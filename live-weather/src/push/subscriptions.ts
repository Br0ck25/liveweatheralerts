import {
	type PushSubscription as WebPushSubscription,
	type VapidKeys,
} from '@block65/webcrypto-web-push';
import type {
	Env,
	PushAlertTypes,
	PushQuietHours,
	PushDeliveryScope,
	PushScope,
	PushPreferences,
	PushSubscriptionRecord,
	PushStateAlertSnapshot,
	LegacyPushPreferences,
	LegacyPushSubscriptionRecord,
} from '../types';
import {
	KV_PUSH_SUB_PREFIX,
	KV_PUSH_STATE_INDEX_PREFIX,
	KV_PUSH_RADIUS_INDEX,
	KV_PUSH_STATE_ALERT_SNAPSHOT,
} from '../constants';
import {
	dedupeStrings,
	sha256Hex,
	normalizeStateCode,
	STATE_CODE_TO_NAME,
	DEFAULT_PUSH_ALERT_TYPES,
	DEFAULT_PUSH_QUIET_HOURS,
	normalizeCountyFips,
	cleanCountyToken,
	extractCountyFipsCodesForState,
	extractStateCodes,
} from '../utils';
import { alertIntersectsRadius } from '../geo-utils';

// ---------------------------------------------------------------------------
// Local normalizers
// ---------------------------------------------------------------------------

function normalizeCountyName(input: unknown): string | null {
	const value = String(input ?? '').trim();
	return value ? value : null;
}

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

function normalizeRadiusMiles(input: unknown): number | null {
	const value = Number(input);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Number(value.toFixed(2));
}

function normalizePushAlertTypes(input: unknown): PushAlertTypes {
	const value = input as Record<string, unknown> | null;
	return {
		warnings: value?.warnings !== false,
		watches: value?.watches !== false,
		advisories: value?.advisories === true,
		statements: value?.statements !== false,
	};
}

function normalizeQuietHourTime(input: unknown, fallback: string): string {
	const value = String(input ?? '').trim();
	if (!/^\d{2}:\d{2}$/.test(value)) return fallback;
	const [hours, minutes] = value.split(':').map((part) => Number(part));
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizePushQuietHours(input: unknown): PushQuietHours {
	const value = input as Record<string, unknown> | null;
	return {
		enabled: value?.enabled === true,
		start: normalizeQuietHourTime(value?.start, DEFAULT_PUSH_QUIET_HOURS.start),
		end: normalizeQuietHourTime(value?.end, DEFAULT_PUSH_QUIET_HOURS.end),
	};
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

function createPushScopeId(
	stateCode: string,
	deliveryScope: PushDeliveryScope,
	countyFips: string | null,
	radiusMiles: number | null,
	centerLat: number | null,
	centerLon: number | null,
	indexHint: number,
): string {
	const encodeCoordinate = (value: number | null): string =>
		value == null ? 'na' : String(value.toFixed(2)).replace('-', 'm').replace('.', '_');
	const suffix =
		deliveryScope === 'county'
			? countyFips || `county-${indexHint + 1}`
			: deliveryScope === 'radius'
				? `radius-${radiusMiles ?? 'custom'}-${encodeCoordinate(centerLat)}-${encodeCoordinate(centerLon)}`
				: `state-${indexHint + 1}`;
	return `${stateCode}-${deliveryScope}-${suffix}`;
}

export function pushScopeHasRadius(scope: PushScope): boolean {
	return (
		scope.deliveryScope === 'radius'
		&& normalizeRadiusMiles(scope.radiusMiles) != null
		&& normalizeLatitude(scope.centerLat) != null
		&& normalizeLongitude(scope.centerLon) != null
	);
}

function normalizePushScope(
	input: unknown,
	fallbackStateCode: string,
	indexHint: number,
): PushScope | null {
	const value = input as Record<string, unknown> | null;
	if (!value || typeof value !== 'object') return null;

	const stateCode = normalizeStateCode(value.stateCode) || normalizeStateCode(fallbackStateCode);
	if (!stateCode) return null;

	const requestedDeliveryScope =
		value.deliveryScope === 'county'
			? 'county'
			: value.deliveryScope === 'radius'
				? 'radius'
				: 'state';
	const countyFips = normalizeCountyFips(value.countyFips);
	const countyName = normalizeCountyName(value.countyName);
	const centerLat = normalizeLatitude(value.centerLat);
	const centerLon = normalizeLongitude(value.centerLon);
	const radiusMiles = normalizeRadiusMiles(value.radiusMiles);

	const deliveryScope: PushDeliveryScope =
		requestedDeliveryScope === 'radius' && centerLat != null && centerLon != null && radiusMiles != null
			? 'radius'
			: requestedDeliveryScope === 'county' && (countyFips || countyName)
			? 'county'
			: 'state';
	const scopeId =
		String(value.id ?? '').trim() ||
		createPushScopeId(stateCode, deliveryScope, countyFips, radiusMiles, centerLat, centerLon, indexHint);
	const placeIdValue = String(value.placeId ?? '').trim();
	const placeId = placeIdValue ? placeIdValue : null;
	const fallbackLabel =
		deliveryScope === 'radius'
			? `Within ${radiusMiles ?? 0} mi of ${stateCode}`
			: deliveryScope === 'county'
			? `${stateCode} ${countyName || `County ${countyFips || ''}`.trim()}`.trim()
			: `${stateCode} Alerts`;
	const scopeLabel = String(value.label ?? '').trim() || fallbackLabel;

	return {
		id: scopeId,
		placeId,
		label: scopeLabel,
		stateCode,
		deliveryScope,
		countyName,
		countyFips,
		centerLat: deliveryScope === 'radius' ? centerLat : null,
		centerLon: deliveryScope === 'radius' ? centerLon : null,
		radiusMiles: deliveryScope === 'radius' ? radiusMiles : null,
		enabled: value.enabled !== false,
		alertTypes: normalizePushAlertTypes(value.alertTypes),
		severeOnly: value.severeOnly === true,
	};
}

export function createDefaultPushScope(stateCode: string): PushScope {
	return {
		id: `${stateCode}-state-default`,
		placeId: null,
		label: `${stateCode} Alerts`,
		stateCode,
		deliveryScope: 'state',
		countyName: null,
		countyFips: null,
		centerLat: null,
		centerLon: null,
		radiusMiles: null,
		enabled: true,
		alertTypes: { ...DEFAULT_PUSH_ALERT_TYPES },
		severeOnly: false,
	};
}

function defaultPushPreferences(stateCode: string): PushPreferences {
	const normalizedState = normalizeStateCode(stateCode) || 'KY';
	return {
		scopes: [createDefaultPushScope(normalizedState)],
		quietHours: { ...DEFAULT_PUSH_QUIET_HOURS },
		deliveryMode: 'immediate',
		pausedUntil: null,
	};
}

export function normalizePushPreferences(
	input: unknown,
	fallbackStateCode: string,
): PushPreferences {
	const fallback = defaultPushPreferences(fallbackStateCode);
	const value = input as Record<string, unknown> | null;
	if (!value || typeof value !== 'object') {
		return fallback;
	}

	const scopesInput = Array.isArray(value.scopes) ? value.scopes : [];
	let scopes = scopesInput
		.map((scope, index) => normalizePushScope(scope, fallbackStateCode, index))
		.filter((scope): scope is PushScope => !!scope);

	if (scopes.length === 0) {
		const legacyState = normalizeStateCode(
			(value as LegacyPushPreferences).stateCode || fallbackStateCode,
		);
		if (legacyState) {
			const legacy = value as LegacyPushPreferences;
			const legacyDeliveryScope =
				legacy.deliveryScope === 'county'
					? 'county'
					: legacy.deliveryScope === 'radius'
						? 'radius'
						: 'state';
			const legacyCountyFips = normalizeCountyFips(legacy.countyFips);
			const legacyCountyName = normalizeCountyName(legacy.countyName);
			const legacyCenterLat = normalizeLatitude(legacy.centerLat);
			const legacyCenterLon = normalizeLongitude(legacy.centerLon);
			const legacyRadiusMiles = normalizeRadiusMiles(legacy.radiusMiles);
			const deliveryScope: PushDeliveryScope =
				legacyDeliveryScope === 'radius'
					&& legacyCenterLat != null
					&& legacyCenterLon != null
					&& legacyRadiusMiles != null
					? 'radius'
					: legacyDeliveryScope === 'county' && (legacyCountyFips || legacyCountyName)
					? 'county'
					: 'state';

			scopes = [
				{
					...createDefaultPushScope(legacyState),
					id: createPushScopeId(
						legacyState,
						deliveryScope,
						legacyCountyFips,
						legacyRadiusMiles,
						legacyCenterLat,
						legacyCenterLon,
						0,
					),
					label:
						deliveryScope === 'radius'
							? `Within ${legacyRadiusMiles ?? 0} mi of ${legacyState}`
							: deliveryScope === 'county'
							? `${legacyState} ${legacyCountyName || `County ${legacyCountyFips || ''}`.trim()}`.trim()
							: `${legacyState} Alerts`,
					deliveryScope,
					countyName: legacyCountyName,
					countyFips: legacyCountyFips,
					centerLat: deliveryScope === 'radius' ? legacyCenterLat : null,
					centerLon: deliveryScope === 'radius' ? legacyCenterLon : null,
					radiusMiles: deliveryScope === 'radius' ? legacyRadiusMiles : null,
					alertTypes: normalizePushAlertTypes(legacy.alertTypes),
					severeOnly: legacy.severeOnly === true,
				},
			];
		}
	}

	if (scopes.length === 0) {
		scopes = fallback.scopes;
	}

	const seenScopeIds = new Set<string>();
	const dedupedScopes = scopes.filter((scope) => {
		const key = scope.id;
		if (seenScopeIds.has(key)) return false;
		seenScopeIds.add(key);
		return true;
	});

	const pausedUntilValue = String(value.pausedUntil ?? '').trim();
	const pausedUntil = pausedUntilValue ? pausedUntilValue : null;

	return {
		scopes: dedupedScopes,
		quietHours: normalizePushQuietHours(value.quietHours),
		deliveryMode: value.deliveryMode === 'digest' ? 'digest' : 'immediate',
		pausedUntil,
	};
}

export function indexedStateCodesFromPreferences(prefs: PushPreferences): string[] {
	const states = prefs.scopes
		.filter((scope) => scope.enabled)
		.map((scope) => normalizeStateCode(scope.stateCode))
		.filter((code): code is string => !!code);
	return dedupeStrings(states);
}

export function prefsHaveEnabledRadiusScopes(prefs: PushPreferences): boolean {
	return prefs.scopes.some((scope) => scope.enabled && pushScopeHasRadius(scope));
}

export function firstStateCodeFromPreferences(prefs: PushPreferences): string | null {
	const firstEnabled = prefs.scopes.find(
		(scope) => scope.enabled && normalizeStateCode(scope.stateCode),
	);
	if (firstEnabled) return normalizeStateCode(firstEnabled.stateCode);
	const firstAny = prefs.scopes.find((scope) => normalizeStateCode(scope.stateCode));
	if (firstAny) return normalizeStateCode(firstAny.stateCode);
	return null;
}

// ---------------------------------------------------------------------------
// KV key helpers
// ---------------------------------------------------------------------------

export function pushSubKey(subscriptionId: string): string {
	return `${KV_PUSH_SUB_PREFIX}${subscriptionId}`;
}

function pushStateIndexKey(stateCode: string): string {
	return `${KV_PUSH_STATE_INDEX_PREFIX}${stateCode}`;
}

export function getVapidKeys(env: Env): VapidKeys | null {
	const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
	const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
	const subject = String(env.VAPID_SUBJECT || '').trim() || 'mailto:alerts@liveweatheralerts.com';
	if (!publicKey || !privateKey) return null;
	return { publicKey, privateKey, subject };
}

export function isValidPushSubscription(value: unknown): value is WebPushSubscription {
	const v = value as Record<string, any> | null | undefined;
	if (!v || typeof v !== 'object') return false;
	const endpoint = String(v.endpoint ?? '');
	const keys = v.keys as Record<string, any> | undefined;
	const auth = String(keys?.auth ?? '');
	const p256dh = String(keys?.p256dh ?? '');
	if (!endpoint.startsWith('https://')) return false;
	return auth.length > 0 && p256dh.length > 0;
}

// ---------------------------------------------------------------------------
// State index CRUD
// ---------------------------------------------------------------------------

export async function readPushStateIndex(env: Env, stateCode: string): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(pushStateIndexKey(stateCode));
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return dedupeStrings(parsed.map((v) => String(v)));
	} catch {
		return [];
	}
}

async function readPushRadiusIndex(env: Env): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_PUSH_RADIUS_INDEX);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return dedupeStrings(parsed.map((value) => String(value)));
	} catch {
		return [];
	}
}

async function writePushRadiusIndex(env: Env, subscriptionIds: string[]): Promise<void> {
	const ids = dedupeStrings(subscriptionIds);
	if (ids.length === 0) {
		await env.WEATHER_KV.delete(KV_PUSH_RADIUS_INDEX);
		return;
	}
	await env.WEATHER_KV.put(KV_PUSH_RADIUS_INDEX, JSON.stringify(ids));
}

export async function addPushIdToRadiusIndex(env: Env, subscriptionId: string): Promise<void> {
	const current = await readPushRadiusIndex(env);
	if (current.includes(subscriptionId)) return;
	current.push(subscriptionId);
	await writePushRadiusIndex(env, current);
}

export async function removePushIdFromRadiusIndex(env: Env, subscriptionId: string): Promise<void> {
	const current = await readPushRadiusIndex(env);
	const next = current.filter((id) => id !== subscriptionId);
	await writePushRadiusIndex(env, next);
}

async function writePushStateIndex(env: Env, stateCode: string, subscriptionIds: string[]): Promise<void> {
	const ids = dedupeStrings(subscriptionIds);
	if (ids.length === 0) {
		await env.WEATHER_KV.delete(pushStateIndexKey(stateCode));
		return;
	}
	await env.WEATHER_KV.put(pushStateIndexKey(stateCode), JSON.stringify(ids));
}

export async function addPushIdToStateIndex(env: Env, stateCode: string, subscriptionId: string): Promise<void> {
	const current = await readPushStateIndex(env, stateCode);
	if (current.includes(subscriptionId)) return;
	current.push(subscriptionId);
	await writePushStateIndex(env, stateCode, current);
}

export async function removePushIdFromStateIndex(env: Env, stateCode: string, subscriptionId: string): Promise<void> {
	const current = await readPushStateIndex(env, stateCode);
	const next = current.filter((id) => id !== subscriptionId);
	await writePushStateIndex(env, stateCode, next);
}

export async function readPushSubscriptionRecordById(env: Env, subscriptionId: string): Promise<PushSubscriptionRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(pushSubKey(subscriptionId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as LegacyPushSubscriptionRecord;
		if (!parsed || typeof parsed !== 'object') return null;

		const id = String(parsed.id || '').trim();
		const endpoint = String(parsed.endpoint || '').trim();
		const subscription = parsed.subscription;
		if (!id || !endpoint || !isValidPushSubscription(subscription)) return null;

		const fallbackStateCode =
			normalizeStateCode(parsed.stateCode)
			|| normalizeStateCode(parsed.indexedStateCodes?.[0])
			|| 'KY';
		const prefs = normalizePushPreferences(parsed.prefs, fallbackStateCode);
		const indexedFromRecord = Array.isArray(parsed.indexedStateCodes)
			? dedupeStrings(
				parsed.indexedStateCodes
					.map((value) => normalizeStateCode(value))
					.filter((value): value is string => !!value),
			)
			: [];
		const indexedStateCodes =
			indexedFromRecord.length > 0
				? indexedFromRecord
				: indexedStateCodesFromPreferences(prefs);

		const createdAt = String(parsed.createdAt || '').trim() || new Date().toISOString();
		const updatedAt = String(parsed.updatedAt || '').trim() || createdAt;
		const userAgent = String(parsed.userAgent || '').slice(0, 300);

		return {
			id,
			endpoint,
			subscription,
			prefs,
			indexedStateCodes,
			createdAt,
			updatedAt,
			userAgent: userAgent || undefined,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Alert type / scope matching
// ---------------------------------------------------------------------------

function classifyAlertType(event: string): keyof PushAlertTypes {
	const text = String(event || '').toLowerCase();
	if (text.includes('warning')) return 'warnings';
	if (text.includes('watch')) return 'watches';
	if (text.includes('advisory')) return 'advisories';
	return 'statements';
}

export function alertMatchesTypePrefs(event: string, alertTypes: PushAlertTypes): boolean {
	const bucket = classifyAlertType(event);
	return !!alertTypes[bucket];
}

function timeStringToMinutes(value: string): number {
	const [h, m] = String(value || '00:00').split(':').map((v) => Number(v) || 0);
	return h * 60 + m;
}

export function isWithinQuietHours(now: Date, prefs: PushPreferences): boolean {
	if (!prefs.quietHours.enabled) return false;
	const current = now.getHours() * 60 + now.getMinutes();
	const start = timeStringToMinutes(prefs.quietHours.start);
	const end = timeStringToMinutes(prefs.quietHours.end);
	if (start === end) return false;
	if (start < end) return current >= start && current < end;
	return current >= start || current < end;
}

export function alertBypassesQuietHours(feature: any): boolean {
	const event = String(feature?.properties?.event || '');
	const text = String(event || '').toLowerCase();
	if (
		text.includes('tornado warning')
		|| text.includes('severe thunderstorm warning')
		|| text.includes('flash flood warning')
	) {
		return true;
	}
	const severity = String(feature?.properties?.severity || '').toLowerCase();
	return text.includes('warning') && severity === 'extreme';
}

export function isDeliveryPaused(prefs: PushPreferences, now: Date): boolean {
	if (!prefs.pausedUntil) return false;
	const pausedUntilMs = Date.parse(prefs.pausedUntil);
	return Number.isFinite(pausedUntilMs) && pausedUntilMs > now.getTime();
}

export function alertMatchesScopeCounty(feature: any, scope: PushScope): boolean {
	if (scope.deliveryScope !== 'county') return true;
	const stateCode = normalizeStateCode(scope.stateCode);
	if (!stateCode) return false;
	const countyFipsCodes = extractCountyFipsCodesForState(feature, stateCode);
	const countyFips = normalizeCountyFips(scope.countyFips);
	if (countyFips) {
		if (countyFipsCodes.includes(countyFips)) return true;
	}
	const countyName = cleanCountyToken(String(scope.countyName || ''));
	if (!countyName) return false;
	const areaDesc = String(feature?.properties?.areaDesc || '');
	const areaTokens = areaDesc
		.split(/[;,]/)
		.map((part) => cleanCountyToken(part))
		.filter(Boolean);
	if (
		areaTokens.some(
			(token) =>
				token === countyName
				|| token.includes(countyName)
				|| countyName.includes(token),
		)
	) {
		return true;
	}
	return cleanCountyToken(areaDesc).includes(countyName);
}

export function alertMatchesScopeRadius(feature: any, scope: PushScope): boolean {
	if (!pushScopeHasRadius(scope)) return false;
	return alertIntersectsRadius(
		feature,
		Number(scope.centerLat),
		Number(scope.centerLon),
		Number(scope.radiusMiles),
	);
}

function alertMatchesSevereOnly(feature: any): boolean {
	const event = String(feature?.properties?.event || '').toLowerCase();
	const severity = String(feature?.properties?.severity || '').toLowerCase();
	if (!event.includes('warning')) return false;
	if (severity === 'severe' || severity === 'extreme') return true;
	return (
		event.includes('tornado')
		|| event.includes('severe thunderstorm')
		|| event.includes('flash flood')
		|| event.includes('hurricane')
		|| event.includes('blizzard')
	);
}

export function featureMatchesScope(feature: any, stateCode: string, scope: PushScope): boolean {
	if (!scope.enabled) return false;
	if (scope.deliveryScope !== 'radius' && normalizeStateCode(scope.stateCode) !== stateCode) return false;
	const event = String(feature?.properties?.event || '');
	if (!alertMatchesTypePrefs(event, scope.alertTypes)) return false;
	if (scope.severeOnly && !alertMatchesSevereOnly(feature)) return false;
	if (scope.deliveryScope === 'radius') return alertMatchesScopeRadius(feature, scope);
	if (!alertMatchesScopeCounty(feature, scope)) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Subscription CRUD
// ---------------------------------------------------------------------------

export async function upsertPushSubscriptionRecord(
	env: Env,
	subscription: WebPushSubscription,
	userAgent?: string,
	stateCodeInput?: string,
	prefsInput?: unknown,
): Promise<PushSubscriptionRecord> {
	const nowIso = new Date().toISOString();
	const subscriptionId = await sha256Hex(subscription.endpoint);
	const existing = await readPushSubscriptionRecordById(env, subscriptionId);
	const requestedStateCode = normalizeStateCode(stateCodeInput);
	const existingPrimaryState =
		existing ? firstStateCodeFromPreferences(existing.prefs) : null;
	const fallbackStateCode =
		requestedStateCode
		|| existingPrimaryState
		|| 'KY';

	let nextPrefs: PushPreferences;
	if (prefsInput && typeof prefsInput === 'object') {
		nextPrefs = normalizePushPreferences(prefsInput, fallbackStateCode);
	} else if (requestedStateCode) {
		const baseline = existing?.prefs || defaultPushPreferences(requestedStateCode);
		const templateScope = baseline.scopes[0] || createDefaultPushScope(requestedStateCode);
		const migratedScope: PushScope = {
			...templateScope,
			id: `${requestedStateCode}-state-updated`,
			label: `${requestedStateCode} Alerts`,
			stateCode: requestedStateCode,
			deliveryScope: 'state',
			countyName: null,
			countyFips: null,
			centerLat: null,
			centerLon: null,
			radiusMiles: null,
			enabled: true,
		};
		nextPrefs = {
			...baseline,
			scopes: [migratedScope],
		};
	} else {
		nextPrefs = existing?.prefs || defaultPushPreferences(fallbackStateCode);
	}
	const indexedStateCodes = indexedStateCodesFromPreferences(nextPrefs);

	const record: PushSubscriptionRecord = {
		id: subscriptionId,
		endpoint: subscription.endpoint,
		subscription,
		prefs: nextPrefs,
		indexedStateCodes,
		createdAt: existing?.createdAt || nowIso,
		updatedAt: nowIso,
		userAgent: String(userAgent || existing?.userAgent || '').slice(0, 300),
	};

	await env.WEATHER_KV.put(pushSubKey(subscriptionId), JSON.stringify(record));

	const previousIndexedStateCodes = existing?.indexedStateCodes || [];
	const shouldBeRadiusIndexed = prefsHaveEnabledRadiusScopes(nextPrefs);
	const allKnownStateCodes = dedupeStrings([
		...Object.keys(STATE_CODE_TO_NAME),
		...previousIndexedStateCodes,
		...indexedStateCodes,
	]);

	for (const stateCode of allKnownStateCodes) {
		const shouldBeIndexed = indexedStateCodes.includes(stateCode);
		const currentlyIndexed = (await readPushStateIndex(env, stateCode)).includes(
			subscriptionId,
		);
		if (shouldBeIndexed && !currentlyIndexed) {
			await addPushIdToStateIndex(env, stateCode, subscriptionId);
			continue;
		}
		if (!shouldBeIndexed && currentlyIndexed) {
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
		}
	}

	const currentlyRadiusIndexed = (await readPushRadiusIndex(env)).includes(subscriptionId);
	if (shouldBeRadiusIndexed && !currentlyRadiusIndexed) {
		await addPushIdToRadiusIndex(env, subscriptionId);
	}
	if (!shouldBeRadiusIndexed && currentlyRadiusIndexed) {
		await removePushIdFromRadiusIndex(env, subscriptionId);
	}

	return record;
}

export async function removePushSubscriptionById(env: Env, subscriptionId: string): Promise<boolean> {
	const existing = await readPushSubscriptionRecordById(env, subscriptionId);
	if (!existing) {
		await Promise.all([
			env.WEATHER_KV.delete(pushSubKey(subscriptionId)),
			removePushIdFromRadiusIndex(env, subscriptionId),
		]);
		return false;
	}
	await Promise.all([
		env.WEATHER_KV.delete(pushSubKey(subscriptionId)),
		removePushIdFromRadiusIndex(env, subscriptionId),
		...existing.indexedStateCodes.map((stateCode) =>
			removePushIdFromStateIndex(env, stateCode, subscriptionId),
		),
	]);
	return true;
}

export async function removePushSubscriptionByEndpoint(env: Env, endpoint: string): Promise<boolean> {
	const subscriptionId = await sha256Hex(endpoint);
	return await removePushSubscriptionById(env, subscriptionId);
}

export function buildStateAlertSnapshot(map: Record<string, any>): PushStateAlertSnapshot {
	const snapshot: PushStateAlertSnapshot = {};
	for (const [fallbackId, feature] of Object.entries(map)) {
		const id = String((feature as any)?.id ?? fallbackId ?? '');
		if (!id) continue;
		const stateCodes = extractStateCodes(feature);
		for (const stateCode of stateCodes) {
			if (!snapshot[stateCode]) snapshot[stateCode] = [];
			snapshot[stateCode].push(id);
		}
	}
	for (const stateCode of Object.keys(snapshot)) {
		snapshot[stateCode] = dedupeStrings(snapshot[stateCode]).sort();
	}
	return snapshot;
}

export async function writePushStateAlertSnapshot(env: Env, snapshot: PushStateAlertSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_PUSH_STATE_ALERT_SNAPSHOT, JSON.stringify(snapshot));
}
