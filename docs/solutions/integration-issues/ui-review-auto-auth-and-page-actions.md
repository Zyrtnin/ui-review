---
title: "Auto-Authentication and Per-Page Actions for UI Review"
project: "ui-review"
component: "bin/server.js, lib/capture.js"
problem_type: "Feature integration — authentication pipeline and interaction engine"
severity: "medium"
status: "implemented"
date_solved: "2026-02-12"
root_causes:
  - "Manual authentication workflow required user intervention before every review"
  - "No mechanism to interact with page elements during screenshot capture"
solution_category: "Pipeline integration + declarative action engine"
files_modified:
  - "bin/server.js"
  - "lib/capture.js"
  - "lib/config.js"
  - "public/index.html"
keywords:
  - "authentication"
  - "auto-login"
  - "Playwright"
  - "page-actions"
  - "SSE"
  - "storageState"
  - "declarative-actions"
  - "screenshot-capture"
---

# Auto-Authentication and Per-Page Actions for UI Review

## Context

The ui-review CLI tool captures screenshots via Playwright and analyzes them with a VLM (qwen3-vl:8b). Two limitations prevented testing authenticated or interactive pages:

1. **Auth gap**: Users had to click "Test Login" before running reviews. If forgotten, all screenshots showed the login page.
2. **No interaction**: The tool navigated to URLs and screenshot the initial state — no clicks, fills, hovers, or waits. Interactive UI bugs (broken modals, dropdowns, forms) went undetected.

## Design Decisions

### Auto-Auth: On-Demand, Transparent

The original flow was two-step: click "Test Login" → then "Run Review". The fix makes login **implicit** — if credentials are filled in the UI form but no auth state exists, they're sent with the review request and the server auto-logins.

**Key choice**: Send raw credentials with the request body, not store them server-side. The frontend caches the resulting `storageState` for subsequent reviews. This keeps the server stateless and avoids encrypted credential storage.

### Per-Page Actions: Declarative Objects

Actions are JSON objects (`{ click: ".btn" }`) rather than JavaScript callbacks. This enables:
- Manifest file portability (JSON/YAML config can define actions)
- Validation at config load time (reject bad action types early)
- Serializability (actions stored in report metadata for reproducibility)

## Solution

### Feature 1: Auto-Auth

#### Server: Accept Credentials, Auto-Login

Both `runReview()` and `runDiscover()` accept optional `credentials` in the request body. Changed `const` to `let` for `authState` destructuring so it can be reassigned after login:

```javascript
// bin/server.js — runReview()
let { baseUrl: bodyBaseUrl, pages: bodyPages = [], authState, credentials } = body;

// Auto-auth: if credentials provided but no authState, perform login
if (credentials && !authState && !watchSession) {
  const { loginUrl, username, password } = credentials;
  if (loginUrl && username && password) {
    try {
      sendEvent(res, 'progress', { status: 'auto-login', message: `Logging in to ${loginUrl}...` });
      const loginResult = await executeLogin({ baseUrl: bodyBaseUrl, loginUrl, username, password, allowPrivate });
      authState = loginResult.storageState;
      sendEvent(res, 'auth-ready', {
        storageState: loginResult.storageState,
        cookies: loginResult.cookies,
        redirectedTo: loginResult.redirectedTo,
      });
    } catch (err) {
      sendEvent(res, 'error', { message: `Auto-login failed: ${err.message}` });
      res.end();
      return;
    }
  }
}
```

#### Frontend: Send Credentials, Cache Auth State

```javascript
// public/index.html — startReview()
if (!currentAuthState) {
  const loginUrl = $('#loginUrl').value.trim();
  const username = $('#authUser').value.trim();
  const password = $('#authPass').value;
  if (loginUrl && username && password) {
    body.credentials = { loginUrl, username, password };
  }
}

// SSE handler: cache auth state from server
} else if (msg.event === 'auth-ready') {
  currentAuthState = msg.storageState;
  $('#authIndicator').textContent = 'authenticated';
  $('#authIndicator').className = 'auth-status ok';
}
```

#### Data Flow

```
User fills credentials → clicks "Run Review" (no Test Login needed)
  → Frontend: no currentAuthState? send credentials with request
  → Server: executeLogin() → Playwright fills form, submits, extracts cookies
  → Server sends SSE: auth-ready { storageState }
  → Frontend caches currentAuthState for reuse
  → Review proceeds with authentication
  → Subsequent reviews skip login (authState cached)
```

### Feature 2: Per-Page Actions

#### Action Execution Engine

```javascript
// lib/capture.js
const ACTION_TIMEOUT = 10_000; // 10s per individual action

async function executeActions(page, actions) {
  if (!actions || !Array.isArray(actions) || actions.length === 0) return;

  for (const action of actions) {
    if (action.click)                await page.click(action.click, { timeout: ACTION_TIMEOUT });
    else if (action.fill !== undefined) await page.fill(action.fill, action.value || '', { timeout: ACTION_TIMEOUT });
    else if (action.hover)           await page.hover(action.hover, { timeout: ACTION_TIMEOUT });
    else if (action.wait)            await page.waitForSelector(action.wait, { timeout: ACTION_TIMEOUT });
    else if (action.select !== undefined) await page.selectOption(action.select, action.value || '', { timeout: ACTION_TIMEOUT });
    else if (action.press)           await page.keyboard.press(action.press);
    else if (action.waitForNavigation) await page.waitForLoadState('networkidle', { timeout: ACTION_TIMEOUT });
    else if (action.delay)           await new Promise(r => setTimeout(r, Math.min(Math.max(0, action.delay), 10000)));
  }
}
```

#### Wired into Both Capture Paths

Actions execute after navigation and `waitFor`, before the font/stability wait and screenshot:

```javascript
// Fast path (watch mode — reused page)
await existingPage.goto(url.href, { waitUntil: 'networkidle', timeout: 30_000 });
if (waitFor) await existingPage.waitForSelector(waitFor, { timeout: 10_000 });
await executeActions(existingPage, actions);  // ← Here
await existingPage.evaluate(() => document.fonts.ready);

// Standard path (new browser context)
await page.goto(url.href, { waitUntil: 'networkidle', timeout: 30_000 });
if (waitFor) await page.waitForSelector(waitFor, { timeout: 10_000 });
await executeActions(page, actions);  // ← Here
await page.evaluate(() => document.fonts.ready);
```

#### Config Validation

```javascript
// lib/config.js — validateManifest()
if (page.actions) {
  if (!Array.isArray(page.actions)) throw new ConfigError(`...`);
  const validKeys = new Set(['click', 'fill', 'hover', 'wait', 'select', 'press', 'waitForNavigation', 'delay']);
  for (let i = 0; i < page.actions.length; i++) {
    const action = page.actions[i];
    const actionType = Object.keys(action).find(k => validKeys.has(k));
    if (!actionType) throw new ConfigError(`... has no recognized type`);
    if (action.delay !== undefined && (typeof action.delay !== 'number' || action.delay < 0 || action.delay > 10000))
      throw new ConfigError(`... delay must be 0-10000 ms`);
    if ((action.fill !== undefined || action.select !== undefined) && typeof action.value !== 'string')
      throw new ConfigError(`... requires a "value" string`);
  }
}
```

#### Frontend: Per-Page Actions Editor

Each page item gets an "actions" toggle that reveals a JSON textarea:

```javascript
// public/index.html
const pageActions = new Map();

// In createPageItem():
div.innerHTML = `
  <div class="page-item-row">
    <input type="checkbox" checked ...>
    <span>${name}</span>
    <span class="path">${path}</span>
    ${actionsBadge}
    <a class="actions-toggle" href="#">actions</a>
  </div>
  <div class="actions-editor">
    <label>Pre-screenshot actions (JSON array):</label>
    <textarea placeholder='[{ "click": ".btn" }, { "wait": ".modal" }]'></textarea>
    <div class="actions-hint">Types: click, fill (+value), hover, wait, select (+value), press, delay, waitForNavigation</div>
    <div class="actions-error"></div>
  </div>`;

// JSON validation on textarea change:
textarea.addEventListener('change', () => {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Must be a JSON array');
  pageActions.set(page.path, parsed);
  // Update badge count
});

// Include in request:
function getSelectedPages() {
  $$('#pageTree input:checked').forEach(cb => {
    const page = { name: cb.dataset.name, path: cb.dataset.path };
    const actions = pageActions.get(cb.dataset.path);
    if (actions?.length > 0) page.actions = actions;
    pages.push(page);
  });
}
```

## Key Insights

1. **`let` vs `const` for conditional reassignment**: Changing destructuring from `const` to `let` allows `authState` to be populated mid-function by auto-login. Simple but easy to miss.

2. **SSE as state transport**: The `auth-ready` SSE event carries the full `storageState` object back to the frontend, enabling client-side caching without server sessions.

3. **Declarative actions are portable**: JSON action objects can be defined in config files, validated at load time, stored in reports for reproducibility, and displayed in UI editors. Functions can't do any of that.

4. **Sequential with individual timeouts**: Each action has its own 10s timeout rather than a global budget. One slow selector doesn't consume the entire timeout.

5. **Optional parameters preserve backward compatibility**: `actions` defaults to `undefined` in `captureScreenshot()`. `executeActions()` no-ops on empty/missing arrays. Zero changes needed for existing workflows.

6. **Login success detection by URL change**: `executeLogin()` checks if the page URL changed from the login path. This works for redirect-based logins but fails for SPAs that stay on the same URL — a known limitation.

## Prevention Checklist

When extending the review pipeline:

- [ ] Are new request body fields destructured with `let` if they need conditional reassignment?
- [ ] Do SSE events carry enough state for the frontend to update independently?
- [ ] Is the new feature optional (no-op when not configured)?
- [ ] Are config values validated at load time, not at runtime?
- [ ] Do action timeouts apply per-item, not globally?
- [ ] Are errors from new features isolated (one page failure doesn't abort the review)?
- [ ] Does the feature work in both standard and watch mode paths?
- [ ] Are credentials/secrets excluded from logs, error messages, and report metadata?

## Related Documentation

- Plan: `docs/plans/2026-02-12-feat-persistent-watch-mode-and-token-auth-plan.md`
- Brainstorm: `docs/brainstorms/2026-02-12-watch-mode-and-auth-brainstorm.md`
- SSE lifecycle patterns: `docs/solutions/logic-errors/sse-response-lifecycle-management.md`
- Ollama streaming patterns: `docs/cloudflare-tunnel-streaming-guide.md`
