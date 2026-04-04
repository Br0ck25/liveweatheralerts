import type {
	Env,
	AlertChangeRecord,
	AlertThread,
	FacebookAutoPostDecision,
	FacebookPublishResult,
	AutoPostEvaluationRecord,
	FbAutoPostMode,
	FacebookPublishThreadAction,
	SpcOutlookSummary,
	SpcThreadRecord,
	FacebookCoverageEvaluation,
	FacebookCoverageIntent,
} from '../types';
import {
	FB_AUTO_POST_MAX_ALERT_AGE_MS,
	FB_AUTO_POST_DUPLICATE_WINDOW_MS,
	FB_AUTO_POST_STANDALONE_MAX_POSTS_PER_HOUR,
	KV_FB_ALERT_STANDALONE_POST_HISTORY,
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
import { markAlertStandaloneCovered } from './digest';
import { assessAlertThreadUpdate } from './text';
import {
	buildSpcDay1WatchCommentText,
	readLastSpcDay1Summary,
	readSpcThreadRecord,
	recordSpcThreadCommentActivity,
	spcSummaryOverlapStates,
} from './spc-v2';

export { normalizeFacebookPublishThreadAction };

type AutoPostHazardClusterFamily = 'wind' | 'flood' | 'winter' | 'fire_weather';

type AutoPostHazardClusterCandidate = AutoPostEvaluationRecord & {
	finalDecision: FacebookAutoPostDecision;
	clusterFamily: AutoPostHazardClusterFamily;
	senderOffice: string;
	stateCode: string;
	windowStartMs: number;
	windowEndMs: number;
	timestampMs: number | null;
	anchorScore: number;
	normalizedMetroNames: string[];
};

type AutoPostHazardClusterPlan = {
	id: string;
	family: AutoPostHazardClusterFamily;
	senderOffice: string;
	stateCode: string;
	anchor: AutoPostHazardClusterCandidate;
	members: AutoPostHazardClusterCandidate[];
};

type TornadoWatchSpcCommentPlan = {
	evaluation: AutoPostEvaluationRecord;
	decision: FacebookAutoPostDecision;
	threadTarget: AlertThread;
	customMessage: string;
	spcPostId: string;
};

type AutoPostStandaloneHistoryRecord = {
	postTimestamps: string[];
	updatedAt: string;
};

type AutoPostPublishOutcome = {
	thread: AlertThread | null;
	status: FacebookPublishResult['status'];
};

type AutoPostExecutionBundle = {
	config: Awaited<ReturnType<typeof readFbAutoPostConfig>>;
	relevantChanges: AlertChangeRecord[];
	evaluations: AutoPostEvaluationRecord[];
	severeWeatherFallbackOverrides: Map<string, FacebookAutoPostDecision>;
	tornadoWatchSpcCommentPlans: Map<string, TornadoWatchSpcCommentPlan>;
	hazardClusterPlans: AutoPostHazardClusterPlan[];
	orderedEvaluations: AutoPostEvaluationRecord[];
};

type AutoPostHourlyCapAction = {
	skip: boolean;
	threadAction?: FacebookPublishThreadAction;
	threadTarget?: AlertThread | null;
	logLabel?: string;
};

const AUTO_POST_CLUSTER_WINDOW_MATCH_MS = 2 * 60 * 60 * 1000;
const AUTO_POST_CLUSTER_AREA_PART_LIMIT = 3;
const AUTO_POST_STANDALONE_WINDOW_MS = 60 * 60 * 1000;
const AUTO_POST_STANDALONE_HISTORY_TTL_SECONDS = 2 * 60 * 60;
const AUTO_POST_WIDESPREAD_COUNTY_THRESHOLD = 10;
const AUTO_POST_HIGH_WIND_WARNING_MPH = 60;
const AUTO_POST_WIDESPREAD_WIND_MPH = 70;
const AUTO_POST_SEVERE_METRO_WIND_MPH = 65;
const AUTO_POST_SEVERE_REGIONAL_WIND_MPH = 70;
const AUTO_POST_SEVERE_METRO_HAIL_IN = 1.75;
const AUTO_POST_SEVERE_REGIONAL_HAIL_IN = 2;
const AUTO_POST_HIGH_SNOW_IN = 8;
const AUTO_POST_SIGNIFICANT_ICE_IN = 0.25;
const AUTO_POST_NUMERIC_CONTEXT_DISTANCE = 48;
const TIER_ONE_AUTO_POST_REASONS = new Set([
	'all_tornado_warnings',
	'tornado_emergency',
	'pds_tornado_warning',
	'flash_flood_emergency',
	'hurricane_landfall',
	'hurricane_warning',
	'storm_surge_warning',
	'extreme_wind_warning',
	'fire_family_escalation',
]);

function normalizeAutoPostEvent(event: string): string {
	return String(event || '').trim().toLowerCase();
}

function buildAutoPostAlertText(feature: any): string {
	const properties = feature?.properties ?? {};
	return [
		properties.event,
		properties.headline,
		properties.description,
		properties.instruction,
		properties.areaDesc,
		findProperty(properties, 'damageThreat'),
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();
}

function hasLargePopulationExposure(matchedMetroNames: string[]): boolean {
	return matchedMetroNames.length > 0;
}

function hasWidespreadCoverage(countyCount: number): boolean {
	return countyCount >= AUTO_POST_WIDESPREAD_COUNTY_THRESHOLD;
}

function maxCapturedNumber(match: RegExpMatchArray): number | null {
	const values = match
		.slice(1)
		.map((value) => Number(value))
		.filter((value) => Number.isFinite(value));
	if (values.length === 0) return null;
	return Math.max(...values);
}

function extractMaxContextualAmount(
	text: string,
	keywordPattern: string,
	unitPattern: string,
): number | null {
	const matches: number[] = [];
	const patterns = [
		new RegExp(`(?:${keywordPattern})[^\\d]{0,${AUTO_POST_NUMERIC_CONTEXT_DISTANCE}}(\\d+(?:\\.\\d+)?)\\s*(?:to|-|–)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})`, 'gi'),
		new RegExp(`(?:${keywordPattern})[^\\d]{0,${AUTO_POST_NUMERIC_CONTEXT_DISTANCE}}(?:up to\\s*)?(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})`, 'gi'),
		new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:to|-|–)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})[^.\\n]{0,${AUTO_POST_NUMERIC_CONTEXT_DISTANCE}}(?:${keywordPattern})`, 'gi'),
		new RegExp(`(?:up to\\s*)?(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})[^.\\n]{0,${AUTO_POST_NUMERIC_CONTEXT_DISTANCE}}(?:${keywordPattern})`, 'gi'),
	];

	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) {
			const maxValue = maxCapturedNumber(match);
			if (maxValue != null) matches.push(maxValue);
		}
	}

	if (matches.length === 0) return null;
	return Math.max(...matches);
}

function extractAlertSnowAmountInches(feature: any): number | null {
	const properties = feature?.properties ?? {};
	const direct = [
		findProperty(properties, 'totalSnowfall'),
		findProperty(properties, 'snowfallAmount'),
		findProperty(properties, 'snowAccumulation'),
		findProperty(properties, 'snowAmount'),
		findProperty(properties, 'maxSnowAmount'),
	];
	for (const candidate of direct) {
		const parsed = parseAlertNumericValue(candidate);
		if (parsed != null) return parsed;
	}
	return extractMaxContextualAmount(
		buildAutoPostAlertText(feature),
		'snow(?:fall)?|snow accum(?:ulation|ulations)?|snow amounts?',
		'inches?|inch|"',
	);
}

function extractAlertIceAmountInches(feature: any): number | null {
	const properties = feature?.properties ?? {};
	const direct = [
		findProperty(properties, 'iceAccumulation'),
		findProperty(properties, 'maxIceAccumulation'),
		findProperty(properties, 'freezingRainAmount'),
		findProperty(properties, 'iceAmount'),
	];
	for (const candidate of direct) {
		const parsed = parseAlertNumericValue(candidate);
		if (parsed != null) return parsed;
	}
	return extractMaxContextualAmount(
		buildAutoPostAlertText(feature),
		'ice|icing|freezing rain|glaze',
		'inches?|inch|"',
	);
}

function extractAlertWindMph(feature: any): number | null {
	const properties = feature?.properties ?? {};
	const direct = parseAlertNumericValue(findProperty(properties, 'maxWindGust'));
	if (direct != null) return direct;
	return extractMaxContextualAmount(
		buildAutoPostAlertText(feature),
		'wind(?:s| gusts?)?|gusts?',
		'mph|miles? per hour',
	);
}

function extractAlertHailInches(feature: any): number | null {
	const properties = feature?.properties ?? {};
	const direct = parseAlertNumericValue(findProperty(properties, 'maxHailSize'));
	if (direct != null) return direct;
	return extractMaxContextualAmount(
		buildAutoPostAlertText(feature),
		'hail',
		'inches?|inch|"',
	);
}

function hasWinterStandaloneSignal(feature: any): boolean {
	const text = buildAutoPostAlertText(feature);
	const snowAmount = extractAlertSnowAmountInches(feature);
	if (snowAmount != null && snowAmount >= AUTO_POST_HIGH_SNOW_IN) return true;
	const iceAmount = extractAlertIceAmountInches(feature);
	if (iceAmount != null && iceAmount >= AUTO_POST_SIGNIFICANT_ICE_IN) return true;
	return /\bblizzard\b|\bwhiteout\b|\bnear zero visibility\b|\bdangerous travel\b|\bhazardous travel\b|\btravel could become impossible\b|\bheavy snow\b|\bsignificant icing\b|\bice accumulation\b|\bfreezing rain\b/.test(text);
}

function hasStrongWindImpactWording(feature: any): boolean {
	return /\bpower outages?\b|\bdowned trees?\b|\btree damage\b|\broof damage\b|\bstructural damage\b|\bdestructive winds?\b|\bdifficult travel\b|\bhigh-profile vehicles\b|\bblowing dust\b|\breduced visibility\b/.test(buildAutoPostAlertText(feature));
}

function hasHighWindStandaloneSignal(
	feature: any,
	countyCount: number,
	matchedMetroNames: string[],
): boolean {
	const maxWind = extractAlertWindMph(feature);
	if (maxWind != null && maxWind >= AUTO_POST_WIDESPREAD_WIND_MPH) return true;
	if ((hasLargePopulationExposure(matchedMetroNames) || hasWidespreadCoverage(countyCount)) && maxWind != null && maxWind >= AUTO_POST_HIGH_WIND_WARNING_MPH) {
		return true;
	}
	return hasStrongWindImpactWording(feature);
}

function hasSignificantFlooding(feature: any): boolean {
	return /\blife-threatening\b|\bmajor flooding\b|\bconsiderable flood damage\b|\bwater rescues?\b|\bevacuat(?:e|ion|ions|ed)\b|\bhomes? threatened\b|\bstructures? threatened\b|\broad closures?\b|\broads? flooded\b|\bwater over roads?\b|\bflooding is occurring\b|\brapid rises?\b|\bcreeks? and streams? rising\b|\bcommunities flooded\b/.test(buildAutoPostAlertText(feature));
}

function isTierThreeMinorStandaloneWarning(event: string): boolean {
	return event === 'freeze warning' || event === 'hard freeze warning';
}

function isTierTwoWinterWarningEvent(event: string): boolean {
	return event === 'winter storm warning' || event === 'ice storm warning' || event === 'blizzard warning';
}

function isHighWindWarningEvent(event: string): boolean {
	return event === 'high wind warning';
}

function isTierTwoFloodWarningEvent(event: string): boolean {
	return event === 'flood warning' || event === 'flash flood warning';
}

function isStandalonePostCapExempt(reason: string): boolean {
	return TIER_ONE_AUTO_POST_REASONS.has(reason);
}

function isTornadoWarningEvent(event: string): boolean {
	return /\btornado warning\b/i.test(String(event || '').trim());
}

function isTornadoWatchEvent(event: string): boolean {
	return /\btornado watch\b/i.test(String(event || '').trim());
}

function isWarningEvent(event: string): boolean {
	return /\bwarning\b/i.test(String(event || '').trim());
}

export function autoPostHazardClusterFamilyForEvent(event: string): AutoPostHazardClusterFamily | null {
	const normalized = String(event || '').trim().toLowerCase();
	if (normalized === 'high wind warning' || normalized === 'wind advisory' || normalized === 'wind watch') {
		return 'wind';
	}
	if (normalized === 'flood warning' || normalized === 'flood advisory' || normalized === 'flood watch') {
		return 'flood';
	}
	if (
		normalized === 'winter storm warning'
		|| normalized === 'winter weather advisory'
		|| normalized === 'ice storm warning'
		|| normalized === 'blizzard warning'
	) {
		return 'winter';
	}
	if (normalized === 'red flag warning' || normalized === 'fire weather watch') {
		return 'fire_weather';
	}
	return null;
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

function resolveSpcThreadSummary(
	thread: SpcThreadRecord,
	fallbackSummary: SpcOutlookSummary | null,
): SpcOutlookSummary | null {
	if (thread.summary) return thread.summary;
	if (!fallbackSummary) return null;
	if (thread.hash && fallbackSummary.summaryHash && thread.hash !== fallbackSummary.summaryHash) {
		return null;
	}
	return fallbackSummary;
}

function tornadoWatchFallsWithinSpcDay1Window(
	feature: any,
	change: AlertChangeRecord,
	summary: SpcOutlookSummary,
): boolean {
	const timestampMs = autoPostTimestampMsForChange(feature, change)
		?? parseTimeMs(String(change.changedAt || ''));
	if (timestampMs == null) return true;
	const validFromMs = parseTimeMs(String(summary.validFrom || summary.issuedAt || ''));
	if (validFromMs != null && timestampMs < validFromMs) return false;
	const validToMs = parseTimeMs(String(summary.validTo || ''));
	if (validToMs != null && timestampMs > validToMs) return false;
	return true;
}

function hasActiveHigherPriorityTornadoCoverage(
	map: Record<string, any>,
	excludedAlertId: string,
): boolean {
	return Object.entries(map).some(([mapAlertId, feature]) => {
		const featureAlertId = String(feature?.id || '');
		if (mapAlertId === excludedAlertId || featureAlertId === excludedAlertId) return false;
		if (!isAutoPostCandidateActive(feature)) return false;
		const event = String(feature?.properties?.event || '').trim();
		if (isTornadoWarningEvent(event)) return true;
		const tierOneReason = detectTierOneAutoPostReason(feature);
		return tierOneReason === 'tornado_emergency' || tierOneReason === 'pds_tornado_warning';
	});
}

function buildAlertThreadFromSpcThread(
	thread: SpcThreadRecord,
	summary: SpcOutlookSummary,
): AlertThread {
	const expiresMs = parseTimeMs(String(summary.validTo || ''));
	return {
		postId: thread.postId,
		nwsAlertId: 'spc-day1',
		expiresAt: expiresMs != null ? Math.floor(expiresMs / 1000) : 0,
		county: String(summary.stateFocusText || summary.primaryRegion || 'SPC Day 1 coverage'),
		alertType: 'SPC Day 1 Outlook',
		updateCount: Math.max(0, Number(thread.commentCount || 0)),
		lastPostedAt: thread.lastCommentAt || thread.publishedAt,
		lastPostedSnapshot: null,
	};
}

async function buildTornadoWatchSpcCommentPlans(
	env: Env,
	mode: FbAutoPostMode,
	map: Record<string, any>,
	evaluations: AutoPostEvaluationRecord[],
	nowMs = Date.now(),
): Promise<Map<string, TornadoWatchSpcCommentPlan>> {
	const plans = new Map<string, TornadoWatchSpcCommentPlan>();
	if (mode !== 'smart_high_impact') return plans;

	const spcThread = await readSpcThreadRecord(env, 1);
	if (!spcThread?.postId) return plans;
	const fallbackSummary = await readLastSpcDay1Summary(env);
	const summary = resolveSpcThreadSummary(spcThread, fallbackSummary);
	if (!summary || summary.outlookDay !== 1) return plans;

	for (const evaluation of evaluations) {
		const alertId = String(evaluation.change.alertId || evaluation.feature?.id || '');
		if (!alertId || !isTornadoWatchEvent(evaluation.event)) continue;
		if (!isAutoPostCandidateActive(evaluation.feature)) continue;
		if (!isAutoPostCandidateTimely(evaluation.feature, evaluation.change, nowMs)) continue;
		if (!tornadoWatchFallsWithinSpcDay1Window(evaluation.feature, evaluation.change, summary)) continue;
		const overlapStates = spcSummaryOverlapStates(summary, evaluation.change.stateCodes || []);
		if (overlapStates.length === 0) continue;
		if (hasActiveHigherPriorityTornadoCoverage(map, alertId)) continue;

		const existingThread = await readExistingThreadForFeature(env, evaluation.feature, evaluation.event, evaluation.change);
		const threadTarget = existingThread?.postId === spcThread.postId
			? existingThread
			: buildAlertThreadFromSpcThread(spcThread, summary);

		plans.set(alertId, {
			evaluation,
			decision: {
				...evaluation.decision,
				eligible: true,
				threadAction: 'comment',
				reason: 'spc_day1_tornado_watch_comment',
			},
			threadTarget,
			customMessage: buildSpcDay1WatchCommentText(summary, overlapStates, {
				watchLabel: evaluation.event,
				changeType: evaluation.change.changeType,
				expiresAt: String(evaluation.feature?.properties?.expires || evaluation.feature?.properties?.ends || ''),
				nowMs,
			}),
			spcPostId: spcThread.postId,
		});
	}

	return plans;
}

async function resolveAutoPostThreadAction(
	env: Env,
	feature: any,
	event: string,
	change?: AlertChangeRecord | null,
): Promise<FacebookPublishThreadAction> {
	const existingThread = await readExistingThreadForFeature(env, feature, event, change);
	if (!existingThread) return '';
	if (threadIsRecentForAutoPost(existingThread)) return '';

	const updateAssessment = assessAlertThreadUpdate(feature?.properties ?? {}, existingThread.lastPostedSnapshot ?? null, {
		previousExpiresAtSeconds: existingThread.expiresAt,
	});
	if (updateAssessment.shouldSkip) return '';
	if (
		updateAssessment.sameOffice
		&& !updateAssessment.areaChanged
		&& !updateAssessment.severityChanged
		&& !updateAssessment.textChanged
	) {
		return '';
	}
	return 'new_post';
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
	if (/\bextreme wind warning\b/.test(text)) return 'extreme_wind_warning';
	if (/\bstorm surge warning\b/.test(text)) return 'storm_surge_warning';
	if (/\bhurricane warning\b/.test(text)) return 'hurricane_warning';
	if (/\bhurricane\b/.test(text) && /\b(?:landfall|made landfall)\b/.test(text)) return 'hurricane_landfall';
	return null;
}

export function evaluateSmartHighImpactStandaloneSignal(
	feature: any,
	change: AlertChangeRecord,
	nowMs = Date.now(),
): Pick<FacebookAutoPostDecision, 'eligible' | 'reason' | 'matchedMetroNames' | 'countyCount'> {
	const event = String(feature?.properties?.event || change.event || '').trim();
	const normalizedEvent = normalizeAutoPostEvent(event);
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
	const noSignal = (reason: string): Pick<FacebookAutoPostDecision, 'eligible' | 'reason' | 'matchedMetroNames' | 'countyCount'> => ({
		eligible: false,
		reason,
		matchedMetroNames,
		countyCount,
	});
	const yesSignal = (reason: string): Pick<FacebookAutoPostDecision, 'eligible' | 'reason' | 'matchedMetroNames' | 'countyCount'> => ({
		eligible: true,
		reason,
		matchedMetroNames,
		countyCount,
	});

	if (!isWarningEvent(event)) return noSignal('not_warning');
	if (!isAutoPostCandidateActive(feature, nowMs)) return noSignal('inactive_or_expired');
	if (!isAutoPostCandidateTimely(feature, change, nowMs)) return noSignal('stale_alert');

	if (isTornadoWarningEvent(event)) return yesSignal('all_tornado_warnings');

	const tierOneReason = detectTierOneAutoPostReason(feature);
	if (tierOneReason) return yesSignal(tierOneReason);

	if (impactCategories.includes('fire')) {
		if (!hasFireFamilyEscalationCriteria(feature)) return noSignal('fire_family_not_escalated');
		return yesSignal('fire_family_escalation');
	}

	if (isTierThreeMinorStandaloneWarning(normalizedEvent)) {
		return noSignal('tier3_minor_hazard');
	}

	const hasPopulationExposure = hasLargePopulationExposure(matchedMetroNames);
	const hasRegionalCoverage = hasWidespreadCoverage(countyCount);

	if (isSevereThunderstormWarningEvent(event)) {
		if (!hasPopulationExposure && !hasRegionalCoverage) {
			return noSignal('severe_thunderstorm_needs_population_or_coverage');
		}
		const maxWind = extractAlertWindMph(feature);
		const hailSize = extractAlertHailInches(feature);
		const qualifiesFromDestructiveSignal = hasSevereThunderstormDestructiveCriteria(feature);
		const qualifiesFromMetroThreshold = hasPopulationExposure && (
			(maxWind != null && maxWind >= AUTO_POST_SEVERE_METRO_WIND_MPH)
			|| (hailSize != null && hailSize >= AUTO_POST_SEVERE_METRO_HAIL_IN)
			|| hasSevereThunderstormStrongWording(feature)
		);
		const qualifiesFromRegionalThreshold = hasRegionalCoverage && (
			(maxWind != null && maxWind >= AUTO_POST_SEVERE_REGIONAL_WIND_MPH)
			|| (hailSize != null && hailSize >= AUTO_POST_SEVERE_REGIONAL_HAIL_IN)
			|| hasSevereThunderstormStrongWording(feature)
		);
		if (!qualifiesFromDestructiveSignal && !qualifiesFromMetroThreshold && !qualifiesFromRegionalThreshold) {
			return noSignal('severe_thunderstorm_below_threshold');
		}
		return yesSignal('tier2_severe_thunderstorm_warning');
	}

	if (isHighWindWarningEvent(normalizedEvent)) {
		if (!hasPopulationExposure && !hasRegionalCoverage) {
			return noSignal('high_wind_warning_needs_population_or_coverage');
		}
		if (!hasHighWindStandaloneSignal(feature, countyCount, matchedMetroNames)) {
			return noSignal('high_wind_warning_below_threshold');
		}
		return yesSignal('tier2_high_wind_warning');
	}

	if (isTierTwoWinterWarningEvent(normalizedEvent)) {
		if (!hasPopulationExposure && !hasRegionalCoverage) {
			return noSignal('winter_warning_needs_population_or_coverage');
		}
		if (!hasWinterStandaloneSignal(feature)) {
			return noSignal('winter_warning_below_threshold');
		}
		return yesSignal('tier2_winter_warning');
	}

	if (isTierTwoFloodWarningEvent(normalizedEvent)) {
		if (!hasPopulationExposure && !hasRegionalCoverage) {
			return noSignal('flood_warning_needs_population_or_coverage');
		}
		if (!hasSignificantFlooding(feature)) {
			return noSignal('flood_warning_below_threshold');
		}
		return yesSignal('tier2_flood_warning');
	}

	return noSignal('tier3_minor_hazard');
}

function autoPostChangePriority(changeType: string): number {
	const normalized = String(changeType || '').trim().toLowerCase();
	if (normalized === 'new') return 0;
	if (normalized === 'updated') return 1;
	if (normalized === 'extended') return 2;
	return 3;
}

function normalizeClusterMetroNames(metroNames: string[]): string[] {
	return dedupeStrings(
		metroNames
			.map((metroName) => String(metroName || '').trim().toLowerCase())
			.filter(Boolean),
	).sort();
}

function joinReadableList(values: string[]): string {
	const clean = dedupeStrings(values.map((value) => String(value || '').trim()).filter(Boolean));
	if (clean.length === 0) return '';
	if (clean.length === 1) return clean[0];
	if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
	return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function eventTierRank(event: string): number {
	const normalized = String(event || '').trim().toLowerCase();
	if (/warning$/.test(normalized)) return 3;
	if (/advisory$/.test(normalized)) return 2;
	if (/watch$/.test(normalized)) return 1;
	return 0;
}

function severityWeight(severity: unknown): number {
	const normalized = String(severity || '').trim().toLowerCase();
	if (normalized === 'extreme') return 35;
	if (normalized === 'severe') return 25;
	if (normalized === 'moderate') return 15;
	if (normalized === 'minor') return 8;
	return 0;
}

function geographyClarityWeight(record: AutoPostEvaluationRecord): number {
	const areaDesc = String(record.feature?.properties?.areaDesc || '').trim();
	let score = 0;
	if (record.matchedMetroNames.length > 0) {
		score += 18;
	}
	if (areaDesc && areaDesc.length <= 80) {
		score += 10;
	} else if (areaDesc) {
		score += 4;
	}
	if (record.countyCount >= 5) {
		score += 6;
	}
	return score;
}

function familyImpactWeight(family: AutoPostHazardClusterFamily, feature: any): number {
	const properties = feature?.properties ?? {};
	const text = [
		properties.headline,
		properties.description,
		properties.instruction,
		findProperty(properties, 'damageThreat'),
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();

	if (family === 'wind') {
		const maxWind = parseAlertNumericValue(findProperty(properties, 'maxWindGust'));
		let score = maxWind != null ? Math.max(0, Math.min(45, Math.round(maxWind) - 40)) : 0;
		if (/power outages?|tree damage|downed trees?|damage to roofs?|destructive/.test(text)) score += 18;
		if (/travel.*difficult|high-profile vehicles|blowing dust/.test(text)) score += 10;
		return score;
	}

	if (family === 'flood') {
		let score = severityWeight(properties.severity);
		if (/road closures?|roads? flooded|water over roads?|rapid rises?|flooding is occurring|life-threatening/.test(text)) score += 20;
		if (/evacuat|rescues?|structures? threatened/.test(text)) score += 20;
		return score;
	}

	if (family === 'winter') {
		let score = severityWeight(properties.severity);
		if (/blizzard|whiteout/.test(text)) score += 22;
		if (/freezing rain|ice accumulation|significant icing|glaze/.test(text)) score += 18;
		if (/heavy snow|near zero visibility|dangerous travel|hazardous travel/.test(text)) score += 14;
		return score;
	}

	let score = severityWeight(properties.severity);
	if (/critical fire weather|rapid fire spread|wildfire|public safety|evacuat/.test(text)) score += 20;
	if (/power outages?|structures? threatened|homes? threatened/.test(text)) score += 12;
	return score;
}

export function scoreAutoPostHazardClusterCandidate(record: AutoPostEvaluationRecord): number {
	const family = autoPostHazardClusterFamilyForEvent(record.event);
	if (!family) return -1;
	let score = eventTierRank(record.event) * 100;
	score += familyImpactWeight(family, record.feature);
	score += Math.min(40, record.countyCount * 3);
	score += Math.min(20, record.matchedMetroNames.length * 10);
	score += geographyClarityWeight(record);
	return score;
}

function summarizeClusterArea(record: AutoPostEvaluationRecord): string {
	if (record.matchedMetroNames.length > 0) {
		return joinReadableList(record.matchedMetroNames.slice(0, 2));
	}
	const parts = dedupeStrings(
		String(record.feature?.properties?.areaDesc || '')
			.split(/;|,/)
			.map((part) => String(part || '').trim())
			.filter(Boolean),
	);
	if (parts.length === 0) return 'additional areas';
	if (parts.length <= AUTO_POST_CLUSTER_AREA_PART_LIMIT) return joinReadableList(parts);
	return `${joinReadableList(parts.slice(0, AUTO_POST_CLUSTER_AREA_PART_LIMIT))} and nearby areas`;
}

function buildClusterImpactSummary(family: AutoPostHazardClusterFamily, record: AutoPostEvaluationRecord): string {
	const properties = record.feature?.properties ?? {};
	const text = [
		properties.headline,
		properties.description,
		properties.instruction,
	]
		.map((value) => mapSomeValue(value))
		.join(' ')
		.toLowerCase();

	if (family === 'wind') {
		const maxWind = parseAlertNumericValue(findProperty(properties, 'maxWindGust'));
		if (maxWind != null) {
			return `damaging gusts up to ${Math.round(maxWind)} mph are expected`;
		}
		if (/power outages?|downed trees?|tree damage/.test(text)) {
			return 'damaging gusts and scattered power outages are possible';
		}
		return 'damaging gusts are expected';
	}

	if (family === 'flood') {
		if (/road closures?|roads? flooded|water over roads?/.test(text)) {
			return 'flooding and travel problems are becoming more likely';
		}
		if (/flooding is occurring|rapid rises?|rises on creeks?/.test(text)) {
			return 'additional flooding problems are expected';
		}
		return 'additional flood alerts are now in place';
	}

	if (family === 'winter') {
		if (/freezing rain|ice|icing|sleet/.test(text)) {
			return 'snow and ice will create hazardous travel';
		}
		if (/blizzard|whiteout/.test(text)) {
			return 'whiteout conditions and dangerous travel are possible';
		}
		return 'snow and hazardous travel are expected';
	}

	if (/wildfire|rapid fire spread|public safety|evacuat/.test(text)) {
		return 'critical fire weather conditions continue to threaten nearby areas';
	}
	return 'critical fire weather conditions are expected';
}

export function buildAutoPostHazardClusterCommentMessage(
	record: AutoPostEvaluationRecord,
	family = autoPostHazardClusterFamilyForEvent(record.event),
): string {
	if (!family) {
		return `UPDATE: Weather impacts have expanded to include ${summarizeClusterArea(record)}.`;
	}

	const lead = family === 'wind'
		? 'High wind impacts'
		: family === 'flood'
			? 'Flooding concerns'
			: family === 'winter'
				? 'Winter weather impacts'
				: 'Fire weather concerns';
	const area = summarizeClusterArea(record);
	const impactSummary = buildClusterImpactSummary(family, record);
	return `UPDATE: ${lead} have expanded to include ${area}, where ${impactSummary}.`;
}

function clusterWindowForRecord(record: AutoPostEvaluationRecord): { startMs: number; endMs: number } | null {
	const properties = record.feature?.properties ?? {};
	const startMs = autoPostTimestampMsForChange(record.feature, record.change)
		?? parseTimeMs(String(properties.effective || properties.sent || properties.updated || record.change.changedAt || ''));
	const endMs = parseTimeMs(String(properties.ends || properties.expires || ''));
	if (startMs == null || endMs == null) return null;
	return { startMs, endMs };
}

function clusterGroupStateCode(change: AlertChangeRecord): string | null {
	const stateCodes = dedupeStrings((change.stateCodes || []).map((stateCode) => String(stateCode || '').trim().toUpperCase()).filter(Boolean));
	return stateCodes.length === 1 ? stateCodes[0] : null;
}

function windowsApproximatelyMatch(
	left: { startMs: number; endMs: number },
	right: { startMs: number; endMs: number },
): boolean {
	const overlaps = left.startMs <= (right.endMs + AUTO_POST_CLUSTER_WINDOW_MATCH_MS)
		&& right.startMs <= (left.endMs + AUTO_POST_CLUSTER_WINDOW_MATCH_MS);
	if (!overlaps) return false;
	return Math.abs(left.startMs - right.startMs) <= AUTO_POST_CLUSTER_WINDOW_MATCH_MS
		&& Math.abs(left.endMs - right.endMs) <= AUTO_POST_CLUSTER_WINDOW_MATCH_MS;
}

function metrosClearlyIndicateSeparateStories(
	groupMetros: Set<string>,
	candidateMetroNames: string[],
): boolean {
	if (groupMetros.size === 0 || candidateMetroNames.length === 0) return false;
	return !candidateMetroNames.some((metroName) => groupMetros.has(metroName));
}

function compareAutoPostHazardClusterCandidates(
	left: AutoPostHazardClusterCandidate,
	right: AutoPostHazardClusterCandidate,
): number {
	const scoreDiff = right.anchorScore - left.anchorScore;
	if (scoreDiff !== 0) return scoreDiff;

	const tierDiff = eventTierRank(right.event) - eventTierRank(left.event);
	if (tierDiff !== 0) return tierDiff;

	const metroDiff = right.matchedMetroNames.length - left.matchedMetroNames.length;
	if (metroDiff !== 0) return metroDiff;

	const countyDiff = right.countyCount - left.countyCount;
	if (countyDiff !== 0) return countyDiff;

	const timestampDiff = (right.timestampMs ?? 0) - (left.timestampMs ?? 0);
	if (timestampDiff !== 0) return timestampDiff;

	return String(left.change.alertId || left.feature?.id || '').localeCompare(String(right.change.alertId || right.feature?.id || ''));
}

export function buildAutoPostHazardClusterPlans(
	evaluations: AutoPostEvaluationRecord[],
	decisionOverrides: Map<string, FacebookAutoPostDecision> = new Map(),
): AutoPostHazardClusterPlan[] {
	const candidates: AutoPostHazardClusterCandidate[] = [];

	for (const record of evaluations) {
		const alertId = String(record.change.alertId || record.feature?.id || '');
		const finalDecision = decisionOverrides.get(alertId) || record.decision;
		const clusterFamily = autoPostHazardClusterFamilyForEvent(record.event);
		if (!clusterFamily) continue;
		if (!isAutoPostCandidateActive(record.feature) || !isAutoPostCandidateTimely(record.feature, record.change)) continue;

		const stateCode = clusterGroupStateCode(record.change);
		const senderOffice = String(record.feature?.properties?.senderName || '').trim();
		const window = clusterWindowForRecord(record);
		if (!stateCode || !senderOffice || !window) continue;

		const isAnchorCandidate = finalDecision.eligible;
		const isClusterSupplement = finalDecision.reason === 'not_warning';
		if (!isAnchorCandidate && !isClusterSupplement) continue;

		candidates.push({
			...record,
			finalDecision,
			clusterFamily,
			senderOffice,
			stateCode,
			windowStartMs: window.startMs,
			windowEndMs: window.endMs,
			timestampMs: autoPostTimestampMsForChange(record.feature, record.change),
			anchorScore: scoreAutoPostHazardClusterCandidate(record),
			normalizedMetroNames: normalizeClusterMetroNames(record.matchedMetroNames),
		});
	}

	const partitionMap = new Map<string, AutoPostHazardClusterCandidate[]>();
	for (const candidate of candidates) {
		const key = `${candidate.clusterFamily}|${candidate.senderOffice.toLowerCase()}|${candidate.stateCode}`;
		const existing = partitionMap.get(key) || [];
		existing.push(candidate);
		partitionMap.set(key, existing);
	}

	const plans: AutoPostHazardClusterPlan[] = [];
	for (const partitionRecords of partitionMap.values()) {
		const groups: Array<{
			referenceWindow: { startMs: number; endMs: number };
			groupMetros: Set<string>;
			members: AutoPostHazardClusterCandidate[];
		}> = [];

		for (const candidate of [...partitionRecords].sort((left, right) => {
			const startDiff = left.windowStartMs - right.windowStartMs;
			if (startDiff !== 0) return startDiff;
			return compareAutoPostHazardClusterCandidates(left, right);
		})) {
			const matchingGroup = groups.find((group) =>
				windowsApproximatelyMatch(group.referenceWindow, { startMs: candidate.windowStartMs, endMs: candidate.windowEndMs })
				&& !metrosClearlyIndicateSeparateStories(group.groupMetros, candidate.normalizedMetroNames),
			);

			if (!matchingGroup) {
				groups.push({
					referenceWindow: { startMs: candidate.windowStartMs, endMs: candidate.windowEndMs },
					groupMetros: new Set(candidate.normalizedMetroNames),
					members: [candidate],
				});
				continue;
			}

			candidate.normalizedMetroNames.forEach((metroName) => matchingGroup.groupMetros.add(metroName));
			matchingGroup.members.push(candidate);
		}

		for (const [groupIndex, group] of groups.entries()) {
			if (group.members.length < 2) continue;

			const orderedMembers = [...group.members].sort(compareAutoPostHazardClusterCandidates);
			const anchor = orderedMembers.find((member) => member.finalDecision.eligible);
			if (!anchor) continue;

			plans.push({
				id: `${anchor.clusterFamily}:${anchor.senderOffice.toLowerCase()}:${anchor.stateCode}:${groupIndex}`,
				family: anchor.clusterFamily,
				senderOffice: anchor.senderOffice,
				stateCode: anchor.stateCode,
				anchor,
				members: [
					anchor,
					...orderedMembers.filter((member) => String(member.change.alertId || member.feature?.id || '') !== String(anchor.change.alertId || anchor.feature?.id || '')),
				],
			});
		}
	}

	return plans.sort((left, right) => compareAutoPostHazardClusterCandidates(left.anchor, right.anchor));
}

async function publishAutoPostEvaluation(
	env: Env,
	evaluation: AutoPostEvaluationRecord,
	decision: FacebookAutoPostDecision,
	options: {
		threadAction?: FacebookPublishThreadAction;
		threadTarget?: AlertThread | null;
		customMessage?: string;
		logLabel?: string;
	} = {},
): Promise<AutoPostPublishOutcome> {
	const result = await publishFeatureToFacebook(env, evaluation.feature, {
		threadAction: options.threadAction ?? decision.threadAction,
		threadTarget: options.threadTarget ?? null,
		customMessage: options.customMessage,
		change: evaluation.change,
	});
	await markAlertStandaloneCovered(env, evaluation.change.alertId);
	const metroLabel = decision.matchedMetroNames.length > 0
		? ` metros=${decision.matchedMetroNames.join('|')}`
		: '';
	const logLabel = options.logLabel ? ` ${options.logLabel}` : '';
	console.log(
		`[fb-auto-post] ${result.status} ${evaluation.change.alertId} mode=${decision.mode} reason=${decision.reason}${logLabel} change=${evaluation.change.changeType} counties=${decision.countyCount}${metroLabel} post=${result.postId}`,
	);
	return {
		thread: await readExistingThreadForFeature(env, evaluation.feature, evaluation.event, evaluation.change),
		status: result.status,
	};
}

function autoPostIntentPriority(
	decision: FacebookAutoPostDecision,
	action: FacebookCoverageIntent['action'],
): number {
	if (decision.reason === 'all_tornado_warnings') return action === 'comment' ? 950 : 1000;
	if (
		decision.reason === 'tornado_emergency'
		|| decision.reason === 'pds_tornado_warning'
		|| decision.reason === 'flash_flood_emergency'
		|| decision.reason === 'extreme_wind_warning'
		|| decision.reason === 'storm_surge_warning'
		|| decision.reason === 'hurricane_warning'
		|| decision.reason === 'hurricane_landfall'
	) {
		return action === 'comment' ? 920 : 970;
	}
	if (
		decision.reason === 'tier2_severe_thunderstorm_warning'
		|| decision.reason === 'tier2_flood_warning'
		|| decision.reason === 'tier2_winter_warning'
		|| decision.reason === 'tier2_high_wind_warning'
		|| decision.reason === 'fire_family_escalation'
	) {
		return action === 'comment' ? 780 : 860;
	}
	if (decision.reason === 'spc_day1_tornado_watch_comment') return 640;
	if (decision.reason === 'tier3_minor_hazard') return 500;
	return action === 'comment' ? 660 : 720;
}

function autoPostIntentAreaLabel(record: AutoPostEvaluationRecord): string {
	if (record.matchedMetroNames.length > 0) {
		return joinReadableList(record.matchedMetroNames.slice(0, 2));
	}
	const stateCodes = dedupeStrings((record.change.stateCodes || []).map((stateCode) => String(stateCode || '').trim().toUpperCase()));
	if (stateCodes.length > 0) {
		return stateCodes.join('/');
	}
	return summarizeClusterArea(record);
}

function buildAutoPostCoverageIntent(
	record: AutoPostEvaluationRecord,
	decision: FacebookAutoPostDecision,
	action: FacebookCoverageIntent['action'],
	options: {
		reason?: string;
		storyKey?: string | null;
		targetPostId?: string | null;
		summaryPrefix?: string;
	} = {},
): FacebookCoverageIntent {
	const areaLabel = autoPostIntentAreaLabel(record);
	const reason = options.reason ?? decision.reason;
	const prefix = options.summaryPrefix ?? record.event;
	return {
		lane: 'alerts',
		action,
		priority: autoPostIntentPriority({ ...decision, reason }, action),
		reason,
		summary: `${prefix} for ${areaLabel}`,
		storyKey: options.storyKey ?? String(record.change.alertId || record.feature?.id || ''),
		targetPostId: options.targetPostId ?? null,
	};
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
	return {
		blockedByHigherTier: false,
		candidateAlertIds: new Set<string>(),
		selectedAlertIds: new Set<string>(),
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
	const signal = evaluateSmartHighImpactStandaloneSignal(feature, change);
	const countyCount = signal.countyCount;
	const matchedMetroNames = signal.matchedMetroNames;
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

	return {
		eligible: signal.eligible,
		threadAction,
		reason: signal.reason,
		mode,
		matchedMetroNames,
		countyCount,
	};
}

export async function selectSevereWeatherFallbackOverrides(
	env: Env,
	evaluations: AutoPostEvaluationRecord[],
): Promise<Map<string, FacebookAutoPostDecision>> {
	void env;
	void evaluations;
	return new Map<string, FacebookAutoPostDecision>();
}

async function buildAutoPostExecutionBundle(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	nowMs = Date.now(),
): Promise<AutoPostExecutionBundle> {
	const config = await readFbAutoPostConfig(env);
	const relevantChanges = changes.filter((change) =>
		change.changeType === 'new'
		|| change.changeType === 'updated'
		|| change.changeType === 'extended',
	);
	const evaluations: AutoPostEvaluationRecord[] = [];
	if (config.mode !== 'off') {
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
	}

	const severeWeatherFallbackOverrides = config.mode === 'smart_high_impact'
		? await selectSevereWeatherFallbackOverrides(env, evaluations)
		: new Map<string, FacebookAutoPostDecision>();
	const tornadoWatchSpcCommentPlans = await buildTornadoWatchSpcCommentPlans(
		env,
		config.mode,
		map,
		evaluations,
		nowMs,
	);
	const hazardClusterPlans = buildAutoPostHazardClusterPlans(evaluations, severeWeatherFallbackOverrides);
	const orderedEvaluations = [...evaluations].sort((a, b) =>
		sortAutoPostEvaluationsForPublishing(a, b, severeWeatherFallbackOverrides),
	);

	return {
		config,
		relevantChanges,
		evaluations,
		severeWeatherFallbackOverrides,
		tornadoWatchSpcCommentPlans,
		hazardClusterPlans,
		orderedEvaluations,
	};
}

export async function evaluateAutoPostIntent(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	nowMs = Date.now(),
): Promise<FacebookCoverageEvaluation> {
	const bundle = await buildAutoPostExecutionBundle(env, map, changes, nowMs);
	if (bundle.config.mode === 'off') {
		return { lane: 'alerts', intent: null, blockedReason: 'auto_post_disabled' };
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		return { lane: 'alerts', intent: null, blockedReason: 'facebook_credentials_missing' };
	}
	if (bundle.relevantChanges.length === 0) {
		return { lane: 'alerts', intent: null, blockedReason: 'no_relevant_changes' };
	}

	const standaloneHistory = await readAutoPostStandaloneHistory(env, nowMs);
	const recentStandalonePostTimestamps = standaloneHistory.postTimestamps;

	for (const plan of bundle.hazardClusterPlans) {
		const anchorDecision = bundle.severeWeatherFallbackOverrides.get(String(plan.anchor.change.alertId || plan.anchor.feature?.id || '')) || plan.anchor.decision;
		const hourlyCapAction = await resolveAutoPostHourlyCapAction(env, plan.anchor, anchorDecision, recentStandalonePostTimestamps);
		if (hourlyCapAction.skip) continue;
		return {
			lane: 'alerts',
			intent: buildAutoPostCoverageIntent(
				plan.anchor,
				anchorDecision,
				hourlyCapAction.threadAction === 'comment'
					? 'comment'
					: (plan.members.length > 1 ? 'multi_post' : 'post'),
				{
					reason: anchorDecision.reason,
					storyKey: `cluster:${plan.family}:${plan.senderOffice.toLowerCase()}:${plan.stateCode}`,
					targetPostId: hourlyCapAction.threadTarget?.postId ?? null,
					summaryPrefix: `${plan.anchor.event} cluster`,
				},
			),
		};
	}

	for (const evaluation of bundle.orderedEvaluations) {
		const alertId = String(evaluation.change.alertId || evaluation.feature?.id || '');
		const tornadoWatchSpcCommentPlan = bundle.tornadoWatchSpcCommentPlans.get(alertId);
		if (tornadoWatchSpcCommentPlan) {
			return {
				lane: 'alerts',
				intent: buildAutoPostCoverageIntent(
					tornadoWatchSpcCommentPlan.evaluation,
					tornadoWatchSpcCommentPlan.decision,
					'comment',
					{
						reason: 'spc_day1_tornado_watch_comment',
						storyKey: `spc-day1:${tornadoWatchSpcCommentPlan.spcPostId}`,
						targetPostId: tornadoWatchSpcCommentPlan.spcPostId,
						summaryPrefix: tornadoWatchSpcCommentPlan.evaluation.event,
					},
				),
			};
		}

		const decision = bundle.severeWeatherFallbackOverrides.get(alertId) || evaluation.decision;
		if (!decision.eligible) {
			if (shouldCommentOnExistingMinorHazardThread(decision)) {
				const existingThread = await readExistingThreadForFeature(env, evaluation.feature, evaluation.event, evaluation.change);
				if (existingThread) {
					return {
						lane: 'alerts',
						intent: buildAutoPostCoverageIntent(
							evaluation,
							{ ...decision, eligible: true },
							'comment',
							{
								storyKey: `thread:${existingThread.postId}`,
								targetPostId: existingThread.postId,
								summaryPrefix: evaluation.event,
							},
						),
					};
				}
			}
			continue;
		}

		const hourlyCapAction = await resolveAutoPostHourlyCapAction(env, evaluation, decision, recentStandalonePostTimestamps);
		if (hourlyCapAction.skip) continue;
		return {
			lane: 'alerts',
			intent: buildAutoPostCoverageIntent(
				evaluation,
				decision,
				hourlyCapAction.threadAction === 'comment' ? 'comment' : 'post',
				{
					storyKey: alertId,
					targetPostId: hourlyCapAction.threadTarget?.postId ?? null,
				},
			),
		};
	}

	return { lane: 'alerts', intent: null, blockedReason: 'no_actionable_alerts' };
}

function autoPostDecisionRank(decision: FacebookAutoPostDecision, event: string): number {
	if (decision.reason === 'all_tornado_warnings') return 0;
	if (
		decision.reason === 'tornado_emergency'
		|| decision.reason === 'pds_tornado_warning'
		|| decision.reason === 'flash_flood_emergency'
		|| decision.reason === 'extreme_wind_warning'
		|| decision.reason === 'storm_surge_warning'
		|| decision.reason === 'hurricane_warning'
		|| decision.reason === 'hurricane_landfall'
	) {
		return 1;
	}
	if (decision.reason === 'fire_family_escalation') return 2;
	if (decision.reason === 'tier2_severe_thunderstorm_warning') return 3;
	if (decision.reason === 'tier2_flood_warning') return 4;
	if (decision.reason === 'tier2_winter_warning') return 5;
	if (decision.reason === 'tier2_high_wind_warning') return 6;
	if (isSevereWeatherFallbackEvent(event)) return 7;
	return 8;
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
	if (aSevereCluster === 'severe_thunderstorm' && bSevereCluster === 'severe_thunderstorm') {
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

function trimStandalonePostTimestamps(timestamps: string[], nowMs = Date.now()): string[] {
	return dedupeStrings(
		timestamps.filter((timestamp) => {
			const parsedMs = Date.parse(String(timestamp || '').trim());
			return Number.isFinite(parsedMs) && (nowMs - parsedMs) < AUTO_POST_STANDALONE_WINDOW_MS;
		}),
	).sort();
}

async function readAutoPostStandaloneHistory(
	env: Env,
	nowMs = Date.now(),
): Promise<AutoPostStandaloneHistoryRecord> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_ALERT_STANDALONE_POST_HISTORY);
		if (!raw) {
			return {
				postTimestamps: [],
				updatedAt: new Date(nowMs).toISOString(),
			};
		}
		const parsed = JSON.parse(raw) as Partial<AutoPostStandaloneHistoryRecord> | null;
		return {
			postTimestamps: trimStandalonePostTimestamps(Array.isArray(parsed?.postTimestamps) ? parsed.postTimestamps : [], nowMs),
			updatedAt: String(parsed?.updatedAt || new Date(nowMs).toISOString()),
		};
	} catch {
		return {
			postTimestamps: [],
			updatedAt: new Date(nowMs).toISOString(),
		};
	}
}

async function writeAutoPostStandaloneHistory(
	env: Env,
	postTimestamps: string[],
	nowMs = Date.now(),
): Promise<void> {
	await env.WEATHER_KV.put(
		KV_FB_ALERT_STANDALONE_POST_HISTORY,
		JSON.stringify({
			postTimestamps: trimStandalonePostTimestamps(postTimestamps, nowMs),
			updatedAt: new Date(nowMs).toISOString(),
		} satisfies AutoPostStandaloneHistoryRecord),
		{ expirationTtl: AUTO_POST_STANDALONE_HISTORY_TTL_SECONDS },
	);
}

function shouldCommentOnExistingMinorHazardThread(decision: FacebookAutoPostDecision): boolean {
	return decision.reason === 'tier3_minor_hazard';
}

async function resolveAutoPostHourlyCapAction(
	env: Env,
	evaluation: AutoPostEvaluationRecord,
	decision: FacebookAutoPostDecision,
	recentStandalonePostTimestamps: string[],
): Promise<AutoPostHourlyCapAction> {
	if (!decision.eligible) return { skip: false };
	if (isStandalonePostCapExempt(decision.reason)) return { skip: false };
	if (recentStandalonePostTimestamps.length < FB_AUTO_POST_STANDALONE_MAX_POSTS_PER_HOUR) {
		return { skip: false };
	}

	const existingThread = await readExistingThreadForFeature(env, evaluation.feature, evaluation.event, evaluation.change);
	if (existingThread) {
		return {
			skip: false,
			threadAction: 'comment',
			threadTarget: existingThread,
			logLabel: 'hourly_cap=comment_fallback',
		};
	}

	return {
		skip: true,
		logLabel: 'hourly_cap=skipped',
	};
}

function shouldCountPostedStandaloneAlert(decision: FacebookAutoPostDecision, status: FacebookPublishResult['status']): boolean {
	return status === 'posted' && !isStandalonePostCapExempt(decision.reason);
}

export async function autoPostFacebookAlerts(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
): Promise<void> {
	const nowMs = Date.now();
	const bundle = await buildAutoPostExecutionBundle(env, map, changes, nowMs);
	const { config } = bundle;
	if (config.mode === 'off') return;
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		console.warn(`[fb-auto-post] ${config.mode} mode is enabled but Facebook credentials are missing.`);
		return;
	}
	if (bundle.relevantChanges.length === 0) return;

	const standaloneHistory = await readAutoPostStandaloneHistory(env, nowMs);
	let recentStandalonePostTimestamps = standaloneHistory.postTimestamps;
	let standaloneHistoryChanged = false;
	const noteStandalonePost = (): void => {
		recentStandalonePostTimestamps = trimStandalonePostTimestamps([
			...recentStandalonePostTimestamps,
			new Date().toISOString(),
		]);
		standaloneHistoryChanged = true;
	};

	const {
		evaluations,
		severeWeatherFallbackOverrides,
		tornadoWatchSpcCommentPlans,
		hazardClusterPlans,
		orderedEvaluations,
	} = bundle;
	const handledAlertIds = new Set<string>();

	for (const plan of hazardClusterPlans) {
		const anchorAlertId = String(plan.anchor.change.alertId || plan.anchor.feature?.id || '');
		if (!anchorAlertId || handledAlertIds.has(anchorAlertId)) continue;

		const anchorDecision = severeWeatherFallbackOverrides.get(anchorAlertId) || plan.anchor.decision;
		const hourlyCapAction = await resolveAutoPostHourlyCapAction(
			env,
			plan.anchor,
			anchorDecision,
			recentStandalonePostTimestamps,
		);
		if (hourlyCapAction.skip) {
			console.log(
				`[fb-auto-post] skipped ${anchorAlertId} event="${plan.anchor.event}" reason=hourly_standalone_cap cluster=anchor family=${plan.family} state=${plan.stateCode}`,
			);
			continue;
		}

		let anchorThread: AlertThread | null = null;
		try {
			const anchorOutcome = await publishAutoPostEvaluation(env, plan.anchor, anchorDecision, {
				threadAction: hourlyCapAction.threadAction,
				threadTarget: hourlyCapAction.threadTarget ?? null,
				logLabel: [
					`cluster=anchor family=${plan.family} state=${plan.stateCode}`,
					hourlyCapAction.logLabel,
				].filter(Boolean).join(' '),
			});
			handledAlertIds.add(anchorAlertId);
			anchorThread = anchorOutcome.thread;
			if (shouldCountPostedStandaloneAlert(anchorDecision, anchorOutcome.status)) {
				noteStandalonePost();
			}
		} catch (err) {
			console.error(
				`[fb-auto-post] failed cluster anchor ${anchorAlertId} family=${plan.family} state=${plan.stateCode}: ${String(err)}`,
			);
			continue;
		}

		if (!anchorThread) {
			console.warn(
				`[fb-auto-post] missing anchor thread after clustered publish alert=${anchorAlertId} family=${plan.family} state=${plan.stateCode}`,
			);
			continue;
		}

		for (const member of plan.members.slice(1)) {
			const memberAlertId = String(member.change.alertId || member.feature?.id || '');
			if (!memberAlertId || handledAlertIds.has(memberAlertId)) continue;
			handledAlertIds.add(memberAlertId);
			const memberDecision = severeWeatherFallbackOverrides.get(memberAlertId) || member.decision;
			try {
				const memberOutcome = await publishAutoPostEvaluation(env, member, memberDecision, {
					threadAction: 'comment',
					threadTarget: anchorThread,
					customMessage: buildAutoPostHazardClusterCommentMessage(member, plan.family),
					logLabel: `cluster=comment family=${plan.family} state=${plan.stateCode} anchor=${anchorAlertId}`,
				});
				anchorThread = memberOutcome.thread ?? anchorThread;
			} catch (err) {
				console.error(
					`[fb-auto-post] failed clustered comment ${memberAlertId} anchor=${anchorAlertId} family=${plan.family}: ${String(err)}`,
				);
			}
		}
	}

	for (const evaluation of orderedEvaluations) {
		const alertId = String(evaluation.change.alertId || evaluation.feature?.id || '');
		if (handledAlertIds.has(alertId)) continue;
		const tornadoWatchSpcCommentPlan = tornadoWatchSpcCommentPlans.get(alertId);
		if (tornadoWatchSpcCommentPlan) {
			try {
				await publishAutoPostEvaluation(
					env,
					tornadoWatchSpcCommentPlan.evaluation,
					tornadoWatchSpcCommentPlan.decision,
					{
						threadAction: 'comment',
						threadTarget: tornadoWatchSpcCommentPlan.threadTarget,
						customMessage: tornadoWatchSpcCommentPlan.customMessage,
						logLabel: 'routed=spc_day1_watch',
					},
				);
				await recordSpcThreadCommentActivity(env, 1, {
					nowMs,
					postId: tornadoWatchSpcCommentPlan.spcPostId,
				});
				handledAlertIds.add(alertId);
				continue;
			} catch (err) {
				console.error(
					`[fb-auto-post] failed spc_day1_watch_comment ${evaluation.change.alertId}: ${String(err)}`,
				);
			}
		}
		const decision = severeWeatherFallbackOverrides.get(alertId) || evaluation.decision;
		if (!decision.eligible) {
			if (shouldCommentOnExistingMinorHazardThread(decision)) {
				const existingThread = await readExistingThreadForFeature(env, evaluation.feature, evaluation.event, evaluation.change);
				if (existingThread) {
					try {
						await publishAutoPostEvaluation(env, evaluation, {
							...decision,
							eligible: true,
						}, {
							threadAction: 'comment',
							threadTarget: existingThread,
							logLabel: 'thread=reuse_minor_hazard',
						});
						handledAlertIds.add(alertId);
						continue;
					} catch (err) {
						console.error(
							`[fb-auto-post] failed minor-hazard thread reuse ${evaluation.change.alertId}: ${String(err)}`,
						);
					}
				}
			}
			console.log(
				`[fb-auto-post] skipped ${evaluation.change.alertId} event="${String(evaluation.feature?.properties?.event || evaluation.change.event || '')}" reason=${decision.reason}`,
			);
			continue;
		}

		const hourlyCapAction = await resolveAutoPostHourlyCapAction(
			env,
			evaluation,
			decision,
			recentStandalonePostTimestamps,
		);
		if (hourlyCapAction.skip) {
			console.log(
				`[fb-auto-post] skipped ${evaluation.change.alertId} event="${String(evaluation.feature?.properties?.event || evaluation.change.event || '')}" reason=hourly_standalone_cap`,
			);
			continue;
		}

		try {
			const outcome = await publishAutoPostEvaluation(env, evaluation, decision, {
				threadAction: hourlyCapAction.threadAction,
				threadTarget: hourlyCapAction.threadTarget ?? null,
				logLabel: hourlyCapAction.logLabel,
			});
			handledAlertIds.add(alertId);
			if (shouldCountPostedStandaloneAlert(decision, outcome.status)) {
				noteStandalonePost();
			}
		} catch (err) {
			console.error(
				`[fb-auto-post] failed for ${evaluation.change.alertId} mode=${decision.mode} reason=${decision.reason}: ${String(err)}`,
			);
		}
	}

	if (standaloneHistoryChanged) {
		try {
			await writeAutoPostStandaloneHistory(env, recentStandalonePostTimestamps, Date.now());
		} catch (err) {
			console.error(`[fb-auto-post] failed writing standalone hourly history: ${String(err)}`);
		}
	}

}
