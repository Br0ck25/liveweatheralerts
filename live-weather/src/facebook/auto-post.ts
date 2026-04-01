import type {
	Env,
	AlertChangeRecord,
	AlertThread,
	FacebookAutoPostDecision,
	AutoPostEvaluationRecord,
	FbAutoPostMode,
	FacebookPublishThreadAction,
} from '../types';
import {
	FB_AUTO_POST_MAX_ALERT_AGE_MS,
	FB_AUTO_POST_DUPLICATE_WINDOW_MS,
} from '../constants';
import {
	dedupeStrings,
	mapSomeValue,
	findProperty,
	extractFullCountyFipsCodes,
	deriveAlertImpactCategories,
} from '../utils';
import {
	isSevereThunderstormWarningEvent,
	isSevereWeatherFallbackEvent,
	matchingMetroNamesForAlert,
	highestPriorityMetroRank,
	readFbAutoPostConfig,
} from './config';
import {
	stormClusterFamilyForEvent,
	readExistingThreadForFeature,
	normalizeFacebookPublishThreadAction,
} from './threads';
import { publishFeatureToFacebook } from './api';
import { parseTimeMs } from '../alert-lifecycle';
import { markAlertStandaloneCovered, runDigestCoverage } from './digest';
import { generateDigestCopy } from './llm';

export { normalizeFacebookPublishThreadAction };

function isTornadoWarningEvent(event: string): boolean {
	return /\btornado warning\b/i.test(String(event || '').trim());
}

function isWarningEvent(event: string): boolean {
	return /\bwarning\b/i.test(String(event || '').trim());
}

export function threadIsRecentForAutoPost(thread: AlertThread | null, nowMs = Date.now()): boolean {
	if (!thread) return false;
	const lastPostedMs = Date.parse(String(thread.lastPostedAt || '').trim());
	if (!Number.isFinite(lastPostedMs)) {
		return true;
	}
	return (nowMs - lastPostedMs) <= FB_AUTO_POST_DUPLICATE_WINDOW_MS;
}

function autoPostTimestampMsForChange(feature: any, change: AlertChangeRecord): number | null {
	const properties = feature?.properties ?? {};
	const changeType = String(change.changeType || '').toLowerCase();
	const primaryTimestamp =
		changeType === 'updated' || changeType === 'extended'
			? properties.updated
			: properties.sent;
	const fallbackCandidates = [
		primaryTimestamp,
		properties.updated,
		properties.sent,
		properties.effective,
		change.changedAt,
	];

	for (const candidate of fallbackCandidates) {
		const parsed = parseTimeMs(String(candidate || ''));
		if (parsed != null) return parsed;
	}
	return null;
}

function isAutoPostCandidateActive(feature: any, nowMs = Date.now()): boolean {
	const expiry = feature?.properties?.ends ?? feature?.properties?.expires;
	const expiryMs = parseTimeMs(String(expiry || ''));
	if (expiryMs == null) return true;
	return expiryMs > nowMs;
}

function isAutoPostCandidateTimely(
	feature: any,
	change: AlertChangeRecord,
	nowMs = Date.now(),
): boolean {
	const timestampMs = autoPostTimestampMsForChange(feature, change);
	if (timestampMs == null) return true;
	return (nowMs - timestampMs) <= FB_AUTO_POST_MAX_ALERT_AGE_MS;
}

async function resolveAutoPostThreadAction(
	env: Env,
	feature: any,
	event: string,
	change?: AlertChangeRecord | null,
): Promise<FacebookPublishThreadAction> {
	const existingThread = await readExistingThreadForFeature(env, feature, event, change);
	return existingThread && !threadIsRecentForAutoPost(existingThread) ? 'new_post' : '';
}

export function parseAlertNumericValue(value: unknown): number | null {
	if (Array.isArray(value)) {
		for (const entry of value) {
			const parsed = parseAlertNumericValue(entry);
			if (parsed != null) return parsed;
		}
		return null;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
	if (!match) return null;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

export function hasSevereThunderstormDestructiveCriteria(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const maxWind = parseAlertNumericValue(findProperty(properties, 'maxWindGust'));
	if (maxWind != null && maxWind >= 70) return true;
	const maxHail = parseAlertNumericValue(findProperty(properties, 'maxHailSize'));
	if (maxHail != null && maxHail >= 2) return true;
	const text = [
		properties.event,
		properties.headline,
		properties.description,
		properties.instruction,
		findProperty(properties, 'damageThreat'),
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();
	return /\bdestructive\b/.test(text);
}

function hasSevereThunderstormStrongWording(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const text = [
		properties.event,
		properties.headline,
		properties.description,
		properties.instruction,
		findProperty(properties, 'damageThreat'),
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();
	return /\bconsiderable damage\b|\bdangerous storm\b|\bdangerous thunderstorm\b|\bconsiderable\b/.test(text);
}

export function hasSevereThunderstormNearThresholdMetrics(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const maxWind = parseAlertNumericValue(findProperty(properties, 'maxWindGust'));
	if (maxWind != null && maxWind >= 65) return true;
	const maxHail = parseAlertNumericValue(findProperty(properties, 'maxHailSize'));
	return maxHail != null && maxHail >= 1.75;
}

function hasFireFamilyEscalationCriteria(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const text = [
		properties.event,
		properties.headline,
		properties.description,
		properties.instruction,
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();
	return /\bevacuat(?:e|ion|ions|ed)\b|\bpublic safety\b|\blife safety\b|\bactive wildfire\b|\bwildfire impact\b|\bwildfire\b|\bstructures? threatened\b|\bhomes? threatened\b/.test(text);
}

function detectTierOneAutoPostReason(feature: any): string | null {
	const properties = feature?.properties ?? {};
	const event = String(properties.event || '').trim();
	const text = [
		event,
		properties.headline,
		properties.description,
		properties.instruction,
	]
		.map((value) => String(value || ''))
		.join(' ')
		.toLowerCase();

	if (/\btornado emergency\b/.test(text)) return 'tornado_emergency';
	if (/\bparticularly dangerous situation\b|\bpds tornado\b/.test(text)) return 'pds_tornado_warning';
	if (/\bflash flood emergency\b/.test(text)) return 'flash_flood_emergency';
	if (/\bhurricane\b/.test(text) && /\b(?:landfall|made landfall)\b/.test(text)) return 'hurricane_landfall';
	return null;
}

function autoPostChangePriority(changeType: string): number {
	const normalized = String(changeType || '').trim().toLowerCase();
	if (normalized === 'new') return 0;
	if (normalized === 'updated') return 1;
	if (normalized === 'extended') return 2;
	return 3;
}

function sortSevereWeatherFallbackCandidates(
	a: AutoPostEvaluationRecord,
	b: AutoPostEvaluationRecord,
): number {
	const aHasMetro = a.matchedMetroNames.length > 0 ? 1 : 0;
	const bHasMetro = b.matchedMetroNames.length > 0 ? 1 : 0;
	if (aHasMetro !== bHasMetro) return bHasMetro - aHasMetro;

	const aMetroRank = highestPriorityMetroRank(a.matchedMetroNames);
	const bMetroRank = highestPriorityMetroRank(b.matchedMetroNames);
	if (aMetroRank !== bMetroRank) return aMetroRank - bMetroRank;

	if (a.countyCount !== b.countyCount) return b.countyCount - a.countyCount;

	const aIsWarning = isSevereThunderstormWarningEvent(a.event) ? 1 : 0;
	const bIsWarning = isSevereThunderstormWarningEvent(b.event) ? 1 : 0;
	if (aIsWarning !== bIsWarning) return bIsWarning - aIsWarning;

	const changePriorityDiff = autoPostChangePriority(a.change.changeType) - autoPostChangePriority(b.change.changeType);
	if (changePriorityDiff !== 0) return changePriorityDiff;

	return String(a.change.alertId || a.feature?.id || '').localeCompare(String(b.change.alertId || b.feature?.id || ''));
}

function hasHigherTierAutoPostCompetition(record: AutoPostEvaluationRecord): boolean {
	return isTornadoWarningEvent(record.event) || detectTierOneAutoPostReason(record.feature) != null;
}

function isSevereWeatherFallbackCandidate(record: AutoPostEvaluationRecord): boolean {
	if (!isSevereWeatherFallbackEvent(record.event)) return false;
	if (!isAutoPostCandidateActive(record.feature)) return false;
	if (!isAutoPostCandidateTimely(record.feature, record.change)) return false;
	return record.matchedMetroNames.length > 0 || record.countyCount >= 10;
}

export function selectSevereWeatherFallbackCandidates(evaluations: AutoPostEvaluationRecord[]): {
	blockedByHigherTier: boolean;
	candidateAlertIds: Set<string>;
	selectedAlertIds: Set<string>;
} {
	const candidates = evaluations.filter((record) => isSevereWeatherFallbackCandidate(record));
	const candidateAlertIds = new Set(
		candidates
			.map((record) => String(record.change.alertId || record.feature?.id || ''))
			.filter(Boolean),
	);
	if (candidates.length < 2) {
		return {
			blockedByHigherTier: false,
			candidateAlertIds,
			selectedAlertIds: new Set<string>(),
		};
	}
	if (evaluations.some((record) => hasHigherTierAutoPostCompetition(record))) {
		return {
			blockedByHigherTier: true,
			candidateAlertIds,
			selectedAlertIds: new Set<string>(),
		};
	}

	return {
		blockedByHigherTier: false,
		candidateAlertIds,
		selectedAlertIds: new Set(
			[...candidates]
				.sort(sortSevereWeatherFallbackCandidates)
				.slice(0, 2)
				.map((record) => String(record.change.alertId || record.feature?.id || ''))
				.filter(Boolean),
		),
	};
}

// ---------------------------------------------------------------------------
// Core auto-post decision & orchestration
// ---------------------------------------------------------------------------

export async function evaluateFacebookAutoPostDecision(
	env: Env,
	mode: FbAutoPostMode,
	feature: any,
	change: AlertChangeRecord,
): Promise<FacebookAutoPostDecision> {
	const event = String(feature?.properties?.event || change.event || '').trim();
	const properties = feature?.properties ?? {};
	const countyCount = Math.max(
		extractFullCountyFipsCodes(feature, change).length,
		dedupeStrings((change.countyCodes || []).map((countyCode) => String(countyCode || '').trim())).length,
	);
	const matchedMetroNames = matchingMetroNamesForAlert(feature, change);
	const impactCategories = deriveAlertImpactCategories(
		event,
		String(properties.headline || ''),
		String(properties.description || ''),
	);
	const noDecision = (
		reason: string,
		threadAction: FacebookPublishThreadAction = '',
	): FacebookAutoPostDecision => ({
		eligible: false,
		threadAction,
		reason,
		mode,
		matchedMetroNames,
		countyCount,
	});

	if (mode === 'off') return noDecision('mode_off');
	if (!isWarningEvent(event)) return noDecision('not_warning');
	if (
		change.changeType !== 'new'
		&& change.changeType !== 'updated'
		&& change.changeType !== 'extended'
	) {
		return noDecision('change_not_postable');
	}
	if (!isAutoPostCandidateActive(feature)) return noDecision('inactive_or_expired');
	if (!isAutoPostCandidateTimely(feature, change)) return noDecision('stale_alert');

	const threadAction = await resolveAutoPostThreadAction(env, feature, event, change);

	if (mode === 'tornado_only') {
		if (!isTornadoWarningEvent(event)) return noDecision('mode_tornado_only_non_tornado', threadAction);
		return {
			eligible: true,
			threadAction,
			reason: 'all_tornado_warnings',
			mode,
			matchedMetroNames,
			countyCount,
		};
	}

	if (isTornadoWarningEvent(event)) {
		return {
			eligible: true,
			threadAction,
			reason: 'all_tornado_warnings',
			mode,
			matchedMetroNames,
			countyCount,
		};
	}

	const tierOneReason = detectTierOneAutoPostReason(feature);
	if (tierOneReason) {
		return {
			eligible: true,
			threadAction,
			reason: tierOneReason,
			mode,
			matchedMetroNames,
			countyCount,
		};
	}

	if (impactCategories.includes('fire')) {
		if (!hasFireFamilyEscalationCriteria(feature)) {
			return noDecision('fire_family_not_escalated', threadAction);
		}
		return {
			eligible: true,
			threadAction,
			reason: 'fire_family_escalation',
			mode,
			matchedMetroNames,
			countyCount,
		};
	}

	const passesBaseImpactGate = matchedMetroNames.length > 0 || countyCount >= 10;
	if (!passesBaseImpactGate) {
		return noDecision('impact_gate_not_met', threadAction);
	}

	if (isSevereThunderstormWarningEvent(event)) {
		const meetsPrimaryCriteria = hasSevereThunderstormDestructiveCriteria(feature);
		const meetsSoftCriteria = hasSevereThunderstormStrongWording(feature)
			|| (matchedMetroNames.length > 0 && hasSevereThunderstormNearThresholdMetrics(feature));
		if (!meetsPrimaryCriteria && !meetsSoftCriteria) {
			return noDecision('severe_thunderstorm_below_threshold', threadAction);
		}
	}

	return {
		eligible: true,
		threadAction,
		reason: matchedMetroNames.length > 0 ? 'major_metro_warning' : 'ten_county_warning',
		mode,
		matchedMetroNames,
		countyCount,
	};
}

export async function selectSevereWeatherFallbackOverrides(
	env: Env,
	evaluations: AutoPostEvaluationRecord[],
): Promise<Map<string, FacebookAutoPostDecision>> {
	const overrides = new Map<string, FacebookAutoPostDecision>();
	const fallbackSelection = selectSevereWeatherFallbackCandidates(evaluations);
	if (fallbackSelection.selectedAlertIds.size === 0) return overrides;

	for (const record of evaluations.filter((entry) => fallbackSelection.candidateAlertIds.has(String(entry.change.alertId || entry.feature?.id || '')))) {
		const alertId = String(record.change.alertId || record.feature?.id || '');
		if (!alertId) continue;
		if (fallbackSelection.selectedAlertIds.has(alertId)) {
			if (!record.decision.eligible) {
				overrides.set(alertId, {
					...record.decision,
					eligible: true,
					threadAction: record.decision.threadAction || await resolveAutoPostThreadAction(env, record.feature, record.event, record.change),
					reason: 'severe_weather_fallback',
				});
			}
			continue;
		}

		overrides.set(alertId, {
			...record.decision,
			eligible: false,
			threadAction: record.decision.threadAction || await resolveAutoPostThreadAction(env, record.feature, record.event, record.change),
			reason: 'severe_weather_fallback_not_selected',
		});
	}

	return overrides;
}

function autoPostDecisionRank(decision: FacebookAutoPostDecision, event: string): number {
	if (decision.reason === 'all_tornado_warnings') return 0;
	if (
		decision.reason === 'tornado_emergency'
		|| decision.reason === 'pds_tornado_warning'
		|| decision.reason === 'flash_flood_emergency'
		|| decision.reason === 'hurricane_landfall'
	) {
		return 1;
	}
	if (decision.reason === 'fire_family_escalation') return 2;
	if (isSevereWeatherFallbackEvent(event)) return 3;
	if (decision.reason === 'major_metro_warning') return 4;
	if (decision.reason === 'ten_county_warning') return 5;
	if (decision.reason === 'severe_weather_fallback') return 6;
	return 7;
}

function sortAutoPostEvaluationsForPublishing(
	a: AutoPostEvaluationRecord,
	b: AutoPostEvaluationRecord,
	overrides: Map<string, FacebookAutoPostDecision>,
): number {
	const aAlertId = String(a.change.alertId || a.feature?.id || '');
	const bAlertId = String(b.change.alertId || b.feature?.id || '');
	const aDecision = overrides.get(aAlertId) || a.decision;
	const bDecision = overrides.get(bAlertId) || b.decision;

	const aSevereCluster = stormClusterFamilyForEvent(a.event);
	const bSevereCluster = stormClusterFamilyForEvent(b.event);
	if (aSevereCluster && bSevereCluster) {
		const severeSort = sortSevereWeatherFallbackCandidates(a, b);
		if (severeSort !== 0) return severeSort;
	}

	const decisionRankDiff = autoPostDecisionRank(aDecision, a.event) - autoPostDecisionRank(bDecision, b.event);
	if (decisionRankDiff !== 0) return decisionRankDiff;

	const changePriorityDiff = autoPostChangePriority(a.change.changeType) - autoPostChangePriority(b.change.changeType);
	if (changePriorityDiff !== 0) return changePriorityDiff;

	if (a.countyCount !== b.countyCount) return b.countyCount - a.countyCount;

	return aAlertId.localeCompare(bAlertId);
}

export async function autoPostFacebookAlerts(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
): Promise<void> {
	const config = await readFbAutoPostConfig(env);
	if (config.mode === 'off') return;
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		console.warn(`[fb-auto-post] ${config.mode} mode is enabled but Facebook credentials are missing.`);
		return;
	}

	const relevantChanges = changes.filter((change) =>
		change.changeType === 'new'
		|| change.changeType === 'updated'
		|| change.changeType === 'extended',
	);
	if (relevantChanges.length === 0) return;

	const evaluations: AutoPostEvaluationRecord[] = [];
	for (const change of relevantChanges) {
		const feature =
			map[change.alertId]
			|| Object.values(map).find((candidate: any) => String(candidate?.id ?? '') === change.alertId);
		if (!feature) continue;

		const decision = await evaluateFacebookAutoPostDecision(env, config.mode, feature, change);
		evaluations.push({
			feature,
			change,
			decision,
			event: String(feature?.properties?.event || change.event || '').trim(),
			matchedMetroNames: decision.matchedMetroNames,
			countyCount: decision.countyCount,
		});
	}

	const severeWeatherFallbackOverrides = config.mode === 'smart_high_impact'
		? await selectSevereWeatherFallbackOverrides(env, evaluations)
		: new Map<string, FacebookAutoPostDecision>();

	const orderedEvaluations = [...evaluations].sort((a, b) =>
		sortAutoPostEvaluationsForPublishing(a, b, severeWeatherFallbackOverrides),
	);

	for (const evaluation of orderedEvaluations) {
		const alertId = String(evaluation.change.alertId || evaluation.feature?.id || '');
		const decision = severeWeatherFallbackOverrides.get(alertId) || evaluation.decision;
		if (!decision.eligible) {
			console.log(
				`[fb-auto-post] skipped ${evaluation.change.alertId} event="${String(evaluation.feature?.properties?.event || evaluation.change.event || '')}" reason=${decision.reason}`,
			);
			continue;
		}

		try {
			const result = await publishFeatureToFacebook(env, evaluation.feature, {
				threadAction: decision.threadAction,
			});
			// Mark this alert as covered by a standalone post so it is excluded from digests
			await markAlertStandaloneCovered(env, evaluation.change.alertId);
			const metroLabel = decision.matchedMetroNames.length > 0
				? ` metros=${decision.matchedMetroNames.join('|')}`
				: '';
			console.log(
				`[fb-auto-post] ${result.status} ${evaluation.change.alertId} mode=${decision.mode} reason=${decision.reason} change=${evaluation.change.changeType} counties=${decision.countyCount}${metroLabel} post=${result.postId}`,
			);
		} catch (err) {
			console.error(
				`[fb-auto-post] failed for ${evaluation.change.alertId} mode=${decision.mode} reason=${decision.reason}: ${String(err)}`,
			);
		}
	}

	// Run digest coverage when smart_high_impact and digestCoverageEnabled
	if (config.mode === 'smart_high_impact' && config.digestCoverageEnabled) {
		try {
			await runDigestCoverage(env, map, generateDigestCopy);
		} catch (err) {
			console.error(`[fb-digest] digest coverage failed: ${String(err)}`);
		}
	}
}
