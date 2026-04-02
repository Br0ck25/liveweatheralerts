// NWS active alerts — full US feed.
// ETags mean a 304 (nothing changed) costs almost nothing.
// Contact info in User-Agent is per NWS guidelines — they email you instead of silently blocking.
export const WEATHER_API    = 'https://api.weather.gov/alerts/active';
export const NWS_USER_AGENT = 'LiveWeatherAlerts/1.0 (liveweatheralerts.com; alerts@liveweatheralerts.com)';
export const NWS_ACCEPT     = 'application/geo+json,application/json';
export const FB_GRAPH_API   = 'https://graph.facebook.com/v17.0';
export const DEFAULT_WEATHER_LAT = 41.8781;
export const DEFAULT_WEATHER_LON = -87.6298;
export const PRIMARY_APP_ORIGIN = 'https://liveweatheralerts.com';
export const WWW_APP_ORIGIN = 'https://www.liveweatheralerts.com';
export const PUBLIC_ALERTS_PAGE_PATH = '/live';
export const PUBLIC_ALERTS_PAGE_URL = PRIMARY_APP_ORIGIN + '/live';

// KV keys
export const KV_ALERT_MAP  = 'alerts:map';       // JSON: Record<alertId, feature> — merged active alerts
export const KV_ETAG       = 'alerts:etag';      // Last ETag string from NWS
export const KV_LAST_POLL  = 'alerts:last-poll'; // ISO timestamp of last successful poll
export const KV_FB_APP_CONFIG = 'fb:app-config';  // JSON: { appId, appSecret }
export const KV_FB_AUTO_POST_CONFIG = 'fb:auto-post-config'; // JSON: { mode, updatedAt }
export const KV_ADMIN_SESSION_PREFIX = 'admin:session:'; // admin:session:{opaqueToken}
export const KV_PUSH_SUB_PREFIX = 'push:sub:'; // push:sub:{sha256(endpoint)}
export const KV_PUSH_STATE_INDEX_PREFIX = 'push:index:state:'; // push:index:state:{stateCode}
export const KV_PUSH_RADIUS_INDEX = 'push:index:radius'; // JSON: string[] of subscription ids with enabled radius scopes
export const KV_PUSH_STATE_ALERT_SNAPSHOT = 'push:state-alert-snapshot:v1'; // JSON: Record<stateCode, alertId[]>
export const KV_ALERT_LIFECYCLE_SNAPSHOT = 'alerts:lifecycle-snapshot:v1'; // JSON: Record<alertId, AlertLifecycleSnapshotEntry>
export const KV_ALERT_CHANGES = 'alerts:changes:v1'; // JSON: AlertChangeRecord[]
export const KV_ALERT_HISTORY_DAILY = 'alerts:history:daily:v1'; // JSON: Record<day, AlertHistoryDayRecord>
export const KV_OPERATIONAL_DIAGNOSTICS = 'ops:diagnostics:v1'; // JSON: OperationalDiagnostics
export const LOCAL_DEV_ALERT_REFRESH_MINUTES = 2;
export const ALERT_HISTORY_RETENTION_DAYS = 14;
export const ALERT_HISTORY_MAX_QUERY_DAYS = 14;
export const MAX_RECENT_PUSH_FAILURES = 20;
export const ADMIN_SESSION_COOKIE = 'admin_session';
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60;
export const FB_AUTO_POST_MAX_ALERT_AGE_MS = 30 * 60 * 1000;
export const FB_AUTO_POST_DUPLICATE_WINDOW_MS = 60 * 60 * 1000;
// KV thread keys: thread:{ugc}:{eventSlug} — tracks active FB post threads per county+alertType
// e.g. thread:KYC195:severe_thunderstorm_warning

// Digest / coverage KV keys
export const KV_FB_LAST_POST_TIMESTAMP = 'fb:last-post-timestamp';
export const KV_FB_DIGEST_BLOCK = 'fb:digest:block';
export const KV_FB_DIGEST_HASH = 'fb:digest:hash';
export const KV_FB_DIGEST_ROTATION_CURSOR = 'fb:digest:rotation-cursor';
export const KV_FB_COVERED_ALERTS = 'fb:covered-alerts';
export const KV_FB_STARTUP_STATE = 'fb:startup-state';
export const KV_FB_DIGEST_THREAD_PREFIX = 'fb:digest-thread:';
export const KV_FB_DIGEST_RECENT_OPENINGS = 'fb:digest:recent-openings';
export const KV_FB_SPC_LAST_SUMMARY_PREFIX = 'fb:spc:last-summary:';
export const KV_FB_SPC_LAST_POST_PREFIX = 'fb:spc:last-post:';
export const KV_FB_SPC_LAST_HASH_PREFIX = 'fb:spc:last-hash:';
export const KV_FB_SPC_THREAD_PREFIX = 'fb:spc:thread:';
export const KV_FB_SPC_DEBUG = 'fb:spc:debug';
export const KV_FB_SPC_LAST_SUMMARY = 'fb:spc:day1:last-summary';
export const KV_FB_SPC_LAST_POST = 'fb:spc:day1:last-post';
export const KV_FB_SPC_LAST_HASH = 'fb:spc:day1:last-hash';
export const KV_FB_SPC_RECENT_OPENINGS = 'fb:spc:recent-openings';

// Digest timing constants
export const FB_DIGEST_COOLDOWN_MS = 60 * 60 * 1000;
export const FB_DIGEST_SAME_HAZARD_COOLDOWN_MS = 60 * 60 * 1000;
export const FB_DIGEST_COMMENT_COOLDOWN_MS = 20 * 60 * 1000;
export const FB_DIGEST_MAX_POSTS_PER_HOUR = 2;
export const FB_DIGEST_DEFAULT_MAX_COMMENTS_PER_THREAD = 3;
export const FB_DIGEST_DEFAULT_MIN_COMMENT_GAP_MINUTES = 20;
export const FB_STARTUP_GAP_MS = 6 * 60 * 60 * 1000;

// Incident mode thresholds
export const FB_INCIDENT_MODE_ALERT_THRESHOLD = 100;
export const FB_INCIDENT_MODE_STATE_THRESHOLD = 8;
export const FB_MARINE_SUPPRESSION_THRESHOLD = 0.30;

// Cluster breakout thresholds
export const FB_CLUSTER_BREAKOUT_FLOOD_WARNINGS = 10;
export const FB_CLUSTER_BREAKOUT_SCORE_THRESHOLD = 20;
export const FB_CLUSTER_BREAKOUT_MIN_STATES = 3;

// Digest layout constants
export const FB_DIGEST_TOP_STATE_COUNT = 3;
export const FB_DIGEST_ROTATION_STATE_COUNT = 3;
export const FB_DIGEST_MAX_NORMAL_MULTISTATE = 6;
export const FB_DIGEST_RECENT_OPENINGS_LIMIT = 3;
export const FB_SPC_RECENT_OPENINGS_LIMIT = 3;

// Push notification constants
export const NOTIFICATION_ICON_PATH = '/icon-192.svg';
export const NOTIFICATION_BADGE_PATH = '/icon-192.svg';

// Facebook API
export const FB_TIMEOUT_MS = 15_000;

// Zip code validation
export const ZIP_RE = /^\d{5}$/;

// Admin forecast city configs
import type { AdminForecastLocationConfig, AdminConvectiveOutlookConfig, SpcOutlookDay } from './types';
export const ADMIN_FORECAST_LOCATIONS: AdminForecastLocationConfig[] = [
	{ id: 'new_york_city', label: 'New York City', region: 'Northeast', zip: '10001', discussionOfficeCode: 'OKX', discussionOfficeLabel: 'New York NY' },
	{ id: 'atlanta', label: 'Atlanta', region: 'Southeast', zip: '30303', discussionOfficeCode: 'FFC', discussionOfficeLabel: 'Peachtree City GA' },
	{ id: 'chicago', label: 'Chicago', region: 'Midwest', zip: '60601', discussionOfficeCode: 'LOT', discussionOfficeLabel: 'Chicago/Romeoville IL' },
	{ id: 'dallas', label: 'Dallas', region: 'Plains', zip: '75201', discussionOfficeCode: 'FWD', discussionOfficeLabel: 'Fort Worth TX' },
	{ id: 'denver', label: 'Denver', region: 'West', zip: '80202', discussionOfficeCode: 'BOU', discussionOfficeLabel: 'Boulder CO' },
];
export const ADMIN_DISCUSSION_LIMIT = 10;
export const ADMIN_CONVECTIVE_OUTLOOKS: AdminConvectiveOutlookConfig[] = [
	{ id: 'day1', label: 'Day 1', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day1otlk.html', imagePrefix: 'day1' },
	{ id: 'day2', label: 'Day 2', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk.html', imagePrefix: 'day2' },
	{ id: 'day3', label: 'Day 3', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day3otlk.html', imagePrefix: 'day3' },
];

export function kvSpcLastSummaryKey(day: SpcOutlookDay): string {
	return `${KV_FB_SPC_LAST_SUMMARY_PREFIX}${day}`;
}

export function kvSpcLastPostKey(day: SpcOutlookDay): string {
	return `${KV_FB_SPC_LAST_POST_PREFIX}${day}`;
}

export function kvSpcLastHashKey(day: SpcOutlookDay): string {
	return `${KV_FB_SPC_LAST_HASH_PREFIX}${day}`;
}

export function kvSpcThreadKey(day: SpcOutlookDay): string {
	return `${KV_FB_SPC_THREAD_PREFIX}${day}`;
}
