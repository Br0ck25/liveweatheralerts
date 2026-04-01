import type { Env, AdminSessionRecord } from '../types';
import {
	KV_ADMIN_SESSION_PREFIX,
	ADMIN_SESSION_COOKIE,
	ADMIN_SESSION_TTL_SECONDS,
} from '../constants';
import { sha256Hex, generateOpaqueToken } from '../utils';

export function getAdminPassword(env: Env): string | null {
	const password = String(env.ADMIN_PASSWORD || '').trim();
	return password || null;
}

function adminSessionKvKey(sessionId: string): string {
	return `${KV_ADMIN_SESSION_PREFIX}${sessionId}`;
}

export function getCookieValue(request: Request, name: string): string | null {
	const cookie = request.headers.get('cookie') || '';
	const cookieEntry = cookie
		.split(';')
		.map((kv) => kv.trim())
		.find((kv) => kv.startsWith(`${name}=`));
	if (!cookieEntry) return null;
	const rawValue = cookieEntry.slice(name.length + 1);
	if (!rawValue) return null;
	try {
		return decodeURIComponent(rawValue);
	} catch {
		return rawValue;
	}
}

export async function createAdminSession(env: Env, adminPassword: string): Promise<string> {
	const sessionId = generateOpaqueToken();
	const record: AdminSessionRecord = {
		createdAt: new Date().toISOString(),
		passwordHash: await sha256Hex(adminPassword),
	};
	await env.WEATHER_KV.put(adminSessionKvKey(sessionId), JSON.stringify(record), {
		expirationTtl: ADMIN_SESSION_TTL_SECONDS,
	});
	return sessionId;
}

export function buildAdminSessionCookie(request: Request, sessionId: string): string {
	const secureAttribute =
		new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SECONDS}${secureAttribute}`;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
	const adminPassword = getAdminPassword(env);
	if (!adminPassword) return false;
	const sessionId = getCookieValue(request, ADMIN_SESSION_COOKIE);
	if (!sessionId) return false;
	const rawRecord = await env.WEATHER_KV.get(adminSessionKvKey(sessionId));
	if (!rawRecord) return false;
	try {
		const record = JSON.parse(rawRecord) as Partial<AdminSessionRecord>;
		return record.passwordHash === (await sha256Hex(adminPassword));
	} catch {
		return false;
	}
}

export function getDebugSummaryBearerToken(env: Env): string | null {
	const token = String(env.DEBUG_SUMMARY_BEARER_TOKEN || '').trim();
	return token || null;
}

export function hasDebugSummaryAccess(
	request: Request,
	expectedBearerToken: string,
): boolean {
	const authHeader =
		request.headers.get('Authorization') ||
		request.headers.get('authorization') ||
		'';
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	const provided = match[1].trim();
	if (!provided) return false;
	return provided === expectedBearerToken;
}

export async function parseRequestBody(request: Request): Promise<URLSearchParams> {
	const contentType =
		request.headers.get('Content-Type') ||
		request.headers.get('content-type');
	if (contentType?.includes('application/json')) {
		const json = await request.json();
		return new URLSearchParams(
			Object.entries(json as Record<string, any>).map(([k, v]) => [k, String(v ?? '')]),
		);
	}
	const text = await request.text();
	return new URLSearchParams(text);
}
