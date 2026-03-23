You are editing an existing Cloudflare Pages site in `pages-site/`.

Task: Add a NEW tab to the existing Information Hub page, not a full redesign.

Target:
- New tab name: [TAB NAME]
- Data key for tab: [tab_key]  (example: flood, winter, power-outage)
- Panel id must be: `panel-[tab_key]`
- Querystring support: `/information-hub/?tab=[tab_key]`

Requirements:
1) Keep current visual style exactly consistent.
   - Reuse existing classes and structure from:
     - `pages-site/information-hub/index.html`
     - `pages-site/information-hub/styles.css`
     - `pages-site/information-hub/app.js`
   - Do not change fonts, global color direction, spacing system, or navbar structure.

2) Add tab button in tablist:
   - `<button class="hub-tab" ... data-panel="[tab_key]">[TAB NAME]</button>`
   - Include proper ARIA attributes and tabindex behavior matching existing tabs.

3) Add matching panel section:
   - `<section class="hub-panel" id="panel-[tab_key]" role="tabpanel" ... hidden>`
   - Use simple, action-first language.
   - Include:
     - a short intro
     - 3–6 plain-language cards (`panel-card` or matching pattern)
     - optional “Technical terms” `<details>` block
     - optional link to deeper page if relevant

4) Keep wording simple:
   - explain “what this means”
   - explain “what to do now”
   - avoid jargon unless placed in optional technical section

5) Ensure tab script works:
   - Update `pages-site/information-hub/app.js` only if needed
   - New tab must open correctly from:
     - clicking tab
     - keyboard arrows/home/end
     - URL query param `?tab=[tab_key]`

6) Optional homepage discoverability:
   - If this tab is high priority, add one card in `pages-site/index.html` pointing to `/information-hub/?tab=[tab_key]`
   - Keep card wording short and consistent with existing page-link-card style

7) Keep existing behavior intact:
   - Do not break other tabs
   - Do not remove existing content unless explicitly asked

8) Update docs:
   - Add one line in `pages-site/README.md` noting the new Information Hub tab topic

Output format:
- List files changed
- Provide final code diffs or full updated snippets for each changed file
- Keep changes minimal and style-consistent
