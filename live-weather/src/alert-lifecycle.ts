import type {
	Env,
	AlertChangeType,
	AlertChangeRecord,
	AlertLifecycleSnapshotEntry,
	AlertLifecycleSnapshot,
	AlertLifecycleDiffResult,
	AlertHistorySnapshotCounts,
	AlertHistoryDaySnapshot,
	AlertHistoryEntry,
	AlertHistoryDayRecord,
	AlertHistoryByDay,
} from './types';
import {
	KV_ALERT_LIFECYCLE_SNAPSHOT,
	KV_ALERT_CHANGES,
	KV_ALERT_HISTORY_DAILY,
	ALERT_HISTORY_RETENTION_DAYS,
} from './constants';
import {
	dedupeStrings,
	normalizeStateCode,
	extractStateCodes,
	extractCountyFipsCodes,
	extractCountyFipsCodesForState,
	classifyAlertCategoryFromEvent,
	deriveAlertImpactCategories,
	isMajorImpactAlertEvent,
	normalizeCountyFips,
	stateCodeDisplayName,
} from './utils';
import { centroidFromGeometry } from './geo-utils';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function normalizeLatitude(input: unknown): number | null {
	const value = Number(input);
	if (!Number.isFinite(value) || value < -90 || value > 90) return null;
	return Number(value.toFixed(4));
}

function normalizeLongitude(input: unknown): number | null {
	const value = Number(input);
	if (!Number.isFinite(value) || value < -180 || value > 180) return null;
	return Number(value.toFixed(4));
}

function normalizeIsoTimestamp(value: unknown): string {
	const text = String(value || '').trim();
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) return '';
	return new Date(parsed).toISOString();
}

function normalizeAlertLifecycleSnapshotEntry(value: unknown): AlertLifecycleSnapshotEntry | null {
	const entry = value as Record<string, unknown> | null;
	if (!entry || typeof entry !== 'object') return null;

	const alertId = String(entry.alertId || '').trim();
	if (!alertId) return null;

	const stateCodes = Array.isArray(entry.stateCodes)
		? dedupeStrings(entry.stateCodes.map((state) => String(state).trim().toUpperCase())).sort()
		: [];
	const countyCodes = Array.isArray(entry.countyCodes)
		? dedupeStrings(
			entry.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];

	const normalizedLastChangeType = String(entry.lastChangeType || '').trim().toLowerCase();
	const lastChangeType =
		normalizedLastChangeType === 'new'
		|| normalizedLastChangeType === 'updated'
		|| normalizedLastChangeType === 'extended'
			? normalizedLastChangeType
			: null;

	const lastChangedAt = normalizeIsoTimestamp(entry.lastChangedAt);

	return {
		alertId,
		stateCodes,
		countyCodes,
		event: String(entry.event || ''),
		areaDesc: String(entry.areaDesc || ''),
		lat: normalizeLatitude(entry.lat),
		lon: normalizeLongitude(entry.lon),
		headline: String(entry.headline || ''),
		description: String(entry.description || ''),
		instruction: String(entry.instruction || ''),
		severity: String(entry.severity || ''),
		urgency: String(entry.urgency || ''),
		certainty: String(entry.certainty || ''),
		updated: String(entry.updated || ''),
		expires: String(entry.expires || ''),
		lastChangeType,
		lastChangedAt: lastChangedAt || null,
	};
}

export async function readAlertLifecycleSnapshot(env: Env): Promise<AlertLifecycleSnapshot | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_LIFECYCLE_SNAPSHOT);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const snapshot: AlertLifecycleSnapshot = {};
		for (const [alertId, value] of Object.entries(parsed as Record<string, unknown>)) {
			const normalized = normalizeAlertLifecycleSnapshotEntry(value);
			if (!normalized) continue;
			snapshot[String(alertId)] = normalized;
		}
		return snapshot;
	} catch {
		return null;
	}
}

async function writeAlertLifecycleSnapshot(env: Env, snapshot: AlertLifecycleSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_LIFECYCLE_SNAPSHOT, JSON.stringify(snapshot));
}

function normalizeAlertChangeType(value: unknown): AlertChangeType | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'new'
		|| normalized === 'updated'
		|| normalized === 'extended'
		|| normalized === 'expired'
		|| normalized === 'all_clear'
	) {
		return normalized;
	}
	return null;
}

export function normalizeAlertChangeRecord(value: unknown): AlertChangeRecord | null {
	const record = value as Record<string, unknown> | null;
	if (!record || typeof record !== 'object') return null;

	const changeType = normalizeAlertChangeType(record.changeType);
	const alertId = String(record.alertId || '').trim();
	const changedAt = normalizeIsoTimestamp(record.changedAt);
	if (!changeType || !alertId || !changedAt) return null;

	const stateCodes = Array.isArray(record.stateCodes)
		? dedupeStrings(
			record.stateCodes
				.map((stateCode) => normalizeStateCode(stateCode))
				.filter((stateCode): stateCode is string => !!stateCode),
		).sort()
		: [];
	const countyCodes = Array.isArray(record.countyCodes)
		? dedupeStrings(
			record.countyCodes
				.map((countyCode) =>
					String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3),
				)
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];

	return {
		alertId,
		stateCodes,
		countyCodes,
		event: String(record.event || ''),
		areaDesc: String(record.areaDesc || ''),
		lat: normalizeLatitude(record.lat),
		lon: normalizeLongitude(record.lon),
		changedAt,
		changeType,
		severity: String(record.severity || '').trim() || null,
		category: String(record.category || '').trim() || null,
		isMajor: record.isMajor === true,
		previousExpires: record.previousExpires ? String(record.previousExpires) : null,
		nextExpires: record.nextExpires ? String(record.nextExpires) : null,
	};
}

export async function readAlertChangeRecords(env: Env): Promise<AlertChangeRecord[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_CHANGES);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((record) => normalizeAlertChangeRecord(record))
			.filter((record): record is AlertChangeRecord => !!record)
			.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
	} catch {
		return [];
	}
}

async function appendAlertChangeRecords(env: Env, changes: AlertChangeRecord[]): Promise<void> {
	if (changes.length === 0) return;
	const existing = await readAlertChangeRecords(env);
	const merged = [...changes, ...existing];
	const deduped = new Map<string, AlertChangeRecord>();
	for (const record of merged) {
		const key = `${record.alertId}|${record.changeType}|${record.changedAt}`;
		if (!deduped.has(key)) {
			deduped.set(key, record);
		}
	}
	const sorted = Array.from(deduped.values()).sort(
		(a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
	);
	const retentionWindowMs = 7 * 24 * 60 * 60 * 1000;
	const nowMs = Date.now();
	const trimmed = sorted
		.filter((record) => {
			const changedAtMs = Date.parse(record.changedAt);
			if (!Number.isFinite(changedAtMs)) return false;
			return nowMs - changedAtMs <= retentionWindowMs;
		})
		.slice(0, 1200);
	await env.WEATHER_KV.put(KV_ALERT_CHANGES, JSON.stringify(trimmed));
}

function dayKeyFromTimestampMs(timestampMs: number): string {
	return new Date(timestampMs).toISOString().slice(0, 10);
}

function dayKeyFromIso(value: string): string | null {
	const parsed = Date.parse(String(value || '').trim());
	if (!Number.isFinite(parsed)) return null;
	return dayKeyFromTimestampMs(parsed);
}

function normalizeAlertHistorySnapshotCount(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function createEmptyAlertHistorySnapshotCounts(): AlertHistorySnapshotCounts {
	return {
		activeAlertCount: 0,
		activeWarningCount: 0,
		activeMajorCount: 0,
	};
}

export function normalizeAlertHistorySnapshotCounts(value: unknown): AlertHistorySnapshotCounts {
	const counts = value as Record<string, unknown> | null;
	return {
		activeAlertCount: normalizeAlertHistorySnapshotCount(counts?.activeAlertCount),
		activeWarningCount: normalizeAlertHistorySnapshotCount(counts?.activeWarningCount),
		activeMajorCount: normalizeAlertHistorySnapshotCount(counts?.activeMajorCount),
	};
}

function addAlertHistorySnapshotCounts(
	target: AlertHistorySnapshotCounts,
	source: AlertHistorySnapshotCounts,
): void {
	target.activeAlertCount += source.activeAlertCount;
	target.activeWarningCount += source.activeWarningCount;
	target.activeMajorCount += source.activeMajorCount;
}

function buildStateCountySnapshotKey(stateCode: string, countyCode: string): string {
	return `${stateCode}:${countyCode}`;
}

function parseStateCountySnapshotKey(
	value: unknown,
): { stateCode: string; countyCode: string } | null {
	const raw = String(value || '').trim().toUpperCase();
	if (!raw) return null;

	const splitMatch = raw.match(/^([A-Z]{2})[:|](\d{3})$/);
	if (splitMatch) {
		const stateCode = normalizeStateCode(splitMatch[1]);
		const countyCode = normalizeCountyFips(splitMatch[2]);
		if (!stateCode || !countyCode) return null;
		return { stateCode, countyCode };
	}

	const compactMatch = raw.match(/^([A-Z]{2})(\d{3})$/);
	if (!compactMatch) return null;
	const stateCode = normalizeStateCode(compactMatch[1]);
	const countyCode = normalizeCountyFips(compactMatch[2]);
	if (!stateCode || !countyCode) return null;
	return { stateCode, countyCode };
}

function normalizeAlertHistoryDaySnapshot(value: unknown): AlertHistoryDaySnapshot {
	const snapshot = value as Record<string, unknown> | null;
	const byStateRaw = snapshot?.byState as Record<string, unknown> | undefined;
	const byState: AlertHistoryDaySnapshot['byState'] = {};
	if (byStateRaw && typeof byStateRaw === 'object') {
		for (const [stateCode, stateValue] of Object.entries(byStateRaw)) {
			const normalizedStateCode = normalizeStateCode(stateCode);
			if (!normalizedStateCode) continue;
			byState[normalizedStateCode] = normalizeAlertHistorySnapshotCounts(stateValue);
		}
	}

	const byStateCountyRaw = snapshot?.byStateCounty as Record<string, unknown> | undefined;
	const byStateCounty: Record<string, AlertHistorySnapshotCounts> = {};
	if (byStateCountyRaw && typeof byStateCountyRaw === 'object') {
		for (const [stateCountyKey, stateCountyValue] of Object.entries(byStateCountyRaw)) {
			const parsedKey = parseStateCountySnapshotKey(stateCountyKey);
			if (!parsedKey) continue;
			byStateCounty[
				buildStateCountySnapshotKey(parsedKey.stateCode, parsedKey.countyCode)
			] = normalizeAlertHistorySnapshotCounts(stateCountyValue);
		}
	}

	const rootCounts = normalizeAlertHistorySnapshotCounts(snapshot);
	return {
		activeAlertCount: rootCounts.activeAlertCount,
		activeWarningCount: rootCounts.activeWarningCount,
		activeMajorCount: rootCounts.activeMajorCount,
		byState,
		byStateCounty,
	};
}

function createHistoryDaySnapshotFromMap(map: Record<string, any>): AlertHistoryDaySnapshot {
	let activeAlertCount = 0;
	let activeWarningCount = 0;
	let activeMajorCount = 0;
	const byState: AlertHistoryDaySnapshot['byState'] = {};
	const byStateCounty: Record<string, AlertHistorySnapshotCounts> = {};

	for (const feature of Object.values(map)) {
		activeAlertCount += 1;
		const properties = feature?.properties ?? {};
		const event = String(properties.event || '');
		const severity = String(properties.severity || '');
		const headline = String(properties.headline || '');
		const description = String(properties.description || '');
		const category = classifyAlertCategoryFromEvent(event);
		const stateCodes = extractStateCodes(feature);
		const countyCodesByState = new Map<string, string[]>();
		for (const stateCode of stateCodes) {
			const countyCodesForState = extractCountyFipsCodesForState(feature, stateCode);
			countyCodesByState.set(stateCode, countyCodesForState);
			if (!byState[stateCode]) {
				byState[stateCode] = createEmptyAlertHistorySnapshotCounts();
			}
			byState[stateCode].activeAlertCount += 1;
			for (const countyCode of countyCodesForState) {
				const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
				if (!byStateCounty[stateCountyKey]) {
					byStateCounty[stateCountyKey] = createEmptyAlertHistorySnapshotCounts();
				}
				byStateCounty[stateCountyKey].activeAlertCount += 1;
			}
		}

		if (category === 'warning') {
			activeWarningCount += 1;
			for (const stateCode of stateCodes) {
				if (byState[stateCode]) {
					byState[stateCode].activeWarningCount += 1;
				}
			}
			for (const stateCode of stateCodes) {
				const countyCodesForState = countyCodesByState.get(stateCode) || [];
				for (const countyCode of countyCodesForState) {
					const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
					if (byStateCounty[stateCountyKey]) {
						byStateCounty[stateCountyKey].activeWarningCount += 1;
					}
				}
			}
		}
		const impactCategories = deriveAlertImpactCategories(event, headline, description);
		if (isMajorImpactAlertEvent(event, severity, impactCategories)) {
			activeMajorCount += 1;
			for (const stateCode of stateCodes) {
				if (byState[stateCode]) {
					byState[stateCode].activeMajorCount += 1;
				}
			}
			for (const stateCode of stateCodes) {
				const countyCodesForState = countyCodesByState.get(stateCode) || [];
				for (const countyCode of countyCodesForState) {
					const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
					if (byStateCounty[stateCountyKey]) {
						byStateCounty[stateCountyKey].activeMajorCount += 1;
					}
				}
			}
		}
	}

	return {
		activeAlertCount,
		activeWarningCount,
		activeMajorCount,
		byState,
		byStateCounty,
	};
}

function buildAlertHistoryEntrySummary(change: AlertChangeRecord): string {
	const eventLabel = String(change.event || 'Weather alert').trim() || 'Weather alert';
	const areaLabel = String(change.areaDesc || '').trim();
	const placeLabel = areaLabel || 'the selected area';

	if (change.changeType === 'new') {
		return `${eventLabel} was newly issued for ${placeLabel}.`;
	}
	if (change.changeType === 'updated') {
		return `${eventLabel} was updated for ${placeLabel}.`;
	}
	if (change.changeType === 'extended') {
		return `${eventLabel} was extended for ${placeLabel}.`;
	}
	if (change.changeType === 'expired') {
		return `${eventLabel} expired for ${placeLabel}.`;
	}
	return `All clear conditions were recorded for ${placeLabel}.`;
}

function normalizeAlertHistoryEntry(value: unknown): AlertHistoryEntry | null {
	const entry = value as Record<string, unknown> | null;
	if (!entry || typeof entry !== 'object') return null;

	const alertId = String(entry.alertId || '').trim();
	const changedAt = normalizeIsoTimestamp(entry.changedAt);
	const changeType = normalizeAlertChangeType(entry.changeType);
	if (!alertId || !changedAt || !changeType) return null;

	const event = String(entry.event || '').trim() || 'Weather Alert';
	const categoryRaw = String(entry.category || '').trim().toLowerCase();
	const category = categoryRaw || classifyAlertCategoryFromEvent(event);
	const severity = String(entry.severity || '').trim();
	const impactCategories = deriveAlertImpactCategories(
		event,
		String(entry.summary || ''),
		String(entry.areaDesc || ''),
	);
	const isMajor =
		entry.isMajor === true
		|| isMajorImpactAlertEvent(event, severity, impactCategories);
	const stateCodes = Array.isArray(entry.stateCodes)
		? dedupeStrings(
			entry.stateCodes
				.map((stateCode) => normalizeStateCode(stateCode))
				.filter((stateCode): stateCode is string => !!stateCode),
		).sort()
		: [];
	const countyCodes = Array.isArray(entry.countyCodes)
		? dedupeStrings(
			entry.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];
	const summary = String(entry.summary || '').trim() || buildAlertHistoryEntrySummary({
		alertId,
		stateCodes,
		countyCodes,
		event,
		areaDesc: String(entry.areaDesc || ''),
		changedAt,
		changeType,
		severity: severity || null,
		category,
		isMajor,
		previousExpires: entry.previousExpires ? String(entry.previousExpires) : null,
		nextExpires: entry.nextExpires ? String(entry.nextExpires) : null,
	});

	return {
		alertId,
		stateCodes,
		countyCodes,
		event,
		areaDesc: String(entry.areaDesc || ''),
		changedAt,
		changeType,
		severity: severity || 'Unknown',
		category,
		isMajor,
		summary,
		previousExpires: entry.previousExpires ? String(entry.previousExpires) : null,
		nextExpires: entry.nextExpires ? String(entry.nextExpires) : null,
	};
}

export function normalizeAlertHistoryDayRecord(value: unknown): AlertHistoryDayRecord | null {
	const record = value as Record<string, unknown> | null;
	if (!record || typeof record !== 'object') return null;

	const day = String(record.day || '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
	const dayMs = Date.parse(`${day}T00:00:00.000Z`);
	if (!Number.isFinite(dayMs)) return null;

	const updatedAt = normalizeIsoTimestamp(record.updatedAt) || new Date().toISOString();
	const snapshot = normalizeAlertHistoryDaySnapshot(record.snapshot);
	const entries = Array.isArray(record.entries)
		? record.entries
			.map((entry) => normalizeAlertHistoryEntry(entry))
			.filter((entry): entry is AlertHistoryEntry => !!entry)
			.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
		: [];

	return {
		day,
		updatedAt,
		snapshot,
		entries,
	};
}

export async function readAlertHistoryByDay(env: Env): Promise<AlertHistoryByDay> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_HISTORY_DAILY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const records: AlertHistoryByDay = {};
		for (const value of Object.values(parsed as Record<string, unknown>)) {
			const normalized = normalizeAlertHistoryDayRecord(value);
			if (!normalized) continue;
			records[normalized.day] = normalized;
		}
		return records;
	} catch {
		return {};
	}
}

async function writeAlertHistoryByDay(env: Env, historyByDay: AlertHistoryByDay): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_HISTORY_DAILY, JSON.stringify(historyByDay));
}

export function readAlertHistorySnapshotCountsByCounty(
	snapshot: AlertHistoryDaySnapshot,
	countyCodeInput: string,
	stateCodeInput?: string | null,
): AlertHistorySnapshotCounts | null {
	const countyCode = normalizeCountyFips(countyCodeInput);
	if (!countyCode) return null;
	const stateCode = normalizeStateCode(stateCodeInput || '');
	const byStateCounty = snapshot.byStateCounty || {};

	if (stateCode) {
		const directMatch = byStateCounty[buildStateCountySnapshotKey(stateCode, countyCode)];
		return directMatch ? normalizeAlertHistorySnapshotCounts(directMatch) : null;
	}

	let matched = false;
	const totals = createEmptyAlertHistorySnapshotCounts();
	for (const [key, value] of Object.entries(byStateCounty)) {
		const parsedKey = parseStateCountySnapshotKey(key);
		if (!parsedKey || parsedKey.countyCode !== countyCode) continue;
		matched = true;
		addAlertHistorySnapshotCounts(
			totals,
			normalizeAlertHistorySnapshotCounts(value),
		);
	}
	return matched ? totals : null;
}

export function summarizeAlertHistoryEntriesAsSnapshot(
	entries: AlertHistoryEntry[],
): AlertHistorySnapshotCounts {
	const latestByAlertId = new Map<string, AlertHistoryEntry>();
	for (const entry of entries) {
		const alertId = String(entry.alertId || '').trim();
		if (!alertId || alertId.toLowerCase().startsWith('all-clear:')) continue;
		const existing = latestByAlertId.get(alertId);
		const changedAtMs = Date.parse(entry.changedAt);
		const existingChangedAtMs = existing ? Date.parse(existing.changedAt) : NaN;
		if (
			!existing
			|| (
				Number.isFinite(changedAtMs)
				&& (
					!Number.isFinite(existingChangedAtMs)
					|| changedAtMs > existingChangedAtMs
				)
			)
		) {
			latestByAlertId.set(alertId, entry);
		}
	}

	const counts = createEmptyAlertHistorySnapshotCounts();
	for (const entry of latestByAlertId.values()) {
		counts.activeAlertCount += 1;
		const category = String(entry.category || '').trim().toLowerCase()
			|| classifyAlertCategoryFromEvent(entry.event);
		if (category === 'warning') {
			counts.activeWarningCount += 1;
		}
		if (entry.isMajor === true) {
			counts.activeMajorCount += 1;
		}
	}
	return counts;
}

function pruneAlertHistoryByDay(
	historyByDay: AlertHistoryByDay,
	nowMs = Date.now(),
): AlertHistoryByDay {
	const retentionWindowMs = ALERT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const cutoffMs = nowMs - retentionWindowMs;
	const pruned: AlertHistoryByDay = {};
	for (const [day, record] of Object.entries(historyByDay)) {
		const dayMs = Date.parse(`${day}T00:00:00.000Z`);
		if (!Number.isFinite(dayMs)) continue;
		const dayEndsMs = dayMs + (24 * 60 * 60 * 1000);
		if (dayEndsMs < cutoffMs) continue;
		pruned[day] = record;
	}
	return pruned;
}

function createAlertHistoryEntryFromChange(change: AlertChangeRecord): AlertHistoryEntry {
	const event = String(change.event || '').trim() || 'Weather Alert';
	const category = String(change.category || '').trim().toLowerCase()
		|| classifyAlertCategoryFromEvent(event);
	const severity = String(change.severity || '').trim() || 'Unknown';
	const impactCategories = deriveAlertImpactCategories(event, '', '');
	const isMajor =
		change.isMajor === true
		|| isMajorImpactAlertEvent(event, severity, impactCategories);
	return {
		alertId: String(change.alertId || '').trim(),
		stateCodes: dedupeStrings(change.stateCodes.map((stateCode) => String(stateCode).trim().toUpperCase()))
			.filter((stateCode) => !!normalizeStateCode(stateCode))
			.sort(),
		countyCodes: dedupeStrings(
			change.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort(),
		event,
		areaDesc: String(change.areaDesc || ''),
		changedAt: normalizeIsoTimestamp(change.changedAt) || new Date().toISOString(),
		changeType: change.changeType,
		severity,
		category,
		isMajor,
		summary: buildAlertHistoryEntrySummary(change),
		previousExpires: change.previousExpires ?? null,
		nextExpires: change.nextExpires ?? null,
	};
}

export function buildNextAlertHistoryByDay(
	previousHistoryByDay: AlertHistoryByDay | null,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	nowIso = new Date().toISOString(),
): AlertHistoryByDay {
	const nextHistoryByDay: AlertHistoryByDay = {};
	for (const value of Object.values(previousHistoryByDay || {})) {
		const normalized = normalizeAlertHistoryDayRecord(value);
		if (!normalized) continue;
		nextHistoryByDay[normalized.day] = {
			...normalized,
			entries: [...normalized.entries],
		};
	}

	const nowDay = dayKeyFromIso(nowIso) || dayKeyFromTimestampMs(Date.now());
	const ensureDayRecord = (day: string): AlertHistoryDayRecord => {
		const existing = nextHistoryByDay[day];
		if (existing) {
			return existing;
		}
		const created: AlertHistoryDayRecord = {
			day,
			updatedAt: nowIso,
			snapshot: {
				activeAlertCount: 0,
				activeWarningCount: 0,
				activeMajorCount: 0,
				byState: {},
				byStateCounty: {},
			},
			entries: [],
		};
		nextHistoryByDay[day] = created;
		return created;
	};

	const todayRecord = ensureDayRecord(nowDay);
	todayRecord.snapshot = createHistoryDaySnapshotFromMap(map);
	todayRecord.updatedAt = nowIso;

	for (const change of changes) {
		const normalizedChange = normalizeAlertChangeRecord(change);
		if (!normalizedChange) continue;
		const day = dayKeyFromIso(normalizedChange.changedAt) || nowDay;
		const dayRecord = ensureDayRecord(day);
		const nextEntry = createAlertHistoryEntryFromChange(normalizedChange);
		const nextEntryKey = `${nextEntry.alertId}|${nextEntry.changeType}|${nextEntry.changedAt}`;
		const existingKeys = new Set(
			dayRecord.entries.map((entry) => `${entry.alertId}|${entry.changeType}|${entry.changedAt}`),
		);
		if (!existingKeys.has(nextEntryKey)) {
			dayRecord.entries.push(nextEntry);
		}
		dayRecord.entries.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
		if (dayRecord.entries.length > 500) {
			dayRecord.entries = dayRecord.entries.slice(0, 500);
		}
		dayRecord.updatedAt = nowIso;
	}

	return pruneAlertHistoryByDay(nextHistoryByDay, Date.parse(nowIso));
}

export async function syncAlertHistoryDailySnapshots(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
): Promise<AlertHistoryByDay> {
	const previousHistoryByDay = await readAlertHistoryByDay(env);
	const nextHistoryByDay = buildNextAlertHistoryByDay(previousHistoryByDay, map, changes);
	await writeAlertHistoryByDay(env, nextHistoryByDay);
	return nextHistoryByDay;
}

function createLifecycleSnapshotEntry(
	alertId: string,
	feature: any,
	previousEntry?: AlertLifecycleSnapshotEntry | null,
): AlertLifecycleSnapshotEntry {
	const properties = feature?.properties ?? {};
	const location = centroidFromGeometry(feature);
	return {
		alertId,
		stateCodes: dedupeStrings(extractStateCodes(feature)).sort(),
		countyCodes: extractCountyFipsCodes(feature),
		event: String(properties.event || ''),
		areaDesc: String(properties.areaDesc || ''),
		lat: normalizeLatitude(location.lat),
		lon: normalizeLongitude(location.lon),
		headline: String(properties.headline || ''),
		description: String(properties.description || ''),
		instruction: String(properties.instruction || ''),
		severity: String(properties.severity || ''),
		urgency: String(properties.urgency || ''),
		certainty: String(properties.certainty || ''),
		updated: String(properties.updated || ''),
		expires: String(properties.expires || ''),
		lastChangeType: previousEntry?.lastChangeType || null,
		lastChangedAt: previousEntry?.lastChangedAt || null,
	};
}

export function parseTimeMs(value: string): number | null {
	const parsed = Date.parse(String(value || '').trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function hasAlertBeenUpdated(
	previousEntry: AlertLifecycleSnapshotEntry,
	currentEntry: AlertLifecycleSnapshotEntry,
): boolean {
	return (
		previousEntry.updated !== currentEntry.updated
		|| previousEntry.headline !== currentEntry.headline
		|| previousEntry.description !== currentEntry.description
		|| previousEntry.instruction !== currentEntry.instruction
		|| previousEntry.areaDesc !== currentEntry.areaDesc
		|| previousEntry.severity !== currentEntry.severity
		|| previousEntry.urgency !== currentEntry.urgency
		|| previousEntry.certainty !== currentEntry.certainty
	);
}

function hasAlertBeenExtended(
	previousEntry: AlertLifecycleSnapshotEntry,
	currentEntry: AlertLifecycleSnapshotEntry,
): boolean {
	const previousExpiresMs = parseTimeMs(previousEntry.expires);
	const currentExpiresMs = parseTimeMs(currentEntry.expires);
	if (previousExpiresMs === null || currentExpiresMs === null) return false;
	return currentExpiresMs - previousExpiresMs > 60_000;
}

function createAlertChangeRecord(
	entry: AlertLifecycleSnapshotEntry,
	changedAt: string,
	changeType: AlertChangeType,
	previousExpires?: string | null,
	nextExpires?: string | null,
): AlertChangeRecord {
	const category = classifyAlertCategoryFromEvent(entry.event || '');
	const impactCategories = deriveAlertImpactCategories(
		entry.event || '',
		entry.headline || '',
		entry.description || '',
	);
	return {
		alertId: entry.alertId,
		stateCodes: dedupeStrings(entry.stateCodes).sort(),
		countyCodes: dedupeStrings(entry.countyCodes).sort(),
		event: entry.event || 'Weather Alert',
		areaDesc: entry.areaDesc,
		lat: normalizeLatitude(entry.lat),
		lon: normalizeLongitude(entry.lon),
		changedAt,
		changeType,
		severity: entry.severity || null,
		category,
		isMajor: isMajorImpactAlertEvent(entry.event || '', entry.severity || '', impactCategories),
		previousExpires: previousExpires ?? null,
		nextExpires: nextExpires ?? null,
	};
}

function countActiveAlertsByState(snapshot: AlertLifecycleSnapshot): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of Object.values(snapshot)) {
		for (const stateCode of entry.stateCodes) {
			if (!counts[stateCode]) counts[stateCode] = 0;
			counts[stateCode] += 1;
		}
	}
	return counts;
}

export function diffAlertLifecycleSnapshots(
	currentMap: Record<string, any>,
	previousSnapshot: AlertLifecycleSnapshot | null,
): AlertLifecycleDiffResult {
	const changedAt = new Date().toISOString();
	const currentSnapshot: AlertLifecycleSnapshot = {};
	for (const [fallbackId, feature] of Object.entries(currentMap)) {
		const alertId = String((feature as any)?.id ?? fallbackId ?? '');
		if (!alertId) continue;
		const previousEntry = previousSnapshot?.[alertId] || null;
		currentSnapshot[alertId] = createLifecycleSnapshotEntry(alertId, feature, previousEntry);
	}

	if (!previousSnapshot) {
		return {
			currentSnapshot,
			changes: [],
			isInitialSnapshot: true,
		};
	}

	const changes: AlertChangeRecord[] = [];

	for (const [alertId, currentEntry] of Object.entries(currentSnapshot)) {
		const previousEntry = previousSnapshot[alertId];
		if (!previousEntry) {
			currentEntry.lastChangeType = 'new';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'new',
					null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		if (hasAlertBeenExtended(previousEntry, currentEntry)) {
			currentEntry.lastChangeType = 'extended';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'extended',
					previousEntry.expires || null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		if (hasAlertBeenUpdated(previousEntry, currentEntry)) {
			currentEntry.lastChangeType = 'updated';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'updated',
					previousEntry.expires || null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		currentEntry.lastChangeType = previousEntry.lastChangeType || null;
		currentEntry.lastChangedAt = previousEntry.lastChangedAt || null;
	}

	for (const [alertId, previousEntry] of Object.entries(previousSnapshot)) {
		if (currentSnapshot[alertId]) continue;
		changes.push(
			createAlertChangeRecord(
				previousEntry,
				changedAt,
				'expired',
				previousEntry.expires || null,
				null,
			),
		);
	}

	const previousCountsByState = countActiveAlertsByState(previousSnapshot);
	const currentCountsByState = countActiveAlertsByState(currentSnapshot);
	const stateCodes = dedupeStrings([
		...Object.keys(previousCountsByState),
		...Object.keys(currentCountsByState),
	]);

	for (const stateCode of stateCodes) {
		const previousCount = previousCountsByState[stateCode] || 0;
		const currentCount = currentCountsByState[stateCode] || 0;
		if (previousCount <= 0 || currentCount > 0) continue;
		changes.push({
			alertId: `all-clear:${stateCode}`,
			stateCodes: [stateCode],
			countyCodes: [],
			event: 'All Clear',
			areaDesc: stateCodeDisplayName(stateCode),
			changedAt,
			changeType: 'all_clear',
			severity: null,
			category: null,
			isMajor: true,
			previousExpires: null,
			nextExpires: null,
		});
	}

	return {
		currentSnapshot,
		changes,
		isInitialSnapshot: false,
	};
}

export function latestLifecycleStatusByAlertId(snapshot: AlertLifecycleSnapshot): Record<string, AlertChangeType | null> {
	const map: Record<string, AlertChangeType | null> = {};
	for (const [alertId, entry] of Object.entries(snapshot)) {
		map[alertId] = entry.lastChangeType || null;
	}
	return map;
}

export async function syncAlertLifecycleState(
	env: Env,
	map: Record<string, any>,
): Promise<AlertLifecycleDiffResult> {
	const previousSnapshot = await readAlertLifecycleSnapshot(env);
	const diffResult = diffAlertLifecycleSnapshots(map, previousSnapshot);
	await writeAlertLifecycleSnapshot(env, diffResult.currentSnapshot);
	if (!diffResult.isInitialSnapshot && diffResult.changes.length > 0) {
		await appendAlertChangeRecords(env, diffResult.changes);
	}
	return diffResult;
}
