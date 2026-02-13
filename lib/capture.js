import { chromium } from 'playwright';
import { lookup } from 'node:dns/promises';
import { CaptureError, BrowserCrashedError, ConfigError } from './errors.js';

/**
 * Private IP ranges to block for SSRF prevention.
 * Applied after DNS resolution to catch DNS rebinding.
 */
const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i,
];

/**
 * Validate URL scheme (http/https only).
 * @param {string} input
 * @returns {URL}
 */
function validateUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ConfigError(`Invalid URL: ${input}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ConfigError(`Unsupported protocol: ${url.protocol}. Only http and https are allowed.`);
  }
  return url;
}

/**
 * Check if a URL resolves to a private/internal IP (SSRF prevention).
 * Skipped when allowPrivate is true.
 *
 * @param {URL} url
 * @param {boolean} [allowPrivate=false]
 */
async function checkSsrf(url, allowPrivate = false) {
  if (allowPrivate) return;

  try {
    const { address } = await lookup(url.hostname);
    if (PRIVATE_IP_PATTERNS.some(re => re.test(address))) {
      throw new ConfigError(
        `URL resolves to private/internal IP (${address}): ${url.href}. ` +
        'Use --allow-private to override.'
      );
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    // DNS resolution failed — let Playwright handle it
  }
}

/**
 * Capture a screenshot of a single page at a given viewport.
 *
 * @param {Object} options
 * @param {string} options.url - The URL to capture
 * @param {Object} options.viewport - { width, height }
 * @param {Object} [options.config] - App config
 * @param {string} [options.storageState] - Path to Playwright storage state for auth
 * @param {string} [options.waitFor] - CSS selector to wait for before capture
 * @param {boolean} [options.allowPrivate] - Allow private/internal IPs
 * @param {boolean} [options.headless] - Run browser in headless mode (default: true)
 * @param {Object} [options.browser] - Existing browser instance to reuse (skips launch/close)
 * @param {Object} [options.page] - Existing page to reuse (for watch mode — skips context/page creation)
 * @returns {Promise<Buffer>} PNG screenshot buffer
 */
export async function captureScreenshot({
  url: urlString,
  viewport,
  config = {},
  storageState,
  waitFor,
  allowPrivate = false,
  headless = true,
  browser: existingBrowser,
  page: existingPage,
}) {
  const url = validateUrl(urlString);
  await checkSsrf(url, allowPrivate);

  // Fast path: reuse an existing page (watch mode)
  if (existingPage) {
    try {
      await existingPage.setViewportSize({ width: viewport.width, height: viewport.height });

      await existingPage.goto(url.href, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      if (waitFor) {
        await existingPage.waitForSelector(waitFor, { timeout: 10_000 });
      }

      await existingPage.evaluate(() => document.fonts.ready);
      await new Promise(r => setTimeout(r, 500));

      return await existingPage.screenshot({ type: 'png', animations: 'disabled' });
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      // Detect browser crash vs normal capture error
      if (err.message?.includes('has been closed') || err.message?.includes('Target closed') ||
          err.message?.includes('Browser has been closed') || err.message?.includes('browser has been closed')) {
        throw new BrowserCrashedError(`Browser crashed during capture of ${url.href}: ${err.message}`);
      }
      throw new CaptureError(`Screenshot capture failed for ${url.href}: ${err.message}`);
    }
  }

  // Standard path: create browser/context/page as needed
  const ownsTheBrowser = !existingBrowser;
  let browser = existingBrowser;

  try {
    if (!browser) {
      browser = await chromium.launch({ headless });
    }

    const contextOptions = {
      viewport: { width: viewport.width, height: viewport.height },
      ignoreHTTPSErrors: config.ignoreHttpsErrors || false,
    };
    if (storageState) {
      contextOptions.storageState = storageState;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
      // Navigate with networkidle wait strategy
      await page.goto(url.href, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });

      // Optional: wait for specific selector
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: 10_000 });
      }

      // Wait for fonts to finish loading
      await page.evaluate(() => document.fonts.ready);

      // Stability delay for late CSS transitions
      await new Promise(r => setTimeout(r, 500));

      // Viewport screenshot (not full page), animations disabled
      const buffer = await page.screenshot({
        type: 'png',
        animations: 'disabled',
      });

      return buffer;
    } finally {
      await context.close();
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;

    // Check for missing browser executable
    if (err.message?.includes("Executable doesn't exist") || err.message?.includes('browserType.launch')) {
      throw new CaptureError(
        'Chromium browser not installed. Run: npx playwright install chromium'
      );
    }

    throw new CaptureError(`Screenshot capture failed for ${url.href}: ${err.message}`);
  } finally {
    if (ownsTheBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Launch a reusable browser instance for watch mode.
 * Caller is responsible for closing it when done.
 *
 * @returns {Promise<Object>} Playwright browser instance
 */
export async function launchBrowser({ headless = true } = {}) {
  return chromium.launch({ headless });
}
