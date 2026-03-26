"use client";

import { useEffect, useRef, useState } from "react";
import {
  X,
  MapPin,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

type RadarModalProps = {
  open: boolean;
  onClose: () => void;
  location: {
    lat: number;
    lon: number;
    label: string;
  };
  radar?: {
    station?: string | null;
    updated?: string;
    summary?: string;
  } | null;
};

type RainViewerFrame = {
  time: number;
  path: string;
};

type RainViewerResponse = {
  host?: string;
  radar?: {
    past?: RainViewerFrame[];
    nowcast?: RainViewerFrame[];
  };
};

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = "&copy; OpenStreetMap contributors";
const RADAR_COLOR = 2;
const RADAR_OPTIONS = "1_1";
const MODAL_ZOOM = 5;
const FRAME_INTERVAL_MS = 6_000;

function formatFrameTime(unixSeconds?: number) {
  if (!unixSeconds) return "Latest";
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildRainViewerTileUrl(host: string, path: string) {
  return `${host}${path}/256/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
}

export default function RadarMapModal({
  open,
  onClose,
  location,
  radar,
}: RadarModalProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const radarLayerRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  const [isLeafletLoaded, setIsLeafletLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [host, setHost] = useState("");
  const [frames, setFrames] = useState<RainViewerFrame[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    let active = true;

    async function loadRainViewer() {
      try {
        setLoading(true);
        setLoadError(null);

        const res = await fetch(
          "https://api.rainviewer.com/public/weather-maps.json",
          { cache: "no-store" }
        );

        if (!res.ok) throw new Error("RainViewer request failed");

        const data = (await res.json()) as RainViewerResponse;
        const nextHost = data.host || "https://tilecache.rainviewer.com";
        const nextFrames = data.radar?.past?.slice(-6) ?? [];

        if (!active) return;

        setHost(nextHost);
        setFrames(nextFrames);
        setFrameIndex(Math.max(0, nextFrames.length - 1));
        setLoading(false);
      } catch (err) {
        if (!active) return;
        console.error("RainViewer modal load error:", err);
        setLoadError("Radar unavailable");
        setFrames([]);
        setLoading(false);
      }
    }

    loadRainViewer();
    return () => {
      active = false;
    };
  }, [open]);

  // Initialise Leaflet map when modal opens; destroy when it closes
  useEffect(() => {
    if (!open || !mapContainerRef.current || mapRef.current) return;

    let mounted = true;

    async function initMap() {
      const module = await import("leaflet");
      const L = module.default || module;
      leafletRef.current = L;

      if (!mounted || !mapContainerRef.current) return;

      const map = L.map(mapContainerRef.current, {
        zoomControl: false,
        attributionControl: true,
      }).setView([location.lat, location.lon], MODAL_ZOOM);

      L.tileLayer(OSM_URL, {
        attribution: OSM_ATTRIBUTION,
        maxZoom: 19,
      }).addTo(map);

      const marker = L.circleMarker([location.lat, location.lon], {
        radius: 7,
        color: "#ffffff",
        weight: 2,
        fillColor: "#3b82f6",
        fillOpacity: 1,
      }).addTo(map);

      mapRef.current = map;
      markerRef.current = marker;
      setIsLeafletLoaded(true);
      setTimeout(() => map.invalidateSize(), 0);
    }

    initMap();

    return () => {
      mounted = false;
      if (mapRef.current) {
        mapRef.current.remove();
      }
      mapRef.current = null;
      radarLayerRef.current = null;
      markerRef.current = null;
      leafletRef.current = null;
      setIsLeafletLoaded(false);
    };
  }, [open, location.lat, location.lon]);

  useEffect(() => {
    if (!open || !mapRef.current) return;
    mapRef.current.setView([location.lat, location.lon], MODAL_ZOOM, {
      animate: false,
    });
    markerRef.current?.setLatLng([location.lat, location.lon]);
    setTimeout(() => mapRef.current?.invalidateSize(), 0);
  }, [open, location.lat, location.lon]);

  const currentFramePath = frames[frameIndex]?.path ?? "";

  useEffect(() => {
    if (!open || !mapRef.current || !host || !currentFramePath || !isLeafletLoaded)
      return;

    const L = leafletRef.current;
    if (!L) return;

    const nextUrl = buildRainViewerTileUrl(host, currentFramePath);

    if (!radarLayerRef.current) {
      const layer = L.tileLayer(nextUrl, {
        opacity: 0.8,
        attribution: "",
        maxZoom: MODAL_ZOOM,
        minZoom: 1,
        tileSize: 256,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 1,
      });

      layer.on("tileerror", (event: any) => {
        const errText = String(event?.error || "");
        if (errText.includes("429")) {
          setIsPlaying(false);
          setLoadError("Radar temporarily rate-limited. Retrying in 15 s…");
          setTimeout(() => {
            setLoadError(null);
            setIsPlaying(true);
          }, 15_000);
        }
      });

      layer.addTo(mapRef.current);
      radarLayerRef.current = layer;
    } else {
      radarLayerRef.current.setUrl(nextUrl);
    }
  }, [open, host, currentFramePath, isLeafletLoaded]);

  useEffect(() => {
    if (!open || !isPlaying || frames.length <= 1) return;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, FRAME_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [open, isPlaying, frames.length]);

  function handlePrevFrame() {
    if (!frames.length) return;
    setIsPlaying(false);
    setFrameIndex((prev) => (prev - 1 + frames.length) % frames.length);
  }

  function handleNextFrame() {
    if (!frames.length) return;
    setIsPlaying(false);
    setFrameIndex((prev) => (prev + 1) % frames.length);
  }

  if (!open) return null;

  const currentFrame = frames[frameIndex] ?? null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0 flex flex-col">
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-4 py-3 text-white">
          <div className="min-w-0">
            <div className="text-lg font-black uppercase tracking-wide">
              Live Radar
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <MapPin className="h-3.5 w-3.5" />
              <span className="truncate">{location.label}</span>
              <span>• Frame {formatFrameTime(currentFrame?.time)}</span>
              {radar?.updated ? (
                <span>
                  • Updated{" "}
                  {new Date(radar.updated).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}
              {radar?.summary ? (
                <span className="truncate">• {radar.summary}</span>
              ) : null}
            </div>
          </div>

          <div className="ml-3 flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrevFrame}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-white hover:bg-white/10"
              aria-label="Previous radar frame"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={() => setIsPlaying((v) => !v)}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-white hover:bg-white/10"
              aria-label={isPlaying ? "Pause radar loop" : "Play radar loop"}
            >
              {isPlaying ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="h-5 w-5" />
              )}
            </button>

            <button
              type="button"
              onClick={handleNextFrame}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-white hover:bg-white/10"
              aria-label="Next radar frame"
            >
              <ChevronRight className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-white hover:bg-white/10"
              aria-label="Close radar"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 bg-black">
          <div ref={mapContainerRef} className="absolute inset-0" />

          {loading ? (
            <div className="pointer-events-none absolute left-4 top-4 animate-pulse rounded-2xl border border-white/10 bg-slate-950/85 px-4 py-3 text-sm font-semibold text-white shadow-xl">
              Loading radar…
            </div>
          ) : null}

          {loadError ? (
            <div className="absolute left-4 top-4 max-w-70 rounded-2xl border border-red-400/20 bg-slate-950/90 px-4 py-3 text-sm text-white shadow-xl">
              <div className="font-bold text-red-300">Radar unavailable</div>
              <div className="mt-1 text-slate-200">{loadError}</div>
            </div>
          ) : null}

          <div className="absolute bottom-4 left-1/2 w-[min(92%,700px)] -translate-x-1/2 rounded-[24px] border border-white/10 bg-slate-950/85 p-3 text-white shadow-2xl backdrop-blur">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-300">
              <span>Radar timeline</span>
              <span>{formatFrameTime(currentFrame?.time)}</span>
            </div>

            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {frames.map((frame, index) => {
                const active = index === frameIndex;
                return (
                  <button
                    key={`${frame.time}-${index}`}
                    type="button"
                    onClick={() => {
                      setIsPlaying(false);
                      setFrameIndex(index);
                    }}
                    className={`rounded-xl px-2 py-2 text-center text-[11px] font-bold transition ${
                      active
                        ? "bg-blue-600 text-white"
                        : "bg-white/5 text-slate-300 hover:bg-white/10"
                    }`}
                    aria-label={`Show radar frame ${formatFrameTime(frame.time)}`}
                  >
                    {formatFrameTime(frame.time)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
