# Live Weather Alerts Pages Frontend

This folder is a Cloudflare Pages project for `liveweatheralerts.com`.

## Files

- `index.html` - UI shell
- `styles.css` - page styling
- `app.js` - fetches alert JSON and renders cards
- `functions/api/alerts.js` - Pages Function proxy to the backend Worker
- `functions/api/forecast.js` - ZIP-to-forecast endpoint (current, hourly, 7-day, radar)
- `weather-forecast/` - dedicated ZIP forecast page
- `information-hub/` - tabbed weather learning center and hazard library
- `convective-outlook/` - plain-language SPC outlook page
- `faq/` - plain-language weather FAQ page
- `weather-terms/` - mini-glossary for common weather terms
- `tornado-basics/` - evergreen tornado basics page
- `nighttime-warning-checklist/` - before-bed severe weather prep checklist
- `forecast-maps/` - plain-language national forecast maps guide with embedded live map images
- `alert-methods/` - plain-language warning delivery setup guide
- `functions/api/convective-outlook.js` - pulls and simplifies SPC Day 1/2/3 outlook pages
- `functions/api/push/public-key.js` - proxy for VAPID public key
- `functions/api/push/subscribe.js` - saves browser push subscription + selected state
- `functions/api/push/unsubscribe.js` - removes browser push subscription
- `sw.js` - service worker that receives push and shows notifications

`FAQ` and `Forecast Maps` are also accessible as tabs in the Information Hub.
Weather Terms are available at `/weather-terms/` and in the Information Hub glossary tab.
Weather Forecast is available at `/weather-forecast/` and supports ZIP memory on return visits.

## Required Pages Environment Variable

Set this in Cloudflare Pages project settings:

- `WEATHER_WORKER_ORIGIN` = your backend Worker origin
  - Example: `https://live-weather.jamesbrock25.workers.dev`

Backend Worker secrets for push notifications:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (example: `mailto:alerts@liveweatheralerts.com`)

Generate keys once (local machine):

1. `npx web-push generate-vapid-keys`
2. Copy values into Worker secrets with Wrangler:
   - `npx wrangler secret put VAPID_PUBLIC_KEY`
   - `npx wrangler secret put VAPID_PRIVATE_KEY`
   - `npx wrangler secret put VAPID_SUBJECT`

## Deploy (Cloudflare Pages)

1. Create a new Pages project.
2. Point the project root to this folder: `pages-site`.
3. Build command: none.
4. Build output directory: `/` (root of this folder).
5. Add custom domain: `liveweatheralerts.com` (and optionally `www.liveweatheralerts.com`).

## Notes

- The frontend calls `/api/alerts` on the same domain.
- The Pages Function forwards that request to your backend Worker.
- The convective outlook page calls `/api/convective-outlook`.
- The ZIP forecast tab calls `/api/forecast`.
- State-based push flow:
  - Frontend requests `/api/push/public-key`.
  - Browser subscribes with service worker `/sw.js`.
  - Frontend posts subscription + selected state to `/api/push/subscribe`.
  - Backend cron sends push only when a new alert ID appears for that state.
