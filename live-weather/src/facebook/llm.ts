import {
	FB_DIGEST_RECENT_OPENINGS_LIMIT,
	KV_FB_DIGEST_RECENT_OPENINGS,
} from '../constants';
import type {
	DigestSummary,
	DigestCopyMode,
	Env,
	LlmPostValidationResult,
	LlmPromptPayload,
	RecentDigestOpeningsRecord,
} from '../types';

const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const LLM_MAX_TOKENS = 350;
const DIGEST_MAX_CHARS = 500;

const SYSTEM_PROMPT = [
	'You are a national weather desk writer for a live alert service.',
	'',
	'Write Facebook posts that sound like a real-time weather desk update — not a generic summary.',
	'',
	'Your job is to clearly explain how the weather story is changing right now.',
	'',
	'STYLE:',
	'- concise',
	'- authoritative',
	'- human',
	'- not robotic',
	'- not repetitive',
	'- not generic',
	'',
	'STRICT RULES:',
	'- max 2 short paragraphs',
	'- no emojis',
	'- no hashtags',
	'- no county lists',
	'- no filler phrases',
	'- no repetition of previous phrasing',
	'',
	'DO NOT USE:',
	'- "affecting several states"',
	'- "alerts are in effect"',
	'- "parts of the country"',
	'- "high-volume alert surge"',
	'- repetitive phrasing like "is intensifying" or "is expanding"',
	'',
	'WRITING RULES:',
	'- start with the weather situation, not the alerts',
	'- treat each post like a live update, not a static alert inventory',
	'- prefer regional descriptions (Midwest, Northeast, Plains, West)',
	'- mention only 3–5 states',
	'- vary sentence structure across posts',
	'- avoid repeating the same sentence structure across posts',
	'- do not repeatedly use phrases like "is intensifying" or "is expanding"',
	'- vary how you describe changes (building, spreading, shifting, developing, moving)',
	'- prefer natural desk-style openings over rigid formulas',
	'- make each post feel distinct',
	'',
	'Your output should feel like a live update from a national weather desk.',
].join('\n');

const COMMENT_SYSTEM_PROMPT = [
	SYSTEM_PROMPT,
	'',
	'When writing a comment update:',
	'- treat it as a follow-up on an existing Facebook post',
	'- start with "UPDATE:"',
	'- only comment when the change is meaningful',
	'- you MUST describe what changed since the last post',
	'- focus on what changed, expanded, intensified, or shifted',
	'- stay anchored to the same main hazard story as the original post',
	'- do not pivot to a different primary hazard or a completely different lead region',
	'- do not rewrite the full situation like a brand-new standalone post',
	'- assume the reader already saw the previous post',
].join('\n');

const STATE_NAMES: Record<string, string> = {
	AK: 'Alaska',
	AL: 'Alabama',
	AR: 'Arkansas',
	AZ: 'Arizona',
	CA: 'California',
	CO: 'Colorado',
	CT: 'Connecticut',
	DC: 'District of Columbia',
	DE: 'Delaware',
	FL: 'Florida',
	GA: 'Georgia',
	GU: 'Guam',
	HI: 'Hawaii',
	IA: 'Iowa',
	ID: 'Idaho',
	IL: 'Illinois',
	IN: 'Indiana',
	KS: 'Kansas',
	KY: 'Kentucky',
	LA: 'Louisiana',
	MA: 'Massachusetts',
	MD: 'Maryland',
	ME: 'Maine',
	MI: 'Michigan',
	MN: 'Minnesota',
	MO: 'Missouri',
	MS: 'Mississippi',
	MT: 'Montana',
	NC: 'North Carolina',
	ND: 'North Dakota',
	NE: 'Nebraska',
	NH: 'New Hampshire',
	NJ: 'New Jersey',
	NM: 'New Mexico',
	NV: 'Nevada',
	NY: 'New York',
	OH: 'Ohio',
	OK: 'Oklahoma',
	OR: 'Oregon',
	PA: 'Pennsylvania',
	PR: 'Puerto Rico',
	RI: 'Rhode Island',
	SC: 'South Carolina',
	SD: 'South Dakota',
	TN: 'Tennessee',
	TX: 'Texas',
	UT: 'Utah',
	VA: 'Virginia',
	VI: 'U.S. Virgin Islands',
	VT: 'Vermont',
	WA: 'Washington',
	WI: 'Wisconsin',
	WV: 'West Virginia',
	WY: 'Wyoming',
};

const REGION_BY_STATE: Record<string, string> = {
	CT: 'Northeast',
	DC: 'Northeast',
	DE: 'Northeast',
	MA: 'Northeast',
	MD: 'Northeast',
	ME: 'Northeast',
	NH: 'Northeast',
	NJ: 'Northeast',
	NY: 'Northeast',
	PA: 'Northeast',
	RI: 'Northeast',
	VT: 'Northeast',
	IA: 'Midwest',
	IL: 'Midwest',
	IN: 'Midwest',
	MI: 'Midwest',
	MN: 'Midwest',
	MO: 'Midwest',
	OH: 'Midwest',
	WI: 'Midwest',
	KS: 'Plains',
	ND: 'Plains',
	NE: 'Plains',
	OK: 'Plains',
	SD: 'Plains',
	TX: 'Plains',
	AL: 'Southeast',
	AR: 'Southeast',
	FL: 'Southeast',
	GA: 'Southeast',
	KY: 'Southeast',
	LA: 'Southeast',
	MS: 'Southeast',
	NC: 'Southeast',
	SC: 'Southeast',
	TN: 'Southeast',
	VA: 'Southeast',
	WV: 'Southeast',
	AZ: 'Southwest',
	NM: 'Southwest',
	AK: 'West',
	CA: 'West',
	CO: 'West',
	HI: 'West',
	ID: 'West',
	MT: 'West',
	NV: 'West',
	OR: 'West',
	UT: 'West',
	WA: 'West',
	WY: 'West',
	GU: 'Pacific',
	PR: 'Caribbean',
	VI: 'Caribbean',
};

const REGION_PRIORITY = ['Northeast', 'Midwest', 'Plains', 'Southeast', 'Southwest', 'West', 'Pacific', 'Caribbean'];

const FIRE_SOUTHWEST_OVERRIDE_STATES = new Set(['AZ', 'NM', 'TX']);

const BANNED_OUTPUT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /affecting several states/i, reason: 'contains_banned_phrase_affecting_several_states' },
	{ pattern: /parts of the country/i, reason: 'contains_banned_phrase_parts_of_country' },
	{ pattern: /alerts are in effect/i, reason: 'contains_banned_phrase_alerts_in_effect' },
	{ pattern: /high-volume(?:\s+[a-z-]+){0,3}\s+surge/i, reason: 'contains_banned_phrase_high_volume_surge' },
	{ pattern: /\bis intensifying\b/i, reason: 'contains_formulaic_change_phrase_is_intensifying' },
	{ pattern: /\bis expanding\b/i, reason: 'contains_formulaic_change_phrase_is_expanding' },
];

function dedupeStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const output: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(trimmed);
	}

	return output;
}

export function stateCodeToName(code: string): string {
	return STATE_NAMES[code.toUpperCase()] ?? code;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOrderedRegions(states: string[]): string[] {
	const regionCounts = new Map<string, number>();

	for (const stateCode of states) {
		const region = REGION_BY_STATE[stateCode.toUpperCase()];
		if (!region) continue;
		regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
	}

	const orderedRegions = Array.from(regionCounts.entries())
		.sort((a, b) => {
			const countDiff = b[1] - a[1];
			if (countDiff !== 0) return countDiff;
			return REGION_PRIORITY.indexOf(a[0]) - REGION_PRIORITY.indexOf(b[0]);
		})
		.map(([region]) => region);

	return orderedRegions;
}

function buildBaseRegionalFocus(states: string[]): string {
	const orderedRegions = buildOrderedRegions(states);

	if (orderedRegions.length === 0) return 'National';
	if (orderedRegions.length === 1) return orderedRegions[0];
	return orderedRegions.slice(0, 2).join(' and ');
}

function buildRegionalFocusParts(states: string[], hazardFocus: string | null = null, impacts: string[] = []): string[] {
	const normalizedStates = dedupeStrings(states.map((state) => state.toUpperCase()));
	const normalizedHazard = String(hazardFocus || '').toLowerCase();
	const normalizedImpacts = impacts.map((impact) => impact.toLowerCase());
	const orderedRegions = buildOrderedRegions(normalizedStates);

	if (normalizedHazard === 'flood' && normalizedStates.includes('TX')) {
		return ['Gulf Coast', 'Southeast'];
	}

	if (normalizedImpacts.includes('coastal conditions')) {
		return ['Coastal areas'];
	}

	if (normalizedHazard === 'fire' && normalizedStates.some((state) => FIRE_SOUTHWEST_OVERRIDE_STATES.has(state))) {
		return ['Southwest'];
	}

	if (orderedRegions.length === 0) {
		return ['National'];
	}

	return orderedRegions.slice(0, 2);
}

function buildRegionalFocus(states: string[], hazardFocus: string | null = null, impacts: string[] = []): string {
	const focusParts = buildRegionalFocusParts(states, hazardFocus, impacts);
	if (focusParts.length === 0) return 'National';
	if (focusParts.length === 1) return focusParts[0];
	return focusParts.slice(0, 2).join(' and ');
}

function buildExampleStates(states: string[]): string[] {
	return dedupeStrings(states.map(stateCodeToName)).slice(0, 4);
}

function joinNaturalList(values: string[]): string {
	const items = dedupeStrings(values);
	if (items.length === 0) return '';
	if (items.length === 1) return items[0];
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function urgencyRank(urgency: string): number {
	if (urgency === 'high') return 3;
	if (urgency === 'moderate') return 2;
	return 1;
}

function deriveTrend(summary: DigestSummary): 'continuing' | 'expanding' | 'intensifying' {
	if (summary.urgency === 'high') return 'intensifying';
	if (summary.mode === 'incident' || summary.postType === 'cluster' || summary.states.length >= 4) return 'expanding';
	return 'continuing';
}

function deriveImpact(summary: Pick<DigestSummary, 'hazardFocus' | 'topAlertTypes'>): string[] {
	const combined = [summary.hazardFocus ?? '', ...summary.topAlertTypes].join(' ').toLowerCase();
	const impacts: string[] = [];
	const addImpact = (impact: string) => {
		if (!impacts.includes(impact)) impacts.push(impact);
	};

	if (/flood/.test(combined)) {
		addImpact('flooding');
		addImpact('travel');
	}
	if (/winter|snow|ice|blizzard|sleet|freez/.test(combined)) {
		addImpact('snow');
		addImpact('travel');
	}
	if (/wind|thunderstorm|gale/.test(combined)) {
		addImpact('wind');
	}
	if (/fire|red flag|smoke/.test(combined)) {
		addImpact('fire weather');
	}
	if (/heat/.test(combined)) {
		addImpact('heat');
	}
	if (/air quality/.test(combined)) {
		addImpact('air quality');
	}
	if (/marine|coastal|surf|rip current/.test(combined)) {
		addImpact('coastal conditions');
	}

	if (impacts.length === 0) {
		addImpact('weather impacts');
	}

	return impacts.slice(0, 3);
}

export function buildDigestRegionalBuckets(
	summary: Pick<DigestSummary, 'states' | 'hazardFocus' | 'topAlertTypes'>,
): string[] {
	return buildRegionalFocusParts(summary.states, summary.hazardFocus, deriveImpact(summary));
}

export function buildDigestRegionalFocus(
	summary: Pick<DigestSummary, 'states' | 'hazardFocus' | 'topAlertTypes'>,
): string {
	return buildRegionalFocus(summary.states, summary.hazardFocus, deriveImpact(summary));
}

export function buildCommentChangeHint(
	previousSummary: DigestSummary | null | undefined,
	currentSummary: DigestSummary,
): string | null {
	if (!previousSummary) return null;

	const currentStates = dedupeStrings(currentSummary.states.map((state) => state.toUpperCase()));
	const previousStates = dedupeStrings(previousSummary.states.map((state) => state.toUpperCase()));
	const currentStateSet = new Set(currentStates);
	const previousStateSet = new Set(previousStates);
	const addedStates = currentStates
		.filter((state) => !previousStateSet.has(state))
		.map(stateCodeToName)
		.slice(0, 4);
	const removedStates = previousStates
		.filter((state) => !currentStateSet.has(state))
		.map(stateCodeToName)
		.slice(0, 4);
	const previousRegionalFocus = buildDigestRegionalFocus(previousSummary);
	const currentRegionalFocus = buildDigestRegionalFocus(currentSummary);
	const currentAlertTypes = dedupeStrings(currentSummary.topAlertTypes).slice(0, 2);
	const previousAlertTypes = dedupeStrings(previousSummary.topAlertTypes).slice(0, 2);
	const changeHints: string[] = [];

	if (addedStates.length > 0) {
		changeHints.push(`new states added: ${joinNaturalList(addedStates)}`);
	}

	if (currentStates.length > previousStates.length && addedStates.length === 0) {
		changeHints.push('alert coverage expanded');
	}

	if (urgencyRank(currentSummary.urgency) > urgencyRank(previousSummary.urgency)) {
		changeHints.push('intensity increased');
	}

	if (previousRegionalFocus !== currentRegionalFocus) {
		changeHints.push(`impact shifting from ${previousRegionalFocus} toward ${currentRegionalFocus}`);
	}

	if (
		currentAlertTypes.length > 0
		&& currentAlertTypes.join('|').toLowerCase() !== previousAlertTypes.join('|').toLowerCase()
	) {
		changeHints.push(`alerts now led by ${joinNaturalList(currentAlertTypes)}`);
	}

	if ((previousSummary.hazardFocus ?? null) !== (currentSummary.hazardFocus ?? null) && currentSummary.hazardFocus) {
		changeHints.push(`hazard focus now centered on ${capitalizeHazard(currentSummary.hazardFocus).toLowerCase()}`);
	}

	if (removedStates.length > 0 && addedStates.length === 0 && previousRegionalFocus === currentRegionalFocus) {
		changeHints.push(`impacts shifting within ${currentRegionalFocus}`);
	}

	if (changeHints.length > 0) {
		return changeHints.slice(0, 3).join('; ');
	}

	if (currentSummary.hazardFocus === 'flood') {
		return 'flooding impacts are becoming more of a problem in the same core states';
	}
	if (currentSummary.hazardFocus === 'winter') {
		return 'snow and ice impacts are building in the same core states';
	}
	if (currentSummary.hazardFocus === 'wind') {
		return 'wind impacts are shifting within the same core states';
	}
	if (currentSummary.hazardFocus === 'fire') {
		return 'fire weather concerns are spreading within the same core states';
	}

	return 'the weather pattern is still changing within the same core region';
}

function extractOpening(text: string): string | null {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (!normalized) return null;

	const firstParagraph = normalized.split(/\n+/)[0]?.trim() || normalized;
	const firstSentence = firstParagraph.match(/^.+?[.!?](?=\s|$)/)?.[0]?.trim() || firstParagraph;
	const normalizedOpening = firstSentence.replace(/^UPDATE:\s*/i, '').trim();
	const opening = normalizedOpening.slice(0, 140).trim();
	return opening || null;
}

function getSystemPrompt(outputMode: DigestCopyMode): string {
	return outputMode === 'comment' ? COMMENT_SYSTEM_PROMPT : SYSTEM_PROMPT;
}

export async function readRecentDigestOpenings(env: Env): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_DIGEST_RECENT_OPENINGS);
		if (!raw) return [];

		const parsed = JSON.parse(raw) as RecentDigestOpeningsRecord;
		if (!Array.isArray(parsed.openings)) return [];

		return dedupeStrings(parsed.openings.map((opening) => String(opening || '')))
			.slice(0, FB_DIGEST_RECENT_OPENINGS_LIMIT);
	} catch {
		return [];
	}
}

export async function recordRecentDigestOpening(env: Env, text: string): Promise<void> {
	const opening = extractOpening(text);
	if (!opening) return;

	try {
		const existing = await readRecentDigestOpenings(env);
		const next = [opening, ...existing.filter((entry) => entry.toLowerCase() !== opening.toLowerCase())]
			.slice(0, FB_DIGEST_RECENT_OPENINGS_LIMIT);

		const record: RecentDigestOpeningsRecord = {
			openings: next,
			updatedAt: new Date().toISOString(),
		};

		await env.WEATHER_KV.put(KV_FB_DIGEST_RECENT_OPENINGS, JSON.stringify(record), {
			expirationTtl: 24 * 60 * 60,
		});
	} catch {
		// Non-critical — recent opening memory is best-effort.
	}
}

export function buildUserPrompt(payload: LlmPromptPayload): string {
	const outputMode = payload.output_mode ?? 'post';
	const exampleStates = payload.example_states ?? [];
	const impacts = payload.impact ?? [];
	const recentOpenings = payload.recent_openings ?? [];
	const alertTypes = payload.top_alert_types ?? [];
	const changeHint = payload.change_hint?.trim() || '';

	const alertList = alertTypes.length > 0
		? `Primary alert types: ${alertTypes.join(', ')}.`
		: '';
	const antiRepetitionSection = recentOpenings.length > 0
		? [
			'Avoid repeating these structures or phrasing:',
			...recentOpenings.map((opening) => `- ${opening}`),
		].join('\n')
		: '';
	const formatSection = outputMode === 'comment'
		? [
			'Format: this is an UPDATE comment on an existing Facebook post.',
			'Start with "UPDATE:".',
			'You MUST describe what changed since the last post.',
			payload.hazard_focus
				? `Keep the update centered on ${capitalizeHazard(payload.hazard_focus).toLowerCase()} in ${payload.regional_focus}.`
				: `Keep the update centered on the same main weather story in ${payload.regional_focus}.`,
			'Do not pivot to a different primary hazard or a different lead region.',
			'Examples of change:',
			'- new states added',
			'- alerts expanded',
			'- intensity increased',
			'- impact shifting regions',
			'DO NOT restate the full situation.',
			'Do not restart with a broad national summary.',
			'Assume the reader already saw the previous post.',
			'Keep it short and specific.',
		].join('\n')
		: [
			'Format: this is a standalone Facebook post.',
			changeHint
				? 'Lead with what changed since the last digest update, not a static list of current alerts.'
				: 'Lead with the weather situation right now.',
			changeHint ? 'Frame it as an evolving weather story.' : '',
			'Use a natural live-desk opening, not a robotic formula.',
		].join('\n');

	return [
		formatSection,
		`Regional focus: ${payload.regional_focus}.`,
		exampleStates.length > 0 ? `Example states: ${exampleStates.join(', ')}.` : '',
		`Trend: ${payload.trend}.`,
		changeHint ? `Change hint: ${changeHint}.` : '',
		changeHint && outputMode === 'post' ? 'Tell readers what changed since the last digest instead of summarizing the full alert board from scratch.' : '',
		impacts.length > 0 ? `Impact: ${impacts.join(', ')}.` : '',
		alertList,
		`Urgency: ${payload.urgency}.`,
		antiRepetitionSection,
		`Write a Facebook post of no more than ${payload.max_length} characters.`,
		`Style: ${payload.style}`,
	].filter(Boolean).join('\n');
}

export function buildLlmPayload(
	summary: DigestSummary,
	recentOpenings: string[] = [],
	outputMode: DigestCopyMode = 'post',
): LlmPromptPayload {
	const impacts = deriveImpact(summary);
	const regionalFocus = buildDigestRegionalFocus(summary);

	return {
		mode: summary.mode,
		post_type: summary.postType,
		output_mode: outputMode,
		hazard_focus: summary.hazardFocus,
		states: summary.states,
		regional_focus: regionalFocus,
		example_states: buildExampleStates(summary.states),
		trend: deriveTrend(summary),
		change_hint: summary.changeHint ?? null,
		impact: impacts,
		top_alert_types: summary.topAlertTypes,
		urgency: summary.urgency,
		max_length: 450,
		style: outputMode === 'comment'
			? 'live national weather desk update comment, brief, direct, change-focused, no hype'
			: 'live national weather desk update, clear, concise, distinct, no hype',
		recent_openings: recentOpenings.slice(0, FB_DIGEST_RECENT_OPENINGS_LIMIT),
	};
}

export function validateLlmOutput(text: string, payload: LlmPromptPayload): LlmPostValidationResult {
	const trimmed = text.trim();
	const maxAllowedLength = Math.min(DIGEST_MAX_CHARS, payload.max_length || DIGEST_MAX_CHARS);
	const stateCodes = payload.states ?? [];
	const exampleStates = payload.example_states ?? [];

	if (!trimmed) {
		return { valid: false, text: trimmed, failureReason: 'empty_output' };
	}
	if (trimmed.length > maxAllowedLength) {
		return { valid: false, text: trimmed, failureReason: 'too_long' };
	}
	if (payload.output_mode === 'comment' && !/^UPDATE:/i.test(trimmed)) {
		return { valid: false, text: trimmed, failureReason: 'missing_update_prefix' };
	}

	const mentionsGeo = stateCodes.some((stateCode) => new RegExp(`\\b${escapeRegExp(stateCode.toUpperCase())}\\b`).test(trimmed))
		|| exampleStates.some((stateName) => trimmed.toLowerCase().includes(stateName.toLowerCase()))
		|| /\b(?:nation|national|country|u\.s\.|u\.?s\.?\s*(?:wide|weather)|midwest|northeast|southeast|southwest|northwest|plains|rockies|west|pacific|caribbean)\b/i.test(trimmed);
	if (!mentionsGeo) {
		return { valid: false, text: trimmed, failureReason: 'no_geography_mention' };
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

function buildDigestCoveragePhrase(summary: DigestSummary, evolving: boolean): string {
	const locationText = summary.states.length > 0
		? formatStateList(summary.states)
		: `parts of the ${buildDigestRegionalFocus(summary)}`;

	if (summary.hazardFocus === 'flood') {
		return evolving
			? `Flooding continues to spread across ${locationText}`
			: `Flood concerns are building across ${locationText}`;
	}
	if (summary.hazardFocus === 'winter') {
		return evolving
			? `Winter weather continues to spread across ${locationText}`
			: `Winter weather is building across ${locationText}`;
	}
	if (summary.hazardFocus === 'wind') {
		return evolving
			? `Wind impacts continue to spread across ${locationText}`
			: `Wind impacts are building across ${locationText}`;
	}
	if (summary.hazardFocus === 'fire') {
		return evolving
			? `Fire weather concerns continue to spread across ${locationText}`
			: `Fire weather concerns are building across ${locationText}`;
	}
	return evolving
		? `Weather impacts continue to shift across ${locationText}`
		: `Weather impacts are building across ${locationText}`;
}

function buildDigestChangeSentence(summary: DigestSummary): string {
	const changeHint = String(summary.changeHint || '').trim();
	const newStatesMatch = changeHint.match(/new states added:\s*([^;]+)/i);
	if (newStatesMatch) {
		return `Additional alerts have spread into ${newStatesMatch[1].trim()} this hour.`;
	}
	const shiftMatch = changeHint.match(/impact shifting from .* toward ([^;]+)/i);
	if (shiftMatch) {
		return `The main focus is shifting toward ${shiftMatch[1].trim()}.`;
	}
	const leadAlertMatch = changeHint.match(/alerts now led by ([^;]+)/i);
	if (leadAlertMatch) {
		return `The latest alerts are now led by ${leadAlertMatch[1].trim()}.`;
	}
	if (/intensity increased/i.test(changeHint) || summary.warningCount > 0) {
		return 'Additional warnings are now coming into the story as conditions worsen.';
	}
	if (summary.topAlertTypes.length > 0) {
		return `The latest alerts are still led by ${joinNaturalList(summary.topAlertTypes.slice(0, 2))}.`;
	}
	return 'Conditions continue to change this hour.';
}

function buildPostFallbackTemplate(summary: DigestSummary): string {
	const situationLine = buildDigestCoveragePhrase(summary, Boolean(summary.changeHint));
	const changeSentence = buildDigestChangeSentence(summary);

	return [
		`${situationLine}.`,
		`${changeSentence} Check local forecasts and follow guidance from your local National Weather Service office.`,
		'Full details: https://liveweatheralerts.com/live',
	].join('\n\n');
}

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildCommentFallbackLead(summary: DigestSummary): string {
	const changeHint = summary.changeHint?.trim();
	if (changeHint) {
		return buildDigestCoveragePhrase(summary, true);
	}
	return buildDigestCoveragePhrase(summary, true);
}

function buildCommentFallbackTemplate(summary: DigestSummary): string {
	const lead = buildCommentFallbackLead(summary);
	const changeSentence = buildDigestChangeSentence(summary);

	return `UPDATE: ${lead}. ${changeSentence} Full details: https://liveweatheralerts.com/live`.trim();
}

function buildFallbackTemplate(summary: DigestSummary, outputMode: DigestCopyMode = 'post'): string {
	return outputMode === 'comment'
		? buildCommentFallbackTemplate(summary)
		: buildPostFallbackTemplate(summary);
}

function capitalizeHazard(family: string): string {
	const labels: Record<string, string> = {
		flood: 'Flooding',
		winter: 'Winter weather',
		wind: 'Strong wind',
		fire: 'Fire weather',
		other: 'Weather',
	};
	return labels[family] ?? 'Weather';
}

function formatStateList(states: string[]): string {
	const names = states.map(stateCodeToName);
	if (names.length === 0) return 'multiple states';
	if (names.length <= 3) return names.join(', ');
	return `${names.slice(0, 3).join(', ')} and ${names.length - 3} other state${names.length - 3 !== 1 ? 's' : ''}`;
}

export async function generateDigestCopy(
	env: Env,
	summary: DigestSummary,
	outputMode: DigestCopyMode = 'post',
): Promise<string> {
	const recentOpenings = await readRecentDigestOpenings(env);
	const payload = buildLlmPayload(summary, recentOpenings, outputMode);

	if (env.AI) {
		try {
			const result = await env.AI.run(LLM_MODEL, {
				messages: [
					{ role: 'system', content: getSystemPrompt(outputMode) },
					{ role: 'user', content: buildUserPrompt(payload) },
				],
				max_tokens: LLM_MAX_TOKENS,
			}) as { response?: string };

			const raw = String(result?.response || '').trim();
			const validation = validateLlmOutput(raw, payload);
			if (validation.valid) {
				return validation.text;
			}
			console.warn(`[fb-llm] validation failed: ${validation.failureReason}, falling back to template`);
		} catch (err) {
			console.error(`[fb-llm] Workers AI error: ${String(err)}, falling back to template`);
		}
	}

	return buildFallbackTemplate(summary, outputMode);
}

/**
 * Returns the appropriate copy function based on whether LLM copy is enabled.
 * When disabled, always uses the deterministic template fallback.
 */
export function createDigestCopyFn(
	llmEnabled: boolean,
	): (env: Env, summary: DigestSummary, outputMode?: DigestCopyMode) => Promise<string> {
	if (llmEnabled) return generateDigestCopy;
	return async (_env: Env, summary: DigestSummary, outputMode: DigestCopyMode = 'post') => buildFallbackTemplate(summary, outputMode);
}
