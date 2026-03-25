"use client";

import React, { useEffect, useMemo, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { X, Layers, MapPin } from "lucide-react";

type WeatherLocation = {
  lat: number;
  lon: number;
  city?: string | null;
  state?: string | null;
  label: string;
};

type RadarData = {
  station: string | null;
  loopImageUrl: string | null;
  stillImageUrl: string | null;
  updated: string;
  summary: string;
};

function formatRelative(value?: string | null) {
  if (!value) return "just now";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "recently";
  const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (diffMin < 1) return "just now";
  if (diffMin === 1) return "1 min ago";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hr ago`;
}

export default function RadarMapModal({
  open,
  onClose,
  location,
  radar,
}: {
  open: boolean;
  onClose: () => void;
  location: WeatherLocation;
  radar: RadarData | null;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<maplibregl.Map | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  // NOAA/NWS MRMS radar base reflectivity WMS
  // Official service info says this service has WMS capabilities and updates every 5 minutes.
  const radarWmsTemplate = useMemo(() => {
    const base =
      "https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer";
    return (
      `${base}?service=WMS&request=GetMap&version=1.1.1` +
      `&layers=1&styles=&format=image/png&transparent=true&srs=EPSG:3857` +
      `&width=256&height=256&bbox={bbox-epsg-3857}`
    );
  }, []);

  useEffect(() => {
    if (!open || !mapRef.current || mapInstanceRef.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [
              "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            ],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
          },
        ],
      },
      center: [location.lon, location.lat],
      zoom: 7,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      if (!map.getSource("mrms-radar")) {
        map.addSource("mrms-radar", {
          type: "raster",
          tiles: [radarWmsTemplate],
          tileSize: 256,
        });

        map.addLayer({
          id: "mrms-radar-layer",
          type: "raster",
          source: "mrms-radar",
          paint: {
            "raster-opacity": 0.78,
          },
        });
      }

      new maplibregl.Marker({ color: "#2563eb" })
        .setLngLat([location.lon, location.lat])
        .addTo(map);

      // Refresh MRMS tiles every 5 minutes for near-real-time radar overlay
      if (refreshTimerRef.current == null) {
        refreshTimerRef.current = window.setInterval(() => {
          const source = map.getSource("mrms-radar") as maplibregl.RasterTileSource | undefined;
          if (source && "setTiles" in source && typeof source.setTiles === "function") {
            source.setTiles([`${radarWmsTemplate}&t=${Date.now()}`]);
          }
        }, 300000);
      }
    });

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      if (refreshTimerRef.current != null) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [open, location.lat, location.lon, radarWmsTemplate]);

  useEffect(() => {
    if (!open) return;
    const map = mapInstanceRef.current;
    if (!map) return;
    map.flyTo({
      center: [location.lon, location.lat],
      zoom: 7,
      essential: true,
    });
  }, [open, location.lat, location.lon]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-md">
      <div className="absolute inset-x-0 bottom-0 top-[4%] overflow-hidden rounded-t-[30px] border border-white/10 bg-slate-950 text-white shadow-2xl">
        <div className="mx-auto mt-3 h-1.5 w-14 rounded-full bg-white/20" />

        <div className="flex items-center justify-between px-4 pb-4 pt-4">
          <div>
            <div className="text-lg font-black uppercase tracking-wide">Live Radar</div>
            <div className="mt-1 flex items-center gap-2 text-sm text-slate-300">
              <MapPin className="h-4 w-4" />
              {location.label}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {radar?.summary || "NOAA MRMS radar overlay"} · Updated {formatRelative(radar?.updated)}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
          >
            <X className="h-4 w-4" />
            Close
          </button>
        </div>

        <div className="px-4 pb-4">
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
            <Layers className="h-4 w-4" />
            NOAA/NWS MRMS Base Reflectivity overlay on OpenStreetMap
          </div>

          <div className="overflow-hidden rounded-[24px] border border-white/10">
            <div ref={mapRef} className="h-[72vh] w-full bg-slate-900" />
          </div>
        </div>
      </div>
    </div>
  );
}
