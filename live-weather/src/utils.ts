import type { Env, PushAlertTypes, PushQuietHours } from './types';
import { PUBLIC_ALERTS_PAGE_URL } from './constants';

export function safeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, '\'')
		.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

export function nl2br(text: string): string {
	return safeHtml(text).replace(/\r?\n/g, '<br>');
}

export function descriptionToHtml(text: string): string {
	const escaped = safeHtml(text)
		.replace(/HAZARD:/g, '<strong>HAZARD:</strong>')
		.replace(/SOURCE:/g, '<strong>SOURCE:</strong>')
		.replace(/IMPACT:/g, '<strong>IMPACT:</strong>');
	return escaped.replace(/\r?\n/g, '<br>');
}

export function mapSomeValue(value: unknown): string {
	if (value == null) return '';
	if (Array.isArray(value)) return value.filter((v) => v != null).join(', ');
	return String(value);
}

export function findProperty(p: any, key: string): unknown {
	if (!p || typeof p !== 'object') return undefined;
	if (p[key] != null) return p[key];
	if (p.parameters && p.parameters[key] != null) return p.parameters[key];
	if (p.parameters && p.parameters[`${key}s`] != null) return p.parameters[`${key}s`];
	return undefined;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

export function dedupeStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

export function generateOpaqueToken(byteLength = 32): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Format an ISO 8601 datetime string for display, preserving the local time
 * and timezone offset that NWS encoded in the string.
 */
export function formatDateTime(value: string): string {
	try {
		const m = value.match(
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:\d{2})$/
		);
		if (m) {
			const [, year, month, day, hour24, min, offset] = m;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;

			const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
			const offsetSign = offset[0] === '+' ? 1 : -1;
			const [offH, offM] = offset.slice(1).split(':').map(Number);
			const offsetMs = offsetSign * (offH * 60 + offM) * 60000;
			const localDate = new Date(date.getTime() + offsetMs + date.getTimezoneOffset() * 60000);
			const dow = dows[localDate.getUTCDay()];

			const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
			const monthName = months[parseInt(month, 10) - 1];

			const h24 = parseInt(hour24, 10);
			const ampm = h24 >= 12 ? 'PM' : 'AM';
			const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

			const offLabel = `UTC${offset.replace(':00', '').replace(':30', '.5')}`;

			return `${dow}, ${monthName} ${parseInt(day, 10)}, ${year}, ${h12}:${min} ${ampm} (${offLabel})`;
		}

		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return date.toLocaleString('en-US', {
			weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC', timeZoneName: 'short',
		});
	} catch {
		return value;
	}
}

export function hailDesc(inches: string): string {
	const n = parseFloat(inches);
	if (Number.isNaN(n)) return `${inches}"`;
	if (n >= 4.0)  return `${inches}" (grapefruit size)`;
	if (n >= 2.75) return `${inches}" (baseball size)`;
	if (n >= 1.75) return `${inches}" (golf ball size)`;
	if (n >= 1.5)  return `${inches}" (ping pong ball size)`;
	if (n >= 1.25) return `${inches}" (half dollar size)`;
	if (n >= 1.0)  return `${inches}" (quarter size)`;
	if (n >= 0.75) return `${inches}" (penny size)`;
	return `${inches}"`;
}

export function normalizeHazardSourceImpact(text: string): string {
	return text
		.replace(/\bHAZARD\.?\.?\.?\s*/gi, 'HAZARD: ')
		.replace(/\bSOURCE\.?\.?\.?\s*/gi, 'SOURCE: ')
		.replace(/\bIMPACT\.?\.?\.?\s*/gi, 'IMPACT: ')
		.replace(/\b(HAZARD|SOURCE|IMPACT):\s*/gi, '$1: ');
}

function isLocationsImpactedParagraph(lines: string[]): boolean {
	if (lines.length === 0) return false;
	const first = String(lines[0] || '').trim();
	return /^Locations impacted include:/i.test(first)
		|| /^Cities impacted include:/i.test(first);
}

function reflowWrappedAlertLines(lines: string[]): string[] {
	if (lines.length <= 1) return lines.filter(Boolean);
	const paragraphs: string[] = [];
	let current = String(lines[0] || '').trim();
	for (const rawLine of lines.slice(1)) {
		const line = String(rawLine || '').trim();
		if (!line) continue;
		if (/[.!?]$/.test(current)) {
			paragraphs.push(current);
			current = line;
			continue;
		}
		current = `${current} ${line}`.trim();
	}
	if (current) paragraphs.push(current);
	return paragraphs;
}

function reflowAlertBulletParagraph(lines: string[]): string {
	const headerLines: string[] = [];
	const bulletItems: string[] = [];
	let currentBullet = '';

	for (const rawLine of lines) {
		const line = String(rawLine || '').trim();
		if (!line) continue;
		if (/^\s*-\s+/.test(line)) {
			if (currentBullet) bulletItems.push(currentBullet);
			currentBullet = line.replace(/^\s*-\s+/, '- ').trim();
			continue;
		}
		if (currentBullet) {
			currentBullet = `${currentBullet} ${line}`.trim();
			continue;
		}
		headerLines.push(line);
	}

	if (currentBullet) bulletItems.push(currentBullet);

	const parts: string[] = [];
	if (headerLines.length > 0) {
		parts.push(reflowWrappedAlertLines(headerLines).join('\n\n'));
	}
	for (const item of bulletItems) {
		parts.push(item);
	}
	return parts.join('\n\n');
}

export function reflowAlertParagraphs(text: string): string {
	const paragraphs = String(text || '')
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
	return paragraphs.map((paragraph) => {
		const lines = paragraph
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length <= 1) return lines[0] || '';
		if (isLocationsImpactedParagraph(lines)) {
			return lines.join('\n');
		}
		if (lines.some((line, index) => index > 0 && /^\s*-\s+/.test(line))) {
			return reflowAlertBulletParagraph(lines);
		}
		return reflowWrappedAlertLines(lines).join('\n\n');
	}).join('\n\n');
}

export function formatLastSynced(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const formatted = date.toLocaleString('en-US', {
		timeZone: 'America/New_York',
		month: '2-digit',
		day: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	return formatted.replace(',', '') + ' ET';
}

export function formatTimestampText(text: string): string {
	return text
		.replace(/Until\s+(\d{1,2})(\d{2})\s+PM\s+EDT/gi, (_m, h, m) => {
			const minutes = m ? m : '00';
			return `Until ${h}:${minutes} PM EDT`;
		})
		.replace(/At\s+(\d{1,2})(\d{2})\s+PM\s+EDT,/gi, (_m, h, m) => {
			const minutes = m ? m : '00';
			return `At ${h}:${minutes} PM EDT,`;
		});
}

export function escapeRegExp(value: string): string {
	return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatAlertDescription(raw: string): string {
	let text = String(raw || '').trim();

	text = text.replace(/^[A-Z]{3,8}\s*\n+/, '');
	text = text.replace(/\r\n/g, '\n');
	text = text.replace(/^\* /gm, '');
	text = text.replace(/(^|\n)\s*\.\.\.+\s*/g, '$1');

	while (/ADDITIONAL DETAILS:[^\n]*\s+-\s+/i.test(text)) {
		text = text.replace(/(ADDITIONAL DETAILS:[^\n]*)\s+-\s+/, '$1\n- ');
	}

	text = text.replace(/\bHAZARD[.:\s]+\s*/gi,  'HAZARD: ');
	text = text.replace(/\bSOURCE[.:\s]+\s*/gi,  'SOURCE: ');
	text = text.replace(/\bIMPACT[.:\s]+\s*/gi,  'IMPACT: ');

	text = text.replace(/(\n|^)WHAT(\.{0,3}|(?=[A-Z0-9]))([ \t]*)/gm,   '\nWHAT: ');
	text = text.replace(/(\n|^)WHERE(\.{0,3}|(?=[A-Z0-9]))([ \t]*)/gm,  '\nWHERE: ');
	text = text.replace(/(\n|^)WHEN(\.{0,3}|(?=[A-Z0-9]))([ \t]*)/gm,   '\nWHEN: ');
	text = text.replace(/(\n|^)IMPACTS(\.{0,3}|(?=[A-Z0-9]))([ \t]*)/gm,'\nIMPACTS: ');
	text = text.replace(/(\n|^)ADDITIONAL DETAILS(\.{0,3}|(?=[A-Z0-9]))([ \t]*)/gim, '\nADDITIONAL DETAILS: ');

	const nwsSectionLabels = [
		'WINDS', 'RELATIVE HUMIDITY', 'TEMPERATURES', 'SEVERITY', 'FUELS (ERC)',
		'WEATHER', 'FIRE ENVIRONMENT', 'THUNDERSTORMS', 'TIMING', 'MIXING HEIGHT',
		'TRANSPORT WINDS', 'SMOKE DISPERSION', 'RED FLAG THREAT INDEX',
		'CHANCE OF WETTING RAIN', 'LIGHTNING ACTIVITY LEVEL',
	];
	for (const label of nwsSectionLabels) {
		const pattern = new RegExp(
			`(\\n|^)${escapeRegExp(label)}(\\.{0,3}|(?=[A-Z0-9]))([ \\t]*)`,
			'gm',
		);
		text = text.replace(pattern, `\n${label}: `);
	}

	text = text.replace(/\bLocations impacted include\.\.\./gi, 'Locations impacted include:');

	text = text.replace(/(^|\s)\.([A-Z][A-Z0-9 ]{0,30}?)\.\.\./g, (_match, sep, label) => {
		const normalized = `${label.trim()}: `;
		return sep ? `\n${normalized}` : normalized;
	});

	text = text.replace(/\.\.\./g, ' ');
	text = text.replace(/[ \t]{2,}/g, ' ');

	text = text.replace(/\b(\d{1,2})(\d{2})\s*(AM|PM)\s*(CDT|CST|EDT|EST|MDT|MST|PDT|PST|AST|HST|AKDT|AKST)\b/gi,
		(_m, h, m, ampm, tz) => `${h}:${m} ${ampm} ${tz}`);

	text = text.replace(/\n{3,}/g, '\n\n');
	text = text.replace(/^\n+/, '');
	text = reflowAlertParagraphs(text);

	return text.trim();
}

export function formatDateTimeShort(value: string): string {
	try {
		const m = value.match(
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:\d{2})$/
		);
		if (!m) return value;
		const [, , month, day, hour24, min, offset] = m;
		const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
		const monthName = months[parseInt(month, 10) - 1];
		const h24 = parseInt(hour24, 10);
		const ampm = h24 >= 12 ? 'PM' : 'AM';
		const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
		const tzAbbr: Record<string, string> = {
			'-10:00': 'HST', '-09:00': 'AKDT', '-08:00': 'PST', '-07:00': 'PDT',
			'-06:00': 'CST', '-05:00': 'CDT', '-04:00': 'EDT',
		};
		const tz = tzAbbr[offset] ?? `UTC${offset.replace(':00', '')}`;
		return `${monthName} ${parseInt(day, 10)}, ${h12}:${min} ${ampm} ${tz}`;
	} catch {
		return value;
	}
}

export function classifyAlert(event: string): 'warning' | 'watch' | 'other' {
	if (/\bwarning\b/i.test(event)) return 'warning';
	if (/\bwatch\b/i.test(event)) return 'watch';
	return 'other';
}

export function alertImageCategory(event: string): 'advisory' | 'outlook' | 'warning' | 'watch' | 'other' {
	const raw = String(event || '').toLowerCase();
	const compact = normalizeEventSlug(raw).replace(/-/g, '');
	if (raw.includes('advisory') || /advi-?ory/.test(raw) || compact.includes('advisory')) return 'advisory';
	if (raw.includes('outlook') || /outl?ook/.test(raw) || compact.includes('outlook')) return 'outlook';
	if (raw.includes('warning') || /warnin?g/.test(raw) || compact.includes('warning')) return 'warning';
	if (raw.includes('watch') || /watc?h/.test(raw) || compact.includes('watch')) return 'watch';
	return 'other';
}

export const STATE_CODE_TO_NAME: Record<string, string> = {
	'AL': 'alabama', 'AK': 'alaska', 'AZ': 'arizona', 'AR': 'arkansas', 'CA': 'california',
	'CO': 'colorado', 'CT': 'connecticut', 'DE': 'delaware', 'FL': 'florida', 'GA': 'georgia',
	'HI': 'hawaii', 'ID': 'idaho', 'IL': 'illinois', 'IN': 'indiana', 'IA': 'iowa',
	'KS': 'kansas', 'KY': 'kentucky', 'LA': 'louisiana', 'ME': 'maine', 'MD': 'maryland',
	'MA': 'massachusetts', 'MI': 'michigan', 'MN': 'minnesota', 'MS': 'mississippi', 'MO': 'missouri',
	'MT': 'montana', 'NE': 'nebraska', 'NV': 'nevada', 'NH': 'new-hampshire', 'NJ': 'new-jersey',
	'NM': 'new-mexico', 'NY': 'new-york', 'NC': 'north-carolina', 'ND': 'north-dakota', 'OH': 'ohio',
	'OK': 'oklahoma', 'OR': 'oregon', 'PA': 'pennsylvania', 'RI': 'rhode-island', 'SC': 'south-carolina',
	'SD': 'south-dakota', 'TN': 'tennessee', 'TX': 'texas', 'UT': 'utah', 'VT': 'vermont',
	'VA': 'virginia', 'WA': 'washington', 'WV': 'west-virginia', 'WI': 'wisconsin', 'WY': 'wyoming',
	'DC': 'district-of-columbia'
};

export const STATE_CODE_TO_FIPS: Record<string, string> = {
	'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06',
	'CO': '08', 'CT': '09', 'DE': '10', 'DC': '11', 'FL': '12',
	'GA': '13', 'HI': '15', 'ID': '16', 'IL': '17', 'IN': '18',
	'IA': '19', 'KS': '20', 'KY': '21', 'LA': '22', 'ME': '23',
	'MD': '24', 'MA': '25', 'MI': '26', 'MN': '27', 'MS': '28',
	'MO': '29', 'MT': '30', 'NE': '31', 'NV': '32', 'NH': '33',
	'NJ': '34', 'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38',
	'OH': '39', 'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44',
	'SC': '45', 'SD': '46', 'TN': '47', 'TX': '48', 'UT': '49',
	'VT': '50', 'VA': '51', 'WA': '53', 'WV': '54', 'WI': '55', 'WY': '56'
};

export function slugify(text: string): string {
	return String(text || '')
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function normalizeEventSlug(raw: string): string {
	let slug = slugify(raw);
	if (!slug) return '';
	slug = slug.replace(/advi-?ory/g, 'advisory');
	slug = slug.replace(/warnin?g?/g, 'warning');
	slug = slug.replace(/floodwatch/g, 'flood-watch');
	slug = slug.replace(/high-?surf/g, 'high-surf');
	slug = slug.replace(/windadvi-?ory/g, 'wind-advisory');
	return slug;
}

export function getEventSlugVariants(event: string, eventSlug: string): string[] {
	const slugs = new Set<string>();
	if (!eventSlug) eventSlug = slugify(event || '');
	if (!eventSlug) return [];

	slugs.add(eventSlug);
	for (const expanded of expandEventSlugs(eventSlug)) {
		slugs.add(expanded);
	}

	if (eventSlug.includes('-')) {
		slugs.add(eventSlug.replace(/-/g, ''));
	} else {
		slugs.add(eventSlug.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
	}

	if (eventSlug.startsWith('pecial')) {
		slugs.add('s' + eventSlug);
	}
	if (eventSlug.endsWith('-tatement')) {
		slugs.add(eventSlug.replace(/-tatement$/, '-statement'));
	} else if (eventSlug.endsWith('tatement')) {
		slugs.add(eventSlug.replace(/tatement$/, 'statement'));
	}
	const withSpecialPrefix = eventSlug.replace(/^pecial/, 'special');
	if (withSpecialPrefix !== eventSlug) {
		slugs.add(withSpecialPrefix);
		if (withSpecialPrefix.endsWith('-tatement')) {
			slugs.add(withSpecialPrefix.replace(/-tatement$/, '-statement'));
		} else if (withSpecialPrefix.endsWith('tatement')) {
			slugs.add(withSpecialPrefix.replace(/tatement$/, 'statement'));
		}
	}

	const normalizedEvent = String(event || '').toLowerCase();
	if (/\bspecial\s+weather\s+statement\b/.test(normalizedEvent)) {
		slugs.add('special-weather-statement');
		slugs.add('specialweatherstatement');
	}

	return Array.from(slugs);
}

export function expandEventSlugs(eventSlug: string): string[] {
	const variants = new Set<string>();
	const s = String(eventSlug || '').trim();
	if (!s) return [];
	variants.add(s);

	const accelerants = ['watch', 'warning', 'advisory', 'statement', 'outlook'];
	for (const suffix of accelerants) {
		if (s.toLowerCase().endsWith(suffix) && !s.toLowerCase().endsWith(`-${suffix}`)) {
			const base = s.slice(0, -suffix.length);
			if (base) variants.add(`${base}-${suffix}`);
		}
	}

	if (s.includes('-')) {
		variants.add(s.replace(/-/g, ''));
	} else {
		variants.add(s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
	}

	return Array.from(variants);
}

export function extractStateCodes(feature: any): string[] {
	const p = feature?.properties ?? {};
	const codes = new Set<string>();
	const ugcCodes: string[] = Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [];
	for (const ugc of ugcCodes) {
		if (typeof ugc === 'string' && ugc.length >= 2) {
			const code = ugc.slice(0, 2).toUpperCase();
			if (STATE_CODE_TO_NAME[code]) {
				codes.add(code);
			}
		}
	}
	if (codes.size > 0) return Array.from(codes);
	const sender = String(p.senderName || '');
	const m = sender.match(/\b([A-Z]{2})\b/);
	if (m && STATE_CODE_TO_NAME[m[1]]) return [m[1]];
	return [];
}

export function extractStateCode(feature: any): string {
	const codes = extractStateCodes(feature);
	if (codes.length > 0) return codes[0];
	return '';
}

export function normalizeStateCode(input: unknown): string | null {
	const code = String(input ?? '').trim().toUpperCase();
	if (!code) return null;
	return STATE_CODE_TO_NAME[code] ? code : null;
}

export function stateCodeToName(code: string): string {
	return STATE_CODE_TO_NAME[String(code || '').toUpperCase()] || '';
}

export function stateNameToCode(nameOrCode: string): string {
	const raw = String(nameOrCode || '').trim();
	if (!raw) return '';
	const maybeCode = raw.toUpperCase();
	if (STATE_CODE_TO_NAME[maybeCode]) return maybeCode;
	const normalized = raw
		.toLowerCase()
		.replace(/\./g, '')
		.replace(/\s+/g, '-');
	for (const [code, slug] of Object.entries(STATE_CODE_TO_NAME)) {
		if (slug === normalized) return code;
		if (slug.replace(/-/g, ' ') === normalized.replace(/-/g, ' ')) return code;
	}
	if (normalized === 'washington-dc' || normalized === 'washington-d-c') return 'DC';
	if (normalized === 'district-of-columbia' || normalized === 'district columbia') return 'DC';
	return '';
}

export function stateCodeDisplayName(code: string): string {
	const slug = stateCodeToName(code);
	if (!slug) return String(code || '').toUpperCase();
	return slug
		.split('-')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

export const DEFAULT_PUSH_ALERT_TYPES: PushAlertTypes = {
	warnings: true,
	watches: true,
	advisories: false,
	statements: true,
};

export const DEFAULT_PUSH_QUIET_HOURS: PushQuietHours = {
	enabled: false,
	start: '22:00',
	end: '06:00',
};

export function isCountyTableDescription(text: string): boolean {
	if (!text) return false;
	return (
		/^(SEVERE THUNDERSTORM|TORNADO|WINTER STORM|BLIZZARD|ICE STORM|FLOOD)\s+(WATCH|WARNING|ADVISORY)\s+\d+/i.test(text.trim()) ||
		/FOR THE FOLLOWING AREAS/i.test(text) ||
		(/THIS WATCH INCLUDES \d+ COUNTI/i.test(text) && /THIS INCLUDES THE CITIES OF/i.test(text))
	);
}

export function alertToText(properties: any): string {
	const event      = (properties.event || 'Weather Alert').toUpperCase();
	const areaDesc   = properties.areaDesc || 'Unknown area';
	const severity   = properties.severity || '';
	const headline   = properties.headline
		?? findProperty(properties, 'NWSheadline')
		?? '';

	const expires = properties.expires ? formatDateTimeShort(properties.expires) : null;

	const rawDescription = String(properties.description || '');
	const description = isCountyTableDescription(rawDescription)
		? null
		: formatAlertDescription(rawDescription);

	const instruction = properties.instruction
		? formatAlertDescription(String(properties.instruction))
		: null;

	const lines: string[] = [];

	lines.push(event);
	lines.push('');
	lines.push(`Area: ${areaDesc}`);
	if (expires)  lines.push(`Expires: ${expires}`);
	if (severity) lines.push(`Severity: ${severity}`);

	if (headline) {
		lines.push('');
		lines.push(String(headline));
	}

	if (description) {
		lines.push('');
		lines.push(description);
	}

	if (instruction) {
		lines.push('');
		lines.push(instruction);
	}

	lines.push('');
	lines.push(PUBLIC_ALERTS_PAGE_URL);
	lines.push('');
	lines.push('#weatheralert #weather #alert');

	return lines.join('\n');
}

export function severityBadgeColor(severity: string): string {
	const s = severity.toLowerCase();
	if (s === 'extreme')  return '#7b0000';
	if (s === 'severe')   return '#cc0000';
	if (s === 'moderate') return '#e07000';
	if (s === 'minor')    return '#b8a000';
	return '#555';
}

// ---------------------------------------------------------------------------
// County extraction utilities (shared by push and facebook modules)
// ---------------------------------------------------------------------------

export function normalizeCountyFips(input: unknown): string | null {
	const digits = String(input ?? '').replace(/\D/g, '');
	if (!digits) return null;
	return digits.padStart(3, '0').slice(-3);
}

export function cleanCountyToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\b(county|counties|parish|parishes|borough|city)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function extractCountyUgcCodes(feature: any): string[] {
	const ugcCodes = Array.isArray(feature?.properties?.geocode?.UGC)
		? feature.properties.geocode.UGC
		: [];
	return dedupeStrings(
		ugcCodes
			.map((value: unknown) => String(value || '').trim().toUpperCase())
			.filter((value: string) => /^[A-Z]{2}C\d{3}$/.test(value)),
	);
}

export function extractCountyFipsFromSameCodes(
	feature: any,
	stateCodeInput?: string | null,
): string[] {
	const expectedStateCode = normalizeStateCode(stateCodeInput || '');
	const expectedStateFips = expectedStateCode
		? STATE_CODE_TO_FIPS[expectedStateCode] || null
		: null;
	const sameCodes = Array.isArray(feature?.properties?.geocode?.SAME)
		? feature.properties.geocode.SAME
		: [];

	return dedupeStrings(
		sameCodes
			.map((value: unknown) => String(value || '').replace(/\D/g, ''))
			.map((digits: string) => (digits.length >= 5 ? digits.slice(-5) : ''))
			.filter((digits: string) => /^\d{5}$/.test(digits))
			.filter((digits: string) =>
				expectedStateFips ? digits.slice(0, 2) === expectedStateFips : true,
			)
			.map((digits: string) => digits.slice(-3))
			.filter((digits: string) => /^\d{3}$/.test(digits)),
	);
}

export function extractCountyFipsCodesForState(feature: any, stateCodeInput: string): string[] {
	const stateCode = normalizeStateCode(stateCodeInput);
	if (!stateCode) return [];
	const fromUgc = extractCountyUgcCodes(feature)
		.filter((ugcCode) => ugcCode.startsWith(`${stateCode}C`))
		.map((ugcCode) => ugcCode.slice(-3))
		.filter((countyCode) => /^\d{3}$/.test(countyCode));
	const fromSame = extractCountyFipsFromSameCodes(feature, stateCode);
	return dedupeStrings([...fromUgc, ...fromSame]).sort();
}

export function extractCountyFipsCodes(feature: any): string[] {
	const fromUgc = extractCountyUgcCodes(feature)
		.map((ugc) => String(ugc).slice(-3))
		.filter((value) => /^\d{3}$/.test(value));
	const fromSame = extractCountyFipsFromSameCodes(feature);
	return dedupeStrings([...fromUgc, ...fromSame]).sort();
}

export function normalizeFullCountyFips(input: unknown): string | null {
	const digits = String(input ?? '').replace(/\D/g, '');
	if (!/^\d{5}$/.test(digits)) return null;
	return digits;
}

export function extractFullCountyFipsCodes(
	feature: any,
	change?: import('./types').AlertChangeRecord | null,
): string[] {
	const fullCodes = new Set<string>();

	for (const ugcCode of extractCountyUgcCodes(feature)) {
		const stateCode = ugcCode.slice(0, 2).toUpperCase();
		const countyCode = ugcCode.slice(-3);
		const stateFips = STATE_CODE_TO_FIPS[stateCode];
		if (stateFips && /^\d{3}$/.test(countyCode)) {
			fullCodes.add(`${stateFips}${countyCode}`);
		}
	}

	const sameCodes = Array.isArray(feature?.properties?.geocode?.SAME)
		? feature.properties.geocode.SAME
		: [];
	for (const sameCode of sameCodes) {
		const normalized = normalizeFullCountyFips(sameCode);
		if (normalized) {
			fullCodes.add(normalized);
		}
	}

	if (fullCodes.size === 0 && change && change.stateCodes.length === 1) {
		const stateFips = STATE_CODE_TO_FIPS[String(change.stateCodes[0] || '').toUpperCase()];
		if (stateFips) {
			for (const countyCode of change.countyCodes) {
				const normalizedCounty = normalizeCountyFips(countyCode);
				if (normalizedCounty) {
					fullCodes.add(`${stateFips}${normalizedCounty}`);
				}
			}
		}
	}

	return Array.from(fullCodes).sort();
}

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

export function truncateText(value: string, maxLength: number): string {
	const text = String(value || '').trim();
	if (text.length <= maxLength) return text;
	return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Alert impact / classification helpers (shared across many modules)
// ---------------------------------------------------------------------------

export function classifyAlertCategoryFromEvent(event: string): string {
	const normalized = String(event || '').toLowerCase();
	if (normalized.includes('warning')) return 'warning';
	if (normalized.includes('watch')) return 'watch';
	if (normalized.includes('advisory')) return 'advisory';
	if (normalized.includes('statement')) return 'statement';
	return 'other';
}

export function deriveAlertImpactCategories(
	event: string,
	headline: string,
	description: string,
): import('./types').AlertImpactCategory[] {
	const text = `${String(event || '')} ${String(headline || '')} ${String(description || '')}`
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();

	const categories: import('./types').AlertImpactCategory[] = [];
	const addCategory = (value: import('./types').AlertImpactCategory) => {
		if (!categories.includes(value)) {
			categories.push(value);
		}
	};

	if (/\btornado\b/.test(text)) {
		addCategory('tornado');
		addCategory('wind');
	}
	if (/\bflood|inundation|hydrologic/.test(text)) {
		addCategory('flood');
	}
	if (/\bwinter|snow|sleet|blizzard|ice storm|freezing rain|wind chill|freeze|frost/.test(text)) {
		addCategory('winter');
	}
	if (/\bheat|hot weather|high temperature|heat index/.test(text)) {
		addCategory('heat');
	}
	if (/\bwind|gust/.test(text)) {
		addCategory('wind');
	}
	if (/\bred flag|fire weather|wildfire|smoke/.test(text)) {
		addCategory('fire');
	}
	if (/\bcoastal|surf|rip current|storm surge/.test(text)) {
		addCategory('coastal');
	}
	if (/\bmarine|gale|small craft|hazardous seas|tsunami/.test(text)) {
		addCategory('marine');
	}
	if (/\bair quality|air stagnation|ozone|particulate/.test(text)) {
		addCategory('air_quality');
	}

	if (categories.length === 0) {
		addCategory('other');
	}

	return categories;
}

export function isMajorImpactAlertEvent(
	event: string,
	severity: string,
	impactCategories: import('./types').AlertImpactCategory[] = [],
): boolean {
	const normalizedEvent = String(event || '').toLowerCase();
	const normalizedSeverity = String(severity || '').toLowerCase();
	if (normalizedSeverity === 'extreme') return true;
	if (
		/tornado warning|flash flood warning|flood warning|severe thunderstorm warning|extreme wind warning|high wind warning|hurricane warning|storm surge warning|blizzard warning|ice storm warning|excessive heat warning/.test(
			normalizedEvent,
		)
	) {
		return true;
	}
	if (normalizedEvent.includes('warning') && normalizedSeverity === 'severe') {
		return true;
	}
	return impactCategories.includes('tornado') && normalizedEvent.includes('warning');
}

// ---------------------------------------------------------------------------
// Canonical URL helpers
// ---------------------------------------------------------------------------

export function canonicalAlertDetailUrl(alertId: string): string {
	const normalizedId = String(alertId || '').trim();
	if (!normalizedId) return '/?tab=alerts';
	return `/?alert=${encodeURIComponent(normalizedId)}`;
}

export function canonicalAlertsPageUrl(stateCode?: string | null): string {
	const normalizedState = normalizeStateCode(stateCode || '');
	const params = new URLSearchParams();
	params.set('tab', 'alerts');
	if (normalizedState) {
		params.set('state', normalizedState);
	}
	const query = params.toString();
	return query ? `/?${query}` : '/';
}

export function canonicalSettingsUrl(): string {
	return '/?tab=more';
}

export function redirectToCanonicalAppUrl(request: Request, targetPath: string, status = 302): Response {
	return Response.redirect(new URL(targetPath, request.url).toString(), status);
}
