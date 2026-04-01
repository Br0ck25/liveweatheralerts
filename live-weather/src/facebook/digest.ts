import type {
	Env,
	DigestHazardFamily,
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
	FB_DIGEST_COMMENT_COOLDOWN_MS,
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
} from '../constants';
import { deriveAlertImpactCategories, dedupeStrings } from '../utils';

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

function buildHazardClusters(candidates: DigestCandidate[]): HazardClusterSummary[] {
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
		const eventCounts = new Map<string, number>();
		for (const item of items) {
			for (const s of item.stateCodes) stateSet.add(s);
			score += alertTierScore(item.alertTier);
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
			topAlertTypes,
		});
	}
	// Sort: flood first, then winter, wind, fire, other; within family by score desc
	const familyOrder: DigestHazardFamily[] = ['flood', 'winter', 'wind', 'fire', 'other'];
	clusters.sort((a, b) => {
		const aOrder = familyOrder.indexOf(a.family);
		const bOrder = familyOrder.indexOf(b.family);
		if (aOrder !== bOrder) return aOrder - bOrder;
		return b.score - a.score;
	});
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

function checkClusterBreakout(clusters: HazardClusterSummary[]): HazardClusterSummary | null {
	for (const cluster of clusters) {
		if (cluster.family === 'flood') {
			const floodWarnings = cluster.alertCount;
			const multiState = cluster.states.length >= 2;
			if (floodWarnings >= FB_CLUSTER_BREAKOUT_FLOOD_WARNINGS && multiState) return cluster;
		}
		if (cluster.score >= FB_CLUSTER_BREAKOUT_SCORE_THRESHOLD && cluster.states.length >= FB_CLUSTER_BREAKOUT_MIN_STATES) {
			return cluster;
		}
	}
	return null;
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
): DigestSummary {
	const hazardFocus = clusterBreakout?.family ?? (clusters[0]?.family ?? null);
	const topAlertTypes = clusterBreakout
		? clusterBreakout.topAlertTypes
		: clusters.flatMap((c) => c.topAlertTypes).slice(0, 3);
	const urgency = deriveDigestUrgency(candidates);
	const hash = buildDigestHash(selectedStates, topAlertTypes, hazardFocus);

	return {
		mode,
		postType: clusterBreakout ? 'cluster' : 'digest',
		hazardFocus: hazardFocus ?? null,
		states: selectedStates,
		topAlertTypes: dedupeStrings(topAlertTypes).slice(0, 3),
		urgency,
		alertCount: candidates.length,
		hash,
	};
}

// ---------------------------------------------------------------------------
// Cooldown checks
// ---------------------------------------------------------------------------

async function canPostNewDigest(env: Env, nowMs: number): Promise<{
	allowed: boolean;
	blockId: string;
	existingThread: DigestThreadRecord | null;
}> {
	const block = await readDigestBlockRecord(env);
	// Derive the current block ID from time (each 30-min window = 1 block)
	const blockMs = FB_DIGEST_COOLDOWN_MS;
	const blockId = `block-${Math.floor(nowMs / blockMs)}`;

	if (!block || block.blockId !== blockId) {
		// New block — can post a new digest
		return { allowed: true, blockId, existingThread: null };
	}

	// Same block — check if we can comment
	const thread = await readDigestThread(env, blockId);
	return { allowed: false, blockId, existingThread: thread };
}

async function canPostDigestComment(thread: DigestThreadRecord, nowMs: number): Promise<boolean> {
	if (thread.commentCount >= 1) return false; // max 1 comment per block
	if (!thread.lastCommentAt) return true;
	const lastCommentMs = Date.parse(thread.lastCommentAt);
	if (!Number.isFinite(lastCommentMs)) return true;
	return (nowMs - lastCommentMs) >= FB_DIGEST_COMMENT_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Facebook posting helpers for digest
// ---------------------------------------------------------------------------

async function postToFacebook(env: Env, message: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured');
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

export function buildStartupSnapshotText(clusters: HazardClusterSummary[], totalCount: number): string {
	const now = new Date();
	const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
	const lines: string[] = [`CURRENT WEATHER SITUATION — ${dateStr}`];

	if (clusters.length === 0) {
		lines.push('No significant weather alerts are active at this time.');
	} else {
		lines.push(`${totalCount} active weather alert${totalCount !== 1 ? 's' : ''} across the U.S.`);
		lines.push('');
		for (const cluster of clusters.slice(0, 3)) {
			const stateList = cluster.states.slice(0, 4).join(', ')
				+ (cluster.states.length > 4 ? ` and ${cluster.states.length - 4} more` : '');
			const label = cluster.family === 'flood' ? 'Flooding concerns'
				: cluster.family === 'winter' ? 'Winter weather'
				: cluster.family === 'wind' ? 'Wind impacts'
				: cluster.family === 'fire' ? 'Fire weather'
				: 'Weather alerts';
			lines.push(`${label}: ${stateList}`);
		}
	}
	lines.push('');
	lines.push('Full alerts: liveweatheralerts.com');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runDigestCoverage(
	env: Env,
	alertMap: Record<string, any>,
	generateCopy: (env: Env, summary: DigestSummary) => Promise<string>,
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

	// Check for startup mode
	const startupNeeded = await isStartupMode(env, nowMs);
	if (startupNeeded) {
		await runStartupCoverage(env, candidates, mode, generateCopy, nowMs);
		await writeStartupState(env, { initializedAt: new Date(nowMs).toISOString() });
		return;
	}

	const clusters = buildHazardClusters(candidates);
	const clusterBreakout = checkClusterBreakout(clusters);
	const stateScores = scoreStates(candidates);
	const cursor = await readRotationCursor(env);
	const { selectedStates, nextCursor } = selectStatesForDigest(candidates, stateScores, cursor);

	if (selectedStates.length === 0) {
		console.log('[fb-digest] no states selected for digest');
		return;
	}

	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, clusterBreakout);
	const lastHash = await readLastDigestHash(env);

	const { allowed, blockId, existingThread } = await canPostNewDigest(env, nowMs);

	if (allowed) {
		if (summary.hash === lastHash) {
			console.log('[fb-digest] hash unchanged, skipping digest');
			return;
		}
		// Post new digest
		const copy = await generateCopy(env, summary);
		const postId = await postToFacebook(env, copy);
		console.log(`[fb-digest] posted new digest post=${postId} mode=${mode} states=${selectedStates.join(',')}`);

		const block: PublishedDigestBlockRecord = {
			blockId,
			publishedAt: new Date(nowMs).toISOString(),
			hash: summary.hash,
			postId,
		};
		await writeDigestBlockRecord(env, block);
		await writeLastDigestHash(env, summary.hash);
		await writeRotationCursor(env, nextCursor);
		await recordLastPostTimestamp(env, nowMs);

		const thread: DigestThreadRecord = {
			postId,
			blockId,
			publishedAt: new Date(nowMs).toISOString(),
			hash: summary.hash,
			commentCount: 0,
			lastCommentAt: null,
		};
		await writeDigestThread(env, blockId, thread);
	} else if (existingThread) {
		// Same block — check if we can add a comment
		if (summary.hash === existingThread.hash) {
			console.log('[fb-digest] content unchanged within block, skipping comment');
			return;
		}
		const commentAllowed = await canPostDigestComment(existingThread, nowMs);
		if (!commentAllowed) {
			console.log('[fb-digest] comment cooldown active or max comments reached, skipping');
			return;
		}
		const copy = await generateCopy(env, summary);
		const commentId = await commentOnFacebook(env, existingThread.postId, copy);
		console.log(`[fb-digest] posted digest comment=${commentId} post=${existingThread.postId}`);

		const updatedThread: DigestThreadRecord = {
			...existingThread,
			hash: summary.hash,
			commentCount: existingThread.commentCount + 1,
			lastCommentAt: new Date(nowMs).toISOString(),
		};
		await writeDigestThread(env, blockId, updatedThread);
		await recordLastPostTimestamp(env, nowMs);
	} else {
		console.log('[fb-digest] within cooldown block but no thread found, skipping');
	}
}

async function runStartupCoverage(
	env: Env,
	candidates: DigestCandidate[],
	mode: 'normal' | 'incident',
	generateCopy: (env: Env, summary: DigestSummary) => Promise<string>,
	nowMs: number,
): Promise<void> {
	const clusters = buildHazardClusters(candidates);
	if (clusters.length === 0) {
		console.log('[fb-digest] startup: no clusters, skipping snapshot post');
		return;
	}

	const snapshotText = buildStartupSnapshotText(clusters, candidates.length);
	const postId = await postToFacebook(env, snapshotText);
	console.log(`[fb-digest] startup snapshot post=${postId}`);

	await recordLastPostTimestamp(env, nowMs);

	// Seed digest block record so normal mode picks up cleanly
	const blockMs = FB_DIGEST_COOLDOWN_MS;
	const blockId = `block-${Math.floor(nowMs / blockMs)}`;
	const stateScores = scoreStates(candidates);
	const cursor = await readRotationCursor(env);
	const { selectedStates } = selectStatesForDigest(candidates, stateScores, cursor);
	const summary = buildDigestSummary(candidates, clusters, selectedStates, mode, null);

	const block: PublishedDigestBlockRecord = {
		blockId,
		publishedAt: new Date(nowMs).toISOString(),
		hash: summary.hash,
		postId,
	};
	await writeDigestBlockRecord(env, block);
	await writeLastDigestHash(env, summary.hash);

	const thread: DigestThreadRecord = {
		postId,
		blockId,
		publishedAt: new Date(nowMs).toISOString(),
		hash: summary.hash,
		commentCount: 0,
		lastCommentAt: null,
	};
	await writeDigestThread(env, blockId, thread);
	console.log(`[fb-digest] startup: seeded digest state block=${blockId}`);
}
