import React, { useEffect, useMemo, useState } from 'react'
import {
  Bell,
  Menu,
  MapPin,
  ChevronRight,
  House,
  CloudSun,
  Radar,
  TriangleAlert,
  MoreHorizontal,
  Wind,
  Droplets,
  Eye,
  CloudRain,
  Sun,
  Moon,
  Gauge,
  ShieldAlert,
  Search,
  Loader2,
  MapPinned,
  Sunrise,
  Sunset,
  Share2,
  ExternalLink,
  Palette,
  Download,
  X,
} from 'lucide-react'

type AppTab = 'home' | 'forecast' | 'radar' | 'alerts' | 'more'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type SavedLocation = {
  lat: number
  lon: number
  city?: string
  state?: string
  zip?: string
  county?: string
  countyCode?: string
  zoneCode?: string
  label: string
}

type WorkerWeatherResponse = {
  location?: Record<string, unknown>
  current?: Record<string, unknown>
  hourly?: Array<Record<string, unknown>>
  daily?: Array<Record<string, unknown>>
  radar?: Record<string, unknown>
  updated?: string
}

type WorkerAlertsResponse = {
  alerts?: Array<Record<string, unknown>>
  meta?: Record<string, unknown>
}

const API_BASE =
  import.meta.env.VITE_API_BASE || 'https://live-weather.jamesbrock25.workers.dev'

function formatTemp(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--°'
  return `${Math.round(num)}°`
}

function formatPercent(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--%'
  return `${Math.round(num)}%`
}

function formatPressure(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '--'
  return `${num.toFixed(1)} in`
}

function formatDateTime(value?: string | null): string {
  if (!value) return '--'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '--'
  return parsed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function weatherIconFromText(input: string, isNight = false) {
  const text = String(input || '').toLowerCase()
  if (
    text.includes('rain') ||
    text.includes('storm') ||
    text.includes('shower') ||
    text.includes('thunder')
  )
    return CloudRain
  if (text.includes('clear') || text.includes('fair') || text.includes('sunny') || text.includes('sun')) {
    return isNight ? Moon : Sun
  }
  if (text.includes('night') || text.includes('moon')) return Moon
  return isNight ? Moon : CloudSun
}

function isNightFromHourlyItem(item: Record<string, unknown>): boolean {
  const icon = String(item?.icon || '')
  if (icon.includes('/day/')) return false
  if (icon.includes('/night/')) return true
  // Fallback: treat hours before 6am or at/after 8pm as night
  const st = item?.startTime ? new Date(String(item.startTime)) : null
  if (st && !isNaN(st.getTime())) {
    const h = st.getHours()
    return h < 6 || h >= 20
  }
  return false
}

function alertBorderClass(event: string, severity: string) {
  const text = `${event} ${severity}`.toLowerCase()
  if (
    text.includes('warning') ||
    text.includes('extreme') ||
    text.includes('severe')
  ) {
    return { border: 'border-red-500', label: 'text-red-400' }
  }
  if (
    text.includes('watch') ||
    text.includes('advisory') ||
    text.includes('moderate')
  ) {
    return { border: 'border-yellow-400', label: 'text-yellow-300' }
  }
  return { border: 'border-blue-400', label: 'text-blue-300' }
}

function getCurrentCondition(current: Record<string, unknown>) {
  return (
    current?.condition ||
    current?.summary ||
    current?.shortForecast ||
    current?.textDescription ||
    'Current Conditions'
  ) as string
}

function getCurrentTemp(current: Record<string, unknown>) {
  return (
    current?.temperature ??
    current?.temp ??
    current?.temperatureF ??
    current?.actualTemp ??
    null
  )
}

function getFeelsLike(current: Record<string, unknown>) {
  return (
    current?.feelsLike ??
    current?.feelslike ??
    current?.feelsLikeF ??
    current?.apparentTemperature ??
    current?.windChill ??
    current?.heatIndex ??
    null
  )
}

function getWind(current: Record<string, unknown>) {
  const mph = Number(current?.windMph ?? NaN)
  if (Number.isFinite(mph)) {
    if (mph < 1) return 'Calm'
    const dir = String(current?.windDirection || '').trim()
    return dir ? `${dir} ${Math.round(mph)} mph` : `${Math.round(mph)} mph`
  }
  const raw = current?.windText ?? current?.windSpeedText ?? current?.windSpeed ?? current?.wind
  if (raw !== undefined && raw !== null && String(raw) !== '') {
    const dir = String(current?.windDirection || '').trim()
    return dir ? `${dir} ${String(raw)}` : String(raw)
  }
  return '--'
}

function getHumidity(current: Record<string, unknown>) {
  return current?.humidity ?? current?.relativeHumidity ?? null
}

function getVisibility(current: Record<string, unknown>) {
  const mi = current?.visibilityMi
  if (Number.isFinite(Number(mi)) && Number(mi) >= 0) {
    return `${Number(mi).toFixed(1)} mi`
  }
  const raw = current?.visibilityText ?? current?.visibility
  if (raw !== undefined && raw !== null && String(raw) !== '') return String(raw)
  return '--'
}

function getPressure(current: Record<string, unknown>) {
  return current?.pressureInHg ?? current?.pressure ?? null
}

function getHourlyTime(item: Record<string, unknown>) {
  if (item?.timeLabel) return item.timeLabel as string
  if (item?.label) return item.label as string
  if (item?.name) return item.name as string
  if (item?.startTime) return formatDateTime(item.startTime as string)
  return '--'
}

function getHourlyTemp(item: Record<string, unknown>) {
  return (
    item?.temperature ?? item?.temperatureF ?? item?.temp ?? item?.value ?? null
  )
}

function getHourlyRain(item: Record<string, unknown>) {
  return (
    item?.precipitationChance ??
    item?.precipProbability ??
    item?.rainChance ??
    item?.precip ??
    0
  )
}

function getDailySummary(item: Record<string, unknown>) {
  return (
    item?.summary ||
    item?.shortForecast ||
    item?.detailedForecast ||
    item?.condition ||
    'Forecast'
  ) as string
}

function getDailyLabel(item: Record<string, unknown>) {
  return (item?.label || item?.day || item?.name || item?.name || 'Day') as string
}

function getDailyHigh(item: Record<string, unknown>) {
  return (
    item?.high ??
    item?.highF ??
    item?.temperatureHigh ??
    item?.maxTemp ??
    item?.temperature ??
    null
  )
}

function getDailyLow(item: Record<string, unknown>) {
  return (
    item?.low ??
    item?.lowF ??
    item?.temperatureLow ??
    item?.minTemp ??
    null
  )
}

function getDailyPrecip(item: Record<string, unknown>) {
  return (
    item?.precipProbability ??
    item?.precipitationChance ??
    item?.rainChance ??
    item?.precip ??
    0
  )
}

function getDailyNightSummary(item: Record<string, unknown>) {
  return (item?.nightShortForecast || '') as string
}

function getDailyNightDetailedForecast(item: Record<string, unknown>) {
  return (item?.nightDetailedForecast || '') as string
}

function getDailyNightPrecip(item: Record<string, unknown>) {
  return item?.nightPrecipitationChance ?? item?.nightPrecip ?? null
}

function getLocationLabel(
  location: SavedLocation | null,
  weatherLocation: Record<string, unknown> | undefined,
) {
  return (
    location?.label ||
    (weatherLocation?.label as string) ||
    [(weatherLocation?.city as string) || '', (weatherLocation?.state as string) || '']
      .filter(Boolean)
      .join(', ') ||
    'Unknown Location'
  )
}

function formatAlertDescription(text: string): string {
  if (!text) return text
  // Split into paragraph blocks (blank-line separated) and reformat NWS bullet points
  const blocks = text.split(/\n{2,}/)
  return blocks
    .map((block) => {
      const lines = block.split('\n')
      const firstLine = lines[0] ?? ''
      const bulletMatch = firstLine.match(/^\* ([A-Z][A-Z ]+)\.\.\.(.*)$/i)
      if (bulletMatch) {
        const keyword = bulletMatch[1].trim().toUpperCase()
        const rest = [bulletMatch[2], ...lines.slice(1)]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        return `${keyword}: ${rest}`
      }
      // Non-bullet paragraph: join word-wrapped lines
      return lines.join(' ').replace(/\s+/g, ' ').trim()
    })
    .filter(Boolean)
    .join('\n\n')
}

// ─── Standalone Alert Detail Page ────────────────────────────────────────────
// Rendered instead of the main App when ?alert=<id> is in the URL.
// Completely independent of the user's saved location.
const ALERT_PAGE_BG: Record<string, string> = {
  blue: '#091320', purple: '#0d091e', emerald: '#071510',
  amber: '#150e04', rose: '#17080b', teal: '#071514',
}
const ALERT_PAGE_CARD: Record<string, string> = {
  blue: 'bg-sky-950/60', purple: 'bg-purple-950/60', emerald: 'bg-emerald-950/60',
  amber: 'bg-amber-950/60', rose: 'bg-rose-950/60', teal: 'bg-teal-950/60',
}
const ALERT_PAGE_ACCENT: Record<string, string> = {
  blue: 'text-sky-400', purple: 'text-purple-400', emerald: 'text-emerald-400',
  amber: 'text-amber-400', rose: 'text-rose-400', teal: 'text-teal-400',
}

function AlertDetailPage({ alertId }: { alertId: string }) {
  const theme = window.localStorage.getItem('lwa_theme_v1') || 'blue'
  const pageBg = ALERT_PAGE_BG[theme] || '#091320'
  const cardCls = ALERT_PAGE_CARD[theme] || 'bg-sky-950/60'
  const accentCls = ALERT_PAGE_ACCENT[theme] || 'text-sky-400'

  const [alert, setAlert] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/alerts/${encodeURIComponent(alertId)}`)
      .then((r) => r.json())
      .then((json: { alert?: Record<string, unknown>; error?: string }) => {
        if (json?.alert) setAlert(json.alert)
        else setError(json?.error || 'Alert not found.')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load alert.'))
      .finally(() => setLoading(false))
  }, [alertId])

  const styles = alert
    ? alertBorderClass(String(alert.event || ''), String(alert.severity || ''))
    : { border: 'border-blue-400', label: 'text-blue-300' }

  const navBg = NAV_BG[theme] || '#0c1b30'

  const navTo = (tab: string) => {
    try {
      const u = new URL(window.location.href)
      u.searchParams.delete('alert')
      window.history.replaceState(null, '', u.pathname + (u.search || ''))
    } catch { /* ignore */ }
    window.localStorage.setItem('lwa_active_tab_v1', tab)
    window.location.reload()
  }

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: pageBg }}>
      <div className="mx-auto min-h-screen w-full max-w-md px-4 pb-28 pt-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className={`text-xs tracking-wide ${accentCls} opacity-70`}>LIVE WEATHER ALERTS</div>
            <div className="text-xs text-white/40 mt-0.5">Alert Detail</div>
          </div>
          <button
            onClick={() => navTo('alerts')}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70 hover:bg-white/10 transition-colors"
          >
            Open App <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-8 w-8 animate-spin text-white/40" />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-900/20 p-5 text-sm text-red-200">
            {error}
          </div>
        )}

        {alert && (
          <div className={`rounded-xl border-l-4 ${cardCls} p-5 ${styles.border}`}>
            <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${styles.label}`}>
              {String(alert.event || 'WEATHER ALERT')}
            </div>
            <div className="text-xl font-bold leading-snug">
              {(alert.event as string) || 'Weather Alert'}
            </div>
            <div className="mt-1 text-sm text-white/70">
              {(alert.summary as string) || (alert.headline as string) || ''}
            </div>

            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
              {(alert.areaDesc as string) ? (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Area</div>
                  <div className="text-sm text-white/70">{alert.areaDesc as string}</div>
                </div>
              ) : null}
              {(alert.description as string) ? (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Description</div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">
                    {formatAlertDescription(alert.description as string)}
                  </div>
                </div>
              ) : null}
              {(alert.instruction as string) ? (
                <div>
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Instructions</div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-yellow-200/80">
                    {formatAlertDescription(alert.instruction as string)}
                  </div>
                </div>
              ) : null}
              {(alert.expires as string) ? (
                <div className="text-xs text-white/40">
                  Expires {formatDateTime(alert.expires as string)}
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
              <div className="text-xs text-white/40">
                Issued {formatDateTime((alert.sent as string) || (alert.updated as string))}
              </div>
              <div className="flex items-center gap-3">
                {(alert.nwsUrl as string) ? (
                  <a
                    href={alert.nwsUrl as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white/40 hover:text-white/70 transition-colors"
                    aria-label="View on NWS"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : null}
                <button
                  onClick={async () => {
                    const url = window.location.href
                    if (navigator.share) {
                      try { await navigator.share({ title: String(alert.event || 'Weather Alert'), url }) } catch { /* cancelled */ }
                    } else {
                      await navigator.clipboard.writeText(url).catch(() => {})
                    }
                  }}
                  className="text-white/40 hover:text-white/70 transition-colors"
                  aria-label="Share"
                >
                  <Share2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Nav bar — tapping any tab opens the app on that tab */}
      <div className="fixed bottom-0 left-1/2 w-full max-w-md -translate-x-1/2 px-4 pb-4">
        <div className="rounded-2xl border border-white/10 p-2 shadow-2xl backdrop-blur" style={{ backgroundColor: navBg }}>
          <div className="grid grid-cols-5 gap-1">
            {([
              { id: 'home',     label: 'Home',     icon: House },
              { id: 'forecast', label: 'Forecast', icon: CloudSun },
              { id: 'radar',    label: 'Radar',    icon: Radar },
              { id: 'alerts',   label: 'Alerts',   icon: TriangleAlert },
              { id: 'more',     label: 'More',     icon: MoreHorizontal },
            ] as { id: string; label: string; icon: React.ElementType }[]).map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  onClick={() => navTo(tab.id)}
                  className="flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-white/45 transition hover:bg-white/5 hover:text-white/80"
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-[11px] font-medium">{tab.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
// ─────────────────────────────────────────────────────────────────────────────

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8 // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

const THEMES: Record<string, { t300: string; t400: string; bg500: string; borderAccent: string; bgMuted: string; borderMuted: string; ring: string; iconBg: string; iconBorder: string; hoverBorder: string; extraBorderMuted: string; cardBg: string }> = {
  blue:    { t300: 'text-sky-300',     t400: 'text-sky-400',     bg500: 'bg-sky-500',     borderAccent: 'border-sky-400',     bgMuted: 'bg-sky-500/20',     borderMuted: 'border-sky-400/20',     ring: 'ring-sky-400/70',     iconBg: 'bg-sky-400/10',     iconBorder: 'border-sky-300/10',     hoverBorder: 'hover:border-sky-500/40',     extraBorderMuted: 'border-sky-500/20',     cardBg: 'bg-sky-950/60' },
  purple:  { t300: 'text-purple-300',  t400: 'text-purple-400',  bg500: 'bg-purple-500',  borderAccent: 'border-purple-400',  bgMuted: 'bg-purple-500/20',  borderMuted: 'border-purple-400/20',  ring: 'ring-purple-400/70',  iconBg: 'bg-purple-400/10',  iconBorder: 'border-purple-300/10',  hoverBorder: 'hover:border-purple-500/40',  extraBorderMuted: 'border-purple-500/20',  cardBg: 'bg-purple-950/60' },
  emerald: { t300: 'text-emerald-300', t400: 'text-emerald-400', bg500: 'bg-emerald-500', borderAccent: 'border-emerald-400', bgMuted: 'bg-emerald-500/20', borderMuted: 'border-emerald-400/20', ring: 'ring-emerald-400/70', iconBg: 'bg-emerald-400/10', iconBorder: 'border-emerald-300/10', hoverBorder: 'hover:border-emerald-500/40', extraBorderMuted: 'border-emerald-500/20', cardBg: 'bg-emerald-950/60' },
  amber:   { t300: 'text-amber-300',   t400: 'text-amber-400',   bg500: 'bg-amber-500',   borderAccent: 'border-amber-400',   bgMuted: 'bg-amber-500/20',   borderMuted: 'border-amber-400/20',   ring: 'ring-amber-400/70',   iconBg: 'bg-amber-400/10',   iconBorder: 'border-amber-300/10',   hoverBorder: 'hover:border-amber-500/40',   extraBorderMuted: 'border-amber-500/20',   cardBg: 'bg-amber-950/60' },
  rose:    { t300: 'text-rose-300',    t400: 'text-rose-400',    bg500: 'bg-rose-500',    borderAccent: 'border-rose-400',    bgMuted: 'bg-rose-500/20',    borderMuted: 'border-rose-400/20',    ring: 'ring-rose-400/70',    iconBg: 'bg-rose-400/10',    iconBorder: 'border-rose-300/10',    hoverBorder: 'hover:border-rose-500/40',    extraBorderMuted: 'border-rose-500/20',    cardBg: 'bg-rose-950/60' },
  teal:    { t300: 'text-teal-300',    t400: 'text-teal-400',    bg500: 'bg-teal-500',    borderAccent: 'border-teal-400',    bgMuted: 'bg-teal-500/20',    borderMuted: 'border-teal-400/20',    ring: 'ring-teal-400/70',    iconBg: 'bg-teal-400/10',    iconBorder: 'border-teal-300/10',    hoverBorder: 'hover:border-teal-500/40',    extraBorderMuted: 'border-teal-500/20',    cardBg: 'bg-teal-950/60' },
}

const THEME_BG: Record<string, string> = {
  blue:    '#091320',
  purple:  '#0d091e',
  emerald: '#071510',
  amber:   '#150e04',
  rose:    '#17080b',
  teal:    '#071514',
}

const NAV_BG: Record<string, string> = {
  blue:    '#0c1b30',
  purple:  '#130d24',
  emerald: '#0a1a14',
  amber:   '#1a1204',
  rose:    '#1c090e',
  teal:    '#0a1a18',
}

function normalizeAlertCount(alerts: Array<Record<string, unknown>>) {
  const warnings = alerts.filter((alert) =>
    String(alert?.category || alert?.event || '')
      .toLowerCase()
      .includes('warning'),
  ).length
  const advisories = alerts.filter((alert) => {
    const text = `${alert?.category || ''} ${alert?.event || ''}`.toLowerCase()
    return text.includes('advisory') || text.includes('watch')
  }).length
  return { warnings, advisories }
}

function AppInner() {
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    const s = window.localStorage.getItem('lwa_active_tab_v1') as AppTab | null
    return s && ['home','forecast','radar','alerts','more'].includes(s) ? s : 'forecast'
  })
  const [themeKey, setThemeKey] = useState<string>(
    () => window.localStorage.getItem('lwa_theme_v1') || 'blue'
  )
  const [locationInput, setLocationInput] = useState('')
  const [location, setLocation] = useState<SavedLocation | null>(null)
  const [weather, setWeather] = useState<WorkerWeatherResponse | null>(null)
  const [alertsData, setAlertsData] = useState<WorkerAlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [locationLoading, setLocationLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedDayIndex, setExpandedDayIndex] = useState<number | null>(null)
  const [alertsFilter, setAlertsFilter] = useState<'all'|'warning'|'watch'|'advisory'|'statement'>('all')
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null)
  const [alertToggles, setAlertToggles] = useState(() => {
    try { const s = window.localStorage.getItem('lwa_alert_toggles_v1'); if (s) return JSON.parse(s) as Record<string,boolean> } catch {}
    return { severe: true, rain: true, lightning: false, daily: true }
  })
  const [showAllAlerts, setShowAllAlerts] = useState(false)
  const [alertsScope, setAlertsScope] = useState<'local' | 'all'>('local')
  const [alertRadius, setAlertRadius] = useState<0 | 25 | 50 | 100>(() => {
    const s = window.localStorage.getItem('lwa_alert_radius_v1')
    return (s ? (Number(s) as 0|25|50|100) : 0)
  })
  const [showSetupModal, setShowSetupModal] = useState<'location' | 'notif' | null>(
    () => window.localStorage.getItem('lwa_setup_done_v1') ? null : 'location'
  )
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showInstallBanner, setShowInstallBanner] = useState(false)

  useEffect(() => {
    const saved = window.localStorage.getItem('lwa_saved_location_v1')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as SavedLocation
        if (parsed?.lat && parsed?.lon) {
          setLocation(parsed)
          return
        }
      } catch {
        // ignore bad local storage value
      }
    }

    setLocation({
      lat: 37.1671,
      lon: -83.2913,
      city: 'Wooton',
      state: 'KY',
      zip: '41776',
      label: 'Wooton, KY',
    })
  }, [])

  useEffect(() => {
    if (!location?.lat || !location?.lon) return

    const lat = location.lat
    const lon = location.lon
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const weatherUrl = `${API_BASE}/api/weather?lat=${lat}&lon=${lon}`
        const alertsUrl = `${API_BASE}/api/alerts`
        const radarUrl = `${API_BASE}/api/radar?lat=${lat}&lon=${lon}`

        const [weatherRes, alertsRes, radarRes] = await Promise.all([
          fetch(weatherUrl),
          fetch(alertsUrl),
          fetch(radarUrl),
        ])

        const weatherJson = (await weatherRes.json()) as WorkerWeatherResponse
        const alertsJson = (await alertsRes.json()) as WorkerAlertsResponse
        const radarJson = (await radarRes.json()) as Record<string, unknown>

        if (cancelled) return

        setWeather({ ...weatherJson, radar: weatherJson?.radar || radarJson })
        setAlertsData(alertsJson)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load weather data.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [location?.lat, location?.lon])

  async function useSearchLocation() {
    const input = locationInput.trim()
    if (!input) return
    setLocationLoading(true)
    setError(null)
    try {
      const isZip = /^\d{5}$/.test(input)
      const url = isZip
        ? `${API_BASE}/api/geocode?zip=${encodeURIComponent(input)}`
        : `${API_BASE}/api/geocode?query=${encodeURIComponent(input)}`
      const res = await fetch(url)
      const json = (await res.json()) as SavedLocation & { error?: string }
      if (!res.ok) throw new Error(json?.error || 'Could not find that location.')
      setLocation(json)
      window.localStorage.setItem('lwa_saved_location_v1', JSON.stringify(json))
      window.localStorage.setItem('lwa_setup_done_v1', '1')
      if (!window.localStorage.getItem('lwa_notif_asked_v1')) setShowSetupModal('notif')
      else setShowSetupModal(null)
      setLocationInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Location update failed.')
    } finally {
      setLocationLoading(false)
    }
  }

  async function useDeviceLocation() {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported on this device.')
      return
    }

    setLocationLoading(true)
    setError(null)

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const lat = position.coords.latitude
          const lon = position.coords.longitude
          const res = await fetch(`${API_BASE}/api/geocode?lat=${lat}&lon=${lon}`)
          const json = (await res.json()) as SavedLocation & { error?: string }
          if (!res.ok) throw new Error(json?.error || 'Could not resolve your location.')
          setLocation(json)
          window.localStorage.setItem('lwa_saved_location_v1', JSON.stringify(json))
          window.localStorage.setItem('lwa_setup_done_v1', '1')
          if (!window.localStorage.getItem('lwa_notif_asked_v1')) setShowSetupModal('notif')
          else setShowSetupModal(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Location update failed.')
        } finally {
          setLocationLoading(false)
        }
      },
      (geoError) => {
        setLocationLoading(false)
        setError(geoError.message || 'Location permission denied.')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    )
  }

  async function shareAlert(alert: Record<string, unknown>) {
    const event = String(alert.event || 'Weather Alert')
    const headline = String(alert.headline || alert.summary || '')
    const alertId = String(alert.id || '')
    const siteUrl = alertId
      ? `${window.location.href.split('?')[0]}?alert=${encodeURIComponent(alertId)}`
      : ''
    const url = siteUrl || String(alert.nwsUrl || '')
    if (navigator.share) {
      try {
        await navigator.share({ title: event, text: headline || event, ...(url ? { url } : {}) })
      } catch { /* cancelled */ }
    } else if (url) {
      await navigator.clipboard.writeText(url).catch(() => {})
    } else {
      await navigator.clipboard.writeText(headline ? `${event}\n${headline}` : event).catch(() => {})
    }
  }

  async function sendTestNotification() {
    if (!('Notification' in window)) {
      setError('Notifications are not supported on this device.')
      return
    }
    try {
      const perm = await Notification.requestPermission()
      if (perm === 'granted') {
        const notifOptions = {
          body: '\u2705 Test alert \u2014 your notifications are working!',
          icon: '/icon-192.svg',
        }
        let shown = false
        // Mobile Chrome/Brave require SW-based notifications; new Notification() throws on Android.
        // Race against a 500 ms timeout so dev (no SW registered) falls back to the constructor.
        if ('serviceWorker' in navigator) {
          try {
            const reg = await Promise.race([
              navigator.serviceWorker.ready,
              new Promise<ServiceWorkerRegistration>((_, reject) =>
                setTimeout(() => reject(new Error('sw-timeout')), 500)
              ),
            ])
            await reg.showNotification('Live Weather Alerts', notifOptions)
            shown = true
          } catch {
            // SW not available — fall through
          }
        }
        if (!shown) {
          new Notification('Live Weather Alerts', notifOptions)
        }
      } else if (perm === 'denied') {
        setError('Notifications are blocked. Enable them in your browser or device settings.')
      }
    } catch {
      setError('Could not send test notification.')
    }
  }

  // Persist settings to localStorage
  useEffect(() => { window.localStorage.setItem('lwa_active_tab_v1', activeTab) }, [activeTab])
  useEffect(() => { window.localStorage.setItem('lwa_theme_v1', themeKey) }, [themeKey])
  useEffect(() => { window.localStorage.setItem('lwa_alert_radius_v1', String(alertRadius)) }, [alertRadius])
  useEffect(() => { window.localStorage.setItem('lwa_alert_toggles_v1', JSON.stringify(alertToggles)) }, [alertToggles])

  // PWA install banner
  useEffect(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return
    const stored = (() => {
      try { return JSON.parse(window.localStorage.getItem('lwa_install_v1') || '{}') } catch { return {} }
    })() as { count?: number; last?: number | null }
    const dismissCount = stored.count ?? 0
    const lastDismissed = stored.last ?? null
    const handler = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as unknown as BeforeInstallPromptEvent)
      if (dismissCount >= 3) return
      if (lastDismissed && Date.now() - lastDismissed < 48 * 60 * 60 * 1000) return
      setShowInstallBanner(true)
    }
    const onInstalled = () => {
      window.localStorage.setItem('lwa_install_v1', JSON.stringify({ count: 3, last: null }))
      setShowInstallBanner(false)
      setInstallPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const triggerInstall = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') {
      window.localStorage.setItem('lwa_install_v1', JSON.stringify({ count: 3, last: null }))
      setShowInstallBanner(false)
      setInstallPrompt(null)
    }
  }

  const dismissInstallBanner = () => {
    setShowInstallBanner(false)
    const stored = (() => {
      try { return JSON.parse(window.localStorage.getItem('lwa_install_v1') || '{}') } catch { return {} }
    })() as { count?: number }
    const count = (stored.count ?? 0) + 1
    window.localStorage.setItem('lwa_install_v1', JSON.stringify({ count, last: Date.now() }))
  }

  // Enrich location with countyCode and zoneCode if missing
  useEffect(() => {
    if (!location?.lat || !location?.lon || (location?.countyCode && location?.zoneCode)) return
    const lat = location.lat, lon = location.lon
    fetch(`${API_BASE}/api/geocode?lat=${lat}&lon=${lon}`)
      .then((r) => r.json())
      .then((json: SavedLocation) => {
        if (json?.countyCode || json?.zoneCode) {
          setLocation((prev) => {
            if (!prev) return prev
            const enriched = { ...prev, countyCode: json.countyCode, county: json.county, zoneCode: json.zoneCode }
            window.localStorage.setItem('lwa_saved_location_v1', JSON.stringify(enriched))
            return enriched
          })
        }
      })
      .catch(() => {})
  }, [location?.lat, location?.lon, location?.countyCode, location?.zoneCode])

  const tc = THEMES[themeKey] ?? THEMES.blue

  const current = weather?.current || {}
  const hourly = useMemo(() => (weather?.hourly || []).slice(0, 6), [weather?.hourly])
  const daily = useMemo(() => (weather?.daily || []).slice(0, 7), [weather?.daily])

  // Use all alerts from the active feed (NWS /alerts/active already returns only active alerts)
  const alerts = useMemo(() => {
    return alertsData?.alerts ?? []
  }, [alertsData?.alerts])

  const localAlerts = useMemo(() => {
    if (!location?.state) return []
    const stateCode = String(location.state).toUpperCase()
    return alerts.filter((alert) => {
      // Check primary stateCode first
      if (String(alert?.stateCode || '').toUpperCase() === stateCode) return true
      // Also check stateCodes array for multi-state alerts (e.g. IL+IN+KY+MO)
      const codes = Array.isArray(alert?.stateCodes) ? (alert.stateCodes as string[]) : []
      return codes.some((c) => String(c).toUpperCase() === stateCode)
    })
  }, [alerts, location])

  // County/radius-filtered alerts for the home screen
  // alertRadius=0 → UGC county+zone matching (precise)
  // alertRadius>0 → show all state-level alerts (user opted into wider view)
  const countyAlerts = useMemo(() => {
    // Radius mode: return all state-level alerts unfiltered
    if (alertRadius > 0) return localAlerts

    const countyUgc =
      location?.countyCode && location?.state
        ? `${String(location.state).toUpperCase()}C${String(location.countyCode).padStart(3, '0')}`
        : null
    const zoneUgc = location?.zoneCode ? String(location.zoneCode).toUpperCase() : null

    // Build set of UGC codes that apply to this user
    const userUgcs = new Set<string>([
      ...(countyUgc ? [countyUgc] : []),
      ...(zoneUgc ? [zoneUgc] : []),
    ])

    if (userUgcs.size > 0) {
      const byUgc = localAlerts.filter((alert) => {
        const ugcs = Array.isArray(alert?.ugc) ? (alert.ugc as string[]) : []
        return ugcs.some((u) => userUgcs.has(String(u).toUpperCase()))
      })
      if (byUgc.length > 0) return byUgc
    }

    // No county code available yet (still geocoding) — fall back to state-level
    return localAlerts
  }, [localAlerts, location, alertRadius])

  const scopedAlerts = useMemo(() => {
    return alertsScope === 'local' ? countyAlerts : alerts
  }, [alertsScope, countyAlerts, alerts])

  // Per-day alert matching for the forecast page
  const dayAlerts = useMemo(() => {
    return daily.map((day) => {
      const dayStart = new Date(String(day?.startTime || '')).getTime()
      if (!Number.isFinite(dayStart)) return []
      return localAlerts.filter((alert) => {
        const expires = Date.parse(String(alert?.expires || '0'))
        return Number.isFinite(expires) && expires > dayStart
      })
    })
  }, [daily, localAlerts])

  const filteredAlerts = useMemo(() => {
    return scopedAlerts
      .filter((alert) => {
        if (alertsFilter === 'all') return true
        const text = String(alert?.event || alert?.category || '').toLowerCase()
        return text.includes(alertsFilter)
      })
      .sort((a, b) => {
        const ta = Date.parse(String(a?.updated || a?.sent || '0')) || 0
        const tb = Date.parse(String(b?.updated || b?.sent || '0')) || 0
        return tb - ta
      })
  }, [scopedAlerts, alertsFilter])

  const counts = normalizeAlertCount(scopedAlerts)
  const currentLocationLabel = getLocationLabel(location, weather?.location)
  const activeAlertHero = countyAlerts[0] || null

  return (
    <div className="min-h-screen text-white" style={{ backgroundColor: THEME_BG[themeKey] || '#091320' }}>
      {/* PWA install banner — slides down from top */}
      <div
        className={`fixed left-1/2 z-40 w-full max-w-md -translate-x-1/2 px-4 transition-all duration-300 ease-out ${
          showInstallBanner ? 'top-3 opacity-100' : '-top-24 opacity-0 pointer-events-none'
        }`}
      >
        <div
          className="flex items-center gap-3 rounded-2xl border border-white/10 p-3 shadow-xl backdrop-blur-md"
          style={{ backgroundColor: NAV_BG[themeKey] || '#0c1b30' }}
        >
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tc.bg500}`}>
            <TriangleAlert className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold leading-none">Live Weather Alerts</div>
            <div className="mt-0.5 text-xs text-white/50">Add to home screen for quick access</div>
          </div>
          <button
            onClick={() => void triggerInstall()}
            className={`shrink-0 rounded-lg ${tc.bg500} px-3 py-2 text-xs font-semibold text-white`}
          >
            Install
          </button>
          <button
            onClick={dismissInstallBanner}
            className="shrink-0 rounded-lg p-1.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
            aria-label="Dismiss install banner"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mx-auto min-h-screen w-full max-w-md pb-28">
        <div className="flex items-center justify-between border-b border-white/10 px-4 pb-3 pt-4">
          <div>
            <div className="text-xs tracking-wide text-white/60">LIVE WEATHER ALERTS</div>
            <div className="flex items-center gap-2 text-sm text-white/80">
              <MapPin className="h-4 w-4" /> {currentLocationLabel}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setActiveTab('more')} className="rounded-lg bg-white/5 p-2" aria-label="Notifications">
              <Bell className="h-5 w-5" />
            </button>
            <button onClick={() => setActiveTab('more')} className="rounded-lg bg-white/5 p-2" aria-label="Menu">
              <Menu className="h-5 w-5" />
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 pt-4">
            <div className="rounded-2xl border border-red-500/30 bg-red-900/30 p-4 text-sm text-red-100">
              {error}
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 pt-12 text-white/60">
            <Loader2 className="h-8 w-8 animate-spin" />
            <div className="text-sm">Loading live data from your worker…</div>
          </div>
        ) : (
          <>
            {activeTab === 'home' && (
              <>
                {activeAlertHero ? (
                  <div className="px-4 pt-4">
                    <div className="rounded-2xl border border-red-500/30 bg-gradient-to-b from-red-700 to-red-900 p-5">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-red-200">
                        {String(activeAlertHero.event || 'ACTIVE ALERT').toUpperCase()}
                      </div>
                      <div className="mb-1 text-3xl font-bold">{currentLocationLabel}</div>
                      <div className="mb-3 text-sm text-red-100">
                        {(activeAlertHero.summary as string) ||
                          (activeAlertHero.headline as string) ||
                          'Weather alert in effect'}
                      </div>
                      <div className="mb-4 flex flex-wrap gap-2 text-xs">
                        <span className="rounded bg-red-500/20 px-2 py-1">
                          {(activeAlertHero.severity as string) || 'Alert'}
                        </span>
                        {activeAlertHero.urgency ? (
                          <span className="rounded bg-red-500/20 px-2 py-1">
                            {activeAlertHero.urgency as string}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-red-200">
                          Until {formatDateTime(activeAlertHero.expires as string)}
                        </div>
                        <button
                          onClick={() => {
                            const id = String(activeAlertHero.id || 'hero')
                            setExpandedAlertId((prev) => (prev === id ? null : id))
                          }}
                          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-red-700"
                        >
                          {expandedAlertId === String(activeAlertHero.id || 'hero') ? 'Less' : 'Details'}{' '}
                          <ChevronRight className="inline h-4 w-4" />
                        </button>
                      </div>
                      {expandedAlertId === String(activeAlertHero.id || 'hero') && (
                        <div className="mt-3 space-y-2 border-t border-white/20 pt-3 text-sm">
                          {(activeAlertHero.description as string) ? (
                            <div className="whitespace-pre-wrap leading-relaxed text-red-100/90">
                              {formatAlertDescription(activeAlertHero.description as string)}
                            </div>
                          ) : null}
                          {(activeAlertHero.instruction as string) ? (
                            <div className="mt-2 whitespace-pre-wrap leading-relaxed text-yellow-200/80">
                              {formatAlertDescription(activeAlertHero.instruction as string)}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="px-4 pt-4">
                    <div className="rounded-2xl border border-green-400/30 bg-gradient-to-b from-emerald-900 to-emerald-800 p-5">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-emerald-200">
                        ALL CLEAR
                      </div>
                      <div className="mb-1 text-3xl font-bold">{currentLocationLabel}</div>
                      <div className="mb-3 text-sm text-emerald-100">
                        There are no active alerts in your area right now.
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-emerald-200">
                          Updated {formatDateTime(weather?.updated || '')}
                        </div>
                        <button
                          onClick={() => setActiveTab('forecast')}
                          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-emerald-700"
                        >
                          Explore Forecast
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-4 space-y-3 px-4">
                  {countyAlerts.slice(1, 5).map((alert, idx) => {
                    const styles = alertBorderClass(
                      String(alert?.event || ''),
                      String(alert?.severity || ''),
                    )
                    const homeAlertId = String(alert.id || `home-${idx}`)
                    const isHomeExpanded = expandedAlertId === homeAlertId
                    return (
                      <div
                        key={homeAlertId}
                        onClick={() => setExpandedAlertId((prev) => (prev === homeAlertId ? null : homeAlertId))}
                        className={`cursor-pointer rounded-xl border-l-4 ${tc.cardBg} p-4 ${styles.border}`}
                      >
                        <div className={`mb-1 text-xs ${styles.label}`}>
                          {String(alert.event || 'ALERT').toUpperCase()}
                        </div>
                        <div className="text-lg font-semibold">
                          {(alert.event as string) || 'Weather Alert'}
                        </div>
                        <div className="mt-1 text-sm text-white/70">
                          {(alert.summary as string) ||
                            (alert.headline as string) ||
                            'Tap for details.'}
                        </div>
                        {isHomeExpanded && (
                          <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
                            {(alert.areaDesc as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Area</div>
                                <div className="text-sm text-white/70">{alert.areaDesc as string}</div>
                              </div>
                            ) : null}
                            {(alert.description as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Description</div>
                                <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">{formatAlertDescription(alert.description as string)}</div>
                              </div>
                            ) : null}
                            {(alert.instruction as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Instructions</div>
                                <div className="whitespace-pre-wrap text-sm leading-relaxed text-yellow-200/80">{formatAlertDescription(alert.instruction as string)}</div>
                              </div>
                            ) : null}
                            {(alert.expires as string) ? (
                              <div className="text-xs text-white/40">Expires {formatDateTime(alert.expires as string)}</div>
                            ) : null}
                          </div>
                        )}
                        <div className="mt-2 flex items-center justify-between">
                          <div className="text-xs text-white/40">
                            Issued {formatDateTime((alert.sent as string) || (alert.updated as string))}
                          </div>
                          <div className="flex items-center gap-3">
                            {(alert.nwsUrl as string) ? (
                              <a
                                href={alert.nwsUrl as string}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-white/40 hover:text-white/70 transition-colors"
                                aria-label="View on NWS"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            ) : null}
                            <button
                              onClick={(e) => { e.stopPropagation(); void shareAlert(alert) }}
                              className="text-white/40 hover:text-white/70 transition-colors"
                              aria-label="Share alert"
                            >
                              <Share2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {countyAlerts.length > 5 && (
                    <button
                      onClick={() => setActiveTab('alerts')}
                      className={`w-full rounded-xl border border-white/10 ${tc.cardBg} py-3 text-sm font-medium ${tc.t400}`}
                    >
                      {countyAlerts.length - 5} more alerts — tap to view all
                    </button>
                  )}

                  <div className={`mt-2 rounded-2xl border border-white/10 p-5 ${tc.cardBg}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className={`mb-2 text-xs tracking-wide ${tc.t300}`}>CURRENT</div>
                        <div className="text-4xl font-bold leading-none">
                          {formatTemp(getCurrentTemp(current))}
                        </div>
                        <div className="mt-2 text-lg font-medium">{getCurrentCondition(current)}</div>
                        <div className="mt-1 text-sm text-white/60">
                          Feels like {formatTemp(getFeelsLike(current))}
                        </div>
                      </div>
                      <div className={`rounded-2xl border ${tc.iconBorder} ${tc.iconBg} p-4`}>
                        {React.createElement(weatherIconFromText(getCurrentCondition(current), !!(current?.isNight)), {
                          className: `h-12 w-12 ${tc.t300}`,
                        })}
                      </div>
                    </div>
                    <div className="mt-5 grid grid-cols-4 gap-3 text-center">
                      <div className="rounded-xl bg-white/5 p-3">
                        <Wind className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">Wind</div>
                        <div className="mt-1 text-sm font-semibold">{String(getWind(current))}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Droplets className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">Humidity</div>
                        <div className="mt-1 text-sm font-semibold">{formatPercent(getHumidity(current))}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Eye className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">Visibility</div>
                        <div className="mt-1 text-sm font-semibold">{String(getVisibility(current))}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Gauge className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">Pressure</div>
                        <div className="mt-1 text-sm font-semibold">{formatPressure(getPressure(current))}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {activeTab === 'forecast' && (
              <>
                <div className="px-4 pt-4">
                  <div className={`rounded-2xl border border-white/10 p-5 ${tc.cardBg}`}>
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className={`mb-2 text-xs tracking-wide ${tc.t300}`}>FORECAST</div>
                        <div className="text-4xl font-bold leading-none">
                          {formatTemp(getCurrentTemp(current))}
                        </div>
                        <div className="mt-2 text-lg font-medium">{getCurrentCondition(current)}</div>
                        <div className="mt-1 text-sm text-white/60">
                          Tonight low {formatTemp(getDailyLow(daily[0] || {}))} • Tomorrow high{' '}
                          {formatTemp(getDailyHigh(daily[1] || daily[0] || {}))}
                        </div>
                      </div>
                      <div className={`rounded-2xl border ${tc.iconBorder} ${tc.iconBg} p-4`}>
                        {React.createElement(weatherIconFromText(getCurrentCondition(current), !!(current?.isNight)), {
                          className: `h-12 w-12 ${tc.t300}`,
                        })}
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-4 gap-3 text-center">
                      <div className="rounded-xl bg-white/5 p-3">
                        <Wind className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">
                          Wind
                        </div>
                        <div className="mt-1 text-sm font-semibold">{String(getWind(current))}</div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Droplets className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">
                          Humidity
                        </div>
                        <div className="mt-1 text-sm font-semibold">
                          {formatPercent(getHumidity(current))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Eye className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">
                          Visibility
                        </div>
                        <div className="mt-1 text-sm font-semibold">
                          {String(getVisibility(current))}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/5 p-3">
                        <Gauge className="mx-auto mb-2 h-4 w-4 text-white/70" />
                        <div className="text-[11px] uppercase tracking-wide text-white/50">
                          Pressure
                        </div>
                        <div className="mt-1 text-sm font-semibold">
                          {formatPressure(getPressure(current))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 px-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold tracking-wide text-white/70">
                      HOURLY FORECAST
                    </div>
                    <button
                      onClick={() => setActiveTab('radar')}
                      className={`text-sm font-medium ${tc.t400}`}
                    >
                      Radar <ChevronRight className="inline h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                    {hourly.map((item, index) => {
                      const Icon = weatherIconFromText(
                        String(item?.shortForecast || item?.condition || item?.summary || ''),
                        isNightFromHourlyItem(item),
                      )
                      return (
                        <div
                          key={index}
                          className={`min-w-[84px] rounded-2xl border border-white/10 ${tc.cardBg} p-3 text-center`}
                        >
                          <div className="text-[11px] text-white/45">{getHourlyTime(item)}</div>
                          <Icon className={`mx-auto my-3 h-5 w-5 ${tc.t300}`} />
                          <div className="text-xl font-semibold">{formatTemp(getHourlyTemp(item))}</div>
                          <div className={`mt-1 text-xs ${tc.t400}`}>
                            {formatPercent(getHourlyRain(item))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="mt-5 px-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold tracking-wide text-white/70">
                      7-DAY FORECAST
                    </div>
                    <div className="text-xs text-white/40">Updated {formatDateTime(weather?.updated)}</div>
                  </div>
                  <div className="space-y-3">
                    {daily.map((day, idx) => {
                      const Icon = weatherIconFromText(getDailySummary(day))
                      const expanded = expandedDayIndex === idx
                      const thisDayAlerts = dayAlerts[idx] ?? []
                      return (
                        <div
                          key={idx}
                          onClick={() => setExpandedDayIndex(expanded ? null : idx)}
                          className={`cursor-pointer rounded-2xl border p-4 ${tc.borderMuted} ${tc.cardBg} ${expanded ? `ring-2 ${tc.ring}` : ''}`}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex items-center gap-3">
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5">
                              <Icon className={`h-5 w-5 ${tc.t300}`} />
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <div className="text-base font-semibold">{getDailyLabel(day)}</div>
                                  {thisDayAlerts.length > 0 && (
                                    <span className="shrink-0 rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400">
                                      Alert
                                    </span>
                                  )}
                                </div>
                                <div className="truncate text-sm text-white/55">
                                  {getDailySummary(day)}
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="mb-1 text-sm text-white/45">
                                {formatPercent(getDailyPrecip(day))} rain
                              </div>
                              <div className="text-base font-semibold">
                                {formatTemp(getDailyHigh(day))}{' '}
                                <span className="font-normal text-white/35">
                                  / {formatTemp(getDailyLow(day))}
                                </span>
                              </div>
                            </div>
                          </div>
                          {expanded ? (
                            <div className={`mt-3 space-y-2 rounded-xl border ${tc.extraBorderMuted} bg-[#0d1b36] p-3 text-sm text-white/80`}>
                              {/* Daytime */}
                              <div className={`text-[11px] font-semibold uppercase tracking-wide ${tc.t400}`}>Day</div>
                              <div>{getDailySummary(day)}</div>
                              {String(day?.detailedForecast || '') && String(day?.detailedForecast) !== getDailySummary(day) && (
                                <div className="text-white/60">{String(day?.detailedForecast)}</div>
                              )}
                              <div className="text-white/70">Wind: {String(day?.windDirection || '')} {String(day?.windSpeed || '')}</div>
                              <div className="text-white/70">Rain: {formatPercent(getDailyPrecip(day))}</div>

                              {/* Nighttime */}
                              {getDailyNightSummary(day) && (
                                <>
                                  <div className={`border-t border-white/10 pt-2 text-[11px] font-semibold uppercase tracking-wide ${tc.t400}`}>Tonight</div>
                                  <div>{getDailyNightSummary(day)}</div>
                                  {getDailyNightDetailedForecast(day) && getDailyNightDetailedForecast(day) !== getDailyNightSummary(day) && (
                                    <div className="text-white/60">{getDailyNightDetailedForecast(day)}</div>
                                  )}
                                  {getDailyNightPrecip(day) !== null && (
                                    <div className="text-white/70">Rain: {formatPercent(getDailyNightPrecip(day))}</div>
                                  )}
                                </>
                              )}

                              {/* Sunrise / Sunset (today only) */}
                              {idx === 0 && (
                                <div className="flex gap-4 border-t border-white/10 pt-2">
                                  <div className="flex items-center gap-1.5">
                                    <Sunrise className="h-4 w-4 text-yellow-400" />
                                    <span>{formatDateTime(current.sunrise as string) || 'N/A'}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <Sunset className="h-4 w-4 text-orange-400" />
                                    <span>{formatDateTime(current.sunset as string) || 'N/A'}</span>
                                  </div>
                                </div>
                              )}

                              {/* Alert links */}
                              {thisDayAlerts.length > 0 && (
                                <div className="border-t border-white/10 pt-2">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setActiveTab('alerts') }}
                                    className="flex items-center gap-1.5 text-xs font-medium text-yellow-400"
                                  >
                                    <TriangleAlert className="h-3.5 w-3.5" />
                                    {thisDayAlerts.length} active alert{thisDayAlerts.length !== 1 ? 's' : ''} affecting this area
                                    <ChevronRight className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )}

                              <div className="pt-1 text-xs text-white/40">Tap to collapse</div>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}

            {activeTab === 'radar' && (
              <>
                <div className="flex flex-col px-4 pt-4" style={{ height: 'calc(100vh - 11rem)' }}>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className={`mb-1 text-xs tracking-wide ${tc.t300}`}>LIVE RADAR</div>
                      <div className="text-lg font-semibold">{currentLocationLabel}</div>
                    </div>
                    <a
                      href="https://radar.weather.gov/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center gap-2 rounded-lg border ${tc.borderMuted} ${tc.bgMuted} px-3 py-2 text-sm font-medium ${tc.t300}`}
                    >
                      <ExternalLink className="h-4 w-4" />
                      Full Map
                    </a>
                  </div>
                  <div className={`relative flex-1 overflow-hidden rounded-2xl border ${tc.borderMuted}`}>
                    <iframe
                      src="https://radar.weather.gov/"
                      className="h-full w-full border-0"
                      title="NWS Weather Radar"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                    />
                  </div>
                </div>
              </>
            )}

            {activeTab === 'alerts' && (
              <>
                <div className="px-4 pt-4">
                  <div className={`flex items-center justify-between rounded-2xl border ${tc.borderMuted} bg-white/5 px-5 py-4`}>
                    <div>
                      <div className={`text-xs font-semibold tracking-wide ${tc.t300}`}>ACTIVE ALERTS</div>
                      <div className="mt-0.5 text-2xl font-bold">{scopedAlerts.length}</div>
                      <div className="mt-1 text-sm text-white/60">
                        {alertsScope === 'local'
                          ? `In ${currentLocationLabel}`
                          : 'Nationwide'}
                      </div>
                    </div>
                    <div className={`rounded-2xl border ${tc.iconBorder} ${tc.iconBg} p-4`}>
                      <ShieldAlert className={`h-7 w-7 ${tc.t300}`} />
                    </div>
                  </div>
                </div>

                {/* Scope toggle */}
                <div className="mt-3 flex gap-2 px-4">
                  <button
                    onClick={() => { setAlertsScope('local'); setShowAllAlerts(false) }}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      alertsScope === 'local'
                        ? `${tc.borderAccent} ${tc.bgMuted} ${tc.t300}`
                        : 'border-white/10 bg-white/5 text-white/50'
                    }`}
                  >
                    My Area
                  </button>
                  <button
                    onClick={() => { setAlertsScope('all'); setShowAllAlerts(false) }}
                    className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                      alertsScope === 'all'
                        ? `${tc.borderAccent} ${tc.bgMuted} ${tc.t300}`
                        : 'border-white/10 bg-white/5 text-white/50'
                    }`}
                  >
                    All US
                  </button>
                </div>

                {/* Filter pills - grid layout to avoid horizontal scroll */}
                <div className="mt-3 grid grid-cols-5 gap-1.5 px-4">
                  {([
                    { value: 'all', label: 'All' },
                    { value: 'warning', label: 'Warn' },
                    { value: 'watch', label: 'Watch' },
                    { value: 'advisory', label: 'Advis' },
                    { value: 'statement', label: 'Stmt' },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setAlertsFilter(opt.value); setShowAllAlerts(false) }}
                      className={`rounded-full py-1.5 text-xs font-medium transition-colors ${
                        alertsFilter === opt.value
                          ? `${tc.bg500} text-white`
                          : 'bg-white/10 text-white/60 hover:bg-white/15'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-3 px-4">
                  <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-4 text-center`}>
                    <div className="text-xs uppercase tracking-wide text-white/45">Warnings</div>
                    <div className="mt-1 text-2xl font-bold text-red-400">{counts.warnings}</div>
                  </div>
                  <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-4 text-center`}>
                    <div className="text-xs uppercase tracking-wide text-white/45">Advisories</div>
                    <div className="mt-1 text-2xl font-bold text-yellow-300">
                      {counts.advisories}
                    </div>
                  </div>
                  <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-4 text-center`}>
                    <div className="text-xs uppercase tracking-wide text-white/45">Updated</div>
                    <div className="mt-2 text-sm font-semibold">
                      {formatDateTime(
                        (alertsData?.meta?.generatedAt as string) || weather?.updated,
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 px-4">
                  {(showAllAlerts ? filteredAlerts : filteredAlerts.slice(0, 6)).map((alert, idx) => {
                    const styles = alertBorderClass(
                      String(alert?.event || ''),
                      String(alert?.severity || ''),
                    )
                    const alertId = String(alert.id || idx)
                    const isExpanded = expandedAlertId === alertId
                    return (
                      <div
                        key={alertId}
                        id={`alert-card-${alertId}`}
                        onClick={() => setExpandedAlertId(isExpanded ? null : alertId)}
                        className={`cursor-pointer rounded-xl border-l-4 ${tc.cardBg} p-4 ${styles.border}`}
                      >
                        <div className={`mb-1 text-xs ${styles.label}`}>
                          {String(alert.event || 'ALERT').toUpperCase()}
                        </div>
                        <div className="text-lg font-semibold">
                          {(alert.event as string) || 'Weather Alert'}
                        </div>
                        <div className="mt-1 text-sm text-white/70">
                          {(alert.summary as string) ||
                            (alert.headline as string) ||
                            'Tap for details.'}
                        </div>
                        {isExpanded && (
                          <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
                            {(alert.areaDesc as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Area</div>
                                <div className="text-sm text-white/70">{alert.areaDesc as string}</div>
                              </div>
                            ) : null}
                            {(alert.description as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Description</div>
                                <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/80">{formatAlertDescription(alert.description as string)}</div>
                              </div>
                            ) : null}
                            {(alert.instruction as string) ? (
                              <div>
                                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">Instructions</div>
                                <div className="whitespace-pre-wrap text-sm leading-relaxed text-yellow-200/80">{formatAlertDescription(alert.instruction as string)}</div>
                              </div>
                            ) : null}
                            {(alert.expires as string) ? (
                              <div className="text-xs text-white/40">
                                Expires {formatDateTime(alert.expires as string)}
                              </div>
                            ) : null}
                          </div>
                        )}
                        <div className="mt-3 flex items-center justify-between">
                          <div className="text-xs text-white/40">
                            Issued {formatDateTime((alert.sent as string) || (alert.updated as string))}
                          </div>
                          <div className="flex items-center gap-3">
                            {(alert.nwsUrl as string) ? (
                              <a
                                href={alert.nwsUrl as string}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-white/40 hover:text-white/70 transition-colors"
                                aria-label="View on NWS"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            ) : null}
                            <button
                              onClick={(e) => { e.stopPropagation(); void shareAlert(alert) }}
                              className="text-white/40 hover:text-white/70 transition-colors"
                              aria-label="Share alert"
                            >
                              <Share2 className="inline h-4 w-4" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setExpandedAlertId(isExpanded ? null : alertId) }}
                              className={`text-sm font-medium ${tc.t400}`}
                            >
                              {isExpanded ? 'Less' : 'Details'}{' '}
                              <ChevronRight
                                className={`inline h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {filteredAlerts.length > 6 && (
                    <button
                      onClick={() => setShowAllAlerts((v) => !v)}
                      className={`w-full rounded-xl border border-white/10 ${tc.cardBg} py-3 text-sm font-medium ${tc.t400}`}
                    >
                      {showAllAlerts ? 'Show Less' : `Show All ${filteredAlerts.length} Alerts`}
                    </button>
                  )}
                </div>
              </>
            )}

            {activeTab === 'more' && (
              <>
                <div className="px-4 pt-4">
                  <div className={`rounded-2xl border border-white/10 p-5 ${tc.cardBg}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className={`mb-1 text-xs tracking-wide ${tc.t300}`}>LOCATION</div>
                        <div className="text-xl font-semibold">{currentLocationLabel}</div>
                        <div className="mt-1 text-sm text-white/60">
                          {location?.zip ? `ZIP ${location.zip}` : 'Using saved location'}
                        </div>
                      </div>
                      <button
                        onClick={useDeviceLocation}
                        className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
                      >
                        {locationLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <MapPinned className="h-4 w-4" />
                        )}
                        Use GPS
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mt-4 px-4">
                  <div className="mb-3 text-sm font-semibold tracking-wide text-white/70">
                    CHANGE LOCATION
                  </div>
                  <div className={`rounded-xl border border-white/10 ${tc.cardBg} p-4`}>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <input
                          value={locationInput}
                          onChange={(e) => setLocationInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void useSearchLocation() }}
                          placeholder="City, State or ZIP code"
                          className="w-full rounded-lg border border-white/10 bg-white/5 py-2.5 pl-9 pr-3 text-sm outline-none"
                        />
                      </div>
                      <button
                        onClick={() => void useSearchLocation()}
                        className={`rounded-lg ${tc.bg500} px-4 py-2.5 text-sm font-medium text-white`}
                      >
                        {locationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Update'}
                      </button>
                    </div>
                    <div className="mt-3">
                      <div className="mb-2 text-xs text-white/50">Alert radius (from your location)</div>
                      <div className="flex gap-2">
                        {([0, 25, 50, 100] as const).map((r) => (
                          <button
                            key={r}
                            onClick={() => setAlertRadius(r)}
                            className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                              alertRadius === r
                                ? `${tc.borderAccent} ${tc.bgMuted} ${tc.t300}`
                                : 'border-white/10 bg-white/5 text-white/50'
                            }`}
                          >
                            {r === 0 ? 'County' : `${r} mi`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 px-4">
                  <div className="mb-3 text-sm font-semibold tracking-wide text-white/70">
                    APPEARANCE
                  </div>
                  <div className={`rounded-xl border border-white/10 ${tc.cardBg} p-4`}>
                    <div className="mb-3 flex items-center gap-2">
                      <Palette className="h-4 w-4 text-white/50" />
                      <span className="text-sm text-white/70">Accent Color</span>
                    </div>
                    <div className="grid grid-cols-6 gap-2">
                      {([
                        { key: 'blue',    dot: 'bg-sky-400',     label: 'Blue' },
                        { key: 'purple',  dot: 'bg-purple-400',  label: 'Purple' },
                        { key: 'emerald', dot: 'bg-emerald-400', label: 'Green' },
                        { key: 'amber',   dot: 'bg-amber-400',   label: 'Amber' },
                        { key: 'rose',    dot: 'bg-rose-400',    label: 'Rose' },
                        { key: 'teal',    dot: 'bg-teal-400',    label: 'Teal' },
                      ] as const).map((t) => (
                        <button
                          key={t.key}
                          onClick={() => setThemeKey(t.key)}
                          className={`flex flex-col items-center gap-1 rounded-xl border p-2 transition-colors ${
                            themeKey === t.key ? 'border-white/40 bg-white/10' : 'border-white/10 bg-white/5'
                          }`}
                          title={t.label}
                        >
                          <div className={`h-5 w-5 rounded-full ${t.dot} ${
                            themeKey === t.key ? 'ring-2 ring-white/50 ring-offset-1 ring-offset-[#121a2b]' : ''
                          }`} />
                          <span className="text-[10px] text-white/50">{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 px-4">
                  <div className="mb-3 text-sm font-semibold tracking-wide text-white/70">
                    ALERT SETTINGS
                  </div>
                  <div className="space-y-2">
                    {(
                      [
                        { key: 'severe' as const, label: 'Severe Weather Alerts', desc: 'Warnings, watches & advisories for your area' },
                        { key: 'rain' as const, label: 'Rain Alerts', desc: 'Heavy precipitation notifications' },
                        { key: 'lightning' as const, label: 'Lightning Alerts', desc: 'Thunderstorm & lightning warnings' },
                        { key: 'daily' as const, label: 'Daily Forecast', desc: 'Morning forecast summary' },
                      ]
                    ).map((item) => (
                      <button
                        key={item.key}
                        onClick={() => setAlertToggles((prev) => ({ ...prev, [item.key]: !prev[item.key] }))}
                        className={`flex w-full items-center justify-between rounded-xl border border-white/10 ${tc.cardBg} p-4 text-left`}
                      >
                        <div>
                          <div className="text-sm font-medium">{item.label}</div>
                          <div className="mt-1 text-xs text-white/45">{item.desc}</div>
                        </div>
                        <div
                          className={`flex h-6 w-10 shrink-0 items-center rounded-full p-1 transition-colors ${
                            alertToggles[item.key] ? `justify-end ${tc.bg500}` : 'justify-start bg-white/20'
                          }`}
                        >
                          <div className="h-4 w-4 rounded-full bg-white" />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 px-4">
                  <div className="mb-3 text-sm font-semibold tracking-wide text-white/70">
                    NOTIFICATIONS
                  </div>
                  <button
                    onClick={sendTestNotification}
                    className={`flex w-full items-center justify-between rounded-xl border border-white/10 ${tc.cardBg} p-4 text-left ${tc.hoverBorder} transition-colors`}
                  >
                    <div>
                      <div className="text-sm font-medium">Send Test Notification</div>
                      <div className="mt-1 text-xs text-white/45">Make sure alerts will come through</div>
                    </div>
                    <Bell className={`h-5 w-5 ${tc.t400}`} />
                  </button>
                </div>

                {installPrompt && (
                  <div className="mt-4 px-4">
                    <div className="mb-3 text-sm font-semibold tracking-wide text-white/70">
                      APP
                    </div>
                    <button
                      onClick={() => void triggerInstall()}
                      className={`flex w-full items-center justify-between rounded-xl border border-white/10 ${tc.cardBg} p-4 text-left ${tc.hoverBorder} transition-colors`}
                    >
                      <div>
                        <div className="text-sm font-medium">Install App</div>
                        <div className="mt-1 text-xs text-white/45">Add to your home screen for quick access</div>
                      </div>
                      <Download className={`h-5 w-5 ${tc.t400}`} />
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        <div className="fixed bottom-0 left-1/2 w-full max-w-md -translate-x-1/2 px-4 pb-4">
          <div className="rounded-2xl border border-white/10 p-2 shadow-2xl backdrop-blur" style={{ backgroundColor: NAV_BG[themeKey] || '#0c1b30' }}>
            <div className="grid grid-cols-5 gap-1">
              {[
                { id: 'home', label: 'Home', icon: House },
                { id: 'forecast', label: 'Forecast', icon: CloudSun },
                { id: 'radar', label: 'Radar', icon: Radar },
                { id: 'alerts', label: 'Alerts', icon: TriangleAlert },
                { id: 'more', label: 'More', icon: MoreHorizontal },
              ].map((tab) => {
                const Icon = tab.icon
                const isActive = activeTab === tab.id
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as AppTab)}
                    className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 transition ${
                      isActive
                        ? `${tc.bg500} text-white`
                        : 'text-white/45 hover:bg-white/5 hover:text-white/80'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-[11px] font-medium">{tab.label}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Location setup modal */}
      {showSetupModal === 'location' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-white/10 p-6" style={{ backgroundColor: NAV_BG[themeKey] || '#0c1b30' }}>
            <div className={`mb-1 text-center text-xs tracking-wide ${tc.t300}`}>GET STARTED</div>
            <div className="mb-2 text-center text-2xl font-bold">Set Your Location</div>
            <div className="mb-6 text-center text-sm text-white/60">
              Enter your city &amp; state or ZIP code to get accurate local weather and alerts.
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                <input
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void useSearchLocation() }}
                  placeholder="City, State or ZIP code"
                  className="w-full rounded-lg border border-white/10 bg-white/5 py-2.5 pl-9 pr-3 text-sm outline-none"
                  autoFocus
                />
              </div>
              <button
                onClick={() => void useSearchLocation()}
                disabled={locationLoading}
                className={`rounded-lg ${tc.bg500} px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50`}
              >
                {locationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Go'}
              </button>
            </div>
            <button
              onClick={useDeviceLocation}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 py-2.5 text-sm"
            >
              {locationLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPinned className="h-4 w-4" />}
              Use My Current Location
            </button>
            <button
              onClick={() => { window.localStorage.setItem('lwa_setup_done_v1', '1'); setShowSetupModal(null) }}
              className="mt-3 w-full py-2 text-center text-sm text-white/40"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}

      {/* Notifications permission modal */}
      {showSetupModal === 'notif' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-white/10 p-6" style={{ backgroundColor: NAV_BG[themeKey] || '#0c1b30' }}>
            <div className={`mb-1 text-center text-xs tracking-wide ${tc.t300}`}>STAY SAFE</div>
            <div className="mb-2 text-center text-2xl font-bold">Enable Notifications</div>
            <div className="mb-6 text-center text-sm text-white/60">
              Receive instant alerts for severe weather in your area.
            </div>
            <button
              onClick={async () => {
                window.localStorage.setItem('lwa_notif_asked_v1', '1')
                setShowSetupModal(null)
                await sendTestNotification()
              }}
              className={`w-full rounded-lg ${tc.bg500} py-3 text-sm font-semibold text-white`}
            >
              Enable Notifications
            </button>
            <button
              onClick={() => { window.localStorage.setItem('lwa_notif_asked_v1', '1'); setShowSetupModal(null) }}
              className="mt-3 w-full py-2 text-center text-sm text-white/40"
            >
              Not now
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const alertIdParam = (() => {
    try { return new URLSearchParams(window.location.search).get('alert') || null } catch { return null }
  })()
  if (alertIdParam) return <AlertDetailPage alertId={alertIdParam} />
  return <AppInner />
}
