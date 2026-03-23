```text
You are editing an existing Cloudflare Pages site in `pages-site/`.

Task: Add MULTIPLE new tabs to `pages-site/information-hub/` in one pass, using the current design system exactly as-is.

Tabs to add:
- [TAB 1 NAME] -> key: [tab1_key]
- [TAB 2 NAME] -> key: [tab2_key]
- [TAB 3 NAME] -> key: [tab3_key]
(You may add more in the same format.)

Core rules:
1) Preserve style and structure.
   - Reuse existing patterns/classes from:
     - `pages-site/information-hub/index.html`
     - `pages-site/information-hub/styles.css`
     - `pages-site/information-hub/app.js`
   - No redesign. Keep current spacing, card styles, and typography.

2) For each new tab:
   - Add one tab button in `.hub-tabs`:
     - `data-panel="[tab_key]"`
     - correct `aria-controls`, `aria-selected`, and `tabindex`
   - Add one matching panel:
     - `<section class="hub-panel" id="panel-[tab_key]" role="tabpanel" ... hidden>`

3) Panel content template (for each tab):
   - short intro sentence
   - 3–6 simple action-focused cards (use existing `panel-card` style)
   - optional technical `<details>` section (advanced terms only)
   - optional “Open full guide” link if a deeper page exists

4) Writing requirements:
   - plain-language, low-jargon, adult-facing
   - “what this means” + “what to do now”
   - users should understand without leaving site

5) Querystring support:
   - Ensure each new tab opens from:
     - `/information-hub/?tab=[tab_key]`
   - Keep all existing tab functionality intact (click + keyboard arrows/home/end)

6) Homepage discoverability:
   - In `pages-site/index.html`, add `page-link-card` links for each new tab:
     - `/information-hub/?tab=[tab_key]`
   - Keep copy short and consistent with current cards.

7) Navigation consistency:
   - Do not change top nav order or global theme.
   - Only update nav if absolutely needed for consistency with existing pages.

8) README:
   - Update `pages-site/README.md` with a short note listing newly added Information Hub tabs.

Output required:
- List all files changed
- Show final diffs or full snippets for each changed file
- Confirm each new tab key works via `?tab=...`
- Keep edits minimal, clean, and style-consistent
```