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
	DEBUG_SUMMARY_BEARER_TOKEN?: string;
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
const PRIMARY_APP_ORIGIN = 'https://liveweatheralerts.com';
const WWW_APP_ORIGIN = 'https://www.liveweatheralerts.com';

// KV keys
const KV_ALERT_MAP  = 'alerts:map';       // JSON: Record<alertId, feature> — merged active alerts
const KV_ETAG       = 'alerts:etag';      // Last ETag string from NWS
const KV_LAST_POLL  = 'alerts:last-poll'; // ISO timestamp of last successful poll
const KV_FB_APP_CONFIG = 'fb:app-config';  // JSON: { appId, appSecret }
const KV_PUSH_SUB_PREFIX = 'push:sub:'; // push:sub:{sha256(endpoint)}
const KV_PUSH_STATE_INDEX_PREFIX = 'push:index:state:'; // push:index:state:{stateCode}
const KV_PUSH_STATE_ALERT_SNAPSHOT = 'push:state-alert-snapshot:v1'; // JSON: Record<stateCode, alertId[]>
const KV_ALERT_LIFECYCLE_SNAPSHOT = 'alerts:lifecycle-snapshot:v1'; // JSON: Record<alertId, AlertLifecycleSnapshotEntry>
const KV_ALERT_CHANGES = 'alerts:changes:v1'; // JSON: AlertChangeRecord[]
const KV_ALERT_HISTORY_DAILY = 'alerts:history:daily:v1'; // JSON: Record<day, AlertHistoryDayRecord>
const KV_OPERATIONAL_DIAGNOSTICS = 'ops:diagnostics:v1'; // JSON: OperationalDiagnostics
const ALERT_HISTORY_RETENTION_DAYS = 14;
const ALERT_HISTORY_MAX_QUERY_DAYS = 14;
const MAX_RECENT_PUSH_FAILURES = 20;
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

type PushDeliveryScope = 'state' | 'county';
type PushDeliveryMode = 'immediate' | 'digest';

type PushQuietHours = {
	enabled: boolean;
	start: string;
	end: string;
};

type PushScope = {
	id: string;
	placeId?: string | null;
	label: string;
	stateCode: string;
	deliveryScope: PushDeliveryScope;
	countyName?: string | null;
	countyFips?: string | null;
	enabled: boolean;
	alertTypes: PushAlertTypes;
	severeOnly: boolean;
};

type PushPreferences = {
	scopes: PushScope[];
	quietHours: PushQuietHours;
	deliveryMode: PushDeliveryMode;
	pausedUntil?: string | null;
};

interface PushSubscriptionRecord {
	id: string;
	endpoint: string;
	subscription: WebPushSubscription;
	prefs: PushPreferences;
	indexedStateCodes: string[];
	createdAt: string;
	updatedAt: string;
	userAgent?: string;
}

type LegacyPushPreferences = {
	stateCode?: string;
	deliveryScope?: PushDeliveryScope;
	countyName?: string | null;
	countyFips?: string | null;
	alertTypes?: Partial<PushAlertTypes>;
	quietHours?: Partial<PushQuietHours>;
	severeOnly?: boolean;
	pausedUntil?: string | null;
};

type LegacyPushSubscriptionRecord = {
	id?: string;
	endpoint?: string;
	stateCode?: string;
	subscription?: WebPushSubscription;
	prefs?: LegacyPushPreferences | PushPreferences;
	indexedStateCodes?: string[];
	createdAt?: string;
	updatedAt?: string;
	userAgent?: string;
};

type PushStateAlertSnapshot = Record<string, string[]>;

type AlertImpactCategory =
	| 'tornado'
	| 'flood'
	| 'winter'
	| 'heat'
	| 'wind'
	| 'fire'
	| 'marine'
	| 'coastal'
	| 'air_quality'
	| 'other';

type AlertChangeType = 'new' | 'updated' | 'extended' | 'expired' | 'all_clear';

type AlertChangeRecord = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	changedAt: string;
	changeType: AlertChangeType;
	severity?: string | null;
	category?: string | null;
	isMajor?: boolean;
	previousExpires?: string | null;
	nextExpires?: string | null;
};

type AlertLifecycleSnapshotEntry = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	headline: string;
	description: string;
	instruction: string;
	severity: string;
	urgency: string;
	certainty: string;
	updated: string;
	expires: string;
	lastChangeType?: Extract<AlertChangeType, 'new' | 'updated' | 'extended'> | null;
	lastChangedAt?: string | null;
};

type AlertLifecycleSnapshot = Record<string, AlertLifecycleSnapshotEntry>;

type AlertLifecycleDiffResult = {
	currentSnapshot: AlertLifecycleSnapshot;
	changes: AlertChangeRecord[];
	isInitialSnapshot: boolean;
};

type AlertHistoryEntry = {
	alertId: string;
	stateCodes: string[];
	countyCodes: string[];
	event: string;
	areaDesc: string;
	changedAt: string;
	changeType: AlertChangeType;
	severity: string;
	category: string;
	isMajor: boolean;
	summary: string;
	previousExpires?: string | null;
	nextExpires?: string | null;
};

type AlertHistorySnapshotCounts = {
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
};

type AlertHistoryDaySnapshot = {
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
	byState: Record<
		string,
		AlertHistorySnapshotCounts
	>;
	byStateCounty?: Record<string, AlertHistorySnapshotCounts>;
};

type AlertHistoryDayRecord = {
	day: string;
	updatedAt: string;
	snapshot: AlertHistoryDaySnapshot;
	entries: AlertHistoryEntry[];
};

type AlertHistoryByDay = Record<string, AlertHistoryDayRecord>;

type PushFailureDiagnostic = {
	at: string;
	stateCode: string;
	subscriptionId?: string | null;
	status?: number;
	message: string;
};

type OperationalDiagnostics = {
	lastSyncAttemptAt: string | null;
	lastSuccessfulSyncAt: string | null;
	lastSyncError: string | null;
	lastKnownAlertCount: number;
	lastStaleDataAt: string | null;
	lastStaleMinutes: number | null;
	invalidSubscriptionCount: number;
	lastInvalidSubscriptionAt: string | null;
	lastInvalidSubscriptionReason: string | null;
	pushFailureCount: number;
	recentPushFailures: PushFailureDiagnostic[];
};

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

function getDebugSummaryBearerToken(env: Env): string | null {
	const token = String(env.DEBUG_SUMMARY_BEARER_TOKEN || '').trim();
	return token || null;
}

function hasDebugSummaryAccess(request: Request, expectedBearerToken: string): boolean {
	const authHeader = request.headers.get('Authorization') || request.headers.get('authorization') || '';
	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	const provided = match[1].trim();
	if (!provided) return false;
	return provided === expectedBearerToken;
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

const STATE_CODE_TO_FIPS: Record<string, string> = {
	'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06',
	'CO': '08', 'CT': '09', 'DE': '10', 'DC': '11', 'FL': '12',
	'GA': '13', 'HI': '15', 'ID': '16', 'IL': '17', 'IN': '18',
	'IA': '19', 'KS': '20', 'KY': '21', 'LA': '22', 'ME': '23',
	'MD': '24', 'MA': '25', 'MI': '26', 'MN': '27', 'MS': '28',
	'MO': '29', 'MT': '30', 'NE': '31', 'NV': '32', 'NH': '33',
	'NJ': '34', 'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38',
	'OH': '39', 'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44',
	'SC': '45', 'SD': '46', 'TN': '47', 'TX': '48', 'UT': '49',
	'VT': '50', 'VA': '51', 'WA': '53', 'WV': '54', 'WI': '55',
	'WY': '56'
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

const DEFAULT_PUSH_ALERT_TYPES: PushAlertTypes = {
	warnings: true,
	watches: true,
	advisories: false,
	statements: true,
};

const DEFAULT_PUSH_QUIET_HOURS: PushQuietHours = {
	enabled: false,
	start: '22:00',
	end: '06:00',
};

const NOTIFICATION_ICON_PATH = '/notification-icon-192.png';
const NOTIFICATION_BADGE_PATH = '/notification-badge-72.png';

function normalizeCountyFips(input: unknown): string | null {
	const digits = String(input ?? '').replace(/\D/g, '');
	if (!digits) return null;
	return digits.padStart(3, '0').slice(-3);
}

function normalizeCountyName(input: unknown): string | null {
	const value = String(input ?? '').trim();
	return value ? value : null;
}

function normalizePushAlertTypes(input: unknown): PushAlertTypes {
	const value = input as Record<string, unknown> | null;
	return {
		warnings: value?.warnings !== false,
		watches: value?.watches !== false,
		advisories: value?.advisories === true,
		statements: value?.statements !== false,
	};
}

function normalizeQuietHourTime(input: unknown, fallback: string): string {
	const value = String(input ?? '').trim();
	if (!/^\d{2}:\d{2}$/.test(value)) return fallback;
	const [hours, minutes] = value.split(':').map((part) => Number(part));
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizePushQuietHours(input: unknown): PushQuietHours {
	const value = input as Record<string, unknown> | null;
	return {
		enabled: value?.enabled === true,
		start: normalizeQuietHourTime(value?.start, DEFAULT_PUSH_QUIET_HOURS.start),
		end: normalizeQuietHourTime(value?.end, DEFAULT_PUSH_QUIET_HOURS.end),
	};
}

function createPushScopeId(
	stateCode: string,
	deliveryScope: PushDeliveryScope,
	countyFips: string | null,
	indexHint: number,
): string {
	const suffix =
		deliveryScope === 'county'
			? countyFips || `county-${indexHint + 1}`
			: `state-${indexHint + 1}`;
	return `${stateCode}-${deliveryScope}-${suffix}`;
}

function normalizePushScope(
	input: unknown,
	fallbackStateCode: string,
	indexHint: number,
): PushScope | null {
	const value = input as Record<string, unknown> | null;
	if (!value || typeof value !== 'object') return null;

	const stateCode = normalizeStateCode(value.stateCode) || normalizeStateCode(fallbackStateCode);
	if (!stateCode) return null;

	const requestedDeliveryScope =
		value.deliveryScope === 'county' ? 'county' : 'state';
	const countyFips = normalizeCountyFips(value.countyFips);
	const countyName = normalizeCountyName(value.countyName);

	const deliveryScope: PushDeliveryScope =
		requestedDeliveryScope === 'county' && (countyFips || countyName)
			? 'county'
			: 'state';
	const scopeId =
		String(value.id ?? '').trim() ||
		createPushScopeId(stateCode, deliveryScope, countyFips, indexHint);
	const placeIdValue = String(value.placeId ?? '').trim();
	const placeId = placeIdValue ? placeIdValue : null;
	const fallbackLabel =
		deliveryScope === 'county'
			? `${stateCode} ${countyName || `County ${countyFips || ''}`.trim()}`.trim()
			: `${stateCode} Alerts`;
	const scopeLabel = String(value.label ?? '').trim() || fallbackLabel;

	return {
		id: scopeId,
		placeId,
		label: scopeLabel,
		stateCode,
		deliveryScope,
		countyName,
		countyFips,
		enabled: value.enabled !== false,
		alertTypes: normalizePushAlertTypes(value.alertTypes),
		severeOnly: value.severeOnly === true,
	};
}

function createDefaultPushScope(stateCode: string): PushScope {
	return {
		id: `${stateCode}-state-default`,
		placeId: null,
		label: `${stateCode} Alerts`,
		stateCode,
		deliveryScope: 'state',
		countyName: null,
		countyFips: null,
		enabled: true,
		alertTypes: { ...DEFAULT_PUSH_ALERT_TYPES },
		severeOnly: false,
	};
}

function defaultPushPreferences(stateCode: string): PushPreferences {
	const normalizedState = normalizeStateCode(stateCode) || 'KY';
	return {
		scopes: [createDefaultPushScope(normalizedState)],
		quietHours: { ...DEFAULT_PUSH_QUIET_HOURS },
		deliveryMode: 'immediate',
		pausedUntil: null,
	};
}

function normalizePushPreferences(
	input: unknown,
	fallbackStateCode: string,
): PushPreferences {
	const fallback = defaultPushPreferences(fallbackStateCode);
	const value = input as Record<string, unknown> | null;
	if (!value || typeof value !== 'object') {
		return fallback;
	}

	const scopesInput = Array.isArray(value.scopes) ? value.scopes : [];
	let scopes = scopesInput
		.map((scope, index) => normalizePushScope(scope, fallbackStateCode, index))
		.filter((scope): scope is PushScope => !!scope);

	if (scopes.length === 0) {
		const legacyState = normalizeStateCode(
			(value as LegacyPushPreferences).stateCode || fallbackStateCode,
		);
		if (legacyState) {
			const legacy = value as LegacyPushPreferences;
			const legacyDeliveryScope =
				legacy.deliveryScope === 'county' ? 'county' : 'state';
			const legacyCountyFips = normalizeCountyFips(legacy.countyFips);
			const legacyCountyName = normalizeCountyName(legacy.countyName);
			const deliveryScope: PushDeliveryScope =
				legacyDeliveryScope === 'county' && (legacyCountyFips || legacyCountyName)
					? 'county'
					: 'state';

			scopes = [
				{
					...createDefaultPushScope(legacyState),
					id: createPushScopeId(legacyState, deliveryScope, legacyCountyFips, 0),
					label:
						deliveryScope === 'county'
							? `${legacyState} ${legacyCountyName || `County ${legacyCountyFips || ''}`.trim()}`.trim()
							: `${legacyState} Alerts`,
					deliveryScope,
					countyName: legacyCountyName,
					countyFips: legacyCountyFips,
					alertTypes: normalizePushAlertTypes(legacy.alertTypes),
					severeOnly: legacy.severeOnly === true,
				},
			];
		}
	}

	if (scopes.length === 0) {
		scopes = fallback.scopes;
	}

	const seenScopeIds = new Set<string>();
	const dedupedScopes = scopes.filter((scope) => {
		const key = scope.id;
		if (seenScopeIds.has(key)) return false;
		seenScopeIds.add(key);
		return true;
	});

	const pausedUntilValue = String(value.pausedUntil ?? '').trim();
	const pausedUntil = pausedUntilValue ? pausedUntilValue : null;

	return {
		scopes: dedupedScopes,
		quietHours: normalizePushQuietHours(value.quietHours),
		deliveryMode: value.deliveryMode === 'digest' ? 'digest' : 'immediate',
		pausedUntil,
	};
}

function indexedStateCodesFromPreferences(prefs: PushPreferences): string[] {
	const states = prefs.scopes
		.filter((scope) => scope.enabled)
		.map((scope) => normalizeStateCode(scope.stateCode))
		.filter((code): code is string => !!code);
	return dedupeStrings(states);
}

function firstStateCodeFromPreferences(prefs: PushPreferences): string | null {
	const firstEnabled = prefs.scopes.find(
		(scope) => scope.enabled && normalizeStateCode(scope.stateCode),
	);
	if (firstEnabled) return normalizeStateCode(firstEnabled.stateCode);

	const firstAny = prefs.scopes.find((scope) => normalizeStateCode(scope.stateCode));
	if (firstAny) return normalizeStateCode(firstAny.stateCode);
	return null;
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
		const parsed = JSON.parse(raw) as LegacyPushSubscriptionRecord;
		if (!parsed || typeof parsed !== 'object') return null;

		const id = String(parsed.id || '').trim();
		const endpoint = String(parsed.endpoint || '').trim();
		const subscription = parsed.subscription;
		if (!id || !endpoint || !isValidPushSubscription(subscription)) return null;

		const fallbackStateCode =
			normalizeStateCode(parsed.stateCode)
			|| normalizeStateCode(parsed.indexedStateCodes?.[0])
			|| 'KY';
		const prefs = normalizePushPreferences(parsed.prefs, fallbackStateCode);
		const indexedFromRecord = Array.isArray(parsed.indexedStateCodes)
			? dedupeStrings(
				parsed.indexedStateCodes
					.map((value) => normalizeStateCode(value))
					.filter((value): value is string => !!value),
			)
			: [];
		const indexedStateCodes =
			indexedFromRecord.length > 0
				? indexedFromRecord
				: indexedStateCodesFromPreferences(prefs);

		const createdAt = String(parsed.createdAt || '').trim() || new Date().toISOString();
		const updatedAt = String(parsed.updatedAt || '').trim() || createdAt;
		const userAgent = String(parsed.userAgent || '').slice(0, 300);

		return {
			id,
			endpoint,
			subscription,
			prefs,
			indexedStateCodes,
			createdAt,
			updatedAt,
			userAgent: userAgent || undefined,
		};
	} catch {
		return null;
	}
}

function classifyAlertType(event: string): keyof PushAlertTypes {
	const text = String(event || '').toLowerCase();
	if (text.includes('warning')) return 'warnings';
	if (text.includes('watch')) return 'watches';
	if (text.includes('advisory')) return 'advisories';
	return 'statements';
}

function alertMatchesTypePrefs(event: string, alertTypes: PushAlertTypes): boolean {
	const bucket = classifyAlertType(event);
	return !!alertTypes[bucket];
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

function alertBypassesQuietHours(feature: any): boolean {
	const event = String(feature?.properties?.event || '');
	const text = String(event || '').toLowerCase();
	if (
		text.includes('tornado warning')
		|| text.includes('severe thunderstorm warning')
		|| text.includes('flash flood warning')
	) {
		return true;
	}
	const severity = String(feature?.properties?.severity || '').toLowerCase();
	return text.includes('warning') && severity === 'extreme';
}

function isDeliveryPaused(prefs: PushPreferences, now: Date): boolean {
	if (!prefs.pausedUntil) return false;
	const pausedUntilMs = Date.parse(prefs.pausedUntil);
	return Number.isFinite(pausedUntilMs) && pausedUntilMs > now.getTime();
}

function cleanCountyToken(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\b(county|counties|parish|parishes|borough|city)\b/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractCountyUgcCodes(feature: any): string[] {
	const ugcCodes = Array.isArray(feature?.properties?.geocode?.UGC)
		? feature.properties.geocode.UGC
		: [];
	return dedupeStrings(
		ugcCodes
			.map((value: unknown) => String(value || '').trim().toUpperCase())
			.filter((value: string) => /^[A-Z]{2}C\d{3}$/.test(value)),
	);
}

function extractCountyFipsFromSameCodes(
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

function extractCountyFipsCodesForState(feature: any, stateCodeInput: string): string[] {
	const stateCode = normalizeStateCode(stateCodeInput);
	if (!stateCode) return [];
	const fromUgc = extractCountyUgcCodes(feature)
		.filter((ugcCode) => ugcCode.startsWith(`${stateCode}C`))
		.map((ugcCode) => ugcCode.slice(-3))
		.filter((countyCode) => /^\d{3}$/.test(countyCode));
	const fromSame = extractCountyFipsFromSameCodes(feature, stateCode);
	return dedupeStrings([...fromUgc, ...fromSame]).sort();
}

function alertMatchesScopeCounty(feature: any, scope: PushScope): boolean {
	if (scope.deliveryScope !== 'county') return true;

	const stateCode = normalizeStateCode(scope.stateCode);
	if (!stateCode) return false;

	const countyFipsCodes = extractCountyFipsCodesForState(feature, stateCode);
	const countyFips = normalizeCountyFips(scope.countyFips);
	if (countyFips) {
		if (countyFipsCodes.includes(countyFips)) return true;
	}

	const countyName = cleanCountyToken(String(scope.countyName || ''));
	if (!countyName) return false;

	const areaDesc = String(feature?.properties?.areaDesc || '');
	const areaTokens = areaDesc
		.split(/[;,]/)
		.map((part) => cleanCountyToken(part))
		.filter(Boolean);

	if (
		areaTokens.some(
			(token) =>
				token === countyName
				|| token.includes(countyName)
				|| countyName.includes(token),
		)
	) {
		return true;
	}

	return cleanCountyToken(areaDesc).includes(countyName);
}

function alertMatchesSevereOnly(feature: any): boolean {
	const event = String(feature?.properties?.event || '').toLowerCase();
	const severity = String(feature?.properties?.severity || '').toLowerCase();
	if (!event.includes('warning')) return false;
	if (severity === 'severe' || severity === 'extreme') return true;
	return (
		event.includes('tornado')
		|| event.includes('severe thunderstorm')
		|| event.includes('flash flood')
		|| event.includes('hurricane')
		|| event.includes('blizzard')
	);
}

function featureMatchesScope(feature: any, stateCode: string, scope: PushScope): boolean {
	if (!scope.enabled) return false;
	if (normalizeStateCode(scope.stateCode) !== stateCode) return false;
	const event = String(feature?.properties?.event || '');
	if (!alertMatchesTypePrefs(event, scope.alertTypes)) return false;
	if (scope.severeOnly && !alertMatchesSevereOnly(feature)) return false;
	if (!alertMatchesScopeCounty(feature, scope)) return false;
	return true;
}

async function upsertPushSubscriptionRecord(
	env: Env,
	subscription: WebPushSubscription,
	userAgent?: string,
	stateCodeInput?: string,
	prefsInput?: unknown,
): Promise<PushSubscriptionRecord> {
	const nowIso = new Date().toISOString();
	const subscriptionId = await sha256Hex(subscription.endpoint);
	const existing = await readPushSubscriptionRecordById(env, subscriptionId);
	const requestedStateCode = normalizeStateCode(stateCodeInput);
	const existingPrimaryState =
		existing ? firstStateCodeFromPreferences(existing.prefs) : null;
	const fallbackStateCode =
		requestedStateCode
		|| existingPrimaryState
		|| 'KY';

	let nextPrefs: PushPreferences;
	if (prefsInput && typeof prefsInput === 'object') {
		nextPrefs = normalizePushPreferences(prefsInput, fallbackStateCode);
	} else if (requestedStateCode) {
		const baseline = existing?.prefs || defaultPushPreferences(requestedStateCode);
		const templateScope = baseline.scopes[0] || createDefaultPushScope(requestedStateCode);
		const migratedScope: PushScope = {
			...templateScope,
			id: `${requestedStateCode}-state-updated`,
			label: `${requestedStateCode} Alerts`,
			stateCode: requestedStateCode,
			deliveryScope: 'state',
			countyName: null,
			countyFips: null,
			enabled: true,
		};
		nextPrefs = {
			...baseline,
			scopes: [migratedScope],
		};
	} else {
		nextPrefs = existing?.prefs || defaultPushPreferences(fallbackStateCode);
	}
	const indexedStateCodes = indexedStateCodesFromPreferences(nextPrefs);

	const record: PushSubscriptionRecord = {
		id: subscriptionId,
		endpoint: subscription.endpoint,
		subscription,
		prefs: nextPrefs,
		indexedStateCodes,
		createdAt: existing?.createdAt || nowIso,
		updatedAt: nowIso,
		userAgent: String(userAgent || existing?.userAgent || '').slice(0, 300),
	};

	await env.WEATHER_KV.put(pushSubKey(subscriptionId), JSON.stringify(record));

	const previousIndexedStateCodes = existing?.indexedStateCodes || [];
	const allKnownStateCodes = dedupeStrings([
		...Object.keys(STATE_CODE_TO_NAME),
		...previousIndexedStateCodes,
		...indexedStateCodes,
	]);

	for (const stateCode of allKnownStateCodes) {
		const shouldBeIndexed = indexedStateCodes.includes(stateCode);
		const currentlyIndexed = (await readPushStateIndex(env, stateCode)).includes(
			subscriptionId,
		);
		if (shouldBeIndexed && !currentlyIndexed) {
			await addPushIdToStateIndex(env, stateCode, subscriptionId);
			continue;
		}
		if (!shouldBeIndexed && currentlyIndexed) {
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
		}
	}

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
		...existing.indexedStateCodes.map((stateCode) =>
			removePushIdFromStateIndex(env, stateCode, subscriptionId),
		),
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

async function writePushStateAlertSnapshot(env: Env, snapshot: PushStateAlertSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_PUSH_STATE_ALERT_SNAPSHOT, JSON.stringify(snapshot));
}

function extractCountyFipsCodes(feature: any): string[] {
	const fromUgc = extractCountyUgcCodes(feature)
		.map((ugc) => String(ugc).slice(-3))
		.filter((value) => /^\d{3}$/.test(value));
	const fromSame = extractCountyFipsFromSameCodes(feature);
	return dedupeStrings(
		[...fromUgc, ...fromSame],
	).sort();
}

function normalizeIsoTimestamp(value: unknown): string {
	const text = String(value || '').trim();
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) return '';
	return new Date(parsed).toISOString();
}

function normalizeAlertLifecycleSnapshotEntry(value: unknown): AlertLifecycleSnapshotEntry | null {
	const entry = value as Record<string, unknown> | null;
	if (!entry || typeof entry !== 'object') return null;

	const alertId = String(entry.alertId || '').trim();
	if (!alertId) return null;

	const stateCodes = Array.isArray(entry.stateCodes)
		? dedupeStrings(entry.stateCodes.map((state) => String(state).trim().toUpperCase())).sort()
		: [];
	const countyCodes = Array.isArray(entry.countyCodes)
		? dedupeStrings(
			entry.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];

	const normalizedLastChangeType = String(entry.lastChangeType || '').trim().toLowerCase();
	const lastChangeType =
		normalizedLastChangeType === 'new'
		|| normalizedLastChangeType === 'updated'
		|| normalizedLastChangeType === 'extended'
			? normalizedLastChangeType
			: null;

	const lastChangedAt = normalizeIsoTimestamp(entry.lastChangedAt);

	return {
		alertId,
		stateCodes,
		countyCodes,
		event: String(entry.event || ''),
		areaDesc: String(entry.areaDesc || ''),
		headline: String(entry.headline || ''),
		description: String(entry.description || ''),
		instruction: String(entry.instruction || ''),
		severity: String(entry.severity || ''),
		urgency: String(entry.urgency || ''),
		certainty: String(entry.certainty || ''),
		updated: String(entry.updated || ''),
		expires: String(entry.expires || ''),
		lastChangeType,
		lastChangedAt: lastChangedAt || null,
	};
}

async function readAlertLifecycleSnapshot(env: Env): Promise<AlertLifecycleSnapshot | null> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_LIFECYCLE_SNAPSHOT);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const snapshot: AlertLifecycleSnapshot = {};
		for (const [alertId, value] of Object.entries(parsed as Record<string, unknown>)) {
			const normalized = normalizeAlertLifecycleSnapshotEntry(value);
			if (!normalized) continue;
			snapshot[String(alertId)] = normalized;
		}
		return snapshot;
	} catch {
		return null;
	}
}

async function writeAlertLifecycleSnapshot(env: Env, snapshot: AlertLifecycleSnapshot): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_LIFECYCLE_SNAPSHOT, JSON.stringify(snapshot));
}

function normalizeAlertChangeType(value: unknown): AlertChangeType | null {
	const normalized = String(value || '').trim().toLowerCase();
	if (
		normalized === 'new'
		|| normalized === 'updated'
		|| normalized === 'extended'
		|| normalized === 'expired'
		|| normalized === 'all_clear'
	) {
		return normalized;
	}
	return null;
}

function normalizeAlertChangeRecord(value: unknown): AlertChangeRecord | null {
	const record = value as Record<string, unknown> | null;
	if (!record || typeof record !== 'object') return null;

	const changeType = normalizeAlertChangeType(record.changeType);
	const alertId = String(record.alertId || '').trim();
	const changedAt = normalizeIsoTimestamp(record.changedAt);
	if (!changeType || !alertId || !changedAt) return null;

	const stateCodes = Array.isArray(record.stateCodes)
		? dedupeStrings(
			record.stateCodes
				.map((stateCode) => normalizeStateCode(stateCode))
				.filter((stateCode): stateCode is string => !!stateCode),
		).sort()
		: [];
	const countyCodes = Array.isArray(record.countyCodes)
		? dedupeStrings(
			record.countyCodes
				.map((countyCode) =>
					String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3),
				)
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];

	return {
		alertId,
		stateCodes,
		countyCodes,
		event: String(record.event || ''),
		areaDesc: String(record.areaDesc || ''),
		changedAt,
		changeType,
		severity: String(record.severity || '').trim() || null,
		category: String(record.category || '').trim() || null,
		isMajor: record.isMajor === true,
		previousExpires: record.previousExpires ? String(record.previousExpires) : null,
		nextExpires: record.nextExpires ? String(record.nextExpires) : null,
	};
}

async function readAlertChangeRecords(env: Env): Promise<AlertChangeRecord[]> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_CHANGES);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((record) => normalizeAlertChangeRecord(record))
			.filter((record): record is AlertChangeRecord => !!record)
			.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
	} catch {
		return [];
	}
}

async function appendAlertChangeRecords(env: Env, changes: AlertChangeRecord[]): Promise<void> {
	if (changes.length === 0) return;
	const existing = await readAlertChangeRecords(env);
	const merged = [...changes, ...existing];
	const deduped = new Map<string, AlertChangeRecord>();
	for (const record of merged) {
		const key = `${record.alertId}|${record.changeType}|${record.changedAt}`;
		if (!deduped.has(key)) {
			deduped.set(key, record);
		}
	}
	const sorted = Array.from(deduped.values()).sort(
		(a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt),
	);
	const retentionWindowMs = 7 * 24 * 60 * 60 * 1000;
	const nowMs = Date.now();
	const trimmed = sorted
		.filter((record) => {
			const changedAtMs = Date.parse(record.changedAt);
			if (!Number.isFinite(changedAtMs)) return false;
			return nowMs - changedAtMs <= retentionWindowMs;
		})
		.slice(0, 1200);
	await env.WEATHER_KV.put(KV_ALERT_CHANGES, JSON.stringify(trimmed));
}

function dayKeyFromTimestampMs(timestampMs: number): string {
	return new Date(timestampMs).toISOString().slice(0, 10);
}

function dayKeyFromIso(value: string): string | null {
	const parsed = Date.parse(String(value || '').trim());
	if (!Number.isFinite(parsed)) return null;
	return dayKeyFromTimestampMs(parsed);
}

function normalizeAlertHistorySnapshotCount(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function createEmptyAlertHistorySnapshotCounts(): AlertHistorySnapshotCounts {
	return {
		activeAlertCount: 0,
		activeWarningCount: 0,
		activeMajorCount: 0,
	};
}

function normalizeAlertHistorySnapshotCounts(value: unknown): AlertHistorySnapshotCounts {
	const counts = value as Record<string, unknown> | null;
	return {
		activeAlertCount: normalizeAlertHistorySnapshotCount(counts?.activeAlertCount),
		activeWarningCount: normalizeAlertHistorySnapshotCount(counts?.activeWarningCount),
		activeMajorCount: normalizeAlertHistorySnapshotCount(counts?.activeMajorCount),
	};
}

function addAlertHistorySnapshotCounts(
	target: AlertHistorySnapshotCounts,
	source: AlertHistorySnapshotCounts,
): void {
	target.activeAlertCount += source.activeAlertCount;
	target.activeWarningCount += source.activeWarningCount;
	target.activeMajorCount += source.activeMajorCount;
}

function buildStateCountySnapshotKey(stateCode: string, countyCode: string): string {
	return `${stateCode}:${countyCode}`;
}

function parseStateCountySnapshotKey(
	value: unknown,
): { stateCode: string; countyCode: string } | null {
	const raw = String(value || '').trim().toUpperCase();
	if (!raw) return null;

	const splitMatch = raw.match(/^([A-Z]{2})[:|](\d{3})$/);
	if (splitMatch) {
		const stateCode = normalizeStateCode(splitMatch[1]);
		const countyCode = normalizeCountyFips(splitMatch[2]);
		if (!stateCode || !countyCode) return null;
		return { stateCode, countyCode };
	}

	const compactMatch = raw.match(/^([A-Z]{2})(\d{3})$/);
	if (!compactMatch) return null;
	const stateCode = normalizeStateCode(compactMatch[1]);
	const countyCode = normalizeCountyFips(compactMatch[2]);
	if (!stateCode || !countyCode) return null;
	return { stateCode, countyCode };
}

function readAlertHistorySnapshotCountsByCounty(
	snapshot: AlertHistoryDaySnapshot,
	countyCodeInput: string,
	stateCodeInput?: string | null,
): AlertHistorySnapshotCounts | null {
	const countyCode = normalizeCountyFips(countyCodeInput);
	if (!countyCode) return null;
	const stateCode = normalizeStateCode(stateCodeInput || '');
	const byStateCounty = snapshot.byStateCounty || {};

	if (stateCode) {
		const directMatch = byStateCounty[buildStateCountySnapshotKey(stateCode, countyCode)];
		return directMatch ? normalizeAlertHistorySnapshotCounts(directMatch) : null;
	}

	let matched = false;
	const totals = createEmptyAlertHistorySnapshotCounts();
	for (const [key, value] of Object.entries(byStateCounty)) {
		const parsedKey = parseStateCountySnapshotKey(key);
		if (!parsedKey || parsedKey.countyCode !== countyCode) continue;
		matched = true;
		addAlertHistorySnapshotCounts(
			totals,
			normalizeAlertHistorySnapshotCounts(value),
		);
	}
	return matched ? totals : null;
}

function summarizeAlertHistoryEntriesAsSnapshot(
	entries: AlertHistoryEntry[],
): AlertHistorySnapshotCounts {
	const latestByAlertId = new Map<string, AlertHistoryEntry>();
	for (const entry of entries) {
		const alertId = String(entry.alertId || '').trim();
		if (!alertId || alertId.toLowerCase().startsWith('all-clear:')) continue;
		const existing = latestByAlertId.get(alertId);
		const changedAtMs = Date.parse(entry.changedAt);
		const existingChangedAtMs = existing ? Date.parse(existing.changedAt) : NaN;
		if (
			!existing
			|| (
				Number.isFinite(changedAtMs)
				&& (
					!Number.isFinite(existingChangedAtMs)
					|| changedAtMs > existingChangedAtMs
				)
			)
		) {
			latestByAlertId.set(alertId, entry);
		}
	}

	const counts = createEmptyAlertHistorySnapshotCounts();
	for (const entry of latestByAlertId.values()) {
		counts.activeAlertCount += 1;
		const category = String(entry.category || '').trim().toLowerCase()
			|| classifyAlertCategoryFromEvent(entry.event);
		if (category === 'warning') {
			counts.activeWarningCount += 1;
		}
		if (entry.isMajor === true) {
			counts.activeMajorCount += 1;
		}
	}
	return counts;
}

function normalizeAlertHistoryDaySnapshot(value: unknown): AlertHistoryDaySnapshot {
	const snapshot = value as Record<string, unknown> | null;
	const byStateRaw = snapshot?.byState as Record<string, unknown> | undefined;
	const byState: AlertHistoryDaySnapshot['byState'] = {};
	if (byStateRaw && typeof byStateRaw === 'object') {
		for (const [stateCode, stateValue] of Object.entries(byStateRaw)) {
			const normalizedStateCode = normalizeStateCode(stateCode);
			if (!normalizedStateCode) continue;
			byState[normalizedStateCode] = normalizeAlertHistorySnapshotCounts(stateValue);
		}
	}

	const byStateCountyRaw = snapshot?.byStateCounty as Record<string, unknown> | undefined;
	const byStateCounty: Record<string, AlertHistorySnapshotCounts> = {};
	if (byStateCountyRaw && typeof byStateCountyRaw === 'object') {
		for (const [stateCountyKey, stateCountyValue] of Object.entries(byStateCountyRaw)) {
			const parsedKey = parseStateCountySnapshotKey(stateCountyKey);
			if (!parsedKey) continue;
			byStateCounty[
				buildStateCountySnapshotKey(parsedKey.stateCode, parsedKey.countyCode)
			] = normalizeAlertHistorySnapshotCounts(stateCountyValue);
		}
	}

	const rootCounts = normalizeAlertHistorySnapshotCounts(snapshot);
	return {
		activeAlertCount: rootCounts.activeAlertCount,
		activeWarningCount: rootCounts.activeWarningCount,
		activeMajorCount: rootCounts.activeMajorCount,
		byState,
		byStateCounty,
	};
}

function createHistoryDaySnapshotFromMap(map: Record<string, any>): AlertHistoryDaySnapshot {
	let activeAlertCount = 0;
	let activeWarningCount = 0;
	let activeMajorCount = 0;
	const byState: AlertHistoryDaySnapshot['byState'] = {};
	const byStateCounty: Record<string, AlertHistorySnapshotCounts> = {};

	for (const feature of Object.values(map)) {
		activeAlertCount += 1;
		const properties = feature?.properties ?? {};
		const event = String(properties.event || '');
		const severity = String(properties.severity || '');
		const headline = String(properties.headline || '');
		const description = String(properties.description || '');
		const category = classifyAlertCategoryFromEvent(event);
		const stateCodes = extractStateCodes(feature);
		const countyCodesByState = new Map<string, string[]>();
		for (const stateCode of stateCodes) {
			const countyCodesForState = extractCountyFipsCodesForState(feature, stateCode);
			countyCodesByState.set(stateCode, countyCodesForState);
			if (!byState[stateCode]) {
				byState[stateCode] = createEmptyAlertHistorySnapshotCounts();
			}
			byState[stateCode].activeAlertCount += 1;
			for (const countyCode of countyCodesForState) {
				const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
				if (!byStateCounty[stateCountyKey]) {
					byStateCounty[stateCountyKey] = createEmptyAlertHistorySnapshotCounts();
				}
				byStateCounty[stateCountyKey].activeAlertCount += 1;
			}
		}

		if (category === 'warning') {
			activeWarningCount += 1;
			for (const stateCode of stateCodes) {
				if (byState[stateCode]) {
					byState[stateCode].activeWarningCount += 1;
				}
			}
			for (const stateCode of stateCodes) {
				const countyCodesForState = countyCodesByState.get(stateCode) || [];
				for (const countyCode of countyCodesForState) {
					const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
					if (byStateCounty[stateCountyKey]) {
						byStateCounty[stateCountyKey].activeWarningCount += 1;
					}
				}
			}
		}
		const impactCategories = deriveAlertImpactCategories(event, headline, description);
		if (isMajorImpactAlertEvent(event, severity, impactCategories)) {
			activeMajorCount += 1;
			for (const stateCode of stateCodes) {
				if (byState[stateCode]) {
					byState[stateCode].activeMajorCount += 1;
				}
			}
			for (const stateCode of stateCodes) {
				const countyCodesForState = countyCodesByState.get(stateCode) || [];
				for (const countyCode of countyCodesForState) {
					const stateCountyKey = buildStateCountySnapshotKey(stateCode, countyCode);
					if (byStateCounty[stateCountyKey]) {
						byStateCounty[stateCountyKey].activeMajorCount += 1;
					}
				}
			}
		}
	}

	return {
		activeAlertCount,
		activeWarningCount,
		activeMajorCount,
		byState,
		byStateCounty,
	};
}

function buildAlertHistoryEntrySummary(change: AlertChangeRecord): string {
	const eventLabel = String(change.event || 'Weather alert').trim() || 'Weather alert';
	const areaLabel = String(change.areaDesc || '').trim();
	const placeLabel = areaLabel || 'the selected area';

	if (change.changeType === 'new') {
		return `${eventLabel} was newly issued for ${placeLabel}.`;
	}
	if (change.changeType === 'updated') {
		return `${eventLabel} was updated for ${placeLabel}.`;
	}
	if (change.changeType === 'extended') {
		return `${eventLabel} was extended for ${placeLabel}.`;
	}
	if (change.changeType === 'expired') {
		return `${eventLabel} expired for ${placeLabel}.`;
	}
	return `All clear conditions were recorded for ${placeLabel}.`;
}

function normalizeAlertHistoryEntry(value: unknown): AlertHistoryEntry | null {
	const entry = value as Record<string, unknown> | null;
	if (!entry || typeof entry !== 'object') return null;

	const alertId = String(entry.alertId || '').trim();
	const changedAt = normalizeIsoTimestamp(entry.changedAt);
	const changeType = normalizeAlertChangeType(entry.changeType);
	if (!alertId || !changedAt || !changeType) return null;

	const event = String(entry.event || '').trim() || 'Weather Alert';
	const categoryRaw = String(entry.category || '').trim().toLowerCase();
	const category = categoryRaw || classifyAlertCategoryFromEvent(event);
	const severity = String(entry.severity || '').trim();
	const impactCategories = deriveAlertImpactCategories(
		event,
		String(entry.summary || ''),
		String(entry.areaDesc || ''),
	);
	const isMajor =
		entry.isMajor === true
		|| isMajorImpactAlertEvent(event, severity, impactCategories);
	const stateCodes = Array.isArray(entry.stateCodes)
		? dedupeStrings(
			entry.stateCodes
				.map((stateCode) => normalizeStateCode(stateCode))
				.filter((stateCode): stateCode is string => !!stateCode),
		).sort()
		: [];
	const countyCodes = Array.isArray(entry.countyCodes)
		? dedupeStrings(
			entry.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort()
		: [];
	const summary = String(entry.summary || '').trim() || buildAlertHistoryEntrySummary({
		alertId,
		stateCodes,
		countyCodes,
		event,
		areaDesc: String(entry.areaDesc || ''),
		changedAt,
		changeType,
		severity: severity || null,
		category,
		isMajor,
		previousExpires: entry.previousExpires ? String(entry.previousExpires) : null,
		nextExpires: entry.nextExpires ? String(entry.nextExpires) : null,
	});

	return {
		alertId,
		stateCodes,
		countyCodes,
		event,
		areaDesc: String(entry.areaDesc || ''),
		changedAt,
		changeType,
		severity: severity || 'Unknown',
		category,
		isMajor,
		summary,
		previousExpires: entry.previousExpires ? String(entry.previousExpires) : null,
		nextExpires: entry.nextExpires ? String(entry.nextExpires) : null,
	};
}

function normalizeAlertHistoryDayRecord(value: unknown): AlertHistoryDayRecord | null {
	const record = value as Record<string, unknown> | null;
	if (!record || typeof record !== 'object') return null;

	const day = String(record.day || '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
	const dayMs = Date.parse(`${day}T00:00:00.000Z`);
	if (!Number.isFinite(dayMs)) return null;

	const updatedAt = normalizeIsoTimestamp(record.updatedAt) || new Date().toISOString();
	const snapshot = normalizeAlertHistoryDaySnapshot(record.snapshot);
	const entries = Array.isArray(record.entries)
		? record.entries
			.map((entry) => normalizeAlertHistoryEntry(entry))
			.filter((entry): entry is AlertHistoryEntry => !!entry)
			.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
		: [];

	return {
		day,
		updatedAt,
		snapshot,
		entries,
	};
}

async function readAlertHistoryByDay(env: Env): Promise<AlertHistoryByDay> {
	try {
		const raw = await env.WEATHER_KV.get(KV_ALERT_HISTORY_DAILY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const records: AlertHistoryByDay = {};
		for (const value of Object.values(parsed as Record<string, unknown>)) {
			const normalized = normalizeAlertHistoryDayRecord(value);
			if (!normalized) continue;
			records[normalized.day] = normalized;
		}
		return records;
	} catch {
		return {};
	}
}

async function writeAlertHistoryByDay(env: Env, historyByDay: AlertHistoryByDay): Promise<void> {
	await env.WEATHER_KV.put(KV_ALERT_HISTORY_DAILY, JSON.stringify(historyByDay));
}

function pruneAlertHistoryByDay(
	historyByDay: AlertHistoryByDay,
	nowMs = Date.now(),
): AlertHistoryByDay {
	const retentionWindowMs = ALERT_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const cutoffMs = nowMs - retentionWindowMs;
	const pruned: AlertHistoryByDay = {};
	for (const [day, record] of Object.entries(historyByDay)) {
		const dayMs = Date.parse(`${day}T00:00:00.000Z`);
		if (!Number.isFinite(dayMs)) continue;
		const dayEndsMs = dayMs + (24 * 60 * 60 * 1000);
		if (dayEndsMs < cutoffMs) continue;
		pruned[day] = record;
	}
	return pruned;
}

function createAlertHistoryEntryFromChange(change: AlertChangeRecord): AlertHistoryEntry {
	const event = String(change.event || '').trim() || 'Weather Alert';
	const category = String(change.category || '').trim().toLowerCase()
		|| classifyAlertCategoryFromEvent(event);
	const severity = String(change.severity || '').trim() || 'Unknown';
	const impactCategories = deriveAlertImpactCategories(event, '', '');
	const isMajor =
		change.isMajor === true
		|| isMajorImpactAlertEvent(event, severity, impactCategories);
	return {
		alertId: String(change.alertId || '').trim(),
		stateCodes: dedupeStrings(change.stateCodes.map((stateCode) => String(stateCode).trim().toUpperCase()))
			.filter((stateCode) => !!normalizeStateCode(stateCode))
			.sort(),
		countyCodes: dedupeStrings(
			change.countyCodes
				.map((countyCode) => String(countyCode).replace(/\D/g, '').padStart(3, '0').slice(-3))
				.filter((countyCode) => /^\d{3}$/.test(countyCode)),
		).sort(),
		event,
		areaDesc: String(change.areaDesc || ''),
		changedAt: normalizeIsoTimestamp(change.changedAt) || new Date().toISOString(),
		changeType: change.changeType,
		severity,
		category,
		isMajor,
		summary: buildAlertHistoryEntrySummary(change),
		previousExpires: change.previousExpires ?? null,
		nextExpires: change.nextExpires ?? null,
	};
}

function buildNextAlertHistoryByDay(
	previousHistoryByDay: AlertHistoryByDay | null,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
	nowIso = new Date().toISOString(),
): AlertHistoryByDay {
	const nextHistoryByDay: AlertHistoryByDay = {};
	for (const value of Object.values(previousHistoryByDay || {})) {
		const normalized = normalizeAlertHistoryDayRecord(value);
		if (!normalized) continue;
		nextHistoryByDay[normalized.day] = {
			...normalized,
			entries: [...normalized.entries],
		};
	}

	const nowDay = dayKeyFromIso(nowIso) || dayKeyFromTimestampMs(Date.now());
	const ensureDayRecord = (day: string): AlertHistoryDayRecord => {
		const existing = nextHistoryByDay[day];
		if (existing) {
			return existing;
		}
		const created: AlertHistoryDayRecord = {
			day,
			updatedAt: nowIso,
			snapshot: {
				activeAlertCount: 0,
				activeWarningCount: 0,
				activeMajorCount: 0,
				byState: {},
				byStateCounty: {},
			},
			entries: [],
		};
		nextHistoryByDay[day] = created;
		return created;
	};

	const todayRecord = ensureDayRecord(nowDay);
	todayRecord.snapshot = createHistoryDaySnapshotFromMap(map);
	todayRecord.updatedAt = nowIso;

	for (const change of changes) {
		const normalizedChange = normalizeAlertChangeRecord(change);
		if (!normalizedChange) continue;
		const day = dayKeyFromIso(normalizedChange.changedAt) || nowDay;
		const dayRecord = ensureDayRecord(day);
		const nextEntry = createAlertHistoryEntryFromChange(normalizedChange);
		const nextEntryKey = `${nextEntry.alertId}|${nextEntry.changeType}|${nextEntry.changedAt}`;
		const existingKeys = new Set(
			dayRecord.entries.map((entry) => `${entry.alertId}|${entry.changeType}|${entry.changedAt}`),
		);
		if (!existingKeys.has(nextEntryKey)) {
			dayRecord.entries.push(nextEntry);
		}
		dayRecord.entries.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
		if (dayRecord.entries.length > 500) {
			dayRecord.entries = dayRecord.entries.slice(0, 500);
		}
		dayRecord.updatedAt = nowIso;
	}

	return pruneAlertHistoryByDay(nextHistoryByDay, Date.parse(nowIso));
}

async function syncAlertHistoryDailySnapshots(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
): Promise<AlertHistoryByDay> {
	const previousHistoryByDay = await readAlertHistoryByDay(env);
	const nextHistoryByDay = buildNextAlertHistoryByDay(previousHistoryByDay, map, changes);
	await writeAlertHistoryByDay(env, nextHistoryByDay);
	return nextHistoryByDay;
}

function createLifecycleSnapshotEntry(
	alertId: string,
	feature: any,
	previousEntry?: AlertLifecycleSnapshotEntry | null,
): AlertLifecycleSnapshotEntry {
	const properties = feature?.properties ?? {};
	return {
		alertId,
		stateCodes: dedupeStrings(extractStateCodes(feature)).sort(),
		countyCodes: extractCountyFipsCodes(feature),
		event: String(properties.event || ''),
		areaDesc: String(properties.areaDesc || ''),
		headline: String(properties.headline || ''),
		description: String(properties.description || ''),
		instruction: String(properties.instruction || ''),
		severity: String(properties.severity || ''),
		urgency: String(properties.urgency || ''),
		certainty: String(properties.certainty || ''),
		updated: String(properties.updated || ''),
		expires: String(properties.expires || ''),
		lastChangeType: previousEntry?.lastChangeType || null,
		lastChangedAt: previousEntry?.lastChangedAt || null,
	};
}

function parseTimeMs(value: string): number | null {
	const parsed = Date.parse(String(value || '').trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function hasAlertBeenUpdated(
	previousEntry: AlertLifecycleSnapshotEntry,
	currentEntry: AlertLifecycleSnapshotEntry,
): boolean {
	return (
		previousEntry.updated !== currentEntry.updated
		|| previousEntry.headline !== currentEntry.headline
		|| previousEntry.description !== currentEntry.description
		|| previousEntry.instruction !== currentEntry.instruction
		|| previousEntry.areaDesc !== currentEntry.areaDesc
		|| previousEntry.severity !== currentEntry.severity
		|| previousEntry.urgency !== currentEntry.urgency
		|| previousEntry.certainty !== currentEntry.certainty
	);
}

function hasAlertBeenExtended(
	previousEntry: AlertLifecycleSnapshotEntry,
	currentEntry: AlertLifecycleSnapshotEntry,
): boolean {
	const previousExpiresMs = parseTimeMs(previousEntry.expires);
	const currentExpiresMs = parseTimeMs(currentEntry.expires);
	if (previousExpiresMs === null || currentExpiresMs === null) return false;
	return currentExpiresMs - previousExpiresMs > 60_000;
}

function createAlertChangeRecord(
	entry: AlertLifecycleSnapshotEntry,
	changedAt: string,
	changeType: AlertChangeType,
	previousExpires?: string | null,
	nextExpires?: string | null,
): AlertChangeRecord {
	const category = classifyAlertCategoryFromEvent(entry.event || '');
	const impactCategories = deriveAlertImpactCategories(
		entry.event || '',
		entry.headline || '',
		entry.description || '',
	);
	return {
		alertId: entry.alertId,
		stateCodes: dedupeStrings(entry.stateCodes).sort(),
		countyCodes: dedupeStrings(entry.countyCodes).sort(),
		event: entry.event || 'Weather Alert',
		areaDesc: entry.areaDesc,
		changedAt,
		changeType,
		severity: entry.severity || null,
		category,
		isMajor: isMajorImpactAlertEvent(entry.event || '', entry.severity || '', impactCategories),
		previousExpires: previousExpires ?? null,
		nextExpires: nextExpires ?? null,
	};
}

function countActiveAlertsByState(snapshot: AlertLifecycleSnapshot): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of Object.values(snapshot)) {
		for (const stateCode of entry.stateCodes) {
			if (!counts[stateCode]) counts[stateCode] = 0;
			counts[stateCode] += 1;
		}
	}
	return counts;
}

function diffAlertLifecycleSnapshots(
	currentMap: Record<string, any>,
	previousSnapshot: AlertLifecycleSnapshot | null,
): AlertLifecycleDiffResult {
	const changedAt = new Date().toISOString();
	const currentSnapshot: AlertLifecycleSnapshot = {};
	for (const [fallbackId, feature] of Object.entries(currentMap)) {
		const alertId = String((feature as any)?.id ?? fallbackId ?? '');
		if (!alertId) continue;
		const previousEntry = previousSnapshot?.[alertId] || null;
		currentSnapshot[alertId] = createLifecycleSnapshotEntry(alertId, feature, previousEntry);
	}

	if (!previousSnapshot) {
		return {
			currentSnapshot,
			changes: [],
			isInitialSnapshot: true,
		};
	}

	const changes: AlertChangeRecord[] = [];

	for (const [alertId, currentEntry] of Object.entries(currentSnapshot)) {
		const previousEntry = previousSnapshot[alertId];
		if (!previousEntry) {
			currentEntry.lastChangeType = 'new';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'new',
					null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		if (hasAlertBeenExtended(previousEntry, currentEntry)) {
			currentEntry.lastChangeType = 'extended';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'extended',
					previousEntry.expires || null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		if (hasAlertBeenUpdated(previousEntry, currentEntry)) {
			currentEntry.lastChangeType = 'updated';
			currentEntry.lastChangedAt = changedAt;
			changes.push(
				createAlertChangeRecord(
					currentEntry,
					changedAt,
					'updated',
					previousEntry.expires || null,
					currentEntry.expires || null,
				),
			);
			continue;
		}

		currentEntry.lastChangeType = previousEntry.lastChangeType || null;
		currentEntry.lastChangedAt = previousEntry.lastChangedAt || null;
	}

	for (const [alertId, previousEntry] of Object.entries(previousSnapshot)) {
		if (currentSnapshot[alertId]) continue;
		changes.push(
			createAlertChangeRecord(
				previousEntry,
				changedAt,
				'expired',
				previousEntry.expires || null,
				null,
			),
		);
	}

	const previousCountsByState = countActiveAlertsByState(previousSnapshot);
	const currentCountsByState = countActiveAlertsByState(currentSnapshot);
	const stateCodes = dedupeStrings([
		...Object.keys(previousCountsByState),
		...Object.keys(currentCountsByState),
	]);

	for (const stateCode of stateCodes) {
		const previousCount = previousCountsByState[stateCode] || 0;
		const currentCount = currentCountsByState[stateCode] || 0;
		if (previousCount <= 0 || currentCount > 0) continue;
		changes.push({
			alertId: `all-clear:${stateCode}`,
			stateCodes: [stateCode],
			countyCodes: [],
			event: 'All Clear',
			areaDesc: stateCodeDisplayName(stateCode),
			changedAt,
			changeType: 'all_clear',
			severity: null,
			category: null,
			isMajor: true,
			previousExpires: null,
			nextExpires: null,
		});
	}

	return {
		currentSnapshot,
		changes,
		isInitialSnapshot: false,
	};
}

function latestLifecycleStatusByAlertId(snapshot: AlertLifecycleSnapshot): Record<string, AlertChangeType | null> {
	const map: Record<string, AlertChangeType | null> = {};
	for (const [alertId, entry] of Object.entries(snapshot)) {
		map[alertId] = entry.lastChangeType || null;
	}
	return map;
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
		const detailUrl = alertId
			? canonicalAlertDetailUrl(alertId)
			: `/alerts?state=${encodeURIComponent(stateCode)}`;
		const fallbackUrl = `/alerts?state=${encodeURIComponent(stateCode)}`;
		return {
			title: `${event} - ${stateName}`,
			body: truncateText(headline || areaDesc || 'Tap for details.', 140),
			url: detailUrl,
			detailUrl,
			fallbackUrl,
			tag: alertId ? `alert-${alertId}` : `state-${stateCode}-latest`,
			stateCode,
			alertId,
			changeType: 'new',
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
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
		url: `/alerts?state=${encodeURIComponent(stateCode)}`,
		fallbackUrl: '/alerts',
		tag: `state-${stateCode}-group`,
		stateCode,
		changeType: 'new',
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
	};
}

function buildTestPushMessageData(stateCode: string, scopeCount: number): Record<string, any> {
	return {
		title: 'Live Weather Alerts test notification',
		body:
			scopeCount > 1
				? `Notifications are active for ${scopeCount} scopes.`
				: `Notifications are active for ${stateCode}.`,
		url: '/settings',
		fallbackUrl: `/alerts?state=${encodeURIComponent(stateCode)}`,
		tag: `test-${stateCode}`,
		stateCode,
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
		test: true,
	};
}

type LifecyclePushEntry = {
	change: AlertChangeRecord;
	feature?: any;
};

function buildLifecyclePushMessageData(stateCode: string, entries: LifecyclePushEntry[]): Record<string, any> {
	const stateName = stateCodeDisplayName(stateCode);
	const usableEntries = entries.filter((entry) => !!entry.change);
	if (usableEntries.length === 0) {
		return {
			title: `Weather alert update - ${stateName}`,
			body: 'Tap to review recent alert updates.',
			url: `/alerts?state=${encodeURIComponent(stateCode)}`,
			fallbackUrl: '/alerts',
			tag: `state-${stateCode}-lifecycle`,
			stateCode,
			changeType: 'grouped',
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
		};
	}

	if (usableEntries.length === 1) {
		const entry = usableEntries[0];
		const changeType = entry.change.changeType;
		if (changeType === 'all_clear') {
			return {
				title: `All clear - ${stateName}`,
				body: 'Active alerts have cleared for this area.',
				url: `/alerts?state=${encodeURIComponent(stateCode)}`,
				fallbackUrl: '/alerts',
				tag: `state-${stateCode}-all-clear`,
				stateCode,
				changeType: 'all_clear',
				icon: NOTIFICATION_ICON_PATH,
				badge: NOTIFICATION_BADGE_PATH,
			};
		}

		const feature = entry.feature ?? {};
		const properties = feature?.properties ?? {};
		const alertId = String(feature?.id ?? properties?.id ?? entry.change.alertId ?? '');
		const event = String(properties.event ?? entry.change.event ?? 'Weather Alert');
		const headline = String(properties.headline ?? '').trim();
		const areaDesc = String(properties.areaDesc ?? entry.change.areaDesc ?? '').trim();
		const detailUrl = alertId
			? canonicalAlertDetailUrl(alertId)
			: `/alerts?state=${encodeURIComponent(stateCode)}`;
		const changeLabel =
			changeType === 'extended'
				? 'extended'
				: changeType === 'updated'
					? 'updated'
					: changeType;

		return {
			title: `${event} ${changeLabel} - ${stateName}`,
			body: truncateText(headline || areaDesc || 'Tap for details.', 140),
			url: detailUrl,
			detailUrl,
			fallbackUrl: `/alerts?state=${encodeURIComponent(stateCode)}`,
			tag: alertId ? `alert-${alertId}-${changeType}` : `state-${stateCode}-${changeType}`,
			stateCode,
			alertId: alertId || undefined,
			changeType,
			icon: NOTIFICATION_ICON_PATH,
			badge: NOTIFICATION_BADGE_PATH,
		};
	}

	const counts: Record<AlertChangeType, number> = {
		new: 0,
		updated: 0,
		extended: 0,
		expired: 0,
		all_clear: 0,
	};
	for (const entry of usableEntries) {
		counts[entry.change.changeType] += 1;
	}

	const bodyParts: string[] = [];
	if (counts.new > 0) bodyParts.push(`${counts.new} new`);
	if (counts.updated > 0) bodyParts.push(`${counts.updated} updated`);
	if (counts.extended > 0) bodyParts.push(`${counts.extended} extended`);
	if (counts.expired > 0) bodyParts.push(`${counts.expired} expired`);
	if (counts.all_clear > 0) bodyParts.push(`${counts.all_clear} all clear`);
	if (bodyParts.length === 0) bodyParts.push(`${usableEntries.length} lifecycle updates`);

	const uniqueTypes = Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([type]) => type);

	return {
		title: `${usableEntries.length} alert changes - ${stateName}`,
		body: truncateText(`Includes ${bodyParts.join(', ')}. Tap to review now.`, 140),
		url: `/alerts?state=${encodeURIComponent(stateCode)}`,
		fallbackUrl: '/alerts',
		tag: `state-${stateCode}-group`,
		stateCode,
		changeType: uniqueTypes.length === 1 ? uniqueTypes[0] : 'grouped',
		changes: usableEntries.slice(0, 8).map((entry) => ({
			alertId: entry.change.alertId,
			changeType: entry.change.changeType,
		})),
		icon: NOTIFICATION_ICON_PATH,
		badge: NOTIFICATION_BADGE_PATH,
	};
}

function changeMatchesScope(change: AlertChangeRecord, scope: PushScope): boolean {
	if (!scope.enabled) return false;
	const scopeStateCode = normalizeStateCode(scope.stateCode);
	if (!scopeStateCode || !change.stateCodes.includes(scopeStateCode)) return false;
	if (!alertMatchesTypePrefs(change.event, scope.alertTypes)) return false;
	if (scope.severeOnly && !isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', ''))) {
		return false;
	}
	if (scope.deliveryScope !== 'county') return true;

	const targetCountyFips = normalizeCountyFips(scope.countyFips);
	if (targetCountyFips) {
		return change.countyCodes.includes(targetCountyFips);
	}
	const countyName = cleanCountyToken(String(scope.countyName || ''));
	if (!countyName) return false;
	return cleanCountyToken(change.areaDesc).includes(countyName);
}

function shouldSendAllClearNotification(stateChanges: AlertChangeRecord[]): boolean {
	const hasAllClear = stateChanges.some((change) => change.changeType === 'all_clear');
	if (!hasAllClear) return false;
	return stateChanges.some(
		(change) =>
			change.changeType === 'expired'
			&& isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', '')),
	);
}

function batchLifecycleEntriesForDeliveryMode(
	deliveryMode: PushDeliveryMode,
	entries: LifecyclePushEntry[],
): LifecyclePushEntry[][] {
	const usableEntries = entries.filter((entry) => !!entry.change);
	if (usableEntries.length === 0) return [];
	if (deliveryMode === 'digest') {
		return [usableEntries];
	}
	return usableEntries.map((entry) => [entry]);
}

async function sendPushPayload(
	vapid: VapidKeys,
	subscription: WebPushSubscription,
	data: Record<string, unknown>,
	topic: string,
): Promise<Response> {
	const message: PushMessage = {
		data,
		options: { ttl: 900, urgency: 'high', topic },
	};
	const payload = await buildPushPayload(message, subscription, vapid);
	return await fetch(subscription.endpoint, payload);
}

async function sendPushForState(
	env: Env,
	vapid: VapidKeys,
	stateCode: string,
	stateChanges: AlertChangeRecord[],
	map: Record<string, any>,
): Promise<void> {
	if (stateChanges.length === 0) return;
	const subscriptionIds = await readPushStateIndex(env, stateCode);
	if (subscriptionIds.length === 0) return;

	for (const subscriptionId of subscriptionIds) {
		const record = await readPushSubscriptionRecordById(env, subscriptionId);
		if (!record) {
			await recordInvalidSubscription(
				env,
				`push_state_missing_record_${stateCode}_${subscriptionId.slice(0, 12)}`,
			);
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
			continue;
		}
		if (!record.indexedStateCodes.includes(stateCode)) {
			await recordInvalidSubscription(
				env,
				`push_state_stale_index_${stateCode}_${subscriptionId.slice(0, 12)}`,
			);
			await removePushIdFromStateIndex(env, stateCode, subscriptionId);
			continue;
		}

		const prefs = record.prefs;
		const now = new Date();
		if (isDeliveryPaused(prefs, now)) {
			continue;
		}

		const matchingScopes = prefs.scopes.filter(
			(scope) => scope.enabled && normalizeStateCode(scope.stateCode) === stateCode,
		);
		if (matchingScopes.length === 0) {
			continue;
		}

		const isQuietHoursActive = isWithinQuietHours(now, prefs);
		const allowAllClearPush = shouldSendAllClearNotification(stateChanges);
		const matchingEntries: LifecyclePushEntry[] = [];
		for (const change of stateChanges) {
			if (change.changeType === 'all_clear') {
				if (!allowAllClearPush) continue;
				const stateScopeEnabled = matchingScopes.some((scope) => scope.deliveryScope === 'state');
				if (!stateScopeEnabled) continue;
				if (isQuietHoursActive) continue;
				matchingEntries.push({ change });
				continue;
			}

			if (change.changeType === 'expired') {
				if (prefs.deliveryMode !== 'digest') continue;
				if (!isMajorImpactAlertEvent(change.event, '', deriveAlertImpactCategories(change.event, '', ''))) {
					continue;
				}
				const matchedScope = matchingScopes.find((scope) => changeMatchesScope(change, scope));
				if (!matchedScope) continue;
				if (isQuietHoursActive) continue;
				matchingEntries.push({ change });
				continue;
			}

			const feature = map[change.alertId];
			if (!feature) continue;

			const matchedScope = matchingScopes.find((scope) =>
				featureMatchesScope(feature, stateCode, scope),
			);
			if (!matchedScope) continue;

			if (isQuietHoursActive && !alertBypassesQuietHours(feature)) {
				continue;
			}

			matchingEntries.push({ change, feature });
		}

		if (matchingEntries.length === 0) {
			continue;
		}

		const payloadBatches = batchLifecycleEntriesForDeliveryMode(
			prefs.deliveryMode,
			matchingEntries,
		);
		for (const [batchIndex, batch] of payloadBatches.entries()) {
			const payloadData = buildLifecyclePushMessageData(stateCode, batch);
			const firstChangeType = String(batch[0]?.change?.changeType || 'grouped');
			const topic =
				prefs.deliveryMode === 'digest'
					? `state-${stateCode}-digest`
					: `state-${stateCode}-${firstChangeType}-${batchIndex + 1}`;

			try {
				const response = await sendPushPayload(
					vapid,
					record.subscription,
					payloadData,
					topic,
				);

				// Endpoint is gone — clean up to avoid repeated failures.
				if (response.status === 404 || response.status === 410) {
					await removePushSubscriptionById(env, subscriptionId);
					await recordInvalidSubscription(
						env,
						`push_endpoint_gone_${stateCode}_${response.status}`,
					);
					break;
				}
				if (!response.ok) {
					const body = await response.text().catch(() => '');
					await recordPushDeliveryFailure(env, {
						stateCode,
						subscriptionId,
						status: response.status,
						message: body || `push_send_failed_${response.status}`,
					});
					console.log(`[push] send failed state=${stateCode} status=${response.status} body=${body.slice(0, 240)}`);
				}
			} catch (err) {
				await recordPushDeliveryFailure(env, {
					stateCode,
					subscriptionId,
					message: String(err),
				});
				console.log(`[push] send exception state=${stateCode} err=${String(err)}`);
				// Ignore transient send failures and retry on the next schedule cycle.
			}
		}
	}
}

async function dispatchStatePushNotifications(
	env: Env,
	map: Record<string, any>,
	changes: AlertChangeRecord[],
): Promise<void> {
	const vapid = getVapidKeys(env);
	if (!vapid) return;
	if (changes.length === 0) {
		await writePushStateAlertSnapshot(env, buildStateAlertSnapshot(map));
		return;
	}

	const changesByState: Record<string, AlertChangeRecord[]> = {};
	for (const change of changes) {
		for (const stateCode of change.stateCodes) {
			if (!changesByState[stateCode]) changesByState[stateCode] = [];
			changesByState[stateCode].push(change);
		}
	}

	for (const [stateCode, stateChanges] of Object.entries(changesByState)) {
		await sendPushForState(env, vapid, stateCode, stateChanges, map);
	}

	await writePushStateAlertSnapshot(env, buildStateAlertSnapshot(map));
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

function normalizeIsoOrNull(value: unknown): string | null {
	const text = String(value || '').trim();
	if (!text) return null;
	const parsed = Date.parse(text);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed).toISOString();
}

function parseNonNegativeNumber(value: unknown, fallback = 0): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function defaultOperationalDiagnostics(): OperationalDiagnostics {
	return {
		lastSyncAttemptAt: null,
		lastSuccessfulSyncAt: null,
		lastSyncError: null,
		lastKnownAlertCount: 0,
		lastStaleDataAt: null,
		lastStaleMinutes: null,
		invalidSubscriptionCount: 0,
		lastInvalidSubscriptionAt: null,
		lastInvalidSubscriptionReason: null,
		pushFailureCount: 0,
		recentPushFailures: [],
	};
}

function normalizePushFailureDiagnostic(value: unknown): PushFailureDiagnostic | null {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== 'object') return null;
	const at = normalizeIsoOrNull(input.at);
	const stateCode = normalizeStateCode(input.stateCode) || String(input.stateCode || '').trim().toUpperCase();
	const message = String(input.message || '').trim();
	if (!at || !stateCode || !message) return null;
	const statusNumber = Number(input.status);
	const status = Number.isFinite(statusNumber) ? statusNumber : undefined;
	const subscriptionId = String(input.subscriptionId || '').trim() || null;
	return {
		at,
		stateCode,
		status,
		subscriptionId,
		message: truncateText(message, 240),
	};
}

function normalizeOperationalDiagnostics(value: unknown): OperationalDiagnostics {
	const input = value as Record<string, unknown> | null;
	if (!input || typeof input !== 'object') {
		return defaultOperationalDiagnostics();
	}

	const recentPushFailuresRaw = Array.isArray(input.recentPushFailures)
		? input.recentPushFailures
		: [];
	const recentPushFailures = recentPushFailuresRaw
		.map((item) => normalizePushFailureDiagnostic(item))
		.filter((item): item is PushFailureDiagnostic => !!item)
		.slice(0, MAX_RECENT_PUSH_FAILURES);

	return {
		lastSyncAttemptAt: normalizeIsoOrNull(input.lastSyncAttemptAt),
		lastSuccessfulSyncAt: normalizeIsoOrNull(input.lastSuccessfulSyncAt),
		lastSyncError: String(input.lastSyncError || '').trim() || null,
		lastKnownAlertCount: parseNonNegativeNumber(input.lastKnownAlertCount),
		lastStaleDataAt: normalizeIsoOrNull(input.lastStaleDataAt),
		lastStaleMinutes: Number.isFinite(Number(input.lastStaleMinutes))
			? parseNonNegativeNumber(input.lastStaleMinutes)
			: null,
		invalidSubscriptionCount: parseNonNegativeNumber(input.invalidSubscriptionCount),
		lastInvalidSubscriptionAt: normalizeIsoOrNull(input.lastInvalidSubscriptionAt),
		lastInvalidSubscriptionReason:
			String(input.lastInvalidSubscriptionReason || '').trim() || null,
		pushFailureCount: parseNonNegativeNumber(input.pushFailureCount),
		recentPushFailures,
	};
}

async function readOperationalDiagnostics(env: Env): Promise<OperationalDiagnostics> {
	try {
		const raw = await env.WEATHER_KV.get(KV_OPERATIONAL_DIAGNOSTICS);
		if (!raw) return defaultOperationalDiagnostics();
		const parsed = JSON.parse(raw) as unknown;
		return normalizeOperationalDiagnostics(parsed);
	} catch {
		return defaultOperationalDiagnostics();
	}
}

async function writeOperationalDiagnostics(
	env: Env,
	diagnostics: OperationalDiagnostics,
): Promise<void> {
	await env.WEATHER_KV.put(
		KV_OPERATIONAL_DIAGNOSTICS,
		JSON.stringify(normalizeOperationalDiagnostics(diagnostics)),
	);
}

async function updateOperationalDiagnostics(
	env: Env,
	updater: (current: OperationalDiagnostics) => OperationalDiagnostics,
): Promise<OperationalDiagnostics> {
	const current = await readOperationalDiagnostics(env);
	const next = normalizeOperationalDiagnostics(updater(current));
	await writeOperationalDiagnostics(env, next);
	return next;
}

async function recordSyncAttempt(env: Env): Promise<void> {
	const nowIso = new Date().toISOString();
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncAttemptAt: nowIso,
	}));
}

async function recordSyncSuccess(env: Env, activeAlertCount: number): Promise<void> {
	const nowIso = new Date().toISOString();
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncAttemptAt: nowIso,
		lastSuccessfulSyncAt: nowIso,
		lastSyncError: null,
		lastKnownAlertCount: Math.max(0, Math.floor(activeAlertCount)),
	}));
}

async function recordSyncFailure(env: Env, message: string): Promise<void> {
	const trimmed = truncateText(String(message || 'Unknown sync failure.'), 240);
	console.error(`[ops] sync failure: ${trimmed}`);
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		lastSyncError: trimmed,
	}));
}

async function recordStaleDataCondition(
	env: Env,
	staleMinutes: number,
	reason: string,
): Promise<void> {
	if (!Number.isFinite(staleMinutes) || staleMinutes < 15) return;
	const nowMs = Date.now();
	await updateOperationalDiagnostics(env, (current) => {
		const previousAt = current.lastStaleDataAt ? Date.parse(current.lastStaleDataAt) : Number.NaN;
		const previousMinutes = current.lastStaleMinutes ?? -1;
		const withinCooldown = Number.isFinite(previousAt) && (nowMs - previousAt) < 10 * 60 * 1000;
		if (withinCooldown && previousMinutes === Math.floor(staleMinutes)) {
			return current;
		}
		console.warn(
			`[ops] stale-data condition minutes=${Math.floor(staleMinutes)} reason=${truncateText(reason, 120)}`,
		);
		return {
			...current,
			lastStaleDataAt: new Date(nowMs).toISOString(),
			lastStaleMinutes: Math.floor(staleMinutes),
		};
	});
}

async function recordInvalidSubscription(env: Env, reason: string): Promise<void> {
	const nowIso = new Date().toISOString();
	const normalizedReason = truncateText(String(reason || 'invalid_subscription'), 180);
	console.warn(`[ops] invalid subscription: ${normalizedReason}`);
	await updateOperationalDiagnostics(env, (current) => ({
		...current,
		invalidSubscriptionCount: current.invalidSubscriptionCount + 1,
		lastInvalidSubscriptionAt: nowIso,
		lastInvalidSubscriptionReason: normalizedReason,
	}));
}

async function recordPushDeliveryFailure(
	env: Env,
	input: {
		stateCode: string;
		subscriptionId?: string;
		status?: number;
		message: string;
	},
): Promise<void> {
	const stateCode = normalizeStateCode(input.stateCode) || String(input.stateCode || '').trim().toUpperCase() || 'US';
	const status = Number.isFinite(Number(input.status)) ? Number(input.status) : undefined;
	const message = truncateText(String(input.message || 'Push delivery failed.'), 240);
	console.warn(
		`[ops] push delivery failure state=${stateCode}${status ? ` status=${status}` : ''} msg=${message}`,
	);
	await updateOperationalDiagnostics(env, (current) => {
		const nextFailure: PushFailureDiagnostic = {
			at: new Date().toISOString(),
			stateCode,
			status,
			subscriptionId: input.subscriptionId || null,
			message,
		};
		return {
			...current,
			pushFailureCount: current.pushFailureCount + 1,
			recentPushFailures: [
				nextFailure,
				...current.recentPushFailures,
			].slice(0, MAX_RECENT_PUSH_FAILURES),
		};
	});
}

function staleMinutesFromLastPoll(lastPoll: string | null): number {
	const lastPollMs = lastPoll ? Date.parse(lastPoll) : Number.NaN;
	if (!Number.isFinite(lastPollMs)) return 0;
	return Math.max(0, Math.floor((Date.now() - lastPollMs) / 60_000));
}

function isLocalDevRequest(request: Request): boolean {
	try {
		const { hostname } = new URL(request.url);
		return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
	} catch {
		return false;
	}
}

function shouldAutoRefreshStaleAlertsInLocalDev(
	request: Request,
	lastPoll: string | null,
): boolean {
	if (!isLocalDevRequest(request)) return false;
	return staleMinutesFromLastPoll(lastPoll) >= 15;
}

async function countPushSubscriptionRecords(env: Env): Promise<number> {
	let count = 0;
	let cursor: string | undefined;
	do {
		const page = await env.WEATHER_KV.list({
			prefix: KV_PUSH_SUB_PREFIX,
			limit: 1000,
			cursor,
		});
		count += page.keys.length;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	return count;
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
	await recordSyncAttempt(env);
	const result = await pollNWS(env);

	if (!result.changed) {
		// Either 304 or a transient error — return what we have in KV
		const map = pruneExpired(await readAlertMap(env));
		await writeAlertMap(env, map);
		const syncError = (result as { error?: string }).error;
		if (syncError) {
			await recordSyncFailure(env, syncError);
			const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
			const staleMinutes = staleMinutesFromLastPoll(lastPoll ?? null);
			await recordStaleDataCondition(env, staleMinutes, 'sync_alerts_cached_fallback');
			return { map, error: syncError };
		}

		const nowIso = new Date().toISOString();
		await Promise.all([
			env.WEATHER_KV.put(KV_LAST_POLL, nowIso),
			recordSyncSuccess(env, Object.keys(map).length),
		]);
		return { map };
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
		recordSyncSuccess(env, Object.keys(pruned).length),
	]);

	return { map: pruned };
}

async function syncAlertLifecycleState(
	env: Env,
	map: Record<string, any>,
): Promise<AlertLifecycleDiffResult> {
	const previousSnapshot = await readAlertLifecycleSnapshot(env);
	const diffResult = diffAlertLifecycleSnapshots(map, previousSnapshot);
	await writeAlertLifecycleSnapshot(env, diffResult.currentSnapshot);
	if (!diffResult.isInitialSnapshot && diffResult.changes.length > 0) {
		await appendAlertChangeRecords(env, diffResult.changes);
	}
	return diffResult;
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
	const allowedOrigin = origin === PRIMARY_APP_ORIGIN ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

function pushCorsHeaders(origin?: string | null): Headers {
	const allowedOrigin = origin === PRIMARY_APP_ORIGIN ? origin : '*';
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		'Vary': 'Origin',
	});
}

function debugCorsHeaders(origin?: string | null): Headers {
	const isAllowedOrigin = origin === PRIMARY_APP_ORIGIN || origin === WWW_APP_ORIGIN;
	const allowedOrigin = isAllowedOrigin ? origin : PRIMARY_APP_ORIGIN;
	return new Headers({
		'Access-Control-Allow-Origin': allowedOrigin,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

	const subscription = body?.subscription as WebPushSubscription;
	if (!isValidPushSubscription(subscription)) {
		await recordInvalidSubscription(env, 'subscribe_invalid_payload');
		return new Response(JSON.stringify({ error: 'Invalid push subscription payload.' }), { status: 400, headers });
	}

	const requestedStateCode =
		normalizeStateCode(body?.stateCode || body?.state)
		|| normalizeStateCode(body?.prefs?.stateCode)
		|| normalizeStateCode(body?.prefs?.scopes?.[0]?.stateCode);
	if (!requestedStateCode && !body?.prefs) {
		await recordInvalidSubscription(env, 'subscribe_missing_scope');
		return new Response(JSON.stringify({ error: 'A valid US state code or push scope is required.' }), { status: 400, headers });
	}

	const record = await upsertPushSubscriptionRecord(
		env,
		subscription,
		request.headers.get('user-agent') || undefined,
		requestedStateCode || undefined,
		body?.prefs,
	);
	const responseStateCode = firstStateCodeFromPreferences(record.prefs);

	const payload: Record<string, unknown> = {
		ok: true,
		subscriptionId: record.id,
		prefs: record.prefs,
		indexedStateCodes: record.indexedStateCodes,
	};
	if (responseStateCode) {
		payload.stateCode = responseStateCode;
	}

	return new Response(JSON.stringify(payload), { status: 200, headers });
}

async function handlePushTest(request: Request, env: Env): Promise<Response> {
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

	const subscription = body?.subscription as WebPushSubscription;
	if (!isValidPushSubscription(subscription)) {
		await recordInvalidSubscription(env, 'push_test_invalid_payload');
		return new Response(JSON.stringify({ error: 'Invalid push subscription payload.' }), { status: 400, headers });
	}

	const requestedStateCode =
		normalizeStateCode(body?.stateCode || body?.state)
		|| normalizeStateCode(body?.prefs?.stateCode)
		|| normalizeStateCode(body?.prefs?.scopes?.[0]?.stateCode)
		|| 'KY';
	const prefs = normalizePushPreferences(body?.prefs, requestedStateCode);
	const stateCode = firstStateCodeFromPreferences(prefs) || requestedStateCode;
	const enabledScopeCount = prefs.scopes.filter((scope) => scope.enabled).length;
	const payloadData = buildTestPushMessageData(
		stateCode,
		enabledScopeCount > 0 ? enabledScopeCount : prefs.scopes.length,
	);

	try {
		const response = await sendPushPayload(
			vapid,
			subscription,
			payloadData,
			`test-${stateCode}`,
		);
		if (response.status === 404 || response.status === 410) {
			await removePushSubscriptionByEndpoint(env, subscription.endpoint);
			await recordInvalidSubscription(
				env,
				`push_test_endpoint_gone_${response.status}`,
			);
			return new Response(
				JSON.stringify({
					error: 'Push subscription is no longer valid. Please resubscribe.',
				}),
				{ status: 410, headers },
			);
		}
		if (!response.ok) {
			const bodyText = await response.text().catch(() => '');
			await recordPushDeliveryFailure(env, {
				stateCode,
				status: response.status,
				message: `push_test_failed_${response.status}`,
			});
			return new Response(
				JSON.stringify({
					error: `Test push failed (${response.status}). ${bodyText.slice(0, 160)}`.trim(),
				}),
				{ status: 502, headers },
			);
		}
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unable to send test push.';
		await recordPushDeliveryFailure(env, {
			stateCode,
			message: `push_test_exception_${message}`,
		});
		return new Response(JSON.stringify({ error: message }), { status: 502, headers });
	}
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

function classifyAlertCategoryFromEvent(event: string): string {
	const normalized = String(event || '').toLowerCase();
	if (normalized.includes('warning')) return 'warning';
	if (normalized.includes('watch')) return 'watch';
	if (normalized.includes('advisory')) return 'advisory';
	if (normalized.includes('statement')) return 'statement';
	return 'other';
}

function deriveAlertImpactCategories(
	event: string,
	headline: string,
	description: string,
): AlertImpactCategory[] {
	const text = `${String(event || '')} ${String(headline || '')} ${String(description || '')}`
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();

	const categories: AlertImpactCategory[] = [];
	const addCategory = (value: AlertImpactCategory) => {
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

function isMajorImpactAlertEvent(
	event: string,
	severity: string,
	impactCategories: AlertImpactCategory[] = [],
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

function compactAlertText(value: string): string {
	return String(value || '')
		.replace(/\r\n/g, '\n')
		.replace(/\s+/g, ' ')
		.trim();
}

function firstAlertSentence(value: string): string {
	const normalized = formatAlertDescription(String(value || ''));
	const lines = normalized
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const withoutLabel = line
			.replace(/^[A-Z][A-Z/\s]{2,40}:\s*/i, '')
			.replace(/^\*\s*/, '')
			.trim();
		if (withoutLabel) {
			return withoutLabel;
		}
	}

	return '';
}

function deriveAlertSummary(headline: string, description: string): string {
	const explicitHeadline = compactAlertText(headline);
	if (explicitHeadline) return truncateText(explicitHeadline, 220);
	const fromDescription = compactAlertText(firstAlertSentence(description));
	if (fromDescription) return truncateText(fromDescription, 220);
	return 'Review details for location and timing.';
}

function deriveInstructionsSummary(instruction: string, description: string): string {
	const explicitInstruction = compactAlertText(firstAlertSentence(instruction));
	if (explicitInstruction) return truncateText(explicitInstruction, 220);
	const fallback = compactAlertText(firstAlertSentence(description));
	if (fallback) return truncateText(fallback, 220);
	return '';
}

function canonicalAlertDetailUrl(alertId: string): string {
	const normalizedId = String(alertId || '').trim();
	if (!normalizedId) return '/alerts';
	return `/alerts/${encodeURIComponent(normalizedId)}`;
}

function collectGeometryCoordinatePairs(geometry: any): Array<[number, number]> {
	const pairs: Array<[number, number]> = [];
	if (!geometry || typeof geometry !== 'object') return pairs;

	const pushPair = (candidate: any) => {
		if (!Array.isArray(candidate) || candidate.length < 2) return;
		const lon = Number(candidate[0]);
		const lat = Number(candidate[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
		if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
		pairs.push([lat, lon]);
	};

	const visit = (node: any) => {
		if (!Array.isArray(node)) return;
		if (node.length >= 2 && typeof node[0] !== 'object' && typeof node[1] !== 'object') {
			pushPair(node);
			return;
		}
		for (const child of node) {
			visit(child);
		}
	};

	visit(geometry.coordinates);
	return pairs;
}

function centroidFromGeometry(feature: any): { lat?: number; lon?: number } {
	const pairs = collectGeometryCoordinatePairs(feature?.geometry);
	if (pairs.length === 0) return {};
	const [latTotal, lonTotal] = pairs.reduce(
		(acc, [lat, lon]) => [acc[0] + lat, acc[1] + lon],
		[0, 0],
	);
	return {
		lat: Number((latTotal / pairs.length).toFixed(4)),
		lon: Number((lonTotal / pairs.length).toFixed(4)),
	};
}

function normalizeAlertFeature(
	feature: any,
	lifecycleByAlertId?: Record<string, AlertChangeType | null>,
) {
	const p = feature?.properties ?? {};
	const id = String(feature?.id ?? p.id ?? '');
	const event = String(p.event ?? '');
	const headline = String(p.headline ?? '');
	const description = String(p.description ?? '');
	const instruction = String(p.instruction ?? '');
	const location = centroidFromGeometry(feature);
	const lifecycleStatus = lifecycleByAlertId?.[id] || null;
	const impactCategories = deriveAlertImpactCategories(event, headline, description);
	const isMajor = isMajorImpactAlertEvent(event, String(p.severity ?? ''), impactCategories);
	return {
		id,
		stateCode: extractStateCode(feature),
		category: classifyAlertCategoryFromEvent(event),
		impactCategories,
		isMajor,
		detailUrl: canonicalAlertDetailUrl(id),
		summary: deriveAlertSummary(headline, description),
		instructionsSummary: deriveInstructionsSummary(instruction, description),
		lifecycleStatus,
		lat: location.lat ?? null,
		lon: location.lon ?? null,
		event,
		areaDesc: String(p.areaDesc ?? ''),
		severity: String(p.severity ?? ''),
		status: String(p.status ?? ''),
		urgency: String(p.urgency ?? ''),
		certainty: String(p.certainty ?? ''),
		headline,
		description,
		instruction,
		sent: String(p.sent ?? ''),
		effective: String(p.effective ?? ''),
		onset: String(p.onset ?? ''),
		expires: String(p.expires ?? ''),
		updated: String(p.updated ?? ''),
		nwsUrl: String(p['@id'] ?? p.url ?? ''),
		ugc: Array.isArray(p.geocode?.UGC) ? p.geocode.UGC : [],
	};
}

function buildAlertsMeta(input: {
	lastPoll: string | null;
	syncError?: string | null;
	count: number;
}) {
	const generatedAt = new Date().toISOString();
	const staleMinutes = staleMinutesFromLastPoll(input.lastPoll);
	return {
		lastPoll: input.lastPoll,
		generatedAt,
		syncError: input.syncError ?? null,
		stale: staleMinutes >= 15,
		staleMinutes,
		count: input.count,
	};
}

async function handleApiAlerts(request: Request, env: Env): Promise<Response> {
	let map = await readAlertMap(env);
	let error: string | undefined;
	const lastPollBefore = await env.WEATHER_KV.get(KV_LAST_POLL);
	if (
		Object.keys(map).length === 0
		|| shouldAutoRefreshStaleAlertsInLocalDev(request, lastPollBefore ?? null)
	) {
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		error = syncResult.error;
	}
	const lifecycleSnapshot = await readAlertLifecycleSnapshot(env);
	const lifecycleByAlertId = lifecycleSnapshot
		? latestLifecycleStatusByAlertId(lifecycleSnapshot)
		: {};
	const alerts = Object.values(map).map((feature: any) =>
		normalizeAlertFeature(feature, lifecycleByAlertId),
	);
	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const meta = buildAlertsMeta({
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
		count: alerts.length,
	});
	await recordStaleDataCondition(env, meta.staleMinutes, 'api_alerts_response');
	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};
	return new Response(JSON.stringify({
		alerts,
		meta,
		generatedAt: meta.generatedAt,
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
	}), {
		status: 200,
		headers,
	});
}

async function handleApiAlertDetail(request: Request, env: Env, alertId: string): Promise<Response> {
	let map = await readAlertMap(env);
	let error: string | undefined;
	const lastPollBefore = await env.WEATHER_KV.get(KV_LAST_POLL);
	if (
		Object.keys(map).length === 0
		|| shouldAutoRefreshStaleAlertsInLocalDev(request, lastPollBefore ?? null)
	) {
		const syncResult = await syncAlerts(env);
		map = syncResult.map;
		error = syncResult.error;
	}

	const directMatch = map[alertId];
	const fallbackMatch = directMatch
		? directMatch
		: Object.values(map).find((feature: any) => {
			const p = feature?.properties ?? {};
			const id = String(feature?.id ?? p.id ?? '');
			return id === alertId;
		});

	const headers = {
		...corsHeaders(),
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
	};

	if (!fallbackMatch) {
		return new Response(JSON.stringify({ error: 'Alert not found.' }), {
			status: 404,
			headers,
		});
	}

	const lastPoll = await env.WEATHER_KV.get(KV_LAST_POLL);
	const meta = buildAlertsMeta({
		lastPoll: lastPoll ?? null,
		syncError: error ?? null,
		count: 1,
	});
	await recordStaleDataCondition(env, meta.staleMinutes, 'api_alert_detail_response');
	const lifecycleSnapshot = await readAlertLifecycleSnapshot(env);
	const lifecycleByAlertId = lifecycleSnapshot
		? latestLifecycleStatusByAlertId(lifecycleSnapshot)
		: {};

	return new Response(JSON.stringify({
		alert: normalizeAlertFeature(fallbackMatch, lifecycleByAlertId),
		meta,
		generatedAt: meta.generatedAt,
		lastPoll: meta.lastPoll,
		syncError: error ?? null,
	}), {
		status: 200,
		headers,
	});
}

function normalizeHistorySeverityBucket(
	value: string,
): 'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown' {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'extreme') return 'extreme';
	if (normalized === 'severe') return 'severe';
	if (normalized === 'moderate') return 'moderate';
	if (normalized === 'minor') return 'minor';
	return 'unknown';
}

function summarizeAlertHistoryDay(
	entries: AlertHistoryEntry[],
	snapshot: AlertHistorySnapshotCounts,
): {
	totalEntries: number;
	activeAlertCount: number;
	activeWarningCount: number;
	activeMajorCount: number;
	byLifecycle: Record<AlertChangeType, number>;
	byCategory: Record<'warning' | 'watch' | 'advisory' | 'statement' | 'other', number>;
	bySeverity: Record<'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown', number>;
	topEvents: Array<{ event: string; count: number }>;
	notableWarnings: Array<{
		alertId: string;
		event: string;
		areaDesc: string;
		severity: string;
		changedAt: string;
		changeType: AlertChangeType;
	}>;
} {
	const byLifecycle: Record<AlertChangeType, number> = {
		new: 0,
		updated: 0,
		extended: 0,
		expired: 0,
		all_clear: 0,
	};
	const byCategory: Record<'warning' | 'watch' | 'advisory' | 'statement' | 'other', number> = {
		warning: 0,
		watch: 0,
		advisory: 0,
		statement: 0,
		other: 0,
	};
	const bySeverity: Record<'extreme' | 'severe' | 'moderate' | 'minor' | 'unknown', number> = {
		extreme: 0,
		severe: 0,
		moderate: 0,
		minor: 0,
		unknown: 0,
	};
	const eventCounts = new Map<string, number>();

	for (const entry of entries) {
		byLifecycle[entry.changeType] += 1;
		const category = String(entry.category || '').trim().toLowerCase();
		if (
			category === 'warning'
			|| category === 'watch'
			|| category === 'advisory'
			|| category === 'statement'
		) {
			byCategory[category] += 1;
		} else {
			byCategory.other += 1;
		}
		bySeverity[normalizeHistorySeverityBucket(entry.severity)] += 1;
		const eventKey = String(entry.event || 'Weather Alert').trim() || 'Weather Alert';
		eventCounts.set(eventKey, (eventCounts.get(eventKey) || 0) + 1);
	}

	const topEvents = Array.from(eventCounts.entries())
		.map(([event, count]) => ({ event, count }))
		.sort((a, b) => {
			if (a.count !== b.count) return b.count - a.count;
			return a.event.localeCompare(b.event);
		})
		.slice(0, 4);

	const notableWarnings = entries
		.filter((entry) => {
			const category = String(entry.category || '').trim().toLowerCase()
				|| classifyAlertCategoryFromEvent(entry.event);
			const severityBucket = normalizeHistorySeverityBucket(entry.severity);
			return category === 'warning' && (entry.isMajor || severityBucket === 'extreme' || severityBucket === 'severe');
		})
		.sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
		.slice(0, 4)
		.map((entry) => ({
			alertId: entry.alertId,
			event: entry.event,
			areaDesc: entry.areaDesc,
			severity: entry.severity,
			changedAt: entry.changedAt,
			changeType: entry.changeType,
		}));

	return {
		totalEntries: entries.length,
		activeAlertCount: snapshot.activeAlertCount,
		activeWarningCount: snapshot.activeWarningCount,
		activeMajorCount: snapshot.activeMajorCount,
		byLifecycle,
		byCategory,
		bySeverity,
		topEvents,
		notableWarnings,
	};
}

async function handleApiAlertHistory(request: Request, env: Env): Promise<Response> {
	const headers = apiCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const url = new URL(request.url);
	const stateInput = String(url.searchParams.get('state') || '').trim();
	const countyInput = String(url.searchParams.get('countyCode') || '').trim();
	const daysInput = String(url.searchParams.get('days') || '').trim();

	let stateCode: string | null = null;
	if (stateInput) {
		stateCode = normalizeStateCode(stateInput);
		if (!stateCode) {
			return new Response(JSON.stringify({ error: 'Invalid state filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let countyCode: string | null = null;
	if (countyInput) {
		countyCode = normalizeCountyFips(countyInput);
		if (!countyCode) {
			return new Response(JSON.stringify({ error: 'Invalid countyCode filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let requestedDays = 7;
	if (daysInput) {
		const parsedDays = Number(daysInput);
		if (!Number.isInteger(parsedDays) || parsedDays <= 0 || parsedDays > ALERT_HISTORY_MAX_QUERY_DAYS) {
			return new Response(
				JSON.stringify({
					error: `days must be an integer between 1 and ${ALERT_HISTORY_MAX_QUERY_DAYS}.`,
				}),
				{
					status: 400,
					headers,
				},
			);
		}
		requestedDays = parsedDays;
	}

	let historyByDay = await readAlertHistoryByDay(env);
	if (Object.keys(historyByDay).length === 0) {
		const { map } = await syncAlerts(env);
		const lifecycleDiff = await syncAlertLifecycleState(env, map);
		historyByDay = await syncAlertHistoryDailySnapshots(env, map, lifecycleDiff.changes);
	}

	const nowMs = Date.now();
	const cutoffMs = nowMs - (requestedDays * 24 * 60 * 60 * 1000);
	const dayRecords = Object.values(historyByDay)
		.map((record) => normalizeAlertHistoryDayRecord(record))
		.filter((record): record is AlertHistoryDayRecord => !!record)
		.sort((a, b) => b.day.localeCompare(a.day));

	const days = dayRecords
		.map((record) => {
			const dayMs = Date.parse(`${record.day}T00:00:00.000Z`);
			if (!Number.isFinite(dayMs)) return null;
			const dayEndsMs = dayMs + (24 * 60 * 60 * 1000);
			if (dayEndsMs < cutoffMs) return null;

			const scopedEntries = record.entries.filter((entry) => {
				const changedAtMs = Date.parse(entry.changedAt);
				if (!Number.isFinite(changedAtMs) || changedAtMs < cutoffMs) {
					return false;
				}
				if (stateCode && !entry.stateCodes.includes(stateCode)) {
					return false;
				}
				if (countyCode && !entry.countyCodes.includes(countyCode)) {
					return false;
				}
				return true;
			});

			const stateScopedSnapshot = stateCode
				? normalizeAlertHistorySnapshotCounts(record.snapshot.byState[stateCode])
				: normalizeAlertHistorySnapshotCounts(record.snapshot);

			let scopedSnapshot = stateScopedSnapshot;
			if (countyCode) {
				const countySnapshot = readAlertHistorySnapshotCountsByCounty(
					record.snapshot,
					countyCode,
					stateCode,
				);
				scopedSnapshot = countySnapshot
					? countySnapshot
					: summarizeAlertHistoryEntriesAsSnapshot(scopedEntries);
			}
			const summary = summarizeAlertHistoryDay(scopedEntries, scopedSnapshot);

			if (summary.totalEntries === 0 && summary.activeAlertCount === 0) {
				return null;
			}

			return {
				day: record.day,
				generatedAt: record.updatedAt,
				summary,
				entries: scopedEntries,
			};
		})
		.filter((record): record is {
			day: string;
			generatedAt: string;
			summary: ReturnType<typeof summarizeAlertHistoryDay>;
			entries: AlertHistoryEntry[];
		} => !!record);

	return new Response(
		JSON.stringify({
			days,
			generatedAt: new Date().toISOString(),
			meta: {
				state: stateCode,
				countyCode,
				daysRequested: requestedDays,
			},
		}),
		{
			status: 200,
			headers,
		},
	);
}

async function handleApiAlertChanges(request: Request, env: Env): Promise<Response> {
	const headers = apiCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const url = new URL(request.url);
	const sinceInput = String(url.searchParams.get('since') || '').trim();
	const stateInput = String(url.searchParams.get('state') || '').trim();
	const countyInput = String(url.searchParams.get('countyCode') || '').trim();

	let sinceMs: number | null = null;
	if (sinceInput) {
		const parsed = Date.parse(sinceInput);
		if (!Number.isFinite(parsed)) {
			return new Response(JSON.stringify({ error: 'Invalid since timestamp.' }), {
				status: 400,
				headers,
			});
		}
		sinceMs = parsed;
	}

	let stateCode: string | null = null;
	if (stateInput) {
		stateCode = normalizeStateCode(stateInput);
		if (!stateCode) {
			return new Response(JSON.stringify({ error: 'Invalid state filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	let countyCode: string | null = null;
	if (countyInput) {
		countyCode = normalizeCountyFips(countyInput);
		if (!countyCode) {
			return new Response(JSON.stringify({ error: 'Invalid countyCode filter.' }), {
				status: 400,
				headers,
			});
		}
	}

	const changes = await readAlertChangeRecords(env);
	const filtered = changes.filter((change) => {
		const changedAtMs = Date.parse(change.changedAt);
		if (sinceMs !== null && (!Number.isFinite(changedAtMs) || changedAtMs <= sinceMs)) {
			return false;
		}
		if (stateCode && !change.stateCodes.includes(stateCode)) {
			return false;
		}
		if (countyCode && !change.countyCodes.includes(countyCode)) {
			return false;
		}
		return true;
	});

	return new Response(
		JSON.stringify({
			changes: filtered,
			generatedAt: new Date().toISOString(),
		}),
		{
			status: 200,
			headers,
		},
	);
}

async function handleApiDebugSummary(request: Request, env: Env): Promise<Response> {
	const headers = debugCorsHeaders(request.headers.get('Origin'));
	headers.set('Content-Type', 'application/json; charset=utf-8');
	headers.set('Cache-Control', 'no-store');

	const expectedBearerToken = getDebugSummaryBearerToken(env);
	if (!expectedBearerToken) {
		return new Response(
			JSON.stringify({
				error: 'Debug summary is disabled until DEBUG_SUMMARY_BEARER_TOKEN is configured.',
			}),
			{
				status: 503,
				headers,
			},
		);
	}

	if (!hasDebugSummaryAccess(request, expectedBearerToken)) {
		headers.set('WWW-Authenticate', 'Bearer realm="debug-summary"');
		return new Response(JSON.stringify({ error: 'Unauthorized.' }), {
			status: 401,
			headers,
		});
	}

	const map = pruneExpired(await readAlertMap(env));
	const diagnostics = await readOperationalDiagnostics(env);
	const pushSubscriptionCount = await countPushSubscriptionRecords(env);

	return new Response(
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			lastSuccessfulSync: diagnostics.lastSuccessfulSyncAt,
			lastSyncAttempt: diagnostics.lastSyncAttemptAt,
			lastSyncError: diagnostics.lastSyncError,
			activeAlertCount: Object.keys(map).length,
			pushSubscriptionCount,
			invalidSubscriptionCount: diagnostics.invalidSubscriptionCount,
			lastInvalidSubscriptionAt: diagnostics.lastInvalidSubscriptionAt,
			lastInvalidSubscriptionReason: diagnostics.lastInvalidSubscriptionReason,
			recentPushFailures: diagnostics.recentPushFailures,
		}),
		{
			status: 200,
			headers,
		},
	);
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

type MapClickPeriodOverride = {
	name: string;
	startMs: number;
	shortForecast: string;
	detailedForecast: string;
	precipitationChance: number | null;
	icon: string;
};

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

function normalizeDailyPeriods(periods: any[], mapClickOverrides: MapClickPeriodOverride[] = []): any[] {
	const normalized: any[] = [];

	for (let i = 0; i < periods.length; i++) {
		const period = periods[i];
		if (!period) continue;

		// Prefer daytime periods as the main day cards
		if (period.isDaytime === true) {
			const override = findMapClickPeriodOverride(mapClickOverrides, period);
			const next = periods[i + 1];
			const nightPeriod = next && next.isDaytime === false ? next : null;
			const nightOverride = nightPeriod
				? findMapClickPeriodOverride(mapClickOverrides, nightPeriod)
				: null;
			const highF = forecastTemperatureToF(period);
			const lowF =
				nightPeriod
					? forecastTemperatureToF(nightPeriod)
					: null;

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
				nightIcon: String(nightOverride?.icon || nightPeriod?.icon || ''),
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
		const daily = normalizeDailyPeriods(dailyPeriodsRaw, mapClickOverrides);
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

		const generatedAt = new Date().toISOString();
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
			updated: generatedAt,
			generatedAt,
			meta: {
				generatedAt,
			},
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
	const lifecycleDiff = await syncAlertLifecycleState(env, map);
	await syncAlertHistoryDailySnapshots(env, map, lifecycleDiff.changes);
	await dispatchStatePushNotifications(env, map, lifecycleDiff.changes);
}

// ---------------------------------------------------------------------------
// Exported worker — fetch + scheduled handlers
// ---------------------------------------------------------------------------

export const __testing = {
	normalizeAlertFeature,
	buildStatePushMessageData,
	buildLifecyclePushMessageData,
	deriveAlertImpactCategories,
	isMajorImpactAlertEvent,
	shouldSendAllClearNotification,
	batchLifecycleEntriesForDeliveryMode,
	diffAlertLifecycleSnapshots,
	normalizeAlertChangeRecord,
	normalizeAlertHistoryDayRecord,
	buildNextAlertHistoryByDay,
	canonicalAlertDetailUrl,
	extractCountyFipsCodes,
	alertMatchesScopeCounty,
};

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
			if (url.pathname === '/api/debug/summary') {
				return new Response(null, {
					status: 204,
					headers: debugCorsHeaders(request.headers.get('Origin')),
				});
			}
			if (url.pathname.startsWith('/api/push/')) {
				return new Response(null, {
					status: 204,
					headers: pushCorsHeaders(request.headers.get('Origin')),
				});
			}
			if (url.pathname.startsWith('/api/')) {
				return new Response(null, {
					status: 204,
					headers: apiCorsHeaders(request.headers.get('Origin')),
				});
			}
			return new Response(null, {
				status: 204,
				headers: corsHeaders(),
			});
		}
		if (url.pathname === '/api/alerts' && request.method === 'GET') {
			return await handleApiAlerts(request, env);
		}
		if (url.pathname === '/api/alerts/changes' && request.method === 'GET') {
			return await handleApiAlertChanges(request, env);
		}
		if (url.pathname === '/api/alerts/history' && request.method === 'GET') {
			return await handleApiAlertHistory(request, env);
		}
		if (url.pathname === '/api/debug/summary' && request.method === 'GET') {
			return await handleApiDebugSummary(request, env);
		}
		if (url.pathname.startsWith('/api/alerts/') && request.method === 'GET') {
			const rawAlertId = url.pathname.slice('/api/alerts/'.length);
			let alertId = rawAlertId;
			try {
				alertId = decodeURIComponent(rawAlertId);
			} catch {
				alertId = rawAlertId;
			}
			if (!alertId) {
				return new Response(JSON.stringify({ error: 'Alert not found.' }), {
					status: 404,
					headers: {
						...corsHeaders(),
						'Content-Type': 'application/json; charset=utf-8',
						'Cache-Control': 'no-store',
					},
				});
			}
			return await handleApiAlertDetail(request, env, alertId);
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
		if (url.pathname === '/api/push/test' && request.method === 'POST') {
			return await handlePushTest(request, env);
		}
		if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
			return await handlePushUnsubscribe(request, env);
		}
		if ((url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/live-weather-alerts') && request.method === 'GET') {
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
