# Facebook Alert Coverage Strategy

## Summary

This combines the baseline national Facebook coverage plan with the surge or incident-mode plan for very large alert loads.

The goal is:

- cover all meaningful weather alerts
- avoid spamming the Facebook page
- keep life-threatening alerts immediate
- shift lower-priority coverage into controlled digest posts
- automatically tighten posting rules when alert volume explodes
- handle cold starts without replaying backlog like live coverage
- make every post read like an authority update, not a bot list
- keep the first implementation scope realistic for the current worker

## Core Model

Use a tiered system:

1. Standalone immediate posts for true high-impact alerts
2. Digest coverage for lower-priority alerts
3. Silent/internal coverage for alerts that should not hit the page directly

The website or app remains the full source of truth. Facebook is the highlight layer, not the full firehose.

Use three operating modes:

- Startup or Catch-Up Mode for cold starts and empty-post situations
- Normal Mode for manageable active alert volume
- Incident Mode for surge conditions and national-scale overload

## Admin and Config Controls

Keep the existing Facebook auto-post mode selector and extend it with a small v1 control surface.

Recommended v1 config fields:

- `mode`
- `digestCoverageEnabled`
- `llmCopyEnabled`
- `startupCatchupEnabled`

Behavior:

- `mode` continues to control standalone auto-post rules
- digests only run when `mode` is `smart_high_impact` and `digestCoverageEnabled` is on
- Workers AI copy only runs when `llmCopyEnabled` is on and the `AI` binding is available
- Startup or Catch-Up Mode only runs when `startupCatchupEnabled` is on

## Tier 1: Standalone Immediate Posts

These should always be allowed to break out as their own Facebook post:

- Tornado Warning
- Tornado Emergency
- Flash Flood Emergency
- Destructive Severe Thunderstorm Warning
- Evacuation or public-safety wildfire alerts
- Rare top-tier winter or ice warnings with major metro or broad regional impact

Rules:

- 1 alert = 1 post
- publish immediately
- if an alert previously appeared in a digest and then escalates into this tier, create a new standalone post
- once an alert gets standalone Facebook coverage, exclude it from future digests while it remains active

## Tier 2: Digest Coverage

Use digest coverage for:

- low-impact warnings that do not meet standalone thresholds
- all watches by default
- advisories
- statements
- broad regional but non-life-threatening weather activity

Examples:

- Flood Warning
- Flood Watch
- Winter Storm Watch
- Winter Weather Advisory
- Wind Advisory
- High Wind Watch
- Fire Weather Watch
- Red Flag Warning without evacuation wording
- Special Weather Statement

Rules:

- publish at most 1 digest post every 30 minutes total
- inside the same 30-minute block, allow at most 1 comment update after a 15-minute cooldown
- only comment if the digest content materially changed
- if the next digest hash matches the last published hash, skip posting

## Tier 3: Silent/Internal Coverage

Track these internally, but do not post them directly to the national Facebook page unless they become part of a digest that clearly matters to the audience:

- test messages
- duplicates
- expired or all-clear lifecycle items
- marine-only and offshore-only alerts
- low-value noise that has little land audience relevance

For the national page, marine/coastal-only surges should usually be suppressed.

Marine suppression rule:

- if marine or coastal alerts are more than 30% of total active alerts, exclude them entirely from Facebook digests
- only allow marine or coastal items back in if they clearly impact land populations directly

## Startup or Catch-Up Mode

Startup mode handles the first snapshot after a cold start or a long quiet gap.

Trigger:

- no worker-published Facebook post recorded in local KV within the last 6 hours
- system cold start
- or no active digest publish state is available for the current cycle

Behavior:

- publish 1 national snapshot post immediately
- publish 1 to 3 priority hazard-cluster posts if the active map is broad enough
- never replay old alerts one-by-one as if they are fresh live alerts
- seed digest state from the current active snapshot only
- transition into Normal Mode or Incident Mode after initialization completes

Priority startup clusters should favor the biggest live land-impact hazards, such as:

- flood
- winter
- wind or fire weather

## Normal Mode

Normal mode applies when alert volume is manageable.

Digest shape:

- if exactly 1 state has digestable alerts, publish a state digest
- if 2 to 6 states have digestable alerts, publish 1 multistate digest covering all of them
- if 7 or more states have digestable alerts, switch to rotation logic

Hazard clustering comes before state layout.

Build digest candidates by hazard family first, then geography:

- flood
- winter
- wind
- fire weather
- other land-impact hazards

Within each hazard family:

- score affected states
- surface the clearest multistate pattern
- only fall back to state-first framing when one state clearly dominates the story

State scoring:

- warning = 5 points
- watch = 3 points
- advisory = 2 points
- statement = 1 point

Tie-breakers:

- more eligible alerts
- stronger metro or population relevance
- state code

For 7 or more active states:

- always publish 1 multistate digest
- include the top 3 scoring states
- include 3 rotated states from the remaining pool
- persist a rotation cursor in KV and advance it after each published digest

## Incident Mode

Incident mode exists for extreme alert loads, where normal grouped posting would still look spammy.

Enter incident mode when any of these are true:

- active alerts >= 100
- active states >= 8
- marine/coastal share >= 30%

In incident mode:

- do not create separate digest posts per state
- publish only national or multistate digests
- keep the same 30-minute global digest budget
- prioritize hazard families over raw alert count
- keep standalone breakout posts for true life-safety alerts only
- strongly prefer hazard-cluster framing over state rollups

Recommended digest framing:

- winter impacts in the Rockies or Plains
- flood issues in the Midwest or South
- wind impacts in affected western states
- other large-scale land-impact setups

## Cluster Breakout Override

Allow a dedicated hazard-cluster post when one non-Tier-1 hazard family becomes the dominant national story.

Trigger examples:

- 10 or more flood warnings across multiple states
- a winter hazard-family score of 20 or more across at least 3 states
- a wind or fire-weather hazard-family score of 20 or more across at least 3 states

Behavior:

- publish a standalone cluster post for that hazard family
- do not bury that cluster inside a generic digest
- keep Tier 1 life-safety alert breakouts higher priority than cluster breakouts
- remove alerts covered by the cluster post from the next digest if they would only duplicate the same story

## Example: Large Snapshot Handling

For the `alerts.txt` snapshot reviewed on April 1, 2026:

- total alerts: 392
- marine/coastal-style alerts: about 208
- advisories: 252
- watches: 46
- warnings: 78

This should not be handled as one post per alert.

It should be handled as:

- standalone posts only for qualifying life-safety alerts
- 1 national digest post every 30 minutes
- 1 comment update max inside the active digest block if the summary materially changes
- suppression of marine-only noise from dominating the page

## Digest Content Rules

Build digests from the current active alert snapshot, not from replaying every lifecycle change. That keeps the Facebook summary aligned with what is active now.

Digest content should:

- answer the question "What is happening right now?"
- summarize hazard families first
- group alerts into hazard clusters before listing states
- show only the top 3 to 6 states in each digest
- rotate additional states into later digests
- exclude alerts already covered by standalone Facebook posts
- omit expired, duplicate, test, and all-clear records

Digest posts should feel like a live national update desk, not a raw list dump.

Preferred framing:

- "Flooding concerns in the Midwest"
- "Winter impacts in the Northern Plains"
- "Strong winds across the West"

Avoid raw list framing like:

- event name + event name + event name with no clear current story

## Threading and Comments

Use Facebook comments to reduce repost churn:

- create a digest anchor post for the current block
- if the digest changes meaningfully within that block, add a comment update instead of making a new post
- if a tracked alert escalates to standalone tier, break out into a new immediate post instead of updating the digest thread

Implementation rule:

- digest threads must use a dedicated digest thread record keyed by digest block and scope
- do not reuse the existing per-alert Facebook thread keys for digests
- alert threads and digest threads must stay separate so digest comments cannot collide with alert update comments

## LLM Copywriting Layer

Use an LLM to write the final Facebook copy, but do not let it decide alert logic.

The rules engine remains responsible for:

- what gets posted
- what gets grouped
- what gets suppressed
- whether a post is standalone, digest, comment, or silent coverage
- startup vs Normal vs Incident Mode
- hazard clustering
- state rotation
- marine suppression
- dedupe
- cooldowns
- escalation handling

The LLM is responsible for:

- headline wording
- making the post sound human and readable
- summarizing 3 to 6 states cleanly
- turning hazard clusters into strong Facebook copy
- varying phrasing so posts do not all read the same

For this system, the model acts as a controlled copywriter, not the dispatcher.

## Workers AI Model

Use Cloudflare Workers AI with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

Reference:

- [Cloudflare Workers AI: llama-3.3-70b-instruct-fp8-fast](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)

Infrastructure requirements:

- add an `AI` binding in `wrangler.jsonc`
- extend the worker `Env` type to include the `AI` binding
- only attempt LLM generation when the binding exists and `llmCopyEnabled` is true

Use the LLM for:

- national digest posts
- multistate summary posts
- hazard-cluster posts such as flood, winter, or wind
- comment updates
- headline variation

Do not depend on the LLM for:

- alert classification
- Tier 1 eligibility
- marine suppression
- cooldown logic
- dedupe
- escalation handling
- post scheduling

## LLM Input Contract

Do not send the raw alert feed to the LLM.

Send only a structured payload produced by the rules engine, such as:

```json
{
  "mode": "incident",
  "post_type": "digest",
  "hazard_focus": "flood",
  "states": ["OH", "NY", "IN", "MO"],
  "top_alert_types": ["Flood Warning", "Flood Watch"],
  "urgency": "high",
  "max_length": 450,
  "style": "national weather desk, clear, concise, no hype"
}
```

The payload should include only:

- selected alerts
- chosen hazard cluster
- allowed states
- tone and style instructions
- output length limits
- any safety wording constraints

## LLM Output Constraints

Constrain the model hard.

Default rules:

- max 2 short paragraphs
- no emojis
- no hashtags unless explicitly enabled
- no county dump
- no unsupported safety advice
- no exaggerated words like "historic" or "catastrophic" unless the triggering alert supports them
- keep the writing clear, concise, and authoritative

Every generated post should still satisfy the digest quality rule:

- answer "What is happening right now?"

## Validation and Fallback

Use a hybrid production flow:

1. Worker builds the structured payload.
2. Workers AI writes the Facebook copy.
3. A final validator checks length, tone, banned wording, and required geography or hazard mentions.
4. If validation fails or the model is unavailable, fall back to a deterministic template.

Recommended v1 behavior:

- use templates for Tier 1 standalone warnings
- use the LLM for digests, multistate summaries, cluster posts, and comment updates
- always keep a template fallback if the LLM fails

## V1 Scope Boundary

The first rollout should stay focused on rules, digesting, clustering, and safe LLM copy generation.

Explicitly in v1:

- standalone alert posting
- startup or catch-up handling
- digest generation and rotation
- cluster breakout posts
- Workers AI copywriting with validation and template fallback
- admin toggles for digest, LLM, and startup behavior

Deferred to v2 unless a separate metrics pipeline is added:

- automatic engagement-protection throttling based on Facebook post performance
- Graph API insights ingestion
- live Facebook page inspection for startup detection

## Engagement Protection

Protect long-term reach by adapting when recent posts are underperforming.

This is a future enhancement, not a required part of the first implementation.

Rule:

- if the last 3 Facebook posts show low engagement or high negative scroll-through signals, temporarily reduce digest frequency
- raise the posting-quality threshold until engagement recovers

Behavior during protection mode:

- slow digest cadence from 30 minutes to 45 or 60 minutes
- require a clearer national or regional story before publishing a new digest
- prefer comments on the active digest thread over creating another post
- keep Tier 1 life-safety posts exempt from throttling

## Implementation Notes

Recommended worker behavior:

- keep `smart_high_impact` as the standalone posting engine
- add digest coverage as an additional toggle, not a replacement mode
- run digest generation after standalone auto-post evaluation in the scheduled handler
- call Workers AI only after the rules engine has selected the exact post payload
- detect Startup Mode before Normal or Incident Mode logic runs
- generate digest framing from hazard clusters first, then state scoring
- support cluster breakout posts as a separate publish path
- apply marine suppression before digest scoring
- use local KV state, not a live Facebook page read, to detect startup conditions in v1
- use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` as the copywriting model for digests and cluster summaries
- keep deterministic templates as a fallback path when Workers AI errors or output validation fails
- store digest threads separately from alert threads
- use KV to store:
  - current digest block record
  - last published digest hash
  - digest rotation cursor
  - covered-alert records for standalone posts
  - startup initialization state
  - last worker-published Facebook post timestamp
  - separate digest thread records

Implementation note:

- extending the admin config and config endpoint is part of v1 even though no public end-user API changes are required

Recommended internal types:

- facebook coverage config
- digest candidate
- digest summary
- hazard cluster summary
- digest thread record
- llm prompt payload
- llm post validation result
- published digest block record
- standalone-covered alert record
- startup state record

No public end-user API changes are required for v1.

## Acceptance Criteria

- a large alert pull does not create post spam
- a cold start produces a clean snapshot-style kickoff instead of replaying backlog
- the page publishes immediate breakout posts only for true life-safety alerts
- lower-priority alerts still receive coverage through controlled digests
- no more than 1 digest post is created every 30 minutes
- no more than 1 comment update is added inside a digest block when needed
- digest comments attach to digest threads only, and alert updates attach to alert threads only
- marine-only surges no longer dominate the national page
- marine-heavy snapshots are excluded from digests unless they affect land populations directly
- dominant flood, winter, or wind clusters can break out into their own focused post
- digest language reads like a current weather situation summary, not a raw list
- the rules engine, not the LLM, always decides posting logic
- Workers AI only receives structured selected data, never the full raw alert feed
- if LLM generation fails, the post still publishes cleanly through template fallback
- admin config persists digest, LLM, and startup toggles
- active states rotate through digest coverage over time
- escalation from digest-worthy to standalone-worthy always creates a new immediate post

## Default Assumptions

- this is a national land-focused Facebook page
- completeness means alerts are covered in the system and on the site, not one Facebook post per alert
- watches stay digest-only by default
- digest cadence is 30 minutes
- comment cooldown is 15 minutes
- the system is fully automatic in v1
- startup mode uses the current active snapshot as truth and never backfills old Facebook posts
- startup detection uses local KV state and a 6-hour gap, not a live Facebook page fetch
- Workers AI is used as a constrained copywriter layer, not a decision engine
- engagement-protection metrics are out of scope for v1
