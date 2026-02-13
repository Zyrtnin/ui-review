---
title: "feat: Persistent watch mode with token auth"
type: feat
date: 2026-02-12
brainstorm: docs/brainstorms/2026-02-12-watch-mode-and-auth-brainstorm.md
---

# Persistent Watch Mode with Token Auth

## Overview

Two changes to the ui-review server:

1. **Persistent watch mode** — Browser stays open after review completes. Users can re-trigger reviews manually or via optional polling. Currently the `finally` block in `bin/server.js:507-511` always closes the browser.

2. **URL token auth** — Pages that require URL-based tokens (e.g., `?token=XYZ`) can declare a `tokenAuth` config. The server auto-fetches tokens from a configurable endpoint using the authenticated session, then injects them into page URLs before capture.

## Problem Statement

**Watch mode:** The browser opens, captures screenshots, then immediately closes when the review loop finishes. This defeats the purpose — users can't see the pages being reviewed, can't interact with the browser, and can't re-run reviews without starting a new session.

**Token auth:** Some pages require URL-based authentication tokens (not session cookies). These tokens expire, so hardcoding them in page paths is fragile. Polling mode is impossible without auto-refreshing tokens.

## Technical Approach

### Architecture

**Server-side watch session state:**

```
watchSessions: Map<reportId, {
  browser,      // Playwright browser instance
  page,         // Persistent page object
  authState,    // storageState for re-auth
  config,       // Review config snapshot
  pages,        // Page list
  viewports,    // Viewport list
  pollTimer,    // setInterval ID (if polling)
  reviewInProgress, // mutex flag
}>
```

The key architectural change: browser lifecycle is decoupled from the SSE request lifecycle. The browser persists server-side across multiple request/response cycles.

**Request flow:**

```
Initial review:  POST /api/review { watchMode: true }
                 → SSE stream → done + watch-ready → stream closes
                 → browser stays open in watchSessions map

Re-trigger:      POST /api/review { reportId: "review-XXX" }
                 → new SSE stream → re-reviews all pages → done → stream closes
                 → browser still open

Stop watch:      POST /api/watch/:reportId/stop
                 → closes browser, removes from map, clears poll timer
```

### Implementation Phases

#### Phase 1: Persistent Browser Lifecycle

**Goal:** Browser stays open after review completes in watch mode. Manual re-trigger works.

**Files changed:**
- `bin/server.js` — Watch session management, re-trigger support

**Tasks:**

- [x] Add `watchSessions` Map at module level in `bin/server.js`
- [x] In `runReview()`, when `watchMode` is true: after the review loop's `done` event, store `{ browser, page, authState, config, pages, viewports }` in `watchSessions` keyed by `report.id`. Send a `watch-ready` event. Do NOT close the browser in the `finally` block.
- [x] In `runReview()`, when `watchMode` is false (default): keep existing behavior — close browser in `finally`
- [x] When a review request includes `reportId` AND that reportId is in `watchSessions`: reuse the stored browser/page instead of launching a new one. Run the review loop, send results on the new SSE stream, then keep the browser open.
- [x] Add `POST /api/watch/:reportId/stop` endpoint: close browser, clear poll timer, remove from `watchSessions`
- [x] Add `GET /api/watch` endpoint: return list of active watch sessions `[{ reportId, baseUrl, startedAt }]`
- [x] Handle `req.on('close')` correctly: when the SSE client disconnects during watch mode, do NOT close the browser (it should persist). Only abort in-flight GPU work.
- [x] On server shutdown (`process.on('SIGINT'/'SIGTERM')`): close all browsers in `watchSessions`

**Key code change in `runReview()` finally block:**

```javascript
// bin/server.js — replace lines 506-511
} finally {
  if (sharedBrowser && !watchMode) {
    await sharedBrowser.close().catch(() => {});
  } else if (sharedBrowser && watchMode && !aborted) {
    // Store for re-use
    watchSessions.set(report.id, {
      browser: sharedBrowser,
      page: sharedPage,
      authState,
      config,
      pages,
      viewports: resolvedViewports,
      pollTimer: null,
      reviewInProgress: false,
      startedAt: new Date().toISOString(),
    });
    sendEvent(res, 'watch-ready', { reportId: report.id });
  } else if (sharedBrowser) {
    // Aborted — clean up
    await sharedBrowser.close().catch(() => {});
  }
}
```

**Acceptance criteria:**
- [ ] `watchMode: true` review completes, browser window stays open
- [ ] `POST /api/review { reportId: "review-XXX" }` re-reviews using the same browser
- [ ] `POST /api/watch/:reportId/stop` closes the browser
- [ ] Client SSE disconnect does NOT close the watch mode browser
- [ ] Server shutdown closes all watch browsers

---

#### Phase 2: URL Token Auth

**Goal:** Pages with `tokenAuth` config automatically get fresh tokens injected into their URLs.

**Files changed:**
- `bin/server.js` — Token generation before capture
- `lib/config.js` — Manifest validation for `tokenAuth`

**Tasks:**

- [x] Add `tokenAuth` validation to `validateManifest()` in `lib/config.js:131-149` (inside the pages loop). Validate: `endpoint` (string, starts with `/`), `method` (GET or POST), `body` (optional object), `responseField` (string), `queryParam` (string).
- [x] Add `generatePageToken()` helper function in `bin/server.js`:

```javascript
// bin/server.js
async function generatePageToken({ page, baseUrl, authState, allowPrivate }) {
  const { tokenAuth } = page;
  if (!tokenAuth) return null;

  const tokenUrl = baseUrl.replace(/\/$/, '') + tokenAuth.endpoint;

  // Use authenticated fetch — convert storageState cookies to Cookie header
  const cookies = (authState?.cookies || [])
    .filter(c => tokenUrl.includes(c.domain) || !c.domain)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const resp = await fetch(tokenUrl, {
    method: tokenAuth.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: tokenAuth.method === 'GET' ? undefined : JSON.stringify(tokenAuth.body || {}),
  });

  if (!resp.ok) throw new Error(`Token endpoint returned ${resp.status}`);
  const data = await resp.json();

  // Extract token from response using dot-path (e.g., "data.token")
  const token = tokenAuth.responseField.split('.').reduce((obj, key) => obj?.[key], data);
  if (!token) throw new Error(`Token field "${tokenAuth.responseField}" not found in response`);

  return { queryParam: tokenAuth.queryParam, value: token };
}
```

- [x] In the review loop (server.js, before `captureScreenshot()`), call `generatePageToken()` and append the token to `fullUrl`:

```javascript
// Before line 367 (captureScreenshot call)
let captureUrl = fullUrl;
if (page.tokenAuth && authState) {
  try {
    sendEvent(res, 'progress', {
      status: 'token',
      page: pageLabel,
      message: `Generating auth token for ${pageLabel}...`,
    });
    const token = await generatePageToken({ page, baseUrl, authState, allowPrivate });
    if (token) {
      const sep = captureUrl.includes('?') ? '&' : '?';
      captureUrl = `${captureUrl}${sep}${token.queryParam}=${encodeURIComponent(token.value)}`;
    }
  } catch (err) {
    sendEvent(res, 'page-error', {
      page: pageLabel,
      viewport: viewport.name,
      message: `Token generation failed: ${err.message}`,
    });
    continue; // Skip this page×viewport combo
  }
}
```

- [x] Generate tokens **per-page** (not once at start), since tokens may be page-specific and can expire during long reviews
- [x] In re-trigger (Phase 1), re-generate tokens each cycle to handle expiration

**Acceptance criteria:**
- [ ] Page with `tokenAuth` config gets a fresh token injected into its URL
- [ ] Token generation failure for one page doesn't abort the entire review
- [ ] `progress` SSE event with status `token` sent during token generation
- [ ] Manifest validation rejects invalid `tokenAuth` schemas
- [ ] Tokens are re-generated on each review cycle (not cached across re-triggers)

---

#### Phase 3: Optional Polling

**Goal:** Watch sessions can optionally poll at a configurable interval, only re-analyzing pages whose screenshots changed.

**Files changed:**
- `bin/server.js` — Poll timer management
- `package.json` — Add `pixelmatch` dependency

**Tasks:**

- [x] Add `pixelmatch` dependency: `npm install pixelmatch pngjs`
- [x] Add `pollInterval` parameter to review request body parsing (server.js:224). Minimum 60000ms (1 minute).
- [ ] After watch session is stored (Phase 1), if `pollInterval` is set, start a `setInterval` timer:

```javascript
if (pollInterval && pollInterval >= 60000) {
  session.pollTimer = setInterval(() => {
    if (!session.reviewInProgress) {
      runPollCycle(report.id);
    }
  }, pollInterval);
}
```

- [x] Implement `runPollCycle(reportId)`:
  1. Set `session.reviewInProgress = true`
  2. For each page×viewport, capture screenshot using existing browser/page
  3. Compare with previous screenshot using `pixelmatch` (threshold: 0.1, >0.5% pixel diff = changed)
  4. Only send changed screenshots to VLM for re-analysis
  5. Update report with new results
  6. Set `session.reviewInProgress = false`
  7. Store results in report — any connected SSE client gets the updates

- [x] Implement screenshot comparison helper:

```javascript
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

function screenshotsChanged(buf1, buf2, threshold = 0.005) {
  const img1 = PNG.sync.read(buf1);
  const img2 = PNG.sync.read(buf2);
  if (img1.width !== img2.width || img1.height !== img2.height) return true;
  const totalPixels = img1.width * img1.height;
  const diffCount = pixelmatch(img1.data, img2.data, null, img1.width, img1.height, { threshold: 0.1 });
  return (diffCount / totalPixels) > threshold;
}
```

- [x] Clear poll timer in `POST /api/watch/:reportId/stop`
- [x] Clear poll timer on server shutdown

**Acceptance criteria:**
- [ ] `pollInterval: 300000` polls every 5 minutes
- [ ] Unchanged pages are skipped (no GPU usage)
- [ ] Changed pages are re-analyzed and report is updated
- [ ] Poll timer is cleared when watch session stops
- [ ] Concurrent poll cycles are prevented (mutex flag)

---

#### Phase 4: Browser Crash Recovery

**Goal:** If the Playwright browser crashes during a watch session, auto-relaunch it.

**Files changed:**
- `bin/server.js` — Crash detection and recovery

**Tasks:**

- [x] After storing watch session, listen for browser disconnect:

```javascript
sharedBrowser.on('disconnected', async () => {
  const session = watchSessions.get(report.id);
  if (!session) return; // Already cleaned up

  try {
    const newBrowser = await launchBrowser({ headless: false });
    const ctx = await newBrowser.newContext({
      ignoreHTTPSErrors: true,
      ...(session.authState ? { storageState: session.authState } : {}),
    });
    session.browser = newBrowser;
    session.page = await ctx.newPage();
    // Note: no SSE stream may be connected — recovery is silent
  } catch {
    // Recovery failed — remove watch session
    watchSessions.delete(report.id);
  }
});
```

- [x] In `captureScreenshot()`, if `existingPage` throws an error that indicates browser death (e.g., "Target page, context or browser has been closed"), throw a typed error so the caller can distinguish browser crash from page-level errors
- [x] In the review loop, catch browser crash errors and attempt one recovery before failing the page

**Acceptance criteria:**
- [ ] Browser crash during idle watch → auto-relaunched
- [ ] Browser crash during capture → one recovery attempt, then fail
- [ ] Auth state preserved across browser recovery

---

#### Phase 5: Frontend UI

**Goal:** UI controls for watch mode session management.

**Files changed:**
- `public/index.html` — Watch mode controls

**Tasks:**

- [x] After review completes with `watch-ready` event, show watch mode control panel:
  - "Re-review" button → calls `POST /api/review { reportId }` and streams new results
  - "Stop watching" button → calls `POST /api/watch/:reportId/stop`
  - Status indicator: "Watching — browser open" / "Polling every 5m" / "Re-reviewing..."
- [x] Add polling interval input (dropdown: Off / 1m / 5m / 15m / 30m)
- [x] Handle `watch-ready` SSE event to transition UI to watch state
- [x] On re-review, show progress events inline (same as initial review) and update result cards in-place
- [x] Show notification if browser crash recovery occurs (via polling `GET /api/watch`)

**Acceptance criteria:**
- [ ] Re-review button triggers a new review cycle using existing browser
- [ ] Stop button closes browser and returns to normal state
- [ ] Polling dropdown starts/stops polling timer
- [ ] Results update in-place during re-review

## Alternative Approaches Considered

**File system watching (rejected):** Requires filesystem access to the target app. Tool will run on VPS, potentially separate from the target app. HTTP-based approaches are deployment-agnostic.

**WebSocket instead of SSE (rejected):** Would require adding `ws` dependency and changing the streaming architecture. SSE works fine for server→client push. Re-triggers use separate POST requests.

**Keep SSE stream alive indefinitely (rejected):** CF tunnel may close idle connections. Storing the `res` object server-side is fragile. Separate request per review cycle is more robust.

## Dependencies & Prerequisites

**New npm packages:**
- `pixelmatch` — Pixel-level image comparison (Phase 3 only)
- `pngjs` — PNG encoding/decoding for pixelmatch (Phase 3 only)

**Existing infrastructure used:**
- `/api/auth/login` endpoint (server.js:94-140) — already works
- `authState`/`storageState` flow (server.js:225, 305, 375) — already wired
- `launchBrowser()` helper (capture.js:181-183) — already exported
- `captureScreenshot()` page reuse (capture.js:86-107) — already implemented

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Memory leak from long-lived browser | Medium | Medium | Track session count, auto-close after N hours or N reviews |
| CF tunnel closes idle SSE | Low | Low | Each review cycle is a separate SSE stream — no idle connections |
| Token endpoint changes format | Low | Medium | `responseField` supports dot-path notation for nested responses |
| Pixelmatch false positives (anti-aliasing) | Medium | Low | Configurable threshold (default 0.5%), `pixelmatch` threshold option |

## References

### Internal
- Brainstorm: `docs/brainstorms/2026-02-12-watch-mode-and-auth-brainstorm.md`
- Watch mode browser setup: `bin/server.js:296-314`
- Browser close (the bug): `bin/server.js:507-511`
- Auth login flow: `bin/server.js:94-140`
- Capture page reuse: `lib/capture.js:86-107`
- Config validation: `lib/config.js:106-162`
- Frontend SSE handling: `public/index.html:1090-1230`
- CF tunnel streaming guide: `docs/cloudflare-tunnel-streaming-guide.md`

### External
- Playwright `browser.on('disconnected')`: Playwright docs
- `pixelmatch` library: npmjs.com/package/pixelmatch
