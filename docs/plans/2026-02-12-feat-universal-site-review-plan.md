---
title: "feat: Universal Site Review — Discovery, Screenshots, Watch Mode, Auth"
type: feat
date: 2026-02-12
brainstorm: docs/brainstorms/2026-02-12-universal-site-review-brainstorm.md
---

# Universal Site Review — Discovery, Screenshots, Watch Mode, Auth

## Overview

Transform ui-review from a hardcoded-page tool into a universal site reviewer that can discover pages on any site, save screenshots alongside analysis, show a live browser during review, and authenticate before crawling.

Four features, implemented in four phases:

| Phase | Feature | Effort | Files |
|-------|---------|--------|-------|
| 1 | Screenshot persistence + side-by-side display | Small | capture.js, server.js, index.html |
| 2 | Page discovery (sitemap + crawl + tree UI) | Large | **new** discover.js, server.js, index.html |
| 3 | Live watch mode toggle | Small | capture.js, server.js, index.html |
| 4 | Authentication (login flow + storageState) | Medium | **new** auth section in server.js, index.html |

## Phase 1: Screenshot Persistence

**Goal:** Save every screenshot to disk, serve via API, display side-by-side with issues.

### 1.1 Storage Layout

```
reports/
  review-1707123456.json          # existing report JSON
  review-1707123456/
    screenshots/
      Home_desktop.png
      Home_mobile.png
      Login_desktop.png
      Login_mobile.png
```

**Filename convention:** `{sanitizedPageName}_{viewport}.png`
- Sanitize: replace non-alphanumeric with `_`, lowercase, truncate to 60 chars
- Collision-safe: page name derived from `page.name` field (unique per report)

### 1.2 Server Changes (`bin/server.js`)

**After screenshot capture, save to disk:**

```javascript
// bin/server.js — inside the page×viewport loop, after captureScreenshot()

const screenshotDir = join(REPORTS_DIR, report.id, 'screenshots');
mkdirSync(screenshotDir, { recursive: true });
const filename = `${sanitizeName(page.name)}_${viewport.name}.png`;
writeFileSync(join(screenshotDir, filename), buffer);

// Store relative path in result
report.results[key].screenshot = `screenshots/${filename}`;
```

**New route — serve screenshots:**

```javascript
// GET /api/reports/:id/screenshots/:filename
const screenshotMatch = url.pathname.match(
  /^\/api\/reports\/([a-z0-9-]+)\/screenshots\/([a-zA-Z0-9_.-]+\.png)$/
);
if (screenshotMatch && req.method === 'GET') {
  const filePath = join(REPORTS_DIR, screenshotMatch[1], 'screenshots', screenshotMatch[2]);
  // Path traversal protection: regex already constrains chars
  if (existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Screenshot not found');
  }
}
```

**Helper function:**

```javascript
function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}
```

### 1.3 Frontend Changes (`public/index.html`)

**Side-by-side layout in result cards:**

```
+--------------------------------------------------+
| > Home (desktop)          3 issues  2 warning     |
+--------------------------------------------------+
| [Screenshot]  | Summary text...                   |
| (click to     | [warning] SPACING                 |
|  zoom)        |   Between nav and hero...          |
|               |   Fix: Add 16px margin...          |
|               | [suggestion] TYPOGRAPHY             |
|               |   Font size inconsistent...        |
+--------------------------------------------------+
```

**CSS additions:**

```css
.result-card-content { display: flex; gap: 16px; }
.screenshot-panel { flex: 0 0 40%; max-width: 400px; }
.screenshot-panel img { width: 100%; border-radius: 4px; cursor: zoom-in; border: 1px solid var(--border); }
.screenshot-panel img.zoomed { position: fixed; top: 5vh; left: 5vw; width: 90vw; height: 90vh; object-fit: contain; z-index: 100; background: rgba(0,0,0,0.9); border: none; cursor: zoom-out; }
.issues-panel { flex: 1; min-width: 0; }
```

**JS in `renderResultCard()`:**

```javascript
const screenshotUrl = data.screenshot
  ? `/api/reports/${currentReportId}/${data.screenshot}`
  : '';

const screenshotHtml = screenshotUrl
  ? `<div class="screenshot-panel">
       <img src="${screenshotUrl}" alt="${msg.page} ${msg.viewport}"
            onclick="this.classList.toggle('zoomed')">
     </div>`
  : '';
```

### 1.4 Acceptance Criteria

- [ ] Screenshots saved to `reports/<id>/screenshots/<name>_<viewport>.png`
- [ ] `GET /api/reports/:id/screenshots/:filename` returns PNG with 200
- [ ] Path traversal rejected (only alphanumeric + underscore + dot + hyphen)
- [ ] Screenshot path stored in result JSON (`result.screenshot`)
- [ ] Frontend renders screenshot left, issues right
- [ ] Click screenshot to zoom (fixed overlay), click again to dismiss
- [ ] Resume skips re-capturing screenshots that already exist on disk
- [ ] Export report markdown includes screenshot filenames

---

## Phase 2: Page Discovery

**Goal:** Crawl any site to discover pages, display as filterable tree, let user select which to review.

### 2.1 New Module: `lib/discover.js`

```javascript
// lib/discover.js

export async function discoverPages({
  baseUrl,
  maxPages = 50,
  onPage,           // callback(page) for SSE streaming
  onProgress,       // callback(message) for status
  allowPrivate = false,
  storageState,     // Playwright auth state
  signal,           // AbortSignal for cancellation
})
```

**Discovery strategy:**

1. **Try sitemap.xml** — `GET {baseUrl}/sitemap.xml`
   - Parse XML, extract `<loc>` URLs
   - Filter to same-origin only
   - If found and has entries, use as page list (skip crawling)

2. **Fall back to link crawling** — Playwright-based
   - Start at `baseUrl`
   - Extract all `<a href>` from rendered HTML
   - Filter: same-origin, http/https only, no fragments, no duplicate paths
   - Normalize: strip trailing slash, sort query params, lowercase path
   - BFS traversal with configurable concurrency (3 concurrent pages)
   - 200ms delay between page loads to avoid rate limiting
   - Stop when `maxPages` reached or no unvisited links remain

3. **Always allow manual additions** — frontend keeps the custom page input

**Return value:**

```javascript
{
  pages: [
    { name: 'Home', path: '/', depth: 0, status: 200, links: 5 },
    { name: 'login', path: '/login.php', depth: 1, status: 200, links: 2 },
    { name: 'player-dashboard', path: '/player_dashboard.php', depth: 1, status: 302, links: 0 },
  ],
  source: 'crawl' | 'sitemap' | 'mixed',
  totalLinksFound: 47,
  pagesSkipped: 12,  // over maxPages limit
}
```

**URL normalization:**

```javascript
function normalizeUrl(urlString, baseUrl) {
  const url = new URL(urlString, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) return null;  // external
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.hash = '';  // strip fragments
  let path = url.pathname.replace(/\/+$/, '') || '/';  // strip trailing slash
  return path + (url.search || '');
}
```

**Page name derivation from path:**

```javascript
function pageNameFromPath(path) {
  const name = path.replace(/^\//, '').replace(/\.\w+$/, '').replace(/\//g, ' > ') || 'Home';
  return name.charAt(0).toUpperCase() + name.slice(1);
}
```

### 2.2 Server Route: `POST /api/discover`

SSE endpoint streaming discovered pages:

```javascript
// Request body
{ "baseUrl": "http://localhost:8081", "maxPages": 50, "allowPrivate": true }

// SSE events
data: {"event":"discover-progress","message":"Trying sitemap.xml..."}
data: {"event":"discover-progress","message":"No sitemap found, crawling links..."}
data: {"event":"discover-page","page":{"name":"Home","path":"/","depth":0,"status":200}}
data: {"event":"discover-page","page":{"name":"login","path":"/login.php","depth":1,"status":200}}
data: {"event":"discover-complete","total":23,"source":"crawl"}
data: {"event":"discover-error","message":"..."}
```

### 2.3 Frontend: Page Tree UI

Replace the flat checkbox grid with a collapsible tree:

```
[Search pages...]  [Discover Pages]  Page cap: [50 v]

[x] / (Home)                                    depth 0
[x] /login.php (Login)                           depth 1
[-] /player/ (3 pages)
    [x] /player_portal.html (Player Portal)      depth 1
    [x] /player_dashboard.php (Dashboard)        depth 1
    [x] /player_profile.html (Profile)           depth 2
[-] /tournament/ (4 pages)
    [x] /tournament_entry.html (Entry)           depth 1
    [x] /tournament_leaderboard.html (Leaderboard) depth 1
    ...
[x] /game_leaderboards.html (Game Leaderboards)  depth 1

Select all | Select none | 12 of 23 selected
```

**Tree grouping logic:**

```javascript
function buildPageTree(pages) {
  const tree = {};
  for (const page of pages) {
    const segments = page.path.split('/').filter(Boolean);
    const group = segments.length > 1 ? '/' + segments[0] + '/' : '/';
    if (!tree[group]) tree[group] = [];
    tree[group].push(page);
  }
  return tree;
}
```

**Search/filter:** Client-side filter on page name and path. Hides non-matching entries.

**Page cap selector:** Dropdown or number input in the UI, value sent in discover request body.

### 2.4 Acceptance Criteria

- [ ] `POST /api/discover` streams discovered pages via SSE
- [ ] Tries sitemap.xml first, falls back to link crawling
- [ ] Respects `maxPages` limit (configurable in UI)
- [ ] Same-origin filter (no external links)
- [ ] URL normalization (fragments, trailing slashes, duplicates)
- [ ] Page tree UI with collapsible groups by path segment
- [ ] Search/filter input narrows visible pages
- [ ] Group-level select/deselect (click folder checkbox)
- [ ] "Discover Pages" button triggers crawl, populates tree
- [ ] Manual page input still works alongside discovered pages
- [ ] Crawl cancellable (user clicks cancel or navigates away)
- [ ] 200ms delay between page loads
- [ ] Max 3 concurrent page loads during crawl

---

## Phase 3: Live Watch Mode

**Goal:** Optional toggle to launch Playwright in headful mode so the user can watch screenshots being taken in real-time.

### 3.1 Capture Changes (`lib/capture.js`)

```javascript
// Accept headless option (default true)
export async function captureScreenshot({
  url: urlString,
  viewport,
  config = {},
  storageState,
  waitFor,
  allowPrivate = false,
  headless = true,        // NEW
})

// Pass to launch
browser = await chromium.launch({ headless });
```

### 3.2 Server Changes (`bin/server.js`)

Accept `watchMode` in review request body:

```javascript
const { baseUrl, pages, viewports, allowPrivate, reportId, watchMode = false } = body;

// Pass to captureScreenshot
const buffer = await captureScreenshot({
  url: fullUrl,
  viewport,
  config,
  allowPrivate,
  headless: !watchMode,  // headful when watch mode enabled
});
```

**Display server detection:**

```javascript
if (watchMode && process.platform === 'linux' && !process.env.DISPLAY) {
  sendEvent(res, 'error', {
    message: 'Watch mode requires a display server. Set DISPLAY env var or disable watch mode.'
  });
  res.end();
  return;
}
```

### 3.3 Frontend Toggle

```html
<label class="watch-mode">
  <input type="checkbox" id="watchMode"> Watch mode (opens browser window)
</label>
```

Add to request body:

```javascript
const body = { baseUrl, pages, viewports, allowPrivate, watchMode: $('#watchMode').checked };
```

### 3.4 Acceptance Criteria

- [ ] "Watch mode" checkbox in actions bar
- [ ] When enabled, Playwright launches visible Chromium window
- [ ] Each page navigation visible to the user
- [ ] Screenshots still captured and saved normally
- [ ] Error message if no display server detected (Linux without DISPLAY)
- [ ] Default: off (headless)

---

## Phase 4: Authentication

**Goal:** Log in to a site before crawling/reviewing so authenticated pages are accessible.

### 4.1 Login Flow

**Frontend: Auth panel (collapsible, above pages panel):**

```
[v] Authentication (optional)
  Login URL:    [http://localhost:8081/login.php    ]
  Username:     [admin                              ]
  Password:     [********                           ]
  -- OR --
  Upload storageState.json: [Choose File]
  [Test Login]
```

**Server endpoint: `POST /api/auth/login`**

```javascript
// Request
{
  "baseUrl": "http://localhost:8081",
  "loginUrl": "/login.php",
  "username": "admin",
  "password": "secret123",
  "allowPrivate": true
}

// Response (success)
{
  "ok": true,
  "storageState": { /* Playwright storage state JSON */ },
  "redirectedTo": "/index.php",
  "cookies": 3
}

// Response (failure)
{
  "ok": false,
  "error": "Login failed — still on login page after submit"
}
```

**Login execution (`bin/server.js` or new `lib/auth.js`):**

```javascript
async function executeLogin({ baseUrl, loginUrl, username, password, allowPrivate }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const fullLoginUrl = baseUrl.replace(/\/$/, '') + loginUrl;
  await page.goto(fullLoginUrl, { waitUntil: 'networkidle' });

  // Auto-detect form fields
  const usernameField = await page.$('input[type="text"], input[name*="user"], input[name*="email"], input[id*="user"]');
  const passwordField = await page.$('input[type="password"]');
  const submitButton = await page.$('button[type="submit"], input[type="submit"]');

  if (!usernameField || !passwordField) {
    throw new Error('Could not find username/password fields on login page');
  }

  await usernameField.fill(username);
  await passwordField.fill(password);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
    submitButton ? submitButton.click() : page.keyboard.press('Enter'),
  ]);

  // Check if still on login page (login failed)
  const currentUrl = page.url();
  if (currentUrl.includes(loginUrl)) {
    const errorText = await page.$eval('.error, .alert-danger, [class*="error"]', el => el.textContent).catch(() => '');
    throw new Error(`Login failed${errorText ? ': ' + errorText.trim() : ' — still on login page'}`);
  }

  const state = await context.storageState();
  await browser.close();
  return { storageState: state, redirectedTo: new URL(currentUrl).pathname };
}
```

### 4.2 StorageState Upload

Frontend file picker + server endpoint:

```javascript
// POST /api/auth/upload-state
// multipart/form-data with storageState JSON file

// Validate schema: must have cookies array
// Store in memory for current session (not persisted to disk)
```

### 4.3 Passing Auth to Capture + Discovery

Both `captureScreenshot()` and `discoverPages()` accept `storageState`:

```javascript
// In runReview() — pass stored auth state
const buffer = await captureScreenshot({
  url: fullUrl,
  viewport,
  config,
  allowPrivate,
  storageState: authState,  // from login flow or upload
  headless: !watchMode,
});
```

The existing `capture.js` already supports `storageState` — it just needs to be wired through.

### 4.4 Frontend State

```javascript
let currentAuthState = null;  // Playwright storageState object

// After successful login test
currentAuthState = response.storageState;

// Included in review/discover requests
const body = { baseUrl, pages, viewports, allowPrivate, authState: currentAuthState };
```

**Per-environment auth:** Save auth association in localStorage (env name -> has auth flag). Don't save passwords or cookies — just track "this env requires auth" so the panel auto-opens.

### 4.5 Acceptance Criteria

- [ ] Auth panel with login URL, username, password fields
- [ ] "Test Login" button executes login and reports success/failure
- [ ] Auto-detect username/password/submit fields on login page
- [ ] Clear error message if login fails
- [ ] StorageState file upload as alternative
- [ ] Auth state passed to both discovery and review
- [ ] Passwords never logged, stored to disk, or sent via SSE
- [ ] Session expiry mid-review detected (401/403) with re-auth prompt
- [ ] MFA detected → clear message "Use storageState upload instead"

---

## Files Summary

### New Files
| File | Phase | Purpose |
|------|-------|---------|
| `lib/discover.js` | 2 | Sitemap parsing + link crawling |
| `prompts/` (no new files) | — | — |

### Modified Files
| File | Phases | Changes |
|------|--------|---------|
| `lib/capture.js` | 1, 3 | Accept `headless` param |
| `bin/server.js` | 1, 2, 3, 4 | Screenshot save/serve, discover endpoint, auth endpoint, watch mode |
| `public/index.html` | 1, 2, 3, 4 | Side-by-side display, page tree, watch toggle, auth panel |

### No New Dependencies

All features use Playwright (already installed) for crawling, auth, and headful mode. Sitemap XML parsing uses a simple regex or the built-in DOMParser approach (no library needed — sitemaps are simple XML).

---

## Open Questions

1. **Should discovery cache results per-environment?** Avoid re-crawling the same site every time. Could store in `reports/discover-{hostname}.json`.
2. **Should screenshots be JPEG instead of PNG?** The VLM performance doc notes JPEG q80 is 4-6x smaller with zero quality loss for VLM input. Frontend display quality is fine too.
3. **Max report size cleanup?** With screenshots, reports could be 20-100MB. Add a "Delete Report" button and maybe auto-cleanup after N reports.

---

*Generated from brainstorm: docs/brainstorms/2026-02-12-universal-site-review-brainstorm.md*
