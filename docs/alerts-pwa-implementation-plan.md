# Live Weather Alerts PWA Implementation Plan

Last updated: 2026-03-26

## Purpose

This document is the implementation plan for turning the current app into a complete alerts-first PWA. It is written so a human or another AI can build the system sprint by sprint without needing extra product clarification.

Use this document as the source of truth for:

- product scope
- architecture decisions
- API contracts
- sprint sequencing
- ticket-level implementation tasks
- acceptance criteria

Rule of execution:

1. Build one sprint at a time.
2. Keep existing behavior working while adding the next layer.
3. Keep builds and tests passing before moving to the next sprint.

## Product North Star

The app is not trying to become a generic weather app.

The product promise is:

1. Tell me if I am affected.
2. Interrupt me when something changes.
3. Show me what to do right now.
4. Tell me when the danger is over.

Forecast, radar, and settings exist to support alerts. They are not the primary product.

## Non-Goals

Do not prioritize these before the alert system is complete:

- generic weather news
- community or social features
- long-form weather editorial
- pollen, sunrise, moon phase, or seasonal widgets
- lifestyle dashboards unrelated to active alerts

## Current Repo Baseline

### Frontend

- Stack: Vite + React + TypeScript + `vite-plugin-pwa`
- Main UI currently lives mostly in `frontend/src/App.tsx`
- PWA registration lives in `frontend/src/main.tsx`
- PWA config lives in `frontend/vite.config.ts`
- Existing tabs: alerts, forecast, more
- Existing onboarding: save one default location in browser storage
- Existing alert features: filtering, sorting, county matching, forecast-to-alert linking
- Existing install handling: `beforeinstallprompt` in the UI

### Worker

- Stack: Cloudflare Worker + KV
- Main backend file: `live-weather/src/index.ts`
- Existing endpoints:
  - `GET /api/alerts`
  - `GET /api/geocode`
  - `GET /api/location`
  - `GET /api/weather`
  - `GET /api/radar`
  - `GET /api/push/public-key`
  - `POST /api/push/subscribe`
  - `POST /api/push/unsubscribe`
- Existing scheduled job:
  - syncs NWS alerts
  - compares snapshots
  - dispatches push notifications by state
- Existing push preference model:
  - one state per subscription
  - optional county delivery
  - alert type toggles
  - quiet hours

### Important Current Gaps

- The frontend does not expose a complete push subscription and preferences flow yet.
- `frontend/src/App.tsx` is too large for major feature expansion.
- The current PWA setup needs a custom service worker for `push` and `notificationclick`.
- The current worker push model is optimized for one state per subscription and will block multi-location support.
- The worker push payload references `/logo/...` icon and badge assets that do not appear to exist in the repo and must be added or corrected.

## Launch Definition

The launch candidate is complete when all of the following are true:

- users can save multiple places and choose a primary place
- users can subscribe to push notifications from the frontend
- users can control alert types, quiet hours, and scope
- new alerts can deep-link directly into alert detail pages
- alert detail pages explain risk, timing, affected areas, and actions
- radar is available inside the alert experience
- alert lifecycle is visible: new, updated, extended, expiring soon, expired, all clear
- the app can show what changed since the user’s last visit
- the PWA works offline with last-known data and clear stale messaging
- the system has basic tests and a manual QA checklist

## Architecture Decisions

### Frontend Decisions

1. Keep React, Vite, TypeScript, and `vite-plugin-pwa`.
2. Add `react-router-dom` for deep links and route-based navigation.
3. Convert the PWA from generated service worker behavior to `injectManifest` so custom push handlers can live in `frontend/src/sw.ts`.
4. Keep small preference data in `localStorage`.
5. Use Cache Storage and runtime caching for last-known alerts, weather, and radar.
6. Do not add a global state library unless it becomes necessary. Start with feature hooks and route-level state.
7. Break `frontend/src/App.tsx` into features before major feature work.

### Worker Decisions

1. Keep the Cloudflare Worker + KV architecture for this roadmap.
2. Do not add a database in the initial buildout.
3. Preserve current endpoints where possible and add new endpoints incrementally.
4. Add backward-compatible parsing for old push records and evolve them to a multi-scope preference model.
5. Keep NOAA/NWS as the source of truth for alert data.
6. Keep the route table in `live-weather/src/index.ts` if needed, but extract helpers as touched if it improves maintainability.

## Recommended Frontend Structure After Sprint 1

```text
frontend/
  src/
    app/
      AppShell.tsx
      router.tsx
    features/
      alerts/
        components/
        hooks/
        pages/
      forecast/
        components/
        hooks/
        pages/
      locations/
        components/
      notifications/
        components/
        hooks/
      settings/
        pages/
    lib/
      api/
      pwa/
      storage/
      analytics/
    sw.ts
    main.tsx
```

## Worker Structure Guidance

The code can remain in `live-weather/src/index.ts` at first, but these logical areas should exist over time:

- alerts
- push
- radar
- weather
- geocode
- history
- routing
- shared utilities

If another AI is implementing this incrementally, it should only split modules when it can keep tests passing. Direct edits in `index.ts` are acceptable until the system is stable.

## Core Data Model Changes

### Frontend Saved Place Model

Replace the single saved-location mindset with a place model:

```ts
type SavedPlace = {
  id: string;
  label: string;
  rawInput: string;
  stateCode: string;
  countyName?: string;
  countyCode?: string;
  lat?: number;
  lon?: number;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### Worker Push Preference Model

The current push model should evolve from one state per subscription to one subscription with multiple scopes.

Target shape:

```ts
type PushScope = {
  id: string;
  label: string;
  stateCode: string;
  deliveryScope: "state" | "county";
  countyName?: string | null;
  countyFips?: string | null;
  enabled: boolean;
  alertTypes: {
    warnings: boolean;
    watches: boolean;
    advisories: boolean;
    statements: boolean;
  };
  severeOnly: boolean;
};

type PushPreferences = {
  scopes: PushScope[];
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
  deliveryMode: "immediate" | "digest";
  pausedUntil?: string | null;
};

type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  subscription: WebPushSubscription;
  prefs: PushPreferences;
  indexedStateCodes: string[];
  createdAt: string;
  updatedAt: string;
  userAgent?: string;
};
```

### Worker Alert Change Model

Add a durable change log model for lifecycle UI and history:

```ts
type AlertChangeType =
  | "new"
  | "updated"
  | "extended"
  | "expired"
  | "all_clear";

type AlertChangeRecord = {
  alertId: string;
  stateCodes: string[];
  event: string;
  areaDesc: string;
  changedAt: string;
  changeType: AlertChangeType;
  previousExpires?: string | null;
  nextExpires?: string | null;
};
```

## Planned API Contracts

These are the target contracts to build toward. Existing endpoints can be extended in a backward-compatible way while the frontend migrates.

### `GET /api/alerts`

```json
{
  "alerts": [],
  "meta": {
    "lastPoll": "2026-03-26T18:00:00.000Z",
    "generatedAt": "2026-03-26T18:00:05.000Z",
    "syncError": null,
    "stale": false,
    "staleMinutes": 0,
    "count": 0
  }
}
```

Notes:

- Keep returning `alerts`.
- Add a `meta` object instead of scattering metadata at the root.
- Later add derived fields such as `category`, `lifecycleStatus`, and `detailUrl`.

### `GET /api/alerts/:id`

```json
{
  "alert": {},
  "meta": {
    "lastPoll": "2026-03-26T18:00:00.000Z",
    "generatedAt": "2026-03-26T18:00:05.000Z"
  }
}
```

If not found, return `404` with `{ "error": "Alert not found." }`.

### `POST /api/push/subscribe`

```json
{
  "subscription": {},
  "prefs": {
    "scopes": [],
    "quietHours": {
      "enabled": false,
      "start": "22:00",
      "end": "06:00"
    },
    "deliveryMode": "immediate",
    "pausedUntil": null
  }
}
```

Response:

```json
{
  "ok": true,
  "subscriptionId": "sha256-id",
  "prefs": {},
  "indexedStateCodes": ["OH", "KY"]
}
```

### `POST /api/push/unsubscribe`

```json
{
  "endpoint": "https://push.example/subscription-id"
}
```

Response:

```json
{
  "ok": true,
  "removed": true
}
```

### `POST /api/push/test`

Purpose:

- sends a test notification to the current subscription
- used by the notification settings screen for QA

Request:

```json
{
  "subscription": {},
  "prefs": {}
}
```

Response:

```json
{
  "ok": true
}
```

### `GET /api/radar?lat=...&lon=...`

Keep the existing endpoint, but make sure the frontend uses it inside alert detail pages and for primary saved place radar previews.

### `GET /api/alerts/changes`

Query params:

- `since`
- `state`
- `countyCode`

Response:

```json
{
  "changes": [],
  "generatedAt": "2026-03-26T18:00:05.000Z"
}
```

### `GET /api/alerts/history`

Query params:

- `state`
- `countyCode`
- `days`

Response:

```json
{
  "days": []
}
```

## Migration Notes

1. Preserve current `localStorage` keys until a migration is added.
2. Add a migration path from the current single-location storage object to `SavedPlace[]`.
3. Add a worker migration helper that can read the old single-state push record format and rewrite it into the new multi-scope record format on first update.
4. Preserve current query-string alert filtering behavior while adding route-based detail pages.
5. Keep current `/?state=XX` deep links working even after `/alerts/:id` routes are introduced.

## Sprint Plan

## Sprint 1: Foundation, Routing, and PWA Platform

### Goal

Create the architecture needed for everything else: route-based UI, extracted frontend modules, typed API clients, custom service worker support, and stable response envelopes.

### Ticket List

#### FE-101 Split `App.tsx` into feature modules

Files:

- `frontend/src/App.tsx`
- `frontend/src/app/AppShell.tsx`
- `frontend/src/features/alerts/components/AlertCard.tsx`
- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`
- `frontend/src/features/settings/pages/SettingsPage.tsx`
- `frontend/src/features/locations/components/LocationModal.tsx`

Tasks:

- Extract the existing alert card, forecast panel, settings panel, and location modal out of `App.tsx`.
- Keep behavior identical while moving logic into smaller files.
- Leave only high-level composition in `App.tsx` or replace it with `AppShell.tsx`.

Acceptance criteria:

- app behavior matches the current UI
- builds still pass
- `App.tsx` is no longer the only place where all features live

#### FE-102 Introduce route-based navigation

Files:

- `frontend/package.json`
- `frontend/src/main.tsx`
- `frontend/src/app/router.tsx`
- `frontend/src/app/AppShell.tsx`

Tasks:

- Add `react-router-dom`.
- Create routes for `/`, `/alerts`, `/alerts/:alertId`, `/forecast`, and `/settings`.
- Keep the bottom nav behavior but back it with routes instead of only local state.
- Preserve current saved active tab behavior by mapping it into default navigation rules.

Acceptance criteria:

- direct navigation to `/alerts` and `/forecast` works
- browser back and forward works
- bottom nav still works on mobile

#### FE-103 Create typed API client modules

Files:

- `frontend/src/types.ts`
- `frontend/src/lib/api/alerts.ts`
- `frontend/src/lib/api/weather.ts`
- `frontend/src/lib/api/radar.ts`
- `frontend/src/lib/api/geocode.ts`
- `frontend/src/lib/api/push.ts`

Tasks:

- Move fetch logic out of UI components.
- Add normalized response parsers and shared error handling.
- Ensure alerts, weather, radar, geocode, and push calls use a single pattern.

Acceptance criteria:

- no screen performs raw fetches inline if a typed API client exists for that endpoint
- response parsing errors are user-friendly

#### FE-104 Convert PWA setup to custom service worker

Files:

- `frontend/vite.config.ts`
- `frontend/src/main.tsx`
- `frontend/src/sw.ts`
- `frontend/src/lib/pwa/register.ts`

Tasks:

- Switch `vite-plugin-pwa` to `injectManifest`.
- Keep precaching and runtime caching.
- Add custom service worker listeners for `install`, `activate`, `push`, and `notificationclick`.
- Add runtime caching for `/api/alerts`, `/api/geocode`, `/api/weather`, and `/api/radar`.

Acceptance criteria:

- app still installs as a PWA
- service worker registers successfully
- push listeners exist even if the settings UI is not finished yet

#### FE-105 Add stale-data and offline banners

Files:

- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`
- `frontend/src/styles.css`

Tasks:

- Show when alert data is stale.
- Show when the app is offline and serving cached data.
- Use `meta.lastPoll`, `meta.stale`, and `navigator.onLine`.

Acceptance criteria:

- users can tell when data is current versus cached
- offline mode does not look like a silent failure

#### FE-106 Add frontend test scaffolding

Files:

- `frontend/package.json`
- `frontend/vitest.config.ts`
- `frontend/src/test/setup.ts`

Tasks:

- Add `vitest`, `@testing-library/react`, and `jsdom`.
- Add a basic render test for the route shell.
- Add one utility test for alert classification or storage migration logic.

Acceptance criteria:

- frontend tests run locally
- test scaffolding is ready for later sprints

#### BE-101 Normalize response envelopes

Files:

- `live-weather/src/index.ts`

Tasks:

- Update `/api/alerts`, `/api/weather`, and `/api/radar` responses to use a consistent envelope where useful.
- Add `generatedAt`.
- Add stale-data metadata for alerts.
- Keep compatibility with the current frontend until FE clients are migrated.

Acceptance criteria:

- endpoints still return valid JSON
- old UI does not break before the FE migration is complete

#### BE-102 Add `GET /api/alerts/:id`

Files:

- `live-weather/src/index.ts`

Tasks:

- Route `GET /api/alerts/:id`.
- Read from the existing active alert map in KV.
- Return the normalized alert object plus `meta`.

Acceptance criteria:

- a known alert id returns alert detail JSON
- unknown ids return `404`

#### BE-103 Add worker tests for alert detail and envelope behavior

Files:

- `live-weather/test/index.spec.ts`

Tasks:

- add test coverage for `GET /api/alerts/:id`
- add test coverage for normalized alert response envelopes

Acceptance criteria:

- `npm test` in `live-weather` still passes

### Sprint 1 Verification

- `frontend`: `npm run build`
- `frontend`: new test command passing
- `live-weather`: `npm test`
- manual: alert list, forecast, settings, install prompt, and location modal still work

## Sprint 2: Notification Center and Browser Push

### Goal

Ship real user-facing push notifications with adjustable settings, while redesigning worker subscription storage so it can support multi-location later.

### Ticket List

#### FE-201 Build notification center UI

Files:

- `frontend/src/features/notifications/components/NotificationCenter.tsx`
- `frontend/src/features/settings/pages/SettingsPage.tsx`
- `frontend/src/styles.css`

Tasks:

- Add sections for permission status, enable notifications, disable notifications, alert type toggles, quiet hours, delivery mode, scope selection, and test notification.
- Show clear unsupported-browser copy.

Acceptance criteria:

- users can understand current notification state without opening browser settings
- settings are visible from the settings page

#### FE-202 Implement browser subscription flow

Files:

- `frontend/src/lib/pwa/push.ts`
- `frontend/src/features/notifications/hooks/usePushNotifications.ts`
- `frontend/src/lib/api/push.ts`

Tasks:

- fetch the VAPID public key
- request `Notification` permission
- create a browser push subscription with `PushManager.subscribe`
- send subscription and prefs to `/api/push/subscribe`
- unsubscribe through `/api/push/unsubscribe`
- resubmit settings updates through `/api/push/subscribe`

Acceptance criteria:

- subscribe works end to end in supported browsers
- unsubscribe removes the server record
- updating prefs does not create duplicate broken state

#### FE-203 Implement service worker notification click behavior

Files:

- `frontend/src/sw.ts`

Tasks:

- on push, display notification using worker payload fields
- on click, focus an existing client if possible
- if no client is open, open the correct route
- prefer `/alerts/:alertId` if present in payload
- fall back to `/alerts?state=XX`

Acceptance criteria:

- clicking a notification opens the intended screen
- repeated notifications group correctly by `tag`

#### FE-204 Add notification asset validation

Files:

- `frontend/public/`
- `frontend/vite.config.ts`
- `live-weather/src/index.ts`

Tasks:

- create actual PNG icon and badge assets used for notifications
- either match the current `/logo/...` worker references or update the worker to use real asset paths
- ensure icons are suitable for Android notification display

Acceptance criteria:

- notifications show icons instead of broken asset references

#### BE-201 Redesign push preferences for multi-scope subscriptions

Files:

- `live-weather/src/index.ts`

Tasks:

- replace the current single-state push record shape with the multi-scope preference model from this plan
- keep backward-compatible reads for old records
- on write, store only the new record shape
- update state indexing to support one subscription mapped to many states

Acceptance criteria:

- one browser subscription can follow multiple state or county scopes
- old records do not break the system

#### BE-202 Add `POST /api/push/test`

Files:

- `live-weather/src/index.ts`

Tasks:

- accept a subscription and current prefs
- build a test payload
- dispatch one test notification
- return useful errors for missing VAPID config or invalid subscriptions

Acceptance criteria:

- the frontend can trigger a test push from the settings page

#### BE-203 Harden scope matching and quiet-hour logic

Files:

- `live-weather/src/index.ts`

Tasks:

- move county matching from plain-text only logic toward UGC or county FIPS matching whenever possible
- keep text fallback where codes are unavailable
- add `severeOnly` handling
- keep quiet-hours bypass for critical warnings

Acceptance criteria:

- county-scoped notifications are more reliable than simple string matching
- severe-only behavior works

#### BE-204 Add tests for subscribe, unsubscribe, migration, and test push

Files:

- `live-weather/test/index.spec.ts`

Tasks:

- cover old record migration
- cover new multi-scope writes
- cover test push route validation

Acceptance criteria:

- worker tests pass with the new model

### Sprint 2 Verification

- manual on Chrome Android
- manual on desktop Chrome
- manual unsupported-browser flow
- verify subscribe, update prefs, test push, and unsubscribe

## Sprint 3: Alert Detail Pages and Actionable Alert UX

### Goal

Turn alerts into destinations, not just list items.

### Ticket List

#### FE-301 Create alert detail route and page

Files:

- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`
- `frontend/src/app/router.tsx`
- `frontend/src/lib/api/alerts.ts`

Tasks:

- fetch alert detail by id
- support direct route visits and notification clicks
- include loading, error, and not-found states

Acceptance criteria:

- `/alerts/:alertId` is fully usable without first loading the list page

#### FE-302 Add alert detail content modules

Files:

- `frontend/src/features/alerts/components/`
- `frontend/src/styles.css`

Tasks:

- create sections for headline, severity and urgency, affected area, issued and expires times, countdown, plain-English summary, instructions, and the official NWS link

Acceptance criteria:

- the detail page is easier to understand than the raw NWS payload

#### FE-303 Add alert action tools

Files:

- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`
- `frontend/src/lib/analytics/events.ts`

Tasks:

- add share button
- add copy link button
- add copy safety steps button
- add open radar button placeholder if radar panel lands next sprint
- track action events

Acceptance criteria:

- a user can share and revisit a specific alert easily

#### FE-304 Add list-to-detail linking

Files:

- `frontend/src/features/alerts/components/AlertCard.tsx`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`

Tasks:

- make alert cards route to detail pages
- update forecast alert buttons to deep-link to detail pages instead of only scrolling the list

Acceptance criteria:

- any alert entry point can open the same canonical detail experience

#### BE-301 Add derived fields to alert payloads

Files:

- `live-weather/src/index.ts`

Tasks:

- add normalized fields such as `category`, `detailUrl`, `summary`, and `instructionsSummary`
- keep raw source fields too

Acceptance criteria:

- the frontend no longer has to derive every display field by itself

#### BE-302 Update push payloads to use canonical alert URLs

Files:

- `live-weather/src/index.ts`

Tasks:

- when a push notification is for a single alert, include `/alerts/:alertId`
- for grouped pushes, keep a filtered list fallback

Acceptance criteria:

- push clicks land on useful routes

#### BE-303 Add worker tests for detail payloads

Files:

- `live-weather/test/index.spec.ts`

### Sprint 3 Verification

- direct-load an alert detail route
- share a route and reload it
- click from alert list into detail and back
- click from a push into detail

## Sprint 4: Radar, Timelines, and Alert Lifecycle

### Goal

Make alerts feel live by showing radar context, countdowns, and what changed.

### Ticket List

#### FE-401 Add radar panel to alert detail

Files:

- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`
- `frontend/src/features/alerts/components/AlertRadarPanel.tsx`
- `frontend/src/lib/api/radar.ts`

Tasks:

- fetch radar for the alert’s best available coordinates
- prefer saved place coordinates when relevant
- show loop image, still image fallback, updated timestamp, and storm direction

Acceptance criteria:

- radar is visible inside alert detail
- broken radar responses degrade gracefully

#### FE-402 Add alert timeline and countdown UI

Files:

- `frontend/src/features/alerts/components/AlertTimeline.tsx`
- `frontend/src/features/alerts/components/AlertCountdown.tsx`

Tasks:

- show issued, effective, updated, and expires
- show expiring-soon state
- refresh countdowns on an interval without full refetch

Acceptance criteria:

- users can tell if the alert is new, active, or almost over

#### FE-403 Add lifecycle badges to list and detail

Files:

- `frontend/src/features/alerts/components/AlertLifecycleBadge.tsx`
- `frontend/src/features/alerts/components/AlertCard.tsx`
- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`

Tasks:

- support `new`, `updated`, `extended`, `expiring_soon`, `expired`, and `all_clear`
- display badges consistently

Acceptance criteria:

- users can identify changes without reading every timestamp

#### FE-404 Add "what changed since last visit" banner

Files:

- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/lib/storage/preferences.ts`
- `frontend/src/lib/api/alerts.ts`

Tasks:

- store a last-seen timestamp or snapshot reference
- call `/api/alerts/changes?since=...`
- summarize changes at the top of the alerts screen

Acceptance criteria:

- returning users see changes immediately

#### BE-401 Build alert snapshot diff engine

Files:

- `live-weather/src/index.ts`

Tasks:

- compare current active alerts to the previous snapshot
- detect `new`, `updated`, `extended`, `expired`, and `all_clear`
- write change records to KV

Acceptance criteria:

- the worker can explain how alerts changed over time

#### BE-402 Add `GET /api/alerts/changes`

Files:

- `live-weather/src/index.ts`

Tasks:

- filter changes by state and county when provided
- support `since`

Acceptance criteria:

- frontend can ask what changed since a specific time

#### BE-403 Add all-clear and lifecycle-aware push payloads

Files:

- `live-weather/src/index.ts`

Tasks:

- include `changeType` in push payloads
- optionally send all-clear or grouped digest pushes when major warnings expire
- avoid spam by grouping related changes

Acceptance criteria:

- push messaging reflects lifecycle state, not only new alerts

### Sprint 4 Verification

- verify lifecycle tags appear in UI
- verify changes endpoint returns expected records
- verify expiring alert copy updates as time passes

## Sprint 5: Multi-Location and Scope Management

### Goal

Expand from one default location to a proper place system for daily utility and retention.

### Ticket List

#### FE-501 Migrate saved location to place manager

Files:

- `frontend/src/lib/storage/location.ts`
- `frontend/src/lib/storage/places.ts`
- `frontend/src/features/locations/components/PlaceManager.tsx`
- `frontend/src/features/locations/components/LocationModal.tsx`

Tasks:

- create a migration from the existing single-location storage object to `SavedPlace[]`
- preserve the existing default location as the first primary place
- allow add, edit, remove, and set primary

Acceptance criteria:

- existing users keep their current saved place after migration
- new users can manage multiple places

#### FE-502 Add place switcher and place-aware data loading

Files:

- `frontend/src/app/AppShell.tsx`
- `frontend/src/features/alerts/hooks/useAlerts.ts`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`

Tasks:

- add quick switching between places
- load alerts, forecast, and radar for the active primary place
- keep filters place-aware

Acceptance criteria:

- changing places updates the app context quickly

#### FE-503 Add per-place notification scope editing

Files:

- `frontend/src/features/notifications/components/NotificationCenter.tsx`
- `frontend/src/features/locations/components/PlaceManager.tsx`

Tasks:

- let users opt each place into notifications
- map place settings to worker push scopes
- allow county-level follow when county data is known

Acceptance criteria:

- one subscription can follow multiple places

#### FE-504 Add named place presets

Files:

- `frontend/src/features/locations/components/PlaceManager.tsx`

Tasks:

- support common labels like Home, Work, Family, and Travel
- allow custom labels too

Acceptance criteria:

- the feature feels practical and understandable

#### BE-501 Finalize multi-scope indexing behavior

Files:

- `live-weather/src/index.ts`

Tasks:

- ensure subscription records index correctly under every relevant state
- remove stale state indexes when scopes are removed

Acceptance criteria:

- no orphaned state indexes remain after scope updates

#### BE-502 Improve county targeting fidelity

Files:

- `live-weather/src/index.ts`

Tasks:

- use county FIPS or UGC matching wherever possible for both UI filtering support and push delivery
- keep text fallback

Acceptance criteria:

- county delivery is consistent across places and pushes

### Sprint 5 Verification

- migrate an existing browser with one saved place
- add Home and Work
- switch primary place
- enable notifications for only one place and verify worker scopes update

## Sprint 6: Personal Impact and All-Clear UX

### Goal

Help users act on alerts, not just read them.

### Ticket List

#### FE-601 Add personal impact cards

Files:

- `frontend/src/features/alerts/components/ImpactCard.tsx`
- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`

Tasks:

- show concise impact cards such as commute risk, overnight risk, outdoor plan risk, school pickup timing, and power outage prep
- derive them from alert type, severity, expiration window, and forecast context

Acceptance criteria:

- every major alert type has at least one useful action-oriented impact card

#### FE-602 Add all-clear and expired alert experiences

Files:

- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/features/alerts/pages/AlertDetailPage.tsx`

Tasks:

- show when a previously prominent alert has expired
- surface an all-clear state rather than silently removing it
- link users into history when relevant

Acceptance criteria:

- the app gives closure after a severe event

#### FE-603 Add "since last visit" summary cards

Files:

- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/lib/api/alerts.ts`

Tasks:

- summarize counts of new, updated, and expired alerts since the last session

Acceptance criteria:

- returning users immediately understand what changed

#### BE-601 Add alert categorization helpers for impact cards

Files:

- `live-weather/src/index.ts`

Tasks:

- add normalized alert category tags where useful
- expose enough structured data for the frontend to map impact cards reliably

Acceptance criteria:

- frontend impact logic is not forced to parse raw event text for everything

#### BE-602 Add all-clear push and grouped digests

Files:

- `live-weather/src/index.ts`

Tasks:

- support grouped lifecycle digests when delivery mode is `digest`
- send all-clear notifications for major warning clearances if enabled

Acceptance criteria:

- users are not only notified when danger starts

### Sprint 6 Verification

- inspect impact cards for tornado, flood, winter, heat, and wind alerts
- verify all-clear copy appears in UI
- verify digest mode does not spam

## Sprint 7: Alert History and Review Mode

### Goal

Let users review what happened over the past day or week.

### Ticket List

#### FE-701 Create alert history page

Files:

- `frontend/src/features/alerts/pages/AlertHistoryPage.tsx`
- `frontend/src/app/router.tsx`
- `frontend/src/lib/api/alerts.ts`

Tasks:

- add `/history`
- group history by day and place
- allow filters by alert type and severity

Acceptance criteria:

- a user can review recent alert activity by place

#### FE-702 Add day-level history summaries

Files:

- `frontend/src/features/alerts/components/HistoryDayCard.tsx`

Tasks:

- show counts, top alert types, and notable warnings by day

Acceptance criteria:

- the history page is scan-friendly, not just a raw log dump

#### BE-701 Persist daily alert history snapshots

Files:

- `live-weather/src/index.ts`

Tasks:

- store compact daily history records in KV
- prune old records on a retention window

Acceptance criteria:

- history can be returned without replaying the entire alert feed from scratch

#### BE-702 Add `GET /api/alerts/history`

Files:

- `live-weather/src/index.ts`

Tasks:

- support `state`, `countyCode`, and `days`
- return compact day summaries plus relevant alert entries

Acceptance criteria:

- history page can load from a stable API

### Sprint 7 Verification

- verify 24-hour and 7-day history
- verify place filtering
- verify history still works when no active alerts exist

## Sprint 8: Launch Hardening, Accessibility, and Release Prep

### Goal

Ship a polished, trustworthy, installable alert utility.

### Ticket List

#### FE-801 Polish install and update UX

Files:

- `frontend/src/features/settings/pages/SettingsPage.tsx`
- `frontend/src/lib/pwa/register.ts`
- `frontend/src/styles.css`

Tasks:

- improve install education copy
- add update-available messaging when the service worker refreshes
- improve PWA onboarding after install

Acceptance criteria:

- install behavior feels intentional on mobile and desktop

#### FE-802 Finish accessibility pass

Files:

- all touched frontend files

Tasks:

- keyboard navigation
- focus management
- aria labels
- reduced motion support
- color contrast fixes

Acceptance criteria:

- core alerts and settings flows are screen-reader and keyboard friendly

#### FE-803 Harden offline and reconnect behavior

Files:

- `frontend/src/sw.ts`
- `frontend/src/features/alerts/pages/AlertsPage.tsx`
- `frontend/src/features/forecast/pages/ForecastPage.tsx`

Tasks:

- show reconnect state
- refresh data after reconnect
- make cached-data fallback explicit

Acceptance criteria:

- offline use is predictable

#### BE-801 Add operational logging and cleanup

Files:

- `live-weather/src/index.ts`

Tasks:

- log sync failures, stale data conditions, invalid subscriptions, and push delivery failures consistently
- clean up duplicated CORS handling

Acceptance criteria:

- operational issues are easier to diagnose

#### BE-802 Add admin or debug summary endpoint

Files:

- `live-weather/src/index.ts`

Tasks:

- add a lightweight endpoint or admin view showing last successful sync, current active alert count, push subscription count, and recent push failures

Acceptance criteria:

- basic operational visibility exists before launch

#### OPS-801 Final deployment and release checklist

Tasks:

- verify VAPID keys are configured
- verify Cloudflare cron schedule is active
- verify push icon and badge assets are deployed
- verify Pages and Worker routes are correct
- verify HTTPS and manifest paths
- verify deep links work in installed PWA mode

Acceptance criteria:

- the system can be deployed without guessing environment setup

### Sprint 8 Verification

- install on Android
- install on desktop Chrome
- verify update prompt
- verify push click from installed PWA
- verify accessibility checks

## Cross-Sprint Engineering Rules

Every sprint should follow these rules:

1. Keep existing behavior working unless the ticket explicitly replaces it.
2. Build the frontend and run worker tests before closing a sprint.
3. Add or update tests for critical parsing, storage migration, and routing logic.
4. Do not rewrite the full worker or frontend architecture in one sprint.
5. Preserve backward compatibility when changing storage or API contracts.
6. Prefer deterministic typed helpers over duplicating inline parsing logic in components.

## Manual QA Checklist

Run this across the roadmap:

- first visit without saved location
- save state-only location
- save city or ZIP with county data
- reload and confirm persistence
- offline reopen with cached alerts
- reconnect and refresh
- install the PWA
- update the PWA
- enable notifications
- disable notifications
- quiet hours behavior
- deep-link alert detail route
- push click into detail route
- all-clear message visibility
- multi-location switching

## Suggested AI Execution Workflow

If another AI is using this file to build the system, tell it to follow this workflow:

1. Read this plan first.
2. Only implement one sprint at a time.
3. Before editing, inspect the current files named in that sprint.
4. Keep changes minimal and additive where possible.
5. After implementation, run the project build and tests.
6. Report:
   - files changed
   - user-facing behavior added
   - technical risks
   - anything left incomplete

## Ready-to-Use Prompt for Another AI

```text
Read docs/alerts-pwa-implementation-plan.md and implement Sprint 1 only.

Constraints:
- keep the current app behavior working
- do not skip acceptance criteria
- prefer incremental refactors over large rewrites
- preserve backwards compatibility for storage and APIs
- run frontend build and worker tests before finishing

When done, report:
- files changed
- what was implemented
- what still needs follow-up inside Sprint 1
- any migration or QA notes
```

## Post-Launch Backlog

Only consider these after Sprint 8 is stable:

- richer analytics sink
- personalized alert digests by schedule
- travel mode
- watchlist widgets
- partner integrations
