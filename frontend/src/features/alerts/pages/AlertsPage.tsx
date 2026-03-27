import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  AlertChangeRecord,
  AlertRecord,
  AlertTypeFilter,
  AlertsMeta,
  SeverityFilter,
  SortMode
} from "../../../types";
import { getAlertChanges } from "../../../lib/api/alerts";
import {
  readAlertsLastSeenAt,
  writeAlertsLastSeenAt
} from "../../../lib/storage/preferences";
import { AlertLifecycleBadge } from "../components/AlertLifecycleBadge";
import {
  buildAlertChangeSummaryCards,
  formatDateTime,
  selectClosureHighlights
} from "../utils";
import { AlertCard } from "../components/AlertCard";

type AlertsPageProps = {
  isOffline: boolean;
  alertsMeta: AlertsMeta | null;
  alerts: AlertRecord[];
  sortedAlerts: AlertRecord[];
  states: string[];
  query: string;
  stateFilter: string;
  typeFilter: AlertTypeFilter;
  severityFilter: SeverityFilter;
  sortMode: SortMode;
  showFilters: boolean;
  changeSummaryStorageKey: string;
  changeSummaryStateCode: string;
  changeSummaryCountyCode: string;
  changeSummaryLabel: string;
  loadState: "loading" | "ready" | "error";
  errorMessage: string | null;
  warningCount: number;
  watchCount: number;
  expiringSoonCount: number;
  onQueryChange: (value: string) => void;
  onStateFilterChange: (value: string) => void;
  onTypeFilterChange: (value: AlertTypeFilter) => void;
  onSeverityFilterChange: (value: SeverityFilter) => void;
  onSortModeChange: (value: SortMode) => void;
  onShowFiltersChange: (next: boolean) => void;
};

const alertTypeLabel: Record<AlertTypeFilter, string> = {
  all: "All alert types",
  warning: "Warnings",
  watch: "Watches",
  advisory: "Advisories",
  statement: "Statements",
  other: "Other"
};

export function AlertsPage({
  isOffline,
  alertsMeta,
  alerts,
  sortedAlerts,
  states,
  query,
  stateFilter,
  typeFilter,
  severityFilter,
  sortMode,
  showFilters,
  changeSummaryStorageKey,
  changeSummaryStateCode,
  changeSummaryCountyCode,
  changeSummaryLabel,
  loadState,
  errorMessage,
  warningCount,
  watchCount,
  expiringSoonCount,
  onQueryChange,
  onStateFilterChange,
  onTypeFilterChange,
  onSeverityFilterChange,
  onSortModeChange,
  onShowFiltersChange
}: AlertsPageProps) {
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(() =>
    readAlertsLastSeenAt(changeSummaryStorageKey)
  );
  const [changes, setChanges] = useState<AlertChangeRecord[]>([]);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [changesLoadState, setChangesLoadState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");

  useEffect(() => {
    setLastSeenAt(readAlertsLastSeenAt(changeSummaryStorageKey));
  }, [changeSummaryStorageKey]);

  useEffect(() => {
    return () => {
      writeAlertsLastSeenAt(new Date().toISOString(), changeSummaryStorageKey);
    };
  }, [changeSummaryStorageKey]);

  useEffect(() => {
    if (!lastSeenAt) {
      setChanges([]);
      setChangesLoadState("idle");
      setChangesError(null);
      return;
    }

    const currentScopedLastSeenAt = readAlertsLastSeenAt(changeSummaryStorageKey);
    if (currentScopedLastSeenAt !== lastSeenAt) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setChangesLoadState("loading");
      setChangesError(null);
      try {
        const payload = await getAlertChanges({
          since: lastSeenAt,
          state: changeSummaryStateCode || undefined,
          countyCode: changeSummaryCountyCode || undefined,
          signal: controller.signal
        });
        if (cancelled) return;
        setChanges(payload.changes);
        setChangesLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setChanges([]);
        setChangesLoadState("error");
        setChangesError(
          error instanceof Error ? error.message : "Unable to summarize alert changes."
        );
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [changeSummaryCountyCode, changeSummaryStateCode, changeSummaryStorageKey, lastSeenAt]);

  const summaryCards = useMemo(
    () => buildAlertChangeSummaryCards(changes, changeSummaryLabel),
    [changeSummaryLabel, changes]
  );
  const closureHighlights = useMemo(() => selectClosureHighlights(changes, 4), [changes]);
  const hasChangeSummary = Boolean(lastSeenAt && summaryCards.length > 0);

  return (
    <>
      {isOffline ? (
        <section className="message offline-message" role="status">
          You are offline. Showing cached alert data when available. Reconnect to
          refresh active alerts.
        </section>
      ) : null}

      {alertsMeta?.stale ? (
        <section className="message warning-message" role="status">
          Alert data may be stale ({alertsMeta.staleMinutes} minutes old). Last
          update: {alertsMeta.lastPoll ? formatDateTime(alertsMeta.lastPoll) : "unknown"}.
        </section>
      ) : null}

      {lastSeenAt ? (
        <section className="alerts-change-banner" role="status" aria-live="polite">
          <div className="alerts-change-banner-head">
            <p>
              What changed for {changeSummaryLabel} since your last visit (
              {formatDateTime(lastSeenAt)})
            </p>
            {changesLoadState === "loading" ? <span>Updating…</span> : null}
          </div>

          {changesLoadState === "error" ? (
            <p className="alerts-change-banner-error">
              Could not load recent changes. {changesError || ""}
            </p>
          ) : null}

          {hasChangeSummary ? (
            <>
              <div className="alerts-change-summary-grid">
                {summaryCards.map((card) => (
                  <article
                    key={card.id}
                    className={`alerts-change-summary-card alerts-change-summary-${card.tone}`}
                  >
                    <div className="alerts-change-summary-top">
                      <AlertLifecycleBadge
                        status={card.id}
                        className="alerts-change-summary-badge"
                      />
                      <strong>{card.count}</strong>
                    </div>
                    <p className="alerts-change-summary-title">{card.title}</p>
                    <p className="alerts-change-summary-detail">{card.detail}</p>
                  </article>
                ))}
              </div>

              {closureHighlights.length > 0 ? (
                <div className="alerts-change-closure-wrap" id="alerts-change-recent">
                  <p className="alerts-change-closure-title">Recent closure updates</p>
                  <ul className="alerts-change-list">
                    {closureHighlights.map((change) => (
                      <li key={`${change.alertId}-${change.changeType}-${change.changedAt}`}>
                        <AlertLifecycleBadge status={change.changeType} />
                        <span>
                          {change.event} • {change.areaDesc || "Area unavailable"} •{" "}
                          {formatDateTime(change.changedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="alerts-change-history-note">
                Need more context?{" "}
                <Link to="/history" className="alerts-history-link">
                  Open alert history review mode.
                </Link>
              </p>

              <ul className="alerts-change-list">
                {changes.slice(0, 4).map((change) => (
                  <li key={`${change.alertId}-${change.changeType}-${change.changedAt}`}>
                    <AlertLifecycleBadge status={change.changeType} />
                    <span>
                      {change.event} • {change.areaDesc || "Area unavailable"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : changesLoadState === "ready" ? (
            <p className="alerts-change-banner-none">
              No major alert lifecycle changes since your last visit.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="metric-grid">
        <article className="metric-card">
          <p>Total Active Alerts</p>
          <strong>{alerts.length}</strong>
        </article>
        <article className="metric-card warning-metric">
          <p>Warnings</p>
          <strong>{warningCount}</strong>
        </article>
        <article className="metric-card">
          <p>Watches</p>
          <strong>{watchCount}</strong>
        </article>
        <article className="metric-card soon-metric">
          <p>Expiring Within 2h</p>
          <strong>{expiringSoonCount}</strong>
        </article>
      </section>

      <section className="filters-panel">
        <div className="filters-header">
          <p className="filters-title">Filters and Search</p>
          <button
            type="button"
            className="text-btn"
            onClick={() => onShowFiltersChange(!showFilters)}
            aria-expanded={showFilters}
            aria-controls="alerts-filters-fields"
          >
            {showFilters ? "Hide" : "Show"}
          </button>
        </div>

        {showFilters ? (
          <div id="alerts-filters-fields">
            <label className="field">
              <span>Search alerts</span>
              <input
                type="search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search by event, area, severity, or text..."
              />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>State</span>
                <select
                  value={stateFilter}
                  onChange={(event) => onStateFilterChange(event.target.value)}
                >
                  <option value="all">All states</option>
                  {states.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Type</span>
                <select
                  value={typeFilter}
                  onChange={(event) =>
                    onTypeFilterChange(event.target.value as AlertTypeFilter)
                  }
                >
                  {Object.entries(alertTypeLabel).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Severity</span>
                <select
                  value={severityFilter}
                  onChange={(event) =>
                    onSeverityFilterChange(event.target.value as SeverityFilter)
                  }
                >
                  <option value="all">All severities</option>
                  <option value="extreme">Extreme</option>
                  <option value="severe">Severe</option>
                  <option value="moderate">Moderate</option>
                  <option value="minor">Minor</option>
                  <option value="unknown">Unknown</option>
                </select>
              </label>

              <label className="field">
                <span>Sort</span>
                <select
                  value={sortMode}
                  onChange={(event) => onSortModeChange(event.target.value as SortMode)}
                >
                  <option value="priority">Highest priority first</option>
                  <option value="expires">Expiring soonest first</option>
                  <option value="latest">Latest updated first</option>
                </select>
              </label>
            </div>
          </div>
        ) : null}
      </section>

      {errorMessage ? (
        <section className="message error-message" role="alert">
          <strong>Could not load alerts:</strong> {errorMessage}
        </section>
      ) : null}

      <section className="alerts-panel">
        {loadState === "loading" && alerts.length === 0 ? (
          <div className="skeleton-grid">
            <div className="skeleton-card" />
            <div className="skeleton-card" />
            <div className="skeleton-card" />
          </div>
        ) : null}

        {loadState !== "loading" && sortedAlerts.length === 0 ? (
          <div className="empty-state">
            <h2>{closureHighlights.length > 0 ? "No active alerts right now" : "No matching alerts"}</h2>
            <p>
              {closureHighlights.length > 0
                ? "Recent lifecycle updates indicate major alerts have expired or cleared."
                : "There are no active alerts for the current filters. Clear one or more filters to broaden results."}
            </p>
            <p>
              <Link to="/history" className="alerts-history-link">
                Review recent alert history
              </Link>
            </p>
          </div>
        ) : null}

      {sortedAlerts.map((alert, index) => (
        <AlertCard key={`${alert.id}-${alert.sent}-${index}`} alert={alert} index={index} />
      ))}
    </section>

      <footer className="site-footer">
        <p>Data source: NOAA/NWS active alerts feed.</p>
      </footer>
    </>
  );
}
