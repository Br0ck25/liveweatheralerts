# Live Weather Alerts Release Checklist

Last updated: 2026-03-27

This checklist is release-ops only. Use [`docs/launch-runbook.md`](./launch-runbook.md) for exact deploy order, smoke tests, manual QA matrix, and rollback.

## 1) Required Worker Config + Secrets

- [ ] Deploy uses `live-weather/wrangler.jsonc` (not a repo-root Wrangler file).
- [ ] `WEATHER_KV` binding exists in `live-weather/wrangler.jsonc`.
- [ ] Worker cron trigger is configured as `*/2 * * * *` in `live-weather/wrangler.jsonc`.
- [ ] Secret exists: `DEBUG_SUMMARY_BEARER_TOKEN`.
- [ ] Secrets exist: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- [ ] Push config secrets use `VAPID_*` names (legacy `PUSH_VAPID_*` names are not used by runtime code).
- [ ] Worker route is active: `liveweatheralerts.com/api/*`
- [ ] Worker route is active: `www.liveweatheralerts.com/api/*`

Verify secret names:

```bash
cd live-weather
npx wrangler secret list --config wrangler.jsonc
```

Set missing secrets:

```bash
npx wrangler secret put DEBUG_SUMMARY_BEARER_TOKEN --config wrangler.jsonc
npx wrangler secret put VAPID_PUBLIC_KEY --config wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.jsonc
npx wrangler secret put VAPID_SUBJECT --config wrangler.jsonc
```

## 2) Pre-Deploy Build + Test Gates

- [ ] `npm run build` passes in `frontend`
- [ ] `npm test` passes in `frontend`
- [ ] `npm test` passes in `live-weather`

## 3) Post-Deploy Smoke Checks

- [ ] `GET /api/alerts` returns `200` JSON.
- [ ] `GET /api/push/public-key` returns `200` with a `publicKey`.
- [ ] `GET /api/debug/summary` without auth fails closed (`401` expected when configured; `503` means token missing; `404` means route/routing mismatch).
- [ ] `GET /api/debug/summary` with valid bearer token returns `200` and diagnostic JSON.
- [ ] `lastSuccessfulSync` updates during scheduled cron runs.
- [ ] `/notification-icon-192.png` returns `200` with `Content-Type: image/png`.
- [ ] `/notification-badge-72.png` returns `200` with `Content-Type: image/png`.

Exact debug-summary curl commands:

```bash
curl -i https://liveweatheralerts.com/api/debug/summary
curl -i -H "Authorization: Bearer ${DEBUG_SUMMARY_BEARER_TOKEN}" https://liveweatheralerts.com/api/debug/summary
```

PowerShell variant:

```powershell
curl.exe -i https://liveweatheralerts.com/api/debug/summary
curl.exe -i -H "Authorization: Bearer $env:DEBUG_SUMMARY_BEARER_TOKEN" https://liveweatheralerts.com/api/debug/summary
```

## 4) Manual QA + Signoff

- [ ] Service worker update flow verified (`update available` banner, update action, app reload).
- [ ] Install flow verified on Android Chrome (prompt and standalone launch).
- [ ] Install flow verified on desktop Chrome/Edge (prompt and standalone launch).
- [ ] Push notification click opens installed PWA to expected route (`/alerts/:id` preferred, fallback `/alerts?state=XX`).
- [ ] Offline and reconnect messaging verified.
- [ ] App routes work in installed mode: `/alerts`, `/alerts/:id`, `/history`, `/forecast`, `/settings`.
- [ ] Accessibility checks completed for keyboard, focus, skip link, modal close, reduced motion, and contrast.
- [ ] Manual QA matrix and go/no-go signoff completed using `docs/launch-runbook.md`.
