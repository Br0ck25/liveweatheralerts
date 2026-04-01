import { type Env, type AdminConvectiveOutlookConfig, HttpError } from '../types';
import { ADMIN_FORECAST_LOCATIONS, ADMIN_DISCUSSION_LIMIT, ADMIN_CONVECTIVE_OUTLOOKS } from '../constants';
import { decodeHtmlEntities, formatDateTime } from '../utils';
import { isAuthenticated } from '../admin/auth';
import {
	fetchNwsProductList, fetchNwsProductById, fetchRemoteText,
	buildWeatherPayloadForPoint, fetchPointWeatherContext,
} from './api';
import { geocodeZipToLocation } from './geocoding';

function buildAdminForecastPeriods(daily: any[]): any[] {
	const periods: any[] = [];
	for (const day of (Array.isArray(daily) ? daily : []).slice(0, 3)) {
		periods.push({
			id: `${String(day?.name || 'day').toLowerCase().replace(/\s+/g, '-')}-day`,
			name: String(day?.name || ''),
			shortForecast: String(day?.shortForecast || ''),
			detailedForecast: String(day?.detailedForecast || ''),
			temperatureF: Number.isFinite(Number(day?.highF)) ? Number(day.highF) : Number(day?.temperatureF ?? NaN),
			temperatureLabel: Number.isFinite(Number(day?.highF)) ? 'High' : 'Temp',
			windSpeed: String(day?.windSpeed || ''),
			windDirection: String(day?.windDirection || ''),
			precipitationChance: Number.isFinite(Number(day?.precipitationChance)) ? Number(day.precipitationChance) : null,
			isDaytime: true,
		});

		if (day?.nightName) {
			periods.push({
				id: `${String(day.nightName).toLowerCase().replace(/\s+/g, '-')}-night`,
				name: String(day.nightName || ''),
				shortForecast: String(day?.nightShortForecast || ''),
				detailedForecast: String(day?.nightDetailedForecast || ''),
				temperatureF: Number.isFinite(Number(day?.lowF)) ? Number(day.lowF) : null,
				temperatureLabel: 'Low',
				windSpeed: String(day?.nightWindSpeed || ''),
				windDirection: String(day?.nightWindDirection || ''),
				precipitationChance: Number.isFinite(Number(day?.nightPrecipitationChance)) ? Number(day.nightPrecipitationChance) : null,
				isDaytime: false,
			});
		}
	}
	return periods;
}

function buildAdminForecastSummaryLine(period: any): string {
	const tempPart = Number.isFinite(Number(period?.temperatureF))
		? `${String(period?.temperatureLabel || 'Temp')}: ${Math.round(Number(period.temperatureF))}F`
		: null;
	const precipPart = Number.isFinite(Number(period?.precipitationChance))
		? `${Math.round(Number(period.precipitationChance))}% precip`
		: null;
	return [
		`${String(period?.name || 'Period')}: ${String(period?.shortForecast || '').trim()}`,
		tempPart,
		precipPart,
	].filter(Boolean).join(', ');
}

function buildNationalForecastSummaryText(cities: any[]): string {
	const lines = [
		'3-Day USA Forecast',
		'',
	];

	for (const city of cities) {
		lines.push(`${city.label} (${city.region})`);
		for (const period of city.periods) {
			lines.push(buildAdminForecastSummaryLine(period));
		}
		lines.push('');
	}

	const rainFocusedCities = cities
		.map((city) => ({
			label: city.label,
			rainPeriods: city.periods.filter((period: any) => Number(period?.precipitationChance || 0) >= 40).length,
		}))
		.filter((entry) => entry.rainPeriods > 0)
		.sort((a, b) => b.rainPeriods - a.rainPeriods)
		.slice(0, 2);
	if (rainFocusedCities.length > 0) {
		lines.push('National Weather Story');
		lines.push(`- Greatest rain chances: ${rainFocusedCities.map((entry) => entry.label).join(' and ')}`);
		lines.push('');
	}

	lines.push('#USWeather #NationalForecast #LiveWeatherAlerts');
	return lines.join('\n').trim();
}

function extractSpcDiscussionSummary(text: string): string {
	const lines = String(text || '').split(/\r?\n/);
	const summaryIndex = lines.findIndex((line) => line.trim().toUpperCase() === '...SUMMARY...');
	if (summaryIndex === -1) return '';
	const collected: string[] = [];
	for (let index = summaryIndex + 1; index < lines.length; index += 1) {
		const line = lines[index]?.trim() || '';
		if (!line) {
			if (collected.length > 0) break;
			continue;
		}
		if (/^\.\.\..+\.\.\.$/.test(line)) break;
		collected.push(line.replace(/\s+/g, ' '));
	}
	return collected.join(' ').trim();
}

function buildConvectiveOutlookFacebookText(day: any): string {
	const lines = [
		String(day?.title || day?.label || 'SPC Convective Outlook'),
		day?.updated ? `Updated ${String(day.updated)}` : '',
		day?.summary ? `Summary: ${String(day.summary)}` : '',
		'',
		String(day?.discussionText || '').trim(),
	];
	return lines.filter(Boolean).join('\n').trim();
}

function buildDiscussionFacebookText(city: any, discussion: any): string {
	const lines = [
		`NWS Discussion: ${String(city?.label || 'Discussion')}`,
		`Issued ${formatDateTime(String(discussion?.issuanceTime || ''))}`,
		'',
		String(discussion?.productText || '').trim(),
	];
	return lines.filter(Boolean).join('\n').trim();
}

function parseSpcConvectiveOutlookPage(html: string, config: AdminConvectiveOutlookConfig): any {
	const pageTitleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
	const pageTitle = decodeHtmlEntities(String(pageTitleMatch?.[1] || `${config.label} Convective Outlook`))
		.replace(/\s+/g, ' ')
		.trim();
	const updatedMatch = html.match(/Updated:(?:&nbsp;|\s)*([^<]+?)(?:&nbsp;|\s)*\(/i);
	const updated = decodeHtmlEntities(String(updatedMatch?.[1] || ''))
		.replace(/\s+/g, ' ')
		.trim();
	const defaultTabMatch = html.match(/onload="[^"]*show_tab\('([^']+)'\)/i) || html.match(/show_tab\('([^']+)'\)/i);
	const defaultTab = String(defaultTabMatch?.[1] || '').trim();
	const imageUrl = defaultTab
		? new URL(`${config.imagePrefix}${defaultTab}.png`, config.pageUrl).toString()
		: '';
	const markerIndex = html.toLowerCase().indexOf('forecast discussion');
	const preStart = markerIndex >= 0 ? html.indexOf('<pre>', markerIndex) : html.indexOf('<pre>');
	const preEnd = preStart >= 0 ? html.indexOf('</pre>', preStart) : -1;
	const discussionText = preStart >= 0 && preEnd > preStart
		? decodeHtmlEntities(html.slice(preStart + 5, preEnd)).replace(/\r/g, '').trim()
		: '';
	const productLines = discussionText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const productTitle = productLines.find((line) => /^Day\s+\d+\s+Convective Outlook/i.test(line)) || `${config.label} Convective Outlook`;
	const issuedLineMatch = discussionText.match(/NWS Storm Prediction Center Norman OK\s+([^\n]+)/i);
	const issuedLabel = String(issuedLineMatch?.[1] || '').trim();
	const summary = extractSpcDiscussionSummary(discussionText);
	return {
		id: config.id,
		label: config.label,
		title: productTitle,
		pageTitle,
		updated,
		issuedLabel,
		summary,
		imageUrl,
		pageUrl: config.pageUrl,
		discussionText,
		facebookText: buildConvectiveOutlookFacebookText({
			label: config.label,
			title: productTitle,
			updated,
			summary,
			discussionText,
		}),
	};
}

async function fetchAdminForecastCityData(config: typeof ADMIN_FORECAST_LOCATIONS[number]): Promise<any> {
	const savedLocation = await geocodeZipToLocation(config.zip);
	const point = await fetchPointWeatherContext(savedLocation.lat, savedLocation.lon);
	const weather = await buildWeatherPayloadForPoint(point);
	return {
		id: config.id,
		label: config.label,
		region: config.region,
		zip: config.zip,
		locationLabel: String(weather?.location?.label || `${config.label}, ${savedLocation.state || ''}`),
		updated: String(weather?.updated || weather?.generatedAt || new Date().toISOString()),
		periods: buildAdminForecastPeriods(weather?.daily || []),
	};
}

async function fetchAdminDiscussionCityData(config: typeof ADMIN_FORECAST_LOCATIONS[number]): Promise<any> {
	const list = await fetchNwsProductList('AFD', config.discussionOfficeCode);
	const latestItems = list.slice(0, ADMIN_DISCUSSION_LIMIT);
	const products = await Promise.all(
		latestItems.map(async (item: any) => {
			const productId = String(item?.id || '').trim();
			const product = await fetchNwsProductById(productId);
			return {
				id: String(product?.id || productId),
				title: String(product?.productName || item?.productName || 'Area Forecast Discussion'),
				issuanceTime: String(product?.issuanceTime || item?.issuanceTime || ''),
				productText: String(product?.productText || '').trim(),
				productUrl: String(product?.['@id'] || item?.['@id'] || ''),
			};
		}),
	);

	return {
		id: config.id,
		label: config.label,
		region: config.region,
		zip: config.zip,
		officeCode: config.discussionOfficeCode,
		officeLabel: config.discussionOfficeLabel,
		discussionCount: list.length,
		discussions: products.map((discussion) => ({
			...discussion,
			facebookText: buildDiscussionFacebookText(config, discussion),
		})),
	};
}

async function fetchAdminConvectiveOutlookDayData(config: AdminConvectiveOutlookConfig): Promise<any> {
	const html = await fetchRemoteText(config.pageUrl, `${config.label} convective outlook`);
	return parseSpcConvectiveOutlookPage(html, config);
}

export async function handleAdminForecastData(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const headers = new Headers({
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});

	const results = await Promise.allSettled(
		ADMIN_FORECAST_LOCATIONS.map((config) => fetchAdminForecastCityData(config)),
	);

	const cities = results
		.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
		.map((result) => result.value);
	const errors = results
		.map((result, index) =>
			result.status === 'rejected'
				? {
					id: ADMIN_FORECAST_LOCATIONS[index]?.id || `city-${index + 1}`,
					label: ADMIN_FORECAST_LOCATIONS[index]?.label || `City ${index + 1}`,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				}
				: null,
		)
		.filter(Boolean);

	if (cities.length === 0) {
		return new Response(JSON.stringify({
			error: 'Unable to load admin forecast data right now.',
			errors,
		}), { status: 502, headers });
	}

	const generatedAt = new Date().toISOString();
	return new Response(JSON.stringify({
		generatedAt,
		cities,
		summaryTitle: '3-Day USA Forecast',
		summaryText: buildNationalForecastSummaryText(cities),
		errors,
	}), { status: 200, headers });
}

export async function handleAdminDiscussionData(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const headers = new Headers({
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});

	const results = await Promise.allSettled(
		ADMIN_FORECAST_LOCATIONS.map((config) => fetchAdminDiscussionCityData(config)),
	);

	const cities = results
		.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
		.map((result) => result.value);
	const errors = results
		.map((result, index) =>
			result.status === 'rejected'
				? {
					id: ADMIN_FORECAST_LOCATIONS[index]?.id || `city-${index + 1}`,
					label: ADMIN_FORECAST_LOCATIONS[index]?.label || `City ${index + 1}`,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				}
				: null,
		)
		.filter(Boolean);

	if (cities.length === 0) {
		return new Response(JSON.stringify({
			error: 'Unable to load NWS discussions right now.',
			errors,
		}), { status: 502, headers });
	}

	return new Response(JSON.stringify({
		generatedAt: new Date().toISOString(),
		cities,
		errors,
	}), { status: 200, headers });
}

export async function handleAdminConvectiveOutlookData(request: Request, env: Env): Promise<Response> {
	if (!await isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const headers = new Headers({
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	});

	const results = await Promise.allSettled(
		ADMIN_CONVECTIVE_OUTLOOKS.map((config) => fetchAdminConvectiveOutlookDayData(config)),
	);

	const days = results
		.filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
		.map((result) => result.value);
	const errors = results
		.map((result, index) =>
			result.status === 'rejected'
				? {
					id: ADMIN_CONVECTIVE_OUTLOOKS[index]?.id || `day-${index + 1}`,
					label: ADMIN_CONVECTIVE_OUTLOOKS[index]?.label || `Day ${index + 1}`,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				}
				: null,
		)
		.filter(Boolean);

	if (days.length === 0) {
		return new Response(JSON.stringify({
			error: 'Unable to load SPC convective outlook data right now.',
			errors,
		}), { status: 502, headers });
	}

	return new Response(JSON.stringify({
		generatedAt: new Date().toISOString(),
		days,
		errors,
	}), { status: 200, headers });
}
