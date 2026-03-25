"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { X, MapPin, Play, Pause, LocateFixed, ChevronLeft, ChevronRight } from "lucide-react";

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
    frames?: { time: string; label: string }[];
    tileTemplate?: string | null;
    hasLiveTiles?: boolean;
    defaultCenter?: { lat: number; lon: number };
    defaultZoom?: number;
  } | null;
};

function buildRecentFrames(count = 8, stepMinutes = 2) {
  const now = new Date();
  const frames: string[] = [];

  const rounded = new Date(now);
  rounded.setUTCSeconds(0, 0);
  rounded.setUTCMinutes(Math.floor(rounded.getUTCMinutes() / stepMinutes) * stepMinutes);

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(rounded);
    d.setUTCMinutes(d.getUTCMinutes() - i * stepMinutes);
    frames.push(d.toISOString());
  }

  return frames;
}

function buildRadarTileUrl(time?: string) {
  const params = [
    "SERVICE=WMS",
    "VERSION=1.1.1",
    "REQUEST=GetMap",
    "FORMAT=image/png",
    "TRANSPARENT=true",
    "LAYERS=conus_bref_qcd",
    "SRS=EPSG:3857",
    "WIDTH=256",
    "HEIGHT=256",
    "BBOX={bbox-epsg-3857}",
  ];

  if (time) {
    params.push(`TIME=${encodeURIComponent(time)}`);
  }

  return `https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?${params.join("&")}`;
}

function formatFrameLabel(value: string, frameLabels: Map<string, string>) {
  const presetLabel = frameLabels.get(value);
  if (presetLabel) return presetLabel;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Latest";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function buildLocationGeoJson(location: { lat: number; lon: number; label: string }) {
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [location.lon, location.lat],
        },
        properties: {
          label: location.label,
        },
      },
    ],
  };
}

const RADAR_SOURCE_ID = "nexrad-radar";
const LOCATION_SOURCE_ID = "location-point";

export default function RadarMapModal({
  open,
  onClose,
  location,
  radar,
}: RadarModalProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [frameIndex, setFrameIndex] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [showLoading, setShowLoading] = useState(true);

  const frames = useMemo(
    () =>
      radar?.frames?.length
        ? radar.frames.map((f) => f.time)
        : buildRecentFrames(8, 2),
    [radar]
  );

  const frameLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const frame of radar?.frames || []) {
      map.set(frame.time, frame.label);
    }
    return map;
  }, [radar?.frames]);

  const currentFrame = frames[frameIndex] ?? frames[0];

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrameIndex(frames.length - 1);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowLoading(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRadarError(null);
  }, [open, frames.length]);

  useEffect(() => {
    if (!open || !mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          "carto-light": {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
              "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
              "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            ],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
          },
        },
        layers: [
          {
            id: "carto-light",
            type: "raster",
            source: "carto-light",
          },
        ],
      },
      center: [location.lon, location.lat],
      zoom: 7,
      attributionControl: false,
      interactive: true,
      dragPan: true,
      scrollZoom: true,
      doubleClickZoom: true,
      touchZoomRotate: true,
      dragRotate: false,
    });

    map.touchZoomRotate.enable();
    map.dragPan.enable();
    map.scrollZoom.enable();

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      setMapReady(true);
      setShowLoading(false);

      if (!map.getSource(RADAR_SOURCE_ID)) {
        const initialTileUrl = radar?.tileTemplate
          ? radar.tileTemplate.replace("{time}", encodeURIComponent(currentFrame))
          : buildRadarTileUrl(currentFrame);

        map.addSource(RADAR_SOURCE_ID, {
          type: "raster",
          tiles: [initialTileUrl],
          tileSize: 256,
        });

        map.addLayer({
          id: RADAR_SOURCE_ID,
          type: "raster",
          source: RADAR_SOURCE_ID,
          paint: {
            "raster-opacity": 0.8,
          },
        });
      }

      if (!map.getSource(LOCATION_SOURCE_ID)) {
        map.addSource(LOCATION_SOURCE_ID, {
          type: "geojson",
          data: buildLocationGeoJson(location),
        });

        map.addLayer({
          id: "location-circle",
          type: "circle",
          source: LOCATION_SOURCE_ID,
          paint: {
            "circle-radius": 7,
            "circle-color": "#2563eb",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });

        map.addLayer({
          id: "location-label",
          type: "symbol",
          source: LOCATION_SOURCE_ID,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 12,
            "text-offset": [0, 1.4],
            "text-anchor": "top",
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#0f172a",
            "text-halo-width": 2,
          },
        });
      }
    });

    map.on("error", () => {
      setRadarError("Radar temporarily unavailable.");
      setShowLoading(false);
    });

    map.on("sourcedata", () => {
      setShowLoading(false);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [open, currentFrame, location, radar?.tileTemplate]);

  useEffect(() => {
    if (!open || !mapRef.current || !mapReady) return;

    const id = window.setTimeout(() => {
      mapRef.current?.resize();
      mapRef.current?.flyTo({
        center: [location.lon, location.lat],
        zoom: 7,
        duration: 700,
      });

      const source = mapRef.current?.getSource(LOCATION_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      source?.setData(buildLocationGeoJson(location));
    }, 100);

    return () => window.clearTimeout(id);
  }, [open, mapReady, location]);

  useEffect(() => {
    if (!open || !mapRef.current || !isPlaying || frames.length <= 1) return;

    const timer = window.setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 700);

    return () => window.clearInterval(timer);
  }, [open, isPlaying, frames.length]);

  useEffect(() => {
    if (!open || !mapRef.current || !mapReady) return;

    const source = mapRef.current.getSource(RADAR_SOURCE_ID) as maplibregl.RasterTileSource | undefined;
    if (!source) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowLoading(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRadarError(null);

    const tileUrl = radar?.tileTemplate
      ? radar.tileTemplate.replace("{time}", encodeURIComponent(currentFrame))
      : buildRadarTileUrl(currentFrame);

    source.setTiles([tileUrl]);

    const done = window.setTimeout(() => {
      setShowLoading(false);
    }, 250);

    return () => window.clearTimeout(done);
  }, [open, mapReady, currentFrame, radar?.tileTemplate]);

  function handleRecenter() {
    mapRef.current?.flyTo({
      center: [location.lon, location.lat],
      zoom: 7,
      duration: 700,
    });
  }

  function handlePrevFrame() {
    setIsPlaying(false);
    setFrameIndex((prev) => (prev - 1 + frames.length) % frames.length);
  }

  function handleNextFrame() {
    setIsPlaying(false);
    setFrameIndex((prev) => (prev + 1) % frames.length);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0 flex flex-col">
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-4 py-3 text-white">
          <div className="min-w-0">
            <div className="text-lg font-black uppercase tracking-wide">Live Radar</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-300">
              <MapPin className="h-3.5 w-3.5" />
              <span className="truncate">{location.label}</span>
              <span>• Frame {formatFrameLabel(currentFrame, frameLabels)}</span>
              {radar?.updated ? (
                <span>
                  • Updated {new Date(radar.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              ) : null}
              {radar?.summary ? <span className="truncate">• {radar.summary}</span> : null}
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
              onClick={handleRecenter}
              className="rounded-full border border-white/10 bg-white/5 p-2 text-white hover:bg-white/10"
              aria-label="Recenter radar"
            >
              <LocateFixed className="h-5 w-5" />
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

        <div className="relative min-h-0 flex-1">
          <div
            ref={mapContainerRef}
            className="h-full w-full"
            style={{ touchAction: "pan-x pan-y" }}
          />

          {showLoading ? (
            <div className="pointer-events-none absolute left-4 top-4 rounded-2xl border border-white/10 bg-slate-950/85 px-4 py-3 text-sm font-semibold text-white shadow-xl animate-pulse">
              Loading radar…
            </div>
          ) : null}

          {radarError ? (
            <div className="absolute left-4 top-4 max-w-[280px] rounded-2xl border border-red-400/20 bg-slate-950/90 px-4 py-3 text-sm text-white shadow-xl">
              <div className="font-bold text-red-300">Radar unavailable</div>
              <div className="mt-1 text-slate-200">{radarError}</div>
            </div>
          ) : null}

          <div className="absolute bottom-4 left-1/2 w-[min(92%,700px)] -translate-x-1/2 rounded-[24px] border border-white/10 bg-slate-950/85 p-3 text-white shadow-2xl backdrop-blur">
            <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-300">
              <span>Radar timeline</span>
              <span>{formatFrameLabel(currentFrame, frameLabels)}</span>
            </div>

            <div className="grid grid-cols-8 gap-2">
              {frames.map((frame, index) => {
                const active = index === frameIndex;
                return (
                  <button
                    key={frame}
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
                    aria-label={`Show radar frame ${formatFrameLabel(frame, frameLabels)}`}
                  >
                    {formatFrameLabel(frame, frameLabels)}
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
