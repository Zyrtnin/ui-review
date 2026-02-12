#!/usr/bin/env node

import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, VIEWPORTS } from '../lib/config.js';
import { healthCheck, prewarm, analyze, parseVlmJson } from '../lib/ollama.js';
import { captureScreenshot } from '../lib/capture.js';
import { loadPrompt } from '../lib/prompts.js';
import { sanitizeResult } from '../lib/report.js';
import { discoverPages } from '../lib/discover.js';

const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '3000', 10);
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');
const REPORTS_DIR = join(import.meta.dirname, '..', 'reports');

// Ensure reports directory exists
mkdirSync(REPORTS_DIR, { recursive: true });

/** Send an SSE event line. */
function sendEvent(res, event, data) {
  res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
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
    const usernameField = await page.$('input[type="text"], input[name*="user"], input[name*="email"], input[id*="user"], input[name*="login"]');
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

/** Discover pages on a site, streaming SSE events. */
async function runDiscover(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendEvent(res, 'error', { message: 'Invalid request body' });
    res.end();
    return;
  }

  const { baseUrl, maxPages = 50, allowPrivate = false, authState } = body;

  if (!baseUrl) {
    sendEvent(res, 'error', { message: 'baseUrl is required' });
    res.end();
    return;
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

  res.end();
}

/** Run reviews for pages × viewports, streaming SSE events. */
async function runReview(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  let body;
  try {
    body = await readBody(req);
  } catch {
    sendEvent(res, 'error', { message: 'Invalid request body' });
    res.end();
    return;
  }

  const {
    baseUrl,
    pages = [],
    viewports = ['desktop'],
    allowPrivate = false,
    reportId,       // Resume existing report
    skipCompleted,  // Array of "page::viewport" keys to skip
    watchMode = false,
    authState,
  } = body;

  if (!baseUrl || !pages.length) {
    sendEvent(res, 'error', { message: 'baseUrl and at least one page are required' });
    res.end();
    return;
  }

  const resolvedViewports = viewports.map(name => {
    const vp = VIEWPORTS[name];
    if (!vp) return null;
    return { name, ...vp };
  }).filter(Boolean);

  if (!resolvedViewports.length) {
    sendEvent(res, 'error', { message: 'No valid viewports selected' });
    res.end();
    return;
  }

  let config;
  try {
    config = getOllamaConfig();
  } catch (err) {
    sendEvent(res, 'error', { message: `Config error: ${err.message}` });
    res.end();
    return;
  }

  // Load or create report
  let report;
  if (reportId) {
    report = loadReport(reportId);
    if (!report) {
      sendEvent(res, 'error', { message: `Report ${reportId} not found` });
      res.end();
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
      pages: pages.map(p => ({ name: p.name, path: p.path })),
      totalExpected: pages.length * resolvedViewports.length,
      results: {},   // keyed by "pageName::viewport"
      errors: {},    // keyed by "pageName::viewport"
      summary: { pages: 0, issues: 0, critical: 0, warning: 0, suggestion: 0 },
    };
  }

  // Build skip set from existing results
  const skip = new Set(skipCompleted || Object.keys(report.results));

  sendEvent(res, 'report-id', { reportId: report.id });
  saveReport(report);

  let aborted = false;
  req.on('close', () => { aborted = true; });

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

      for (const viewport of resolvedViewports) {
        if (aborted) break;

        const key = resultKey(page.name, viewport.name);
        const fullUrl = baseUrl.replace(/\/$/, '') + page.path;
        const pageLabel = page.name || page.path;

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
            storageState: authState || undefined,
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

    sendEvent(res, 'done', { summary: report.summary, reportId: report.id });
  } catch (err) {
    report.status = 'error';
    report.updatedAt = new Date().toISOString();
    saveReport(report);
    sendEvent(res, 'error', { message: err.message });
  }

  res.end();
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

  if (url.pathname === '/api/discover' && req.method === 'POST') {
    await runDiscover(req, res);
    return;
  }

  if (url.pathname === '/api/review' && req.method === 'POST') {
    await runReview(req, res);
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
