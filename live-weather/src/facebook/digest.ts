import type {
	Env,
	DigestCopyMode,
	DigestHazardFamily,
	DigestHazardCooldownKey,
	DigestAlertTier,
	DigestCandidate,
	HazardClusterSummary,
	DigestSummary,
	DigestThreadRecord,
	PublishedDigestBlockRecord,
	StandaloneCoveredAlertRecord,
	StartupStateRecord,
} from '../types';
import {
	KV_FB_LAST_POST_TIMESTAMP,
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
	FB_DIGEST_TOP_STATE_COUNT,
	FB_DIGEST_ROTATION_STATE_COUNT,
	FB_DIGEST_MAX_NORMAL_MULTISTATE,
	PRIMARY_APP_ORIGIN,
} from '../constants';
import { deriveAlertImpactCategories, dedupeStrings } from '../utils';
import { readFbAutoPostConfig } from './config';
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

async function readLastPostTimestamp(env: Env): Promise<number | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_LAST_POST_TIMESTAMP);
		if (!raw) return null;
		const ms = Date.parse(raw);
		return Number.isFinite(ms) ? ms : null;
	} catch {
		return null;
	}
}

export async function recordLastPostTimestamp(env: Env, nowMs = Date.now()): Promise<void> {
	try {
		await env.WEATHER_KV.put(
			KV_FB_LAST_POST_TIMESTAMP,
			new Date(nowMs).toISOString(),
			{ expirationTtl: 8 * 60 * 60 },
		);
	} catch {
		// Non-critical
	}
}

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
	const lastPost = await readLastPostTimestamp(env);
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
	candidates: DigestCandidate[],
	stateScores: Map<string, number>,
	rotationCursor: number,
): { selectedStates: string[]; nextCursor: number } {
	const distinctStates = Array.from(stateScores.keys()).sort((a, b) => {
		const scoreDiff = (stateScores.get(b) || 0) - (stateScores.get(a) || 0);
		if (scoreDiff !== 0) return scoreDiff;
		return a.localeCompare(b);
	});

	if (distinctStates.length === 0) return { selectedStates: [], nextCursor: rotationCursor };
	if (distinctStates.length <= FB_DIGEST_MAX_NORMAL_MULTISTATE) {
		return { selectedStates: distinctStates, nextCursor: rotationCursor };
	}

	// 7+ states: top 3 + 3 rotated from the remaining pool
	const topStates = distinctStates.slice(0, FB_DIGEST_TOP_STATE_COUNT);
	const remainingPool = distinctStates.slice(FB_DIGEST_TOP_STATE_COUNT);
	const rotated: string[] = [];
	for (let i = 0; i < FB_DIGEST_ROTATION_STATE_COUNT && remainingPool.length > 0; i++) {
		const idx = (rotationCursor + i) % remainingPool.length;
		rotated.push(remainingPool[idx]);
	}
	const nextCursor = remainingPool.length > 0
		? (rotationCursor + FB_DIGEST_ROTATION_STATE_COUNT) % remainingPool.length
		: 0;
	return { selectedStates: [...topStates, ...rotated], nextCursor };
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

function buildDigestHash(states: string[], topAlertTypes: string[], hazardFocus: string | null): string {
	return `${hazardFocus || 'multi'}|${[...states].sort().join(',')}|${[...topAlertTypes].sort().join(',')}`;
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
	const topAlertTypes = dedupeStrings([
		...(focusCluster?.topAlertTypes ?? []),
		...clusters.flatMap((c) => c.topAlertTypes),
	]).slice(0, 3);
	const urgency = deriveDigestUrgency(candidates);
	const warningCount = candidates.filter((candidate) => candidate.alertTier === 'warning').length;
	const hash = buildDigestHash(selectedStates, topAlertTypes, hazardFocus);

	return {
		mode,
		postType: clusterBreakout && focusCluster?.family === clusterBreakout.family ? 'cluster' : 'digest',
		hazardFocus: hazardFocus ?? null,
		states: selectedStates,
		topAlertTypes,
		urgency,
		alertCount: candidates.length,
		warningCount,
		hash,
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
	majorEscalation: boolean;
	outbreakBegan: boolean;
	meaningfulPostChange: boolean;
	meaningfulCommentChange: boolean;
	overrideNewPost: boolean;
} {
	if (!previousSummary) {
		return {
			addedStates: dedupeStrings(currentSummary.states.map((state) => state.toUpperCase())),
			addedAlertTypes: dedupeStrings(currentSummary.topAlertTypes),
			warningDelta: currentSummary.warningCount,
			alertDelta: currentSummary.alertCount,
			hazardChanged: false,
			regionalShiftSignificant: false,
			majorEscalation: false,
			outbreakBegan: false,
			meaningfulPostChange: true,
			meaningfulCommentChange: false,
			overrideNewPost: false,
		};
	}

	const currentStates = dedupeStrings(currentSummary.states.map((state) => state.toUpperCase()));
	const previousStates = dedupeStrings(previousSummary.states.map((state) => state.toUpperCase()));
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

	const warningDelta = currentSummary.warningCount - previousSummary.warningCount;
	const alertDelta = currentSummary.alertCount - previousSummary.alertCount;
	const hazardChanged = (previousSummary.hazardFocus ?? null) !== (currentSummary.hazardFocus ?? null);
	const regionalShiftSignificant = previousRegionalFocus !== currentRegionalFocus && !sharedState && !sharedRegionalBucket;
	const urgencyIncreased = digestUrgencyRank(currentSummary.urgency) > digestUrgencyRank(previousSummary.urgency);
	const majorWarningSpike = warningDelta >= 3 || (currentSummary.warningCount >= 3 && warningDelta >= 2);
	const majorEscalation = urgencyIncreased || majorWarningSpike;
	const outbreakBegan = (
		(previousSummary.mode !== 'incident' && currentSummary.mode === 'incident')
		|| (previousSummary.postType !== 'cluster' && currentSummary.postType === 'cluster')
	);

	const meaningfulCommentChange = (
		addedStates.length >= 1
		|| addedAlertTypes.length > 0
		|| majorEscalation
		|| outbreakBegan
		|| warningDelta > 0
		|| alertDelta >= 4
	);

	const meaningfulPostChange = (
		addedStates.length >= 2
		|| hazardChanged
		|| regionalShiftSignificant
		|| majorEscalation
		|| outbreakBegan
		|| (addedAlertTypes.length > 0 && (warningDelta > 0 || urgencyIncreased))
		|| (alertDelta >= 6 && warningDelta > 0)
	);

	return {
		addedStates,
		addedAlertTypes,
		warningDelta,
		alertDelta,
		hazardChanged,
		regionalShiftSignificant,
		majorEscalation,
		outbreakBegan,
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

	const previousStateSet = new Set(dedupeStrings(previousSummary.states.map((state) => state.toUpperCase())));
	const sharedState = dedupeStrings(currentSummary.states.map((state) => state.toUpperCase()))
		.some((state) => previousStateSet.has(state));
	const previousRegionalBuckets = new Set(buildDigestRegionalBuckets(previousSummary));
	const sharedRegionalBucket = buildDigestRegionalBuckets(currentSummary)
		.some((bucket) => previousRegionalBuckets.has(bucket));

	if (sharedState || sharedRegionalBucket || previousRegionalFocus === currentRegionalFocus) {
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

	const lastPublishedMs = Date.parse(block.publishedAt);
	const withinGlobalCooldown = Number.isFinite(lastPublishedMs) && (nowMs - lastPublishedMs) < FB_DIGEST_COOLDOWN_MS;
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

function buildStartupLeadSentence(cluster: HazardClusterSummary): string {
	return `${startupClusterLabel(cluster.family)} is the main weather story right now across ${formatStartupStateList(cluster.states)}.`;
}

function buildStartupSecondarySentence(cluster: HazardClusterSummary): string {
	return `${startupClusterLabel(cluster.family)} is also active in ${formatStartupStateList(cluster.states)}.`;
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
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) return;

	const nowMs = Date.now();
	const activeAlertIds = new Set(Object.keys(alertMap));

	// Prune covered alerts that have expired
	await pruneExpiredCoveredAlerts(env, activeAlertIds);

	const coveredAlertIds = await readStandaloneCoveredAlerts(env);
	const allCandidates = buildDigestCandidates(alertMap, coveredAlertIds);
	const { candidates, marineShare, suppressed } = applyMarineSuppression(allCandidates);

	if (candidates.length === 0) {
		console.log('[fb-digest] no digest candidates after filtering');
		return;
	}

	const distinctStates = dedupeStrings(candidates.flatMap((c) => c.stateCodes));
	const mode = detectOperatingMode(activeAlertIds.size, distinctStates.length, marineShare);
	const autoPostConfig = await readFbAutoPostConfig(env);
	const digestCommentSettings = getDigestCommentSettings(autoPostConfig);

	// Check for startup mode
	const startupNeeded = await isStartupMode(env, nowMs);
	if (startupNeeded) {
		await runStartupCoverage(env, candidates, mode, nowMs);
		await writeStartupState(env, { initializedAt: new Date(nowMs).toISOString() });
		return;
	}

	const clusters = buildHazardClusters(candidates);
	const previousBlock = await readDigestBlockRecord(env);
	const previousThread = previousBlock ? await readDigestThread(env, previousBlock.blockId) : null;
	const previousSummary = previousThread?.summary ?? null;
	const clusterBreakout = checkClusterBreakout(clusters);
	const primaryCluster = selectDigestPrimaryCluster(clusters, clusterBreakout, previousBlock, nowMs);
	const defaultFocusFamily = clusterBreakout?.family ?? (clusters[0]?.family ?? null);
	const useFocusedStatePool = primaryCluster?.family != null && primaryCluster.family !== defaultFocusFamily;
	const statePool = useFocusedStatePool
		? candidates.filter((candidate) => candidate.hazardFamily === primaryCluster?.family)
		: candidates;
	const stateScores = scoreStates(statePool);
	const cursor = await readRotationCursor(env);
	const { selectedStates, nextCursor } = selectStatesForDigest(statePool, stateScores, cursor);

	if (selectedStates.length === 0) {
		console.log('[fb-digest] no states selected for digest');
		return;
	}

	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, clusterBreakout, primaryCluster);
	const lastHash = await readLastDigestHash(env);
	const changeEvaluation = evaluateDigestChangeThresholds(previousSummary, summary);
	const postChangeHint = previousSummary ? buildCommentChangeHint(previousSummary, summary) : null;

	const { allowed, blockId, existingThread, lastBlock, reason } = await canPostNewDigest(
		env,
		nowMs,
		summary.hazardFocus,
		previousBlock,
	);
	const recentPostCount = countRecentDigestPosts(lastBlock, nowMs);

	const publishDigestPost = async (postSummary: DigestSummary, nextBlockId: string): Promise<void> => {
		const copy = await generateCopy(env, postSummary, 'post');
		const postId = await postToFacebook(env, copy, getDigestImageUrl(env, postSummary.hazardFocus));
		await recordRecentDigestOpening(env, copy);
		console.log(`[fb-digest] posted digest post=${postId} mode=${mode} states=${selectedStates.join(',')}`);
		const publishedAt = new Date(nowMs).toISOString();

		const block: PublishedDigestBlockRecord = {
			blockId: nextBlockId,
			publishedAt,
			hash: postSummary.hash,
			postId,
			hazardFocus: postSummary.hazardFocus ?? null,
			lastPublishedAtByFocus: buildNextPublishedAtByFocus(lastBlock, postSummary.hazardFocus, publishedAt),
			recentPostTimestamps: buildNextRecentDigestPostTimestamps(lastBlock, publishedAt),
		};
		await writeDigestBlockRecord(env, block);
		await writeLastDigestHash(env, postSummary.hash);
		await writeRotationCursor(env, nextCursor);
		await recordLastPostTimestamp(env, nowMs);

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

	if (allowed) {
		if (!previousSummary && summary.hash === lastHash) {
			console.log('[fb-digest] hash unchanged, skipping digest');
			return;
		}
		if (previousSummary && !changeEvaluation.meaningfulPostChange) {
			console.log('[fb-digest] no meaningful hourly digest change, skipping post');
			return;
		}
		await publishDigestPost(
			postChangeHint ? { ...summary, changeHint: postChangeHint } : summary,
			blockId,
		);
	} else if (changeEvaluation.overrideNewPost && recentPostCount < FB_DIGEST_MAX_POSTS_PER_HOUR) {
		await publishDigestPost(
			postChangeHint ? { ...summary, changeHint: postChangeHint } : summary,
			buildDigestBlockId(nowMs),
		);
		console.log(`[fb-digest] posted override digest reason=${reason || 'override'} posts_last_hour=${recentPostCount + 1}`);
	} else if (existingThread) {
		if (!changeEvaluation.meaningfulCommentChange) {
			console.log('[fb-digest] no meaningful within-hour digest change, skipping comment');
			return;
		}
		const continuity = evaluateDigestStoryContinuity(existingThread.summary, summary);
		if (!continuity.allowed) {
			console.log(
				`[fb-digest] story continuity guard blocked comment reason=${continuity.reason || 'unknown'} `
				+ `previous=${existingThread.summary?.hazardFocus ?? 'unknown'}/${continuity.previousRegionalFocus ?? 'unknown'} `
				+ `current=${summary.hazardFocus ?? 'unknown'}/${continuity.currentRegionalFocus}`,
			);
			return;
		}
		const commentAllowed = canPostDigestComment(existingThread, nowMs, digestCommentSettings);
		if (!commentAllowed) {
			console.log('[fb-digest] comment cooldown active or max comments reached, skipping');
			return;
		}
		const commentSummary: DigestSummary = {
			...summary,
			changeHint: buildCommentChangeHint(existingThread.summary, summary),
		};
		const copy = await generateCopy(env, commentSummary, 'comment');
		const commentId = await commentOnFacebook(env, existingThread.postId, copy);
		await recordRecentDigestOpening(env, copy);
		console.log(`[fb-digest] posted digest comment=${commentId} post=${existingThread.postId}`);

		const updatedThread: DigestThreadRecord = {
			...existingThread,
			hash: commentSummary.hash,
			commentCount: existingThread.commentCount + 1,
			lastCommentAt: new Date(nowMs).toISOString(),
			summary: commentSummary,
		};
		await writeDigestThread(env, blockId, updatedThread);
		await recordLastPostTimestamp(env, nowMs);
	} else {
		console.log(`[fb-digest] skipping new digest reason=${reason || 'cooldown'}`);
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

	await recordLastPostTimestamp(env, nowMs);

	// Seed digest block record so normal mode picks up cleanly
	const blockId = buildDigestBlockId(nowMs);
	const stateScores = scoreStates(candidates);
	const cursor = await readRotationCursor(env);
	const { selectedStates } = selectStatesForDigest(candidates, stateScores, cursor);
	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, null, clusters[0] ?? null);
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
