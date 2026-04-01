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
		expect(body).toContain('Facebook Post');
		expect(body).toContain('Facebook Post Ranking');
		expect(body).toContain('Priority is a relative ranking number');
		expect(body).toContain('Forecast Center');
		expect(body).toContain('NWS Discussions');
		expect(body).toContain('Convective Outlook');
		expect(body).toContain('3-Day USA Summary');
		expect(body).toContain('liveWeatherAdminFilters:v1');
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

	it('uses a change-only facebook comment when admin posts the default alert text into an existing thread', async () => {
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
		const commentCall = (globalThis.fetch as any).mock.calls.find(([input]: [RequestInfo]) =>
			String(input).includes('/existing-post-1/comments'),
		);
		expect(commentCall).toBeTruthy();
		const commentBody = commentCall?.[1]?.body;
		const commentParams = commentBody instanceof URLSearchParams
			? commentBody
			: new URLSearchParams(String(commentBody || ''));
		const message = String(commentParams.get('message') || '');
		expect(message).toContain('🔄 UPDATE — Tornado Warning for Test County');
		expect(message).toContain('NWS updated this alert with no major text changes.');
		expect(message).not.toContain('https://liveweatheralerts.com');
		expect(message).not.toContain('#weatheralert');
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

	it('qualifies smart auto-post warnings using the updated family-specific rules', async () => {
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
		expect(floodDecision.reason).toBe('ten_county_warning');

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
		expect(winterDecision.reason).toBe('ten_county_warning');

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
		expect(metroSevereStrongDecision.reason).toBe('major_metro_warning');

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
		expect(tenCountySevereDecision.reason).toBe('ten_county_warning');

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

	it('selects the top two severe weather fallback auto-posts by metro priority before regional coverage', async () => {
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

		expect(overrides.get('nyc-watch')).toMatchObject({
			eligible: true,
			reason: 'severe_weather_fallback',
		});
		expect(overrides.get('dfw-warning')).toMatchObject({
			eligible: true,
			reason: 'severe_weather_fallback',
		});
		expect(overrides.get('regional-warning')).toMatchObject({
			eligible: false,
			reason: 'severe_weather_fallback_not_selected',
		});
	});

	it('disables severe weather fallback when a tornado warning is active in the same batch', async () => {
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

	it('normalizeFbAutoPostConfig handles new digest/llm/startup fields', () => {
		const { normalizeFbAutoPostConfig } = __testing;

		const base = normalizeFbAutoPostConfig(null);
		expect(base.digestCoverageEnabled).toBe(false);
		expect(base.llmCopyEnabled).toBe(false);
		expect(base.startupCatchupEnabled).toBe(false);

		const full = normalizeFbAutoPostConfig({
			mode: 'smart_high_impact',
			updatedAt: '2026-04-01T00:00:00.000Z',
			digestCoverageEnabled: true,
			llmCopyEnabled: true,
			startupCatchupEnabled: true,
		});
		expect(full.mode).toBe('smart_high_impact');
		expect(full.digestCoverageEnabled).toBe(true);
		expect(full.llmCopyEnabled).toBe(true);
		expect(full.startupCatchupEnabled).toBe(true);

		// Legacy boolean format still works and defaults new fields to false
		const legacy = normalizeFbAutoPostConfig(true);
		expect(legacy.mode).toBe('tornado_only');
		expect(legacy.digestCoverageEnabled).toBe(false);
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

	it('buildStartupSnapshotText creates a readable snapshot with date', () => {
		const { buildStartupSnapshotText } = __testing;

		const clusters = [
			{ family: 'flood', states: ['OH', 'IN', 'IL'], score: 15, alertCount: 5, topAlertTypes: ['Flood Warning'] },
			{ family: 'winter', states: ['MN', 'WI'], score: 8, alertCount: 3, topAlertTypes: ['Winter Storm Watch'] },
		];

		const text = buildStartupSnapshotText(clusters as any, 8);
		expect(text).toContain('CURRENT WEATHER SITUATION');
		expect(text).toContain('8 active weather alerts');
		expect(text).toContain('Flooding concerns');
		expect(text).toContain('OH');
		expect(text).toContain('Winter weather');
		expect(text).toContain('liveweatheralerts.com');
	});

	it('buildStartupSnapshotText handles empty clusters gracefully', () => {
		const { buildStartupSnapshotText } = __testing;
		const text = buildStartupSnapshotText([], 0);
		expect(text).toContain('CURRENT WEATHER SITUATION');
		expect(text).toContain('No significant weather');
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
		const payload = { states: ['TX'], top_alert_types: [], hazard_focus: null, mode: 'normal', post_type: 'digest', urgency: 'low', max_length: 450, style: '' } as any;
		const withHashtag = 'Flooding conditions in TX. #weather #wx';
		expect(validateLlmOutput(withHashtag, payload).valid).toBe(false);
		expect(validateLlmOutput(withHashtag, payload).failureReason).toBe('contains_hashtag');
	});

	it('validateLlmOutput accepts valid short text with state mention', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['OH', 'IN'], top_alert_types: ['Flood Warning'], hazard_focus: 'flood', mode: 'normal', post_type: 'digest', urgency: 'high', max_length: 450, style: '' } as any;
		const good = 'Flooding concerns are active across Ohio and Indiana this afternoon. Monitor local forecasts and follow NWS guidance for your area.';
		const result = validateLlmOutput(good, payload);
		expect(result.valid).toBe(true);
		expect(result.text).toBe(good.trim());
	});

	it('validateLlmOutput accepts national/regional geography markers without state codes', () => {
		const { validateLlmOutput } = __testing;
		const payload = { states: ['TX', 'OK'], top_alert_types: ['Red Flag Warning'], hazard_focus: 'fire', mode: 'incident', post_type: 'digest', urgency: 'high', max_length: 450, style: '' } as any;
		const national = 'Critical fire weather conditions are widespread across the Southern Plains. High winds and low humidity continue to elevate fire risk.';
		const result = validateLlmOutput(national, payload);
		expect(result.valid).toBe(true);
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

	it('admin auto-post-config endpoint saves and returns new digest fields', async () => {
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
				llmCopyEnabled: true,
				startupCatchupEnabled: true,
			}),
		});
		const response = await worker.fetch(configRequest, goodEnv as any, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const json = await response.json() as any;
		expect(json.success).toBe(true);
		expect(json.config.mode).toBe('smart_high_impact');
		expect(json.config.digestCoverageEnabled).toBe(true);
		expect(json.config.llmCopyEnabled).toBe(true);
		expect(json.config.startupCatchupEnabled).toBe(true);

		// Re-read from KV to confirm persistence
		const stored = await goodEnv.WEATHER_KV.get('fb:auto-post-config');
		expect(stored).not.toBeNull();
		const parsed = JSON.parse(stored!);
		expect(parsed.digestCoverageEnabled).toBe(true);
		expect(parsed.llmCopyEnabled).toBe(true);
		expect(parsed.startupCatchupEnabled).toBe(true);
	});

	it('admin page renders digest/llm/startup checkboxes', async () => {
		const goodEnv = { ...env, ADMIN_PASSWORD: 'testpassword' };

		// Pre-set config with all toggles on
		await goodEnv.WEATHER_KV.put('fb:auto-post-config', JSON.stringify({
			mode: 'smart_high_impact',
			updatedAt: new Date().toISOString(),
			digestCoverageEnabled: true,
			llmCopyEnabled: false,
			startupCatchupEnabled: true,
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
		expect(body).toContain('llmCopyEnabled');
		expect(body).toContain('startupCatchupEnabled');
		expect(body).toContain('Digest coverage');
		expect(body).toContain('AI-generated copy');
		expect(body).toContain('Startup / catch-up mode');
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
