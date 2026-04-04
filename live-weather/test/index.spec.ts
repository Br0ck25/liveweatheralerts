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
				geometry: {
					type: 'Polygon',
					coordinates: [[
						[-83.35, 37.12],
						[-83.2, 37.12],
						[-83.2, 37.22],
						[-83.35, 37.22],
						[-83.35, 37.12],
					]],
				},
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
			if (
				url.startsWith('https://live-weather.example/images/')
				|| url.startsWith('https://live-weather.example/virginia/')
				|| url.startsWith('https://live-weather.example/advisory/')
				|| url.startsWith('https://liveweatheralerts.com/images/')
				|| url.startsWith('https://liveweatheralerts.com/virginia/')
				|| url.startsWith('https://liveweatheralerts.com/advisory/')
			) {
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
				if (url.includes('/comments')) {
					return new Response(JSON.stringify({ id: 'comment-12345' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
		expect(body).toContain('ADMIN_PASSWORD');

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
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Secure');
		expect(cookie).not.toContain('testpassword');

		const sessionToken = cookie?.match(/admin_session=([^;]+)/)?.[1];
		expect(sessionToken).toBeTruthy();
		expect(await goodEnv.WEATHER_KV.get(`admin:session:${decodeURIComponent(sessionToken || '')}`)).not.toBeNull();

		const authRequest = new IncomingRequest('https://live-weather.example/admin', {
			headers: { Cookie: cookie || '' },
		});
		response = await worker.fetch(authRequest, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('Live Weather Alerts Admin');
		expect(body).toContain('Tornado Warning');
		expect(body).toContain('autoPostMode');
		expect(body).toContain('data-admin-panel-btn="facebook-auto-post"');
		expect(body).toContain('data-admin-panel-btn="facebook-tokens"');
		expect(body).toContain('data-admin-panel="facebook-auto-post"');
		expect(body).toContain('data-admin-panel="facebook-tokens"');
		expect(body).toContain('Facebook Post');
		expect(body).toContain('Facebook Post Ranking');
		expect(body).toContain('Priority is a relative ranking number');
		expect(body).toContain('Forecast Center');
		expect(body).toContain('NWS Discussions');
		expect(body).toContain('Convective Outlook');
		expect(body).toContain('3-Day USA Summary');
		expect(body).toContain('liveWeatherAdminFilters:v1');

		const alertsPanelMatch = body.match(/<div class="admin-page-panel is-active" data-admin-panel="alerts">([\s\S]*?)<div class="admin-page-panel" data-admin-panel="facebook-auto-post">/);
		expect(alertsPanelMatch?.[1]).toBeTruthy();
		expect(alertsPanelMatch?.[1]).not.toContain('autoPostMode');
		expect(alertsPanelMatch?.[1]).not.toContain('tokenAppId');
	});

	it('returns regional admin forecast data and a 3-day USA summary when authenticated', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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

		const citiesByZip = {
			'10001': { label: 'New York City', state: 'NY', lat: 40.7506, lon: -73.9972, county: 'New York', fips: '061', zone: 'NYZ072', timeZone: 'America/New_York' },
			'30303': { label: 'Atlanta', state: 'GA', lat: 33.7529, lon: -84.3925, county: 'Fulton', fips: '121', zone: 'GAZ025', timeZone: 'America/New_York' },
			'60601': { label: 'Chicago', state: 'IL', lat: 41.8864, lon: -87.6186, county: 'Cook', fips: '031', zone: 'ILZ014', timeZone: 'America/Chicago' },
			'75201': { label: 'Dallas', state: 'TX', lat: 32.7877, lon: -96.7997, county: 'Dallas', fips: '113', zone: 'TXZ102', timeZone: 'America/Chicago' },
			'80202': { label: 'Denver', state: 'CO', lat: 39.7528, lon: -104.9992, county: 'Denver', fips: '031', zone: 'COZ040', timeZone: 'America/Denver' },
		} as const;

		const pointKeyToZip = new Map(
			Object.entries(citiesByZip).map(([zip, city]) => [`${city.lat.toFixed(4)},${city.lon.toFixed(4)}`, zip]),
		);

		(globalThis as any).fetch = vi.fn(async (input: RequestInfo) => {
			const url = String(input);
			if (url.startsWith('https://api.zippopotam.us/us/')) {
				const zip = url.split('/').pop() || '';
				const city = citiesByZip[zip as keyof typeof citiesByZip];
				if (!city) return new Response('not found', { status: 404 });
				return new Response(JSON.stringify({
					'post code': zip,
					country: 'United States',
					places: [{
						'place name': city.label,
						'state abbreviation': city.state,
						latitude: String(city.lat),
						longitude: String(city.lon),
					}],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://geo.fcc.gov/api/census/block/find')) {
				const parsed = new URL(url);
				const lat = Number(parsed.searchParams.get('latitude'));
				const lon = Number(parsed.searchParams.get('longitude'));
				const zip = pointKeyToZip.get(`${lat.toFixed(4)},${lon.toFixed(4)}`) || '10001';
				const city = citiesByZip[zip as keyof typeof citiesByZip];
				return new Response(JSON.stringify({
					County: {
						name: city.county,
						FIPS: city.fips,
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://api.weather.gov/points/')) {
				const pointMatch = url.match(/points\/(-?\d+\.\d+),(-?\d+\.\d+)/);
				const pointKey = pointMatch ? `${Number(pointMatch[1]).toFixed(4)},${Number(pointMatch[2]).toFixed(4)}` : '';
				const zip = pointKeyToZip.get(pointKey) || '10001';
				const city = citiesByZip[zip as keyof typeof citiesByZip];
				return new Response(JSON.stringify({
					properties: {
						relativeLocation: {
							properties: {
								city: city.label,
								state: city.state,
							},
						},
						timeZone: city.timeZone,
						gridId: city.state,
						gridX: 1,
						gridY: 1,
						forecast: `https://weather.example/${zip}/forecast`,
						forecastHourly: `https://weather.example/${zip}/hourly`,
						observationStations: `https://weather.example/${zip}/stations`,
						forecastZone: `https://api.weather.gov/zones/forecast/${city.zone}`,
						radarStation: `K${zip.slice(0, 3)}`,
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://weather.example/')) {
				const match = url.match(/weather\.example\/(\d{5})\/(forecast|hourly|stations)/);
				const zip = match?.[1] || '10001';
				const endpoint = match?.[2] || 'forecast';
				const city = citiesByZip[zip as keyof typeof citiesByZip];
				if (endpoint === 'stations') {
					return new Response(JSON.stringify({
						features: [{
							properties: { stationIdentifier: `K${zip}` },
							geometry: { coordinates: [city.lon, city.lat] },
						}],
					}), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				if (endpoint === 'hourly') {
					return new Response(JSON.stringify({
						properties: {
							periods: [{
								startTime: '2026-03-30T13:00:00-04:00',
								temperature: 68,
								temperatureUnit: 'F',
								shortForecast: `${city.label} Hourly`,
								windSpeed: '10 mph',
								windDirection: 'SW',
								probabilityOfPrecipitation: { value: 20 },
							}],
						},
					}), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return new Response(JSON.stringify({
					properties: {
						periods: [
							{ name: 'Today', isDaytime: true, temperature: 72, temperatureUnit: 'F', shortForecast: `${city.label} Sunshine`, detailedForecast: `${city.label} will stay mostly sunny and mild.`, windSpeed: '10 mph', windDirection: 'SW', probabilityOfPrecipitation: { value: 10 }, startTime: '2026-03-30T13:00:00-04:00', endTime: '2026-03-30T19:00:00-04:00', icon: 'https://example.com/day.png' },
							{ name: 'Tonight', isDaytime: false, temperature: 55, temperatureUnit: 'F', shortForecast: 'Partly Cloudy', detailedForecast: `A quiet night settles over ${city.label}.`, windSpeed: '8 mph', windDirection: 'SW', probabilityOfPrecipitation: { value: 15 }, startTime: '2026-03-30T19:00:00-04:00', endTime: '2026-03-31T07:00:00-04:00', icon: 'https://example.com/night.png' },
							{ name: 'Tuesday', isDaytime: true, temperature: 76, temperatureUnit: 'F', shortForecast: 'Warm and Breezy', detailedForecast: `${city.label} turns warmer with a few passing clouds.`, windSpeed: '12 mph', windDirection: 'SW', probabilityOfPrecipitation: { value: 20 }, startTime: '2026-03-31T07:00:00-04:00', endTime: '2026-03-31T19:00:00-04:00', icon: 'https://example.com/day2.png' },
							{ name: 'Tuesday Night', isDaytime: false, temperature: 57, temperatureUnit: 'F', shortForecast: 'Chance Showers', detailedForecast: `A few showers are possible around ${city.label} overnight.`, windSpeed: '9 mph', windDirection: 'S', probabilityOfPrecipitation: { value: 40 }, startTime: '2026-03-31T19:00:00-04:00', endTime: '2026-04-01T07:00:00-04:00', icon: 'https://example.com/night2.png' },
							{ name: 'Wednesday', isDaytime: true, temperature: 74, temperatureUnit: 'F', shortForecast: 'Scattered Showers', detailedForecast: `${city.label} keeps a few scattered showers through the afternoon.`, windSpeed: '11 mph', windDirection: 'W', probabilityOfPrecipitation: { value: 50 }, startTime: '2026-04-01T07:00:00-04:00', endTime: '2026-04-01T19:00:00-04:00', icon: 'https://example.com/day3.png' },
							{ name: 'Wednesday Night', isDaytime: false, temperature: 53, temperatureUnit: 'F', shortForecast: 'Clearing Late', detailedForecast: `${city.label} dries out overnight with cooler air moving in.`, windSpeed: '7 mph', windDirection: 'NW', probabilityOfPrecipitation: { value: 20 }, startTime: '2026-04-01T19:00:00-04:00', endTime: '2026-04-02T07:00:00-04:00', icon: 'https://example.com/night3.png' },
						],
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://api.weather.gov/stations/K')) {
				return new Response(JSON.stringify({
					properties: {
						timestamp: new Date().toISOString(),
						textDescription: 'Clear',
						temperature: { value: 20, unitCode: 'wmoUnit:degC' },
						dewpoint: { value: 10, unitCode: 'wmoUnit:degC' },
						relativeHumidity: { value: 55, unitCode: 'wmoUnit:percent' },
						windSpeed: { value: 4, unitCode: 'wmoUnit:m_s-1' },
						windDirection: { value: 225, unitCode: 'wmoUnit:degree_(angle)' },
						visibility: { value: 16093, unitCode: 'wmoUnit:m' },
						barometricPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.startsWith('https://forecast.weather.gov/MapClick.php')) {
				return new Response('not found', { status: 404 });
			}
			if (url.startsWith('https://api.sunrise-sunset.org/json')) {
				return new Response(JSON.stringify({
					status: 'OK',
					tzid: 'UTC',
					results: {
						sunrise: '2026-03-30T11:00:00+00:00',
						sunset: '2026-03-30T23:00:00+00:00',
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/admin/forecast-data', {
			headers: { Cookie: cookie },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.cities).toHaveLength(5);
		expect(json.cities.map((city: any) => city.label)).toEqual([
			'New York City',
			'Atlanta',
			'Chicago',
			'Dallas',
			'Denver',
		]);
		expect(json.summaryTitle).toBe('3-Day USA Forecast');
		expect(json.summaryText).toContain('New York City (Northeast)');
		expect(json.summaryText).toContain('Denver (West)');
		expect(Array.isArray(json.cities[0].periods)).toBe(true);
		expect(json.cities[0].periods.length).toBeGreaterThanOrEqual(6);
	});

	it('returns NWS discussion data for the admin discussion hub when authenticated', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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

		const offices = [
			{ id: 'nyc', label: 'New York City', office: 'OKX', cityCode: 'KOKX', issued: '2026-03-30T08:58:00-04:00' },
			{ id: 'atlanta', label: 'Atlanta', office: 'FFC', cityCode: 'KFFC', issued: '2026-03-30T08:12:00-04:00' },
			{ id: 'chicago', label: 'Chicago', office: 'LOT', cityCode: 'KLOT', issued: '2026-03-30T07:45:00-05:00' },
			{ id: 'dallas', label: 'Dallas', office: 'FWD', cityCode: 'KFWD', issued: '2026-03-30T07:20:00-05:00' },
			{ id: 'denver', label: 'Denver', office: 'BOU', cityCode: 'KBOU', issued: '2026-03-30T06:40:00-06:00' },
		] as const;

		(globalThis as any).fetch = vi.fn(async (input: RequestInfo) => {
			const url = String(input);
			const productListMatch = url.match(/api\.weather\.gov\/products\/types\/AFD\/locations\/([A-Z]{3})$/);
			if (productListMatch) {
				const officeCode = productListMatch[1];
				const office = offices.find((entry) => entry.office === officeCode);
				if (!office) return new Response('not found', { status: 404 });
				return new Response(JSON.stringify({
					'@graph': [
						{
							id: `afd-${office.id}-1`,
							'@id': `https://api.weather.gov/products/afd-${office.id}-1`,
							productCode: 'AFD',
							productName: 'Area Forecast Discussion',
							issuanceTime: office.issued,
						},
					],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}

			const productMatch = url.match(/api\.weather\.gov\/products\/(afd-[a-z-]+-\d+)$/);
			if (productMatch) {
				const productId = productMatch[1];
				const office = offices.find((entry) => productId.startsWith(`afd-${entry.id}-`));
				if (!office) return new Response('not found', { status: 404 });
				return new Response(JSON.stringify({
					id: productId,
					'@id': `https://api.weather.gov/products/${productId}`,
					productCode: 'AFD',
					productName: 'Area Forecast Discussion',
					issuanceTime: office.issued,
					productText: [
						'000',
						`FXUS63 ${office.cityCode} 301258`,
						`AFD${office.office}`,
						'',
						'AREA FORECAST DISCUSSION',
						`National Weather Service ${office.label}`,
						'',
						'.KEY MESSAGES...',
						`- ${office.label} stays active with changing spring weather.`,
					].join('\n'),
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}

			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/admin/discussions-data', {
			headers: { Cookie: cookie },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.cities).toHaveLength(5);
		expect(json.cities.map((city: any) => city.label)).toEqual([
			'New York City',
			'Atlanta',
			'Chicago',
			'Dallas',
			'Denver',
		]);
		expect(json.cities[0].discussionCount).toBe(1);
		expect(json.cities[0].discussions[0].title).toBe('Area Forecast Discussion');
		expect(json.cities[0].discussions[0].productText).toContain('AREA FORECAST DISCUSSION');
		expect(json.cities[0].discussions[0].facebookText).toContain('NWS Discussion: New York City');
	});

	it('returns SPC day 1, 2, and 3 convective outlook data when authenticated', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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

		const pages = {
			'https://www.spc.noaa.gov/products/outlook/day1otlk.html': {
				tab: 'otlk_1630',
				title: 'Storm Prediction Center Mar 30, 2026 1630 UTC Day 1 Convective Outlook',
				updated: 'Mon Mar 30 16:13:16 UTC 2026',
				discussion: [
					'SPC AC 301613',
					'',
					'Day 1 Convective Outlook',
					'NWS Storm Prediction Center Norman OK',
					'1113 AM CDT Mon Mar 30 2026',
					'',
					'Valid 301630Z - 311200Z',
					'',
					'...SUMMARY...',
					'A few severe thunderstorms are possible across the middle Mississippi Valley tonight.',
					'',
					'...IA to Lower MI...',
				].join('\n'),
			},
			'https://www.spc.noaa.gov/products/outlook/day2otlk.html': {
				tab: 'otlk_0600',
				title: 'Storm Prediction Center Mar 30, 2026 0600 UTC Day 2 Convective Outlook',
				updated: 'Mon Mar 30 06:02:03 UTC 2026',
				discussion: [
					'SPC AC 300602',
					'',
					'Day 2 Convective Outlook',
					'NWS Storm Prediction Center Norman OK',
					'0102 AM CDT Mon Mar 30 2026',
					'',
					'Valid 311200Z - 011200Z',
					'',
					'...SUMMARY...',
					'Severe thunderstorms remain possible from Iowa into Lower Michigan.',
					'',
					'...Synopsis...',
				].join('\n'),
			},
			'https://www.spc.noaa.gov/products/outlook/day3otlk.html': {
				tab: 'otlk_0730',
				title: 'Storm Prediction Center Mar 30, 2026 0730 UTC Day 3 Convective Outlook',
				updated: 'Mon Mar 30 11:10:23 UTC 2026',
				discussion: [
					'SPC AC 301110',
					'',
					'Day 3 Convective Outlook CORR 1',
					'NWS Storm Prediction Center Norman OK',
					'0610 AM CDT Mon Mar 30 2026',
					'',
					'Valid 011200Z - 021200Z',
					'',
					'...SUMMARY...',
					'Organized severe thunderstorms could develop across parts of the Plains.',
					'',
					'...Plains...',
				].join('\n'),
			},
		} as const;

		(globalThis as any).fetch = vi.fn(async (input: RequestInfo) => {
			const url = String(input);
			const page = pages[url as keyof typeof pages];
			if (page) {
				return new Response([
					'<html>',
					'<head>',
					`<title>${page.title}</title>`,
					'</head>',
					`<body onload="changeOverlay(); updateCookies(); show_tab('${page.tab}')">`,
					`<div>Updated:&nbsp;${page.updated}&nbsp;(<a href="#">Print Version</a>)</div>`,
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					`<pre>${page.discussion}</pre>`,
					'</body>',
					'</html>',
				].join(''), {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			}

			return new Response('not found', { status: 404 });
		});

		const request = new IncomingRequest('https://live-weather.example/admin/convective-outlook-data', {
			headers: { Cookie: cookie },
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.days).toHaveLength(3);
		expect(json.days.map((day: any) => day.id)).toEqual(['day1', 'day2', 'day3']);
		expect(json.days[0].title).toBe('Day 1 Convective Outlook');
		expect(json.days[0].summary).toContain('middle Mississippi Valley');
		expect(json.days[0].imageUrl).toBe('https://www.spc.noaa.gov/products/outlook/day1otlk_1630.png');
		expect(json.days[1].imageUrl).toBe('https://www.spc.noaa.gov/products/outlook/day2otlk_0600.png');
		expect(json.days[2].imageUrl).toBe('https://www.spc.noaa.gov/products/outlook/day3otlk_0730.png');
		expect(json.days[2].facebookText).toContain('Day 3 Convective Outlook CORR 1');
	});

	it('fails closed when ADMIN_PASSWORD is missing', async () => {
		const loginRequest = new IncomingRequest('https://live-weather.example/admin/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ password: 'liveweather' }).toString(),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(loginRequest, env, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.text();
		expect(response.status).toBe(503);
		expect(body).toContain('ADMIN_PASSWORD');
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('rejects forged admin cookies that mirror the password', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
		const request = new IncomingRequest('https://live-weather.example/admin/post', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Cookie: 'admin_session=LWAUTH%3Atestpassword',
			},
			body: new URLSearchParams({ action: 'post_alert', alertId: 'alert-1' }).toString(),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('serves the built React app shell at the public routes', async () => {
		for (const pathname of ['/', '/live-weather-alerts']) {
			const request = new IncomingRequest(`https://live-weather.example${pathname}`);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			const body = await response.text();
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/html');
			expect(body).toContain('<title>Live Weather Alerts</title>');
			expect(body).toContain('<div id="root"></div>');
			expect(body).toContain('<link rel="manifest" href="/manifest.json" />');
			expect(body).toContain('<script type="module" crossorigin src="/assets/');
			expect(body).not.toContain('What this means');
			expect(body).not.toContain('id="stateFilter"');
		}
	});

	it('uses liveweatheralerts.com in generated post text and strips the footer link from comment text', () => {
		const postText = __testing.alertToText(sampleAlerts.features[0].properties);
		expect(postText).toContain('https://liveweatheralerts.com');
		expect(postText).not.toContain('localkynews.com');

		const commentText = __testing.buildCommentText(`${postText}\nhttps://example.com/`);
		expect(commentText).not.toContain('https://liveweatheralerts.com');
		expect(commentText).not.toContain('https://example.com/');
		expect(commentText).not.toContain('#weatheralert');
	});

	it('reflows wrapped prose in alert text while preserving impacted-location blocks', () => {
		const postText = __testing.alertToText({
			event: 'Severe Thunderstorm Warning',
			areaDesc: 'Cook, IL; Will, IL',
			severity: 'Severe',
			expires: '2026-03-31T10:30:00-05:00',
			headline: 'Severe Thunderstorm Warning issued March 31 at 9:54AM CDT until March 31 at 10:30AM CDT by NWS Chicago IL',
			description: [
				'At 9:53 AM CDT, severe thunderstorms were located over New Lenox,',
				'Frankford, and Matteson, moving east at 30 to 50 mph.',
				'',
				'HAZARD...60 mph wind gusts and quarter size hail.',
				'',
				'SOURCE...Radar indicated.',
				'',
				'IMPACT...Hail damage to vehicles is expected. Expect wind damage to',
				'roofs, siding, and trees.',
				'',
				'Locations impacted include...',
				'Orland Park, Tinley Park, Calumet City, Chicago Heights, Lansing, Oak',
				'Forest, Harvey, Blue Island, Dolton, Park Forest, Homewood, Matteson,',
				'Mokena, Frankfort, Steger, Peotone, South Holland, Country Club',
				'Hills, Midlothian, Hazel Crest, Richton Park, Riverdale, Markham,',
				'Crestwood, and Sauk Village.',
			].join('\n'),
			instruction: 'For your protection move to an interior room on the lowest floor of a\nbuilding.',
		});

		expect(postText).toContain(
			'At 9:53 AM CDT, severe thunderstorms were located over New Lenox, Frankford, and Matteson, moving east at 30 to 50 mph.',
		);
		expect(postText).toContain(
			'IMPACT: Hail damage to vehicles is expected. Expect wind damage to roofs, siding, and trees.',
		);
		expect(postText).toContain(
			'For your protection move to an interior room on the lowest floor of a building.',
		);
		expect(postText).toContain(
			'Locations impacted include:\nOrland Park, Tinley Park, Calumet City, Chicago Heights, Lansing, Oak\nForest',
		);
	});

	it('preserves sentence-level paragraph breaks in flood watch text while reflowing bullet details', () => {
		const postText = __testing.alertToText({
			event: 'Flood Watch',
			areaDesc: 'Niagara; Orleans; Monroe; Wayne; Northern Cayuga; Northern Erie; Genesee; Wyoming; Livingston; Ontario; Chautauqua; Cattaraugus; Allegany; Southern Erie',
			severity: 'Severe',
			expires: '2026-04-01T03:00:00-04:00',
			headline: 'Flood Watch issued March 31 at 1:44PM EDT until April 1 at 8:00PM EDT by NWS Buffalo NY',
			description: [
				'Heavy rain may fall on a deep primed snowpack leading to the melt increasing.',
				'Flows in rivers may increase quickly and reach critical levels.',
				'',
				'WHAT...Flooding caused by excessive rainfall continues to be possible.',
				'',
				'WHERE...Portions of western New York and the northern Finger Lakes Region.',
				'',
				'WHEN...Through Wednesday evening.',
				'',
				'IMPACTS...Excessive runoff may result in flooding of rivers, creeks, streams, and other low-lying and flood-prone locations. Area creeks and streams are running high and could flood with more heavy rain.',
				'',
				'ADDITIONAL DETAILS...',
				'- Multiple rounds of showers and embedded thunderstorms',
				'continue through tonight which may result in 1" to 1.5", with',
				'localized amounts of 2" if thunderstorms repeat over the same',
				'area. Excess runoff from this rainfall may cause area',
				'waterways to reach or exceed bankfull stage. General flooding',
				'away from area waterways will also be possible during this',
				'timeframe, especially in typical low-lying and poor drainage',
				'areas.',
				'- http://www.weather.gov/safety/flood',
			].join('\n'),
			instruction: 'You should monitor later forecasts and be alert for possible Flood Warnings. Those living in areas prone to flooding should be prepared to take action should flooding develop.',
		});

		expect(postText).toContain(
			'Heavy rain may fall on a deep primed snowpack leading to the melt increasing.\n\nFlows in rivers may increase quickly and reach critical levels.',
		);
		expect(postText).toContain(
			'ADDITIONAL DETAILS:\n\n- Multiple rounds of showers and embedded thunderstorms continue through tonight which may result in 1" to 1.5", with localized amounts of 2" if thunderstorms repeat over the same area. Excess runoff from this rainfall may cause area waterways to reach or exceed bankfull stage. General flooding away from area waterways will also be possible during this timeframe, especially in typical low-lying and poor drainage areas.\n\n- http://www.weather.gov/safety/flood',
		);
	});

	it('builds facebook update comments from only the changed alert sections', () => {
		const previousSnapshot = __testing.buildAlertPostedSnapshot({
			event: 'Severe Thunderstorm Warning',
			areaDesc: 'Cook, IL; Will, IL',
			severity: 'Severe',
			expires: '2026-03-31T10:20:00-05:00',
			headline: 'Severe Thunderstorm Warning issued March 31 at 9:40AM CDT until March 31 at 10:20AM CDT by NWS Chicago IL',
			description: [
				'At 9:40 AM CDT, severe thunderstorms were located over Joliet, moving east at 25 mph.',
				'',
				'HAZARD...60 mph wind gusts and quarter size hail.',
				'',
				'SOURCE...Radar indicated.',
				'',
				'IMPACT...Minor hail damage is possible.',
			].join('\n'),
			instruction: 'For your protection move to an interior room on the lowest floor of a building.',
		});

		const message = __testing.buildFacebookUpdateCommentMessage({
			event: 'Severe Thunderstorm Warning',
			areaDesc: 'Cook, IL; Will, IL',
			severity: 'Severe',
			expires: '2026-03-31T10:30:00-05:00',
			headline: 'Severe Thunderstorm Warning issued March 31 at 9:54AM CDT until March 31 at 10:30AM CDT by NWS Chicago IL',
			description: [
				'At 9:53 AM CDT, severe thunderstorms were located over New Lenox, Frankford, and Matteson, moving east at 30 to 50 mph.',
				'',
				'HAZARD...60 mph wind gusts and quarter size hail.',
				'',
				'SOURCE...Radar indicated.',
				'',
				'IMPACT...Hail damage to vehicles is expected. Expect wind damage to roofs, siding, and trees.',
			].join('\n'),
			instruction: 'For your protection move to an interior room on the lowest floor of a building.',
		}, previousSnapshot);

		expect(message).toContain('🔄 UPDATE — Severe Thunderstorm Warning for Cook, IL; Will, IL');
		expect(message).toContain('Expires: Mar 31, 10:30 AM CDT');
		expect(message).toContain(
			'At 9:53 AM CDT, severe thunderstorms were located over New Lenox, Frankford, and Matteson, moving east at 30 to 50 mph.',
		);
		expect(message).toContain(
			'IMPACT: Hail damage to vehicles is expected. Expect wind damage to roofs, siding, and trees.',
		);
		expect(message).not.toContain('HAZARD: 60 mph wind gusts and quarter size hail.');
		expect(message).not.toContain('SOURCE: Radar indicated.');
		expect(message).not.toContain('Area: Cook, IL; Will, IL');
	});

	it('formats fire weather watch section headings cleanly for Facebook post previews', () => {
		const postText = __testing.alertToText({
			event: 'Fire Weather Watch',
			areaDesc: 'Cimarron; Texas; Beaver; Dallam',
			severity: 'Severe',
			expires: '2026-03-30T02:00:00-05:00',
			headline: 'Fire Weather Watch issued March 29 at 9:08PM CDT until March 30 at 9:00PM CDT by NWS Amarillo TX',
			description: [
				'WINDS...Southwest 15 to 25 mph with gusts up to 35 mph.',
				'',
				'RELATIVE HUMIDITY...As low as 8 percent.',
				'',
				'TEMPERATURES...In the low 90s.',
				'',
				'IMPACTS...Any fires that develop will have the potential to',
				'spread rapidly. Outdoor burning is not recommended.',
				'',
				'SEVERITY...',
				'',
				'FUELS (ERC)...90th+ percentile...5 (out of 5).',
				'',
				'WEATHER...Near Critical...2 (out of 5).',
				'',
				'FIRE ENVIRONMENT...7 (out of 10).',
			].join('\n'),
			instruction: 'A Fire Weather Watch means that the potential for critical fire weather conditions exists. Listen for later forecasts and possible red flag warnings.',
		});

		expect(postText).toContain('WINDS: Southwest 15 to 25 mph with gusts up to 35 mph.');
		expect(postText).toContain('RELATIVE HUMIDITY: As low as 8 percent.');
		expect(postText).toContain('TEMPERATURES: In the low 90s.');
		expect(postText).toContain('SEVERITY:');
		expect(postText).toContain('FUELS (ERC): 90th+ percentile 5 (out of 5).');
		expect(postText).toContain('WEATHER: Near Critical 2 (out of 5).');
		expect(postText).toContain('FIRE ENVIRONMENT: 7 (out of 10).');
		expect(postText).not.toContain('WINDSSouthwest');
		expect(postText).not.toContain('RELATIVE HUMIDITYAs');
		expect(postText).not.toContain('FIRE ENVIRONMENT7');
	});

	it('normalizes marine forecast heading tokens from NWS dot format', () => {
		const raw = '.TONIGHT...SE wind 10 to 20 kt. Seas 4 to 9 ft. Rain and snow. .MON...E wind 15 to 30 kt. Seas 6 to 10 ft. Rain and snow. .MON NIGHT...NE wind 20 to 35 kt. Seas 10 to 13 ft. .TUE...N wind 20 to 35 kt. Seas 10 to 14 ft. .TUE NIGHT...N wind 15 to 30 kt. Seas 9 to 14 ft. .WED THROUGH FRI...W wind up to 20 kt. Seas 6 to 11 ft.';
		const formatted = __testing.formatAlertDescription(raw);
		expect(formatted).toBe(
			'TONIGHT: SE wind 10 to 20 kt. Seas 4 to 9 ft. Rain and snow.\nMON: E wind 15 to 30 kt. Seas 6 to 10 ft. Rain and snow.\nMON NIGHT: NE wind 20 to 35 kt. Seas 10 to 13 ft.\nTUE: N wind 20 to 35 kt. Seas 10 to 14 ft.\nTUE NIGHT: N wind 15 to 30 kt. Seas 9 to 14 ft.\nWED THROUGH FRI: W wind up to 20 kt. Seas 6 to 11 ft.'
		);
	});

	it('removes leading ellipsis in descriptive NWS text lines', () => {
		const raw = '...RED FLAG WARNINGS ARE IN EFFECT THROUGH MONDAY EVENING FOR MOST OF...\n\nAFFECTED AREA: ...';
		const formatted = __testing.formatAlertDescription(raw);
		expect(formatted).toBe('RED FLAG WARNINGS ARE IN EFFECT THROUGH MONDAY EVENING FOR MOST OF\n\nAFFECTED AREA:');
	});

	it('splits additional details bullets onto separate lines', () => {
		const raw = 'ADDITIONAL DETAILS: - At 2:00 PM EDT Sunday the stage was 15.5 feet. - Forecast...The river is expected to fall below flood stage tonight. - Flood stage is 15.0 feet. - Please visit www.weather.gov/safety/flood for flood safety and preparedness information.';
		const formatted = __testing.formatAlertDescription(raw);
		expect(formatted).toBe('ADDITIONAL DETAILS: - At 2:00 PM EDT Sunday the stage was 15.5 feet.\n- Forecast...The river is expected to fall below flood stage tonight.\n- Flood stage is 15.0 feet.\n- Please visit www.weather.gov/safety/flood for flood safety and preparedness information.');
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
		expect(json.alerts[0].detailUrl).toBe('/?alert=alert-1');
		expect(typeof json.alerts[0].summary).toBe('string');
		expect(typeof json.alerts[0].instructionsSummary).toBe('string');
		expect(json.meta).toBeTruthy();
		expect(typeof json.meta.generatedAt).toBe('string');
		expect(typeof json.meta.stale).toBe('boolean');
		expect(json.meta.count).toBe(json.alerts.length);
		expect(
			(globalThis.fetch as any).mock.calls.some(([, init]: [RequestInfo, RequestInit | undefined]) =>
				(init as any)?.headers?.['User-Agent'] === 'LiveWeatherAlerts/1.0 (liveweatheralerts.com; alerts@liveweatheralerts.com)',
			),
		).toBe(true);
	});

	it('filters alerts by geospatial radius when lat/lon/radius are provided', async () => {
		const nearbyRequest = new IncomingRequest(
			'https://live-weather.example/api/alerts?lat=37.1671&lon=-83.2913&radius=25',
		);
		const nearbyCtx = createExecutionContext();
		const nearbyResponse = await worker.fetch(nearbyRequest, env, nearbyCtx);
		await waitOnExecutionContext(nearbyCtx);
		expect(nearbyResponse.status).toBe(200);
		const nearbyJson = await nearbyResponse.json() as any;
		expect(nearbyJson.meta.filterMode).toBe('radius');
		expect(nearbyJson.meta.radiusMiles).toBe(25);
		expect(nearbyJson.alerts).toHaveLength(1);

		const farRequest = new IncomingRequest(
			'https://live-weather.example/api/alerts?lat=34.0522&lon=-118.2437&radius=25',
		);
		const farCtx = createExecutionContext();
		const farResponse = await worker.fetch(farRequest, env, farCtx);
		await waitOnExecutionContext(farCtx);
		expect(farResponse.status).toBe(200);
		const farJson = await farResponse.json() as any;
		expect(farJson.alerts).toHaveLength(0);
	});

	it('filters alerts by state and UGC for local-area alert requests', async () => {
		await env.WEATHER_KV.put(
			'alerts:map',
			JSON.stringify({
				'ky-alert': {
					id: 'ky-alert',
					geometry: {
						type: 'Polygon',
						coordinates: [[
							[-83.35, 37.12],
							[-83.2, 37.12],
							[-83.2, 37.22],
							[-83.35, 37.22],
							[-83.35, 37.12],
						]],
					},
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Test County',
						geocode: { UGC: ['KYC001', 'KYZ010'] },
						status: 'Actual',
						headline: 'Test tornado warning',
						description: 'Tornado expected',
						effective: 'Now',
						expires: 'Soon',
						url: 'https://example.com/ky-alert',
					},
				},
				'oh-alert': {
					id: 'oh-alert',
					geometry: {
						type: 'Polygon',
						coordinates: [[
							[-82.1, 39.8],
							[-81.9, 39.8],
							[-81.9, 39.95],
							[-82.1, 39.95],
							[-82.1, 39.8],
						]],
					},
					properties: {
						event: 'Flood Advisory',
						severity: 'Moderate',
						areaDesc: 'Ohio County',
						geocode: { UGC: ['OHC001'] },
						status: 'Actual',
						headline: 'Test flood advisory',
						description: 'Flooding expected',
						effective: 'Now',
						expires: 'Later',
						url: 'https://example.com/oh-alert',
					},
				},
			}),
		);
		await env.WEATHER_KV.put('alerts:last-poll', new Date().toISOString());

		const stateRequest = new IncomingRequest('https://live-weather.example/api/alerts?state=KY');
		const stateCtx = createExecutionContext();
		const stateResponse = await worker.fetch(stateRequest, env, stateCtx);
		await waitOnExecutionContext(stateCtx);
		expect(stateResponse.status).toBe(200);
		const stateJson = await stateResponse.json() as any;
		expect(stateJson.meta.filterMode).toBe('state');
		expect(stateJson.meta.stateCode).toBe('KY');
		expect(stateJson.alerts.map((alert: any) => alert.id)).toEqual(['ky-alert']);

		const ugcRequest = new IncomingRequest(
			'https://live-weather.example/api/alerts?state=KY&ugc=KYC001&ugc=KYZ010,OHC001',
		);
		const ugcCtx = createExecutionContext();
		const ugcResponse = await worker.fetch(ugcRequest, env, ugcCtx);
		await waitOnExecutionContext(ugcCtx);
		expect(ugcResponse.status).toBe(200);
		const ugcJson = await ugcResponse.json() as any;
		expect(ugcJson.meta.filterMode).toBe('ugc');
		expect(ugcJson.meta.stateCode).toBe('KY');
		expect(ugcJson.meta.ugcCount).toBe(3);
		expect(ugcJson.alerts.map((alert: any) => alert.id)).toEqual(['ky-alert']);
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
		expect(foundJson.alert.detailUrl).toBe('/?alert=alert-1');
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

		expect(payload.url).toBe('/?alert=abc%20123');
		expect(payload.detailUrl).toBe('/?alert=abc%20123');
		expect(payload.fallbackUrl).toBe('/?tab=alerts&state=KY');
		expect(payload.alertId).toBe('abc 123');
	});

	it('redirects legacy app alert paths to the canonical alert detail URL', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://live-weather.example/alerts/abc%20123'),
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('https://live-weather.example/?alert=abc%20123');
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

	it('matches radius push scopes against nearby alert geometry even across state delivery buckets', () => {
		const prefs = __testing.normalizePushPreferences({
			scopes: [
				{
					id: 'ky-radius',
					label: 'Within 25 mi of Wooton, KY',
					stateCode: 'KY',
					deliveryScope: 'radius',
					centerLat: 37.1671,
					centerLon: -83.2913,
					radiusMiles: 25,
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
			quietHours: { enabled: false, start: '22:00', end: '06:00' },
			deliveryMode: 'immediate',
		}, 'KY');
		const radiusScope = prefs.scopes[0];
		const nearbyFeature = {
			id: 'tn-alert',
			geometry: {
				type: 'Polygon',
				coordinates: [[
					[-83.31, 37.11],
					[-83.19, 37.11],
					[-83.19, 37.23],
					[-83.31, 37.23],
					[-83.31, 37.11],
				]],
			},
			properties: {
				event: 'Severe Thunderstorm Warning',
				severity: 'Severe',
				areaDesc: 'Border County',
				geocode: { UGC: ['TNC025'] },
			},
		};
		expect(__testing.featureMatchesScope(nearbyFeature, 'TN', radiusScope)).toBe(true);
		expect(__testing.changeMatchesScope({
			alertId: 'expired-border-alert',
			stateCodes: ['TN'],
			countyCodes: ['025'],
			event: 'Severe Thunderstorm Warning',
			areaDesc: 'Border County',
			lat: 37.17,
			lon: -83.24,
			changedAt: '2026-03-29T12:00:00.000Z',
			changeType: 'expired',
			severity: 'Severe',
			category: 'warning',
			isMajor: true,
			previousExpires: '2026-03-29T13:00:00.000Z',
			nextExpires: null,
		}, radiusScope)).toBe(true);
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

	it('skips duplicate admin reposts when an existing thread has no material changes', async () => {
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
		await goodEnv.WEATHER_KV.put('thread:KYC001:tornado_warning', JSON.stringify({
			postId: 'existing-post-1',
			nwsAlertId: 'alert-1',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			county: 'Test County',
			alertType: 'Tornado Warning',
			updateCount: 1,
			lastPostedSnapshot: __testing.buildAlertPostedSnapshot(sampleAlerts.features[0].properties),
		}));

		const postBody = new URLSearchParams({
			action: 'post_alert',
			alertId: 'alert-1',
			customMessage: __testing.alertToText(sampleAlerts.features[0].properties),
		}).toString();
		const request = new IncomingRequest('https://live-weather.example/admin/post', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
			body: postBody,
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.results[0].status).toBe('skipped');
		expect(json.results[0].skippedReason).toBe('duplicate_minor_update');
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) =>
			String(input).includes('graph.facebook.com'),
		)).toBe(false);
	});

	it('autoPostFacebookAlerts skips older freeze-warning reissues when only a minor time tweak changed', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const oldPostedAt = new Date(nowMs - (2 * 60 * 60 * 1000)).toISOString();
		const oldExpiresIso = new Date(nowMs + (10 * 60 * 60 * 1000)).toISOString();
		const minorExtensionIso = new Date(nowMs + (10 * 60 * 60 * 1000) + (15 * 60 * 1000)).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));

		const baseFreezeProperties = {
			event: 'Freeze Warning',
			severity: 'Moderate',
			areaDesc: 'Tooele and Rush Valleys; Eastern Box Elder County; Northern Wasatch Front; Salt Lake Valley; Utah Valley; San Rafael Swell; Western Canyonlands',
			senderName: 'NWS Salt Lake City UT',
			headline: 'Freeze Warning issued April 3 at 8:44AM MDT until April 4 at 9:00AM MDT by NWS Salt Lake City UT',
			description: 'Temperatures will drop below freezing again tonight. Frost and freeze conditions could kill crops and damage unprotected outdoor plumbing.',
			instruction: 'Take steps now to protect tender plants from the cold.',
			sent: nowIso,
			updated: nowIso,
			effective: nowIso,
			expires: oldExpiresIso,
			geocode: {
				UGC: ['UTZ101', 'UTZ102', 'UTZ103', 'UTZ104', 'UTZ105', 'UTZ106', 'UTZ107'],
			},
		};
		await goodEnv.WEATHER_KV.put('thread:UTZ101:freeze_warning', JSON.stringify({
			postId: 'freeze-post-1',
			nwsAlertId: 'freeze-old-1',
			expiresAt: Math.floor(Date.parse(oldExpiresIso) / 1000),
			county: baseFreezeProperties.areaDesc,
			alertType: 'Freeze Warning',
			updateCount: 0,
			lastPostedAt: oldPostedAt,
			lastPostedSnapshot: __testing.buildAlertPostedSnapshot(baseFreezeProperties),
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'freeze-reissue-1': {
					id: 'freeze-reissue-1',
					properties: {
						...baseFreezeProperties,
						headline: 'Freeze Warning issued April 3 at 10:44AM MDT until April 4 at 9:15AM MDT by NWS Salt Lake City UT',
						expires: minorExtensionIso,
						updated: new Date(nowMs + 5 * 60 * 1000).toISOString(),
					},
				},
			},
			[
				{
					alertId: 'freeze-reissue-1',
					stateCodes: ['UT'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019'],
					event: 'Freeze Warning',
					areaDesc: baseFreezeProperties.areaDesc,
					changedAt: nowIso,
					changeType: 'updated',
					severity: 'Moderate',
				},
			],
		);

		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) =>
			String(input).includes('graph.facebook.com'),
		)).toBe(false);
		const threadRaw = await goodEnv.WEATHER_KV.get('thread:UTZ101:freeze_warning');
		expect(threadRaw).toBeTruthy();
		const thread = JSON.parse(threadRaw || '{}');
		expect(thread.postId).toBe('freeze-post-1');
		expect(thread.updateCount).toBe(0);
	});

	it('autoPostFacebookAlerts keeps freeze-warning extensions on the same thread as comments', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const oldPostedAt = new Date(nowMs - (2 * 60 * 60 * 1000)).toISOString();
		const oldExpiresIso = new Date(nowMs + (8 * 60 * 60 * 1000)).toISOString();
		const significantExtensionIso = new Date(nowMs + (11 * 60 * 60 * 1000)).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));

		const baseFreezeProperties = {
			event: 'Freeze Warning',
			severity: 'Moderate',
			areaDesc: 'Tooele and Rush Valleys; Eastern Box Elder County; Northern Wasatch Front; Salt Lake Valley; Utah Valley; San Rafael Swell; Western Canyonlands',
			senderName: 'NWS Salt Lake City UT',
			headline: 'Freeze Warning issued April 3 at 8:44AM MDT until April 4 at 6:00AM MDT by NWS Salt Lake City UT',
			description: 'Temperatures will drop below freezing again tonight. Frost and freeze conditions could kill crops and damage unprotected outdoor plumbing.',
			instruction: 'Take steps now to protect tender plants from the cold.',
			sent: nowIso,
			updated: nowIso,
			effective: nowIso,
			expires: oldExpiresIso,
			geocode: {
				UGC: ['UTZ101', 'UTZ102', 'UTZ103', 'UTZ104', 'UTZ105', 'UTZ106', 'UTZ107'],
			},
		};
		await goodEnv.WEATHER_KV.put('thread:UTZ101:freeze_warning', JSON.stringify({
			postId: 'freeze-post-2',
			nwsAlertId: 'freeze-old-2',
			expiresAt: Math.floor(Date.parse(oldExpiresIso) / 1000),
			county: baseFreezeProperties.areaDesc,
			alertType: 'Freeze Warning',
			updateCount: 0,
			lastPostedAt: oldPostedAt,
			lastPostedSnapshot: __testing.buildAlertPostedSnapshot(baseFreezeProperties),
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'freeze-extension-1': {
					id: 'freeze-extension-1',
					properties: {
						...baseFreezeProperties,
						headline: 'Freeze Warning issued April 3 at 10:44AM MDT until April 4 at 9:00AM MDT by NWS Salt Lake City UT',
						expires: significantExtensionIso,
						updated: new Date(nowMs + 5 * 60 * 1000).toISOString(),
					},
				},
			},
			[
				{
					alertId: 'freeze-extension-1',
					stateCodes: ['UT'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019'],
					event: 'Freeze Warning',
					areaDesc: baseFreezeProperties.areaDesc,
					changedAt: nowIso,
					changeType: 'extended',
					severity: 'Moderate',
				},
			],
		);

		const commentCall = (globalThis.fetch as any).mock.calls.find(([input]: [RequestInfo]) =>
			String(input).includes('/freeze-post-2/comments'),
		);
		expect(commentCall).toBeTruthy();
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		)).toBe(false);
		const commentBody = commentCall?.[1]?.body;
		const commentParams = commentBody instanceof URLSearchParams
			? commentBody
			: new URLSearchParams(String(commentBody || ''));
		expect(String(commentParams.get('message') || '')).toContain('Expires:');

		const threadRaw = await goodEnv.WEATHER_KV.get('thread:UTZ101:freeze_warning');
		expect(threadRaw).toBeTruthy();
		const thread = JSON.parse(threadRaw || '{}');
		expect(thread.postId).toBe('freeze-post-2');
		expect(thread.updateCount).toBe(1);
	});

	it('renders facebook post tab preview buttons with the same state and event metadata used for image lookup', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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
		const response = await worker.fetch(
			new IncomingRequest('https://live-weather.example/admin', {
				headers: { Cookie: cookie },
			}),
			goodEnv as any,
			createExecutionContext(),
		);
		const body = await response.text();
		expect(body).toContain('data-admin-panel-btn="facebook-post"');
		expect(body).toContain('data-state="KY"');
		expect(body).toContain('data-event="Tornado Warning"');
	});

	it('reuses a manual facebook post thread for a later scheduled auto-post update comment', async () => {
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

		const manualPostRequest = new IncomingRequest('https://live-weather.example/admin/post', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
			body: new URLSearchParams({ action: 'post_alert', alertId: 'alert-1' }).toString(),
		});
		const manualPostCtx = createExecutionContext();
		const manualPostResponse = await worker.fetch(manualPostRequest, goodEnv as any, manualPostCtx);
		await waitOnExecutionContext(manualPostCtx);
		expect(manualPostResponse.status).toBe(200);

		const manualThreadRaw = await goodEnv.WEATHER_KV.get('thread:KYC001:tornado_warning');
		expect(manualThreadRaw).toBeTruthy();
		const manualThread = JSON.parse(manualThreadRaw || '{}');
		expect(manualThread.postId).toBe('12345');

		const nowIso = new Date().toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'tornado_only',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('alerts:lifecycle-snapshot:v1', JSON.stringify({
			'alert-1': {
				alertId: 'alert-1',
				stateCodes: ['KY'],
				countyCodes: ['001'],
				event: 'Tornado Warning',
				areaDesc: 'Test County',
				lat: 37.17,
				lon: -83.28,
				headline: 'Test tornado warning',
				description: 'Previous tornado warning details',
				instruction: '',
				severity: 'Severe',
				urgency: '',
				certainty: '',
				updated: '',
				expires: '2026-03-29T23:00:00-04:00',
				lastChangeType: 'new',
				lastChangedAt: '2026-03-29T20:00:00.000Z',
			},
		}));

		const scheduledCtx = createExecutionContext();
		await worker.scheduled(
			{
				cron: '*/2 * * * *',
				scheduledTime: Date.now(),
			} as any,
			goodEnv as any,
			scheduledCtx,
		);
		await waitOnExecutionContext(scheduledCtx);

		expect(
			(globalThis.fetch as any).mock.calls.some(([input]) =>
				String(input).includes('/12345/comments'),
			),
		).toBe(true);
	});

	it('clusters same-metro severe thunderstorm warnings into one post with comment updates instead of duplicate posts', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		const expiresIso = new Date(Date.now() + 45 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));

		const chicagoPrimary = {
			id: 'svr-chicago-1',
			properties: {
				event: 'Severe Thunderstorm Warning',
				severity: 'Severe',
				areaDesc: 'Cook, IL; Will, IL',
				senderName: 'NWS Chicago IL',
				headline: 'Severe Thunderstorm Warning for Chicago metro',
				description: 'At 9:53 AM CDT, severe thunderstorms were located over Chicago.\n\nHAZARD...80 mph wind gusts and quarter size hail.\n\nSOURCE...Radar indicated.\n\nIMPACT...Destructive winds will cause damage to roofs, siding, and trees.',
				instruction: 'Move to an interior room on the lowest floor of a building.',
				sent: nowIso,
				updated: nowIso,
				effective: nowIso,
				expires: expiresIso,
				geocode: {
					UGC: ['ILC031', 'ILC197'],
					SAME: ['17031', '17197'],
				},
				parameters: {
					maxWindGust: ['80 mph'],
					maxHailSize: ['1.00'],
				},
			},
		};
		const chicagoSibling = {
			id: 'svr-chicago-2',
			properties: {
				event: 'Severe Thunderstorm Warning',
				severity: 'Severe',
				areaDesc: 'Lake, IN',
				senderName: 'NWS Chicago IL',
				headline: 'Severe Thunderstorm Warning for northwest Indiana',
				description: 'At 9:58 AM CDT, severe thunderstorms were moving into northwest Indiana.\n\nHAZARD...70 mph wind gusts and quarter size hail.\n\nSOURCE...Radar indicated.\n\nIMPACT...Damaging winds will knock down trees and power lines.',
				instruction: 'Move to an interior room on the lowest floor of a building.',
				sent: nowIso,
				updated: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
				effective: nowIso,
				expires: expiresIso,
				geocode: {
					UGC: ['INC089'],
					SAME: ['18089'],
				},
				parameters: {
					maxWindGust: ['70 mph'],
					maxHailSize: ['1.00'],
				},
			},
		};

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'svr-chicago-1': chicagoPrimary,
				'svr-chicago-2': chicagoSibling,
			},
			[
				{
					alertId: 'svr-chicago-1',
					stateCodes: ['IL'],
					countyCodes: ['031', '197'],
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Cook, IL; Will, IL',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
				{
					alertId: 'svr-chicago-2',
					stateCodes: ['IN'],
					countyCodes: ['089'],
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Lake, IN',
					changedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const commentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/12345/comments'),
		);
		expect(postCalls.length).toBe(1);
		expect(commentCalls.length).toBe(1);

		const metroThreadRaw = await goodEnv.WEATHER_KV.get('thread-cluster:severe_thunderstorm:metro:chicago');
		expect(metroThreadRaw).toBeTruthy();
		expect(JSON.parse(metroThreadRaw || '{}').updateCount).toBe(1);
	});

	it('maps only the intended hazard families for same-cycle alert clustering', () => {
		const { autoPostHazardClusterFamilyForEvent } = __testing as any;

		expect(autoPostHazardClusterFamilyForEvent('High Wind Warning')).toBe('wind');
		expect(autoPostHazardClusterFamilyForEvent('Flood Advisory')).toBe('flood');
		expect(autoPostHazardClusterFamilyForEvent('Winter Weather Advisory')).toBe('winter');
		expect(autoPostHazardClusterFamilyForEvent('Red Flag Warning')).toBe('fire_weather');
		expect(autoPostHazardClusterFamilyForEvent('Severe Thunderstorm Warning')).toBeNull();
		expect(autoPostHazardClusterFamilyForEvent('Tornado Warning')).toBeNull();
		expect(autoPostHazardClusterFamilyForEvent('Flash Flood Warning')).toBeNull();
	});

	it('clusters same-family alerts from the same office and state into one anchor post with comment updates', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		const expiresIso = new Date(Date.now() + 90 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));

		const strongerWarning = {
			id: 'wind-cluster-anchor',
			properties: {
				event: 'High Wind Warning',
				severity: 'Severe',
				areaDesc: 'West Slope; Foothills; River Valley; Lake Basin',
				senderName: 'NWS Reno NV',
				headline: 'Destructive winds expected across the West Slope',
				description: 'Damaging gusts may reach 80 mph with tree damage and scattered power outages likely.',
				instruction: 'Avoid travel in exposed areas.',
				sent: nowIso,
				updated: nowIso,
				effective: nowIso,
				expires: expiresIso,
				geocode: {
					UGC: ['CAZ101', 'CAZ103', 'CAZ105', 'CAZ107', 'CAZ109', 'CAZ111', 'CAZ113', 'CAZ115', 'CAZ117', 'CAZ119', 'CAZ121', 'CAZ123'],
				},
				parameters: {
					maxWindGust: ['80 mph'],
				},
			},
		};
		const secondaryWarning = {
			id: 'wind-cluster-warning-2',
			properties: {
				event: 'High Wind Warning',
				severity: 'Moderate',
				areaDesc: 'Interior Basin; Canyon Rim',
				senderName: 'NWS Reno NV',
				headline: 'High Wind Warning expanded into the Interior Basin',
				description: 'Wind gusts up to 60 mph are expected with difficult travel for high-profile vehicles.',
				instruction: 'Use caution on open roads.',
				sent: new Date(Date.now() + 60 * 1000).toISOString(),
				updated: new Date(Date.now() + 60 * 1000).toISOString(),
				effective: nowIso,
				expires: expiresIso,
				geocode: {
					UGC: ['CAZ131', 'CAZ133', 'CAZ135', 'CAZ137', 'CAZ139', 'CAZ141', 'CAZ143', 'CAZ145', 'CAZ147', 'CAZ149'],
				},
				parameters: {
					maxWindGust: ['60 mph'],
				},
			},
		};
		const advisorySupplement = {
			id: 'wind-cluster-advisory',
			properties: {
				event: 'Wind Advisory',
				severity: 'Moderate',
				areaDesc: 'North Slope',
				senderName: 'NWS Reno NV',
				headline: 'Wind Advisory added for the North Slope',
				description: 'Gusts up to 45 mph are expected across the advisory area.',
				instruction: 'Secure loose outdoor objects.',
				sent: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
				updated: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
				effective: nowIso,
				expires: expiresIso,
				geocode: {
					UGC: ['CAZ201'],
				},
				parameters: {
					maxWindGust: ['45 mph'],
				},
			},
		};

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'wind-cluster-anchor': strongerWarning,
				'wind-cluster-warning-2': secondaryWarning,
				'wind-cluster-advisory': advisorySupplement,
			},
			[
				{
					alertId: 'wind-cluster-anchor',
					stateCodes: ['CA'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019', '021', '023'],
					event: 'High Wind Warning',
					areaDesc: 'West Slope; Foothills; River Valley; Lake Basin',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
				{
					alertId: 'wind-cluster-warning-2',
					stateCodes: ['CA'],
					countyCodes: ['031', '033', '035', '037', '039', '041', '043', '045', '047', '049'],
					event: 'High Wind Warning',
					areaDesc: 'Interior Basin; Canyon Rim',
					changedAt: new Date(Date.now() + 60 * 1000).toISOString(),
					changeType: 'new',
					severity: 'Moderate',
				},
				{
					alertId: 'wind-cluster-advisory',
					stateCodes: ['CA'],
					countyCodes: ['201'],
					event: 'Wind Advisory',
					areaDesc: 'North Slope',
					changedAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
					changeType: 'new',
					severity: 'Moderate',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const commentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/12345/comments'),
		);
		expect(postCalls.length).toBe(1);
		expect(commentCalls.length).toBe(2);

		const postBody = postCalls[0]?.[1]?.body;
		const postParams = postBody instanceof URLSearchParams
			? postBody
			: new URLSearchParams(String(postBody || ''));
		const anchorText = String(postParams.get('caption') || postParams.get('message') || '');
		expect(anchorText).toContain('Destructive winds expected across the West Slope');

		const commentMessages = commentCalls.map(([, init]: [RequestInfo, RequestInit]) => {
			const body = init?.body;
			const params = body instanceof URLSearchParams
				? body
				: new URLSearchParams(String(body || ''));
			return String(params.get('message') || '');
		});
		expect(commentMessages.every((message) => message.startsWith('UPDATE:'))).toBe(true);
		expect(commentMessages.some((message) => message.includes('60 mph'))).toBe(true);
		expect(commentMessages.some((message) => message.includes('North Slope'))).toBe(true);
		expect(commentMessages.every((message) => !message.includes('#weatheralert'))).toBe(true);

		const advisoryThreadRaw = await goodEnv.WEATHER_KV.get('thread:CAZ201:wind_advisory');
		expect(advisoryThreadRaw).toBeTruthy();
		expect(JSON.parse(advisoryThreadRaw || '{}').postId).toBe('12345');
		const advisoryClusterThreadRaw = await goodEnv.WEATHER_KV.get('thread-cluster:wind:sender:nws-reno-nv:states:CA');
		expect(advisoryClusterThreadRaw).toBeTruthy();
		expect(JSON.parse(advisoryClusterThreadRaw || '{}').postId).toBe('12345');
	});

	it('runCoordinatedFacebookCoverage prioritizes alert auto-posts over digest startup coverage', async () => {
		const { runCoordinatedFacebookCoverage, readFacebookCoordinatorSnapshot } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		const expiresIso = new Date(Date.now() + 90 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
			digestCoverageEnabled: true,
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '');

		await runCoordinatedFacebookCoverage(
			goodEnv as any,
			{
				'wind-priority-alert': {
					id: 'wind-priority-alert',
					properties: {
						event: 'High Wind Warning',
						severity: 'Severe',
						urgency: 'Immediate',
						areaDesc: 'West Slope; Foothills; River Valley; Lake Basin',
						senderName: 'NWS Reno NV',
						headline: 'Destructive winds expected across the West Slope',
						description: 'Damaging gusts may reach 80 mph with tree damage and scattered power outages likely.',
						instruction: 'Avoid travel in exposed areas.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: {
							UGC: ['CAZ101', 'CAZ103', 'CAZ105', 'CAZ107', 'CAZ109', 'CAZ111', 'CAZ113', 'CAZ115', 'CAZ117', 'CAZ119', 'CAZ121', 'CAZ123'],
						},
						parameters: {
							maxWindGust: ['80 mph'],
						},
					},
				},
			},
			[
				{
					alertId: 'wind-priority-alert',
					stateCodes: ['CA'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019', '021', '023'],
					event: 'High Wind Warning',
					areaDesc: 'West Slope; Foothills; River Valley; Lake Basin',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const snapshot = await readFacebookCoordinatorSnapshot(goodEnv);
		expect(snapshot?.selectedLane).toBe('alerts');
		expect(snapshot?.selectedReason).toBe('coordinator_selected_alerts');
		expect(snapshot?.selectedIntentReason).toBe('tier2_high_wind_warning');
		expect(snapshot?.statuses.some((status: any) => status.lane === 'digest' && status.status === 'suppressed')).toBe(true);
		expect(snapshot?.statuses.some((status: any) => (
			status.lane === 'digest'
			&& status.reason === 'coordinator_suppressed_digest_by_alerts'
		))).toBe(true);
		expect(await goodEnv.WEATHER_KV.get('fb:digest:block')).toBeNull();
	});

	it('does not cluster same-family alerts when the state differs', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		const expiresIso = new Date(Date.now() + 90 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'wind-ca': {
					id: 'wind-ca',
					properties: {
						event: 'High Wind Warning',
						severity: 'Severe',
						areaDesc: 'California wind corridor',
						senderName: 'NWS Reno NV',
						headline: 'California High Wind Warning',
						description: 'Damaging gusts up to 75 mph are expected.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: { UGC: ['CAZ301', 'CAZ303', 'CAZ305', 'CAZ307', 'CAZ309', 'CAZ311', 'CAZ313', 'CAZ315', 'CAZ317', 'CAZ319'] },
						parameters: { maxWindGust: ['75 mph'] },
					},
				},
				'wind-nv': {
					id: 'wind-nv',
					properties: {
						event: 'High Wind Warning',
						severity: 'Severe',
						areaDesc: 'Nevada wind corridor',
						senderName: 'NWS Reno NV',
						headline: 'Nevada High Wind Warning',
						description: 'Damaging gusts up to 70 mph are expected.',
						sent: new Date(Date.now() + 60 * 1000).toISOString(),
						updated: new Date(Date.now() + 60 * 1000).toISOString(),
						effective: nowIso,
						expires: expiresIso,
						geocode: { UGC: ['NVZ301', 'NVZ303', 'NVZ305', 'NVZ307', 'NVZ309', 'NVZ311', 'NVZ313', 'NVZ315', 'NVZ317', 'NVZ319'] },
						parameters: { maxWindGust: ['70 mph'] },
					},
				},
			},
			[
				{
					alertId: 'wind-ca',
					stateCodes: ['CA'],
					countyCodes: ['301', '303', '305', '307', '309', '311', '313', '315', '317', '319'],
					event: 'High Wind Warning',
					areaDesc: 'California wind corridor',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
				{
					alertId: 'wind-nv',
					stateCodes: ['NV'],
					countyCodes: ['301', '303', '305', '307', '309', '311', '313', '315', '317', '319'],
					event: 'High Wind Warning',
					areaDesc: 'Nevada wind corridor',
					changedAt: new Date(Date.now() + 60 * 1000).toISOString(),
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const commentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/comments'),
		);
		expect(postCalls.length).toBe(2);
		expect(commentCalls.length).toBe(0);
	});

	it('routes overlapping tornado watches onto the current SPC Day 1 thread instead of creating a new alert post', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const expiresIso = new Date(nowMs + 5 * 60 * 60 * 1000).toISOString();
		const spcIssuedIso = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
		const spcPublishedIso = new Date(nowMs - 90 * 60 * 1000).toISOString();
		const spcValidFromIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
		const spcValidToIso = new Date(nowMs + 10 * 60 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('fb:spc:thread:1', JSON.stringify({
			postId: 'spc-day1-post-1',
			outlookDay: 1,
			issuedAt: spcIssuedIso,
			publishedAt: spcPublishedIso,
			hash: 'spc-day1-hash-1',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				issuedAt: spcIssuedIso,
				validFrom: spcValidFromIso,
				validTo: spcValidToIso,
				outlookDay: 1,
				highestRiskLevel: 'enhanced',
				highestRiskNumber: 3,
				affectedStates: ['IA', 'IL', 'WI'],
				stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
				primaryRegion: 'Midwest',
				hazardFocus: 'tornado',
				hazardList: ['tornadoes', 'damaging winds'],
				stormMode: 'supercells',
				notableText: null,
				tornadoProbability: 10,
				windProbability: 30,
				hailProbability: null,
				timingText: 'this afternoon',
				summaryHash: 'spc-day1-hash-1',
			},
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'tw-ia-1': {
					id: 'tw-ia-1',
					properties: {
						event: 'Tornado Watch',
						severity: 'Moderate',
						areaDesc: 'Polk; Story; Boone',
						senderName: 'NWS Des Moines IA',
						headline: 'Tornado Watch for central Iowa',
						description: 'Tornadoes, large hail, and isolated damaging winds are possible.',
						instruction: 'Be ready to act quickly if warnings are issued.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: {
							UGC: ['IAC015', 'IAC153', 'IAC169'],
						},
					},
				},
			},
			[
				{
					alertId: 'tw-ia-1',
					stateCodes: ['IA'],
					countyCodes: ['015', '153', '169'],
					event: 'Tornado Watch',
					areaDesc: 'Polk; Story; Boone',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Moderate',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const spcCommentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/spc-day1-post-1/comments'),
		);
		expect(postCalls.length).toBe(0);
		expect(spcCommentCalls.length).toBe(1);

		const commentBody = spcCommentCalls[0]?.[1]?.body;
		const commentParams = commentBody instanceof URLSearchParams
			? commentBody
			: new URLSearchParams(String(commentBody || ''));
		const commentMessage = String(commentParams.get('message') || '');
		expect(commentMessage).toContain('UPDATE: A Tornado Watch is now in effect for parts of Iowa');
		expect(commentMessage).toContain('Tornadoes and damaging winds will be the main concerns');
		expect(commentMessage).not.toContain('Polk; Story; Boone');

		const watchThreadRaw = await goodEnv.WEATHER_KV.get('thread:IAC015:tornado_watch');
		expect(watchThreadRaw).toBeTruthy();
		expect(JSON.parse(watchThreadRaw || '{}').postId).toBe('spc-day1-post-1');

		const spcThreadRaw = await goodEnv.WEATHER_KV.get('fb:spc:thread:1');
		expect(spcThreadRaw).toBeTruthy();
		const spcThread = JSON.parse(spcThreadRaw || '{}');
		expect(spcThread.commentCount).toBe(1);
		expect(spcThread.lastCommentAt).toBeTruthy();
	});

	it('skips the SPC Day 1 watch reroute when a tornado warning is already driving coverage', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const expiresIso = new Date(nowMs + 5 * 60 * 60 * 1000).toISOString();
		const spcIssuedIso = new Date(nowMs - 3 * 60 * 60 * 1000).toISOString();
		const spcPublishedIso = new Date(nowMs - 90 * 60 * 1000).toISOString();
		const spcValidFromIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
		const spcValidToIso = new Date(nowMs + 10 * 60 * 60 * 1000).toISOString();
		const activeWarningIso = new Date(nowMs).toISOString();
		const activeWarningExpiresIso = new Date(Date.now() + 20 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('fb:spc:thread:1', JSON.stringify({
			postId: 'spc-day1-post-1',
			outlookDay: 1,
			issuedAt: spcIssuedIso,
			publishedAt: spcPublishedIso,
			hash: 'spc-day1-hash-1',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				issuedAt: spcIssuedIso,
				validFrom: spcValidFromIso,
				validTo: spcValidToIso,
				outlookDay: 1,
				highestRiskLevel: 'enhanced',
				highestRiskNumber: 3,
				affectedStates: ['IA', 'IL', 'WI'],
				stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
				primaryRegion: 'Midwest',
				hazardFocus: 'tornado',
				hazardList: ['tornadoes', 'damaging winds'],
				stormMode: 'supercells',
				notableText: null,
				tornadoProbability: 10,
				windProbability: 30,
				hailProbability: null,
				timingText: 'this afternoon',
				summaryHash: 'spc-day1-hash-1',
			},
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'tw-ia-1': {
					id: 'tw-ia-1',
					properties: {
						event: 'Tornado Watch',
						severity: 'Moderate',
						areaDesc: 'Polk; Story; Boone',
						senderName: 'NWS Des Moines IA',
						headline: 'Tornado Watch for central Iowa',
						description: 'Tornadoes, large hail, and isolated damaging winds are possible.',
						instruction: 'Be ready to act quickly if warnings are issued.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: {
							UGC: ['IAC015', 'IAC153', 'IAC169'],
						},
					},
				},
				'tornado-live': {
					id: 'tornado-live',
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Leslie County',
						senderName: 'NWS Jackson KY',
						headline: 'Tornado Warning for Leslie County',
						description: 'A tornado warning is in effect for Leslie County.',
						instruction: 'Take shelter now.',
						sent: activeWarningIso,
						updated: activeWarningIso,
						effective: activeWarningIso,
						expires: activeWarningExpiresIso,
						geocode: {
							UGC: ['KYC131'],
						},
					},
				},
			},
			[
				{
					alertId: 'tw-ia-1',
					stateCodes: ['IA'],
					countyCodes: ['015', '153', '169'],
					event: 'Tornado Watch',
					areaDesc: 'Polk; Story; Boone',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Moderate',
				},
				{
					alertId: 'tornado-live',
					stateCodes: ['KY'],
					countyCodes: ['131'],
					event: 'Tornado Warning',
					areaDesc: 'Leslie County',
					changedAt: activeWarningIso,
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const spcCommentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/spc-day1-post-1/comments'),
		);
		expect(postCalls.length).toBe(1);
		expect(spcCommentCalls.length).toBe(0);

		const spcThreadRaw = await goodEnv.WEATHER_KV.get('fb:spc:thread:1');
		expect(spcThreadRaw).toBeTruthy();
		expect(JSON.parse(spcThreadRaw || '{}').commentCount).toBe(0);
	});

	it('runSpcCoverageForDay still publishes scheduled Day 2 anchors after a recent alert-lane Facebook post in the same cycle', async () => {
		const { autoPostFacebookAlerts, runSpcCoverageForDay } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		} as any;
		const nowIso = new Date().toISOString();
		const expiresIso = new Date(Date.now() + 45 * 60 * 1000).toISOString();

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'tornado_only',
			updatedAt: nowIso,
			spcDay1CoverageEnabled: false,
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));

		await autoPostFacebookAlerts(
			goodEnv,
			{
				'tornado-gap-1': {
					id: 'tornado-gap-1',
					properties: {
						event: 'Tornado Warning',
						severity: 'Severe',
						areaDesc: 'Test County, KY',
						senderName: 'NWS Jackson KY',
						headline: 'Tornado Warning for Test County',
						description: 'A tornado warning is in effect for the county.',
						instruction: 'Take shelter now.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: {
							UGC: ['KYC001'],
							SAME: ['21001'],
						},
					},
				},
			},
			[
				{
					alertId: 'tornado-gap-1',
					stateCodes: ['KY'],
					countyCodes: ['001'],
					event: 'Tornado Warning',
					areaDesc: 'Test County, KY',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const sharedTimestamp = await goodEnv.WEATHER_KV.get('fb:last-post-timestamp');
		expect(sharedTimestamp).toBeTruthy();
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '2026-04-02T18:30:00.000Z');

		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...AND NORTHERN MISSOURI...',
						'',
						'...SUMMARY...',
						'Severe thunderstorms are expected across southern Iowa and northern Missouri tomorrow afternoon into evening.',
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T06:02:00+00:00' } }],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com')) {
				return new Response(JSON.stringify({ id: 'should-not-post' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const result = await runSpcCoverageForDay(
			goodEnv,
			2,
			Date.parse('2026-04-02T18:35:00.000Z'),
		);

		expect(result.error).toBeNull();
		expect(result.plannedOutputMode).toBe('post');
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes('graph.facebook.com'))).toBe(true);
	});

	it('saves the facebook auto-post mode and renders it selected on admin refresh', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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

		const saveRequest = new IncomingRequest('https://live-weather.example/admin/auto-post-config', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: cookie,
			},
			body: JSON.stringify({ mode: 'smart_high_impact' }),
		});
		const saveCtx = createExecutionContext();
		const saveResponse = await worker.fetch(saveRequest, goodEnv as any, saveCtx);
		await waitOnExecutionContext(saveCtx);
		expect(saveResponse.status).toBe(200);
		const savePayload = await saveResponse.json() as any;
		expect(savePayload.success).toBe(true);
		expect(savePayload.config.mode).toBe('smart_high_impact');

		const storedConfigRaw = await goodEnv.WEATHER_KV.get('fb:auto-post-config');
		expect(storedConfigRaw).toBeTruthy();
		expect(JSON.parse(storedConfigRaw || '{}').mode).toBe('smart_high_impact');

		const pageRequest = new IncomingRequest('https://live-weather.example/admin', {
			headers: { Cookie: cookie },
		});
		const pageCtx = createExecutionContext();
		const pageResponse = await worker.fetch(pageRequest, goodEnv as any, pageCtx);
		await waitOnExecutionContext(pageCtx);
		expect(pageResponse.status).toBe(200);
		const body = await pageResponse.text();
		expect(body).toContain('Auto-post mode');
		expect(body).toContain('id="autoPostMode"');
		expect(body).toContain('<option value="smart_high_impact" selected>');
	});

	it('auto-posts updated tornado warnings as Facebook comments during the scheduled sync', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'tornado_only',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('alerts:lifecycle-snapshot:v1', JSON.stringify({
			'alert-1': {
				alertId: 'alert-1',
				stateCodes: ['KY'],
				countyCodes: ['001'],
				event: 'Tornado Warning',
				areaDesc: 'Test County',
				lat: 37.17,
				lon: -83.28,
				headline: 'Test tornado warning',
				description: 'Previous tornado warning details',
				instruction: '',
				severity: 'Severe',
				urgency: '',
				certainty: '',
				updated: '',
				expires: '2026-03-29T23:00:00-04:00',
				lastChangeType: 'new',
				lastChangedAt: '2026-03-29T20:00:00.000Z',
			},
		}));
		await goodEnv.WEATHER_KV.put('thread:KYC001:tornado_warning', JSON.stringify({
			postId: 'existing-post-1',
			nwsAlertId: 'alert-1',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			county: 'Test County',
			alertType: 'Tornado Warning',
			updateCount: 1,
		}));

		const ctx = createExecutionContext();
		await worker.scheduled(
			{
				cron: '*/2 * * * *',
				scheduledTime: Date.now(),
			} as any,
			goodEnv as any,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(
			(globalThis.fetch as any).mock.calls.some(([input]) =>
				String(input).includes('/existing-post-1/comments'),
			),
		).toBe(true);

		const threadRaw = await goodEnv.WEATHER_KV.get('thread:KYC001:tornado_warning');
		expect(threadRaw).toBeTruthy();
		expect(JSON.parse(threadRaw || '{}').updateCount).toBe(2);
	});

	it('starts a new tornado thread after the auto-post comment chain limit is reached', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowIso = new Date().toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'tornado_only',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('alerts:lifecycle-snapshot:v1', JSON.stringify({
			'alert-1': {
				alertId: 'alert-1',
				stateCodes: ['KY'],
				countyCodes: ['001'],
				event: 'Tornado Warning',
				areaDesc: 'Test County',
				lat: 37.17,
				lon: -83.28,
				headline: 'Test tornado warning',
				description: 'Previous tornado warning details',
				instruction: '',
				severity: 'Severe',
				urgency: '',
				certainty: '',
				updated: '',
				expires: '2026-03-29T23:00:00-04:00',
				lastChangeType: 'new',
				lastChangedAt: '2026-03-29T20:00:00.000Z',
			},
		}));
		await goodEnv.WEATHER_KV.put('thread:KYC001:tornado_warning', JSON.stringify({
			postId: 'existing-post-1',
			nwsAlertId: 'alert-1',
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			county: 'Test County',
			alertType: 'Tornado Warning',
			updateCount: 3,
			lastPostedAt: nowIso,
		}));

		const ctx = createExecutionContext();
		await worker.scheduled(
			{
				cron: '*/2 * * * *',
				scheduledTime: Date.now(),
			} as any,
			goodEnv as any,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(
			(globalThis.fetch as any).mock.calls.some(([input]) =>
				String(input).includes('/existing-post-1/comments'),
			),
		).toBe(true);

		const threadRaw = await goodEnv.WEATHER_KV.get('thread:KYC001:tornado_warning');
		expect(threadRaw).toBeTruthy();
		const nextThread = JSON.parse(threadRaw || '{}');
		expect(nextThread.postId).toBe('12345');
		expect(nextThread.updateCount).toBe(0);
	});

	it('normalizes legacy boolean auto-post config to tornado-only mode', () => {
		expect(__testing.normalizeFbAutoPostConfig(true).mode).toBe('tornado_only');
		expect(__testing.normalizeFbAutoPostConfig(false).mode).toBe('off');
	});

	it('applies deterministic tiered standalone alert rules in smart_high_impact mode', async () => {
		const tornadoDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'tw-rural',
				properties: {
					event: 'Tornado Warning',
					areaDesc: 'Leslie County',
					geocode: { UGC: ['KYC131'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'tw-rural',
				stateCodes: ['KY'],
				countyCodes: ['131'],
				event: 'Tornado Warning',
				areaDesc: 'Leslie County',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(tornadoDecision.eligible).toBe(true);
		expect(tornadoDecision.reason).toBe('all_tornado_warnings');

		const freezeDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'freeze-tier3',
				properties: {
					event: 'Freeze Warning',
					areaDesc: 'Northern Utah Valleys',
					geocode: { UGC: ['UTZ101'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'freeze-tier3',
				stateCodes: ['UT'],
				countyCodes: ['001', '003', '005'],
				event: 'Freeze Warning',
				areaDesc: 'Northern Utah Valleys',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(freezeDecision.eligible).toBe(false);
		expect(freezeDecision.reason).toBe('tier3_minor_hazard');

		const floodDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'flood-10',
				properties: {
					event: 'Flood Warning',
					areaDesc: 'Ten county flood warning',
					geocode: {
						UGC: ['WYC001', 'WYC003', 'WYC005', 'WYC007', 'WYC009', 'WYC011', 'WYC013', 'WYC015', 'WYC017', 'WYC019'],
					},
					description: 'Flooding is occurring with water over roads and several road closures likely through tonight.',
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'flood-10',
				stateCodes: ['WY'],
				countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019'],
				event: 'Flood Warning',
				areaDesc: 'Ten county flood warning',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(floodDecision.eligible).toBe(true);
		expect(floodDecision.countyCount).toBe(10);
		expect(floodDecision.reason).toBe('tier2_flood_warning');

		const winterDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'winter-10',
				properties: {
					event: 'Winter Storm Warning',
					areaDesc: 'Ten county winter warning',
					geocode: {
						UGC: ['WYC021', 'WYC023', 'WYC025', 'WYC027', 'WYC029', 'WYC031', 'WYC033', 'WYC035', 'WYC037', 'WYC039'],
					},
					description: 'Snow accumulations of 8 to 12 inches and dangerous travel are expected through the passes.',
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'winter-10',
				stateCodes: ['WY'],
				countyCodes: ['021', '023', '025', '027', '029', '031', '033', '035', '037', '039'],
				event: 'Winter Storm Warning',
				areaDesc: 'Ten county winter warning',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(winterDecision.eligible).toBe(true);
		expect(winterDecision.reason).toBe('tier2_winter_warning');

		const highWindDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'wind-10',
				properties: {
					event: 'High Wind Warning',
					areaDesc: 'Ten county high wind warning',
					geocode: {
						UGC: ['WYC101', 'WYC103', 'WYC105', 'WYC107', 'WYC109', 'WYC111', 'WYC113', 'WYC115', 'WYC117', 'WYC119'],
					},
					description: 'West winds 30 to 40 mph with gusts up to 70 mph. Downed trees and scattered power outages are possible.',
					parameters: { maxWindGust: ['70 mph'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'wind-10',
				stateCodes: ['WY'],
				countyCodes: ['101', '103', '105', '107', '109', '111', '113', '115', '117', '119'],
				event: 'High Wind Warning',
				areaDesc: 'Ten county high wind warning',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(highWindDecision.eligible).toBe(true);
		expect(highWindDecision.reason).toBe('tier2_high_wind_warning');

		const redFlagDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'red-flag-rural',
				properties: {
					event: 'Red Flag Warning',
					areaDesc: 'Cimarron; Texas; Beaver; Dallam; Sherman; Hansford; Ochiltree; Lipscomb; Hartley; Moore',
					geocode: {
						UGC: ['OKC025', 'OKC139', 'OKC007', 'TXC111', 'TXC357', 'TXC195', 'TXC295', 'TXC421', 'TXC205', 'TXC341'],
					},
					headline: 'Red Flag Warning issued by NWS Amarillo TX',
					description: 'Critical fire weather conditions are no longer being met and the warning will be allowed to expire.',
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'red-flag-rural',
				stateCodes: ['OK', 'TX'],
				countyCodes: ['025', '139', '007', '111', '357', '195', '295', '421', '205', '341'],
				event: 'Red Flag Warning',
				areaDesc: 'Panhandles',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(redFlagDecision.eligible).toBe(false);
		expect(redFlagDecision.reason).toBe('fire_family_not_escalated');

		const redFlagEscalatedDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'red-flag-evac',
				properties: {
					event: 'Red Flag Warning',
					areaDesc: 'Rural county',
					geocode: { UGC: ['KSC025'] },
					headline: 'Red Flag Warning with public safety impacts',
					description: 'An active wildfire is impacting homes and public safety evacuations are underway.',
					instruction: 'Evacuate immediately.',
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'red-flag-evac',
				stateCodes: ['KS'],
				countyCodes: ['025'],
				event: 'Red Flag Warning',
				areaDesc: 'Rural county',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(redFlagEscalatedDecision.eligible).toBe(true);
		expect(redFlagEscalatedDecision.reason).toBe('fire_family_escalation');

		const metroSevereDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'svr-metro-low',
				properties: {
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Dallas County',
					geocode: { UGC: ['TXC113'] },
					parameters: { maxWindGust: ['60'], maxHailSize: ['1.00'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'svr-metro-low',
				stateCodes: ['TX'],
				countyCodes: ['113'],
				event: 'Severe Thunderstorm Warning',
				areaDesc: 'Dallas County',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(metroSevereDecision.eligible).toBe(false);
		expect(metroSevereDecision.reason).toBe('severe_thunderstorm_below_threshold');

		const metroSevereStrongDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'svr-metro-strong',
				properties: {
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Dallas County',
					geocode: { UGC: ['TXC113'] },
					parameters: { maxWindGust: ['65'], maxHailSize: ['1.75'] },
					description: 'A dangerous storm with considerable damage is possible as it moves across Dallas County.',
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'svr-metro-strong',
				stateCodes: ['TX'],
				countyCodes: ['113'],
				event: 'Severe Thunderstorm Warning',
				areaDesc: 'Dallas County',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(metroSevereStrongDecision.eligible).toBe(true);
		expect(metroSevereStrongDecision.reason).toBe('tier2_severe_thunderstorm_warning');

		const tenCountySevereDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'svr-10-county',
				properties: {
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Ten county severe warning',
					geocode: {
						UGC: ['WYC041', 'WYC043', 'WYC045', 'WYC047', 'WYC049', 'WYC051', 'WYC053', 'WYC055', 'WYC057', 'WYC059'],
					},
					parameters: { maxHailSize: ['2.00'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'svr-10-county',
				stateCodes: ['WY'],
				countyCodes: ['041', '043', '045', '047', '049', '051', '053', '055', '057', '059'],
				event: 'Severe Thunderstorm Warning',
				areaDesc: 'Ten county severe warning',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(tenCountySevereDecision.eligible).toBe(true);
		expect(tenCountySevereDecision.reason).toBe('tier2_severe_thunderstorm_warning');

		const watchDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'watch-1',
				properties: {
					event: 'Severe Thunderstorm Watch',
					areaDesc: 'Dallas-Fort Worth Metroplex',
					geocode: { UGC: ['TXC113'] },
					sent: new Date().toISOString(),
					expires: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'watch-1',
				stateCodes: ['TX'],
				countyCodes: ['113'],
				event: 'Severe Thunderstorm Watch',
				areaDesc: 'Dallas-Fort Worth Metroplex',
				changedAt: new Date().toISOString(),
				changeType: 'new',
			},
		);
		expect(watchDecision.eligible).toBe(false);
		expect(watchDecision.reason).toBe('not_warning');

		const staleTornadoDecision = await __testing.evaluateFacebookAutoPostDecision(
			env as any,
			'smart_high_impact',
			{
				id: 'tw-stale',
				properties: {
					event: 'Tornado Warning',
					areaDesc: 'Old Tornado Warning',
					geocode: { UGC: ['KYC131'] },
					sent: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
					expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
				},
			},
			{
				alertId: 'tw-stale',
				stateCodes: ['KY'],
				countyCodes: ['131'],
				event: 'Tornado Warning',
				areaDesc: 'Old Tornado Warning',
				changedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
				changeType: 'new',
			},
		);
		expect(staleTornadoDecision.eligible).toBe(false);
		expect(staleTornadoDecision.reason).toBe('stale_alert');
	});

	it('does not create relative severe-weather fallback promotions under deterministic rules', async () => {
		const nowIso = new Date().toISOString();
		const futureIso = new Date(Date.now() + 45 * 60 * 1000).toISOString();

		const overrides = await __testing.selectSevereWeatherFallbackOverrides(env as any, [
			{
				feature: {
					id: 'nyc-watch',
					properties: {
						event: 'Severe Thunderstorm Watch',
						geocode: { UGC: ['NYC061'] },
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'nyc-watch',
					stateCodes: ['NY'],
					countyCodes: ['061'],
					event: 'Severe Thunderstorm Watch',
					areaDesc: 'New York metro',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: false,
					threadAction: '',
					reason: 'not_warning',
					mode: 'smart_high_impact',
					matchedMetroNames: ['New York City'],
					countyCount: 5,
				},
				event: 'Severe Thunderstorm Watch',
				matchedMetroNames: ['New York City'],
				countyCount: 5,
			},
			{
				feature: {
					id: 'dfw-warning',
					properties: {
						event: 'Severe Thunderstorm Warning',
						geocode: { UGC: ['TXC113'] },
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'dfw-warning',
					stateCodes: ['TX'],
					countyCodes: ['113'],
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Dallas County',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: false,
					threadAction: '',
					reason: 'severe_thunderstorm_below_threshold',
					mode: 'smart_high_impact',
					matchedMetroNames: ['Dallas-Fort Worth'],
					countyCount: 1,
				},
				event: 'Severe Thunderstorm Warning',
				matchedMetroNames: ['Dallas-Fort Worth'],
				countyCount: 1,
			},
			{
				feature: {
					id: 'regional-warning',
					properties: {
						event: 'Severe Thunderstorm Warning',
						geocode: {
							UGC: ['WYC001', 'WYC003', 'WYC005', 'WYC007', 'WYC009', 'WYC011', 'WYC013', 'WYC015', 'WYC017', 'WYC019', 'WYC021', 'WYC023'],
						},
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'regional-warning',
					stateCodes: ['WY'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019', '021', '023'],
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Regional severe weather',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: true,
					threadAction: '',
					reason: 'ten_county_warning',
					mode: 'smart_high_impact',
					matchedMetroNames: [],
					countyCount: 12,
				},
				event: 'Severe Thunderstorm Warning',
				matchedMetroNames: [],
				countyCount: 12,
			},
		]);

		expect(overrides.size).toBe(0);
	});

	it('caps lower-tier standalone alert posts at four per hour while still allowing same-story comments', async () => {
		const goodEnv = {
			...env,
			FB_PAGE_ID: '1097328350123101',
			FB_PAGE_ACCESS_TOKEN: 'dummy-token',
		};
		const nowMs = Date.now();
		const nowIso = new Date(nowMs).toISOString();
		const expiresIso = new Date(nowMs + 2 * 60 * 60 * 1000).toISOString();
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('fb:auto-post:standalone-history:v1', JSON.stringify({
			postTimestamps: [0, 1, 2, 3].map((offset) => new Date(nowMs - offset * 10 * 60 * 1000).toISOString()),
			updatedAt: nowIso,
		}));
		await goodEnv.WEATHER_KV.put('thread:CAZ401:high_wind_warning', JSON.stringify({
			postId: 'cap-existing-post',
			nwsAlertId: 'prior-cap-alert',
			expiresAt: Math.floor(Date.parse(expiresIso) / 1000),
			county: 'Comment corridor',
			alertType: 'High Wind Warning',
			updateCount: 1,
			lastPostedAt: new Date(nowMs - 20 * 60 * 1000).toISOString(),
			lastPostedSnapshot: __testing.buildAlertPostedSnapshot({
				event: 'High Wind Warning',
				areaDesc: 'Comment corridor',
				headline: 'Earlier High Wind Warning coverage',
				description: 'Earlier high wind impacts were expected across the corridor.',
				instruction: 'Use caution.',
				severity: 'Severe',
				expires: expiresIso,
				senderName: 'NWS Reno NV',
				geocode: { UGC: ['CAZ401'] },
			}),
		}));

		await __testing.autoPostFacebookAlerts(
			goodEnv as any,
			{
				'wind-cap-comment': {
					id: 'wind-cap-comment',
					properties: {
						event: 'High Wind Warning',
						severity: 'Severe',
						areaDesc: 'Comment corridor',
						senderName: 'NWS Reno NV',
						headline: 'High Wind Warning continues for the Comment corridor',
						description: 'West winds 30 to 40 mph with gusts up to 70 mph. Downed trees and scattered power outages are possible.',
						instruction: 'Avoid travel in exposed areas.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: { UGC: ['CAZ401'] },
						parameters: { maxWindGust: ['70 mph'] },
					},
				},
				'wind-cap-skip': {
					id: 'wind-cap-skip',
					properties: {
						event: 'High Wind Warning',
						severity: 'Severe',
						areaDesc: 'Skip corridor',
						senderName: 'NWS Reno NV',
						headline: 'High Wind Warning for the Skip corridor',
						description: 'West winds 30 to 40 mph with gusts up to 70 mph. Downed trees and scattered power outages are possible.',
						instruction: 'Avoid travel in exposed areas.',
						sent: nowIso,
						updated: nowIso,
						effective: nowIso,
						expires: expiresIso,
						geocode: { UGC: ['NVZ402'] },
						parameters: { maxWindGust: ['70 mph'] },
					},
				},
			},
			[
				{
					alertId: 'wind-cap-comment',
					stateCodes: ['CA'],
					countyCodes: ['401', '403', '405', '407', '409', '411', '413', '415', '417', '419'],
					event: 'High Wind Warning',
					areaDesc: 'Comment corridor',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
				{
					alertId: 'wind-cap-skip',
					stateCodes: ['NV'],
					countyCodes: ['421', '423', '425', '427', '429', '431', '433', '435', '437', '439'],
					event: 'High Wind Warning',
					areaDesc: 'Skip corridor',
					changedAt: nowIso,
					changeType: 'new',
					severity: 'Severe',
				},
			],
		);

		const postCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/feed') || String(input).includes('/photos'),
		);
		const commentCalls = (globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
			String(input).includes('/cap-existing-post/comments'),
		);
		expect(postCalls.length).toBe(0);
		expect(commentCalls.length).toBe(1);

		const commentThreadRaw = await goodEnv.WEATHER_KV.get('thread:CAZ401:high_wind_warning');
		expect(commentThreadRaw).toBeTruthy();
		expect(JSON.parse(commentThreadRaw || '{}').updateCount).toBe(2);

		const skippedThreadRaw = await goodEnv.WEATHER_KV.get('thread:NVZ402:high_wind_warning');
		expect(skippedThreadRaw).toBeNull();

		const historyRaw = await goodEnv.WEATHER_KV.get('fb:auto-post:standalone-history:v1');
		expect(historyRaw).toBeTruthy();
		expect(JSON.parse(historyRaw || '{}').postTimestamps).toHaveLength(4);
	});

	it('returns no fallback overrides even when tornado warnings are active in the same batch', async () => {
		const nowIso = new Date().toISOString();
		const futureIso = new Date(Date.now() + 45 * 60 * 1000).toISOString();

		const overrides = await __testing.selectSevereWeatherFallbackOverrides(env as any, [
			{
				feature: {
					id: 'nyc-watch',
					properties: {
						event: 'Severe Thunderstorm Watch',
						geocode: { UGC: ['NYC061'] },
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'nyc-watch',
					stateCodes: ['NY'],
					countyCodes: ['061'],
					event: 'Severe Thunderstorm Watch',
					areaDesc: 'New York metro',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: false,
					threadAction: '',
					reason: 'not_warning',
					mode: 'smart_high_impact',
					matchedMetroNames: ['New York City'],
					countyCount: 5,
				},
				event: 'Severe Thunderstorm Watch',
				matchedMetroNames: ['New York City'],
				countyCount: 5,
			},
			{
				feature: {
					id: 'regional-warning',
					properties: {
						event: 'Severe Thunderstorm Warning',
						geocode: {
							UGC: ['WYC001', 'WYC003', 'WYC005', 'WYC007', 'WYC009', 'WYC011', 'WYC013', 'WYC015', 'WYC017', 'WYC019'],
						},
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'regional-warning',
					stateCodes: ['WY'],
					countyCodes: ['001', '003', '005', '007', '009', '011', '013', '015', '017', '019'],
					event: 'Severe Thunderstorm Warning',
					areaDesc: 'Regional severe weather',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: true,
					threadAction: '',
					reason: 'ten_county_warning',
					mode: 'smart_high_impact',
					matchedMetroNames: [],
					countyCount: 10,
				},
				event: 'Severe Thunderstorm Warning',
				matchedMetroNames: [],
				countyCount: 10,
			},
			{
				feature: {
					id: 'tornado-live',
					properties: {
						event: 'Tornado Warning',
						geocode: { UGC: ['KYC131'] },
						sent: nowIso,
						expires: futureIso,
					},
				},
				change: {
					alertId: 'tornado-live',
					stateCodes: ['KY'],
					countyCodes: ['131'],
					event: 'Tornado Warning',
					areaDesc: 'Leslie County',
					changedAt: nowIso,
					changeType: 'new',
				},
				decision: {
					eligible: true,
					threadAction: '',
					reason: 'all_tornado_warnings',
					mode: 'smart_high_impact',
					matchedMetroNames: [],
					countyCount: 1,
				},
				event: 'Tornado Warning',
				matchedMetroNames: [],
				countyCount: 1,
			},
		]);

		expect(overrides.size).toBe(0);
	});

	it('ranks facebook post candidates from highest-likelihood auto-posts to low-likelihood alerts', () => {
		const nowIso = new Date().toISOString();
		const futureIso = new Date(Date.now() + 45 * 60 * 1000).toISOString();

		const rankings = __testing.buildAdminFacebookPostRankings([
			{
				id: 'tw-top',
				properties: {
					event: 'Tornado Warning',
					areaDesc: 'Leslie County',
					geocode: { UGC: ['KYC131'] },
					sent: nowIso,
					expires: futureIso,
				},
			},
			{
				id: 'flood-mid',
				properties: {
					event: 'Flood Warning',
					areaDesc: 'Regional flood warning',
					geocode: {
						UGC: ['WYC001', 'WYC003', 'WYC005', 'WYC007', 'WYC009', 'WYC011', 'WYC013', 'WYC015', 'WYC017', 'WYC019'],
					},
					sent: nowIso,
					expires: futureIso,
				},
			},
			{
				id: 'red-flag-low',
				properties: {
					event: 'Red Flag Warning',
					areaDesc: 'Dry counties',
					geocode: {
						UGC: ['TXC111', 'TXC195', 'TXC205', 'TXC295', 'TXC341', 'TXC357', 'TXC421', 'OKC007', 'OKC025', 'OKC139'],
					},
					description: 'Dry and windy conditions continue, but no active incident impacts are reported.',
					sent: nowIso,
					expires: futureIso,
				},
			},
		]);

		expect(rankings[0].alertId).toBe('tw-top');
		expect(rankings[0].bucket).toBe('post_now');
		expect(rankings[1].alertId).toBe('flood-mid');
		expect(rankings[2].alertId).toBe('red-flag-low');
		expect(rankings[2].bucket).toBe('manual_review');
	});

	it('suppresses monitoring-only test alerts from website and admin surfaces', () => {
		expect(__testing.shouldSuppressAlertFromUi({
			id: 'test-msg-1',
			properties: {
				event: 'TEST MESSAGE',
				areaDesc: 'Montgomery',
				description: 'Monitoring message only. Please disregard.',
				instruction: 'Monitoring message only. Please disregard.',
				status: 'Actual',
			},
		})).toBe(true);

		expect(__testing.shouldSuppressAlertFromUi({
			id: 'real-alert-1',
			properties: {
				event: 'Flood Warning',
				areaDesc: 'Jefferson County',
				description: 'Flooding is ongoing.',
				status: 'Actual',
			},
		})).toBe(false);
	});

	it('weights winter and land-based watch/advisory products above marine alerts in facebook rankings', () => {
		const nowIso = new Date().toISOString();
		const longFutureIso = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();

		const rankings = __testing.buildAdminFacebookPostRankings([
			{
				id: 'winter-watch',
				properties: {
					event: 'Winter Storm Watch',
					areaDesc: 'Large inland winter watch',
					geocode: {
						UGC: ['WYC001', 'WYC003', 'WYC005', 'WYC007', 'WYC009', 'WYC011', 'WYC013', 'WYC015', 'WYC017', 'WYC019'],
					},
					description: 'Significant winter travel impacts are possible with hazardous roads and widespread snow.',
					sent: nowIso,
					expires: longFutureIso,
				},
			},
			{
				id: 'winter-advisory',
				properties: {
					event: 'Winter Weather Advisory',
					areaDesc: 'One county winter advisory',
					geocode: { UGC: ['KYC111'] },
					description: 'Slippery roads are possible during the morning commute.',
					sent: nowIso,
					expires: longFutureIso,
				},
			},
			{
				id: 'rip-current',
				properties: {
					event: 'Rip Current Statement',
					areaDesc: 'Miami-Dade County beaches',
					geocode: { UGC: ['FLC086'] },
					description: 'Dangerous surf and rip currents are expected at area beaches.',
					sent: nowIso,
					expires: longFutureIso,
				},
			},
			{
				id: 'gale-watch',
				properties: {
					event: 'Gale Watch',
					areaDesc: 'Lake Superior open waters',
					description: 'Offshore waters may see strong northwest winds.',
					sent: nowIso,
					expires: longFutureIso,
				},
			},
			{
				id: 'small-craft',
				properties: {
					event: 'Small Craft Advisory',
					areaDesc: 'Atlantic coastal waters offshore',
					description: 'Hazardous conditions for small craft across offshore waters.',
					sent: nowIso,
					expires: longFutureIso,
				},
			},
		]);

		const byId = new Map(rankings.map((item) => [item.alertId, item]));
		expect(byId.get('winter-watch')?.score).toBeGreaterThanOrEqual(210);
		expect(byId.get('winter-watch')?.bucket).toBe('manual_review');
		expect(byId.get('winter-watch')?.score).toBeGreaterThan(byId.get('winter-advisory')?.score ?? 0);
		expect(byId.get('winter-advisory')?.score).toBeGreaterThan(byId.get('small-craft')?.score ?? 0);
		expect(byId.get('rip-current')?.score).toBeGreaterThan(byId.get('small-craft')?.score ?? 0);
		expect(byId.get('gale-watch')?.score).toBeLessThan(180);
		expect(byId.get('small-craft')?.score).toBeLessThan(170);
	});

	it('caps niche hazards and keeps wind advisory relevance above rip current and special weather statement', () => {
		const nowIso = new Date().toISOString();
		const futureIso = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();

		const rankings = __testing.buildAdminFacebookPostRankings([
			{
				id: 'wind-advisory-ne',
				properties: {
					event: 'Wind Advisory',
					areaDesc: 'Seventeen Nebraska counties',
					geocode: {
						UGC: ['NEC001', 'NEC003', 'NEC005', 'NEC007', 'NEC009', 'NEC011', 'NEC013', 'NEC015', 'NEC017', 'NEC019', 'NEC021', 'NEC023', 'NEC025', 'NEC027', 'NEC029', 'NEC031', 'NEC033'],
					},
					description: 'Travel may be difficult for high-profile vehicles on open roads across the region.',
					sent: nowIso,
					expires: futureIso,
				},
			},
			{
				id: 'rip-current-pr',
				properties: {
					event: 'Rip Current Statement',
					areaDesc: 'Northwest Puerto Rico beaches',
					geocode: {
						UGC: ['PRC001', 'PRC003', 'PRC005', 'PRC007', 'PRC009', 'PRC011', 'PRC013', 'PRC015', 'PRC017', 'PRC019', 'PRC021', 'PRC023', 'PRC025', 'PRC027', 'PRC029', 'PRC031', 'PRC033', 'PRC035', 'PRC037', 'PRC039', 'PRC041', 'PRC043', 'PRC045', 'PRC047', 'PRC049', 'PRC051', 'PRC053', 'PRC054', 'PRC055', 'PRC057', 'PRC059', 'PRC061', 'PRC063', 'PRC065', 'PRC067'],
					},
					description: 'Dangerous rip currents are expected along area beaches in Puerto Rico.',
					sent: nowIso,
					expires: futureIso,
				},
			},
			{
				id: 'special-statement',
				properties: {
					event: 'Special Weather Statement',
					areaDesc: 'One Wisconsin county',
					geocode: { UGC: ['WIC001'] },
					description: 'Brief showers are possible in the area.',
					sent: nowIso,
					expires: futureIso,
				},
			},
		]);

		const byId = new Map(rankings.map((item) => [item.alertId, item]));
		expect(byId.get('wind-advisory-ne')?.score).toBeLessThanOrEqual(180);
		expect(byId.get('wind-advisory-ne')?.score).toBeGreaterThan(byId.get('rip-current-pr')?.score ?? 0);
		expect(byId.get('rip-current-pr')?.score).toBeLessThanOrEqual(170);
		expect(byId.get('rip-current-pr')?.score).toBeGreaterThan(byId.get('special-statement')?.score ?? 0);
		expect(byId.get('special-statement')?.score).toBeLessThanOrEqual(160);
		expect(byId.get('special-statement')?.score).toBeLessThan(150);
	});

	it('applies recency boosts and same-hazard noise suppression in the facebook rankings', () => {
		const now = Date.now();
		const freshIso = new Date(now).toISOString();
		const twoHoursAgoIso = new Date(now - 2 * 60 * 60 * 1000).toISOString();
		const fourHoursAgoIso = new Date(now - 4 * 60 * 60 * 1000).toISOString();
		const futureIso = new Date(now + 18 * 60 * 60 * 1000).toISOString();

		const rankings = __testing.buildAdminFacebookPostRankings([
			{
				id: 'statement-fresh',
				properties: {
					event: 'Special Weather Statement',
					areaDesc: 'Fresh statement',
					geocode: { UGC: ['WIC001'] },
					description: 'Brief showers are possible in the area.',
					sent: freshIso,
					expires: futureIso,
				},
			},
			{
				id: 'statement-old',
				properties: {
					event: 'Special Weather Statement',
					areaDesc: 'Old statement',
					geocode: { UGC: ['WIC003'] },
					description: 'Brief showers are possible in the area.',
					sent: fourHoursAgoIso,
					expires: futureIso,
				},
			},
			...Array.from({ length: 7 }, (_value, index) => ({
				id: `winter-cluster-${index + 1}`,
				properties: {
					event: 'Winter Weather Advisory',
					areaDesc: `Kansas advisory ${index + 1}`,
					geocode: { UGC: [`KSC${String(index + 1).padStart(3, '0')}`] },
					description: 'Slippery roads are possible during the morning commute.',
					sent: index < 4 ? freshIso : twoHoursAgoIso,
					expires: futureIso,
				},
			})),
		]);

		const byId = new Map(rankings.map((item) => [item.alertId, item]));
		expect(byId.get('statement-fresh')?.score).toBeGreaterThan(byId.get('statement-old')?.score ?? 0);

		const winterScores = rankings
			.filter((item) => item.alertId.startsWith('winter-cluster-'))
			.map((item) => item.score)
			.sort((a, b) => b - a);
		expect(winterScores.slice(0, 4).every((score) => score === 180)).toBe(true);
		expect(winterScores[4]).toBe(175);
		expect(winterScores[5]).toBe(175);
		expect(winterScores[6]).toBe(170);
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

	it('subscribes with a radius scope and writes the radius index', async () => {
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
				subscription: {
					...TEST_PUSH_SUBSCRIPTION,
					endpoint: 'https://push.example/subscription-radius',
				},
				prefs: {
					scopes: [
						{
							id: 'scope-ky-radius',
							label: 'Within 50 mi of Wooton, KY',
							stateCode: 'KY',
							deliveryScope: 'radius',
							centerLat: 37.1671,
							centerLon: -83.2913,
							radiusMiles: 50,
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
		expect(payload.prefs.scopes[0].deliveryScope).toBe('radius');
		expect(payload.prefs.scopes[0].radiusMiles).toBe(50);
		expect(payload.prefs.scopes[0].centerLat).toBe(37.1671);
		expect(payload.prefs.scopes[0].centerLon).toBe(-83.2913);

		const radiusIndexRaw = await pushEnv.WEATHER_KV.get('push:index:radius');
		expect(JSON.parse(radiusIndexRaw || '[]')).toContain(payload.subscriptionId);
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

	// ---------------------------------------------------------------------------
	// Digest coverage — unit tests
	// ---------------------------------------------------------------------------

	it('normalizeFbAutoPostConfig handles digest fields and multi-day SPC settings', () => {
		const { normalizeFbAutoPostConfig } = __testing;

		const base = normalizeFbAutoPostConfig(null);
		expect(base.digestCoverageEnabled).toBe(false);
		expect(base.digestCommentUpdatesEnabled).toBe(true);
		expect(base.digestMaxCommentsPerThread).toBe(3);
		expect(base.digestMinCommentGapMinutes).toBe(20);
		expect(base.llmCopyEnabled).toBe(false);
		expect(base.startupCatchupEnabled).toBe(false);
		expect(base.spcCoverageEnabled).toBe(false);
		expect(base.spcMinRiskLevel).toBe('slight');
		expect(base.spcDay1CoverageEnabled).toBe(false);
		expect(base.spcDay1MinRiskLevel).toBe('slight');
		expect(base.spcDay2CoverageEnabled).toBe(false);
		expect(base.spcDay2MinRiskLevel).toBe('enhanced');
		expect(base.spcDay3CoverageEnabled).toBe(false);
		expect(base.spcDay3MinRiskLevel).toBe('enhanced');
		expect(base.spcHashtagsEnabled).toBe(true);
		expect(base.spcLlmEnabled).toBe(false);
		expect(base.spcTimingRefreshEnabled).toBe(true);

		const full = normalizeFbAutoPostConfig({
			mode: 'smart_high_impact',
			updatedAt: '2026-04-01T00:00:00.000Z',
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: false,
			digestMaxCommentsPerThread: 2,
			digestMinCommentGapMinutes: 25,
			llmCopyEnabled: true,
			startupCatchupEnabled: true,
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: true,
			spcDay3MinRiskLevel: 'moderate',
			spcHashtagsEnabled: false,
			spcLlmEnabled: true,
			spcTimingRefreshEnabled: false,
		});
		expect(full.mode).toBe('smart_high_impact');
		expect(full.digestCoverageEnabled).toBe(true);
		expect(full.digestCommentUpdatesEnabled).toBe(false);
		expect(full.digestMaxCommentsPerThread).toBe(2);
		expect(full.digestMinCommentGapMinutes).toBe(25);
		expect(full.llmCopyEnabled).toBe(true);
		expect(full.startupCatchupEnabled).toBe(true);
		expect(full.spcCoverageEnabled).toBe(true);
		expect(full.spcMinRiskLevel).toBe('slight');
		expect(full.spcDay1CoverageEnabled).toBe(true);
		expect(full.spcDay1MinRiskLevel).toBe('slight');
		expect(full.spcDay2CoverageEnabled).toBe(true);
		expect(full.spcDay2MinRiskLevel).toBe('enhanced');
		expect(full.spcDay3CoverageEnabled).toBe(true);
		expect(full.spcDay3MinRiskLevel).toBe('moderate');
		expect(full.spcHashtagsEnabled).toBe(false);
		expect(full.spcLlmEnabled).toBe(true);
		expect(full.spcTimingRefreshEnabled).toBe(false);

		const legacyObject = normalizeFbAutoPostConfig({
			mode: 'off',
			spcCoverageEnabled: true,
			spcMinRiskLevel: 'enhanced',
		});
		expect(legacyObject.spcCoverageEnabled).toBe(true);
		expect(legacyObject.spcMinRiskLevel).toBe('enhanced');
		expect(legacyObject.spcDay1CoverageEnabled).toBe(true);
		expect(legacyObject.spcDay1MinRiskLevel).toBe('enhanced');
		expect(legacyObject.spcDay2CoverageEnabled).toBe(false);

		// Legacy boolean format still works and defaults new fields to false
		const legacy = normalizeFbAutoPostConfig(true);
		expect(legacy.mode).toBe('tornado_only');
		expect(legacy.digestCoverageEnabled).toBe(false);
		expect(legacy.digestCommentUpdatesEnabled).toBe(true);
		expect(legacy.digestMaxCommentsPerThread).toBe(3);
		expect(legacy.digestMinCommentGapMinutes).toBe(20);
		expect(legacy.spcCoverageEnabled).toBe(false);
		expect(legacy.spcDay2CoverageEnabled).toBe(false);
		expect(legacy.spcDay3CoverageEnabled).toBe(false);
	});

	it('parseSpcDay1OutlookPage and buildSpcDay1OutlookSummary normalize a Day 1 severe setup', async () => {
		const { parseSpcDay1OutlookPage, buildSpcDay1OutlookSummary } = __testing as any;
		const html = [
			'<html>',
			'<head><title>Storm Prediction Center Apr 2, 2026 1300 UTC Day 1 Convective Outlook</title></head>',
			"<body onload=\"changeOverlay(); updateCookies(); show_tab('otlk_1300')\">",
			'<div>Updated:&nbsp;Thu Apr 2 12:56:18 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
			'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
			'<pre>' + [
				'SPC AC 021256',
				'',
				'Day 1 Convective Outlook',
				'NWS Storm Prediction Center Norman OK',
				'0756 AM CDT Thu Apr 02 2026',
				'',
				'Valid 021300Z - 031200Z',
				'',
				'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...AND SOUTHERN WISCONSIN...',
				'',
				'...SUMMARY...',
				'Fast-moving supercells capable of producing several tornadoes are expected across eastern Iowa, northern Illinois, and southern Wisconsin this afternoon.',
				'',
				'...Eastern Iowa, Northern Illinois, and Southern Wisconsin...',
				'Tornado potential will be the main concern, though damaging winds are also possible.',
				'A few supercells may develop before storms grow into a line later today.',
			].join('\n') + '</pre>',
			'</body>',
			'</html>',
		].join('');

		const page = parseSpcDay1OutlookPage(html, {
			id: 'day1',
			label: 'Day 1',
			pageUrl: 'https://www.spc.noaa.gov/products/outlook/day1otlk.html',
			imagePrefix: 'day1',
		});
		const summary = await buildSpcDay1OutlookSummary(page, {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: {
						LABEL: 'TSTM',
						VALID_ISO: '2026-04-02T13:00:00+00:00',
						EXPIRE_ISO: '2026-04-03T12:00:00+00:00',
						ISSUE_ISO: '2026-04-02T12:56:00+00:00',
					},
				},
				{
					type: 'Feature',
					geometry: {
						type: 'MultiPolygon',
						coordinates: [
							[[[-91.7, 42.0], [-91.1, 42.0], [-91.1, 42.5], [-91.7, 42.5], [-91.7, 42.0]]],
							[[[-89.5, 41.8], [-88.8, 41.8], [-88.8, 42.2], [-89.5, 42.2], [-89.5, 41.8]]],
							[[[-89.9, 42.8], [-89.2, 42.8], [-89.2, 43.3], [-89.9, 43.3], [-89.9, 42.8]]],
						],
					},
					properties: {
						LABEL: 'ENH',
						VALID_ISO: '2026-04-02T13:00:00+00:00',
						EXPIRE_ISO: '2026-04-03T12:00:00+00:00',
						ISSUE_ISO: '2026-04-02T12:56:00+00:00',
					},
				},
			],
		});

		expect(summary.highestRiskLevel).toBe('enhanced');
		expect(summary.highestRiskNumber).toBe(3);
		expect(summary.affectedStates).toEqual(['IA', 'IL', 'WI']);
		expect(summary.stateFocusText).toBe('Eastern Iowa, Northern Illinois, and Southern Wisconsin');
		expect(summary.primaryAreaSource).toBe('geojson');
		expect(summary.primaryRegion).toBe('Midwest');
		expect(summary.hazardFocus).toBe('tornado');
		expect(summary.hazardList).toEqual(['tornadoes', 'damaging winds']);
		expect(summary.primaryHazards).toEqual(['tornadoes']);
		expect(summary.secondaryHazards).toEqual(['damaging winds']);
		expect(summary.stormMode).toBe('fast-moving supercells');
		expect(summary.stormEvolution).toBe(true);
		expect(summary.stormEvolutionText).toContain('before storms organize into a line of storms later on');
		expect(summary.riskAreas?.enhanced).toEqual(['IA', 'IL', 'WI']);
		expect(summary.timingText).toBe('this afternoon');
		expect(summary.imageUrl).toBe('https://www.spc.noaa.gov/products/outlook/day1otlk_1300.png');
		expect(summary.summaryHash).toHaveLength(64);
	});

	it('selectSpcPrimaryRiskArea keeps an IA/MO/IL enhanced core from drifting into Southern Plains framing', async () => {
		const { buildSpcOutlookSummary, selectSpcPrimaryRiskArea } = __testing as any;
		const page = {
			title: 'Day 2 Convective Outlook',
			updated: 'Thu Apr 02 12:56:18 UTC 2026',
			issuedLabel: '0756 AM CDT Thu Apr 02 2026',
			summary: 'A focused severe weather corridor is expected from southern Iowa into northern Missouri and western Illinois. A broader severe line may extend later into eastern Oklahoma and north Texas.',
			discussionText: 'Early storms should focus from southern Iowa into northern Missouri and western Illinois before the line extends south and west later in the period into eastern Oklahoma and north Texas.',
			pageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk.html',
			imageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk_0600.png',
			headlineText: 'THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...NORTHERN MISSOURI...AND WESTERN ILLINOIS...',
			sectionHeadings: ['Southern Iowa, Northern Missouri, and Western Illinois'],
			timingText: 'late afternoon into evening',
		};

		const story = selectSpcPrimaryRiskArea(page, ['IA', 'MO', 'IL']);
		expect(story.primaryStates).toEqual(['IA', 'MO', 'IL']);
		expect(story.primaryFocusText).toBe('Southern Iowa, Northern Missouri, and Western Illinois');
		expect(story.primaryAreaSource).toBe('geojson');
		expect(story.secondaryStates).toEqual([]);

		const summary = await buildSpcOutlookSummary(2, page, {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: {
						type: 'MultiPolygon',
						coordinates: [
							[[[-94.8, 40.8], [-94.2, 40.8], [-94.2, 41.2], [-94.8, 41.2], [-94.8, 40.8]]],
							[[[-93.8, 39.4], [-93.2, 39.4], [-93.2, 39.8], [-93.8, 39.8], [-93.8, 39.4]]],
							[[[-90.9, 40.4], [-90.3, 40.4], [-90.3, 40.8], [-90.9, 40.8], [-90.9, 40.4]]],
						],
					},
					properties: {
						LABEL: 'ENH',
						VALID_ISO: '2026-04-03T12:00:00+00:00',
						EXPIRE_ISO: '2026-04-04T12:00:00+00:00',
						ISSUE_ISO: '2026-04-02T06:00:00+00:00',
					},
				},
			],
		});

		expect(summary.affectedStates).toEqual(['IA', 'MO', 'IL']);
		expect(summary.primaryRegion).toBe('Mid-Mississippi Valley');
		expect(summary.primaryRegion).not.toBe('Southern Plains');
	});

	it('buildSpcOutlookSummary keeps discussion tail states out of the main story when the highest-risk polygon is tighter', async () => {
		const { buildSpcOutlookSummary } = __testing as any;
		const page = {
			title: 'Day 2 Convective Outlook',
			updated: 'Thu Apr 02 12:56:18 UTC 2026',
			issuedLabel: '0756 AM CDT Thu Apr 02 2026',
			summary: 'Severe thunderstorms are expected across southern Iowa, northern Missouri, and western Illinois tomorrow afternoon into evening. A broader severe line may later extend into eastern Oklahoma and north Texas.',
			discussionText: 'Early discrete storms should focus from southern Iowa into northern Missouri and western Illinois before storms organize into a line later in the period. The broader line may eventually extend toward eastern Oklahoma and north Texas.',
			pageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk.html',
			imageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk_0600.png',
			headlineText: 'THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...NORTHERN MISSOURI...AND WESTERN ILLINOIS...',
			sectionHeadings: ['Southern Iowa, Northern Missouri, and Western Illinois'],
			timingText: 'late afternoon into evening',
		};

		const summary = await buildSpcOutlookSummary(2, page, {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: {
						type: 'MultiPolygon',
						coordinates: [
							[[[-94.8, 40.8], [-94.2, 40.8], [-94.2, 41.2], [-94.8, 41.2], [-94.8, 40.8]]],
							[[[-93.8, 39.4], [-93.2, 39.4], [-93.2, 39.8], [-93.8, 39.8], [-93.8, 39.4]]],
							[[[-90.9, 40.4], [-90.3, 40.4], [-90.3, 40.8], [-90.9, 40.8], [-90.9, 40.4]]],
						],
					},
					properties: {
						LABEL: 'ENH',
						VALID_ISO: '2026-04-03T12:00:00+00:00',
						EXPIRE_ISO: '2026-04-04T12:00:00+00:00',
						ISSUE_ISO: '2026-04-02T06:00:00+00:00',
					},
				},
			],
		});

		expect(summary.affectedStates).toEqual(['IA', 'MO', 'IL']);
		expect(summary.affectedStates).not.toEqual(expect.arrayContaining(['OK', 'TX']));
		expect(summary.primaryRegion).toBe('Mid-Mississippi Valley');
		expect(summary.primaryAreaSource).toBe('geojson');
	});

	it('buildSpcPostDecision handles day-aware setup, upgrade, and timing refresh cases', () => {
		const { buildSpcPostDecision } = __testing as any;
		const config = {
			spcDay1MinRiskLevel: 'slight',
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3MinRiskLevel: 'enhanced',
			spcTimingRefreshEnabled: true,
		} as any;
		const summary = {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			outlookDay: 1,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'IL', 'WI'],
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			hazardList: ['tornadoes', 'damaging winds'],
			stormMode: 'fast-moving supercells',
			notableText: 'storms may move quickly enough to limit warning time',
			timingText: 'this afternoon',
			summaryHash: 'hash-enhanced-1',
		} as any;

		expect(buildSpcPostDecision(summary, null, config, Date.parse('2026-04-02T14:00:00Z'))).toEqual({
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'main_setup',
		});

		expect(buildSpcPostDecision({
			...summary,
			outlookDay: 2,
			issuedAt: '2026-04-02T06:00:00+00:00',
			validFrom: '2026-04-03T12:00:00+00:00',
			validTo: '2026-04-04T12:00:00+00:00',
			primaryRegion: 'Mid-South',
			affectedStates: ['AR', 'MS', 'TN'],
			summaryHash: 'hash-day2-1',
		}, null, config, Date.parse('2026-04-02T14:00:00Z'))).toEqual({
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'day2_lookahead',
		});

		expect(buildSpcPostDecision(summary, {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			postedAt: '2026-04-02T14:00:00+00:00',
			summaryHash: 'hash-slight-1',
			postId: 'post-1',
			outputMode: 'post',
			highestRiskLevel: 'slight',
			highestRiskNumber: 2,
			affectedStates: ['IA', 'IL', 'WI'],
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			tornadoProbability: null,
			windProbability: null,
			hailProbability: null,
			timingText: 'this afternoon',
			postType: 'main_setup',
			reason: 'new_slight_or_higher',
		}, config, Date.parse('2026-04-02T17:00:00Z'))).toEqual({
			shouldPost: true,
			reason: 'risk_upgrade',
			postType: 'upgrade',
		});

		expect(buildSpcPostDecision(summary, {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			postedAt: '2026-04-02T14:00:00+00:00',
			summaryHash: 'hash-enhanced-1',
			postId: 'post-1',
			outputMode: 'post',
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'IL', 'WI'],
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			tornadoProbability: null,
			windProbability: null,
			hailProbability: null,
			timingText: 'this afternoon',
			postType: 'main_setup',
			reason: 'new_slight_or_higher',
		}, config, Date.parse('2026-04-02T19:30:00Z'))).toEqual({
			shouldPost: true,
			reason: 'timing_refresh',
			postType: 'timing_refresh',
		});
	});

	it('evaluateSpcPostingSchedule enforces default windows but allows upgrade overrides', () => {
		const { evaluateSpcPostingSchedule } = __testing as any;
		const summary = {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			outlookDay: 2,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			primaryRegion: 'Midwest',
			hazardFocus: 'wind',
			hazardList: ['widespread damaging winds', 'tornadoes'],
			stormMode: 'a large squall line',
			timingText: 'late afternoon into evening',
			summaryHash: 'day2-window-hash',
		} as any;

		expect(evaluateSpcPostingSchedule(summary, {
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'day2_lookahead',
		}, null, Date.parse('2026-04-02T14:00:00Z'))).toEqual({
			allowed: false,
			reason: 'outside_window',
			windowLabel: 'day2_midday',
		});

		expect(evaluateSpcPostingSchedule(summary, {
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'day2_lookahead',
		}, null, Date.parse('2026-04-02T18:00:00Z'))).toEqual({
			allowed: true,
			reason: 'within_window',
			windowLabel: 'day2_midday',
		});

		expect(evaluateSpcPostingSchedule(summary, {
			shouldPost: true,
			reason: 'risk_upgrade',
			postType: 'upgrade',
		}, {
			outlookDay: 2,
			issuedAt: '2026-04-02T06:00:00+00:00',
			validFrom: '2026-04-03T12:00:00+00:00',
			validTo: '2026-04-04T12:00:00+00:00',
			postedAt: '2026-04-02T17:00:00+00:00',
			summaryHash: 'prev-day2-hash',
			postId: 'day2-post-1',
			outputMode: 'post',
			highestRiskLevel: 'slight',
			highestRiskNumber: 2,
			affectedStates: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			primaryRegion: 'Midwest',
			hazardFocus: 'wind',
			hazardList: ['damaging winds'],
			stormMode: 'storm clusters',
			notableText: null,
			tornadoProbability: null,
			windProbability: null,
			hailProbability: null,
			timingText: 'late afternoon into evening',
			postType: 'day2_lookahead',
			reason: 'new_slight_or_higher',
		} as any, Date.parse('2026-04-02T14:00:00Z'))).toEqual({
			allowed: true,
			reason: 'override',
			windowLabel: 'day2_midday',
		});
	});

	it('buildSpcPostText varies openings, supports comment mode, and adds optional hashtags', () => {
		const { buildSpcCommentChangeHint, buildSpcPostText } = __testing as any;
		const summary = {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			outlookDay: 1,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'IL', 'WI'],
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			hazardList: ['tornadoes', 'damaging winds'],
			primaryHazards: ['tornadoes'],
			secondaryHazards: ['damaging winds'],
			stormMode: 'fast-moving supercells',
			laterStormMode: 'a line of storms',
			stormEvolutionText: 'Fast-moving supercells may develop early before storms organize into a line of storms later on.',
			timingText: 'this afternoon',
			summaryHash: 'hash-enhanced-1',
		} as any;
		const previousSummary = {
			...summary,
			highestRiskLevel: 'slight',
			highestRiskNumber: 2,
			affectedStates: ['IA', 'IL'],
			summaryHash: 'hash-slight-1',
		} as any;

		const text = buildSpcPostText(summary, {
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'main_setup',
		}, ['This afternoon to watch across the Midwest.'], true);

		expect(text.startsWith('This afternoon to watch across the Midwest.')).toBe(false);
		expect(text).toContain('Level 3 Enhanced Risk');
		expect(text).toContain('centered on Eastern Iowa, Northern Illinois, and Southern Wisconsin');
		expect(text).toContain('Fast-moving supercells may develop early before storms organize into a line of storms later on.');
		expect(text).toContain('Tornadoes look like the main threats, with damaging winds possible.');
		expect(text).toContain('The main window looks this afternoon.');
		expect(text).toContain('#IAwx #ILwx #WIwx');

		const changeHint = buildSpcCommentChangeHint(previousSummary, summary);
		expect(changeHint).toContain('risk upgraded');
		expect(changeHint).toContain('new core states added');

		const commentText = buildSpcPostText(summary, {
			shouldPost: true,
			reason: 'risk_upgrade',
			postType: 'upgrade',
		}, [], true, 'comment', changeHint);
		expect(commentText.startsWith('UPDATE:')).toBe(true);
		expect(commentText).toContain('SPC still has a Level 3 Enhanced Risk centered on Eastern Iowa, Northern Illinois, and Southern Wisconsin.');
		expect(commentText).not.toContain('#IAwx');
	});

	it('buildSpcDay1WatchCommentText keeps overlapping watch updates brief and broad', () => {
		const { buildSpcDay1WatchCommentText } = __testing as any;
		const summary = {
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			outlookDay: 1,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'IL', 'WI'],
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			hazardList: ['tornadoes', 'damaging winds'],
			primaryHazards: ['tornadoes'],
			secondaryHazards: ['damaging winds'],
			stormMode: 'supercells',
			notableText: null,
			tornadoProbability: 10,
			windProbability: 30,
			hailProbability: null,
			timingText: 'this afternoon',
			summaryHash: 'spc-day1-hash-1',
		} as any;

		const text = buildSpcDay1WatchCommentText(summary, ['IA'], {
			expiresAt: '2026-04-02T23:00:00.000Z',
			nowMs: Date.parse('2026-04-02T18:00:00.000Z'),
		});

		expect(text).toContain('UPDATE: A Tornado Watch is now in effect for parts of Iowa');
		expect(text).toContain('Tornadoes and damaging winds will be the main concerns');
		expect(text).not.toContain('Eastern Iowa');
		expect(text).not.toContain('#IAwx');
	});

	it('selectAfdOfficesForSpcRegion prefers offices inside the SPC core and caps the selection', () => {
		const { selectAfdOfficesForSpcRegion } = __testing as any;
		const selected = selectAfdOfficesForSpcRegion({
			affectedStates: ['IA', 'IL', 'WI'],
			primaryRegion: 'Midwest',
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			summaryText: 'Fast-moving supercells are possible from eastern Iowa into northern Illinois and southern Wisconsin.',
			discussionText: 'The corridor from eastern Iowa into northern Illinois and southern Wisconsin may see the highest severe coverage.',
		}, 3);

		expect(selected.map((office: any) => office.code)).toEqual(['DVN', 'ARX', 'LOT']);
		expect(selected[0].matchedFocusKeywords).toContain('eastern iowa');
		expect(selected).toHaveLength(3);
	});

	it('extractAfdSignalFromText pulls timing, storm mode, hazard, confidence, and uncertainty cues', () => {
		const { extractAfdSignalFromText } = __testing as any;
		const signal = extractAfdSignalFromText([
			'.KEY MESSAGES...',
			'- Discrete supercells may develop late afternoon into evening before quick upscale growth takes over.',
			'- Tornado and large hail potential would be strongest with any storms that stay isolated.',
			'- Confidence is increasing in organized severe storm development, though cloud cover may limit destabilization.',
			'- Storms may move quickly and reduce warning time.',
		].join('\n'));

		expect(signal.timingHints).toContain('late afternoon into evening');
		expect(signal.stormModeHints).toEqual(expect.arrayContaining(['discrete supercells', 'quick upscale growth']));
		expect(signal.hazardEmphasis).toEqual(expect.arrayContaining(['tornado', 'large hail']));
		expect(signal.confidenceHints).toContain('confidence is increasing in organized severe storm development');
		expect(signal.uncertaintyHints).toContain('cloud cover may limit destabilization');
		expect(signal.notableBehaviorHints).toContain('storms may move quickly and reduce warning time');
	});

	it('buildSpcAfdEnrichment merges the latest selected office AFDs and tolerates failed offices', async () => {
		const { buildSpcAfdEnrichment } = __testing as any;
		(globalThis as any).fetch = vi.fn(async (input: RequestInfo) => {
			const url = String(input);
			if (url.endsWith('/products/types/AFD/locations/DVN')) {
				return new Response(JSON.stringify({
					'@graph': [{
						id: 'afd-dvn-1',
						issuanceTime: '2026-04-02T17:30:00Z',
					}],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.endsWith('/products/types/AFD/locations/DMX')) {
				return new Response(JSON.stringify({ '@graph': [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.endsWith('/products/afd-dvn-1')) {
				return new Response(JSON.stringify({
					id: 'afd-dvn-1',
					productText: [
						'.KEY MESSAGES...',
						'- Discrete supercells may develop late afternoon into evening before quick upscale growth takes over.',
						'- Tornado and large hail potential would be strongest with any storms that stay isolated.',
						'- Confidence is increasing in organized severe storm development.',
					].join('\n'),
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response('not found', { status: 404 });
		});

		const enrichment = await buildSpcAfdEnrichment({
			affectedStates: ['IA'],
			primaryRegion: 'Midwest',
			stateFocusText: 'Eastern Iowa',
			summaryText: 'Strong to severe storms are possible across eastern Iowa late today.',
			discussionText: 'Eastern Iowa remains the corridor to watch for organized severe development.',
		}, 2);

		expect(enrichment).toBeTruthy();
		expect(enrichment.selectedOffices.map((office: any) => office.code)).toEqual(['DVN', 'DMX']);
		expect(enrichment.sourceProductIds).toEqual(['afd-dvn-1']);
		expect(enrichment.failedOfficeCodes).toContain('DMX');
		expect(enrichment.timingHints).toContain('late afternoon into evening');
		expect(enrichment.hazardEmphasis).toEqual(expect.arrayContaining(['tornado', 'large hail']));
	});

	it('buildSpcPostText keeps Day 2 copy centered on the SPC core with squall-line messaging', () => {
		const { buildSpcPostText } = __testing as any;
		const summary = {
			issuedAt: '2026-04-02T06:02:00+00:00',
			validFrom: '2026-04-03T12:00:00+00:00',
			validTo: '2026-04-04T12:00:00+00:00',
			outlookDay: 2,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'MO', 'IL'],
			stateFocusText: 'Southern Iowa, Northern Missouri, and Western Illinois',
			primaryRegion: 'Mid-Mississippi Valley',
			hazardFocus: 'mixed',
			hazardList: ['large hail', 'damaging winds', 'tornadoes'],
			primaryHazards: ['large hail', 'damaging winds'],
			secondaryHazards: ['tornadoes'],
			stormMode: 'discrete supercells',
			laterStormMode: 'a large squall line',
			stormEvolutionText: 'Discrete supercells may develop early before storms organize into a large squall line later on.',
			notableText: null,
			timingText: 'late afternoon into evening',
			summaryHash: 'hash-day2-core',
		} as any;

		const text = buildSpcPostText(summary, {
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'day2_lookahead',
		}, [], true);

		expect(text).toContain('SPC has issued a Level 3 Enhanced Risk centered on Southern Iowa, Northern Missouri, and Western Illinois.');
		expect(text).toContain('Discrete supercells may develop early before storms organize into a large squall line later on.');
		expect(text).toContain('Large hail and damaging winds would be the main threats, with a few tornadoes possible.');
		expect(text).toContain('The better window looks late afternoon into evening.');
		expect(text).toContain('#IAwx #MOwx #ILwx');
		expect(text).not.toContain('Southern Plains');
	});

	it('buildSpcPostText uses AFD support hints to sharpen storm evolution and confidence wording', () => {
		const { buildSpcPostText } = __testing as any;
		const summary = {
			issuedAt: '2026-04-02T06:02:00+00:00',
			validFrom: '2026-04-03T12:00:00+00:00',
			validTo: '2026-04-04T12:00:00+00:00',
			outlookDay: 2,
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			primaryRegion: 'Midwest',
			hazardFocus: 'wind',
			hazardList: ['damaging winds', 'tornadoes'],
			stormMode: 'a squall line',
			notableText: null,
			timingText: 'late afternoon into evening',
			summaryHash: 'hash-day2-afd-support',
		} as any;

		const text = buildSpcPostText(summary, {
			shouldPost: true,
			reason: 'new_slight_or_higher',
			postType: 'day2_lookahead',
		}, [], false, 'post', null, {
			selectedOffices: [{ code: 'DVN', label: 'Quad Cities IA/IL', score: 13, matchedStateCodes: ['IA'], matchedFocusKeywords: ['eastern iowa'] }],
			sourceProductIds: ['afd-dvn-1'],
			failedOfficeCodes: [],
			fetchedAt: '2026-04-02T17:45:00.000Z',
			timingHints: ['late afternoon into evening'],
			stormModeHints: ['quick upscale growth'],
			hazardEmphasis: ['tornado'],
			uncertaintyHints: ['cloud cover may limit destabilization'],
			confidenceHints: ['confidence is increasing in organized severe storm development'],
			notableBehaviorHints: [],
		});

		expect(text).toContain('Quick upscale growth may follow once storms mature.');
		expect(text).toContain('Confidence is increasing in organized severe storm development, though cloud cover may limit destabilization.');
	});

	it('validateSpcLlmOutput rejects states outside the SPC core area', () => {
		const { buildSpcLlmPayload, validateSpcLlmOutput } = __testing as any;
		const payload = buildSpcLlmPayload({
			outputMode: 'post',
			outlookDay: 2,
			postType: 'day2_lookahead',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Mid-Mississippi Valley',
			states: ['IA', 'MO', 'IL'],
			stateFocusText: 'Southern Iowa, Northern Missouri, and Western Illinois',
			hazardFocus: 'wind',
			hazardList: ['large hail', 'damaging winds', 'tornadoes'],
			primaryHazards: ['large hail', 'damaging winds'],
			secondaryHazards: ['tornadoes'],
			hazardLine: 'large hail and damaging winds',
			stormMode: 'discrete supercells',
			stormEvolutionText: 'Discrete supercells may develop early before storms organize into a large squall line later on.',
			timingWindow: 'late afternoon into evening',
			notableText: null,
			trend: 'developing',
			recentOpenings: [],
			hashtagsEnabled: true,
		});

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Mid-Mississippi Valley. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa, northern Missouri, western Illinois, and Mississippi.',
			payload,
		).failureReason).toBe('mentions_out_of_scope_state');

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Southern Plains. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa, northern Missouri, and western Illinois. Discrete supercells may develop early before storms organize into a larger line later in the day, with large hail and damaging winds as the main threats and a few tornadoes possible.',
			payload,
		).failureReason).toBe('mentions_conflicting_region');

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Mid-Mississippi Valley. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa, northern Missouri, and western Illinois. Discrete supercells may develop early before storms organize into a larger line later on. Large hail and damaging winds look like the main threats, with a few tornadoes possible. The better window looks late afternoon into evening.',
			payload,
		).valid).toBe(true);
	});

	it('buildSpcLlmPayload and buildSpcUserPrompt include AFD hints as secondary forecast guidance', () => {
		const { buildSpcLlmPayload, buildSpcUserPrompt } = __testing as any;
		const payload = buildSpcLlmPayload({
			outputMode: 'post',
			outlookDay: 2,
			postType: 'day2_lookahead',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Mid-Mississippi Valley',
			states: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			hazardFocus: 'wind',
			hazardList: ['damaging winds', 'tornadoes'],
			primaryHazards: ['damaging winds'],
			secondaryHazards: ['tornadoes'],
			hazardLine: 'damaging winds and tornadoes',
			stormMode: 'a squall line',
			stormEvolutionText: 'Discrete supercells may develop early before storms organize into a squall line later on.',
			timingWindow: 'late afternoon into evening',
			notableText: null,
			afdTimingHints: ['late afternoon into evening'],
			afdStormModeHints: ['quick upscale growth'],
			afdHazardEmphasis: ['tornado'],
			afdUncertaintyHints: ['cloud cover may limit destabilization'],
			afdConfidenceHints: ['confidence is increasing in organized severe storm development'],
			afdNotableBehaviorHints: ['storms may move quickly and reduce warning time'],
			trend: 'developing',
			recentOpenings: [],
			hashtagsEnabled: false,
		});

		expect(payload.afd_timing_hints).toEqual(['late afternoon into evening']);
		expect(payload.afd_uncertainty_hints).toEqual(['cloud cover may limit destabilization']);
		expect(payload.primary_states).toEqual(['IA', 'MO']);
		expect(payload.region).toBe('Mid-Mississippi Valley');
		expect(payload.storm_evolution).toBe(true);
		const prompt = buildSpcUserPrompt(payload);
		expect(prompt).toContain('Source priority: 1) SPC core categorical risk area 2) SPC summary 3) SPC discussion details.');
		expect(prompt).toContain('SPC remains the primary source of truth');
		expect(prompt).toContain('Locked primary states: Iowa and Missouri.');
		expect(prompt).toContain('Storm evolution is present and must be included in the copy.');
		expect(prompt).toContain('Supporting timing nuance: late afternoon into evening.');
		expect(prompt).toContain('Supporting uncertainty wording: cloud cover may limit destabilization.');
		expect(prompt).toContain('If tornadoes are secondary or conditional, do not lead with tornadoes.');
	});

	it('validateSpcLlmOutput rejects missing storm evolution and tornado-led copy when wind and hail are primary', () => {
		const { buildSpcLlmPayload, validateSpcLlmOutput } = __testing as any;
		const payload = buildSpcLlmPayload({
			outputMode: 'post',
			outlookDay: 2,
			postType: 'day2_lookahead',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Mid-Mississippi Valley',
			states: ['IA', 'MO', 'IL'],
			stateFocusText: 'Southern Iowa, Northern Missouri, and Western Illinois',
			hazardFocus: 'mixed',
			hazardList: ['large hail', 'damaging winds', 'tornadoes'],
			primaryHazards: ['large hail', 'damaging winds'],
			secondaryHazards: ['tornadoes'],
			hazardLine: 'large hail and damaging winds',
			stormMode: 'discrete supercells',
			stormEvolutionText: 'Discrete supercells may develop early before storms organize into a large squall line later on.',
			timingWindow: 'late afternoon into evening',
			notableText: null,
			trend: 'developing',
			recentOpenings: [],
			hashtagsEnabled: false,
		});

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Mid-Mississippi Valley. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa, northern Missouri, and western Illinois. Large hail and damaging winds look like the main threats, with a few tornadoes possible. The better window looks late afternoon into evening.',
			payload,
		).failureReason).toBe('missing_storm_evolution');

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Mid-Mississippi Valley. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa, northern Missouri, and western Illinois. Tornadoes look like the main threat. Discrete supercells may develop early before storms organize into a large squall line later on. The better window looks late afternoon into evening.',
			payload,
		).failureReason).toBe('tornado_lead_mismatch');
	});

	it('validateSpcLlmOutput rejects narrowed cores and timing drift, but accepts the stronger desk-style copy', () => {
		const { buildSpcLlmPayload, buildSpcUserPrompt, validateSpcLlmOutput } = __testing as any;
		const day1Payload = buildSpcLlmPayload({
			outputMode: 'post',
			outlookDay: 1,
			postType: 'main_setup',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Midwest',
			states: ['IA', 'IL', 'WI'],
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			hazardFocus: 'tornado',
			hazardList: ['tornadoes', 'damaging winds'],
			hazardLine: 'tornadoes and damaging winds',
			stormMode: 'fast-moving supercells',
			timingWindow: 'this afternoon',
			notableText: 'storms will race northeast quickly, which may limit warning time',
			trend: 'developing',
			recentOpenings: ['This afternoon to watch across the Midwest.'],
			hashtagsEnabled: true,
		});

		expect(buildSpcUserPrompt(day1Payload)).toContain('Do not narrow this multi-state corridor down to a single state or swap it for a broader but less accurate region.');
		expect(validateSpcLlmOutput(
			"Today's severe weather threat is focused on the Midwest, particularly southern Wisconsin, where a Level 3 enhanced risk is in place. Fast-moving supercells are expected to develop this afternoon and evening, bringing tornadoes and damaging winds, with storms moving quickly enough to limit warning time.",
			day1Payload,
		).failureReason).toBe('missing_core_state_cluster');

		expect(validateSpcLlmOutput(
			'Watching today closely across the Midwest. SPC has issued a Level 3 Enhanced Risk for severe storms centered on eastern Iowa, northern Illinois, and southern Wisconsin. Fast-moving supercells may develop early before storms organize into a line of storms later on. Tornadoes look like the main threats, with damaging winds possible. The main window looks this afternoon. Storms may move quickly enough to limit warning time.',
			day1Payload,
		).valid).toBe(true);

		const day2Payload = buildSpcLlmPayload({
			outputMode: 'post',
			outlookDay: 2,
			postType: 'day2_lookahead',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Midwest',
			states: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			hazardFocus: 'wind',
			hazardList: ['damaging winds', 'tornadoes', 'large hail'],
			hazardLine: 'damaging winds, tornadoes, and large hail',
			stormMode: 'a squall line',
			timingWindow: 'late afternoon into evening',
			notableText: 'the line should move east overnight after it organizes',
			trend: 'developing',
			recentOpenings: ['Watching tomorrow closely across the Midwest.'],
			hashtagsEnabled: true,
		});

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Midwest. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa and northern Missouri. A developing storm system will evolve into a squall line overnight, bringing damaging winds and large hail to the region, with a few tornadoes possible before the threat shifts into place by morning.',
			day2Payload,
		).failureReason).toBe('timing_not_aligned');

		expect(validateSpcLlmOutput(
			'Watching tomorrow closely across the Midwest. SPC has issued a Level 3 Enhanced Risk centered on southern Iowa and northern Missouri. A developing storm system is expected to organize into a squall line late Friday afternoon into the evening, bringing damaging winds and tornado potential as it moves east.',
			day2Payload,
		).valid).toBe(true);
	});

	it('validateSpcLlmOutput requires the primary SPC area to stay anchored even when secondary states are allowed', () => {
		const { buildSpcLlmPayload, validateSpcLlmOutput } = __testing as any;
		const payload = buildSpcLlmPayload({
			outputMode: 'comment',
			outlookDay: 1,
			postType: 'upgrade',
			riskLevel: 'enhanced',
			riskNumber: 3,
			primaryRegion: 'Midwest',
			states: ['IA', 'IL', 'WI'],
			secondaryStates: ['MO'],
			stateFocusText: 'Iowa, Illinois, and Wisconsin',
			secondaryAreaText: 'parts of Missouri later on',
			hazardFocus: 'wind',
			hazardList: ['damaging winds', 'large hail'],
			primaryHazards: ['damaging winds', 'large hail'],
			secondaryHazards: ['tornadoes'],
			hazardLine: 'damaging winds and large hail',
			stormMode: 'supercells',
			stormEvolution: true,
			stormEvolutionText: 'Supercells may develop early before storms organize into a line later on.',
			timingWindow: 'late afternoon through evening',
			notableText: 'storms may move quickly enough to limit warning time',
			trend: 'shifting',
			changeHint: 'core risk area now centered on Iowa, Illinois, and Wisconsin',
			recentOpenings: [],
			hashtagsEnabled: false,
		});

		expect(validateSpcLlmOutput(
			'UPDATE: Missouri may see a secondary extension later this evening as storms organize into a line.',
			payload,
		).failureReason).toBe('missing_primary_area_anchor');
		expect(validateSpcLlmOutput(
			'UPDATE: The Midwest core still centers on Iowa and Illinois, with Missouri only a secondary extension later as storms organize into a line.',
			payload,
		).valid).toBe(true);
	});

	it('runSpcDay1Coverage preserves the Day 1 wrapper while using the new SPC lane state', async () => {
		const { runSpcDay1Coverage, readLastSpcDay1Post, readRecentSpcOpenings } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: false,
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: true,
			spcTimingRefreshEnabled: true,
		}));

		const spcHtml = [
			'<html>',
			'<head><title>Storm Prediction Center Apr 2, 2026 1300 UTC Day 1 Convective Outlook</title></head>',
			"<body onload=\"show_tab('otlk_1300')\">",
			'<div>Updated:&nbsp;Thu Apr 2 12:56:18 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
			'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
			'<pre>' + [
				'SPC AC 021256',
				'',
				'Day 1 Convective Outlook',
				'NWS Storm Prediction Center Norman OK',
				'0756 AM CDT Thu Apr 02 2026',
				'',
				'Valid 021300Z - 031200Z',
				'',
				'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...AND SOUTHERN WISCONSIN...',
				'',
				'...SUMMARY...',
				'Severe thunderstorms capable of producing several tornadoes are expected across eastern Iowa, northern Illinois, and southern Wisconsin this afternoon.',
				'',
				'...Eastern IA/Northern IL/Southern WI...',
				'Tornado potential will be the main concern this afternoon.',
			].join('\n') + '</pre>',
			'</body>',
			'</html>',
		].join('');
		const spcGeoJson = {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					properties: {
						LABEL: 'ENH',
						VALID_ISO: '2026-04-02T13:00:00+00:00',
						EXPIRE_ISO: '2026-04-03T12:00:00+00:00',
						ISSUE_ISO: '2026-04-02T12:56:00+00:00',
					},
				},
			],
		};

		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk.html') {
				return new Response(spcHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify(spcGeoJson), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/photos')) {
				return new Response(JSON.stringify({ id: 'spc-post-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/feed')) {
				return new Response(JSON.stringify({ id: 'spc-post-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		await runSpcDay1Coverage(goodEnv, Date.parse('2026-04-02T14:00:00Z'));
		await runSpcDay1Coverage(goodEnv, Date.parse('2026-04-02T14:10:00Z'));

		const storedPost = await readLastSpcDay1Post(goodEnv);
		expect(storedPost?.highestRiskLevel).toBe('enhanced');
		expect(storedPost?.postType).toBe('main_setup');
		expect(storedPost?.postId).toBe('spc-post-1');

		const openings = await readRecentSpcOpenings(goodEnv);
		expect(openings.length).toBeGreaterThan(0);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/photos')).length).toBe(1);
	});

	it('runSpcCoverage staggers Day 1 and Day 2 posts into their intended windows and records a debug snapshot', async () => {
		const { runSpcCoverage, readLastSpcDay1Post, readLastSpcPost, readRecentSpcOpenings, readSpcDebugSnapshot } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: false,
			spcDay3MinRiskLevel: 'enhanced',
			spcHashtagsEnabled: true,
			spcTimingRefreshEnabled: true,
		}));

		const pages = {
			'https://www.spc.noaa.gov/products/outlook/day1otlk.html': [
				'<html>',
				'<head><title>Storm Prediction Center Apr 2, 2026 1300 UTC Day 1 Convective Outlook</title></head>',
				"<body onload=\"show_tab('otlk_1300')\">",
				'<div>Updated:&nbsp;Thu Apr 2 12:56:18 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
				'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
				'<pre>' + [
					'SPC AC 021256',
					'',
					'Day 1 Convective Outlook',
					'NWS Storm Prediction Center Norman OK',
					'0756 AM CDT Thu Apr 02 2026',
					'',
					'Valid 021300Z - 031200Z',
					'',
					'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...AND SOUTHERN WISCONSIN...',
					'',
					'...SUMMARY...',
					'Severe thunderstorms capable of producing several tornadoes are expected across eastern Iowa, northern Illinois, and southern Wisconsin this afternoon.',
				].join('\n') + '</pre>',
				'</body>',
				'</html>',
			].join(''),
			'https://www.spc.noaa.gov/products/outlook/day2otlk.html': [
				'<html>',
				'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
				"<body onload=\"show_tab('otlk_0600')\">",
				'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
				'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
				'<pre>' + [
					'SPC AC 020602',
					'',
					'Day 2 Convective Outlook',
					'NWS Storm Prediction Center Norman OK',
					'0102 AM CDT Thu Apr 02 2026',
					'',
					'Valid 031200Z - 041200Z',
					'',
					'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS ACROSS PARTS OF ARKANSAS...MISSISSIPPI...AND TENNESSEE...',
					'',
					'...SUMMARY...',
					'Severe thunderstorms are possible from Arkansas into Mississippi and Tennessee tomorrow afternoon into evening.',
				].join('\n') + '</pre>',
				'</body>',
				'</html>',
			].join(''),
		} as Record<string, string>;
		const geoJsonByUrl = {
			'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson': {
				type: 'FeatureCollection',
				features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-02T13:00:00+00:00', EXPIRE_ISO: '2026-04-03T12:00:00+00:00', ISSUE_ISO: '2026-04-02T12:56:00+00:00' } }],
			},
			'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson': {
				type: 'FeatureCollection',
				features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T06:02:00+00:00' } }],
			},
		} as Record<string, any>;
		let postCounter = 0;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (pages[url]) {
				return new Response(pages[url], { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (geoJsonByUrl[url]) {
				return new Response(JSON.stringify(geoJsonByUrl[url]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && (url.includes('/photos') || url.includes('/feed'))) {
				postCounter += 1;
				return new Response(JSON.stringify({ id: `spc-post-${postCounter}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		await runSpcCoverage(goodEnv, Date.parse('2026-04-02T14:00:00Z'));
		await runSpcCoverage(goodEnv, Date.parse('2026-04-02T18:00:00Z'));

		const day1Post = await readLastSpcDay1Post(goodEnv);
		const day2Post = await readLastSpcPost(goodEnv, 2);
		const snapshot = await readSpcDebugSnapshot(goodEnv);
		const openings = await readRecentSpcOpenings(goodEnv);

		expect(day1Post?.postType).toBe('main_setup');
		expect(day2Post?.postType).toBe('day2_lookahead');
		expect(day2Post?.postId).toBe('spc-post-2');
		expect(snapshot?.entries).toHaveLength(3);
		expect(snapshot?.entries.map((entry: any) => entry.outlookDay)).toEqual([1, 2, 3]);
		expect(openings.length).toBeGreaterThanOrEqual(2);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/photos')).length).toBe(2);
	});

	it('runSpcCoverageForDay keeps Day 2 upgrades as new posts instead of thread comments', async () => {
		const { runSpcCoverageForDay, readLastSpcPost } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: false,
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'slight',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));

		let version: 'initial' | 'upgrade' = 'initial';
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				const riskLine = version === 'initial'
					? '...THERE IS A SLIGHT RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...AND NORTHERN MISSOURI...'
					: '...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...NORTHERN MISSOURI...AND WEST-CENTRAL ILLINOIS...';
				const summaryLine = version === 'initial'
					? 'Severe thunderstorms are possible across southern Iowa and northern Missouri tomorrow afternoon into evening.'
					: 'A more organized severe weather episode is expected across southern Iowa, northern Missouri, and west-central Illinois tomorrow late afternoon into evening.';
				const detailLine = version === 'initial'
					? 'Storm clusters may produce damaging winds.'
					: 'A large squall line may develop with damaging winds and embedded tornado potential.';
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						riskLine,
						'',
						'...SUMMARY...',
						summaryLine,
						'',
						'...Southern IA/Northern MO...',
						detailLine,
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				const label = version === 'initial' ? 'SLGT' : 'ENH';
				const issueIso = version === 'initial' ? '2026-04-02T06:02:00+00:00' : '2026-04-02T18:05:00+00:00';
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{
						type: 'Feature',
						properties: {
							LABEL: label,
							VALID_ISO: '2026-04-03T12:00:00+00:00',
							EXPIRE_ISO: '2026-04-04T12:00:00+00:00',
							ISSUE_ISO: issueIso,
						},
					}],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/photos')) {
				return new Response(JSON.stringify({ id: version === 'initial' ? 'spc-day2-post-1' : 'spc-day2-post-2' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/comments')) {
				return new Response(JSON.stringify({ id: 'should-not-comment' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const initialResult = await runSpcCoverageForDay(goodEnv, 2, Date.parse('2026-04-02T17:00:00Z'));
		version = 'upgrade';
		const updateResult = await runSpcCoverageForDay(goodEnv, 2, Date.parse('2026-04-02T20:10:00Z'));
		const storedPost = await readLastSpcPost(goodEnv, 2);

		expect(initialResult.plannedOutputMode).toBe('post');
		expect(updateResult.plannedOutputMode).toBe('post');
		expect(storedPost?.outputMode).toBe('post');
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/photos')).length).toBe(2);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/comments')).length).toBe(0);
	});

	it('runSpcCoverageForDay lets scheduled Day 2 main posts bypass the 15-minute SPC lane gap', async () => {
		const { runSpcCoverageForDay } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));

		await goodEnv.WEATHER_KV.put('fb:spc:day1:last-post', JSON.stringify({
			outlookDay: 1,
			issuedAt: '2026-04-02T12:56:00+00:00',
			validFrom: '2026-04-02T13:00:00+00:00',
			validTo: '2026-04-03T12:00:00+00:00',
			postedAt: '2026-04-02T17:55:00.000Z',
			summaryHash: 'recent-day1-post',
			postId: 'recent-day1-post',
			outputMode: 'post',
			highestRiskLevel: 'enhanced',
			highestRiskNumber: 3,
			affectedStates: ['IA', 'IL', 'WI'],
			stateFocusText: 'Eastern Iowa, Northern Illinois, and Southern Wisconsin',
			primaryRegion: 'Midwest',
			hazardFocus: 'tornado',
			hazardList: ['tornadoes', 'damaging winds'],
			stormMode: 'fast-moving supercells',
			notableText: 'storms may move quickly enough to limit warning time',
			tornadoProbability: 10,
			windProbability: 30,
			hailProbability: null,
			timingText: 'this afternoon',
			postType: 'main_setup',
			reason: 'new_slight_or_higher',
		}));

		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...AND NORTHERN MISSOURI...',
						'',
						'...SUMMARY...',
						'Severe thunderstorms are expected across southern Iowa and northern Missouri tomorrow afternoon into evening.',
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T06:02:00+00:00' } }],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com')) {
				return new Response(JSON.stringify({ id: 'spc-day2-post-gap-bypass' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const result = await runSpcCoverageForDay(goodEnv, 2, Date.parse('2026-04-02T18:05:00Z'));

		expect(result.error).toBeNull();
		expect(result.plannedOutputMode).toBe('post');
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes('graph.facebook.com'))).toBe(true);
	});

	it('runSpcCoverageForDay lets scheduled Day 2 main posts ignore the shared Facebook cooldown', async () => {
		const { runSpcCoverageForDay } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: false,
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '2026-04-02T17:55:00.000Z');

		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...AND NORTHERN MISSOURI...',
						'',
						'...SUMMARY...',
						'Severe thunderstorms are expected across southern Iowa and northern Missouri tomorrow afternoon into evening.',
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T06:02:00+00:00' } }],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com')) {
				return new Response(JSON.stringify({ id: 'spc-day2-shared-gap-bypass' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const result = await runSpcCoverageForDay(goodEnv, 2, Date.parse('2026-04-02T18:05:00Z'));

		expect(result.error).toBeNull();
		expect(result.plannedOutputMode).toBe('post');
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes('graph.facebook.com'))).toBe(true);
	});

	it('runSpcCoverageForDay still respects the shared Facebook cooldown for Day 2 upgrades', async () => {
		const { runSpcCoverageForDay } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: false,
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'slight',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));
		await goodEnv.WEATHER_KV.put('fb:spc:last-post:2', JSON.stringify({
			outlookDay: 2,
			issuedAt: '2026-04-02T06:02:00+00:00',
			validFrom: '2026-04-03T12:00:00+00:00',
			validTo: '2026-04-04T12:00:00+00:00',
			postedAt: '2026-04-02T17:30:00.000Z',
			summaryHash: 'day2-old-hash',
			postId: 'day2-old-post',
			outputMode: 'post',
			highestRiskLevel: 'slight',
			highestRiskNumber: 2,
			affectedStates: ['IA', 'MO'],
			stateFocusText: 'Southern Iowa and Northern Missouri',
			primaryRegion: 'Midwest',
			hazardFocus: 'wind',
			hazardList: ['damaging winds'],
			stormMode: 'storm clusters',
			notableText: null,
			tornadoProbability: null,
			windProbability: 15,
			hailProbability: null,
			timingText: 'tomorrow afternoon into evening',
			postType: 'day2_lookahead',
			reason: 'new_slight_or_higher',
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '2026-04-02T18:00:00.000Z');

		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...NORTHERN MISSOURI...AND WEST-CENTRAL ILLINOIS...',
						'',
						'...SUMMARY...',
						'A more organized severe weather episode is expected across southern Iowa, northern Missouri, and west-central Illinois tomorrow late afternoon into evening.',
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T18:05:00+00:00' } }],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com')) {
				return new Response(JSON.stringify({ id: 'should-not-post-upgrade' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const result = await runSpcCoverageForDay(goodEnv, 2, Date.parse('2026-04-02T18:05:00Z'));

		expect(result.error).toBe('recent_global_post_gap');
		expect(result.plannedOutputMode).toBeNull();
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes('graph.facebook.com'))).toBe(false);
	});

	it('runCoordinatedFacebookCoverage releases a deferred Day 2 anchor after a Day 1 suppression', async () => {
		const { runCoordinatedFacebookCoverage, readFacebookCoordinatorSnapshot, runSpcCoverageForDay } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'slight',
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '');

		let day1Version: 'initial' | 'upgrade' = 'initial';
		let graphCallCount = 0;
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk.html') {
				const title = day1Version === 'initial'
					? 'Storm Prediction Center Apr 2, 2026 1300 UTC Day 1 Convective Outlook'
					: 'Storm Prediction Center Apr 2, 2026 1800 UTC Day 1 Convective Outlook';
				const tabId = day1Version === 'initial' ? 'otlk_1300' : 'otlk_1800';
				const updatedLine = day1Version === 'initial'
					? 'Updated:&nbsp;Thu Apr 2 12:56:18 UTC 2026&nbsp;(<a href="#">Print Version</a>)'
					: 'Updated:&nbsp;Thu Apr 2 18:00:00 UTC 2026&nbsp;(<a href="#">Print Version</a>)';
				const acLine = day1Version === 'initial' ? 'SPC AC 021256' : 'SPC AC 021800';
				const issuedLine = day1Version === 'initial'
					? '0756 AM CDT Thu Apr 02 2026'
					: '0100 PM CDT Thu Apr 02 2026';
				const validLine = day1Version === 'initial'
					? 'Valid 021300Z - 031200Z'
					: 'Valid 021800Z - 031200Z';
				const riskLine = day1Version === 'initial'
					? '...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...AND SOUTHERN WISCONSIN...'
					: '...THERE IS A MODERATE RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...SOUTHERN WISCONSIN...AND NORTHWEST INDIANA...';
				const summaryLine = day1Version === 'initial'
					? 'Severe thunderstorms capable of producing several tornadoes are expected across eastern Iowa, northern Illinois, and southern Wisconsin this afternoon.'
					: 'Severe thunderstorms capable of producing strong tornadoes are expected across eastern Iowa, northern Illinois, southern Wisconsin, and northwest Indiana this afternoon into evening.';
				return new Response([
					'<html>',
					`<head><title>${title}</title></head>`,
					`<body onload="show_tab('${tabId}')">`,
					`<div>${updatedLine}</div>`,
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						acLine,
						'',
						'Day 1 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						issuedLine,
						'',
						validLine,
						'',
						riskLine,
						'',
						'...SUMMARY...',
						summaryLine,
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{
						type: 'Feature',
						properties: {
							LABEL: day1Version === 'initial' ? 'ENH' : 'MDT',
							VALID_ISO: day1Version === 'initial' ? '2026-04-02T13:00:00+00:00' : '2026-04-02T18:00:00+00:00',
							EXPIRE_ISO: '2026-04-03T12:00:00+00:00',
							ISSUE_ISO: day1Version === 'initial' ? '2026-04-02T12:56:00+00:00' : '2026-04-02T18:00:00+00:00',
						},
					}],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk.html') {
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 0600 UTC Day 2 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_0600')\">",
					'<div>Updated:&nbsp;Thu Apr 2 06:02:03 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 020602',
						'',
						'Day 2 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0102 AM CDT Thu Apr 02 2026',
						'',
						'Valid 031200Z - 041200Z',
						'',
						'...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS SOUTHERN IOWA...NORTHERN MISSOURI...AND WEST-CENTRAL ILLINOIS...',
						'',
						'...SUMMARY...',
						'A more organized severe weather episode is expected across southern Iowa, northern Missouri, and west-central Illinois tomorrow late afternoon into evening.',
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson') {
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{ type: 'Feature', properties: { LABEL: 'ENH', VALID_ISO: '2026-04-03T12:00:00+00:00', EXPIRE_ISO: '2026-04-04T12:00:00+00:00', ISSUE_ISO: '2026-04-02T06:02:00+00:00' } }],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com')) {
				graphCallCount += 1;
				const id = graphCallCount === 1
					? 'spc-day1-anchor-post'
					: graphCallCount === 2
						? 'spc-day1-upgrade-comment'
						: 'spc-day2-deferred-post';
				return new Response(JSON.stringify({ id }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const initialDay1 = await runSpcCoverageForDay(goodEnv, 1, Date.parse('2026-04-02T13:10:00Z'));
		expect(initialDay1.error).toBeNull();
		expect(initialDay1.plannedOutputMode).toBe('post');
		day1Version = 'upgrade';

		const firstSnapshot = await runCoordinatedFacebookCoverage(goodEnv, {}, [], Date.parse('2026-04-02T18:20:00Z'));

		expect(firstSnapshot.selectedLane).toBe('spc_day1');
		expect(firstSnapshot.selectedAction).toBe('comment');
		expect(firstSnapshot.selectedIntentReason).toBe('risk_upgrade');
		expect(firstSnapshot.statuses.some((status: any) => (
			status.lane === 'spc_day2'
			&& status.status === 'suppressed'
			&& status.reason === 'coordinator_suppressed_spc_day2_by_spc_day1'
		))).toBe(true);

		const deferredRaw = await goodEnv.WEATHER_KV.get('fb:spc:deferred-anchor:2');
		expect(deferredRaw).toBeTruthy();
		expect(JSON.parse(deferredRaw || '{}')).toMatchObject({
			day: 2,
			suppressedByLane: 'spc_day1',
			forecastDay: '2026-04-03',
		});

		const secondSnapshot = await runCoordinatedFacebookCoverage(goodEnv, {}, [], Date.parse('2026-04-02T19:25:00Z'));

		expect(secondSnapshot.selectedLane).toBe('spc_day2');
		expect(secondSnapshot.selectedReason).toBe('coordinator_selected_spc_day2');
		expect(secondSnapshot.selectedIntentReason).toBe('deferred_anchor_release');
		expect(await goodEnv.WEATHER_KV.get('fb:spc:deferred-anchor:2')).toBeNull();

		const savedSnapshot = await readFacebookCoordinatorSnapshot(goodEnv);
		expect(savedSnapshot?.selectedLane).toBe('spc_day2');
		expect(savedSnapshot?.selectedIntentReason).toBe('deferred_anchor_release');
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('graph.facebook.com')).length).toBe(3);
	});

	it('runSpcCoverageForDay uses Facebook comments for same-thread SPC upgrades', async () => {
		const { runSpcCoverageForDay, readLastSpcDay1Post } = __testing as any;
		const goodEnv = {
			...env,
			FB_PAGE_ID: 'page-1',
			FB_PAGE_ACCESS_TOKEN: 'token-1',
		} as any;

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'off',
			updatedAt: '2026-04-02T12:00:00.000Z',
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: false,
			spcDay3CoverageEnabled: false,
			spcHashtagsEnabled: false,
			spcTimingRefreshEnabled: true,
		}));

		let version: 'initial' | 'upgrade' = 'initial';
		const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
			const url = String(input);
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk.html') {
				const riskLine = version === 'initial'
					? '...THERE IS AN ENHANCED RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...AND SOUTHERN WISCONSIN...'
					: '...THERE IS A MODERATE RISK OF SEVERE THUNDERSTORMS EASTERN IOWA...NORTHERN ILLINOIS...SOUTHERN WISCONSIN...AND NORTHWEST INDIANA...';
				const summaryLine = version === 'initial'
					? 'Severe thunderstorms capable of producing several tornadoes are expected across eastern Iowa, northern Illinois, and southern Wisconsin this afternoon.'
					: 'Severe thunderstorms capable of producing strong tornadoes are expected across eastern Iowa, northern Illinois, southern Wisconsin, and northwest Indiana this afternoon.';
				return new Response([
					'<html>',
					'<head><title>Storm Prediction Center Apr 2, 2026 1300 UTC Day 1 Convective Outlook</title></head>',
					"<body onload=\"show_tab('otlk_1300')\">",
					'<div>Updated:&nbsp;Thu Apr 2 12:56:18 UTC 2026&nbsp;(<a href="#">Print Version</a>)</div>',
					'<div><font color="#FFFFFF"><b>&nbsp;Forecast Discussion</b></font></div>',
					'<pre>' + [
						'SPC AC 021256',
						'',
						'Day 1 Convective Outlook',
						'NWS Storm Prediction Center Norman OK',
						'0756 AM CDT Thu Apr 02 2026',
						'',
						'Valid 021300Z - 031200Z',
						'',
						riskLine,
						'',
						'...SUMMARY...',
						summaryLine,
					].join('\n') + '</pre>',
					'</body>',
					'</html>',
				].join(''), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
			}
			if (url === 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson') {
				const label = version === 'initial' ? 'ENH' : 'MDT';
				const issueIso = version === 'initial' ? '2026-04-02T12:56:00+00:00' : '2026-04-02T14:30:00+00:00';
				return new Response(JSON.stringify({
					type: 'FeatureCollection',
					features: [{
						type: 'Feature',
						properties: {
							LABEL: label,
							VALID_ISO: '2026-04-02T13:00:00+00:00',
							EXPIRE_ISO: '2026-04-03T12:00:00+00:00',
							ISSUE_ISO: issueIso,
						},
					}],
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/photos')) {
				return new Response(JSON.stringify({ id: 'spc-post-thread-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('graph.facebook.com') && url.includes('/comments')) {
				return new Response(JSON.stringify({ id: 'spc-comment-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (init?.method === 'HEAD') {
				return new Response('', { status: 200 });
			}
			return new Response('not found', { status: 404 });
		});
		(globalThis as any).fetch = fetchMock;

		const initialResult = await runSpcCoverageForDay(goodEnv, 1, Date.parse('2026-04-02T14:00:00Z'));
		version = 'upgrade';
		const updateResult = await runSpcCoverageForDay(goodEnv, 1, Date.parse('2026-04-02T16:10:00Z'));
		const storedPost = await readLastSpcDay1Post(goodEnv);

		expect(initialResult.plannedOutputMode).toBe('post');
		expect(updateResult.plannedOutputMode).toBe('comment');
		expect(storedPost?.outputMode).toBe('comment');
		expect(storedPost?.commentId).toBe('spc-comment-1');
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/photos')).length).toBe(1);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/comments')).length).toBe(1);
	});

	it('buildDigestCandidates filters out Tier 1 alerts and covered alerts', () => {
		const { buildDigestCandidates } = __testing;

		const alertMap = {
			'tornado-1': {
				id: 'tornado-1',
				properties: {
					event: 'Tornado Warning',
					severity: 'Extreme',
					areaDesc: 'Test County, KY',
					geocode: { UGC: ['KYC001'] },
					status: 'Actual',
					headline: 'Tornado Warning in effect',
					description: 'A tornado warning is in effect.',
					urgency: 'Immediate',
					certainty: 'Observed',
				},
			},
			'flood-1': {
				id: 'flood-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Moderate',
					areaDesc: 'Clinton County, OH',
					geocode: { UGC: ['OHC027'] },
					status: 'Actual',
					headline: 'Flood warning in effect',
					description: 'Flooding is occurring.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			},
			'winter-1': {
				id: 'winter-1',
				properties: {
					event: 'Winter Storm Watch',
					severity: 'Moderate',
					areaDesc: 'Lake County, IL',
					geocode: { UGC: ['ILC097'] },
					status: 'Actual',
					headline: 'Winter storm watch in effect',
					description: 'Winter storm conditions possible.',
					urgency: 'Future',
					certainty: 'Possible',
				},
			},
			'test-1': {
				id: 'test-1',
				properties: {
					event: 'Test Message',
					severity: 'Unknown',
					areaDesc: 'Test County',
					geocode: { UGC: ['KYC001'] },
					status: 'Test',
					description: '',
					urgency: 'Unknown',
					certainty: 'Unknown',
				},
			},
		};

		// No covered alerts — tornado excluded (Tier 1), test excluded, flood and winter included
		const candidates = buildDigestCandidates(alertMap as any, new Set<string>());
		const alertIds = candidates.map((c) => c.alertId);
		expect(alertIds).not.toContain('tornado-1');
		expect(alertIds).not.toContain('test-1');
		expect(alertIds).toContain('flood-1');
		expect(alertIds).toContain('winter-1');

		// If flood-1 is covered by standalone, it should be excluded
		const candidatesWithCovered = buildDigestCandidates(alertMap as any, new Set(['flood-1']));
		const coveredIds = candidatesWithCovered.map((c) => c.alertId);
		expect(coveredIds).not.toContain('flood-1');
		expect(coveredIds).toContain('winter-1');
	});

	it('buildDigestCandidates correctly classifies hazard families', () => {
		const { buildDigestCandidates } = __testing;

		const alertMap = {
			'flood-w': {
				id: 'flood-w',
				properties: {
					event: 'Flood Watch',
					severity: 'Moderate',
					areaDesc: 'Test County, OH',
					geocode: { UGC: ['OHC027'] },
					status: 'Actual',
					headline: 'Flooding possible',
					description: 'Flooding conditions are possible.',
					urgency: 'Future',
					certainty: 'Possible',
				},
			},
			'wind-a': {
				id: 'wind-a',
				properties: {
					event: 'Wind Advisory',
					severity: 'Minor',
					areaDesc: 'Test County, CO',
					geocode: { UGC: ['COC001'] },
					status: 'Actual',
					headline: 'Wind advisory in effect',
					description: 'Strong winds expected.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			},
			'rfr': {
				id: 'rfr',
				properties: {
					event: 'Red Flag Warning',
					severity: 'Moderate',
					areaDesc: 'Test County, CA',
					geocode: { UGC: ['CAC001'] },
					status: 'Actual',
					headline: 'Red flag warning in effect',
					description: 'Critical fire weather conditions.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			},
		};

		const candidates = buildDigestCandidates(alertMap as any, new Set<string>());
		const byId = Object.fromEntries(candidates.map((c) => [c.alertId, c]));
		expect(byId['flood-w']?.hazardFamily).toBe('flood');
		expect(byId['wind-a']?.hazardFamily).toBe('wind');
		expect(byId['rfr']?.hazardFamily).toBe('fire');
	});

	it('buildDigestCandidates marks marine alerts correctly', () => {
		const { buildDigestCandidates } = __testing;

		const alertMap = {
			'marine-1': {
				id: 'marine-1',
				properties: {
					event: 'Gale Warning',
					severity: 'Moderate',
					areaDesc: 'Coastal Waters of NC',
					geocode: { UGC: ['ANZ331'] },
					status: 'Actual',
					headline: 'Gale warning in effect',
					description: 'Gale conditions expected.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			},
			'land-1': {
				id: 'land-1',
				properties: {
					event: 'High Wind Warning',
					severity: 'Moderate',
					areaDesc: 'Denver County, CO',
					geocode: { UGC: ['COC031'] },
					status: 'Actual',
					headline: 'High wind warning',
					description: 'High winds expected.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			},
		};

		const candidates = buildDigestCandidates(alertMap as any, new Set<string>());
		const marine = candidates.find((c) => c.alertId === 'marine-1');
		const land = candidates.find((c) => c.alertId === 'land-1');
		expect(marine?.isMarineOrCoastal).toBe(true);
		expect(land?.isMarineOrCoastal).toBe(false);
	});

	it('buildDigestSummary correctly classifies mode and urgency', () => {
		const { buildDigestCandidates, buildDigestSummary } = __testing;

		const alertMap: Record<string, any> = {};
		// Create 8 states worth of flood warnings to trigger incident mode
		const states = ['OH', 'IN', 'IL', 'MO', 'KY', 'TN', 'WV', 'VA'];
		for (const [i, state] of states.entries()) {
			alertMap[`flood-${i}`] = {
				id: `flood-${i}`,
				properties: {
					event: 'Flood Warning',
					severity: 'Moderate',
					areaDesc: `Test County, ${state}`,
					geocode: { UGC: [`${state}C001`] },
					status: 'Actual',
					headline: 'Flood warning',
					description: 'Flooding occurring.',
					urgency: 'Immediate',
					certainty: 'Observed',
				},
			};
		}

		const candidates = buildDigestCandidates(alertMap, new Set<string>());
		expect(candidates.length).toBeGreaterThan(0);

		// Extract needed data for buildDigestSummary
		const { buildHazardClusters: _buildHazardClusters } = __testing as any;
		// Build a simplified call using the exported function
		const summary = buildDigestSummary(
			candidates,
			[{ family: 'flood', states, score: 40, alertCount: 8, topAlertTypes: ['Flood Warning'] }],
			states,
			'incident',
			null,
		);
		expect(summary.mode).toBe('incident');
		expect(summary.postType).toBe('digest');
		expect(summary.hazardFocus).toBe('flood');
		expect(summary.states).toEqual(states);
		expect(summary.hash).toBeTruthy();
	});

	it('buildHazardClusters ranks the strongest hazard family ahead of weaker flood coverage', () => {
		const { buildDigestCandidates, buildHazardClusters, buildDigestSummary } = __testing as any;

		const alertMap: Record<string, any> = {};
		const winterStates = ['MN', 'WI', 'SD', 'ND', 'MT'];
		const floodStates = ['NY', 'PA', 'OH', 'WV', 'VA', 'MD'];

		for (const [i, state] of winterStates.entries()) {
			alertMap[`winter-${i}`] = {
				id: `winter-${i}`,
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					areaDesc: `Test County, ${state}`,
					geocode: { UGC: [`${state}C001`] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
					urgency: 'Immediate',
					certainty: 'Likely',
				},
			};
		}

		for (const [i, state] of floodStates.entries()) {
			alertMap[`flood-${i}`] = {
				id: `flood-${i}`,
				properties: {
					event: 'Flood Advisory',
					severity: 'Moderate',
					areaDesc: `Test County, ${state}`,
					geocode: { UGC: [`${state}C001`] },
					status: 'Actual',
					headline: 'Flood advisory',
					description: 'Minor flooding is possible.',
					urgency: 'Expected',
					certainty: 'Likely',
				},
			};
		}

		const candidates = buildDigestCandidates(alertMap, new Set<string>());
		const clusters = buildHazardClusters(candidates);

		expect(clusters.map((cluster: any) => cluster.family)).toEqual(['winter', 'flood']);
		expect(clusters[0].warningCount).toBe(5);
		expect(clusters[1].warningCount).toBe(0);

		const summary = buildDigestSummary(
			candidates,
			clusters,
			['MN', 'WI', 'SD', 'ND', 'MT', 'NY'],
			'incident',
			null,
		);

		expect(summary.hazardFocus).toBe('winter');
		expect(summary.topAlertTypes).toContain('Winter Storm Warning');
	});

	it('selectDigestRegionalStory keeps scattered winter alerts focused on the dominant regional cluster', () => {
		const { buildDigestCandidates, selectDigestRegionalStory } = __testing as any;
		const alertMap: Record<string, any> = {
			'winter-mn': {
				id: 'winter-mn',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Minnesota counties',
					geocode: { UGC: ['MNC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-wi': {
				id: 'winter-wi',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Wisconsin counties',
					geocode: { UGC: ['WIC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-sd': {
				id: 'winter-sd',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'South Dakota counties',
					geocode: { UGC: ['SDC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-nd': {
				id: 'winter-nd',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'North Dakota counties',
					geocode: { UGC: ['NDC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-ca': {
				id: 'winter-ca',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Expected',
					areaDesc: 'California mountain counties',
					geocode: { UGC: ['CAC001'] },
					status: 'Actual',
					headline: 'California winter storm warning',
					description: 'Mountain snow expected in California.',
				},
			},
			'winter-il': {
				id: 'winter-il',
				properties: {
					event: 'Winter Weather Advisory',
					severity: 'Moderate',
					urgency: 'Expected',
					areaDesc: 'Illinois counties',
					geocode: { UGC: ['ILC001'] },
					status: 'Actual',
					headline: 'Illinois winter weather advisory',
					description: 'Light snow and travel impacts possible.',
				},
			},
			'winter-wy': {
				id: 'winter-wy',
				properties: {
					event: 'Winter Weather Advisory',
					severity: 'Moderate',
					urgency: 'Expected',
					areaDesc: 'Wyoming counties',
					geocode: { UGC: ['WYC001'] },
					status: 'Actual',
					headline: 'Wyoming winter weather advisory',
					description: 'Light snow and travel impacts possible.',
				},
			},
		};

		const candidates = buildDigestCandidates(alertMap, new Set<string>()).filter((candidate: any) => candidate.hazardFamily === 'winter');
		const selection = selectDigestRegionalStory(candidates);

		expect(selection.storyRegion).toBe('northern Plains and Upper Midwest');
		expect(selection.storyStates).toEqual(['MN', 'ND', 'SD', 'WI']);
		expect(selection.outlierStates).toEqual(expect.arrayContaining(['CA', 'IL', 'WY']));
		expect(selection.regionalCoherence).toBe('cohesive');
	});

	it('selectDigestPrimaryCluster falls back to a different hazard family when the top one is cooling down', () => {
		const { selectDigestPrimaryCluster } = __testing as any;
		const nowMs = Date.UTC(2026, 3, 1, 13, 0, 0);
		const fortyMinutesAgo = new Date(nowMs - 40 * 60 * 1000).toISOString();

		const winterCluster = {
			family: 'winter',
			states: ['OH', 'NY', 'WI'],
			score: 18,
			alertCount: 5,
			warningCount: 2,
			topAlertTypes: ['Winter Weather Advisory'],
		};
		const floodCluster = {
			family: 'flood',
			states: ['TX', 'OK'],
			score: 10,
			alertCount: 4,
			warningCount: 1,
			topAlertTypes: ['Flood Warning'],
		};

		const selected = selectDigestPrimaryCluster(
			[winterCluster, floodCluster],
			null,
			{
				blockId: 'block-previous',
				publishedAt: fortyMinutesAgo,
				hash: 'winter-hash',
				postId: 'post-1',
				hazardFocus: 'winter',
				lastPublishedAtByFocus: {
					winter: fortyMinutesAgo,
				},
			},
			nowMs,
		);

		expect(selected?.family).toBe('flood');
	});

	it('canPostNewDigest keeps the active thread during the hourly cooldown and enforces the two-post hourly cap', async () => {
		const { canPostNewDigest } = __testing as any;
		const startMs = Date.UTC(2026, 3, 1, 12, 0, 0);
		const publishedAt = new Date(startMs).toISOString();
		const blockId = `block-${Math.floor(startMs / (60 * 60 * 1000))}`;

		await env.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId,
			publishedAt,
			hash: 'flood-hash',
			postId: 'post-1',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: {
				flood: publishedAt,
			},
		}));
		await env.WEATHER_KV.put(`fb:digest-thread:${blockId}`, JSON.stringify({
			postId: 'post-1',
			blockId,
			publishedAt,
			hash: 'flood-hash',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH'],
				topAlertTypes: ['Flood Warning'],
				urgency: 'moderate',
				alertCount: 3,
				warningCount: 1,
				hash: 'flood-hash',
			},
		}));

		const duringHour = await canPostNewDigest(env, startMs + 31 * 60 * 1000, 'winter');
		expect(duringHour.allowed).toBe(false);
		expect(duringHour.reason).toBe('same_block');
		expect(duringHour.existingThread?.postId).toBe('post-1');

		const secondPublishedAt = new Date(startMs + 20 * 60 * 1000).toISOString();
		await env.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId,
			publishedAt: secondPublishedAt,
			hash: 'flood-hash-2',
			postId: 'post-2',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: {
				flood: secondPublishedAt,
			},
			recentPostTimestamps: [publishedAt, secondPublishedAt],
		}));

		const capped = await canPostNewDigest(env, startMs + 45 * 60 * 1000, 'winter');
		expect(capped.allowed).toBe(false);
		expect(capped.reason).toBe('hourly_post_cap');

		const afterHour = await canPostNewDigest(env, startMs + 81 * 60 * 1000, 'flood');
		expect(afterHour.allowed).toBe(true);
		expect(afterHour.reason).toBeNull();
	});

	it('evaluateDigestNewPostGap enforces the 60-minute digest anchor gap', () => {
		const { evaluateDigestNewPostGap } = __testing as any;
		const nowMs = Date.UTC(2026, 3, 1, 13, 0, 0);

		expect(evaluateDigestNewPostGap(null, nowMs)).toMatchObject({
			allowed: true,
			reason: 'no_previous_digest_post',
		});

		const duringGap = evaluateDigestNewPostGap({
			blockId: 'block-during-gap',
			publishedAt: new Date(nowMs - 31 * 60 * 1000).toISOString(),
			hash: 'during-gap',
			postId: 'post-during-gap',
		}, nowMs);
		expect(duringGap.allowed).toBe(false);
		expect(duringGap.reason).toBe('digest_new_post_gap_not_met');

		const afterGap = evaluateDigestNewPostGap({
			blockId: 'block-after-gap',
			publishedAt: new Date(nowMs - 81 * 60 * 1000).toISOString(),
			hash: 'after-gap',
			postId: 'post-after-gap',
		}, nowMs);
		expect(afterGap.allowed).toBe(true);
		expect(afterGap.reason).toBe('digest_new_post_allowed_after_60m');
	});

	it('evaluateDigestSameStory and evaluateSecondDigestPostAllowance separate same-story updates from material pivots', () => {
		const {
			evaluateDigestChangeThresholds,
			evaluateDigestSameStory,
			evaluateSecondDigestPostAllowance,
		} = __testing as any;
		const previousSummary = {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'flood',
			states: ['OH', 'IN'],
			storyStates: ['OH', 'IN'],
			storyRegion: 'Midwest',
			storyFingerprint: 'flood|Midwest|IN,OH|flood warning',
			topAlertTypes: ['Flood Warning'],
			urgency: 'moderate',
			alertCount: 3,
			warningCount: 1,
			hash: 'prev-flood-story',
		} as any;

		const sameStoryUpdate = {
			...previousSummary,
			states: ['OH', 'IN', 'PA'],
			storyStates: ['OH', 'IN', 'PA'],
			storyFingerprint: 'flood|Midwest|IN,OH,PA|flood warning',
			alertCount: 4,
			hash: 'same-story-update',
		} as any;
		const sameStory = evaluateDigestSameStory(previousSummary, sameStoryUpdate);
		expect(sameStory.samePublicStory).toBe(true);
		expect(sameStory.sameTopAlertTypes).toBe(true);
		expect(sameStory.storyStateOverlapRatio).toBeGreaterThanOrEqual(0.5);

		const warningJumpSummary = {
			...sameStoryUpdate,
			alertCount: 8,
			warningCount: 4,
			hash: 'warning-jump-story',
		} as any;
		const warningJumpChange = evaluateDigestChangeThresholds(previousSummary, warningJumpSummary);
		expect(evaluateSecondDigestPostAllowance(previousSummary, warningJumpSummary, warningJumpChange)).toMatchObject({
			allowed: true,
			reason: 'digest_second_post_allowed_warning_jump',
		});

		const hazardShiftSummary = {
			...previousSummary,
			hazardFocus: 'winter',
			states: ['MI', 'OH'],
			storyStates: ['MI', 'OH'],
			storyRegion: 'Great Lakes',
			storyFingerprint: 'winter|Great Lakes|MI,OH|winter storm warning',
			topAlertTypes: ['Winter Storm Warning'],
			alertCount: 5,
			warningCount: 2,
			hash: 'hazard-shift-story',
		} as any;
		const hazardShiftChange = evaluateDigestChangeThresholds(previousSummary, hazardShiftSummary);
		expect(evaluateSecondDigestPostAllowance(previousSummary, hazardShiftSummary, hazardShiftChange)).toMatchObject({
			allowed: true,
			reason: 'digest_second_post_allowed_hazard_change',
		});

		const regionShiftSummary = {
			...previousSummary,
			states: ['TX', 'LA'],
			storyStates: ['TX', 'LA'],
			storyRegion: 'Gulf Coast',
			storyFingerprint: 'flood|Gulf Coast|LA,TX|flood warning',
			alertCount: 4,
			warningCount: 2,
			hash: 'region-shift-story',
		} as any;
		const regionShiftChange = evaluateDigestChangeThresholds(previousSummary, regionShiftSummary);
		expect(evaluateSecondDigestPostAllowance(previousSummary, regionShiftSummary, regionShiftChange)).toMatchObject({
			allowed: true,
			reason: 'digest_second_post_allowed_region_change',
		});

		const newMajorStorySummary = {
			...previousSummary,
			states: ['IA', 'MO'],
			storyStates: ['IA', 'MO'],
			storyRegion: 'Midwest',
			storyFingerprint: 'flood|Midwest|IA,MO|flash flood warning',
			topAlertTypes: ['Flash Flood Warning'],
			alertCount: 4,
			warningCount: 2,
			hash: 'new-major-story',
		} as any;
		const newMajorStoryDiff = evaluateDigestSameStory(previousSummary, newMajorStorySummary);
		expect(newMajorStoryDiff.clearlyDifferentStory).toBe(true);
		const newMajorStoryChange = evaluateDigestChangeThresholds(previousSummary, newMajorStorySummary);
		expect(evaluateSecondDigestPostAllowance(previousSummary, newMajorStorySummary, newMajorStoryChange)).toMatchObject({
			allowed: true,
			reason: 'digest_second_post_allowed_new_major_story',
		});
	});

	it('checkClusterBreakout only uses the flood override for actual flood warnings', () => {
		const { checkClusterBreakout } = __testing as any;

		const breakout = checkClusterBreakout([
			{
				family: 'flood',
				states: ['NY', 'PA'],
				score: 18,
				alertCount: 10,
				warningCount: 0,
				topAlertTypes: ['Flood Advisory'],
			},
			{
				family: 'winter',
				states: ['MN', 'WI'],
				score: 18,
				alertCount: 6,
				warningCount: 2,
				topAlertTypes: ['Winter Weather Advisory'],
			},
		]);

		expect(breakout).toBeNull();
	});

	it('buildStartupSnapshotText creates a readable snapshot with date', () => {
		const { buildStartupSnapshotText } = __testing;

		const clusters = [
			{ family: 'flood', states: ['OH', 'IN', 'IL'], score: 15, alertCount: 5, topAlertTypes: ['Flood Warning'] },
			{ family: 'winter', states: ['MN', 'WI'], score: 8, alertCount: 3, topAlertTypes: ['Winter Storm Watch'] },
		];

		const text = buildStartupSnapshotText(clusters as any, 8);
		expect(text).toContain('Flooding is the main weather story right now');
		expect(text).toContain('Ohio, Indiana, and Illinois');
		expect(text).toContain('Winter weather is also active');
		expect(text).toContain('8 active weather alerts are posted nationwide');
		expect(text).toContain('liveweatheralerts.com');
	});

	it('buildStartupSnapshotText handles empty clusters gracefully', () => {
		const { buildStartupSnapshotText } = __testing;
		const text = buildStartupSnapshotText([], 0);
		expect(text).toContain('Quiet weather is the main story nationwide right now.');
		expect(text).toContain('No significant weather alerts are active');
	});

	it('validateLlmOutput rejects empty output', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['OH', 'IN'], top_alert_types: ['Flood Warning'], hazard_focus: 'flood', mode: 'normal', post_type: 'digest', urgency: 'high', max_length: 450, style: '' } as any;
		expect(validateLlmOutput('', payload).valid).toBe(false);
		expect(validateLlmOutput('', payload).failureReason).toBe('empty_output');
	});

	it('validateLlmOutput rejects output that is too long', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['OH'], top_alert_types: [], hazard_focus: null, mode: 'normal', post_type: 'digest', urgency: 'low', max_length: 450, style: '' } as any;
		const longText = 'Ohio ' + 'a'.repeat(600);
		expect(validateLlmOutput(longText, payload).valid).toBe(false);
		expect(validateLlmOutput(longText, payload).failureReason).toBe('too_long');
	});

	it('validateLlmOutput rejects output with no geography mention', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['TX'], top_alert_types: ['Flood Warning'], hazard_focus: 'flood', mode: 'normal', post_type: 'digest', urgency: 'high', max_length: 450, style: '' } as any;
		const noGeo = 'Flooding conditions are active. Please monitor forecasts.';
		expect(validateLlmOutput(noGeo, payload).valid).toBe(false);
		expect(validateLlmOutput(noGeo, payload).failureReason).toBe('no_geography_mention');
	});

	it('validateLlmOutput rejects output with hashtags', () => {
		const { validateLlmOutput } = __testing;
		// Use state abbreviation so the geography check passes, then hashtag check should fire
		const payload = { states: ['TX'], regional_focus: 'Plains', example_states: ['Texas'], trend: 'continuing', impact: ['wind'], top_alert_types: [], hazard_focus: null, mode: 'normal', post_type: 'digest', urgency: 'low', max_length: 450, style: '', recent_openings: [] } as any;
		const withHashtag = 'Flooding conditions in TX. #weather #wx';
		expect(validateLlmOutput(withHashtag, payload).valid).toBe(false);
		expect(validateLlmOutput(withHashtag, payload).failureReason).toBe('contains_hashtag');
	});

	it('validateLlmOutput accepts valid short text with state mention', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['OH', 'IN'], regional_focus: 'Midwest', example_states: ['Ohio', 'Indiana'], trend: 'intensifying', impact: ['flooding', 'travel'], top_alert_types: ['Flood Warning'], hazard_focus: 'flood', mode: 'normal', post_type: 'digest', urgency: 'high', max_length: 450, style: '', recent_openings: [] } as any;
		const good = 'Flooding concerns are active across Ohio and Indiana this afternoon. Monitor local forecasts and follow NWS guidance for your area.';
		const result = validateLlmOutput(good, payload);
		expect(result.valid).toBe(true);
		expect(result.text).toBe(good.trim());
	});

	it('validateLlmOutput accepts national/regional geography markers without state codes', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['TX', 'OK'], regional_focus: 'Plains', example_states: ['Texas', 'Oklahoma'], trend: 'expanding', impact: ['fire weather', 'wind'], top_alert_types: ['Red Flag Warning'], hazard_focus: 'fire', mode: 'incident', post_type: 'digest', urgency: 'high', max_length: 450, style: '', recent_openings: [] } as any;
		const national = 'Critical fire weather conditions are widespread across the Southern Plains. High winds and low humidity continue to elevate fire risk.';
		const result = validateLlmOutput(national, payload);
		expect(result.valid).toBe(true);
	});

	it('buildLlmPayload derives regional focus, state names, trend, and impacts', () => {
		const { buildLlmPayload } = __testing as any;
		const payload = buildLlmPayload({
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'winter',
			states: ['OH', 'NY', 'IN', 'MO'],
			topAlertTypes: ['Winter Storm Warning', 'Wind Advisory'],
			urgency: 'moderate',
			alertCount: 8,
			hash: 'winter-cluster',
		}, ['Strong winds are affecting parts of the country.']);

		expect(payload.regional_focus).toBe('Midwest and Northeast');
		expect(payload.example_states).toEqual(['Ohio', 'New York', 'Indiana', 'Missouri']);
		expect(payload.trend).toBe('expanding');
		expect(payload.impact).toEqual(expect.arrayContaining(['snow', 'travel', 'wind']));
		expect(payload.recent_openings).toEqual(['Strong winds are affecting parts of the country.']);
	});

	it('buildLlmPayload applies the flood-plus-Texas regional override', () => {
		const { buildLlmPayload } = __testing as any;
		const payload = buildLlmPayload({
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'flood',
			states: ['TX', 'LA', 'MS'],
			topAlertTypes: ['Flood Warning', 'Flash Flood Warning'],
			urgency: 'high',
			alertCount: 6,
			hash: 'tx-flood',
		}, []);

		expect(payload.regional_focus).toBe('Gulf Coast and Southeast');
	});

	it('buildLlmPayload applies the coastal regional override when coastal impacts lead', () => {
		const { buildLlmPayload } = __testing as any;
		const payload = buildLlmPayload({
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'other',
			states: ['FL', 'SC'],
			topAlertTypes: ['Coastal Flood Advisory', 'High Surf Advisory'],
			urgency: 'moderate',
			alertCount: 4,
			hash: 'coastal-focus',
		}, []);

		expect(payload.impact).toContain('coastal conditions');
		expect(payload.regional_focus).toBe('Coastal areas');
	});

	it('buildLlmPayload applies the fire-plus-southwest regional override', () => {
		const { buildLlmPayload } = __testing as any;
		const payload = buildLlmPayload({
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'fire',
			states: ['TX', 'OK'],
			topAlertTypes: ['Red Flag Warning', 'Fire Weather Watch'],
			urgency: 'high',
			alertCount: 5,
			hash: 'fire-sw',
		}, []);

		expect(payload.regional_focus).toBe('Southwest');
	});

	it('buildUserPrompt uses regional context and anti-repetition guidance', () => {
		const { buildUserPrompt } = __testing as any;
		const prompt = buildUserPrompt({
			mode: 'incident',
			post_type: 'cluster',
			hazard_focus: 'flood',
			states: ['OH', 'NY', 'IN', 'MO'],
			regional_focus: 'Midwest and Northeast',
			example_states: ['Ohio', 'New York', 'Indiana', 'Missouri'],
			trend: 'intensifying',
			change_hint: 'intensity increased; impact shifting from Midwest toward Northeast',
			impact: ['flooding', 'travel'],
			top_alert_types: ['Flood Warning', 'Flood Watch'],
			urgency: 'high',
			max_length: 450,
			style: 'live national weather desk update, clear, concise, distinct, no hype',
			recent_openings: [
				'A high-volume flood alert surge...',
				'Strong winds are affecting...',
			],
		});

		expect(prompt).toContain('Regional focus: Midwest and Northeast.');
		expect(prompt).toContain('Example states: Ohio, New York, Indiana, Missouri.');
		expect(prompt).toContain('Trend: intensifying.');
		expect(prompt).toContain('Change hint: intensity increased; impact shifting from Midwest toward Northeast.');
		expect(prompt).toContain('Lead with what changed since the last digest update, not a static list of current alerts.');
		expect(prompt).toContain('Tell readers what changed since the last digest instead of summarizing the full alert board from scratch.');
		expect(prompt).toContain('Impact: flooding, travel.');
		expect(prompt).toContain('Avoid repeating these structures or phrasing:');
		expect(prompt).not.toContain('Affected states:');
		expect(prompt).not.toContain('High-volume national alert surge.');
	});

	it('buildUserPrompt adds update-comment framing for digest comments', () => {
		const { buildUserPrompt } = __testing as any;
		const prompt = buildUserPrompt({
			mode: 'incident',
			post_type: 'cluster',
			output_mode: 'comment',
			hazard_focus: 'flood',
			states: ['OH', 'IN'],
			regional_focus: 'Midwest',
			example_states: ['Ohio', 'Indiana'],
			trend: 'expanding',
			change_hint: 'new states added: Indiana; intensity increased',
			impact: ['flooding', 'travel'],
			top_alert_types: ['Flood Warning'],
			urgency: 'high',
			max_length: 450,
			style: 'live national weather desk update comment, brief, direct, change-focused, no hype',
			recent_openings: ['Flooding is building across Ohio tonight.'],
		});

		expect(prompt).toContain('Format: this is an UPDATE comment on an existing Facebook post.');
		expect(prompt).toContain('Start with "UPDATE:".');
		expect(prompt).toContain('You MUST describe what changed since the last post.');
		expect(prompt).toContain('Keep the update centered on flooding in Midwest.');
		expect(prompt).toContain('Do not pivot to a different primary hazard or a different lead region.');
		expect(prompt).toContain('DO NOT restate the full situation.');
		expect(prompt).toContain('Assume the reader already saw the previous post.');
		expect(prompt).toContain('Change hint: new states added: Indiana; intensity increased.');
		expect(prompt).toContain('Do not restart with a broad national summary.');
	});

	it('buildUserPrompt tells the model to ignore suppressed outlier states', () => {
		const { buildUserPrompt } = __testing as any;
		const prompt = buildUserPrompt({
			mode: 'incident',
			post_type: 'cluster',
			hazard_focus: 'winter',
			states: ['MN', 'ND', 'SD', 'WI'],
			regional_focus: 'northern Plains and Upper Midwest',
			example_states: ['Minnesota', 'North Dakota', 'South Dakota', 'Wisconsin'],
			trend: 'expanding',
			impact: ['snow', 'travel'],
			top_alert_types: ['Winter Storm Warning'],
			urgency: 'high',
			max_length: 450,
			style: 'live national weather desk update, clear, concise, distinct, no hype',
			recent_openings: [],
			suppressed_outliers: ['California', 'Wyoming'],
		});

		expect(prompt).toContain('Ignore these weaker or distant outlier states for this post: California, Wyoming.');
	});

	it('buildCommentChangeHint summarizes what shifted since the last digest update', () => {
		const { buildCommentChangeHint } = __testing as any;
		const changeHint = buildCommentChangeHint({
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'flood',
			states: ['OH'],
			topAlertTypes: ['Flood Watch'],
			urgency: 'moderate',
			alertCount: 3,
			hash: 'prev',
		}, {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'flood',
			states: ['OH', 'IN'],
			topAlertTypes: ['Flood Warning'],
			urgency: 'high',
			alertCount: 5,
			hash: 'next',
		});

		expect(changeHint).toBe('new states added: Indiana; intensity increased; alerts now led by Flood Warning');
	});

	it('buildCommentChangeHint uses regional overrides when comparing digest shifts', () => {
		const { buildCommentChangeHint } = __testing as any;
		const changeHint = buildCommentChangeHint({
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'flood',
			states: ['TX'],
			topAlertTypes: ['Flood Watch'],
			urgency: 'moderate',
			alertCount: 2,
			hash: 'prev-tx-flood',
		}, {
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'flood',
			states: ['TX', 'LA'],
			topAlertTypes: ['Flood Warning'],
			urgency: 'high',
			alertCount: 4,
			hash: 'next-tx-flood',
		});

		expect(changeHint).toBe('new states added: Louisiana; intensity increased; alerts now led by Flood Warning');
		expect(changeHint).not.toContain('impact shifting from Plains');
	});

	it('evaluateDigestStoryContinuity rejects digest comment pivots into a different hazard story', () => {
		const { evaluateDigestStoryContinuity } = __testing as any;
		const result = evaluateDigestStoryContinuity({
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'flood',
			states: ['OH', 'NY'],
			topAlertTypes: ['Flood Warning'],
			urgency: 'high',
			alertCount: 5,
			hash: 'prev-flood-story',
		}, {
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'wind',
			states: ['CA', 'NV', 'WY', 'IN'],
			topAlertTypes: ['High Wind Warning'],
			urgency: 'high',
			alertCount: 6,
			hash: 'next-wind-story',
		});

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe('hazard_focus_changed');
		expect(result.previousRegionalFocus).toBe('Midwest and Northeast');
		expect(result.currentRegionalFocus).toBe('West and Midwest');
	});

	it('evaluateDigestStoryContinuity rejects same-hazard digest updates that jump to a different region', () => {
		const { evaluateDigestStoryContinuity } = __testing as any;
		const result = evaluateDigestStoryContinuity({
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'wind',
			states: ['KS', 'OK', 'TX'],
			topAlertTypes: ['Wind Advisory'],
			urgency: 'moderate',
			alertCount: 4,
			hash: 'prev-plains-wind',
		}, {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'wind',
			states: ['AZ', 'CA', 'NV'],
			topAlertTypes: ['High Wind Warning'],
			urgency: 'high',
			alertCount: 5,
			hash: 'next-west-wind',
		});

		expect(result.allowed).toBe(false);
		expect(result.reason).toBe('regional_focus_changed');
		expect(result.previousRegionalFocus).toBe('Plains');
		expect(result.currentRegionalFocus).toBe('West and Southwest');
	});

	it('evaluateDigestChangeThresholds distinguishes routine updates from override-worthy digest changes', () => {
		const { evaluateDigestChangeThresholds } = __testing as any;
		const previousSummary = {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'flood',
			states: ['OH'],
			topAlertTypes: ['Flood Watch'],
			urgency: 'moderate',
			alertCount: 3,
			warningCount: 1,
			hash: 'prev-digest',
		} as any;

		const routine = evaluateDigestChangeThresholds(previousSummary, {
			...previousSummary,
			alertCount: 4,
			warningCount: 1,
			hash: 'routine-digest',
		});
		expect(routine.meaningfulPostChange).toBe(false);
		expect(routine.meaningfulCommentChange).toBe(false);
		expect(routine.overrideNewPost).toBe(false);

		const override = evaluateDigestChangeThresholds(previousSummary, {
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'flood',
			states: ['OH', 'IN'],
			topAlertTypes: ['Flood Warning'],
			urgency: 'high',
			alertCount: 8,
			warningCount: 4,
			hash: 'override-digest',
		});
		expect(override.addedStates).toEqual(['IN']);
		expect(override.majorEscalation).toBe(true);
		expect(override.outbreakBegan).toBe(true);
		expect(override.meaningfulCommentChange).toBe(true);
		expect(override.meaningfulPostChange).toBe(true);
		expect(override.overrideNewPost).toBe(true);
	});

	it('evaluateDigestChangeThresholds suppresses new posts for same-hazard same-region continuations', () => {
		const { evaluateDigestChangeThresholds } = __testing as any;
		const previousSummary = {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'winter',
			states: ['MN', 'WI'],
			storyRegion: 'northern Plains and Upper Midwest',
			topAlertTypes: ['Winter Storm Warning'],
			urgency: 'moderate',
			alertCount: 4,
			warningCount: 2,
			hash: 'prev-winter-story',
		} as any;

		const continuation = evaluateDigestChangeThresholds(previousSummary, {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'winter',
			states: ['MN', 'ND', 'SD', 'WI'],
			storyRegion: 'northern Plains and Upper Midwest',
			topAlertTypes: ['Winter Storm Warning'],
			urgency: 'moderate',
			alertCount: 6,
			warningCount: 3,
			hash: 'next-winter-story',
		} as any);

		expect(continuation.sameStorySuppressionCandidate).toBe(true);
		expect(continuation.meaningfulPostChange).toBe(false);
		expect(continuation.meaningfulCommentChange).toBe(true);
	});

	it('evaluateDigestChangeThresholds ignores rotated display states when the underlying story fingerprint is unchanged', () => {
		const { evaluateDigestChangeThresholds } = __testing as any;
		const previousSummary = {
			mode: 'incident',
			postType: 'cluster',
			hazardFocus: 'winter',
			states: ['MN', 'SD', 'WI'],
			storyStates: ['MN', 'ND', 'SD', 'WI'],
			storyRegion: 'northern Plains and Upper Midwest',
			storyFingerprint: 'winter|northern Plains and Upper Midwest|MN,ND,SD,WI|winter storm warning',
			topAlertTypes: ['Winter Storm Warning'],
			urgency: 'high',
			alertCount: 7,
			warningCount: 4,
			hash: 'winter-story-steady',
		} as any;

		const continuation = evaluateDigestChangeThresholds(previousSummary, {
			...previousSummary,
			states: ['ND', 'SD', 'WI'],
			alertCount: 8,
			warningCount: 4,
			hash: 'winter-story-rotated-display',
		} as any);

		expect(continuation.sameStorySuppressionCandidate).toBe(true);
		expect(continuation.meaningfulPostChange).toBe(false);
	});

	it('getDigestImageUrl selects hazard-specific digest art', () => {
		const { getDigestImageUrl } = __testing as any;
		const imageEnv = {
			FB_IMAGE_BASE_URL: 'https://cdn.example.com',
		} as any;

		expect(getDigestImageUrl(imageEnv, 'flood')).toBe('https://cdn.example.com/images/flooding-alerts.png');
		expect(getDigestImageUrl(imageEnv, 'winter')).toBe('https://cdn.example.com/images/winter-storm-alerts.png');
		expect(getDigestImageUrl(imageEnv, 'wind')).toBe('https://cdn.example.com/images/weather-alerts.png');
	});

	it('validateLlmOutput rejects banned stock phrases and accepts full state names', () => {
		const { validateLlmOutput } = __testing;
		const payload = {
			states: ['PA', 'MO'],
			regional_focus: 'Midwest and Northeast',
			example_states: ['Pennsylvania', 'Missouri'],
			trend: 'continuing',
			impact: ['flooding'],
			top_alert_types: ['Flood Warning'],
			hazard_focus: 'flood',
			mode: 'normal',
			post_type: 'digest',
			urgency: 'moderate',
			max_length: 450,
			style: '',
			recent_openings: [],
		} as any;

		expect(validateLlmOutput('Flooding is affecting several states including Pennsylvania and Missouri.', payload).failureReason)
			.toBe('contains_banned_phrase_affecting_several_states');
		expect(validateLlmOutput('Flooding is active across parts of the country, especially Pennsylvania.', payload).failureReason)
			.toBe('contains_banned_phrase_parts_of_country');
		expect(validateLlmOutput('Flood alerts are in effect across Pennsylvania this evening.', payload).failureReason)
			.toBe('contains_banned_phrase_alerts_in_effect');
		expect(validateLlmOutput('Flooding is intensifying in Pennsylvania this evening.', payload).failureReason)
			.toBe('contains_formulaic_change_phrase_is_intensifying');
		expect(validateLlmOutput('Flooding is expanding into Missouri tonight.', payload).failureReason)
			.toBe('contains_formulaic_change_phrase_is_expanding');
		expect(validateLlmOutput('Flooding continues in Pennsylvania and Missouri tonight with road impacts in low-lying areas.', payload).valid)
			.toBe(true);
	});

	it('validateLlmOutput requires UPDATE prefix for digest comments', () => {
		const { validateLlmOutput } = __testing;
		const payload = {
			states: ['OH'],
			regional_focus: 'Midwest',
			example_states: ['Ohio'],
			trend: 'continuing',
			impact: ['flooding'],
			top_alert_types: ['Flood Warning'],
			hazard_focus: 'flood',
			mode: 'normal',
			post_type: 'digest',
			output_mode: 'comment',
			urgency: 'moderate',
			max_length: 450,
			style: '',
			recent_openings: [],
		} as any;

		expect(validateLlmOutput('Flooding continues in Ohio tonight with road impacts in low-lying areas.', payload).failureReason)
			.toBe('missing_update_prefix');
		expect(validateLlmOutput('UPDATE: Flooding continues in Ohio tonight with road impacts in low-lying areas.', payload).valid)
			.toBe(true);
	});

	it('validateLlmOutput rejects text that reintroduces suppressed outlier states', () => {
		const { validateLlmOutput } = __testing;
		const payload = {
			states: ['MN', 'ND', 'SD', 'WI'],
			regional_focus: 'northern Plains and Upper Midwest',
			example_states: ['Minnesota', 'North Dakota', 'South Dakota', 'Wisconsin'],
			trend: 'expanding',
			impact: ['snow', 'travel'],
			top_alert_types: ['Winter Storm Warning'],
			hazard_focus: 'winter',
			mode: 'incident',
			post_type: 'cluster',
			urgency: 'high',
			max_length: 450,
			style: '',
			recent_openings: [],
			suppressed_outliers: ['California'],
		} as any;

		expect(
			validateLlmOutput('Winter weather is the main weather story right now across the northern Plains and Upper Midwest, with impacts centered in Minnesota and California.', payload).failureReason,
		).toBe('mentions_suppressed_outlier');
	});

	it('recordRecentDigestOpening keeps the newest distinct openings first', async () => {
		const { recordRecentDigestOpening, readRecentDigestOpenings } = __testing as any;

		await recordRecentDigestOpening(env, 'Flooding is building across Ohio tonight. Travel impacts are increasing.');
		await recordRecentDigestOpening(env, 'Snow and wind are pushing through New York and Pennsylvania this evening.');
		await recordRecentDigestOpening(env, 'Flooding is building across Ohio tonight. Travel impacts are increasing.');

		const openings = await readRecentDigestOpenings(env);
		expect(openings).toEqual([
			'Flooding is building across Ohio tonight.',
			'Snow and wind are pushing through New York and Pennsylvania this evening.',
		]);
	});

	it('runDigestCoverage records startup snapshot openings without calling the digest writer', async () => {
		const { runDigestCoverage, readRecentDigestOpenings } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const copyFn = vi.fn(async () => 'unused');
		await goodEnv.WEATHER_KV.put('fb:digest:recent-openings', JSON.stringify({ openings: [], updatedAt: new Date().toISOString() }));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', '');

		await runDigestCoverage(goodEnv, {
			'alert-startup-1': {
				id: 'alert-startup-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Ohio County',
					geocode: { UGC: ['OHC001', 'INC001', 'ILC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues across the region.',
				},
			},
		}, copyFn);

		expect(copyFn).not.toHaveBeenCalled();
		const openings = await readRecentDigestOpenings(goodEnv);
		expect(openings.length).toBeGreaterThan(0);
		expect(openings[0]).toMatch(/Flooding is the main weather story right now across/i);
	});

	it('runDigestCoverage skips startup and new posts during the shared Facebook cooldown', async () => {
		const { runDigestCoverage, readRecentDigestOpenings } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const copyFn = vi.fn(async () => 'This digest should never be written.');
		const recentPostAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();

		await goodEnv.WEATHER_KV.put('fb:digest:recent-openings', JSON.stringify({ openings: [], updatedAt: new Date().toISOString() }));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', recentPostAt);

		await runDigestCoverage(goodEnv, {
			'alert-global-gap-1': {
				id: 'alert-global-gap-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Ohio County',
					geocode: { UGC: ['OHC001', 'INC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues across the region.',
				},
			},
		}, copyFn);

		expect(copyFn).not.toHaveBeenCalled();
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) => String(input).includes('graph.facebook.com'))).toBe(false);
		const openings = await readRecentDigestOpenings(goodEnv);
		expect(openings).toEqual([]);
	});

	it('runDigestCoverage uses comment-mode copy for same-block digest updates', async () => {
		const { runDigestCoverage, readRecentDigestOpenings } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const nowMs = Date.now();
		const publishedAt = new Date(nowMs - 25 * 60 * 1000).toISOString();
		const blockId = `block-${Math.floor(nowMs / (60 * 60 * 1000))}`;
		const copyFn = vi.fn(async (_env: any, _summary: any, outputMode = 'post') => (
			outputMode === 'comment'
				? 'UPDATE: Flooding is intensifying in Ohio and Indiana tonight with travel impacts building.'
				: 'Flooding is the main weather story across Ohio and Indiana tonight.'
		));

		await goodEnv.WEATHER_KV.put('fb:digest:recent-openings', JSON.stringify({ openings: [], updatedAt: new Date().toISOString() }));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', publishedAt);
		await goodEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId,
			publishedAt,
			hash: 'existing-block-hash',
			postId: '12345',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: publishedAt },
		}));
		await goodEnv.WEATHER_KV.put(`fb:digest-thread:${blockId}`, JSON.stringify({
			postId: '12345',
			blockId,
			publishedAt,
			hash: 'older-thread-hash',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH'],
				topAlertTypes: ['Flood Warning'],
				urgency: 'moderate',
				alertCount: 1,
				warningCount: 1,
				hash: 'older-thread-hash',
			},
		}));

		await runDigestCoverage(goodEnv, {
			'alert-comment-1': {
				id: 'alert-comment-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Moderate',
					urgency: 'Immediate',
					areaDesc: 'Ohio and Indiana counties',
					geocode: { UGC: ['OHC001', 'INC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues and is worsening in low-lying areas.',
				},
			},
		}, copyFn);

		expect(copyFn).toHaveBeenCalled();
		expect(copyFn.mock.calls[0][2]).toBe('comment');
		expect(copyFn.mock.calls[0][1].changeHint).toBe('new states added: Indiana');
		const openings = await readRecentDigestOpenings(goodEnv);
		expect(openings[0]).toBe('Flooding is intensifying in Ohio and Indiana tonight with travel impacts building.');
	});

	it('runDigestCoverage posts a new override digest within the hour when warnings spike sharply', async () => {
		const { runDigestCoverage, readDigestThread } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const nowMs = Date.now();
		const publishedAt = new Date(nowMs - 20 * 60 * 1000).toISOString();
		const blockId = `block-${Math.floor(nowMs / (60 * 60 * 1000))}`;
		const copyFn = vi.fn(async (_env: any, _summary: any, outputMode = 'post') => (
			outputMode === 'comment'
				? 'UPDATE: This should not be used for the override path.'
				: 'Flooding continues to spread across Ohio and Indiana. Additional warnings are now coming into the story this hour.'
		));

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: 3,
			digestMinCommentGapMinutes: 20,
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', publishedAt);
		await goodEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId,
			publishedAt,
			hash: 'older-flood-hash',
			postId: '12345',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: publishedAt },
			recentPostTimestamps: [publishedAt],
		}));
		await goodEnv.WEATHER_KV.put(`fb:digest-thread:${blockId}`, JSON.stringify({
			postId: '12345',
			blockId,
			publishedAt,
			hash: 'older-flood-hash',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH', 'IN'],
				topAlertTypes: ['Flood Watch'],
				urgency: 'moderate',
				alertCount: 2,
				warningCount: 1,
				hash: 'older-flood-hash',
			},
		}));

		await runDigestCoverage(goodEnv, {
			'alert-override-1': {
				id: 'alert-override-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Ohio and Indiana counties',
					geocode: { UGC: ['OHC001', 'INC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues and warnings are increasing in coverage.',
				},
			},
			'alert-override-2': {
				id: 'alert-override-2',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Additional Ohio and Indiana counties',
					geocode: { UGC: ['OHC003', 'INC003'] },
					status: 'Actual',
					headline: 'Additional Flood Warning posted',
					description: 'Flooding continues in more low-lying areas.',
				},
			},
			'alert-override-3': {
				id: 'alert-override-3',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Even more Ohio and Indiana counties',
					geocode: { UGC: ['OHC005', 'INC005'] },
					status: 'Actual',
					headline: 'Flood Warning expanded again',
					description: 'Warnings continue to increase as flooding worsens.',
				},
			},
			'alert-override-4': {
				id: 'alert-override-4',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'New flood warning counties in Ohio and Indiana',
					geocode: { UGC: ['OHC007', 'INC007'] },
					status: 'Actual',
					headline: 'Flood Warning expanded again',
					description: 'Warnings continue to increase as flooding worsens.',
				},
			},
		}, copyFn);

		expect(copyFn).toHaveBeenCalled();
		expect(copyFn.mock.calls[0][2]).toBe('post');
		expect(copyFn.mock.calls[0][1].changeHint).toContain('intensity increased');
		expect((globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) => String(input).includes('/comments')).length).toBe(0);

		const storedThread = await readDigestThread(goodEnv, blockId);
		expect(storedThread?.commentCount).toBe(0);
		expect(storedThread?.summary?.topAlertTypes[0]).toBe('Flood Warning');
		expect(storedThread?.summary?.warningCount).toBe(4);
	});

	it('runDigestCoverage skips an hourly digest post when the story has not changed meaningfully', async () => {
		const { runDigestCoverage } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const nowMs = Date.now();
		const previousPublishedAt = new Date(nowMs - 65 * 60 * 1000).toISOString();
		const previousBlockId = `block-${Math.floor((nowMs - 65 * 60 * 1000) / (60 * 60 * 1000))}`;
		const copyFn = vi.fn(async () => 'This should not post.');

		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: 3,
			digestMinCommentGapMinutes: 20,
		}));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', previousPublishedAt);
		await goodEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId: previousBlockId,
			publishedAt: previousPublishedAt,
			hash: 'steady-flood-hash',
			postId: 'steady-post',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: previousPublishedAt },
			recentPostTimestamps: [previousPublishedAt],
		}));
		await goodEnv.WEATHER_KV.put(`fb:digest-thread:${previousBlockId}`, JSON.stringify({
			postId: 'steady-post',
			blockId: previousBlockId,
			publishedAt: previousPublishedAt,
			hash: 'steady-flood-hash',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH'],
				topAlertTypes: ['Flood Watch'],
				urgency: 'moderate',
				alertCount: 3,
				warningCount: 1,
				hash: 'steady-flood-hash',
			},
		}));
		await goodEnv.WEATHER_KV.put('fb:digest:hash', 'steady-flood-hash');

		await runDigestCoverage(goodEnv, {
			'alert-steady-1': {
				id: 'alert-steady-1',
				properties: {
					event: 'Flood Watch',
					severity: 'Moderate',
					urgency: 'Expected',
					areaDesc: 'Ohio County',
					geocode: { UGC: ['OHC001'] },
					status: 'Actual',
					headline: 'Flood Watch remains in effect',
					description: 'Minor flooding concerns continue in the same area.',
				},
			},
		}, copyFn);

		expect(copyFn).not.toHaveBeenCalled();
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) => String(input).includes('/feed'))).toBe(false);
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) => String(input).includes('/comments'))).toBe(false);
	});

	it('evaluateDigestCoverageIntent surfaces explicit pacing reasons for new posts, comments, and skips', async () => {
		const { evaluateDigestCoverageIntent } = __testing as any;
		const nowMs = Date.now();

		const hourlyEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const oldPublishedAt = new Date(nowMs - 70 * 60 * 1000).toISOString();
		const oldBlockId = `block-${Math.floor((nowMs - 70 * 60 * 1000) / (60 * 60 * 1000))}`;
		await hourlyEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: 3,
			digestMinCommentGapMinutes: 20,
		}));
		await hourlyEnv.WEATHER_KV.put('fb:last-post-timestamp', oldPublishedAt);
		await hourlyEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId: oldBlockId,
			publishedAt: oldPublishedAt,
			hash: 'old-flood-story',
			postId: 'old-flood-post',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: oldPublishedAt },
			recentPostTimestamps: [oldPublishedAt],
		}));
		await hourlyEnv.WEATHER_KV.put(`fb:digest-thread:${oldBlockId}`, JSON.stringify({
			postId: 'old-flood-post',
			blockId: oldBlockId,
			publishedAt: oldPublishedAt,
			hash: 'old-flood-story',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH'],
				storyStates: ['OH'],
				storyRegion: 'Midwest',
				topAlertTypes: ['Flood Warning'],
				urgency: 'moderate',
				alertCount: 2,
				warningCount: 1,
				hash: 'old-flood-story',
			},
		}));

		const hourlyEvaluation = await evaluateDigestCoverageIntent(hourlyEnv, {
			'winter-hourly-1': {
				id: 'winter-hourly-1',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Minnesota and Wisconsin counties',
					geocode: { UGC: ['MNC001', 'WIC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
		}, nowMs);
		expect(hourlyEvaluation.intent?.action).toBe('post');
		expect(hourlyEvaluation.intent?.reason).toBe('digest_new_post_allowed_after_60m');

		const sameStoryEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const recentPublishedAt = new Date(nowMs - 25 * 60 * 1000).toISOString();
		const recentBlockId = `block-${Math.floor(nowMs / (60 * 60 * 1000))}`;
		await sameStoryEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: 3,
			digestMinCommentGapMinutes: 20,
		}));
		await sameStoryEnv.WEATHER_KV.put('fb:last-post-timestamp', recentPublishedAt);
		await sameStoryEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId: recentBlockId,
			publishedAt: recentPublishedAt,
			hash: 'recent-flood-story',
			postId: 'recent-flood-post',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: recentPublishedAt },
			recentPostTimestamps: [recentPublishedAt],
		}));
		await sameStoryEnv.WEATHER_KV.put(`fb:digest-thread:${recentBlockId}`, JSON.stringify({
			postId: 'recent-flood-post',
			blockId: recentBlockId,
			publishedAt: recentPublishedAt,
			hash: 'recent-flood-story',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH'],
				storyStates: ['OH'],
				storyRegion: 'Midwest',
				topAlertTypes: ['Flood Warning'],
				urgency: 'moderate',
				alertCount: 2,
				warningCount: 1,
				hash: 'recent-flood-story',
			},
		}));

		const commentEvaluation = await evaluateDigestCoverageIntent(sameStoryEnv, {
			'comment-flood-1': {
				id: 'comment-flood-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Moderate',
					urgency: 'Immediate',
					areaDesc: 'Ohio and Indiana counties',
					geocode: { UGC: ['OHC001', 'INC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues and is worsening in low-lying areas.',
				},
			},
		}, nowMs);
		expect(commentEvaluation.intent?.action).toBe('comment');
		expect(commentEvaluation.intent?.reason).toBe('digest_same_story_comment_only');

		const skipEvaluation = await evaluateDigestCoverageIntent(sameStoryEnv, {
			'skip-flood-1': {
				id: 'skip-flood-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Moderate',
					urgency: 'Expected',
					areaDesc: 'Ohio County',
					geocode: { UGC: ['OHC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Minor flooding concerns continue in the same area.',
				},
			},
		}, nowMs);
		expect(skipEvaluation.intent).toBeNull();
		expect(skipEvaluation.blockedReason).toBe('digest_same_story_skip');

		const warningJumpEvaluation = await evaluateDigestCoverageIntent(sameStoryEnv, {
			'warning-jump-1': {
				id: 'warning-jump-1',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Ohio County',
					geocode: { UGC: ['OHC001'] },
					status: 'Actual',
					headline: 'Flood Warning remains in effect',
					description: 'Flooding continues and warnings are increasing in coverage.',
				},
			},
			'warning-jump-2': {
				id: 'warning-jump-2',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Indiana County',
					geocode: { UGC: ['INC001'] },
					status: 'Actual',
					headline: 'Additional Flood Warning posted',
					description: 'Flooding continues in more low-lying areas.',
				},
			},
			'warning-jump-3': {
				id: 'warning-jump-3',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Additional Ohio County',
					geocode: { UGC: ['OHC003'] },
					status: 'Actual',
					headline: 'Flood Warning expanded again',
					description: 'Warnings continue to increase as flooding worsens.',
				},
			},
			'warning-jump-4': {
				id: 'warning-jump-4',
				properties: {
					event: 'Flood Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Additional Indiana County',
					geocode: { UGC: ['INC003'] },
					status: 'Actual',
					headline: 'Flood Warning expanded again',
					description: 'Warnings continue to increase as flooding worsens.',
				},
			},
		}, nowMs);
		expect(warningJumpEvaluation.intent?.action).toBe('post');
		expect(warningJumpEvaluation.intent?.reason).toBe('digest_second_post_allowed_warning_jump');
	});

	it('runDigestCoverage passes a coherent regional winter story into digest copy generation', async () => {
		const { runDigestCoverage } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const nowMs = Date.now();
		const previousPublishedAt = new Date(nowMs - 65 * 60 * 1000).toISOString();
		const previousBlockId = `block-${Math.floor((nowMs - 65 * 60 * 1000) / (60 * 60 * 1000))}`;
		const copyFn = vi.fn(async () => 'Winter weather is the main weather story right now across the northern Plains and Upper Midwest tonight.');

		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', previousPublishedAt);
		await goodEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId: previousBlockId,
			publishedAt: previousPublishedAt,
			hash: 'older-flood-story',
			postId: 'flood-story-post',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: previousPublishedAt },
			recentPostTimestamps: [previousPublishedAt],
		}));
		await goodEnv.WEATHER_KV.put(`fb:digest-thread:${previousBlockId}`, JSON.stringify({
			postId: 'flood-story-post',
			blockId: previousBlockId,
			publishedAt: previousPublishedAt,
			hash: 'older-flood-story',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'normal',
				postType: 'digest',
				hazardFocus: 'flood',
				states: ['OH', 'IN'],
				storyRegion: 'Midwest',
				topAlertTypes: ['Flood Warning'],
				urgency: 'moderate',
				alertCount: 3,
				warningCount: 1,
				hash: 'older-flood-story',
			},
		}));

		await runDigestCoverage(goodEnv, {
			'winter-mn': {
				id: 'winter-mn',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Minnesota counties',
					geocode: { UGC: ['MNC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-wi': {
				id: 'winter-wi',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'Wisconsin counties',
					geocode: { UGC: ['WIC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-sd': {
				id: 'winter-sd',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'South Dakota counties',
					geocode: { UGC: ['SDC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-nd': {
				id: 'winter-nd',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'North Dakota counties',
					geocode: { UGC: ['NDC001'] },
					status: 'Actual',
					headline: 'Winter storm warning',
					description: 'Heavy snow and ice expected.',
				},
			},
			'winter-ca': {
				id: 'winter-ca',
				properties: {
					event: 'Winter Storm Warning',
					severity: 'Severe',
					urgency: 'Expected',
					areaDesc: 'California mountain counties',
					geocode: { UGC: ['CAC001'] },
					status: 'Actual',
					headline: 'California winter storm warning',
					description: 'Mountain snow expected in California.',
				},
			},
			'winter-wy': {
				id: 'winter-wy',
				properties: {
					event: 'Winter Weather Advisory',
					severity: 'Moderate',
					urgency: 'Expected',
					areaDesc: 'Wyoming counties',
					geocode: { UGC: ['WYC001'] },
					status: 'Actual',
					headline: 'Wyoming winter weather advisory',
					description: 'Light snow and travel impacts possible.',
				},
			},
		}, copyFn);

		expect(copyFn).toHaveBeenCalledTimes(1);
		const summary = copyFn.mock.calls[0][1];
		expect(summary.hazardFocus).toBe('winter');
		expect(summary.storyRegion).toBe('northern Plains and Upper Midwest');
		expect(summary.states).toEqual(['MN', 'ND', 'SD', 'WI']);
		expect(summary.outlierStates).toEqual(expect.arrayContaining(['CA', 'WY']));
	});

	it('runDigestCoverage starts a new override digest instead of commenting when the story pivots away from the parent thread', async () => {
		const { runDigestCoverage, readDigestThread, readRecentDigestOpenings } = __testing as any;
		const goodEnv = { ...env, FB_PAGE_ID: 'page-1', FB_PAGE_ACCESS_TOKEN: 'token-1' } as any;
		const nowMs = Date.now();
		const publishedAt = new Date(nowMs - 25 * 60 * 1000).toISOString();
		const blockId = `block-${Math.floor(nowMs / (60 * 60 * 1000))}`;
		const copyFn = vi.fn(async (_env: any, _summary: any, outputMode = 'post') => (
			outputMode === 'comment'
				? 'UPDATE: This comment should never be posted.'
				: 'High winds are becoming the main weather story across California, Nevada, Wyoming, and Indiana tonight.'
		));

		await goodEnv.WEATHER_KV.put('fb:digest:recent-openings', JSON.stringify({ openings: [], updatedAt: new Date().toISOString() }));
		await goodEnv.WEATHER_KV.put('fb:last-post-timestamp', publishedAt);
		await goodEnv.WEATHER_KV.put('fb:digest:block', JSON.stringify({
			blockId,
			publishedAt,
			hash: 'existing-block-hash',
			postId: '12345',
			hazardFocus: 'flood',
			lastPublishedAtByFocus: { flood: publishedAt },
		}));
		await goodEnv.WEATHER_KV.put(`fb:digest-thread:${blockId}`, JSON.stringify({
			postId: '12345',
			blockId,
			publishedAt,
			hash: 'older-thread-hash',
			commentCount: 0,
			lastCommentAt: null,
			summary: {
				mode: 'incident',
				postType: 'cluster',
				hazardFocus: 'flood',
				states: ['OH', 'NY'],
				topAlertTypes: ['Flood Warning'],
				urgency: 'high',
				alertCount: 3,
				hash: 'older-thread-hash',
			},
		}));

		await runDigestCoverage(goodEnv, {
			'alert-comment-shift': {
				id: 'alert-comment-shift',
				properties: {
					event: 'High Wind Warning',
					severity: 'Severe',
					urgency: 'Immediate',
					areaDesc: 'California, Nevada, Wyoming, and Indiana counties',
					geocode: { UGC: ['CAC001', 'NVC001', 'WYC001', 'INC001'] },
					status: 'Actual',
					headline: 'High Wind Warning remains in effect',
					description: 'Strong winds continue across the West and into parts of the Midwest.',
				},
			},
		}, copyFn);

		expect(copyFn).toHaveBeenCalledTimes(1);
		expect(copyFn.mock.calls[0][2]).toBe('post');
		expect((globalThis.fetch as any).mock.calls.some(([input]: [RequestInfo]) => String(input).includes('/comments'))).toBe(false);
		expect(
			(globalThis.fetch as any).mock.calls.filter(([input]: [RequestInfo]) =>
				String(input).includes('/photos') || String(input).includes('/feed'),
			).length,
		).toBeGreaterThan(0);

		const thread = await readDigestThread(goodEnv, blockId);
		expect(thread?.commentCount).toBe(0);
		expect(thread?.summary?.hazardFocus).toBe('wind');

		const openings = await readRecentDigestOpenings(goodEnv);
		expect(openings[0]).toBe('High winds are becoming the main weather story across California, Nevada, Wyoming, and Indiana tonight.');
	});

	it('generateDigestCopy falls back to template when AI is unavailable', async () => {
		const { generateDigestCopy } = __testing;

		const summary = {
			mode: 'normal',
			postType: 'digest',
			hazardFocus: 'flood',
			states: ['OH', 'IN'],
			topAlertTypes: ['Flood Warning', 'Flood Watch'],
			urgency: 'high',
			alertCount: 5,
			hash: 'test-hash',
		} as any;

		// Env without AI binding
		const result = await generateDigestCopy(env, summary);
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(10);
		// Template fallback should mention flood and states
		expect(result.toLowerCase()).toMatch(/flood/);
	});

	it('admin auto-post-config endpoint saves and returns multi-day SPC settings', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };
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

		const ctx = createExecutionContext();
		const configRequest = new IncomingRequest('https://live-weather.example/admin/auto-post-config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Cookie: cookie },
			body: JSON.stringify({
				mode: 'smart_high_impact',
				digestCoverageEnabled: true,
				digestCommentUpdatesEnabled: true,
				digestMaxCommentsPerThread: 2,
				digestMinCommentGapMinutes: 25,
				llmCopyEnabled: true,
				startupCatchupEnabled: true,
				spcDay1CoverageEnabled: true,
				spcDay1MinRiskLevel: 'slight',
				spcDay2CoverageEnabled: true,
				spcDay2MinRiskLevel: 'enhanced',
				spcDay3CoverageEnabled: true,
				spcDay3MinRiskLevel: 'moderate',
				spcHashtagsEnabled: false,
				spcLlmEnabled: true,
				spcTimingRefreshEnabled: false,
			}),
		});
		const response = await worker.fetch(configRequest, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.success).toBe(true);
		expect(json.config.mode).toBe('smart_high_impact');
		expect(json.config.digestCoverageEnabled).toBe(true);
		expect(json.config.digestCommentUpdatesEnabled).toBe(true);
		expect(json.config.digestMaxCommentsPerThread).toBe(2);
		expect(json.config.digestMinCommentGapMinutes).toBe(25);
		expect(json.config.llmCopyEnabled).toBe(true);
		expect(json.config.startupCatchupEnabled).toBe(true);
		expect(json.config.spcCoverageEnabled).toBe(true);
		expect(json.config.spcMinRiskLevel).toBe('slight');
		expect(json.config.spcDay1CoverageEnabled).toBe(true);
		expect(json.config.spcDay1MinRiskLevel).toBe('slight');
		expect(json.config.spcDay2CoverageEnabled).toBe(true);
		expect(json.config.spcDay2MinRiskLevel).toBe('enhanced');
		expect(json.config.spcDay3CoverageEnabled).toBe(true);
		expect(json.config.spcDay3MinRiskLevel).toBe('moderate');
		expect(json.config.spcHashtagsEnabled).toBe(false);
		expect(json.config.spcLlmEnabled).toBe(true);
		expect(json.config.spcTimingRefreshEnabled).toBe(false);

		// Re-read from KV to confirm persistence
		const stored = await goodEnv.WEATHER_KV.get('fb:auto-post-config');
		expect(stored).not.toBeNull();
		const parsed = JSON.parse(stored!);
		expect(parsed.digestCoverageEnabled).toBe(true);
		expect(parsed.digestCommentUpdatesEnabled).toBe(true);
		expect(parsed.digestMaxCommentsPerThread).toBe(2);
		expect(parsed.digestMinCommentGapMinutes).toBe(25);
		expect(parsed.llmCopyEnabled).toBe(true);
		expect(parsed.startupCatchupEnabled).toBe(true);
		expect(parsed.spcCoverageEnabled).toBe(true);
		expect(parsed.spcMinRiskLevel).toBe('slight');
		expect(parsed.spcDay1CoverageEnabled).toBe(true);
		expect(parsed.spcDay1MinRiskLevel).toBe('slight');
		expect(parsed.spcDay2CoverageEnabled).toBe(true);
		expect(parsed.spcDay2MinRiskLevel).toBe('enhanced');
		expect(parsed.spcDay3CoverageEnabled).toBe(true);
		expect(parsed.spcDay3MinRiskLevel).toBe('moderate');
		expect(parsed.spcHashtagsEnabled).toBe(false);
		expect(parsed.spcLlmEnabled).toBe(true);
		expect(parsed.spcTimingRefreshEnabled).toBe(false);
	});

	it('admin page renders digest and multi-day SPC lane controls', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };

		// Pre-set config with all toggles on
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			digestCommentUpdatesEnabled: true,
			digestMaxCommentsPerThread: 3,
			digestMinCommentGapMinutes: 20,
			llmCopyEnabled: false,
			startupCatchupEnabled: true,
			spcDay1CoverageEnabled: true,
			spcDay1MinRiskLevel: 'slight',
			spcDay2CoverageEnabled: true,
			spcDay2MinRiskLevel: 'enhanced',
			spcDay3CoverageEnabled: true,
			spcDay3MinRiskLevel: 'moderate',
			spcHashtagsEnabled: false,
			spcLlmEnabled: true,
			spcTimingRefreshEnabled: false,
		}));

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

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new IncomingRequest('https://live-weather.example/admin', { headers: { Cookie: cookie } }),
			goodEnv as any,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('digestCoverageEnabled');
		expect(body).toContain('digestCommentUpdatesEnabled');
		expect(body).toContain('digestMaxCommentsPerThread');
		expect(body).toContain('digestMinCommentGapMinutes');
		expect(body).toContain('llmCopyEnabled');
		expect(body).toContain('startupCatchupEnabled');
		expect(body).toContain('spcDay1CoverageEnabled');
		expect(body).toContain('spcDay1MinRiskLevel');
		expect(body).toContain('spcDay2CoverageEnabled');
		expect(body).toContain('spcDay2MinRiskLevel');
		expect(body).toContain('spcDay3CoverageEnabled');
		expect(body).toContain('spcDay3MinRiskLevel');
		expect(body).toContain('spcHashtagsEnabled');
		expect(body).toContain('spcLlmEnabled');
		expect(body).toContain('spcTimingRefreshEnabled');
		expect(body).toContain('Digest coverage');
		expect(body).toContain('Digest comment updates');
		expect(body).toContain('Max digest comments per thread');
		expect(body).toContain('Minutes between digest comments');
		expect(body).toContain('AI-generated copy');
		expect(body).toContain('Startup / catch-up mode');
		expect(body).toContain('SPC Outlook Lane');
		expect(body).toContain('SPC Day 1 coverage');
		expect(body).toContain('SPC Day 2 coverage');
		expect(body).toContain('SPC Day 3 coverage');
		expect(body).toContain('Day 1 minimum risk');
		expect(body).toContain('SPC AI polish (V1.5)');
		expect(body).toContain('forecast-desk writing');
		expect(body).not.toContain('Reserved for future V1.5 polish');
	});

	it('markAlertStandaloneCovered and readStandaloneCoveredAlerts round-trip correctly', async () => {
		const { markAlertStandaloneCovered, readStandaloneCoveredAlerts } = __testing;

		const before = await readStandaloneCoveredAlerts(env);
		expect(before.size).toBe(0);

		await markAlertStandaloneCovered(env, 'alert-abc');
		await markAlertStandaloneCovered(env, 'alert-def');

		const after = await readStandaloneCoveredAlerts(env);
		expect(after.has('alert-abc')).toBe(true);
		expect(after.has('alert-def')).toBe(true);
		expect(after.has('alert-xyz')).toBe(false);
	});});
