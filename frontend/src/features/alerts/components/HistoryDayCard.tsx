import { Link } from "react-router-dom";
import type { AlertHistoryDay, AlertHistoryEntry } from "../../../types";
import { AlertLifecycleBadge } from "./AlertLifecycleBadge";
import { formatDateTime } from "../utils";

type HistoryDayCardProps = {
  day: AlertHistoryDay;
};

type PlaceActivityRow = {
  placeLabel: string;
  count: number;
};

function formatHistoryDayLabel(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(parsed)) return day;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric"
  }).format(parsed);
}

function formatHistoryEntryTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function buildPlaceActivityRows(entries: AlertHistoryEntry[]): PlaceActivityRow[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = entry.areaDesc.trim() || "Area unavailable";
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([placeLabel, count]) => ({ placeLabel, count }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.placeLabel.localeCompare(b.placeLabel);
    })
    .slice(0, 4);
}

function isNavigableAlertId(alertId: string): boolean {
  const normalized = alertId.trim().toLowerCase();
  return Boolean(normalized) && !normalized.startsWith("all-clear:");
}

export function HistoryDayCard({ day }: HistoryDayCardProps) {
  const placeRows = buildPlaceActivityRows(day.entries);

  return (
    <article className="history-day-card">
      <header className="history-day-header">
        <div>
          <h3>{formatHistoryDayLabel(day.day)}</h3>
          <p>
            {day.summary.totalEntries} update
            {day.summary.totalEntries === 1 ? "" : "s"} tracked
          </p>
        </div>
        <p className="history-day-generated-at">
          Updated {formatDateTime(day.generatedAt)}
        </p>
      </header>

      <section className="history-day-summary-grid" aria-label="Day summary counts">
        <article className="history-day-summary-card">
          <span>Active alerts seen</span>
          <strong>{day.summary.activeAlertCount}</strong>
        </article>
        <article className="history-day-summary-card">
          <span>Warnings seen</span>
          <strong>{day.summary.activeWarningCount}</strong>
        </article>
        <article className="history-day-summary-card">
          <span>Major alerts seen</span>
          <strong>{day.summary.activeMajorCount}</strong>
        </article>
        <article className="history-day-summary-card">
          <span>Lifecycle updates</span>
          <strong>{day.summary.totalEntries}</strong>
        </article>
      </section>

      <section className="history-day-lifecycle" aria-label="Lifecycle activity">
        <p>Lifecycle activity</p>
        <div className="history-day-lifecycle-chips">
          <span>
            <AlertLifecycleBadge status="new" /> {day.summary.byLifecycle.new}
          </span>
          <span>
            <AlertLifecycleBadge status="updated" /> {day.summary.byLifecycle.updated}
          </span>
          <span>
            <AlertLifecycleBadge status="extended" /> {day.summary.byLifecycle.extended}
          </span>
          <span>
            <AlertLifecycleBadge status="expired" /> {day.summary.byLifecycle.expired}
          </span>
          <span>
            <AlertLifecycleBadge status="all_clear" /> {day.summary.byLifecycle.all_clear}
          </span>
        </div>
      </section>

      {day.summary.topEvents.length > 0 ? (
        <section className="history-day-top-events" aria-label="Top alert types">
          <p>Top alert types</p>
          <ul>
            {day.summary.topEvents.map((event) => (
              <li key={`${day.day}-${event.event}`}>
                <span>{event.event}</span>
                <strong>{event.count}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {day.summary.notableWarnings.length > 0 ? (
        <section className="history-day-notable" aria-label="Notable warnings">
          <p>Notable warnings</p>
          <ul>
            {day.summary.notableWarnings.map((warning) => (
              <li
                key={`${warning.alertId}-${warning.changedAt}-${warning.changeType}`}
              >
                <AlertLifecycleBadge status={warning.changeType} />
                <span>
                  {warning.event} • {warning.areaDesc || "Area unavailable"} •{" "}
                  {warning.severity || "Unknown"} • {formatHistoryEntryTime(warning.changedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {placeRows.length > 0 ? (
        <section className="history-day-places" aria-label="Place activity">
          <p>Place activity</p>
          <ul>
            {placeRows.map((row) => (
              <li key={`${day.day}-${row.placeLabel}`}>
                <span>{row.placeLabel}</span>
                <strong>{row.count}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="history-day-entries" aria-label="History entries">
        <p>Recent updates</p>
        <ul>
          {day.entries.slice(0, 10).map((entry) => {
            const detailPath = `/alerts/${encodeURIComponent(entry.alertId)}`;
            return (
              <li key={`${entry.alertId}-${entry.changeType}-${entry.changedAt}`}>
                <AlertLifecycleBadge status={entry.changeType} />
                <div>
                  <p className="history-entry-event">
                    {isNavigableAlertId(entry.alertId) ? (
                      <Link to={detailPath}>{entry.event}</Link>
                    ) : (
                      <span>{entry.event}</span>
                    )}
                  </p>
                  <p className="history-entry-meta">
                    {entry.areaDesc || "Area unavailable"} • {entry.severity || "Unknown"} •{" "}
                    {formatHistoryEntryTime(entry.changedAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
