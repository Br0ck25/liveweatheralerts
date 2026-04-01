import { type MapClickPeriodOverride, type RadarFrame, type RadarPayload, HttpError } from '../types';
import { NWS_USER_AGENT, NWS_ACCEPT } from '../constants';
import { dedupeStrings } from '../utils';
import {
	roundTo, firstFinite, toTemperatureF, toSpeedMph, toPressureInHg, toMiles, toPercent,
	toCompassDirection, parseWindSpeedTextMph, forecastTemperatureToF, severityFromForecastText,
	measurementValue,
} from './units';
import { apiCorsHeaders } from '../public-api';
import { parseLatLonForWeather } from './geocoding';

function normalizeIsoOrNull(value: unknown): string | null {
	const text = String(value || '').trim();
	if (!text) return null;
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toISOString();
}

export async function fetchNwsJson(url: string, label: string): Promise<any> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': NWS_USER_AGENT,
			Accept: NWS_ACCEPT,
		},
	});

	if (response.status === 404) {
		throw new HttpError(404, `${label} not found.`);
	}
	if (!response.ok) {
		throw new HttpError(502, `${label} request failed: ${response.status} ${response.statusText}`);
	}
	return await response.json();
}

export async function fetchRemoteText(url: string, label: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			'User-Agent': NWS_USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		},
	});
	if (response.status === 404) {
		throw new HttpError(404, `${label} not found.`);
	}
	if (!response.ok) {
		throw new HttpError(502, `${label} request failed: ${response.status} ${response.statusText}`);
	}
	return await response.text();
}

export async function fetchNwsProductList(productCode: string, locationCode: string): Promise<any[]> {
	const payload = await fetchNwsJson(
		`https://api.weather.gov/products/types/${encodeURIComponent(productCode)}/locations/${encodeURIComponent(locationCode)}`,
		`${productCode} product list`,
	);
	const graph = Array.isArray(payload?.['@graph']) ? payload['@graph'] : [];
	return graph
		.filter((entry: any) => entry && typeof entry === 'object' && entry.id)
		.sort((a: any, b: any) => Date.parse(String(b?.issuanceTime || '')) - Date.parse(String(a?.issuanceTime || '')));
}

export async function fetchNwsProductById(productId: string): Promise<any> {
	return await fetchNwsJson(
		`https://api.weather.gov/products/${encodeURIComponent(productId)}`,
		'NWS product',
	);
}

async function fetchMapClickForecastJson(lat: number, lon: number): Promise<any | null> {
	const url = new URL('https://forecast.weather.gov/MapClick.php');
	url.searchParams.set('lat', lat.toFixed(2));
	url.searchParams.set('lon', lon.toFixed(2));
	url.searchParams.set('unit', '0');
	url.searchParams.set('lg', 'english');
	url.searchParams.set('FcstType', 'json');

	try {
		const response = await fetch(url.toString(), {
			headers: {
				'User-Agent': NWS_USER_AGENT,
				Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
			},
		});
		if (!response.ok) return null;
		const payload = await response.json();
		return payload && typeof payload === 'object' ? payload : null;
	} catch {
		return null;
	}
}

function normalizeMapClickText(value: unknown): string {
	return String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeMapClickPop(value: unknown): number | null {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

function buildMapClickPeriodOverrides(payload: any): MapClickPeriodOverride[] {
	const periodNames = Array.isArray(payload?.time?.startPeriodName)
		? payload.time.startPeriodName
		: [];
	const startTimes = Array.isArray(payload?.time?.startValidTime)
		? payload.time.startValidTime
		: [];
	const texts = Array.isArray(payload?.data?.text) ? payload.data.text : [];
	const weather = Array.isArray(payload?.data?.weather) ? payload.data.weather : [];
	const pops = Array.isArray(payload?.data?.pop) ? payload.data.pop : [];
	const icons = Array.isArray(payload?.data?.iconLink) ? payload.data.iconLink : [];

	const total = Math.min(periodNames.length, startTimes.length);
	const overrides: MapClickPeriodOverride[] = [];

	for (let i = 0; i < total; i++) {
		const startMs = Date.parse(String(startTimes[i] ?? ''));
		if (!Number.isFinite(startMs)) continue;

		const name = normalizeMapClickText(periodNames[i]);
		const shortForecast = normalizeMapClickText(weather[i]);
		const detailedForecast = normalizeMapClickText(texts[i]);
		const precipitationChance = normalizeMapClickPop(pops[i]);
		const icon = normalizeMapClickText(icons[i]);

		overrides.push({
			name,
			startMs,
			shortForecast,
			detailedForecast,
			precipitationChance,
			icon,
		});
	}

	return overrides;
}

function findMapClickPeriodOverride(
	overrides: MapClickPeriodOverride[],
	period: any,
): MapClickPeriodOverride | null {
	if (!overrides.length) return null;

	const periodStartMs = Date.parse(String(period?.startTime || ''));
	const periodName = String(period?.name || '').trim().toLowerCase();

	if (Number.isFinite(periodStartMs)) {
		const byStart = overrides.find((item) => item.startMs === periodStartMs);
		if (byStart) return byStart;
	}

	if (periodName) {
		const byName = overrides.find((item) => item.name.toLowerCase() === periodName);
		if (byName) return byName;
	}

	return null;
}

export async function fetchPointWeatherContext(lat: number, lon: number): Promise<any> {
	const payload = await fetchNwsJson(
		`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
		'Point lookup',
	);
	const p = payload?.properties ?? {};
	const relative = p?.relativeLocation?.properties ?? {};
	const city = String(relative?.city || '').trim() || undefined;
	const state = String(relative?.state || '').trim() || undefined;
	const label = city && state ? `${city}, ${state}` : `Lat ${lat.toFixed(2)}, Lon ${lon.toFixed(2)}`;

	return {
		lat,
		lon,
		city,
		state,
		label,
		timeZone: String(p?.timeZone || ''),
		gridId: String(p?.gridId || ''),
		gridX: Number(p?.gridX),
		gridY: Number(p?.gridY),
		forecast: String(p?.forecast || ''),
		forecastHourly: String(p?.forecastHourly || ''),
		observationStations: String(p?.observationStations || ''),
		radarStation: String(p?.radarStation || ''),
	};
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const R = 3958.7613;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
		Math.sin(dLon / 2) * Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	return R * c;
}

function observationAgeMs(timestamp?: string | null): number {
	if (!timestamp) return Number.POSITIVE_INFINITY;
	const ms = Date.parse(String(timestamp));
	if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
	return Math.max(0, Date.now() - ms);
}

function isRecentObservation(timestamp?: string | null): boolean {
	if (!timestamp) return false;
	const ms = Date.parse(String(timestamp));
	if (!Number.isFinite(ms)) return false;
	return Date.now() - ms <= 90 * 60 * 1000;
}

async function fetchStationLatestObservation(stationId: string): Promise<any | null> {
	try {
		const obsPayload = await fetchNwsJson(
			`https://api.weather.gov/stations/${encodeURIComponent(stationId)}/observations/latest`,
			'Latest observation',
		);
		return obsPayload?.properties ?? null;
	} catch {
		return null;
	}
}

export async function fetchLatestObservation(
	observationStationsUrl: string,
	lat: number,
	lon: number,
): Promise<{ stationId: string; properties: any; distanceMiles: number | null } | null> {
	if (!observationStationsUrl) return null;
	try {
		const stationsPayload = await fetchNwsJson(observationStationsUrl, 'Observation stations');
		const features = Array.isArray(stationsPayload?.features) ? stationsPayload.features : [];
		const candidates = features
			.slice(0, 8)
			.map((feature: any) => {
				const stationId = String(
					feature?.properties?.stationIdentifier
					|| feature?.properties?.station
					|| ''
				).trim();
				const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
				const stationLon = Number(coords?.[0]);
				const stationLat = Number(coords?.[1]);
				const distanceMiles = Number.isFinite(stationLat) && Number.isFinite(stationLon)
					? haversineMiles(lat, lon, stationLat, stationLon)
					: Number.POSITIVE_INFINITY;
				return { stationId, distanceMiles };
			})
			.filter((x: any) => Boolean(x.stationId));

		if (candidates.length === 0) return null;

		const observed = await Promise.all(
			candidates.map(async (candidate: any) => ({
				stationId: candidate.stationId,
				distanceMiles: Number.isFinite(candidate.distanceMiles) ? candidate.distanceMiles : null,
				properties: await fetchStationLatestObservation(candidate.stationId),
			})),
		);

		const usable = observed.filter((item: any) => item.properties);
		if (usable.length === 0) return null;

		usable.sort((a: any, b: any) => {
			const aHasTemp = Number.isFinite(toTemperatureF(a.properties?.temperature) as number) ? 1 : 0;
			const bHasTemp = Number.isFinite(toTemperatureF(b.properties?.temperature) as number) ? 1 : 0;
			if (aHasTemp !== bHasTemp) return bHasTemp - aHasTemp;

			const aRecent = isRecentObservation(a.properties?.timestamp) ? 1 : 0;
			const bRecent = isRecentObservation(b.properties?.timestamp) ? 1 : 0;
			if (aRecent !== bRecent) return bRecent - aRecent;

			const aDist = Number.isFinite(a.distanceMiles as number) ? Number(a.distanceMiles) : Number.POSITIVE_INFINITY;
			const bDist = Number.isFinite(b.distanceMiles as number) ? Number(b.distanceMiles) : Number.POSITIVE_INFINITY;
			if (aDist !== bDist) return aDist - bDist;

			const aAge = observationAgeMs(a.properties?.timestamp);
			const bAge = observationAgeMs(b.properties?.timestamp);
			return aAge - bAge;
		});

		return usable[0] ?? null;
	} catch {
		return null;
	}
}

function normalizeHourlyPeriods(hourlyPeriods: any[]): any[] {
	const now = Date.now();

	return hourlyPeriods
		.filter((period: any) => {
			const startMs = Date.parse(String(period?.startTime || ''));
			return Number.isFinite(startMs) && startMs > now;
		})
		.slice(0, 18)
		.map((period: any) => {
			const temperatureF = forecastTemperatureToF(period);
			return {
				startTime: String(period?.startTime || ''),
				isNow: false,
				temperatureF: roundTo(temperatureF, 0),
				shortForecast: String(period?.shortForecast || ''),
				icon: String(period?.icon || ''),
				windSpeedMph: roundTo(parseWindSpeedTextMph(String(period?.windSpeed || '')), 0),
				windDirection: String(period?.windDirection || ''),
				precipitationChance: roundTo(
					Number.isFinite(Number(period?.probabilityOfPrecipitation?.value))
						? Number(period?.probabilityOfPrecipitation?.value)
						: null,
					0,
				),
			};
		});
}

function normalizeDailyPeriods(periods: any[], mapClickOverrides: MapClickPeriodOverride[] = []): any[] {
	const normalized: any[] = [];

	for (let i = 0; i < periods.length; i++) {
		const period = periods[i];
		if (!period) continue;

		if (period.isDaytime === true) {
			const override = findMapClickPeriodOverride(mapClickOverrides, period);
			const next = periods[i + 1];
			const nightPeriod = next && next.isDaytime === false ? next : null;
			const nightOverride = nightPeriod
				? findMapClickPeriodOverride(mapClickOverrides, nightPeriod)
				: null;
			const highF = forecastTemperatureToF(period);
			const lowF = nightPeriod ? forecastTemperatureToF(nightPeriod) : null;

			const forecastText = String(
				override?.shortForecast || period?.shortForecast || '',
			);
			const detailedForecastText = String(
				override?.detailedForecast || period?.detailedForecast || '',
			);
			const precipitationChance = firstFinite(
				override?.precipitationChance ?? null,
				Number.isFinite(Number(period?.probabilityOfPrecipitation?.value))
					? Number(period?.probabilityOfPrecipitation?.value)
					: null,
			);
			const nightPrecipitationChance = firstFinite(
				nightOverride?.precipitationChance ?? null,
				Number.isFinite(Number(nightPeriod?.probabilityOfPrecipitation?.value))
					? Number(nightPeriod?.probabilityOfPrecipitation?.value)
					: null,
			);
			normalized.push({
				name: String(period?.name || ""),
				startTime: String(period?.startTime || ""),
				endTime: String(period?.endTime || ""),
				isDaytime: true,
				highF: roundTo(highF, 0),
				lowF: lowF !== null ? roundTo(lowF, 0) : null,
				temperatureF: roundTo(highF, 0),
				shortForecast: forecastText,
				detailedForecast: detailedForecastText,
				windSpeed: String(period?.windSpeed || ""),
				windDirection: String(period?.windDirection || ""),
				precipitationChance: roundTo(precipitationChance, 0),
				icon: String(override?.icon || period?.icon || ''),
				nightName: String(nightPeriod?.name || ""),
				nightShortForecast: String(
					nightOverride?.shortForecast || nightPeriod?.shortForecast || '',
				),
				nightDetailedForecast: String(
					nightOverride?.detailedForecast || nightPeriod?.detailedForecast || '',
				),
				nightPrecipitationChance: roundTo(nightPrecipitationChance, 0),
				nightWindSpeed: String(nightPeriod?.windSpeed || ''),
				nightWindDirection: String(nightPeriod?.windDirection || ''),
				nightIcon: String(nightOverride?.icon || nightPeriod?.icon || ''),
				sunrise: null,
				sunset: null,
				severity: severityFromForecastText(forecastText),
			});
		}
	}

	return normalized.slice(0, 10);
}

function parseIsoMs(value?: string | null): number | null {
	if (!value) return null;
	const ms = Date.parse(String(value));
	return Number.isFinite(ms) ? ms : null;
}

function buildSunTimesFromDailyPeriods(dailyPeriods: any[], nowMs = Date.now()) {
	const dayPeriods = (Array.isArray(dailyPeriods) ? dailyPeriods : [])
		.filter((p: any) => p?.isDaytime && p?.startTime && p?.endTime)
		.map((p: any) => ({
			startTime: String(p.startTime),
			endTime: String(p.endTime),
			startMs: parseIsoMs(p.startTime),
			endMs: parseIsoMs(p.endTime),
		}))
		.filter((p: any) => p.startMs !== null && p.endMs !== null)
		.sort((a: any, b: any) => a.startMs - b.startMs);

	let sunrise: string | null = null;
	let sunset: string | null = null;
	let isNight = false;

	const activeDay = dayPeriods.find((p: any) => nowMs >= p.startMs && nowMs < p.endMs);
	if (activeDay) {
		sunrise = activeDay.startTime;
		sunset = activeDay.endTime;
		isNight = false;
	} else {
		const previousDay = [...dayPeriods].reverse().find((p: any) => p.endMs <= nowMs);
		const nextDay = dayPeriods.find((p: any) => p.startMs > nowMs);

		sunset = previousDay?.endTime ?? null;
		sunrise = nextDay?.startTime ?? null;
		isNight = true;
	}

	if (!sunrise && dayPeriods.length) {
		sunrise = dayPeriods[0].startTime;
	}
	if (!sunset && dayPeriods.length) {
		sunset = dayPeriods[dayPeriods.length - 1].endTime;
	}

	return { sunrise, sunset, isNight };
}

async function fetchSunriseSunsetTimes(
	lat: number,
	lon: number,
	timeZone?: string | null,
	date?: string | null,
): Promise<{
	sunrise: string | null;
	sunset: string | null;
	tzid: string | null;
} | null> {
	try {
		const endpoint = new URL('https://api.sunrise-sunset.org/json');
		endpoint.searchParams.set('lat', lat.toFixed(4));
		endpoint.searchParams.set('lng', lon.toFixed(4));
		endpoint.searchParams.set('formatted', '0');
		if (timeZone) {
			endpoint.searchParams.set('tzid', String(timeZone));
		}
		if (date) {
			endpoint.searchParams.set('date', String(date));
		}

		const response = await fetch(endpoint.toString(), {
			headers: {
				Accept: 'application/json',
			},
		});
		if (!response.ok) return null;

		const payload = await response.json() as any;
		const status = String(payload?.status || '').trim().toUpperCase();
		if (status !== 'OK' && status !== 'INVALID_TZID') return null;

		return {
			sunrise: normalizeIsoOrNull(payload?.results?.sunrise),
			sunset: normalizeIsoOrNull(payload?.results?.sunset),
			tzid: String(payload?.tzid || '').trim() || null,
		};
	} catch {
		return null;
	}
}

export function calendarDateKey(
	value: string | number | Date,
	timeZone?: string | null,
): string | null {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;

	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: timeZone || 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(date);
		const year = parts.find((part) => part.type === 'year')?.value;
		const month = parts.find((part) => part.type === 'month')?.value;
		const day = parts.find((part) => part.type === 'day')?.value;
		if (year && month && day) {
			return `${year}-${month}-${day}`;
		}
	} catch {
		// Fall back to the UTC calendar date below.
	}

	return date.toISOString().slice(0, 10);
}

async function fetchSunriseSunsetSchedule(
	lat: number,
	lon: number,
	timeZone: string | null,
	dates: string[],
): Promise<Record<string, { sunrise: string | null; sunset: string | null }>> {
	const uniqueDates = dedupeStrings(
		dates
			.map((value) => String(value || '').trim())
			.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
	).slice(0, 8);
	if (uniqueDates.length === 0) return {};

	const results = await Promise.all(
		uniqueDates.map(async (date) => ({
			date,
			data: await fetchSunriseSunsetTimes(lat, lon, timeZone, date),
		})),
	);

	return results.reduce<Record<string, { sunrise: string | null; sunset: string | null }>>(
		(acc, entry) => {
			if (!entry.data) return acc;
			acc[entry.date] = {
				sunrise: entry.data.sunrise,
				sunset: entry.data.sunset,
			};
			return acc;
		},
		{},
	);
}

function calculateFeelsLike(tempF: number, humidity: number, windMph: number): number {
	// Wind Chill (ONLY when cold)
	if (tempF <= 50 && windMph > 3) {
		return Math.round(
			35.74 +
			0.6215 * tempF -
			35.75 * Math.pow(windMph, 0.16) +
			0.4275 * tempF * Math.pow(windMph, 0.16),
		);
	}

	// Heat Index (ONLY when hot)
	if (tempF >= 80 && humidity >= 40) {
		return Math.round(
			-42.379 +
			2.04901523 * tempF +
			10.14333127 * humidity -
			0.22475541 * tempF * humidity -
			0.00683783 * tempF * tempF -
			0.05481717 * humidity * humidity +
			0.00122874 * tempF * tempF * humidity +
			0.00085282 * tempF * humidity * humidity -
			0.00000199 * tempF * tempF * humidity * humidity,
		);
	}

	return Math.round(tempF);
}

function buildCurrentConditions(
	observationProps: any,
	firstHourly: any,
	sun?: { sunrise: string | null; sunset: string | null; isNight: boolean },
): any {
	const observationIsFresh = isRecentObservation(observationProps?.timestamp);
	const observedTempF = toTemperatureF(observationProps?.temperature);
	const hourlyTempF = forecastTemperatureToF(firstHourly);
	const temperatureF = firstFinite(
		observationIsFresh ? observedTempF : null,
		hourlyTempF,
		observedTempF,
	);

	const humidity = observationIsFresh ? toPercent(observationProps?.relativeHumidity) : null;
	const pressureInHg = observationIsFresh ? toPressureInHg(observationProps?.barometricPressure) : null;
	const visibilityMi = observationIsFresh ? toMiles(observationProps?.visibility) : null;
	const dewpointF = observationIsFresh ? toTemperatureF(observationProps?.dewpoint) : null;
	const windMph = firstFinite(
		observationIsFresh ? toSpeedMph(observationProps?.windSpeed) : null,
		parseWindSpeedTextMph(String(firstHourly?.windSpeed || '')),
	);
	const windDirection = observationIsFresh
		? firstFinite(measurementValue(observationProps?.windDirection), null)
		: null;
	const feelsLikeF = Number.isFinite(Number(temperatureF))
		? calculateFeelsLike(
			Number(temperatureF),
			Number(humidity ?? 0),
			Number(windMph ?? 0),
		)
		: null;

	const condition = String(
		(observationIsFresh ? observationProps?.textDescription : null)
		|| firstHourly?.shortForecast
		|| observationProps?.textDescription
		|| 'Conditions unavailable',
	);

	return {
		temperatureF: roundTo(temperatureF, 0),
		feelsLikeF: roundTo(feelsLikeF, 0),
		condition,
		windMph: roundTo(windMph, 0),
		windDirection: toCompassDirection(windDirection) || String(firstHourly?.windDirection || ''),
		humidity: roundTo(humidity, 0),
		dewpointF: roundTo(dewpointF, 0),
		pressureInHg: roundTo(pressureInHg, 2),
		visibilityMi: roundTo(visibilityMi, 1),
		icon: String((observationIsFresh ? observationProps?.icon : null) || firstHourly?.icon || observationProps?.icon || ''),
		timestamp: String((observationIsFresh ? observationProps?.timestamp : null) || firstHourly?.startTime || observationProps?.timestamp || ''),
		isObservationFresh: observationIsFresh,
		sunrise: sun?.sunrise ?? null,
		sunset: sun?.sunset ?? null,
		isNight: !!sun?.isNight,
	};
}

function buildRecentRadarFrames(count = 8, stepMinutes = 2): RadarFrame[] {
	const now = new Date();
	const rounded = new Date(now);
	rounded.setUTCSeconds(0, 0);
	rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / stepMinutes) * stepMinutes);

	const frames: RadarFrame[] = [];

	for (let i = count - 1; i >= 0; i--) {
		const d = new Date(rounded);
		d.setUTCMinutes(d.getUTCMinutes() - i * stepMinutes);

		frames.push({
			time: d.toISOString(),
			label: d.toLocaleTimeString('en-US', {
				hour: 'numeric',
				minute: '2-digit',
				timeZone: 'UTC',
			}),
		});
	}

	return frames;
}

function buildRadarTileTemplate(): string {
	return [
		'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows',
		'?SERVICE=WMS',
		'&VERSION=1.1.1',
		'&REQUEST=GetMap',
		'&FORMAT=image/png',
		'&TRANSPARENT=true',
		'&LAYERS=conus_bref_qcd',
		'&SRS=EPSG:3857',
		'&WIDTH=256',
		'&HEIGHT=256',
		'&BBOX={bbox-epsg-3857}',
		'&TIME={time}',
	].join('');
}

function buildRadarStillImageUrl(time?: string): string | null {
	if (!time) return null;

	const params = [
		'SERVICE=WMS',
		'VERSION=1.1.1',
		'REQUEST=GetMap',
		'FORMAT=image/png',
		'TRANSPARENT=true',
		'LAYERS=conus_bref_qcd',
		'SRS=EPSG:4326',
		'WIDTH=1200',
		'HEIGHT=700',
		'BBOX=24,-126,50,-66',
		`TIME=${encodeURIComponent(time)}`,
	];

	return `https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?${params.join('&')}`;
}

export function radarImagesForStation(_station: string): { loopImageUrl: string | null; stillImageUrl: string | null } {
	const frames = buildRecentRadarFrames(8, 2);
	const latest = frames[frames.length - 1]?.time ?? null;

	return {
		loopImageUrl: null,
		stillImageUrl: buildRadarStillImageUrl(latest),
	};
}

function buildRadarPayload(input: {
	lat: number;
	lon: number;
	station?: string | null;
	updated?: string | null;
	summary?: string | null;
}): RadarPayload {
	const frames = buildRecentRadarFrames(8, 2);
	const latestFrame = frames[frames.length - 1]?.time ?? null;
	const tileTemplate = buildRadarTileTemplate();
	const images = radarImagesForStation(input.station || '');

	return {
		station: input.station || null,
		loopImageUrl: images.loopImageUrl,
		stillImageUrl: images.stillImageUrl || buildRadarStillImageUrl(latestFrame),
		updated: String(input.updated || latestFrame || new Date().toISOString()),
		summary: String(input.summary || ''),
		frames,
		tileTemplate,
		hasLiveTiles: true,
		defaultCenter: {
			lat: input.lat,
			lon: input.lon,
		},
		defaultZoom: 7,
	};
}

export async function buildWeatherPayloadForPoint(point: any): Promise<any> {
	if (!point.forecast || !point.forecastHourly) {
		throw new HttpError(502, 'Forecast endpoints are unavailable for this location.');
	}

	const [forecastPayload, hourlyPayload, observation, mapClickPayload] = await Promise.all([
		fetchNwsJson(point.forecast, 'Daily forecast'),
		fetchNwsJson(point.forecastHourly, 'Hourly forecast'),
		fetchLatestObservation(point.observationStations, point.lat, point.lon),
		fetchMapClickForecastJson(point.lat, point.lon),
	]);

	const hourlyPeriodsRaw = Array.isArray(hourlyPayload?.properties?.periods)
		? hourlyPayload.properties.periods
		: [];
	const dailyPeriodsRaw = Array.isArray(forecastPayload?.properties?.periods)
		? forecastPayload.properties.periods
		: [];

	const hourly = normalizeHourlyPeriods(hourlyPeriodsRaw);
	const mapClickOverrides = buildMapClickPeriodOverrides(mapClickPayload);
	let daily = normalizeDailyPeriods(dailyPeriodsRaw, mapClickOverrides);
	const currentLocalDateKey = calendarDateKey(Date.now(), point.timeZone || null);
	const sunriseSunsetSchedule = await fetchSunriseSunsetSchedule(
		point.lat,
		point.lon,
		point.timeZone || null,
		[
			...(currentLocalDateKey ? [currentLocalDateKey] : []),
			...daily
				.slice(0, 7)
				.map((day: any) => calendarDateKey(String(day?.startTime || ''), point.timeZone || null))
				.filter(Boolean) as string[],
		],
	);
	const sun = buildSunTimesFromDailyPeriods(dailyPeriodsRaw);
	const currentDaySun = currentLocalDateKey ? sunriseSunsetSchedule[currentLocalDateKey] : null;
	if (currentDaySun?.sunrise) {
		sun.sunrise = currentDaySun.sunrise;
	}
	if (currentDaySun?.sunset) {
		sun.sunset = currentDaySun.sunset;
	}
	if (!sun.sunrise && observation?.properties?.sunrise) {
		sun.sunrise = String(observation.properties.sunrise);
	}
	if (!sun.sunset && observation?.properties?.sunset) {
		sun.sunset = String(observation.properties.sunset);
	}
	daily = daily.map((day: any) => {
		const dateKey = calendarDateKey(String(day?.startTime || ''), point.timeZone || null);
		const daySun = dateKey ? sunriseSunsetSchedule[dateKey] : null;
		return {
			...day,
			sunrise: daySun?.sunrise || normalizeIsoOrNull(day?.startTime) || null,
			sunset: daySun?.sunset || normalizeIsoOrNull(day?.endTime) || null,
		};
	});
	let current = buildCurrentConditions(
		observation?.properties ?? {},
		hourlyPeriodsRaw[0] ?? {},
		sun,
	);

	const now = Date.now();
	let isNight = true;
	if (sun?.sunrise && sun?.sunset) {
		const sunrise = Date.parse(String(sun.sunrise));
		const sunset = Date.parse(String(sun.sunset));
		if (Number.isFinite(sunrise) && Number.isFinite(sunset) && now >= sunrise && now < sunset) {
			isNight = false;
		}
	}

	current = { ...current, isNight };

	const radarStation = point.radarStation || observation?.stationId || '';
	const radar = buildRadarPayload({
		lat: point.lat,
		lon: point.lon,
		station: radarStation || null,
		updated: String(observation?.properties?.timestamp || hourly[0]?.startTime || new Date().toISOString()),
		summary: String(observation?.properties?.textDescription || current.condition || ''),
	});

	const generatedAt = new Date().toISOString();

	return {
		location: {
			lat: point.lat,
			lon: point.lon,
			city: point.city,
			state: point.state,
			label: point.label,
			timeZone: point.timeZone || null,
			gridId: point.gridId || null,
			gridX: Number.isFinite(point.gridX) ? point.gridX : null,
			gridY: Number.isFinite(point.gridY) ? point.gridY : null,
			radarStation: radarStation || null,
		},
		current,
		hourly,
		daily,
		radar,
		updated: generatedAt,
		generatedAt,
		meta: {
			generatedAt,
		},
	};
}

export async function handleApiWeather(request: Request): Promise<Response> {
	const headers = apiCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	try {
		const { lat, lon } = parseLatLonForWeather(request);
		const point = await fetchPointWeatherContext(lat, lon);
		const payload = await buildWeatherPayloadForPoint(point);
		headers.set('Cache-Control', 'public, max-age=30, must-revalidate');
		return new Response(JSON.stringify(payload), { status: 200, headers });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Unexpected weather lookup error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}

export async function handleApiRadar(request: Request): Promise<Response> {
	const headers = apiCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	try {
		const { lat, lon } = parseLatLonForWeather(request);
		const point = await fetchPointWeatherContext(lat, lon);
		const observation = await fetchLatestObservation(point.observationStations, point.lat, point.lon);
		const radarStation = point.radarStation || observation?.stationId || '';
		const images = radarImagesForStation(radarStation);
		const direction = toCompassDirection(measurementValue(observation?.properties?.windDirection));

		const generatedAt = new Date().toISOString();
		headers.set('Cache-Control', 'public, max-age=30, must-revalidate');
		return new Response(JSON.stringify({
			location: {
				lat: point.lat,
				lon: point.lon,
				city: point.city,
				state: point.state,
				label: point.label,
			},
			station: radarStation || null,
			loopImageUrl: images.loopImageUrl,
			stillImageUrl: images.stillImageUrl,
			updated: String(observation?.properties?.timestamp || new Date().toISOString()),
			summary: String(observation?.properties?.textDescription || ''),
			stormDirection: direction,
			generatedAt,
			meta: {
				generatedAt,
			},
		}), { status: 200, headers });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Unexpected radar lookup error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}
