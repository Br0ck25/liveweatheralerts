# Live Weather Alerts — Facebook Newsroom Blueprint

## Summary
Live Weather Alerts is a Facebook Page that publishes real-time national weather coverage. The goal is to evolve the current Cloudflare Worker + KV system into a full automated newsroom pipeline: filtering incoming weather signals, deciding what matters, clustering related alerts into single coverage threads, generating clean Facebook-first content, and publishing with strong anti-spam controls.

Cloudflare Workers AI should be added as an editorial co-pilot using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, but final eligibility, clustering, threading, and publish decisions must remain deterministic. AI assists — it does not publish.

This is not a rewrite. The repo already contains much of the foundation:
- alert lifecycle ingestion and diffing
- Facebook ranking, threading, text generation, and auto-post rules
- admin workflow for review/posting
- forecast, discussion, and convective outlook surfaces

The next step is to connect those pieces into one newsroom pipeline.

---

## Current Baseline In Repo
The current codebase already has these building blocks:
- `src/alert-lifecycle.ts`, `src/nws.ts`, `src/public-api.ts`
  - alert ingestion, normalization, lifecycle snapshots, and public alert/weather APIs
- `src/facebook/config.ts`
  - auto-post mode config, metro allowlist, hazard helpers
- `src/facebook/threads.ts`
  - Facebook thread persistence and storm-cluster thread keys
- `src/facebook/ranking.ts`
  - ranking logic for admin editorial review
- `src/facebook/text.ts`
  - post text, comment text, and formatting logic
- `src/facebook/auto-post.ts`
  - auto-post eligibility, fallback behavior, scheduling-time post/comment orchestration
- `src/admin/page.ts`
  - admin page, review workflow, forecast/discussion/outlook tabs, and Facebook Post tab

Phase 1 is mostly about orchestration and data model hardening, not building from scratch.

The repo also already has generated Cloudflare Worker AI types available in `worker-configuration.d.ts`, including JSON mode support for `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The missing pieces are the Worker AI binding, `Env.AI`, a newsroom AI service layer, and an admin review flow for AI-generated drafts.

---

## Core Architecture
The newsroom pipeline should be:

1. **Ingest**
   - NWS alerts remain the primary live source
   - SPC outlooks and existing forecast city data remain scheduled/editorial sources
   - Radar signals and storm reports are planned Phase 3 sources, not phase-1 requirements

2. **Normalize**
   - Convert raw inputs into canonical internal signal records
   - Each signal should have hazard family, event type, severity, timing, geography, county/UGC footprint, metro matches, thresholds, and a short summary
   - All timestamps are stored in UTC internally; ET conversion is applied only at scheduling and display layers

3. **Classify**
   - Label each signal by:
     - hazard family: `tornado`, `severe`, `flood`, `winter`, `fire`, `marine`, `other`
     - event type: `warning`, `watch`, `advisory`, `statement`
     - impact flags: metro hit, county count, destructive wording, travel impact, population/audience relevance
     - metro priority tier: `top-50`, `other-metro`, or `rural-only`
     - newsroom region: `Northeast`, `Southeast`, `Midwest`, `Plains`, or `West`

4. **Rank**
   - Keep the existing priority/ranking engine for editorial sorting and fallback selection
   - Apply metro-priority weighting so top-50 metro impacts rank above otherwise similar rural-only events
   - Ranking remains separate from final publishing decisions

5. **Cluster**
   - Group signals into event clusters before publishing decisions are made
   - This is the core anti-spam layer

6. **Decide**
   - For each cluster, choose an action: `auto_post`, `comment`, `hold`, `combine`, or `skip`
   - Choose a publish format: `alert`, `roundup`, `live_event`, or `forecast`

7. **Generate content**
   - Build deterministic templates for immediate alert publishing
   - Build AI-assisted drafts for forecasts, roundups, outlooks, and discussions that require admin review before publishing

8. **Publish**
   - Post immediately or on schedule
   - Reuse existing threads when the cluster is already active
   - Apply rate control at the region level
   - Purge expired KV records on a rolling schedule

---

## Cloudflare Workers AI Layer
Workers AI should support the newsroom without becoming the source of truth.

- **Model:** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- **Worker integration:**
  - add an `AI` binding in `wrangler.jsonc`
  - extend `Env` in `src/types.ts` with `AI: Ai`
- **Primary roles:**
  - `decision_assist` — suggest action and format for high-priority clusters
  - `draft_generation` — generate post/comment copy for editorial review
  - `summary_generation` — produce short signal summaries for admin context
- **Decision authority:**
  - the deterministic rule engine keeps final authority
  - AI may suggest `post`, `comment`, `hold`, `combine`, or `skip`, but it may never override a deterministic `skip`
  - the `combine` action means: merge the suggested cluster's signals into a target cluster and mark the source cluster as `merged`; thread state from the source cluster is abandoned and the target cluster's active thread is used going forward
- **Execution model:**
  - inline AI calls for urgent decision-assist on high-priority live clusters
  - KV + cron job processing for draft generation, summaries, and lower-priority editorial tasks
- **Output contract:**
  - use `env.AI.run(...)` with message-based prompts
  - require structured JSON output using `response_format: { type: "json_schema" }`
  - reject malformed or hallucinated output during local validation against `sourceFacts`
- **Review gate:**
  - all AI-written text requires admin approval before publishing
  - urgent alert publishing remains deterministic in v1 so real-time coverage is never blocked by review
- **Cost controls:**
  - AI is only called when cluster importance meets or exceeds the configured `AI_CALL_THRESHOLD`
  - AI is always called when a content draft is explicitly required for forecast, roundup, live-event, or engagement workflows
  - low-priority clusters never trigger AI calls unless a draft is required

---

## Canonical Internal Models

### SignalRecord
A normalized weather/news signal. All timestamps are UTC ISO strings.

Fields:
- `signalId` — unique signal identifier
- `sourceType` — `nws_alert` | `spc_outlook` | `forecast` | `storm_report` | `radar`
- `alertId` — source-native identifier
- `hazardFamily` — `tornado` | `severe` | `flood` | `winter` | `fire` | `marine` | `other`
- `eventType` — `warning` | `watch` | `advisory` | `statement`
- `event` — raw NWS event string
- `severity` — `extreme` | `severe` | `moderate` | `minor` | `unknown`
- `issuedAt` — UTC ISO string
- `updatedAt` — UTC ISO string
- `expiresAt` — UTC ISO string
- `stateCodes`
- `countyCodes`
- `ugcCodes`
- `matchedMetroNames`
- `thresholdFlags`
- `impactFlags`
- `summary`

### EventClusterRecord
A persistent cluster representing one ongoing storm or event. All timestamps are UTC ISO strings.

Fields:
- `clusterKey` — stable unique key for the cluster lifetime
- `regionKey` — deterministic region-hazard key used for cooldown enforcement
- `newsroomRegion` — `Northeast` | `Southeast` | `Midwest` | `Plains` | `West`
- `hazardFamily`
- `primarySignalId`
- `memberSignalIds`
- `memberAlertIds`
- `matchedMetroNames`
- `clusterImportance` — numeric score (see scoring section)
- `senderOffice`
- `stateCodes`
- `countyCodes`
- `ugcCodes`
- `firstSeenAt` — UTC ISO string
- `lastSeenAt` — UTC ISO string
- `lastMeaningfulUpdateAt` — UTC ISO string
- `activePostId` — current Facebook post ID
- `status` — `active` | `decayed` | `expired` | `merged`
- `lastPublishedAt` — UTC ISO string
- `lastCommentAt` — UTC ISO string
- `expiresAt` — UTC ISO string (KV TTL anchor; default 24 hours after `lastSeenAt`)

### PublishingDecision
The final decision object passed to content/posting.

Fields:
- `action` — `auto_post` | `comment` | `hold` | `combine` | `skip`
- `reason` — human-readable explanation for admin display
- `clusterKey`
- `publishMode` — `immediate` | `scheduled`
- `postType` — `alert` | `roundup` | `live_event` | `forecast`
- `threadAction` — `new_anchor` | `comment` | `rollover_anchor`
- `autoPostGatePassed` — boolean
- `escalationReason` — string | null
- `cooldownBypassed` — boolean
- `primarySignalId`

### NewsroomAiJobRecord
A queued or inline AI task created by the newsroom system.

Fields:
- `jobId`
- `jobType` — `decision_assist` | `draft_generation` | `summary_generation`
- `status` — `pending` | `running` | `complete` | `failed`
- `sourceClusterKey`
- `sourceSignalIds`
- `deterministicDecision` — the deterministic `PublishingDecision` at job creation time
- `model` — model identifier string
- `promptVersion`
- `requestedAt` — UTC ISO string
- `completedAt` — UTC ISO string | null
- `reviewStatus` — `pending_review` | `approved` | `rejected` | `edited` | `regenerated`
- `rejectedBy` — admin user string | null
- `rejectionReason` — string | null
- `validationErrors`

### NewsroomAiSuggestion
An AI suggestion attached to a cluster or pending post.

Fields:
- `suggestedAction` — `post` | `comment` | `hold` | `combine` | `skip`
- `primarySignalId`
- `combineWithClusterKey` — target cluster key when action is `combine`; null otherwise
- `confidence` — `high` | `medium` | `low`
- `rationale`
- `riskFlags`

### NewsroomAiDraft
A validated AI-generated draft ready for admin review.

Fields:
- `draftType` — `alert` | `forecast` | `roundup` | `outlook` | `discussion` | `engagement`
- `title`
- `body`
- `hashtags`
- `commentBody` — optional comment text when draft is for a thread update
- `sourceFacts` — structured object of verifiable facts used in generation
- `approvedBy` — admin user string | null
- `approvedAt` — UTC ISO string | null
- `rejectedBy` — admin user string | null
- `rejectionReason` — string | null

### StormReportRecord
A deduped storm report attached to one or more active clusters.

Fields:
- `reportId`
- `source` — `nws_lsr` | `spc`
- `sourceNativeId`
- `canonicalSource` — always `nws_lsr` when both sources overlap
- `reportType`
- `eventTime` — UTC ISO string
- `lat`
- `lon`
- `stateCode`
- `countyCode`
- `metroNames`
- `headline`
- `detailText`
- `magnitude`
- `significance` — `high` | `medium` | `low`
- `matchedClusterKey`
- `matchedAlertIds`

### RadarSignalRecord
A radar-derived support signal for a live weather cluster.

Fields:
- `signalId`
- `clusterKey`
- `hazardFamily`
- `frameTimes`
- `intensityBucket`
- `persistenceScore`
- `movementConfidence`
- `boostRecommendation` — `boost` | `suppress` | `neutral`
- `summary`
- `createdAt` — UTC ISO string

### OutbreakModeState
The current national severe weather compression state.

Fields:
- `active`
- `enteredAt` — UTC ISO string | null
- `exitedAt` — UTC ISO string | null
- `triggerReason`
- `affectedRegions`
- `dominantClusterKeys`
- `forcedState` — `on` | `off` | null (null means automatic)

### EngagementDraftRecord
A scheduled engagement draft created for quiet-day posting windows.

Fields:
- `draftId`
- `scheduledWindow` — ET display string (stored UTC internally)
- `sourceType`
- `sourceFacts`
- `draftBody`
- `hashtags`
- `status` — `pending_review` | `approved` | `rejected` | `published`
- `approvedBy` — admin user string | null
- `approvedAt` — UTC ISO string | null

### LiveEventRecord
A focused major-event coverage record that coordinates newsroom output across one or more clusters.

Fields:
- `eventId`
- `slug`
- `title`
- `status` — `detected` | `active` | `closing` | `closed`
- `startedAt` — UTC ISO string
- `endedAt` — UTC ISO string | null
- `triggerSource` — `auto_detected` | `admin`
- `createdBy` — admin user string
- `lastModifiedBy` — admin user string | null
- `primaryHazardFamily`
- `coveredRegions`
- `linkedClusterKeys`
- `currentSummary`
- `featuredMediaId`
- `operatorNotes`

### LiveEventMediaRecord
An approved media asset linked to a live event.

Fields:
- `mediaId`
- `eventId`
- `platform` — `facebook` | `youtube`
- `mediaType` — `video` | `livestream` | `post`
- `url`
- `title`
- `thumbnailUrl`
- `addedBy` — admin user string
- `approvedAt` — UTC ISO string
- `sortOrder`

### CrowdReportRecord
A moderated public submission tied to a cluster or live event.

Fields:
- `reportId`
- `submittedAt` — UTC ISO string
- `status` — `pending` | `approved_internal` | `approved_public` | `approved_media` | `rejected`
- `reporterName`
- `contact`
- `text`
- `photoAssetRefs`
- `lat`
- `lon`
- `locationLabel`
- `matchedClusterKey`
- `matchedEventId`
- `moderationNotes`
- `approvedBy` — admin user string | null
- `rejectedBy` — admin user string | null
- `rejectionReason` — string | null
- `submissionIp` — stored for abuse detection; never displayed publicly

---

## Cluster Importance Scoring

Cluster importance is a numeric score used by the auto-post gate, ranking, fallback behavior, and AI-call thresholds. All weights are additive. `src/facebook/config.ts` should expose these as named constants, or they should live in an equivalent dedicated newsroom-config module if that file is later split out.

### Base Hazard Family Score
| Family | Base Score |
|---|---|
| tornado | 100 |
| severe | 60 |
| flood | 55 |
| fire | 50 |
| winter | 40 |
| marine | 30 |
| other | 10 |

### Event Type Modifier
| Event Type | Modifier |
|---|---|
| warning | +20 |
| watch | +10 |
| advisory | +5 |
| statement | 0 |

### Metro Priority Modifier
| Metro Tier | Modifier |
|---|---|
| top-50 metro | +30 |
| other metro | +15 |
| rural-only | 0 |

### Impact and Threshold Modifiers
- destructive threshold met: +20
- county reach >= 10 counties: +10
- county reach >= 5 counties: +5
- storm-report support (high significance): +15
- storm-report support (medium significance): +5
- radar boost recommendation: +10
- radar suppress recommendation: −15

### Recency Modifier
- signal issued within the last 15 minutes: +10
- signal issued within the last 30 minutes: +5
- signal issued more than 60 minutes ago: −10

### Configured Thresholds (defaults, all tunable in `src/facebook/config.ts` or equivalent)
- `AUTO_POST_THRESHOLD`: 80
- `AI_CALL_THRESHOLD`: 70
- `FALLBACK_CONSIDER_THRESHOLD`: 50

Metro priority modifiers never bypass family-specific safety thresholds such as destructive severe criteria or fire escalation requirements.

---

## KV Storage and TTL Policy

Cloudflare KV has no automatic garbage collection beyond TTL. Every key written by the newsroom system must have an explicit TTL or a scheduled cleanup job.

### Key Namespaces and TTLs
| Namespace | TTL |
|---|---|
| `cluster:*` | 24 hours after `lastSeenAt` |
| `thread:*` | 48 hours after last write |
| `signal:*` | 6 hours after `expiresAt` |
| `ai_job:*` | 7 days |
| `ai_draft:*` | 7 days |
| `outbreak:state` | no TTL; overwritten on each cron cycle |
| `engagement_draft:*` | 72 hours |
| `storm_report:*` | 48 hours after `eventTime` |
| `live_event:*` | 30 days after `endedAt` |
| `crowd_report:*` | 30 days |

A dedicated cleanup cron job should run every 30 minutes to purge keys that have exceeded their TTL but were not expired by KV automatically (e.g., keys written without a TTL during migration). During any cron cycle, the Worker should also prune signal index entries that reference expired clusters.

---

## Phase 1 — Core Newsroom Engine
Phase 1 makes live alert coverage behave like a real newsroom.

### 1. Decision Engine Above Per-Alert Rules
Move from per-alert publishing to cluster-first publishing.

The final decision flow:
1. normalize signal (UTC timestamps throughout)
2. cluster signal against active clusters
3. evaluate cluster importance score
4. choose primary signal within the cluster
5. run the hard auto-post gate
6. decide: `auto_post` → `new_anchor` or `comment`, `hold`, `combine`, or `skip`

### 2. Hard Auto-Post Gate
Every automatic publish action must pass a clear yes/no gate before it becomes a post or comment.

Auto-post must pass all of these checks in order:
1. signal is active and not stale
2. hazard qualifies by family rules
3. cluster importance score meets or exceeds `AUTO_POST_THRESHOLD`
4. not a duplicate cluster that should reuse an existing thread
5. not suppressed by outbreak mode or a higher-priority active cluster

If any gate fails, the decision falls back to `comment`, `hold`, `combine`, or `skip`. The reason must be recorded on the `PublishingDecision` for admin visibility.

### 3. Cluster Importance Score
See the **Cluster Importance Scoring** section for the full spec. Thresholds are config-driven constants. Weights should be additive and tunable without code changes.

### 4. Storm Cluster Engine
This is the most important missing layer.

Clustering rules:
- same hazard family
- overlapping counties/UGCs or same allowlisted metro
- same sender office when metro overlap is absent
- within a 60-minute rolling window
- storm motion may be used as a tiebreaker when available, but is not required

Cluster output:
- one cluster per active same-storm event
- one primary signal within the cluster (highest importance score)
- all sibling signals treated as updates unless they justify a split

**Gap/ambiguity rule — signals arriving in the 61–74 minute window:** If a signal arrives after the 60-minute cluster window has closed but before the 75-minute thread decay threshold, it should be treated as a new cluster. It may comment on an existing thread only if the thread has not yet decayed. It does not reopen the prior cluster.

### 5. Region Definition Layer
Every cluster must map to exactly one newsroom region: `Northeast`, `Southeast`, `Midwest`, `Plains`, or `West`.

Region assignment priority:
1. if the cluster matches one or more metros, use the highest-priority metro's region
2. otherwise use the dominant state/county footprint
3. if the cluster spans multiple regions without a metro match, use the region with the largest county share
4. if county share is exactly tied across regions (50/50 split), prefer the region of the `senderOffice`

Regions are used for: cooldown enforcement, outbreak mode, roundup grouping, and quiet-day logic.

### 6. Non-Negotiable Coverage Rule
`1 storm = 1 post`

- the first qualifying alert in a cluster creates the anchor post
- later alerts in the same cluster become comments
- severe watches in the same cluster do not get standalone posts by default
- delay-by-expiration is not the anti-spam strategy — clustering is

### 7. When A New Anchor Post Is Allowed
A new anchor post is only created when:
- the hazard family changes
- the cluster moves into a new metro or major region not already covered
- a qualifying escalation trigger fires (see Section 11)
- the prior thread has decayed after `75 minutes` of inactivity
- the previous cluster is stale beyond the 60-minute cluster window and no active thread exists
- the chain limit forces a rollover anchor post

### 8. Auto-Post Rules by Family
Family-specific rules are evaluated at the cluster level.

**Tornado-family:**
- all active, timely Tornado Warnings qualify for auto-post
- same-storm tornado updates thread into the same post when clustered

**Severe-family:**
- use current destructive/threshold logic
- if multiple severe warnings or watches belong to the same cluster, choose one primary anchor post and convert the rest to comments

**Flood-family:**
- Flash Flood Emergencies always auto-post (bypass importance threshold)
- other flood warnings must pass the base impact gate

**Fire-family:**
- no auto-post from metro match or county count alone
- requires wildfire escalation or public-safety emergency designation

**Winter-family:**
- must pass the base impact gate
- eligible for threshold tightening in a future config update if the family proves noisy

**Marine-family:**
- must pass the base impact gate
- treated as lower priority than land-based hazards of equal severity

### 9. Metro Priority Weight
Metro matching materially affects coverage priority, not just eligibility.

- **Top-50 metro hit:** major priority boost (+30); may satisfy the geographic side of the base impact gate; may bypass county-count requirements for non-rural qualifying events
- **Other metro hit:** moderate boost (+15)
- **Rural-only:** stricter filtering; fewer fallback promotions

Metro priority never bypasses family-specific safety thresholds (destructive severe criteria, fire escalation requirements, etc.).

### 10. Post Format Decider
Every publishing decision resolves to exactly one post format:

- `alert` — a single event or cluster driving urgent coverage
- `roundup` — multiple regions or clusters without one dominant event
- `live_event` — a major ongoing event covered through the live-event workspace
- `forecast` — scheduled forecast-led editorial content

Engagement drafts are a scheduled editorial subtype outside the core format decider.

### 11. Escalation Trigger
Escalation is defined explicitly so the system knows when a same-storm update deserves a fresh anchor post.

Escalation creates a new anchor post when any of the following occur:
- tornado confirmed or observed
- meaningful damage reports confirmed
- hail `>= 2.0"` (consistent with storm-report significance threshold)
- wind `>= 75 mph` (unified threshold — see note below)
- the storm enters a major metro not already part of the active cluster's covered metros

> **Note on wind thresholds:** The escalation trigger and storm-report auto-comment threshold both use `>= 75 mph`. This replaces the earlier inconsistency between 80 mph (escalation) and 70 mph (storm reports). The 75 mph value is the chosen unified standard. If either threshold needs to change in the future, both should be updated together as a single config value: `WIND_SIGNIFICANCE_MPH`.

Escalation may override a same-cluster comment path, but still respects duplicate suppression and outbreak-mode compression when the event is already fully covered.

### 12. Rate Control
Anchor-post cooldown per region:
- maximum 1 new anchor post per region every `10 minutes`
- comments are always exempt from cooldown
- qualifying escalation events may bypass cooldown
- during outbreak mode, cooldown reduces to `5 minutes` for distinct dominant clusters in different regions (same-cluster anchors are still suppressed)

### 13. Thread Decay, Chain Limit, and Cluster Window Boundaries

**Meaningful update** — a change that affects coverage value:
- hazard, severity, or confirmation status changes
- expiration or timing extensions
- county, UGC, metro, or region footprint changes
- destructive threshold changes
- new storm-report or radar-supported escalation

Plain wording refreshes without a hazard, timing, geography, or impact change do not count as meaningful.

**Cluster window:** 60 minutes — governs whether a new signal joins an existing cluster.

**Thread decay:** 75 minutes of no meaningful update — the cluster/thread is considered decayed. The next meaningful signal in that area creates a new cluster and anchor post.

**Chain limit:** maximum `3` update comments per anchor post. The next meaningful update rolls to a new anchor with continuation handling (e.g., "Continued coverage of…").

**Gap window behavior (61–74 minutes):** A signal arriving after the cluster window closes but before thread decay does not reopen the old cluster. It starts a new cluster. It may comment on the old thread only if that thread has not decayed. This must be explicitly handled in the clustering logic.

### 14. Thread State and Migration
Persist cluster-aware thread state in KV:
- cluster record key
- alert-id alias to cluster
- region/hazard alias to cluster
- continue honoring existing `thread:*` keys for compatibility during migration

Manual admin posts must continue to seed thread state so automation can comment later.

### 15. Admin Newsroom Controls
Extend admin into a newsroom control panel.

Visibility:
- active clusters and their importance scores
- primary signal vs sibling updates
- why an alert is `post`, `comment`, `hold`, `combine`, or `skip` (reason from `PublishingDecision`)
- cooldown status per region
- current Facebook thread/post ID per cluster

Override controls:
- force new post
- force comment
- suppress cluster
- split cluster
- merge cluster (triggers `combine` action; target cluster must be specified)

### 16. Workers AI Integration
Phase 1 adds minimum AI plumbing for editorial assistance without changing publish safety.

- Add the Workers AI binding and `Env.AI`
- Create a dedicated newsroom AI service layer for `decision_assist`, `draft_generation`, and `summary_generation`
- Only call AI when:
  - cluster importance meets or exceeds `AI_CALL_THRESHOLD`
  - or a content draft is required for forecast, roundup, live-event, or engagement workflows
- Validate every AI response against a local JSON schema before storing
- Store both the deterministic decision and AI suggestion on the same job record
- Keep alert auto-posting deterministic in v1; AI-generated alert copy goes into admin review unless explicitly published through the manual workflow
- Persist prompt version, model ID, source facts, validation results, and final publish outcome for every AI job
- Worker must degrade gracefully when the AI binding is unavailable — fall back to deterministic-only behavior, log the failure, and continue

---

## Phase 2 — Forecast, Outlook, and Roundup Engine
Phase 2 turns the existing forecast and outlook work into an actual publishing schedule.

### 1. Scheduled Content Job Types
First-class content jobs:
- `alert_anchor`
- `alert_comment`
- `forecast_daily_draft`
- `forecast_update_draft`
- `roundup_draft`
- `spc_outlook_draft`
- `discussion_summary_draft`

All scheduled AI-generated editorial jobs enter the admin review queue by default. None auto-publish in v1.

> **Dependency note:** The Workers AI binding (Phase 1, Section 16) must be complete and stable before Phase 2 scheduled AI draft jobs are implemented. Phase 2 AI job types are blocked on Phase 1 AI plumbing.

### 2. Daily Schedule (ET display; stored/processed in UTC)
- **Morning `6:30–8:00 AM ET`**
  - default: 3-day national forecast
  - switch to roundup when multiple active clusters exist with no dominant event
- **Midday `11:30 AM–1:30 PM ET`**
  - publish only if forecast materially changed (see Section 3)
- **Evening `5:30–8:00 PM ET`**
  - publish evening forecast or active-weather update

During dominant live weather events or outbreak mode, scheduled forecast/roundup jobs should be deferred rather than suppressed entirely — they reschedule to the next available window.

### 3. Material Forecast Change Rules
Forecast update qualifies if any of these occur in days 1–3:
- temperature changes by at least `5°F`
- POP changes by at least `20 percentage points`
- short forecast wording changes for any tracked city
- SPC outlook category increases

### 4. Roundup Engine
Use roundups when:
- multiple medium- or high-importance clusters are active with no single dominant event
- fallback content is needed without spamming individual posts
- outbreak mode favors compression

Roundup rules:
- group by region
- summarize threats and link to the site
- prefer one roundup per region per time window
- a clearly national multi-region event may warrant a single national roundup instead of per-region posts
- roundups act as anti-spam compression — they never duplicate content already in active cluster threads

### 5. Inactivity Fallback (canonical, applies in all phases)
If nothing has posted in `2 hours`:

1. Evaluate held live clusters — prefer those with radar or storm-report support
2. If one deserves coverage, post it as an `alert`
3. If several medium-importance clusters exist without a dominant event, generate a `roundup`
4. If nothing meaningful exists, do nothing

A fallback post never outranks an active dominant cluster. A fallback never generates extra anchors during outbreak mode unless there is a clearly distinct regional event. If the fallback creates AI-generated editorial content, it produces a draft for admin review rather than auto-publishing in v1.

This logic supersedes the Phase 2 and Phase 3 fallback descriptions; there is one canonical fallback decision tree.

---

## Phase 3 — Radar Signals, Storm Reports, Outbreak Compression, and Engagement Drafts
Phase 3 adds four new capabilities on top of the Phase 1–2 systems.

### 1. Storm Report Ingestion and Enrichment
Storm reports strengthen active coverage; they do not create a parallel posting pipeline.

- Ingest: NWS Local Storm Reports and SPC storm reports
- NWS LSR is canonical when sources overlap or disagree
- Deduplicate into a single `StormReportRecord` using: hazard/report type, time proximity, location radius, and county/state fallback when coordinates are missing
- Attach reports to existing clusters by: overlapping county/UGC, metro match, or nearest active cluster when only coordinates exist
- Reports must not create standalone anchor posts
- High-significance reports may create deterministic update comments only when:
  - a matching Facebook thread already exists
  - the report confirms escalation on that active cluster
  - the report passes significance thresholds

**Unified significance thresholds (shared with escalation trigger):**
- tornado observed or confirmed
- tornado damage or structures impacted
- wind `>= 75 mph` (config: `WIND_SIGNIFICANCE_MPH`)
- hail `>= 2.0"` (config: `HAIL_SIGNIFICANCE_INCHES`)
- flash-flood or flood impacts involving rescues, road washouts, or major roadway inundation

Lower-value reports update ranking and cluster state without auto-commenting.

### 2. Radar-Assisted Decisioning
Radar becomes a supporting newsroom signal, not a new posting source.

- Reuse existing radar frame/tile infrastructure from the weather API
- Create radar support signals only for the top active `severe`, `tornado`, and `flood` clusters per cron cycle
- Radar uses:
  - boost cluster confidence when live radar supports the cluster
  - suppress weak or noisy severe coverage when radar support is absent
  - inform outbreak mode on regional storm organization
- Radar must not create new clusters, create standalone posts, or influence winter, fire, or non-convective coverage in v1

### 3. Outbreak Mode
Outbreak mode protects reach by compressing the feed during major multi-region events.

- **Enter:** automatically when `3+` dominant clusters exist across `2+` regions within a `90-minute` rolling window
- **Exit:** automatically after `60 minutes` below the trigger threshold
- Admin visibility with manual `force_on` and `force_off` controls (stored as `forcedState` on `OutbreakModeState`)

Outbreak mode behavior:
- maintain `1 storm = 1 post`
- favor comments over new anchor posts for same-storm updates
- prefer regional and national roundups when several medium/high clusters are active
- reduce per-region anchor cooldown to `5 minutes` only for distinct dominant clusters in different regions
- never permit duplicate same-cluster anchors in outbreak mode

### 4. Inactivity Fallback During Outbreak Mode
See the canonical fallback in Phase 2 Section 5. During outbreak mode, fallback additionally requires that:
- held clusters with report/radar support are evaluated first
- engagement drafts are only considered if the day is otherwise quiet and outbreak mode has fully exited

### 5. Scheduled Engagement Draft Generation
Engagement content is a quiet-day editorial lane, not a spam lane.

- One scheduled engagement-draft window per day: `1:00–3:00 PM ET`
- At most one engagement draft per day
- Only generate when:
  - no dominant cluster is active
  - outbreak mode is inactive
  - no higher-priority forecast, roundup, or live-weather draft is already pending for that window
- Engagement draft inputs: 5-city forecast trends, NWS discussions, SPC outlooks, notable weather patterns without a dominant event
- Engagement drafts always require admin review and never auto-publish

**Content strategy targets (guiding mix, not hard quotas):**
- `40%` alerts
- `30%` forecasts
- `20%` roundups/outlooks
- `10%` engagement

"Engagement" means educational, conversational, or interest-driven weather content — trivia, historical weather comparisons, safety reminders, or notable pattern explainers.

---

## Phase 4 — Live Event Mode, Video Links, and Crowd Report Workflow
Phase 4 turns the newsroom into a major-event operating system without making it a spammy live blog.

### 1. Live Event Mode
Live Event Mode is a focused coverage hub for one major ongoing event.

- Add a `LiveEventRecord` linking one or more dominant clusters under a single event
- **Activation:** hybrid — system detects likely major events; admin confirms and starts the live event
- Detection inputs: dominant cluster severity, report-confirmed escalation, outbreak mode, radar-supported persistence, major metro exposure
- Live Event Mode behavior:
  - designate one primary event across linked clusters
  - tighten update cadence for that event thread
  - favor comments and approved updates over new anchor posts
  - give the event top placement in admin and on the public site
  - compress the rest of the newsroom so the event owns coverage without duplication
- **Close-out:** admin ends the event manually, or the system suggests closing when clusters expire and no meaningful updates arrive in a cooling period

### 2. Dedicated Public Event Page
- Temporary event page route keyed by `slug`
- Page shows: current event summary, affected regions and metros, approved update timeline, radar/map context, approved photos, safety messaging
- Only approved newsroom updates and approved crowd-report assets may appear
- Homepage may link prominently to the live event page but does not become a full homepage takeover in v1

### 3. External Video Integration
- First-class platforms: Facebook, YouTube
- Allowed: linking a video or live stream into the live event workspace, pinning featured video on the public event page, using approved video links in newsroom drafts
- No direct video upload, storage, or transcoding in Phase 4

### 4. Crowd Report Workflow
- Public submission form accepts: written report text, optional still photos, location, event type, timestamp, optional name/contact
- Submissions enter moderation queue; they never affect public coverage until reviewed
- **Submission abuse controls:** rate limit by IP (max 5 submissions per hour per IP), basic input validation on all fields, honeypot field for bot filtering, `submissionIp` stored for ban enforcement
- Moderation actions: `approve_internal`, `approve_public`, `approve_media`, `reject`
- Approved reports may: enrich live event timelines, strengthen admin cluster context, contribute approved photos to coverage
- Approved reports must not create anchor posts or comments automatically in v1

### 5. Storage and Worker Bindings
- Keep KV for lightweight state and indexes
- Add R2 object storage for: crowd-report photos, approved event media references and thumbnails
- Extend `Env` and `wrangler.jsonc` for the new storage bindings
- AI may assist summarization after moderation, but may not bypass moderation or deterministic publish controls

### 6. Admin Newsroom and Moderation Surfaces
- **Live Event workspace:** active event summary, linked clusters, approved timeline entries, radar/report/media context, controls to start/update/pin/end the event, `createdBy` and `lastModifiedBy` tracking
- **Crowd Reports queue:** report details, location context, attached images, cluster/event match suggestions, moderation actions, IP and submission history for abuse review
- **Media panel:** adding Facebook and YouTube links, pinning and reordering approved media, selecting featured media for the live event page

---

## Implementation Priorities

Phase 1 implementation order:
1. cluster-first live alert pipeline
2. decision engine with cluster importance scoring
3. region cooldown + thread persistence
4. admin newsroom visibility (cluster state, decision reasons, override controls)
5. scheduled forecast/roundup job types
6. Workers AI binding + newsroom AI service layer ← must be stable before Phase 2 AI drafts
7. admin AI review queue (approve, reject, edit, regenerate)
8. KV cleanup cron job

Most important code areas for phase 1:
- `src/facebook/auto-post.ts`
- `src/facebook/threads.ts`
- `src/facebook/text.ts`
- `src/admin/page.ts`
- `src/types.ts`
- `wrangler.jsonc`

---

## Test Plan

### Live Alert / Cluster Tests
- same Chicago severe warnings create one anchor post and comments, not duplicate posts
- same-storm tornado updates thread into the same post
- different metro creates a new cluster and post
- different hazard creates a new cluster and post
- cluster expires after 60 minutes and a new post is allowed for the next signal
- a signal arriving at 65 minutes starts a new cluster but may comment on the old thread if it has not decayed
- a signal arriving at 76+ minutes starts a new cluster and a new anchor post

### Threading / Compatibility Tests
- manual admin post seeds thread state for later auto comments
- legacy `thread:*` keys still work during migration
- chain-limit rollover creates a new anchor with continuation handling
- `combine` action merges source cluster signals into target cluster and marks source as `merged`

### Decision Engine Tests
- tornado warnings always qualify
- severe threshold logic still applies
- flood/winter/fire family gating remains intact
- cooldown blocks duplicate anchor posts but allows comments
- AI suggestion cannot override a deterministic `skip`
- AI suggestion can recommend `comment` over `new_post` for same-storm clusters
- deterministic `skip` reason is recorded on the `PublishingDecision`

### Cluster Importance Scoring Tests
- tornado warning in a top-50 metro scores above `AUTO_POST_THRESHOLD`
- low-severity advisory in a rural area scores below `AUTO_POST_THRESHOLD`
- storm-report support raises a borderline cluster above the threshold
- radar suppress recommendation lowers a cluster below the threshold
- all importance weights are readable from config without code changes

### Scheduled Content Tests
- morning forecast posts once per window in ET
- midday update only runs on material change
- dominant live weather defers (not cancels) scheduled content to the next window
- roundup generation works when multiple medium clusters exist
- inactivity fallback chooses alert, roundup, or no-op correctly using the canonical fallback tree
- AI-generated forecast, roundup, outlook, and discussion jobs enter review instead of auto-publishing
- quiet-day mode allows forecast and engagement focus when no meaningful clusters are active
- Phase 2 AI draft jobs do not run if the Phase 1 AI binding is not configured

### Phase 1 Decision Gate and Format Tests
- auto-post requires all hard gate checks to pass
- top-50 metro impacts rank above otherwise similar rural-only events
- each publishing decision resolves to exactly one post type
- escalation triggers create a fresh anchor post when thresholds are met
- each cluster maps to exactly one newsroom region
- 50/50 cross-region clusters fall back to `senderOffice` region
- thread decay opens the door for a new anchor after `75 minutes` of inactivity
- chain limit rolls to a new anchor after `3` update comments
- AI is not called for clusters below `AI_CALL_THRESHOLD` unless a draft is explicitly required

### Wind Threshold Consistency Tests
- a storm report at `75 mph` triggers a high-significance auto-comment
- a storm report at `75 mph` on an active cluster triggers escalation
- a storm report at `74 mph` does neither
- `WIND_SIGNIFICANCE_MPH` config change updates both behaviors simultaneously

### KV TTL and Cleanup Tests
- expired cluster keys are purged within one cleanup cron cycle
- signal index entries referencing expired clusters are pruned
- `thread:*` keys remain valid for 48 hours after last write
- AI job records persist for 7 days after completion

### Phase 3 Storm Report Tests
- overlapping NWS + SPC reports dedupe into one canonical record
- NWS LSR wins as canonical when sources disagree materially
- reports attach to the correct cluster by county, metro, or coordinates
- significant reports auto-comment only when an active thread exists
- reports never create standalone posts
- `WIND_SIGNIFICANCE_MPH` and `HAIL_SIGNIFICANCE_INCHES` govern both storm-report and escalation thresholds

### Phase 3 Radar and Outbreak Tests
- radar signals are computed only for `severe`, `tornado`, and `flood` clusters
- radar can boost or suppress cluster confidence without creating posts
- outbreak mode enters at `3+` dominant clusters across `2+` regions in `90 minutes`
- outbreak mode exits after `60 minutes` below threshold
- outbreak mode favors comments and roundups without creating duplicate same-cluster anchors
- admin `force_on` and `force_off` controls override automatic state

### Phase 3 Engagement Tests
- only one engagement draft is created per quiet day
- engagement drafts do not generate during outbreak mode or dominant live coverage
- engagement drafts enter admin review and do not auto-publish

### Phase 4 Live Event Tests
- likely major events are detected automatically but do not activate without admin confirmation
- active live events pull together linked clusters without duplicating coverage
- ending a live event returns the newsroom to normal behavior
- public event pages show only approved updates and approved media
- `createdBy` and `lastModifiedBy` are recorded on `LiveEventRecord`

### Phase 4 Video and Crowd Report Tests
- Facebook and YouTube links validate and render correctly in live event media
- invalid or unapproved video links never appear publicly
- public crowd reports enter moderation successfully
- text and photo submissions store correctly in R2
- rejected reports never affect public or admin event output beyond moderation history
- approved reports can enrich live event pages and admin context without auto-posting
- submissions exceeding 5 per hour from the same IP are rejected
- honeypot field triggers silent rejection

### Workers AI Tests
- Worker degrades gracefully when the AI binding is unavailable; deterministic path continues
- structured JSON output validates before being stored
- malformed JSON is rejected with a logged `validationErrors` record
- hallucinated facts are rejected against `sourceFacts` in the draft validator
- approved AI drafts publish through the same Facebook image/thread path as manual admin posting
- `rejectedBy` and `rejectionReason` are recorded on rejected drafts

### Admin Tests
- newsroom queue reflects cluster decisions and importance scores
- preview matches anchor vs comment behavior
- overrides persist and affect later cron runs
- AI review queue shows source facts, deterministic decision, AI suggestion, and draft output
- approve, reject, edit, and regenerate actions work end to end
- merge/split cluster controls update KV state correctly

---

## Assumptions
- The current Worker + KV architecture remains the primary implementation path
- Facebook (Live Weather Alerts page) is the first and primary publishing target
- Phases 1–2 are implementation-ready; phases 3–4 remain roadmap-level
- All timestamps are stored internally in UTC; ET conversion applies only at scheduling and display layers
- Storm motion is helpful but not required for v1 clustering
- Radar-based signals and storm reports are out of scope for phases 1–2
- Cloudflare Workers AI uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- KV + cron remains the async job backbone for v1 instead of Queues or Durable Objects
- AI assists decisioning and generates drafts; the deterministic rule engine keeps final authority
- All AI-written text requires human approval before publishing
- Immediate alert auto-posting remains deterministic in v1
- Workers AI usage in local/dev and production may incur cost
- Phase 2 scheduled AI draft jobs are blocked on the Phase 1 AI binding being complete and stable
- Phase 3 storm reports use both NWS LSR and SPC sources; NWS LSR is always canonical
- Phase 3 storm reports enrich clusters and existing threads only; they do not create standalone posts
- Phase 3 radar signals influence only `severe`, `tornado`, and `flood` decisioning
- Phase 3 outbreak mode is automatic by default but visible and overridable in admin
- Phase 3 engagement drafts are scheduled, review-gated, and limited to quiet-day coverage
- Phase 1 uses a hard auto-post gate before any automatic publish action
- Phase 1 metro priority is weighted; top-50 metros receive the strongest boost
- Phase 1 uses one static newsroom-region map for cooldowns, roundups, and outbreak logic
- Phase 1 thread decay threshold: `75 minutes` of inactivity
- Phase 1 chain limit: `3` update comments per anchor post
- Phase 1 cluster window: `60 minutes`
- Wind significance threshold: `75 mph` (unified, config: `WIND_SIGNIFICANCE_MPH`)
- Hail significance threshold: `2.0"` (config: `HAIL_SIGNIFICANCE_INCHES`)
- AI calls are cost-controlled and only run for clusters at or above `AI_CALL_THRESHOLD`
- KV records have explicit TTLs; a cleanup cron job purges stale keys every 30 minutes
- Phase 4 Live Event Mode is a focused coverage hub, not a continuous live-blog engine
- Phase 4 live events use hybrid activation: auto-detect plus admin confirmation
- Phase 4 public coverage uses a dedicated event page; no full homepage takeover in v1
- Phase 4 video integration is limited to Facebook and YouTube links
- Phase 4 crowd-report intake is open to the public but fully review-gated and rate-limited by IP
- Phase 4 accepts text and still photos for crowd reports; no direct video uploads
- Phase 4 uses R2 for crowd-report photo and media storage
