/// <reference lib="webworker" />

import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";
import {
  precacheAndRoute,
  cleanupOutdatedCaches,
  createHandlerBoundToURL
} from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
import { NetworkFirst, StaleWhileRevalidate, CacheFirst } from "workbox-strategies";

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{
    revision: string | null;
    url: string;
  }>;
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const appShellHandler = createHandlerBoundToURL("/index.html");
registerRoute(
  new NavigationRoute(appShellHandler, {
    allowlist: [
      /^\/$/,
      /^\/alerts(?:\/.*)?$/,
      /^\/history$/,
      /^\/forecast$/,
      /^\/settings$/
    ],
    denylist: [/^\/api\//]
  })
);

registerRoute(
  ({ url }) =>
    url.pathname.startsWith("/api/alerts") ||
    url.pathname.startsWith("/api/geocode") ||
    url.pathname.startsWith("/api/weather") ||
    url.pathname.startsWith("/api/radar"),
  new NetworkFirst({
    cacheName: "weather-api",
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200]
      }),
      new ExpirationPlugin({
        maxEntries: 40,
        maxAgeSeconds: 60 * 15
      })
    ]
  })
);

registerRoute(
  ({ request }) => request.destination === "image",
  new CacheFirst({
    cacheName: "weather-images",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200]
      }),
      new ExpirationPlugin({
        maxEntries: 80,
        maxAgeSeconds: 60 * 60 * 24 * 7
      })
    ]
  })
);

registerRoute(
  ({ request }) =>
    request.destination === "style" ||
    request.destination === "script" ||
    request.destination === "font",
  new StaleWhileRevalidate({
    cacheName: "app-assets",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200]
      })
    ]
  })
);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload: Record<string, unknown> = {};
  try {
    payload = event.data.json() as Record<string, unknown>;
  } catch {
    payload = {
      title: "Live Weather Alert",
      body: event.data.text()
    };
  }

  const title =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title
      : "Live Weather Alert";
  const body =
    typeof payload.body === "string" && payload.body.trim()
      ? payload.body
      : "Tap to view alert details.";
  const payloadAlertId =
    typeof payload.alertId === "string" && payload.alertId.trim()
      ? payload.alertId.trim()
      : "";
  const payloadDetailUrl =
    typeof payload.detailUrl === "string" && payload.detailUrl.trim()
      ? payload.detailUrl.trim()
      : "";
  const payloadStateCode =
    typeof payload.stateCode === "string" && payload.stateCode.trim()
      ? payload.stateCode.trim().toUpperCase()
      : "";
  const icon =
    typeof payload.icon === "string" && payload.icon.trim()
      ? payload.icon
      : "/notification-icon-192.png";
  const badge =
    typeof payload.badge === "string" && payload.badge.trim()
      ? payload.badge
      : "/notification-badge-72.png";
  const tag =
    typeof payload.tag === "string" && payload.tag.trim()
      ? payload.tag
      : payloadAlertId
        ? `alert-${payloadAlertId}`
        : payloadStateCode
          ? `state-${payloadStateCode}-latest`
          : "live-weather-alert";
  const detailUrl =
    payloadDetailUrl ||
    (payloadAlertId ? `/alerts/${encodeURIComponent(payloadAlertId)}` : "");
  const stateUrl = payloadStateCode
    ? `/alerts?state=${encodeURIComponent(payloadStateCode)}`
    : "/alerts";
  const fallbackUrl =
    typeof payload.fallbackUrl === "string" && payload.fallbackUrl.trim()
      ? payload.fallbackUrl
      : stateUrl;
  const url =
    typeof payload.url === "string" && payload.url.trim()
      ? payload.url
      : detailUrl || stateUrl;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: {
        url,
        fallbackUrl,
        alertId: payloadAlertId || undefined,
        stateCode: payloadStateCode || undefined
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = (event.notification.data as {
    url?: string;
    fallbackUrl?: string;
  }) || { url: "/alerts", fallbackUrl: "/alerts" };
  const targetUrl = String(notificationData.url || "/alerts").trim() || "/alerts";
  const fallbackUrl =
    String(notificationData.fallbackUrl || "/alerts").trim() || "/alerts";
  const target = new URL(targetUrl, self.location.origin);
  const fallbackTarget = new URL(fallbackUrl, self.location.origin);
  if (target.origin !== self.location.origin) {
    target.pathname = fallbackTarget.pathname;
    target.search = fallbackTarget.search;
    target.hash = fallbackTarget.hash;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const sameOriginClients = clients
        .map((client) => client as WindowClient)
        .filter((client) => {
          try {
            return new URL(client.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });

      const exactMatchClient = sameOriginClients.find((client) => {
        try {
          const clientUrl = new URL(client.url);
          return (
            clientUrl.pathname === target.pathname &&
            clientUrl.search === target.search
          );
        } catch {
          return false;
        }
      });
      if (exactMatchClient) {
        return exactMatchClient.focus();
      }

      const reusableClient = sameOriginClients[0];
      if (reusableClient) {
        return reusableClient.focus().then(() => reusableClient.navigate(target.href));
      }

      return self.clients.openWindow(target.href).then((opened) => {
        if (opened) return opened;
        return self.clients.openWindow(fallbackTarget.href);
      });
    })
  );
});
