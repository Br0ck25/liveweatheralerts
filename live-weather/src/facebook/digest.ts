import type {
	Env,
	DigestCopyMode,
	DigestHazardFamily,
	DigestHazardCooldownKey,
	DigestAlertTier,
	DigestCandidate,
	DigestRegionalStorySelection,
	HazardClusterSummary,
	DigestSummary,
	DigestThreadRecord,
	PublishedDigestBlockRecord,
	StandaloneCoveredAlertRecord,
	StartupStateRecord,
	FacebookCoverageEvaluation,
	FacebookCoverageIntent,
} from '../types';
import {
	KV_FB_DIGEST_BLOCK,
	KV_FB_DIGEST_HASH,
	KV_FB_DIGEST_ROTATION_CURSOR,
	KV_FB_COVERED_ALERTS,
	KV_FB_STARTUP_STATE,
	KV_FB_DIGEST_THREAD_PREFIX,
	FB_DIGEST_COOLDOWN_MS,
	FB_DIGEST_SAME_HAZARD_COOLDOWN_MS,
	FB_DIGEST_COMMENT_COOLDOWN_MS,
	FB_DIGEST_MAX_POSTS_PER_HOUR,
	FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD,
	FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES,
	FB_STARTUP_GAP_MS,
	FB_INCIDENT_MODE_ALERT_THRESHOLD,
	FB_INCIDENT_MODE_STATE_THRESHOLD,
	FB_MARINE_SUPPRESSION_THRESHOLD,
	FB_CLUSTER_BREAKOUT_FLOOD_WARNINGS,
	FB_CLUSTER_BREAKOUT_SCORE_THRESHOLD,
	FB_CLUSTER_BREAKOUT_MIN_STATES,
	FB_DIGEST_MAX_STORY_STATES,
	PRIMARY_APP_ORIGIN,
} from '../constants';
import { deriveAlertImpactCategories, dedupeStrings } from '../utils';
import { matchingMetroNamesForAlert, readFbAutoPostConfig } from './config';
import {
	readLastFacebookActivityTimestamp,
	readRecentFacebookActivity,
	recordLastFacebookActivity,
} from './activity';
import {
	buildCommentChangeHint,
	buildDigestRegionalBuckets,
	buildDigestRegionalFocus,
	recordRecentDigestOpening,
	stateCodeToName,
} from './llm';

// ---------------------------------------------------------------------------
// Alert classification helpers
// ---------------------------------------------------------------------------

function detectHazardFamily(event: string, headline: string, description: string): DigestHazardFamily {
	const cats = deriveAlertImpactCategories(event, headline, description);
	if (cats.includes('flood')) return 'flood';
	if (cats.includes('winter')) return 'winter';
	if (cats.includes('fire')) return 'fire';
	// wind only if not tornado (tornado is tier 1 standalone)
	if (cats.includes('wind') && !cats.includes('tornado')) return 'wind';
	return 'other';
}

function detectAlertTier(event: string): DigestAlertTier {
	const lower = event.toLowerCase();
	if (/\bwarning\b/.test(lower)) return 'warning';
	if (/\bwatch\b/.test(lower)) return 'watch';
	if (/\badvisory\b/.test(lower)) return 'advisory';
	if (/\bstatement\b/.test(lower)) return 'statement';
	return 'statement';
}

function alertTierScore(tier: DigestAlertTier): number {
	if (tier === 'warning') return 5;
	if (tier === 'watch') return 3;
	if (tier === 'advisory') return 2;
	return 1;
}

function isMarineOrCoastalAlert(event: string, areaDesc: string): boolean {
	const eventL = event.toLowerCase();
	const areaL = areaDesc.toLowerCase();
	return (
		/\bgale\b|\bsmall craft\b|\bhazardous seas\b|\bbeach hazard\b|\bmarine\b|\brip current\b|\bswell\b|\btsunami\b/.test(eventL)
		|| /\bcoastal waters\b|\bopen waters\b|\boffshore\b|\blake\s+waters\b|\binland\s+lake\b|\bharbor\b|\bbay\s+waters\b/.test(areaL)
		|| /^(?:lake|marine|coastal|offshore|nearshore|open lake)\s+/i.test(event)
	);
}

// Tier 1 alerts always get standalone posts — never go into digest
function isTierOneAlert(event: string, properties: any): boolean {
	const e = String(event || '').toLowerCase();
	if (/\btornado warning\b/.test(e)) return true;
	const text = [event, properties?.headline, properties?.description, properties?.instruction]
		.map((v) => String(v || ''))
		.join(' ')
		.toLowerCase();
	if (/\btornado emergency\b/.test(text)) return true;
	if (/\bflash flood emergency\b/.test(text)) return true;
	if (/\bparticularly dangerous situation\b|\bpds tornado\b/.test(text)) return true;
	if (/\bevacuat(?:e|ion|ions|ed)\b/.test(text) && /\bwildfire\b/.test(text)) return true;
	return false;
}

function isTestOrDuplicateOrLowValue(properties: any): boolean {
	const status = String(properties?.status || '').toLowerCase();
	if (status === 'test' || status === 'exercise' || status === 'draft') return true;
	const event = String(properties?.event || '').toLowerCase();
	if (/\btest\b/.test(event)) return true;
	return false;
}

type DigestStateStoryScore = {
	stateCode: string;
	score: number;
	warningCount: number;
	alertCount: number;
	metroCount: number;
};

type DigestStoryComponent = {
	states: string[];
	score: number;
	warningCount: number;
	alertCount: number;
	metroCount: number;
};

const DIGEST_STATE_NEIGHBORS: Record<string, string[]> = {
	AK: [],
	AL: ['FL', 'GA', 'MS', 'TN'],
	AR: ['LA', 'MO', 'MS', 'OK', 'TN', 'TX'],
	AZ: ['CA', 'CO', 'NM', 'NV', 'UT'],
	CA: ['AZ', 'NV', 'OR'],
	CO: ['AZ', 'KS', 'NE', 'NM', 'OK', 'UT', 'WY'],
	CT: ['MA', 'NY', 'RI'],
	DC: ['MD', 'VA'],
	DE: ['MD', 'NJ', 'PA'],
	FL: ['AL', 'GA'],
	GA: ['AL', 'FL', 'NC', 'SC', 'TN'],
	GU: [],
	HI: [],
	IA: ['IL', 'MN', 'MO', 'NE', 'SD', 'WI'],
	ID: ['MT', 'NV', 'OR', 'UT', 'WA', 'WY'],
	IL: ['IA', 'IN', 'KY', 'MO', 'WI'],
	IN: ['IL', 'KY', 'MI', 'OH'],
	KS: ['CO', 'MO', 'NE', 'OK'],
	KY: ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV'],
	LA: ['AR', 'MS', 'TX'],
	MA: ['CT', 'NH', 'NY', 'RI', 'VT'],
	MD: ['DC', 'DE', 'PA', 'VA', 'WV'],
	ME: ['NH'],
	MI: ['IN', 'OH', 'WI'],
	MN: ['IA', 'ND', 'SD', 'WI'],
	MO: ['AR', 'IA', 'IL', 'KS', 'KY', 'NE', 'OK', 'TN'],
	MS: ['AL', 'AR', 'LA', 'TN'],
	MT: ['ID', 'ND', 'SD', 'WY'],
	NC: ['GA', 'SC', 'TN', 'VA'],
	ND: ['MN', 'MT', 'SD'],
	NE: ['CO', 'IA', 'KS', 'MO', 'SD', 'WY'],
	NH: ['MA', 'ME', 'VT'],
	NJ: ['DE', 'NY', 'PA'],
	NM: ['AZ', 'CO', 'OK', 'TX', 'UT'],
	NV: ['AZ', 'CA', 'ID', 'OR', 'UT'],
	NY: ['CT', 'MA', 'NJ', 'PA', 'VT'],
	OH: ['IN', 'KY', 'MI', 'PA', 'WV'],
	OK: ['AR', 'CO', 'KS', 'MO', 'NM', 'TX'],
	OR: ['CA', 'ID', 'NV', 'WA'],
	PA: ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV'],
	PR: [],
	RI: ['CT', 'MA'],
	SC: ['GA', 'NC'],
	SD: ['IA', 'MN', 'MT', 'ND', 'NE', 'WY'],
	TN: ['AL', 'AR', 'GA', 'KY', 'MO', 'MS', 'NC', 'VA'],
	TX: ['AR', 'LA', 'NM', 'OK'],
	UT: ['AZ', 'CO', 'ID', 'NM', 'NV', 'WY'],
	VA: ['DC', 'KY', 'MD', 'NC', 'TN', 'WV'],
	VI: [],
	VT: ['MA', 'NH', 'NY'],
	WA: ['ID', 'OR'],
	WI: ['IA', 'IL', 'MI', 'MN'],
	WV: ['KY', 'MD', 'OH', 'PA', 'VA'],
	WY: ['CO', 'ID', 'MT', 'NE', 'SD', 'UT'],
};

const DIGEST_STORY_REGION_BY_STATE: Record<string, string> = {
	AK: 'Pacific',
	AL: 'Gulf Coast',
	AR: 'Southeast',
	AZ: 'Southwest',
	CA: 'West Coast',
	CO: 'Rockies',
	CT: 'Northeast',
	DC: 'Northeast',
	DE: 'Northeast',
	FL: 'Gulf Coast',
	GA: 'Southeast',
	GU: 'Pacific',
	HI: 'Pacific',
	IA: 'Midwest',
	ID: 'Rockies',
	IL: 'Midwest',
	IN: 'Midwest',
	KS: 'Plains',
	KY: 'Southeast',
	LA: 'Gulf Coast',
	MA: 'Northeast',
	MD: 'Northeast',
	ME: 'Northeast',
	MI: 'Midwest',
	MN: 'Midwest',
	MO: 'Midwest',
	MS: 'Gulf Coast',
	MT: 'Rockies',
	NC: 'Southeast',
	ND: 'Plains',
	NE: 'Plains',
	NH: 'Northeast',
	NJ: 'Northeast',
	NM: 'Southwest',
	NV: 'Rockies',
	NY: 'Northeast',
	OH: 'Midwest',
	OK: 'Plains',
	OR: 'West Coast',
	PA: 'Northeast',
	PR: 'Caribbean',
	RI: 'Northeast',
	SC: 'Southeast',
	SD: 'Plains',
	TN: 'Southeast',
	TX: 'Plains',
	UT: 'Rockies',
	VA: 'Southeast',
	VI: 'Caribbean',
	VT: 'Northeast',
	WA: 'West Coast',
	WI: 'Midwest',
	WV: 'Southeast',
	WY: 'Rockies',
};

const DIGEST_STORY_REGION_PAIR_LABELS: Record<string, string> = {
	'Gulf Coast|Southeast': 'Southeast',
	'Midwest|Northeast': 'Great Lakes and Northeast',
	'Midwest|Plains': 'northern Plains and Upper Midwest',
	'Rockies|Southwest': 'Southwest',
	'Rockies|West Coast': 'West',
};

function digestSeverityScore(severity: string): number {
	const normalized = String(severity || '').trim().toLowerCase();
	if (normalized === 'extreme') return 4;
	if (normalized === 'severe') return 3;
	if (normalized === 'moderate') return 2;
	if (normalized === 'minor') return 1;
	return 0;
}

function digestUrgencyScore(urgency: string): number {
	const normalized = String(urgency || '').trim().toLowerCase();
	if (normalized === 'immediate') return 3;
	if (normalized === 'expected') return 2;
	if (normalized === 'future') return 1;
	return 0;
}

function scoreDigestCandidateForStory(candidate: DigestCandidate): number {
	const metroBonus = Math.min(2, candidate.matchedMetroNames.length) * 4;
	const warningMetroBonus = candidate.alertTier === 'warning' && candidate.matchedMetroNames.length > 0 ? 2 : 0;
	return (alertTierScore(candidate.alertTier) * 12)
		+ (digestSeverityScore(candidate.severity) * 3)
		+ (digestUrgencyScore(candidate.urgency) * 2)
		+ metroBonus
		+ warningMetroBonus;
}

function compareDigestStateStoryScores(left: DigestStateStoryScore, right: DigestStateStoryScore): number {
	const scoreDiff = right.score - left.score;
	if (scoreDiff !== 0) return scoreDiff;

	const warningDiff = right.warningCount - left.warningCount;
	if (warningDiff !== 0) return warningDiff;

	const metroDiff = right.metroCount - left.metroCount;
	if (metroDiff !== 0) return metroDiff;

	const alertDiff = right.alertCount - left.alertCount;
	if (alertDiff !== 0) return alertDiff;

	return left.stateCode.localeCompare(right.stateCode);
}

function compareDigestStoryComponents(left: DigestStoryComponent, right: DigestStoryComponent): number {
	const scoreDiff = right.score - left.score;
	if (scoreDiff !== 0) return scoreDiff;

	const warningDiff = right.warningCount - left.warningCount;
	if (warningDiff !== 0) return warningDiff;

	const metroDiff = right.metroCount - left.metroCount;
	if (metroDiff !== 0) return metroDiff;

	const stateDiff = right.states.length - left.states.length;
	if (stateDiff !== 0) return stateDiff;

	return left.states.join('|').localeCompare(right.states.join('|'));
}

function buildDigestStateStoryScores(candidates: DigestCandidate[]): Map<string, DigestStateStoryScore> {
	const scores = new Map<string, DigestStateStoryScore>();

	for (const candidate of candidates) {
		const weight = scoreDigestCandidateForStory(candidate);
		const metroCount = Math.min(2, candidate.matchedMetroNames.length);
		for (const stateCode of dedupeStrings(candidate.stateCodes.map((state) => state.toUpperCase()))) {
			const existing = scores.get(stateCode) ?? {
				stateCode,
				score: 0,
				warningCount: 0,
				alertCount: 0,
				metroCount: 0,
			};
			existing.score += weight;
			existing.alertCount += 1;
			existing.metroCount += metroCount;
			if (candidate.alertTier === 'warning') {
				existing.warningCount += 1;
			}
			scores.set(stateCode, existing);
		}
	}

	return scores;
}

function buildDigestStoryComponents(stateScores: Map<string, DigestStateStoryScore>): DigestStoryComponent[] {
	const stateSet = new Set(stateScores.keys());
	const remaining = new Set(stateSet);
	const components: DigestStoryComponent[] = [];

	while (remaining.size > 0) {
		const seed = Array.from(remaining)[0];
		const queue = [seed];
		const componentStates = new Set<string>();
		remaining.delete(seed);

		while (queue.length > 0) {
			const stateCode = queue.shift();
			if (!stateCode || componentStates.has(stateCode)) continue;
			componentStates.add(stateCode);
			for (const neighbor of DIGEST_STATE_NEIGHBORS[stateCode] || []) {
				if (!stateSet.has(neighbor) || !remaining.has(neighbor)) continue;
				remaining.delete(neighbor);
				queue.push(neighbor);
			}
		}

		const orderedStates = Array.from(componentStates)
			.map((stateCode) => stateScores.get(stateCode))
			.filter((record): record is DigestStateStoryScore => !!record)
			.sort(compareDigestStateStoryScores);

		components.push({
			states: orderedStates.map((record) => record.stateCode),
			score: orderedStates.reduce((total, record) => total + record.score, 0),
			warningCount: orderedStates.reduce((total, record) => total + record.warningCount, 0),
			alertCount: orderedStates.reduce((total, record) => total + record.alertCount, 0),
			metroCount: orderedStates.reduce((total, record) => total + record.metroCount, 0),
		});
	}

	return components.sort(compareDigestStoryComponents);
}

function buildDigestStoryRegionLabel(
	states: string[],
	stateScores: Map<string, DigestStateStoryScore>,
	hazardFamily: DigestHazardFamily | null = null,
): string | null {
	if (states.length === 0) return null;

	if (hazardFamily === 'flood' && states.some((stateCode) => ['TX', 'LA', 'MS', 'AL', 'FL'].includes(stateCode))) {
		return 'Gulf Coast';
	}
	if (hazardFamily === 'fire' && states.some((stateCode) => ['AZ', 'NM', 'TX'].includes(stateCode))) {
		return 'Southwest';
	}

	const regionScores = new Map<string, number>();
	for (const stateCode of states) {
		const region = DIGEST_STORY_REGION_BY_STATE[stateCode] || stateCode;
		const score = stateScores.get(stateCode)?.score ?? 0;
		regionScores.set(region, (regionScores.get(region) || 0) + score);
	}

	const orderedRegions = Array.from(regionScores.entries()).sort((left, right) => {
		const scoreDiff = right[1] - left[1];
		if (scoreDiff !== 0) return scoreDiff;
		return left[0].localeCompare(right[0]);
	});

	const primaryRegion = orderedRegions[0]?.[0] ?? null;
	const primaryScore = orderedRegions[0]?.[1] ?? 0;
	const secondaryRegion = orderedRegions[1]?.[0] ?? null;
	const secondaryScore = orderedRegions[1]?.[1] ?? 0;
	if (!primaryRegion) return null;

	if (secondaryRegion && primaryScore > 0 && secondaryScore >= (primaryScore * 0.65)) {
		const pairKey = [primaryRegion, secondaryRegion].sort().join('|');
		return DIGEST_STORY_REGION_PAIR_LABELS[pairKey] || primaryRegion;
	}

	return primaryRegion;
}

export function selectDigestRegionalStory(candidates: DigestCandidate[]): DigestRegionalStorySelection {
	if (candidates.length === 0) {
		return {
			storyRegion: null,
			storyStates: [],
			outlierStates: [],
			regionalCoherence: 'cohesive',
			dominantStateShare: 1,
		};
	}

	const stateScores = buildDigestStateStoryScores(candidates);
	const components = buildDigestStoryComponents(stateScores);
	const dominantComponent = components[0];
	if (!dominantComponent) {
		return {
			storyRegion: null,
			storyStates: [],
			outlierStates: [],
			regionalCoherence: 'cohesive',
			dominantStateShare: 1,
		};
	}

	const totalStateScore = Array.from(stateScores.values()).reduce((total, record) => total + record.score, 0);
	const dominantStateShare = totalStateScore > 0 ? dominantComponent.score / totalStateScore : 1;
	const dominantOrderedStates = dominantComponent.states
		.map((stateCode) => stateScores.get(stateCode))
		.filter((record): record is DigestStateStoryScore => !!record);
	const topStateScore = dominantOrderedStates[0]?.score ?? 0;
	const minimumRetainedStates = Math.min(3, dominantOrderedStates.length);
	let storyStates = dominantOrderedStates
		.filter((record) => topStateScore <= 0 || record.score >= (topStateScore * 0.6))
		.map((record) => record.stateCode)
		.slice(0, FB_DIGEST_MAX_STORY_STATES);
	if (storyStates.length < minimumRetainedStates) {
		storyStates = dominantOrderedStates
			.slice(0, Math.min(FB_DIGEST_MAX_STORY_STATES, minimumRetainedStates))
			.map((record) => record.stateCode);
	}
	const storyStateSet = new Set(storyStates);
	const outlierStates = Array.from(stateScores.values())
		.sort(compareDigestStateStoryScores)
		.map((record) => record.stateCode)
		.filter((stateCode) => !storyStateSet.has(stateCode));

	return {
		storyRegion: buildDigestStoryRegionLabel(
			dominantComponent.states,
			stateScores,
			candidates[0]?.hazardFamily ?? null,
		),
		storyStates,
		outlierStates,
		regionalCoherence: components.length === 1 || dominantStateShare >= 0.65 ? 'cohesive' : 'scattered',
		dominantStateShare,
	};
}

// ---------------------------------------------------------------------------
// Covered alerts KV helpers
// ---------------------------------------------------------------------------

export async function readStandaloneCoveredAlerts(env: Env): Promise<Set<string>> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_COVERED_ALERTS);
		if (!raw) return new Set();
		const record = JSON.parse(raw) as StandaloneCoveredAlertRecord;
		return new Set(record.alertIds || []);
	} catch {
		return new Set();
	}
}

export async function markAlertStandaloneCovered(env: Env, alertId: string): Promise<void> {
	try {
		const covered = await readStandaloneCoveredAlerts(env);
		covered.add(alertId);
		const record: StandaloneCoveredAlertRecord = {
			alertIds: Array.from(covered),
			updatedAt: new Date().toISOString(),
		};
		await env.WEATHER_KV.put(KV_FB_COVERED_ALERTS, JSON.stringify(record), { expirationTtl: 7200 });
	} catch {
		// Non-critical — covered alerts is best-effort
	}
}

export async function pruneExpiredCoveredAlerts(env: Env, activeAlertIds: Set<string>): Promise<void> {
	try {
		const covered = await readStandaloneCoveredAlerts(env);
		const pruned = new Set([...covered].filter((id) => activeAlertIds.has(id)));
		if (pruned.size === covered.size) return;
		const record: StandaloneCoveredAlertRecord = {
			alertIds: Array.from(pruned),
			updatedAt: new Date().toISOString(),
		};
		await env.WEATHER_KV.put(KV_FB_COVERED_ALERTS, JSON.stringify(record), { expirationTtl: 7200 });
	} catch {
		// Non-critical
	}
}

// ---------------------------------------------------------------------------
// Startup state KV helpers
// ---------------------------------------------------------------------------

async function readStartupState(env: Env): Promise<StartupStateRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_STARTUP_STATE);
		if (!raw) return null;
		return JSON.parse(raw) as StartupStateRecord;
	} catch {
		return null;
	}
}

async function writeStartupState(env: Env, state: StartupStateRecord): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_STARTUP_STATE, JSON.stringify(state), { expirationTtl: 8 * 60 * 60 });
}

export async function isStartupMode(env: Env, nowMs = Date.now()): Promise<boolean> {
	const lastPost = await readLastFacebookActivityTimestamp(env);
	if (lastPost == null) return true;
	if ((nowMs - lastPost) > FB_STARTUP_GAP_MS) return true;
	const digestBlock = await readDigestBlockRecord(env);
	if (!digestBlock) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Digest block / hash / rotation KV helpers
// ---------------------------------------------------------------------------

async function readDigestBlockRecord(env: Env): Promise<PublishedDigestBlockRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_DIGEST_BLOCK);
		if (!raw) return null;
		return JSON.parse(raw) as PublishedDigestBlockRecord;
	} catch {
		return null;
	}
}

async function writeDigestBlockRecord(env: Env, record: PublishedDigestBlockRecord): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_DIGEST_BLOCK, JSON.stringify(record), { expirationTtl: 2 * 60 * 60 });
}

async function readLastDigestHash(env: Env): Promise<string | null> {
	try {
		return await env.WEATHER_KV.get(KV_FB_DIGEST_HASH);
	} catch {
		return null;
	}
}

async function writeLastDigestHash(env: Env, hash: string): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_DIGEST_HASH, hash, { expirationTtl: 2 * 60 * 60 });
}

async function readRotationCursor(env: Env): Promise<number> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_DIGEST_ROTATION_CURSOR);
		if (!raw) return 0;
		const n = Number(raw);
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}

async function writeRotationCursor(env: Env, cursor: number): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_DIGEST_ROTATION_CURSOR, String(cursor), { expirationTtl: 24 * 60 * 60 });
}

// ---------------------------------------------------------------------------
// Digest thread KV helpers (separate from alert threads)
// ---------------------------------------------------------------------------

export async function readDigestThread(env: Env, blockId: string): Promise<DigestThreadRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_DIGEST_THREAD_PREFIX + blockId);
		if (!raw) return null;
		return JSON.parse(raw) as DigestThreadRecord;
	} catch {
		return null;
	}
}

async function writeDigestThread(env: Env, blockId: string, record: DigestThreadRecord): Promise<void> {
	await env.WEATHER_KV.put(
		KV_FB_DIGEST_THREAD_PREFIX + blockId,
		JSON.stringify(record),
		{ expirationTtl: 2 * 60 * 60 },
	);
}

// ---------------------------------------------------------------------------
// Core digest building logic
// ---------------------------------------------------------------------------

export function buildDigestCandidates(
	alertMap: Record<string, any>,
	coveredAlertIds: Set<string>,
): DigestCandidate[] {
	const candidates: DigestCandidate[] = [];
	for (const [alertId, feature] of Object.entries(alertMap)) {
		const p = feature?.properties ?? {};
		const event = String(p.event || '').trim();
		if (!event) continue;
		if (isTestOrDuplicateOrLowValue(p)) continue;
		if (isTierOneAlert(event, p)) continue;
		if (coveredAlertIds.has(alertId)) continue;

		const stateCodes = dedupeStrings(extractStateCodesFromFeature(feature));
		if (stateCodes.length === 0) continue;

		const areaDesc = String(p.areaDesc || '').trim();
		const isMarine = isMarineOrCoastalAlert(event, areaDesc);
		const matchedMetroNames = matchingMetroNamesForAlert(feature);
		const hazardFamily = detectHazardFamily(event, String(p.headline || ''), String(p.description || ''));
		const alertTier = detectAlertTier(event);

		candidates.push({
			alertId,
			stateCodes,
			event,
			areaDesc,
			urgency: String(p.urgency || ''),
			severity: String(p.severity || ''),
			certainty: String(p.certainty || ''),
			hazardFamily,
			alertTier,
			matchedMetroNames,
			isMarineOrCoastal: isMarine,
		});
	}
	return candidates;
}

function extractStateCodesFromFeature(feature: any): string[] {
	const codes: string[] = [];
	const properties = feature?.properties ?? {};

	// From geocode.UGC (e.g. "KYC123" → first 2 chars = state)
	if (Array.isArray(properties.geocode?.UGC)) {
		for (const ugc of properties.geocode.UGC) {
			const code = String(ugc || '').trim().toUpperCase().slice(0, 2);
			if (/^[A-Z]{2}$/.test(code)) codes.push(code);
		}
	}
	// From geocode.SAME (FIPS: first 2 digits = state FIPS, but we need alpha codes)
	// Fall back to areaDesc parsing — look for standard 2-letter state codes at end of phrases
	if (codes.length === 0) {
		const areaDesc = String(properties.areaDesc || '');
		const matches = areaDesc.match(/\b([A-Z]{2})\b/g);
		if (matches) {
			const validStateCodes = new Set([
				'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
				'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
				'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','GU','PR','VI',
			]);
			for (const m of matches) {
				if (validStateCodes.has(m)) codes.push(m);
			}
		}
	}
	return dedupeStrings(codes);
}

function applyMarineSuppression(candidates: DigestCandidate[]): {
	candidates: DigestCandidate[];
	marineShare: number;
	suppressed: boolean;
} {
	if (candidates.length === 0) return { candidates, marineShare: 0, suppressed: false };
	const marineCount = candidates.filter((c) => c.isMarineOrCoastal).length;
	const marineShare = marineCount / candidates.length;
	if (marineShare > FB_MARINE_SUPPRESSION_THRESHOLD) {
		return {
			candidates: candidates.filter((c) => !c.isMarineOrCoastal),
			marineShare,
			suppressed: true,
		};
	}
	return { candidates, marineShare, suppressed: false };
}

function detectOperatingMode(
	totalActiveCandidates: number,
	distinctStates: number,
	marineShare: number,
): 'normal' | 'incident' {
	if (totalActiveCandidates >= FB_INCIDENT_MODE_ALERT_THRESHOLD) return 'incident';
	if (distinctStates >= FB_INCIDENT_MODE_STATE_THRESHOLD) return 'incident';
	if (marineShare >= FB_MARINE_SUPPRESSION_THRESHOLD) return 'incident';
	return 'normal';
}

function getDigestHazardCooldownKey(hazardFocus: DigestHazardFamily | null | undefined): DigestHazardCooldownKey {
	return hazardFocus ?? 'multi';
}

function getLastPublishedAtForHazardFocus(
	block: PublishedDigestBlockRecord | null,
	hazardFocus: DigestHazardFamily | null,
): string | null {
	if (!block) return null;
	const key = getDigestHazardCooldownKey(hazardFocus);
	const fromMap = block.lastPublishedAtByFocus?.[key];
	if (fromMap) return fromMap;
	if ((block.hazardFocus ?? null) === (hazardFocus ?? null)) {
		return block.publishedAt;
	}
	return null;
}

function getLastPublishedMsForHazardFocus(
	block: PublishedDigestBlockRecord | null,
	hazardFocus: DigestHazardFamily | null,
): number | null {
	const publishedAt = getLastPublishedAtForHazardFocus(block, hazardFocus);
	if (!publishedAt) return null;
	const publishedMs = Date.parse(publishedAt);
	return Number.isFinite(publishedMs) ? publishedMs : null;
}

function isHazardFocusCoolingDown(
	block: PublishedDigestBlockRecord | null,
	hazardFocus: DigestHazardFamily | null,
	nowMs: number,
): boolean {
	const lastPublishedMs = getLastPublishedMsForHazardFocus(block, hazardFocus);
	if (lastPublishedMs == null) return false;
	return (nowMs - lastPublishedMs) < FB_DIGEST_SAME_HAZARD_COOLDOWN_MS;
}

function buildNextPublishedAtByFocus(
	previousBlock: PublishedDigestBlockRecord | null,
	hazardFocus: DigestHazardFamily | null,
	publishedAt: string,
): Partial<Record<DigestHazardCooldownKey, string>> {
	const next = {
		...(previousBlock?.lastPublishedAtByFocus ?? {}),
	};
	if (previousBlock?.publishedAt) {
		next[getDigestHazardCooldownKey(previousBlock.hazardFocus ?? null)] = previousBlock.publishedAt;
	}
	next[getDigestHazardCooldownKey(hazardFocus)] = publishedAt;
	return next;
}

function buildDigestBlockId(nowMs: number): string {
	return `block-${Math.floor(nowMs / FB_DIGEST_COOLDOWN_MS)}`;
}

function digestUrgencyRank(urgency: DigestSummary['urgency']): number {
	if (urgency === 'high') return 3;
	if (urgency === 'moderate') return 2;
	return 1;
}

function getRecentDigestPostTimestamps(block: PublishedDigestBlockRecord | null): string[] {
	const timestamps = dedupeStrings([
		...(block?.recentPostTimestamps ?? []),
		block?.publishedAt ?? '',
	]);
	return timestamps
		.filter((timestamp) => Number.isFinite(Date.parse(timestamp)))
		.sort((a, b) => Date.parse(a) - Date.parse(b));
}

function countRecentDigestPosts(
	block: PublishedDigestBlockRecord | null,
	nowMs: number,
	windowMs = FB_DIGEST_COOLDOWN_MS,
): number {
	return getRecentDigestPostTimestamps(block)
		.filter((timestamp) => {
			const publishedMs = Date.parse(timestamp);
			return Number.isFinite(publishedMs) && (nowMs - publishedMs) < windowMs;
		})
		.length;
}

function buildNextRecentDigestPostTimestamps(
	previousBlock: PublishedDigestBlockRecord | null,
	publishedAt: string,
): string[] {
	const publishedMs = Date.parse(publishedAt);
	const cutoffMs = Number.isFinite(publishedMs)
		? publishedMs - (2 * FB_DIGEST_COOLDOWN_MS)
		: Date.now() - (2 * FB_DIGEST_COOLDOWN_MS);
	return dedupeStrings([
		...getRecentDigestPostTimestamps(previousBlock),
		publishedAt,
	])
		.filter((timestamp) => {
			const timestampMs = Date.parse(timestamp);
			return Number.isFinite(timestampMs) && timestampMs >= cutoffMs;
		})
		.sort((a, b) => Date.parse(a) - Date.parse(b))
		.slice(-6);
}

const HAZARD_CLUSTER_TIEBREAK_ORDER: DigestHazardFamily[] = ['flood', 'winter', 'wind', 'fire', 'other'];

function compareHazardClusters(a: HazardClusterSummary, b: HazardClusterSummary): number {
	const scoreDiff = b.score - a.score;
	if (scoreDiff !== 0) return scoreDiff;

	const warningDiff = (b.warningCount ?? 0) - (a.warningCount ?? 0);
	if (warningDiff !== 0) return warningDiff;

	const stateDiff = b.states.length - a.states.length;
	if (stateDiff !== 0) return stateDiff;

	const alertDiff = b.alertCount - a.alertCount;
	if (alertDiff !== 0) return alertDiff;

	return HAZARD_CLUSTER_TIEBREAK_ORDER.indexOf(a.family) - HAZARD_CLUSTER_TIEBREAK_ORDER.indexOf(b.family);
}

export function buildHazardClusters(candidates: DigestCandidate[]): HazardClusterSummary[] {
	const familyMap = new Map<DigestHazardFamily, DigestCandidate[]>();
	for (const c of candidates) {
		const existing = familyMap.get(c.hazardFamily) || [];
		existing.push(c);
		familyMap.set(c.hazardFamily, existing);
	}

	const clusters: HazardClusterSummary[] = [];
	for (const [family, items] of familyMap) {
		const stateSet = new Set<string>();
		let score = 0;
		let warningCount = 0;
		const regionalStory = selectDigestRegionalStory(items);
		const eventCounts = new Map<string, number>();
		for (const item of items) {
			for (const s of item.stateCodes) stateSet.add(s);
			score += alertTierScore(item.alertTier);
			if (item.alertTier === 'warning') warningCount += 1;
			eventCounts.set(item.event, (eventCounts.get(item.event) || 0) + 1);
		}
		const topAlertTypes = Array.from(eventCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([ev]) => ev);
		clusters.push({
			family,
			states: Array.from(stateSet).sort(),
			score,
			alertCount: items.length,
			warningCount,
			topAlertTypes,
			storyRegion: regionalStory.storyRegion,
			storyStates: regionalStory.storyStates,
			outlierStates: regionalStory.outlierStates,
			regionalCoherence: regionalStory.regionalCoherence,
			dominantStateShare: regionalStory.dominantStateShare,
		});
	}
	clusters.sort(compareHazardClusters);
	return clusters;
}

function scoreStates(candidates: DigestCandidate[]): Map<string, number> {
	const scores = new Map<string, number>();
	for (const c of candidates) {
		const pts = alertTierScore(c.alertTier);
		for (const s of c.stateCodes) {
			scores.set(s, (scores.get(s) || 0) + pts);
		}
	}
	return scores;
}

function selectStatesForDigest(
	stateScores: Map<string, number>,
	rotationCursor: number,
	preferredStates: string[] = [],
): { selectedStates: string[]; nextCursor: number } {
	const curatedStates = dedupeStrings(preferredStates.map((stateCode) => String(stateCode || '').trim().toUpperCase()))
		.slice(0, FB_DIGEST_MAX_STORY_STATES);
	if (curatedStates.length > 0) {
		return { selectedStates: curatedStates, nextCursor: rotationCursor };
	}

	const distinctStates = Array.from(stateScores.keys()).sort((a, b) => {
		const scoreDiff = (stateScores.get(b) || 0) - (stateScores.get(a) || 0);
		if (scoreDiff !== 0) return scoreDiff;
		return a.localeCompare(b);
	});

	return {
		selectedStates: distinctStates.slice(0, FB_DIGEST_MAX_STORY_STATES),
		nextCursor: rotationCursor,
	};
}

export function checkClusterBreakout(clusters: HazardClusterSummary[]): HazardClusterSummary | null {
	const qualifyingClusters = clusters.filter((cluster) => {
		if (cluster.family === 'flood') {
			const floodWarnings = cluster.warningCount ?? 0;
			const multiState = cluster.states.length >= 2;
			if (floodWarnings >= FB_CLUSTER_BREAKOUT_FLOOD_WARNINGS && multiState) {
				return true;
			}
		}

		return cluster.score >= FB_CLUSTER_BREAKOUT_SCORE_THRESHOLD
			&& cluster.states.length >= FB_CLUSTER_BREAKOUT_MIN_STATES;
	});

	if (qualifyingClusters.length === 0) return null;
	return [...qualifyingClusters].sort(compareHazardClusters)[0] ?? null;
}

export function selectDigestPrimaryCluster(
	clusters: HazardClusterSummary[],
	clusterBreakout: HazardClusterSummary | null,
	previousBlock: PublishedDigestBlockRecord | null,
	nowMs: number,
): HazardClusterSummary | null {
	const orderedClusters = [clusterBreakout, ...clusters]
		.filter((cluster): cluster is HazardClusterSummary => cluster != null)
		.filter((cluster, index, list) => list.findIndex((entry) => entry.family === cluster.family) === index);

	if (orderedClusters.length === 0) return null;

	return orderedClusters.find((cluster) => !isHazardFocusCoolingDown(previousBlock, cluster.family, nowMs))
		?? orderedClusters[0]
		?? null;
}

function buildDigestHash(
	states: string[],
	topAlertTypes: string[],
	hazardFocus: string | null,
	storyRegion: string | null = null,
): string {
	return `${hazardFocus || 'multi'}|${storyRegion || 'regionless'}|${[...states].sort().join(',')}|${[...topAlertTypes].sort().join(',')}`;
}

function getDigestStoryStates(summary: Pick<DigestSummary, 'states' | 'storyStates'>): string[] {
	const storyStates = Array.isArray(summary.storyStates) && summary.storyStates.length > 0
		? summary.storyStates
		: summary.states;
	return dedupeStrings(storyStates.map((state) => String(state || '').trim().toUpperCase()));
}

function getDigestStoryFingerprint(summary: Pick<DigestSummary, 'states' | 'storyStates' | 'storyFingerprint' | 'topAlertTypes' | 'hazardFocus' | 'storyRegion'>): string {
	return summary.storyFingerprint
		? String(summary.storyFingerprint)
		: buildDigestHash(
			getDigestStoryStates(summary),
			summary.topAlertTypes,
			summary.hazardFocus,
			summary.storyRegion ?? null,
		);
}

function deriveDigestUrgency(candidates: DigestCandidate[]): 'high' | 'moderate' | 'low' {
	const hasSevere = candidates.some((c) => /extreme|severe/i.test(c.severity));
	if (hasSevere) return 'high';
	const hasWarning = candidates.some((c) => c.alertTier === 'warning');
	if (hasWarning) return 'moderate';
	return 'low';
}

export function buildDigestSummary(
	candidates: DigestCandidate[],
	clusters: HazardClusterSummary[],
	selectedStates: string[],
	mode: 'normal' | 'incident',
	clusterBreakout: HazardClusterSummary | null,
	primaryCluster: HazardClusterSummary | null = null,
): DigestSummary {
	const focusCluster = primaryCluster ?? clusterBreakout ?? (clusters[0] ?? null);
	const hazardFocus = focusCluster?.family ?? null;
	const storyRegion = focusCluster?.storyRegion ?? null;
	const storyStates = dedupeStrings((focusCluster?.storyStates && focusCluster.storyStates.length > 0
		? focusCluster.storyStates
		: (focusCluster?.states ?? selectedStates)).map((state) => String(state || '').trim().toUpperCase()));
	const outlierStates = dedupeStrings((focusCluster?.outlierStates ?? []).map((stateCode) => String(stateCode || '').trim().toUpperCase()));
	const topAlertTypes = dedupeStrings([
		...(focusCluster?.topAlertTypes ?? []),
		...clusters.flatMap((c) => c.topAlertTypes),
	]).slice(0, 3);
	const urgency = deriveDigestUrgency(candidates);
	const warningCount = candidates.filter((candidate) => candidate.alertTier === 'warning').length;
	const hash = buildDigestHash(storyStates, topAlertTypes, hazardFocus, storyRegion);

	return {
		mode,
		postType: clusterBreakout && focusCluster?.family === clusterBreakout.family ? 'cluster' : 'digest',
		hazardFocus: hazardFocus ?? null,
		states: selectedStates,
		storyStates,
		storyFingerprint: hash,
		topAlertTypes,
		urgency,
		alertCount: candidates.length,
		warningCount,
		hash,
		storyRegion,
		outlierStates,
		regionalCoherence: focusCluster?.regionalCoherence ?? (outlierStates.length > 0 ? 'scattered' : 'cohesive'),
	};
}

function normalizeDigestAlertTypes(alertTypes: string[]): string[] {
	return dedupeStrings(alertTypes.map((alertType) => String(alertType || '').trim().toLowerCase()));
}

function hasDigestAlertTypeOverlap(previousSummary: DigestSummary, currentSummary: DigestSummary): boolean {
	const previousAlertTypes = new Set(normalizeDigestAlertTypes(previousSummary.topAlertTypes));
	return normalizeDigestAlertTypes(currentSummary.topAlertTypes)
		.some((alertType) => previousAlertTypes.has(alertType));
}

type DigestNewPostGapEvaluation = {
	allowed: boolean;
	withinGap: boolean;
	lastPublishedMs: number | null;
	timeSinceLastDigestPostMs: number | null;
	reason: 'no_previous_digest_post' | 'digest_new_post_gap_not_met' | 'digest_new_post_allowed_after_60m';
};

type DigestSameStoryEvaluation = {
	sameHazardFamily: boolean;
	sameStoryRegion: boolean;
	sameTopAlertTypes: boolean;
	sameStoryFingerprint: boolean;
	storyStateOverlapRatio: number;
	samePublicStory: boolean;
	clearlyDifferentStory: boolean;
};

type DigestSecondPostAllowance = {
	allowed: boolean;
	reason:
		| 'digest_second_post_allowed_hazard_change'
		| 'digest_second_post_allowed_region_change'
		| 'digest_second_post_allowed_warning_jump'
		| 'digest_second_post_allowed_new_major_story'
		| 'digest_second_post_allowed_urgency_increase'
		| 'digest_second_post_blocked_not_material';
};

function digestStateOverlapRatio(previousStates: string[], currentStates: string[]): number {
	if (previousStates.length === 0 && currentStates.length === 0) return 1;
	if (previousStates.length === 0 || currentStates.length === 0) return 0;
	const previousStateSet = new Set(previousStates);
	const sharedStateCount = currentStates.filter((state) => previousStateSet.has(state)).length;
	return sharedStateCount / Math.max(previousStates.length, currentStates.length);
}

export function evaluateDigestNewPostGap(
	block: PublishedDigestBlockRecord | null | undefined,
	nowMs: number,
): DigestNewPostGapEvaluation {
	const lastPublishedMs = Number.isFinite(Date.parse(String(block?.publishedAt || '')))
		? Date.parse(String(block?.publishedAt || ''))
		: null;
	if (lastPublishedMs == null) {
		return {
			allowed: true,
			withinGap: false,
			lastPublishedMs: null,
			timeSinceLastDigestPostMs: null,
			reason: 'no_previous_digest_post',
		};
	}

	const timeSinceLastDigestPostMs = nowMs - lastPublishedMs;
	const withinGap = timeSinceLastDigestPostMs >= 0 && timeSinceLastDigestPostMs < FB_DIGEST_COOLDOWN_MS;
	return {
		allowed: !withinGap,
		withinGap,
		lastPublishedMs,
		timeSinceLastDigestPostMs,
		reason: withinGap ? 'digest_new_post_gap_not_met' : 'digest_new_post_allowed_after_60m',
	};
}

export function evaluateDigestSameStory(
	previousSummary: DigestSummary | null | undefined,
	currentSummary: DigestSummary,
): DigestSameStoryEvaluation {
	if (!previousSummary) {
		return {
			sameHazardFamily: false,
			sameStoryRegion: false,
			sameTopAlertTypes: false,
			sameStoryFingerprint: false,
			storyStateOverlapRatio: 0,
			samePublicStory: false,
			clearlyDifferentStory: false,
		};
	}

	const previousRegionalFocus = buildDigestRegionalFocus(previousSummary);
	const currentRegionalFocus = buildDigestRegionalFocus(currentSummary);
	const previousStates = getDigestStoryStates(previousSummary);
	const currentStates = getDigestStoryStates(currentSummary);
	const previousRegionalBuckets = new Set(buildDigestRegionalBuckets(previousSummary));
	const sharedRegionalBucket = buildDigestRegionalBuckets(currentSummary)
		.some((bucket) => previousRegionalBuckets.has(bucket));
	const sameHazardFamily = (previousSummary.hazardFocus ?? null) === (currentSummary.hazardFocus ?? null);
	const sameStoryRegion = previousRegionalFocus === currentRegionalFocus || sharedRegionalBucket;
	const sameTopAlertTypes = hasDigestAlertTypeOverlap(previousSummary, currentSummary)
		|| normalizeDigestAlertTypes(previousSummary.topAlertTypes)[0] === normalizeDigestAlertTypes(currentSummary.topAlertTypes)[0];
	const sameStoryFingerprint = getDigestStoryFingerprint(previousSummary) === getDigestStoryFingerprint(currentSummary);
	const storyStateOverlapRatio = digestStateOverlapRatio(previousStates, currentStates);
	const samePublicStory = sameHazardFamily
		&& sameStoryRegion
		&& sameTopAlertTypes
		&& (sameStoryFingerprint || storyStateOverlapRatio >= 0.5);
	const clearlyDifferentStory = !samePublicStory && (
		!sameHazardFamily
		|| !sameStoryRegion
		|| !sameTopAlertTypes
		|| storyStateOverlapRatio < 0.34
		|| (storyStateOverlapRatio < 0.5 && !sameStoryFingerprint)
	);

	return {
		sameHazardFamily,
		sameStoryRegion,
		sameTopAlertTypes,
		sameStoryFingerprint,
		storyStateOverlapRatio,
		samePublicStory,
		clearlyDifferentStory,
	};
}

export function evaluateDigestChangeThresholds(
	previousSummary: DigestSummary | null | undefined,
	currentSummary: DigestSummary,
): {
	addedStates: string[];
	addedAlertTypes: string[];
	warningDelta: number;
	alertDelta: number;
	hazardChanged: boolean;
	regionalShiftSignificant: boolean;
	sameStoryRegion: boolean;
	sameTopAlertTypes: boolean;
	sameStoryFingerprint: boolean;
	storyStateOverlapRatio: number;
	samePublicStory: boolean;
	clearlyDifferentStory: boolean;
	similarUrgency: boolean;
	urgencyIncreasedMaterially: boolean;
	majorEscalation: boolean;
	warningJumpSignificant: boolean;
	outbreakBegan: boolean;
	sameStorySuppressionCandidate: boolean;
	meaningfulPostChange: boolean;
	meaningfulCommentChange: boolean;
	overrideNewPost: boolean;
} {
	if (!previousSummary) {
		const currentStoryStates = getDigestStoryStates(currentSummary);
		return {
			addedStates: dedupeStrings(currentStoryStates.map((state) => state.toUpperCase())),
			addedAlertTypes: dedupeStrings(currentSummary.topAlertTypes),
			warningDelta: currentSummary.warningCount,
			alertDelta: currentSummary.alertCount,
			hazardChanged: false,
			regionalShiftSignificant: false,
			sameStoryRegion: false,
			sameTopAlertTypes: false,
			sameStoryFingerprint: false,
			storyStateOverlapRatio: 0,
			samePublicStory: false,
			clearlyDifferentStory: false,
			similarUrgency: false,
			urgencyIncreasedMaterially: false,
			majorEscalation: false,
			warningJumpSignificant: false,
			outbreakBegan: false,
			sameStorySuppressionCandidate: false,
			meaningfulPostChange: true,
			meaningfulCommentChange: false,
			overrideNewPost: false,
		};
	}

	const currentStates = getDigestStoryStates(currentSummary);
	const previousStates = getDigestStoryStates(previousSummary);
	const previousStateSet = new Set(previousStates);
	const addedStates = currentStates.filter((state) => !previousStateSet.has(state));

	const currentAlertTypes = normalizeDigestAlertTypes(currentSummary.topAlertTypes);
	const previousAlertTypes = new Set(normalizeDigestAlertTypes(previousSummary.topAlertTypes));
	const addedAlertTypes = currentAlertTypes.filter((alertType) => !previousAlertTypes.has(alertType));

	const previousRegionalFocus = buildDigestRegionalFocus(previousSummary);
	const currentRegionalFocus = buildDigestRegionalFocus(currentSummary);
	const previousRegionalBuckets = new Set(buildDigestRegionalBuckets(previousSummary));
	const sharedState = currentStates.some((state) => previousStateSet.has(state));
	const sharedRegionalBucket = buildDigestRegionalBuckets(currentSummary)
		.some((bucket) => previousRegionalBuckets.has(bucket));
	const sameStory = evaluateDigestSameStory(previousSummary, currentSummary);

	const warningDelta = currentSummary.warningCount - previousSummary.warningCount;
	const alertDelta = currentSummary.alertCount - previousSummary.alertCount;
	const hazardChanged = (previousSummary.hazardFocus ?? null) !== (currentSummary.hazardFocus ?? null);
	const regionalShiftSignificant = previousRegionalFocus !== currentRegionalFocus && !sharedState && !sharedRegionalBucket;
	const urgencyIncreasedMaterially = digestUrgencyRank(currentSummary.urgency) > digestUrgencyRank(previousSummary.urgency);
	const sameStoryRegion = sameStory.sameStoryRegion;
	const similarUrgency = !urgencyIncreasedMaterially;
	const warningJumpSignificant = warningDelta >= 3
		|| (currentSummary.warningCount >= 3 && warningDelta >= 2)
		|| (alertDelta >= 8 && warningDelta > 0);
	const majorEscalation = urgencyIncreasedMaterially || warningJumpSignificant;
	const outbreakBegan = (
		(previousSummary.mode !== 'incident' && currentSummary.mode === 'incident')
		|| (previousSummary.postType !== 'cluster' && currentSummary.postType === 'cluster')
	);
	const sameStorySuppressionCandidate = sameStory.samePublicStory && similarUrgency && !majorEscalation && !outbreakBegan;

	const meaningfulCommentChange = (
		addedStates.length >= 1
		|| addedAlertTypes.length > 0
		|| majorEscalation
		|| outbreakBegan
		|| (warningDelta >= 1 && currentSummary.warningCount >= 3)
		|| alertDelta >= 4
	);

	const meaningfulPostChange = (
		hazardChanged
		|| regionalShiftSignificant
		|| majorEscalation
		|| outbreakBegan
		|| (addedAlertTypes.length > 0 && (warningDelta > 0 || urgencyIncreasedMaterially || !sameStory.sameTopAlertTypes))
		|| (alertDelta >= 6 && warningDelta > 0)
		|| (sameStory.clearlyDifferentStory && (addedStates.length > 0 || addedAlertTypes.length > 0))
	) && !sameStorySuppressionCandidate;

	return {
		addedStates,
		addedAlertTypes,
		warningDelta,
		alertDelta,
		hazardChanged,
		regionalShiftSignificant,
		sameStoryRegion,
		sameTopAlertTypes: sameStory.sameTopAlertTypes,
		sameStoryFingerprint: sameStory.sameStoryFingerprint,
		storyStateOverlapRatio: sameStory.storyStateOverlapRatio,
		samePublicStory: sameStory.samePublicStory,
		clearlyDifferentStory: sameStory.clearlyDifferentStory,
		similarUrgency,
		urgencyIncreasedMaterially,
		majorEscalation,
		warningJumpSignificant,
		outbreakBegan,
		sameStorySuppressionCandidate,
		meaningfulPostChange,
		meaningfulCommentChange,
		overrideNewPost: hazardChanged || regionalShiftSignificant || majorEscalation || outbreakBegan,
	};
}

export function evaluateDigestStoryContinuity(
	previousSummary: DigestSummary | null | undefined,
	currentSummary: DigestSummary,
): {
	allowed: boolean;
	reason: 'missing_previous_summary' | 'missing_hazard_focus' | 'hazard_focus_changed' | 'ambiguous_other_story' | 'regional_focus_changed' | null;
	previousRegionalFocus: string | null;
	currentRegionalFocus: string;
} {
	const currentRegionalFocus = buildDigestRegionalFocus(currentSummary);
	if (!previousSummary) {
		return {
			allowed: false,
			reason: 'missing_previous_summary',
			previousRegionalFocus: null,
			currentRegionalFocus,
		};
	}

	const previousRegionalFocus = buildDigestRegionalFocus(previousSummary);
	const previousHazard = previousSummary.hazardFocus ?? null;
	const currentHazard = currentSummary.hazardFocus ?? null;
	const previousStoryFingerprint = getDigestStoryFingerprint(previousSummary);
	const currentStoryFingerprint = getDigestStoryFingerprint(currentSummary);

	if (!previousHazard || !currentHazard) {
		return {
			allowed: false,
			reason: 'missing_hazard_focus',
			previousRegionalFocus,
			currentRegionalFocus,
		};
	}

	if (previousHazard !== currentHazard) {
		return {
			allowed: false,
			reason: 'hazard_focus_changed',
			previousRegionalFocus,
			currentRegionalFocus,
		};
	}

	if ((previousHazard === 'other' || currentHazard === 'other') && !hasDigestAlertTypeOverlap(previousSummary, currentSummary)) {
		return {
			allowed: false,
			reason: 'ambiguous_other_story',
			previousRegionalFocus,
			currentRegionalFocus,
		};
	}

	const previousStateSet = new Set(getDigestStoryStates(previousSummary));
	const sharedState = getDigestStoryStates(currentSummary)
		.some((state) => previousStateSet.has(state));
	const previousRegionalBuckets = new Set(buildDigestRegionalBuckets(previousSummary));
	const sharedRegionalBucket = buildDigestRegionalBuckets(currentSummary)
		.some((bucket) => previousRegionalBuckets.has(bucket));

	if (previousStoryFingerprint === currentStoryFingerprint || sharedState || sharedRegionalBucket || previousRegionalFocus === currentRegionalFocus) {
		return {
			allowed: true,
			reason: null,
			previousRegionalFocus,
			currentRegionalFocus,
		};
	}

	return {
		allowed: false,
		reason: 'regional_focus_changed',
		previousRegionalFocus,
		currentRegionalFocus,
	};
}

function hasDigestMaterialUrgencyIncrease(
	previousSummary: DigestSummary,
	currentSummary: DigestSummary,
): boolean {
	return digestUrgencyRank(currentSummary.urgency) > digestUrgencyRank(previousSummary.urgency);
}

function hasDigestSignificantWarningJump(
	changeEvaluation: ReturnType<typeof evaluateDigestChangeThresholds>,
	currentSummary: DigestSummary,
): boolean {
	if (changeEvaluation.warningJumpSignificant) return true;
	if (changeEvaluation.warningDelta >= 2 && currentSummary.warningCount >= 3) return true;
	return changeEvaluation.alertDelta >= 8 && changeEvaluation.warningDelta > 0;
}

export function evaluateSecondDigestPostAllowance(
	previousSummary: DigestSummary,
	currentSummary: DigestSummary,
	changeEvaluation: ReturnType<typeof evaluateDigestChangeThresholds>,
	): DigestSecondPostAllowance {
	const sameStory = evaluateDigestSameStory(previousSummary, currentSummary);
	if (changeEvaluation.sameStorySuppressionCandidate) {
		return { allowed: false, reason: 'digest_second_post_blocked_not_material' };
	}
	if (changeEvaluation.hazardChanged) {
		return { allowed: true, reason: 'digest_second_post_allowed_hazard_change' };
	}
	if (changeEvaluation.regionalShiftSignificant) {
		return { allowed: true, reason: 'digest_second_post_allowed_region_change' };
	}
	if (hasDigestSignificantWarningJump(changeEvaluation, currentSummary)) {
		return { allowed: true, reason: 'digest_second_post_allowed_warning_jump' };
	}
	if (hasDigestMaterialUrgencyIncrease(previousSummary, currentSummary)) {
		return { allowed: true, reason: 'digest_second_post_allowed_urgency_increase' };
	}
	const continuity = evaluateDigestStoryContinuity(previousSummary, currentSummary);
	if (changeEvaluation.outbreakBegan || !continuity.allowed || sameStory.clearlyDifferentStory) {
		return { allowed: true, reason: 'digest_second_post_allowed_new_major_story' };
	}
	return { allowed: false, reason: 'digest_second_post_blocked_not_material' };
}

// ---------------------------------------------------------------------------
// Cooldown checks
// ---------------------------------------------------------------------------

export async function canPostNewDigest(
	env: Env,
	nowMs: number,
	hazardFocus: DigestHazardFamily | null,
	existingBlock: PublishedDigestBlockRecord | null = null,
): Promise<{
	allowed: boolean;
	blockId: string;
	existingThread: DigestThreadRecord | null;
	lastBlock: PublishedDigestBlockRecord | null;
	reason: 'same_block' | 'global_cooldown' | 'same_hazard_cooldown' | 'hourly_post_cap' | null;
}> {
	const block = existingBlock ?? await readDigestBlockRecord(env);
	const blockId = buildDigestBlockId(nowMs);

	if (!block) {
		return { allowed: true, blockId, existingThread: null, lastBlock: null, reason: null };
	}

	const gapEvaluation = evaluateDigestNewPostGap(block, nowMs);
	const withinGlobalCooldown = gapEvaluation.withinGap;
	const recentPostCount = countRecentDigestPosts(block, nowMs);
	const activeThread = (withinGlobalCooldown || recentPostCount >= FB_DIGEST_MAX_POSTS_PER_HOUR)
		? await readDigestThread(env, block.blockId)
		: null;

	if (recentPostCount >= FB_DIGEST_MAX_POSTS_PER_HOUR) {
		return { allowed: false, blockId: block.blockId, existingThread: activeThread, lastBlock: block, reason: 'hourly_post_cap' };
	}

	if (withinGlobalCooldown) {
		return {
			allowed: false,
			blockId: block.blockId,
			existingThread: activeThread,
			lastBlock: block,
			reason: block.blockId === blockId ? 'same_block' : 'global_cooldown',
		};
	}

	if (isHazardFocusCoolingDown(block, hazardFocus, nowMs)) {
		return { allowed: false, blockId, existingThread: null, lastBlock: block, reason: 'same_hazard_cooldown' };
	}

	return { allowed: true, blockId, existingThread: null, lastBlock: block, reason: null };
}

function getDigestCommentSettings(config: Awaited<ReturnType<typeof readFbAutoPostConfig>>): {
	enabled: boolean;
	maxCommentsPerThread: number;
	minCommentGapMs: number;
} {
	const maxCommentsPerThread = Number.isFinite(Number(config.digestMaxCommentsPerThread))
		? Math.min(5, Math.max(1, Math.round(Number(config.digestMaxCommentsPerThread))))
		: FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD;
	const minCommentGapMinutes = Number.isFinite(Number(config.digestMinCommentGapMinutes))
		? Math.min(60, Math.max(10, Math.round(Number(config.digestMinCommentGapMinutes))))
		: FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES;
	return {
		enabled: config.digestCommentUpdatesEnabled !== false,
		maxCommentsPerThread,
		minCommentGapMs: Math.max(FB_DIGEST_COMMENT_COOLDOWN_MS, minCommentGapMinutes * 60 * 1000),
	};
}

function canPostDigestComment(
	thread: DigestThreadRecord,
	nowMs: number,
	settings: { enabled: boolean; maxCommentsPerThread: number; minCommentGapMs: number },
): boolean {
	if (!settings.enabled) return false;
	if ((thread.commentCount ?? 0) >= settings.maxCommentsPerThread) return false;
	if (!thread.lastCommentAt) return true;
	const lastCommentMs = Date.parse(thread.lastCommentAt);
	if (!Number.isFinite(lastCommentMs)) return true;
	return (nowMs - lastCommentMs) >= settings.minCommentGapMs;
}

// ---------------------------------------------------------------------------
// Facebook posting helpers for digest
// ---------------------------------------------------------------------------

function getDigestImagePath(hazardFocus: DigestHazardFamily | null | undefined): string {
	if (hazardFocus === 'flood') {
		return '/images/flooding-alerts.png';
	}
	if (hazardFocus === 'winter') {
		return '/images/winter-storm-alerts.png';
	}
	return '/images/weather-alerts.png';
}

type DigestCoveragePlan = {
	intent: FacebookCoverageIntent | null;
	blockedReason: string | null;
	startupNeeded: boolean;
	summary: DigestSummary | null;
	previousSummary: DigestSummary | null;
	blockId: string;
	lastBlock: PublishedDigestBlockRecord | null;
	existingThread: DigestThreadRecord | null;
	selectedStates: string[];
	nextCursor: number;
	changeEvaluation: ReturnType<typeof evaluateDigestChangeThresholds> | null;
	recentPostCount: number;
	commentSettings: { enabled: boolean; maxCommentsPerThread: number; minCommentGapMs: number } | null;
	copyMode: DigestCopyMode | null;
};

function buildDigestIntent(
	action: FacebookCoverageIntent['action'],
	priority: number,
	reason: string,
	summary: DigestSummary,
	storyKey?: string | null,
	targetPostId?: string | null,
): FacebookCoverageIntent {
	const label = summary.hazardFocus ? `${summary.hazardFocus} digest` : 'digest';
	const regionalFocus = summary.storyRegion ?? buildDigestRegionalFocus(summary);
	return {
		lane: 'digest',
		action,
		priority,
		reason,
		summary: `${label} for ${regionalFocus}`,
		storyKey: storyKey ?? summary.storyFingerprint ?? summary.hash,
		targetPostId: targetPostId ?? null,
	};
}

async function buildDigestCoveragePlan(
	env: Env,
	alertMap: Record<string, any>,
	nowMs = Date.now(),
): Promise<DigestCoveragePlan> {
	const emptyPlan = (): DigestCoveragePlan => ({
		intent: null,
		blockedReason: null,
		startupNeeded: false,
		summary: null,
		previousSummary: null,
		blockId: buildDigestBlockId(nowMs),
		lastBlock: null,
		existingThread: null,
		selectedStates: [],
		nextCursor: 0,
		changeEvaluation: null,
		recentPostCount: 0,
		commentSettings: null,
		copyMode: null,
	});

	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		return { ...emptyPlan(), blockedReason: 'facebook_credentials_missing' };
	}

	const activeAlertIds = new Set(Object.keys(alertMap));
	await pruneExpiredCoveredAlerts(env, activeAlertIds);

	const coveredAlertIds = await readStandaloneCoveredAlerts(env);
	const allCandidates = buildDigestCandidates(alertMap, coveredAlertIds);
	const { candidates, marineShare } = applyMarineSuppression(allCandidates);
	if (candidates.length === 0) {
		return { ...emptyPlan(), blockedReason: 'no_candidates' };
	}

	const recentFacebookActivity = await readRecentFacebookActivity(env, nowMs);
	if (recentFacebookActivity.withinGap) {
		return { ...emptyPlan(), blockedReason: 'recent_global_post_gap' };
	}

	const distinctStates = dedupeStrings(candidates.flatMap((candidate) => candidate.stateCodes));
	const mode = detectOperatingMode(activeAlertIds.size, distinctStates.length, marineShare);
	const startupNeeded = await isStartupMode(env, nowMs);
	const clusters = buildHazardClusters(candidates);
	if (clusters.length === 0) {
		return { ...emptyPlan(), blockedReason: 'no_clusters' };
	}
	if (startupNeeded) {
		const leadCluster = clusters[0] ?? null;
		const stateScores = scoreStates(
			leadCluster?.family
				? candidates.filter((candidate) => candidate.hazardFamily === leadCluster.family)
				: candidates,
		);
		const cursor = await readRotationCursor(env);
		const { selectedStates, nextCursor } = selectStatesForDigest(stateScores, cursor, leadCluster?.storyStates ?? []);
		const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, null, leadCluster);
		return {
			...emptyPlan(),
			intent: buildDigestIntent('post', 470, 'digest_startup_snapshot', summary),
			startupNeeded: true,
			summary,
			selectedStates,
			nextCursor,
		};
	}

	const previousBlock = await readDigestBlockRecord(env);
	const previousThread = previousBlock ? await readDigestThread(env, previousBlock.blockId) : null;
	const previousSummary = previousThread?.summary ?? null;
	const clusterBreakout = checkClusterBreakout(clusters);
	const primaryCluster = selectDigestPrimaryCluster(clusters, clusterBreakout, previousBlock, nowMs);
	const statePool = primaryCluster?.family != null
		? candidates.filter((candidate) => candidate.hazardFamily === primaryCluster.family)
		: candidates;
	const stateScores = scoreStates(statePool);
	const cursor = await readRotationCursor(env);
	const { selectedStates, nextCursor } = selectStatesForDigest(
		stateScores,
		cursor,
		primaryCluster?.storyStates ?? [],
	);
	if (selectedStates.length === 0) {
		return { ...emptyPlan(), blockedReason: 'no_states_selected' };
	}

	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, clusterBreakout, primaryCluster);
	const changeEvaluation = evaluateDigestChangeThresholds(previousSummary, summary);
	const { allowed, blockId, existingThread, lastBlock, reason } = await canPostNewDigest(
		env,
		nowMs,
		summary.hazardFocus,
		previousBlock,
	);
	const recentPostCount = countRecentDigestPosts(lastBlock, nowMs);
	const withinHourlyDigestWindow = recentPostCount > 0
		|| reason === 'same_block'
		|| reason === 'global_cooldown'
		|| reason === 'same_hazard_cooldown';
	const withinHourlyFollowupWindow = withinHourlyDigestWindow && Boolean(previousSummary);
	const secondPostAllowance = previousSummary
		? evaluateSecondDigestPostAllowance(previousSummary, summary, changeEvaluation)
		: { allowed: false, reason: 'digest_second_post_blocked_not_material' } satisfies DigestSecondPostAllowance;
	const autoPostConfig = await readFbAutoPostConfig(env);
	const commentSettings = getDigestCommentSettings(autoPostConfig);
	const lastHash = await readLastDigestHash(env);

	if (allowed) {
		if (!previousSummary && summary.hash === lastHash) {
			return {
				...emptyPlan(),
				summary,
				previousSummary,
				blockId,
				lastBlock,
				existingThread,
				selectedStates,
				nextCursor,
				changeEvaluation,
				recentPostCount,
				commentSettings,
				blockedReason: 'hash_unchanged',
			};
		}
		if (previousSummary && !changeEvaluation.meaningfulPostChange) {
			return {
				...emptyPlan(),
				summary,
				previousSummary,
				blockId,
				lastBlock,
				existingThread,
				selectedStates,
				nextCursor,
				changeEvaluation,
				recentPostCount,
				commentSettings,
				blockedReason: 'digest_same_story_skip',
			};
		}
		return {
			...emptyPlan(),
			intent: buildDigestIntent('post', 480, 'digest_new_post_allowed_after_60m', summary),
			summary,
			previousSummary,
			blockId,
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			copyMode: 'post',
		};
	}

	if (
		changeEvaluation.overrideNewPost
		&& secondPostAllowance.allowed
		&& recentPostCount < FB_DIGEST_MAX_POSTS_PER_HOUR
	) {
		return {
			...emptyPlan(),
			intent: buildDigestIntent('post', 520, secondPostAllowance.reason, summary),
			summary,
			previousSummary,
			blockId: buildDigestBlockId(nowMs),
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			copyMode: 'post',
		};
	}

	if (!existingThread) {
		return {
			...emptyPlan(),
			summary,
			previousSummary,
			blockId,
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			blockedReason: withinHourlyFollowupWindow && !secondPostAllowance.allowed
				? secondPostAllowance.reason
				: (reason ? `cooldown:${reason}` : 'cooldown'),
		};
	}

	if (!changeEvaluation.meaningfulCommentChange) {
		return {
			...emptyPlan(),
			summary,
			previousSummary,
			blockId,
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			blockedReason: 'digest_same_story_skip',
		};
	}

	const continuity = evaluateDigestStoryContinuity(existingThread.summary, summary);
	if (!continuity.allowed) {
		return {
			...emptyPlan(),
			summary,
			previousSummary,
			blockId,
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			blockedReason: withinHourlyFollowupWindow && !secondPostAllowance.allowed
				? secondPostAllowance.reason
				: `story_continuity_blocked:${continuity.reason || 'unknown'}`,
		};
	}

	if (!canPostDigestComment(existingThread, nowMs, commentSettings)) {
		return {
			...emptyPlan(),
			summary,
			previousSummary,
			blockId,
			lastBlock,
			existingThread,
			selectedStates,
			nextCursor,
			changeEvaluation,
			recentPostCount,
			commentSettings,
			blockedReason: 'digest_comment_cooldown',
		};
	}

	return {
		...emptyPlan(),
		intent: buildDigestIntent('comment', 420, 'digest_same_story_comment_only', summary, summary.storyFingerprint ?? summary.hash, existingThread.postId),
		summary,
		previousSummary,
		blockId,
		lastBlock,
		existingThread,
		selectedStates,
		nextCursor,
		changeEvaluation,
		recentPostCount,
		commentSettings,
		copyMode: 'comment',
	};
}

export async function evaluateDigestCoverageIntent(
	env: Env,
	alertMap: Record<string, any>,
	nowMs = Date.now(),
): Promise<FacebookCoverageEvaluation> {
	const plan = await buildDigestCoveragePlan(env, alertMap, nowMs);
	return {
		lane: 'digest',
		intent: plan.intent,
		blockedReason: plan.blockedReason,
	};
}

export function getDigestImageUrl(env: Env, hazardFocus: DigestHazardFamily | null | undefined = null): string {
	const base = String(env.FB_IMAGE_BASE_URL || '').trim().replace(/\/$/, '') || PRIMARY_APP_ORIGIN;
	return `${base}${getDigestImagePath(hazardFocus)}`;
}

async function postToFacebook(env: Env, message: string, imageUrl?: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured');
	}
	if (imageUrl) {
		const photoUrl = `https://graph.facebook.com/v17.0/${encodeURIComponent(env.FB_PAGE_ID)}/photos`;
		const photoBody = new URLSearchParams({ url: imageUrl, caption: message, access_token: env.FB_PAGE_ACCESS_TOKEN });
		const photoRes = await fetch(photoUrl, { method: 'POST', body: photoBody, signal: AbortSignal.timeout(15_000) });
		if (photoRes.ok) {
			const photoData = await photoRes.json() as { id?: string };
			if (photoData.id) return photoData.id;
		}
		console.warn('[fb-digest] photo post failed, falling back to text feed');
	}
	const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(env.FB_PAGE_ID)}/feed`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Facebook API error ${res.status}: ${text}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook post returned no ID');
	return data.id;
}

async function commentOnFacebook(env: Env, postId: string, message: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured');
	}
	const url = `https://graph.facebook.com/v17.0/${encodeURIComponent(postId)}/comments`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Facebook comment API error ${res.status}: ${text}`);
	}
	const data = await res.json() as { id?: string };
	return data.id ?? '';
}

// ---------------------------------------------------------------------------
// Startup snapshot builder
// ---------------------------------------------------------------------------

function startupClusterLabel(family: DigestHazardFamily): string {
	if (family === 'flood') return 'Flooding';
	if (family === 'winter') return 'Winter weather';
	if (family === 'wind') return 'Wind impacts';
	if (family === 'fire') return 'Fire weather';
	return 'Active weather';
}

function formatStartupStateList(states: string[]): string {
	const names = dedupeStrings(states.map(stateCodeToName));
	if (names.length === 0) return 'multiple states';
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
	return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more state${names.length - 3 !== 1 ? 's' : ''}`;
}

function startupClusterStoryStates(cluster: HazardClusterSummary): string[] {
	return cluster.storyStates && cluster.storyStates.length > 0 ? cluster.storyStates : cluster.states;
}

function buildStartupLeadSentence(cluster: HazardClusterSummary): string {
	const regionText = cluster.storyRegion ? ` across the ${cluster.storyRegion.toLowerCase()}` : '';
	return `${startupClusterLabel(cluster.family)} is the main weather story right now${regionText}, with the core impacts centered in ${formatStartupStateList(startupClusterStoryStates(cluster))}.`;
}

function buildStartupSecondarySentence(cluster: HazardClusterSummary): string {
	const regionText = cluster.storyRegion ? ` across the ${cluster.storyRegion.toLowerCase()}` : '';
	return `${startupClusterLabel(cluster.family)} is also active${regionText}, with impacts centered in ${formatStartupStateList(startupClusterStoryStates(cluster))}.`;
}

export function buildStartupSnapshotText(clusters: HazardClusterSummary[], totalCount: number): string {
	const now = new Date();
	const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

	if (clusters.length === 0) {
		return [
			'Quiet weather is the main story nationwide right now.',
			`No significant weather alerts are active as of ${dateStr}.`,
			'Full alerts: https://liveweatheralerts.com/live',
		].join('\n\n');
	}

	const openingParagraph = [
		buildStartupLeadSentence(clusters[0]),
		...clusters.slice(1, 3).map(buildStartupSecondarySentence),
	].join(' ');
	const totalLine = `${totalCount} active weather alert${totalCount !== 1 ? 's' : ''} ${totalCount === 1 ? 'is' : 'are'} posted nationwide as of ${dateStr}.`;

	return [
		openingParagraph,
		`${totalLine}\nFull alerts: https://liveweatheralerts.com/live`,
	].join('\n\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDigestCoverage(
	env: Env,
	alertMap: Record<string, any>,
	generateCopy: (env: Env, summary: DigestSummary, outputMode?: DigestCopyMode) => Promise<string>,
): Promise<void> {
	const nowMs = Date.now();
	const plan = await buildDigestCoveragePlan(env, alertMap, nowMs);
	if (!plan.intent || !plan.summary) {
		console.log(`[fb-digest] skipping ${plan.blockedReason || 'no_actionable_digest'}`);
		return;
	}

	if (plan.startupNeeded) {
		const coveredAlertIds = await readStandaloneCoveredAlerts(env);
		const allCandidates = buildDigestCandidates(alertMap, coveredAlertIds);
		const { candidates, marineShare } = applyMarineSuppression(allCandidates);
		const distinctStates = dedupeStrings(candidates.flatMap((candidate) => candidate.stateCodes));
		const mode = detectOperatingMode(new Set(Object.keys(alertMap)).size, distinctStates.length, marineShare);
		await runStartupCoverage(env, candidates, mode, nowMs);
		await writeStartupState(env, { initializedAt: new Date(nowMs).toISOString() });
		return;
	}

	const summary = plan.summary;
	const postChangeHint = plan.previousSummary ? buildCommentChangeHint(plan.previousSummary, summary) : null;

	const publishDigestPost = async (postSummary: DigestSummary, nextBlockId: string): Promise<void> => {
		const copy = await generateCopy(env, postSummary, 'post');
		const postId = await postToFacebook(env, copy, getDigestImageUrl(env, postSummary.hazardFocus));
		await recordRecentDigestOpening(env, copy);
		console.log(
			`[fb-digest] posted digest post=${postId} reason=${plan.intent?.reason || 'digest_new_post'} `
			+ `mode=${postSummary.mode} states=${plan.selectedStates.join(',')}`,
		);
		const publishedAt = new Date(nowMs).toISOString();

		const block: PublishedDigestBlockRecord = {
			blockId: nextBlockId,
			publishedAt,
			hash: postSummary.hash,
			postId,
			hazardFocus: postSummary.hazardFocus ?? null,
			lastPublishedAtByFocus: buildNextPublishedAtByFocus(plan.lastBlock, postSummary.hazardFocus, publishedAt),
			recentPostTimestamps: buildNextRecentDigestPostTimestamps(plan.lastBlock, publishedAt),
		};
		await writeDigestBlockRecord(env, block);
		await writeLastDigestHash(env, postSummary.hash);
		await writeRotationCursor(env, plan.nextCursor);
		await recordLastFacebookActivity(env, nowMs);

		const thread: DigestThreadRecord = {
			postId,
			blockId: nextBlockId,
			publishedAt,
			hash: postSummary.hash,
			commentCount: 0,
			lastCommentAt: null,
			summary: postSummary,
		};
		await writeDigestThread(env, nextBlockId, thread);
	};

	if (plan.intent.action === 'post') {
		await publishDigestPost(
			postChangeHint ? { ...summary, changeHint: postChangeHint } : summary,
			plan.blockId,
		);
		if (plan.intent.reason.startsWith('digest_second_post_allowed_')) {
			console.log(`[fb-digest] posted second digest reason=${plan.intent.reason} posts_last_hour=${plan.recentPostCount + 1}`);
		}
	} else if (plan.intent.action === 'comment' && plan.existingThread) {
		const commentSummary: DigestSummary = {
			...summary,
			changeHint: buildCommentChangeHint(plan.existingThread.summary, summary),
		};
		const copy = await generateCopy(env, commentSummary, 'comment');
		const commentId = await commentOnFacebook(env, plan.existingThread.postId, copy);
		await recordRecentDigestOpening(env, copy);
		console.log(
			`[fb-digest] posted digest comment=${commentId} post=${plan.existingThread.postId} `
			+ `reason=${plan.intent.reason}`,
		);

		const updatedThread: DigestThreadRecord = {
			...plan.existingThread,
			hash: commentSummary.hash,
			commentCount: plan.existingThread.commentCount + 1,
			lastCommentAt: new Date(nowMs).toISOString(),
			summary: commentSummary,
		};
		await writeDigestThread(env, plan.blockId, updatedThread);
		await recordLastFacebookActivity(env, nowMs);
	} else {
		console.log(`[fb-digest] skipping new digest reason=${plan.blockedReason || 'cooldown'}`);
	}
}

async function runStartupCoverage(
	env: Env,
	candidates: DigestCandidate[],
	mode: 'normal' | 'incident',
	nowMs: number,
): Promise<void> {
	const clusters = buildHazardClusters(candidates);
	if (clusters.length === 0) {
		console.log('[fb-digest] startup: no clusters, skipping snapshot post');
		return;
	}

	const snapshotText = buildStartupSnapshotText(clusters, candidates.length);
	const postId = await postToFacebook(env, snapshotText, getDigestImageUrl(env, clusters[0]?.family ?? null));
	await recordRecentDigestOpening(env, snapshotText);
	console.log(`[fb-digest] startup snapshot post=${postId}`);

	await recordLastFacebookActivity(env, nowMs);

	// Seed digest block record so normal mode picks up cleanly
	const blockId = buildDigestBlockId(nowMs);
	const leadCluster = clusters[0] ?? null;
	const stateScores = scoreStates(
		leadCluster?.family
			? candidates.filter((candidate) => candidate.hazardFamily === leadCluster.family)
			: candidates,
	);
	const cursor = await readRotationCursor(env);
	const { selectedStates } = selectStatesForDigest(stateScores, cursor, leadCluster?.storyStates ?? []);
	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, null, leadCluster);
	const publishedAt = new Date(nowMs).toISOString();
	const previousBlock = await readDigestBlockRecord(env);

	const block: PublishedDigestBlockRecord = {
		blockId,
		publishedAt,
		hash: summary.hash,
		postId,
		hazardFocus: summary.hazardFocus ?? null,
		lastPublishedAtByFocus: buildNextPublishedAtByFocus(previousBlock, summary.hazardFocus, publishedAt),
		recentPostTimestamps: buildNextRecentDigestPostTimestamps(previousBlock, publishedAt),
	};
	await writeDigestBlockRecord(env, block);
	await writeLastDigestHash(env, summary.hash);

	const thread: DigestThreadRecord = {
		postId,
		blockId,
		publishedAt,
		hash: summary.hash,
		commentCount: 0,
		lastCommentAt: null,
		summary,
	};
	await writeDigestThread(env, blockId, thread);
	console.log(`[fb-digest] startup: seeded digest state block=${blockId}`);
}
