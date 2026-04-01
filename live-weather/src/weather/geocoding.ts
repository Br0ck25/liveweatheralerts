import { type SavedLocation, HttpError } from '../types';
import { NWS_USER_AGENT, NWS_ACCEPT, DEFAULT_WEATHER_LAT, DEFAULT_WEATHER_LON, ZIP_RE } from '../constants';
import { stateNameToCode } from '../utils';
import { apiCorsHeaders, corsHeaders } from '../public-api';

export async function lookupNwsZoneCode(lat: number, lon: number): Promise<string | undefined> {
	try {
		const endpoint = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
		const res = await fetch(endpoint, {
			headers: { 'User-Agent': NWS_USER_AGENT, Accept: NWS_ACCEPT },
		});
		if (!res.ok) return undefined;
		const payload = await res.json() as any;
		const zoneUrl = String(payload?.properties?.forecastZone || '');
		const match = zoneUrl.match(/\/([A-Z]{2}Z\d{3})$/i);
		return match ? match[1].toUpperCase() : undefined;
	} catch {
		return undefined;
	}
}

export async function lookupCountyByLatLon(lat: number, lon: number): Promise<{ county?: string; countyCode?: string }> {
	try {
		const endpoint = new URL('https://geo.fcc.gov/api/census/block/find');
		endpoint.searchParams.set('latitude', lat.toFixed(6));
		endpoint.searchParams.set('longitude', lon.toFixed(6));
		endpoint.searchParams.set('showall', 'true');
		endpoint.searchParams.set('format', 'json');

		const response = await fetch(endpoint.toString(), {
			headers: {
				Accept: 'application/json',
			},
		});

		if (!response.ok) return {};

		const payload = await response.json() as any;
		const county = String(payload?.County?.name || '').trim() || undefined;
		const rawFips = String(payload?.County?.FIPS || '').trim();
		const countyCode = /^\d+$/.test(rawFips)
			? rawFips.padStart(3, '0').slice(-3)
			: undefined;

		return { county, countyCode };
	} catch {
		return {};
	}
}

export async function geocodePlaceQuery(query: string): Promise<SavedLocation> {
	const endpoint = new URL('https://nominatim.openstreetmap.org/search');
	endpoint.searchParams.set('q', query);
	endpoint.searchParams.set('countrycodes', 'us');
	endpoint.searchParams.set('format', 'jsonv2');
	endpoint.searchParams.set('addressdetails', '1');
	endpoint.searchParams.set('limit', '1');

	const response = await fetch(endpoint.toString(), {
		headers: {
			'User-Agent': NWS_USER_AGENT,
			Accept: 'application/json',
		},
	});

	if (response.status === 404) {
		throw new HttpError(404, 'Location not found.');
	}
	if (!response.ok) {
		throw new HttpError(502, `Location lookup failed: ${response.status} ${response.statusText}`);
	}

	const payload = await response.json() as any;
	const top = Array.isArray(payload) ? payload[0] : null;
	if (!top) {
		throw new HttpError(404, 'Location not found.');
	}

	const lat = Number(top?.lat);
	const lon = Number(top?.lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		throw new HttpError(502, 'Location lookup returned invalid coordinates.');
	}

	const address = top?.address ?? {};
	const city = String(
		address?.city
		|| address?.town
		|| address?.village
		|| address?.hamlet
		|| address?.municipality
		|| ''
	).trim() || undefined;

	const isoState = String(address?.['ISO3166-2-lvl4'] || '').trim();
	let state = '';
	if (/^US-[A-Z]{2}$/i.test(isoState)) {
		state = isoState.slice(3).toUpperCase();
	}
	if (!state) {
		state = stateNameToCode(String(address?.state || '').trim());
	}

	const fccCounty = await lookupCountyByLatLon(lat, lon);
	const county = fccCounty.county || String(address?.county || '').trim() || undefined;
	const countyCode = fccCounty.countyCode;
	const zoneCode = await lookupNwsZoneCode(lat, lon);
	const label = city && state ? `${city}, ${state}` : (state || query);

	return {
		lat,
		lon,
		city,
		state: state || undefined,
		county,
		countyCode,
		zoneCode,
		label,
	};
}

export async function geocodeZip(zip: string): Promise<SavedLocation> {
	const endpoint = `https://api.zippopotam.us/us/${encodeURIComponent(zip)}`;
	const response = await fetch(endpoint, {
		headers: {
			Accept: 'application/json',
		},
	});

	if (response.status === 404) {
		throw new HttpError(404, 'ZIP code not found.');
	}
	if (!response.ok) {
		throw new HttpError(502, `ZIP lookup failed: ${response.status} ${response.statusText}`);
	}

	const payload = await response.json() as any;
	const place = Array.isArray(payload?.places) ? payload.places[0] : null;
	if (!place) {
		throw new HttpError(404, 'ZIP code not found.');
	}

	const lat = Number(place?.latitude);
	const lon = Number(place?.longitude);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		throw new HttpError(502, 'ZIP lookup returned invalid coordinates.');
	}

	const city = String(place?.['place name'] || '').trim() || undefined;
	const state = String(place?.['state abbreviation'] || '').trim() || undefined;
	const label = city && state ? `${city}, ${state}` : zip;
	const county = await lookupCountyByLatLon(lat, lon);
	const zoneCode = await lookupNwsZoneCode(lat, lon);

	return {
		lat,
		lon,
		city,
		state,
		zip,
		county: county.county,
		countyCode: county.countyCode,
		zoneCode,
		label,
	};
}

export async function reverseGeocodePoint(lat: number, lon: number): Promise<SavedLocation> {
	const endpoint = `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
	const response = await fetch(endpoint, {
		headers: {
			'User-Agent': NWS_USER_AGENT,
			Accept: 'application/geo+json,application/json',
		},
	});

	if (response.status === 404) {
		throw new HttpError(404, 'Location not found.');
	}
	if (!response.ok) {
		throw new HttpError(502, `Reverse geocoding failed: ${response.status} ${response.statusText}`);
	}

	const payload = await response.json() as any;
	const relative = payload?.properties?.relativeLocation?.properties ?? {};
	const city = String(relative?.city || '').trim() || undefined;
	const state = String(relative?.state || '').trim() || undefined;
	const label = city && state ? `${city}, ${state}` : `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`;
	const county = await lookupCountyByLatLon(lat, lon);
	// Extract forecast zone code from the NWS points response (e.g. KYZ040)
	const zoneUrl = String(payload?.properties?.forecastZone || '');
	const zoneMatch = zoneUrl.match(/\/([A-Z]{2}Z\d{3})$/i);
	const zoneCode = zoneMatch ? zoneMatch[1].toUpperCase() : undefined;

	return {
		lat,
		lon,
		city,
		state,
		county: county.county,
		countyCode: county.countyCode,
		zoneCode,
		label,
	};
}

export function parseCoordinate(raw: string, min: number, max: number, fieldLabel: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new HttpError(400, `${fieldLabel} is invalid.`);
	}
	return value;
}

export function parseLatLonForWeather(request: Request): { lat: number; lon: number } {
	const url = new URL(request.url);
	const latRaw = String(url.searchParams.get('lat') || '').trim();
	const lonRaw = String(url.searchParams.get('lon') || '').trim();

	if (!latRaw && !lonRaw) {
		return { lat: DEFAULT_WEATHER_LAT, lon: DEFAULT_WEATHER_LON };
	}
	if (!latRaw || !lonRaw) {
		throw new HttpError(400, 'Provide both ?lat= and ?lon=.');
	}

	return {
		lat: parseCoordinate(latRaw, -90, 90, 'Latitude'),
		lon: parseCoordinate(lonRaw, -180, 180, 'Longitude'),
	};
}

export async function geocodeZipToLocation(zip: string): Promise<SavedLocation> {
	return await geocodeZip(zip);
}

export async function handleApiGeocode(request: Request): Promise<Response> {
	const headers = apiCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const url = new URL(request.url);
	const zip = String(url.searchParams.get('zip') || '').trim();
	const query = String(url.searchParams.get('query') || url.searchParams.get('q') || '').trim();
	const latRaw = String(url.searchParams.get('lat') || '').trim();
	const lonRaw = String(url.searchParams.get('lon') || '').trim();

	try {
		if (zip) {
			if (!ZIP_RE.test(zip)) {
				throw new HttpError(400, 'Enter a valid 5-digit ZIP code.');
			}
			const location = await geocodeZip(zip);
			headers.set('Cache-Control', 'public, max-age=86400');
			return new Response(JSON.stringify(location), { status: 200, headers });
		}

		if (query) {
			const location = await geocodePlaceQuery(query);
			headers.set('Cache-Control', 'public, max-age=3600');
			return new Response(JSON.stringify(location), { status: 200, headers });
		}

		if (!latRaw || !lonRaw) {
			throw new HttpError(400, 'Provide ?zip=##### or ?query=city,state or both ?lat= and ?lon=.');
		}

		const lat = parseCoordinate(latRaw, -90, 90, 'Latitude');
		const lon = parseCoordinate(lonRaw, -180, 180, 'Longitude');
		const location = await reverseGeocodePoint(lat, lon);
		headers.set('Cache-Control', 'public, max-age=1800');
		return new Response(JSON.stringify(location), { status: 200, headers });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message =
			error instanceof Error
				? error.message
				: 'Unexpected geocoding error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}

export async function handleApiLocation(request: Request): Promise<Response> {
	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'public, max-age=3600',
	};

	try {
		const url = new URL(request.url);
		const zip = String(url.searchParams.get('zip') || '').trim();

		if (!ZIP_RE.test(zip)) {
			throw new HttpError(400, 'ZIP code is invalid.');
		}

		const location = await geocodeZipToLocation(zip);
		return new Response(JSON.stringify(location), {
			status: 200,
			headers,
		});
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Unexpected location lookup error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}
