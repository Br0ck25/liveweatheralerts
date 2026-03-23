import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

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
