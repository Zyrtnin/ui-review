---
title: "SSE Watch Mode Browser Persistence Fix"
project: "ui-review"
component: "bin/server.js"
problem_type: "Resource lifecycle management in SSE streaming server"
severity: "medium"
status: "solved"
date_solved: "2026-02-12"
root_causes:
  - "Unconditional browser.close() in finally block killed watch session browsers"
  - "Unhandled write-to-closed-stream errors in sendEvent() broke control flow and prevented watch session storage"
solution_category: "Error handling + conditional resource cleanup"
files_modified:
  - "bin/server.js"
  - "lib/capture.js"
  - "lib/errors.js"
  - "public/index.html"
keywords:
  - "SSE"
  - "browser persistence"
  - "watch mode"
  - "error handling"
  - "resource cleanup"
  - "Playwright"
  - "Node.js HTTP"
---

# SSE Watch Mode Browser Persistence Fix

## Context

The ui-review CLI's SSE-based review server uses Playwright to capture screenshots and analyze them with a VLM. Watch mode was implemented to keep the browser alive after a review completes, allowing re-triggers without relaunching.

The browser kept closing immediately after every review, making watch mode non-functional.

## Root Cause

Two interacting bugs in `runReview()`:

### Bug 1: Unconditional Browser Cleanup

The `finally` block always closed the browser, regardless of watch mode:

```javascript
// WRONG — closes browser unconditionally
finally {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
  }
}
```

### Bug 2: Response Write Errors Breaking Control Flow

Even after making the finally block conditional, watch sessions still weren't stored. The `sendEvent(res, 'done', ...)` call before the finally block threw when the SSE client had disconnected. This exception jumped to the catch block, and the finally block's conditional logic didn't execute properly.

```
Expected flow:
  1. Review completes → 2. Send 'done' → 3. Finally: store browser

Actual flow:
  1. Review completes → 2. Client disconnects → 3. sendEvent throws →
  4. Catch block runs → 5. sendEvent('error') ALSO throws →
  6. Finally: browser state is corrupted, session never stored
```

## Solution

### Fix 1: Conditional Finally Block

Three distinct code paths based on resource ownership:

```javascript
finally {
  if (watchSession) {
    // Re-trigger: browser is borrowed — just mark not in-progress
    watchSession.reviewInProgress = false;
  } else if (sharedBrowser && isWatchSession) {
    // New watch: store browser for re-use, don't close
    watchSessions.set(report.id, { browser: sharedBrowser, page: sharedPage, ... });
  } else if (sharedBrowser) {
    // Non-watch: close browser immediately
    await sharedBrowser.close().catch(() => {});
  }
}
```

### Fix 2: Try-Catch All Response Writes

Every `sendEvent()` and `res.end()` after the main loop is wrapped:

```javascript
// End of try block
try { sendEvent(res, 'done', { summary, reportId }); } catch {}

// In catch block
try { sendEvent(res, 'error', { message: err.message }); } catch {}

// In finally block
try { sendEvent(res, 'watch-ready', { reportId }); } catch {}

// After finally
try { res.end(); } catch {}
```

### Fix 3: Client Disconnect Handler

Abort GPU work but NOT the browser:

```javascript
req.on('close', () => {
  aborted = true;
  reviewAbort.abort();  // Cancel in-flight Ollama request
  // Note: browser stays open in watch mode
});
```

## Key Insight

In Node.js HTTP servers, **writing to a closed response stream throws an exception**. In SSE flows, clients may disconnect at any time. If cleanup logic depends on code that runs after a `res.write()`, it will silently fail when the client is gone.

**Rule:** Place critical cleanup logic (session storage, resource management) BEFORE any potentially-throwing response writes. Or wrap all writes in try-catch.

**Anti-pattern:**
```javascript
sendEvent(res, 'watch-ready', { reportId }); // Throws if client gone
watchSessions.set(reportId, session);        // Never reached!
```

**Correct:**
```javascript
watchSessions.set(reportId, session);        // Always runs
try { sendEvent(res, 'watch-ready', { reportId }); } catch {} // May throw — swallowed
```

## Prevention Checklist

When reviewing SSE/streaming server code:

- [ ] Does the `finally` block have conditional cleanup based on resource ownership?
- [ ] Are ALL `res.write()` / `res.end()` calls wrapped in try-catch?
- [ ] Does `req.on('close')` set a flag instead of doing cleanup directly?
- [ ] Are long-lived resources (browsers, connections) stored in a Map, not tied to request lifecycle?
- [ ] Is there a shutdown handler that cleans up all persistent resources?

## Related Documentation

- Plan: `docs/plans/2026-02-12-feat-persistent-watch-mode-and-token-auth-plan.md`
- Brainstorm: `docs/brainstorms/2026-02-12-watch-mode-and-auth-brainstorm.md`
- SSE streaming patterns: `docs/solutions/integration-issues/ollama-vlm-cloudflare-tunnel-streaming.md`
