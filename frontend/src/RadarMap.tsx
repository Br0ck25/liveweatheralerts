import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

type RainViewerFrame = {
  time: number
  path: string
}

type RainViewerData = {
  host: string
  radar: {
    past: RainViewerFrame[]
    nowcast?: RainViewerFrame[]
  }
}

function RadarTileLayer({
  path,
  host,
  opacity,
}: {
  path: string
  host: string
  opacity: number
}) {
  const map = useMap()
  const layerRef = useRef<L.TileLayer | null>(null)

  useEffect(() => {
    const url = `${host}${path}/256/{z}/{x}/{y}/2/1_1.png`
    if (!layerRef.current) {
      layerRef.current = L.tileLayer(url, {
        opacity,
        zIndex: 200,
        tileSize: 256,
        maxZoom: 18,
      })
      layerRef.current.addTo(map)
    } else {
      layerRef.current.setUrl(url)
      layerRef.current.setOpacity(opacity)
    }
  }, [path, host, opacity, map])

  useEffect(() => {
    return () => {
      layerRef.current?.remove()
      layerRef.current = null
    }
  }, [])

  return null
}

function MapRecenter({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap()
  const prev = useRef<{ lat: number; lon: number } | null>(null)
  useEffect(() => {
    if (!prev.current || prev.current.lat !== lat || prev.current.lon !== lon) {
      prev.current = { lat, lon }
      map.setView([lat, lon], map.getZoom(), { animate: true })
    }
  }, [lat, lon, map])
  return null
}

interface RadarMapProps {
  lat: number
  lon: number
  locationLabel?: string
}

export function RadarMap({ lat, lon, locationLabel }: RadarMapProps) {
  const [frames, setFrames] = useState<RainViewerFrame[]>([])
  const [host, setHost] = useState('https://tilecache.rainviewer.com')
  const [frameIndex, setFrameIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [opacity, setOpacity] = useState(0.75)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then((r) => r.json())
      .then((data: RainViewerData) => {
        if (cancelled) return
        const past = data?.radar?.past ?? []
        if (past.length > 0) {
          setHost(data.host ?? 'https://tilecache.rainviewer.com')
          setFrames(past)
          setFrameIndex(past.length - 1)
          setLoadError(false)
        } else {
          setLoadError(true)
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isPlaying || frames.length === 0) return
    const interval = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length)
    }, 600)
    return () => clearInterval(interval)
  }, [isPlaying, frames.length])

  const currentFrame = frames[frameIndex] ?? null

  function fmtFrameTime(frame: RainViewerFrame | null) {
    if (!frame) return '--'
    return new Date(frame.time * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Map */}
      <div className="overflow-hidden rounded-2xl border border-white/10">
        <div style={{ height: 360, position: 'relative' }}>
          <MapContainer
            center={[lat, lon]}
            zoom={7}
            zoomControl
            attributionControl={false}
            style={{ height: '100%', width: '100%', background: '#0f172a' }}
          >
            {/* Base map — no labels so radar renders above terrain cleanly */}
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
              maxZoom={19}
              subdomains="abcd"
              opacity={0.9}
            />
            {/* Radar overlay — sandwiched below labels */}
            {currentFrame && !loadError && (
              <RadarTileLayer path={currentFrame.path} host={host} opacity={opacity} />
            )}
            {/* City/road labels rendered on top of radar */}
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png"
              maxZoom={19}
              subdomains="abcd"
              zIndex={300}
            />
            {/* User location */}
            <CircleMarker
              center={[lat, lon]}
              radius={7}
              pathOptions={{
                fillColor: '#38bdf8',
                fillOpacity: 1,
                color: '#ffffff',
                weight: 2,
              }}
            />
            <MapRecenter lat={lat} lon={lon} />
          </MapContainer>

          {/* Location label — minimal, no background box */}
          <div
            className="pointer-events-none"
            style={{ position: 'absolute', top: 12, left: 12, zIndex: 1000 }}
          >
            <div className="rounded-lg bg-black/40 px-2.5 py-1 text-sm font-medium text-white backdrop-blur-sm">
              {locationLabel || 'Your Location'}
            </div>
          </div>

          {/* Current frame time */}
          <div
            className="pointer-events-none"
            style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000 }}
          >
            <div className="rounded-lg bg-black/40 px-2.5 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
              {fmtFrameTime(currentFrame)}
            </div>
          </div>

          {loadError && (
            <div
              className="flex items-center justify-center bg-black/60"
              style={{ position: 'absolute', inset: 0, zIndex: 900 }}
            >
              <div className="text-sm text-white/60">Radar data unavailable</div>
            </div>
          )}
        </div>

        {/* Playback controls */}
        <div className="bg-[#0d1525] px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs text-white/50">
              {frames.length > 0
                ? `${fmtFrameTime(frames[0])} → ${fmtFrameTime(frames[frames.length - 1])}`
                : 'Loading frames…'}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPlaying(true)}
                title="Play"
                className={`flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-sm ${
                  isPlaying ? 'bg-sky-500 text-white' : 'bg-white/5 text-white/60'
                }`}
              >
                ▶
              </button>
              <button
                onClick={() => setIsPlaying(false)}
                title="Pause"
                className={`flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 text-sm ${
                  !isPlaying ? 'bg-sky-500 text-white' : 'bg-white/5 text-white/60'
                }`}
              >
                ⏸
              </button>
            </div>
          </div>

          {/* Frame scrubber */}
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={frameIndex}
            onChange={(e) => {
              setIsPlaying(false)
              setFrameIndex(Number(e.target.value))
            }}
            className="mb-3 w-full accent-sky-400"
          />

          {/* Opacity */}
          <div className="flex items-center gap-3 text-xs text-white/50">
            <span className="shrink-0">Opacity</span>
            <input
              type="range"
              min={10}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              className="flex-1 accent-sky-400"
            />
            <span className="w-8 shrink-0 text-right">{Math.round(opacity * 100)}%</span>
          </div>
        </div>
      </div>

      {/* Color legend */}
      <div className="flex items-center justify-between rounded-xl border border-white/10 bg-[#121a2b] px-4 py-3">
        <div className="text-xs text-white/50">Intensity</div>
        <div className="flex gap-1">
          {['#00d8ff', '#00cc00', '#b3ff00', '#ffff00', '#ff8800', '#ff2200'].map((color, i) => (
            <div
              key={i}
              className="h-3 w-5 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
        <div className="text-[10px] text-white/40">Light → Heavy</div>
      </div>
    </div>
  )
}
