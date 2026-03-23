You are editing an existing Cloudflare Pages site in `pages-site/`.

Create a NEW page for:
- Topic: [TOPIC]
- URL slug: /[slug]/
- Audience: general public (adults + families)
- Writing style: very simple, clear, non-technical by default
- Goal: users should understand what to do without leaving the site

Hard requirements:
1) Keep the same visual style and design language already used in this project.
   - Reuse existing patterns from:
     - `pages-site/styles.css`
     - `pages-site/information-hub/`
     - `pages-site/tornado-basics/`
     - `pages-site/alert-methods/`
     - `pages-site/forecast-maps/`
   - Keep fonts, spacing rhythm, card style, hero section, pills, and button style consistent.
   - Do NOT redesign the brand.

2) Keep wording simple and action-first.
   - Prefer short sentences.
   - Explain “what this means” and “what to do now”.
   - Put technical terms in an optional `<details>` section only.

3) Build page files:
   - `pages-site/[slug]/index.html`
   - `pages-site/[slug]/styles.css`
   - (optional) `pages-site/[slug]/app.js` only if needed

4) Include this nav pattern (same order used currently):
   - Weather Alerts
   - Information Hub
   - Convective Outlook
   - Tornado Basics
   - Alert Methods

5) Add discoverability:
   - Add a card link from `pages-site/index.html` to `/[slug]/`
   - Add a tab/section link from `pages-site/information-hub/index.html` (or a panel link) to this new page

6) Accessibility + responsive:
   - Mobile-first behavior
   - Clear heading hierarchy
   - Good contrast
   - Buttons/links easy to tap

7) Source handling:
   - Add source links at the bottom as optional “official guidance”
   - Main content must stand on its own without forcing users to leave

8) Update docs:
   - Add the new page to `pages-site/README.md` file list

Output format:
- Show exact files changed
- Provide final code for each changed/new file
- Keep code clean and consistent with existing project style
