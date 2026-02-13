#!/usr/bin/env node

import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, VIEWPORTS } from '../lib/config.js';
import { healthCheck, prewarm, analyze, parseVlmJson } from '../lib/ollama.js';
import { captureScreenshot, launchBrowser } from '../lib/capture.js';
import { loadPrompt } from '../lib/prompts.js';
import { sanitizeResult } from '../lib/report.js';
import { discoverPages } from '../lib/discover.js';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3000', 10);
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const REPORTS_DIR = join(import.meta.dirname, '..', 'reports');

const ENVS_DIR = join(import.meta.dirname, '..', 'data', 'environments');

// Ensure directories exist
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(ENVS_DIR, { recursive: true });

// --- Environment State Persistence ---

function slugify(name) {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function listEnvironments() {
  if (!existsSync(ENVS_DIR)) return [];
  return readdirSync(ENVS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(readFileSync(join(ENVS_DIR, f), 'utf8'));
        return {
          name: data.name,
          url: data.url,
          lastDiscoveredAt: data.lastDiscoveredAt,
          updatedAt: data.updatedAt,
          pageCount: (data.discoveredPages || []).length,
        };
      } catch { return null; }
    })
    .filter(Boolean);
}

function loadEnvironmentState(name) {
  const filePath = join(ENVS_DIR, `${slugify(name)}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveEnvironmentState(name, data) {
  const filePath = join(ENVS_DIR, `${slugify(name)}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function deleteEnvironmentState(name) {
  const filePath = join(ENVS_DIR, `${slugify(name)}.json`);
  try {
    unlinkSync(filePath);
  } catch {}
}

/**
 * Active watch sessions — browser persists across SSE request cycles.
 * @type {Map<string, { browser, page, authState, config, pages, viewports, pollTimer, reviewInProgress, startedAt, baseUrl, allowPrivate }>}
 */
const watchSessions = new Map();

/** Send an SSE event line. */
function sendEvent(res, event, data) {
  res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
}

/**
 * Start an SSE keepalive interval that sends comment lines to prevent
 * Cloudflare tunnel idle timeouts (~100s). SSE comments (lines starting
 * with ':') are ignored by EventSource clients but keep the connection alive.
 * @param {import('http').ServerResponse} res
 * @param {number} intervalMs - keepalive interval (default 15s)
 * @returns {NodeJS.Timeout} interval handle — call clearInterval() when done
 */
function startSSEKeepalive(res, intervalMs = 15_000) {
  return setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // Connection already closed — caller will clean up
    }
  }, intervalMs);
}

/** Read request body as JSON. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Load Ollama config from .env (reuses existing config module). */
function getOllamaConfig(overrides = {}) {
  return loadConfig({ cliArgs: { debug: true, ...overrides } });
}

/** Composite key for a page×viewport result. */
function resultKey(pageName, viewportName) {
  return `${pageName}::${viewportName}`;
}

/** Sanitize a name for use as a filename. */
function sanitizeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

/** Save report to disk. */
function saveReport(report) {
  const filePath = join(REPORTS_DIR, `${report.id}.json`);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
}

/** Load a report by ID. */
function loadReport(id) {
  const filePath = join(REPORTS_DIR, `${id}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** List all reports, newest first. */
function listReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf8'));
        return {
          id: data.id,
          baseUrl: data.baseUrl,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          status: data.status,
          resultCount: Object.keys(data.results || {}).length,
          totalExpected: data.totalExpected || 0,
          summary: data.summary,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/** Execute a login flow using Playwright and return storageState. */
async function executeLogin({ baseUrl, loginUrl, username, password, allowPrivate = false }) {
  const { chromium } = await import('playwright');

  const fullLoginUrl = baseUrl.replace(/\/$/, '') + loginUrl;
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    await page.goto(fullLoginUrl, { waitUntil: 'networkidle', timeout: 15000 });

    // Auto-detect form fields
    const usernameField = await page.$('input[type="text"], input[type="email"], input[name*="user"], input[name*="email"], input[id*="user"], input[name*="login"]');
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
    const currentPath = new URL(currentUrl).pathname;
    if (currentPath === loginUrl || currentPath === loginUrl.replace(/\/$/, '')) {
      const errorText = await page.$eval('.error, .alert-danger, .alert-error, [class*="error"]', el => el.textContent).catch(() => '');
      throw new Error(`Login failed${errorText ? ': ' + errorText.trim() : ' — still on login page'}`);
    }

    const state = await context.storageState();
    const cookies = (state.cookies || []).length;
    await context.close();

    return { storageState: state, redirectedTo: currentPath, cookies };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Generate a URL token for a page that requires tokenAuth.
 * Uses authenticated fetch with cookies from storageState.
 */
async function generatePageToken({ page, baseUrl, authState }) {
  const { tokenAuth } = page;
  if (!tokenAuth) return null;

  const tokenUrl = baseUrl.replace(/\/$/, '') + tokenAuth.endpoint;

  // Convert storageState cookies to Cookie header
  const cookies = (authState?.cookies || [])
    .filter(c => {
      if (!c.domain) return true;
      const host = new URL(tokenUrl).hostname;
      return host === c.domain || host.endsWith('.' + c.domain);
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const method = tokenAuth.method || 'POST';
  const resp = await fetch(tokenUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(tokenAuth.body || {}),
  });

  if (!resp.ok) throw new Error(`Token endpoint returned ${resp.status}`);
  const data = await resp.json();

  // Extract token using dot-path (e.g., "data.token" → data["data"]["token"])
  const token = tokenAuth.responseField.split('.').reduce((obj, key) => obj?.[key], data);
  if (!token) throw new Error(`Token field "${tokenAuth.responseField}" not found in response`);

  return { queryParam: tokenAuth.queryParam, value: String(token) };
}

/**
 * Compare two PNG buffers. Returns true if they differ by more than threshold.
 */
function screenshotsChanged(buf1, buf2, threshold = 0.005) {
  const img1 = PNG.sync.read(buf1);
  const img2 = PNG.sync.read(buf2);
  if (img1.width !== img2.width || img1.height !== img2.height) return true;
  const totalPixels = img1.width * img1.height;
  const diffCount = pixelmatch(img1.data, img2.data, null, img1.width, img1.height, { threshold: 0.1 });
  return (diffCount / totalPixels) > threshold;
}

/**
 * Run a poll cycle for a watch session.
 * Re-captures all pages, diffs screenshots, and only re-analyzes changed ones.
 */
async function runPollCycle(reportId) {
  const session = watchSessions.get(reportId);
  if (!session || session.reviewInProgress) return;

  session.reviewInProgress = true;
  const report = loadReport(reportId);
  if (!report) {
    session.reviewInProgress = false;
    return;
  }

  const { browser, page: sharedPage, config, pages, viewports, baseUrl, authState, allowPrivate } = session;
  const systemPrompt = loadPrompt('review-system');

  try {
    for (const pg of pages) {
      // Generate token if needed
      let tokenSuffix = '';
      if (pg.tokenAuth && authState) {
        try {
          const token = await generatePageToken({ page: pg, baseUrl, authState });
          if (token) {
            const sep = pg.path.includes('?') ? '&' : '?';
            tokenSuffix = `${sep}${token.queryParam}=${encodeURIComponent(token.value)}`;
          }
        } catch { continue; }
      }

      for (const viewport of viewports) {
        const key = resultKey(pg.name, viewport.name);
        const fullUrl = baseUrl.replace(/\/$/, '') + pg.path + tokenSuffix;

        try {
          // Capture new screenshot
          const buffer = await captureScreenshot({
            url: fullUrl,
            viewport,
            config,
            allowPrivate,
            headless: false,
            browser,
            page: sharedPage,
            actions: pg.actions || undefined,
          });

          // Compare with previous screenshot
          const screenshotDir = join(REPORTS_DIR, reportId, 'screenshots');
          const screenshotFilename = `${sanitizeName(pg.name)}_${viewport.name}.png`;
          const prevPath = join(screenshotDir, screenshotFilename);

          let changed = true;
          if (existsSync(prevPath)) {
            const prevBuffer = readFileSync(prevPath);
            changed = screenshotsChanged(prevBuffer, buffer);
          }

          if (!changed) continue; // Screenshot unchanged — skip analysis

          // Save new screenshot
          mkdirSync(screenshotDir, { recursive: true });
          writeFileSync(join(screenshotDir, screenshotFilename), buffer);

          // Re-analyze changed page
          const prompt = loadPrompt('review', {
            url: fullUrl,
            viewport: viewport.name,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
          });

          const raw = await analyze({ config, systemPrompt, prompt, images: [buffer] });
          let result = sanitizeResult(raw, { url: fullUrl, viewport: viewport.name });

          if (result._raw && result.summary) {
            const retried = parseVlmJson(result.summary);
            if (!retried._raw) {
              result = sanitizeResult(retried, { url: fullUrl, viewport: viewport.name });
            }
          }

          result.screenshot = `screenshots/${screenshotFilename}`;
          result.pollCycleAt = new Date().toISOString();
          report.results[key] = result;
          delete report.errors[key];
        } catch (err) {
          report.errors[key] = { message: `Poll cycle error: ${err.message}`, timestamp: new Date().toISOString() };
        }
      }
    }

    // Recalculate summary
    report.summary = { pages: 0, issues: 0, critical: 0, warning: 0, suggestion: 0 };
    report.summary.pages = Object.keys(report.results).length;
    for (const r of Object.values(report.results)) {
      for (const issue of r.issues || []) {
        report.summary.issues++;
        report.summary[issue.severity] = (report.summary[issue.severity] || 0) + 1;
      }
    }
    report.updatedAt = new Date().toISOString();
    saveReport(report);
  } catch {
    // Poll cycle failed — will retry next interval
  } finally {
    session.reviewInProgress = false;
  }
}

/** Discover pages on a site, streaming SSE events. */
async function runDiscover(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const keepaliveTimer = startSSEKeepalive(res);
  const endStream = () => {
    clearInterval(keepaliveTimer);
    try { res.end(); } catch {}
  };

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendEvent(res, 'error', { message: 'Invalid request body' });
    endStream();
    return;
  }

  let { baseUrl, maxPages = 50, allowPrivate = false, authState, credentials } = body;

  if (!baseUrl) {
    sendEvent(res, 'error', { message: 'baseUrl is required' });
    endStream();
    return;
  }

  // Auto-auth: if credentials provided but no authState, perform login automatically
  if (credentials && !authState) {
    const { loginUrl, username, password } = credentials;
    if (baseUrl && loginUrl && username && password) {
      try {
        sendEvent(res, 'discover-progress', { message: `Logging in to ${loginUrl}...` });
        const loginResult = await executeLogin({ baseUrl, loginUrl, username, password, allowPrivate });
        authState = loginResult.storageState;
        sendEvent(res, 'auth-ready', {
          storageState: loginResult.storageState,
          cookies: loginResult.cookies,
          redirectedTo: loginResult.redirectedTo,
        });
      } catch (err) {
        sendEvent(res, 'error', { message: `Auto-login failed: ${err.message}` });
        endStream();
        return;
      }
    }
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const result = await discoverPages({
      baseUrl,
      maxPages,
      allowPrivate,
      storageState: authState || undefined,
      signal: controller.signal,
      onProgress: (message) => {
        sendEvent(res, 'discover-progress', { message });
      },
      onPage: (page) => {
        sendEvent(res, 'discover-page', { page });
      },
    });

    sendEvent(res, 'discover-complete', {
      total: result.pages.length,
      source: result.source,
      totalLinksFound: result.totalLinksFound,
      pagesSkipped: result.pagesSkipped,
    });
  } catch (err) {
    sendEvent(res, 'discover-error', { message: err.message });
  }

  endStream();
}

/** Run reviews for pages × viewports, streaming SSE events. */
async function runReview(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Keep CF tunnel alive during long VLM analysis (70-640s per page)
  const keepaliveTimer = startSSEKeepalive(res);

  /** Clean up keepalive and end the SSE stream. */
  const endStream = () => {
    clearInterval(keepaliveTimer);
    try { res.end(); } catch {}
  };

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendEvent(res, 'error', { message: 'Invalid request body' });
    endStream();
    return;
  }

  let {
    baseUrl: bodyBaseUrl,
    pages: bodyPages = [],
    viewports = ['desktop'],
    allowPrivate = false,
    reportId,       // Resume existing report
    skipCompleted,  // Array of "page::viewport" keys to skip
    watchMode = false,
    pollInterval,   // Optional polling interval in ms (min 60000)
    authState,
    credentials,    // Optional: { loginUrl, username, password } for auto-login
  } = body;

  // Check if this is a watch session re-trigger
  const watchSession = reportId ? watchSessions.get(reportId) : null;

  // Auto-auth: if credentials provided but no authState, perform login automatically
  if (credentials && !authState && !watchSession) {
    const { loginUrl, username, password } = credentials;
    if (loginUrl && username && password) {
      try {
        sendEvent(res, 'progress', { status: 'auto-login', message: `Logging in to ${loginUrl}...` });
        const loginResult = await executeLogin({
          baseUrl: bodyBaseUrl,
          loginUrl,
          username,
          password,
          allowPrivate,
        });
        authState = loginResult.storageState;
        sendEvent(res, 'auth-ready', {
          storageState: loginResult.storageState,
          cookies: loginResult.cookies,
          redirectedTo: loginResult.redirectedTo,
        });
      } catch (err) {
        sendEvent(res, 'error', { message: `Auto-login failed: ${err.message}` });
        endStream();
        return;
      }
    }
  }

  // For re-triggers, use stored values; for new reviews, use request body
  const baseUrl = watchSession?.baseUrl || bodyBaseUrl;
  const pages = (bodyPages.length ? bodyPages : watchSession?.pages) || [];

  if (!baseUrl || !pages.length) {
    sendEvent(res, 'error', { message: 'baseUrl and at least one page are required' });
    endStream();
    return;
  }

  const resolvedViewports = viewports.map(name => {
    const vp = VIEWPORTS[name];
    if (!vp) return null;
    return { name, ...vp };
  }).filter(Boolean);

  if (!resolvedViewports.length) {
    sendEvent(res, 'error', { message: 'No valid viewports selected' });
    endStream();
    return;
  }

  let config;
  try {
    config = getOllamaConfig();
  } catch (err) {
    sendEvent(res, 'error', { message: `Config error: ${err.message}` });
    endStream();
    return;
  }

  // Load or create report
  let report;
  if (reportId) {
    report = loadReport(reportId);
    if (!report) {
      sendEvent(res, 'error', { message: `Report ${reportId} not found` });
      endStream();
      return;
    }
    report.updatedAt = new Date().toISOString();
    report.status = 'running';
  } else {
    const id = `review-${Date.now()}`;
    report = {
      id,
      baseUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      config: { model: config.model, viewports },
      pages: pages.map(p => ({ name: p.name, path: p.path, ...(p.actions?.length ? { actions: p.actions } : {}) })),
      totalExpected: pages.length * resolvedViewports.length,
      results: {},   // keyed by "pageName::viewport"
      errors: {},    // keyed by "pageName::viewport"
      summary: { pages: 0, issues: 0, critical: 0, warning: 0, suggestion: 0 },
    };
  }

  // Build skip set from existing results (watch re-triggers skip nothing by default)
  const skip = new Set(watchSession ? (skipCompleted || []) : (skipCompleted || Object.keys(report.results)));

  sendEvent(res, 'report-id', { reportId: report.id });
  saveReport(report);

  let aborted = false;
  const reviewAbort = new AbortController();
  const isWatchSession = watchMode || !!watchSession;
  req.on('close', () => {
    aborted = true;
    clearInterval(keepaliveTimer);
    reviewAbort.abort();  // Cancel any in-flight Ollama request (stops GPU work)
    // Note: in watch mode, browser stays open — only GPU work is aborted
  });

  // In watch mode, launch a shared browser + persistent page for the entire review.
  // For re-triggers, reuse the existing browser from the watch session.
  let sharedBrowser = null;
  let sharedPage = null;
  if (watchSession) {
    // Re-trigger: reuse existing watch session browser
    sharedBrowser = watchSession.browser;
    sharedPage = watchSession.page;
    watchSession.reviewInProgress = true;
  } else if (watchMode) {
    try {
      const forceHeadless = !process.env.DISPLAY;
      sharedBrowser = await launchBrowser({ headless: forceHeadless });
      const ctx = await sharedBrowser.newContext({
        ignoreHTTPSErrors: true,
        ...(authState ? { storageState: authState } : {}),
      });
      sharedPage = await ctx.newPage();
    } catch (err) {
      sendEvent(res, 'error', { message: `Failed to launch browser for watch mode: ${err.message}` });
      if (sharedBrowser) await sharedBrowser.close().catch(() => {});
      endStream();
      return;
    }
  }

  try {
    // Health check
    sendEvent(res, 'progress', { status: 'health-check', message: `Checking Ollama at ${config.ollamaUrl}...` });
    await healthCheck(config);

    // Prewarm
    sendEvent(res, 'progress', { status: 'prewarm', message: `Prewarming ${config.model}...` });
    await prewarm(config);

    const systemPrompt = loadPrompt('review-system');

    // Process each page × viewport sequentially (GPU-bound)
    for (const page of pages) {
      if (aborted) break;

      // Generate token for pages that require tokenAuth (once per page, reused across viewports)
      let tokenSuffix = '';
      const pageLabel = page.name || page.path;
      if (page.tokenAuth && authState) {
        try {
          sendEvent(res, 'progress', {
            status: 'token',
            page: pageLabel,
            message: `Generating auth token for ${pageLabel}...`,
          });
          const token = await generatePageToken({ page, baseUrl, authState });
          if (token) {
            const sep = page.path.includes('?') ? '&' : '?';
            tokenSuffix = `${sep}${token.queryParam}=${encodeURIComponent(token.value)}`;
          }
        } catch (err) {
          // Token failure skips all viewports for this page
          for (const vp of resolvedViewports) {
            const k = resultKey(page.name, vp.name);
            report.errors[k] = { message: `Token generation failed: ${err.message}`, timestamp: new Date().toISOString() };
            sendEvent(res, 'page-error', {
              page: pageLabel,
              viewport: vp.name,
              message: `Token generation failed: ${err.message}`,
            });
          }
          report.updatedAt = new Date().toISOString();
          saveReport(report);
          continue;
        }
      }

      for (const viewport of resolvedViewports) {
        if (aborted) break;

        const key = resultKey(page.name, viewport.name);
        const fullUrl = baseUrl.replace(/\/$/, '') + page.path + tokenSuffix;

        // Skip already-completed combos
        if (skip.has(key)) {
          sendEvent(res, 'progress', {
            status: 'skipped',
            page: pageLabel,
            viewport: viewport.name,
            message: `Skipping ${pageLabel} (${viewport.name}) — already reviewed`,
          });
          // Re-send cached result so frontend can render it
          if (report.results[key]) {
            sendEvent(res, 'result', {
              page: pageLabel,
              viewport: viewport.name,
              data: report.results[key],
              cached: true,
            });
          }
          continue;
        }

        try {
          // Capture
          sendEvent(res, 'progress', {
            status: 'capturing',
            page: pageLabel,
            viewport: viewport.name,
            message: `Capturing ${pageLabel} at ${viewport.name}...`,
          });

          const buffer = await captureScreenshot({
            url: fullUrl,
            viewport,
            config,
            allowPrivate,
            headless: !watchMode,
            browser: sharedBrowser || undefined,
            page: sharedPage || undefined,
            storageState: authState || undefined,
            actions: page.actions || undefined,
          });

          // Save screenshot to disk
          const screenshotDir = join(REPORTS_DIR, report.id, 'screenshots');
          mkdirSync(screenshotDir, { recursive: true });
          const screenshotFilename = `${sanitizeName(page.name)}_${viewport.name}.png`;
          writeFileSync(join(screenshotDir, screenshotFilename), buffer);
          const screenshotPath = `screenshots/${screenshotFilename}`;

          sendEvent(res, 'progress', {
            status: 'captured',
            page: pageLabel,
            viewport: viewport.name,
            message: `Screenshot ${(buffer.length / 1024).toFixed(0)}KB — saved`,
          });

          // Analyze
          sendEvent(res, 'progress', {
            status: 'analyzing',
            page: pageLabel,
            viewport: viewport.name,
            message: `Analyzing ${pageLabel} (${viewport.name}) with ${config.model}...`,
          });

          const prompt = loadPrompt('review', {
            url: fullUrl,
            viewport: viewport.name,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
          });

          const raw = await analyze({
            config,
            systemPrompt,
            prompt,
            images: [buffer],
            signal: reviewAbort.signal,
          });

          let result = sanitizeResult(raw, { url: fullUrl, viewport: viewport.name });

          // Fallback 1: try re-parsing the summary text as JSON
          if (result._raw && result.summary) {
            const retried = parseVlmJson(result.summary);
            if (!retried._raw) {
              result = sanitizeResult(retried, { url: fullUrl, viewport: viewport.name });
            }
          }

          // Fallback 2: send raw text back through VLM for JSON reformatting
          if (result._raw && result.summary) {
            sendEvent(res, 'progress', {
              status: 'reformatting',
              page: pageLabel,
              viewport: viewport.name,
              message: `Reformatting raw response for ${pageLabel} (${viewport.name})...`,
            });

            try {
              const reformatPrompt = loadPrompt('reformat', { rawText: result.summary });
              const reformatted = await analyze({
                config,
                systemPrompt: 'You convert UI review text into structured JSON. Respond only with valid JSON.',
                prompt: reformatPrompt,
                images: [],
                signal: reviewAbort.signal,
              });
              const parsed = parseVlmJson(typeof reformatted === 'string' ? reformatted : JSON.stringify(reformatted));
              if (!parsed._raw && Array.isArray(parsed.issues)) {
                result = sanitizeResult(parsed, { url: fullUrl, viewport: viewport.name });
              }
            } catch { /* keep original _raw result */ }
          }

          // Store in report (include screenshot reference)
          result.screenshot = screenshotPath;
          report.results[key] = result;
          delete report.errors[key];

          // Update summary
          report.summary.pages = Object.keys(report.results).length;
          report.summary.issues = 0;
          report.summary.critical = 0;
          report.summary.warning = 0;
          report.summary.suggestion = 0;
          for (const r of Object.values(report.results)) {
            for (const issue of r.issues || []) {
              report.summary.issues++;
              report.summary[issue.severity] = (report.summary[issue.severity] || 0) + 1;
            }
          }

          report.updatedAt = new Date().toISOString();
          saveReport(report);

          sendEvent(res, 'result', {
            page: pageLabel,
            viewport: viewport.name,
            data: result,
          });

        } catch (err) {
          // User cancelled — stop the loop immediately
          if (err.name === 'AbortError') {
            aborted = true;
            break;
          }
          report.errors[key] = { message: err.message, timestamp: new Date().toISOString() };
          report.updatedAt = new Date().toISOString();
          saveReport(report);

          sendEvent(res, 'page-error', {
            page: pageLabel,
            viewport: viewport.name,
            message: err.message,
          });
        }
      }
    }

    report.status = aborted ? 'interrupted' : 'complete';
    report.updatedAt = new Date().toISOString();
    saveReport(report);

    try { sendEvent(res, 'done', { summary: report.summary, reportId: report.id }); } catch {}
  } catch (err) {
    report.status = 'error';
    report.updatedAt = new Date().toISOString();
    saveReport(report);
    try { sendEvent(res, 'error', { message: err.message }); } catch {};
  } finally {
    if (watchSession) {
      // Re-trigger complete — mark not in-progress but keep browser alive
      watchSession.reviewInProgress = false;
    } else if (sharedBrowser && isWatchSession) {
      // Watch review done (or client disconnected) — store session for re-use
      const session = {
        browser: sharedBrowser,
        page: sharedPage,
        authState,
        config,
        pages,
        viewports: resolvedViewports,
        baseUrl,
        allowPrivate,
        pollTimer: null,
        reviewInProgress: false,
        startedAt: new Date().toISOString(),
      };

      // Start polling if requested (minimum 60s)
      if (pollInterval && pollInterval >= 60000) {
        session.pollTimer = setInterval(() => runPollCycle(report.id), pollInterval);
      }

      // Auto-recover from browser crashes
      sharedBrowser.on('disconnected', async () => {
        const s = watchSessions.get(report.id);
        if (!s) return; // Already cleaned up
        try {
          const newBrowser = await launchBrowser({ headless: false });
          const ctx = await newBrowser.newContext({
            ignoreHTTPSErrors: true,
            ...(s.authState ? { storageState: s.authState } : {}),
          });
          s.browser = newBrowser;
          s.page = await ctx.newPage();
          // Re-attach disconnect listener to new browser
          newBrowser.on('disconnected', async () => {
            const s2 = watchSessions.get(report.id);
            if (s2) {
              // Second crash — give up, clean up
              if (s2.pollTimer) clearInterval(s2.pollTimer);
              watchSessions.delete(report.id);
            }
          });
        } catch {
          // Recovery failed — remove watch session
          if (s.pollTimer) clearInterval(s.pollTimer);
          watchSessions.delete(report.id);
        }
      });

      watchSessions.set(report.id, session);
      try {
        sendEvent(res, 'watch-ready', {
          reportId: report.id,
          polling: !!session.pollTimer,
          pollInterval: session.pollTimer ? pollInterval : null,
        });
      } catch {} // Client may have disconnected — session still stored
    } else if (sharedBrowser) {
      // Non-watch or aborted — close browser
      await sharedBrowser.close().catch(() => {});
    }
  }

  endStream();
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // API routes
  if (url.pathname === '/api/config' && req.method === 'GET') {
    try {
      const config = getOllamaConfig();
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({
        viewports: Object.entries(VIEWPORTS).map(([name, dims]) => ({ name, ...dims })),
        ollamaUrl: config.ollamaUrl,
        model: config.model,
      }));
    } catch (err) {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    try {
      const config = getOllamaConfig();
      const result = await healthCheck(config);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, models: result.models, ollamaUrl: config.ollamaUrl }));
    } catch (err) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/reports' && req.method === 'GET') {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(listReports()));
    return;
  }

  // GET /api/reports/:id
  const reportMatch = url.pathname.match(/^\/api\/reports\/([a-z0-9-]+)$/);
  if (reportMatch && req.method === 'GET') {
    const report = loadReport(reportMatch[1]);
    if (report) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(report));
    } else {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Report not found' }));
    }
    return;
  }

  // GET /api/reports/:id/screenshots/:filename
  const screenshotMatch = url.pathname.match(/^\/api\/reports\/([a-z0-9-]+)\/screenshots\/([a-zA-Z0-9_.-]+\.png)$/);
  if (screenshotMatch && req.method === 'GET') {
    const filePath = join(REPORTS_DIR, screenshotMatch[1], 'screenshots', screenshotMatch[2]);
    if (existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Screenshot not found');
    }
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { baseUrl, loginUrl, username, password, allowPrivate = false } = body;

      if (!baseUrl || !loginUrl || !username || !password) {
        res.writeHead(400, JSON_HEADERS);
        res.end(JSON.stringify({ ok: false, error: 'All fields are required' }));
        return;
      }

      const result = await executeLogin({ baseUrl, loginUrl, username, password, allowPrivate });
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // GET /api/watch — list active watch sessions
  if (url.pathname === '/api/watch' && req.method === 'GET') {
    const sessions = [];
    for (const [reportId, s] of watchSessions) {
      sessions.push({
        reportId,
        baseUrl: s.baseUrl,
        startedAt: s.startedAt,
        reviewInProgress: s.reviewInProgress,
        polling: !!s.pollTimer,
      });
    }
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(sessions));
    return;
  }

  // POST /api/watch/:reportId/stop — close browser and remove watch session
  const watchStopMatch = url.pathname.match(/^\/api\/watch\/([a-z0-9-]+)\/stop$/);
  if (watchStopMatch && req.method === 'POST') {
    const session = watchSessions.get(watchStopMatch[1]);
    if (!session) {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ ok: false, error: 'Watch session not found' }));
      return;
    }
    if (session.pollTimer) clearInterval(session.pollTimer);
    await session.browser.close().catch(() => {});
    watchSessions.delete(watchStopMatch[1]);
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/discover' && req.method === 'POST') {
    await runDiscover(req, res);
    return;
  }

  if (url.pathname === '/api/review' && req.method === 'POST') {
    await runReview(req, res);
    return;
  }

  // --- Environment State Persistence ---

  // GET /api/environments — list saved environments
  if (url.pathname === '/api/environments' && req.method === 'GET') {
    const envs = listEnvironments();
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(envs));
    return;
  }

  // GET /api/environments/:name/state — get full state for an environment
  const envStateGetMatch = url.pathname.match(/^\/api\/environments\/([^/]+)\/state$/);
  if (envStateGetMatch && req.method === 'GET') {
    const envName = decodeURIComponent(envStateGetMatch[1]);
    const state = loadEnvironmentState(envName);
    if (state) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(state));
    } else {
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Environment not found' }));
    }
    return;
  }

  // POST /api/environments/:name/state — save state
  if (envStateGetMatch && req.method === 'POST') {
    try {
      const envName = decodeURIComponent(envStateGetMatch[1]);
      const body = await readBody(req);
      body.updatedAt = new Date().toISOString();
      if (!body.name) body.name = envName;
      saveEnvironmentState(envName, body);
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // DELETE /api/environments/:name — remove environment
  const envDeleteMatch = url.pathname.match(/^\/api\/environments\/([^/]+)$/);
  if (envDeleteMatch && req.method === 'DELETE') {
    const envName = decodeURIComponent(envDeleteMatch[1]);
    deleteEnvironmentState(envName);
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Static files
  if (req.method === 'GET') {
    const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      const content = readFileSync(join(PUBLIC_DIR, filePath));
      const ext = filePath.split('.').pop();
      const types = { html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`ui-review server running at http://localhost:${PORT}`);
  console.log(`Reports saved to: ${REPORTS_DIR}`);
});

/** Graceful shutdown — close all watch session browsers. */
async function shutdown() {
  console.log('\nShutting down — closing watch session browsers...');
  for (const [id, session] of watchSessions) {
    if (session.pollTimer) clearInterval(session.pollTimer);
    await session.browser.close().catch(() => {});
    watchSessions.delete(id);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
