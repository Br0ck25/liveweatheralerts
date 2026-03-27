export type AlertType = "warning" | "watch" | "advisory" | "statement" | "other";
export type AlertTypeFilter = AlertType | "all";
export type AlertChangeType = "new" | "updated" | "extended" | "expired" | "all_clear";
export type AlertLifecycleStatus = AlertChangeType | "expiring_soon";
export type AlertImpactCategory =
  | "tornado"
  | "flood"
  | "winter"
  | "heat"
  | "wind"
  | "fire"
  | "marine"
  | "coastal"
  | "air_quality"
  | "other";
export type SeverityFilter =
  | "all"
  | "extreme"
  | "severe"
  | "moderate"
  | "minor"
  | "unknown";
export type SortMode = "priority" | "expires" | "latest";

export interface AlertRecord {
  id: string;
  stateCode: string;
  ugc: string[];
  category?: string;
  impactCategories?: AlertImpactCategory[];
  isMajor?: boolean;
  detailUrl?: string;
  summary?: string;
  instructionsSummary?: string;
  lifecycleStatus?: AlertLifecycleStatus | null;
  lat?: number;
  lon?: number;
  event: string;
  areaDesc: string;
  severity: string;
  status: string;
  urgency: string;
  certainty: string;
  headline: string;
  description: string;
  instruction: string;
  sent: string;
  effective: string;
  onset: string;
  expires: string;
  updated: string;
  nwsUrl: string;
}

export interface AlertsMeta {
  lastPoll: string | null;
  generatedAt: string;
  syncError: string | null;
  stale: boolean;
  staleMinutes: number;
  count: number;
}

export interface AlertsPayload {
  alerts: AlertRecord[];
  lastPoll: string | null;
  syncError: string | null;
  meta: AlertsMeta;
}

export interface AlertDetailPayload {
  alert: AlertRecord;
  meta: AlertsMeta;
}

export interface AlertChangeRecord {
  alertId: string;
  stateCodes: string[];
  countyCodes: string[];
  event: string;
  areaDesc: string;
  changedAt: string;
  changeType: AlertChangeType;
  previousExpires?: string | null;
  nextExpires?: string | null;
}

export interface AlertsChangesPayload {
  changes: AlertChangeRecord[];
  generatedAt: string;
}

export interface AlertHistoryNotableWarning {
  alertId: string;
  event: string;
  areaDesc: string;
  severity: string;
  changedAt: string;
  changeType: AlertChangeType;
}

export interface AlertHistoryTopEvent {
  event: string;
  count: number;
}

export interface AlertHistoryDaySummary {
  totalEntries: number;
  activeAlertCount: number;
  activeWarningCount: number;
  activeMajorCount: number;
  byLifecycle: Record<AlertChangeType, number>;
  byCategory: Record<AlertType, number>;
  bySeverity: Record<Exclude<SeverityFilter, "all">, number>;
  topEvents: AlertHistoryTopEvent[];
  notableWarnings: AlertHistoryNotableWarning[];
}

export interface AlertHistoryEntry {
  alertId: string;
  stateCodes: string[];
  countyCodes: string[];
  event: string;
  areaDesc: string;
  changedAt: string;
  changeType: AlertChangeType;
  severity: string;
  category: AlertType;
  isMajor: boolean;
  summary: string;
  previousExpires?: string | null;
  nextExpires?: string | null;
}

export interface AlertHistoryDay {
  day: string;
  generatedAt: string;
  summary: AlertHistoryDaySummary;
  entries: AlertHistoryEntry[];
}

export interface AlertsHistoryPayload {
  days: AlertHistoryDay[];
  generatedAt: string;
  meta: {
    state: string | null;
    countyCode: string | null;
    daysRequested: number;
  };
}

export interface SavedLocationPreference {
  stateCode: string;
  rawInput: string;
  label: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
  savedAt: string;
}

export interface SavedPlace {
  id: string;
  label: string;
  rawInput: string;
  stateCode: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GeocodeLocationPayload {
  city?: string;
  state?: string;
  label?: string;
  county?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
  error?: string;
}

export interface WeatherCurrent {
  temperatureF?: number | null;
  feelsLikeF?: number | null;
  condition?: string;
  windMph?: number | null;
  windDirection?: string | null;
  humidity?: number | null;
  icon?: string;
  isNight?: boolean;
}

export interface WeatherHourlyPeriod {
  startTime?: string;
  temperatureF?: number | null;
  shortForecast?: string;
  icon?: string;
  precipitationChance?: number | null;
}

export interface WeatherDailyPeriod {
  name?: string;
  startTime?: string;
  highF?: number | null;
  lowF?: number | null;
  shortForecast?: string;
  detailedForecast?: string;
  icon?: string;
  precipitationChance?: number | null;
  nightName?: string;
  nightShortForecast?: string;
  nightDetailedForecast?: string;
  nightIcon?: string;
  nightPrecipitationChance?: number | null;
}

export interface WeatherPayload {
  location?: {
    label?: string;
    city?: string;
    state?: string;
    lat?: number;
    lon?: number;
  };
  current?: WeatherCurrent;
  hourly?: WeatherHourlyPeriod[];
  daily?: WeatherDailyPeriod[];
  radar?: RadarPayload;
  updated?: string;
  generatedAt?: string;
  meta?: {
    generatedAt: string;
  };
  error?: string;
}

export interface RadarPayload {
  location?: {
    lat?: number;
    lon?: number;
    city?: string;
    state?: string;
    label?: string;
  };
  station?: string | null;
  loopImageUrl?: string | null;
  stillImageUrl?: string | null;
  updated?: string;
  summary?: string;
  stormDirection?: string | null;
  generatedAt?: string;
  meta?: {
    generatedAt: string;
  };
  error?: string;
}

export interface PushPublicKeyPayload {
  publicKey: string;
}

export type PushDeliveryScope = "state" | "county";
export type PushDeliveryMode = "immediate" | "digest";

export interface PushAlertTypes {
  warnings: boolean;
  watches: boolean;
  advisories: boolean;
  statements: boolean;
}

export interface PushScope {
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
}

export interface PushQuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface PushPreferences {
  scopes: PushScope[];
  quietHours: PushQuietHours;
  deliveryMode: PushDeliveryMode;
  pausedUntil?: string | null;
}

export interface PushSubscribeRequest {
  subscription: Record<string, unknown>;
  prefs?: PushPreferences;
  stateCode?: string;
  state?: string;
}

export interface PushSubscribePayload {
  ok: true;
  subscriptionId: string;
  stateCode?: string;
  prefs?: PushPreferences;
  indexedStateCodes?: string[];
}

export interface PushUnsubscribePayload {
  ok: true;
  removed: boolean;
}

export interface PushTestPayload {
  ok: true;
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}
