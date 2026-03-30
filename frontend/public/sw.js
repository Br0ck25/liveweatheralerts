// Minimal service worker — satisfies Chrome's PWA installability requirement.
// Push handler + pass-through fetch; no caching to keep alerts always fresh.

const CACHE_VERSION = 'lwa-v1'
const DEFAULT_NOTIFICATION_ICON = null
const PUSH_TEST_STATUS_MESSAGE_TYPE = 'lwa:push-test-status'

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
  if (text.endsWith('.png') || text.startsWith('data:image/png')) {
    return text
  }
  return DEFAULT_NOTIFICATION_ICON
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

async function broadcastPushTestStatus(payload) {
  const clientTestId = typeof payload?.clientTestId === 'string' ? payload.clientTestId.trim() : ''
  if (!clientTestId) return

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  await Promise.all(
    clients.map(async (client) => {
      try {
        client.postMessage({
          type: PUSH_TEST_STATUS_MESSAGE_TYPE,
          clientTestId,
          status: payload.status,
          ...(payload.error ? { error: payload.error } : {}),
        })
      } catch {
        // Ignore messaging failures for closed or inaccessible clients.
      }
    }),
  )
}

async function showWeatherNotification(title, options) {
  try {
    await self.registration.showNotification(title, options)
    return
  } catch {
    await self.registration.showNotification(title, {
      body: options.body,
      tag: options.tag,
      data: options.data,
      renotify: true,
      requireInteraction: true,
    })
  }
}

self.addEventListener('push', (event) => {
  const payload = safePayload(event)
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Live Weather Alerts'

  const icon = normalizeNotificationAsset(payload.icon)
  const badge = normalizeNotificationAsset(payload.badge)
  const options = {
    body:
      typeof payload.body === 'string' && payload.body.trim()
        ? payload.body.trim()
        : 'Tap to open Live Weather Alerts.',
    tag:
      typeof payload.tag === 'string' && payload.tag.trim()
        ? payload.tag.trim()
        : 'live-weather-alert',
    data: {
      ...payload,
      targetUrl: buildNotificationTarget(payload),
    },
    renotify: true,
    requireInteraction: true,
    ...(icon ? { icon } : {}),
    ...(badge ? { badge } : {}),
  }
  const clientTestId =
    typeof payload.clientTestId === 'string' && payload.clientTestId.trim()
      ? payload.clientTestId.trim()
      : ''

  event.waitUntil(
    showWeatherNotification(title, options)
      .then(() =>
        broadcastPushTestStatus({
          clientTestId,
          status: 'displayed',
        }),
      )
      .catch(async (error) => {
        await broadcastPushTestStatus({
          clientTestId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error || 'Notification display failed.'),
        })
        throw error
      }),
  )
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
