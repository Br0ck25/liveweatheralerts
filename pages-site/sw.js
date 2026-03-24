self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: 'Weather Alert',
      body: event.data ? event.data.text() : 'New weather alert available.',
    };
  }

  const title = String(payload.title || 'Weather Alert');
  const body = String(payload.body || 'New weather alert available.');
  const url = String(payload.url || '/');
  const icon = String(payload.icon || '/logo/Live Weather Alerts logo 192.png');
  const badge = String(payload.badge || '/logo/Live Weather Alerts logo 32.png');
  const tag = String(payload.tag || 'weather-alert');

  const options = {
    body,
    icon,
    badge,
    tag,
    renotify: true,
    data: {
      url,
      stateCode: payload.stateCode || null,
      alertId: payload.alertId || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification?.data?.url || '/';
  const targetUrl = new URL(target, self.location.origin).toString();

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        if ('navigate' in client) {
          try {
            await client.navigate(targetUrl);
          } catch {
            // no-op
          }
        }
        await client.focus();
        return;
      }
    }
    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
