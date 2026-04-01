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
export const PUBLIC_ALERTS_PAGE_PATH = '/';
export const PUBLIC_ALERTS_PAGE_URL = PRIMARY_APP_ORIGIN;

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

// Push notification constants
export const NOTIFICATION_ICON_PATH = '/icon-192.svg';
export const NOTIFICATION_BADGE_PATH = '/icon-192.svg';

// Facebook API
export const FB_TIMEOUT_MS = 15_000;

// Zip code validation
export const ZIP_RE = /^\d{5}$/;

// Admin forecast city configs
import type { AdminForecastLocationConfig, AdminConvectiveOutlookConfig } from './types';
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
