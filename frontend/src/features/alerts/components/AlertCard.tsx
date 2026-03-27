import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AlertRecord } from "../../../types";
import { AlertLifecycleBadge } from "./AlertLifecycleBadge";
import {
  alertAnchorId,
  canonicalAlertDetailPath,
  classifyAlertType,
  deriveAlertLifecycleStatus,
  formatDateTime,
  formatLabel,
  formatTimeLeft,
  stateLabelFromCode,
  summaryFromAlert,
  textLines,
  uniqueAffectedAreas
} from "../utils";

type AlertCardProps = {
  alert: AlertRecord;
  index: number;
  isHighlighted?: boolean;
};

export function AlertCard({ alert, index, isHighlighted = false }: AlertCardProps) {
  const [isExpanded, setIsExpanded] = useState(isHighlighted);

  useEffect(() => {
    if (isHighlighted) {
      setIsExpanded(true);
    }
  }, [isHighlighted]);

  const alertType = classifyAlertType(alert.event);
  const anchorId = alertAnchorId(alert.id);
  const description = textLines(alert.description);
  const instruction = textLines(alert.instruction);
  const sourceLabel = alert.stateCode.trim() ? alert.stateCode : "US";
  const summary = summaryFromAlert(alert);
  const sentTime = alert.sent || alert.effective || alert.onset;
  const updatedTime = alert.updated || sentTime;
  const detailsRegionId = `${anchorId}-details`;
  const sectionValue = (lines: string[], labels: string[]): string => {
    for (const line of lines) {
      for (const label of labels) {
        const prefix = `${label}:`;
        if (line.toUpperCase().startsWith(prefix)) {
          return line.slice(prefix.length).trim();
        }
      }
    }
    return "";
  };

  const what = sectionValue(description, ["WHAT", "HAZARD"]) || summary;
  const where =
    sectionValue(description, ["WHERE"]) ||
    alert.areaDesc ||
    "Area details unavailable.";
  const when = sectionValue(description, ["WHEN"]);
  const impacts = sectionValue(description, ["IMPACTS", "IMPACT"]);
  const additional = sectionValue(description, ["ADDITIONAL DETAILS"]);
  const instructionsText =
    sectionValue(instruction, ["INSTRUCTIONS", "PRECAUTIONARY ACTIONS"]) ||
    instruction.join(" ").trim();
  const areaList = uniqueAffectedAreas(alert.areaDesc || where);
  const countyCount = areaList.length || 1;
  const stateLabel = stateLabelFromCode(sourceLabel);
  const detailPath = canonicalAlertDetailPath(alert);
  const stateCountySummary = `${stateLabel} • ${countyCount} ${
    countyCount === 1 ? "county" : "counties"
  }`;
  const lifecycleStatus = deriveAlertLifecycleStatus(alert);

  return (
    <article
      id={anchorId}
      className={`alert-sheet alert-sheet-${alertType}${
        isHighlighted ? " alert-sheet-highlighted" : ""
      }`}
      style={{ animationDelay: `${Math.min(index * 45, 420)}ms` }}
    >
      <header className="sheet-head">
        <div>
          <div className="sheet-event-row">
            <p className={`sheet-event sheet-event-${alertType}`}>
              {(alert.event || "Weather Alert").toUpperCase()}
            </p>
            {lifecycleStatus ? (
              <AlertLifecycleBadge status={lifecycleStatus} />
            ) : null}
          </div>
          <h3>{stateCountySummary}</h3>
        </div>
      </header>

      <section className="sheet-callout">
        <h4>PRIMARY ALERT AREA</h4>
        <p>{where}</p>
      </section>

      <section className="sheet-time-grid">
        <div className="sheet-time-cell">
          <h5>ISSUED</h5>
          <p>{formatDateTime(sentTime)}</p>
        </div>
        <div className="sheet-time-cell">
          <h5>EXPIRES</h5>
          <p>{formatDateTime(alert.expires)}</p>
        </div>
        <div className="sheet-time-cell">
          <h5>TIME LEFT</h5>
          <p>{formatTimeLeft(alert.expires)}</p>
        </div>
      </section>

      <Link className="sheet-detail-link" to={detailPath}>
        Open full alert details
      </Link>

      <button
        type="button"
        className="sheet-toggle"
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
        aria-controls={detailsRegionId}
      >
        {isExpanded ? "Collapse details" : "Expand details"}
      </button>

      {isExpanded ? (
        <div id={detailsRegionId}>
          <section className="sheet-section">
            <h4>AFFECTED AREAS</h4>
            <p>{alert.areaDesc || where}</p>
          </section>

          <section className="sheet-section">
            <h4>WHAT</h4>
            <p>{what}</p>
          </section>

          {when ? (
            <section className="sheet-section">
              <h4>WHEN</h4>
              <p>{when}</p>
            </section>
          ) : null}

          {impacts ? (
            <section className="sheet-section">
              <h4>IMPACTS</h4>
              <p>{impacts}</p>
            </section>
          ) : null}

          {instructionsText ? (
            <section className="sheet-section">
              <h4>INSTRUCTIONS</h4>
              <p>{instructionsText}</p>
            </section>
          ) : null}

          {additional ? (
            <section className="sheet-section">
              <h4>ADDITIONAL DETAILS</h4>
              <p>{additional}</p>
            </section>
          ) : null}

          <footer className="sheet-footer">
            <div>
              <span className="sheet-footer-label">Status</span>
              <p>{formatLabel(alert.status)}</p>
            </div>
            <div>
              <span className="sheet-footer-label">Severity</span>
              <p>{formatLabel(alert.severity)}</p>
            </div>
            <div>
              <span className="sheet-footer-label">Updated</span>
              <p>{formatDateTime(updatedTime)}</p>
            </div>
          </footer>

          {alert.nwsUrl.trim().startsWith("http") ? (
            <a
              className="sheet-cta"
              href={alert.nwsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View official NWS alert
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
