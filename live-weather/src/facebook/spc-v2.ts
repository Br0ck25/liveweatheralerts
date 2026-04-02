import type {
	AdminConvectiveOutlookConfig,
	Env,
	FbAutoPostConfig,
	PublishedSpcOutlookRecord,
	RecentSpcOpeningsRecord,
	SpcDay1OutlookSummary,
	SpcDebugEntry,
	SpcDebugSnapshot,
	SpcHazardFocus,
	SpcLlmPayload,
	SpcOutlookDay,
	SpcOutlookSummary,
	SpcOutputMode,
	SpcPostDecision,
	SpcPostReason,
	SpcPostType,
	SpcRiskLevel,
	SpcRiskNumber,
	SpcThreadRecord,
} from '../types';
import {
	ADMIN_CONVECTIVE_OUTLOOKS,
	FB_GRAPH_API,
	FB_SPC_RECENT_OPENINGS_LIMIT,
	FB_TIMEOUT_MS,
	KV_FB_SPC_DEBUG,
	KV_FB_SPC_LAST_HASH,
	KV_FB_SPC_LAST_POST,
	KV_FB_SPC_LAST_SUMMARY,
	KV_FB_SPC_RECENT_OPENINGS,
	NWS_USER_AGENT,
	kvSpcLastHashKey,
	kvSpcLastPostKey,
	kvSpcLastSummaryKey,
	kvSpcThreadKey,
} from '../constants';
import {
	decodeHtmlEntities,
	dedupeStrings,
	escapeRegExp,
	sha256Hex,
	stateCodeDisplayName,
	STATE_CODE_TO_NAME,
} from '../utils';
import { fetchRemoteText } from '../weather/api';
import { readFbAutoPostConfig } from './config';
import { buildSpcLlmPayload, generateSpcLlmCopy } from './spc-llm';

export type ParsedSpcOutlookPage = {
	title: string;
	updated: string;
	issuedLabel: string;
	summary: string;
	discussionText: string;
	pageUrl: string;
	imageUrl: string | null;
	headlineText: string | null;
	sectionHeadings: string[];
	timingText: string | null;
};

const SPC_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SPC_COMMENT_MAX_COUNT = 2;
const SPC_COMMENT_MIN_GAP_MS = 90 * 60 * 1000;
const SPC_GLOBAL_POST_GAP_MS = 15 * 60 * 1000;
const SPC_TIMING_REFRESH_MIN_GAP_MS = 4 * 60 * 60 * 1000;
const SPC_TIMING_REFRESH_START_OFFSET_MS = 5 * 60 * 60 * 1000;
const SPC_TIMING_REFRESH_END_BUFFER_MS = 6 * 60 * 60 * 1000;
const SPC_MAX_STATE_COUNT = 5;
const SPC_SCHEDULING_TIME_ZONE = 'America/Chicago';
const SPC_DAY1_MAIN_WINDOW = { startMinutes: (6 * 60) + 30, endMinutes: 9 * 60, label: 'day1_morning' };
const SPC_DAY2_MAIN_WINDOW = { startMinutes: (11 * 60) + 30, endMinutes: 14 * 60, label: 'day2_midday' };
const SPC_DAY3_MAIN_WINDOW = { startMinutes: (18 * 60) + 30, endMinutes: 21 * 60, label: 'day3_evening' };
const SPC_DAY1_TIMING_REFRESH_WINDOW = { startMinutes: 15 * 60, endMinutes: 18 * 60, label: 'day1_late_day_refresh' };
const SPC_LOCAL_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
	timeZone: SPC_SCHEDULING_TIME_ZONE,
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
});

const RISK_LEVEL_TO_NUMBER: Record<SpcRiskLevel, SpcRiskNumber> = {
	none: 0,
	marginal: 1,
	slight: 2,
	enhanced: 3,
	moderate: 4,
	high: 5,
};

const GEOJSON_LABEL_TO_LEVEL: Record<string, SpcRiskLevel> = {
	TSTM: 'none',
	TMST: 'none',
	NONE: 'none',
	MRGL: 'marginal',
	SLGT: 'slight',
	ENH: 'enhanced',
	MDT: 'moderate',
	HIGH: 'high',
};

const SAFE_STATE_ABBREVIATION_CODES = new Set(
	Object.keys(STATE_CODE_TO_NAME)
		.filter((code) => !['IN', 'ME', 'OR', 'HI', 'GU', 'PR', 'VI'].includes(code)),
);

const REGION_TEXT_HINTS: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /upper midwest/i, label: 'Upper Midwest' },
	{ pattern: /great lakes/i, label: 'Great Lakes' },
	{ pattern: /mid-?south/i, label: 'Mid-South' },
	{ pattern: /southern plains/i, label: 'Southern Plains' },
	{ pattern: /central plains/i, label: 'Central Plains' },
	{ pattern: /northern plains/i, label: 'Northern Plains' },
	{ pattern: /gulf coast/i, label: 'Gulf Coast' },
	{ pattern: /ohio valley/i, label: 'Ohio Valley' },
	{ pattern: /northeast/i, label: 'Northeast' },
	{ pattern: /southeast/i, label: 'Southeast' },
	{ pattern: /southwest/i, label: 'Southwest' },
	{ pattern: /midwest/i, label: 'Midwest' },
	{ pattern: /plains/i, label: 'Plains' },
	{ pattern: /west coast|rockies|intermountain west|western states/i, label: 'West' },
];

const TIMING_TEXT_HINTS: Array<{ pattern: RegExp; value: string }> = [
	{ pattern: /late afternoon through evening/i, value: 'late afternoon through evening' },
	{ pattern: /late afternoon into evening/i, value: 'late afternoon into evening' },
	{ pattern: /afternoon into evening/i, value: 'afternoon into evening' },
	{ pattern: /late afternoon and evening/i, value: 'late afternoon and evening' },
	{ pattern: /this afternoon and evening/i, value: 'this afternoon and evening' },
	{ pattern: /this afternoon/i, value: 'this afternoon' },
	{ pattern: /this evening/i, value: 'this evening' },
	{ pattern: /overnight/i, value: 'overnight' },
	{ pattern: /late afternoon/i, value: 'late afternoon' },
	{ pattern: /tomorrow afternoon into evening/i, value: 'tomorrow afternoon into evening' },
	{ pattern: /tomorrow/i, value: 'tomorrow' },
	{ pattern: /during the day 3 period/i, value: 'during the day 3 period' },
];

const UPPER_MIDWEST_STATES = new Set(['IA', 'IL', 'MN', 'WI', 'MI']);
const GREAT_LAKES_STATES = new Set(['IL', 'IN', 'MI', 'OH', 'PA', 'WI']);
const MID_SOUTH_STATES = new Set(['AL', 'AR', 'KY', 'LA', 'MO', 'MS', 'TN']);
const SOUTHERN_PLAINS_STATES = new Set(['KS', 'OK', 'TX']);
const CENTRAL_PLAINS_STATES = new Set(['KS', 'NE', 'SD', 'ND']);

const REGION_BUCKETS: Record<string, string> = {
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
	KS: 'Plains',
	ND: 'Plains',
	NE: 'Plains',
	OK: 'Plains',
	SD: 'Plains',
	TX: 'Plains',
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
};

const REGION_PRIORITY = ['Upper Midwest', 'Great Lakes', 'Mid-South', 'Southern Plains', 'Central Plains', 'Midwest', 'Southeast', 'Plains', 'Southwest', 'West', 'Northeast'];

const FULL_NAME_STATE_PATTERNS = Object.keys(STATE_CODE_TO_NAME)
	.filter((code) => !['GU', 'PR', 'VI'].includes(code))
	.map((code) => ({
		code,
		pattern: new RegExp(`\\b${escapeRegExp(stateCodeDisplayName(code))}\\b`, 'gi'),
	}));

const ABBREVIATION_STATE_PATTERNS = Object.keys(STATE_CODE_TO_NAME)
	.filter((code) => SAFE_STATE_ABBREVIATION_CODES.has(code))
	.map((code) => ({
		code,
		pattern: new RegExp(`\\b${code}\\b`, 'g'),
	}));

function fbAbortSignal(): AbortSignal {
	return AbortSignal.timeout(FB_TIMEOUT_MS);
}

function normalizeSpaces(value: string): string {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseIsoMs(value: string | null | undefined): number | null {
	const ms = Date.parse(String(value || ''));
	return Number.isFinite(ms) ? ms : null;
}

function isoDay(value: string | null | undefined): string {
	const text = String(value || '').trim();
	return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}

function getSpcLocalClockMinutes(nowMs: number): number {
	const parts = SPC_LOCAL_TIME_FORMATTER.formatToParts(new Date(nowMs));
	const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0');
	const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0');
	return (hour * 60) + minute;
}

function isWithinClockWindow(nowMs: number, startMinutes: number, endMinutes: number): boolean {
	const localMinutes = getSpcLocalClockMinutes(nowMs);
	return localMinutes >= startMinutes && localMinutes <= endMinutes;
}

function normalizeStoryText(value: string | null | undefined): string {
	return normalizeSpaces(value || '').toLowerCase();
}

function normalizeStoryList(values: string[] | null | undefined): string[] {
	return dedupeStrings((values || []).map((value) => normalizeStoryText(value)));
}

function hasTornadoStorySignal(summary: {
	hazardFocus?: SpcHazardFocus | null;
	hazardList?: string[] | null;
	tornadoProbability?: number | null;
} | null | undefined): boolean {
	if (!summary) return false;
	if (summary.hazardFocus === 'tornado') return true;
	if (Number(summary.tornadoProbability || 0) > 0) return true;
	return normalizeStoryList(summary.hazardList).includes('tornadoes');
}

function spcRiskNumber(level: SpcRiskLevel): SpcRiskNumber {
	return RISK_LEVEL_TO_NUMBER[level] ?? 0;
}

function riskLabelDisplay(level: SpcRiskLevel): string {
	if (level === 'marginal') return 'Marginal';
	if (level === 'slight') return 'Slight';
	if (level === 'enhanced') return 'Enhanced';
	if (level === 'moderate') return 'Moderate';
	if (level === 'high') return 'High';
	return 'General Thunderstorms';
}

function getOutlookConfig(day: SpcOutlookDay): AdminConvectiveOutlookConfig {
	return ADMIN_CONVECTIVE_OUTLOOKS.find((entry) => entry.id === `day${day}`)
		?? { id: `day${day}`, label: `Day ${day}`, pageUrl: `https://www.spc.noaa.gov/products/outlook/day${day}otlk.html`, imagePrefix: `day${day}` };
}

function getSpcCategoricalGeoJsonUrl(day: SpcOutlookDay): string {
	return `https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`;
}

function extractSpcDiscussionSummary(text: string): string {
	const lines = String(text || '').split(/\r?\n/);
	const summaryIndex = lines.findIndex((line) => line.trim().toUpperCase() === '...SUMMARY...');
	if (summaryIndex === -1) return '';
	const collected: string[] = [];
	for (let index = summaryIndex + 1; index < lines.length; index += 1) {
		const line = normalizeSpaces(lines[index] || '');
		if (!line) {
			if (collected.length > 0) break;
			continue;
		}
		if (/^\.\.\..+\.\.\.$/.test(line)) break;
		collected.push(line);
	}
	return collected.join(' ').trim();
}

function extractEllipsisSections(text: string): string[] {
	const flattened = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ');
	return dedupeStrings(
		Array.from(flattened.matchAll(/\.\.\.\s*(.{3,180}?)\s*\.\.\./g))
			.map((match) => normalizeSpaces(match[1] || ''))
			.filter(Boolean),
	);
}

function deriveTimingText(text: string): string | null {
	for (const hint of TIMING_TEXT_HINTS) {
		if (hint.pattern.test(text)) return hint.value;
	}
	return null;
}

export function parseSpcOutlookPage(html: string, config: AdminConvectiveOutlookConfig): ParsedSpcOutlookPage {
	const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
	const pageTitle = decodeHtmlEntities(String(pageTitleMatch?.[1] || `${config.label} Convective Outlook`)).replace(/\s+/g, ' ').trim();
	const updatedMatch = html.match(/Updated:(?:&nbsp;|\s)*([^<]+?)(?:&nbsp;|\s)*\(/i);
	const updated = decodeHtmlEntities(String(updatedMatch?.[1] || '')).replace(/\s+/g, ' ').trim();
	const defaultTabMatch = html.match(/onload="[^"]*show_tab\('([^']+)'\)/i) || html.match(/show_tab\('([^']+)'\)/i);
	const defaultTab = String(defaultTabMatch?.[1] || '').trim();
	const imageUrl = defaultTab ? new URL(`${config.imagePrefix}${defaultTab}.png`, config.pageUrl).toString() : null;
	const markerIndex = html.toLowerCase().indexOf('forecast discussion');
	const preStart = markerIndex >= 0 ? html.indexOf('<pre>', markerIndex) : html.indexOf('<pre>');
	const preEnd = preStart >= 0 ? html.indexOf('</pre>', preStart) : -1;
	const discussionText = preStart >= 0 && preEnd > preStart
		? decodeHtmlEntities(html.slice(preStart + 5, preEnd)).replace(/\r/g, '').trim()
		: '';
	const issuedLineMatch = discussionText.match(/NWS Storm Prediction Center Norman OK\s+([^\n]+)/i);
	const issuedLabel = normalizeSpaces(String(issuedLineMatch?.[1] || ''));
	const ellipsisSections = extractEllipsisSections(discussionText);
	const headlineText = ellipsisSections.find((section) => /^THERE IS\b/i.test(section)) ?? null;
	const sectionHeadings = ellipsisSections.filter((section) => section !== headlineText && !/^SUMMARY$/i.test(section)).slice(0, 4);
	const titleMatch = discussionText.match(/Day\s+\d+\s+Convective Outlook[^\n]*/i);
	const timingText = deriveTimingText([headlineText, extractSpcDiscussionSummary(discussionText), ...sectionHeadings, discussionText].filter(Boolean).join(' '));

	return {
		title: titleMatch?.[0]?.trim() || pageTitle,
		updated,
		issuedLabel,
		summary: extractSpcDiscussionSummary(discussionText),
		discussionText,
		pageUrl: config.pageUrl,
		imageUrl,
		headlineText,
		sectionHeadings,
		timingText,
	};
}

export function parseSpcDay1OutlookPage(html: string, config: AdminConvectiveOutlookConfig = getOutlookConfig(1)): ParsedSpcOutlookPage {
	return parseSpcOutlookPage(html, config);
}

async function fetchSpcCategoricalGeoJson(day: SpcOutlookDay): Promise<any> {
	const response = await fetch(getSpcCategoricalGeoJsonUrl(day), {
		headers: {
			'User-Agent': NWS_USER_AGENT,
			Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.8',
		},
	});
	if (!response.ok) {
		throw new Error(`SPC Day ${day} categorical outlook request failed: ${response.status} ${response.statusText}`);
	}
	return await response.json();
}

function getRiskLevelFromGeoJsonFeature(feature: any): SpcRiskLevel {
	const label = String(feature?.properties?.LABEL || '').trim().toUpperCase();
	return GEOJSON_LABEL_TO_LEVEL[label] ?? 'none';
}

function selectHighestRiskFeature(features: any[]): any | null {
	const ordered = [...features].sort((a, b) => spcRiskNumber(getRiskLevelFromGeoJsonFeature(b)) - spcRiskNumber(getRiskLevelFromGeoJsonFeature(a)));
	return ordered[0] ?? null;
}

function collectPatternMatches(text: string, entries: Array<{ code: string; pattern: RegExp }>, priority: number): Array<{ code: string; index: number; priority: number }> {
	const matches: Array<{ code: string; index: number; priority: number }> = [];
	for (const entry of entries) {
		entry.pattern.lastIndex = 0;
		let match: RegExpExecArray | null = null;
		while ((match = entry.pattern.exec(text)) !== null) {
			matches.push({ code: entry.code, index: match.index, priority });
		}
	}
	return matches;
}

function extractOrderedStateCodesFromText(text: string): string[] {
	const rawText = String(text || '');
	const upperText = rawText.toUpperCase();
	const matches = [
		...collectPatternMatches(rawText, FULL_NAME_STATE_PATTERNS, 0),
		...collectPatternMatches(upperText, ABBREVIATION_STATE_PATTERNS, 1),
	].sort((a, b) => {
		const indexDiff = a.index - b.index;
		if (indexDiff !== 0) return indexDiff;
		return a.priority - b.priority;
	});

	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const match of matches) {
		if (seen.has(match.code)) continue;
		seen.add(match.code);
		ordered.push(match.code);
	}
	return ordered;
}

function stripRiskLead(text: string): string {
	return normalizeSpaces(
		String(text || '')
			.replace(/^there is (?:a|an)\s+(?:marginal|slight|enhanced|moderate|high)\s+risk of severe thunderstorms\s*/i, '')
			.replace(/^there is\s+/i, '')
			.replace(/^across parts of\s+/i, '')
			.replace(/^centered on\s+/i, ''),
	);
}

function titleCaseDirectionalPhrase(text: string): string {
	return normalizeSpaces(
		String(text || '').replace(/\b([a-z][a-z'-]*)\b/g, (match, word) => {
			if (/^(and|or|the|of|into|across|for|to|from)$/i.test(word)) return word.toLowerCase();
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		}),
	);
}

function buildReadableFocusPhrase(text: string): string | null {
	const cleaned = stripRiskLead(
		String(text || '')
			.replace(/\.{3,}/g, ', ')
			.replace(/[\/]+/g, ', ')
			.replace(/\s*,\s*,+/g, ', ')
			.replace(/\s+,/g, ',')
			.replace(/,\s*and\s+/gi, ', and '),
	);
	if (!cleaned) return null;
	const compact = cleaned.replace(/^,\s*/, '').replace(/\s*,\s*/g, ', ').trim();
	if (!compact) return null;
	const listified = compact.includes(',') ? compact.replace(/,\s*([^,]+)$/u, ', and $1') : compact;
	return titleCaseDirectionalPhrase(listified);
}

function deriveStateFocusText(page: ParsedSpcOutlookPage): string | null {
	for (const section of page.sectionHeadings) {
		const focusText = buildReadableFocusPhrase(section);
		if (focusText && extractOrderedStateCodesFromText(focusText).length > 0) {
			return focusText;
		}
	}
	const headlineFocus = buildReadableFocusPhrase(page.headlineText || '');
	if (headlineFocus && extractOrderedStateCodesFromText(headlineFocus).length > 0) {
		return headlineFocus;
	}
	const summaryFocus = buildReadableFocusPhrase(page.summary || '');
	if (summaryFocus && extractOrderedStateCodesFromText(summaryFocus).length > 0) {
		return summaryFocus;
	}
	return null;
}

function deriveAffectedStates(page: ParsedSpcOutlookPage): string[] {
	const prioritizedSources = [
		...page.sectionHeadings,
		page.headlineText,
		page.summary,
	].filter(Boolean);
	for (const source of prioritizedSources) {
		const focusedStates = extractOrderedStateCodesFromText(source).slice(0, SPC_MAX_STATE_COUNT);
		if (focusedStates.length > 0) return focusedStates;
	}
	return extractOrderedStateCodesFromText(page.discussionText).slice(0, SPC_MAX_STATE_COUNT);
}

function inferPrimaryRegionFromText(text: string): string | null {
	for (const hint of REGION_TEXT_HINTS) {
		if (hint.pattern.test(text)) return hint.label;
	}
	return null;
}

function buildBaseRegionFromStates(states: string[]): string {
	const stateSet = new Set(states);
	const regionCounts = new Map<string, number>();
	for (const state of states) {
		const region = REGION_BUCKETS[state];
		if (!region) continue;
		regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
	}

	if (states.some((state) => SOUTHERN_PLAINS_STATES.has(state)) && (stateSet.has('TX') || stateSet.has('OK'))) {
		return 'Southern Plains';
	}
	if ((states.every((state) => CENTRAL_PLAINS_STATES.has(state)) || states.some((state) => CENTRAL_PLAINS_STATES.has(state))) && !stateSet.has('TX') && !stateSet.has('OK')) {
		return 'Central Plains';
	}
	if (states.some((state) => MID_SOUTH_STATES.has(state))) {
		return 'Mid-South';
	}

	const orderedRegions = Array.from(regionCounts.entries())
		.sort((a, b) => {
			const countDiff = b[1] - a[1];
			if (countDiff !== 0) return countDiff;
			return REGION_PRIORITY.indexOf(a[0]) - REGION_PRIORITY.indexOf(b[0]);
		})
		.map(([region]) => region);

	return orderedRegions[0] ?? 'National';
}

function derivePrimaryRegion(page: ParsedSpcOutlookPage, states: string[]): string {
	const stateDrivenRegion = buildBaseRegionFromStates(states);
	if (states.length > 0 && stateDrivenRegion !== 'National') {
		return stateDrivenRegion;
	}
	const focusText = normalizeSpaces([page.headlineText, page.summary, ...page.sectionHeadings].filter(Boolean).join(' '));
	return inferPrimaryRegionFromText(focusText) ?? stateDrivenRegion;
}

function countPattern(text: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	const matches = text.match(pattern);
	return matches ? matches.length : 0;
}

function deriveProbabilityFromText(text: string, hazard: 'tornado' | 'wind' | 'hail'): number | null {
	const patterns = hazard === 'tornado'
		? [/([0-9]{1,2})%\s+(?:probability of\s+)?tornado(?:es)?/gi, /tornado(?:es)?\s+(?:probabilities?|probability)\s+(?:around|near|up to)?\s*([0-9]{1,2})%/gi]
		: hazard === 'wind'
			? [/([0-9]{1,2})%\s+(?:probability of\s+)?(?:damaging\s+)?wind/gi, /wind\s+(?:probabilities?|probability)\s+(?:around|near|up to)?\s*([0-9]{1,2})%/gi]
			: [/([0-9]{1,2})%\s+(?:probability of\s+)?(?:large\s+)?hail/gi, /hail\s+(?:probabilities?|probability)\s+(?:around|near|up to)?\s*([0-9]{1,2})%/gi];

	let best: number | null = null;
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null = null;
		while ((match = pattern.exec(text)) !== null) {
			const value = Number(match[1]);
			if (!Number.isFinite(value)) continue;
			best = best == null ? value : Math.max(best, value);
		}
	}
	return best;
}

function deriveProbabilities(page: ParsedSpcOutlookPage): Pick<SpcOutlookSummary, 'tornadoProbability' | 'windProbability' | 'hailProbability' | 'probabilitySource'> {
	const combined = [page.headlineText, page.summary, page.discussionText].filter(Boolean).join(' ');
	const tornadoProbability = deriveProbabilityFromText(combined, 'tornado');
	const windProbability = deriveProbabilityFromText(combined, 'wind');
	const hailProbability = deriveProbabilityFromText(combined, 'hail');
	const hasAny = tornadoProbability != null || windProbability != null || hailProbability != null;
	return {
		tornadoProbability,
		windProbability,
		hailProbability,
		probabilitySource: hasAny ? 'text' : 'none',
	};
}

function deriveHazardFocus(summaryText: string, discussionText: string, probabilities: { tornadoProbability?: number | null; windProbability?: number | null; hailProbability?: number | null }): SpcHazardFocus {
	const probabilityScores: Array<{ hazard: SpcHazardFocus; score: number }> = [
		{ hazard: 'tornado', score: Number(probabilities.tornadoProbability || 0) },
		{ hazard: 'wind', score: Number(probabilities.windProbability || 0) },
		{ hazard: 'hail', score: Number(probabilities.hailProbability || 0) },
	].sort((a, b) => b.score - a.score);
	const probabilityTop = probabilityScores[0];
	const probabilitySecond = probabilityScores[1];
	if (probabilityTop && probabilityTop.score > 0) {
		if (probabilitySecond && probabilitySecond.score > 0 && (probabilityTop.score - probabilitySecond.score) <= 4) {
			return 'mixed';
		}
		return probabilityTop.hazard;
	}

	const text = `${summaryText} ${discussionText}`.toLowerCase();
	if (/all severe hazards/i.test(text)) return 'mixed';
	const tornadoScore = countPattern(text, /\btornado(?:es)?\b/g) + countPattern(text, /\brotation\b/g);
	const windScore = countPattern(text, /\bdamaging (?:thunderstorm )?winds?\b/g) + countPattern(text, /\bwind damage\b/g) + countPattern(text, /\bgusts?\b/g);
	const hailScore = countPattern(text, /\blarge hail\b/g) + countPattern(text, /\bhail\b/g);
	const scores: Array<{ hazard: SpcHazardFocus; score: number }> = [
		{ hazard: 'tornado', score: tornadoScore },
		{ hazard: 'wind', score: windScore },
		{ hazard: 'hail', score: hailScore },
	].sort((a, b) => b.score - a.score);
	const top = scores[0];
	const second = scores[1];
	if (!top || top.score <= 0) return 'mixed';
	if (second && second.score > 0 && (top.score - second.score) <= 1) return 'mixed';
	return top.hazard;
}

function buildHazardList(summaryText: string, discussionText: string, probabilities: { tornadoProbability?: number | null; windProbability?: number | null; hailProbability?: number | null }): string[] {
	const text = `${summaryText} ${discussionText}`.toLowerCase();
	const hazards: Array<{ label: string; score: number }> = [
		{
			label: 'tornadoes',
			score: Number(probabilities.tornadoProbability || 0)
				+ countPattern(text, /\btornado(?:es)?\b/g)
				+ countPattern(text, /\brotation\b/g),
		},
		{
			label: /widespread damaging wind|significant wind|severe wind swath|strong wind field/.test(text) ? 'widespread damaging winds' : 'damaging winds',
			score: Number(probabilities.windProbability || 0)
				+ countPattern(text, /\bdamaging (?:thunderstorm )?winds?\b/g)
				+ countPattern(text, /\bwind damage\b/g)
				+ countPattern(text, /\bsevere gusts?\b/g),
		},
		{
			label: 'large hail',
			score: Number(probabilities.hailProbability || 0)
				+ countPattern(text, /\blarge hail\b/g)
				+ countPattern(text, /\bhail\b/g),
		},
	].filter((entry) => entry.score > 0);

	if (hazards.length === 0) {
		return ['severe weather impacts'];
	}

	return hazards
		.sort((a, b) => b.score - a.score)
		.map((entry) => entry.label)
		.filter((label, index, list) => list.indexOf(label) === index)
		.slice(0, 3);
}

function deriveStormMode(page: ParsedSpcOutlookPage): string | null {
	const text = `${page.headlineText || ''} ${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	if (/fast-moving supercells?|rapidly moving supercells?|quickly moving supercells?/.test(text)) return 'fast-moving supercells';
	if (/large squall line|organized squall line/.test(text)) return 'a large squall line';
	if (/squall line|qlcs|quasi-linear/.test(text)) return 'a squall line';
	if (/discrete supercells?/.test(text)) return 'discrete supercells';
	if (/supercells?/.test(text)) return 'supercells';
	if (/line of storms|linear storm mode|bowing segments?/.test(text)) return 'a line of storms';
	if (/storm clusters?|organized clusters?/.test(text)) return 'storm clusters';
	return null;
}

function deriveNotableText(page: ParsedSpcOutlookPage, stormMode: string | null): string | null {
	const text = `${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	if (/short warning lead time|limit(?:ed)? warning time|warning lead time/.test(text)) {
		return 'storms may move quickly enough to limit warning time';
	}
	if ((stormMode?.includes('fast-moving') || /move quickly|moving quickly|race northeast|rapidly move|moving very fast/.test(text))) {
		return 'storms may move quickly enough to limit warning time';
	}
	if (/embedded tornado(?: risk| threat| potential)?/.test(text) && /discrete.*early|before .*line/.test(text)) {
		return 'a few discrete storms may form early before the line organizes';
	}
	if (/discrete.*early|before .*line/.test(text)) {
		return 'a few discrete storms may form before the main line organizes';
	}
	if (/organizing late afternoon into (?:the )?evening|late afternoon into evening|late day into evening/.test(text)) {
		return 'the system should organize late afternoon into the evening';
	}
	if (/embedded tornado/.test(text)) {
		return 'embedded tornado potential may develop within the line';
	}
	return null;
}

function buildSummaryHashSeed(summary: Omit<SpcOutlookSummary, 'summaryHash'>): string {
	return JSON.stringify({
		outlookDay: summary.outlookDay,
		forecastDay: isoDay(summary.validFrom) || isoDay(summary.issuedAt),
		risk: summary.highestRiskNumber,
		states: [...summary.affectedStates].sort(),
		stateFocusText: summary.stateFocusText ?? null,
		region: summary.primaryRegion,
		hazard: summary.hazardFocus,
		hazardList: summary.hazardList ?? [],
		stormMode: summary.stormMode ?? null,
		notableText: summary.notableText ?? null,
		tornadoProbability: summary.tornadoProbability ?? null,
		windProbability: summary.windProbability ?? null,
		hailProbability: summary.hailProbability ?? null,
	});
}

export function normalizeSpcMinRiskLevel(value: unknown): SpcRiskLevel {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'marginal' || normalized === 'slight' || normalized === 'enhanced' || normalized === 'moderate' || normalized === 'high') {
		return normalized as SpcRiskLevel;
	}
	return 'slight';
}

export async function buildSpcOutlookSummary(day: SpcOutlookDay, page: ParsedSpcOutlookPage, geojson: any): Promise<SpcOutlookSummary> {
	const features = Array.isArray(geojson?.features) ? geojson.features : [];
	const highestRiskFeature = selectHighestRiskFeature(features);
	const timingProps = highestRiskFeature?.properties ?? features[0]?.properties ?? {};
	const highestRiskLevel = getRiskLevelFromGeoJsonFeature(highestRiskFeature);
	const highestRiskNumber = spcRiskNumber(highestRiskLevel);
	const stateFocusText = deriveStateFocusText(page);
	const affectedStates = deriveAffectedStates(page);
	const primaryRegion = derivePrimaryRegion(page, affectedStates);
	const probabilities = deriveProbabilities(page);
	const hazardFocus = deriveHazardFocus(page.summary, page.discussionText, probabilities);
	const hazardList = buildHazardList(page.summary, page.discussionText, probabilities);
	const stormMode = deriveStormMode(page);
	const notableText = deriveNotableText(page, stormMode);

	const summaryWithoutHash: Omit<SpcOutlookSummary, 'summaryHash'> = {
		issuedAt: String(timingProps?.ISSUE_ISO || '').trim(),
		validFrom: String(timingProps?.VALID_ISO || '').trim(),
		validTo: String(timingProps?.EXPIRE_ISO || '').trim(),
		outlookDay: day,
		highestRiskLevel,
		highestRiskNumber,
		affectedStates,
		stateFocusText,
		primaryRegion,
		hazardFocus,
		hazardList,
		stormMode,
		notableText,
		tornadoProbability: probabilities.tornadoProbability,
		windProbability: probabilities.windProbability,
		hailProbability: probabilities.hailProbability,
		probabilitySource: probabilities.probabilitySource,
		timingText: page.timingText,
		summaryText: page.summary || null,
		discussionText: page.discussionText || null,
		imageUrl: page.imageUrl,
		sourceUrl: page.pageUrl,
		title: page.title || null,
		updatedAt: page.updated || null,
	};
	const summaryHash = await sha256Hex(buildSummaryHashSeed(summaryWithoutHash));
	return { ...summaryWithoutHash, summaryHash };
}

export async function buildSpcDay1OutlookSummary(page: ParsedSpcOutlookPage, geojson: any): Promise<SpcDay1OutlookSummary> {
	return await buildSpcOutlookSummary(1, page, geojson) as SpcDay1OutlookSummary;
}

export async function fetchLatestSpcOutlookSummary(day: SpcOutlookDay): Promise<SpcOutlookSummary> {
	const config = getOutlookConfig(day);
	const [html, geojson] = await Promise.all([
		fetchRemoteText(config.pageUrl, `SPC Day ${day} convective outlook`),
		fetchSpcCategoricalGeoJson(day),
	]);
	return await buildSpcOutlookSummary(day, parseSpcOutlookPage(html, config), geojson);
}

export async function fetchLatestSpcDay1OutlookSummary(): Promise<SpcDay1OutlookSummary> {
	return await fetchLatestSpcOutlookSummary(1) as SpcDay1OutlookSummary;
}

function forecastDayKey(summaryOrRecord: { validFrom?: string; issuedAt: string }): string {
	return isoDay(summaryOrRecord.validFrom) || isoDay(summaryOrRecord.issuedAt);
}

function hasMaterialStateShift(previousStates: string[], currentStates: string[]): boolean {
	const previousSet = new Set(previousStates);
	const currentSet = new Set(currentStates);
	const added = currentStates.filter((state) => !previousSet.has(state));
	const removed = previousStates.filter((state) => !currentSet.has(state));
	if (added.length >= 2 || removed.length >= 2) return true;
	const overlap = previousStates.filter((state) => currentSet.has(state)).length;
	const largerSetSize = Math.max(previousStates.length, currentStates.length);
	if (largerSetSize === 0) return false;
	return (overlap / largerSetSize) < 0.5;
}

function hasMeaningfulProbabilityShift(previous: PublishedSpcOutlookRecord | null, current: SpcOutlookSummary): boolean {
	if (!previous) return false;
	const probabilityDiffs = [
		Math.abs(Number(current.tornadoProbability ?? 0) - Number(previous.tornadoProbability ?? 0)),
		Math.abs(Number(current.windProbability ?? 0) - Number(previous.windProbability ?? 0)),
		Math.abs(Number(current.hailProbability ?? 0) - Number(previous.hailProbability ?? 0)),
	];
	return probabilityDiffs.some((diff) => diff >= 5);
}

function hasMajorStoryShift(previous: PublishedSpcOutlookRecord | null, current: SpcOutlookSummary): boolean {
	if (!previous) return false;
	if (hasTornadoStorySignal(current) && !hasTornadoStorySignal(previous)) {
		return true;
	}
	if (normalizeStoryText(current.stormMode) && normalizeStoryText(current.stormMode) !== normalizeStoryText(previous.stormMode)) {
		return true;
	}
	if (normalizeStoryText(current.notableText) && normalizeStoryText(current.notableText) !== normalizeStoryText(previous.notableText)) {
		return true;
	}
	if (
		normalizeStoryText(current.stateFocusText)
		&& normalizeStoryText(current.stateFocusText) !== normalizeStoryText(previous.stateFocusText)
		&& hasMaterialStateShift(previous.affectedStates, current.affectedStates)
	) {
		return true;
	}
	return false;
}

function spcPrimaryWindow(day: SpcOutlookDay) {
	if (day === 1) return SPC_DAY1_MAIN_WINDOW;
	if (day === 2) return SPC_DAY2_MAIN_WINDOW;
	return SPC_DAY3_MAIN_WINDOW;
}

function shouldBypassSpcTimeWindow(
	decision: SpcPostDecision,
	previousPost: PublishedSpcOutlookRecord | null,
	currentSummary: SpcOutlookSummary,
): boolean {
	if (decision.reason === 'risk_upgrade' || decision.reason === 'region_shift' || decision.reason === 'probability_shift') {
		return true;
	}
	if (decision.reason === 'hazard_change') {
		return true;
	}
	return hasMajorStoryShift(previousPost, currentSummary);
}

export function evaluateSpcPostingSchedule(
	summary: SpcOutlookSummary,
	decision: SpcPostDecision,
	lastPost: PublishedSpcOutlookRecord | null,
	nowMs = Date.now(),
): {
	allowed: boolean;
	reason: 'within_window' | 'override' | 'outside_window';
	windowLabel: string;
} {
	const window = decision.postType === 'timing_refresh'
		? SPC_DAY1_TIMING_REFRESH_WINDOW
		: spcPrimaryWindow(summary.outlookDay);
	if (isWithinClockWindow(nowMs, window.startMinutes, window.endMinutes)) {
		return {
			allowed: true,
			reason: 'within_window',
			windowLabel: window.label,
		};
	}
	if (shouldBypassSpcTimeWindow(decision, lastPost, summary)) {
		return {
			allowed: true,
			reason: 'override',
			windowLabel: window.label,
		};
	}
	return {
		allowed: false,
		reason: 'outside_window',
		windowLabel: window.label,
	};
}

function isTimingRefreshWindow(summary: SpcOutlookSummary, nowMs: number): boolean {
	if (summary.outlookDay !== 1) return false;
	const validFromMs = parseIsoMs(summary.validFrom);
	const validToMs = parseIsoMs(summary.validTo);
	if (validFromMs == null || validToMs == null) return false;
	if (nowMs < (validFromMs + SPC_TIMING_REFRESH_START_OFFSET_MS)) return false;
	if (nowMs > (validToMs - SPC_TIMING_REFRESH_END_BUFFER_MS)) return false;
	return true;
}

function getMinRiskLevelForDay(config: FbAutoPostConfig, day: SpcOutlookDay): SpcRiskLevel {
	if (day === 1) return normalizeSpcMinRiskLevel(config.spcDay1MinRiskLevel ?? config.spcMinRiskLevel ?? 'slight');
	if (day === 2) return normalizeSpcMinRiskLevel(config.spcDay2MinRiskLevel ?? 'enhanced');
	return normalizeSpcMinRiskLevel(config.spcDay3MinRiskLevel ?? 'enhanced');
}

function isCoverageEnabledForDay(config: FbAutoPostConfig, day: SpcOutlookDay): boolean {
	if (day === 1) return config.spcDay1CoverageEnabled ?? config.spcCoverageEnabled ?? false;
	if (day === 2) return config.spcDay2CoverageEnabled === true;
	return config.spcDay3CoverageEnabled === true;
}

function defaultPostTypeForDay(day: SpcOutlookDay): Exclude<SpcPostType, ''> {
	if (day === 2) return 'day2_lookahead';
	if (day === 3) return 'day3_heads_up';
	return 'main_setup';
}

function shouldPostTimingRefresh(summary: SpcOutlookSummary, lastPost: PublishedSpcOutlookRecord | null, config: FbAutoPostConfig, nowMs: number): boolean {
	if (summary.outlookDay !== 1) return false;
	if (config.spcTimingRefreshEnabled !== true) return false;
	if (!lastPost) return false;
	if (lastPost.summaryHash !== summary.summaryHash) return false;
	if (lastPost.postType === 'timing_refresh') return false;
	const lastPostedMs = parseIsoMs(lastPost.postedAt);
	if (lastPostedMs != null && (nowMs - lastPostedMs) < SPC_TIMING_REFRESH_MIN_GAP_MS) return false;
	const strongEnough = summary.highestRiskNumber >= 3 || (summary.highestRiskNumber >= 2 && summary.hazardFocus === 'tornado');
	if (!strongEnough) return false;
	return isTimingRefreshWindow(summary, nowMs);
}

export function buildSpcPostDecision(summary: SpcOutlookSummary, lastPost: PublishedSpcOutlookRecord | null, config: FbAutoPostConfig, nowMs = Date.now()): SpcPostDecision {
	const minRiskNumber = spcRiskNumber(getMinRiskLevelForDay(config, summary.outlookDay));
	if (summary.highestRiskNumber < minRiskNumber) {
		return { shouldPost: false, reason: 'below_threshold', postType: '' };
	}

	if (!lastPost || forecastDayKey(lastPost) !== forecastDayKey(summary)) {
		return { shouldPost: true, reason: 'new_slight_or_higher', postType: defaultPostTypeForDay(summary.outlookDay) };
	}

	if (summary.summaryHash === lastPost.summaryHash) {
		if (shouldPostTimingRefresh(summary, lastPost, config, nowMs)) {
			return { shouldPost: true, reason: 'timing_refresh', postType: 'timing_refresh' };
		}
		return { shouldPost: false, reason: 'no_material_change', postType: '' };
	}

	if (summary.highestRiskNumber > lastPost.highestRiskNumber) {
		return { shouldPost: true, reason: 'risk_upgrade', postType: 'upgrade' };
	}

	if (hasMeaningfulProbabilityShift(lastPost, summary)) {
		return { shouldPost: true, reason: 'probability_shift', postType: 'upgrade' };
	}

	if (summary.hazardFocus !== lastPost.hazardFocus) {
		return { shouldPost: true, reason: 'hazard_change', postType: 'upgrade' };
	}

	if (summary.primaryRegion !== lastPost.primaryRegion || hasMaterialStateShift(lastPost.affectedStates, summary.affectedStates)) {
		return { shouldPost: true, reason: 'region_shift', postType: 'upgrade' };
	}

	if (hasMajorStoryShift(lastPost, summary)) {
		return { shouldPost: true, reason: 'hazard_change', postType: 'upgrade' };
	}

	if (shouldPostTimingRefresh(summary, lastPost, config, nowMs)) {
		return { shouldPost: true, reason: 'timing_refresh', postType: 'timing_refresh' };
	}

	return { shouldPost: false, reason: 'no_material_change', postType: '' };
}

function normalizeOpening(text: string): string {
	return normalizeSpaces(text).toLowerCase();
}

function extractOpening(text: string): string | null {
	const normalized = String(text || '').replace(/\s+/g, ' ').trim();
	if (!normalized) return null;
	const firstParagraph = normalized.split(/\n+/)[0]?.trim() || normalized;
	const firstSentence = firstParagraph.match(/^.+?[.!?](?=\s|$)/)?.[0]?.trim() || firstParagraph;
	const cleaned = firstSentence.replace(/^UPDATE:\s*/i, '').trim();
	return cleaned.slice(0, 140).trim() || null;
}

function formatStateList(states: string[]): string {
	const names = dedupeStrings(states.map((state) => stateCodeDisplayName(state))).slice(0, SPC_MAX_STATE_COUNT);
	if (names.length === 0) return 'the highlighted area';
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function getSpcFocusAreaText(summary: SpcOutlookSummary): string {
	return normalizeSpaces(summary.stateFocusText || '') || formatStateList(summary.affectedStates);
}

function joinHazardList(hazards: string[]): string {
	const clean = dedupeStrings(hazards.map((hazard) => normalizeSpaces(hazard))).slice(0, 3);
	if (clean.length === 0) return 'severe weather impacts';
	if (clean.length === 1) return clean[0];
	if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
	return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

export function buildSpcHazardLine(summary: SpcOutlookSummary): string {
	const hazards = dedupeStrings(summary.hazardList ?? []).filter((hazard) => hazard !== 'severe weather impacts');
	if (hazards.length >= 2) {
		return joinHazardList(hazards.slice(0, 2));
	}
	if (hazards.length === 1) {
		return hazards[0];
	}
	if (summary.hazardFocus === 'tornado') {
		return 'tornadoes and damaging winds';
	}
	if (summary.hazardFocus === 'wind') {
		return 'damaging winds and a few tornadoes';
	}
	if (summary.hazardFocus === 'hail') {
		return 'large hail and damaging winds';
	}
	return 'all severe hazards';
}

function buildHashtags(summary: SpcOutlookSummary, enabled: boolean, outputMode: SpcOutputMode): string {
	if (!enabled || outputMode === 'comment') return '';
	return summary.affectedStates.slice(0, 3).map((state) => `#${state.toUpperCase()}wx`).join(' ');
}

function selectOpening(candidates: string[], recentOpenings: string[]): string {
	const normalizedRecent = new Set(recentOpenings.map(normalizeOpening));
	return candidates.find((candidate) => !normalizedRecent.has(normalizeOpening(candidate))) ?? candidates[0] ?? '';
}

function buildTrend(decision: SpcPostDecision, summary: SpcOutlookSummary): SpcLlmPayload['trend'] {
	if (decision.reason === 'timing_refresh') return 'approaching';
	if (decision.reason === 'region_shift' || decision.reason === 'hazard_change' || decision.reason === 'probability_shift') return 'shifting';
	if (decision.reason === 'risk_upgrade') return 'building';
	return summary.outlookDay === 1 ? 'building' : 'developing';
}

function joinNaturalList(values: string[]): string {
	if (values.length === 0) return '';
	if (values.length === 1) return values[0];
	if (values.length === 2) return `${values[0]} and ${values[1]}`;
	return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function probabilityLead(summary: SpcOutlookSummary): string | null {
	const entries = [
		{ label: 'tornado', value: summary.tornadoProbability ?? 0 },
		{ label: 'wind', value: summary.windProbability ?? 0 },
		{ label: 'hail', value: summary.hailProbability ?? 0 },
	].sort((a, b) => b.value - a.value);
	if (!entries[0] || entries[0].value <= 0) return null;
	return `${entries[0].label} confidence increased to around ${entries[0].value}%`;
}

export function buildSpcCommentChangeHint(previousSummary: SpcOutlookSummary | null | undefined, currentSummary: SpcOutlookSummary): string | null {
	if (!previousSummary) return null;
	const previousStates = dedupeStrings(previousSummary.affectedStates.map((state) => state.toUpperCase()));
	const currentStates = dedupeStrings(currentSummary.affectedStates.map((state) => state.toUpperCase()));
	const previousSet = new Set(previousStates);
	const currentSet = new Set(currentStates);
	const previousHazards = new Set(normalizeStoryList(previousSummary.hazardList));
	const currentHazards = new Set(normalizeStoryList(currentSummary.hazardList));
	const addedStates = currentStates.filter((state) => !previousSet.has(state)).map((state) => stateCodeDisplayName(state));
	const removedStates = previousStates.filter((state) => !currentSet.has(state)).map((state) => stateCodeDisplayName(state));
	const hints: string[] = [];

	if (currentSummary.highestRiskNumber > previousSummary.highestRiskNumber) {
		hints.push(`risk upgraded to Level ${currentSummary.highestRiskNumber} ${riskLabelDisplay(currentSummary.highestRiskLevel)} Risk`);
	}
	if (currentHazards.has('tornadoes') && !previousHazards.has('tornadoes')) {
		hints.push('SPC is highlighting tornado risk more clearly');
	}
	if (addedStates.length > 0) {
		hints.push(`new states added: ${joinNaturalList(addedStates.slice(0, 4))}`);
	}
	if (normalizeStoryText(currentSummary.stateFocusText) && normalizeStoryText(currentSummary.stateFocusText) !== normalizeStoryText(previousSummary.stateFocusText)) {
		hints.push(`core area now centered on ${currentSummary.stateFocusText}`);
	}
	if (currentSummary.primaryRegion !== previousSummary.primaryRegion) {
		hints.push(`focus shifting toward the ${currentSummary.primaryRegion}`);
	}
	if (normalizeStoryText(currentSummary.stormMode) && normalizeStoryText(currentSummary.stormMode) !== normalizeStoryText(previousSummary.stormMode)) {
		hints.push(`storm mode now favoring ${currentSummary.stormMode}`);
	}
	if (currentSummary.hazardFocus !== previousSummary.hazardFocus) {
		hints.push(`main threat now leaning more toward ${currentSummary.hazardFocus === 'mixed' ? 'mixed severe hazards' : currentSummary.hazardFocus}`);
	}
	const probabilityHint = probabilityLead(currentSummary);
	if (probabilityHint && hasMeaningfulProbabilityShift(previousSummary as PublishedSpcOutlookRecord, currentSummary)) {
		hints.push(probabilityHint);
	}
	if (normalizeStoryText(currentSummary.notableText) && normalizeStoryText(currentSummary.notableText) !== normalizeStoryText(previousSummary.notableText)) {
		hints.push(`SPC now notes ${currentSummary.notableText}`);
	}
	if ((currentSummary.timingText || '') !== (previousSummary.timingText || '') && currentSummary.timingText) {
		hints.push(`timing now centered on ${currentSummary.timingText}`);
	}
	if (removedStates.length > 0 && addedStates.length === 0 && currentSummary.primaryRegion === previousSummary.primaryRegion) {
		hints.push(`focus narrowing within ${currentSummary.primaryRegion}`);
	}

	return hints.slice(0, 3).join('; ') || null;
}

function buildOpeningCandidates(summary: SpcOutlookSummary, decision: SpcPostDecision, outputMode: SpcOutputMode, changeHint?: string | null): string[] {
	const stateList = getSpcFocusAreaText(summary);
	if (outputMode === 'comment') {
		if (decision.reason === 'risk_upgrade') {
			return [`UPDATE: Severe weather concern has increased across the ${summary.primaryRegion}.`];
		}
		if (decision.reason === 'timing_refresh') {
			return [`UPDATE: Severe weather timing is becoming more important across parts of ${stateList}.`];
		}
		if (decision.reason === 'region_shift') {
			return [`UPDATE: The severe weather focus is shifting across the ${summary.primaryRegion}.`];
		}
		if (decision.reason === 'hazard_change' || decision.reason === 'probability_shift') {
			return [`UPDATE: The severe weather setup is evolving across the ${summary.primaryRegion}.`];
		}
		if (changeHint) {
			return [`UPDATE: ${changeHint.charAt(0).toUpperCase()}${changeHint.slice(1)}.`];
		}
		return [`UPDATE: The severe weather story is changing across the ${summary.primaryRegion}.`];
	}

	if (decision.postType === 'day2_lookahead') {
		return [
			`Watching tomorrow closely across the ${summary.primaryRegion}.`,
			`Tomorrow's severe setup is worth watching across the ${summary.primaryRegion}.`,
			`Here's what we're watching for tomorrow across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'day3_heads_up') {
		return [
			`A longer-range severe setup is worth watching across the ${summary.primaryRegion}.`,
			`The day 3 severe weather pattern is becoming worth watching across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'upgrade') {
		if (decision.reason === 'risk_upgrade') {
			return [
				`Severe weather concern has increased across the ${summary.primaryRegion}.`,
				`The severe setup is looking more serious across the ${summary.primaryRegion}.`,
			];
		}
		return [
			`The severe weather story is changing across the ${summary.primaryRegion}.`,
			`The severe weather focus is shifting across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'timing_refresh') {
		return [
			`Severe weather timing is becoming more important across parts of ${stateList}.`,
			`The timing window for severe storms is getting closer across parts of ${stateList}.`,
		];
	}
	return [
		`This afternoon to watch across the ${summary.primaryRegion}.`,
		`Watching today closely across the ${summary.primaryRegion}.`,
		`Severe setup today across the ${summary.primaryRegion}.`,
		`Here's what we're watching across the ${summary.primaryRegion} today.`,
	];
}

function buildStormSentence(summary: SpcOutlookSummary, decision: SpcPostDecision): string {
	const hazardLine = buildSpcHazardLine(summary);
	const stormMode = normalizeSpaces(summary.stormMode || '');
	const timingText = normalizeSpaces(summary.timingText || '');
	const notableText = normalizeSpaces(summary.notableText || '');

	if (decision.postType === 'day2_lookahead') {
		const modeText = stormMode || 'organized severe storms';
		const timingClause = timingText ? ` during the ${timingText} window` : ' later in the day';
		const notableClause = notableText ? ` ${notableText.charAt(0).toUpperCase()}${notableText.slice(1)}.` : '';
		return `A developing system may produce ${modeText}, with ${hazardLine} as the main threats${timingClause}.${notableClause}`.trim();
	}

	if (decision.postType === 'day3_heads_up') {
		const timingClause = timingText ? ` ${timingText}` : ' later in the period';
		return `The setup could support ${hazardLine}${stormMode ? ` with ${stormMode}` : ''}${timingClause}.`.replace(/\s+/g, ' ').trim();
	}

	const modeText = stormMode || 'severe storms';
	const timingClause = timingText ? ` Storms will develop ${timingText}.` : '';
	const notableClause = notableText ? ` ${notableText.charAt(0).toUpperCase()}${notableText.slice(1)}.` : '';
	return `Expect ${modeText} capable of producing ${hazardLine}.${timingClause}${notableClause}`.replace(/\s+/g, ' ').trim();
}

function buildBaseSecondParagraph(summary: SpcOutlookSummary, decision: SpcPostDecision): string {
	const stateList = getSpcFocusAreaText(summary);
	const riskText = `Level ${summary.highestRiskNumber} ${riskLabelDisplay(summary.highestRiskLevel)} Risk`;
	const stormSentence = buildStormSentence(summary, decision);

	if (decision.postType === 'day2_lookahead') {
		return `SPC has issued a ${riskText} centered on ${stateList}. ${stormSentence}`.trim();
	}
	if (decision.postType === 'day3_heads_up') {
		return `SPC has issued a ${riskText} centered on ${stateList}. ${stormSentence}`.trim();
	}
	if (decision.postType === 'upgrade') {
		if (decision.reason === 'risk_upgrade') {
			return `SPC has upgraded parts of ${stateList} to a ${riskText}. ${stormSentence}`.trim();
		}
		if (decision.reason === 'probability_shift') {
			return `SPC continues a ${riskText} centered on ${stateList}, but the forecast confidence has shifted. ${stormSentence}`.trim();
		}
		return `SPC continues a ${riskText} centered on ${stateList}, but the setup has changed. ${stormSentence}`.trim();
	}
	if (decision.postType === 'timing_refresh') {
		return `The main concern remains a ${riskText} centered on ${stateList}, with the strongest window expected ${summary.timingText || 'later today'}. ${stormSentence}`;
	}
	return `SPC has issued a ${riskText} for severe storms centered on ${stateList}. ${stormSentence}`.trim();
}

function buildCommentSecondParagraph(summary: SpcOutlookSummary, decision: SpcPostDecision, changeHint?: string | null): string {
	const stateList = getSpcFocusAreaText(summary);
	const riskText = `Level ${summary.highestRiskNumber} ${riskLabelDisplay(summary.highestRiskLevel)} Risk`;
	const stormSentence = buildStormSentence(summary, decision);
	if (decision.reason === 'timing_refresh') {
		return `The setup remains a ${riskText} centered on ${stateList}, with the main window now expected ${summary.timingText || 'later today'}. ${stormSentence}`;
	}
	if (changeHint) {
		return `SPC continues a ${riskText} centered on ${stateList}. ${changeHint.charAt(0).toUpperCase()}${changeHint.slice(1)}. ${stormSentence}`.trim();
	}
	return `SPC continues a ${riskText} centered on ${stateList}. ${stormSentence}`;
}

export function buildSpcPostText(summary: SpcOutlookSummary, decision: SpcPostDecision, recentOpenings: string[] = [], hashtagsEnabled = false, outputMode: SpcOutputMode = 'post', changeHint?: string | null): string {
	const opening = outputMode === 'comment'
		? (buildOpeningCandidates(summary, decision, outputMode, changeHint)[0] ?? 'UPDATE: The severe weather setup is changing.')
		: selectOpening(buildOpeningCandidates(summary, decision, outputMode, changeHint), recentOpenings);
	const secondParagraph = outputMode === 'comment'
		? buildCommentSecondParagraph(summary, decision, changeHint)
		: buildBaseSecondParagraph(summary, decision);
	const hashtags = buildHashtags(summary, hashtagsEnabled, outputMode);
	return [opening, secondParagraph, hashtags].filter(Boolean).join('\n\n');
}

function kvSummaryKey(day: SpcOutlookDay): string {
	return day === 1 ? KV_FB_SPC_LAST_SUMMARY : kvSpcLastSummaryKey(day);
}

function kvPostKey(day: SpcOutlookDay): string {
	return day === 1 ? KV_FB_SPC_LAST_POST : kvSpcLastPostKey(day);
}

function kvHashKey(day: SpcOutlookDay): string {
	return day === 1 ? KV_FB_SPC_LAST_HASH : kvSpcLastHashKey(day);
}

export async function readLastSpcSummary(env: Env, day: SpcOutlookDay): Promise<SpcOutlookSummary | null> {
	try {
		const raw = await env.WEATHER_KV.get(kvSummaryKey(day));
		if (!raw) return null;
		return JSON.parse(raw) as SpcOutlookSummary;
	} catch {
		return null;
	}
}

async function writeLastSpcSummary(env: Env, day: SpcOutlookDay, summary: SpcOutlookSummary): Promise<void> {
	await env.WEATHER_KV.put(kvSummaryKey(day), JSON.stringify(summary), { expirationTtl: SPC_STATE_TTL_SECONDS });
}

export async function readLastSpcDay1Summary(env: Env): Promise<SpcDay1OutlookSummary | null> {
	return await readLastSpcSummary(env, 1) as SpcDay1OutlookSummary | null;
}

export async function readLastSpcPost(env: Env, day: SpcOutlookDay): Promise<PublishedSpcOutlookRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(kvPostKey(day));
		if (!raw) return null;
		return JSON.parse(raw) as PublishedSpcOutlookRecord;
	} catch {
		return null;
	}
}

async function writeLastSpcPost(env: Env, day: SpcOutlookDay, record: PublishedSpcOutlookRecord): Promise<void> {
	await env.WEATHER_KV.put(kvPostKey(day), JSON.stringify(record), { expirationTtl: SPC_STATE_TTL_SECONDS });
}

export async function readLastSpcDay1Post(env: Env): Promise<PublishedSpcOutlookRecord | null> {
	return await readLastSpcPost(env, 1);
}

async function readMostRecentSpcPostWithinGap(env: Env, nowMs: number): Promise<PublishedSpcOutlookRecord | null> {
	const posts = await Promise.all(([1, 2, 3] as const).map((day) => readLastSpcPost(env, day)));
	const recentPosts = posts
		.filter((post): post is PublishedSpcOutlookRecord => !!post)
		.filter((post) => {
			const postedMs = parseIsoMs(post.postedAt);
			return postedMs != null && (nowMs - postedMs) < SPC_GLOBAL_POST_GAP_MS;
		})
		.sort((a, b) => (parseIsoMs(b.postedAt) || 0) - (parseIsoMs(a.postedAt) || 0));
	return recentPosts[0] ?? null;
}

async function writeLastSpcHash(env: Env, day: SpcOutlookDay, hash: string): Promise<void> {
	await env.WEATHER_KV.put(kvHashKey(day), hash, { expirationTtl: SPC_STATE_TTL_SECONDS });
}

async function readSpcThread(env: Env, day: SpcOutlookDay): Promise<SpcThreadRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(kvSpcThreadKey(day));
		if (!raw) return null;
		return JSON.parse(raw) as SpcThreadRecord;
	} catch {
		return null;
	}
}

async function writeSpcThread(env: Env, day: SpcOutlookDay, thread: SpcThreadRecord): Promise<void> {
	await env.WEATHER_KV.put(kvSpcThreadKey(day), JSON.stringify(thread), { expirationTtl: SPC_STATE_TTL_SECONDS });
}

export async function readRecentSpcOpenings(env: Env): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_SPC_RECENT_OPENINGS);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as RecentSpcOpeningsRecord;
		if (!Array.isArray(parsed.openings)) return [];
		return dedupeStrings(parsed.openings.map((opening) => String(opening || ''))).slice(0, FB_SPC_RECENT_OPENINGS_LIMIT);
	} catch {
		return [];
	}
}

export async function recordRecentSpcOpening(env: Env, text: string): Promise<void> {
	const opening = extractOpening(text);
	if (!opening) return;
	try {
		const existing = await readRecentSpcOpenings(env);
		const next = [opening, ...existing.filter((entry) => normalizeOpening(entry) !== normalizeOpening(opening))].slice(0, FB_SPC_RECENT_OPENINGS_LIMIT);
		const record: RecentSpcOpeningsRecord = { openings: next, updatedAt: new Date().toISOString() };
		await env.WEATHER_KV.put(KV_FB_SPC_RECENT_OPENINGS, JSON.stringify(record), { expirationTtl: SPC_STATE_TTL_SECONDS });
	} catch {
		// Best-effort memory only.
	}
}

async function postPhotoToFacebook(env: Env, message: string, imageUrl: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) throw new Error('Facebook credentials not configured');
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/photos`;
	const body = new URLSearchParams({ url: imageUrl, caption: message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Facebook photo API error ${res.status}: ${text}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook photo post returned no ID');
	return data.id;
}

async function postToFacebook(env: Env, message: string, imageUrl?: string | null): Promise<string> {
	if (imageUrl) {
		try {
			return await postPhotoToFacebook(env, message, imageUrl);
		} catch (err) {
			console.warn(`[fb-spc] photo post failed, falling back to feed: ${String(err)}`);
		}
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) throw new Error('Facebook credentials not configured');
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Facebook API error ${res.status}: ${text}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook post returned no ID');
	return data.id;
}

async function commentOnFacebook(env: Env, postId: string, message: string): Promise<string> {
	if (!env.FB_PAGE_ACCESS_TOKEN) throw new Error('Facebook credentials not configured');
	const url = `${FB_GRAPH_API}/${encodeURIComponent(postId)}/comments`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Facebook comment API error ${res.status}: ${text}`);
	}
	const data = await res.json() as { id?: string };
	return data.id ?? '';
}

function buildPublishedSpcRecord(summary: SpcOutlookSummary, decision: SpcPostDecision, postId: string, nowMs: number, outputMode: SpcOutputMode, commentId?: string | null): PublishedSpcOutlookRecord {
	const reason = decision.reason as Exclude<SpcPostReason, 'no_material_change' | 'below_threshold'>;
	const postType = (decision.postType || defaultPostTypeForDay(summary.outlookDay)) as Exclude<SpcPostType, ''>;
	return {
		outlookDay: summary.outlookDay,
		issuedAt: summary.issuedAt,
		validFrom: summary.validFrom,
		validTo: summary.validTo,
		postedAt: new Date(nowMs).toISOString(),
		summaryHash: summary.summaryHash,
		postId,
		commentId: commentId ?? null,
		outputMode,
		highestRiskLevel: summary.highestRiskLevel,
		highestRiskNumber: summary.highestRiskNumber,
		affectedStates: summary.affectedStates,
		stateFocusText: summary.stateFocusText ?? null,
		primaryRegion: summary.primaryRegion,
		hazardFocus: summary.hazardFocus,
		hazardList: summary.hazardList ?? [],
		stormMode: summary.stormMode ?? null,
		notableText: summary.notableText ?? null,
		tornadoProbability: summary.tornadoProbability ?? null,
		windProbability: summary.windProbability ?? null,
		hailProbability: summary.hailProbability ?? null,
		timingText: summary.timingText ?? null,
		postType,
		reason,
	};
}

function shouldUseThreadComment(summary: SpcOutlookSummary, decision: SpcPostDecision, thread: SpcThreadRecord | null, nowMs: number): boolean {
	if (summary.outlookDay !== 1) return false;
	if (!thread) return false;
	if (decision.postType !== 'upgrade' && decision.postType !== 'timing_refresh') return false;
	if (forecastDayKey(thread.summary ?? { issuedAt: thread.issuedAt }) !== forecastDayKey(summary)) return false;
	if (thread.commentCount >= SPC_COMMENT_MAX_COUNT) return false;
	const lastInteractionMs = parseIsoMs(thread.lastCommentAt) ?? parseIsoMs(thread.publishedAt);
	if (lastInteractionMs != null && (nowMs - lastInteractionMs) < SPC_COMMENT_MIN_GAP_MS) return false;
	return true;
}

async function buildSpcFinalText(env: Env, summary: SpcOutlookSummary, decision: SpcPostDecision, options: { outputMode: SpcOutputMode; hashtagsEnabled: boolean; llmEnabled: boolean; recentOpenings: string[]; changeHint?: string | null; }): Promise<string> {
	const { outputMode, hashtagsEnabled, llmEnabled, recentOpenings, changeHint } = options;
	if (llmEnabled) {
		const payload = buildSpcLlmPayload({
			outputMode,
			outlookDay: summary.outlookDay,
			postType: (decision.postType || defaultPostTypeForDay(summary.outlookDay)) as Exclude<SpcLlmPayload['post_type'], ''>,
			riskLevel: summary.highestRiskLevel,
			riskNumber: summary.highestRiskNumber,
			primaryRegion: summary.primaryRegion,
			states: summary.affectedStates,
			stateFocusText: summary.stateFocusText ?? null,
			hazardFocus: summary.hazardFocus,
			hazardList: summary.hazardList ?? [],
			hazardLine: buildSpcHazardLine(summary),
			stormMode: summary.stormMode ?? null,
			timingWindow: summary.timingText ?? null,
			notableText: summary.notableText ?? null,
			trend: buildTrend(decision, summary),
			changeHint,
			recentOpenings,
			hashtagsEnabled,
		});
		const llmCopy = await generateSpcLlmCopy(env, payload);
		if (llmCopy) {
			const hashtags = buildHashtags(summary, hashtagsEnabled, outputMode);
			return [llmCopy, hashtags].filter(Boolean).join('\n\n');
		}
	}
	return buildSpcPostText(summary, decision, recentOpenings, hashtagsEnabled, outputMode, changeHint);
}

export async function readSpcDebugSnapshot(env: Env): Promise<SpcDebugSnapshot | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_SPC_DEBUG);
		if (!raw) return null;
		return JSON.parse(raw) as SpcDebugSnapshot;
	} catch {
		return null;
	}
}

async function writeSpcDebugSnapshot(env: Env, snapshot: SpcDebugSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_SPC_DEBUG, JSON.stringify(snapshot), { expirationTtl: SPC_STATE_TTL_SECONDS });
}

export async function runSpcCoverageForDay(env: Env, day: SpcOutlookDay, nowMs = Date.now()): Promise<SpcDebugEntry> {
	const generatedAt = new Date(nowMs).toISOString();
	const config = await readFbAutoPostConfig(env);
	const lastPost = await readLastSpcPost(env, day);
	const disabledDecision: SpcPostDecision = { shouldPost: false, reason: 'below_threshold', postType: '' };

	if (!isCoverageEnabledForDay(config, day)) {
		return {
			outlookDay: day,
			generatedAt,
			decision: disabledDecision,
			summary: null,
			lastPost,
			plannedOutputMode: null,
			messagePreview: null,
			error: 'coverage_disabled',
		};
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		return {
			outlookDay: day,
			generatedAt,
			decision: disabledDecision,
			summary: null,
			lastPost,
			plannedOutputMode: null,
			messagePreview: null,
			error: 'facebook_credentials_missing',
		};
	}

	try {
		const summary = await fetchLatestSpcOutlookSummary(day);
		await writeLastSpcSummary(env, day, summary);
		const decision = buildSpcPostDecision(summary, lastPost, config, nowMs);
		if (!decision.shouldPost) {
			const entry: SpcDebugEntry = {
				outlookDay: day,
				generatedAt,
				decision,
				summary,
				lastPost,
				plannedOutputMode: null,
				messagePreview: null,
				error: null,
			};
			console.log(`[fb-spc] day${day} skipping reason=${decision.reason} risk=${summary.highestRiskLevel} region=${summary.primaryRegion}`);
			return entry;
		}

		const scheduleGate = evaluateSpcPostingSchedule(summary, decision, lastPost, nowMs);
		if (!scheduleGate.allowed) {
			console.log(`[fb-spc] day${day} skipping schedule=${scheduleGate.reason} window=${scheduleGate.windowLabel} risk=${summary.highestRiskLevel}`);
			return {
				outlookDay: day,
				generatedAt,
				decision,
				summary,
				lastPost,
				plannedOutputMode: null,
				messagePreview: null,
				error: 'outside_post_window',
			};
		}

		const recentPostConflict = await readMostRecentSpcPostWithinGap(env, nowMs);
		if (recentPostConflict) {
			console.log(`[fb-spc] day${day} skipping recent_gap previousDay=${recentPostConflict.outlookDay} postedAt=${recentPostConflict.postedAt}`);
			return {
				outlookDay: day,
				generatedAt,
				decision,
				summary,
				lastPost,
				plannedOutputMode: null,
				messagePreview: null,
				error: 'recent_spc_post_gap',
			};
		}

		const recentOpenings = await readRecentSpcOpenings(env);
		const existingThread = await readSpcThread(env, day);
		const outputMode: SpcOutputMode = shouldUseThreadComment(summary, decision, existingThread, nowMs) ? 'comment' : 'post';
		const changeHint = outputMode === 'comment' ? buildSpcCommentChangeHint(existingThread?.summary, summary) : null;
		const message = await buildSpcFinalText(env, summary, decision, {
			outputMode,
			hashtagsEnabled: config.spcHashtagsEnabled !== false,
			llmEnabled: config.spcLlmEnabled === true,
			recentOpenings,
			changeHint,
		});

		if (outputMode === 'comment' && existingThread?.postId) {
			const commentId = await commentOnFacebook(env, existingThread.postId, message);
			await recordRecentSpcOpening(env, message);
			const record = buildPublishedSpcRecord(summary, decision, existingThread.postId, nowMs, 'comment', commentId);
			await writeLastSpcPost(env, day, record);
			await writeLastSpcHash(env, day, summary.summaryHash);
			const updatedThread: SpcThreadRecord = {
				...existingThread,
				issuedAt: summary.issuedAt,
				hash: summary.summaryHash,
				commentCount: existingThread.commentCount + 1,
				lastCommentAt: new Date(nowMs).toISOString(),
				lastDecisionReason: decision.reason as Exclude<SpcPostReason, 'no_material_change' | 'below_threshold'>,
				summary,
			};
			await writeSpcThread(env, day, updatedThread);
			console.log(`[fb-spc] day${day} posted comment=${commentId} post=${existingThread.postId}`);
			return {
				outlookDay: day,
				generatedAt,
				decision,
				summary,
				lastPost: record,
				plannedOutputMode: 'comment',
				messagePreview: message.slice(0, 320),
				error: null,
			};
		}

		const postId = await postToFacebook(env, message, summary.imageUrl || undefined);
		await recordRecentSpcOpening(env, message);
		const record = buildPublishedSpcRecord(summary, decision, postId, nowMs, 'post');
		await writeLastSpcPost(env, day, record);
		await writeLastSpcHash(env, day, summary.summaryHash);
		await writeSpcThread(env, day, {
			postId,
			outlookDay: day,
			issuedAt: summary.issuedAt,
			publishedAt: new Date(nowMs).toISOString(),
			hash: summary.summaryHash,
			commentCount: 0,
			lastCommentAt: null,
			lastDecisionReason: decision.reason as Exclude<SpcPostReason, 'no_material_change' | 'below_threshold'>,
			summary,
		});
		console.log(`[fb-spc] day${day} posted ${record.postType} post=${postId} risk=${summary.highestRiskLevel} region=${summary.primaryRegion}`);
		return {
			outlookDay: day,
			generatedAt,
			decision,
			summary,
			lastPost: record,
			plannedOutputMode: 'post',
			messagePreview: message.slice(0, 320),
			error: null,
		};
	} catch (err) {
		return {
			outlookDay: day,
			generatedAt,
			decision: disabledDecision,
			summary: null,
			lastPost,
			plannedOutputMode: null,
			messagePreview: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function runSpcCoverage(env: Env, nowMs = Date.now()): Promise<SpcDebugSnapshot> {
	const entries: SpcDebugEntry[] = [];
	for (const day of [1, 2, 3] as const) {
		entries.push(await runSpcCoverageForDay(env, day, nowMs));
	}
	const snapshot: SpcDebugSnapshot = { generatedAt: new Date(nowMs).toISOString(), entries };
	await writeSpcDebugSnapshot(env, snapshot);
	return snapshot;
}

export async function runSpcDay1Coverage(env: Env, nowMs = Date.now()): Promise<void> {
	await runSpcCoverageForDay(env, 1, nowMs);
}
