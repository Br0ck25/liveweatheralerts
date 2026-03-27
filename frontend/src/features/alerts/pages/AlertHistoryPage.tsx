import { useEffect, useMemo, useState } from "react";
import type {
  AlertChangeType,
  AlertHistoryDay,
  AlertHistoryDaySummary,
  AlertHistoryEntry,
  AlertType,
  AlertTypeFilter,
  SavedPlace,
  SeverityFilter
} from "../../../types";
import { getAlertHistory } from "../../../lib/api/alerts";
import { HistoryDayCard } from "../components/HistoryDayCard";

type AlertHistoryPageProps = {
  isOffline: boolean;
  activePlace: SavedPlace | null;
  refreshToken?: number;
  onRefreshSettled?: (refreshToken: number) => void;
};

type HistoryLoadState = "idle" | "loading" | "ready" | "error";
type PlaceScope = "state" | "county";

type HistoryDayViewModel = AlertHistoryDay;

const HISTORY_WINDOW_OPTIONS = [
  { value: 1, label: "Last 24 hours" },
  { value: 7, label: "Last 7 days" }
] as const;

const ALERT_TYPE_OPTIONS: Array<{ value: AlertTypeFilter; label: string }> = [
  { value: "all", label: "All alert types" },
  { value: "warning", label: "Warnings" },
  { value: "watch", label: "Watches" },
  { value: "advisory", label: "Advisories" },
  { value: "statement", label: "Statements" },
  { value: "other", label: "Other" }
];

const SEVERITY_OPTIONS: Array<{ value: SeverityFilter; label: string }> = [
  { value: "all", label: "All severities" },
  { value: "extreme", label: "Extreme" },
  { value: "severe", label: "Severe" },
  { value: "moderate", label: "Moderate" },
  { value: "minor", label: "Minor" },
  { value: "unknown", label: "Unknown" }
];

function defaultScopeForPlace(place: SavedPlace | null): PlaceScope {
  return place?.countyCode ? "county" : "state";
}

function normalizeSeverityBucket(value: string): Exclude<SeverityFilter, "all"> {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "extreme") return "extreme";
  if (normalized === "severe") return "severe";
  if (normalized === "moderate") return "moderate";
  if (normalized === "minor") return "minor";
  return "unknown";
}

function createEmptySummary(
  activeCounts: Pick<AlertHistoryDaySummary, "activeAlertCount" | "activeWarningCount" | "activeMajorCount">
): AlertHistoryDaySummary {
  return {
    totalEntries: 0,
    activeAlertCount: activeCounts.activeAlertCount,
    activeWarningCount: activeCounts.activeWarningCount,
    activeMajorCount: activeCounts.activeMajorCount,
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

function summarizeEntries(
  entries: AlertHistoryEntry[],
  activeCounts: Pick<AlertHistoryDaySummary, "activeAlertCount" | "activeWarningCount" | "activeMajorCount">
): AlertHistoryDaySummary {
  const summary = createEmptySummary(activeCounts);
  summary.totalEntries = entries.length;

  const eventCounts = new Map<string, number>();
  for (const entry of entries) {
    summary.byLifecycle[entry.changeType as AlertChangeType] += 1;
    summary.byCategory[entry.category as AlertType] += 1;
    summary.bySeverity[normalizeSeverityBucket(entry.severity)] += 1;
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
        (entry.isMajor ||
          normalizeSeverityBucket(entry.severity) === "extreme" ||
          normalizeSeverityBucket(entry.severity) === "severe")
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

function entryMatchesFilters(
  entry: AlertHistoryEntry,
  typeFilter: AlertTypeFilter,
  severityFilter: SeverityFilter
): boolean {
  const matchesType = typeFilter === "all" || entry.category === typeFilter;
  const matchesSeverity =
    severityFilter === "all" || normalizeSeverityBucket(entry.severity) === severityFilter;
  return matchesType && matchesSeverity;
}

export function AlertHistoryPage({
  isOffline,
  activePlace,
  refreshToken = 0,
  onRefreshSettled
}: AlertHistoryPageProps) {
  const [loadState, setLoadState] = useState<HistoryLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [days, setDays] = useState<AlertHistoryDay[]>([]);
  const [windowDays, setWindowDays] = useState<number>(1);
  const [placeScope, setPlaceScope] = useState<PlaceScope>(
    defaultScopeForPlace(activePlace)
  );
  const [typeFilter, setTypeFilter] = useState<AlertTypeFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");

  useEffect(() => {
    setPlaceScope(defaultScopeForPlace(activePlace));
  }, [activePlace?.id, activePlace?.countyCode]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setLoadState("loading");
      setErrorMessage(null);
      try {
        const payload = await getAlertHistory({
          state: activePlace?.stateCode,
          countyCode:
            placeScope === "county" ? activePlace?.countyCode || undefined : undefined,
          days: windowDays,
          signal: controller.signal
        });
        if (cancelled) return;
        setDays(payload.days);
        setLoadState("ready");
        onRefreshSettled?.(refreshToken);
      } catch (error) {
        if (cancelled) return;
        setDays([]);
        setLoadState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Unable to load alert history."
        );
        onRefreshSettled?.(refreshToken);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    activePlace?.countyCode,
    activePlace?.stateCode,
    onRefreshSettled,
    placeScope,
    refreshToken,
    windowDays
  ]);

  const placeContextLabel = activePlace
    ? `${activePlace.label} (${activePlace.stateCode})`
    : "your selected place";

  const visibleDays = useMemo<HistoryDayViewModel[]>(() => {
    return days
      .map((day) => {
        const filteredEntries = day.entries.filter((entry) =>
          entryMatchesFilters(entry, typeFilter, severityFilter)
        );

        if (typeFilter === "all" && severityFilter === "all") {
          return day;
        }

        return {
          ...day,
          entries: filteredEntries,
          summary: summarizeEntries(filteredEntries, {
            activeAlertCount: day.summary.activeAlertCount,
            activeWarningCount: day.summary.activeWarningCount,
            activeMajorCount: day.summary.activeMajorCount
          })
        };
      })
      .filter((day) => day.entries.length > 0 || day.summary.activeAlertCount > 0);
  }, [days, severityFilter, typeFilter]);

  return (
    <section className="history-page">
      {isOffline ? (
        <section className="message offline-message" role="status">
          You are offline. Showing cached alert history when available. Reconnect to
          refresh this timeline.
        </section>
      ) : null}

      <section className="history-hero">
        <div>
          <p className="history-eyebrow">Review mode</p>
          <h2>Alert history</h2>
          <p>
            Review lifecycle activity by day for {placeContextLabel}. Expired alerts are
            kept here so closure context is still visible.
          </p>
        </div>
      </section>

      <section className="history-controls" aria-label="History filters">
        <label className="field">
          <span>Window</span>
          <select
            value={windowDays}
            onChange={(event) => setWindowDays(Number(event.target.value))}
          >
            {HISTORY_WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {activePlace?.countyCode ? (
          <label className="field">
            <span>Place scope</span>
            <select
              value={placeScope}
              onChange={(event) => setPlaceScope(event.target.value as PlaceScope)}
            >
              <option value="county">{activePlace.countyName || "Primary county"}</option>
              <option value="state">Entire {activePlace.stateCode}</option>
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>Type</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as AlertTypeFilter)}
          >
            {ALERT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Severity</span>
          <select
            value={severityFilter}
            onChange={(event) => setSeverityFilter(event.target.value as SeverityFilter)}
          >
            {SEVERITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {loadState === "loading" ? (
        <section className="history-loading" role="status">
          Loading alert history…
        </section>
      ) : null}

      {loadState === "error" ? (
        <section className="message error-message" role="alert">
          <strong>Could not load history:</strong> {errorMessage || "Unexpected error."}
        </section>
      ) : null}

      {loadState === "ready" && visibleDays.length === 0 ? (
        <section className="history-empty-state">
          <h3>No recent alert history for this view</h3>
          <p>
            There are no lifecycle updates matching the current place, window, and filters.
            This history view still works even when there are no active alerts.
          </p>
        </section>
      ) : null}

      {visibleDays.length > 0 ? (
        <section className="history-day-list">
          {visibleDays.map((day) => (
            <HistoryDayCard key={day.day} day={day} />
          ))}
        </section>
      ) : null}
    </section>
  );
}
