"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Radar } from "lucide-react";

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const RADAR_COLOR = 2;
const RADAR_OPTIONS = "1_1";
const PREVIEW_ZOOM = 7;

type RadarPreviewLocation = {
  lat: number;
  lon: number;
  label: string;
};

type RainViewerFrame = {
  time: number;
  path: string;
};

/**
 * Inner map component — rendered only when the modal is NOT open.
 * Because it's conditionally mounted by the parent wrapper, React will
 * fully unmount it (running all cleanup) the instant the modal opens,
 * which calls map.remove() and eliminates the ghost marker entirely.
 */
function PreviewMap({
  location,
  host,
  latestFrame,
  onTileError,
}: {
  location: RadarPreviewLocation;
  host: string;
  latestFrame: RainViewerFrame | null;
  onTileError: (msg: string) => void;
}) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<any>(null);

  useEffect(() => {
    if (!mapDivRef.current) return;

    let mounted = true;

    async function initMap() {
      const module = await import("leaflet");
      const L = module.default || module;

      if (!mounted || !mapDivRef.current) return;

      const map = L.map(mapDivRef.current, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        touchZoom: false,
        doubleClickZoom: false,
        scrollWheelZoom: false,
        keyboard: false,
      }).setView([location.lat, location.lon], PREVIEW_ZOOM);

      L.tileLayer(OSM_URL, { maxZoom: 19 }).addTo(map);

      L.circleMarker([location.lat, location.lon], {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: "#3b82f6",
        fillOpacity: 1,
      }).addTo(map);

      if (host && latestFrame) {
        const url = `${host}${latestFrame.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
        const layer = L.tileLayer(url, {
          opacity: 0.9,
          maxZoom: PREVIEW_ZOOM,
          tileSize: 256,
          updateWhenIdle: true,
          updateWhenZooming: false,
        });
        layer.on("tileerror", (e: any) => {
          if (String(e?.error || "").includes("429")) {
            onTileError("Radar busy — updating shortly...");
          }
        });
        layer.addTo(map);
      }

      mapInstance.current = map;
      setTimeout(() => map.invalidateSize(), 0);
    }

    initMap();

    // ← This cleanup runs when React unmounts PreviewMap (i.e. when the
    //   modal opens). Calling map.remove() here is the only 100% reliable
    //   way to kill the Leaflet instance and stop the ghost marker.
    return () => {
      mounted = false;
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, [host, latestFrame, location.lat, location.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={mapDivRef} className="relative z-0 h-48 w-full" />;
}

export default function RadarPreviewCard({
  radar,
  location,
  onViewRadar,
  modalOpen = false,
}: {
  radar?: { summary?: string | null } | null;
  location: RadarPreviewLocation;
  onViewRadar: () => void;
  /** Must be true while the radar modal is open */
  modalOpen?: boolean;
}) {
  const [host, setHost] = useState("");
  const [latestFrame, setLatestFrame] = useState<RainViewerFrame | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          "https://api.rainviewer.com/public/weather-maps.json",
          { cache: "no-store" }
        );
        const data = await res.json();
        setHost(data.host || "https://tilecache.rainviewer.com");
        const allFrames: RainViewerFrame[] = data.radar?.past ?? [];
        setLatestFrame(allFrames[allFrames.length - 1] ?? null);
      } catch {
        // silent
      }
    }
    load();
  }, []);

  const locationLabel = location.label || "Your Area";
  const isRadarLive = !!latestFrame?.time;
  const previewTime = isRadarLive
    ? new Date(latestFrame!.time * 1000).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "--:--";

  return (
    <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase">
          <Radar className="h-5 w-5 text-red-400" />
          Live Radar
        </div>

        <button
          onClick={onViewRadar}
          className={`group relative w-full overflow-hidden rounded-[20px] border border-white/10 transition ${
            modalOpen ? "pointer-events-none opacity-0" : "opacity-100 hover:border-white/20"
          }`}
          aria-label="Open live radar"
        >
          <div className="pointer-events-none absolute inset-0 z-10 bg-white/0 transition group-hover:bg-white/[0.03]" />
          {/*
           * When modalOpen is true, we hide the preview content immediately
           * and avoid any Leaflet rendering behind the opening modal.
           */}
          {!modalOpen ? (
            <PreviewMap
              location={location}
              host={host}
              latestFrame={latestFrame}
              onTileError={setTileError}
            />
          ) : (
            <div className="hidden h-48 w-full bg-slate-900" />
          )}

          <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-xl bg-slate-950/80 px-3 py-2 text-left text-white backdrop-blur-md">
            <div className="text-xs font-semibold text-slate-300">{locationLabel}</div>
          </div>

          <div className="pointer-events-none absolute right-3 bottom-2 z-10 flex items-center gap-2 rounded-xl bg-slate-950/80 px-3 py-2 text-white backdrop-blur-md text-xs font-bold">
            <span>{previewTime}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-2 py-0.5 text-rose-200">
              <span className="h-2 w-2 rounded-full bg-rose-400" />
              LIVE
            </span>
          </div>
        </button>

        {tileError ? (
          <p className="mt-2 rounded-lg bg-rose-500/20 px-3 py-1 text-xs font-semibold text-rose-200">
            {tileError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
