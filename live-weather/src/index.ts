import { renderPublicAlertsPage } from './public-alerts-page';
import {
	buildPushPayload,
	type PushMessage,
	type PushSubscription as WebPushSubscription,
	type VapidKeys,
} from '@block65/webcrypto-web-push';

interface Env {
	WEATHER_KV: KVNamespace;
	FB_PAGE_ID?: string;
	FB_PAGE_ACCESS_TOKEN?: string;
	ADMIN_PASSWORD?: string;
	FB_IMAGE_BASE_URL?: string;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	ASSETS?: {
		fetch(request: Request): Promise<Response>;
	};
}

// NWS active alerts — full US feed.
// ETags mean a 304 (nothing changed) costs almost nothing.
// Contact info in User-Agent is per NWS guidelines — they email you instead of silently blocking.
const WEATHER_API    = 'https://api.weather.gov/alerts/active';
const NWS_USER_AGENT = 'LocalKYNews/1.0 (localkynews.com; news@localkynews.com)';
const NWS_ACCEPT     = 'application/geo+json,application/json';
const FB_GRAPH_API   = 'https://graph.facebook.com/v17.0';
const DEFAULT_WEATHER_LAT = 41.8781;
const DEFAULT_WEATHER_LON = -87.6298;

// KV keys
const KV_ALERT_MAP  = 'alerts:map';       // JSON: Record<alertId, feature> — merged active alerts
const KV_ETAG       = 'alerts:etag';      // Last ETag string from NWS
const KV_LAST_POLL  = 'alerts:last-poll'; // ISO timestamp of last successful poll
const KV_FB_APP_CONFIG = 'fb:app-config';  // JSON: { appId, appSecret }
const KV_PUSH_SUB_PREFIX = 'push:sub:'; // push:sub:{sha256(endpoint)}
const KV_PUSH_STATE_INDEX_PREFIX = 'push:index:state:'; // push:index:state:{stateCode}
const KV_PUSH_STATE_ALERT_SNAPSHOT = 'push:state-alert-snapshot:v1'; // JSON: Record<stateCode, alertId[]>
// KV thread keys: thread:{ugc}:{eventSlug} — tracks active FB post threads per county+alertType
// e.g. thread:KYC195:severe_thunderstorm_warning

interface AlertThread {
	postId: string;       // Facebook post ID to comment on
	nwsAlertId: string;   // NWS alert ID that created this thread
	expiresAt: number;    // Unix timestamp (seconds) — used to prune stale threads
	county: string;       // areaDesc
	alertType: string;    // properties.event
	updateCount: number;  // number of update comments posted on this anchor post (0-based)
}

interface FbAppConfig {
	appId?: string;
	appSecret?: string;
}

type PushAlertTypes = {
	warnings: boolean;
	watches: boolean;
	advisories: boolean;
	statements: boolean;
};

type PushQuietHours = {
	enabled: boolean;
	start: string;
	end: string;
};

type PushPreferences = {
	stateCode: string;
	deliveryScope: 'state' | 'county';
	countyName?: string | null;
	countyFips?: string | null;
	alertTypes: PushAlertTypes;
	quietHours: PushQuietHours;
};

interface PushSubscriptionRecord {
	id: string;
	endpoint: string;
	stateCode: string;
	subscription: WebPushSubscription;
	prefs?: PushPreferences;
	createdAt: string;
	updatedAt: string;
	userAgent?: string;
}

type PushStateAlertSnapshot = Record<string, string[]>;

interface SavedLocation {
	lat: number;
	lon: number;
	city?: string;
	state?: string;
	zip?: string;
	county?: string;
	countyCode?: string;
	label: string;
}

class HttpError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const ZIP_RE = /^\d{5}$/;

async function readFbAppConfig(env: Env): Promise<FbAppConfig> {
	try {
		const raw = await env.WEATHER_KV.get(KV_FB_APP_CONFIG);
		if (!raw) return {};
		return JSON.parse(raw) as FbAppConfig;
	} catch {
		return {};
	}
}

async function writeFbAppConfig(env: Env, config: FbAppConfig): Promise<void> {
	await env.WEATHER_KV.put(KV_FB_APP_CONFIG, JSON.stringify(config));
}

function threadKvKey(ugcCode: string, event: string): string {
	const slug = event.toLowerCase().replace(/\s+/g, '_');
	return `thread:${ugcCode}:${slug}`;
}

async function readThread(env: Env, ugcCode: string, event: string): Promise<AlertThread | null> {
	try {
		const raw = await env.WEATHER_KV.get(threadKvKey(ugcCode, event));
		if (!raw) return null;
		const t = JSON.parse(raw) as AlertThread;
		// Prune if expired (give a 10-minute grace window)
		if (t.expiresAt && t.expiresAt < (Date.now() / 1000) - 600) {
			await env.WEATHER_KV.delete(threadKvKey(ugcCode, event));
			return null;
		}
		return t;
	} catch {
		return null;
	}
}

async function writeThread(env: Env, ugcCode: string, thread: AlertThread): Promise<void> {
	const key = threadKvKey(ugcCode, thread.alertType);
	const nowSec = Math.floor(Date.now() / 1000);
	const expiresAt = Number(thread.expiresAt);
	const ttl = (Number.isFinite(expiresAt) && expiresAt > nowSec)
		? Math.max(300, expiresAt - nowSec + 7200)
		: 7200; // default to 2 hours if expiry is missing/invalid
	await env.WEATHER_KV.put(key, JSON.stringify(thread), { expirationTtl: ttl });
}

async function deleteThread(env: Env, ugcCode: string, event: string): Promise<void> {
	await env.WEATHER_KV.delete(threadKvKey(ugcCode, event));
}

/**
 * Wraps alertToText() output with a "Updates will be posted in the comments" line
 * inserted between the dashboard URL and the hashtag block.
 * Used for every new anchor post. If customMessage is provided, use it as-is instead.
 */
function buildAnchorPostText(properties: any): string {
	const caption = alertToText(properties);
	const hashtagLine = '#weatheralert #weather #alert';
	const base = caption.endsWith(hashtagLine)
		? caption.slice(0, -hashtagLine.length).trimEnd()
		: caption.trimEnd();
	return `${base}\n\n🔄 Updates will be posted in the comments as conditions change.\n\n${hashtagLine}`;
}

/**
 * Strips hashtags and the dashboard link from post text so comments are clean.
 */
function buildCommentText(text: string): string {
	const lines = text.split('\n');
	const filtered = lines.filter(line => {
		const trimmed = line.trim();
		if (trimmed.startsWith('#')) return false;
		if (trimmed.includes('localkynews.com')) return false;
		return true;
	});
	while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
		filtered.pop();
	}
	return filtered.join('\n');
}

function safeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function nl2br(text: string): string {
	return safeHtml(text).replace(/\r?\n/g, '<br>');
}

function descriptionToHtml(text: string): string {
	const escaped = safeHtml(text)
		.replace(/HAZARD:/g, '<strong>HAZARD:</strong>')
		.replace(/SOURCE:/g, '<strong>SOURCE:</strong>')
		.replace(/IMPACT:/g, '<strong>IMPACT:</strong>');
	return escaped.replace(/\r?\n/g, '<br>');
}

function mapSomeValue(value: unknown): string {
	if (value == null) return '';
	if (Array.isArray(value)) return value.filter((v) => v != null).join(', ');
	return String(value);
}

function findProperty(p: any, key: string): unknown {
	if (!p || typeof p !== 'object') return undefined;
	if (p[key] != null) return p[key];
	if (p.parameters && p.parameters[key] != null) return p.parameters[key];
	if (p.parameters && p.parameters[`${key}s`] != null) return p.parameters[`${key}s`];
	return undefined;
}

function authToken(password: string): string {
	return `LWAUTH:${password}`;
}

function isAuthenticated(request: Request, env: Env): boolean {
	const cookie = request.headers.get('cookie') || '';
	const auth = cookie.split(';').map((kv) => kv.trim()).find((kv) => kv.startsWith('admin_session='));
	if (!auth) return false;
	const token = auth.split('=')[1] || '';
	const secret = env.ADMIN_PASSWORD || 'liveweather';
	return token === encodeURIComponent(authToken(secret));
}


/**
 * Format an ISO 8601 datetime string for display, preserving the local time
 * and timezone offset that NWS encoded in the string.
 *
 * Cloudflare Workers run in UTC, so a plain toLocaleString() without a timeZone
 * option always renders UTC — wrong for readers.  We extract the wall-clock time
 * and UTC offset directly from the ISO string and build a friendly label like
 * "Sun, Mar 22, 2026, 7:17 PM (UTC-5)" without relying on IANA zone lookup,
 * which avoids the CDT/EDT ambiguity for cross-timezone alerts.
 */
function formatDateTime(value: string): string {
	try {
		// Try to parse the offset and wall-clock time directly from the ISO string.
		// Pattern: YYYY-MM-DDTHH:MM:SS±HH:MM  (NWS always includes offset)
		const m = value.match(
			/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:\d{2})$/
		);
		if (m) {
			const [, year, month, day, hour24, min, offset] = m;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;

			// Day-of-week from the actual UTC instant
			const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
			// Reconstruct the local date to get the correct day-of-week
			const localMs = date.getTime() + (date.getTimezoneOffset() * 60000);
			const offsetSign = offset[0] === '+' ? 1 : -1;
			const [offH, offM] = offset.slice(1).split(':').map(Number);
			const offsetMs = offsetSign * (offH * 60 + offM) * 60000;
			const localDate = new Date(date.getTime() + offsetMs + date.getTimezoneOffset() * 60000);
			const dow = dows[localDate.getUTCDay()];

			// Format month name
			const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
			const monthName = months[parseInt(month, 10) - 1];

			// Format hour as 12-hour
			const h24 = parseInt(hour24, 10);
			const ampm = h24 >= 12 ? 'PM' : 'AM';
			const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

			// Show offset as "UTC-5" / "UTC+0" etc.
			const offLabel = `UTC${offset.replace(':00', '').replace(':30', '.5')}`;

			return `${dow}, ${monthName} ${parseInt(day, 10)}, ${year}, ${h12}:${min} ${ampm} (${offLabel})`;
		}

		// Fallback: just parse and display in UTC
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

/** Convert a decimal inch hail size to a human-readable coin/object description. */
function hailDesc(inches: string): string {
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

function normalizeHazardSourceImpact(text: string): string {
	return text
		.replace(/\bHAZARD\.?\.?\.?\s*/gi, 'HAZARD: ')
		.replace(/\bSOURCE\.?\.?\.?\s*/gi, 'SOURCE: ')
		.replace(/\bIMPACT\.?\.?\.?\s*/gi, 'IMPACT: ')
		.replace(/\b(HAZARD|SOURCE|IMPACT):\s*/gi, '$1: ');
}

function formatLastSynced(iso: string): string {
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
	// toLocaleString returns "MM/DD/YYYY, HH:MM:SS" for en-US; strip comma and append ET
	return formatted.replace(',', '') + ' ET';
}

function formatTimestampText(text: string): string {
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

function formatAlertDescription(raw: string): string {
	let text = String(raw || '').trim();

	// Strip leading product code line (e.g. "SVRILX", "CFWSJU")
	text = text.replace(/^[A-Z]{3,8}\s*\n+/, '');
	text = text.replace(/\r\n/g, '\n');

	// Remove NWS bullet asterisks
	text = text.replace(/^\* /gm, '');

	// --- Section header normalization ---
	// Must happen BEFORE ellipsis stripping so "HAZARD...text" and "WHAT...text" match.
	//
	// Format 1: Watch/Warning style  — HAZARD...  SOURCE...  IMPACT...
	text = text.replace(/\bHAZARD[.:\s]+\s*/gi,  'HAZARD: ');
	text = text.replace(/\bSOURCE[.:\s]+\s*/gi,  'SOURCE: ');
	text = text.replace(/\bIMPACT[.:\s]+\s*/gi,  'IMPACT: ');
	//
	// Format 2: Advisory/Statement style — WHAT... WHERE... WHEN... IMPACTS...
	// NWS runs these together with no space: "WHATLife-threatening rip currents."
	// Match the all-caps label (optionally followed by ellipses/spaces) at the
	// start of a line OR immediately after a newline, then inject "LABEL: ".
	// We use a lookahead for an uppercase letter or digit after the keyword to
	// catch the run-together case, and also match the ellipsis form "WHAT...".
	text = text.replace(/(\n|^)WHAT(\.{0,3}|(?=[A-Z0-9]))(\s*)/gm,   '\nWHAT: ');
	text = text.replace(/(\n|^)WHERE(\.{0,3}|(?=[A-Z0-9]))(\s*)/gm,  '\nWHERE: ');
	text = text.replace(/(\n|^)WHEN(\.{0,3}|(?=[A-Z0-9]))(\s*)/gm,   '\nWHEN: ');
	text = text.replace(/(\n|^)IMPACTS(\.{0,3}|(?=[A-Z0-9]))(\s*)/gm,'\nIMPACTS: ');
	text = text.replace(/(\n|^)ADDITIONAL DETAILS(\.{0,3}|(?=[A-Z0-9]))(\s*)/gim, '\nADDITIONAL DETAILS: ');

	// Normalize "Locations impacted include..." bullet
	text = text.replace(/\bLocations impacted include\.\.\./gi, 'Locations impacted include:');

	// Clean up remaining NWS ellipsis punctuation
	text = text.replace(/\.\.\./g, '');

	// Fix run-together timestamps like "828 PM EDT" -> "8:28 PM EDT"
	// Covers all US zones including AST (Puerto Rico / Virgin Islands)
	text = text.replace(/\b(\d{1,2})(\d{2})\s*(AM|PM)\s*(CDT|CST|EDT|EST|MDT|MST|PDT|PST|AST|HST|AKDT|AKST)\b/gi,
		(_m, h, m, ampm, tz) => `${h}:${m} ${ampm} ${tz}`);

	// Collapse excess blank lines
	text = text.replace(/\n{3,}/g, '\n\n');
	// Clean up any leading newline we may have introduced
	text = text.replace(/^\n+/, '');

	return text.trim();
}

/**
 * Short date format for Facebook post header: "Mar 22, 9:00 PM EDT"
 * Reads wall-clock time and offset directly from the ISO string.
 */
function formatDateTimeShort(value: string): string {
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
		// Common NWS UTC offset -> abbreviation mapping
		const tzAbbr: Record<string, string> = {
			'-10:00': 'HST',
			'-09:00': 'AKDT',
			'-08:00': 'PST',
			'-07:00': 'PDT',
			'-06:00': 'CST',
			'-05:00': 'CDT',
			'-04:00': 'EDT',
		};
		const tz = tzAbbr[offset] ?? `UTC${offset.replace(':00', '')}`;
		return `${monthName} ${parseInt(day, 10)}, ${h12}:${min} ${ampm} ${tz}`;
	} catch {
		return value;
	}
}

function classifyAlert(event: string): 'warning' | 'watch' | 'other' {
	if (/\bwarning\b/i.test(event)) return 'warning';
	if (/\bwatch\b/i.test(event)) return 'watch';
	return 'other';
}

function alertImageCategory(event: string): 'advisory' | 'outlook' | 'warning' | 'watch' | 'other' {
	const raw = String(event || '').toLowerCase();
	// Use a normalized compact string so we still classify corrupted forms like
	// "advi-ory", "adviory", and "warnin".
	const compact = normalizeEventSlug(raw).replace(/-/g, '');
	if (raw.includes('advisory') || /advi-?ory/.test(raw) || compact.includes('advisory')) return 'advisory';
	if (raw.includes('outlook') || /outl?ook/.test(raw) || compact.includes('outlook')) return 'outlook';
	if (raw.includes('warning') || /warnin?g/.test(raw) || compact.includes('warning')) return 'warning';
	if (raw.includes('watch') || /watc?h/.test(raw) || compact.includes('watch')) return 'watch';
	return 'other';
}

const STATE_CODE_TO_NAME: Record<string, string> = {
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

function slugify(text: string): string {
	return String(text || '')
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizeEventSlug(raw: string): string {
	let slug = slugify(raw);
	if (!slug) return '';
	// Repair common broken forms even when they appear inside longer tokens
	// (for example: "winterweatheradviory").
	slug = slug.replace(/advi-?ory/g, 'advisory');
	slug = slug.replace(/warnin?g?/g, 'warning');
	slug = slug.replace(/floodwatch/g, 'flood-watch');
	slug = slug.replace(/high-?surf/g, 'high-surf');
	slug = slug.replace(/windadvi-?ory/g, 'wind-advisory');
	return slug;
}

function getEventSlugVariants(event: string, eventSlug: string): string[] {
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

	// Recovery for truncated or corrupted data seen in production.
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

function stateCodeToName(code: string): string {
	return STATE_CODE_TO_NAME[String(code || '').toUpperCase()] || '';
}

function stateNameToCode(nameOrCode: string): string {
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

function expandEventSlugs(eventSlug: string): string[] {
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

function extractStateCodes(feature: any): string[] {
	const p = feature?.properties ?? {};
	const codes = new Set<string>();
	const ugcCodes: string[] = Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [];
	for (const ugc of ugcCodes) {
		if (typeof ugc === 'string' && ugc.length >= 2) {
			const code = ugc.slice(0, 2).toUpperCase();
			// Only accept codes that are actual US state/territory abbreviations.
			// Marine zone prefixes (AM, PZ, GM, AN, LC, LE, LH, LM, LO, LS, SL, PM, PH, PK, PS, PY)
			// are NOT state codes and must be rejected to avoid bad image paths.
			if (STATE_CODE_TO_NAME[code]) {
				codes.add(code);
			}
		}
	}
	if (codes.size > 0) return Array.from(codes);
	// fallback: try to infer from sender name (e.g. "NWS Louisville KY")
	const sender = String(p.senderName || '');
	const m = sender.match(/\b([A-Z]{2})\b/);
	if (m && STATE_CODE_TO_NAME[m[1]]) return [m[1]];
	return [];
}

function extractStateCode(feature: any): string {
	const codes = extractStateCodes(feature);
	if (codes.length > 0) return codes[0];
	return '';
}

function normalizeStateCode(input: unknown): string | null {
	const code = String(input ?? '').trim().toUpperCase();
	if (!code) return null;
	return STATE_CODE_TO_NAME[code] ? code : null;
}

function stateCodeDisplayName(code: string): string {
	const slug = stateCodeToName(code);
	if (!slug) return String(code || '').toUpperCase();
	return slug
		.split('-')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function pushSubKey(subscriptionId: string): string {
	return `${KV_PUSH_SUB_PREFIX}${subscriptionId}`;
}

function pushStateIndexKey(stateCode: string): string {
	return `${KV_PUSH_STATE_INDEX_PREFIX}${stateCode}`;
}

function getVapidKeys(env: Env): VapidKeys | null {
	const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
	const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
	const subject = String(env.VAPID_SUBJECT || '').trim() || 'mailto:alerts@liveweatheralerts.com';
	if (!publicKey || !privateKey) return null;
	return { publicKey, privateKey, subject };
}

function isValidPushSubscription(value: unknown): value is WebPushSubscription {
	const v = value as Record<string, any> | null | undefined;
	if (!v || typeof v !== 'object') return false;
	const endpoint = String(v.endpoint ?? '');
	const keys = v.keys as Record<string, any> | undefined;
	const auth = String(keys?.auth ?? '');
	const p256dh = String(keys?.p256dh ?? '');
	if (!endpoint.startsWith('https://')) return false;
	return auth.length > 0 && p256dh.length > 0;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function dedupeStrings(values: string[]): string[] {
	return Array.from(new Set(values.filter(Boolean)));
}

async function readPushStateIndex(env: Env, stateCode: string): Promise<string[]> {
	try {
		const raw = await env.WEATHER_KV.get(pushStateIndexKey(stateCode));
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return dedupeStrings(parsed.map((v) => String(v)));
	} catch {
		return [];
	}
}

async function writePushStateIndex(env: Env, stateCode: string, subscriptionIds: string[]): Promise<void> {
	const ids = dedupeStrings(subscriptionIds);
	if (ids.length === 0) {
		await env.WEATHER_KV.delete(pushStateIndexKey(stateCode));
		return;
	}
	await env.WEATHER_KV.put(pushStateIndexKey(stateCode), JSON.stringify(ids));
}

async function addPushIdToStateIndex(env: Env, stateCode: string, subscriptionId: string): Promise<void> {
	const current = await readPushStateIndex(env, stateCode);
	if (current.includes(subscriptionId)) return;
	current.push(subscriptionId);
	await writePushStateIndex(env, stateCode, current);
}

async function removePushIdFromStateIndex(env: Env, stateCode: string, subscriptionId: string): Promise<void> {
	const current = await readPushStateIndex(env, stateCode);
	const next = current.filter((id) => id !== subscriptionId);
	await writePushStateIndex(env, stateCode, next);
}

async function readPushSubscriptionRecordById(env: Env, subscriptionId: string): Promise<PushSubscriptionRecord | null> {
	try {
		const raw = await env.WEATHER_KV.get(pushSubKey(subscriptionId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PushSubscriptionRecord;
		if (!parsed?.id || !parsed?.endpoint || !parsed?.stateCode) return null;
		if (!isValidPushSubscription(parsed.subscription)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function defaultPushPreferences(stateCode: string): PushPreferences {
	return {
		stateCode,
		deliveryScope: 'state',
		countyName: null,
		countyFips: null,
		alertTypes: {
			warnings: true,
			watches: true,
			advisories: false,
			statements: true,
		},
		quietHours: {
			enabled: false,
			start: '22:00',
			end: '06:00',
		},
	};
}

function classifyAlertType(event: string): keyof PushAlertTypes {
	const text = String(event || '').toLowerCase();
	if (text.includes('warning')) return 'warnings';
	if (text.includes('watch')) return 'watches';
	if (text.includes('advisory')) return 'advisories';
	return 'statements';
}

function alertMatchesTypePrefs(event: string, prefs: PushPreferences): boolean {
	const bucket = classifyAlertType(event);
	return !!prefs.alertTypes[bucket];
}

function timeStringToMinutes(value: string): number {
	const [h, m] = String(value || '00:00').split(':').map((v) => Number(v) || 0);
	return h * 60 + m;
}

function isWithinQuietHours(now: Date, prefs: PushPreferences): boolean {
	if (!prefs.quietHours.enabled) return false;
	const current = now.getHours() * 60 + now.getMinutes();
	const start = timeStringToMinutes(prefs.quietHours.start);
	const end = timeStringToMinutes(prefs.quietHours.end);
	if (start === end) return false;
	if (start < end) return current >= start && current < end;
	return current >= start || current < end;
}

function alertBypassesQuietHours(event: string): boolean {
	const text = String(event || '').toLowerCase();
	return text.includes('tornado warning') || text.includes('severe thunderstorm warning');
}

function alertMatchesCountyPrefs(feature: any, prefs: PushPreferences): boolean {
	if (prefs.deliveryScope !== 'county') return true;
	const areaDesc = String(feature?.properties?.areaDesc || '').toLowerCase();
	const countyName = String(prefs.countyName || '').trim().toLowerCase();
	if (!countyName) return false;
	return areaDesc.includes(countyName);
}

async function upsertPushSubscriptionRecord(
	env: Env,
	subscription: WebPushSubscription,
	stateCode: string,
	userAgent?: string,
	prefs?: PushPreferences,
): Promise<PushSubscriptionRecord> {
	const nowIso = new Date().toISOString();
	const subscriptionId = await sha256Hex(subscription.endpoint);
	const existing = await readPushSubscriptionRecordById(env, subscriptionId);
	const normalizedState = normalizeStateCode(stateCode) || stateCode;

	const nextPrefs = prefs
		? { ...defaultPushPreferences(normalizedState), ...prefs, stateCode: normalizedState }
		: existing?.prefs || defaultPushPreferences(normalizedState);

	const record: PushSubscriptionRecord = {
		id: subscriptionId,
		endpoint: subscription.endpoint,
		stateCode: normalizedState,
		subscription,
		prefs: nextPrefs,
		createdAt: existing?.createdAt || nowIso,
		updatedAt: nowIso,
		userAgent: String(userAgent || existing?.userAgent || '').slice(0, 300),
	};

	await env.WEATHER_KV.put(pushSubKey(subscriptionId), JSON.stringify(record));

	if (existing?.stateCode && existing.stateCode !== normalizedState) {
		await removePushIdFromStateIndex(env, existing.stateCode, subscriptionId);
	}
	await addPushIdToStateIndex(env, normalizedState, subscriptionId);

	return record;
}

async function removePushSubscriptionById(env: Env, subscriptionId: string): Promise<boolean> {
	const existing = await readPushSubscriptionRecordById(env, subscriptionId);
	if (!existing) {
		await env.WEATHER_KV.delete(pushSubKey(subscriptionId));
		return false;
	}
	await Promise.all([
		env.WEATHER_KV.delete(pushSubKey(subscriptionId)),
		removePushIdFromStateIndex(env, existing.stateCode, subscriptionId),
	]);
	return true;
}

async function removePushSubscriptionByEndpoint(env: Env, endpoint: string): Promise<boolean> {
	const subscriptionId = await sha256Hex(endpoint);
	return await removePushSubscriptionById(env, subscriptionId);
}

function buildStateAlertSnapshot(map: Record<string, any>): PushStateAlertSnapshot {
	const snapshot: PushStateAlertSnapshot = {};
	for (const [fallbackId, feature] of Object.entries(map)) {
		const id = String((feature as any)?.id ?? fallbackId ?? '');
		if (!id) continue;
		const stateCodes = extractStateCodes(feature);
		for (const stateCode of stateCodes) {
			if (!snapshot[stateCode]) snapshot[stateCode] = [];
			snapshot[stateCode].push(id);
		}
	}
	for (const stateCode of Object.keys(snapshot)) {
		snapshot[stateCode] = dedupeStrings(snapshot[stateCode]).sort();
	}
	return snapshot;
}

async function readPushStateAlertSnapshot(env: Env): Promise<PushStateAlertSnapshot | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_PUSH_STATE_ALERT_SNAPSHOT);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const snapshot: PushStateAlertSnapshot = {};
		for (const [stateCode, ids] of Object.entries(parsed as Record<string, unknown>)) {
			if (!Array.isArray(ids)) continue;
			const normalized = normalizeStateCode(stateCode);
			if (!normalized) continue;
			snapshot[normalized] = dedupeStrings(ids.map((id) => String(id))).sort();
		}
		return snapshot;
	} catch {
		return null;
	}
}

async function writePushStateAlertSnapshot(env: Env, snapshot: PushStateAlertSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_PUSH_STATE_ALERT_SNAPSHOT, JSON.stringify(snapshot));
}

function truncateText(value: string, maxLength: number): string {
	const text = String(value || '').trim();
	if (text.length <= maxLength) return text;
	return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

function buildStatePushMessageData(stateCode: string, features: any[]): Record<string, any> {
	const stateName = stateCodeDisplayName(stateCode);
	if (features.length <= 1) {
		const feature = features[0] ?? {};
		const properties = feature?.properties ?? {};
		const alertId = String(feature?.id ?? properties?.id ?? '');
		const event = String(properties.event ?? 'Weather Alert');
		const headline = String(properties.headline ?? '').trim();
		const areaDesc = String(properties.areaDesc ?? '').trim();
		return {
			title: `${event} - ${stateName}`,
			body: truncateText(headline || areaDesc || 'Tap for details.', 140),
			url: `/?state=${encodeURIComponent(stateCode)}`,
			tag: `state-${stateCode}-${alertId || Date.now()}`,
			stateCode,
			alertId,
			icon: '/logo/Live Weather Alerts logo 192.png',
			badge: '/logo/Live Weather Alerts logo 32.png',
		};
	}

	const warningCount = features.filter((f) => classifyAlert(String(f?.properties?.event ?? '')) === 'warning').length;
	const watchCount = features.filter((f) => classifyAlert(String(f?.properties?.event ?? '')) === 'watch').length;
	const bodyParts = [];
	if (warningCount > 0) bodyParts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
	if (watchCount > 0) bodyParts.push(`${watchCount} watch${watchCount === 1 ? '' : 'es'}`);
	if (bodyParts.length === 0) bodyParts.push(`${features.length} new alerts`);

	return {
		title: `${features.length} new weather alerts - ${stateName}`,
		body: truncateText(`Includes ${bodyParts.join(', ')}. Tap to review now.`, 140),
		url: `/?state=${encodeURIComponent(stateCode)}`,
		tag: `state-${stateCode}-${Date.now()}`,
		stateCode,
		icon: '/logo/Live Weather Alerts logo 192.png',
		badge: '/logo/Live Weather Alerts logo 32.png',
	};
}

async function sendPushForState(env: Env, vapid: VapidKeys, stateCode: string, newFeatures: any[]): Promise<void> {
	if (newFeatures.length === 0) return;
	const subscriptionIds = await readPushStateIndex(env, stateCode);
	if (subscriptionIds.length === 0) return;

	for (const subscriptionId of subscriptionIds) {
		const record = await readPushSubscriptionRecordById(env, subscriptionId);
		if (!record) {
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
			continue;
		}
		if (record.stateCode !== stateCode) {
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
			continue;
		}

		const prefs = record.prefs || defaultPushPreferences(stateCode);

		const matchingFeatures = newFeatures.filter((feature) => {
			const event = String(feature?.properties?.event || '');

			if (!alertMatchesTypePrefs(event, prefs)) return false;
			if (!alertMatchesCountyPrefs(feature, prefs)) return false;

			if (isWithinQuietHours(new Date(), prefs) && !alertBypassesQuietHours(event)) {
				return false;
			}

			return true;
		});

		if (matchingFeatures.length === 0) {
			continue;
		}

		const payloadData = buildStatePushMessageData(stateCode, matchingFeatures);

		try {
			const message: PushMessage = {
				data: payloadData,
				options: { ttl: 900, urgency: 'high', topic: `state-${stateCode}` },
			};
			const payload = await buildPushPayload(message, record.subscription, vapid);
			const response = await fetch(record.subscription.endpoint, payload);

			// Endpoint is gone — clean up to avoid repeated failures.
			if (response.status === 404 || response.status === 410) {
				await removePushSubscriptionById(env, subscriptionId);
			} else if (!response.ok) {
				const body = await response.text().catch(() => '');
				console.log(`[push] send failed state=${stateCode} status=${response.status} body=${body.slice(0, 240)}`);
			}
		} catch (err) {
			console.log(`[push] send exception state=${stateCode} err=${String(err)}`);
			// Ignore transient send failures and retry on the next schedule cycle.
		}
	}
}

async function dispatchStatePushNotifications(env: Env, map: Record<string, any>): Promise<void> {
	const vapid = getVapidKeys(env);
	if (!vapid) return;

	const currentSnapshot = buildStateAlertSnapshot(map);
	const previousSnapshot = await readPushStateAlertSnapshot(env);
	if (!previousSnapshot) {
		// First run: establish baseline to avoid blasting for all currently active alerts.
		await writePushStateAlertSnapshot(env, currentSnapshot);
		return;
	}

	const allStateCodes = dedupeStrings([
		...Object.keys(previousSnapshot),
		...Object.keys(currentSnapshot),
	]);

	for (const stateCode of allStateCodes) {
		const currentIds = new Set(currentSnapshot[stateCode] ?? []);
		const previousIds = new Set(previousSnapshot[stateCode] ?? []);
		const newIds = Array.from(currentIds).filter((id) => !previousIds.has(id));
		if (newIds.length === 0) continue;
		const newFeatures = newIds.map((id) => map[id]).filter(Boolean);
		await sendPushForState(env, vapid, stateCode, newFeatures);
	}

	await writePushStateAlertSnapshot(env, currentSnapshot);
}

/**
 * Detect the legacy NWS watch/advisory county-table description format.
 * These look like:
 *   "SEVERE THUNDERSTORM WATCH 74 REMAINS VALID..."
 *   "IN INDIANA THIS WATCH INCLUDES 27 COUNTIES"
 *   "BARTHOLOMEW    DECATUR    HAMILTON"
 *   "THIS INCLUDES THE CITIES OF..."
 *
 * This format is redundant — the area is already in areaDesc and the
 * headline covers the key info. We skip it entirely for cleaner posts.
 */
function isCountyTableDescription(text: string): boolean {
	if (!text) return false;
	// Matches the opening line of watch/advisory county list bulletins
	return (
		/^(SEVERE THUNDERSTORM|TORNADO|WINTER STORM|BLIZZARD|ICE STORM|FLOOD)\s+(WATCH|WARNING|ADVISORY)\s+\d+/i.test(text.trim()) ||
		/FOR THE FOLLOWING AREAS/i.test(text) ||
		(/THIS WATCH INCLUDES \d+ COUNTI/i.test(text) && /THIS INCLUDES THE CITIES OF/i.test(text))
	);
}

function alertToText(properties: any): string {
	const event      = (properties.event || 'Weather Alert').toUpperCase();
	const areaDesc   = properties.areaDesc || 'Unknown area';
	const severity   = properties.severity || '';
	const headline   = properties.headline
		?? findProperty(properties, 'NWSheadline')
		?? '';

	// Short expiry for the header block
	const expires = properties.expires ? formatDateTimeShort(properties.expires) : null;

	// Clean up description — skip county-table format entirely
	const rawDescription = String(properties.description || '');
	const description = isCountyTableDescription(rawDescription)
		? null
		: formatAlertDescription(rawDescription);

	const instruction = properties.instruction
		? formatAlertDescription(String(properties.instruction))
		: null;

	const lines: string[] = [];

	// ── Header ──────────────────────────────────────────────────────────
	lines.push(event);
	lines.push('');
	lines.push(`Area: ${areaDesc}`);
	if (expires)  lines.push(`Expires: ${expires}`);
	if (severity) lines.push(`Severity: ${severity}`);

	// ── Headline (the human-written NWS one-liner) ───────────────────────
	if (headline) {
		lines.push('');
		lines.push(String(headline));
	}

	// ── NWS description body (skipped for county-table format) ───────────
	if (description) {
		lines.push('');
		lines.push(description);
	}

	// ── Safety instruction ───────────────────────────────────────────────
	if (instruction) {
		lines.push('');
		lines.push(instruction);
	}

	// ── Footer ───────────────────────────────────────────────────────────
	lines.push('');
	lines.push('https://localkynews.com/live-weather-alerts');
	lines.push('');
	lines.push('#weatheralert #weather #alert');

	return lines.join('\n');
}

function severityBadgeColor(severity: string): string {
	const s = severity.toLowerCase();
	if (s === 'extreme')  return '#7b0000';
	if (s === 'severe')   return '#cc0000';
	if (s === 'moderate') return '#e07000';
	if (s === 'minor')    return '#b8a000';
	return '#555';
}

function renderAdminPage(alerts: any[], lastPoll?: string, syncError?: string, appConfig?: FbAppConfig): string {
	const savedAppId = appConfig?.appId ?? '';
	const savedAppSecret = appConfig?.appSecret ? '********' : '';
	// Build post text map keyed by numeric index.
	// We NEVER inject post text into onclick attributes — NWS text contains quotes,
	// apostrophes, and special chars that break HTML attribute parsing. Instead we
	// embed all texts in a JS data object via JSON.stringify (which handles all
	// escaping) and look them up by a simple numeric key from a data-* attribute.
	const postTextMap: Record<string, string> = {};
	const states = new Set<string>();
	const severities = new Set<string>();

	const cards = alerts.map((feature, idx) => {
		const p      = feature.properties ?? {};
		const jsKey  = String(idx);
		const rawId  = String(feature.id ?? '');
		const sev    = String(p.severity ?? '');
		const state  = extractStateCode(feature);
		const searchText = (
			String(p.event ?? '') + ' ' +
			String(p.areaDesc ?? '') + ' ' +
			String(p.headline ?? '') + ' ' +
			String(p.description ?? '')
		).toLowerCase();
		const maxWind = mapSomeValue(findProperty(p, 'maxWindGust') ?? '');
		const maxHailRaw = mapSomeValue(findProperty(p, 'maxHailSize') ?? '');
		const maxHailDisplay = maxHailRaw ? hailDesc(maxHailRaw) : '';

		if (state) states.add(state);
		if (sev) severities.add(sev.toLowerCase());

		// Generate formatted post text and store in map — never interpolated into HTML attrs
		postTextMap[jsKey] = alertToText(p);

		// The post preview shown in the details panel is the exact same text
		// that will appear in the modal and be posted to Facebook
		const previewText = safeHtml(postTextMap[jsKey]);

		const metaRows = [
			'<p><strong>Urgency:</strong> ' + safeHtml(String(p.urgency ?? '')) + '</p>',
			'<p><strong>Certainty:</strong> ' + safeHtml(String(p.certainty ?? '')) + '</p>',
			'<p><strong>Severity:</strong> ' + safeHtml(sev) + '</p>',
			'<p><strong>Effective:</strong> ' + safeHtml(p.effective ? formatDateTime(p.effective) : '\u2014') + '</p>',
			'<p><strong>Expires:</strong> ' + safeHtml(p.expires ? formatDateTime(p.expires) : '\u2014') + '</p>',
			'<p><strong>Onset:</strong> ' + safeHtml(p.onset ? formatDateTime(p.onset) : '\u2014') + '</p>',
			maxWind ? '<p><strong>Max Wind Gust:</strong> ' + safeHtml(maxWind) + '</p>' : '',
			maxHailDisplay ? '<p><strong>Max Hail Size:</strong> ' + safeHtml(maxHailDisplay) + '</p>' : '',
			'<p><strong>NWS URL:</strong> <a href="' + safeHtml(String(p['@id'] ?? rawId)) + '" target="_blank">View on weather.gov</a></p>',
		].filter(Boolean).join('\n        ');

		return (
			'<div class="alert-card sev-' + safeHtml(sev.toLowerCase()) + '" data-state="' + safeHtml(state) + '" data-event="' + safeHtml(String(p.event ?? '')) + '" data-severity="' + safeHtml(sev.toLowerCase()) + '" data-search="' + safeHtml(searchText) + '">\n' +
			'  <div class="card-header">\n' +
			'    <div class="card-title">\n' +
			'      <span class="badge" style="background:' + severityBadgeColor(sev) + '">' + safeHtml(sev.toUpperCase()) + '</span>\n' +
			'      <strong>' + safeHtml(String(p.event ?? 'Alert')) + '</strong>\n' +
			'      <span class="area">' + safeHtml(String(p.areaDesc ?? '')) + '</span>\n' +
			'    </div>\n' +
			'    <div class="card-meta">\n' +
			'      <span>Status: ' + safeHtml(String(p.status ?? '')) + '</span>\n' +
			'      <span>Expires: ' + safeHtml(p.expires ? formatDateTime(p.expires) : '\u2014') + '</span>\n' +
			'    </div>\n' +
			'  </div>\n' +
			'  <details class="card-details">\n' +
			'    <summary>Show details &amp; post preview</summary>\n' +
			'    <div class="details-grid">\n' +
			'      <div class="detail-col">\n' +
			'        ' + metaRows + '\n' +
			'      </div>\n' +
			'      <div class="detail-col">\n' +
			'        <p><strong>Facebook Post Preview:</strong></p>\n' +
			'        <pre class="post-preview">' + previewText + '</pre>\n' +
			'      </div>\n' +
			'    </div>\n' +
			'  </details>\n' +
			'  <div class="card-actions">\n' +
			// data-key is a safe numeric string; data-id is the NWS URN but only read
			// by JS — it is NOT interpolated into JS source code directly.
			'    <button class="btn-preview" data-key="' + jsKey + '" data-id="' + safeHtml(rawId) + '" onclick="openPreview(this)">Preview &amp; Post to Facebook</button>\n' +
			'  </div>\n' +
			'</div>'
		);
	}).join('\n');

	// JSON.stringify fully escapes all characters including quotes, backslashes,
	// and newlines — safe to embed directly in a <script> block.
	const postTextsJs = 'const POST_TEXTS = ' + JSON.stringify(postTextMap) + ';';

	const stateOptions = Array.from(states).sort().map((s) =>
		'<option value="' + safeHtml(s) + '">' + safeHtml(s) + '</option>'
	).join('');

	const severityOptions = Array.from(severities).sort().map((s) =>
		'<option value="' + safeHtml(s) + '">' + safeHtml(s.toUpperCase()) + '</option>'
	).join('');

	const css = [
		'*, *::before, *::after { box-sizing: border-box; }',
		'body { font-family: system-ui, sans-serif; margin: 0; padding: 20px 24px; background: #f4f5f7; color: #1a1a1a; }',
		'h1 { margin: 0 0 4px; font-size: 1.4rem; }',
		'.subtitle { color: #555; margin: 0 0 20px; font-size: 0.9rem; }',
		'.filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 22px; padding: 14px 16px; background: #fff; border-radius: 8px; border: 1px solid #ddd; }',
		'.filter-bar label { font-size: 0.9rem; color: #333; }',
		'.filter-bar input, .filter-bar select { margin-left: 6px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; }',
		'.filter-bar button { padding: 6px 10px; border: 1px solid #bbb; border-radius: 5px; background: #f0f0f0; cursor: pointer; font-size: 0.85rem; }',
		'.filter-bar button:hover { background: #e0e0e0; }',
		'.token-exchange { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 14px; margin-bottom: 22px; }',
		'.token-exchange h2 { margin: 0 0 8px; font-size: 1rem; }',
		'.token-exchange label { display: block; margin: 8px 0; font-size: 0.87rem; }',
		'.token-exchange input { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem; }',
		'.token-exchange button { margin-top: 8px; padding: 7px 14px; font-size: 0.85rem; }',
		'.alerts-list { display: flex; flex-direction: column; gap: 14px; }',
		'.alert-card { background: #fff; border-radius: 8px; border: 1px solid #ddd; border-left: 5px solid #ccc; overflow: hidden; }',
		'.alert-card.sev-severe   { border-left-color: #cc0000; }',
		'.alert-card.sev-extreme  { border-left-color: #7b0000; }',
		'.alert-card.sev-moderate { border-left-color: #e07000; }',
		'.alert-card.sev-minor    { border-left-color: #b8a000; }',
		'.card-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 16px 10px; gap: 12px; flex-wrap: wrap; }',
		'.card-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 0.95rem; }',
		'.badge { color: #fff; font-size: 0.72rem; font-weight: 700; padding: 2px 7px; border-radius: 3px; letter-spacing: 0.04em; }',
		'.area { color: #555; font-size: 0.88rem; }',
		'.card-meta { display: flex; gap: 16px; font-size: 0.82rem; color: #666; white-space: nowrap; }',
		'.card-details { border-top: 1px solid #eee; }',
		'.card-details summary { padding: 8px 16px; cursor: pointer; font-size: 0.85rem; color: #0066cc; user-select: none; }',
		'.card-details summary:hover { background: #f7f7f7; }',
		'.details-grid { display: grid; grid-template-columns: 260px 1fr; gap: 0; padding: 12px 16px 14px; border-top: 1px solid #f0f0f0; }',
		'.detail-col { padding: 0 12px; }',
		'.detail-col:first-child { border-right: 1px solid #eee; padding-left: 0; }',
		'.detail-col p { margin: 4px 0; font-size: 0.85rem; }',
		'.post-preview { font-family: system-ui, sans-serif; font-size: 0.84rem; line-height: 1.65; white-space: pre-wrap; word-break: break-word; background: #f8f9fa; border: 1px solid #e0e0e0; border-radius: 5px; padding: 10px 12px; margin: 4px 0 0; }',
		'.card-actions { padding: 10px 16px; border-top: 1px solid #eee; background: #fafafa; }',
		'.btn-preview { padding: 7px 16px; background: #1877f2; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 0.88rem; font-weight: 600; }',
		'.btn-preview:hover { background: #1565d8; }',
		'.modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; }',
		'.modal-overlay.open { display: flex; }',
		'.modal { background: #fff; border-radius: 10px; width: 640px; max-width: 96vw; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.22); }',
		'.modal-header { padding: 14px 18px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }',
		'.modal-header h2 { margin: 0; font-size: 1rem; }',
		'.modal-close { background: none; border: none; font-size: 1.4rem; cursor: pointer; color: #555; padding: 0 4px; line-height: 1; }',
		'.modal-body { padding: 16px 18px; overflow-y: auto; flex: 1; }',
		'.modal-body label { display: block; font-size: 0.82rem; font-weight: 600; color: #444; margin-bottom: 6px; }',
		'.modal-body textarea { width: 100%; height: 380px; font-family: system-ui, sans-serif; font-size: 0.88rem; line-height: 1.65; padding: 10px; border: 1px solid #ccc; border-radius: 6px; resize: vertical; }',
		'.char-count { font-size: 0.78rem; color: #888; margin-top: 4px; text-align: right; }',
		'.modal-footer { padding: 12px 18px; border-top: 1px solid #eee; display: flex; gap: 10px; justify-content: flex-end; align-items: center; flex-wrap: wrap; }',
		'.btn-cancel { padding: 7px 16px; background: #f0f0f0; border: 1px solid #bbb; border-radius: 5px; cursor: pointer; font-size: 0.88rem; }',
		'.btn-post { padding: 7px 18px; background: #1877f2; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 0.88rem; font-weight: 600; }',
		'.btn-post:hover { background: #1565d8; }',
		'.btn-post:disabled { background: #94b8f5; cursor: not-allowed; }',
		'.post-status { font-size: 0.84rem; padding: 6px 10px; border-radius: 4px; display: none; flex: 1; min-width: 0; }',
		'.post-status.ok  { background: #e6f4ea; color: #1a7f37; display: block; }',
		'.post-status.err { background: #fce8e8; color: #b30000; display: block; }',
    '.thread-indicator { font-size: 0.82rem; padding: 7px 10px; border-radius: 5px; margin-bottom: 10px; min-height: 28px; }',
    '.thread-indicator.checking { background: #f0f0f0; color: #666; }',
    '.thread-indicator.is-new { background: #e8f4e8; color: #1a6b1a; }',
    '.thread-indicator.is-comment { background: #e8f0fb; color: #1a3a7a; }',
    '.btn-force-new { margin-left: 10px; font-size: 0.78rem; padding: 2px 8px; border: 1px solid #aac; border-radius: 4px; background: #fff; cursor: pointer; color: #445; }',
    '.sync-error { background: #fff8e1; color: #7a5a00; border: 1px solid #ffe082; border-radius: 5px; padding: 6px 12px; font-size: 0.84rem; margin-bottom: 12px; }',
	].join('\n');

	const js = postTextsJs + `
let currentAlertId = null;
let currentThreadAction = 'new_post'; // 'new_post' | 'comment'
let currentPostId = null;
let currentImageUrl = null;

const STATE_CODE_TO_NAME = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri',
  MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new-hampshire', NJ: 'new-jersey',
  NM: 'new-mexico', NY: 'new-york', NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina',
  SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming',
  DC: 'district-of-columbia'
};

function stateCodeToName(code) {
  const c = String(code || '').toUpperCase();
  return STATE_CODE_TO_NAME[c] || '';
}

function alertImageCategory(event) {
  const e = String(event || '').toLowerCase();
  const compact = normalizeEventSlugClient(e).replace(/-/g, '');
  if (e.includes('advisory') || /advi-?ory/.test(e) || compact.includes('advisory')) return 'advisory';
  if (e.includes('outlook') || /outl?ook/.test(e) || compact.includes('outlook')) return 'outlook';
  if (e.includes('warning') || /warnin?g/.test(e) || compact.includes('warning')) return 'warning';
  if (e.includes('watch') || /watc?h/.test(e) || compact.includes('watch')) return 'watch';
  return 'other';
}

function slugify(text) {
  return String(text || '').toLowerCase().trim().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function expandEventSlugs(eventSlug) {
  const variants = new Set();
  const s = String(eventSlug || '').trim().toLowerCase();
  if (!s) return [];
  variants.add(s);

  const accelerants = ['watch', 'warning', 'advisory', 'statement', 'outlook'];
  for (const suffix of accelerants) {
    if (s.endsWith(suffix) && !s.endsWith('-' + suffix)) {
      const base = s.slice(0, -suffix.length);
      if (base) variants.add(base + '-' + suffix);
    }
  }

  if (s.includes('-')) {
    variants.add(s.replace(/-/g, ''));
  } else {
    variants.add(s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
  }

  return Array.from(variants);
}

function normalizeEventSlugClient(raw) {
  let slug = slugify(raw);
  if (!slug) return '';
  slug = slug.replace(/advi-?ory/g, 'advisory');
  slug = slug.replace(/warnin?g?/g, 'warning');
  slug = slug.replace(/floodwatch/g, 'flood-watch');
  slug = slug.replace(/high-?surf/g, 'high-surf');
  slug = slug.replace(/windadvi-?ory/g, 'wind-advisory');
  return slug;
}

function getEventSlugVariants(event, eventSlug) {
  const slugs = new Set();
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
  if (/\\bspecial\\s+weather\\s+statement\\b/.test(normalizedEvent)) {
    slugs.add('special-weather-statement');
    slugs.add('specialweatherstatement');
  }

  return Array.from(slugs);
}

function getImageCandidates(state, event) {
  const stateSlug = slugify(state);
  const eventSlug = normalizeEventSlugClient(event);
  const category = slugify(alertImageCategory(event));
  const eventSlugs = getEventSlugVariants(event, eventSlug);

  const list = [];
  if (stateSlug) {
    for (const slug of eventSlugs) {
      if (!slug) continue;
      list.push('/images/' + stateSlug + '/' + slug + '-' + stateSlug + '.jpg');
    }
    if (category) {
      list.push('/images/' + stateSlug + '/' + category + '-' + stateSlug + '.jpg');
    }
  }

  if (category) {
    for (const slug of eventSlugs) {
      if (!slug) continue;
      list.push('/images/' + category + '/' + slug + '-' + category + '.jpg');
    }
    if (stateSlug) {
      list.push('/images/' + category + '/weather-' + category + '-' + stateSlug + '.jpg');
      list.push('/images/' + category + '/' + category + '-' + stateSlug + '.jpg');
    }
    list.push('/images/' + category + '/' + category + '.jpg');
  }

  for (const slug of eventSlugs) {
    if (!slug) continue;
    list.push('/images/' + slug + '.jpg');
  }

  const candidates = Array.from(new Set(list));
  for (const path of list) {
    if (path.startsWith('/images/')) {
      candidates.push(path.replace('/images', ''));
    }
  }
  return candidates;
}

async function findPreviewImageUrl(state, event) {
  const candidates = getImageCandidates(state, event);
  for (const relative of candidates) {
    try {
      const url = new URL(relative, window.location.origin).toString();
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
      if (res.status === 404 || res.status === 410) continue;
      if (res.status === 405 || res.status === 501) {
        const getRes = await fetch(url, { method: 'GET' });
        if (getRes.ok) return url;
      }
    } catch {
      // ignore and try next
    }
  }
  return null;
}

async function setPreviewImage(state, event) {
  const img = document.getElementById('fbPreviewImage');
  const area = document.getElementById('fbPreviewImageArea');
  if (!img || !area) return;
  img.removeAttribute('src');
  area.style.display = 'none';
  currentImageUrl = null;
  const candidate = await findPreviewImageUrl(state, event);
  if (candidate) {
    img.src = candidate;
    area.style.display = 'block';
    currentImageUrl = candidate;
  }
}

async function openPreview(btn) {
  const key = btn.getAttribute('data-key');
  currentAlertId = btn.getAttribute('data-id');
  currentThreadAction = 'new_post';
  currentPostId = null;

  const alertCard = btn.closest('.alert-card');
  const cardState = alertCard?.getAttribute('data-state') || '';
  const cardEvent = alertCard?.getAttribute('data-event') || '';
  const stateFolder = stateCodeToName(cardState) || cardState.toLowerCase();
  setPreviewImage(stateFolder, cardEvent);

  document.getElementById('fbText').value = POST_TEXTS[key] || '';
  document.getElementById('postStatus').className = 'post-status';
  document.getElementById('postStatus').textContent = '';
  const postBtn = document.getElementById('btnPost');
  postBtn.disabled = false;
  postBtn.textContent = 'Post to Facebook';
  updateCharCount();

  // Show modal immediately — thread check updates the header async
  setThreadIndicator('checking', null);
  document.getElementById('fbModal').classList.add('open');

  // Check for existing thread
  try {
    const res = await fetch('/admin/thread-check?alertId=' + encodeURIComponent(currentAlertId || ''));
    const data = await res.json();
    if (data.action === 'comment' && data.threadInfo) {
      currentThreadAction = 'comment';
      currentPostId = data.postId;
      setThreadIndicator('comment', data.threadInfo);
      // Button text is set inside setThreadIndicator based on updateCount
    } else {
      currentThreadAction = 'new_post';
      setThreadIndicator('new_post', null);
      postBtn.textContent = 'Post to Facebook';
    }
  } catch (e) {
    // Thread check failed — default to new post
    currentThreadAction = 'new_post';
    setThreadIndicator('new_post', null);
  }
}

function setThreadIndicator(state, threadInfo) {
  const el = document.getElementById('threadIndicator');
  const postBtn = document.getElementById('btnPost');
  if (state === 'checking') {
    el.className = 'thread-indicator checking';
    el.textContent = 'Checking for existing thread...';
  } else if (state === 'comment' && threadInfo) {
    const updateCount = threadInfo.updateCount ?? 0;
    const remaining = 3 - updateCount;
    const atLimit = remaining <= 0;
    el.className = 'thread-indicator is-comment';
    const countLabel = atLimit
      ? '<strong>Chain limit reached</strong> — will create a new post'
      : '&#128172; <strong>Adding comment</strong> to existing thread (' + remaining + ' update' + (remaining === 1 ? '' : 's') + ' before chain break)';
    el.innerHTML = countLabel + ' &mdash; ' + escHtml(threadInfo.alertType) +
      ' &mdash; Post: <a href="https://www.facebook.com/' + escHtml(threadInfo.postId) + '" target="_blank">' +
      escHtml(threadInfo.postId) + '</a>' +
      ' <button class="btn-force-new" onclick="forceNewPost()">Force new post instead</button>';
    postBtn.textContent = atLimit ? 'Post (New Thread)' : 'Post Comment';
  } else {
    el.className = 'thread-indicator is-new';
    el.textContent = 'Creating new Facebook post';
  }
}

function forceNewPost() {
  currentThreadAction = 'new_post';
  currentPostId = null;
  setThreadIndicator('new_post', null);
  document.getElementById('btnPost').textContent = 'Post to Facebook';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function closeModal() {
  document.getElementById('fbModal').classList.remove('open');
  currentAlertId = null;
  currentThreadAction = 'new_post';
  currentPostId = null;
  currentImageUrl = null;
}

function updateCharCount() {
  document.getElementById('charCount').textContent =
    document.getElementById('fbText').value.length.toLocaleString();
}

async function submitPost() {
  const message = document.getElementById('fbText').value.trim();
  if (!message) return;
  const btn = document.getElementById('btnPost');
  const status = document.getElementById('postStatus');
  btn.disabled = true;
  btn.textContent = currentThreadAction === 'comment' ? 'Posting comment...' : 'Posting...';
  status.className = 'post-status';
  status.textContent = '';
  try {
    const body = new URLSearchParams({
      action: 'post_alert',
      alertId: currentAlertId || '',
      customMessage: message,
      threadAction: currentThreadAction,
    });
    if (currentImageUrl) body.set('imageUrl', currentImageUrl);
    const res = await fetch('/admin/post', { method: 'POST', body });
    const data = await res.json();
    const result = data.results && data.results[0];
    if (result && (result.status === 'posted' || result.status === 'commented')) {
      status.className = 'post-status ok';
      const chainMsg = result.chainBreak ? ' (new thread started)' : '';
      status.textContent = result.status === 'commented'
        ? 'Comment posted successfully!'
        : 'Posted successfully to Facebook!' + chainMsg;
      btn.textContent = result.status === 'commented' ? 'Commented ✓' : 'Posted ✓';
      // Update thread indicator to reflect new state after posting
      if (result.status === 'posted' && result.postId) {
        currentPostId = result.postId;
        currentThreadAction = 'comment';
        setThreadIndicator('comment', { alertType: 'this alert', postId: result.postId, updateCount: 0 });
      } else if (result.status === 'commented' && result.postId) {
        currentPostId = result.postId;
        currentThreadAction = 'comment';
        setThreadIndicator('comment', { alertType: 'this alert', postId: result.postId, updateCount: result.updateCount ?? 0 });
      }
    } else {
      throw new Error((result && result.error) || 'Unknown error');
    }
  } catch (err) {
    status.className = 'post-status err';
    status.textContent = 'Error: ' + err.message;
    btn.disabled = false;
    btn.textContent = currentThreadAction === 'comment' ? 'Post Comment' : 'Post to Facebook';
  }
}

document.getElementById('fbModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function applyFilters() {
  const search = (document.getElementById('filterSearch').value || '').trim().toLowerCase();
  const state = (document.getElementById('filterState').value || 'all').toLowerCase();
  const severity = (document.getElementById('filterSeverity').value || 'all').toLowerCase();

  document.querySelectorAll('.alert-card').forEach((card) => {
    const cardState = (card.getAttribute('data-state') || '').toLowerCase();
    const cardSeverity = (card.getAttribute('data-severity') || '').toLowerCase();
    const cardSearch = (card.getAttribute('data-search') || '').toLowerCase();

    const matchesState = state === 'all' || (!state && !cardState) || cardState === state;
    const matchesSeverity = severity === 'all' || (!severity && !cardSeverity) || cardSeverity === severity;
    const matchesSearch = !search || cardSearch.includes(search);

    card.style.display = (matchesState && matchesSeverity && matchesSearch) ? '' : 'none';
  });
}

function clearFilters() {
  document.getElementById('filterSearch').value = '';
  document.getElementById('filterState').value = 'all';
  document.getElementById('filterSeverity').value = 'all';
  applyFilters();
}

const filterSearchInput = document.getElementById('filterSearch');
const filterStateSelect = document.getElementById('filterState');
const filterSeveritySelect = document.getElementById('filterSeverity');
const clearFiltersBtn = document.getElementById('clearFilters');

if (filterSearchInput) filterSearchInput.addEventListener('input', applyFilters);
if (filterStateSelect) filterStateSelect.addEventListener('change', applyFilters);
if (filterSeveritySelect) filterSeveritySelect.addEventListener('change', applyFilters);
if (clearFiltersBtn) clearFiltersBtn.addEventListener('click', clearFilters);

const btnTokenExchange = document.getElementById('btnTokenExchange');
if (btnTokenExchange) {
  btnTokenExchange.addEventListener('click', async function() {
    const appId = (document.getElementById('tokenAppId') || { value: '' }).value.trim();
    const appSecret = (document.getElementById('tokenAppSecret') || { value: '' }).value.trim();
    const userToken = (document.getElementById('tokenUserToken') || { value: '' }).value.trim();
    const resultEl = document.getElementById('tokenResult');
    if (!resultEl) return;

    if (!appId || !appSecret || !userToken) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'All fields (App ID, App Secret, User Token) are required';
      return;
    }

    resultEl.style.color = '#333';
    resultEl.textContent = 'Exchanging token...';

    try {
      const response = await fetch('/admin/token-exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret, userToken }),
      });
      const data = await response.json();
      if (response.ok && data.access_token) {
        resultEl.style.color = '#1a7f37';
        resultEl.textContent = 'Long-lived token: ' + data.access_token;
      } else {
        resultEl.style.color = '#b30000';
        resultEl.textContent = 'Error exchanging token: ' + (data.error || 'Unknown');
      }
    } catch (err) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'Request failed: ' + err;
    }
  });
}

const btnSaveAppConfig = document.getElementById('btnSaveAppConfig');
if (btnSaveAppConfig) {
  btnSaveAppConfig.addEventListener('click', async function() {
    const appId = (document.getElementById('tokenAppId') || { value: '' }).value.trim();
    const appSecret = (document.getElementById('tokenAppSecret') || { value: '' }).value.trim();
    const resultEl = document.getElementById('tokenResult');
    if (!resultEl) return;

    if (!appId || !appSecret) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'App ID and App Secret are required to save';
      return;
    }

    resultEl.style.color = '#333';
    resultEl.textContent = 'Saving app credentials...';

    try {
      const response = await fetch('/admin/token-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret }),
      });
      const data = await response.json();
      if (response.ok) {
        resultEl.style.color = '#1a7f37';
        resultEl.textContent = 'App credentials saved successfully. Secret is stored but not displayed.';
        const secretInput = document.getElementById('tokenAppSecret');
        if (secretInput) secretInput.value = '********';
      } else {
        resultEl.style.color = '#b30000';
        resultEl.textContent = 'Error saving app credentials: ' + (data.error || 'Unknown');
      }
    } catch (err) {
      resultEl.style.color = '#b30000';
      resultEl.textContent = 'Request failed: ' + err;
    }
  });
}

applyFilters();
`

	return (
		'<!DOCTYPE html>\n' +
		'<html lang="en">\n' +
		'<head>\n' +
		'<meta charset="UTF-8" />\n' +
		'<title>Live Weather Alerts Admin</title>\n' +
		'<style>\n' + css + '\n</style>\n' +
		'</head>\n' +
		'<body>\n' +
		'<h1>Live Weather Alerts Admin</h1>\n' +
		'<p class="subtitle">Active alerts from <a href="https://api.weather.gov/alerts/active" target="_blank">NWS Active Alerts</a>. ' +
    (lastPoll ? 'Last synced: ' + formatLastSynced(lastPoll) + '. ' : '') +
    'Click "Preview &amp; Post" to review and edit before posting.</p>\n' +
    (syncError ? '<p class="sync-error">&#9888; Sync warning: ' + safeHtml(syncError) + '</p>\n' : '') +
		'\n<div class="filter-bar">\n' +
		'  <label>Search: <input id="filterSearch" type="search" placeholder="Search event, area, headline" /></label>\n' +
		'  <label>State: <select id="filterState"><option value="all">All</option>' + stateOptions + '</select></label>\n' +
		'  <label>Severity: <select id="filterSeverity"><option value="all">All</option>' + severityOptions + '</select></label>\n' +
		'  <button type="button" id="clearFilters">Clear</button>\n' +
		'</div>\n' +
		'\n<div class="token-exchange">\n' +
		'  <h2>Convert short-lived user token to long-lived token</h2>\n' +
		'  <p>Enter Facebook App ID, App Secret, and a user access token to generate a long-lived token.</p>\n' +
		'  <label>App ID: <input id="tokenAppId" type="text" value="' + safeHtml(savedAppId) + '" style="width:100%;max-width:480px" /></label>\n' +
		'  <label>App Secret: <input id="tokenAppSecret" type="text" value="' + safeHtml(savedAppSecret) + '" style="width:100%;max-width:480px" /></label>\n' +
		'  <label>User Access Token: <input id="tokenUserToken" type="text" style="width:100%;max-width:480px" /></label>\n' +
		'  <button type="button" id="btnSaveAppConfig">Save app ID/secret</button>\n' +
		'  <button type="button" id="btnTokenExchange">Convert token</button>\n' +
		'  <div id="tokenResult" style="margin-top:10px;color:#333;"></div>\n' +
		'</div>\n' +
		'\n<div class="alerts-list">\n' + cards + '\n</div>\n' +
		'\n<div class="modal-overlay" id="fbModal">\n' +
		'  <div class="modal">\n' +
		'    <div class="modal-header">\n' +
		'      <h2>Preview Facebook Post</h2>\n' +
		'      <button class="modal-close" onclick="closeModal()" title="Close">&#x2715;</button>\n' +
		'    </div>\n' +
		'    <div class="modal-body">\n' +
		'      <div id="threadIndicator" class="thread-indicator"></div>\n' +
		'      <div id="fbPreviewImageArea" style="display:none; margin-bottom:12px;">\n' +
		'        <p style="margin:0 0 6px; font-weight:600;">Image preview</p>\n' +
		'        <img id="fbPreviewImage" alt="Alert image preview" style="width:100%; height:260px; object-fit:contain; object-position:center; border:1px solid #ddd; border-radius:6px; background:#111;" />\n' +
		'      </div>\n' +
		'      <label for="fbText">Edit post text before publishing:</label>\n' +
		'      <textarea id="fbText" oninput="updateCharCount()"></textarea>\n' +
		'      <div class="char-count"><span id="charCount">0</span> characters</div>\n' +
		'    </div>\n' +
		'    <div class="modal-footer">\n' +
		'      <div class="post-status" id="postStatus"></div>\n' +
		'      <button class="btn-cancel" onclick="closeModal()">Cancel</button>\n' +
		'      <button class="btn-post" id="btnPost" onclick="submitPost()">Post to Facebook</button>\n' +
		'    </div>\n' +
		'  </div>\n' +
		'</div>\n' +
		'\n<script>\n' + js + '\n</script>\n' +
		'</body>\n</html>'
	);
}

function renderLoginPage(errorMessage?: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Admin Login - Live Weather Alerts</title>
<style>
body { font-family: system-ui, sans-serif; margin: 24px; }
.container { max-width: 420px; margin: auto; background: #fff; border-radius: 8px; border:1px solid #ddd; padding: 22px; }
input[type=password], button { width: 100%; padding: 10px; margin-top: 8px; font-size: 16px; }
button { background: #0077cc; border: 0; color: #fff; cursor: pointer; }
.error { color: #b30000; }
</style>
</head>
<body>
<div class="container">
<h2>Admin Login</h2>
${errorMessage ? `<p class="error">${safeHtml(errorMessage)}</p>` : ''}
<form method="post" action="/admin/login">
	<label>Password</label>
	<input type="password" name="password" required />
	<button type="submit">Enter</button>
</form>
</div>
</body>
</html>`;
}

const FB_TIMEOUT_MS = 15_000;

// AbortSignal.timeout() is the correct CF Workers API — setTimeout is not available
// in module Workers and throws a runtime error.
function fbAbortSignal(): AbortSignal {
	return AbortSignal.timeout(FB_TIMEOUT_MS);
}

async function urlExists(url: string): Promise<boolean> {
	try {
		let res = await fetch(url, { method: 'HEAD' });
		if (res.ok) return true;
		if (res.status === 405 || res.status === 501) {
			res = await fetch(url, { method: 'GET' });
			return res.ok;
		}
	} catch {
		// ignore network errors; treat as missing
	}
	return false;
}

function getAlertImageCandidates(state: string, event: string): string[] {
	const stateSlug = slugify(state);
	const eventSlug = normalizeEventSlug(event);
	const category = slugify(alertImageCategory(event));
	const eventSlugs = getEventSlugVariants(event, eventSlug);

	const list: string[] = [];
	if (stateSlug) {
		for (const slug of eventSlugs) {
			if (!slug) continue;
			list.push('/images/' + stateSlug + '/' + slug + '-' + stateSlug + '.jpg');
		}
		if (category) {
			list.push('/images/' + stateSlug + '/' + category + '-' + stateSlug + '.jpg');
		}
	}

	if (category) {
		for (const slug of eventSlugs) {
			if (!slug) continue;
			list.push('/images/' + category + '/' + slug + '-' + category + '.jpg');
		}
		if (stateSlug) {
			list.push('/images/' + category + '/weather-' + category + '-' + stateSlug + '.jpg');
			list.push('/images/' + category + '/' + category + '-' + stateSlug + '.jpg');
		}
		list.push('/images/' + category + '/' + category + '.jpg');
	}

	for (const slug of eventSlugs) {
		if (!slug) continue;
		list.push('/images/' + slug + '.jpg');
	}

	const candidates = Array.from(new Set(list));
	for (const path of list) {
		if (path.startsWith('/images/')) {
			candidates.push(path.replace('/images', ''));
		}
	}
	return candidates;
}

async function findAlertImageUrl(env: Env, request: Request, feature: any): Promise<string | null> {
	const base = env.FB_IMAGE_BASE_URL?.trim().replace(/\/$/, '') || new URL(request.url).origin;
	const event = String(feature?.properties?.event || '');
	const stateCode = extractStateCode(feature);
	const stateName = stateCodeToName(stateCode);
	const candidates = getAlertImageCandidates(stateName, event);

	for (const candidate of candidates) {
		const candidateUrl = new URL(candidate, base).toString();
		if (await urlExists(candidateUrl)) {
			return candidateUrl;
		}
	}
	return null;
}

async function postPhotoToFacebook(env: Env, message: string, imageUrl: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/photos`;
	const body = new URLSearchParams({ url: imageUrl, caption: message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook photo API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook photo post succeeded but returned no post ID');
	return data.id;
}

/** Create a new post on the Facebook page. Returns the post ID string. */
async function postToFacebook(env: Env, message: string, imageUrl?: string): Promise<string> {
	if (imageUrl) {
		try {
			return await postPhotoToFacebook(env, message, imageUrl);
		} catch (err) {
			// If image post fails, fallback to text-only feed post.
			console.error('Image post failed, falling back to feed:', String(err));
		}
	}
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	if (!data.id) throw new Error('Facebook post succeeded but returned no post ID');
	return data.id;
}

/** Post a comment on an existing Facebook post. */
async function commentOnFacebook(env: Env, postId: string, message: string): Promise<string> {
	if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
		throw new Error('Facebook credentials not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN)');
	}
	const url = `${FB_GRAPH_API}/${encodeURIComponent(postId)}/comments`;
	const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });
	const res = await fetch(url, { method: 'POST', body, signal: fbAbortSignal() });
	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`Facebook comment API error ${res.status}: ${errText}`);
	}
	const data = await res.json() as { id?: string };
	return data.id ?? '';
}

async function exchangeFacebookToken(appId: string, appSecret: string, userToken: string): Promise<string> {
	const url = `${FB_GRAPH_API}/oauth/access_token?grant_type=fb_exchange_token` +
		`&client_id=${encodeURIComponent(appId)}` +
		`&client_secret=${encodeURIComponent(appSecret)}` +
		`&fb_exchange_token=${encodeURIComponent(userToken)}`;
	const res = await fetch(url, { method: 'GET', signal: fbAbortSignal() });
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`Facebook token exchange API error ${res.status}: ${text}`);
	}
	const data = JSON.parse(text);
	if (!data.access_token) {
		throw new Error(`Unexpected response from Facebook token exchange: ${text}`);
	}
	return data.access_token;
}

async function handleTokenExchange(request: Request, env: Env): Promise<Response> {
	if (!isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const form = await parseRequestBody(request);
	const appId = (form.get('appId') || '').trim();
	const appSecret = (form.get('appSecret') || '').trim();
	const userToken = (form.get('userToken') || '').trim();
	if (!appId || !appSecret || !userToken) {
		return new Response(JSON.stringify({ error: 'appId, appSecret, and userToken are required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	try {
		const longLivedToken = await exchangeFacebookToken(appId, appSecret, userToken);
		return new Response(JSON.stringify({ access_token: longLivedToken }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		return new Response(JSON.stringify({ error: String(err) }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

async function handleTokenConfig(request: Request, env: Env): Promise<Response> {
	if (!isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const form = await parseRequestBody(request);
	const appId = (form.get('appId') || '').trim();
	const appSecret = (form.get('appSecret') || '').trim();
	if (!appId || !appSecret) {
		return new Response(JSON.stringify({ error: 'appId and appSecret are required' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	await writeFbAppConfig(env, { appId, appSecret });
	return new Response(JSON.stringify({ success: true }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}


// ---------------------------------------------------------------------------
// NWS polling — incremental, ETag-aware
// ---------------------------------------------------------------------------

/**
 * Read the current alert map from KV.
 * Returns a Record<alertId, feature> so we can merge/dedupe by ID cheaply.
 */
async function readAlertMap(env: Env): Promise<Record<string, any>> {
	const raw = await env.WEATHER_KV.get(KV_ALERT_MAP);
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, any>;
	} catch {
		return {};
	}
}

/**
 * Write the alert map back to KV.
 * No TTL — the cron manages freshness by pruning expired alerts itself.
 */
async function writeAlertMap(env: Env, map: Record<string, any>): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_MAP, JSON.stringify(map));
}

/**
 * Remove alerts whose `expires` timestamp is in the past.
 */
function pruneExpired(map: Record<string, any>): Record<string, any> {
	const now = Date.now();
	const pruned: Record<string, any> = {};
	for (const [id, feature] of Object.entries(map)) {
		const expires = feature?.properties?.expires ?? feature?.properties?.ends;
		if (expires) {
			const ms = new Date(expires).getTime();
			if (!Number.isNaN(ms) && ms < now) continue; // expired — drop it
		}
		pruned[id] = feature;
	}
	return pruned;
}

/**
 * Poll NWS using an ETag for conditional GET.
 *
 * Returns:
 *   { changed: false }                      — 304, nothing to do
 *   { changed: true, features, etag }        — 200, new full active list
 *   { changed: false, error: string }        — network/API error
 */
async function pollNWS(env: Env): Promise<
	| { changed: false; error?: string }
	| { changed: true; features: any[]; etag: string }
> {
	const storedEtag = await env.WEATHER_KV.get(KV_ETAG);

	const headers: Record<string, string> = {
		'User-Agent': NWS_USER_AGENT,
		'Accept': 'application/geo+json',
	};
	if (storedEtag) {
		headers['If-None-Match'] = storedEtag;
	}

	let res: Response;
	try {
		res = await fetch(WEATHER_API, { headers });
	} catch (err) {
		return { changed: false, error: `Network error: ${String(err)}` };
	}

	// 304 — nothing changed since last poll
	if (res.status === 304) {
		return { changed: false };
	}

	if (!res.ok) {
		return { changed: false, error: `NWS API error: ${res.status} ${res.statusText}` };
	}

	let data: any;
	try {
		data = await res.json();
	} catch (err) {
		return { changed: false, error: `JSON parse error: ${String(err)}` };
	}

	const features = Array.isArray(data?.features) ? data.features : [];
	const etag = res.headers.get('ETag') ?? String(Date.now());

	return { changed: true, features, etag };
}

/**
 * Core sync logic used by both the cron trigger and the admin page's
 * manual refresh. Returns the up-to-date alert map.
 *
 * Strategy:
 *   1. Conditional GET with If-None-Match
 *   2. 304 → prune expired from existing map, done
 *   3. 200 → build a fresh map from the full active list NWS returned
 *            (NWS /alerts/active is the authoritative current state —
 *             no need to merge, just replace and prune)
 *   4. Store new ETag + last-poll timestamp
 */
async function syncAlerts(env: Env): Promise<{ map: Record<string, any>; error?: string }> {
	const result = await pollNWS(env);

	if (!result.changed) {
		// Either 304 or a transient error — return what we have in KV
		const map = pruneExpired(await readAlertMap(env));
		await writeAlertMap(env, map);
		return { map, error: (result as any).error };
	}

	// 200 — NWS returned the full current active set. Build map keyed by alert ID.
	const map: Record<string, any> = {};
	for (const feature of result.features) {
		const id = String(feature?.id ?? feature?.properties?.id ?? '');
		if (id) map[id] = feature;
	}

	// Prune any that are already expired (NWS occasionally includes them briefly)
	const pruned = pruneExpired(map);

	// Persist everything atomically
	await Promise.all([
		writeAlertMap(env, pruned),
		env.WEATHER_KV.put(KV_ETAG, result.etag),
		env.WEATHER_KV.put(KV_LAST_POLL, new Date().toISOString()),
	]);

	return { map: pruned };
}

async function parseRequestBody(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get('Content-Type') || request.headers.get('content-type');
	if (contentType?.includes('application/json')) {
		const json = await request.json();
		return new URLSearchParams(Object.entries(json as Record<string, any>).map(([k, v]) => [k, String(v ?? '')]));
	}
	const text = await request.text();
	return new URLSearchParams(text);
}

async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
	const form = await parseRequestBody(request);
	const password = form.get('password') || '';
	const expected = env.ADMIN_PASSWORD || 'liveweather';
	if (password !== expected) {
		return new Response(renderLoginPage('Invalid password'), {
			status: 401,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}
	const headers = new Headers({ 'Location': '/admin' });
	headers.append('Set-Cookie', `admin_session=${encodeURIComponent(authToken(expected))}; Path=/; HttpOnly; Max-Age=3600`);
	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// Request handlers (updated to use KV cache instead of live NWS fetch)
// ---------------------------------------------------------------------------

async function handlePublicAlertsPage(env: Env): Promise<Response> {
	// Keep this page fresh while still using the same ETag-aware sync path
	// as admin and cron. If NWS has no changes, this is very cheap.
	const { map, error } = await syncAlerts(env);
	const alerts = Object.values(map);
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const page = renderPublicAlertsPage(alerts, lastPoll ?? undefined, error, {
		classifyAlert,
		severityBadgeColor,
		formatDateTime,
		formatAlertDescription,
		formatLastSynced,
		safeHtml,
		nl2br,
		extractStateCode,
		stateCodeToName,
	});
	return new Response(page, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

function apiCorsHeaders(origin?: string | null): Headers {
	const allowedOrigin = origin === 'https://liveweatheralerts.com' ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

function pushCorsHeaders(origin?: string | null): Headers {
	const allowedOrigin = origin === 'https://liveweatheralerts.com' ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

async function handlePushPublicKey(env: Env): Promise<Response> {
	const vapid = getVapidKeys(env);
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');
	if (!vapid) {
		return new Response(JSON.stringify({
			error: 'Push notifications are not configured on the server.',
		}), { status: 503, headers });
	}
	return new Response(JSON.stringify({
		publicKey: vapid.publicKey,
	}), { status: 200, headers });
}

async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const vapid = getVapidKeys(env);
	if (!vapid) {
		return new Response(JSON.stringify({
			error: 'Push notifications are not configured on the server.',
		}), { status: 503, headers });
	}

	let body: any;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers });
	}

	const stateCode = normalizeStateCode(body?.stateCode || body?.state);
	if (!stateCode) {
		return new Response(JSON.stringify({ error: 'A valid US state code is required.' }), { status: 400, headers });
	}

	const subscription = body?.subscription as WebPushSubscription;
	if (!isValidPushSubscription(subscription)) {
		return new Response(JSON.stringify({ error: 'Invalid push subscription payload.' }), { status: 400, headers });
	}

	const prefs = body?.prefs;
	const record = await upsertPushSubscriptionRecord(
		env,
		subscription,
		stateCode,
		request.headers.get('user-agent') || undefined,
		prefs,
	);

	return new Response(JSON.stringify({
		ok: true,
		stateCode: record.stateCode,
		subscriptionId: record.id,
	}), { status: 200, headers });
}

async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
	const headers = pushCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	let body: any;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers });
	}

	const endpoint = String(
		body?.endpoint
		|| body?.subscription?.endpoint
		|| ''
	).trim();
	if (!endpoint) {
		return new Response(JSON.stringify({ error: 'Subscription endpoint is required.' }), { status: 400, headers });
	}

	const removed = await removePushSubscriptionByEndpoint(env, endpoint);
	return new Response(JSON.stringify({ ok: true, removed }), { status: 200, headers });
}

async function handleApiAlerts(env: Env): Promise<Response> {
	const { map, error } = await syncAlerts(env);
	const alerts = Object.values(map).map((feature: any) => {
		const p = feature?.properties ?? {};
		const id = String(feature?.id ?? p.id ?? '');
		return {
			id,
			stateCode: extractStateCode(feature),
			event: String(p.event ?? ''),
			areaDesc: String(p.areaDesc ?? ''),
			severity: String(p.severity ?? ''),
			status: String(p.status ?? ''),
			urgency: String(p.urgency ?? ''),
			certainty: String(p.certainty ?? ''),
			headline: String(p.headline ?? ''),
			description: String(p.description ?? ''),
			instruction: String(p.instruction ?? ''),
			sent: String(p.sent ?? ''),
			effective: String(p.effective ?? ''),
			onset: String(p.onset ?? ''),
			expires: String(p.expires ?? ''),
			updated: String(p.updated ?? ''),
			nwsUrl: String(p['@id'] ?? ''),
			ugc: Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [],
		};
	});
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};
	return new Response(JSON.stringify({
		alerts,
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
	}), {
		status: 200,
		headers,
	});
}

async function lookupCountyByLatLon(lat: number, lon: number): Promise<{ county?: string; countyCode?: string }> {
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

async function geocodePlaceQuery(query: string): Promise<SavedLocation> {
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
	const label = city && state ? `${city}, ${state}` : (state || query);

	return {
		lat,
		lon,
		city,
		state: state || undefined,
		county,
		countyCode,
		label,
	};
}

async function geocodeZip(zip: string): Promise<SavedLocation> {
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

	return {
		lat,
		lon,
		city,
		state,
		zip,
		county: county.county,
		countyCode: county.countyCode,
		label,
	};
}

async function reverseGeocodePoint(lat: number, lon: number): Promise<SavedLocation> {
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

	return {
		lat,
		lon,
		city,
		state,
		county: county.county,
		countyCode: county.countyCode,
		label,
	};
}

function parseCoordinate(raw: string, min: number, max: number, fieldLabel: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new HttpError(400, `${fieldLabel} is invalid.`);
	}
	return value;
}

function parseLatLonForWeather(request: Request): { lat: number; lon: number } {
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

async function fetchNwsJson(url: string, label: string): Promise<any> {
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

function measurementValue(measurement: any): number | null {
	const value = Number(measurement?.value);
	return Number.isFinite(value) ? value : null;
}

function unitCode(measurement: any): string {
	return String(measurement?.unitCode || '').toLowerCase();
}

function firstFinite(...values: Array<number | null | undefined>): number | null {
	for (const value of values) {
		if (Number.isFinite(value as number)) return Number(value);
	}
	return null;
}

function roundTo(value: number | null, decimals: number): number | null {
	if (!Number.isFinite(value as number)) return null;
	const factor = Math.pow(10, decimals);
	return Math.round((value as number) * factor) / factor;
}

function celsiusToFahrenheit(value: number): number {
	return (value * 9) / 5 + 32;
}

function kmhToMph(value: number): number {
	return value * 0.621371;
}

function mpsToMph(value: number): number {
	return value * 2.236936;
}

function knotsToMph(value: number): number {
	return value * 1.15078;
}

function metersToMiles(value: number): number {
	return value * 0.000621371;
}

function pascalsToInHg(value: number): number {
	return value * 0.0002952998751;
}

function toTemperatureF(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('degf')) return value;
	if (unit.includes('degc')) return celsiusToFahrenheit(value);
	return value;
}

function toSpeedMph(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('mi_h-1') || unit.includes('mph')) return value;
	if (unit.includes('km_h-1')) return kmhToMph(value);
	if (unit.includes('m_s-1')) return mpsToMph(value);
	if (unit.includes('knot') || unit.includes('kt')) return knotsToMph(value);
	return value;
}

function toPressureInHg(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.includes('hpa')) return pascalsToInHg(value * 100);
	if (unit.includes('pa')) return pascalsToInHg(value);
	if (unit.includes('inhg')) return value;
	return value;
}

function toMiles(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	const unit = unitCode(measurement);
	if (unit.endsWith(':m') || unit === 'wmounit:m' || unit.includes('meter')) return metersToMiles(value);
	if (unit.includes('km')) return value * 0.621371;
	if (unit.includes('mile')) return value;
	return value;
}

function toPercent(measurement: any): number | null {
	const value = measurementValue(measurement);
	if (value == null) return null;
	return value;
}

function toCompassDirection(degrees: number | null): string | null {
	if (!Number.isFinite(degrees as number)) return null;
	const value = ((degrees as number) % 360 + 360) % 360;
	const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
	return dirs[Math.round(value / 22.5) % 16];
}

function parseWindSpeedTextMph(value: string): number | null {
	const text = String(value || '').toLowerCase();
	if (!text) return null;
	const numbers = text.match(/\d+(?:\.\d+)?/g);
	if (!numbers || numbers.length === 0) return null;
	const parsed = numbers
		.map((x) => Number(x))
		.filter((x) => Number.isFinite(x));
	if (parsed.length === 0) return null;
	const avg = parsed.reduce((sum, x) => sum + x, 0) / parsed.length;
	if (text.includes('km')) return kmhToMph(avg);
	if (text.includes('m/s')) return mpsToMph(avg);
	if (text.includes('kt')) return knotsToMph(avg);
	return avg;
}

function forecastTemperatureToF(period: any): number | null {
	const raw = Number(period?.temperature);
	if (!Number.isFinite(raw)) return null;
	const unit = String(period?.temperatureUnit || '').toUpperCase();
	if (unit === 'F' || !unit) return raw;
	if (unit === 'C') return celsiusToFahrenheit(raw);
	return raw;
}

function severityFromForecastText(text: string): 'high' | 'medium' | 'low' {
	const value = String(text || '').toLowerCase();
	if (/(severe|tornado|flash flood|hurricane|blizzard|thunderstorm|damaging)/i.test(value)) return 'high';
	if (/(rain|showers|wind|snow|sleet|ice|storm|fog|heat)/i.test(value)) return 'medium';
	return 'low';
}

async function fetchPointWeatherContext(lat: number, lon: number): Promise<any> {
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

async function fetchLatestObservation(
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

function normalizeDailyPeriods(periods: any[]): any[] {
	const normalized: any[] = [];

	for (let i = 0; i < periods.length; i++) {
		const period = periods[i];
		if (!period) continue;

		// Prefer daytime periods as the main day cards
		if (period.isDaytime === true) {
			const next = periods[i + 1];
			const highF = forecastTemperatureToF(period);
			const lowF =
				next && next.isDaytime === false
					? forecastTemperatureToF(next)
					: null;

			const forecastText = String(period?.shortForecast || "");
			normalized.push({
				name: String(period?.name || ""),
				startTime: String(period?.startTime || ""),
				isDaytime: true,
				highF: roundTo(highF, 0),
				lowF: lowF !== null ? roundTo(lowF, 0) : null,
				temperatureF: roundTo(highF, 0),
				shortForecast: forecastText,
				detailedForecast: String(period?.detailedForecast || ""),
				windSpeed: String(period?.windSpeed || ""),
				windDirection: String(period?.windDirection || ""),
				precipitationChance: Number(period?.probabilityOfPrecipitation?.value ?? 0),
				icon: String(period?.icon || ""),
				severity: severityFromForecastText(forecastText),
			});
		}
	}

	return normalized.slice(0, 10);
}

function isRecentObservation(timestamp?: string | null): boolean {
	if (!timestamp) return false;
	const ms = Date.parse(String(timestamp));
	if (!Number.isFinite(ms)) return false;
	return Date.now() - ms <= 90 * 60 * 1000; // 90 minutes keeps valid NWS station obs from falling back too early
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

	// Otherwise → actual temp
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

type RadarFrame = {
	time: string;
	label: string;
};

type RadarPayload = {
	station: string | null;
	loopImageUrl: string | null;
	stillImageUrl: string | null;
	updated: string;
	summary: string;
	frames: RadarFrame[];
	tileTemplate: string | null;
	hasLiveTiles: boolean;
	defaultCenter: {
		lat: number;
		lon: number;
	};
	defaultZoom: number;
};

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

function radarImagesForStation(_station: string): { loopImageUrl: string | null; stillImageUrl: string | null } {
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

async function handleApiWeather(request: Request): Promise<Response> {
	const headers = apiCorsHeaders();
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	try {
		const { lat, lon } = parseLatLonForWeather(request);
		const point = await fetchPointWeatherContext(lat, lon);

		if (!point.forecast || !point.forecastHourly) {
			throw new HttpError(502, 'Forecast endpoints are unavailable for this location.');
		}

		const [forecastPayload, hourlyPayload, observation] = await Promise.all([
			fetchNwsJson(point.forecast, 'Daily forecast'),
			fetchNwsJson(point.forecastHourly, 'Hourly forecast'),
			fetchLatestObservation(point.observationStations, point.lat, point.lon),
		]);

		const hourlyPeriodsRaw = Array.isArray(hourlyPayload?.properties?.periods)
			? hourlyPayload.properties.periods
			: [];
		const dailyPeriodsRaw = Array.isArray(forecastPayload?.properties?.periods)
			? forecastPayload.properties.periods
			: [];

		const hourly = normalizeHourlyPeriods(hourlyPeriodsRaw);
		const daily = normalizeDailyPeriods(dailyPeriodsRaw);
		const sun = buildSunTimesFromDailyPeriods(dailyPeriodsRaw);
		if (!sun.sunrise && observation?.properties?.sunrise) {
			sun.sunrise = String(observation.properties.sunrise);
		}
		if (!sun.sunset && observation?.properties?.sunset) {
			sun.sunset = String(observation.properties.sunset);
		}
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
			if (Number.isFinite(sunrise) && Number.isFinite(sunset)) {
				if (now >= sunrise && now < sunset) {
					isNight = false;
				}
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

		console.log("SUN DATA", sun);
		console.log("CURRENT OUTPUT", current);

		headers.set('Cache-Control', 'public, max-age=30, must-revalidate');
		return new Response(JSON.stringify({
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
			updated: new Date().toISOString(),
		}), { status: 200, headers });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Unexpected weather lookup error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}

async function handleApiRadar(request: Request): Promise<Response> {
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
		}), { status: 200, headers });
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 500;
		const message = error instanceof Error ? error.message : 'Unexpected radar lookup error.';
		return new Response(JSON.stringify({ error: message }), { status, headers });
	}
}

async function handleApiLocation(request: Request): Promise<Response> {
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

async function geocodeZipToLocation(zip: string): Promise<SavedLocation> {
	return await geocodeZip(zip);
}

async function handleApiGeocode(request: Request): Promise<Response> {
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

async function handleAdminPage(request: Request, env: Env): Promise<Response> {
	if (!isAuthenticated(request, env)) {
		return new Response(renderLoginPage(), {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	}

	// Sync alerts — uses ETag so it's cheap if nothing changed
	const { map, error } = await syncAlerts(env);
	const alerts = Object.values(map);

	// Surface last poll time in the UI
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const appConfig = await readFbAppConfig(env);

	const page = renderAdminPage(alerts, lastPoll ?? undefined, error, appConfig);
	const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
	return new Response(page, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Thread-check endpoint — called by the modal on open to detect existing threads
// GET /admin/thread-check?alertId=...
// Returns { action: 'new_post' | 'comment', postId?, threadInfo? }
// ---------------------------------------------------------------------------

async function handleThreadCheck(request: Request, env: Env): Promise<Response> {
	if (!isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}
	const url = new URL(request.url);
	const alertId = url.searchParams.get('alertId') ?? '';

	const map = await readAlertMap(env);
	const feature = Object.values(map).find((a: any) => String(a.id) === alertId) as any;
	if (!feature) {
		return new Response(JSON.stringify({ action: 'new_post' }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const p = feature.properties ?? {};
	const ugcCodes: string[] = Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [];
	const event: string = String(p.event ?? '');

	// Check each UGC code for an existing thread — return the first match
	for (const ugc of ugcCodes) {
		const thread = await readThread(env, ugc, event);
		if (thread) {
			return new Response(JSON.stringify({
				action: 'comment',
				postId: thread.postId,
				threadInfo: {
					county: thread.county,
					alertType: thread.alertType,
					postId: thread.postId,
					updateCount: thread.updateCount ?? 0,
				},
			}), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	return new Response(JSON.stringify({ action: 'new_post' }), {
		headers: { 'Content-Type': 'application/json' },
	});
}

async function handlePost(request: Request, env: Env): Promise<Response> {
	if (!isAuthenticated(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const form = await parseRequestBody(request);
	const action = form.get('action');
	const alertId = form.get('alertId') ?? '';
	const customMessage = form.get('customMessage')?.trim() ?? '';
	// threadAction: 'new_post' forces a new post even if a thread exists
	//               'comment'  forces a comment on the existing thread
	//               '' (empty) — auto-detect from KV (default)
	const threadAction = form.get('threadAction')?.trim() ?? '';
	// imageUrl: explicit image URL sent from the admin preview (the same URL
	//           the admin saw in the modal). If present, skip server-side lookup.
	const clientImageUrl = form.get('imageUrl')?.trim() ?? '';

	// Read from KV cache — no live NWS fetch needed here
	let map = await readAlertMap(env);
	let alerts = Object.values(map);

	if (!Array.isArray(alerts) || alerts.length === 0) {
		// If cache is empty, attempt a fresh sync from NWS before posting.
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		alerts = Object.values(map);
	}

	if (!Array.isArray(alerts) || alerts.length === 0) {
		return new Response('No alerts in cache — try reloading the admin page first', { status: 400 });
	}

	let toPost: any[] = [];

	if (action === 'post_alert' && alertId) {
		const match = alerts.find((a: any) => String(a.id) === alertId);
		if (match) toPost = [match];
	}
	if (action === 'auto_post_warning') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'warning');
	}
	if (action === 'auto_post_watch') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'watch');
	}
	if (action === 'auto_post_other') {
		toPost = alerts.filter((a: any) => classifyAlert(String(a.properties?.event ?? '')) === 'other');
	}

	if (toPost.length === 0) {
		return new Response('No matched alerts to post', { status: 400 });
	}

	const results = [];
	for (const feature of toPost.slice(0, 10)) {
		const p = feature.properties ?? {};
		const message = customMessage || alertToText(p);
		const event: string = String(p.event ?? '');
		const ugcCodes: string[] = Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : ['UNKNOWN'];
		const primaryUgc = ugcCodes[0];
		const expiresAt = p.expires ? Math.floor(new Date(p.expires).getTime() / 1000) : 0;

		try {
			// Determine whether to post new or comment on existing thread
			let existingThread: AlertThread | null = null;
			if (threadAction !== 'new_post') {
				existingThread = await readThread(env, primaryUgc, event);
			}

			if (!existingThread || threadAction === 'new_post') {
				// ── NEW ANCHOR POST ────────────────────────────────────────────
				const anchorMessage = customMessage || buildAnchorPostText(p);
				const imageUrl = clientImageUrl || await findAlertImageUrl(env, request, feature);
				const postId = await postToFacebook(env, anchorMessage, imageUrl ?? undefined);
				const thread: AlertThread = {
					postId,
					nwsAlertId: String(feature.id ?? ''),
					expiresAt,
					county: String(p.areaDesc ?? ''),
					alertType: event,
					updateCount: 0,
				};
				for (const ugc of ugcCodes) {
					await writeThread(env, ugc, { ...thread });
				}
				results.push({ id: feature.id, status: 'posted', postId });

			} else {
				// ── EXISTING THREAD — comment or chain break ───────────────────
				const currentCount = existingThread.updateCount ?? 0;

				// If user explicitly chose 'comment', always comment regardless of count
				const forceComment = threadAction === 'comment';

				if (forceComment || currentCount < 3) {
					// Post update comment on existing anchor
					const commentBody = customMessage || buildCommentText(alertToText(p));
					const fullComment = customMessage
						? customMessage
						: `🔄 UPDATE — ${event} for ${String(p.areaDesc ?? '')}\n\n${commentBody}`;
					const commentId = await commentOnFacebook(env, existingThread.postId, fullComment);
					// Update thread: advance alertId, refresh expiry, increment count
					const updatedThread: AlertThread = {
						...existingThread,
						nwsAlertId: String(feature.id ?? ''),
						expiresAt,
						updateCount: currentCount + 1,
					};
					await writeThread(env, primaryUgc, updatedThread);
					results.push({
						id: feature.id,
						status: 'commented',
						postId: existingThread.postId,
						commentId,
						updateCount: currentCount + 1,
					});

				} else {
					// ── CHAIN LIMIT REACHED (updateCount >= 3) ─────────────────
					// Post transition comment on old anchor (non-fatal if it fails)
					try {
						await commentOnFacebook(
							env,
							existingThread.postId,
							`🔄 Continuing coverage of this ${event} has moved to a new post.`
						);
					} catch { /* ignore — still create the new anchor */ }

					// Create new anchor post
					const anchorMessage = customMessage || buildAnchorPostText(p);
					const imageUrl = clientImageUrl || await findAlertImageUrl(env, request, feature);
					const postId = await postToFacebook(env, anchorMessage, imageUrl ?? undefined);
					const chainThread: AlertThread = {
						postId,
						nwsAlertId: String(feature.id ?? ''),
						expiresAt,
						county: String(p.areaDesc ?? ''),
						alertType: event,
						updateCount: 0,
					};
					for (const ugc of ugcCodes) {
						await writeThread(env, ugc, { ...chainThread });
					}
					results.push({ id: feature.id, status: 'posted', postId, chainBreak: true });
				}
			}
		} catch (err) {
			results.push({ id: feature.id, status: 'error', error: String(err) });
		}
	}

	return new Response(JSON.stringify({ results }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// ---------------------------------------------------------------------------
// Cron handler — runs every 2 minutes via wrangler.jsonc trigger
// ---------------------------------------------------------------------------

async function handleScheduled(env: Env): Promise<void> {
	// Sync alerts with ETag — if NWS returns 304, this costs ~2 KV reads total
	const { map } = await syncAlerts(env);
	await dispatchStatePushNotifications(env, map);
}

// ---------------------------------------------------------------------------
// Exported worker — fetch + scheduled handlers
// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Static asset support: support direct root image paths + `/images/*` (site bucket may be ./images).
		const isImageAsset = url.pathname === '/favicon.ico'
			|| url.pathname.startsWith('/images/')
			|| /\.(png|jpe?g|svg|webp|gif)$/i.test(url.pathname);
		if (isImageAsset) {
			if (env.ASSETS) {
				try {
					// Try deterministic candidate paths, including hash-stripped variants.
					const candidatePaths = new Set<string>();
					candidatePaths.add(url.pathname);

					if (url.pathname.startsWith('/images/')) {
						candidatePaths.add(url.pathname.replace('/images', '') || '/');
					} else {
						candidatePaths.add('/images' + url.pathname);
					}

					// If the filename contains a hash chunk before extension (e.g. .b4b78533ab.jpg), try strip it.
					const hashStripped = url.pathname.replace(/\.([a-f0-9]{8,})\.(jpe?g|png|svg|webp|gif)$/i, '.$2');
					if (hashStripped !== url.pathname) {
						candidatePaths.add(hashStripped);
						if (hashStripped.startsWith('/images/')) {
							candidatePaths.add(hashStripped.replace('/images', '') || '/');
						} else {
							candidatePaths.add('/images' + hashStripped);
						}
					}

					for (const path of candidatePaths) {
						const candidateUrl = new URL(request.url);
						candidateUrl.pathname = path;
						const candidateRes = await env.ASSETS.fetch(new Request(candidateUrl.toString(), request));
						if (candidateRes && candidateRes.status !== 404) {
							return candidateRes;
						}
					}
				} catch (e) {
					// fallback to normal handler if static asset not found.
				}
			}
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}

		if (url.pathname === '/api/alerts' && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: apiCorsHeaders(request.headers.get('Origin')) });
		}
		if (url.pathname === '/api/geocode' && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: apiCorsHeaders(request.headers.get('Origin')) });
		}
		if (url.pathname === '/api/location' && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: apiCorsHeaders(request.headers.get('Origin')) });
		}
		if (url.pathname === '/api/weather' && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: apiCorsHeaders(request.headers.get('Origin')) });
		}
		if (url.pathname === '/api/radar' && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: apiCorsHeaders(request.headers.get('Origin')) });
		}
		if (url.pathname.startsWith('/api/push/') && request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: pushCorsHeaders() });
		}
		if (url.pathname === '/api/alerts' && request.method === 'GET') {
			return await handleApiAlerts(env);
		}
		if (url.pathname === '/api/geocode' && request.method === 'GET') {
			return await handleApiGeocode(request);
		}
		if (url.pathname === '/api/location' && request.method === 'GET') {
			return await handleApiLocation(request);
		}
		if (url.pathname === '/api/weather' && request.method === 'GET') {
			return await handleApiWeather(request);
		}
		if (url.pathname === '/api/radar' && request.method === 'GET') {
			return await handleApiRadar(request);
		}
		if (url.pathname === '/api/push/public-key' && request.method === 'GET') {
			return await handlePushPublicKey(env);
		}
		if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
			return await handlePushSubscribe(request, env);
		}
		if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
			return await handlePushUnsubscribe(request, env);
		}
		if (url.pathname === '/live-weather-alerts' && request.method === 'GET') {
			return await handlePublicAlertsPage(env);
		}
		if (url.pathname === '/admin' && request.method === 'GET') {
			return await handleAdminPage(request, env);
		}
		if (url.pathname === '/admin/login' && request.method === 'POST') {
			return await handleAdminLogin(request, env);
		}
		if (url.pathname === '/admin/post' && request.method === 'POST') {
			return await handlePost(request, env);
		}
		if (url.pathname === '/admin/thread-check' && request.method === 'GET') {
			return await handleThreadCheck(request, env);
		}
		if (url.pathname === '/admin/token-exchange' && request.method === 'POST') {
			return await handleTokenExchange(request, env);
		}
		if (url.pathname === '/admin/token-config' && request.method === 'POST') {
			return await handleTokenConfig(request, env);
		}
		return new Response('Not found', { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(handleScheduled(env));
	},
} satisfies ExportedHandler<Env>;
