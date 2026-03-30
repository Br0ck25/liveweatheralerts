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

type PushAlertTypeKey = 'warnings' | 'watches' | 'advisories' | 'statements'

type PushAlertToggleState = Record<PushAlertTypeKey, boolean>

type PushDeliveryScope = 'state' | 'county' | 'radius'

type PushScopePreference = {
  id: string
  placeId?: string | null
  label: string
  stateCode: string
  deliveryScope: PushDeliveryScope
  countyName?: string | null
  countyFips?: string | null
  centerLat?: number | null
  centerLon?: number | null
  radiusMiles?: number | null
  enabled: boolean
  alertTypes: PushAlertToggleState
  severeOnly: boolean
}

type PushPreferences = {
  scopes: PushScopePreference[]
  quietHours: {
    enabled: boolean
    start: string
    end: string
  }
  deliveryMode: 'immediate' | 'digest'
  pausedUntil?: string | null
}

type PushPublicKeyResponse = {
  publicKey?: string
  error?: string
}

type PushMutationResponse = {
  ok?: boolean
  error?: string
  subscriptionId?: string
  prefs?: PushPreferences
}

type WorkerRadarResponse = {
  station?: string | null
  loopImageUrl?: string | null
  stillImageUrl?: string | null
  updated?: string
  summary?: string
  frames?: Array<Record<string, unknown>>
  tileTemplate?: string | null
  hasLiveTiles?: boolean
}

type WorkerWeatherResponse = {
  location?: Record<string, unknown>
  current?: Record<string, unknown>
  hourly?: Array<Record<string, unknown>>
  daily?: Array<Record<string, unknown>>
  radar?: WorkerRadarResponse
  updated?: string
}

type WorkerAlertsResponse = {
  alerts?: WorkerAlert[]
  meta?: Record<string, unknown>
}

type WorkerAlert = Record<string, unknown>

type ResourceErrors = {
  weather: string | null
  localAlerts: string | null
  allAlerts: string | null
}

class FetchError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type PushTestDeliveryStatus = 'displayed' | 'failed' | 'timeout'

type PushTestStatusMessage = {
  type?: string
  clientTestId?: string
  status?: 'displayed' | 'failed'
  error?: string
}

const PUSH_TEST_STATUS_MESSAGE_TYPE = 'lwa:push-test-status'
const PUSH_TEST_TIMEOUT_MS = 8000
const DATA_POLL_INTERVAL_MS = 2 * 60 * 1000

function isPushVapidMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /vapid credentials.*do not correspond|create the subscriptions/i.test(error.message)
}

function resolveApiBase(): string {
  const configuredBase = String(import.meta.env.VITE_API_BASE || '').trim().replace(/\/+$/, '')
  if (configuredBase) return configuredBase

  if (typeof window === 'undefined') return ''

  const { hostname, port } = window.location
  const isLocalFrontend =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0'

  if (isLocalFrontend && port !== '8787') {
    return 'http://127.0.0.1:8787'
  }

  return ''
}

const API_BASE = resolveApiBase()

function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path
}

function isLocalAppHost(): boolean {
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init)
  const text = await response.text()
  const payload = text
    ? (() => {
        try {
          return JSON.parse(text) as T & { error?: string }
        } catch {
          return null
        }
      })()
    : null

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : response.statusText || 'Request failed.'
    throw new FetchError(response.status, message)
  }

  return (payload ?? ({} as T)) as T
}

function resourceErrorMessage(label: string, error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `${label} unavailable: ${error.message.trim()}`
  }
  return `${label} unavailable right now.`
}

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
  return { border: 'alert-border-default', label: 'alert-label-default' }
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

function isAppTab(value: string | null): value is AppTab {
  return !!value && ['home', 'forecast', 'radar', 'alerts', 'more'].includes(value)
}

function decodeUrlValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function getAlertIdFromLocation(): string | null {
  try {
    const url = new URL(window.location.href)
    const alertFromQuery = url.searchParams.get('alert')
    if (alertFromQuery) return alertFromQuery

    const pathMatch = url.pathname.match(/^\/alerts\/(.+?)\/?$/)
    if (pathMatch?.[1]) return decodeUrlValue(pathMatch[1])
  } catch {
    // ignore malformed URL
  }

  return null
}

function buildAppUrl(options: {
  alertId?: string | null
  tab?: AppTab | null
  state?: string | null
} = {}): string {
  const url = new URL(window.location.href)
  url.pathname = '/'
  url.search = ''

  const alertId = String(options.alertId || '').trim()
  if (alertId) {
    url.searchParams.set('alert', alertId)
    return url.toString()
  }

  if (options.tab) {
    url.searchParams.set('tab', options.tab)
  }

  const state = String(options.state || '').trim().toUpperCase()
  if (state) {
    url.searchParams.set('state', state)
  }

  return url.toString()
}

function getInitialActiveTab(): AppTab {
  try {
    const url = new URL(window.location.href)
    const tab = url.searchParams.get('tab')
    if (isAppTab(tab)) return tab
    if (url.pathname === '/alerts' || url.pathname === '/alerts/') return 'alerts'
    if (url.pathname === '/settings' || url.pathname === '/settings/') return 'more'
  } catch {
    // ignore malformed URL
  }

  const stored = window.localStorage.getItem('lwa_active_tab_v1')
  return isAppTab(stored) ? stored : 'forecast'
}

function normalizeStoredAlertToggles(input: unknown): PushAlertToggleState {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const severe = typeof value.severe === 'boolean' ? value.severe : undefined
  const rain = typeof value.rain === 'boolean' ? value.rain : undefined
  const lightning = typeof value.lightning === 'boolean' ? value.lightning : undefined
  const daily = typeof value.daily === 'boolean' ? value.daily : undefined

  return {
    warnings:
      typeof value.warnings === 'boolean'
        ? value.warnings
        : severe ?? lightning ?? true,
    watches:
      typeof value.watches === 'boolean'
        ? value.watches
        : severe ?? true,
    advisories:
      typeof value.advisories === 'boolean'
        ? value.advisories
        : rain ?? severe ?? true,
    statements:
      typeof value.statements === 'boolean'
        ? value.statements
        : daily ?? true,
  }
}

function normalizeStateCode(state: unknown): string | null {
  const value = String(state || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(value) ? value : null
}

function normalizeCountyFips(countyCode: unknown): string | null {
  const digits = String(countyCode ?? '').replace(/\D/g, '')
  return digits ? digits.padStart(3, '0').slice(-3) : null
}

function buildPushPreferences(
  location: SavedLocation | null,
  alertRadius: 0 | 25 | 50 | 100,
  alertToggles: PushAlertToggleState,
): PushPreferences | null {
  const stateCode = normalizeStateCode(location?.state)
  if (!stateCode) return null

  const countyFips = normalizeCountyFips(location?.countyCode)
  const countyName = String(location?.county || '').trim() || null
  const hasEnabledAlertTypes = Object.values(alertToggles).some(Boolean)
  const hasRadiusCenter = Number.isFinite(location?.lat) && Number.isFinite(location?.lon)
  const useRadiusScope = alertRadius > 0 && hasRadiusCenter
  const useCountyScope = !useRadiusScope && alertRadius === 0 && (!!countyFips || !!countyName)
  const locationLabel = location?.label || countyName || `${stateCode} local area`
  const scopeLabel = useRadiusScope
    ? `Within ${alertRadius} mi of ${locationLabel}`
    : useCountyScope
    ? countyName || location?.label || `${stateCode} Local Alerts`
    : `${stateCode} Alerts`

  return {
    scopes: [
      {
        id: useRadiusScope
          ? `${stateCode}-radius-${alertRadius}-${Number(location?.lat).toFixed(2)}-${Number(location?.lon).toFixed(2)}`
          : useCountyScope
          ? `${stateCode}-county-${countyFips || 'named'}`
          : `${stateCode}-state-default`,
        placeId: null,
        label: scopeLabel,
        stateCode,
        deliveryScope: useRadiusScope ? 'radius' : useCountyScope ? 'county' : 'state',
        countyName: useCountyScope ? countyName : null,
        countyFips: useCountyScope ? countyFips : null,
        centerLat: useRadiusScope ? Number(location?.lat?.toFixed(4)) : null,
        centerLon: useRadiusScope ? Number(location?.lon?.toFixed(4)) : null,
        radiusMiles: useRadiusScope ? alertRadius : null,
        enabled: hasEnabledAlertTypes,
        alertTypes: { ...alertToggles },
        severeOnly: false,
      },
    ],
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '06:00',
    },
    deliveryMode: 'immediate',
    pausedUntil: null,
  }
}

function describePushScope(
  prefs: PushPreferences | null,
  location: SavedLocation | null,
): string {
  const scope = prefs?.scopes.find((item) => item.enabled) || prefs?.scopes[0]
  if (!scope) return 'your current area'
  if (scope.deliveryScope === 'radius') {
    const miles = Number(scope.radiusMiles)
    const targetLabel = scope.label || location?.label || `${scope.stateCode} nearby alerts`
    const cleanTarget = targetLabel.replace(/^Within \d+\s+mi of\s+/i, '')
    return Number.isFinite(miles) && miles > 0
      ? `the ${Math.round(miles)}-mile area around ${cleanTarget}`
      : cleanTarget
  }
  if (scope.deliveryScope === 'county') {
    return scope.countyName || location?.county || location?.label || `${scope.stateCode} local alerts`
  }
  return `${scope.stateCode} statewide alerts`
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported on this device.')
  }

  const registration = await navigator.serviceWorker.register('/sw.js', {
    updateViaCache: 'none',
  })
  try {
    await registration.update()
  } catch {
    // Keep going with the existing active registration.
  }
  try {
    return await navigator.serviceWorker.ready
  } catch {
    // Fall back to the registration we just created.
    return registration
  }
}

function serializePushSubscription(subscription: PushSubscription): Record<string, unknown> {
  return subscription.toJSON() as Record<string, unknown>
}

function createPushTestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `push-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function waitForPushTestStatus(clientTestId: string): Promise<{
  status: PushTestDeliveryStatus
  error?: string
}> {
  if (!('serviceWorker' in navigator)) {
    return Promise.resolve({ status: 'timeout' })
  }

  return new Promise((resolve) => {
    let settled = false

    const finish = (result: { status: PushTestDeliveryStatus; error?: string }) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      navigator.serviceWorker.removeEventListener('message', handleMessage)
      resolve(result)
    }

    const handleMessage = (event: MessageEvent<PushTestStatusMessage>) => {
      const data = event.data
      if (!data || data.type !== PUSH_TEST_STATUS_MESSAGE_TYPE || data.clientTestId !== clientTestId) {
        return
      }

      if (data.status === 'displayed') {
        finish({ status: 'displayed' })
        return
      }

      if (data.status === 'failed') {
        finish({
          status: 'failed',
          error:
            typeof data.error === 'string' && data.error.trim()
              ? data.error.trim()
              : 'The browser received the push event but could not display the notification.',
        })
      }
    }

    const timeoutId = window.setTimeout(() => {
      finish({ status: 'timeout' })
    }, PUSH_TEST_TIMEOUT_MS)

    navigator.serviceWorker.addEventListener('message', handleMessage)
  })
}

// ─── Standalone Alert Detail Page ────────────────────────────────────────────
// Rendered instead of the main App when an alert detail route is in the URL.
// Completely independent of the user's saved location.
const ALERT_PAGE_BG: Record<string, string> = {
  blue: '#091320', purple: '#0d091e', emerald: '#071510',
  amber: '#150e04', rose: '#17080b', teal: '#071514',
  white: '#f8fafc', black: '#020611',
}
const ALERT_PAGE_CARD: Record<string, string> = {
  blue: 'bg-sky-950/60', purple: 'bg-purple-950/60', emerald: 'bg-emerald-950/60',
  amber: 'bg-amber-950/60', rose: 'bg-rose-950/60', teal: 'bg-teal-950/60',
  white: 'bg-white/80', black: 'bg-slate-950/80',
}
const ALERT_PAGE_ACCENT: Record<string, string> = {
  blue: 'text-sky-400', purple: 'text-purple-400', emerald: 'text-emerald-400',
  amber: 'text-amber-400', rose: 'text-rose-400', teal: 'text-teal-400',
  white: 'text-slate-700', black: 'text-slate-300',
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
    fetchJson<{ alert?: Record<string, unknown>; error?: string }>(
      `/api/alerts/${encodeURIComponent(alertId)}`,
    )
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
    if (isAppTab(tab)) {
      window.localStorage.setItem('lwa_active_tab_v1', tab)
      window.location.assign(buildAppUrl({ tab }))
      return
    }

    window.location.assign(buildAppUrl())
  }

  const textColorCls = theme === 'white' ? 'text-slate-900' : 'text-white'
  const cardTextCls = theme === 'white' ? 'text-slate-900' : 'text-white'
  const subtleText = theme === 'white' ? 'text-slate-700' : 'text-white/70'
  const subtleSecondary = theme === 'white' ? 'text-slate-700/70' : 'text-white/40'
  const subtleHover = theme === 'white' ? 'hover:text-slate-900' : 'hover:text-white/70'
  const panelButton = theme === 'white'
    ? 'border-slate-300 bg-white/10 text-slate-800 hover:bg-white/20'
    : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10'

  return (
    <div className={`min-h-screen ${textColorCls}`} style={{ backgroundColor: pageBg }}>
      <div className="mx-auto min-h-screen w-full max-w-md px-4 pb-28 pt-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className={`text-xs tracking-wide ${accentCls} opacity-70`}>LIVE WEATHER ALERTS</div>
            <div className={`text-xs ${subtleSecondary} mt-0.5`}>Alert Detail</div>
          </div>
          <button
            onClick={() => navTo('alerts')}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${panelButton}`}
          >
            Open App <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className={`h-8 w-8 animate-spin ${subtleSecondary}`} />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-900/20 p-5 text-sm text-red-200">
            {error}
          </div>
        )}

        {alert && (
          <div className={`rounded-xl border-l-4 ${cardCls} p-5 ${styles.border} ${cardTextCls}`}>
            <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${styles.label}`}>
              {String(alert.event || 'WEATHER ALERT')}
            </div>
            <div className="text-xl font-bold leading-snug">
              {(alert.event as string) || 'Weather Alert'}
            </div>
            <div className={`mt-1 text-sm ${subtleText}`}>
              {(alert.summary as string) || (alert.headline as string) || ''}
            </div>

            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
              {(alert.areaDesc as string) ? (
                <div>
                  <div className={`mb-1 text-xs font-medium uppercase tracking-wide ${subtleSecondary}`}>Area</div>
                  <div className={`text-sm ${subtleText}`}>{alert.areaDesc as string}</div>
                </div>
              ) : null}
              {(alert.description as string) ? (
                <div>
                  <div className={`mb-1 text-xs font-medium uppercase tracking-wide ${subtleSecondary}`}>Description</div>
                  <div className={`whitespace-pre-wrap text-sm leading-relaxed ${theme === 'white' ? 'text-slate-600/90' : 'text-white/80'}`}>
                    {formatAlertDescription(alert.description as string)}
                  </div>
                </div>
              ) : null}
              {(alert.instruction as string) ? (
                <div>
                  <div className={`mb-1 text-xs font-medium uppercase tracking-wide ${subtleSecondary}`}>Instructions</div>
                  <div className={`whitespace-pre-wrap text-sm leading-relaxed ${theme === 'white' ? 'text-yellow-700/80' : 'text-yellow-200/80'}`}>
                    {formatAlertDescription(alert.instruction as string)}
                  </div>
                </div>
              ) : null}
              {(alert.expires as string) ? (
                <div className={subtleSecondary}>
                  Expires {formatDateTime(alert.expires as string)}
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
              <div className={subtleSecondary}>
                Issued {formatDateTime((alert.sent as string) || (alert.updated as string))}
              </div>
              <div className="flex items-center gap-3">
                {(alert.nwsUrl as string) ? (
                  <a
                    href={alert.nwsUrl as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${subtleSecondary} ${subtleHover} transition-colors`}
                    aria-label="View on NWS"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                ) : null}
                <button
                  onClick={async () => {
                    const url = buildAppUrl({ alertId })
                    if (navigator.share) {
                      try { await navigator.share({ title: String(alert.event || 'Weather Alert'), url }) } catch { /* cancelled */ }
                    } else {
                      await navigator.clipboard.writeText(url).catch(() => {})
                    }
                  }}
                  className={`${subtleSecondary} ${subtleHover} transition-colors`}
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
              const navButtonClass = theme === 'white'
                ? 'flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-slate-700/80 transition hover:bg-slate-100/30 hover:text-slate-900'
                : 'flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-white/45 transition hover:bg-white/5 hover:text-white/80'
              return (
                <button
                  key={tab.id}
                  onClick={() => navTo(tab.id)}
                  className={navButtonClass}
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

function isDisplayableAlert(alert: WorkerAlert): boolean {
  const text = `${String(alert?.event || '')} ${String(alert?.headline || alert?.summary || '')} ${String(alert?.description || '')}`.toLowerCase()
  return !text.includes('test')
}

function buildUserUgcSet(location: SavedLocation | null): Set<string> {
  const countyUgc =
    location?.countyCode && location?.state
      ? `${String(location.state).toUpperCase()}C${String(location.countyCode).padStart(3, '0')}`
      : null
  const zoneUgc = location?.zoneCode ? String(location.zoneCode).toUpperCase() : null
  return new Set<string>([
    ...(countyUgc ? [countyUgc] : []),
    ...(zoneUgc ? [zoneUgc] : []),
  ])
}

function buildLocalAlertsApiPath(
  location: SavedLocation | null,
  alertRadius: 0 | 25 | 50 | 100,
): string {
  const params = new URLSearchParams()
  const stateCode = normalizeStateCode(location?.state)
  if (stateCode) {
    params.set('state', stateCode)
  }

  if (
    location &&
    alertRadius > 0 &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lon)
  ) {
    params.set('lat', String(location.lat))
    params.set('lon', String(location.lon))
    params.set('radius', String(alertRadius))
  } else {
    for (const ugc of buildUserUgcSet(location)) {
      params.append('ugc', ugc)
    }
  }

  const query = params.toString()
  return `/api/alerts${query ? `?${query}` : ''}`
}

function DataUnavailableCard({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string
  message: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="rounded-2xl border border-amber-400/30 bg-amber-950/40 p-5 text-sm text-amber-100">
      <div className="text-xs font-semibold tracking-wide text-amber-300">{title}</div>
      <div className="mt-2 leading-relaxed">{message}</div>
      {actionLabel && onAction ? (
        <button
          onClick={onAction}
          className="mt-4 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-amber-950"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

const THEMES: Record<string, { t300: string; t400: string; bg500: string; borderAccent: string; bgMuted: string; borderMuted: string; ring: string; iconBg: string; iconBorder: string; hoverBorder: string; extraBorderMuted: string; cardBg: string }> = {
  blue:    { t300: 'text-sky-300',     t400: 'text-sky-400',     bg500: 'bg-sky-500',     borderAccent: 'border-sky-400',     bgMuted: 'bg-sky-500/20',     borderMuted: 'border-sky-400/20',     ring: 'ring-sky-400/70',     iconBg: 'bg-sky-400/10',     iconBorder: 'border-sky-300/10',     hoverBorder: 'hover:border-sky-500/40',     extraBorderMuted: 'border-sky-500/20',     cardBg: 'bg-sky-950/60' },
  purple:  { t300: 'text-purple-300',  t400: 'text-purple-400',  bg500: 'bg-purple-500',  borderAccent: 'border-purple-400',  bgMuted: 'bg-purple-500/20',  borderMuted: 'border-purple-400/20',  ring: 'ring-purple-400/70',  iconBg: 'bg-purple-400/10',  iconBorder: 'border-purple-300/10',  hoverBorder: 'hover:border-purple-500/40',  extraBorderMuted: 'border-purple-500/20',  cardBg: 'bg-purple-950/60' },
  emerald: { t300: 'text-emerald-300', t400: 'text-emerald-400', bg500: 'bg-emerald-500', borderAccent: 'border-emerald-400', bgMuted: 'bg-emerald-500/20', borderMuted: 'border-emerald-400/20', ring: 'ring-emerald-400/70', iconBg: 'bg-emerald-400/10', iconBorder: 'border-emerald-300/10', hoverBorder: 'hover:border-emerald-500/40', extraBorderMuted: 'border-emerald-500/20', cardBg: 'bg-emerald-950/60' },
  teal:    { t300: 'text-teal-300',    t400: 'text-teal-400',    bg500: 'bg-teal-500',    borderAccent: 'border-teal-400',    bgMuted: 'bg-teal-500/20',    borderMuted: 'border-teal-400/20',    ring: 'ring-teal-400/70',    iconBg: 'bg-teal-400/10',    iconBorder: 'border-teal-300/10',    hoverBorder: 'hover:border-teal-500/40',    extraBorderMuted: 'border-teal-500/20',    cardBg: 'bg-teal-950/60' },
  white:   { t300: 'text-black/70',    t400: 'text-black',       bg500: 'bg-sky-500',     borderAccent: 'border-sky-400',     bgMuted: 'bg-slate-200',      borderMuted: 'border-slate-400',      ring: 'ring-sky-400/70',     iconBg: 'bg-sky-400/10',     iconBorder: 'border-sky-300/10',     hoverBorder: 'hover:border-sky-500/40',     extraBorderMuted: 'border-sky-500/20',     cardBg: 'bg-slate-100' },
  black:   { t300: 'text-slate-300',    t400: 'text-slate-100',   bg500: 'bg-slate-900',   borderAccent: 'border-slate-700', bgMuted: 'bg-slate-800/70', borderMuted: 'border-slate-600/40', ring: 'ring-slate-400/70', iconBg: 'bg-slate-700/20', iconBorder: 'border-slate-600/20', hoverBorder: 'hover:border-slate-500/40', extraBorderMuted: 'border-slate-500/20', cardBg: 'bg-slate-950/70' },
}

const THEME_BG: Record<string, string> = {
  blue:    '#091320',
  purple:  '#0d091e',
  emerald: '#071510',
  teal:    '#071514',
  white:   '#091320',
  black:   '#020611',
}

const NAV_BG: Record<string, string> = {
  blue:    '#0c1b30',
  purple:  '#130d24',
  emerald: '#0a1a14',
  teal:    '#0a1a18',
  white:   '#ffffff',
  black:   '#0b1320',
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
  const [activeTab, setActiveTab] = useState<AppTab>(() => getInitialActiveTab())
  const [themeKey, setThemeKey] = useState<string>(
    () => window.localStorage.getItem('lwa_theme_v1') || 'blue'
  )
  const [locationInput, setLocationInput] = useState('')
  const [location, setLocation] = useState<SavedLocation | null>(null)
  const [weather, setWeather] = useState<WorkerWeatherResponse | null>(null)
  const [localAlertsData, setLocalAlertsData] = useState<WorkerAlertsResponse | null>(null)
  const [allAlertsData, setAllAlertsData] = useState<WorkerAlertsResponse | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(true)
  const [localAlertsLoading, setLocalAlertsLoading] = useState(true)
  const [allAlertsLoading, setAllAlertsLoading] = useState(false)
  const [locationLoading, setLocationLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resourceErrors, setResourceErrors] = useState<ResourceErrors>({
    weather: null,
    localAlerts: null,
    allAlerts: null,
  })
  const [expandedDayIndex, setExpandedDayIndex] = useState<number | null>(null)
  const [alertsFilter, setAlertsFilter] = useState<'all'|'warning'|'watch'|'advisory'|'statement'>('all')
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null)
  const [alertToggles, setAlertToggles] = useState<PushAlertToggleState>(() => {
    try {
      const stored = window.localStorage.getItem('lwa_alert_toggles_v1')
      if (stored) return normalizeStoredAlertToggles(JSON.parse(stored))
    } catch {
      // ignore malformed local settings
    }

    return normalizeStoredAlertToggles(null)
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
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushServerConfigured, setPushServerConfigured] = useState<boolean | null>(null)
  const [pushPermission, setPushPermission] = useState<NotificationPermission | 'unsupported'>(
    () => ('Notification' in window ? Notification.permission : 'unsupported')
  )
  const pushSupported =
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  const pushPreferences = useMemo(
    () => buildPushPreferences(location, alertRadius, alertToggles),
    [location, alertRadius, alertToggles],
  )
  const pushScopeLabel = useMemo(
    () => describePushScope(pushPreferences, location),
    [pushPreferences, location],
  )
  const localAppHost = isLocalAppHost()
  const pushConfigurationHelp = localAppHost
    ? 'Push notifications are unavailable in local dev until VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are set in live-weather/.dev.vars.'
    : 'Push notifications are not configured on the server.'

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
    let intervalId: number | null = null

    async function loadWeather(background = false) {
      if (!background) {
        setWeatherLoading(true)
        setWeather(null)
      }
      setResourceErrors((current) => ({ ...current, weather: null }))
      try {
        const weatherJson = await fetchJson<WorkerWeatherResponse>(`/api/weather?lat=${lat}&lon=${lon}`)
        if (cancelled) return
        setWeather(weatherJson)
      } catch (err) {
        if (cancelled) return
        if (!background) {
          setWeather(null)
        }
        setResourceErrors((current) => ({
          ...current,
          weather: resourceErrorMessage('Live weather', err),
        }))
      } finally {
        if (!cancelled && !background) setWeatherLoading(false)
      }
    }

    void loadWeather(false)
    intervalId = window.setInterval(() => {
      void loadWeather(true)
    }, DATA_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
    }
  }, [location?.lat, location?.lon])

  useEffect(() => {
    if (!location) return

    let cancelled = false
    let intervalId: number | null = null

    async function loadLocalAlerts(background = false) {
      if (!background) {
        setLocalAlertsLoading(true)
        setLocalAlertsData(null)
      }
      setResourceErrors((current) => ({ ...current, localAlerts: null }))
      try {
        const alertsJson = await fetchJson<WorkerAlertsResponse>(
          buildLocalAlertsApiPath(location, alertRadius),
        )
        if (cancelled) return
        setLocalAlertsData(alertsJson)
      } catch (err) {
        if (cancelled) return
        if (!background) {
          setLocalAlertsData(null)
        }
        setResourceErrors((current) => ({
          ...current,
          localAlerts: resourceErrorMessage('Local alerts', err),
        }))
      } finally {
        if (!cancelled && !background) setLocalAlertsLoading(false)
      }
    }

    void loadLocalAlerts(false)
    intervalId = window.setInterval(() => {
      void loadLocalAlerts(true)
    }, DATA_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
    }
  }, [
    alertRadius,
    location?.lat,
    location?.lon,
    location?.state,
    location?.countyCode,
    location?.zoneCode,
  ])

  async function useSearchLocation() {
    const input = locationInput.trim()
    if (!input) return
    setLocationLoading(true)
    setError(null)
    try {
      const isZip = /^\d{5}$/.test(input)
      const json = await fetchJson<SavedLocation>(
        isZip
          ? `/api/geocode?zip=${encodeURIComponent(input)}`
          : `/api/geocode?query=${encodeURIComponent(input)}`,
      )
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
          const json = await fetchJson<SavedLocation>(`/api/geocode?lat=${lat}&lon=${lon}`)
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
      ? buildAppUrl({ alertId })
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

  async function getExistingPushSubscription(): Promise<PushSubscription | null> {
    if (!pushSupported) return null
    const registration = await ensureServiceWorkerRegistration()
    return await registration.pushManager.getSubscription()
  }

  async function fetchPushPublicKey(): Promise<string> {
    const json = await fetchJson<PushPublicKeyResponse>('/api/push/public-key')
    if (!json?.publicKey) {
      setPushServerConfigured(false)
      throw new Error(json?.error || pushConfigurationHelp)
    }
    setPushServerConfigured(true)
    return json.publicKey
  }

  async function savePushSubscription(subscription: PushSubscription, prefs: PushPreferences) {
    const json = await fetchJson<PushMutationResponse>('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: serializePushSubscription(subscription),
        prefs,
      }),
    })

    if (!json?.ok) {
      throw new Error(json?.error || 'Could not save your push subscription.')
    }
  }

  async function showLocalTestNotificationFallback() {
    const registration = await ensureServiceWorkerRegistration()
    await registration.showNotification('Live Weather Alerts test notification', {
      body: 'The server accepted the test push, but this browser did not confirm receipt in time. This local fallback verifies notifications can still display here.',
      tag: `local-test-fallback-${Date.now()}`,
      requireInteraction: true,
      data: {
        targetUrl: `${window.location.origin}/?tab=more`,
      },
    })
  }

  async function requestServerTestPush(
    subscription: PushSubscription,
    prefs: PushPreferences,
  ): Promise<{ status: PushTestDeliveryStatus; usedFallback: boolean }> {
    const clientTestId = createPushTestId()
    const deliveryResult = waitForPushTestStatus(clientTestId)
    const json = await fetchJson<PushMutationResponse>('/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: serializePushSubscription(subscription),
        prefs,
        clientTestId,
      }),
    })

    if (!json?.ok) {
      throw new Error(json?.error || 'Could not send a test push notification.')
    }

    const status = await deliveryResult
    if (status.status === 'failed') {
      throw new Error(status.error || 'The browser could not display the test notification.')
    }

    if (status.status === 'timeout') {
      await showLocalTestNotificationFallback()
      return { status: 'timeout', usedFallback: true }
    }

    return { status: 'displayed', usedFallback: false }
  }

  async function resubscribePushSubscription(prefs: PushPreferences): Promise<PushSubscription> {
    const registration = await ensureServiceWorkerRegistration()
    const existing = await registration.pushManager.getSubscription()
    if (existing) {
      await fetchJson<PushMutationResponse>('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      }).catch(() => {})
      await existing.unsubscribe().catch(() => {})
    }

    const publicKey = await fetchPushPublicKey()
    const refreshed = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(publicKey),
    })
    await savePushSubscription(refreshed, prefs)
    setPushEnabled(true)
    return refreshed
  }

  async function ensurePushSubscription(): Promise<PushSubscription> {
    if (!pushSupported) {
      throw new Error('Push notifications are not supported on this device.')
    }
    if (!pushPreferences) {
      throw new Error('Set your location before enabling notifications.')
    }

    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    setPushPermission(permission)

    if (permission !== 'granted') {
      if (permission === 'denied') {
        throw new Error('Notifications are blocked. Enable them in your browser or device settings.')
      }
      throw new Error('Notification permission was not granted.')
    }

    const registration = await ensureServiceWorkerRegistration()
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      const publicKey = await fetchPushPublicKey()
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToArrayBuffer(publicKey),
      })
    }

    await savePushSubscription(subscription, pushPreferences)
    setPushEnabled(true)
    return subscription
  }

  async function enablePushNotifications(sendTest = false) {
    setPushBusy(true)
    setError(null)
    try {
      let subscription = await ensurePushSubscription()
      if (sendTest && pushPreferences) {
        let result: { status: PushTestDeliveryStatus; usedFallback: boolean }
        try {
          result = await requestServerTestPush(subscription, pushPreferences)
        } catch (err) {
          if (!isPushVapidMismatchError(err)) {
            throw err
          }
          subscription = await resubscribePushSubscription(pushPreferences)
          result = await requestServerTestPush(subscription, pushPreferences)
        }

        if (result.status === 'timeout' && result.usedFallback) {
          setError(
            'The server accepted the test push, but this browser did not confirm receipt in time. A local fallback notification was shown while the service worker refreshes.',
          )
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable notifications.')
    } finally {
      setPushBusy(false)
    }
  }

  async function disablePushNotifications() {
    if (!pushSupported) {
      setError('Push notifications are not supported on this device.')
      return
    }

    setPushBusy(true)
    setError(null)
    try {
      const subscription = await getExistingPushSubscription()
      if (subscription) {
        await fetchJson<PushMutationResponse>('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {})
        await subscription.unsubscribe().catch(() => {})
      }
      setPushEnabled(false)
      setPushPermission(Notification.permission)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable notifications.')
    } finally {
      setPushBusy(false)
    }
  }

  async function sendTestNotification() {
    await enablePushNotifications(true)
  }

  // Persist settings to localStorage
  useEffect(() => { window.localStorage.setItem('lwa_active_tab_v1', activeTab) }, [activeTab])
  useEffect(() => { window.localStorage.setItem('lwa_theme_v1', themeKey) }, [themeKey])
  useEffect(() => { window.localStorage.setItem('lwa_alert_radius_v1', String(alertRadius)) }, [alertRadius])
  useEffect(() => { window.localStorage.setItem('lwa_alert_toggles_v1', JSON.stringify(alertToggles)) }, [alertToggles])

  useEffect(() => {
    let cancelled = false

    async function loadPushStatus() {
      if (!pushSupported) {
        if (!cancelled) {
          setPushPermission('unsupported')
          setPushEnabled(false)
        }
        return
      }

      setPushPermission(Notification.permission)

      try {
        const subscription = await getExistingPushSubscription()
        if (!cancelled) {
          setPushEnabled(Boolean(subscription) && Notification.permission === 'granted')
        }
      } catch {
        if (!cancelled) {
          setPushEnabled(false)
        }
      }
    }

    void loadPushStatus()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadPushConfigurationStatus() {
      if (!pushSupported) {
        if (!cancelled) setPushServerConfigured(null)
        return
      }

      try {
        const json = await fetchJson<PushPublicKeyResponse>('/api/push/public-key')
        if (!cancelled) {
          setPushServerConfigured(Boolean(json?.publicKey))
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof FetchError && err.status === 503) {
          setPushServerConfigured(false)
          return
        }
        setPushServerConfigured(null)
      }
    }

    void loadPushConfigurationStatus()
    return () => {
      cancelled = true
    }
  }, [pushSupported])

  useEffect(() => {
    let cancelled = false

    async function syncPushPreferences() {
      if (!pushSupported || !pushEnabled || pushPermission !== 'granted' || !pushPreferences) {
        return
      }

      try {
        const subscription = await getExistingPushSubscription()
        if (!subscription) {
          if (!cancelled) setPushEnabled(false)
          return
        }
        await savePushSubscription(subscription, pushPreferences)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not sync your notification settings.')
        }
      }
    }

    void syncPushPreferences()
    return () => {
      cancelled = true
    }
  }, [pushEnabled, pushPermission, pushPreferences, pushSupported])

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
    fetchJson<SavedLocation>(`/api/geocode?lat=${lat}&lon=${lon}`)
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

  useEffect(() => {
    if (activeTab !== 'alerts') return

    let cancelled = false
    let intervalId: number | null = null

    async function loadAllAlerts(background = false) {
      if (!background) {
        setAllAlertsLoading(true)
      }
      setResourceErrors((current) => ({ ...current, allAlerts: null }))
      try {
        const alertsJson = await fetchJson<WorkerAlertsResponse>('/api/alerts')
        if (cancelled) return
        setAllAlertsData(alertsJson)
      } catch (err) {
        if (cancelled) return
        if (!background) {
          setAllAlertsData(null)
        }
        setResourceErrors((current) => ({
          ...current,
          allAlerts: resourceErrorMessage('Nationwide alerts', err),
        }))
      } finally {
        if (!cancelled && !background) setAllAlertsLoading(false)
      }
    }

    void loadAllAlerts(false)
    intervalId = window.setInterval(() => {
      void loadAllAlerts(true)
    }, DATA_POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      setAllAlertsLoading(false)
      if (intervalId !== null) {
        window.clearInterval(intervalId)
      }
    }
  }, [activeTab])

  const tc = THEMES[themeKey] ?? THEMES.blue
  const isWhiteTheme = themeKey === 'white'
  const isBlackTheme = themeKey === 'black'
  const rootText = isWhiteTheme ? 'text-black' : 'text-white'
  const radarHighlight = isWhiteTheme ? 'text-sky-500' : tc.t300
  const cardBase = `card rounded-2xl border p-5 ${tc.cardBg} ${isWhiteTheme ? 'border-slate-300 shadow-md' : 'border-white/10 shadow-2xl'}`

  const loading = (weatherLoading && !weather) || (localAlertsLoading && !localAlertsData)
  const current = weather?.current || {}
  const hourly = useMemo(() => (weather?.hourly || []).slice(0, 6), [weather?.hourly])
  const daily = useMemo(() => (weather?.daily || []).slice(0, 7), [weather?.daily])
  const radar = weather?.radar ?? null
  const radarImageUrl =
    typeof radar?.stillImageUrl === 'string' && radar.stillImageUrl.trim()
      ? radar.stillImageUrl
      : null
  const localAlerts = useMemo(() => {
    const raw = localAlertsData?.alerts ?? []
    return raw.filter(isDisplayableAlert)
  }, [localAlertsData?.alerts])
  const allAlerts = useMemo(() => {
    const raw = allAlertsData?.alerts ?? []
    return raw.filter(isDisplayableAlert)
  }, [allAlertsData?.alerts])
  const scopedAlerts = useMemo(() => {
    return alertsScope === 'local' ? localAlerts : allAlerts
  }, [alertsScope, localAlerts, allAlerts])

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
  const activeAlertHero = localAlerts[0] || null
  const weatherUnavailable = !weatherLoading && !weather
  const localAlertsUnavailable = !localAlertsLoading && !localAlertsData
  const allAlertsUnavailable = alertsScope === 'all' && !allAlertsLoading && !allAlertsData
  const alertsLoading = alertsScope === 'local' ? localAlertsLoading : allAlertsLoading
  const alertsUnavailable = alertsScope === 'local' ? localAlertsUnavailable : allAlertsUnavailable
  const alertsError =
    alertsScope === 'local' ? resourceErrors.localAlerts : resourceErrors.allAlerts
  const alertsMeta = alertsScope === 'local' ? localAlertsData?.meta : allAlertsData?.meta
  const alertsUpdatedAt =
    typeof alertsMeta?.generatedAt === 'string' && alertsMeta.generatedAt.trim()
      ? alertsMeta.generatedAt
      : weather?.updated || ''
  const alertsSummaryUnavailable = alertsUnavailable || (alertsLoading && scopedAlerts.length === 0)

  return (
    <div className={`min-h-screen ${rootText} ${isWhiteTheme ? 'theme-white' : isBlackTheme ? 'theme-black' : ''}`} style={{ backgroundColor: THEME_BG[themeKey] || '#091320' }}>
      {/* PWA install banner — slides down from top */}
      <div
        className={`fixed left-1/2 z-40 w-full max-w-md -translate-x-1/2 px-4 transition-all duration-300 ease-out ${
          showInstallBanner ? 'top-3 opacity-100' : '-top-24 opacity-0 pointer-events-none'
        }`}
      >
        <div
          className={`flex items-center gap-3 rounded-2xl p-3 ${isWhiteTheme ? 'border-slate-300 shadow-md' : 'border-white/10 shadow-xl'} backdrop-blur-md`}
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
                {localAlertsUnavailable ? (
                  <div className="px-4 pt-4">
                    <DataUnavailableCard
                      title="LOCAL ALERTS UNAVAILABLE"
                      message={resourceErrors.localAlerts || 'We could not load alerts for your area.'}
                      actionLabel="View Forecast"
                      onAction={() => setActiveTab('forecast')}
                    />
                  </div>
                ) : activeAlertHero ? (
                  <div className="px-4 pt-4">
                    <div className="rounded-2xl border border-red-500/30 bg-gradient-to-b from-red-700 to-red-900 p-5">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-white force-white">
                        {String(activeAlertHero.event || 'ACTIVE ALERT').toUpperCase()}
                      </div>
                      <div className="mb-1 text-3xl font-bold text-white force-white">{currentLocationLabel}</div>
                      <div className="mb-3 text-sm text-white force-white">
                        {(activeAlertHero.summary as string) ||
                          (activeAlertHero.headline as string) ||
                          'Weather alert in effect'}
                      </div>
                      <div className="mb-4 flex flex-wrap gap-2 text-xs">
                        <span className="rounded bg-red-500/20 px-2 py-1 text-white force-white">
                          {(activeAlertHero.severity as string) || 'Alert'}
                        </span>
                        {activeAlertHero.urgency ? (
                          <span className="rounded bg-red-500/20 px-2 py-1 text-white force-white">
                            {activeAlertHero.urgency as string}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-white force-white">
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
                            <div className="whitespace-pre-wrap leading-relaxed text-white/90 force-white">
                              {formatAlertDescription(activeAlertHero.description as string)}
                            </div>
                          ) : null}
                          {(activeAlertHero.instruction as string) ? (
                            <div className="mt-2 whitespace-pre-wrap leading-relaxed text-white/70 force-white">
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
                  {localAlerts.slice(1, 5).map((alert, idx) => {
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
                  {localAlerts.length > 5 && (
                    <button
                      onClick={() => setActiveTab('alerts')}
                      className={`w-full rounded-xl border border-white/10 ${tc.cardBg} py-3 text-sm font-medium ${tc.t400}`}
                    >
                      {localAlerts.length - 5} more alerts — tap to view all
                    </button>
                  )}

                  <div className={cardBase}>
                    {weatherUnavailable ? (
                      <DataUnavailableCard
                        title="CURRENT WEATHER UNAVAILABLE"
                        message={resourceErrors.weather || 'Current conditions could not be loaded.'}
                      />
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </div>
              </>
            )}

            {activeTab === 'forecast' && (
              <>
                {weatherUnavailable ? (
                  <div className="px-4 pt-4">
                    <DataUnavailableCard
                      title="FORECAST UNAVAILABLE"
                      message={resourceErrors.weather || 'Forecast data could not be loaded.'}
                    />
                  </div>
                ) : (
                  <>
                    <div className="px-4 pt-4">
                      <div className={cardBase}>
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className={`mb-2 text-xs tracking-wide ${tc.t300}`}>FORECAST</div>
                            <div className="text-4xl font-bold leading-none">
                              {formatTemp(getCurrentTemp(current))}
                            </div>
                            <div className="mt-2 text-lg font-medium">{getCurrentCondition(current)}</div>
                            <div className={`mt-1 text-sm ${tc.t300}`}>
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
                              <div className={`text-[11px] ${tc.t300}`}>{getHourlyTime(item)}</div>
                              <Icon className={`mx-auto my-3 h-5 w-5 ${tc.t300}`} />
                              <div className={`text-xl font-semibold ${tc.t400}`}>{formatTemp(getHourlyTemp(item))}</div>
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
                                  <div className={`mb-1 text-sm ${tc.t400}`}>
                                    {formatPercent(getDailyPrecip(day))} rain
                                  </div>
                                  <div className="text-base font-semibold">
                                    {formatTemp(getDailyHigh(day))}{' '}
                                    <span className={`font-normal ${tc.t300}`}>
                                      / {formatTemp(getDailyLow(day))}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              {expanded ? (
                                <div className={`mt-3 space-y-2 rounded-xl border ${tc.extraBorderMuted} ${tc.bgMuted} p-3 text-sm ${tc.t400}`}>
                                  {/* Daytime */}
                                  <div className={`text-[11px] font-semibold uppercase tracking-wide ${tc.t400}`}>Day</div>
                                  <div>{getDailySummary(day)}</div>
                                  {String(day?.detailedForecast || '') && String(day?.detailedForecast) !== getDailySummary(day) && (
                                    <div className={tc.t300}>{String(day?.detailedForecast)}</div>
                                  )}
                                  <div className={tc.t300}>Wind: {String(day?.windDirection || '')} {String(day?.windSpeed || '')}</div>
                                  <div className={tc.t300}>Rain: {formatPercent(getDailyPrecip(day))}</div>

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

                                  <div className="flex gap-4 border-t border-white/10 pt-2">
                                    <div className="flex items-center gap-1.5">
                                      <Sunrise className="h-4 w-4 text-yellow-400" />
                                      <span>{formatDateTime((day?.sunrise as string) || null) || 'N/A'}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <Sunset className="h-4 w-4 text-orange-400" />
                                      <span>{formatDateTime((day?.sunset as string) || null) || 'N/A'}</span>
                                    </div>
                                  </div>

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
              </>
            )}

            {activeTab === 'radar' && (
              <>
                <div className="flex flex-col px-4 pt-4" style={{ height: 'calc(100vh - 11rem)' }}>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className={`mb-1 text-xs tracking-wide ${radarHighlight}`}>LIVE RADAR</div>
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
                  {weatherUnavailable ? (
                    <DataUnavailableCard
                      title="RADAR UNAVAILABLE"
                      message={resourceErrors.weather || 'Radar data could not be loaded.'}
                    />
                  ) : (
                    <div className={`flex flex-1 flex-col overflow-hidden rounded-2xl border ${tc.borderMuted}`}>
                      <iframe
                        src="https://radar.weather.gov/"
                        className="h-full w-full border-0"
                        title={`NOAA radar for ${currentLocationLabel}`}
                        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                      />
                      <div className={`border-t border-white/10 ${tc.cardBg} px-4 py-3`}>
                        <div className="text-sm font-medium">
                          {String(radar?.summary || 'Live NOAA radar')}
                        </div>
                        <div className="mt-1 text-xs text-white/50">
                          Updated {formatDateTime(String(radar?.updated || weather?.updated || ''))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            {activeTab === 'alerts' && (
              <>
                <div className="px-4 pt-4">
                  <div className={`flex items-center justify-between rounded-2xl border ${tc.borderMuted} bg-white/5 px-5 py-4`}>
                    <div>
                      <div className={`text-xs font-semibold tracking-wide ${tc.t300}`}>ACTIVE ALERTS</div>
                      <div className="mt-0.5 text-2xl font-bold">
                        {alertsSummaryUnavailable ? '--' : scopedAlerts.length}
                      </div>
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
                    <div className="mt-1 text-2xl font-bold text-red-400">
                      {alertsSummaryUnavailable ? '--' : counts.warnings}
                    </div>
                  </div>
                  <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-4 text-center`}>
                    <div className="text-xs uppercase tracking-wide text-white/45">Advisories</div>
                    <div className="mt-1 text-2xl font-bold text-yellow-300">
                      {alertsSummaryUnavailable ? '--' : counts.advisories}
                    </div>
                  </div>
                  <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-4 text-center`}>
                    <div className="text-xs uppercase tracking-wide text-white/45">Updated</div>
                    <div className="mt-2 text-sm font-semibold">
                      {alertsSummaryUnavailable ? '--' : formatDateTime(alertsUpdatedAt)}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 px-4">
                  {alertsLoading && scopedAlerts.length === 0 ? (
                    <div className={`rounded-2xl border border-white/10 ${tc.cardBg} p-5 text-sm text-white/70`}>
                      <div className="flex items-center gap-3">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading {alertsScope === 'local' ? 'local' : 'nationwide'} alerts...
                      </div>
                    </div>
                  ) : alertsUnavailable ? (
                    <DataUnavailableCard
                      title={alertsScope === 'local' ? 'LOCAL ALERTS UNAVAILABLE' : 'NATIONWIDE ALERTS UNAVAILABLE'}
                      message={alertsError || 'Alert data could not be loaded right now.'}
                      actionLabel={alertsScope === 'local' ? 'View Forecast' : 'View My Area'}
                      onAction={() => {
                        if (alertsScope === 'local') {
                          setActiveTab('forecast')
                          return
                        }
                        setAlertsScope('local')
                        setShowAllAlerts(false)
                      }}
                    />
                  ) : filteredAlerts.length === 0 ? (
                    <div className={`rounded-2xl border border-emerald-400/25 bg-emerald-950/30 p-5 text-sm text-emerald-100`}>
                      {alertsScope === 'local'
                        ? `No active alerts are in effect for ${currentLocationLabel} right now.`
                        : 'No active nationwide alerts match this filter right now.'}
                    </div>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              </>
            )}

            {activeTab === 'more' && (
              <>
                <div className="px-4 pt-4">
                  <div className={cardBase}>
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
                        { key: 'teal',    dot: 'bg-teal-400',    label: 'Teal' },
                        { key: 'white',   dot: 'bg-white',       label: 'White' },
                        { key: 'black',   dot: 'bg-zinc-800',    label: 'Black' },
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
                  <div className="mb-2 text-xs text-white/45">
                    These categories sync to your live push subscription.
                  </div>
                  <div className="space-y-2">
                    {(
                      [
                        { key: 'warnings' as const, label: 'Warnings', desc: 'Highest-priority weather alerts' },
                        { key: 'watches' as const, label: 'Watches', desc: 'Potentially dangerous weather developing' },
                        { key: 'advisories' as const, label: 'Advisories', desc: 'Lower-severity but actionable alerts' },
                        { key: 'statements' as const, label: 'Statements', desc: 'Status updates and supporting alert messages' },
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
                  <div className={`rounded-xl border border-white/10 ${tc.cardBg} p-4`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">
                          {pushEnabled ? 'Push Alerts Enabled' : 'Push Alerts Disabled'}
                        </div>
                        <div className="mt-1 text-xs text-white/45">
                          {!pushSupported
                            ? 'This browser does not support push notifications.'
                            : pushServerConfigured === false
                              ? pushConfigurationHelp
                            : pushPermission === 'denied'
                              ? 'Notifications are blocked in browser settings.'
                              : pushEnabled
                                ? `Live alerts are active for ${pushScopeLabel}.`
                                : 'Enable push notifications to receive live weather alerts on this device.'}
                        </div>
                      </div>
                      <Bell className={`h-5 w-5 shrink-0 ${tc.t400}`} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        onClick={() => void sendTestNotification()}
                        disabled={pushBusy || !pushSupported || pushServerConfigured === false}
                        className={`rounded-lg ${tc.bg500} px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50`}
                      >
                        {pushBusy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : pushServerConfigured === false ? 'Push Setup Needed' : pushEnabled ? 'Send Test Push' : 'Enable Alerts'}
                      </button>
                      <button
                        onClick={() => void disablePushNotifications()}
                        disabled={pushBusy || !pushEnabled}
                        className={`rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white/80 disabled:opacity-50`}
                      >
                        Disable Alerts
                      </button>
                    </div>
                  </div>
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

                <div className="mt-4 px-4 pb-2">
                  <div className="text-center text-[11px] text-white/45">
                    Forecast and alerts from NWS/NOAA. Sun times from{' '}
                    <a
                      href="https://sunrise-sunset.org/api"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      Sunrise-Sunset.org
                    </a>
                    .
                  </div>
                </div>
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
              {pushServerConfigured === false
                ? pushConfigurationHelp
                : 'Receive instant alerts for severe weather in your area.'}
            </div>
            <button
              onClick={async () => {
                window.localStorage.setItem('lwa_notif_asked_v1', '1')
                setShowSetupModal(null)
                await enablePushNotifications(true)
              }}
              disabled={pushBusy || !pushSupported || pushServerConfigured === false}
              className={`w-full rounded-lg ${tc.bg500} py-3 text-sm font-semibold text-white disabled:opacity-50`}
            >
              {pushBusy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : pushServerConfigured === false ? 'Push Setup Needed' : 'Enable Notifications'}
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
  const alertIdParam = getAlertIdFromLocation()
  if (alertIdParam) return <AlertDetailPage alertId={alertIdParam} />
  return <AppInner />
}
