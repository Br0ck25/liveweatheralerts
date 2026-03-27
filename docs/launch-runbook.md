# Live Weather Alerts Launch Runbook

Last updated: 2026-03-27

This runbook is for final release operations and manual QA. It assumes feature work is complete.

## 1) Required Config Before Deploy

### Worker config source of truth

- `live-weather/wrangler.jsonc`
- Required binding: `WEATHER_KV` KV namespace
- Required binding: `ASSETS` (Worker static asset fetch fallback)
- Required route: `liveweatheralerts.com/api/*`
- Required route: `www.liveweatheralerts.com/api/*`
- Required cron trigger: `*/2 * * * *`

### Required Worker secrets

- `DEBUG_SUMMARY_BEARER_TOKEN`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- Only `VAPID_*` names are read by the Worker for push config. Legacy `PUSH_VAPID_*` secrets are ignored.

Verify secret names:

```bash
cd live-weather
npx wrangler secret list --config wrangler.jsonc
```

Set any missing secret:

```bash
npx wrangler secret put DEBUG_SUMMARY_BEARER_TOKEN --config wrangler.jsonc
npx wrangler secret put VAPID_PUBLIC_KEY --config wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.jsonc
npx wrangler secret put VAPID_SUBJECT --config wrangler.jsonc
```

## 2) Pre-Deploy Checks

### Terminal-verifiable

1. Frontend build:

```bash
cd frontend
npm run build
```

2. Frontend tests:

```bash
cd frontend
npm test
```

3. Worker tests:

```bash
cd live-weather
npm test
```

4. Capture current deployment baselines for rollback:

```bash
cd live-weather
npx wrangler deployments status --config wrangler.jsonc
npx wrangler deployments list --config wrangler.jsonc
```

```bash
cd frontend
npx wrangler pages project list
npx wrangler pages deployment list --project-name liveweatheralerts
```

### Manual/production-only

1. Confirm Cloudflare cron is enabled for the deployed Worker in dashboard.
2. Confirm Worker routes are attached to both production domains.

## 3) Deploy Steps (Exact Order)

1. Deploy Worker first:

```bash
cd live-weather
npx wrangler deploy --config wrangler.jsonc
```

2. Verify Worker deployment succeeded:

```bash
cd live-weather
npx wrangler deployments status --config wrangler.jsonc
```

3. Build and deploy frontend:

```bash
cd frontend
npm run build
npx wrangler pages deploy dist --project-name liveweatheralerts
```

4. Verify frontend deployment record:

```bash
cd frontend
npx wrangler pages deployment list --project-name liveweatheralerts
```

## 4) Post-Deploy Smoke Tests (Run In Order)

1. Alerts API health:

```bash
curl -i "https://liveweatheralerts.com/api/alerts?state=KY"
```

Pass: `200` and JSON payload with `alerts`.

2. Push public key:

```bash
curl -i https://liveweatheralerts.com/api/push/public-key
```

Pass: `200` and JSON with `publicKey`.

3. Debug summary auth fail-closed:

```bash
curl -i https://liveweatheralerts.com/api/debug/summary
```

Pass: `401 Unauthorized` when token is configured.
Fail condition: `503` means `DEBUG_SUMMARY_BEARER_TOKEN` is missing.
Fail condition: `404` means the deployed Worker does not include the debug summary route yet (or routing is incorrect).

4. Debug summary with auth token:

```bash
curl -i -H "Authorization: Bearer ${DEBUG_SUMMARY_BEARER_TOKEN}" https://liveweatheralerts.com/api/debug/summary
```

PowerShell:

```powershell
curl.exe -i -H "Authorization: Bearer $env:DEBUG_SUMMARY_BEARER_TOKEN" https://liveweatheralerts.com/api/debug/summary
```

Pass: `200` with JSON fields including `lastSuccessfulSync`, `activeAlertCount`, `pushSubscriptionCount`, and `recentPushFailures`.

5. Cron effectiveness check:

Run step 4 twice at least 3 minutes apart.

Pass: `lastSuccessfulSync` advances between checks.

6. Notification icon and badge asset checks:

```bash
curl -sSI https://liveweatheralerts.com/notification-icon-192.png
curl -sSI https://liveweatheralerts.com/notification-badge-72.png
```

Pass: `200` with `Content-Type: image/png` for both.

7. PWA shell sanity:

- Open `https://liveweatheralerts.com`
- Verify app loads, route navigation works, and no fatal UI errors.

## 5) Manual QA Matrix

| Area | Platform | Steps | Pass Criteria | Verification Type |
| --- | --- | --- | --- | --- |
| Install flow | Android Chrome | Visit app, trigger install, launch from home screen | App launches standalone with expected routes | Manual/prod-only |
| Install flow | Desktop Chrome or Edge | Install from address bar/menu, relaunch | Standalone window opens and nav works | Manual/prod-only |
| PWA update flow | Desktop + Android installed PWA | Deploy a new build, reopen app, trigger update action | Update banner appears, tapping update reloads app shell | Manual/prod-only |
| Push subscribe + test | Android Chrome installed PWA | Enable notifications, run test notification from settings | Notification is received with expected title/body | Manual/prod-only |
| Push click routing | Android Chrome installed PWA | Tap push for single alert and grouped/state alert | Single alert opens `/alerts/:id`; grouped/state falls back to `/alerts?state=XX` | Manual/prod-only |
| Notification assets | Android Chrome | Inspect received notification icon and badge | Icon and badge render correctly, no broken image placeholders | Manual/prod-only |
| Offline/reconnect | Desktop + Android | Load app, go offline, reopen, then restore network | Cached-data messaging appears offline; reconnect status appears and data refreshes | Manual/prod-only |
| Route resilience | Desktop + Android installed PWA | Deep-link to `/alerts/:id` and `/history`, then offline/online transitions | Routes remain usable and recover after reconnect | Manual/prod-only |

## 6) Go/No-Go Signoff

Release is `GO` only when all are true:

1. Required secrets are present with correct names.
2. Worker and frontend deploys both succeed.
3. All smoke tests in Section 4 pass.
4. Manual QA matrix in Section 5 is completed and signed off.
5. No unresolved critical issues in push delivery, routing, or PWA update behavior.

Any failed smoke test or unresolved manual QA blocker is `NO-GO`.

## 7) Rollback Notes

### Worker rollback

1. Identify target prior version:

```bash
cd live-weather
npx wrangler deployments list --config wrangler.jsonc
```

2. Roll back to known-good version ID:

```bash
cd live-weather
npx wrangler rollback <version-id> --name live-weather -m "Rollback: <reason>" -y --config wrangler.jsonc
```

3. Re-run smoke tests 1-5 from Section 4.

### Frontend rollback

1. List recent Pages production deployments:

```bash
cd frontend
npx wrangler pages deployment list --project-name liveweatheralerts
```

2. Restore known-good frontend by redeploying the known-good commit/build output:

```bash
cd frontend
npm run build
npx wrangler pages deploy dist --project-name liveweatheralerts
```

3. Re-run smoke tests 6-7 and relevant manual QA steps.

Note: selecting/promoting a prior Pages deployment can also be done in Cloudflare dashboard if preferred by your release process.
