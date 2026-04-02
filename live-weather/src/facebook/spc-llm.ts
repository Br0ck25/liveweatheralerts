import type { Env, SpcHazardFocus, SpcLlmPayload, SpcLlmValidationResult, SpcOutputMode } from '../types';
import { escapeRegExp, stateCodeDisplayName, STATE_CODE_TO_NAME } from '../utils';

const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LLM_MAX_TOKENS = 350;
const SPC_MAX_CHARS = 480;

const SYSTEM_PROMPT = [
	'You are a national severe weather desk writer for a live alert service.',
	'',
	'Write Facebook posts that sound like a real-time forecast desk update — not a copied bulletin or a robotic template.',
	'',
	'Your job is to clearly explain the severe weather story for the forecast period.',
	'',
	'STYLE:',
	'- concise',
	'- authoritative',
	'- human',
	'- forecast-led',
	'- not robotic',
	'- not repetitive',
	'',
	'STRICT RULES:',
	'- max 2 short paragraphs',
	'- no emojis',
	'- no county lists',
	'- no filler phrases',
	'- do not copy SPC wording verbatim',
	'- mention only 3 to 5 states',
	'- start with the weather setup, not with a generic mention of alerts',
	'',
	'DO NOT USE:',
	'- "affecting several states"',
	'- "alerts are in effect"',
	'- "parts of the country"',
	'- exaggerated language or hype',
	'',
	'WRITING RULES:',
	'- sound like a national severe weather desk update',
	'- prefer a clean regional focus over a long list of states',
	'- vary sentence structure across posts',
	'- keep the post forecast-led, not alert-led',
	'- if timing is provided, work it in naturally',
].join('\n');

const COMMENT_SYSTEM_PROMPT = [
	SYSTEM_PROMPT,
	'',
	'When writing a comment update:',
	'- start with "UPDATE:"',
	'- you MUST describe what changed since the last post',
	'- do not restate the full setup like a brand-new standalone post',
	'- assume the reader already saw the earlier forecast post',
	'- focus on upgrade, expansion, timing, or hazard changes',
].join('\n');

const BANNED_OUTPUT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /affecting several states/i, reason: 'contains_banned_phrase_affecting_several_states' },
	{ pattern: /parts of the country/i, reason: 'contains_banned_phrase_parts_of_country' },
	{ pattern: /alerts are in effect/i, reason: 'contains_banned_phrase_alerts_in_effect' },
	{ pattern: /\bis focused on\b/i, reason: 'contains_formulaic_phrase_is_focused_on' },
	{ pattern: /\bis in place\b/i, reason: 'contains_formulaic_phrase_is_in_place' },
	{ pattern: /\bis centered\b/i, reason: 'contains_formulaic_phrase_is_centered' },
	{ pattern: /\bis intensifying\b/i, reason: 'contains_formulaic_change_phrase_is_intensifying' },
	{ pattern: /\bis expanding\b/i, reason: 'contains_formulaic_change_phrase_is_expanding' },
	{ pattern: /historic|catastrophic/i, reason: 'contains_hype_language' },
];

const SAFE_STATE_ABBREVIATION_CODES = new Set(
	Object.keys(STATE_CODE_TO_NAME)
		.filter((code) => !['IN', 'ME', 'OR', 'HI', 'GU', 'PR', 'VI'].includes(code)),
);

const FULL_NAME_STATE_PATTERNS = Object.keys(STATE_CODE_TO_NAME)
	.filter((code) => !['GU', 'PR', 'VI'].includes(code))
	.map((code) => ({
		code,
		name: stateCodeDisplayName(code),
		pattern: new RegExp(`\\b${escapeRegExp(stateCodeDisplayName(code))}\\b`, 'i'),
	}));

const ABBREVIATION_STATE_PATTERNS = Object.keys(STATE_CODE_TO_NAME)
	.filter((code) => SAFE_STATE_ABBREVIATION_CODES.has(code))
	.map((code) => ({
		code,
		name: code,
		pattern: new RegExp(`\\b${code}\\b`, 'g'),
	}));

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		const trimmed = String(value || '').trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(trimmed);
	}
	return output;
}

function buildExampleStates(states: string[]): string[] {
	return dedupeStrings(states.map((state) => stateCodeDisplayName(state))).slice(0, 4);
}

function hazardLabel(hazardFocus: SpcHazardFocus): string {
	if (hazardFocus === 'tornado') return 'tornado';
	if (hazardFocus === 'wind') return 'damaging wind';
	if (hazardFocus === 'hail') return 'hail';
	return 'mixed severe hazards';
}

function joinNaturalList(values: string[]): string {
	const items = dedupeStrings(values);
	if (items.length === 0) return '';
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildDayLabel(day: number): string {
	if (day === 1) return 'Day 1 / today';
	if (day === 2) return 'Day 2 / tomorrow';
	return 'Day 3 / extended outlook';
}

function buildOpeningExamples(payload: SpcLlmPayload): string[] {
	if (payload.output_mode === 'comment') return [];
	if (payload.post_type === 'day2_lookahead') {
		return [
			`Watching tomorrow closely across the ${payload.primary_region}.`,
			`Tomorrow's severe setup is worth watching across the ${payload.primary_region}.`,
			`Here's what we're watching for tomorrow across the ${payload.primary_region}.`,
		];
	}
	if (payload.post_type === 'day3_heads_up') {
		return [
			`A longer-range severe setup is worth watching across the ${payload.primary_region}.`,
			`The day 3 severe weather pattern is becoming worth watching across the ${payload.primary_region}.`,
		];
	}
	return [
		`This afternoon to watch across the ${payload.primary_region}.`,
		`Watching today closely across the ${payload.primary_region}.`,
		`Severe setup today across the ${payload.primary_region}.`,
		`Here's what we're watching today across the ${payload.primary_region}.`,
	];
}

function getSystemPrompt(outputMode: SpcOutputMode): string {
	return outputMode === 'comment' ? COMMENT_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

export function buildSpcLlmPayload(input: {
	outputMode: SpcOutputMode;
	outlookDay: 1 | 2 | 3;
	postType: Exclude<SpcLlmPayload['post_type'], ''>;
	riskLevel: SpcLlmPayload['risk_level'];
	riskNumber: SpcLlmPayload['risk_number'];
	primaryRegion: string;
	states: string[];
	stateFocusText?: string | null;
	hazardFocus: SpcHazardFocus;
	hazardList?: string[];
	hazardLine: string;
	stormMode?: string | null;
	timingWindow?: string | null;
	notableText?: string | null;
	trend: SpcLlmPayload['trend'];
	changeHint?: string | null;
	recentOpenings?: string[];
	hashtagsEnabled?: boolean;
}): SpcLlmPayload {
	return {
		output_mode: input.outputMode,
		outlook_day: input.outlookDay,
		post_type: input.postType,
		risk_level: input.riskLevel,
		risk_number: input.riskNumber,
		primary_region: input.primaryRegion,
		states: input.states,
		example_states: buildExampleStates(input.states),
		state_focus_text: input.stateFocusText ?? null,
		hazard_focus: input.hazardFocus,
		hazard_list: dedupeStrings(input.hazardList ?? []).slice(0, 3),
		hazard_line: input.hazardLine,
		storm_mode: input.stormMode ?? null,
		timing_window: input.timingWindow ?? null,
		notable_text: input.notableText ?? null,
		trend: input.trend,
		change_hint: input.changeHint ?? null,
		recent_openings: dedupeStrings(input.recentOpenings ?? []).slice(0, 3),
		max_length: 430,
		hashtags_enabled: input.hashtagsEnabled === true,
	};
}

export function buildSpcUserPrompt(payload: SpcLlmPayload): string {
	const formatSection = payload.output_mode === 'comment'
		? [
			'Format: this is an UPDATE comment on an existing Facebook forecast post.',
			'Start with "UPDATE:".',
			'You MUST describe what changed since the last post.',
			'Do not restate the full setup.',
			'Assume the reader already saw the previous forecast post.',
		].join('\n')
		: [
			'Format: this is a standalone Facebook forecast post.',
			'Lead with the severe weather setup, not a generic sentence about alerts.',
			'Use a natural live-desk opening.',
		].join('\n');

	const antiRepetition = payload.recent_openings.length > 0
		? ['Avoid repeating these structures or openings:', ...payload.recent_openings.map((opening) => `- ${opening}`)].join('\n')
		: '';
	const openingExamples = payload.output_mode === 'comment'
		? ''
		: ['Opening style examples (vary them; do not copy verbatim):', ...buildOpeningExamples(payload).map((opening) => `- ${opening}`)].join('\n');
	const templateGuidance = payload.output_mode === 'comment'
		? 'Keep the update tied to the same SPC core area and same main storm story.'
		: payload.outlook_day === 1
			? 'Use this structure: opening about today / risk sentence centered on the core area / expectation sentence with storm mode, hazards, timing, and any warning-time note.'
			: payload.outlook_day === 2
				? 'Use this structure: opening about tomorrow / risk sentence centered on the core area / developing-system sentence with storm mode, hazards, timing, and any organization note.'
				: 'Use this structure: opening about the longer-range setup / risk sentence centered on the core area / concise sentence on likely storm mode, hazards, and timing.';
	const coreAreaGuidance = payload.output_mode === 'comment'
		? ''
		: payload.example_states.length > 1
			? `Keep the full SPC core area intact: ${payload.state_focus_text || joinNaturalList(payload.example_states)}. Do not narrow this multi-state corridor down to a single state.`
			: '';
	const timingGuidance = payload.timing_window
		? `If you mention timing, keep it aligned with "${payload.timing_window}". Do not rewrite it into overnight or morning wording unless SPC explicitly says that.`
		: '';

	return [
		formatSection,
		`Outlook period: ${buildDayLabel(payload.outlook_day)}.`,
		`Post type: ${payload.post_type.replace(/_/g, ' ')}.`,
		`Risk: Level ${payload.risk_number} ${payload.risk_level}.`,
		`Primary region: ${payload.primary_region}.`,
		payload.state_focus_text ? `Core area: ${payload.state_focus_text}.` : '',
		payload.example_states.length > 0 ? `Example states: ${payload.example_states.join(', ')}.` : '',
		`Hazard focus: ${hazardLabel(payload.hazard_focus)}.`,
		payload.hazard_list.length > 0 ? `Primary hazards: ${joinNaturalList(payload.hazard_list)}.` : '',
		`Hazard line: ${payload.hazard_line}.`,
		payload.storm_mode ? `Storm mode: ${payload.storm_mode}.` : '',
		payload.timing_window ? `Timing window: ${payload.timing_window}.` : '',
		payload.notable_text ? `Notable behavior: ${payload.notable_text}.` : '',
		`Trend: ${payload.trend}.`,
		payload.change_hint ? `Change hint: ${payload.change_hint}.` : '',
		'Use only the SPC core area and listed states. Do not introduce states outside that core story.',
		coreAreaGuidance,
		timingGuidance,
		templateGuidance,
		openingExamples,
		antiRepetition,
		'Keep it concise and strong.',
		`Write no more than ${payload.max_length} characters before any hashtags.`,
		'Do not add hashtags in the main copy.',
	].filter(Boolean).join('\n');
}

function findMentionedAllowedStates(text: string, allowedStates: string[]): string[] {
	const allowed = new Set(allowedStates.map((state) => state.toUpperCase()));
	const mentioned = new Set<string>();
	for (const entry of FULL_NAME_STATE_PATTERNS) {
		if (allowed.has(entry.code) && entry.pattern.test(text)) {
			mentioned.add(entry.code);
		}
	}
	for (const entry of ABBREVIATION_STATE_PATTERNS) {
		entry.pattern.lastIndex = 0;
		if (allowed.has(entry.code) && entry.pattern.test(text)) {
			mentioned.add(entry.code);
		}
	}
	return Array.from(mentioned);
}

function getRequiredCoreStateCount(payload: SpcLlmPayload): number {
	if (payload.output_mode === 'comment') return 0;
	const stateCount = dedupeStrings(payload.states ?? []).length;
	if (stateCount <= 0) return 0;
	return stateCount <= 3 ? stateCount : 3;
}

function violatesTimingGuidance(text: string, timingWindow?: string | null): boolean {
	const normalizedTiming = String(timingWindow || '').trim().toLowerCase();
	if (!normalizedTiming) return false;
	if (!/\bovernight\b/.test(normalizedTiming) && /\bovernight\b/i.test(text)) {
		return true;
	}
	if (!/\bmorning\b/.test(normalizedTiming) && /\b(?:by morning|this morning|tomorrow morning|morning)\b/i.test(text)) {
		return true;
	}
	return false;
}

function findUnexpectedStates(text: string, allowedStates: string[]): string[] {
	const allowed = new Set(allowedStates.map((state) => state.toUpperCase()));
	const unexpected = new Set<string>();
	for (const entry of FULL_NAME_STATE_PATTERNS) {
		if (!allowed.has(entry.code) && entry.pattern.test(text)) {
			unexpected.add(entry.name);
		}
	}
	for (const entry of ABBREVIATION_STATE_PATTERNS) {
		entry.pattern.lastIndex = 0;
		if (!allowed.has(entry.code) && entry.pattern.test(text)) {
			unexpected.add(entry.name);
		}
	}
	return Array.from(unexpected);
}

export function validateSpcLlmOutput(text: string, payload: SpcLlmPayload): SpcLlmValidationResult {
	const trimmed = String(text || '').trim();
	const maxAllowedLength = Math.min(SPC_MAX_CHARS, payload.max_length || SPC_MAX_CHARS);
	const mentionsGeo = payload.example_states.some((state) => trimmed.toLowerCase().includes(state.toLowerCase()))
		|| trimmed.toLowerCase().includes(payload.primary_region.toLowerCase())
		|| /\b(?:midwest|great lakes|upper midwest|mid-south|southern plains|central plains|plains|northeast|southeast|southwest|gulf coast|west|ohio valley)\b/i.test(trimmed);

	if (!trimmed) {
		return { valid: false, text: trimmed, failureReason: 'empty_output' };
	}
	if (trimmed.length > maxAllowedLength) {
		return { valid: false, text: trimmed, failureReason: 'too_long' };
	}
	if (payload.output_mode === 'comment' && !/^UPDATE:/i.test(trimmed)) {
		return { valid: false, text: trimmed, failureReason: 'missing_update_prefix' };
	}
	if (!mentionsGeo) {
		return { valid: false, text: trimmed, failureReason: 'no_geography_mention' };
	}
	const unexpectedStates = findUnexpectedStates(trimmed, payload.states ?? []);
	if (unexpectedStates.length > 0) {
		return { valid: false, text: trimmed, failureReason: 'mentions_out_of_scope_state' };
	}
	const requiredCoreStateCount = getRequiredCoreStateCount(payload);
	if (requiredCoreStateCount > 0 && findMentionedAllowedStates(trimmed, payload.states ?? []).length < requiredCoreStateCount) {
		return { valid: false, text: trimmed, failureReason: 'missing_core_state_cluster' };
	}
	if (violatesTimingGuidance(trimmed, payload.timing_window)) {
		return { valid: false, text: trimmed, failureReason: 'timing_not_aligned' };
	}
	if (/\bhashTag\b|#\w/i.test(trimmed)) {
		return { valid: false, text: trimmed, failureReason: 'contains_hashtag' };
	}
	for (const { pattern, reason } of BANNED_OUTPUT_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { valid: false, text: trimmed, failureReason: reason };
		}
	}
	return { valid: true, text: trimmed };
}

export async function generateSpcLlmCopy(env: Env, payload: SpcLlmPayload): Promise<string | null> {
	if (!env.AI) return null;
	try {
		const result = await env.AI.run(LLM_MODEL, {
			messages: [
				{ role: 'system', content: getSystemPrompt(payload.output_mode) },
				{ role: 'user', content: buildSpcUserPrompt(payload) },
			],
			max_tokens: LLM_MAX_TOKENS,
		}) as { response?: string };
		const raw = String(result?.response || '').trim();
		const validation = validateSpcLlmOutput(raw, payload);
		if (validation.valid) {
			return validation.text;
		}
		console.warn(`[fb-spc-llm] validation failed: ${validation.failureReason}`);
	} catch (err) {
		console.error(`[fb-spc-llm] Workers AI error: ${String(err)}`);
	}
	return null;
}
