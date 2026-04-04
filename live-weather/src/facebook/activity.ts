import type { Env } from '../types';
import {
	FB_GLOBAL_POST_GAP_MS,
	KV_FB_LAST_POST_TIMESTAMP,
} from '../constants';

const FB_ACTIVITY_TTL_SECONDS = 8 * 60 * 60;

function parseFacebookActivityMs(raw: string | null): number | null {
	const ms = Date.parse(String(raw || '').trim());
	return Number.isFinite(ms) ? ms : null;
}

export async function readLastFacebookActivityTimestamp(env: Env): Promise<number | null> {
	try {
		return parseFacebookActivityMs(await env.WEATHER_KV.get(KV_FB_LAST_POST_TIMESTAMP));
	} catch {
		return null;
	}
}

export async function recordLastFacebookActivity(env: Env, nowMs = Date.now()): Promise<void> {
	try {
		await env.WEATHER_KV.put(
			KV_FB_LAST_POST_TIMESTAMP,
			new Date(nowMs).toISOString(),
			{ expirationTtl: FB_ACTIVITY_TTL_SECONDS },
		);
	} catch {
		// Best-effort coordination only.
	}
}

export async function readRecentFacebookActivity(
	env: Env,
	nowMs = Date.now(),
	gapMs = FB_GLOBAL_POST_GAP_MS,
): Promise<{
	lastActivityMs: number | null;
	lastActivityAt: string | null;
	withinGap: boolean;
	remainingGapMs: number;
}> {
	const lastActivityMs = await readLastFacebookActivityTimestamp(env);
	if (lastActivityMs == null) {
		return {
			lastActivityMs: null,
			lastActivityAt: null,
			withinGap: false,
			remainingGapMs: 0,
		};
	}

	const elapsedMs = nowMs - lastActivityMs;
	const withinGap = elapsedMs >= 0 && elapsedMs < gapMs;
	return {
		lastActivityMs,
		lastActivityAt: new Date(lastActivityMs).toISOString(),
		withinGap,
		remainingGapMs: withinGap ? gapMs - elapsedMs : 0,
	};
}
