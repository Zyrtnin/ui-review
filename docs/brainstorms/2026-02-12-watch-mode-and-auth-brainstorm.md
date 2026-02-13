# Watch Mode + Auth Token Support

**Date:** 2026-02-12
**Status:** Brainstorm complete

## What We're Building

Two improvements to the ui-review tool:

1. **Persistent watch mode** — After a review completes, the browser stays open and can re-review pages on demand or at timed intervals. Currently the browser closes immediately after the review loop finishes (`finally` block in server.js:507-511).

2. **Auth token support for URL-based pages** — Some pages (e.g., FlipperHub's `tournament_entry.html?token=XYZ`) require URL-based tokens for access. The review tool should automatically obtain these tokens via the authenticated session and inject them into page URLs.

## Why This Approach

### Watch Mode: Manual re-trigger + optional polling

**Decision:** Keep browser open after review. Support both manual re-trigger (API/UI button) and optional timed polling.

**Why not file watching?**
- Tool will run on a VPS, potentially separate from the target app
- File watcher (`fs.watch`/chokidar) requires filesystem access to the target app
- HTTP-based approaches work regardless of deployment topology

**How it works:**
- SSE stream stays alive after initial review completes (sends `review-complete` event but doesn't close)
- Browser window remains open and visible
- Re-review triggers:
  - **Manual:** `POST /api/review/:reportId/rerun` or SSE message from client
  - **Polling:** Optional `pollInterval` param (e.g., 300000 = 5 min). Periodically re-captures pages, compares screenshots via pixel diff, only re-analyzes pages that changed visually
- Re-reviews send new `result` events on the same SSE stream
- Browser crash recovery: detect browser disconnection, auto-relaunch + restore auth state

### Auth: Login once + auto-generate URL tokens

**Decision:** Two-tier auth system.

**Tier 1 — Session auth (already exists):**
- Call `/api/auth/login` with credentials → get `storageState`
- Pass `storageState` to review → browser has authenticated cookies

**Tier 2 — URL token injection (new):**
- Pages can declare they need a dynamic token
- The review tool fetches the token from a configurable endpoint using the authenticated session
- Token is appended to the page URL before capture

**Page config example:**
```json
{
  "name": "Tournament Entry",
  "path": "/tournament_entry.html",
  "tokenAuth": {
    "endpoint": "/generate_player_token.php",
    "method": "POST",
    "body": { "tournament_id": "current" },
    "responseField": "token",
    "queryParam": "token"
  }
}
```

**Why not just pass tokens manually in page paths?**
- Tokens expire — stale tokens break reviews
- Manual token generation is tedious for repeated/scheduled reviews
- Auto-generation makes polling mode viable (tokens refresh each cycle)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Watch mode trigger | Manual + optional polling | Works on VPS, no filesystem dependency |
| Re-review scope | All pages | Simpler, a CSS change affects everything |
| Browser lifecycle | Keep open until server stop or explicit close | Standard dev tool pattern |
| Session auth | Login-once via API | Already implemented |
| URL token auth | Auto-fetch from configurable endpoint | Supports expiring tokens, enables polling |
| Screenshot diff for polling | Pixel comparison before re-analyzing | Avoids wasting GPU cycles on unchanged pages |

## Open Questions

1. **Polling screenshot diff threshold** — How much pixel difference triggers a re-review? Need to ignore minor rendering jitter (anti-aliasing, cursor blink, etc.). Something like >1% pixel difference?

2. **Token endpoint format** — Is the `tokenAuth` config format flexible enough for different apps, or do we need something more generic (like running arbitrary JS in the authenticated browser)?

3. **Concurrent requests** — If a re-review is in progress and another file change / poll fires, should we queue (at most 1 pending) or drop it?

4. **Watch mode UI** — The frontend needs UI for: re-review button, polling status indicator, browser crash notification. Is this in scope for the initial implementation?

## Out of Scope

- File system watching (not viable for VPS deployment)
- Multi-browser support (one browser instance per watch session)
- CI/CD webhook integration (can be added later)
- Automatic page discovery in watch mode (use the existing discover endpoint separately)
