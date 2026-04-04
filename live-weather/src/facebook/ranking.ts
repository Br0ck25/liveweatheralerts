import type {
	Env,
	AlertChangeRecord,
	AlertImpactCategory,
	FacebookAutoPostDecision,
	AutoPostEvaluationRecord,
	AdminFacebookPostRankBucket,
	AdminFacebookPostRanking,
} from '../types';
import {
	dedupeStrings,
	extractCountyUgcCodes,
	extractFullCountyFipsCodes,
	extractStateCodes,
	extractCountyFipsCodes,
	deriveAlertImpactCategories,
	classifyAlert,
	normalizeEventSlug,
} from '../utils';
import {
	matchingMetroNamesForAlert,
	highestPriorityMetroRank,
} from './config';
import {
	evaluateSmartHighImpactStandaloneSignal,
	selectSevereWeatherFallbackCandidates,
} from './auto-post';
import { parseTimeMs } from '../alert-lifecycle';

// ---------------------------------------------------------------------------
// Local helpers (duplicated from auto-post.ts to avoid circular deps with ranking)
// ---------------------------------------------------------------------------

function isWarningEvent(event: string): boolean {
	return /\bwarning\b/i.test(String(event || '').trim());
}

function isTornadoWarningEvent(event: string): boolean {
	return /\btornado warning\b/i.test(String(event || '').trim());
}

function isAutoPostCandidateActive(feature: any, nowMs = Date.now()): boolean {
	const expiry = feature?.properties?.ends ?? feature?.properties?.expires;
	const expiryMs = parseTimeMs(String(expiry || ''));
	if (expiryMs == null) return true;
	return expiryMs > nowMs;
}

function isAutoPostCandidateTimely(feature: any, change: AlertChangeRecord, nowMs = Date.now()): boolean {
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
		if (parsed != null) {
			return (nowMs - parsed) <= 30 * 60 * 1000; // 30-minute freshness window for admin display
		}
	}
	return true;
}

function detectTierOneAutoPostReason(feature: any): string | null {
	const properties = feature?.properties ?? {};
	const event = String(properties.event || '').trim();
	const text = [event, properties.headline, properties.description, properties.instruction]
		.map((v) => String(v || ''))
		.join(' ')
		.toLowerCase();
	if (/\btornado emergency\b/.test(text)) return 'tornado_emergency';
	if (/\bparticularly dangerous situation\b|\bpds tornado\b/.test(text)) return 'pds_tornado_warning';
	if (/\bflash flood emergency\b/.test(text)) return 'flash_flood_emergency';
	if (/\bhurricane\b/.test(text) && /\b(?:landfall|made landfall)\b/.test(text)) return 'hurricane_landfall';
	return null;
}

function hasSevereThunderstormStrongWording(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const text = [properties.event, properties.headline, properties.description, properties.instruction]
		.map((v) => String(v || '').toLowerCase())
		.join(' ');
	return /\bconsiderable damage\b|\bdangerous storm\b|\bdangerous thunderstorm\b|\bconsiderable\b/.test(text);
}

function hasFireFamilyEscalationCriteria(feature: any): boolean {
	const properties = feature?.properties ?? {};
	const text = [properties.event, properties.headline, properties.description, properties.instruction]
		.map((v) => String(v || '').toLowerCase())
		.join(' ');
	return /\bevacuat(?:e|ion|ions|ed)\b|\bpublic safety\b|\blife safety\b|\bactive wildfire\b|\bwildfire impact\b|\bwildfire\b|\bstructures? threatened\b|\bhomes? threatened\b/.test(text);
}

// ---------------------------------------------------------------------------
// buildAdminFacebookPostChange — builds a synthetic change record for admin UI
// ---------------------------------------------------------------------------

export function buildAdminFacebookPostChange(feature: any): AlertChangeRecord {
	const properties = feature?.properties ?? {};
	return {
		alertId: String(feature?.id ?? properties['@id'] ?? ''),
		stateCodes: extractStateCodes(feature),
		countyCodes: extractCountyFipsCodes(feature),
		event: String(properties.event || ''),
		areaDesc: String(properties.areaDesc || ''),
		changedAt: String(properties.updated || properties.sent || properties.effective || new Date().toISOString()),
		changeType: 'new',
		severity: String(properties.severity || ''),
	};
}

function evaluateAdminFacebookPostDecision(
	feature: any,
	change: AlertChangeRecord,
): FacebookAutoPostDecision {
	const signal = evaluateSmartHighImpactStandaloneSignal(feature, change);
	return {
		eligible: signal.eligible,
		threadAction: '',
		reason: signal.reason,
		mode: 'smart_high_impact',
		matchedMetroNames: signal.matchedMetroNames,
		countyCount: signal.countyCount,
	};
}

function describeAdminFacebookPostReason(
	reason: string,
	matchedMetroNames: string[],
	countyCount: number,
	fallbackBlockedByHigherTier = false,
): string {
	if (reason === 'all_tornado_warnings') return 'All active, timely Tornado Warnings auto-post.';
	if (reason === 'tornado_emergency') return 'Tier 1 tornado emergency. Auto-post immediately.';
	if (reason === 'pds_tornado_warning') return 'Particularly dangerous tornado wording pushes this into the top auto-post tier.';
	if (reason === 'flash_flood_emergency') return 'Flash Flood Emergencies always auto-post.';
	if (reason === 'extreme_wind_warning') return 'Extreme Wind Warnings always break out as standalone posts.';
	if (reason === 'storm_surge_warning') return 'Storm Surge Warnings always break out as standalone posts.';
	if (reason === 'hurricane_warning') return 'Hurricane Warnings always break out as standalone posts.';
	if (reason === 'hurricane_landfall') return 'Hurricane landfall wording puts this in the highest auto-post tier.';
	if (reason === 'fire_family_escalation') return 'Fire-family alerts only auto-post when wildfire or public-safety escalation is present.';
	if (reason === 'tier2_severe_thunderstorm_warning') {
		return matchedMetroNames.length > 0
			? `Severe Thunderstorm Warning clears the metro threshold for ${matchedMetroNames.join(', ')}.`
			: `Severe Thunderstorm Warning clears the regional threshold across ${countyCount} counties.`;
	}
	if (reason === 'tier2_flood_warning') {
		return matchedMetroNames.length > 0
			? `Flood Warning carries significant impact wording and overlaps ${matchedMetroNames.join(', ')}.`
			: `Flood Warning carries significant impact wording across ${countyCount} counties.`;
	}
	if (reason === 'tier2_winter_warning') {
		return matchedMetroNames.length > 0
			? `Winter warning meets the snow/ice threshold and overlaps ${matchedMetroNames.join(', ')}.`
			: `Winter warning meets the snow/ice threshold across ${countyCount} counties.`;
	}
	if (reason === 'tier2_high_wind_warning') {
		return matchedMetroNames.length > 0
			? `High Wind Warning meets the metro wind threshold for ${matchedMetroNames.join(', ')}.`
			: `High Wind Warning meets the regional wind threshold across ${countyCount} counties.`;
	}
	if (reason === 'severe_weather_fallback') {
		return matchedMetroNames.length > 0
			? `Top severe-weather fallback pick for ${matchedMetroNames.join(', ')}.`
			: `Top severe-weather fallback pick by large regional coverage (${countyCount} counties).`;
	}
	if (reason === 'severe_weather_fallback_not_selected') {
		return fallbackBlockedByHigherTier
			? 'Severe-weather fallback is blocked because a tornado or emergency alert is already active.'
			: 'This severe setup is real, but higher-priority metro or larger-coverage severe posts would go first.';
	}
	if (reason === 'severe_thunderstorm_below_threshold') return 'Severe Thunderstorm Warnings need destructive wording, 70+ mph wind, 2"+ hail, or a near-threshold metro signal.';
	if (reason === 'severe_thunderstorm_needs_population_or_coverage') return 'Severe Thunderstorm Warnings need a major metro overlap or at least 10 counties before they can break out.';
	if (reason === 'high_wind_warning_below_threshold') return 'High Wind Warnings need 60+ mph gusts or strong outage/travel wording before they break out.';
	if (reason === 'high_wind_warning_needs_population_or_coverage') return 'High Wind Warnings need a major metro overlap or at least 10 counties before they can break out.';
	if (reason === 'winter_warning_below_threshold') return 'Winter warnings need 8"+ snow, 0.25"+ ice, or strong blizzard/travel wording before they break out.';
	if (reason === 'winter_warning_needs_population_or_coverage') return 'Winter warnings need a major metro overlap or at least 10 counties before they can break out.';
	if (reason === 'flood_warning_below_threshold') return 'Flood Warnings need significant flooding wording before they break out.';
	if (reason === 'flood_warning_needs_population_or_coverage') return 'Flood Warnings need a major metro overlap or at least 10 counties before they can break out.';
	if (reason === 'fire_family_not_escalated') return 'Red Flag and fire-family alerts do not auto-post from county count or metro reach alone.';
	if (reason === 'tier3_minor_hazard') return 'Minor warning products stay off the standalone alert lane unless a human already seeded the story.';
	if (reason === 'impact_gate_not_met') return 'Needs a major metro or at least 10 counties before it becomes auto-post eligible.';
	if (reason === 'stale_alert') return 'Older than the 30-minute freshness window, so it would be skipped.';
	if (reason === 'inactive_or_expired') return 'Already expired or no longer active.';
	if (reason === 'not_warning') return 'Watches, advisories, and statements stay off the standalone alert lane.';
	return 'Manual review recommended before posting.';
}

function buildAdminRankingAlertText(feature: any): string {
	const properties = feature?.properties ?? {};
	return [properties.event, properties.headline, properties.description, properties.instruction, properties.areaDesc]
		.map((v) => String(v || '').toLowerCase())
		.join(' ');
}

function alertDurationHours(feature: any): number | null {
	const properties = feature?.properties ?? {};
	const sentMs = parseTimeMs(String(properties.sent || properties.effective || properties.updated || ''));
	const expiresMs = parseTimeMs(String(properties.expires || properties.ends || ''));
	if (sentMs == null || expiresMs == null || expiresMs <= sentMs) return null;
	return (expiresMs - sentMs) / (60 * 60 * 1000);
}

function hasLandAudienceCoverage(feature: any, countyCount: number): boolean {
	return countyCount > 0 || extractCountyUgcCodes(feature).length > 0 || extractFullCountyFipsCodes(feature).length > 0;
}

function isMarineOnlyAudienceAlert(
	feature: any,
	impactCategories: AlertImpactCategory[],
	countyCount: number,
): boolean {
	if (!impactCategories.includes('marine')) return false;
	return !hasLandAudienceCoverage(feature, countyCount);
}

function hasOffshoreAudiencePattern(feature: any): boolean {
	const text = buildAdminRankingAlertText(feature);
	return /\boffshore\b|\bopen lake\b|\bcoastal waters\b|\bwaters\b|\bout to \d+\s*nm\b|\blake superior\b|\blake michigan\b|\batlantic waters\b|\bgulf waters\b|\bcaribbean waters\b/.test(text);
}

function hasTravelImpactPotential(feature: any, impactCategories: AlertImpactCategory[]): boolean {
	const text = buildAdminRankingAlertText(feature);
	if (impactCategories.includes('winter')) return true;
	if (/\bhigh wind watch\b|\bhigh wind warning\b|\bwind advisory\b/.test(text)) return true;
	return /\btravel\b|\bcommute\b|\broads?\b|\bbridges?\b|\bhighways?\b|\bhazardous driving\b|\bdifficult travel\b|\bslippery\b|\bslick\b|\bblowing snow\b|\bwhiteout\b|\breduced visibility\b/.test(text);
}

function adminHazardPriorityBase(event: string, impactCategories: AlertImpactCategory[]): number {
	const n = String(event || '').toLowerCase();
	if (/\bwinter storm watch\b/.test(n)) return 194;
	if (/\bhigh wind watch\b/.test(n)) return 190;
	if (/\bwinter weather advisory\b/.test(n)) return 170;
	if (/\bwind advisory\b/.test(n)) return 160;
	if (/\brip current\b/.test(n)) return 162;
	if (/\bspecial weather statement\b/.test(n)) return 136;
	if (/\bsmall craft advisory\b/.test(n)) return 146;
	if (/\bgale watch\b|\bgale warning\b|\bhazardous seas\b|\bmarine weather statement\b/.test(n)) return 148;
	if (impactCategories.includes('winter') && /\bwatch\b/.test(n)) return 188;
	if (impactCategories.includes('winter')) return 168;
	if (impactCategories.includes('coastal')) return 158;
	if (impactCategories.includes('marine')) return 146;
	if (/\bwatch\b/.test(n)) return 170;
	if (/\badvisory\b/.test(n)) return 160;
	if (/\bstatement\b/.test(n)) return 142;
	return 150;
}

function adminHazardPriorityCap(event: string, impactCategories: AlertImpactCategory[]): number | null {
	const n = String(event || '').toLowerCase();
	if (/\bspecial weather statement\b/.test(n)) return 160;
	if (/\brip current\b/.test(n)) return 170;
	if (/\bwind advisory\b/.test(n)) return 175;
	if (/\bwinter weather advisory\b/.test(n)) return 180;
	if (impactCategories.includes('marine') || /\bsmall craft advisory\b|\bgale watch\b|\bgale warning\b|\bhazardous seas\b|\bmarine weather statement\b/.test(n)) {
		return 160;
	}
	return null;
}

function adminCountyReachWeight(countyCount: number): number {
	if (countyCount >= 15) return 8;
	if (countyCount >= 5) return 5;
	if (countyCount >= 1) return 2;
	return 0;
}

const ADMIN_HIGH_ENGAGEMENT_STATE_CODES = new Set([
	'AL', 'AR', 'FL', 'GA', 'IA', 'IL', 'IN', 'KS', 'KY', 'LA', 'MI', 'MN',
	'MO', 'MS', 'NC', 'ND', 'NE', 'OH', 'OK', 'SC', 'SD', 'TN', 'TX', 'WI',
]);

function isTerritoryAudienceAlert(record: AutoPostEvaluationRecord): boolean {
	const stateCodes = dedupeStrings((record.change.stateCodes || []).map((code) => String(code || '').toUpperCase()));
	if (stateCodes.some((code) => ['PR', 'VI', 'GU', 'AS', 'MP'].includes(code))) return true;
	return /\bpuerto rico\b|\bvirgin islands\b|\bguam\b|\bamerican samoa\b|\bnorthern mariana\b/.test(buildAdminRankingAlertText(record.feature));
}

function isHighEngagementRegion(record: AutoPostEvaluationRecord): boolean {
	const stateCodes = dedupeStrings((record.change.stateCodes || []).map((code) => String(code || '').toUpperCase()));
	return stateCodes.some((code) => ADMIN_HIGH_ENGAGEMENT_STATE_CODES.has(code));
}

function adminAudienceRelevanceWeight(record: AutoPostEvaluationRecord, impactCategories: AlertImpactCategory[]): number {
	let weight = 0;
	if (record.matchedMetroNames.length > 0) weight += 12;
	if (hasLandAudienceCoverage(record.feature, record.countyCount)) weight += 4;
	if (hasTravelImpactPotential(record.feature, impactCategories)) weight += 10;
	if (!isTerritoryAudienceAlert(record) && isHighEngagementRegion(record) && hasLandAudienceCoverage(record.feature, record.countyCount)) weight += 4;
	if (isMarineOnlyAudienceAlert(record.feature, impactCategories, record.countyCount)) weight -= 16;
	if (hasOffshoreAudiencePattern(record.feature)) weight -= 10;
	if (isTerritoryAudienceAlert(record)) weight -= 10;
	return weight;
}

function adminEngagementValueWeight(record: AutoPostEvaluationRecord, impactCategories: AlertImpactCategory[]): number {
	const text = buildAdminRankingAlertText(record.feature);
	let weight = 0;
	if (/\bsevere weather\b|\bdamaging winds?\b|\bblizzard\b|\bice storm\b|\bwhiteout\b|\bimpactful\b|\bsignificant\b/.test(text)) weight += 6;
	if (/\bspecial weather statement\b/.test(String(record.event || '').toLowerCase())) weight -= 4;
	if (impactCategories.includes('marine') && !hasLandAudienceCoverage(record.feature, record.countyCount)) weight -= 6;
	if (impactCategories.includes('coastal') && !record.matchedMetroNames.length && isTerritoryAudienceAlert(record)) weight -= 4;
	return weight;
}

function adminRecencyWeight(feature: any): number {
	const properties = feature?.properties ?? {};
	const timestampMs = parseTimeMs(String(properties.updated || properties.sent || properties.effective || ''));
	if (timestampMs == null) return 0;
	const ageMinutes = (Date.now() - timestampMs) / (60 * 1000);
	if (ageMinutes <= 60) return 6;
	if (ageMinutes <= 180) return 2;
	return -4;
}

function adminNoiseSuppressionRegionKey(record: AutoPostEvaluationRecord): string {
	if (record.matchedMetroNames.length > 0) return `metro:${record.matchedMetroNames[0]}`;
	const stateCodes = dedupeStrings((record.change.stateCodes || []).map((code) => String(code || '').toUpperCase())).sort();
	if (stateCodes.length > 0) return `state:${stateCodes.join('|')}`;
	return 'region:unknown';
}

function adminWatchImpactBoost(record: AutoPostEvaluationRecord): number {
	if (classifyAlert(record.event) !== 'watch') return 0;
	let boost = 0;
	const durationHours = alertDurationHours(record.feature);
	const text = buildAdminRankingAlertText(record.feature);
	const severity = String(record.feature?.properties?.severity || '').toLowerCase();
	if (record.matchedMetroNames.length > 0) boost += 6;
	else if (record.countyCount >= 15) boost += 8;
	else if (record.countyCount >= 5) boost += 4;
	if (durationHours != null && durationHours >= 12) boost += 4;
	if (/\bmajor\b|\bsignificant\b|\bdangerous\b|\bwidespread\b|\bimpactful\b|\bhazardous\b/.test(text)) boost += 4;
	if (severity === 'severe' || severity === 'extreme') boost += 3;
	return boost;
}

export function buildAdminFacebookPostRankings(alerts: any[]): AdminFacebookPostRanking[] {
	const evaluations: AutoPostEvaluationRecord[] = alerts.map((feature) => {
		const change = buildAdminFacebookPostChange(feature);
		const decision = evaluateAdminFacebookPostDecision(feature, change);
		return {
			feature,
			change,
			decision,
			event: String(feature?.properties?.event || change.event || '').trim(),
			matchedMetroNames: decision.matchedMetroNames,
			countyCount: decision.countyCount,
		};
	});
	const fallbackSelection = selectSevereWeatherFallbackCandidates(evaluations);
	const rankedEntries = evaluations.map((record) => {
		const alertId = String(record.change.alertId || record.feature?.id || '');
		const isFallbackCandidate = fallbackSelection.candidateAlertIds.has(alertId);
		const isFallbackSelected = fallbackSelection.selectedAlertIds.has(alertId);
		const needsFallbackPromotion = isFallbackSelected && !record.decision.eligible;
		const isFallbackSuppressed = isFallbackCandidate && !isFallbackSelected && fallbackSelection.candidateAlertIds.size >= 2;
		const recencyWeight = adminRecencyWeight(record.feature);
		const matchedMetroBonus = record.matchedMetroNames.length > 0
			? Math.max(0, 80 - (highestPriorityMetroRank(record.matchedMetroNames) * 3))
			: 0;
		const coverageBonus = Math.min(60, record.countyCount * 2);
		const impactCategories = deriveAlertImpactCategories(
			record.event,
			String(record.feature?.properties?.headline || ''),
			String(record.feature?.properties?.description || ''),
		);
		const uncappedWatchAdvisoryScore = adminHazardPriorityBase(record.event, impactCategories)
			+ adminCountyReachWeight(record.countyCount)
			+ adminAudienceRelevanceWeight(record, impactCategories)
			+ adminEngagementValueWeight(record, impactCategories)
			+ adminWatchImpactBoost(record)
			+ recencyWeight;
		const watchAdvisoryCap = adminHazardPriorityCap(record.event, impactCategories);
		const watchAdvisoryScore = watchAdvisoryCap == null
			? uncappedWatchAdvisoryScore
			: Math.min(uncappedWatchAdvisoryScore, watchAdvisoryCap);

		let bucket: AdminFacebookPostRankBucket = 'unlikely';
		let bucketLabel = 'Unlikely to auto-post';
		let reasonCode = record.decision.reason;
		let score = 120 + matchedMetroBonus + coverageBonus + recencyWeight;

		if (record.decision.eligible) {
			bucket = 'post_now';
			bucketLabel = 'Would auto-post now';
			score = 700 + matchedMetroBonus + coverageBonus + recencyWeight;
			if (record.decision.reason === 'all_tornado_warnings') score = 1000 + matchedMetroBonus + recencyWeight;
			else if (record.decision.reason === 'tornado_emergency' || record.decision.reason === 'pds_tornado_warning') score = 980 + matchedMetroBonus + recencyWeight;
			else if (
				record.decision.reason === 'flash_flood_emergency'
				|| record.decision.reason === 'extreme_wind_warning'
				|| record.decision.reason === 'storm_surge_warning'
				|| record.decision.reason === 'hurricane_warning'
				|| record.decision.reason === 'hurricane_landfall'
			) score = 940 + matchedMetroBonus + recencyWeight;
			else if (record.decision.reason === 'fire_family_escalation') score = 900 + matchedMetroBonus + recencyWeight;
			else if (record.decision.reason === 'tier2_severe_thunderstorm_warning') score = 840 + matchedMetroBonus + coverageBonus + recencyWeight;
			else if (record.decision.reason === 'tier2_flood_warning') score = 810 + matchedMetroBonus + coverageBonus + recencyWeight;
			else if (record.decision.reason === 'tier2_winter_warning') score = 790 + matchedMetroBonus + coverageBonus + recencyWeight;
			else if (record.decision.reason === 'tier2_high_wind_warning') score = 775 + matchedMetroBonus + coverageBonus + recencyWeight;
		}

		if (needsFallbackPromotion) {
			bucket = 'fallback_pick';
			bucketLabel = 'Fallback pick';
			reasonCode = 'severe_weather_fallback';
			score = 780 + matchedMetroBonus + coverageBonus + recencyWeight;
		} else if (isFallbackSuppressed) {
			bucket = 'manual_review';
			bucketLabel = 'Lower-priority fallback';
			reasonCode = 'severe_weather_fallback_not_selected';
			score = 520 + matchedMetroBonus + coverageBonus + recencyWeight;
		} else if (!record.decision.eligible && isFallbackCandidate) {
			bucket = 'manual_review';
			bucketLabel = fallbackSelection.blockedByHigherTier ? 'Fallback blocked' : 'Fallback candidate';
			score = 560 + matchedMetroBonus + coverageBonus + recencyWeight;
			reasonCode = fallbackSelection.blockedByHigherTier ? 'severe_weather_fallback_not_selected' : 'not_warning';
		} else if (!record.decision.eligible && (
			record.decision.reason === 'severe_thunderstorm_below_threshold'
			|| record.decision.reason === 'severe_thunderstorm_needs_population_or_coverage'
			|| record.decision.reason === 'flood_warning_below_threshold'
			|| record.decision.reason === 'flood_warning_needs_population_or_coverage'
			|| record.decision.reason === 'winter_warning_below_threshold'
			|| record.decision.reason === 'winter_warning_needs_population_or_coverage'
			|| record.decision.reason === 'high_wind_warning_below_threshold'
			|| record.decision.reason === 'high_wind_warning_needs_population_or_coverage'
			|| record.decision.reason === 'fire_family_not_escalated'
		)) {
			bucket = 'manual_review';
			bucketLabel = 'Needs escalation or stronger signal';
			score = 340 + matchedMetroBonus + coverageBonus + recencyWeight;
		} else if (!record.decision.eligible && (
			record.decision.reason === 'impact_gate_not_met'
			|| record.decision.reason === 'not_warning'
			|| record.decision.reason === 'tier3_minor_hazard'
		)) {
			score = watchAdvisoryScore;
			if (score >= 210) {
				bucket = 'manual_review';
				bucketLabel = 'Worth manual review';
			} else {
				bucket = 'unlikely';
				bucketLabel = 'Unlikely to auto-post';
			}
		}

		return {
			record,
			ranking: {
				feature: record.feature,
				alertId,
				event: record.event,
				score,
				bucket,
				bucketLabel,
				reasonCode,
				reasonText: describeAdminFacebookPostReason(
					reasonCode,
					record.matchedMetroNames,
					record.countyCount,
					fallbackSelection.blockedByHigherTier,
				),
				matchedMetroNames: record.matchedMetroNames,
				countyCount: record.countyCount,
			},
		};
	});

	const suppressionGroups = new Map<string, Array<(typeof rankedEntries)[number]>>();
	for (const entry of rankedEntries) {
		if (entry.ranking.bucket === 'post_now' || entry.ranking.bucket === 'fallback_pick') continue;
		const groupKey = `${normalizeEventSlug(entry.record.event)}|${adminNoiseSuppressionRegionKey(entry.record)}`;
		const existing = suppressionGroups.get(groupKey) || [];
		existing.push(entry);
		suppressionGroups.set(groupKey, existing);
	}

	for (const group of suppressionGroups.values()) {
		if (group.length < 5) continue;
		group.sort((a, b) => b.ranking.score - a.ranking.score || a.ranking.alertId.localeCompare(b.ranking.alertId));
		group.forEach((entry, index) => {
			if (index >= 6) entry.ranking.score -= 10;
			else if (index >= 4) entry.ranking.score -= 5;
		});
	}

	return rankedEntries
		.map((entry) => entry.ranking)
		.sort((a, b) => b.score - a.score || a.event.localeCompare(b.event) || a.alertId.localeCompare(b.alertId));
}
