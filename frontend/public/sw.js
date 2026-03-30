// Minimal service worker — satisfies Chrome's PWA installability requirement.
// Push handler + pass-through fetch; no caching to keep alerts always fresh.

const CACHE_VERSION = 'lwa-v1'
const DEFAULT_NOTIFICATION_ICON = '/icon-192.svg'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  // Remove old caches
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  // Always go to network — weather data must be live
  event.respondWith(fetch(event.request))
})

function safePayload(event) {
  if (!event.data) return {}

  try {
    const parsed = event.data.json()
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    const text = event.data.text()
    return text ? { body: text } : {}
  }
}

function normalizeNotificationAsset(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.startsWith('/notification-')) {
    return DEFAULT_NOTIFICATION_ICON
  }
  return text
}

function buildNotificationTarget(data) {
  const origin = self.location.origin
  const alertId = typeof data.alertId === 'string' ? data.alertId.trim() : ''
  if (alertId) {
    return `${origin}/?alert=${encodeURIComponent(alertId)}`
  }

  const candidate = data.url || data.detailUrl || data.fallbackUrl || '/'
  let url
  try {
    url = new URL(candidate, origin)
  } catch {
    return `${origin}/`
  }

  if (url.pathname === '/settings') {
    return `${origin}/?tab=more`
  }

  if (url.pathname.startsWith('/alerts/')) {
    const rawId = url.pathname.slice('/alerts/'.length)
    let alertId = rawId || ''
    try {
      alertId = decodeURIComponent(alertId)
    } catch {
      // Keep the raw path segment if decoding fails.
    }
    return `${origin}/?alert=${encodeURIComponent(alertId)}`
  }

  if (url.pathname === '/alerts') {
    return `${origin}/?tab=alerts`
  }

  return url.toString()
}

self.addEventListener('push', (event) => {
  const payload = safePayload(event)
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Live Weather Alerts'

  const options = {
    body:
      typeof payload.body === 'string' && payload.body.trim()
        ? payload.body.trim()
        : 'Tap to open Live Weather Alerts.',
    icon: normalizeNotificationAsset(payload.icon),
    badge: normalizeNotificationAsset(payload.badge),
    tag:
      typeof payload.tag === 'string' && payload.tag.trim()
        ? payload.tag.trim()
        : 'live-weather-alert',
    data: {
      ...payload,
      targetUrl: buildNotificationTarget(payload),
    },
    renotify: true,
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl =
    event.notification?.data?.targetUrl && typeof event.notification.data.targetUrl === 'string'
      ? event.notification.data.targetUrl
      : `${self.location.origin}/`

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (!client.url.startsWith(self.location.origin)) continue
        if ('navigate' in client) {
          await client.navigate(targetUrl)
        }
        await client.focus()
        return
      }

      await self.clients.openWindow(targetUrl)
    }),
  )
})
