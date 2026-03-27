import { useEffect, useMemo, useState } from "react";
import type { AlertRecord, RadarPayload, SavedPlace } from "../../../types";
import { getRadar } from "../../../lib/api/radar";
import { formatDateTime } from "../utils";

type AlertRadarPanelProps = {
  alert: AlertRecord;
  savedPlace: SavedPlace | null;
  isOffline: boolean;
};

type RadarLoadState = "idle" | "loading" | "ready" | "error";

type RadarCoordinates = {
  lat: number;
  lon: number;
  sourceLabel: string;
};

function hasCoordinates(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    typeof lon === "number" &&
    Number.isFinite(lon)
  );
}

function chooseRadarCoordinates(
  alert: AlertRecord,
  savedPlace: SavedPlace | null
): RadarCoordinates | null {
  const alertStateCode = String(alert.stateCode || "").trim().toUpperCase();
  const hasSavedCoordinates = hasCoordinates(savedPlace?.lat, savedPlace?.lon);
  const savedStateCode = String(savedPlace?.stateCode || "").trim().toUpperCase();
  const savedLat = Number(savedPlace?.lat);
  const savedLon = Number(savedPlace?.lon);

  if (
    hasSavedCoordinates &&
    (!alertStateCode || !savedStateCode || savedStateCode === alertStateCode)
  ) {
    return {
      lat: savedLat,
      lon: savedLon,
      sourceLabel: `Saved place: ${savedPlace?.label || savedStateCode}`
    };
  }

  if (hasCoordinates(alert.lat, alert.lon)) {
    return {
      lat: Number(alert.lat),
      lon: Number(alert.lon),
      sourceLabel: "Alert area centroid"
    };
  }

  if (hasSavedCoordinates) {
    return {
      lat: savedLat,
      lon: savedLon,
      sourceLabel: `Saved place fallback: ${savedPlace?.label || savedStateCode || "your location"}`
    };
  }

  return null;
}

export function AlertRadarPanel({
  alert,
  savedPlace,
  isOffline
}: AlertRadarPanelProps) {
  const coordinates = useMemo(
    () => chooseRadarCoordinates(alert, savedPlace),
    [alert, savedPlace]
  );

  const [loadState, setLoadState] = useState<RadarLoadState>(
    coordinates ? "loading" : "idle"
  );
  const [payload, setPayload] = useState<RadarPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!coordinates) {
      setLoadState("idle");
      setPayload(null);
      setErrorMessage(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    setLoadState("loading");
    setPayload(null);
    setErrorMessage(null);

    const load = async () => {
      try {
        const radar = await getRadar(
          { lat: coordinates.lat, lon: coordinates.lon },
          controller.signal
        );
        if (cancelled) return;
        setPayload(radar);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) return;
        setLoadState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Radar is unavailable right now."
        );
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [coordinates?.lat, coordinates?.lon]);

  if (!coordinates) {
    return (
      <section className="alert-radar-panel">
        <p className="alert-radar-empty">
          Radar preview is unavailable because this alert does not have usable
          coordinates yet.
        </p>
      </section>
    );
  }

  const radarImageUrl = payload?.loopImageUrl || payload?.stillImageUrl || "";
  const hasStillFallback =
    Boolean(payload?.loopImageUrl?.trim()) && Boolean(payload?.stillImageUrl?.trim());

  return (
    <section className="alert-radar-panel">
      <header className="alert-radar-header">
        <p>Radar source: {coordinates.sourceLabel}</p>
        {payload?.station ? <p>Station {payload.station}</p> : null}
      </header>

      {loadState === "loading" ? (
        <div className="alert-radar-loading" role="status">
          Loading radar...
        </div>
      ) : null}

      {loadState === "error" ? (
        <div className="message warning-message" role="status">
          Radar is currently unavailable. {errorMessage}
          {isOffline ? " You appear to be offline." : ""}
        </div>
      ) : null}

      {loadState === "ready" && radarImageUrl ? (
        <figure className="alert-radar-figure">
          <img
            src={radarImageUrl}
            alt={`Weather radar near ${alert.areaDesc || "the alert area"}`}
            loading="lazy"
          />
          <figcaption>
            {payload?.updated ? `Updated ${formatDateTime(payload.updated)}.` : "Updated time unavailable."}
            {payload?.stormDirection
              ? ` Storm motion: ${payload.stormDirection}.`
              : ""}
            {hasStillFallback ? " Still-image fallback available." : ""}
          </figcaption>
        </figure>
      ) : null}

      {loadState === "ready" && !radarImageUrl ? (
        <p className="alert-radar-empty">
          Radar imagery was not available for this station at the moment.
        </p>
      ) : null}
    </section>
  );
}
