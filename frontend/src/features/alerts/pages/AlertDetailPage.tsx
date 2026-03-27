import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getAlertById, getAlertChanges } from "../../../lib/api/alerts";
import { trackEvent } from "../../../lib/analytics/events";
import { copyTextToClipboard } from "../../../lib/browser/clipboard";
import type {
  AlertChangeRecord,
  AlertRecord,
  AlertsMeta,
  SavedPlace
} from "../../../types";
import { AlertActionTools } from "../components/AlertActionTools";
import { AlertDetailSection } from "../components/AlertDetailSection";
import { AlertLifecycleBadge } from "../components/AlertLifecycleBadge";
import { ImpactCard } from "../components/ImpactCard";
import { AlertRadarPanel } from "../components/AlertRadarPanel";
import { AlertTimeline } from "../components/AlertTimeline";
import {
  buildImpactCardsForAlert,
  canonicalAlertDetailPath,
  classifyAlertType,
  deriveAlertLifecycleStatus,
  formatDateTime,
  formatLabel,
  instructionsSummaryFromAlert,
  summaryFromAlert,
  uniqueAffectedAreas
} from "../utils";

type AlertDetailPageProps = {
  isOffline: boolean;
  savedPlace: SavedPlace | null;
  refreshToken?: number;
  onRefreshSettled?: (refreshToken: number) => void;
};

type AlertDetailLoadState = "loading" | "ready" | "not_found" | "error";

function decodeAlertId(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function AlertDetailPage({
  isOffline,
  savedPlace,
  refreshToken = 0,
  onRefreshSettled
}: AlertDetailPageProps) {
  const navigate = useNavigate();
  const { alertId: rawAlertId } = useParams();
  const routeAlertId = decodeAlertId(rawAlertId);

  const [loadState, setLoadState] = useState<AlertDetailLoadState>("loading");
  const [alert, setAlert] = useState<AlertRecord | null>(null);
  const [detailMeta, setDetailMeta] = useState<AlertsMeta | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [closureChange, setClosureChange] = useState<AlertChangeRecord | null>(null);
  const [closureLookupState, setClosureLookupState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let settled = false;
    const settleRefresh = () => {
      if (settled) return;
      settled = true;
      onRefreshSettled?.(refreshToken);
    };

    if (!routeAlertId) {
      setAlert(null);
      setDetailMeta(null);
      setLoadState("not_found");
      setErrorMessage("Alert not found.");
      settleRefresh();
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setLoadState("loading");
    setAlert(null);
    setDetailMeta(null);
    setErrorMessage(null);
    setActionMessage(null);
    setClosureChange(null);
    setClosureLookupState("idle");

    const loadAlert = async () => {
      try {
        const payload = await getAlertById(routeAlertId, controller.signal);
        if (cancelled) return;

        setAlert(payload.alert);
        setDetailMeta(payload.meta);
        setLoadState("ready");
        settleRefresh();
        trackEvent("alert_detail_viewed", {
          alertId: payload.alert.id,
          event: payload.alert.event,
          category: payload.alert.category || ""
        });
      } catch (error) {
        if (cancelled) return;
        const message =
          error instanceof Error ? error.message : "Unable to load alert details.";
        if (/not found/i.test(message)) {
          setLoadState("not_found");
          setErrorMessage("Alert not found.");
          setClosureLookupState("loading");
          try {
            const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
            const changesPayload = await getAlertChanges({
              since,
              signal: controller.signal
            });
            if (cancelled) return;
            const recentClosure =
              changesPayload.changes.find(
                (change) =>
                  change.alertId === routeAlertId &&
                  (change.changeType === "expired" || change.changeType === "all_clear")
              ) ?? null;
            setClosureChange(recentClosure);
            setClosureLookupState("ready");
          } catch {
            if (cancelled) return;
            setClosureChange(null);
            setClosureLookupState("error");
          }
          settleRefresh();
        } else {
          setLoadState("error");
          setErrorMessage(message);
          settleRefresh();
        }
      }
    };

    void loadAlert();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [onRefreshSettled, refreshToken, reloadToken, routeAlertId]);

  const canonicalPath = useMemo(() => {
    if (!alert) {
      if (!routeAlertId) return "/alerts";
      return `/alerts/${encodeURIComponent(routeAlertId)}`;
    }
    return canonicalAlertDetailPath(alert);
  }, [alert, routeAlertId]);

  const canonicalAbsoluteUrl = useMemo(() => {
    if (typeof window === "undefined") return canonicalPath;
    return new URL(canonicalPath, window.location.origin).toString();
  }, [canonicalPath]);

  const summary = alert ? summaryFromAlert(alert) : "";
  const instructionsSummary = alert ? instructionsSummaryFromAlert(alert) : "";
  const instructions = String(alert?.instruction || "").trim();
  const areaList = uniqueAffectedAreas(alert?.areaDesc || "");
  const issuedAt = alert?.sent || alert?.updated || alert?.effective || "";
  const effectiveAt = alert?.effective || alert?.onset || alert?.sent || "";
  const updatedAt = alert?.updated || alert?.sent || alert?.effective || "";
  const expiresAt = alert?.expires || "";
  const lifecycleStatus = alert ? deriveAlertLifecycleStatus(alert) : null;
  const impactCards = useMemo(
    () => (alert ? buildImpactCardsForAlert(alert, { maxCards: 4 }) : []),
    [alert]
  );

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/alerts");
  };

  const setCopyResult = (ok: boolean, successText: string) => {
    if (ok) {
      setActionMessage(successText);
      return;
    }
    setActionMessage("Copy is unavailable in this browser context.");
  };

  const handleCopyLink = async () => {
    const ok = await copyTextToClipboard(canonicalAbsoluteUrl);
    setCopyResult(ok, "Alert link copied.");
    if (ok && alert) {
      trackEvent("alert_detail_link_copied", { alertId: alert.id });
    }
  };

  const handleCopySafetySteps = async () => {
    const safetyText = instructions || instructionsSummary || summary;
    const ok = await copyTextToClipboard(safetyText);
    setCopyResult(ok, "Safety guidance copied.");
    if (ok && alert) {
      trackEvent("alert_detail_safety_copied", { alertId: alert.id });
    }
  };

  const handleShare = async () => {
    if (!alert) return;

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: alert.headline || alert.event || "Weather alert",
          text: summary || alert.event || "Weather alert details",
          url: canonicalAbsoluteUrl
        });
        setActionMessage("Alert shared.");
        trackEvent("alert_detail_shared", { alertId: alert.id });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    await handleCopyLink();
  };

  const handleOpenRadar = () => {
    if (alert) {
      trackEvent("alert_detail_radar_clicked", { alertId: alert.id });
    }
    const radarAnchor = document.getElementById("alert-radar-panel");
    if (radarAnchor) {
      radarAnchor.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start"
      });
      setActionMessage("Showing local radar context.");
      return;
    }
    setActionMessage("Radar context is unavailable for this alert.");
  };

  return (
    <section className="alert-detail-page">
      {isOffline ? (
        <section className="message offline-message" role="status">
          You are offline. Showing cached alert detail when available. Reconnect to
          refresh this route with live data.
        </section>
      ) : null}

      {detailMeta?.stale ? (
        <section className="message warning-message" role="status">
          Alert data may be stale ({detailMeta.staleMinutes} minutes old). Last
          update:{" "}
          {detailMeta.lastPoll
            ? formatDateTime(detailMeta.lastPoll)
            : formatDateTime(detailMeta.generatedAt)}.
        </section>
      ) : null}

      <nav className="alert-detail-nav" aria-label="Alert detail navigation">
        <button type="button" className="text-btn" onClick={handleBack}>
          Back
        </button>
        <Link className="sheet-link-muted" to="/alerts">
          All alerts
        </Link>
      </nav>

      {loadState === "loading" ? (
        <section className="alert-detail-state">
          <div className="message warning-message" role="status">
            Loading alert details...
          </div>
          <div className="skeleton-card alert-detail-skeleton" />
        </section>
      ) : null}

      {loadState === "error" ? (
        <section className="alert-detail-state">
          <div className="message error-message" role="alert">
            <strong>Could not load alert details:</strong>{" "}
            {errorMessage || "Unexpected error."}
          </div>
          <div className="alert-detail-state-actions">
            <button
              type="button"
              className="text-btn"
              onClick={() => setReloadToken((value) => value + 1)}
            >
              Retry
            </button>
            <Link className="text-btn alert-detail-link-btn" to="/alerts">
              Back to alerts
            </Link>
          </div>
        </section>
      ) : null}

      {loadState === "not_found" ? (
        <section className="alert-detail-state">
          <div className="message error-message" role="alert">
            <strong>Alert not found.</strong> The alert may have expired or the link is
            invalid.
          </div>
          {closureChange ? (
            <div className="message warning-message" role="status">
              <p className="alert-detail-closure-head">
                <AlertLifecycleBadge status={closureChange.changeType} />
                <strong>
                  {closureChange.event || "Weather alert"} has {closureChange.changeType === "all_clear" ? "cleared" : "expired"}.
                </strong>
              </p>
              <p>
                {closureChange.areaDesc || "Area unavailable"} ·{" "}
                {formatDateTime(closureChange.changedAt)}
              </p>
              <p className="alert-detail-history-note">
                Review day-by-day closure context in{" "}
                <Link to="/history">alert history review mode</Link>.
              </p>
            </div>
          ) : null}
          {closureLookupState === "loading" ? (
            <p className="alert-detail-history-note">Checking recent lifecycle updates…</p>
          ) : null}
          <Link className="text-btn alert-detail-link-btn" to="/alerts">
            Go to alerts
          </Link>
        </section>
      ) : null}

      {loadState === "ready" && alert ? (
        <>
          <article
            className={`alert-detail-hero alert-sheet alert-sheet-${classifyAlertType(
              alert.event
            )}`}
          >
            <div className="sheet-event-row">
              <p className={`sheet-event sheet-event-${classifyAlertType(alert.event)}`}>
                {(alert.event || "Weather Alert").toUpperCase()}
              </p>
              {lifecycleStatus ? <AlertLifecycleBadge status={lifecycleStatus} /> : null}
            </div>
            <h2>{alert.headline || alert.event || "Weather Alert Detail"}</h2>
            <p className="alert-detail-hero-area">
              {alert.areaDesc || "Affected area details unavailable."}
            </p>
            <p className="alert-detail-hero-summary">{summary}</p>
          </article>

          {actionMessage ? (
            <section className="message offline-message" role="status" aria-live="polite">
              {actionMessage}
            </section>
          ) : null}

          {lifecycleStatus === "expired" || lifecycleStatus === "all_clear" ? (
            <section className="message warning-message" role="status">
              <p className="alert-detail-closure-head">
                <AlertLifecycleBadge status={lifecycleStatus} />
                <strong>
                  {lifecycleStatus === "all_clear"
                    ? "All clear has been issued for this alert thread."
                    : "This alert has expired."}
                </strong>
              </p>
              <p className="alert-detail-history-note">
                For closure context, review <Link to="/history">alert history review mode</Link>.
              </p>
            </section>
          ) : null}

          <AlertActionTools
            onShare={handleShare}
            onCopyLink={handleCopyLink}
            onCopySafetySteps={handleCopySafetySteps}
            onOpenRadar={handleOpenRadar}
          />

          {impactCards.length > 0 ? (
            <AlertDetailSection title="Impact Right Now">
              <div className="impact-card-grid impact-card-grid-detail">
                {impactCards.map((card) => (
                  <ImpactCard key={card.id} card={card} />
                ))}
              </div>
            </AlertDetailSection>
          ) : null}

          <AlertDetailSection title="Headline">
            <p>{alert.headline || summary}</p>
          </AlertDetailSection>

          <AlertDetailSection title="Severity, Urgency, Certainty">
            <div className="alert-detail-meta-grid">
              <article>
                <h3>Severity</h3>
                <p>{formatLabel(alert.severity)}</p>
              </article>
              <article>
                <h3>Urgency</h3>
                <p>{formatLabel(alert.urgency)}</p>
              </article>
              <article>
                <h3>Certainty</h3>
                <p>{formatLabel(alert.certainty)}</p>
              </article>
            </div>
          </AlertDetailSection>

          <AlertDetailSection title="Affected Area">
            {areaList.length > 0 ? (
              <ul className="alert-detail-area-list">
                {areaList.map((area) => (
                  <li key={area}>{area}</li>
                ))}
              </ul>
            ) : (
              <p>{alert.areaDesc || "Area details unavailable."}</p>
            )}
          </AlertDetailSection>

          <AlertDetailSection title="Timing and Countdown">
            <AlertTimeline
              issuedAt={issuedAt}
              effectiveAt={effectiveAt}
              updatedAt={updatedAt}
              expiresAt={expiresAt}
            />
          </AlertDetailSection>

          <AlertDetailSection title="Radar Context">
            <div id="alert-radar-panel">
              <AlertRadarPanel
                alert={alert}
                savedPlace={savedPlace}
                isOffline={isOffline}
              />
            </div>
          </AlertDetailSection>

          <AlertDetailSection title="Plain-English Summary">
            <p>{summary}</p>
          </AlertDetailSection>

          <AlertDetailSection title="Instructions and Safety Guidance">
            <p>{instructionsSummary || "Follow local emergency guidance."}</p>
            {instructions ? <p>{instructions}</p> : null}
          </AlertDetailSection>

          {alert.nwsUrl.trim().startsWith("http") ? (
            <a
              className="sheet-cta"
              href={alert.nwsUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open official NWS alert
            </a>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
