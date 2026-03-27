import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { __testing } from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const TEST_VAPID_PUBLIC_KEY =
	'BBh6tbpZvhbFTERXyl2f5J3oUkBxUGl7cJ4x7GYNZMpbxXO8BbJqFEjFIIgozLMF_SAdpJQ0Vqg75fn0wlRqmaQ';
const TEST_VAPID_PRIVATE_KEY =
	'XITOiN6eGnyjn9noLsZTwmrjSPIT_oSiRpJ9M1gZ_mc';

const TEST_PUSH_SUBSCRIPTION = {
	endpoint: 'https://push.example/subscription-1',
	expirationTime: null,
	keys: {
		p256dh: 'BA5Q3Q4RzwygoHXoLJKn1GAG3Dm9V_HNXXU3Jxi1_YXjUR6Wz6fFg4M9fnLqXUcwe0qY1jv7YK6XO2jz3aMLJ_Q',
		auth: 'oRyVEqsfwNg4vY_YJEb9Hg',
	},
};

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

describe('Live Weather Admin worker', () => {
	const sampleAlerts = {
		type: 'FeatureCollection',
		features: [
			{
				id: 'alert-1',
				properties: {
					event: 'Tornado Warning',
					severity: 'Severe',
					areaDesc: 'Test County',
					geocode: { UGC: ['KYC001'] },
					status: 'Actual',
					headline: 'Test tornado warning',
					description: 'Tornado expected',
					effective: 'Now',
					expires: 'Soon',
					url: 'https://example.com/alert-1',
				},
			},
		],
	};

	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		(globalThis as any).fetch = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('api.weather.gov/alerts/active')) {
				return new Response(JSON.stringify(sampleAlerts), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://live-weather.example/images/') || url.startsWith('https://live-weather.example/virginia/') || url.startsWith('https://live-weather.example/advisory/')) {
				if (init?.method === 'HEAD') {
					if (url.endsWith('/images/warning/tornado-warning-warning.jpg')) {
						return new Response('', { status: 404 });
					}
					return new Response('', { status: 200 });
				}
				return new Response('', { status: 200 });
			}
			if (url.includes('graph.facebook.com')) {
				if (url.includes('/photos')) {
					return new Response(JSON.stringify({ id: '12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				if (url.includes('/feed')) {
					return new Response(JSON.stringify({ id: '12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
			}
			if (url.startsWith('https://push.example/')) {
				return new Response('', { status: 201 });
			}
			return new Response('not found', { status: 404 });
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('requires login and then serves /admin html with weather alerts and action forms', async () => {
		const openRequest = new IncomingRequest('https://live-weather.example/admin');
		const ctx = createExecutionContext();
		let response = await worker.fetch(openRequest, env, ctx);
		await waitOnExecutionContext(ctx);
		let body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Admin Login');

		const loginBody = new URLSearchParams({ password: 'testpassword' }).toString();
		const loginRequest = new IncomingRequest('https://live-weather.example/admin/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: loginBody,
		});
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
		response = await worker.fetch(loginRequest, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(303);
		const cookie = response.headers.get('set-cookie');
		expect(cookie).toContain('admin_session=');

		const authRequest = new IncomingRequest('https://live-weather.example/admin', {
			headers: { Cookie: cookie || '' },
		});
		response = await worker.fetch(authRequest, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Live Weather Alerts Admin');
		expect(body).toContain('Tornado Warning');
	});

	it('serves a public weather alerts page at /live-weather-alerts', async () => {
		const request = new IncomingRequest('https://live-weather.example/live-weather-alerts');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Live Weather Alerts');
		expect(body).toContain('What this means');
		expect(body).toContain('Tornado Warning');
		expect(body).toContain('id="stateFilter"');
		expect(body).toContain('liveWeather:selectedState');
		expect(body).toContain('>Alabama<');
		expect(body).toContain('>Kentucky<');
		expect(body).toContain('>Wyoming<');
		expect(body).not.toContain('<span class="eyebrow">Live Weather Alerts</span>');
	});

	it('serves alert data as JSON at /api/alerts', async () => {
		const request = new IncomingRequest('https://live-weather.example/api/alerts');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		const json = await response.json() as any;
		expect(Array.isArray(json.alerts)).toBe(true);
		expect(json.alerts[0].event).toBe('Tornado Warning');
		expect(json.alerts[0].category).toBe('warning');
		expect(Array.isArray(json.alerts[0].impactCategories)).toBe(true);
		expect(json.alerts[0].impactCategories).toEqual(expect.arrayContaining(['tornado', 'wind']));
		expect(json.alerts[0].isMajor).toBe(true);
		expect(json.alerts[0].detailUrl).toBe('/alerts/alert-1');
		expect(typeof json.alerts[0].summary).toBe('string');
		expect(typeof json.alerts[0].instructionsSummary).toBe('string');
		expect(json.meta).toBeTruthy();
		expect(typeof json.meta.generatedAt).toBe('string');
		expect(typeof json.meta.stale).toBe('boolean');
		expect(json.meta.count).toBe(json.alerts.length);
	});

	it('auto-refreshes stale alert cache for localhost /api/alerts requests in local dev', async () => {
		await env.WEATHER_KV.put(
			'alerts:map',
			JSON.stringify({
				'alert-1': {
					id: 'alert-1',
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Test County',
					},
				},
			}),
		);
		const oldLastPoll = new Date(Date.now() - 341 * 60 * 1000).toISOString();
		await env.WEATHER_KV.put('alerts:last-poll', oldLastPoll);

		const request = new IncomingRequest('http://127.0.0.1:8787/api/alerts');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.lastPoll).not.toBe(oldLastPoll);
		expect(json.meta.stale).toBe(false);
	});

	it('rejects unauthorized requests at /api/debug/summary', async () => {
		const request = new IncomingRequest('https://live-weather.example/api/debug/summary');
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, DEBUG_SUMMARY_BEARER_TOKEN: 'debug-token' } as any,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toContain('Bearer');
		const json = await response.json() as any;
		expect(json.error).toBe('Unauthorized.');
	});

	it('fails closed at /api/debug/summary when bearer token config is missing', async () => {
		const request = new IncomingRequest('https://live-weather.example/api/debug/summary', {
			headers: {
				Authorization: 'Bearer debug-token',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(503);
		const json = await response.json() as any;
		expect(json.error).toContain('DEBUG_SUMMARY_BEARER_TOKEN');
	});

	it('returns a lightweight debug summary at /api/debug/summary when authorized', async () => {
		await env.WEATHER_KV.put(
			'alerts:map',
			JSON.stringify({
				'alert-1': {
					id: 'alert-1',
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Test County',
					},
				},
			}),
		);
		await env.WEATHER_KV.put(
			'ops:diagnostics:v1',
			JSON.stringify({
				lastSyncAttemptAt: '2026-03-27T11:00:00.000Z',
				lastSuccessfulSyncAt: '2026-03-27T11:00:00.000Z',
				lastSyncError: null,
				lastKnownAlertCount: 1,
				lastStaleDataAt: null,
				lastStaleMinutes: null,
				invalidSubscriptionCount: 2,
				lastInvalidSubscriptionAt: '2026-03-27T11:10:00.000Z',
				lastInvalidSubscriptionReason: 'push_endpoint_gone_KY_410',
				pushFailureCount: 1,
				recentPushFailures: [
					{
						at: '2026-03-27T11:12:00.000Z',
						stateCode: 'KY',
						status: 502,
						subscriptionId: 'sub-1',
						message: 'gateway timeout',
					},
				],
			}),
		);
		await env.WEATHER_KV.put('push:sub:1', JSON.stringify({ id: '1' }));
		await env.WEATHER_KV.put('push:sub:2', JSON.stringify({ id: '2' }));

		const request = new IncomingRequest('https://live-weather.example/api/debug/summary', {
			headers: {
				Authorization: 'Bearer debug-token',
				Origin: 'https://liveweatheralerts.com',
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, DEBUG_SUMMARY_BEARER_TOKEN: 'debug-token' } as any,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('access-control-allow-origin')).toBe('https://liveweatheralerts.com');
		const json = await response.json() as any;
		expect(typeof json.generatedAt).toBe('string');
		expect(json.lastSuccessfulSync).toBe('2026-03-27T11:00:00.000Z');
		expect(json.activeAlertCount).toBe(1);
		expect(json.pushSubscriptionCount).toBeGreaterThanOrEqual(2);
		expect(json.invalidSubscriptionCount).toBe(2);
		expect(Array.isArray(json.recentPushFailures)).toBe(true);
		expect(json.recentPushFailures[0].stateCode).toBe('KY');
	});

	it('serves alert detail data at /api/alerts/:id and returns 404 when missing', async () => {
		const ctx = createExecutionContext();
		const foundResponse = await worker.fetch(
			new IncomingRequest('https://live-weather.example/api/alerts/alert-1'),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(foundResponse.status).toBe(200);
		const foundJson = await foundResponse.json() as any;
		expect(foundJson.alert).toBeTruthy();
		expect(foundJson.alert.id).toBe('alert-1');
		expect(foundJson.alert.category).toBe('warning');
		expect(foundJson.alert.impactCategories).toEqual(expect.arrayContaining(['tornado']));
		expect(foundJson.alert.isMajor).toBe(true);
		expect(foundJson.alert.detailUrl).toBe('/alerts/alert-1');
		expect(typeof foundJson.alert.summary).toBe('string');
		expect(typeof foundJson.alert.instructionsSummary).toBe('string');
		expect(foundJson.meta).toBeTruthy();
		expect(typeof foundJson.meta.generatedAt).toBe('string');
		expect(typeof foundJson.meta.stale).toBe('boolean');
		expect(typeof foundJson.meta.staleMinutes).toBe('number');
		expect(foundJson.meta.count).toBe(1);

		const missingCtx = createExecutionContext();
		const missingResponse = await worker.fetch(
			new IncomingRequest('https://live-weather.example/api/alerts/does-not-exist'),
			env,
			missingCtx,
		);
		await waitOnExecutionContext(missingCtx);
		expect(missingResponse.status).toBe(404);
		const missingJson = await missingResponse.json() as any;
		expect(missingJson.error).toBe('Alert not found.');
	});

	it('auto-refreshes stale alert detail cache for localhost detail requests in local dev', async () => {
		await env.WEATHER_KV.put(
			'alerts:map',
			JSON.stringify({
				'alert-1': {
					id: 'alert-1',
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Test County',
					},
				},
			}),
		);
		const oldLastPoll = new Date(Date.now() - 341 * 60 * 1000).toISOString();
		await env.WEATHER_KV.put('alerts:last-poll', oldLastPoll);

		const request = new IncomingRequest('http://127.0.0.1:8787/api/alerts/alert-1');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.lastPoll).not.toBe(oldLastPoll);
		expect(json.meta.stale).toBe(false);
	});

	it('builds canonical push deep-links for single-alert payloads', () => {
		const payload = __testing.buildStatePushMessageData('KY', [
			{
				id: 'abc 123',
				properties: {
					event: 'Tornado Warning',
					headline: 'Take shelter now',
					areaDesc: 'Test County',
				},
			},
		]) as any;

		expect(payload.url).toBe('/alerts/abc%20123');
		expect(payload.detailUrl).toBe('/alerts/abc%20123');
		expect(payload.fallbackUrl).toBe('/alerts?state=KY');
		expect(payload.alertId).toBe('abc 123');
	});

	it('returns filtered lifecycle changes from GET /api/alerts/changes', async () => {
		await env.WEATHER_KV.put(
			'alerts:changes:v1',
			JSON.stringify([
				{
					alertId: 'alert-1',
					stateCodes: ['KY'],
					countyCodes: ['001'],
					event: 'Tornado Warning',
					areaDesc: 'Test County',
					changedAt: '2026-03-26T12:00:00.000Z',
					changeType: 'new',
					previousExpires: null,
					nextExpires: '2026-03-26T13:00:00.000Z',
				},
				{
					alertId: 'all-clear:KY',
					stateCodes: ['KY'],
					countyCodes: [],
					event: 'All Clear',
					areaDesc: 'Kentucky',
					changedAt: '2026-03-26T13:00:00.000Z',
					changeType: 'all_clear',
					previousExpires: null,
					nextExpires: null,
				},
				{
					alertId: 'alert-2',
					stateCodes: ['OH'],
					countyCodes: ['153'],
					event: 'Flood Warning',
					areaDesc: 'Summit County',
					changedAt: '2026-03-26T13:30:00.000Z',
					changeType: 'updated',
					previousExpires: '2026-03-26T14:00:00.000Z',
					nextExpires: '2026-03-26T15:00:00.000Z',
				},
			]),
		);

		const request = new IncomingRequest(
			'https://live-weather.example/api/alerts/changes?since=2026-03-26T12:30:00.000Z&state=KY',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(Array.isArray(json.changes)).toBe(true);
		expect(json.changes.length).toBe(1);
		expect(json.changes[0].alertId).toBe('all-clear:KY');
		expect(json.changes[0].changeType).toBe('all_clear');
	});

	it('returns day-grouped history from GET /api/alerts/history with place-aware filters and day windows', async () => {
		const nowMs = Date.now();
		const recentChangedAt = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
		const olderChangedAt = new Date(nowMs - 30 * 60 * 60 * 1000).toISOString();
		const recentDay = recentChangedAt.slice(0, 10);
		const olderDay = olderChangedAt.slice(0, 10);

		await env.WEATHER_KV.put(
			'alerts:history:daily:v1',
			JSON.stringify({
				[recentDay]: {
					day: recentDay,
					updatedAt: recentChangedAt,
					snapshot: {
						activeAlertCount: 2,
						activeWarningCount: 1,
						activeMajorCount: 1,
						byState: {
							KY: {
								activeAlertCount: 1,
								activeWarningCount: 1,
								activeMajorCount: 1,
							},
							OH: {
								activeAlertCount: 1,
								activeWarningCount: 0,
								activeMajorCount: 0,
							},
						},
						byStateCounty: {
							'KY:111': {
								activeAlertCount: 1,
								activeWarningCount: 1,
								activeMajorCount: 1,
							},
							'OH:153': {
								activeAlertCount: 1,
								activeWarningCount: 0,
								activeMajorCount: 0,
							},
						},
					},
					entries: [
						{
							alertId: 'alert-recent-ky',
							stateCodes: ['KY'],
							countyCodes: ['111'],
							event: 'Tornado Warning',
							areaDesc: 'Jefferson County',
							changedAt: recentChangedAt,
							changeType: 'new',
							severity: 'Extreme',
							category: 'warning',
							isMajor: true,
							summary: 'Tornado warning issued.',
						},
						{
							alertId: 'alert-recent-oh',
							stateCodes: ['OH'],
							countyCodes: ['153'],
							event: 'Flood Advisory',
							areaDesc: 'Summit County',
							changedAt: recentChangedAt,
							changeType: 'updated',
							severity: 'Minor',
							category: 'advisory',
							isMajor: false,
							summary: 'Flood advisory updated.',
						},
					],
				},
				[olderDay]: {
					day: olderDay,
					updatedAt: olderChangedAt,
					snapshot: {
						activeAlertCount: 1,
						activeWarningCount: 1,
						activeMajorCount: 1,
						byState: {
							KY: {
								activeAlertCount: 1,
								activeWarningCount: 1,
								activeMajorCount: 1,
							},
						},
					},
					entries: [
						{
							alertId: 'alert-older-ky',
							stateCodes: ['KY'],
							countyCodes: ['111'],
							event: 'Severe Thunderstorm Warning',
							areaDesc: 'Jefferson County',
							changedAt: olderChangedAt,
							changeType: 'expired',
							severity: 'Severe',
							category: 'warning',
							isMajor: true,
							summary: 'Warning expired.',
						},
					],
				},
			}),
		);

		const countyRequest = new IncomingRequest(
			'https://live-weather.example/api/alerts/history?state=KY&countyCode=111&days=1',
		);
		const countyCtx = createExecutionContext();
		const countyResponse = await worker.fetch(countyRequest, env, countyCtx);
		await waitOnExecutionContext(countyCtx);
		expect(countyResponse.status).toBe(200);
		const countyJson = await countyResponse.json() as any;
		expect(Array.isArray(countyJson.days)).toBe(true);
		expect(countyJson.days.length).toBe(1);
		expect(countyJson.days[0].day).toBe(recentDay);
		expect(countyJson.days[0].summary.totalEntries).toBe(1);
		expect(countyJson.days[0].summary.activeAlertCount).toBe(1);
		expect(countyJson.days[0].summary.activeWarningCount).toBe(1);
		expect(countyJson.days[0].summary.activeMajorCount).toBe(1);
		expect(countyJson.days[0].entries[0].alertId).toBe('alert-recent-ky');
		expect(countyJson.days[0].entries[0].countyCodes).toContain('111');

		const sevenDayRequest = new IncomingRequest(
			'https://live-weather.example/api/alerts/history?state=KY&days=7',
		);
		const sevenDayCtx = createExecutionContext();
		const sevenDayResponse = await worker.fetch(sevenDayRequest, env, sevenDayCtx);
		await waitOnExecutionContext(sevenDayCtx);
		expect(sevenDayResponse.status).toBe(200);
		const sevenDayJson = await sevenDayResponse.json() as any;
		expect(sevenDayJson.days.length).toBeGreaterThanOrEqual(2);
		expect(sevenDayJson.days[0].summary).toBeTruthy();
		expect(Array.isArray(sevenDayJson.days[0].summary.topEvents)).toBe(true);
	});

	it('falls back to county entry-derived summary counts for legacy history snapshots without county data', async () => {
		const nowMs = Date.now();
		const recentChangedAt = new Date(nowMs - 90 * 60 * 1000).toISOString();
		const day = recentChangedAt.slice(0, 10);

		await env.WEATHER_KV.put(
			'alerts:history:daily:v1',
			JSON.stringify({
				[day]: {
					day,
					updatedAt: recentChangedAt,
					snapshot: {
						activeAlertCount: 3,
						activeWarningCount: 2,
						activeMajorCount: 2,
						byState: {
							KY: {
								activeAlertCount: 2,
								activeWarningCount: 2,
								activeMajorCount: 2,
							},
						},
					},
					entries: [
						{
							alertId: 'legacy-county-alert-1',
							stateCodes: ['KY'],
							countyCodes: ['111'],
							event: 'Tornado Warning',
							areaDesc: 'Jefferson County',
							changedAt: recentChangedAt,
							changeType: 'updated',
							severity: 'Extreme',
							category: 'warning',
							isMajor: true,
							summary: 'Legacy county warning updated.',
						},
						{
							alertId: 'legacy-county-alert-2',
							stateCodes: ['KY'],
							countyCodes: ['111'],
							event: 'Flood Advisory',
							areaDesc: 'Jefferson County',
							changedAt: recentChangedAt,
							changeType: 'new',
							severity: 'Minor',
							category: 'advisory',
							isMajor: false,
							summary: 'Legacy county advisory issued.',
						},
						{
							alertId: 'legacy-other-county',
							stateCodes: ['KY'],
							countyCodes: ['005'],
							event: 'Severe Thunderstorm Warning',
							areaDesc: 'Anderson County',
							changedAt: recentChangedAt,
							changeType: 'new',
							severity: 'Severe',
							category: 'warning',
							isMajor: true,
							summary: 'Other county warning issued.',
						},
					],
				},
			}),
		);

		const request = new IncomingRequest(
			'https://live-weather.example/api/alerts/history?state=KY&countyCode=111&days=1',
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(Array.isArray(json.days)).toBe(true);
		expect(json.days.length).toBe(1);
		expect(json.days[0].summary.totalEntries).toBe(2);
		expect(json.days[0].summary.activeAlertCount).toBe(2);
		expect(json.days[0].summary.activeWarningCount).toBe(1);
		expect(json.days[0].summary.activeMajorCount).toBe(1);
		expect(json.days[0].entries.every((entry: any) => entry.countyCodes.includes('111'))).toBe(true);
	});

	it('persists daily history snapshots and prunes records outside retention', () => {
		const nowIso = new Date().toISOString();
		const nowMs = Date.parse(nowIso);
		const oldIso = new Date(nowMs - (16 * 24 * 60 * 60 * 1000)).toISOString();
		const today = nowIso.slice(0, 10);
		const oldDay = oldIso.slice(0, 10);

		const previous = {
			[oldDay]: {
				day: oldDay,
				updatedAt: oldIso,
				snapshot: {
					activeAlertCount: 0,
					activeWarningCount: 0,
					activeMajorCount: 0,
					byState: {},
				},
				entries: [
					{
						alertId: 'old-alert',
						stateCodes: ['KY'],
						countyCodes: ['111'],
						event: 'Flood Warning',
						areaDesc: 'Old County',
						changedAt: oldIso,
						changeType: 'expired',
						severity: 'Severe',
						category: 'warning',
						isMajor: true,
						summary: 'Old warning expired.',
					},
				],
			},
		} as any;

		const map = {
			'alert-current-1': {
				id: 'alert-current-1',
				properties: {
					event: 'Tornado Warning',
					severity: 'Severe',
					headline: 'Take shelter now',
					description: 'Tornado expected.',
					geocode: {
						UGC: ['KYC111'],
					},
				},
			},
		};

		const changes = [
			{
				alertId: 'alert-current-1',
				stateCodes: ['KY'],
				countyCodes: ['111'],
				event: 'Tornado Warning',
				areaDesc: 'Jefferson County',
				changedAt: nowIso,
				changeType: 'new',
				severity: 'Severe',
				category: 'warning',
				isMajor: true,
				previousExpires: null,
				nextExpires: null,
			},
		] as any[];

		const next = __testing.buildNextAlertHistoryByDay(previous, map, changes, nowIso) as any;
		expect(next[oldDay]).toBeUndefined();
		expect(next[today]).toBeTruthy();
		expect(next[today].entries.length).toBe(1);
		expect(next[today].snapshot.activeAlertCount).toBe(1);
		expect(next[today].snapshot.byState.KY.activeAlertCount).toBe(1);
		expect(next[today].snapshot.byStateCounty['KY:111'].activeAlertCount).toBe(1);
		expect(next[today].snapshot.byStateCounty['KY:111'].activeWarningCount).toBe(1);
		expect(next[today].snapshot.byStateCounty['KY:111'].activeMajorCount).toBe(1);

		const deduped = __testing.buildNextAlertHistoryByDay(next, map, changes, nowIso) as any;
		expect(deduped[today].entries.length).toBe(1);
	});

	it('builds lifecycle-aware push payloads with changeType and all-clear copy', () => {
		const groupedPayload = __testing.buildLifecyclePushMessageData('KY', [
			{
				change: {
					alertId: 'alert-1',
					stateCodes: ['KY'],
					countyCodes: ['001'],
					event: 'Tornado Warning',
					areaDesc: 'Test County',
					changedAt: '2026-03-26T12:00:00.000Z',
					changeType: 'new',
					previousExpires: null,
					nextExpires: '2026-03-26T13:00:00.000Z',
				},
				feature: {
					id: 'alert-1',
					properties: {
						event: 'Tornado Warning',
						headline: 'Take shelter now',
						areaDesc: 'Test County',
					},
				},
			},
			{
				change: {
					alertId: 'alert-2',
					stateCodes: ['KY'],
					countyCodes: ['003'],
					event: 'Flood Warning',
					areaDesc: 'River County',
					changedAt: '2026-03-26T12:10:00.000Z',
					changeType: 'updated',
					previousExpires: '2026-03-26T14:00:00.000Z',
					nextExpires: '2026-03-26T15:00:00.000Z',
				},
				feature: {
					id: 'alert-2',
					properties: {
						event: 'Flood Warning',
						headline: 'Flooding expected',
						areaDesc: 'River County',
					},
				},
			},
		]) as any;

		expect(groupedPayload.changeType).toBe('grouped');
		expect(groupedPayload.body).toContain('new');
		expect(groupedPayload.body).toContain('updated');

		const allClearPayload = __testing.buildLifecyclePushMessageData('KY', [
			{
				change: {
					alertId: 'all-clear:KY',
					stateCodes: ['KY'],
					countyCodes: [],
					event: 'All Clear',
					areaDesc: 'Kentucky',
					changedAt: '2026-03-26T13:00:00.000Z',
					changeType: 'all_clear',
					previousExpires: null,
					nextExpires: null,
				},
			},
		]) as any;

		expect(allClearPayload.changeType).toBe('all_clear');
		expect(allClearPayload.title).toContain('All clear');
	});

	it('derives structured impact categories and major flags for alert events', () => {
		expect(__testing.deriveAlertImpactCategories('Tornado Warning', '', '')).toEqual(
			expect.arrayContaining(['tornado', 'wind']),
		);
		expect(__testing.deriveAlertImpactCategories('Flood Warning', '', '')).toContain('flood');
		expect(__testing.deriveAlertImpactCategories('Winter Storm Warning', '', '')).toContain('winter');
		expect(__testing.deriveAlertImpactCategories('Heat Advisory', '', '')).toContain('heat');
		expect(__testing.deriveAlertImpactCategories('High Wind Warning', '', '')).toContain('wind');
		expect(__testing.isMajorImpactAlertEvent('Tornado Warning', 'Severe', ['tornado'])).toBe(true);
		expect(__testing.isMajorImpactAlertEvent('Wind Advisory', 'Minor', ['wind'])).toBe(false);
	});

	it('batches lifecycle entries by delivery mode and gates all-clear pushes conservatively', () => {
		const stateChanges = [
			{
				alertId: 'alert-major-expired',
				stateCodes: ['KY'],
				countyCodes: ['001'],
				event: 'Tornado Warning',
				areaDesc: 'Test County',
				changedAt: '2026-03-26T14:00:00.000Z',
				changeType: 'expired',
				previousExpires: '2026-03-26T14:00:00.000Z',
				nextExpires: null,
			},
			{
				alertId: 'all-clear:KY',
				stateCodes: ['KY'],
				countyCodes: [],
				event: 'All Clear',
				areaDesc: 'Kentucky',
				changedAt: '2026-03-26T14:05:00.000Z',
				changeType: 'all_clear',
				previousExpires: null,
				nextExpires: null,
			},
		] as any[];

		expect(__testing.shouldSendAllClearNotification(stateChanges)).toBe(true);
		expect(
			__testing.shouldSendAllClearNotification([
				{
					...stateChanges[1],
				},
			]),
		).toBe(false);

		const entries = stateChanges.map((change) => ({ change }));
		const immediateBatches = __testing.batchLifecycleEntriesForDeliveryMode('immediate', entries);
		const digestBatches = __testing.batchLifecycleEntriesForDeliveryMode('digest', entries);
		expect(immediateBatches.length).toBe(2);
		expect(digestBatches.length).toBe(1);
		expect(digestBatches[0].length).toBe(2);
	});

	it('uses county FIPS and UGC matching with text fallback for county targeting', () => {
		const sameOnlyFeature = {
			properties: {
				geocode: {
					SAME: ['21097'],
					UGC: [],
				},
				areaDesc: 'Marion County',
			},
		};
		const ugcFeature = {
			properties: {
				geocode: {
					UGC: ['KYC111'],
				},
				areaDesc: 'Jefferson County',
			},
		};
		const textOnlyFeature = {
			properties: {
				geocode: {
					UGC: [],
				},
				areaDesc: 'Summit County',
			},
		};
		const countyScope = {
			id: 'scope-ky-marion',
			label: 'Marion County KY',
			stateCode: 'KY',
			deliveryScope: 'county',
			countyName: 'Marion County',
			countyFips: '097',
			enabled: true,
			alertTypes: {
				warnings: true,
				watches: true,
				advisories: true,
				statements: true,
			},
			severeOnly: false,
		};

		expect(__testing.extractCountyFipsCodes(sameOnlyFeature)).toContain('097');
		expect(__testing.extractCountyFipsCodes(ugcFeature)).toContain('111');
		expect(__testing.alertMatchesScopeCounty(sameOnlyFeature, countyScope)).toBe(true);
		expect(
			__testing.alertMatchesScopeCounty(textOnlyFeature, {
				...countyScope,
				countyFips: null,
				countyName: 'Summit County',
				stateCode: 'OH',
			}),
		).toBe(true);
	});

	it('prefers recent hourly temp over stale obs and avoids invalid heat/wind chill logic', async () => {
		(globalThis.fetch as any).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('api.weather.gov/points/')) {
				return new Response(JSON.stringify({ properties: {
					forecast: 'https://api.weather.gov/mock_forecast',
					forecastHourly: 'https://api.weather.gov/mock_hourly',
					observationStations: 'https://api.weather.gov/mock_observations',
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_forecast') {
				return new Response(JSON.stringify({ properties: { periods: [{ name: 'Today', startTime: '2026-01-01T12:00:00Z', isDaytime: true, temperature: 60, temperatureUnit: 'F', shortForecast: 'Sunny', icon: 'sunny', windSpeed: '5 mph', windDirection: 'N', probabilityOfPrecipitation: { value: 0 } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_hourly') {
				const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
				return new Response(JSON.stringify({ properties: { periods: [{ startTime: futureStart, temperature: 60, temperatureUnit: 'F', shortForecast: 'Sunny', icon: 'sunny', windSpeed: '5 mph', windDirection: 'N', probabilityOfPrecipitation: { value: 0 } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_observations') {
				return new Response(JSON.stringify({ features: [{ properties: { stationIdentifier: 'TEST' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/stations/TEST/observations/latest')) {
				return new Response(JSON.stringify({ properties: {
					temperature: { value: 54, unitCode: 'unit:degF' },
					windChill: { value: 0, unitCode: 'unit:degC' },
					heatIndex: { value: 0, unitCode: 'unit:degC' },
					relativeHumidity: { value: 50 },
					barometricPressure: { value: 101325, unitCode: 'unit:Pa' },
					visibility: { value: 16000, unitCode: 'unit:m' },
					dewpoint: { value: 45, unitCode: 'unit:degF' },
					windSpeed: { value: 10, unitCode: 'unit:mi_h-1' },
					windDirection: { value: 180 },
					textDescription: 'Cool',
					icon: 'cool',
					timestamp: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/api/weather?lat=37.1187&lon=-82.8187');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.current.temperatureF).toBe(60);
		expect(json.current.feelsLikeF).toBe(60);
		expect(typeof json.meta?.generatedAt).toBe('string');
	});

	it('returns radar payload with normalized meta envelope', async () => {
		(globalThis.fetch as any).mockImplementation(async (input: RequestInfo) => {
			const url = String(input);
			if (url.includes('api.weather.gov/points/')) {
				return new Response(JSON.stringify({ properties: {
					forecast: 'https://api.weather.gov/mock_forecast',
					forecastHourly: 'https://api.weather.gov/mock_hourly',
					observationStations: 'https://api.weather.gov/mock_observations',
					radarStation: 'KRLX',
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_observations') {
				return new Response(JSON.stringify({ features: [{ properties: { stationIdentifier: 'TEST' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/stations/TEST/observations/latest')) {
				return new Response(JSON.stringify({ properties: {
					temperature: { value: 66, unitCode: 'unit:degF' },
					windDirection: { value: 90 },
					textDescription: 'Cloudy',
					timestamp: new Date().toISOString(),
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_forecast' || url === 'https://api.weather.gov/mock_hourly') {
				return new Response(JSON.stringify({ properties: { periods: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/api/radar?lat=37.1187&lon=-82.8187');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.station).toBeTruthy();
		expect(typeof json.meta?.generatedAt).toBe('string');
	});

	it('filters out current hour from hourly forecasts and returns next 18 hours', async () => {
		const now = new Date();
		const hourlyPeriods = Array.from({ length: 20 }, (_, index) => {
			const startTime = new Date(now.getTime() + (index - 1) * 60 * 60 * 1000).toISOString();
			return {
				startTime,
				temperature: 50 + index,
				temperatureUnit: 'F',
				shortForecast: `Test ${index}`,
				icon: 'sunny',
				windSpeed: '5 mph',
				windDirection: 'N',
				probabilityOfPrecipitation: { value: 10 },
			};
		});

		(globalThis.fetch as any).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('api.weather.gov/points/')) {
				return new Response(JSON.stringify({ properties: {
					forecast: 'https://api.weather.gov/mock_forecast',
					forecastHourly: 'https://api.weather.gov/mock_hourly',
					observationStations: 'https://api.weather.gov/mock_observations',
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_forecast') {
				return new Response(JSON.stringify({ properties: { periods: [{ name: 'Today', startTime: '2026-01-01T12:00:00Z', isDaytime: true, temperature: 60, temperatureUnit: 'F', shortForecast: 'Sunny', icon: 'sunny', windSpeed: '5 mph', windDirection: 'N', probabilityOfPrecipitation: { value: 0 } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_hourly') {
				return new Response(JSON.stringify({ properties: { periods: hourlyPeriods } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_observations') {
				return new Response(JSON.stringify({ features: [{ properties: { stationIdentifier: 'TEST' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/stations/TEST/observations/latest')) {
				return new Response(JSON.stringify({ properties: {
					temperature: { value: 54, unitCode: 'unit:degF' },
					windChill: { value: 0, unitCode: 'unit:degC' },
					heatIndex: { value: 0, unitCode: 'unit:degC' },
					relativeHumidity: { value: 50 },
					barometricPressure: { value: 101325, unitCode: 'unit:Pa' },
					visibility: { value: 16000, unitCode: 'unit:m' },
					dewpoint: { value: 45, unitCode: 'unit:degF' },
					windSpeed: { value: 10, unitCode: 'unit:mi_h-1' },
					windDirection: { value: 180 },
					textDescription: 'Cool',
					icon: 'cool',
					timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/api/weather?lat=37.1187&lon=-82.8187');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(Array.isArray(json.hourly)).toBe(true);
		expect(json.hourly.length).toBe(18);
		expect(json.hourly.some((p: any) => p.startTime === hourlyPeriods[0].startTime)).toBe(false);
		expect(json.hourly.every((p: any) => new Date(p.startTime) > now)).toBe(true);
		expect(json.hourly[0].startTime).toBe(hourlyPeriods[2].startTime);
	});

	it('uses MapClick text for daily details when it differs from api.weather.gov', async () => {
		(globalThis.fetch as any).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('api.weather.gov/points/')) {
				return new Response(JSON.stringify({ properties: {
					forecast: 'https://api.weather.gov/mock_forecast',
					forecastHourly: 'https://api.weather.gov/mock_hourly',
					observationStations: 'https://api.weather.gov/mock_observations',
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_forecast') {
				return new Response(JSON.stringify({ properties: { periods: [
					{
						name: 'Tonight',
						startTime: '2026-03-26T20:00:00-04:00',
						isDaytime: false,
						temperature: 64,
						temperatureUnit: 'F',
						shortForecast: 'Partly Cloudy',
						detailedForecast: 'Tonight baseline text.',
						icon: 'night',
						windSpeed: '9 mph',
						windDirection: 'SW',
						probabilityOfPrecipitation: { value: 2 },
					},
					{
						name: 'Friday',
						startTime: '2026-03-27T06:00:00-04:00',
						isDaytime: true,
						temperature: 66,
						temperatureUnit: 'F',
						shortForecast: 'Rain Showers',
						detailedForecast: 'Rain showers after 9am. Baseline text.',
						icon: 'day-rain',
						windSpeed: '7 mph',
						windDirection: 'NW',
						probabilityOfPrecipitation: { value: 91 },
					},
					{
						name: 'Friday Night',
						startTime: '2026-03-27T18:00:00-04:00',
						isDaytime: false,
						temperature: 28,
						temperatureUnit: 'F',
						shortForecast: 'Chance Rain Showers then Widespread Frost',
						detailedForecast: 'Night baseline text.',
						icon: 'night-rain',
						windSpeed: '7 mph',
						windDirection: 'N',
						probabilityOfPrecipitation: { value: 30 },
					},
				] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_hourly') {
				const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
				return new Response(JSON.stringify({ properties: { periods: [
					{
						startTime: futureStart,
						temperature: 66,
						temperatureUnit: 'F',
						shortForecast: 'Cloudy',
						icon: 'cloudy',
						windSpeed: '6 mph',
						windDirection: 'SW',
						probabilityOfPrecipitation: { value: 5 },
					},
				] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://api.weather.gov/mock_observations') {
				return new Response(JSON.stringify({ features: [{ properties: { stationIdentifier: 'TEST' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('/stations/TEST/observations/latest')) {
				return new Response(JSON.stringify({ properties: {
					temperature: { value: 66, unitCode: 'unit:degF' },
					relativeHumidity: { value: 55 },
					barometricPressure: { value: 101000, unitCode: 'unit:Pa' },
					visibility: { value: 16000, unitCode: 'unit:m' },
					dewpoint: { value: 52, unitCode: 'unit:degF' },
					windSpeed: { value: 6, unitCode: 'unit:mi_h-1' },
					windDirection: { value: 210 },
					textDescription: 'Cloudy',
					icon: 'cloudy',
					timestamp: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
				} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://forecast.weather.gov/MapClick.php')) {
				return new Response(JSON.stringify({
					time: {
						startPeriodName: ['Tonight', 'Friday', 'Friday Night'],
						startValidTime: [
							'2026-03-26T20:00:00-04:00',
							'2026-03-27T06:00:00-04:00',
							'2026-03-27T18:00:00-04:00',
						],
					},
					data: {
						weather: ['Partly Cloudy', 'Chance Showers then Showers', 'Chance Showers then Frost'],
						text: [
							'Tonight mapclick text.',
							'Showers, mainly after 1pm. Temperature falling to around 52 by 5pm.',
							'Friday night mapclick text.',
						],
						pop: [null, '90', '30'],
						iconLink: ['icon-tonight', 'icon-friday', 'icon-friday-night'],
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/api/weather?lat=37.17&lon=-83.31');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.daily[0].detailedForecast).toContain('mainly after 1pm');
		expect(json.daily[0].detailedForecast).not.toContain('after 9am');
		expect(json.daily[0].shortForecast).toBe('Chance Showers then Showers');
		expect(json.daily[0].nightShortForecast).toBe('Chance Showers then Frost');
		expect(json.daily[0].nightDetailedForecast).toContain('Friday night mapclick text.');
	});

	it('posts a single alert to Facebook via /admin/post when authenticated', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword', FB_PAGE_ID: '1097328350123101', FB_PAGE_ACCESS_TOKEN: 'dummy-token' };
		const loginResp = await worker.fetch(
			new IncomingRequest('https://live-weather.example/admin/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ password: 'testpassword' }).toString(),
			}),
			goodEnv as any,
			createExecutionContext(),
		);
		const cookie = loginResp.headers.get('set-cookie') || '';

		const postBody = new URLSearchParams({ action: 'post_alert', alertId: 'alert-1' }).toString();
		const request = new IncomingRequest('https://live-weather.example/admin/post', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
			body: postBody,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.results[0].status).toBe('posted');
		expect((globalThis.fetch as any).mock.calls.some(([input]) => String(input).includes('/photos'))).toBe(true);
	});

	it('subscribes with multi-scope prefs and writes state indexes', async () => {
		const pushEnv = {
			...env,
			VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: 'mailto:test@example.com',
		};

		const request = new IncomingRequest('https://live-weather.example/api/push/subscribe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				subscription: TEST_PUSH_SUBSCRIPTION,
				prefs: {
					scopes: [
						{
							id: 'scope-ky',
							label: 'Kentucky',
							stateCode: 'KY',
							deliveryScope: 'state',
							enabled: true,
							alertTypes: {
								warnings: true,
								watches: true,
								advisories: false,
								statements: true,
							},
							severeOnly: false,
						},
						{
							id: 'scope-oh-county',
							label: 'Summit County OH',
							stateCode: 'OH',
							deliveryScope: 'county',
							countyName: 'Summit County',
							countyFips: '153',
							enabled: true,
							alertTypes: {
								warnings: true,
								watches: true,
								advisories: false,
								statements: false,
							},
							severeOnly: true,
						},
					],
					quietHours: {
						enabled: true,
						start: '23:00',
						end: '06:00',
					},
					deliveryMode: 'immediate',
				},
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, pushEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const payload = await response.json() as any;
		expect(payload.ok).toBe(true);
		expect(payload.subscriptionId).toBeTruthy();
		expect(payload.indexedStateCodes).toEqual(expect.arrayContaining(['KY', 'OH']));
		expect(payload.prefs.scopes.length).toBe(2);

		const stateKyIndex = await pushEnv.WEATHER_KV.get('push:index:state:KY');
		const stateOhIndex = await pushEnv.WEATHER_KV.get('push:index:state:OH');
		expect(JSON.parse(stateKyIndex || '[]')).toContain(payload.subscriptionId);
		expect(JSON.parse(stateOhIndex || '[]')).toContain(payload.subscriptionId);
	});

	it('migrates legacy push records on subscribe update and keeps unsubscribe compatible', async () => {
		const pushEnv = {
			...env,
			VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: 'mailto:test@example.com',
		};
		const subscriptionId = await sha256Hex(TEST_PUSH_SUBSCRIPTION.endpoint);

		await pushEnv.WEATHER_KV.put(
			`push:sub:${subscriptionId}`,
			JSON.stringify({
				id: subscriptionId,
				endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
				stateCode: 'IN',
				subscription: TEST_PUSH_SUBSCRIPTION,
				prefs: {
					stateCode: 'IN',
					deliveryScope: 'county',
					countyName: 'Marion County',
					countyFips: '097',
					alertTypes: {
						warnings: true,
						watches: true,
						advisories: false,
						statements: true,
					},
					quietHours: {
						enabled: true,
						start: '22:00',
						end: '05:00',
					},
				},
				createdAt: '2026-03-20T00:00:00.000Z',
				updatedAt: '2026-03-20T00:00:00.000Z',
			}),
		);
		await pushEnv.WEATHER_KV.put('push:index:state:IN', JSON.stringify([subscriptionId]));
		// Simulate an orphaned stale index entry from older write behavior.
		await pushEnv.WEATHER_KV.put('push:index:state:OH', JSON.stringify([subscriptionId]));

		const updateRequest = new IncomingRequest('https://live-weather.example/api/push/subscribe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				subscription: TEST_PUSH_SUBSCRIPTION,
				prefs: {
					scopes: [
						{
							id: 'scope-ky-only',
							label: 'Kentucky',
							stateCode: 'KY',
							deliveryScope: 'state',
							enabled: true,
							alertTypes: {
								warnings: true,
								watches: true,
								advisories: false,
								statements: true,
							},
							severeOnly: false,
						},
					],
					quietHours: {
						enabled: false,
						start: '22:00',
						end: '06:00',
					},
					deliveryMode: 'immediate',
				},
			}),
		});

		const updateCtx = createExecutionContext();
		const updateResponse = await worker.fetch(updateRequest, pushEnv as any, updateCtx);
		await waitOnExecutionContext(updateCtx);
		expect(updateResponse.status).toBe(200);

		const updatePayload = await updateResponse.json() as any;
		expect(updatePayload.subscriptionId).toBe(subscriptionId);
		expect(updatePayload.indexedStateCodes).toEqual(['KY']);

		const storedRecordRaw = await pushEnv.WEATHER_KV.get(`push:sub:${subscriptionId}`);
		expect(storedRecordRaw).toBeTruthy();
		const storedRecord = JSON.parse(storedRecordRaw || '{}');
		expect(storedRecord.stateCode).toBeUndefined();
		expect(Array.isArray(storedRecord.prefs?.scopes)).toBe(true);
		expect(storedRecord.indexedStateCodes).toEqual(['KY']);

		const legacyIndexRaw = await pushEnv.WEATHER_KV.get('push:index:state:IN');
		expect(legacyIndexRaw === null || !JSON.parse(legacyIndexRaw).includes(subscriptionId)).toBe(true);
		const staleOhIndexRaw = await pushEnv.WEATHER_KV.get('push:index:state:OH');
		expect(staleOhIndexRaw === null || !JSON.parse(staleOhIndexRaw).includes(subscriptionId)).toBe(true);

		const unsubscribeRequest = new IncomingRequest('https://live-weather.example/api/push/unsubscribe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				endpoint: TEST_PUSH_SUBSCRIPTION.endpoint,
			}),
		});
		const unsubscribeCtx = createExecutionContext();
		const unsubscribeResponse = await worker.fetch(unsubscribeRequest, pushEnv as any, unsubscribeCtx);
		await waitOnExecutionContext(unsubscribeCtx);
		expect(unsubscribeResponse.status).toBe(200);
		const unsubscribePayload = await unsubscribeResponse.json() as any;
		expect(unsubscribePayload.ok).toBe(true);
		expect(unsubscribePayload.removed).toBe(true);
		expect(await pushEnv.WEATHER_KV.get(`push:sub:${subscriptionId}`)).toBeNull();
	});

	it('validates and sends POST /api/push/test', async () => {
		const missingConfigCtx = createExecutionContext();
		const missingConfigResponse = await worker.fetch(
			new IncomingRequest('https://live-weather.example/api/push/test', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subscription: TEST_PUSH_SUBSCRIPTION }),
			}),
			env,
			missingConfigCtx,
		);
		await waitOnExecutionContext(missingConfigCtx);
		expect(missingConfigResponse.status).toBe(503);

		const pushEnv = {
			...env,
			VAPID_PUBLIC_KEY: TEST_VAPID_PUBLIC_KEY,
			VAPID_PRIVATE_KEY: TEST_VAPID_PRIVATE_KEY,
			VAPID_SUBJECT: 'mailto:test@example.com',
		};

		const invalidRequest = new IncomingRequest('https://live-weather.example/api/push/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ subscription: { endpoint: '' } }),
		});
		const invalidCtx = createExecutionContext();
		const invalidResponse = await worker.fetch(invalidRequest, pushEnv as any, invalidCtx);
		await waitOnExecutionContext(invalidCtx);
		expect(invalidResponse.status).toBe(400);

		const request = new IncomingRequest('https://live-weather.example/api/push/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				subscription: TEST_PUSH_SUBSCRIPTION,
				prefs: {
					scopes: [
						{
							id: 'scope-ky',
							label: 'Kentucky',
							stateCode: 'KY',
							deliveryScope: 'state',
							enabled: true,
							alertTypes: {
								warnings: true,
								watches: true,
								advisories: false,
								statements: true,
							},
							severeOnly: false,
						},
					],
					quietHours: {
						enabled: false,
						start: '22:00',
						end: '06:00',
					},
					deliveryMode: 'immediate',
				},
			}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, pushEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const payload = await response.json() as any;
		expect(payload.ok).toBe(true);
		expect((globalThis.fetch as any).mock.calls.some(([input]) => String(input).startsWith('https://push.example/'))).toBe(true);
	});

	it('falls back to canonical special-weather-statement slug when input is corrupted', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword', FB_PAGE_ID: '1097328350123101', FB_PAGE_ACCESS_TOKEN: 'dummy-token' };
		sampleAlerts.features[0].properties.event = 'pecial Weather Tatement';
		sampleAlerts.features[0].properties.geocode = { UGC: ['FLZ001'] };

		(globalThis.fetch as any).mockImplementation(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('api.weather.gov/alerts/active')) {
				return new Response(JSON.stringify(sampleAlerts), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://live-weather.example/images/') || url.startsWith('https://live-weather.example/florida/')) {
				if (init?.method === 'HEAD') {
					if (url.endsWith('/images/florida/pecialweather-tatement-florida.jpg') || url.endsWith('/florida/pecialweather-tatement-florida.jpg')) {
						return new Response('', { status: 404 });
					}
					if (url.endsWith('/images/florida/special-weather-statement-florida.jpg') || url.endsWith('/florida/special-weather-statement-florida.jpg')) {
						return new Response('', { status: 200 });
					}
					return new Response('', { status: 404 });
				}
				return new Response('', { status: 200 });
			}
			if (url.includes('graph.facebook.com')) {
				if (url.includes('/photos')) {
					return new Response(JSON.stringify({ id: '12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				if (url.includes('/feed')) {
					return new Response(JSON.stringify({ id: '12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
			}
			return new Response('not found', { status: 404 });
		});

		const loginResp = await worker.fetch(
			new IncomingRequest('https://live-weather.example/admin/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ password: 'testpassword' }).toString(),
			}),
			goodEnv as any,
			createExecutionContext(),
		);
		const cookie = loginResp.headers.get('set-cookie') || '';

		const postBody = new URLSearchParams({ action: 'post_alert', alertId: 'alert-1' }).toString();
		const request = new IncomingRequest('https://live-weather.example/admin/post', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
			body: postBody,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.results[0].status).toBe('posted');
		expect((globalThis.fetch as any).mock.calls.some(([input]) => String(input).includes('/images/florida/special-weather-statement-florida.jpg'))).toBe(true);
	});
});
