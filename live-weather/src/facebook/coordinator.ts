import type {
	AlertChangeRecord,
	Env,
	FacebookCoordinatorSnapshot,
	FacebookCoverageEvaluation,
	FacebookCoverageIntent,
	FacebookCoverageLane,
	FacebookCoordinatorLaneStatus,
} from '../types';
import { KV_FB_COORDINATOR_DEBUG } from '../constants';
import { readFbAutoPostConfig } from './config';
import { autoPostFacebookAlerts, evaluateAutoPostIntent } from './auto-post';
import { evaluateDigestCoverageIntent, runDigestCoverage } from './digest';
import { createDigestCopyFn } from './llm';
import { evaluateSpcCoverageIntents, queueDeferredSpcAnchorIfNeeded, runSpcCoverageForDay } from './spc-v2';

const COVERAGE_LANE_TIEBREAK: FacebookCoverageLane[] = ['alerts', 'spc_day1', 'spc_day2', 'spc_day3', 'digest'];
const COORDINATOR_DEBUG_TTL_SECONDS = 8 * 60 * 60;

function coordinatorSelectionReason(lane: FacebookCoverageLane | null): string | null {
	if (lane === 'alerts') return 'coordinator_selected_alerts';
	if (lane === 'digest') return 'coordinator_selected_digest';
	if (lane === 'spc_day1') return 'coordinator_selected_spc_day1';
	if (lane === 'spc_day2') return 'coordinator_selected_spc_day2';
	if (lane === 'spc_day3') return 'coordinator_selected_spc_day3';
	return null;
}

function coordinatorSuppressionReason(
	lane: FacebookCoverageLane,
	selectedLane: FacebookCoverageLane | null,
): string {
	if (selectedLane === 'alerts') {
		if (lane === 'digest') return 'coordinator_suppressed_digest_by_alerts';
		if (lane === 'spc_day1' || lane === 'spc_day2' || lane === 'spc_day3') return 'coordinator_suppressed_spc_by_alerts';
	}
	if (selectedLane === 'digest') {
		if (lane === 'spc_day1' || lane === 'spc_day2' || lane === 'spc_day3') return 'coordinator_suppressed_spc_by_digest';
		if (lane === 'alerts') return 'coordinator_suppressed_alerts_by_digest';
	}
	if (selectedLane === 'spc_day1' || selectedLane === 'spc_day2' || selectedLane === 'spc_day3') {
		if (lane === 'digest') return `coordinator_suppressed_digest_by_${selectedLane}`;
		if (lane === 'alerts') return `coordinator_suppressed_alerts_by_${selectedLane}`;
		if (lane === 'spc_day1' || lane === 'spc_day2' || lane === 'spc_day3') return `coordinator_suppressed_${lane}_by_${selectedLane}`;
	}
	return selectedLane ? `coordinator_suppressed_${lane}_by_${selectedLane}` : `coordinator_suppressed_${lane}`;
}

function compareCoverageIntents(
	left: FacebookCoverageIntent,
	right: FacebookCoverageIntent,
): number {
	const isDeferredSpcAnchorRelease = (intent: FacebookCoverageIntent): boolean => (
		(intent.lane === 'spc_day2' || intent.lane === 'spc_day3')
		&& intent.reason === 'deferred_anchor_release'
	);
	const leftDeferred = isDeferredSpcAnchorRelease(left);
	const rightDeferred = isDeferredSpcAnchorRelease(right);
	if (leftDeferred !== rightDeferred) {
		if (leftDeferred && right.lane !== 'alerts') return -1;
		if (rightDeferred && left.lane !== 'alerts') return 1;
	}
	const priorityDiff = right.priority - left.priority;
	if (priorityDiff !== 0) return priorityDiff;
	const laneDiff = COVERAGE_LANE_TIEBREAK.indexOf(left.lane) - COVERAGE_LANE_TIEBREAK.indexOf(right.lane);
	if (laneDiff !== 0) return laneDiff;
	const actionWeight = (action: FacebookCoverageIntent['action']): number => {
		if (action === 'multi_post') return 0;
		if (action === 'post') return 1;
		return 2;
	};
	const actionDiff = actionWeight(left.action) - actionWeight(right.action);
	if (actionDiff !== 0) return actionDiff;
	return `${left.reason}|${left.storyKey || ''}`.localeCompare(`${right.reason}|${right.storyKey || ''}`);
}

export function selectFacebookCoverageIntent(
	evaluations: FacebookCoverageEvaluation[],
): FacebookCoverageIntent | null {
	const intents = evaluations
		.map((evaluation) => evaluation.intent)
		.filter((intent): intent is FacebookCoverageIntent => !!intent);
	if (intents.length === 0) return null;
	return [...intents].sort(compareCoverageIntents)[0] ?? null;
}

function buildCoordinatorStatuses(
	evaluations: FacebookCoverageEvaluation[],
	selectedIntent: FacebookCoverageIntent | null,
): FacebookCoordinatorLaneStatus[] {
	const selectedReason = coordinatorSelectionReason(selectedIntent?.lane ?? null);
	return evaluations.map((evaluation) => {
		if (!evaluation.intent) {
			return {
				lane: evaluation.lane,
				intent: null,
				status: evaluation.blockedReason ? 'blocked' : 'idle',
				reason: evaluation.blockedReason ?? null,
				detail: null,
			};
		}
		if (selectedIntent && evaluation.lane === selectedIntent.lane) {
			return {
				lane: evaluation.lane,
				intent: evaluation.intent,
				status: 'selected',
				reason: selectedReason,
				detail: evaluation.intent.reason,
			};
		}
		return {
			lane: evaluation.lane,
			intent: evaluation.intent,
			status: 'suppressed',
			reason: coordinatorSuppressionReason(evaluation.lane, selectedIntent?.lane ?? null),
			detail: evaluation.intent.reason,
		};
	});
}

function buildCoordinatorMessages(snapshot: Pick<FacebookCoordinatorSnapshot, 'selectedReason' | 'statuses'>): string[] {
	const messages = [
		snapshot.selectedReason ?? 'coordinator_no_lane_selected',
		...snapshot.statuses.map((status) => status.reason ?? '').filter(Boolean),
	];
	return Array.from(new Set(messages));
}

export async function readFacebookCoordinatorSnapshot(env: Env): Promise<FacebookCoordinatorSnapshot | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_COORDINATOR_DEBUG);
		if (!raw) return null;
		return JSON.parse(raw) as FacebookCoordinatorSnapshot;
	} catch {
		return null;
	}
}

async function writeFacebookCoordinatorSnapshot(env: Env, snapshot: FacebookCoordinatorSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_COORDINATOR_DEBUG, JSON.stringify(snapshot), {
		expirationTtl: COORDINATOR_DEBUG_TTL_SECONDS,
	});
}

export async function runCoordinatedFacebookCoverage(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	nowMs = Date.now(),
): Promise<FacebookCoordinatorSnapshot> {
	const autoPostConfig = await readFbAutoPostConfig(env);
	const digestEvaluation = autoPostConfig.mode === 'smart_high_impact' && autoPostConfig.digestCoverageEnabled === true
		? await evaluateDigestCoverageIntent(env, map, nowMs)
		: { lane: 'digest', intent: null, blockedReason: 'digest_disabled' } satisfies FacebookCoverageEvaluation;
	const evaluations: FacebookCoverageEvaluation[] = [
		await evaluateAutoPostIntent(env, map, changes, nowMs),
		...(await evaluateSpcCoverageIntents(env, nowMs)),
		digestEvaluation,
	];
	const selectedIntent = selectFacebookCoverageIntent(evaluations);
	const snapshot: FacebookCoordinatorSnapshot = {
		generatedAt: new Date(nowMs).toISOString(),
		statuses: buildCoordinatorStatuses(evaluations, selectedIntent),
		selectedLane: selectedIntent?.lane ?? null,
		selectedAction: selectedIntent?.action ?? null,
		selectedReason: coordinatorSelectionReason(selectedIntent?.lane ?? null),
		selectedIntentReason: selectedIntent?.reason ?? null,
		messages: [],
		executionError: null,
	};
	snapshot.messages = buildCoordinatorMessages(snapshot);

	try {
		if (!selectedIntent) {
			console.log('[fb-coordinator] coordinator_no_lane_selected');
			await writeFacebookCoordinatorSnapshot(env, snapshot);
			return snapshot;
		}

		for (const evaluation of evaluations) {
			await queueDeferredSpcAnchorIfNeeded(env, evaluation, selectedIntent, nowMs);
		}

		console.log(
			`[fb-coordinator] ${snapshot.selectedReason || 'coordinator_no_lane_selected'} lane=${selectedIntent.lane} `
			+ `action=${selectedIntent.action} lane_reason=${selectedIntent.reason}`,
		);

		switch (selectedIntent.lane) {
			case 'alerts':
				await autoPostFacebookAlerts(env, map, changes);
				break;
			case 'digest': {
				const copyFn = createDigestCopyFn(autoPostConfig.llmCopyEnabled === true);
				await runDigestCoverage(env, map, copyFn);
				break;
			}
			case 'spc_day1':
				await runSpcCoverageForDay(env, 1, nowMs);
				break;
			case 'spc_day2':
				await runSpcCoverageForDay(env, 2, nowMs);
				break;
			case 'spc_day3':
				await runSpcCoverageForDay(env, 3, nowMs);
				break;
		}

		await writeFacebookCoordinatorSnapshot(env, snapshot);
		return snapshot;
	} catch (error) {
		snapshot.executionError = error instanceof Error ? error.message : String(error);
		await writeFacebookCoordinatorSnapshot(env, snapshot);
		throw error;
	}
}
