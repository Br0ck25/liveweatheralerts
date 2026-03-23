# Live Weather Alerts Pages Frontend

This folder is a Cloudflare Pages project for `liveweatheralerts.com`.

## Files

- `index.html` - UI shell
- `styles.css` - page styling
- `app.js` - fetches alert JSON and renders cards
- `functions/api/alerts.js` - Pages Function proxy to the backend Worker
- `convective-outlook/` - kid-friendly SPC outlook page
- `faq/` - kid-friendly weather FAQ page
- `tornado-basics/` - evergreen tornado basics page
- `functions/api/convective-outlook.js` - pulls and simplifies SPC Day 1/2/3 outlook pages

## Required Pages Environment Variable

Set this in Cloudflare Pages project settings:

- `WEATHER_WORKER_ORIGIN` = your backend Worker origin
  - Example: `https://live-weather.jamesbrock25.workers.dev`

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
