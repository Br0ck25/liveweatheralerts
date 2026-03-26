"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Radar } from "lucide-react";

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const RADAR_COLOR = 2;
const RADAR_OPTIONS = "1_1";
const PREVIEW_ZOOM = 5;

type RadarPreviewLocation = {
  lat: number;
  lon: number;
  label: string;
};

type RainViewerFrame = {
  time: number;
  path: string;
};

export default function RadarPreviewCard({
  location,
  onViewRadar,
  modalOpen = false,
}: {
  location: RadarPreviewLocation;
  onViewRadar: () => void;
  /**
   * Pass `true` while the radar modal is open.
   * The preview map will be fully destroyed to prevent tile/marker bleed-through
   * and recreated when the modal closes.
   */
  modalOpen?: boolean;
}) {
  const mapDivRef = useRef<HTMLDivElement | null>(null);
  const mapInstance = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  const [host, setHost] = useState("");
  const [latestFrame, setLatestFrame] = useState<RainViewerFrame | null>(null);
  const [tileError, setTileError] = useState<string | null>(null);

  // Fetch latest single radar frame once
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          "https://api.rainviewer.com/public/weather-maps.json",
          { cache: "no-store" }
        );
        const data = await res.json();
        setHost(data.host || "https://tilecache.rainviewer.com");
        const frames: RainViewerFrame[] = data.radar?.past ?? [];
        setLatestFrame(frames[frames.length - 1] ?? null);
      } catch {
        // silently ignore; map renders without radar overlay
      }
    }
    load();
  }, []);

  /**
   * Fully destroy the map when the modal opens, fully recreate it when the
   * modal closes. This is the only 100% reliable way to prevent Leaflet's
   * tile layers and markers from bleeding through into the modal's viewport.
   */
  useEffect(() => {
    // Modal just opened → tear down the preview map entirely
    if (modalOpen) {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
      return;
    }

    // Modal closed (or was never open) → initialise / reinitialise the preview map
    if (!mapDivRef.current || mapInstance.current) return;

    let mounted = true;

    async function initMap() {
      const module = await import("leaflet");
      const L = module.default || module;
      leafletRef.current = L;

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

      // Add radar overlay if we already have frame data
      if (host && latestFrame) {
        const url = `${host}${latestFrame.path}/256/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
        const layer = L.tileLayer(url, {
          opacity: 0.75,
          maxZoom: PREVIEW_ZOOM,
          tileSize: 256,
          updateWhenIdle: true,
          updateWhenZooming: false,
        });
        layer.on("tileerror", (e: any) => {
          if (String(e?.error || "").includes("429")) {
            setTileError("Radar rate-limited — try again shortly.");
          }
        });
        layer.addTo(map);
      }

      mapInstance.current = map;
      setTimeout(() => map.invalidateSize(), 0);
    }

    initMap();

    return () => {
      mounted = false;
    };
  // Re-run whenever modal opens/closes, or when radar frame data arrives
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, host, latestFrame]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      mapInstance.current?.remove();
      mapInstance.current = null;
    };
  }, []);

  return (
    <Card className="rounded-[30px] border border-slate-800 bg-slate-950 text-white">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase">
          <Radar className="h-5 w-5 text-red-400" />
          Live Radar
        </div>

        <button
          onClick={onViewRadar}
          className="relative w-full overflow-hidden rounded-[20px] border border-white/10"
          aria-label="Open live radar"
        >
          {modalOpen ? (
            // Placeholder shown while the modal is open (map is destroyed)
            <div className="h-48 w-full rounded-[20px] bg-slate-900" />
          ) : (
            <div ref={mapDivRef} className="h-48 w-full" />
          )}

          <div className="absolute bottom-2 right-2 rounded-lg bg-slate-950/80 px-2 py-1 text-[11px] font-semibold text-slate-300 backdrop-blur">
            Tap to expand
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
