import metroAllowlistSeed from '../metro-allowlist.json';
import type { Env, FbAppConfig, FbAutoPostConfig, FbAutoPostMode, MetroAllowlistEntry, AlertChangeRecord, SpcRiskLevel } from '../types';
import {
	KV_FB_APP_CONFIG,
	KV_FB_AUTO_POST_CONFIG,
	FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD,
	FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES,
} from '../constants';
import { dedupeStrings, formatLastSynced, extractFullCountyFipsCodes } from '../utils';

function normalizeSpcRiskLevel(value: unknown): SpcRiskLevel {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'marginal' || normalized === 'slight' || normalized === 'enhanced' || normalized === 'moderate' || normalized === 'high') {
		return normalized as SpcRiskLevel;
	}
	return 'slight';
}

function normalizeSpcRiskLevelWithDefault(value: unknown, fallback: SpcRiskLevel): SpcRiskLevel {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'marginal' || normalized === 'slight' || normalized === 'enhanced' || normalized === 'moderate' || normalized === 'high') {
		return normalized as SpcRiskLevel;
	}
	return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	const rounded = Math.round(parsed);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

export async function readFbAppConfig(env: Env): Promise<FbAppConfig> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_APP_CONFIG);
		if (!raw) return {};
		return JSON.parse(raw) as FbAppConfig;
	} catch {
		return {};
	}
}

export async function writeFbAppConfig(env: Env, config: FbAppConfig): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_APP_CONFIG, JSON.stringify(config));
}

function normalizeFbAutoPostMode(value: unknown): FbAutoPostMode {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'tornado_only' || normalized === 'smart_high_impact') {
		return normalized;
	}
	return 'off';
}

export function normalizeFbAutoPostConfig(value: unknown): FbAutoPostConfig {
	if (typeof value === 'boolean') {
		const spcDay1CoverageEnabled = false;
		const spcDay1MinRiskLevel: SpcRiskLevel = 'slight';
		return {
			mode: value ? 'tornado_only' : 'off',
			updatedAt: null,
			digestCoverageEnabled: false,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD,
			digestMinCommentGapMinutes: FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES,
			llmCopyEnabled: false,
			startupCatchupEnabled: false,
			spcCoverageEnabled: spcDay1CoverageEnabled,
			spcMinRiskLevel: spcDay1MinRiskLevel,
			spcDay1CoverageEnabled,
			spcDay1MinRiskLevel,
			spcDay2CoverageEnabled: false,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: false,
			spcDay3MinRiskLevel: 'enhanced',
			spcHashtagsEnabled: true,
			spcLlmEnabled: false,
			spcTimingRefreshEnabled: true,
		};
	}
	const config = value as Record<string, unknown> | null;
	const updatedAtRaw = String(config?.updatedAt || '').trim();
	const updatedAtMs = Date.parse(updatedAtRaw);
	const legacyToggle = config?.tornadoWarningsEnabled === true;
	const mode = config?.mode != null
		? normalizeFbAutoPostMode(config.mode)
		: legacyToggle
			? 'tornado_only'
			: 'off';
	const legacySpcCoverageEnabled = config?.spcCoverageEnabled === true;
	const legacySpcMinRiskLevel = normalizeSpcRiskLevel(config?.spcMinRiskLevel);
	const spcDay1CoverageEnabled = config?.spcDay1CoverageEnabled != null
		? config.spcDay1CoverageEnabled === true
		: legacySpcCoverageEnabled;
	const spcDay1MinRiskLevel = config?.spcDay1MinRiskLevel != null
		? normalizeSpcRiskLevelWithDefault(config.spcDay1MinRiskLevel, 'slight')
		: legacySpcMinRiskLevel;
	const spcDay2CoverageEnabled = config?.spcDay2CoverageEnabled === true;
	const spcDay2MinRiskLevel = normalizeSpcRiskLevelWithDefault(config?.spcDay2MinRiskLevel, 'enhanced');
	const spcDay3CoverageEnabled = config?.spcDay3CoverageEnabled === true;
	const spcDay3MinRiskLevel = normalizeSpcRiskLevelWithDefault(config?.spcDay3MinRiskLevel, 'enhanced');
	return {
		mode,
		updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : null,
		digestCoverageEnabled: config?.digestCoverageEnabled === true,
		digestCommentUpdatesEnabled: config?.digestCommentUpdatesEnabled !== false,
		digestMaxCommentsPerThread: normalizePositiveInteger(
			config?.digestMaxCommentsPerThread,
			FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD,
			1,
			5,
		),
		digestMinCommentGapMinutes: normalizePositiveInteger(
			config?.digestMinCommentGapMinutes,
			FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES,
			10,
			60,
		),
		llmCopyEnabled: config?.llmCopyEnabled === true,
		startupCatchupEnabled: config?.startupCatchupEnabled === true,
		spcCoverageEnabled: spcDay1CoverageEnabled,
		spcMinRiskLevel: spcDay1MinRiskLevel,
		spcDay1CoverageEnabled,
		spcDay1MinRiskLevel,
		spcDay2CoverageEnabled,
		spcDay2MinRiskLevel,
		spcDay3CoverageEnabled,
		spcDay3MinRiskLevel,
		spcHashtagsEnabled: config?.spcHashtagsEnabled !== false,
		spcLlmEnabled: config?.spcLlmEnabled === true,
		spcTimingRefreshEnabled: config?.spcTimingRefreshEnabled !== false,
	};
}

export async function readFbAutoPostConfig(env: Env): Promise<FbAutoPostConfig> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_AUTO_POST_CONFIG);
		if (!raw) return normalizeFbAutoPostConfig(null);
		return normalizeFbAutoPostConfig(JSON.parse(raw));
	} catch {
		return normalizeFbAutoPostConfig(null);
	}
}

export async function writeFbAutoPostConfig(env: Env, config: FbAutoPostConfig): Promise<void> {
	await env.WEATHER_KV.put(
		KV_FB_AUTO_POST_CONFIG,
		JSON.stringify(normalizeFbAutoPostConfig(config)),
	);
}

export function fbAutoPostModeLabel(mode: FbAutoPostMode): string {
	if (mode === 'tornado_only') return 'Tornado-only';
	if (mode === 'smart_high_impact') return 'Smart high-impact';
	return 'Off';
}

export function fbAutoPostModeHelp(mode: FbAutoPostMode): string {
	if (mode === 'tornado_only') {
		return 'All active, timely Tornado Warnings auto-post and follow the existing Facebook thread/comment rules.';
	}
	if (mode === 'smart_high_impact') {
		return 'All active, timely Tornado Warnings auto-post. Severe Thunderstorm Warnings and Watches are storm-clustered, so one main post is created per metro/region and same-storm follow-ups become comments instead of duplicate posts. Otherwise Severe Thunderstorm Warnings need metro or 10 counties plus destructive, 70 mph, 2-inch hail, or strong wording. Fire warnings need wildfire or public safety escalation. Flood and winter warnings must pass the base impact gate.';
	}
	return 'Automatic Facebook posting is disabled.';
}

export function buildFbAutoPostStatusText(config?: FbAutoPostConfig | null): string {
	const normalized = normalizeFbAutoPostConfig(config);
	const savedText = normalized.updatedAt
		? `Saved ${formatLastSynced(normalized.updatedAt)}.`
		: 'Changes save immediately.';
	const digestCommentText = `Digest comments: ${normalized.digestCommentUpdatesEnabled !== false ? 'On' : 'Off'} (${normalizePositiveInteger(normalized.digestMaxCommentsPerThread, FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD, 1, 5)} max, ${normalizePositiveInteger(normalized.digestMinCommentGapMinutes, FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES, 10, 60)}m gap).`;
	const spcDay1Text = `D1 ${normalized.spcDay1CoverageEnabled ? 'On' : 'Off'} (${normalizeSpcRiskLevelWithDefault(normalized.spcDay1MinRiskLevel, 'slight')}+)`;
	const spcDay2Text = `D2 ${normalized.spcDay2CoverageEnabled ? 'On' : 'Off'} (${normalizeSpcRiskLevelWithDefault(normalized.spcDay2MinRiskLevel, 'enhanced')}+)`;
	const spcDay3Text = `D3 ${normalized.spcDay3CoverageEnabled ? 'On' : 'Off'} (${normalizeSpcRiskLevelWithDefault(normalized.spcDay3MinRiskLevel, 'enhanced')}+)`;
	const spcAiText = `SPC AI: ${normalized.spcLlmEnabled ? 'On' : 'Off'}.`;
	return `Mode: ${fbAutoPostModeLabel(normalized.mode)}. ${digestCommentText} SPC ${spcDay1Text}, ${spcDay2Text}, ${spcDay3Text}. ${spcAiText} ${savedText}`;
}

function normalizeMetroAllowlistEntry(value: unknown): MetroAllowlistEntry | null {
	const entry = value as Record<string, unknown> | null;
	if (!entry || typeof entry !== 'object') return null;
	const id = String(entry.id || '').trim();
	const name = String(entry.name || '').trim();
	const countyFips = Array.isArray(entry.countyFips)
		? dedupeStrings(
			entry.countyFips
				.map((code) => String(code || '').replace(/\D/g, ''))
				.filter((code) => /^\d{5}$/.test(code)),
		).sort()
		: [];
	if (!id || !name || countyFips.length === 0) return null;
	return { id, name, countyFips };
}

export const METRO_ALLOWLIST: MetroAllowlistEntry[] = Array.isArray(metroAllowlistSeed)
	? (metroAllowlistSeed as unknown[])
		.map((entry) => normalizeMetroAllowlistEntry(entry))
		.filter((entry): entry is MetroAllowlistEntry => !!entry)
	: [];

export const METRO_ALLOWLIST_RANK = new Map<string, number>();
export const METRO_ALLOWLIST_BY_COUNTY_FIPS = new Map<string, MetroAllowlistEntry[]>();
for (const [index, metro] of METRO_ALLOWLIST.entries()) {
	METRO_ALLOWLIST_RANK.set(metro.name, index);
	for (const countyFips of metro.countyFips) {
		const existing = METRO_ALLOWLIST_BY_COUNTY_FIPS.get(countyFips) || [];
		existing.push(metro);
		METRO_ALLOWLIST_BY_COUNTY_FIPS.set(countyFips, existing);
	}
}

// ---------------------------------------------------------------------------
// Event classifiers needed by threads (avoiding circular dependency)
// ---------------------------------------------------------------------------

export function isSevereThunderstormWarningEvent(event: string): boolean {
	return /\bsevere thunderstorm warning\b/i.test(String(event || '').trim());
}

export function isSevereThunderstormWatchEvent(event: string): boolean {
	return /\bsevere thunderstorm watch\b/i.test(String(event || '').trim());
}

export function isSevereWeatherFallbackEvent(event: string): boolean {
	return isSevereThunderstormWarningEvent(event) || isSevereThunderstormWatchEvent(event);
}

export function matchingMetroNamesForAlert(feature: any, change?: AlertChangeRecord | null): string[] {
	const names = new Set<string>();
	for (const countyFips of extractFullCountyFipsCodes(feature, change)) {
		for (const metro of METRO_ALLOWLIST_BY_COUNTY_FIPS.get(countyFips) || []) {
			names.add(metro.name);
		}
	}
	return Array.from(names).sort();
}

export function highestPriorityMetroRank(matchedMetroNames: string[]): number {
	let bestRank = Number.POSITIVE_INFINITY;
	for (const metroName of matchedMetroNames) {
		const metroRank = METRO_ALLOWLIST_RANK.get(metroName);
		if (metroRank != null) {
			bestRank = Math.min(bestRank, metroRank);
		}
	}
	return bestRank;
}
