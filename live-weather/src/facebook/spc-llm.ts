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
	'- the main story must come from the SPC core categorical risk area',
	'- use source priority: 1) core categorical area 2) SPC summary 3) SPC discussion details',
	'- keep any secondary corridor brief and subordinate to the main story',
	'- if tornadoes are only secondary or conditional, do not lead with tornadoes',
	'- if storm evolution is provided, work it in naturally',
	'- start with the weather setup, not with a generic mention of alerts',
	'',
	'DO NOT USE:',
	'- "affecting several states"',
	'- "alerts are in effect"',
	'- "parts of the country"',
	'- "Severe setup today across..."',
	'- exaggerated language or hype',
	'',
	'WRITING RULES:',
	'- sound like a national severe weather desk update',
	'- make the opening sound like a forecast desk, not a robotic template',
	'- prefer a clean regional focus over a long list of states',
	'- vary sentence structure across posts',
	'- keep the post forecast-led, not alert-led',
	'- do not call the setup Southern Plains, Great Lakes, or Ohio Valley unless the primary core actually supports that region',
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
	{ pattern: /(?:^|[.!?]\s+)severe setup today across/i, reason: 'contains_generic_opening_severe_setup_today_across' },
	{ pattern: /(?:^|[.!?]\s+)here'?s what we'?re watching(?: for tomorrow)? across/i, reason: 'contains_generic_opening_heres_what_were_watching' },
	{ pattern: /\bis focused on\b/i, reason: 'contains_formulaic_phrase_is_focused_on' },
	{ pattern: /\bis in place\b/i, reason: 'contains_formulaic_phrase_is_in_place' },
	{ pattern: /\bis centered\b/i, reason: 'contains_formulaic_phrase_is_centered' },
	{ pattern: /\bis intensifying\b/i, reason: 'contains_formulaic_change_phrase_is_intensifying' },
	{ pattern: /\bis expanding\b/i, reason: 'contains_formulaic_change_phrase_is_expanding' },
	{ pattern: /historic|catastrophic/i, reason: 'contains_hype_language' },
];

const REGION_LABEL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: 'Mid-Mississippi Valley', pattern: /\bmid-?mississippi valley\b/i },
	{ label: 'Upper Midwest', pattern: /\bupper midwest\b/i },
	{ label: 'Great Lakes', pattern: /\bgreat lakes\b/i },
	{ label: 'Ohio Valley', pattern: /\bohio valley\b/i },
	{ label: 'Mid-South', pattern: /\bmid-?south\b/i },
	{ label: 'Southern Plains', pattern: /\bsouthern plains\b/i },
	{ label: 'Central Plains', pattern: /\bcentral plains\b/i },
	{ label: 'Northern Plains', pattern: /\bnorthern plains\b/i },
	{ label: 'Midwest', pattern: /\bmidwest\b/i },
	{ label: 'Southeast', pattern: /\bsoutheast\b/i },
	{ label: 'Northeast', pattern: /\bnortheast\b/i },
	{ label: 'Southwest', pattern: /\bsouthwest\b/i },
	{ label: 'Plains', pattern: /\bplains\b/i },
	{ label: 'West', pattern: /\b(?:the west|west coast|intermountain west|western states)\b/i },
];

const REGION_ALLOWED_ALIASES: Record<string, string[]> = {
	'Mid-Mississippi Valley': ['Mid-Mississippi Valley', 'Midwest'],
	'Upper Midwest': ['Upper Midwest', 'Midwest'],
	'Great Lakes': ['Great Lakes', 'Midwest'],
	'Ohio Valley': ['Ohio Valley', 'Midwest'],
	'Mid-South': ['Mid-South', 'Southeast'],
	'Southern Plains': ['Southern Plains', 'Plains'],
	'Central Plains': ['Central Plains', 'Plains'],
	'Northern Plains': ['Northern Plains', 'Plains'],
	Midwest: ['Midwest', 'Mid-Mississippi Valley', 'Upper Midwest'],
	Southeast: ['Southeast', 'Mid-South'],
	Northeast: ['Northeast'],
	Southwest: ['Southwest', 'West'],
	Plains: ['Plains', 'Central Plains', 'Southern Plains', 'Northern Plains'],
	West: ['West', 'Southwest'],
};

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

function maskRegionLabelsForStateDetection(text: string): string {
	return String(text || '').replace(/mid-?mississippi valley/gi, 'midmississippivalley');
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
			`Tomorrow has our attention across the ${payload.primary_region}.`,
			`Watching tomorrow closely across the ${payload.primary_region}.`,
			`A more organized severe setup may unfold tomorrow across the ${payload.primary_region}.`,
		];
	}
	if (payload.post_type === 'day3_heads_up') {
		return [
			`The day 3 severe weather signal is worth watching across the ${payload.primary_region}.`,
			`A broader severe setup may take shape later this period across the ${payload.primary_region}.`,
		];
	}
	return [
		`This afternoon to watch across the ${payload.primary_region}.`,
		`Watching today closely across the ${payload.primary_region}.`,
		`A volatile setup is taking shape this afternoon across the ${payload.primary_region}.`,
		`The core severe weather story today is setting up across the ${payload.primary_region}.`,
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
	secondaryStates?: string[];
	stateFocusText?: string | null;
	secondaryAreaText?: string | null;
	hazardFocus: SpcHazardFocus;
	hazardList?: string[];
	primaryHazards?: string[];
	secondaryHazards?: string[];
	hazardLine: string;
	stormMode?: string | null;
	stormEvolution?: boolean;
	stormEvolutionText?: string | null;
	timingWindow?: string | null;
	notableText?: string | null;
	afdTimingHints?: string[];
	afdStormModeHints?: string[];
	afdHazardEmphasis?: string[];
	afdUncertaintyHints?: string[];
	afdConfidenceHints?: string[];
	afdNotableBehaviorHints?: string[];
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
		primary_states: input.states,
		region: input.primaryRegion,
		primary_region: input.primaryRegion,
		states: input.states,
		secondary_states: dedupeStrings(input.secondaryStates ?? []).slice(0, 3),
		example_states: buildExampleStates(input.states),
		state_focus_text: input.stateFocusText ?? null,
		secondary_area_text: input.secondaryAreaText ?? null,
		hazard_focus: input.hazardFocus,
		hazard_list: dedupeStrings(input.hazardList ?? []).slice(0, 3),
		primary_hazards: dedupeStrings(input.primaryHazards ?? []).slice(0, 2),
		secondary_hazards: dedupeStrings(input.secondaryHazards ?? []).slice(0, 2),
		hazard_line: input.hazardLine,
		storm_mode: input.stormMode ?? null,
		storm_evolution: input.stormEvolution === true || !!String(input.stormEvolutionText || '').trim(),
		storm_evolution_text: input.stormEvolutionText ?? null,
		timing_window: input.timingWindow ?? null,
		notable_text: input.notableText ?? null,
		afd_timing_hints: dedupeStrings(input.afdTimingHints ?? []).slice(0, 3),
		afd_storm_mode_hints: dedupeStrings(input.afdStormModeHints ?? []).slice(0, 3),
		afd_hazard_emphasis: dedupeStrings(input.afdHazardEmphasis ?? []).slice(0, 3),
		afd_uncertainty_hints: dedupeStrings(input.afdUncertaintyHints ?? []).slice(0, 3),
		afd_confidence_hints: dedupeStrings(input.afdConfidenceHints ?? []).slice(0, 3),
		afd_notable_behavior_hints: dedupeStrings(input.afdNotableBehaviorHints ?? []).slice(0, 3),
		trend: input.trend,
		change_hint: input.changeHint ?? null,
		recent_openings: dedupeStrings(input.recentOpenings ?? []).slice(0, 3),
		max_length: 430,
		hashtags_enabled: input.hashtagsEnabled === true,
	};
}

export function buildSpcUserPrompt(payload: SpcLlmPayload): string {
	const afdSupportGuidance = [
		payload.afd_timing_hints?.length ? `Supporting timing nuance: ${joinNaturalList(payload.afd_timing_hints)}.` : '',
		payload.afd_storm_mode_hints?.length ? `Supporting storm evolution nuance: ${joinNaturalList(payload.afd_storm_mode_hints)}.` : '',
		payload.afd_hazard_emphasis?.length ? `Supporting hazard emphasis: ${joinNaturalList(payload.afd_hazard_emphasis)}.` : '',
		payload.afd_uncertainty_hints?.length ? `Supporting uncertainty wording: ${joinNaturalList(payload.afd_uncertainty_hints)}.` : '',
		payload.afd_confidence_hints?.length ? `Supporting confidence wording: ${joinNaturalList(payload.afd_confidence_hints)}.` : '',
		payload.afd_notable_behavior_hints?.length ? `Supporting behavior note: ${joinNaturalList(payload.afd_notable_behavior_hints)}.` : '',
	].filter(Boolean).join('\n');

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
	const sourcePriority = 'Source priority: 1) SPC core categorical risk area 2) SPC summary 3) SPC discussion details.';

	const antiRepetition = payload.recent_openings.length > 0
		? ['Avoid repeating these structures or openings:', ...payload.recent_openings.map((opening) => `- ${opening}`)].join('\n')
		: '';
	const openingExamples = payload.output_mode === 'comment'
		? ''
		: ['Opening style examples (vary them; do not copy verbatim):', ...buildOpeningExamples(payload).map((opening) => `- ${opening}`)].join('\n');
	const templateGuidance = payload.output_mode === 'comment'
		? 'Keep the update tied to the same SPC core area and same main storm story.'
		: payload.outlook_day === 1
			? 'Use this structure: live-desk opening / risk sentence centered on the SPC core area / concise storm-evolution and hazard sentence / timing or warning-time detail if available.'
			: payload.outlook_day === 2
				? 'Use this structure: opening about tomorrow / risk sentence centered on the SPC core area / concise storm-evolution and hazard sentence / timing sentence if available.'
				: 'Use this structure: opening about the longer-range setup / risk sentence centered on the SPC core area / concise sentence on storm evolution, hazards, and timing.';
	const coreAreaGuidance = payload.output_mode === 'comment'
		? ''
		: payload.example_states.length > 1
			? `Keep the full SPC core area intact: ${payload.state_focus_text || joinNaturalList(payload.example_states)}. Do not narrow this multi-state corridor down to a single state or swap it for a broader but less accurate region.`
			: '';
	const secondaryAreaGuidance = payload.secondary_area_text
		? `Secondary corridor: ${payload.secondary_area_text}. Mention it only if it helps explain storm evolution, and keep it clearly secondary to the main story.`
		: '';
	const timingGuidance = payload.timing_window
		? `If you mention timing, keep it aligned with "${payload.timing_window}". Do not rewrite it into overnight or morning wording unless SPC explicitly says that.`
		: '';

	return [
		formatSection,
		sourcePriority,
		`Outlook period: ${buildDayLabel(payload.outlook_day)}.`,
		`Post type: ${payload.post_type.replace(/_/g, ' ')}.`,
		`Risk: Level ${payload.risk_number} ${payload.risk_level}.`,
		`Locked primary states: ${joinNaturalList(payload.primary_states.map((state) => stateCodeDisplayName(state)))}.`,
		`Locked region: ${payload.region}.`,
		`Primary region: ${payload.primary_region}.`,
		payload.state_focus_text ? `Core area: ${payload.state_focus_text}.` : '',
		payload.secondary_area_text ? `Secondary area: ${payload.secondary_area_text}.` : '',
		payload.example_states.length > 0 ? `Example states: ${payload.example_states.join(', ')}.` : '',
		`Hazard focus: ${hazardLabel(payload.hazard_focus)}.`,
		payload.hazard_list.length > 0 ? `Primary hazards: ${joinNaturalList(payload.hazard_list)}.` : '',
		payload.primary_hazards?.length ? `Main threats: ${joinNaturalList(payload.primary_hazards)}.` : '',
		payload.secondary_hazards?.length ? `Secondary or conditional hazards: ${joinNaturalList(payload.secondary_hazards)}.` : '',
		`Hazard line: ${payload.hazard_line}.`,
		payload.storm_mode ? `Storm mode: ${payload.storm_mode}.` : '',
		payload.storm_evolution ? 'Storm evolution is present and must be included in the copy.' : '',
		payload.storm_evolution_text ? `Storm evolution: ${payload.storm_evolution_text}.` : '',
		payload.timing_window ? `Timing window: ${payload.timing_window}.` : '',
		payload.notable_text ? `Notable behavior: ${payload.notable_text}.` : '',
		`Trend: ${payload.trend}.`,
		payload.change_hint ? `Change hint: ${payload.change_hint}.` : '',
		afdSupportGuidance ? 'Supporting forecast cues: use these only to refine nuance; SPC remains the primary source of truth. Do not mention AFDs directly.' : '',
		afdSupportGuidance,
		'Keep the main post anchored to the SPC core area and its main hazard story.',
		'Primary states and region are hard-locked. Do not rename them, broaden them, or swap in nearby states.',
		'Use only the provided primary states, plus any listed secondary states if they are needed to explain storm evolution.',
		'Do not introduce states or regions outside that story.',
		'If tornadoes are secondary or conditional, do not lead with tornadoes.',
		'Say wind and hail are the main threats when SPC treats them as the main threats.',
		'Sound like a forecast desk update, not a template.',
		coreAreaGuidance,
		secondaryAreaGuidance,
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
	const maskedText = maskRegionLabelsForStateDetection(text);
	const allowed = new Set(allowedStates.map((state) => state.toUpperCase()));
	const mentioned = new Set<string>();
	for (const entry of FULL_NAME_STATE_PATTERNS) {
		if (allowed.has(entry.code) && entry.pattern.test(maskedText)) {
			mentioned.add(entry.code);
		}
	}
	for (const entry of ABBREVIATION_STATE_PATTERNS) {
		entry.pattern.lastIndex = 0;
		if (allowed.has(entry.code) && entry.pattern.test(maskedText)) {
			mentioned.add(entry.code);
		}
	}
	return Array.from(mentioned);
}

function allowedPayloadStates(payload: SpcLlmPayload): string[] {
	return dedupeStrings([...(payload.states ?? []), ...(payload.secondary_states ?? [])]).map((state) => state.toUpperCase());
}

function mentionsPrimaryRegionAlias(text: string, payload: SpcLlmPayload): boolean {
	const allowedLabels = REGION_ALLOWED_ALIASES[payload.primary_region] ?? [payload.primary_region, payload.region];
	return dedupeStrings(allowedLabels)
		.some((label) => String(label || '').trim() && text.toLowerCase().includes(String(label || '').trim().toLowerCase()));
}

function mentionsPrimaryAreaAnchor(text: string, payload: SpcLlmPayload): boolean {
	if (mentionsPrimaryRegionAlias(text, payload)) return true;
	return findMentionedAllowedStates(text, payload.states ?? []).length > 0;
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
	const maskedText = maskRegionLabelsForStateDetection(text);
	const allowed = new Set(allowedStates.map((state) => state.toUpperCase()));
	const unexpected = new Set<string>();
	for (const entry of FULL_NAME_STATE_PATTERNS) {
		if (!allowed.has(entry.code) && entry.pattern.test(maskedText)) {
			unexpected.add(entry.name);
		}
	}
	for (const entry of ABBREVIATION_STATE_PATTERNS) {
		entry.pattern.lastIndex = 0;
		if (!allowed.has(entry.code) && entry.pattern.test(maskedText)) {
			unexpected.add(entry.name);
		}
	}
	return Array.from(unexpected);
}

function findFirstAllowedStateIndex(text: string, allowedStates: string[]): number {
	const maskedText = maskRegionLabelsForStateDetection(text);
	const allowed = new Set(allowedStates.map((state) => state.toUpperCase()));
	let firstIndex = Number.POSITIVE_INFINITY;
	for (const entry of FULL_NAME_STATE_PATTERNS) {
		if (!allowed.has(entry.code)) continue;
		const index = maskedText.search(entry.pattern);
		if (index >= 0) firstIndex = Math.min(firstIndex, index);
	}
	for (const entry of ABBREVIATION_STATE_PATTERNS) {
		if (!allowed.has(entry.code)) continue;
		entry.pattern.lastIndex = 0;
		const match = entry.pattern.exec(maskedText);
		if (match) firstIndex = Math.min(firstIndex, match.index);
	}
	return Number.isFinite(firstIndex) ? firstIndex : -1;
}

function secondaryAreaLeadsPrimary(text: string, payload: SpcLlmPayload): boolean {
	if ((payload.secondary_states?.length ?? 0) === 0) return false;
	const primaryIndex = findFirstAllowedStateIndex(text, payload.states ?? []);
	const secondaryIndex = findFirstAllowedStateIndex(text, payload.secondary_states ?? []);
	if (secondaryIndex < 0) return false;
	if (primaryIndex < 0) return !mentionsPrimaryRegionAlias(text, payload);
	return secondaryIndex < primaryIndex;
}

function findConflictingRegionLabels(text: string, payload: SpcLlmPayload): string[] {
	const allowedLabels = new Set(REGION_ALLOWED_ALIASES[payload.primary_region] ?? [payload.primary_region]);
	return REGION_LABEL_PATTERNS
		.filter((entry) => !allowedLabels.has(entry.label) && entry.pattern.test(text))
		.map((entry) => entry.label);
}

function normalizeHazardDescriptor(hazard: string | null | undefined): 'tornado' | 'wind' | 'hail' | 'mixed' | null {
	const normalized = String(hazard || '').trim().toLowerCase();
	if (!normalized) return null;
	if (normalized.includes('tornado')) return 'tornado';
	if (normalized.includes('hail')) return 'hail';
	if (normalized.includes('wind')) return 'wind';
	return 'mixed';
}

function findLeadingHazardDescriptor(text: string): 'tornado' | 'wind' | 'hail' | null {
	const normalized = String(text || '').toLowerCase();
	const entries = [
		{ label: 'tornado' as const, index: normalized.search(/\btornado(?:es)?\b/) },
		{ label: 'wind' as const, index: normalized.search(/\b(?:damaging winds?|widespread damaging winds?|wind damage)\b/) },
		{ label: 'hail' as const, index: normalized.search(/\b(?:large hail|hail)\b/) },
	].filter((entry): entry is { label: 'tornado' | 'wind' | 'hail'; index: number } => entry.index >= 0);
	entries.sort((left, right) => left.index - right.index);
	return entries[0]?.label ?? null;
}

function hasRequiredStormEvolution(text: string, payload: SpcLlmPayload): boolean {
	if (!payload.storm_evolution) return true;
	const normalized = String(text || '').toLowerCase();
	const progressionMentioned = /\b(?:before|then|later|eventually|organize(?:s|d)? into|grow into|evolve into|become more linear|quick upscale growth)\b/.test(normalized);
	const laterModeMentioned = /\b(?:line|linear|squall line|bowing|upscale|clusters?)\b/.test(normalized);
	if (laterModeMentioned && progressionMentioned) return true;
	if (/\bquick upscale growth\b/.test(normalized)) return true;
	const normalizedEvolutionText = String(payload.storm_evolution_text || '').toLowerCase();
	if (normalizedEvolutionText && laterModeMentioned && /\b(?:before|later|organize|grow|evolve|linear|line|upscale|clusters?)\b/.test(normalizedEvolutionText)) {
		return true;
	}
	return false;
}

function hasTornadoLeadMismatch(text: string, payload: SpcLlmPayload): boolean {
	const expectedPrimaryHazard = normalizeHazardDescriptor(payload.primary_hazards?.[0] ?? payload.hazard_list?.[0] ?? null);
	if (!expectedPrimaryHazard || expectedPrimaryHazard === 'tornado' || expectedPrimaryHazard === 'mixed') {
		return false;
	}
	return findLeadingHazardDescriptor(text) === 'tornado';
}

export function validateSpcLlmOutput(text: string, payload: SpcLlmPayload): SpcLlmValidationResult {
	const trimmed = String(text || '').trim();
	const maxAllowedLength = Math.min(SPC_MAX_CHARS, payload.max_length || SPC_MAX_CHARS);
	const allowedStates = allowedPayloadStates(payload);
	const mentionsGeo = findMentionedAllowedStates(trimmed, allowedStates).length > 0
		|| payload.example_states.some((state) => trimmed.toLowerCase().includes(state.toLowerCase()))
		|| trimmed.toLowerCase().includes(payload.primary_region.toLowerCase())
		|| trimmed.toLowerCase().includes(payload.region.toLowerCase())
		|| /\b(?:midwest|mid-?mississippi valley|great lakes|upper midwest|mid-?south|southern plains|central plains|northern plains|plains|northeast|southeast|southwest|gulf coast|west|ohio valley)\b/i.test(trimmed);

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
	const unexpectedStates = findUnexpectedStates(trimmed, allowedStates);
	if (unexpectedStates.length > 0) {
		return { valid: false, text: trimmed, failureReason: 'mentions_out_of_scope_state' };
	}
	if (!mentionsPrimaryAreaAnchor(trimmed, payload)) {
		return { valid: false, text: trimmed, failureReason: 'missing_primary_area_anchor' };
	}
	if (findConflictingRegionLabels(trimmed, payload).length > 0) {
		return { valid: false, text: trimmed, failureReason: 'mentions_conflicting_region' };
	}
	if ((payload.secondary_states?.length ?? 0) > 0) {
		const primaryMentions = findMentionedAllowedStates(trimmed, payload.states ?? []).length;
		const secondaryMentions = findMentionedAllowedStates(trimmed, payload.secondary_states ?? []).length;
		if (secondaryMentions > 0 && primaryMentions === 0 && !mentionsPrimaryRegionAlias(trimmed, payload)) {
			return { valid: false, text: trimmed, failureReason: 'secondary_area_over_primary' };
		}
		if (secondaryAreaLeadsPrimary(trimmed, payload)) {
			return { valid: false, text: trimmed, failureReason: 'secondary_area_over_primary' };
		}
	}
	if (!hasRequiredStormEvolution(trimmed, payload)) {
		return { valid: false, text: trimmed, failureReason: 'missing_storm_evolution' };
	}
	if (hasTornadoLeadMismatch(trimmed, payload)) {
		return { valid: false, text: trimmed, failureReason: 'tornado_lead_mismatch' };
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

export async function generateSpcLlmCopy(
	env: Env,
	payload: SpcLlmPayload,
): Promise<{ text: string | null; failureReason?: string | null; rawText?: string | null }> {
	if (!env.AI) {
		return { text: null, failureReason: 'workers_ai_unavailable', rawText: null };
	}
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
			return { text: validation.text, failureReason: null, rawText: raw };
		}
		console.warn(`[fb-spc-llm] validation failed: ${validation.failureReason}`);
		return {
			text: null,
			failureReason: validation.failureReason ?? 'invalid_output',
			rawText: raw,
		};
	} catch (err) {
		console.error(`[fb-spc-llm] Workers AI error: ${String(err)}`);
		return { text: null, failureReason: 'workers_ai_error', rawText: null };
	}
}
