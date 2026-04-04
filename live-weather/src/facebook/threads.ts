import type { Env, AlertThread, AlertChangeRecord, FacebookPublishThreadAction } from '../types';
import { isSevereWeatherFallbackEvent, matchingMetroNamesForAlert } from './config';
import {
	slugify,
	extractStateCodes,
	dedupeStrings,
	extractCountyUgcCodes,
	extractFullCountyFipsCodes,
} from '../utils';

function threadKvKey(ugcCode: string, event: string): string {
	const slug = event.toLowerCase().replace(/\s+/g, '_');
	return `thread:${ugcCode}:${slug}`;
}

export function stormClusterFamilyForEvent(event: string): string | null {
	const normalized = String(event || '').trim().toLowerCase();
	if (isSevereWeatherFallbackEvent(event)) return 'severe_thunderstorm';
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

export function stormClusterThreadKeys(
	feature: any,
	event: string,
	change?: AlertChangeRecord | null,
): string[] {
	const family = stormClusterFamilyForEvent(event);
	if (!family) return [];

	const keys = new Set<string>();
	for (const metroName of matchingMetroNamesForAlert(feature, change)) {
		const metroSlug = slugify(metroName);
		if (metroSlug) {
			keys.add(`thread-cluster:${family}:metro:${metroSlug}`);
		}
	}

	for (const ugcCode of extractCountyUgcCodes(feature)) {
		const normalized = String(ugcCode || '').trim().toUpperCase();
		if (normalized) {
			keys.add(`thread-cluster:${family}:ugc:${normalized}`);
		}
	}

	const stateCodes = dedupeStrings(
		(
			change?.stateCodes?.length
				? change.stateCodes
				: extractStateCodes(feature)
		).map((code) => String(code || '').trim().toUpperCase()),
	).sort();
	const senderSlug = slugify(String(feature?.properties?.senderName || ''));
	const countyCount = Math.max(
		extractFullCountyFipsCodes(feature, change).length,
		dedupeStrings((change?.countyCodes || []).map((countyCode) => String(countyCode || '').trim())).length,
	);
	if (stateCodes.length > 0 && senderSlug && countyCount >= 10) {
		keys.add(`thread-cluster:${family}:sender:${senderSlug}:states:${stateCodes.join('|')}`);
	}

	return [...keys];
}

export async function readThreadByKey(env: Env, key: string): Promise<AlertThread | null> {
	try {
		const raw = await env.WEATHER_KV.get(key);
		if (!raw) return null;
		const t = JSON.parse(raw) as AlertThread;
		// Prune if expired (give a 10-minute grace window)
		if (t.expiresAt && t.expiresAt < (Date.now() / 1000) - 600) {
			await env.WEATHER_KV.delete(key);
			return null;
		}
		return t;
	} catch {
		return null;
	}
}

async function readThread(env: Env, ugcCode: string, event: string): Promise<AlertThread | null> {
	return readThreadByKey(env, threadKvKey(ugcCode, event));
}

export async function writeThreadByKey(env: Env, key: string, thread: AlertThread): Promise<void> {
	const nowSec = Math.floor(Date.now() / 1000);
	const expiresAt = Number(thread.expiresAt);
	const ttl = (Number.isFinite(expiresAt) && expiresAt > nowSec)
		? Math.max(300, expiresAt - nowSec + 7200)
		: 7200; // default to 2 hours if expiry is missing/invalid
	await env.WEATHER_KV.put(key, JSON.stringify(thread), { expirationTtl: ttl });
}

export async function writeThread(env: Env, ugcCode: string, thread: AlertThread): Promise<void> {
	await writeThreadByKey(env, threadKvKey(ugcCode, thread.alertType), thread);
}

export async function deleteThread(env: Env, ugcCode: string, event: string): Promise<void> {
	await env.WEATHER_KV.delete(threadKvKey(ugcCode, event));
}

async function readExistingThreadForAlert(
	env: Env,
	ugcCodes: string[],
	event: string,
): Promise<AlertThread | null> {
	for (const ugcCode of ugcCodes) {
		const thread = await readThread(env, ugcCode, event);
		if (thread) return thread;
	}
	return null;
}

export async function readExistingThreadForFeature(
	env: Env,
	feature: any,
	event: string,
	change?: AlertChangeRecord | null,
): Promise<AlertThread | null> {
	const ugcCodes: string[] = Array.isArray(feature?.properties?.geocode?.UGC) ? feature.properties.geocode.UGC : [];
	const candidates: AlertThread[] = [];
	const directThread = await readExistingThreadForAlert(env, ugcCodes, event);
	if (directThread) candidates.push(directThread);
	for (const key of stormClusterThreadKeys(feature, event, change)) {
		const clusterThread = await readThreadByKey(env, key);
		if (clusterThread) candidates.push(clusterThread);
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => {
		const aPostedAt = Date.parse(String(a.lastPostedAt || '').trim());
		const bPostedAt = Date.parse(String(b.lastPostedAt || '').trim());
		const aValid = Number.isFinite(aPostedAt);
		const bValid = Number.isFinite(bPostedAt);
		if (aValid && bValid && aPostedAt !== bPostedAt) return bPostedAt - aPostedAt;
		if (aValid !== bValid) return aValid ? -1 : 1;
		return 0;
	});
	return candidates[0];
}

export async function writeStormClusterThreads(
	env: Env,
	feature: any,
	event: string,
	thread: AlertThread,
	change?: AlertChangeRecord | null,
): Promise<void> {
	for (const key of stormClusterThreadKeys(feature, event, change)) {
		await writeThreadByKey(env, key, thread);
	}
}

export function normalizeFacebookPublishThreadAction(
	value: unknown,
): FacebookPublishThreadAction {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'new_post' || normalized === 'comment') return normalized;
	return '';
}
