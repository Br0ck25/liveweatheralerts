import type {
  AlertHistoryDay,
  AlertHistoryDaySummary,
  AlertHistoryEntry,
  AlertImpactCategory,
  AlertChangeRecord,
  AlertChangeType,
  AlertDetailPayload,
  AlertRecord,
  AlertType,
  AlertsHistoryPayload,
  AlertsChangesPayload,
  AlertsMeta,
  AlertsPayload,
  SeverityFilter
} from "../../types";
import { requestJson } from "./http";

type RawAlertsResponse = {
  alerts?: unknown;
  lastPoll?: unknown;
  syncError?: unknown;
  meta?: {
    lastPoll?: unknown;
    generatedAt?: unknown;
    syncError?: unknown;
    stale?: unknown;
    staleMinutes?: unknown;
    count?: unknown;
  };
};

function parseString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseBoolean(value: unknown): boolean {
  return value === true;
}

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAlertChangeType(value: unknown): AlertChangeType | null {
  const normalized = parseString(value).trim().toLowerCase();
  if (normalized === "new") return "new";
  if (normalized === "updated") return "updated";
  if (normalized === "extended") return "extended";
  if (normalized === "expired") return "expired";
  if (normalized === "all_clear") return "all_clear";
  return null;
}

function parseAlertType(value: unknown, event = ""): AlertType {
  const normalized = parseString(value).trim().toLowerCase();
  if (normalized === "warning") return "warning";
  if (normalized === "watch") return "watch";
  if (normalized === "advisory") return "advisory";
  if (normalized === "statement") return "statement";

  const fromEvent = event.trim().toLowerCase();
  if (fromEvent.includes("warning")) return "warning";
  if (fromEvent.includes("watch")) return "watch";
  if (fromEvent.includes("advisory")) return "advisory";
  if (fromEvent.includes("statement")) return "statement";
  return "other";
}

function parseSeverityBucket(value: unknown): Exclude<SeverityFilter, "all"> {
  const normalized = parseString(value).trim().toLowerCase();
  if (normalized === "extreme") return "extreme";
  if (normalized === "severe") return "severe";
  if (normalized === "moderate") return "moderate";
  if (normalized === "minor") return "minor";
  return "unknown";
}

function parseAlertLifecycleStatus(value: unknown): AlertRecord["lifecycleStatus"] {
  const changeType = parseAlertChangeType(value);
  if (changeType) return changeType;
  const normalized = parseString(value).trim().toLowerCase();
  if (normalized === "expiring_soon") return "expiring_soon";
  return null;
}

function parseAlertCategory(rawCategory: unknown, event: string): string {
  const category = parseString(rawCategory).trim().toLowerCase();
  if (category) return category;
  const normalizedEvent = event.trim().toLowerCase();
  if (normalizedEvent.includes("warning")) return "warning";
  if (normalizedEvent.includes("watch")) return "watch";
  if (normalizedEvent.includes("advisory")) return "advisory";
  if (normalizedEvent.includes("statement")) return "statement";
  return "other";
}

function parseAlertImpactCategory(value: unknown): AlertImpactCategory | null {
  const normalized = parseString(value).trim().toLowerCase();
  if (normalized === "tornado") return "tornado";
  if (normalized === "flood") return "flood";
  if (normalized === "winter") return "winter";
  if (normalized === "heat") return "heat";
  if (normalized === "wind") return "wind";
  if (normalized === "fire") return "fire";
  if (normalized === "marine") return "marine";
  if (normalized === "coastal") return "coastal";
  if (normalized === "air_quality") return "air_quality";
  if (normalized === "other") return "other";
  return null;
}

function parseAlertImpactCategories(
  rawImpactCategories: unknown,
  event: string
): AlertImpactCategory[] {
  if (Array.isArray(rawImpactCategories)) {
    const parsed = rawImpactCategories
      .map((item) => parseAlertImpactCategory(item))
      .filter((item): item is AlertImpactCategory => item !== null);
    if (parsed.length > 0) {
      return Array.from(new Set(parsed));
    }
  }

  const normalizedEvent = event.trim().toLowerCase();
  if (normalizedEvent.includes("tornado")) return ["tornado"];
  if (normalizedEvent.includes("flood")) return ["flood"];
  if (
    /winter|snow|sleet|blizzard|ice storm|freezing rain|wind chill|freeze|frost/.test(
      normalizedEvent
    )
  ) {
    return ["winter"];
  }
  if (/heat/.test(normalizedEvent)) return ["heat"];
  if (/wind|gust/.test(normalizedEvent)) return ["wind"];
  return ["other"];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstMeaningfulLine(value: string): string {
  const lines = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const withoutLabel = line
      .replace(/^[A-Z][A-Z/\s]{2,40}:\s*/i, "")
      .replace(/^\*\s*/, "")
      .trim();
    if (withoutLabel) {
      return withoutLabel;
    }
  }

  return "";
}

function parseAlertSummary(rawSummary: unknown, headline: string, description: string): string {
  const explicitSummary = compactWhitespace(parseString(rawSummary));
  if (explicitSummary) return explicitSummary;
  const headlineSummary = compactWhitespace(headline);
  if (headlineSummary) return headlineSummary;
  const lineSummary = compactWhitespace(firstMeaningfulLine(description));
  if (lineSummary) return lineSummary;
  return "Review details for location and timing.";
}

function parseInstructionsSummary(
  rawSummary: unknown,
  instruction: string,
  description: string
): string {
  const explicitSummary = compactWhitespace(parseString(rawSummary));
  if (explicitSummary) return explicitSummary;
  const instructionSummary = compactWhitespace(firstMeaningfulLine(instruction));
  if (instructionSummary) return instructionSummary;
  const descriptionSummary = compactWhitespace(firstMeaningfulLine(description));
  if (descriptionSummary) return descriptionSummary;
  return "";
}

function parseAlertDetailUrl(rawDetailUrl: unknown, alertId: string): string {
  const detailUrl = parseString(rawDetailUrl).trim();
  if (detailUrl.startsWith("/alerts/")) return detailUrl;
  if (!alertId.trim()) return "/alerts";
  return `/alerts/${encodeURIComponent(alertId)}`;
}

function parseAlertRecord(raw: unknown): AlertRecord {
  const value = raw as Record<string, unknown>;
  const id = parseString(value?.id);
  const event = parseString(value?.event);
  const headline = parseString(value?.headline);
  const description = parseString(value?.description);
  const instruction = parseString(value?.instruction);

  return {
    id,
    stateCode: parseString(value?.stateCode),
    ugc: Array.isArray(value?.ugc) ? value.ugc.map((item) => String(item)) : [],
    category: parseAlertCategory(value?.category, event),
    impactCategories: parseAlertImpactCategories(value?.impactCategories, event),
    isMajor: parseBoolean(value?.isMajor),
    detailUrl: parseAlertDetailUrl(value?.detailUrl, id),
    summary: parseAlertSummary(value?.summary, headline, description),
    instructionsSummary: parseInstructionsSummary(
      value?.instructionsSummary,
      instruction,
      description
    ),
    lifecycleStatus: parseAlertLifecycleStatus(value?.lifecycleStatus),
    lat: parseOptionalNumber(value?.lat),
    lon: parseOptionalNumber(value?.lon),
    event,
    areaDesc: parseString(value?.areaDesc),
    severity: parseString(value?.severity),
    status: parseString(value?.status),
    urgency: parseString(value?.urgency),
    certainty: parseString(value?.certainty),
    headline,
    description,
    instruction,
    sent: parseString(value?.sent),
    effective: parseString(value?.effective),
    onset: parseString(value?.onset),
    expires: parseString(value?.expires),
    updated: parseString(value?.updated),
    nwsUrl: parseString(value?.nwsUrl)
  };
}

function computeStaleMeta(lastPoll: string | null, count: number): AlertsMeta {
  const generatedAt = new Date().toISOString();
  const lastPollMs = lastPoll ? Date.parse(lastPoll) : NaN;
  const staleMinutes = Number.isFinite(lastPollMs)
    ? Math.max(0, Math.floor((Date.now() - lastPollMs) / 60_000))
    : 0;
  return {
    lastPoll,
    generatedAt,
    syncError: null,
    stale: staleMinutes >= 15,
    staleMinutes,
    count
  };
}

function parseAlertsMeta(
  payload: RawAlertsResponse,
  count: number
): AlertsMeta {
  const meta = payload.meta;
  const fallbackLastPoll = parseNullableString(payload.lastPoll);
  if (!meta || typeof meta !== "object") {
    return computeStaleMeta(fallbackLastPoll, count);
  }

  const lastPoll = parseNullableString(meta.lastPoll) ?? fallbackLastPoll;
  const generatedAt =
    parseNullableString(meta.generatedAt) ?? new Date().toISOString();
  const syncError =
    parseNullableString(meta.syncError) ?? parseNullableString(payload.syncError);
  const staleMinutes =
    parseNumber(meta.staleMinutes) ||
    computeStaleMeta(lastPoll, count).staleMinutes;
  const stale =
    parseBoolean(meta.stale) || (staleMinutes >= 15 && staleMinutes > 0);
  const metaCount = parseNumber(meta.count) || count;

  return {
    lastPoll,
    generatedAt,
    syncError,
    stale,
    staleMinutes,
    count: metaCount
  };
}

export async function getAlerts(signal?: AbortSignal): Promise<AlertsPayload> {
  const payload = await requestJson<RawAlertsResponse>("/api/alerts", {
    signal,
    fallbackError: "Unable to load alerts."
  });

  const alertsRaw = Array.isArray(payload.alerts) ? payload.alerts : [];
  const alerts = alertsRaw.map((record) => parseAlertRecord(record));
  const meta = parseAlertsMeta(payload, alerts.length);

  return {
    alerts,
    lastPoll: meta.lastPoll,
    syncError: meta.syncError,
    meta
  };
}

export async function getAlertById(
  alertId: string,
  signal?: AbortSignal
): Promise<AlertDetailPayload> {
  const path = `/api/alerts/${encodeURIComponent(alertId)}`;
  const payload = await requestJson<{
    alert?: unknown;
    lastPoll?: unknown;
    syncError?: unknown;
    meta?: {
      lastPoll?: unknown;
      generatedAt?: unknown;
      syncError?: unknown;
      stale?: unknown;
      staleMinutes?: unknown;
      count?: unknown;
    };
  }>(path, {
    signal,
    fallbackError: "Unable to load alert details."
  });

  if (!payload.alert || typeof payload.alert !== "object") {
    throw new Error("Alert detail response was invalid.");
  }

  return {
    alert: parseAlertRecord(payload.alert),
    meta: parseAlertsMeta(payload, 1)
  };
}

function parseAlertChangeRecord(raw: unknown): AlertChangeRecord | null {
  const value = raw as Record<string, unknown>;
  const changeType = parseAlertChangeType(value?.changeType);
  const alertId = parseString(value?.alertId).trim();
  const changedAt = parseString(value?.changedAt).trim();

  if (!changeType || !alertId || !changedAt) {
    return null;
  }

  const stateCodes = Array.isArray(value?.stateCodes)
    ? value.stateCodes.map((stateCode) => parseString(stateCode).trim().toUpperCase()).filter(Boolean)
    : [];
  const countyCodes = Array.isArray(value?.countyCodes)
    ? value.countyCodes.map((countyCode) => parseString(countyCode).replace(/\D/g, "").padStart(3, "0").slice(-3)).filter(Boolean)
    : [];

  return {
    alertId,
    stateCodes,
    countyCodes,
    event: parseString(value?.event) || "Weather Alert",
    areaDesc: parseString(value?.areaDesc),
    changedAt,
    changeType,
    previousExpires: parseNullableString(value?.previousExpires),
    nextExpires: parseNullableString(value?.nextExpires)
  };
}

type AlertChangesQuery = {
  since?: string;
  state?: string;
  countyCode?: string;
  signal?: AbortSignal;
};

export async function getAlertChanges({
  since,
  state,
  countyCode,
  signal
}: AlertChangesQuery = {}): Promise<AlertsChangesPayload> {
  const params = new URLSearchParams();
  if (since?.trim()) params.set("since", since.trim());
  if (state?.trim()) params.set("state", state.trim().toUpperCase());
  if (countyCode?.trim()) {
    const normalizedCountyCode = countyCode.replace(/\D/g, "").padStart(3, "0").slice(-3);
    if (normalizedCountyCode) {
      params.set("countyCode", normalizedCountyCode);
    }
  }

  const query = params.toString();
  const path = query ? `/api/alerts/changes?${query}` : "/api/alerts/changes";

  const payload = await requestJson<{
    changes?: unknown;
    generatedAt?: unknown;
  }>(path, {
    signal,
    fallbackError: "Unable to load alert changes."
  });

  const records = Array.isArray(payload.changes) ? payload.changes : [];
  const changes = records
    .map((record) => parseAlertChangeRecord(record))
    .filter((record): record is AlertChangeRecord => record !== null);

  return {
    changes,
    generatedAt: parseNullableString(payload.generatedAt) ?? new Date().toISOString()
  };
}

type AlertHistoryQuery = {
  state?: string;
  countyCode?: string;
  days?: number;
  signal?: AbortSignal;
};

function parseAlertHistoryEntry(raw: unknown): AlertHistoryEntry | null {
  const value = raw as Record<string, unknown>;
  const alertId = parseString(value?.alertId).trim();
  const changedAt = parseString(value?.changedAt).trim();
  const changeType = parseAlertChangeType(value?.changeType);
  if (!alertId || !changedAt || !changeType) {
    return null;
  }

  const event = parseString(value?.event).trim() || "Weather Alert";
  const category = parseAlertType(value?.category, event);
  const severity = parseString(value?.severity).trim() || "Unknown";

  return {
    alertId,
    stateCodes: Array.isArray(value?.stateCodes)
      ? value.stateCodes.map((stateCode) => parseString(stateCode).trim().toUpperCase()).filter(Boolean)
      : [],
    countyCodes: Array.isArray(value?.countyCodes)
      ? value.countyCodes.map((countyCode) => parseString(countyCode).replace(/\D/g, "").padStart(3, "0").slice(-3)).filter(Boolean)
      : [],
    event,
    areaDesc: parseString(value?.areaDesc),
    changedAt,
    changeType,
    severity,
    category,
    isMajor: parseBoolean(value?.isMajor),
    summary: parseString(value?.summary).trim() || `${event} update`,
    previousExpires: parseNullableString(value?.previousExpires),
    nextExpires: parseNullableString(value?.nextExpires)
  };
}

function emptyHistoryDaySummary(): AlertHistoryDaySummary {
  return {
    totalEntries: 0,
    activeAlertCount: 0,
    activeWarningCount: 0,
    activeMajorCount: 0,
    byLifecycle: {
      new: 0,
      updated: 0,
      extended: 0,
      expired: 0,
      all_clear: 0
    },
    byCategory: {
      warning: 0,
      watch: 0,
      advisory: 0,
      statement: 0,
      other: 0
    },
    bySeverity: {
      extreme: 0,
      severe: 0,
      moderate: 0,
      minor: 0,
      unknown: 0
    },
    topEvents: [],
    notableWarnings: []
  };
}

function summarizeHistoryEntries(
  entries: AlertHistoryEntry[],
  activeCounts?: Pick<AlertHistoryDaySummary, "activeAlertCount" | "activeWarningCount" | "activeMajorCount">
): AlertHistoryDaySummary {
  const summary = emptyHistoryDaySummary();
  summary.totalEntries = entries.length;
  summary.activeAlertCount = activeCounts?.activeAlertCount ?? 0;
  summary.activeWarningCount = activeCounts?.activeWarningCount ?? 0;
  summary.activeMajorCount = activeCounts?.activeMajorCount ?? 0;

  const eventCounts = new Map<string, number>();
  for (const entry of entries) {
    summary.byLifecycle[entry.changeType] += 1;
    summary.byCategory[entry.category] += 1;
    summary.bySeverity[parseSeverityBucket(entry.severity)] += 1;
    const event = entry.event.trim() || "Weather Alert";
    eventCounts.set(event, (eventCounts.get(event) || 0) + 1);
  }

  summary.topEvents = Array.from(eventCounts.entries())
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.event.localeCompare(b.event);
    })
    .slice(0, 4);

  summary.notableWarnings = entries
    .filter(
      (entry) =>
        entry.category === "warning" &&
        (entry.isMajor || parseSeverityBucket(entry.severity) === "extreme" || parseSeverityBucket(entry.severity) === "severe")
    )
    .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
    .slice(0, 4)
    .map((entry) => ({
      alertId: entry.alertId,
      event: entry.event,
      areaDesc: entry.areaDesc,
      severity: entry.severity,
      changedAt: entry.changedAt,
      changeType: entry.changeType
    }));

  return summary;
}

function parseAlertHistoryDay(raw: unknown): AlertHistoryDay | null {
  const value = raw as Record<string, unknown>;
  const day = parseString(value?.day).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }

  const entries = Array.isArray(value?.entries)
    ? value.entries
      .map((entry) => parseAlertHistoryEntry(entry))
      .filter((entry): entry is AlertHistoryEntry => entry !== null)
    : [];
  const rawSummary = value?.summary as Record<string, unknown> | undefined;
  const summary = summarizeHistoryEntries(entries, {
    activeAlertCount: parseNumber(rawSummary?.activeAlertCount),
    activeWarningCount: parseNumber(rawSummary?.activeWarningCount),
    activeMajorCount: parseNumber(rawSummary?.activeMajorCount)
  });

  if (rawSummary && typeof rawSummary === "object") {
    const topEventsRaw = Array.isArray(rawSummary.topEvents) ? rawSummary.topEvents : [];
    const notableRaw = Array.isArray(rawSummary.notableWarnings)
      ? rawSummary.notableWarnings
      : [];
    if (topEventsRaw.length > 0) {
      summary.topEvents = topEventsRaw
        .map((item) => {
          const value = item as Record<string, unknown>;
          return {
            event: parseString(value?.event).trim(),
            count: parseNumber(value?.count)
          };
        })
        .filter((item) => item.event);
    }
    if (notableRaw.length > 0) {
      summary.notableWarnings = notableRaw
        .map((item) => {
          const value = item as Record<string, unknown>;
          const changeType = parseAlertChangeType(value?.changeType);
          const alertId = parseString(value?.alertId).trim();
          const changedAt = parseString(value?.changedAt).trim();
          if (!changeType || !alertId || !changedAt) {
            return null;
          }
          return {
            alertId,
            event: parseString(value?.event).trim() || "Weather Alert",
            areaDesc: parseString(value?.areaDesc),
            severity: parseString(value?.severity).trim() || "Unknown",
            changedAt,
            changeType
          };
        })
        .filter(
          (
            item
          ): item is {
            alertId: string;
            event: string;
            areaDesc: string;
            severity: string;
            changedAt: string;
            changeType: AlertChangeType;
          } => item !== null
        );
    }
  }

  return {
    day,
    generatedAt: parseString(value?.generatedAt).trim() || new Date().toISOString(),
    summary,
    entries
  };
}

export async function getAlertHistory({
  state,
  countyCode,
  days,
  signal
}: AlertHistoryQuery = {}): Promise<AlertsHistoryPayload> {
  const params = new URLSearchParams();
  if (state?.trim()) params.set("state", state.trim().toUpperCase());
  if (countyCode?.trim()) {
    const normalizedCountyCode = countyCode.replace(/\D/g, "").padStart(3, "0").slice(-3);
    if (normalizedCountyCode) {
      params.set("countyCode", normalizedCountyCode);
    }
  }
  if (Number.isInteger(days) && Number(days) > 0) {
    params.set("days", String(days));
  }

  const query = params.toString();
  const path = query ? `/api/alerts/history?${query}` : "/api/alerts/history";

  const payload = await requestJson<{
    days?: unknown;
    generatedAt?: unknown;
    meta?: {
      state?: unknown;
      countyCode?: unknown;
      daysRequested?: unknown;
    };
  }>(path, {
    signal,
    fallbackError: "Unable to load alert history."
  });

  const daysRaw = Array.isArray(payload.days) ? payload.days : [];
  const parsedDays = daysRaw
    .map((record) => parseAlertHistoryDay(record))
    .filter((record): record is AlertHistoryDay => record !== null);

  return {
    days: parsedDays,
    generatedAt: parseNullableString(payload.generatedAt) ?? new Date().toISOString(),
    meta: {
      state: parseNullableString(payload.meta?.state),
      countyCode: parseNullableString(payload.meta?.countyCode),
      daysRequested: parseNumber(payload.meta?.daysRequested) || (Number(days) || 7)
    }
  };
}
