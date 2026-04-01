import type {
	Env,
	AlertImpactCategory,
	AlertChangeType,
	AlertHistoryEntry,
	AlertHistoryDayRecord,
	AlertHistorySnapshotCounts,
	AlertHistoryDaySnapshot,
} from './types';
import {
	KV_LAST_POLL,
	PRIMARY_APP_ORIGIN,
	WWW_APP_ORIGIN,
	ALERT_HISTORY_MAX_QUERY_DAYS,
} from './constants';
import {
	normalizeStateCode,
	normalizeCountyFips,
	dedupeStrings,
	truncateText,
	extractStateCode,
	extractStateCodes,
	formatAlertDescription,
	classifyAlertCategoryFromEvent,
	deriveAlertImpactCategories,
	isMajorImpactAlertEvent,
	canonicalAlertDetailUrl,
} from './utils';
import { alertIntersectsRadius, centroidFromGeometry } from './geo-utils';
import {
	readAlertMap,
	syncAlerts,
	shouldAutoRefreshStaleAlertsInLocalDev,
	staleMinutesFromLastPoll,
	recordStaleDataCondition,
	readOperationalDiagnostics,
	countPushSubscriptionRecords,
	pruneExpired,
	recordInvalidSubscription,
	recordPushDeliveryFailure,
} from './nws';
import {
	readAlertLifecycleSnapshot,
	latestLifecycleStatusByAlertId,
	syncAlertLifecycleState,
	syncAlertHistoryDailySnapshots,
	normalizeAlertHistoryDayRecord,
	normalizeAlertHistorySnapshotCounts,
	readAlertHistoryByDay,
	readAlertChangeRecords,
	readAlertHistorySnapshotCountsByCounty,
	summarizeAlertHistoryEntriesAsSnapshot,
} from './alert-lifecycle';
import {
	getVapidKeys,
	isValidPushSubscription,
	normalizePushPreferences,
	removePushSubscriptionByEndpoint,
	upsertPushSubscriptionRecord,
	firstStateCodeFromPreferences,
} from './push/subscriptions';
import {
	buildTestPushMessageData,
	sendPushPayload,
} from './push/delivery';
import { getDebugSummaryBearerToken, hasDebugSummaryAccess } from './admin/auth';

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

export function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

export function apiCorsHeaders(origin?: string | null): Headers {
	const allowedOrigin = origin === PRIMARY_APP_ORIGIN ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

export function pushCorsHeaders(origin?: string | null): Headers {
	const allowedOrigin = origin === PRIMARY_APP_ORIGIN ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

export function debugCorsHeaders(origin?: string | null): Headers {
	const isAllowedOrigin = origin === PRIMARY_APP_ORIGIN || origin === WWW_APP_ORIGIN;
	const allowedOrigin = isAllowedOrigin ? origin : PRIMARY_APP_ORIGIN;
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

// ---------------------------------------------------------------------------
// Alert feature normalization
// ---------------------------------------------------------------------------

function compactAlertText(value: string): string {
	return String(value || '')
		.replace(/\r\n/g, '\n')
		.replace(/\s+/g, ' ')
		.trim();
}

function firstAlertSentence(value: string): string {
	const normalized = formatAlertDescription(String(value || ''));
	const lines = normalized
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const withoutLabel = line
			.replace(/^[A-Z][A-Z/\s]{2,40}:\s*/i, '')
			.replace(/^\*\s*/, '')
			.trim();
		if (withoutLabel) {
			return withoutLabel;
		}
	}

	return '';
}

function deriveAlertSummary(headline: string, description: string): string {
	const explicitHeadline = compactAlertText(headline);
	if (explicitHeadline) return truncateText(explicitHeadline, 220);
	const fromDescription = compactAlertText(firstAlertSentence(description));
	if (fromDescription) return truncateText(fromDescription, 220);
	return 'Review details for location and timing.';
}

function deriveInstructionsSummary(instruction: string, description: string): string {
	const explicitInstruction = compactAlertText(firstAlertSentence(instruction));
	if (explicitInstruction) return truncateText(explicitInstruction, 220);
	const fallback = compactAlertText(firstAlertSentence(description));
	if (fallback) return truncateText(fallback, 220);
	return '';
}

export function normalizeAlertFeature(
	feature: any,
	lifecycleByAlertId?: Record<string, AlertChangeType | null>,
) {
	const p = feature?.properties ?? {};
	const id = String(feature?.id ?? p.id ?? '');
	const event = String(p.event ?? '');
	const headline = String(p.headline ?? '');
	const description = String(p.description ?? '');
	const instruction = String(p.instruction ?? '');
	const location = centroidFromGeometry(feature);
	const lifecycleStatus = lifecycleByAlertId?.[id] || null;
	const impactCategories = deriveAlertImpactCategories(event, headline, description);
	const isMajor = isMajorImpactAlertEvent(event, String(p.severity ?? ''), impactCategories);
	return {
		id,
		stateCode: extractStateCode(feature),
		stateCodes: extractStateCodes(feature),
		category: classifyAlertCategoryFromEvent(event),
		impactCategories,
		isMajor,
		detailUrl: canonicalAlertDetailUrl(id),
		summary: deriveAlertSummary(headline, description),
		instructionsSummary: deriveInstructionsSummary(instruction, description),
		lifecycleStatus,
		lat: location.lat ?? null,
		lon: location.lon ?? null,
		event,
		areaDesc: String(p.areaDesc ?? ''),
		severity: String(p.severity ?? ''),
		status: String(p.status ?? ''),
		urgency: String(p.urgency ?? ''),
		certainty: String(p.certainty ?? ''),
		headline,
		description,
		instruction,
		sent: String(p.sent ?? ''),
		effective: String(p.effective ?? ''),
		onset: String(p.onset ?? ''),
		expires: String(p.expires ?? ''),
		updated: String(p.updated ?? ''),
		nwsUrl: String(p['@id'] ?? p.url ?? ''),
		ugc: Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [],
	};
}

export function buildAlertsMeta(input: {
	lastPoll: string | null;
	syncError?: string | null;
	count: number;
}) {
	const generatedAt = new Date().toISOString();
	const staleMinutes = staleMinutesFromLastPoll(input.lastPoll);
	return {
		lastPoll: input.lastPoll,
		generatedAt,
		syncError: input.syncError ?? null,
		stale: staleMinutes >= 15,
		staleMinutes,
		count: input.count,
	};
}

// ---------------------------------------------------------------------------
// Push notification handlers
// ---------------------------------------------------------------------------

export async function handlePushPublicKey(env: Env): Promise<Response> {
	const vapid = getVapidKeys(env);
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');
	if (!vapid) {
		return new Response(JSON.stringify({
			error: 'Push notifications are not configured on the server.',
		}), { status: 503, headers });
	}
	return new Response(JSON.stringify({
		publicKey: vapid.publicKey,
	}), { status: 200, headers });
}

export async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const vapid = getVapidKeys(env);
	if (!vapid) {
		return new Response(JSON.stringify({
			error: 'Push notifications are not configured on the server.',
		}), { status: 503, headers });
	}

	let body: any;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers });
	}

	const subscription = body?.subscription;
	if (!isValidPushSubscription(subscription)) {
		await recordInvalidSubscription(env, 'subscribe_invalid_payload');
		return new Response(JSON.stringify({ error: 'Invalid push subscription payload.' }), { status: 400, headers });
	}

	const requestedStateCode =
		normalizeStateCode(body?.stateCode || body?.state)
		|| normalizeStateCode(body?.prefs?.stateCode)
		|| normalizeStateCode(body?.prefs?.scopes?.[0]?.stateCode);
	if (!requestedStateCode && !body?.prefs) {
		await recordInvalidSubscription(env, 'subscribe_missing_scope');
		return new Response(JSON.stringify({ error: 'A valid US state code or push scope is required.' }), { status: 400, headers });
	}

	const record = await upsertPushSubscriptionRecord(
		env,
		subscription,
		request.headers.get('user-agent') || undefined,
		requestedStateCode || undefined,
		body?.prefs,
	);
	const responseStateCode = firstStateCodeFromPreferences(record.prefs);

	const payload: Record<string, unknown> = {
		ok: true,
		subscriptionId: record.id,
		prefs: record.prefs,
		indexedStateCodes: record.indexedStateCodes,
	};
	if (responseStateCode) {
		payload.stateCode = responseStateCode;
	}

	return new Response(JSON.stringify(payload), { status: 200, headers });
}

export async function handlePushTest(request: Request, env: Env): Promise<Response> {
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const vapid = getVapidKeys(env);
	if (!vapid) {
		return new Response(JSON.stringify({
			error: 'Push notifications are not configured on the server.',
		}), { status: 503, headers });
	}

	let body: any;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers });
	}

	const subscription = body?.subscription;
	if (!isValidPushSubscription(subscription)) {
		await recordInvalidSubscription(env, 'push_test_invalid_payload');
		return new Response(JSON.stringify({ error: 'Invalid push subscription payload.' }), { status: 400, headers });
	}

	const requestedStateCode =
		normalizeStateCode(body?.stateCode || body?.state)
		|| normalizeStateCode(body?.prefs?.stateCode)
		|| normalizeStateCode(body?.prefs?.scopes?.[0]?.stateCode)
		|| 'KY';
	const prefs = normalizePushPreferences(body?.prefs, requestedStateCode);
	const stateCode = firstStateCodeFromPreferences(prefs) || requestedStateCode;
	const enabledScopeCount = prefs.scopes.filter((scope) => scope.enabled).length;
	const clientTestId = String(body?.clientTestId || '').trim() || null;
	const payloadData = buildTestPushMessageData(
		stateCode,
		enabledScopeCount > 0 ? enabledScopeCount : prefs.scopes.length,
		clientTestId,
	);

	try {
		const response = await sendPushPayload(
			vapid,
			subscription,
			payloadData,
			`test-${stateCode}`,
		);
		if (response.status === 404 || response.status === 410) {
			await removePushSubscriptionByEndpoint(env, subscription.endpoint);
			await recordInvalidSubscription(
				env,
				`push_test_endpoint_gone_${response.status}`,
			);
			return new Response(
				JSON.stringify({
					error: 'Push subscription is no longer valid. Please resubscribe.',
				}),
				{ status: 410, headers },
			);
		}
		if (!response.ok) {
			const bodyText = await response.text().catch(() => '');
			await recordPushDeliveryFailure(env, {
				stateCode,
				status: response.status,
				message: `push_test_failed_${response.status}`,
			});
			return new Response(
				JSON.stringify({
					error: `Test push failed (${response.status}). ${bodyText.slice(0, 160)}`.trim(),
				}),
				{ status: 502, headers },
			);
		}
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unable to send test push.';
		await recordPushDeliveryFailure(env, {
			stateCode,
			message: `push_test_exception_${message}`,
		});
		return new Response(JSON.stringify({ error: message }), { status: 502, headers });
	}
}

export async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	let body: any;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers });
	}

	const endpoint = String(
		body?.endpoint
		|| body?.subscription?.endpoint
		|| ''
	).trim();
	if (!endpoint) {
		return new Response(JSON.stringify({ error: 'Subscription endpoint is required.' }), { status: 400, headers });
	}

	const removed = await removePushSubscriptionByEndpoint(env, endpoint);
	return new Response(JSON.stringify({ ok: true, removed }), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Alert API helpers
// ---------------------------------------------------------------------------

function normalizeRequestedAlertUgcs(url: URL): string[] {
	return dedupeStrings(
		url.searchParams
			.getAll('ugc')
			.flatMap((value) => String(value || '').split(','))
			.map((value) => String(value || '').trim().toUpperCase())
			.filter(Boolean),
	);
}

function featureMatchesRequestedState(feature: any, requestedStateCode: string | null): boolean {
	if (!requestedStateCode) return true;
	return extractStateCodes(feature).includes(requestedStateCode);
}

function featureMatchesRequestedUgcs(feature: any, requestedUgcs: string[]): boolean {
	if (requestedUgcs.length === 0) return true;
	const featureUgcs = Array.isArray(feature?.properties?.geocode?.UGC)
		? feature.properties.geocode.UGC.map((ugc: unknown) => String(ugc || '').trim().toUpperCase()).filter(Boolean)
		: [];
	return featureUgcs.some((ugc: string) => requestedUgcs.includes(ugc));
}

// ---------------------------------------------------------------------------
// Alert API handlers
// ---------------------------------------------------------------------------

export async function handleApiAlerts(request: Request, env: Env): Promise<Response> {
	let map = await readAlertMap(env);
	let error: string | undefined;
	const url = new URL(request.url);
	const lastPollBefore = await env.WEATHER_KV.get(KV_LAST_POLL);
	if (
		Object.keys(map).length === 0
		|| shouldAutoRefreshStaleAlertsInLocalDev(request, lastPollBefore ?? null)
	) {
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		error = syncResult.error;
	}
	const lifecycleSnapshot = await readAlertLifecycleSnapshot(env);
	const lifecycleByAlertId = lifecycleSnapshot
		? latestLifecycleStatusByAlertId(lifecycleSnapshot)
		: {};
	const radiusParam = url.searchParams.get('radius');
	const latParam = url.searchParams.get('lat');
	const lonParam = url.searchParams.get('lon');
	const requestedStateRaw = String(
		url.searchParams.get('state')
		|| url.searchParams.get('stateCode')
		|| '',
	).trim();
	const requestedStateCode = requestedStateRaw
		? normalizeStateCode(requestedStateRaw)
		: null;
	if (requestedStateRaw && !requestedStateCode) {
		return new Response(JSON.stringify({
			error: 'state must be a valid two-letter US state code.',
		}), {
			status: 400,
			headers: {
				...corsHeaders(),
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}
	const requestedUgcs = normalizeRequestedAlertUgcs(url);
	const hasRadiusFilterParams = radiusParam != null || latParam != null || lonParam != null;
	const radiusMiles = radiusParam == null || radiusParam === '' ? null : Number(radiusParam);
	const centerLat = latParam == null || latParam === '' ? null : Number(latParam);
	const centerLon = lonParam == null || lonParam === '' ? null : Number(lonParam);
	if (
		hasRadiusFilterParams
		&& (
			!(radiusMiles != null && Number.isFinite(radiusMiles) && radiusMiles > 0)
			|| !(centerLat != null && Number.isFinite(centerLat) && centerLat >= -90 && centerLat <= 90)
			|| !(centerLon != null && Number.isFinite(centerLon) && centerLon >= -180 && centerLon <= 180)
		)
	) {
		return new Response(JSON.stringify({
			error: 'lat, lon, and radius must be valid numbers when using radius filtering.',
		}), {
			status: 400,
			headers: {
				...corsHeaders(),
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		});
	}
	const filteredFeatures = Object.values(map).filter((feature: any) => {
		if (
			radiusMiles
			&& centerLat != null
			&& centerLon != null
			&& !alertIntersectsRadius(feature, centerLat, centerLon, radiusMiles)
		) {
			return false;
		}
		if (!featureMatchesRequestedState(feature, requestedStateCode)) {
			return false;
		}
		if (!featureMatchesRequestedUgcs(feature, requestedUgcs)) {
			return false;
		}
		return true;
	});
	const alerts = filteredFeatures.map((feature: any) =>
		normalizeAlertFeature(feature, lifecycleByAlertId),
	);
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const meta = {
		...buildAlertsMeta({
			lastPoll: lastPoll ?? null,
			syncError: error ?? null,
			count: alerts.length,
		}),
		filterMode:
			radiusMiles && centerLat != null && centerLon != null
				? 'radius'
				: requestedUgcs.length > 0
					? 'ugc'
					: requestedStateCode
						? 'state'
						: 'all',
		radiusMiles: radiusMiles && centerLat != null && centerLon != null ? radiusMiles : null,
		center:
			radiusMiles && centerLat != null && centerLon != null
				? { lat: centerLat, lon: centerLon }
				: null,
		stateCode: requestedStateCode,
		ugcCount: requestedUgcs.length,
	};
	await recordStaleDataCondition(env, meta.staleMinutes, 'api_alerts_response');
	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};
	return new Response(JSON.stringify({
		alerts,
		meta,
		generatedAt: meta.generatedAt,
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
	}), {
		status: 200,
		headers,
	});
}

export async function handleApiAlertDetail(
	request: Request,
	env: Env,
	alertId: string,
): Promise<Response> {
	let map = await readAlertMap(env);
	let error: string | undefined;
	const lastPollBefore = await env.WEATHER_KV.get(KV_LAST_POLL);
	if (
		Object.keys(map).length === 0
		|| shouldAutoRefreshStaleAlertsInLocalDev(request, lastPollBefore ?? null)
	) {
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		error = syncResult.error;
	}

	const directMatch = map[alertId];
	const fallbackMatch = directMatch
		? directMatch
		: Object.values(map).find((feature: any) => {
			const p = feature?.properties ?? {};
			const id = String(feature?.id ?? p.id ?? '');
			return id === alertId;
		});

	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};

	if (!fallbackMatch) {
		return new Response(JSON.stringify({ error: 'Alert not found.' }), {
			status: 404,
			headers,
		});
	}

	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const meta = buildAlertsMeta({
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
		count: 1,
	});
	await recordStaleDataCondition(env, meta.staleMinutes, 'api_alert_detail_response');
	const lifecycleSnapshot = await readAlertLifecycleSnapshot(env);
	const lifecycleByAlertId = lifecycleSnapshot
		? latestLifecycleStatusByAlertId(lifecycleSnapshot)
		: {};

	return new Response(JSON.stringify({
		alert: normalizeAlertFeature(fallbackMatch, lifecycleByAlertId),
		meta,
		generatedAt: meta.generatedAt,
		lastPoll: meta.lastPoll,
		syncError: error ?? null,
	}), {
		status: 200,
		headers,
	});
}

// ---------------------------------------------------------------------------
// Alert history helpers
// ---------------------------------------------------------------------------

function normalizeHistorySeverityBucket(
	value: string,
): 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown' {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'extreme') return 'extreme';
	if (normalized === 'severe') return 'severe';
	if (normalized === 'moderate') return 'moderate';
	if (normalized === 'minor') return 'minor';
	return 'unknown';
}

function summarizeAlertHistoryDay(
	entries: AlertHistoryEntry[],
	snapshot: AlertHistorySnapshotCounts,
): {
	totalEntries: number;
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
	byLifecycle: Record<AlertChangeType, number>;
	byCategory: Record<'warning' | 'watch' | 'advisory' | 'statement' | 'other', number>;
	bySeverity: Record<'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown', number>;
	topEvents: Array<{ event: string; count: number }>;
	notableWarnings: Array<{
		alertId: string;
		event: string;
		areaDesc: string;
		severity: string;
		changedAt: string;
		changeType: AlertChangeType;
	}>;
} {
	const byLifecycle: Record<AlertChangeType, number> = {
		new: 0,
		updated: 0,
		extended: 0,
		expired: 0,
		all_clear: 0,
	};
	const byCategory: Record<'warning' | 'watch' | 'advisory' | 'statement' | 'other', number> = {
		warning: 0,
		watch: 0,
		advisory: 0,
		statement: 0,
		other: 0,
	};
	const bySeverity: Record<'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown', number> = {
		extreme: 0,
		severe: 0,
		moderate: 0,
		minor: 0,
		unknown: 0,
	};
	const eventCounts = new Map<string, number>();

	for (const entry of entries) {
		byLifecycle[entry.changeType] += 1;
		const category = String(entry.category || '').trim().toLowerCase();
		if (
			category === 'warning'
			|| category === 'watch'
			|| category === 'advisory'
			|| category === 'statement'
		) {
			byCategory[category] += 1;
		} else {
			byCategory.other += 1;
		}
		bySeverity[normalizeHistorySeverityBucket(entry.severity)] += 1;
		const eventKey = String(entry.event || 'Weather Alert').trim() || 'Weather Alert';
		eventCounts.set(eventKey, (eventCounts.get(eventKey) || 0) + 1);
	}

	const topEvents = Array.from(eventCounts.entries())
		.map(([event, count]) => ({ event, count }))
		.sort((a, b) => {
			if (a.count !== b.count) return b.count - a.count;
			return a.event.localeCompare(b.event);
		})
		.slice(0, 4);

	const notableWarnings = entries
		.filter((entry) => {
			const category = String(entry.category || '').trim().toLowerCase()
				|| classifyAlertCategoryFromEvent(entry.event);
			const severityBucket = normalizeHistorySeverityBucket(entry.severity);
			return category === 'warning' && (entry.isMajor || severityBucket === 'extreme' || severityBucket === 'severe');
		})
		.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
		.slice(0, 4)
		.map((entry) => ({
			alertId: entry.alertId,
			event: entry.event,
			areaDesc: entry.areaDesc,
			severity: entry.severity,
			changedAt: entry.changedAt,
			changeType: entry.changeType,
		}));

	return {
		totalEntries: entries.length,
		activeAlertCount: snapshot.activeAlertCount,
		activeWarningCount: snapshot.activeWarningCount,
		activeMajorCount: snapshot.activeMajorCount,
		byLifecycle,
		byCategory,
		bySeverity,
		topEvents,
		notableWarnings,
	};
}

export async function handleApiAlertHistory(request: Request, env: Env): Promise<Response> {
	const headers = apiCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const url = new URL(request.url);
	const stateInput = String(url.searchParams.get('state') || '').trim();
	const countyInput = String(url.searchParams.get('countyCode') || '').trim();
	const daysInput = String(url.searchParams.get('days') || '').trim();

	let stateCode: string | null = null;
	if (stateInput) {
		stateCode = normalizeStateCode(stateInput);
		if (!stateCode) {
			return new Response(JSON.stringify({ error: 'Invalid state filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let countyCode: string | null = null;
	if (countyInput) {
		countyCode = normalizeCountyFips(countyInput);
		if (!countyCode) {
			return new Response(JSON.stringify({ error: 'Invalid countyCode filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let requestedDays = 7;
	if (daysInput) {
		const parsedDays = Number(daysInput);
		if (!Number.isInteger(parsedDays) || parsedDays <= 0 || parsedDays > ALERT_HISTORY_MAX_QUERY_DAYS) {
			return new Response(
				JSON.stringify({
					error: `days must be an integer between 1 and ${ALERT_HISTORY_MAX_QUERY_DAYS}.`,
				}),
				{
					status: 400,
					headers,
				},
			);
		}
		requestedDays = parsedDays;
	}

	let historyByDay = await readAlertHistoryByDay(env);
	if (Object.keys(historyByDay).length === 0) {
		const { map } = await syncAlerts(env);
		const lifecycleDiff = await syncAlertLifecycleState(env, map);
		historyByDay = await syncAlertHistoryDailySnapshots(env, map, lifecycleDiff.changes);
	}

	const nowMs = Date.now();
	const cutoffMs = nowMs - (requestedDays * 24 * 60 * 60 * 1000);
	const dayRecords = Object.values(historyByDay)
		.map((record) => normalizeAlertHistoryDayRecord(record))
		.filter((record): record is AlertHistoryDayRecord => !!record)
		.sort((a, b) => b.day.localeCompare(a.day));

	const days = dayRecords
		.map((record) => {
			const dayMs = Date.parse(`${record.day}T00:00:00.000Z`);
			if (!Number.isFinite(dayMs)) return null;
			const dayEndsMs = dayMs + (24 * 60 * 60 * 1000);
			if (dayEndsMs < cutoffMs) return null;

			const scopedEntries = record.entries.filter((entry) => {
				const changedAtMs = Date.parse(entry.changedAt);
				if (!Number.isFinite(changedAtMs) || changedAtMs < cutoffMs) {
					return false;
				}
				if (stateCode && !entry.stateCodes.includes(stateCode)) {
					return false;
				}
				if (countyCode && !entry.countyCodes.includes(countyCode)) {
					return false;
				}
				return true;
			});

			const stateScopedSnapshot = stateCode
				? normalizeAlertHistorySnapshotCounts(record.snapshot.byState[stateCode])
				: normalizeAlertHistorySnapshotCounts(record.snapshot);

			let scopedSnapshot = stateScopedSnapshot;
			if (countyCode) {
				const countySnapshot = readAlertHistorySnapshotCountsByCounty(
					record.snapshot,
					countyCode,
					stateCode,
				);
				scopedSnapshot = countySnapshot
					? countySnapshot
					: summarizeAlertHistoryEntriesAsSnapshot(scopedEntries);
			}
			const summary = summarizeAlertHistoryDay(scopedEntries, scopedSnapshot);

			if (summary.totalEntries === 0 && summary.activeAlertCount === 0) {
				return null;
			}

			return {
				day: record.day,
				generatedAt: record.updatedAt,
				summary,
				entries: scopedEntries,
			};
		})
		.filter((record): record is {
			day: string;
			generatedAt: string;
			summary: ReturnType<typeof summarizeAlertHistoryDay>;
			entries: AlertHistoryEntry[];
		} => !!record);

	return new Response(
		JSON.stringify({
			days,
			generatedAt: new Date().toISOString(),
			meta: {
				state: stateCode,
				countyCode,
				daysRequested: requestedDays,
			},
		}),
		{
			status: 200,
			headers,
		},
	);
}

export async function handleApiAlertChanges(request: Request, env: Env): Promise<Response> {
	const headers = apiCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const url = new URL(request.url);
	const sinceInput = String(url.searchParams.get('since') || '').trim();
	const stateInput = String(url.searchParams.get('state') || '').trim();
	const countyInput = String(url.searchParams.get('countyCode') || '').trim();

	let sinceMs: number | null = null;
	if (sinceInput) {
		const parsed = Date.parse(sinceInput);
		if (!Number.isFinite(parsed)) {
			return new Response(JSON.stringify({ error: 'Invalid since timestamp.' }), {
				status: 400,
				headers,
			});
		}
		sinceMs = parsed;
	}

	let stateCode: string | null = null;
	if (stateInput) {
		stateCode = normalizeStateCode(stateInput);
		if (!stateCode) {
			return new Response(JSON.stringify({ error: 'Invalid state filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let countyCode: string | null = null;
	if (countyInput) {
		countyCode = normalizeCountyFips(countyInput);
		if (!countyCode) {
			return new Response(JSON.stringify({ error: 'Invalid countyCode filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	const changes = await readAlertChangeRecords(env);
	const filtered = changes.filter((change) => {
		const changedAtMs = Date.parse(change.changedAt);
		if (sinceMs !== null && (!Number.isFinite(changedAtMs) || changedAtMs <= sinceMs)) {
			return false;
		}
		if (stateCode && !change.stateCodes.includes(stateCode)) {
			return false;
		}
		if (countyCode && !change.countyCodes.includes(countyCode)) {
			return false;
		}
		return true;
	});

	return new Response(
		JSON.stringify({
			changes: filtered,
			generatedAt: new Date().toISOString(),
		}),
		{
			status: 200,
			headers,
		},
	);
}

export async function handleApiDebugSummary(request: Request, env: Env): Promise<Response> {
	const headers = debugCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const expectedBearerToken = getDebugSummaryBearerToken(env);
	if (!expectedBearerToken) {
		return new Response(
			JSON.stringify({
				error: 'Debug summary is disabled until DEBUG_SUMMARY_BEARER_TOKEN is configured.',
			}),
			{
				status: 503,
				headers,
			},
		);
	}

	if (!hasDebugSummaryAccess(request, expectedBearerToken)) {
		headers.set('WWW-Authenticate', 'Bearer realm="debug-summary"');
		return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
			status: 401,
			headers,
		});
	}

	const map = pruneExpired(await readAlertMap(env));
	const diagnostics = await readOperationalDiagnostics(env);
	const pushSubscriptionCount = await countPushSubscriptionRecords(env);

	return new Response(
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			lastSuccessfulSync: diagnostics.lastSuccessfulSyncAt,
			lastSyncAttempt: diagnostics.lastSyncAttemptAt,
			lastSyncError: diagnostics.lastSyncError,
			activeAlertCount: Object.keys(map).length,
			pushSubscriptionCount,
			invalidSubscriptionCount: diagnostics.invalidSubscriptionCount,
			lastInvalidSubscriptionAt: diagnostics.lastInvalidSubscriptionAt,
			lastInvalidSubscriptionReason: diagnostics.lastInvalidSubscriptionReason,
			recentPushFailures: diagnostics.recentPushFailures,
		}),
		{
			status: 200,
			headers,
		},
	);
}
