import {
	buildPushPayload,
	type PushMessage,
	type PushSubscription as WebPushSubscription,
	type VapidKeys,
} from '@block65/webcrypto-web-push';
import type {
	Env,
	PushScope,
	PushPreferences,
	AlertChangeRecord,
	AlertChangeType,
	LifecyclePushEntry,
} from '../types';
import {
	NOTIFICATION_ICON_PATH,
	NOTIFICATION_BADGE_PATH,
	KV_PUSH_RADIUS_INDEX,
} from '../constants';
import {
	normalizeStateCode,
	normalizeCountyFips,
	cleanCountyToken,
	truncateText,
	canonicalAlertDetailUrl,
	canonicalAlertsPageUrl,
	canonicalSettingsUrl,
	classifyAlert,
	isMajorImpactAlertEvent,
	deriveAlertImpactCategories,
	stateCodeDisplayName,
} from '../utils';
import { haversineDistanceMiles } from '../geo-utils';
import {
	pushScopeHasRadius,
	featureMatchesScope,
	alertMatchesTypePrefs,
	isWithinQuietHours,
	alertBypassesQuietHours,
	isDeliveryPaused,
	readPushStateIndex,
	readPushSubscriptionRecordById,
	removePushSubscriptionById,
	removePushIdFromStateIndex,
	removePushIdFromRadiusIndex,
	prefsHaveEnabledRadiusScopes,
	buildStateAlertSnapshot,
	writePushStateAlertSnapshot,
	getVapidKeys,
} from './subscriptions';

// ---------------------------------------------------------------------------
// Local helpers that mirror subscriptions.ts — kept local to avoid leaking
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

async function readPushRadiusIndex(env: Env): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_PUSH_RADIUS_INDEX);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((v) => String(v));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Push message builders
// ---------------------------------------------------------------------------

export function buildStatePushMessageData(stateCode: string, features: any[]): Record<string, any> {
	const stateName = stateCodeDisplayName(stateCode);
	if (features.length <= 1) {
		const feature = features[0] ?? {};
		const properties = feature?.properties ?? {};
		const alertId = String(feature?.id ?? properties?.id ?? '');
		const event = String(properties.event ?? 'Weather Alert');
		const headline = String(properties.headline ?? '').trim();
		const areaDesc = String(properties.areaDesc ?? '').trim();
		const detailUrl = alertId
			? canonicalAlertDetailUrl(alertId)
			: canonicalAlertsPageUrl(stateCode);
		const fallbackUrl = canonicalAlertsPageUrl(stateCode);
		return {
			title: `${event} - ${stateName}`,
			body: truncateText(headline || areaDesc || 'Tap for details.', 140),
			url: detailUrl,
			detailUrl,
			fallbackUrl,
			tag: alertId ? `alert-${alertId}` : `state-${stateCode}-latest`,
			stateCode,
			alertId,
			changeType: 'new',
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
		};
	}

	const warningCount = features.filter((f) => classifyAlert(String(f?.properties?.event ?? '')) === 'warning').length;
	const watchCount = features.filter((f) => classifyAlert(String(f?.properties?.event ?? '')) === 'watch').length;
	const bodyParts = [];
	if (warningCount > 0) bodyParts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
	if (watchCount > 0) bodyParts.push(`${watchCount} watch${watchCount === 1 ? '' : 'es'}`);
	if (bodyParts.length === 0) bodyParts.push(`${features.length} new alerts`);

	return {
		title: `${features.length} new weather alerts - ${stateName}`,
		body: truncateText(`Includes ${bodyParts.join(', ')}. Tap to review now.`, 140),
		url: canonicalAlertsPageUrl(stateCode),
		fallbackUrl: canonicalAlertsPageUrl(),
		tag: `state-${stateCode}-group`,
		stateCode,
		changeType: 'new',
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
	};
}

export function buildTestPushMessageData(
	stateCode: string,
	scopeCount: number,
	clientTestId?: string | null,
): Record<string, any> {
	return {
		title: 'Live Weather Alerts test notification',
		body:
			scopeCount > 1
				? `Notifications are active for ${scopeCount} scopes.`
				: `Notifications are active for ${stateCode}.`,
		url: canonicalSettingsUrl(),
		fallbackUrl: canonicalAlertsPageUrl(stateCode),
		tag: `test-${stateCode}`,
		stateCode,
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
		test: true,
		...(clientTestId ? { clientTestId } : {}),
	};
}

export function buildLifecyclePushMessageData(stateCode: string, entries: LifecyclePushEntry[]): Record<string, any> {
	const stateName = stateCodeDisplayName(stateCode);
	const usableEntries = entries.filter((entry) => !!entry.change);
	if (usableEntries.length === 0) {
		return {
			title: `Weather alert update - ${stateName}`,
			body: 'Tap to review recent alert updates.',
			url: canonicalAlertsPageUrl(stateCode),
			fallbackUrl: canonicalAlertsPageUrl(),
			tag: `state-${stateCode}-lifecycle`,
			stateCode,
			changeType: 'grouped',
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
		};
	}

	if (usableEntries.length === 1) {
		const entry = usableEntries[0];
		const changeType = entry.change.changeType;
		if (changeType === 'all_clear') {
			return {
				title: `All clear - ${stateName}`,
				body: 'Active alerts have cleared for this area.',
				url: canonicalAlertsPageUrl(stateCode),
				fallbackUrl: canonicalAlertsPageUrl(),
				tag: `state-${stateCode}-all-clear`,
				stateCode,
				changeType: 'all_clear',
				icon: NOTIFICATION_ICON_PATH,
				badge: NOTIFICATION_BADGE_PATH,
			};
		}

		const feature = entry.feature ?? {};
		const properties = feature?.properties ?? {};
		const alertId = String(feature?.id ?? properties?.id ?? entry.change.alertId ?? '');
		const event = String(properties.event ?? entry.change.event ?? 'Weather Alert');
		const headline = String(properties.headline ?? '').trim();
		const areaDesc = String(properties.areaDesc ?? entry.change.areaDesc ?? '').trim();
		const detailUrl = alertId
			? canonicalAlertDetailUrl(alertId)
			: canonicalAlertsPageUrl(stateCode);
		const changeLabel =
			changeType === 'extended'
				? 'extended'
				: changeType === 'updated'
					? 'updated'
					: changeType;

		return {
			title: `${event} ${changeLabel} - ${stateName}`,
			body: truncateText(headline || areaDesc || 'Tap for details.', 140),
			url: detailUrl,
			detailUrl,
			fallbackUrl: canonicalAlertsPageUrl(stateCode),
			tag: alertId ? `alert-${alertId}-${changeType}` : `state-${stateCode}-${changeType}`,
			stateCode,
			alertId: alertId || undefined,
			changeType,
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
		};
	}

	const counts: Record<AlertChangeType, number> = {
		new: 0,
		updated: 0,
		extended: 0,
		expired: 0,
		all_clear: 0,
	};
	for (const entry of usableEntries) {
		counts[entry.change.changeType] += 1;
	}

	const bodyParts: string[] = [];
	if (counts.new > 0) bodyParts.push(`${counts.new} new`);
	if (counts.updated > 0) bodyParts.push(`${counts.updated} updated`);
	if (counts.extended > 0) bodyParts.push(`${counts.extended} extended`);
	if (counts.expired > 0) bodyParts.push(`${counts.expired} expired`);
	if (counts.all_clear > 0) bodyParts.push(`${counts.all_clear} all clear`);
	if (bodyParts.length === 0) bodyParts.push(`${usableEntries.length} lifecycle updates`);

	const uniqueTypes = Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([type]) => type);

	return {
		title: `${usableEntries.length} alert changes - ${stateName}`,
		body: truncateText(`Includes ${bodyParts.join(', ')}. Tap to review now.`, 140),
		url: canonicalAlertsPageUrl(stateCode),
		fallbackUrl: canonicalAlertsPageUrl(),
		tag: `state-${stateCode}-group`,
		stateCode,
		changeType: uniqueTypes.length === 1 ? uniqueTypes[0] : 'grouped',
		changes: usableEntries.slice(0, 8).map((entry) => ({
			alertId: entry.change.alertId,
			changeType: entry.change.changeType,
		})),
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
	};
}

// ---------------------------------------------------------------------------
// Scope matching for changes
// ---------------------------------------------------------------------------

export function changeMatchesScope(change: AlertChangeRecord, scope: PushScope): boolean {
	if (!scope.enabled) return false;
	const scopeStateCode = normalizeStateCode(scope.stateCode);
	if (scope.deliveryScope !== 'radius' && (!scopeStateCode || !change.stateCodes.includes(scopeStateCode))) {
		return false;
	}
	if (!alertMatchesTypePrefs(change.event, scope.alertTypes)) return false;
	if (scope.severeOnly && !isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', ''))) {
		return false;
	}
	if (scope.deliveryScope === 'radius') {
		if (!pushScopeHasRadius(scope)) return false;
		const lat = normalizeLatitude(change.lat);
		const lon = normalizeLongitude(change.lon);
		if (lat == null || lon == null) return false;
		return haversineDistanceMiles(
			Number(scope.centerLat),
			Number(scope.centerLon),
			lat,
			lon,
		) <= Number(scope.radiusMiles);
	}
	if (scope.deliveryScope !== 'county') return true;

	const targetCountyFips = normalizeCountyFips(scope.countyFips);
	if (targetCountyFips) {
		return change.countyCodes.includes(targetCountyFips);
	}
	const countyName = cleanCountyToken(String(scope.countyName || ''));
	if (!countyName) return false;
	return cleanCountyToken(change.areaDesc).includes(countyName);
}

export function shouldSendAllClearNotification(stateChanges: AlertChangeRecord[]): boolean {
	const hasAllClear = stateChanges.some((change) => change.changeType === 'all_clear');
	if (!hasAllClear) return false;
	return stateChanges.some(
		(change) =>
			change.changeType === 'expired'
			&& isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', '')),
	);
}

export function batchLifecycleEntriesForDeliveryMode(
	deliveryMode: PushPreferences['deliveryMode'],
	entries: LifecyclePushEntry[],
): LifecyclePushEntry[][] {
	const usableEntries = entries.filter((entry) => !!entry.change);
	if (usableEntries.length === 0) return [];
	if (deliveryMode === 'digest') {
		return [usableEntries];
	}
	return usableEntries.map((entry) => [entry]);
}

// ---------------------------------------------------------------------------
// Push send helpers
// ---------------------------------------------------------------------------

export async function sendPushPayload(
	vapid: VapidKeys,
	subscription: WebPushSubscription,
	data: PushMessage['data'],
	topic: string,
): Promise<Response> {
	const message: PushMessage = {
		data,
		options: { ttl: 900, urgency: 'high', topic },
	};
	const payload = await buildPushPayload(message, subscription, vapid);
	return await fetch(subscription.endpoint, payload);
}

export async function sendPushForState(
	env: Env,
	vapid: VapidKeys,
	stateCode: string,
	stateChanges: AlertChangeRecord[],
	map: Record<string, any>,
	recordInvalidSub: (env: Env, reason: string) => Promise<void>,
	recordDeliveryFailure: (env: Env, input: { stateCode: string; subscriptionId?: string; status?: number; message: string }) => Promise<void>,
): Promise<void> {
	if (stateChanges.length === 0) return;
	const subscriptionIds = [
		...await readPushStateIndex(env, stateCode),
		...await readPushRadiusIndex(env),
	];
	const uniqueIds = [...new Set(subscriptionIds)];
	if (uniqueIds.length === 0) return;

	for (const subscriptionId of uniqueIds) {
		const record = await readPushSubscriptionRecordById(env, subscriptionId);
		if (!record) {
			await recordInvalidSub(
				env,
				`push_state_missing_record_${stateCode}_${subscriptionId.slice(0, 12)}`,
			);
			await Promise.all([
				removePushIdFromStateIndex(env, stateCode, subscriptionId),
				removePushIdFromRadiusIndex(env, subscriptionId),
			]);
			continue;
		}
		const hasRadiusScope = prefsHaveEnabledRadiusScopes(record.prefs);
		if (!record.indexedStateCodes.includes(stateCode) && !hasRadiusScope) {
			await recordInvalidSub(
				env,
				`push_state_stale_index_${stateCode}_${subscriptionId.slice(0, 12)}`,
			);
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
			continue;
		}
		if (!hasRadiusScope) {
			await removePushIdFromRadiusIndex(env, subscriptionId);
		}

		const prefs = record.prefs;
		const now = new Date();
		if (isDeliveryPaused(prefs, now)) {
			continue;
		}

		const matchingScopes = prefs.scopes.filter(
			(scope) =>
				scope.enabled
				&& (
					(scope.deliveryScope === 'radius' && pushScopeHasRadius(scope))
					|| normalizeStateCode(scope.stateCode) === stateCode
				),
		);
		if (matchingScopes.length === 0) {
			continue;
		}

		const isQuietHoursActive = isWithinQuietHours(now, prefs);
		const allowAllClearPush = shouldSendAllClearNotification(stateChanges);
		const matchingEntries: LifecyclePushEntry[] = [];
		for (const change of stateChanges) {
			if (change.changeType === 'all_clear') {
				if (!allowAllClearPush) continue;
				const stateScopeEnabled = matchingScopes.some((scope) => scope.deliveryScope === 'state');
				if (!stateScopeEnabled) continue;
				if (isQuietHoursActive) continue;
				matchingEntries.push({ change });
				continue;
			}

			if (change.changeType === 'expired') {
				if (prefs.deliveryMode !== 'digest') continue;
				if (!isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', ''))) {
					continue;
				}
				const matchedScope = matchingScopes.find((scope) => changeMatchesScope(change, scope));
				if (!matchedScope) continue;
				if (isQuietHoursActive) continue;
				matchingEntries.push({ change });
				continue;
			}

			const feature = map[change.alertId];
			if (!feature) continue;

			const matchedScope = matchingScopes.find((scope) =>
				featureMatchesScope(feature, stateCode, scope),
			);
			if (!matchedScope) continue;

			if (isQuietHoursActive && !alertBypassesQuietHours(feature)) {
				continue;
			}

			matchingEntries.push({ change, feature });
		}

		if (matchingEntries.length === 0) {
			continue;
		}

		const payloadBatches = batchLifecycleEntriesForDeliveryMode(
			prefs.deliveryMode,
			matchingEntries,
		);
		for (const [batchIndex, batch] of payloadBatches.entries()) {
			const payloadData = buildLifecyclePushMessageData(stateCode, batch);
			const firstChangeType = String(batch[0]?.change?.changeType || 'grouped');
			const topic =
				prefs.deliveryMode === 'digest'
					? `state-${stateCode}-digest`
					: `state-${stateCode}-${firstChangeType}-${batchIndex + 1}`;

			try {
				const response = await sendPushPayload(
					vapid,
					record.subscription,
					payloadData,
					topic,
				);

				if (response.status === 404 || response.status === 410) {
					await removePushSubscriptionById(env, subscriptionId);
					await recordInvalidSub(
						env,
						`push_endpoint_gone_${stateCode}_${response.status}`,
					);
					break;
				}
				if (!response.ok) {
					const body = await response.text().catch(() => '');
					await recordDeliveryFailure(env, {
						stateCode,
						subscriptionId,
						status: response.status,
						message: body || `push_send_failed_${response.status}`,
					});
					console.log(`[push] send failed state=${stateCode} status=${response.status} body=${body.slice(0, 240)}`);
				}
			} catch (err) {
				await recordDeliveryFailure(env, {
					stateCode,
					subscriptionId,
					message: String(err),
				});
				console.log(`[push] send exception state=${stateCode} err=${String(err)}`);
			}
		}
	}
}

export async function dispatchStatePushNotifications(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	recordInvalidSub: (env: Env, reason: string) => Promise<void>,
	recordDeliveryFailure: (env: Env, input: { stateCode: string; subscriptionId?: string; status?: number; message: string }) => Promise<void>,
): Promise<void> {
	const vapid = getVapidKeys(env);
	if (!vapid) return;
	if (changes.length === 0) {
		await writePushStateAlertSnapshot(env, buildStateAlertSnapshot(map));
		return;
	}

	const changesByState: Record<string, AlertChangeRecord[]> = {};
	for (const change of changes) {
		for (const stateCode of change.stateCodes) {
			if (!changesByState[stateCode]) changesByState[stateCode] = [];
			changesByState[stateCode].push(change);
		}
	}

	for (const [stateCode, stateChanges] of Object.entries(changesByState)) {
		await sendPushForState(env, vapid, stateCode, stateChanges, map, recordInvalidSub, recordDeliveryFailure);
	}

	await writePushStateAlertSnapshot(env, buildStateAlertSnapshot(map));
}
