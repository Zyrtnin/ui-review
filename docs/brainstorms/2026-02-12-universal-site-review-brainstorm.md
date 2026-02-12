# Brainstorm: Universal Site Review with Discovery, Live View, and Screenshots

**Date:** 2026-02-12
**Status:** Ready for planning

---

## What We're Building

Transform ui-review from a FlipperHub-specific tool with hardcoded pages into a universal site review tool that can:

1. **Auto-discover pages** on any site via crawling/sitemap parsing
2. **Show a live browser window** during review (optional watch mode)
3. **Save screenshots** alongside analysis results, viewable in the frontend

## Why These Changes

The current tool requires manually listing every page path. This means:
- Adding a new site means editing DEFAULT_PAGES in index.html
- No way to know what pages exist on an unfamiliar site
- Screenshots are discarded after VLM analysis — can't verify what the AI saw
- Reviews run invisibly in headless mode — no way to observe progress

These three features together make ui-review a general-purpose tool usable on any web application.

## Key Decisions

### 1. Page Discovery: Sitemap + Crawl + Manual

**Strategy:** Try sitemap.xml first (fast, structured), fall back to link crawling, always allow manual page entry as override.

**Crawl behavior:**
- Unlimited depth with a **configurable page cap** (user sets limit per their app's size, e.g. 50, 100, 200+)
- Same-origin links only (no external sites)
- Follow `<a href>` links in rendered HTML (Playwright-based, so JS-rendered pages work)
- Respect robots.txt? TBD — probably skip for internal tools
- Deduplicate by normalized URL path

**Page tree UI:**
- Collapsible tree grouped by URL path segments (`/player/*`, `/tournament/*`, `/admin/*`)
- Search/filter input to find specific pages
- Checkboxes on each node — select/deselect individual pages or entire groups
- "Select All" / "Select None" at the top
- Discovery results replace the current hardcoded DEFAULT_PAGES grid

**Discovery flow in frontend:**
1. User selects environment (base URL)
2. Clicks "Discover Pages" button
3. SSE stream shows crawl progress (pages found, links followed)
4. Page tree populates as pages are discovered
5. User checks/unchecks pages, selects viewports, clicks "Run Review"

### 2. Live Browser View: Watch Mode Toggle

**Implementation:** A "Watch Mode" toggle in the UI. When enabled:
- Playwright launches in **headful mode** (`headless: false`) instead of headless
- User sees a real Chromium window navigating and screenshotting each page
- When disabled (default), runs headless as before for speed

**Server-side:** The `headless` option in `capture.js` becomes configurable via the review request body. No new dependencies needed — Playwright supports headful mode natively.

**Tradeoff:** Headful mode is slower and requires a display server (X11/Wayland). Fine for local dev, won't work on headless servers. The toggle makes this opt-in.

### 3. Screenshots: Saved and Viewable

**Storage:** Save PNG screenshots to `reports/<report-id>/screenshots/<page-name>_<viewport>.png` alongside the report JSON.

**Frontend display:** Side-by-side layout in result cards:
- Left panel: screenshot (click to zoom/pan)
- Right panel: issue list with severity badges
- Allows visual verification of where issues are on the page

**Server-side:**
- `captureScreenshot()` returns buffer as before
- Server saves buffer to disk before passing to VLM
- Report JSON references screenshot paths (relative to report dir)
- Screenshots served via static file route: `GET /api/reports/:id/screenshots/:filename`

**Export:** Screenshots included when exporting reports (optional zip download).

### 4. Authentication: Login Flow + StorageState Fallback

**Primary (simple):** Login form in the UI:
- User enters login URL, username, password
- Crawler navigates to login URL, fills form fields, submits
- Captures resulting session cookies
- Uses those cookies for all subsequent page loads during crawl + review

**Fallback (advanced):** Upload a Playwright `storageState.json` file:
- User exports cookies/localStorage from their browser
- Upload via file picker in the UI
- Passed to Playwright's `context.storageState()` for all browsing
- Works with any auth system (OAuth, MFA, SSO)

**Storage:** Auth config saved per-environment in localStorage (not passwords — just the storageState after login).

## Architecture Changes

### New Files
- `lib/discover.js` — Page discovery: sitemap parsing + link crawling
- `reports/<id>/screenshots/` — Screenshot storage per report

### Modified Files
- `lib/capture.js` — Accept `headless` option, return both buffer and saved path
- `bin/server.js` — New `POST /api/discover` SSE endpoint, screenshot save logic, auth flow, screenshot serving route
- `public/index.html` — Page tree UI, discover button, watch mode toggle, auth panel, side-by-side screenshot display, configurable page cap

### New Server Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `POST /api/discover` | SSE | Crawl site, stream discovered pages |
| `POST /api/auth/login` | JSON | Execute login flow, return session state |
| `GET /api/reports/:id/screenshots/:file` | Static | Serve saved screenshots |

## Open Questions

1. **Should discovery results be cached per-environment?** (So you don't re-crawl every time)
2. **Should we support crawling SPAs?** (Client-side routing — Playwright handles this naturally since it executes JS)
3. **Max concurrent page loads during crawl?** (Probably 3-5 to avoid overwhelming the target)
4. **Should the page tree show HTTP status codes?** (Useful to see 404s, redirects, auth-required pages)

## Scope Estimate

This is a significant feature set. Suggested phasing:

**Phase 1:** Screenshot persistence + side-by-side display (smallest, most immediately useful)
**Phase 2:** Page discovery with tree UI + configurable cap
**Phase 3:** Live watch mode toggle
**Phase 4:** Authentication (login flow + storageState)

---

*Next step: `/workflows:plan` to create implementation plan*
