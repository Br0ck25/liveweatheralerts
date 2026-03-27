# Live Weather Alerts Frontend

Alerts-only frontend for `liveweatheralerts.com`.

## Stack

- Vite
- React + TypeScript
- vite-plugin-pwa
- Cloudflare Pages deployment target

## PWA support

- Installable on supported mobile/desktop browsers
- Service worker with runtime caching for:
  - app assets
  - alert/geocode API responses
  - images
- Manifest includes standalone display mode and app icons

## Location onboarding

On first visit, users see a location modal and can enter:

- `City, State` (example: `Columbus, OH`)
- `State` (example: `Ohio` or `OH`)
- `ZIP code` (example: `43215`)

The app resolves and saves the chosen state in browser local storage and automatically applies that state filter on future visits. If county data is available from city/ZIP lookup, county-level filtering is also applied.

## Local development

1. Start the worker API in a separate terminal:

```bash
cd "C:\Users\James\Desktop\Live Weather Alerts\live-weather"
npm install
npm run dev
```

2. Start the frontend:

```bash
cd "C:\Users\James\Desktop\Live Weather Alerts\frontend"
npm install
npm run dev
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8787`, so the app uses your local worker automatically.

## Environment variable

Copy `.env.example` to `.env` only if you need a non-default API host:

```bash
VITE_ALERTS_API_BASE=https://api.liveweatheralerts.com
```

If empty, the frontend calls `/api/alerts` on the same origin.

## Build

```bash
npm run build
```

## Cloudflare deployment

1. Deploy the worker (`live-weather`) first.
2. Route worker API traffic to `/api/*` on your domain (recommended):
   - `liveweatheralerts.com/api/*` -> `live-weather` Worker
3. Deploy the frontend to Cloudflare Pages:

```bash
cd "C:\Users\James\Desktop\Live Weather Alerts\frontend"
npm run build
npx wrangler pages deploy dist --project-name liveweatheralerts
```

4. Attach custom domain `liveweatheralerts.com` to the Pages project.

This keeps frontend and alerts API on one domain while preserving clean `/api/alerts` calls.
