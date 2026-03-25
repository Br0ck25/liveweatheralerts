"use client";

import { useEffect, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { X, MapPin } from "lucide-react";

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

const RADAR_SOURCE_ID = "nexrad-radar";
const LOCATION_SOURCE_ID = "location-point";

export default function RadarMapModal({
  open,
  onClose,
  location,
  radar,
}: RadarModalProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

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
            attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
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
    });

    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      const radarTiles = [
        "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?" +
          "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap" +
          "&FORMAT=image/png&TRANSPARENT=true" +
          "&LAYERS=conus_bref_qcd" +
          "&SRS=EPSG:3857" +
          "&WIDTH=256&HEIGHT=256" +
          "&BBOX={bbox-epsg-3857}",
      ];

      if (map.getSource(RADAR_SOURCE_ID)) {
        if (map.getLayer(RADAR_SOURCE_ID)) {
          map.removeLayer(RADAR_SOURCE_ID);
        }
        map.removeSource(RADAR_SOURCE_ID);
      }

      map.addSource(RADAR_SOURCE_ID, {
        type: "raster",
        tiles: radarTiles,
        tileSize: 256,
      });

      map.addLayer({
        id: RADAR_SOURCE_ID,
        type: "raster",
        source: RADAR_SOURCE_ID,
        paint: {
          "raster-opacity": 0.78,
        },
      });

      map.addSource(LOCATION_SOURCE_ID, {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [location.lon, location.lat],
              },
              properties: {
                label: location.label,
              },
            },
          ],
        },
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

      refreshTimerRef.current = window.setInterval(() => {
        const source = map.getSource(RADAR_SOURCE_ID) as maplibregl.RasterTileSource | undefined;
        if (!source) return;

        source.setTiles([
          "https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?" +
            "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap" +
            "&FORMAT=image/png&TRANSPARENT=true" +
            "&LAYERS=conus_bref_qcd" +
            "&SRS=EPSG:3857" +
            "&WIDTH=256&HEIGHT=256" +
            `&CACHEBUST=${Date.now()}` +
            "&BBOX={bbox-epsg-3857}",
        ]);
      }, 300000);
    });

    map.on("error", (e: unknown) => {
      const err = e instanceof Error ? e : { message: String(e) };
      console.error("Radar map error", err);
    });

    return () => {
      if (refreshTimerRef.current) {
        window.clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      map.remove();
      mapRef.current = null;
    };
  }, [open, location.lat, location.lon, location.label]);

  useEffect(() => {
    if (!open || !mapRef.current) return;
    mapRef.current.resize();
    mapRef.current.flyTo({
      center: [location.lon, location.lat],
      zoom: 7,
      duration: 700,
    });
  }, [open, location.lat, location.lon]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-100 bg-black/80 backdrop-blur-sm">
      <div className="absolute inset-0 flex flex-col">
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-4 py-3 text-white">
          <div>
            <div className="text-lg font-black uppercase tracking-wide">Live Radar</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-slate-300">
              <MapPin className="h-3.5 w-3.5" />
              <span>{location.label}</span>
              {radar?.updated ? <span>• Updated {new Date(radar.updated).toLocaleTimeString()}</span> : null}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 p-2 text-white"
            aria-label="Close radar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div ref={mapContainerRef} className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
