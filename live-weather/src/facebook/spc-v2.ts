import type {
	AdminConvectiveOutlookConfig,
	Env,
	FbAutoPostConfig,
	PublishedSpcOutlookRecord,
	RecentSpcOpeningsRecord,
	SpcAfdEnrichment,
	SpcAreaSource,
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
	FacebookCoverageEvaluation,
	FacebookCoverageIntent,
} from '../types';
import booleanIntersects from '@turf/boolean-intersects';
import { feature as topojsonFeature } from 'topojson-client';
import usAtlasStates from 'us-atlas/states-10m.json';
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
	kvSpcDeferredAnchorKey,
	kvSpcLastHashKey,
	kvSpcLastPostKey,
	kvSpcLastSummaryKey,
	kvSpcThreadKey,
	FB_GLOBAL_POST_GAP_MS,
} from '../constants';
import {
	decodeHtmlEntities,
	dedupeStrings,
	escapeRegExp,
	sha256Hex,
	stateCodeDisplayName,
	STATE_CODE_TO_FIPS,
	STATE_CODE_TO_NAME,
} from '../utils';
import { centroidFromGeometry, haversineDistanceMiles } from '../geo-utils';
import { fetchRemoteText } from '../weather/api';
import { buildSpcAfdEnrichment } from '../weather/afd';
import { readFbAutoPostConfig } from './config';
import {
	readRecentFacebookActivity,
	recordLastFacebookActivity,
} from './activity';
import { buildSpcLlmPayload, generateSpcLlmCopy, validateSpcLlmOutput } from './spc-llm';

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
const SPC_GLOBAL_POST_GAP_MS = FB_GLOBAL_POST_GAP_MS;
const SPC_TIMING_REFRESH_MIN_GAP_MS = 4 * 60 * 60 * 1000;
const SPC_TIMING_REFRESH_START_OFFSET_MS = 5 * 60 * 60 * 1000;
const SPC_TIMING_REFRESH_END_BUFFER_MS = 6 * 60 * 60 * 1000;
const SPC_MAX_STATE_COUNT = 5;
const SPC_SCHEDULING_TIME_ZONE = 'America/Chicago';
const SPC_DEFERRED_ANCHOR_DELAY_MS = 60 * 60 * 1000;
const SPC_DAY1_MAIN_WINDOW = { startMinutes: (6 * 60) + 30, endMinutes: (9 * 60) + 30, label: 'day1_morning' };
const SPC_DAY2_MAIN_WINDOW = { startMinutes: 11 * 60, endMinutes: 14 * 60, label: 'day2_midday' };
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
	{ pattern: /mid-?mississippi valley/i, label: 'Mid-Mississippi Valley' },
	{ pattern: /upper midwest/i, label: 'Upper Midwest' },
	{ pattern: /great lakes/i, label: 'Great Lakes' },
	{ pattern: /ohio valley/i, label: 'Ohio Valley' },
	{ pattern: /mid-?south/i, label: 'Mid-South' },
	{ pattern: /southern plains/i, label: 'Southern Plains' },
	{ pattern: /central plains/i, label: 'Central Plains' },
	{ pattern: /northern plains/i, label: 'Northern Plains' },
	{ pattern: /gulf coast/i, label: 'Gulf Coast' },
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
const OHIO_VALLEY_STATES = new Set(['IL', 'IN', 'KY', 'OH', 'PA', 'WV']);
const MIDWEST_STORY_STATES = new Set(['IA', 'IL', 'IN', 'MI', 'MN', 'MO', 'OH', 'WI']);
const MID_MISSISSIPPI_VALLEY_STATES = new Set(['AR', 'IA', 'IL', 'MO', 'WI']);
const MID_SOUTH_STATES = new Set(['AL', 'AR', 'KY', 'LA', 'MO', 'MS', 'TN']);
const SOUTHERN_PLAINS_STATES = new Set(['KS', 'OK', 'TX']);
const CENTRAL_PLAINS_STATES = new Set(['KS', 'NE', 'SD', 'ND']);

const REGION_FAMILY_BY_LABEL: Record<string, 'midwest' | 'plains' | 'southeast' | 'northeast' | 'west'> = {
	'Mid-Mississippi Valley': 'midwest',
	'Upper Midwest': 'midwest',
	'Great Lakes': 'midwest',
	'Ohio Valley': 'midwest',
	Midwest: 'midwest',
	'Mid-South': 'southeast',
	'Southern Plains': 'plains',
	'Central Plains': 'plains',
	'Northern Plains': 'plains',
	Plains: 'plains',
	'Southeast': 'southeast',
	'Gulf Coast': 'southeast',
	'Northeast': 'northeast',
	'Southwest': 'west',
	West: 'west',
};

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

const REGION_PRIORITY = ['Mid-Mississippi Valley', 'Upper Midwest', 'Great Lakes', 'Ohio Valley', 'Mid-South', 'Southern Plains', 'Central Plains', 'Midwest', 'Southeast', 'Plains', 'Southwest', 'West', 'Northeast'];

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

const STATE_CODE_BY_FIPS = Object.entries(STATE_CODE_TO_FIPS).reduce<Record<string, string>>((lookup, [stateCode, fips]) => {
	lookup[fips] = stateCode;
	return lookup;
}, {});

type StateBoundaryFeature = {
	stateCode: string;
	feature: any;
	centroidLat: number | null;
	centroidLon: number | null;
};

const US_STATE_BOUNDARY_FEATURES: StateBoundaryFeature[] = (() => {
	try {
		const topojson = usAtlasStates as any;
		const statesObject = topojson?.objects?.states;
		if (!statesObject) return [];
		const collection = topojsonFeature(topojson, statesObject) as any;
		const features = Array.isArray(collection?.features) ? collection.features : [];
		return features
			.map((stateFeature: any) => {
				const fips = String(stateFeature?.id ?? '').replace(/\D/g, '').padStart(2, '0').slice(-2);
				const stateCode = STATE_CODE_BY_FIPS[fips] || '';
				if (!stateCode || !stateFeature?.geometry) return null;
				const centroid = centroidFromGeometry({ geometry: stateFeature.geometry });
				return {
					stateCode,
					feature: stateFeature,
					centroidLat: Number.isFinite(centroid.lat) ? Number(centroid.lat) : null,
					centroidLon: Number.isFinite(centroid.lon) ? Number(centroid.lon) : null,
				} satisfies StateBoundaryFeature;
			})
			.filter((entry): entry is StateBoundaryFeature => !!entry);
	} catch (error) {
		console.warn(`[fb-spc] failed to load state boundary atlas: ${String(error)}`);
		return [];
	}
})();

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
	primaryHazards?: string[] | null;
	secondaryHazards?: string[] | null;
	tornadoProbability?: number | null;
} | null | undefined): boolean {
	if (!summary) return false;
	if (summary.hazardFocus === 'tornado') return true;
	if (Number(summary.tornadoProbability || 0) > 0) return true;
	return normalizeStoryList([
		...(summary.primaryHazards || []),
		...(summary.secondaryHazards || []),
		...(summary.hazardList || []),
	]).includes('tornadoes');
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
	const discussionLines = discussionText.split(/\n+/).map((line) => normalizeSpaces(line)).filter(Boolean);
	const issuedLineMatch = discussionText.match(/NWS Storm Prediction Center Norman OK\s+([^\n]+)/i);
	const issuedLabel = normalizeSpaces(String(issuedLineMatch?.[1] || ''));
	const ellipsisSections = extractEllipsisSections(discussionText);
	const headlineLine = discussionLines.find((line) => /^\.\.\.\s*THERE IS\b/i.test(line)) ?? null;
	const headlineText = headlineLine
		? headlineLine.replace(/^\.\.\.\s*/i, '').replace(/\s*\.\.\.\s*$/i, '').trim()
		: (ellipsisSections.find((section) => /^THERE IS\b/i.test(section)) ?? null);
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

type StateTextMetric = {
	score: number;
	firstIndex: number;
};

type SpcRiskFeatureSelection = {
	feature: any | null;
	states: string[];
};

function buildSpcTextSources(page: ParsedSpcOutlookPage): Array<{ text: string; weight: number }> {
	return [
		{ text: page.headlineText || '', weight: 8 },
		...page.sectionHeadings.map((section) => ({ text: section, weight: 6 })),
		{ text: page.summary || '', weight: 4 },
		{ text: page.discussionText || '', weight: 1 },
	].filter((source) => !!normalizeSpaces(source.text));
}

function buildStateTextMetrics(page: ParsedSpcOutlookPage): Map<string, StateTextMetric> {
	const metrics = new Map<string, StateTextMetric>();
	for (const [sourceIndex, source] of buildSpcTextSources(page).entries()) {
		const rawText = String(source.text || '');
		const matches = [
			...collectPatternMatches(rawText, FULL_NAME_STATE_PATTERNS, 0),
			...collectPatternMatches(rawText.toUpperCase(), ABBREVIATION_STATE_PATTERNS, 1),
		];
		for (const match of matches) {
			const metric = metrics.get(match.code) ?? { score: 0, firstIndex: Number.POSITIVE_INFINITY };
			metric.score += source.weight;
			metric.firstIndex = Math.min(metric.firstIndex, (sourceIndex * 10_000) + match.index);
			metrics.set(match.code, metric);
		}
	}
	return metrics;
}

function boundaryFeatureForState(stateCode: string): StateBoundaryFeature | null {
	return US_STATE_BOUNDARY_FEATURES.find((entry) => entry.stateCode === stateCode) ?? null;
}

function averageClusterDistanceMiles(candidateState: string, orderedStates: string[]): number {
	const candidateBoundary = boundaryFeatureForState(candidateState);
	if (!candidateBoundary || orderedStates.length === 0) return Number.POSITIVE_INFINITY;
	if (candidateBoundary.centroidLat == null || candidateBoundary.centroidLon == null) return Number.POSITIVE_INFINITY;
	const distances = orderedStates
		.map((stateCode) => boundaryFeatureForState(stateCode))
		.filter((entry): entry is StateBoundaryFeature => !!entry && entry.centroidLat != null && entry.centroidLon != null)
		.map((entry) => haversineDistanceMiles(
			candidateBoundary.centroidLat as number,
			candidateBoundary.centroidLon as number,
			entry.centroidLat as number,
			entry.centroidLon as number,
		));
	if (distances.length === 0) return Number.POSITIVE_INFINITY;
	return distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
}

function orderStatesByTextAndCluster(states: string[], page: ParsedSpcOutlookPage, maxStates = SPC_MAX_STATE_COUNT): string[] {
	const uniqueStates = normalizeStateCodeList(states).slice(0, Math.max(maxStates, states.length));
	if (uniqueStates.length <= 1) return uniqueStates.slice(0, maxStates);
	const textMetrics = buildStateTextMetrics(page);
	const rankState = (stateCode: string) => textMetrics.get(stateCode) ?? { score: 0, firstIndex: Number.POSITIVE_INFINITY };
	const seeded = [...uniqueStates].sort((left, right) => {
		const leftMetric = rankState(left);
		const rightMetric = rankState(right);
		const bothMentioned = Number.isFinite(leftMetric.firstIndex) && Number.isFinite(rightMetric.firstIndex);
		if (bothMentioned) {
			const indexDiff = leftMetric.firstIndex - rightMetric.firstIndex;
			if (indexDiff !== 0) return indexDiff;
		}
		const scoreDiff = rightMetric.score - leftMetric.score;
		if (scoreDiff !== 0) return scoreDiff;
		const indexDiff = leftMetric.firstIndex - rightMetric.firstIndex;
		if (indexDiff !== 0) return indexDiff;
		return left.localeCompare(right);
	});
	const ordered = [seeded.shift() as string];
	while (seeded.length > 0 && ordered.length < maxStates) {
		seeded.sort((left, right) => {
			const leftMetric = rankState(left);
			const rightMetric = rankState(right);
			const bothMentioned = Number.isFinite(leftMetric.firstIndex) && Number.isFinite(rightMetric.firstIndex);
			if (bothMentioned) {
				const indexDiff = leftMetric.firstIndex - rightMetric.firstIndex;
				if (indexDiff !== 0) return indexDiff;
			}
			const scoreDiff = rightMetric.score - leftMetric.score;
			if (Math.abs(scoreDiff) >= 2) return scoreDiff;
			const indexDiff = leftMetric.firstIndex - rightMetric.firstIndex;
			if (indexDiff !== 0) return indexDiff;
			const distanceDiff = averageClusterDistanceMiles(left, ordered) - averageClusterDistanceMiles(right, ordered);
			if (Number.isFinite(distanceDiff) && distanceDiff !== 0) return distanceDiff;
			return left.localeCompare(right);
		});
		ordered.push(seeded.shift() as string);
	}
	return ordered.slice(0, maxStates);
}

function extractStatesFromRiskFeature(feature: any, page: ParsedSpcOutlookPage): string[] {
	if (!feature?.geometry || US_STATE_BOUNDARY_FEATURES.length === 0) return [];
	const intersectingStates = US_STATE_BOUNDARY_FEATURES
		.filter((entry) => {
			try {
				return booleanIntersects(feature as any, entry.feature as any);
			} catch {
				return false;
			}
		})
		.map((entry) => entry.stateCode);
	return orderStatesByTextAndCluster(intersectingStates, page);
}

function buildGeoJsonRiskAreas(features: any[], page: ParsedSpcOutlookPage): NonNullable<SpcOutlookSummary['riskAreas']> {
	const riskAreas: NonNullable<SpcOutlookSummary['riskAreas']> = {
		marginal: [],
		slight: [],
		enhanced: [],
		moderate: [],
		high: [],
	};
	for (const level of ['marginal', 'slight', 'enhanced', 'moderate', 'high'] as const) {
		const states = dedupeStrings(
			features
				.filter((feature) => getRiskLevelFromGeoJsonFeature(feature) === level)
				.flatMap((feature) => extractStatesFromRiskFeature(feature, page)),
		);
		riskAreas[level] = orderStatesByTextAndCluster(states, page);
	}
	return riskAreas;
}

function scoreRiskFeatureStates(states: string[], page: ParsedSpcOutlookPage): number {
	const textMetrics = buildStateTextMetrics(page);
	return states.reduce((total, stateCode) => {
		const metric = textMetrics.get(stateCode) ?? { score: 0, firstIndex: Number.POSITIVE_INFINITY };
		const mentionScore = metric.score * 20;
		const indexScore = Number.isFinite(metric.firstIndex)
			? Math.max(0, 10_000 - metric.firstIndex) / 250
			: 0;
		return total + mentionScore + indexScore;
	}, 0);
}

function selectPrimaryRiskFeature(features: any[], page: ParsedSpcOutlookPage): SpcRiskFeatureSelection {
	const highestRiskNumber = features.reduce((maxRisk, feature) => Math.max(maxRisk, spcRiskNumber(getRiskLevelFromGeoJsonFeature(feature))), 0);
	if (highestRiskNumber <= 0) return { feature: null, states: [] };
	const candidates = features.filter((feature) => spcRiskNumber(getRiskLevelFromGeoJsonFeature(feature)) === highestRiskNumber);
	const evaluated = candidates
		.map((feature) => {
			const states = extractStatesFromRiskFeature(feature, page);
			return {
				feature,
				states,
				score: scoreRiskFeatureStates(states, page),
			};
		})
		.filter((entry) => entry.states.length > 0)
		.sort((left, right) => {
			const scoreDiff = right.score - left.score;
			if (scoreDiff !== 0) return scoreDiff;
			const stateDiff = left.states.length - right.states.length;
			if (stateDiff !== 0) return stateDiff;
			return 0;
		});
	if (evaluated[0]) {
		return { feature: evaluated[0].feature, states: evaluated[0].states };
	}
	const fallbackFeature = selectHighestRiskFeature(features);
	return {
		feature: fallbackFeature,
		states: fallbackFeature ? extractStatesFromRiskFeature(fallbackFeature, page) : [],
	};
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

type SpcAreaCandidate = {
	source: SpcAreaSource;
	rawText: string;
	focusText: string | null;
	states: string[];
	regionHint: string | null;
	order: number;
	score: number;
};

type SpcSelectedRiskStory = {
	primaryStates: string[];
	primaryFocusText: string | null;
	primaryAreaSource: SpcAreaSource;
	secondaryStates: string[];
	secondaryFocusText: string | null;
};

function titleCaseDirectionalPhrase(text: string): string {
	const titleCaseWord = (value: string): string => value
		.split('-')
		.map((part) => {
			const trimmed = part.trim();
			if (!trimmed) return trimmed;
			return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
		})
		.join('-');

	return normalizeSpaces(
		String(text || '').replace(/\b([a-z][a-z'-]*)\b/gi, (match, word) => {
			if (/^(and|or|the|of|into|across|for|to|from)$/i.test(word)) return word.toLowerCase();
			return titleCaseWord(word);
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
	const compact = cleaned
		.replace(/^,\s*/, '')
		.replace(/^and\s+/i, '')
		.replace(/,\s*and\s+/gi, ', ')
		.replace(/\s*,\s*/g, ', ')
		.replace(/,\s*$/u, '')
		.trim();
	if (!compact) return null;
	const expandedStateCodes = compact.replace(/\b([A-Z]{2})\b/g, (match, stateCode) => {
		return STATE_CODE_TO_NAME[stateCode] ? stateCodeDisplayName(stateCode) : match;
	});
	const listified = expandedStateCodes.includes(',') ? expandedStateCodes.replace(/,\s*([^,]+)$/u, ', and $1') : expandedStateCodes;
	return titleCaseDirectionalPhrase(listified);
}

function splitTextIntoSentences(text: string): string[] {
	return dedupeStrings(
		(Array.from(String(text || '').replace(/\r/g, ' ').match(/[^.!?]+[.!?]?/g) || [])
			.map((sentence) => normalizeSpaces(sentence))
			.filter(Boolean)),
	);
}

function countStatesInSet(states: string[], stateSet: Set<string>): number {
	return states.reduce((count, state) => count + (stateSet.has(state) ? 1 : 0), 0);
}

function countDirectionalHints(text: string): number {
	return countPattern(
		String(text || '').toLowerCase(),
		/\b(?:southern|northern|western|eastern|central|upper|lower|mid-?mississippi|midwest|great lakes|ohio valley|southern plains|central plains|northern plains|mid-?south)\b/g,
	);
}

function regionFamilyForLabel(label: string | null | undefined): 'midwest' | 'plains' | 'southeast' | 'northeast' | 'west' | null {
	return label ? (REGION_FAMILY_BY_LABEL[label] ?? null) : null;
}

function regionFamilyForStates(states: string[]): 'midwest' | 'plains' | 'southeast' | 'northeast' | 'west' | null {
	const familyCounts = new Map<'midwest' | 'plains' | 'southeast' | 'northeast' | 'west', number>();
	for (const state of states) {
		const bucket = REGION_BUCKETS[state];
		const family = bucket === 'Midwest'
			? 'midwest'
			: bucket === 'Plains'
				? 'plains'
				: bucket === 'Southeast'
					? 'southeast'
					: bucket === 'Northeast'
						? 'northeast'
						: bucket
							? 'west'
							: null;
		if (!family) continue;
		familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
	}
	return Array.from(familyCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([family]) => family)[0] ?? null;
}

function buildSpcAreaCandidate(rawText: string, source: SpcAreaSource, order: number): SpcAreaCandidate | null {
	const normalizedRaw = normalizeSpaces(rawText);
	if (!normalizedRaw) return null;
	const focusText = buildReadableFocusPhrase(normalizedRaw);
	const states = extractOrderedStateCodesFromText(focusText || normalizedRaw).slice(0, SPC_MAX_STATE_COUNT);
	const regionHint = inferPrimaryRegionFromText([focusText, normalizedRaw].filter(Boolean).join(' '));
	if (!focusText && states.length === 0 && !regionHint) return null;
	const score =
		(source === 'headline' ? 120 : source === 'section' ? 100 : source === 'summary' ? 80 : source === 'discussion' ? 60 : 20)
		+ (Math.min(states.length, SPC_MAX_STATE_COUNT) * 18)
		+ (Math.min(countDirectionalHints(normalizedRaw), 4) * 5)
		+ (focusText ? 10 : 0)
		+ (regionHint ? 8 : 0)
		- (states.length === 0 ? 40 : 0)
		- (normalizedRaw.length > 140 ? 6 : 0);
	return {
		source,
		rawText: normalizedRaw,
		focusText,
		states,
		regionHint,
		order,
		score,
	};
}

function buildSpcAreaCandidates(page: ParsedSpcOutlookPage): SpcAreaCandidate[] {
	const candidates: SpcAreaCandidate[] = [];
	let order = 0;
	if (page.headlineText) {
		const candidate = buildSpcAreaCandidate(page.headlineText, 'headline', order);
		order += 1;
		if (candidate) candidates.push(candidate);
	}
	for (const section of page.sectionHeadings) {
		const candidate = buildSpcAreaCandidate(section, 'section', order);
		order += 1;
		if (candidate) candidates.push(candidate);
	}
	for (const sentence of splitTextIntoSentences(page.summary).slice(0, 3)) {
		const candidate = buildSpcAreaCandidate(sentence, 'summary', order);
		order += 1;
		if (candidate) candidates.push(candidate);
	}
	for (const sentence of splitTextIntoSentences(page.discussionText).slice(0, 8)) {
		const candidate = buildSpcAreaCandidate(sentence, 'discussion', order);
		order += 1;
		if (candidate) candidates.push(candidate);
	}
	return candidates.sort((a, b) => {
		const scoreDiff = b.score - a.score;
		if (scoreDiff !== 0) return scoreDiff;
		const stateDiff = b.states.length - a.states.length;
		if (stateDiff !== 0) return stateDiff;
		return a.order - b.order;
	});
}

function deriveLegacyStateFocusText(page: ParsedSpcOutlookPage): string | null {
	const headlineFocus = buildReadableFocusPhrase(page.headlineText || '');
	const summaryFocus = buildReadableFocusPhrase(page.summary || '');
	const sectionFocuses = page.sectionHeadings
		.map((section) => buildReadableFocusPhrase(section))
		.filter((value): value is string => !!value);
	const focusCandidates = [headlineFocus, ...sectionFocuses, summaryFocus].filter((value): value is string => !!value);
	let fallbackFocus: string | null = null;
	for (const focusText of focusCandidates) {
		const stateCount = extractOrderedStateCodesFromText(focusText).length;
		if (stateCount >= 2) return focusText;
		if (!fallbackFocus && stateCount > 0) {
			fallbackFocus = focusText;
		}
	}
	return fallbackFocus;
}

function deriveLegacyAffectedStates(page: ParsedSpcOutlookPage): string[] {
	const prioritizedSources = [
		page.headlineText,
		page.summary,
		...page.sectionHeadings,
	].filter(Boolean);
	const collectedStates: string[] = [];
	for (const source of prioritizedSources) {
		for (const stateCode of extractOrderedStateCodesFromText(source)) {
			if (collectedStates.includes(stateCode)) continue;
			collectedStates.push(stateCode);
			if (collectedStates.length >= SPC_MAX_STATE_COUNT) {
				return collectedStates;
			}
		}
	}
	if (collectedStates.length > 0) return collectedStates;
	return extractOrderedStateCodesFromText(page.discussionText).slice(0, SPC_MAX_STATE_COUNT);
}

function isRegionCompatibleWithStates(region: string, states: string[]): boolean {
	if (states.length === 0) return true;
	if (region === 'Mid-Mississippi Valley') {
		return countStatesInSet(states, MID_MISSISSIPPI_VALLEY_STATES) >= Math.min(2, states.length)
			&& (states.includes('MO') || (states.includes('AR') && states.includes('IL')));
	}
	if (region === 'Upper Midwest') {
		return countStatesInSet(states, UPPER_MIDWEST_STATES) >= Math.min(2, states.length);
	}
	if (region === 'Great Lakes') {
		return countStatesInSet(states, GREAT_LAKES_STATES) >= Math.min(2, states.length);
	}
	if (region === 'Ohio Valley') {
		return countStatesInSet(states, OHIO_VALLEY_STATES) >= Math.min(2, states.length);
	}
	if (region === 'Southern Plains') {
		return countStatesInSet(states, SOUTHERN_PLAINS_STATES) >= Math.min(2, states.length);
	}
	if (region === 'Central Plains' || region === 'Northern Plains' || region === 'Plains') {
		return countStatesInSet(states, CENTRAL_PLAINS_STATES) >= Math.min(1, Math.min(2, states.length))
			|| countStatesInSet(states, SOUTHERN_PLAINS_STATES) >= Math.min(1, Math.min(2, states.length));
	}
	if (region === 'Midwest') {
		return countStatesInSet(states, MIDWEST_STORY_STATES) >= Math.min(2, states.length);
	}
	if (region === 'Mid-South') {
		return countStatesInSet(states, MID_SOUTH_STATES) >= Math.min(2, states.length);
	}
	const family = regionFamilyForLabel(region);
	const stateFamily = regionFamilyForStates(states);
	return !!family && family === stateFamily;
}

export function selectSpcPrimaryRiskArea(page: ParsedSpcOutlookPage, lockedPrimaryStates: string[] = []): SpcSelectedRiskStory {
	const candidates = buildSpcAreaCandidates(page);
	const lockedStates = orderStatesByTextAndCluster(lockedPrimaryStates, page);
	const lockedStateSet = new Set(lockedStates);
	const exactLockedCandidate = lockedStates.length > 0
		? candidates
			.filter((candidate) => candidate.states.length > 0 && candidate.states.every((state) => lockedStateSet.has(state)))
			.sort((left, right) => {
				const coverageDiff = right.states.length - left.states.length;
				if (coverageDiff !== 0) return coverageDiff;
				const scoreDiff = right.score - left.score;
				if (scoreDiff !== 0) return scoreDiff;
				return left.order - right.order;
			})[0] ?? null
		: null;
	let primaryCandidate = candidates.find((candidate) => candidate.states.length >= 2)
		?? candidates.find((candidate) => candidate.states.length > 0 || candidate.regionHint)
		?? null;

	let primaryStates = lockedStates.length > 0
		? lockedStates
		: primaryCandidate?.states.slice(0, SPC_MAX_STATE_COUNT) ?? [];
	let primaryFocusText = exactLockedCandidate?.focusText ?? primaryCandidate?.focusText ?? null;
	let primaryAreaSource: SpcAreaSource = lockedStates.length > 0 ? 'geojson' : (primaryCandidate?.source ?? 'fallback');
	const legacyStates = deriveLegacyAffectedStates(page);
	const legacyFocusText = deriveLegacyStateFocusText(page);

	if (primaryStates.length === 0) {
		primaryStates = legacyStates;
		primaryFocusText = legacyFocusText;
		primaryAreaSource = 'fallback';
	}
	if (lockedStates.length === 0 && primaryStates.length < 2 && legacyStates.length > primaryStates.length) {
		primaryStates = legacyStates;
		primaryAreaSource = 'fallback';
	}
	if (
		!primaryFocusText
		|| extractOrderedStateCodesFromText(primaryFocusText).length < Math.min(primaryStates.length, 2)
		|| (lockedStates.length > 0 && extractOrderedStateCodesFromText(primaryFocusText).some((state) => !lockedStateSet.has(state)))
	) {
		primaryFocusText = legacyFocusText || (primaryStates.length > 0 ? formatStateList(primaryStates) : null);
	}
	if (lockedStates.length > 0 && (!primaryFocusText || extractOrderedStateCodesFromText(primaryFocusText).some((state) => !lockedStateSet.has(state)))) {
		primaryFocusText = formatStateList(primaryStates);
	}

	const primaryFamily = regionFamilyForStates(primaryStates);
	const secondaryCandidate = candidates.find((candidate) => {
		if (candidate === primaryCandidate || candidate === exactLockedCandidate) return false;
		const uniqueStates = orderStatesByTextAndCluster(candidate.states.filter((state) => !primaryStates.includes(state)), page, 3);
		if (uniqueStates.length === 0 || uniqueStates.length > 3) return false;
		const candidateFamily = regionFamilyForLabel(candidate.regionHint) ?? regionFamilyForStates(uniqueStates);
		if (primaryFamily && candidateFamily && primaryFamily !== candidateFamily) return false;
		return true;
	});
	const secondaryStates = secondaryCandidate
		? orderStatesByTextAndCluster(secondaryCandidate.states.filter((state) => !primaryStates.includes(state)), page, 3)
		: [];
	const secondaryFocusText = secondaryStates.length > 0 ? formatStateList(secondaryStates) : null;

	return {
		primaryStates,
		primaryFocusText,
		primaryAreaSource,
		secondaryStates,
		secondaryFocusText,
	};
}

function inferPrimaryRegionFromText(text: string): string | null {
	for (const hint of REGION_TEXT_HINTS) {
		if (hint.pattern.test(text)) return hint.label;
	}
	return null;
}

function buildBaseRegionFromStates(states: string[]): string {
	if (states.length === 0) return 'National';
	const stateSet = new Set(states);
	const regionCounts = new Map<string, number>();
	for (const state of states) {
		const region = REGION_BUCKETS[state];
		if (!region) continue;
		regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
	}

	if (countStatesInSet(states, SOUTHERN_PLAINS_STATES) >= Math.min(2, states.length) && (stateSet.has('TX') || stateSet.has('OK'))) {
		return 'Southern Plains';
	}
	if (countStatesInSet(states, CENTRAL_PLAINS_STATES) >= Math.min(2, states.length) && !stateSet.has('TX') && !stateSet.has('OK')) {
		return 'Central Plains';
	}
	if (countStatesInSet(states, MID_SOUTH_STATES) >= Math.min(2, states.length)) {
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

function derivePrimaryRegion(states: string[]): string {
	if (states.length === 0) {
		return 'National';
	}
	if (countStatesInSet(states, MID_MISSISSIPPI_VALLEY_STATES) >= 3 && (states.includes('MO') || (states.includes('AR') && states.includes('IL')))) {
		return 'Mid-Mississippi Valley';
	}
	if (
		countStatesInSet(states, GREAT_LAKES_STATES) >= 3
		&& (states.includes('MI') || states.includes('OH') || states.includes('PA'))
		&& !states.includes('MO')
	) {
		return 'Great Lakes';
	}
	if (
		countStatesInSet(states, OHIO_VALLEY_STATES) >= 3
		&& (states.includes('OH') || states.includes('KY') || states.includes('WV'))
		&& !states.includes('IA')
		&& !states.includes('MO')
	) {
		return 'Ohio Valley';
	}
	if (countStatesInSet(states, MIDWEST_STORY_STATES) >= Math.min(2, states.length)) {
		return 'Midwest';
	}
	if (countStatesInSet(states, MID_SOUTH_STATES) >= Math.min(2, states.length) && !states.some((state) => MIDWEST_STORY_STATES.has(state))) {
		return 'Mid-South';
	}
	return buildBaseRegionFromStates(states);
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


function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function normalizeHazardLabel(key: 'tornado' | 'wind' | 'hail', text: string): string {
	if (key === 'tornado') return 'tornadoes';
	if (key === 'hail') return 'large hail';
	return /widespread damaging wind|significant wind|severe wind swath|strong wind field/.test(text)
		? 'widespread damaging winds'
		: 'damaging winds';
}

function deriveHazardPriority(
	summaryText: string,
	discussionText: string,
	probabilities: { tornadoProbability?: number | null; windProbability?: number | null; hailProbability?: number | null },
	stormMode: string | null,
	stormEvolutionText: string | null,
): {
	hazardFocus: SpcHazardFocus;
	primaryHazards: string[];
	secondaryHazards: string[];
	hazardList: string[];
} {
	const summary = summaryText.toLowerCase();
	const discussion = discussionText.toLowerCase();
	const combined = `${summary} ${discussion}`;
	const evidence = (['tornado', 'wind', 'hail'] as const).map((key) => {
		const mentionPatterns = key === 'tornado'
			? [/\btornado(?:es)?\b/g, /\brotation\b/g]
			: key === 'wind'
				? [/\bdamaging (?:thunderstorm )?winds?\b/g, /\bwind damage\b/g, /\bsevere gusts?\b/g, /\bwidespread damaging winds?\b/g]
				: [/\blarge hail\b/g, /\bhail\b/g];
		const mainPatterns = key === 'tornado'
			? [
				/\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b[^.]*\btornado(?:es)?\b/i,
				/\btornado(?:es)?\b[^.]*\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b/i,
				/\bseveral tornadoes\b/i,
				/\bstrong tornado(?:es)?\b/i,
			]
			: key === 'wind'
				? [
					/\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b[^.]*\bdamaging winds?\b/i,
					/\bdamaging winds?\b[^.]*\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b/i,
					/\bwidespread damaging winds?\b/i,
					/\bwind swath\b/i,
					/\borganized squall line\b/i,
				]
				: [
					/\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b[^.]*\bhail\b/i,
					/\bhail\b[^.]*\b(?:main|primary|greater|highest)\s+(?:concern|threat|risk)\b/i,
					/\bvery large hail\b/i,
				];
		const conditionalPatterns = key === 'tornado'
			? [
				/\ba few tornadoes? (?:possible|remain possible|may occur)\b/i,
				/\bconditional tornado(?: risk| threat| potential)?\b/i,
				/\btornado(?: risk| threat| potential)?[^.]*\bif\b/i,
				/\bcannot rule out (?:a few )?tornado(?:es)?\b/i,
				/\bembedded tornado(?: risk| threat| potential)?\b/i,
			]
			: key === 'wind'
				? [/\bdamaging winds? (?:possible|may occur)\b/i]
				: [/\blarge hail (?:possible|may occur)\b/i];
		const probabilityScore = Math.round(Number((key === 'tornado'
			? probabilities.tornadoProbability
			: key === 'wind'
				? probabilities.windProbability
				: probabilities.hailProbability) || 0) / 5);
		let score = probabilityScore;
		for (const pattern of mentionPatterns) {
			score += countPattern(summary, pattern) * 4;
			score += countPattern(discussion, pattern) * 2;
		}
		if (hasAnyPattern(summary, mainPatterns)) score += 8;
		if (hasAnyPattern(discussion, mainPatterns)) score += 5;
		const conditional = hasAnyPattern(combined, conditionalPatterns);
		if (conditional) score -= 4;
		if (key === 'wind' && /\b(?:line|linear|squall|bowing|qlcs)\b/i.test(stormEvolutionText || '')) {
			score += 4;
		}
		if (score > 0 && (key === 'tornado' || key === 'hail') && /\b(?:supercells?|discrete storms?)\b/i.test(stormMode || '')) {
			score += 2;
		}
		return {
			key,
			label: normalizeHazardLabel(key, combined),
			score,
			conditional,
		};
	}).sort((a, b) => b.score - a.score);

	const positiveSignals = evidence.filter((entry) => entry.score > 0);
	if (positiveSignals.length === 0) {
		return {
			hazardFocus: 'mixed',
			primaryHazards: [],
			secondaryHazards: [],
			hazardList: ['severe weather impacts'],
		};
	}

	const primaryLead = positiveSignals.find((entry) => !entry.conditional) ?? positiveSignals[0];
	const primaryHazards = [primaryLead.label];
	for (const entry of positiveSignals) {
		if (entry === primaryLead) continue;
		if (primaryHazards.length >= 2 || entry.conditional) continue;
		if ((primaryLead.score - entry.score) <= 3) {
			primaryHazards.push(entry.label);
		}
	}
	const secondaryHazards = positiveSignals
		.filter((entry) => !primaryHazards.includes(entry.label))
		.map((entry) => entry.label)
		.filter((label, index, list) => list.indexOf(label) === index)
		.slice(0, 2);
	const hazardFocus = primaryHazards.length > 1
		? 'mixed'
		: primaryLead.key === 'tornado'
			? 'tornado'
			: primaryLead.key === 'wind'
				? 'wind'
				: 'hail';
	return {
		hazardFocus,
		primaryHazards,
		secondaryHazards,
		hazardList: dedupeStrings([...primaryHazards, ...secondaryHazards]).slice(0, 3),
	};
}

function deriveStormMode(page: ParsedSpcOutlookPage): string | null {
	const text = `${page.headlineText || ''} ${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	if (/fast-moving supercells?|rapidly moving supercells?|quickly moving supercells?/.test(text)) return 'fast-moving supercells';
	if (/discrete supercells?/.test(text)) return 'discrete supercells';
	if (/supercells?/.test(text)) return 'supercells';
	if (/discrete storms?/.test(text)) return 'discrete storms';
	if (/large squall line|organized squall line/.test(text)) return 'a large squall line';
	if (/squall line|qlcs|quasi-linear/.test(text)) return 'a squall line';
	if (/bowing line|bowing segments?/.test(text)) return 'a bowing line';
	if (/line of storms|linear storm mode|extensive line|become more linear|linear segments?/.test(text)) return 'a line of storms';
	if (/storm clusters?|organized clusters?/.test(text)) return 'storm clusters';
	return null;
}

function deriveLaterStormMode(page: ParsedSpcOutlookPage): string | null {
	const text = `${page.headlineText || ''} ${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	if (/quick upscale growth/.test(text)) return 'quick upscale growth';
	if (/large squall line|organized squall line/.test(text)) return 'a large squall line';
	if (/squall line|qlcs|quasi-linear/.test(text)) return 'a squall line';
	if (/bowing line|bowing segments?/.test(text)) return 'a bowing line';
	if (/(?:grow|organize|evolve|merge) into (?:an? )?line|storms? become (?:more )?linear/.test(text)) return 'a line of storms';
	if (/line of storms|linear storm mode|extensive line|become more linear|linear segments?/.test(text)) return 'a line of storms';
	if (/storm clusters?|organized clusters?/.test(text)) return 'storm clusters';
	return null;
}

function deriveStormEvolutionText(page: ParsedSpcOutlookPage, stormMode: string | null, laterStormMode: string | null): string | null {
	const text = `${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	const hasProgressionSignal = /\b(?:before|then|later|eventually|quick upscale growth|grow into|organize into|evolve into|merge into|become more linear)\b/.test(text);
	if (stormMode && laterStormMode && stormMode !== laterStormMode && hasProgressionSignal) {
		if (laterStormMode === 'quick upscale growth') {
			return `${sentenceCase(stormMode)} may develop early before quick upscale growth takes over later.`;
		}
		if (/become more linear/.test(text)) {
			return `${sentenceCase(stormMode)} may develop early before storms become more linear later on.`;
		}
		return `${sentenceCase(stormMode)} may develop early before storms organize into ${laterStormMode} later on.`;
	}
	if (laterStormMode && hasProgressionSignal) {
		if (laterStormMode === 'quick upscale growth') {
			return 'Quick upscale growth may follow once storms mature.';
		}
		if (/become more linear/.test(text)) {
			return 'Storms are expected to become more linear later on.';
		}
		return `Storms may organize into ${laterStormMode} later on.`;
	}
	return null;
}

function deriveNotableText(page: ParsedSpcOutlookPage, stormMode: string | null, stormEvolutionText: string | null): string | null {
	const text = `${page.summary || ''} ${page.discussionText || ''}`.toLowerCase();
	if (/short warning lead time|limit(?:ed)? warning time|warning lead time/.test(text)) {
		return 'storms may move quickly enough to limit warning time';
	}
	if ((stormMode?.includes('fast-moving') || /move quickly|moving quickly|race northeast|rapidly move|moving very fast/.test(text))) {
		return 'storms may move quickly enough to limit warning time';
	}
	if (!stormEvolutionText && /embedded tornado(?: risk| threat| potential)?/.test(text) && /discrete.*early|before .*line/.test(text)) {
		return 'a few discrete storms may form early before the line organizes';
	}
	if (!stormEvolutionText && /discrete.*early|before .*line/.test(text)) {
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
		secondaryStates: [...(summary.secondaryStates || [])].sort(),
		stateFocusText: summary.stateFocusText ?? null,
		secondaryFocusText: summary.secondaryFocusText ?? null,
		primaryAreaSource: summary.primaryAreaSource ?? null,
		region: summary.primaryRegion,
		hazard: summary.hazardFocus,
		hazardList: summary.hazardList ?? [],
		primaryHazards: summary.primaryHazards ?? [],
		secondaryHazards: summary.secondaryHazards ?? [],
		stormMode: summary.stormMode ?? null,
		stormEvolution: summary.stormEvolution ?? null,
		laterStormMode: summary.laterStormMode ?? null,
		stormEvolutionText: summary.stormEvolutionText ?? null,
		notableText: summary.notableText ?? null,
		tornadoProbability: summary.tornadoProbability ?? null,
		windProbability: summary.windProbability ?? null,
		hailProbability: summary.hailProbability ?? null,
		riskAreas: summary.riskAreas ?? null,
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
	const primaryRiskSelection = selectPrimaryRiskFeature(features, page);
	const highestRiskFeature = primaryRiskSelection.feature ?? selectHighestRiskFeature(features);
	const timingProps = highestRiskFeature?.properties ?? features[0]?.properties ?? {};
	const highestRiskLevel = getRiskLevelFromGeoJsonFeature(highestRiskFeature);
	const highestRiskNumber = spcRiskNumber(highestRiskLevel);
	const storyAreas = selectSpcPrimaryRiskArea(page, primaryRiskSelection.states);
	const stateFocusText = storyAreas.primaryFocusText;
	const affectedStates = storyAreas.primaryStates;
	const primaryRegion = derivePrimaryRegion(affectedStates);
	const riskAreas = buildGeoJsonRiskAreas(features, page);
	const probabilities = deriveProbabilities(page);
	const stormMode = deriveStormMode(page);
	const laterStormMode = deriveLaterStormMode(page);
	const stormEvolutionText = deriveStormEvolutionText(page, stormMode, laterStormMode);
	const stormEvolution = !!stormEvolutionText;
	const hazardPriority = deriveHazardPriority(page.summary, page.discussionText, probabilities, stormMode, stormEvolutionText);
	const notableText = deriveNotableText(page, stormMode, stormEvolutionText);

	const summaryWithoutHash: Omit<SpcOutlookSummary, 'summaryHash'> = {
		issuedAt: String(timingProps?.ISSUE_ISO || '').trim(),
		validFrom: String(timingProps?.VALID_ISO || '').trim(),
		validTo: String(timingProps?.EXPIRE_ISO || '').trim(),
		outlookDay: day,
		highestRiskLevel,
		highestRiskNumber,
		affectedStates,
		stateFocusText,
		secondaryStates: storyAreas.secondaryStates,
		secondaryFocusText: storyAreas.secondaryFocusText,
		primaryAreaSource: storyAreas.primaryAreaSource,
		primaryRegion,
		hazardFocus: hazardPriority.hazardFocus,
		hazardList: hazardPriority.hazardList,
		primaryHazards: hazardPriority.primaryHazards,
		secondaryHazards: hazardPriority.secondaryHazards,
		stormMode,
		stormEvolution,
		laterStormMode,
		stormEvolutionText,
		notableText,
		tornadoProbability: probabilities.tornadoProbability,
		windProbability: probabilities.windProbability,
		hailProbability: probabilities.hailProbability,
		probabilitySource: probabilities.probabilitySource,
		riskAreas,
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
	if (normalizeStoryList(current.primaryHazards).join('|') !== normalizeStoryList(previous.primaryHazards).join('|')) {
		return true;
	}
	if (normalizeStoryText(current.stormMode) && normalizeStoryText(current.stormMode) !== normalizeStoryText(previous.stormMode)) {
		return true;
	}
	if (
		normalizeStoryText(current.stormEvolutionText)
		&& normalizeStoryText(current.stormEvolutionText) !== normalizeStoryText(previous.stormEvolutionText)
	) {
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
	if (
		normalizeStoryText(current.secondaryFocusText)
		&& normalizeStoryText(current.secondaryFocusText) !== normalizeStoryText(previous.secondaryFocusText)
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

function shouldBypassSpcGapGuards(
	summary: SpcOutlookSummary,
	decision: SpcPostDecision,
	scheduleGate: ReturnType<typeof evaluateSpcPostingSchedule>,
	deferredAnchorReady = false,
): boolean {
	if (deferredAnchorReady) return true;
	if (!decision.shouldPost) return false;
	if (decision.reason !== 'new_slight_or_higher') return false;
	if (decision.postType !== defaultPostTypeForDay(summary.outlookDay)) return false;
	return scheduleGate.allowed && scheduleGate.reason === 'within_window';
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

function normalizeStateCodeList(states: string[]): string[] {
	return dedupeStrings(
		(states || [])
			.map((state) => String(state || '').trim().toUpperCase())
			.filter(Boolean),
	);
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

function renderSecondaryHazardLabel(hazard: string): string {
	if (hazard === 'tornadoes') return 'a few tornadoes';
	if (hazard === 'widespread damaging winds') return 'damaging winds';
	return hazard;
}

export function buildSpcHazardLine(summary: SpcOutlookSummary): string {
	const hazards = dedupeStrings(summary.primaryHazards ?? summary.hazardList ?? []).filter((hazard) => hazard !== 'severe weather impacts');
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

function buildSpcThreatNarrative(summary: SpcOutlookSummary, decision: SpcPostDecision): string {
	const primaryHazards = dedupeStrings(
		(summary.primaryHazards && summary.primaryHazards.length > 0)
			? summary.primaryHazards
			: (summary.hazardList ?? []).slice(0, 2),
	).filter((hazard) => hazard !== 'severe weather impacts');
	const secondaryHazards = dedupeStrings(summary.secondaryHazards ?? []).filter((hazard) => hazard !== 'severe weather impacts');
	const primaryText = joinHazardList(primaryHazards.length > 0 ? primaryHazards : [buildSpcHazardLine(summary)]);
	const isLookAhead = decision.postType === 'day2_lookahead' || decision.postType === 'day3_heads_up';
	const usesPluralThreatVerb = primaryHazards.length > 1 || /\band\b|winds\b|tornadoes\b|hazards\b/i.test(primaryText);
	let sentence = `${sentenceCase(primaryText)} ${usesPluralThreatVerb ? (isLookAhead ? 'would be the main threats' : 'look like the main threats') : (isLookAhead ? 'would be the main threat' : 'looks like the main threat')}`;
	if (secondaryHazards.length > 0) {
		sentence += `, with ${joinHazardList(secondaryHazards.map(renderSecondaryHazardLabel))} possible`;
	}
	return `${sentence}.`;
}

function buildSpcSecondaryStorySentence(summary: SpcOutlookSummary): string | null {
	const secondaryText = normalizeSpaces(summary.secondaryFocusText || '');
	if (!secondaryText) return null;
	if (!/\b(?:line|linear|squall|bowing|upscale)\b/i.test(summary.stormEvolutionText || '')) return null;
	return `Any broader line should stay secondary to the main core but could extend toward ${secondaryText} later.`;
}

function buildSpcWatchAreaText(summary: SpcOutlookSummary, stateCodes: string[]): string {
	const overlapStates = normalizeStateCodeList(stateCodes);
	if (overlapStates.length === 0) {
		return `parts of the ${summary.primaryRegion}`;
	}
	return `parts of ${formatStateList(overlapStates)}`;
}

function buildSpcWatchCoveragePhrase(expiresAt: string | null | undefined, nowMs: number): string {
	const expiresMs = parseIsoMs(expiresAt);
	if (expiresMs == null) return 'over the next several hours';
	const remainingMs = expiresMs - nowMs;
	if (remainingMs <= 0) return 'in the short term';
	if (remainingMs <= 2 * 60 * 60 * 1000) return 'over the next couple of hours';
	if (remainingMs <= 8 * 60 * 60 * 1000) return 'over the next several hours';
	if (remainingMs <= 18 * 60 * 60 * 1000) return 'into tonight';
	return 'through the day';
}

function sentenceCase(text: string): string {
	const normalized = normalizeSpaces(text);
	if (!normalized) return '';
	return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function spcSummaryOverlapStates(
	summary: Pick<SpcOutlookSummary, 'affectedStates'>,
	stateCodes: string[],
): string[] {
	const affectedStateSet = new Set(normalizeStateCodeList(summary.affectedStates || []));
	return normalizeStateCodeList(stateCodes).filter((stateCode) => affectedStateSet.has(stateCode));
}

export function buildSpcDay1WatchCommentText(
	summary: SpcOutlookSummary,
	stateCodes: string[],
	options: {
		watchLabel?: string;
		changeType?: string;
		expiresAt?: string | null;
		nowMs?: number;
	} = {},
): string {
	const watchLabel = normalizeSpaces(options.watchLabel || 'Tornado Watch');
	const changeType = String(options.changeType || '').trim().toLowerCase();
	const areaText = buildSpcWatchAreaText(summary, stateCodes);
	const opening = changeType === 'extended'
		? `${watchLabel} has been extended for ${areaText}`
		: changeType === 'updated'
			? `${watchLabel} continues for ${areaText}`
			: `A ${watchLabel} is now in effect for ${areaText}`;
	const hazardLine = summary.primaryHazards?.length === 1 && (summary.secondaryHazards?.length || 0) > 0
		? joinHazardList([summary.primaryHazards[0], summary.secondaryHazards?.[0] || ''])
		: buildSpcHazardLine(summary);
	const threatFocus = hazardLine === 'all severe hazards'
		? `All severe hazards will be possible ${buildSpcWatchCoveragePhrase(options.expiresAt, options.nowMs ?? Date.now())}.`
		: `${sentenceCase(hazardLine)} will be the main ${/\band\b|winds\b|hazards\b|tornadoes\b/i.test(hazardLine) ? 'concerns' : 'concern'} ${buildSpcWatchCoveragePhrase(options.expiresAt, options.nowMs ?? Date.now())}.`;
	return `UPDATE: ${opening} as the severe setup begins to organize. ${threatFocus}`;
}

function buildHashtags(summary: SpcOutlookSummary, enabled: boolean, outputMode: SpcOutputMode): string {
	if (!enabled || outputMode === 'comment') return '';
	return summary.affectedStates.slice(0, 3).map((state) => `#${state.toUpperCase()}wx`).join(' ');
}

function stripSpcHashtagFooter(text: string): string {
	const paragraphs = String(text || '').split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
	if (paragraphs.length === 0) return '';
	const lastParagraph = paragraphs[paragraphs.length - 1];
	if (lastParagraph && lastParagraph.split(/\s+/).every((token) => /^#\w+$/i.test(token))) {
		paragraphs.pop();
	}
	return paragraphs.join('\n\n').trim();
}

function extractSpcHashtagStates(text: string): string[] {
	return dedupeStrings(
		Array.from(String(text || '').matchAll(/#([A-Z]{2})wx\b/gi))
			.map((match) => String(match[1] || '').trim().toUpperCase())
			.filter(Boolean),
	);
}

function validateSpcPublishMessage(
	message: string,
	payload: SpcLlmPayload,
): ReturnType<typeof validateSpcLlmOutput> {
	const trimmed = String(message || '').trim();
	const hashtagStates = extractSpcHashtagStates(trimmed);
	const allowedHashtagStates = new Set(normalizeStateCodeList(payload.primary_states ?? []));
	if (hashtagStates.some((stateCode) => !allowedHashtagStates.has(stateCode))) {
		return { valid: false, text: trimmed, failureReason: 'non_core_hashtag_state' };
	}
	if (payload.output_mode === 'comment' && hashtagStates.length > 0) {
		return { valid: false, text: trimmed, failureReason: 'contains_hashtag' };
	}
	const bodyValidation = validateSpcLlmOutput(stripSpcHashtagFooter(trimmed), payload);
	if (!bodyValidation.valid) {
		return { ...bodyValidation, text: trimmed };
	}
	return { valid: true, text: trimmed };
}

function mapSpcValidationFailureToDebugCode(failureReason: string | null | undefined): string {
	switch (failureReason) {
		case 'mentions_out_of_scope_state':
		case 'non_core_hashtag_state':
			return 'spc_validation_failed_non_core_state';
		case 'mentions_conflicting_region':
		case 'missing_primary_area_anchor':
		case 'secondary_area_over_primary':
		case 'missing_core_state_cluster':
			return 'spc_validation_failed_region_mismatch';
		case 'missing_storm_evolution':
			return 'spc_validation_failed_missing_evolution';
		case 'tornado_lead_mismatch':
			return 'spc_validation_failed_tornado_lead';
		case 'contains_banned_phrase_affecting_several_states':
		case 'contains_banned_phrase_parts_of_country':
		case 'contains_banned_phrase_alerts_in_effect':
		case 'contains_generic_opening_severe_setup_today_across':
		case 'contains_generic_opening_heres_what_were_watching':
		case 'contains_formulaic_phrase_is_focused_on':
		case 'contains_formulaic_phrase_is_in_place':
		case 'contains_formulaic_phrase_is_centered':
		case 'contains_formulaic_change_phrase_is_intensifying':
		case 'contains_formulaic_change_phrase_is_expanding':
		case 'contains_hype_language':
			return 'spc_validation_failed_banned_phrase';
		case 'contains_hashtag':
			return 'spc_validation_failed_hashtag';
		default:
			return 'spc_validation_failed_invalid_output';
	}
}

type SpcFinalTextBuildResult = {
	message: string;
	validationFailures: string[];
};

type SpcDeferredAnchorRecord = {
	day: Exclude<SpcOutlookDay, 1>;
	queuedAt: string;
	releaseAfter: string;
	forecastDay: string;
	storyKey: string | null;
	suppressedByLane: FacebookCoverageIntent['lane'] | null;
};

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

function buildAfdStormModeFallback(afdEnrichment?: SpcAfdEnrichment | null): string | null {
	return normalizeSpaces(afdEnrichment?.stormModeHints?.[0] || '') || null;
}

function buildAfdTimingFallback(afdEnrichment?: SpcAfdEnrichment | null): string | null {
	return normalizeSpaces(afdEnrichment?.timingHints?.[0] || '') || null;
}

function buildAfdNotableFallback(afdEnrichment?: SpcAfdEnrichment | null): string | null {
	return normalizeSpaces(afdEnrichment?.notableBehaviorHints?.[0] || '') || null;
}

function buildAfdStormModeNudge(summary: SpcOutlookSummary, afdEnrichment?: SpcAfdEnrichment | null): string | null {
	const hint = normalizeStoryText(afdEnrichment?.stormModeHints?.[0] || '');
	const current = normalizeStoryText([summary.stormMode, summary.stormEvolutionText].filter(Boolean).join(' '));
	if (!hint) return null;
	if (current && (current.includes(hint) || hint.includes(current))) return null;
	if (hint === 'quick upscale growth') return 'Quick upscale growth may follow once storms mature.';
	if (hint === 'discrete supercells') return 'A few storms may stay discrete early before clustering later.';
	if (hint === 'fast-moving supercells') return 'Any early supercells may move quickly.';
	if (hint === 'squall line' || hint === 'bowing line segments') return 'Storms may consolidate into a line as they move east.';
	if (hint === 'storm clusters') return 'Storms may organize into clusters as the evening goes on.';
	return `Storm mode may lean toward ${hint}.`;
}

function buildAfdTimingNudge(summary: SpcOutlookSummary, afdEnrichment?: SpcAfdEnrichment | null): string | null {
	const hint = normalizeSpaces(afdEnrichment?.timingHints?.[0] || '');
	if (!hint) return null;
	const normalizedHint = normalizeStoryText(hint);
	const normalizedTiming = normalizeStoryText(summary.timingText || '');
	if (normalizedTiming && (normalizedTiming.includes(normalizedHint) || normalizedHint.includes(normalizedTiming))) {
		return null;
	}
	if (normalizedHint === 'after morning clouds clear') {
		return 'Storm chances may improve once morning clouds thin out.';
	}
	return `The better window may sharpen ${hint}.`;
}

function buildAfdHazardNudge(summary: SpcOutlookSummary, afdEnrichment?: SpcAfdEnrichment | null): string | null {
	const summaryHazardText = [buildSpcHazardLine(summary), ...(summary.secondaryHazards || [])].join(' ').toLowerCase();
	const emphasis = dedupeStrings(
		(afdEnrichment?.hazardEmphasis || []).filter((value) => !summaryHazardText.includes(String(value || '').toLowerCase())),
	);
	if (emphasis.length === 0) return null;
	const label = joinNaturalList(
		emphasis.map((value) => {
			if (value === 'tornado') return 'tornado potential';
			if (value === 'damaging wind') return 'damaging wind potential';
			if (value === 'large hail') return 'large hail potential';
			return value;
		}),
	);
	return `${sentenceCase(label)} may stand out a bit more if storms mature.`;
}

function buildAfdConfidenceSentence(afdEnrichment?: SpcAfdEnrichment | null): string | null {
	const confidence = normalizeSpaces(afdEnrichment?.confidenceHints?.[0] || '');
	const uncertainty = normalizeSpaces(afdEnrichment?.uncertaintyHints?.[0] || '');
	if (confidence && uncertainty) {
		return `${sentenceCase(confidence)}, though ${uncertainty.replace(/^[A-Z]/, (char) => char.toLowerCase())}.`;
	}
	if (uncertainty) return `${sentenceCase(uncertainty)}.`;
	if (confidence) return `${sentenceCase(confidence)}.`;
	return null;
}

function buildAfdSupportSentences(summary: SpcOutlookSummary, afdEnrichment?: SpcAfdEnrichment | null): string[] {
	const primaryNudge = buildAfdTimingNudge(summary, afdEnrichment)
		?? buildAfdStormModeNudge(summary, afdEnrichment)
		?? buildAfdHazardNudge(summary, afdEnrichment)
		?? (() => {
			const notableHint = normalizeSpaces(afdEnrichment?.notableBehaviorHints?.[0] || '');
			if (!notableHint) return null;
			const summaryNotable = normalizeStoryText(summary.notableText || '');
			const normalizedHint = normalizeStoryText(notableHint);
			if (summaryNotable && (summaryNotable.includes(normalizedHint) || normalizedHint.includes(summaryNotable))) {
				return null;
			}
			return `${sentenceCase(notableHint)}.`;
		})();
	const confidenceSentence = buildAfdConfidenceSentence(afdEnrichment);
	return [primaryNudge, confidenceSentence].filter((value): value is string => !!value).slice(0, 2);
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
	const currentPrimaryHazards = dedupeStrings(currentSummary.primaryHazards ?? []).slice(0, 2);
	const previousPrimaryHazards = dedupeStrings(previousSummary.primaryHazards ?? []).slice(0, 2);
	const hints: string[] = [];

	if (currentSummary.highestRiskNumber > previousSummary.highestRiskNumber) {
		hints.push(`risk upgraded to Level ${currentSummary.highestRiskNumber} ${riskLabelDisplay(currentSummary.highestRiskLevel)} Risk`);
	}
	if (normalizeStoryText(currentSummary.stateFocusText) && normalizeStoryText(currentSummary.stateFocusText) !== normalizeStoryText(previousSummary.stateFocusText)) {
		hints.push(`core risk area now centered on ${currentSummary.stateFocusText}`);
	}
	if (currentSummary.primaryRegion !== previousSummary.primaryRegion) {
		hints.push(`focus shifting toward the ${currentSummary.primaryRegion}`);
	}
	if (addedStates.length > 0) {
		hints.push(`new core states added: ${joinNaturalList(addedStates.slice(0, 4))}`);
	}
	if (
		currentPrimaryHazards.length > 0
		&& currentPrimaryHazards.join('|').toLowerCase() !== previousPrimaryHazards.join('|').toLowerCase()
	) {
		hints.push(`main threats now lean more toward ${joinHazardList(currentPrimaryHazards)}`);
	}
	if (currentHazards.has('tornadoes') && !previousHazards.has('tornadoes')) {
		hints.push('tornado risk is being highlighted more clearly');
	}
	if (
		normalizeStoryText(currentSummary.stormEvolutionText)
		&& normalizeStoryText(currentSummary.stormEvolutionText) !== normalizeStoryText(previousSummary.stormEvolutionText)
	) {
		if (/\b(?:line|linear|squall|bowing)\b/i.test(currentSummary.stormEvolutionText || '')) {
			hints.push('storms now look more likely to organize into a line later');
		} else {
			hints.push(`storm evolution now favors ${currentSummary.stormMode || 'a more organized setup'}`);
		}
	} else if (normalizeStoryText(currentSummary.stormMode) && normalizeStoryText(currentSummary.stormMode) !== normalizeStoryText(previousSummary.stormMode)) {
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
		hints.push(`timing is coming into better focus for ${currentSummary.timingText}`);
	}
	if (
		normalizeStoryText(currentSummary.secondaryFocusText)
		&& normalizeStoryText(currentSummary.secondaryFocusText) !== normalizeStoryText(previousSummary.secondaryFocusText)
	) {
		hints.push(`a secondary corridor may extend toward ${currentSummary.secondaryFocusText}`);
	}
	if (removedStates.length > 0 && addedStates.length === 0 && currentSummary.primaryRegion === previousSummary.primaryRegion) {
		hints.push(`focus narrowing within ${currentSummary.primaryRegion}`);
	}

	return hints.slice(0, 3).join('; ') || null;
}

function buildOpeningCandidates(summary: SpcOutlookSummary, decision: SpcPostDecision, outputMode: SpcOutputMode, changeHint?: string | null): string[] {
	const stateList = getSpcFocusAreaText(summary);
	if (outputMode === 'comment') {
		if (changeHint) {
			return [`UPDATE: ${changeHint.charAt(0).toUpperCase()}${changeHint.slice(1)}.`];
		}
		if (decision.reason === 'risk_upgrade') {
			return [`UPDATE: Severe weather concern has increased across the ${summary.primaryRegion}.`];
		}
		if (decision.reason === 'timing_refresh') {
			return [`UPDATE: The timing window is coming into better focus across parts of ${stateList}.`];
		}
		if (decision.reason === 'region_shift') {
			return [`UPDATE: The core severe weather focus is shifting across the ${summary.primaryRegion}.`];
		}
		if (decision.reason === 'hazard_change' || decision.reason === 'probability_shift') {
			return [`UPDATE: The threat mix is evolving across the ${summary.primaryRegion}.`];
		}
		return [`UPDATE: The severe weather story is changing across the ${summary.primaryRegion}.`];
	}

	if (decision.postType === 'day2_lookahead') {
		return [
			`Tomorrow has our attention across the ${summary.primaryRegion}.`,
			`Watching tomorrow closely across the ${summary.primaryRegion}.`,
			`A more organized severe setup may unfold tomorrow across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'day3_heads_up') {
		return [
			`The day 3 severe weather signal is worth watching across the ${summary.primaryRegion}.`,
			`A broader severe setup may take shape later this period across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'upgrade') {
		if (decision.reason === 'risk_upgrade') {
			return [
				`Confidence is increasing in a more serious setup across the ${summary.primaryRegion}.`,
				`The severe weather story is becoming more focused across the ${summary.primaryRegion}.`,
			];
		}
		return [
			`The severe weather story is evolving across the ${summary.primaryRegion}.`,
			`The core setup is shifting across the ${summary.primaryRegion}.`,
		];
	}
	if (decision.postType === 'timing_refresh') {
		return [
			`The timing window is becoming more important across parts of ${stateList}.`,
			`The timing window for severe storms is getting closer across parts of ${stateList}.`,
		];
	}
	return [
		`This afternoon to watch across the ${summary.primaryRegion}.`,
		`Watching today closely across the ${summary.primaryRegion}.`,
		`A volatile setup is taking shape this afternoon across the ${summary.primaryRegion}.`,
		`The core severe weather story today is setting up across the ${summary.primaryRegion}.`,
	];
}


function withTrailingPeriod(text: string): string {
	const normalized = normalizeSpaces(text);
	if (!normalized) return '';
	return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}


function buildStormSentence(summary: SpcOutlookSummary, decision: SpcPostDecision, afdEnrichment?: SpcAfdEnrichment | null): string {
	const stormMode = normalizeSpaces(summary.stormMode || buildAfdStormModeFallback(afdEnrichment) || '');
	const evolutionText = normalizeSpaces(summary.stormEvolutionText || '');
	const timingText = normalizeSpaces(summary.timingText || buildAfdTimingFallback(afdEnrichment) || '');
	const notableText = normalizeSpaces(summary.notableText || buildAfdNotableFallback(afdEnrichment) || '');
	const sentences: string[] = [];

	if (evolutionText) {
		sentences.push(withTrailingPeriod(evolutionText));
	} else if (stormMode) {
		if (decision.postType === 'day2_lookahead' || decision.postType === 'day3_heads_up') {
			sentences.push(`Storm mode may favor ${stormMode}.`);
		} else {
			sentences.push(`${sentenceCase(stormMode)} may be the main storm mode.`);
		}
	}

	sentences.push(buildSpcThreatNarrative(summary, decision));

	if (timingText && !normalizeStoryText(evolutionText).includes(normalizeStoryText(timingText))) {
		if (decision.postType === 'timing_refresh') {
			sentences.push(`The main window now looks ${timingText}.`);
		} else if (decision.postType === 'day2_lookahead' || decision.postType === 'day3_heads_up') {
			sentences.push(`The better window looks ${timingText}.`);
		} else {
			sentences.push(`The main window looks ${timingText}.`);
		}
	}

	if (notableText && !normalizeStoryText(evolutionText).includes(normalizeStoryText(notableText))) {
		sentences.push(withTrailingPeriod(notableText));
	}

	const secondaryStorySentence = buildSpcSecondaryStorySentence(summary);
	if (secondaryStorySentence) {
		sentences.push(secondaryStorySentence);
	}

	return sentences.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function buildBaseSecondParagraph(summary: SpcOutlookSummary, decision: SpcPostDecision, afdEnrichment?: SpcAfdEnrichment | null): string {
	const stateList = getSpcFocusAreaText(summary);
	const riskText = `Level ${summary.highestRiskNumber} ${riskLabelDisplay(summary.highestRiskLevel)} Risk`;
	const stormSentence = buildStormSentence(summary, decision, afdEnrichment);
	const afdSupport = buildAfdSupportSentences(summary, afdEnrichment).join(' ');

	if (decision.postType === 'day2_lookahead') {
		return `SPC has issued a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	if (decision.postType === 'day3_heads_up') {
		return `SPC has issued a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	if (decision.postType === 'upgrade') {
		if (decision.reason === 'risk_upgrade') {
			return `SPC has upgraded parts of ${stateList} to a ${riskText}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
		}
		if (decision.reason === 'probability_shift') {
			return `SPC still has a ${riskText} centered on ${stateList}, but the forecast confidence has shifted. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
		}
		return `SPC still has a ${riskText} centered on ${stateList}, but the setup has changed. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	if (decision.postType === 'timing_refresh') {
		return `The main concern remains a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	return `SPC has issued a ${riskText} for severe storms centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
}

function buildCommentSecondParagraph(summary: SpcOutlookSummary, decision: SpcPostDecision, changeHint?: string | null, afdEnrichment?: SpcAfdEnrichment | null): string {
	const stateList = getSpcFocusAreaText(summary);
	const riskText = `Level ${summary.highestRiskNumber} ${riskLabelDisplay(summary.highestRiskLevel)} Risk`;
	const stormSentence = buildStormSentence(summary, decision, afdEnrichment);
	const afdSupport = buildAfdSupportSentences(summary, afdEnrichment).join(' ');
	if (decision.reason === 'timing_refresh') {
		return `SPC still has a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	if (changeHint) {
		return `SPC still has a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
	}
	return `SPC still has a ${riskText} centered on ${stateList}. ${stormSentence}${afdSupport ? ` ${afdSupport}` : ''}`.trim();
}

export function buildSpcPostText(
	summary: SpcOutlookSummary,
	decision: SpcPostDecision,
	recentOpenings: string[] = [],
	hashtagsEnabled = false,
	outputMode: SpcOutputMode = 'post',
	changeHint?: string | null,
	afdEnrichment?: SpcAfdEnrichment | null,
): string {
	const opening = outputMode === 'comment'
		? (buildOpeningCandidates(summary, decision, outputMode, changeHint)[0] ?? 'UPDATE: The severe weather setup is changing.')
		: selectOpening(buildOpeningCandidates(summary, decision, outputMode, changeHint), recentOpenings);
	const secondParagraph = outputMode === 'comment'
		? buildCommentSecondParagraph(summary, decision, changeHint, afdEnrichment)
		: buildBaseSecondParagraph(summary, decision, afdEnrichment);
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

async function readSpcDeferredAnchor(
	env: Env,
	day: Exclude<SpcOutlookDay, 1>,
): Promise<SpcDeferredAnchorRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(kvSpcDeferredAnchorKey(day));
		if (!raw) return null;
		return JSON.parse(raw) as SpcDeferredAnchorRecord;
	} catch {
		return null;
	}
}

async function writeSpcDeferredAnchor(
	env: Env,
	day: Exclude<SpcOutlookDay, 1>,
	record: SpcDeferredAnchorRecord,
): Promise<void> {
	await env.WEATHER_KV.put(kvSpcDeferredAnchorKey(day), JSON.stringify(record), { expirationTtl: SPC_STATE_TTL_SECONDS });
}

async function clearSpcDeferredAnchor(env: Env, day: Exclude<SpcOutlookDay, 1>): Promise<void> {
	await env.WEATHER_KV.delete(kvSpcDeferredAnchorKey(day));
}

function isDeferredAnchorReady(record: SpcDeferredAnchorRecord, nowMs: number): boolean {
	const releaseAfterMs = parseIsoMs(record.releaseAfter);
	if (releaseAfterMs != null) return nowMs >= releaseAfterMs;
	const queuedAtMs = parseIsoMs(record.queuedAt);
	return queuedAtMs != null && nowMs >= (queuedAtMs + SPC_DEFERRED_ANCHOR_DELAY_MS);
}

export async function readSpcThreadRecord(env: Env, day: SpcOutlookDay): Promise<SpcThreadRecord | null> {
	return await readSpcThread(env, day);
}

export async function recordSpcThreadCommentActivity(
	env: Env,
	day: SpcOutlookDay,
	options: {
		nowMs?: number;
		postId?: string | null;
	} = {},
): Promise<SpcThreadRecord | null> {
	const thread = await readSpcThread(env, day);
	if (!thread) return null;
	if (options.postId && thread.postId !== options.postId) return null;
	const updatedThread: SpcThreadRecord = {
		...thread,
		commentCount: Math.max(0, Number(thread.commentCount || 0)) + 1,
		lastCommentAt: new Date(options.nowMs ?? Date.now()).toISOString(),
	};
	await writeSpcThread(env, day, updatedThread);
	return updatedThread;
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
		secondaryStates: summary.secondaryStates,
		stateFocusText: summary.stateFocusText ?? null,
		secondaryFocusText: summary.secondaryFocusText ?? null,
		primaryAreaSource: summary.primaryAreaSource ?? null,
		primaryRegion: summary.primaryRegion,
		hazardFocus: summary.hazardFocus,
		hazardList: summary.hazardList ?? [],
		primaryHazards: summary.primaryHazards ?? [],
		secondaryHazards: summary.secondaryHazards ?? [],
		stormMode: summary.stormMode ?? null,
		stormEvolution: summary.stormEvolution ?? null,
		laterStormMode: summary.laterStormMode ?? null,
		stormEvolutionText: summary.stormEvolutionText ?? null,
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

async function buildSpcFinalText(env: Env, summary: SpcOutlookSummary, decision: SpcPostDecision, options: { outputMode: SpcOutputMode; hashtagsEnabled: boolean; llmEnabled: boolean; recentOpenings: string[]; changeHint?: string | null; afdEnrichment?: SpcAfdEnrichment | null; }): Promise<SpcFinalTextBuildResult> {
	const { outputMode, hashtagsEnabled, llmEnabled, recentOpenings, changeHint, afdEnrichment } = options;
	const validationFailures: string[] = [];
	const recordValidationFailure = (
		failureReason: string | null | undefined,
		source: 'llm_output' | 'template_output',
		attempt?: number,
	): string => {
		const debugCode = mapSpcValidationFailureToDebugCode(failureReason);
		validationFailures.push(debugCode);
		console.warn(
			`[fb-spc] ${source} rejected reason=${debugCode}${attempt ? ` attempt=${attempt}` : ''}`
			+ `${failureReason ? ` raw=${failureReason}` : ''}`,
		);
		return debugCode;
	};
	const payload = buildSpcLlmPayload({
		outputMode,
		outlookDay: summary.outlookDay,
		postType: (decision.postType || defaultPostTypeForDay(summary.outlookDay)) as Exclude<SpcLlmPayload['post_type'], ''>,
		riskLevel: summary.highestRiskLevel,
		riskNumber: summary.highestRiskNumber,
		primaryRegion: summary.primaryRegion,
		states: summary.affectedStates,
		secondaryStates: summary.secondaryStates ?? [],
		stateFocusText: summary.stateFocusText ?? null,
		secondaryAreaText: summary.secondaryFocusText ?? null,
		hazardFocus: summary.hazardFocus,
		hazardList: summary.hazardList ?? [],
		primaryHazards: summary.primaryHazards ?? [],
		secondaryHazards: summary.secondaryHazards ?? [],
		hazardLine: buildSpcHazardLine(summary),
		stormMode: summary.stormMode ?? null,
		stormEvolution: summary.stormEvolution ?? false,
		stormEvolutionText: summary.stormEvolutionText ?? null,
		timingWindow: summary.timingText ?? null,
		notableText: summary.notableText ?? null,
		afdTimingHints: afdEnrichment?.timingHints ?? [],
		afdStormModeHints: afdEnrichment?.stormModeHints ?? [],
		afdHazardEmphasis: afdEnrichment?.hazardEmphasis ?? [],
		afdUncertaintyHints: afdEnrichment?.uncertaintyHints ?? [],
		afdConfidenceHints: afdEnrichment?.confidenceHints ?? [],
		afdNotableBehaviorHints: afdEnrichment?.notableBehaviorHints ?? [],
		trend: buildTrend(decision, summary),
		changeHint,
		recentOpenings,
		hashtagsEnabled,
	});
	if (llmEnabled) {
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const llmResult = await generateSpcLlmCopy(env, payload);
			if (llmResult.text) {
				const hashtags = buildHashtags(summary, hashtagsEnabled, outputMode);
				const llmMessage = [llmResult.text, hashtags].filter(Boolean).join('\n\n');
				const llmValidation = validateSpcPublishMessage(llmMessage, payload);
				if (llmValidation.valid) {
					return {
						message: llmMessage,
						validationFailures: dedupeStrings(validationFailures),
					};
				}
				recordValidationFailure(llmValidation.failureReason, 'llm_output', attempt);
				continue;
			}
			if (llmResult.failureReason && llmResult.failureReason !== 'workers_ai_unavailable') {
				recordValidationFailure(llmResult.failureReason, 'llm_output', attempt);
			}
			if (llmResult.failureReason === 'workers_ai_unavailable') {
				break;
			}
		}
	}
	const templateMessage = buildSpcPostText(summary, decision, recentOpenings, hashtagsEnabled, outputMode, changeHint, afdEnrichment);
	const templateValidation = validateSpcPublishMessage(templateMessage, payload);
	if (!templateValidation.valid) {
		const debugCode = recordValidationFailure(templateValidation.failureReason, 'template_output');
		console.error(
			`[fb-spc] template output invalid reason=${debugCode} `
			+ `states=${payload.states.join('|')} mode=${outputMode} type=${payload.post_type} text=${JSON.stringify(stripSpcHashtagFooter(templateMessage))}`,
		);
		throw new Error(debugCode);
	}
	return {
		message: templateMessage,
		validationFailures: dedupeStrings(validationFailures),
	};
}

type SpcCoveragePlan = {
	entry: SpcDebugEntry;
	intent: FacebookCoverageIntent | null;
	blockedReason: string | null;
	summary: SpcOutlookSummary | null;
	decision: SpcPostDecision;
	lastPost: PublishedSpcOutlookRecord | null;
	outputMode: SpcOutputMode | null;
	existingThread: SpcThreadRecord | null;
	changeHint: string | null;
	afdEnrichment: SpcAfdEnrichment | null;
};

function spcDeferredAnchorDayFromLane(
	lane: FacebookCoverageIntent['lane'],
): Exclude<SpcOutlookDay, 1> | null {
	if (lane === 'spc_day2') return 2;
	if (lane === 'spc_day3') return 3;
	return null;
}

function spcLaneForDay(day: SpcOutlookDay): FacebookCoverageIntent['lane'] {
	if (day === 1) return 'spc_day1';
	if (day === 2) return 'spc_day2';
	return 'spc_day3';
}

function spcCoverageIntentPriority(
	summary: SpcOutlookSummary,
	decision: SpcPostDecision,
	outputMode: SpcOutputMode,
	deferredAnchorReady = false,
): number {
	let priority = summary.outlookDay === 1 ? 760 : summary.outlookDay === 2 ? 620 : 580;
	if (deferredAnchorReady && summary.outlookDay === 2) priority = Math.max(priority, 850);
	if (deferredAnchorReady && summary.outlookDay === 3) priority = Math.max(priority, 840);
	if (decision.reason === 'risk_upgrade' || decision.reason === 'probability_shift' || decision.reason === 'hazard_change' || decision.reason === 'region_shift') {
		priority += 90;
	} else if (decision.reason === 'new_slight_or_higher') {
		priority += 50;
	} else if (decision.reason === 'timing_refresh') {
		priority += 20;
	}
	if (decision.postType === 'upgrade') priority += 15;
	if (outputMode === 'comment') priority -= 30;
	return priority;
}

function buildSpcCoverageIntent(
	summary: SpcOutlookSummary,
	decision: SpcPostDecision,
	outputMode: SpcOutputMode,
	targetPostId?: string | null,
	options: {
		reason?: string;
		deferredAnchorReady?: boolean;
	} = {},
): FacebookCoverageIntent {
	return {
		lane: spcLaneForDay(summary.outlookDay),
		action: outputMode === 'comment' ? 'comment' : 'post',
		priority: spcCoverageIntentPriority(summary, decision, outputMode, options.deferredAnchorReady === true),
		reason: options.reason ?? decision.reason,
		summary: `SPC Day ${summary.outlookDay} ${decision.postType || 'outlook'} for ${summary.primaryRegion}`,
		storyKey: summary.summaryHash,
		targetPostId: targetPostId ?? null,
	};
}

export async function queueDeferredSpcAnchorIfNeeded(
	env: Env,
	evaluation: FacebookCoverageEvaluation,
	selectedIntent: FacebookCoverageIntent | null,
	nowMs = Date.now(),
): Promise<void> {
	if (!selectedIntent || !evaluation.intent) return;
	if (evaluation.lane === selectedIntent.lane) return;
	const day = spcDeferredAnchorDayFromLane(evaluation.intent.lane);
	if (!day) return;
	if (evaluation.intent.action !== 'post') return;
	if (evaluation.intent.reason !== 'new_slight_or_higher') return;
	const latestSummary = await readLastSpcSummary(env, day);
	if (!latestSummary) return;
	const nextForecastDay = forecastDayKey(latestSummary);
	if (!nextForecastDay) return;
	const existing = await readSpcDeferredAnchor(env, day);
	if (existing?.forecastDay === nextForecastDay) return;
	const queuedAt = new Date(nowMs).toISOString();
	await writeSpcDeferredAnchor(env, day, {
		day,
		queuedAt,
		releaseAfter: new Date(nowMs + SPC_DEFERRED_ANCHOR_DELAY_MS).toISOString(),
		forecastDay: nextForecastDay,
		storyKey: evaluation.intent.storyKey ?? null,
		suppressedByLane: selectedIntent.lane,
	});
}

async function buildSpcCoveragePlanForDay(env: Env, day: SpcOutlookDay, nowMs = Date.now()): Promise<SpcCoveragePlan> {
	const generatedAt = new Date(nowMs).toISOString();
	const config = await readFbAutoPostConfig(env);
	const lastPost = await readLastSpcPost(env, day);
	const deferredAnchor = day === 1 ? null : await readSpcDeferredAnchor(env, day);
	const disabledDecision: SpcPostDecision = { shouldPost: false, reason: 'below_threshold', postType: '' };
	const emptyEntry = (error: string | null): SpcDebugEntry => ({
		outlookDay: day,
		generatedAt,
		decision: disabledDecision,
		summary: null,
		lastPost,
		plannedOutputMode: null,
		messagePreview: null,
		error,
	});

	if (!isCoverageEnabledForDay(config, day)) {
		return {
			entry: emptyEntry('coverage_disabled'),
			intent: null,
			blockedReason: 'coverage_disabled',
			summary: null,
			decision: disabledDecision,
			lastPost,
			outputMode: null,
			existingThread: null,
			changeHint: null,
			afdEnrichment: null,
		};
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		return {
			entry: emptyEntry('facebook_credentials_missing'),
			intent: null,
			blockedReason: 'facebook_credentials_missing',
			summary: null,
			decision: disabledDecision,
			lastPost,
			outputMode: null,
			existingThread: null,
			changeHint: null,
			afdEnrichment: null,
		};
	}

	try {
		const summary = await fetchLatestSpcOutlookSummary(day);
		await writeLastSpcSummary(env, day, summary);
		const decision = buildSpcPostDecision(summary, lastPost, config, nowMs);
		const mainAnchorEligible = day !== 1
			&& decision.shouldPost
			&& decision.reason === 'new_slight_or_higher'
			&& decision.postType === defaultPostTypeForDay(day);
		let activeDeferredAnchor = deferredAnchor;
		if (day !== 1 && deferredAnchor) {
			if (!mainAnchorEligible || deferredAnchor.forecastDay !== forecastDayKey(summary)) {
				await clearSpcDeferredAnchor(env, day);
				activeDeferredAnchor = null;
			}
		}
		if (!decision.shouldPost) {
			return {
				entry: {
					outlookDay: day,
					generatedAt,
					decision,
					summary,
					lastPost,
					plannedOutputMode: null,
					messagePreview: null,
					error: null,
				},
				intent: null,
				blockedReason: decision.reason,
				summary,
				decision,
				lastPost,
				outputMode: null,
				existingThread: null,
				changeHint: null,
				afdEnrichment: null,
			};
		}

		const scheduleGate = evaluateSpcPostingSchedule(summary, decision, lastPost, nowMs);
		const deferredAnchorReady = !!activeDeferredAnchor && isDeferredAnchorReady(activeDeferredAnchor, nowMs);
		if (!scheduleGate.allowed && !deferredAnchorReady) {
			const blockedReason = activeDeferredAnchor ? 'deferred_anchor_waiting' : 'outside_post_window';
			return {
				entry: {
					outlookDay: day,
					generatedAt,
					decision,
					summary,
					lastPost,
					plannedOutputMode: null,
					messagePreview: null,
					error: blockedReason,
				},
				intent: null,
				blockedReason,
				summary,
				decision,
				lastPost,
				outputMode: null,
				existingThread: null,
				changeHint: null,
				afdEnrichment: null,
			};
		}

		const deferredAnchorRelease = deferredAnchorReady && !scheduleGate.allowed;
		const bypassGapGuards = shouldBypassSpcGapGuards(summary, decision, scheduleGate, deferredAnchorRelease);
		const recentPostConflict = await readMostRecentSpcPostWithinGap(env, nowMs);
		if (recentPostConflict && !bypassGapGuards) {
			return {
				entry: {
					outlookDay: day,
					generatedAt,
					decision,
					summary,
					lastPost,
					plannedOutputMode: null,
					messagePreview: null,
					error: 'recent_spc_post_gap',
				},
				intent: null,
				blockedReason: 'recent_spc_post_gap',
				summary,
				decision,
				lastPost,
				outputMode: null,
				existingThread: null,
				changeHint: null,
				afdEnrichment: null,
			};
		}

		const recentGlobalActivity = await readRecentFacebookActivity(env, nowMs, SPC_GLOBAL_POST_GAP_MS);
		if (recentGlobalActivity.withinGap && !bypassGapGuards) {
			return {
				entry: {
					outlookDay: day,
					generatedAt,
					decision,
					summary,
					lastPost,
					plannedOutputMode: null,
					messagePreview: null,
					error: 'recent_global_post_gap',
				},
				intent: null,
				blockedReason: 'recent_global_post_gap',
				summary,
				decision,
				lastPost,
				outputMode: null,
				existingThread: null,
				changeHint: null,
				afdEnrichment: null,
			};
		}

		const existingThread = await readSpcThread(env, day);
		const outputMode: SpcOutputMode = shouldUseThreadComment(summary, decision, existingThread, nowMs) ? 'comment' : 'post';
		const changeHint = outputMode === 'comment' ? buildSpcCommentChangeHint(existingThread?.summary, summary) : null;
		const afdEnrichment = await buildSpcAfdEnrichment(summary).catch(() => null);
		const intent = buildSpcCoverageIntent(summary, decision, outputMode, existingThread?.postId ?? null, {
			reason: deferredAnchorRelease ? 'deferred_anchor_release' : undefined,
			deferredAnchorReady: deferredAnchorRelease,
		});

		return {
			entry: {
				outlookDay: day,
				generatedAt,
				decision,
				summary,
				afdEnrichment,
				lastPost,
				plannedOutputMode: outputMode,
				messagePreview: null,
				error: null,
			},
			intent,
			blockedReason: null,
			summary,
			decision,
			lastPost,
			outputMode,
			existingThread,
			changeHint,
			afdEnrichment,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			entry: {
				outlookDay: day,
				generatedAt,
				decision: disabledDecision,
				summary: null,
				lastPost,
				plannedOutputMode: null,
				messagePreview: null,
				error: message,
			},
			intent: null,
			blockedReason: message,
			summary: null,
			decision: disabledDecision,
			lastPost,
			outputMode: null,
			existingThread: null,
			changeHint: null,
			afdEnrichment: null,
		};
	}
}

export async function evaluateSpcCoverageIntentForDay(
	env: Env,
	day: SpcOutlookDay,
	nowMs = Date.now(),
): Promise<FacebookCoverageEvaluation> {
	const plan = await buildSpcCoveragePlanForDay(env, day, nowMs);
	return {
		lane: spcLaneForDay(day),
		intent: plan.intent,
		blockedReason: plan.blockedReason,
	};
}

export async function evaluateSpcCoverageIntents(
	env: Env,
	nowMs = Date.now(),
): Promise<FacebookCoverageEvaluation[]> {
	const evaluations: FacebookCoverageEvaluation[] = [];
	for (const day of [1, 2, 3] as const) {
		evaluations.push(await evaluateSpcCoverageIntentForDay(env, day, nowMs));
	}
	return evaluations;
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
	const plan = await buildSpcCoveragePlanForDay(env, day, nowMs);
	if (!plan.intent || !plan.summary || !plan.outputMode) {
		if (plan.entry.error) {
			console.log(`[fb-spc] day${day} skipping ${plan.entry.error}`);
		}
		return {
			...plan.entry,
			validationFailures: plan.entry.validationFailures ?? [],
			debugMessages: dedupeStrings([
				...(plan.entry.debugMessages ?? []),
				plan.blockedReason ?? '',
				plan.entry.error ?? '',
			]),
		};
	}

	let validationFailures: string[] = [];
	try {
		const config = await readFbAutoPostConfig(env);
		const recentOpenings = await readRecentSpcOpenings(env);
		const finalText = await buildSpcFinalText(env, plan.summary, plan.decision, {
			outputMode: plan.outputMode,
			hashtagsEnabled: config.spcHashtagsEnabled !== false,
			llmEnabled: config.spcLlmEnabled === true,
			recentOpenings,
			changeHint: plan.changeHint,
			afdEnrichment: plan.afdEnrichment,
		});
		const message = finalText.message;
		validationFailures = finalText.validationFailures;

		if (plan.outputMode === 'comment' && plan.existingThread?.postId) {
			const commentId = await commentOnFacebook(env, plan.existingThread.postId, message);
			await recordLastFacebookActivity(env, nowMs);
			await recordRecentSpcOpening(env, message);
			const record = buildPublishedSpcRecord(plan.summary, plan.decision, plan.existingThread.postId, nowMs, 'comment', commentId);
			await writeLastSpcPost(env, day, record);
			await writeLastSpcHash(env, day, plan.summary.summaryHash);
			if (day !== 1) {
				await clearSpcDeferredAnchor(env, day);
			}
			const updatedThread: SpcThreadRecord = {
				...plan.existingThread,
				issuedAt: plan.summary.issuedAt,
				hash: plan.summary.summaryHash,
				commentCount: plan.existingThread.commentCount + 1,
				lastCommentAt: new Date(nowMs).toISOString(),
				lastDecisionReason: plan.decision.reason as Exclude<SpcPostReason, 'no_material_change' | 'below_threshold'>,
				summary: plan.summary,
			};
			await writeSpcThread(env, day, updatedThread);
			console.log(
				`[fb-spc] day${day} posted comment=${commentId} post=${plan.existingThread.postId} `
				+ `reason=${plan.intent.reason}`,
			);
			return {
				...plan.entry,
				lastPost: record,
				plannedOutputMode: 'comment',
				messagePreview: message.slice(0, 320),
				validationFailures,
				debugMessages: dedupeStrings([plan.intent.reason, ...validationFailures]),
				error: null,
			};
		}

		const postId = await postToFacebook(env, message, plan.summary.imageUrl || undefined);
		await recordLastFacebookActivity(env, nowMs);
		await recordRecentSpcOpening(env, message);
		const record = buildPublishedSpcRecord(plan.summary, plan.decision, postId, nowMs, 'post');
		await writeLastSpcPost(env, day, record);
		await writeLastSpcHash(env, day, plan.summary.summaryHash);
		if (day !== 1) {
			await clearSpcDeferredAnchor(env, day);
		}
		await writeSpcThread(env, day, {
			postId,
			outlookDay: day,
			issuedAt: plan.summary.issuedAt,
			publishedAt: new Date(nowMs).toISOString(),
			hash: plan.summary.summaryHash,
			commentCount: 0,
			lastCommentAt: null,
			lastDecisionReason: plan.decision.reason as Exclude<SpcPostReason, 'no_material_change' | 'below_threshold'>,
			summary: plan.summary,
		});
		console.log(
			`[fb-spc] day${day} posted ${record.postType} post=${postId} risk=${plan.summary.highestRiskLevel} `
			+ `region=${plan.summary.primaryRegion} reason=${plan.intent.reason}`,
		);
		return {
			...plan.entry,
			lastPost: record,
			plannedOutputMode: 'post',
			messagePreview: message.slice(0, 320),
			validationFailures,
			debugMessages: dedupeStrings([plan.intent.reason, ...validationFailures]),
			error: null,
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		console.error(`[fb-spc] day${day} failed: ${errorMessage}`);
		return {
			...plan.entry,
			messagePreview: null,
			validationFailures,
			debugMessages: dedupeStrings([plan.intent.reason, ...validationFailures, errorMessage]),
			error: errorMessage,
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
