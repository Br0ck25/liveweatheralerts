import type {
	Env,
	OperationalDiagnostics,
	PushFailureDiagnostic,
} from './types';
import {
	KV_ALERT_MAP,
	KV_ETAG,
	KV_LAST_POLL,
	KV_OPERATIONAL_DIAGNOSTICS,
	KV_PUSH_SUB_PREFIX,
	WEATHER_API,
	NWS_USER_AGENT,
	MAX_RECENT_PUSH_FAILURES,
	LOCAL_DEV_ALERT_REFRESH_MINUTES,
} from './constants';
import {
	normalizeStateCode,
	truncateText,
} from './utils';
import { syncAlertLifecycleState } from './alert-lifecycle';

// ---------------------------------------------------------------------------
// Alert map CRUD
// ---------------------------------------------------------------------------

export async function readAlertMap(env: Env): Promise<Record<string, any>> {
	const raw = await env.WEATHER_KV.get(KV_ALERT_MAP);
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, any>;
	} catch {
		return {};
	}
}

export async function writeAlertMap(env: Env, map: Record<string, any>): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_MAP, JSON.stringify(map));
}

// ---------------------------------------------------------------------------
// Operational diagnostics
// ---------------------------------------------------------------------------

function normalizeIsoOrNull(value: unknown): string | null {
	const text = String(value || '').trim();
	if (!text) return null;
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toISOString();
}

function parseNonNegativeNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function defaultOperationalDiagnostics(): OperationalDiagnostics {
	return {
		lastSyncAttemptAt: null,
		lastSuccessfulSyncAt: null,
		lastSyncError: null,
		lastKnownAlertCount: 0,
		lastStaleDataAt: null,
		lastStaleMinutes: null,
		invalidSubscriptionCount: 0,
		lastInvalidSubscriptionAt: null,
		lastInvalidSubscriptionReason: null,
		pushFailureCount: 0,
		recentPushFailures: [],
	};
}

function normalizePushFailureDiagnostic(value: unknown): PushFailureDiagnostic | null {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== 'object') return null;
	const at = normalizeIsoOrNull(input.at);
	const stateCode = normalizeStateCode(input.stateCode) || String(input.stateCode || '').trim().toUpperCase();
	const message = String(input.message || '').trim();
	if (!at || !stateCode || !message) return null;
	const statusNumber = Number(input.status);
	const status = Number.isFinite(statusNumber) ? statusNumber : undefined;
	const subscriptionId = String(input.subscriptionId || '').trim() || null;
	return {
		at,
		stateCode,
		status,
		subscriptionId,
		message: truncateText(message, 240),
	};
}

function normalizeOperationalDiagnostics(value: unknown): OperationalDiagnostics {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== 'object') {
		return defaultOperationalDiagnostics();
	}

	const recentPushFailuresRaw = Array.isArray(input.recentPushFailures)
		? input.recentPushFailures
		: [];
	const recentPushFailures = recentPushFailuresRaw
		.map((item) => normalizePushFailureDiagnostic(item))
		.filter((item): item is PushFailureDiagnostic => !!item)
		.slice(0, MAX_RECENT_PUSH_FAILURES);

	return {
		lastSyncAttemptAt: normalizeIsoOrNull(input.lastSyncAttemptAt),
		lastSuccessfulSyncAt: normalizeIsoOrNull(input.lastSuccessfulSyncAt),
		lastSyncError: String(input.lastSyncError || '').trim() || null,
		lastKnownAlertCount: parseNonNegativeNumber(input.lastKnownAlertCount),
		lastStaleDataAt: normalizeIsoOrNull(input.lastStaleDataAt),
		lastStaleMinutes: Number.isFinite(Number(input.lastStaleMinutes))
			? parseNonNegativeNumber(input.lastStaleMinutes)
			: null,
		invalidSubscriptionCount: parseNonNegativeNumber(input.invalidSubscriptionCount),
		lastInvalidSubscriptionAt: normalizeIsoOrNull(input.lastInvalidSubscriptionAt),
		lastInvalidSubscriptionReason:
			String(input.lastInvalidSubscriptionReason || '').trim() || null,
		pushFailureCount: parseNonNegativeNumber(input.pushFailureCount),
		recentPushFailures,
	};
}

export async function readOperationalDiagnostics(env: Env): Promise<OperationalDiagnostics> {
	try {
		const raw = await env.WEATHER_KV.get(KV_OPERATIONAL_DIAGNOSTICS);
		if (!raw) return defaultOperationalDiagnostics();
		const parsed = JSON.parse(raw) as unknown;
		return normalizeOperationalDiagnostics(parsed);
	} catch {
		return defaultOperationalDiagnostics();
	}
}

export async function writeOperationalDiagnostics(
	env: Env,
	diagnostics: OperationalDiagnostics,
): Promise<void> {
	await env.WEATHER_KV.put(
		KV_OPERATIONAL_DIAGNOSTICS,
		JSON.stringify(normalizeOperationalDiagnostics(diagnostics)),
	);
}

export async function updateOperationalDiagnostics(
	env: Env,
	updater: (current: OperationalDiagnostics) => OperationalDiagnostics,
): Promise<OperationalDiagnostics> {
	const current = await readOperationalDiagnostics(env);
	const next = normalizeOperationalDiagnostics(updater(current));
	await writeOperationalDiagnostics(env, next);
	return next;
}

async function recordSyncAttempt(env: Env): Promise<void> {
	const nowIso = new Date().toISOString();
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncAttemptAt: nowIso,
	}));
}

async function recordSyncSuccess(env: Env, activeAlertCount: number): Promise<void> {
	const nowIso = new Date().toISOString();
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncAttemptAt: nowIso,
		lastSuccessfulSyncAt: nowIso,
		lastSyncError: null,
		lastKnownAlertCount: Math.max(0, Math.floor(activeAlertCount)),
	}));
}

async function recordSyncFailure(env: Env, message: string): Promise<void> {
	const trimmed = truncateText(String(message || 'Unknown sync failure.'), 240);
	console.error(`[ops] sync failure: ${trimmed}`);
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncError: trimmed,
	}));
}

export async function recordStaleDataCondition(
	env: Env,
	staleMinutes: number,
	reason: string,
): Promise<void> {
	if (!Number.isFinite(staleMinutes) || staleMinutes < 15) return;
	const nowMs = Date.now();
	await updateOperationalDiagnostics(env, (current) => {
		const previousAt = current.lastStaleDataAt ? Date.parse(current.lastStaleDataAt) : Number.NaN;
		const previousMinutes = current.lastStaleMinutes ?? -1;
		const withinCooldown = Number.isFinite(previousAt) && (nowMs - previousAt) < 10 * 60 * 1000;
		if (withinCooldown && previousMinutes === Math.floor(staleMinutes)) {
			return current;
		}
		console.warn(
			`[ops] stale-data condition minutes=${Math.floor(staleMinutes)} reason=${truncateText(reason, 120)}`,
		);
		return {
			...current,
			lastStaleDataAt: new Date(nowMs).toISOString(),
			lastStaleMinutes: Math.floor(staleMinutes),
		};
	});
}

export async function recordInvalidSubscription(env: Env, reason: string): Promise<void> {
	const nowIso = new Date().toISOString();
	const normalizedReason = truncateText(String(reason || 'invalid_subscription'), 180);
	console.warn(`[ops] invalid subscription: ${normalizedReason}`);
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		invalidSubscriptionCount: current.invalidSubscriptionCount + 1,
		lastInvalidSubscriptionAt: nowIso,
		lastInvalidSubscriptionReason: normalizedReason,
	}));
}

export async function recordPushDeliveryFailure(
	env: Env,
	input: {
		stateCode: string;
		subscriptionId?: string;
		status?: number;
		message: string;
	},
): Promise<void> {
	const stateCode = normalizeStateCode(input.stateCode) || String(input.stateCode || '').trim().toUpperCase() || 'US';
	const status = Number.isFinite(Number(input.status)) ? Number(input.status) : undefined;
	const message = truncateText(String(input.message || 'Push delivery failed.'), 240);
	console.warn(
		`[ops] push delivery failure state=${stateCode}${status ? ` status=${status}` : ''} msg=${message}`,
	);
	await updateOperationalDiagnostics(env, (current) => {
		const nextFailure: PushFailureDiagnostic = {
			at: new Date().toISOString(),
			stateCode,
			status,
			subscriptionId: input.subscriptionId || null,
			message,
		};
		return {
			...current,
			pushFailureCount: current.pushFailureCount + 1,
			recentPushFailures: [
				nextFailure,
				...current.recentPushFailures,
			].slice(0, MAX_RECENT_PUSH_FAILURES),
		};
	});
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export function staleMinutesFromLastPoll(lastPoll: string | null): number {
	const lastPollMs = lastPoll ? Date.parse(lastPoll) : Number.NaN;
	if (!Number.isFinite(lastPollMs)) return 0;
	return Math.max(0, Math.floor((Date.now() - lastPollMs) / 60_000));
}

export function isLocalDevRequest(request: Request): boolean {
	try {
		const { hostname } = new URL(request.url);
		return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
	} catch {
		return false;
	}
}

export function shouldAutoRefreshStaleAlertsInLocalDev(
	request: Request,
	lastPoll: string | null,
): boolean {
	if (!isLocalDevRequest(request)) return false;
	return staleMinutesFromLastPoll(lastPoll) >= LOCAL_DEV_ALERT_REFRESH_MINUTES;
}

export async function countPushSubscriptionRecords(env: Env): Promise<number> {
	let count = 0;
	let cursor: string | undefined;
	do {
		const page = await env.WEATHER_KV.list({
			prefix: KV_PUSH_SUB_PREFIX,
			limit: 1000,
			cursor,
		});
		count += page.keys.length;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return count;
}

// ---------------------------------------------------------------------------
// Alert pruning / suppression
// ---------------------------------------------------------------------------

export function pruneExpired(map: Record<string, any>): Record<string, any> {
	const now = Date.now();
	const pruned: Record<string, any> = {};
	for (const [id, feature] of Object.entries(map)) {
		const expiry = feature?.properties?.ends ?? feature?.properties?.expires;
		if (expiry) {
			const ms = new Date(expiry).getTime();
			if (!Number.isNaN(ms) && ms < now) continue;
		}
		pruned[id] = feature;
	}
	return pruned;
}

export function shouldSuppressAlertFromUi(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const event = String(properties.event || '').trim();
	const status = String(properties.status || '').trim();
	const combinedText = [
		event,
		properties.headline,
		properties.description,
		properties.instruction,
	]
		.map((value) => String(value || '').toLowerCase())
		.join(' ');

	if (/\btest message\b/i.test(event)) return true;
	if (/\btest\b/i.test(status)) return true;
	if (/monitoring message only\.\s*please disregard\./i.test(combinedText)) return true;
	return false;
}

function filterSuppressedAlertsFromMap(map: Record<string, any>): Record<string, any> {
	const filtered: Record<string, any> = {};
	for (const [id, feature] of Object.entries(map || {})) {
		if (shouldSuppressAlertFromUi(feature)) continue;
		filtered[id] = feature;
	}
	return filtered;
}

// ---------------------------------------------------------------------------
// NWS polling
// ---------------------------------------------------------------------------

async function pollNWS(env: Env): Promise<
	| { changed: false; error?: string }
	| { changed: true; features: any[]; etag: string }
> {
	const storedEtag = await env.WEATHER_KV.get(KV_ETAG);

	const headers: Record<string, string> = {
		'User-Agent': NWS_USER_AGENT,
		'Accept': 'application/geo+json',
	};
	if (storedEtag) {
		headers['If-None-Match'] = storedEtag;
	}

	let res: Response;
	try {
		res = await fetch(WEATHER_API, { headers });
	} catch (err) {
		return { changed: false, error: `Network error: ${String(err)}` };
	}

	if (res.status === 304) {
		return { changed: false };
	}

	if (!res.ok) {
		return { changed: false, error: `NWS API error: ${res.status} ${res.statusText}` };
	}

	let data: any;
	try {
		data = await res.json();
	} catch (err) {
		return { changed: false, error: `JSON parse error: ${String(err)}` };
	}

	const features = Array.isArray(data?.features) ? data.features : [];
	const etag = res.headers.get('ETag') ?? String(Date.now());

	return { changed: true, features, etag };
}

export async function syncAlerts(env: Env): Promise<{ map: Record<string, any>; error?: string }> {
	await recordSyncAttempt(env);
	const result = await pollNWS(env);

	if (!result.changed) {
		const map = filterSuppressedAlertsFromMap(pruneExpired(await readAlertMap(env)));
		await writeAlertMap(env, map);
		const syncError = (result as { error?: string }).error;
		if (syncError) {
			await recordSyncFailure(env, syncError);
			const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
			const staleMinutes = staleMinutesFromLastPoll(lastPoll ?? null);
			await recordStaleDataCondition(env, staleMinutes, 'sync_alerts_cached_fallback');
			return { map, error: syncError };
		}

		const nowIso = new Date().toISOString();
		await Promise.all([
			env.WEATHER_KV.put(KV_LAST_POLL, nowIso),
			recordSyncSuccess(env, Object.keys(map).length),
		]);
		return { map };
	}

	const map: Record<string, any> = {};
	for (const feature of result.features) {
		if (shouldSuppressAlertFromUi(feature)) continue;
		const id = String(feature?.id ?? feature?.properties?.id ?? '');
		if (id) map[id] = feature;
	}

	const pruned = pruneExpired(map);

	await Promise.all([
		writeAlertMap(env, pruned),
		env.WEATHER_KV.put(KV_ETAG, result.etag),
		env.WEATHER_KV.put(KV_LAST_POLL, new Date().toISOString()),
		recordSyncSuccess(env, Object.keys(pruned).length),
	]);

	return { map: pruned };
}

export { syncAlertLifecycleState };
