import os

base = r"c:\Users\James\Desktop\Live Weather Alerts\frontend\components"

preview_content = '''\
"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { Card, CardContent } from "@/components/ui/card";
import { Radar } from "lucide-react";

type RadarData = {
  station: string | null;
  updated?: string;
  summary?: string;
};

type RadarPreviewLocation = {
  lat: number;
  lon: number;
  label: string;
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
const PREVIEW_ZOOM = 7; // RainViewer max supported zoom is 7

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

export default function RadarPreviewCard({
  radar,
  location,
  onViewRadar,
}: {
  radar: RadarData | null;
  location: RadarPreviewLocation;
  onViewRadar: () => void;
}) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const radarLayerRef = useRef<L.TileLayer | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);

  const [host, setHost] = useState("");
  const [frames, setFrames] = useState<RainViewerFrame[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadRainViewer() {
      try {
        setLoadError(null);

        const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error("RainViewer request failed");
        }

        const data = (await res.json()) as RainViewerResponse;
        const nextHost = data.host || "https://tilecache.rainviewer.com";
        const nextFrames = data.radar?.past?.slice(-8) || [];

        if (!active) return;

        setHost(nextHost);
        setFrames(nextFrames);
        setFrameIndex(Math.max(0, nextFrames.length - 1));
      } catch (err) {
        if (!active) return;
        console.error("RainViewer preview load error:", err);
        setLoadError("Radar preview unavailable");
        setFrames([]);
      }
    }

    loadRainViewer();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false,
    }).setView([location.lat, location.lon], PREVIEW_ZOOM);

    L.tileLayer(OSM_URL, {
      attribution: OSM_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);

    const marker = L.circleMarker([location.lat, location.lon], {
      radius: 6,
      color: "#ffffff",
      weight: 2,
      fillColor: "#3b82f6",
      fillOpacity: 1,
    }).addTo(map);

    mapRef.current = map;
    markerRef.current = marker;

    setTimeout(() => {
      map.invalidateSize();
    }, 0);

    return () => {
      map.remove();
      mapRef.current = null;
      radarLayerRef.current = null;
      markerRef.current = null;
    };
  }, [location.lat, location.lon]);

  useEffect(() => {
    if (!mapRef.current) return;

    mapRef.current.setView([location.lat, location.lon], PREVIEW_ZOOM, {
      animate: false,
    });

    markerRef.current?.setLatLng([location.lat, location.lon]);
  }, [location.lat, location.lon]);

  useEffect(() => {
    if (!mapRef.current || !host || frames.length === 0) return;

    const frame = frames[frameIndex];
    if (!frame?.path) return;

    const nextLayer = L.tileLayer(buildRainViewerTileUrl(host, frame.path), {
      opacity: 0.78,
      attribution: "",
      maxZoom: 7,
      tileSize: 256,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 2,
    });

    nextLayer.addTo(mapRef.current);

    const previousLayer = radarLayerRef.current;
    radarLayerRef.current = nextLayer;

    if (previousLayer) {
      previousLayer.remove();
    }
  }, [host, frames, frameIndex]);

  useEffect(() => {
    if (frames.length <= 1) return;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 700);

    return () => window.clearInterval(timer);
  }, [frames.length]);

  const currentFrame = frames[frameIndex] || null;

  return (
    <Card className="overflow-hidden rounded-[30px] border border-slate-800 bg-slate-950 text-white shadow-xl">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center gap-2 text-xl font-black uppercase tracking-wide">
          <Radar className="h-5 w-5 text-red-400" />
          Live Radar
        </div>

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={onViewRadar}
            className="relative overflow-hidden rounded-[24px] border border-white/10 bg-black text-left"
            aria-label="Open live radar"
          >
            <div className="relative h-48 w-full overflow-hidden rounded-[24px] bg-black">
              <div ref={mapContainerRef} className="absolute inset-0" />

              {loadError ? (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium text-white/70">
                  {loadError}
                </div>
              ) : null}

              <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/65 via-black/10 to-transparent" />

              <div className="pointer-events-none absolute top-3 left-3 text-xs font-black uppercase tracking-widest text-white/90">
                Live Radar Loop
              </div>

              <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex items-center justify-between">
                <div className="rounded-full bg-black/50 px-3 py-1 text-xs font-bold text-white backdrop-blur">
                  {formatFrameTime(currentFrame?.time)}
                </div>

                <div className="flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-black uppercase text-white backdrop-blur">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                  </span>
                  Live
                </div>
              </div>
            </div>
          </button>

          <div className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-sm">
            <div className="flex items-center gap-2 text-blue-100">
              <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
              {radar?.summary || "Radar live"} \u2022 Live \u2022 Updating
            </div>
            <div className="text-xs text-blue-200 uppercase tracking-wide">
              {radar?.station || "N/A"}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
'''

modal_content = '''\
"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
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
const MODAL_ZOOM = 7; // RainViewer max supported zoom is 7

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
  const mapRef = useRef<L.Map | null>(null);
  const radarLayerRef = useRef<L.TileLayer | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);

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

        const res = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
          cache: "no-store",
        });

        if (!res.ok) {
          throw new Error("RainViewer request failed");
        }

        const data = (await res.json()) as RainViewerResponse;
        const nextHost = data.host || "https://tilecache.rainviewer.com";
        const nextFrames = data.radar?.past?.slice(-8) || [];

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

  useEffect(() => {
    if (!open || !mapContainerRef.current || mapRef.current) return;

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

    setTimeout(() => {
      map.invalidateSize();
    }, 0);

    return () => {
      map.remove();
      mapRef.current = null;
      radarLayerRef.current = null;
      markerRef.current = null;
    };
  }, [open, location.lat, location.lon]);

  useEffect(() => {
    if (!open || !mapRef.current) return;

    mapRef.current.setView([location.lat, location.lon], MODAL_ZOOM, {
      animate: false,
    });

    markerRef.current?.setLatLng([location.lat, location.lon]);

    setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 0);
  }, [open, location.lat, location.lon]);

  useEffect(() => {
    if (!open || !mapRef.current || !host || frames.length === 0) return;

    const frame = frames[frameIndex];
    if (!frame?.path) return;

    const nextLayer = L.tileLayer(buildRainViewerTileUrl(host, frame.path), {
      opacity: 0.8,
      attribution: "",
      maxZoom: 7,
      tileSize: 256,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 3,
    });

    nextLayer.addTo(mapRef.current);

    const previousLayer = radarLayerRef.current;
    radarLayerRef.current = nextLayer;

    if (previousLayer) {
      previousLayer.remove();
    }
  }, [open, host, frames, frameIndex]);

  useEffect(() => {
    if (!open || !isPlaying || frames.length <= 1) return;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 700);

    return () => window.clearInterval(timer);
  }, [open, isPlaying, frames.length]);

  function handlePrevFrame() {
    if (frames.length === 0) return;
    setIsPlaying(false);
    setFrameIndex((prev) => (prev - 1 + frames.length) % frames.length);
  }

  function handleNextFrame() {
    if (frames.length === 0) return;
    setIsPlaying(false);
    setFrameIndex((prev) => (prev + 1) % frames.length);
  }

  if (!open) return null;

  const currentFrame = frames[frameIndex] || null;

  return (
    <div className="fixed inset-0 z-100 bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0 flex flex-col">
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-4 py-3 text-white">
          <div className="min-w-0">
            <div className="text-lg font-black uppercase tracking-wide">Live Radar</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <MapPin className="h-3.5 w-3.5" />
              <span className="truncate">{location.label}</span>
              <span>\u2022 Frame {formatFrameTime(currentFrame?.time)}</span>
              {radar?.updated ? (
                <span>
                  \u2022 Updated{" "}
                  {new Date(radar.updated).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}
              {radar?.summary ? <span className="truncate">\u2022 {radar.summary}</span> : null}
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
              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
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
            <div className="pointer-events-none absolute left-4 top-4 rounded-2xl border border-white/10 bg-slate-950/85 px-4 py-3 text-sm font-semibold text-white shadow-xl animate-pulse">
              Loading radar...
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
'''

preview_path = os.path.join(base, "weather", "RadarPreviewCard.tsx")
modal_path = os.path.join(base, "RadarMapModal.tsx")

with open(preview_path, "w", encoding="utf-8") as f:
    f.write(preview_content)
print(f"Written {preview_path}")

with open(modal_path, "w", encoding="utf-8") as f:
    f.write(modal_content)
print(f"Written {modal_path}")
