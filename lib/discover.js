import { chromium } from 'playwright';
import { lookup } from 'node:dns/promises';
import { ConfigError, CaptureError } from './errors.js';

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i,
];

/** Normalize a URL path for deduplication. */
function normalizePath(urlString, baseOrigin) {
  try {
    const url = new URL(urlString, baseOrigin);
    if (url.origin !== baseOrigin) return null;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    let path = url.pathname.replace(/\/+$/, '') || '/';
    return path + (url.search || '');
  } catch {
    return null;
  }
}

/** Derive a human-readable page name from a URL path. */
function pageNameFromPath(path) {
  const name = path.replace(/^\//, '').replace(/\.\w+$/, '').replace(/[_-]/g, ' ').replace(/\//g, ' > ') || 'Home';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Try fetching and parsing sitemap.xml from the target site.
 * Returns array of paths or null if no sitemap found.
 */
async function trySitemap(baseUrl, onProgress) {
  const sitemapUrl = baseUrl.replace(/\/$/, '') + '/sitemap.xml';
  onProgress?.(`Trying ${sitemapUrl}...`);

  try {
    const res = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'ui-review/1.0' },
    });

    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();

    // Basic check that it's XML with <loc> tags
    if (!text.includes('<loc>') && !text.includes('<urlset')) return null;

    // Extract <loc> URLs with regex (avoids XML parser dependency)
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    const paths = [];
    const baseOrigin = new URL(baseUrl).origin;
    let match;

    while ((match = locRegex.exec(text)) !== null) {
      const path = normalizePath(match[1], baseOrigin);
      if (path && !paths.includes(path)) {
        paths.push(path);
      }
    }

    if (paths.length > 0) {
      onProgress?.(`Sitemap found with ${paths.length} URLs`);
      return paths;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Crawl a site using Playwright, following <a href> links via BFS.
 *
 * @param {Object} options
 * @param {string} options.baseUrl - Site root URL
 * @param {number} options.maxPages - Maximum pages to visit
 * @param {Function} options.onPage - Callback for each discovered page
 * @param {Function} options.onProgress - Callback for progress messages
 * @param {boolean} options.allowPrivate - Allow private IPs
 * @param {Object} options.storageState - Playwright auth state
 * @param {AbortSignal} options.signal - Cancellation signal
 * @returns {Promise<{pages: Array, totalLinksFound: number, pagesSkipped: number}>}
 */
async function crawlLinks({
  baseUrl,
  maxPages,
  onPage,
  onProgress,
  allowPrivate = false,
  storageState,
  signal,
}) {
  const baseOrigin = new URL(baseUrl).origin;
  const visited = new Set();
  const queue = [{ path: normalizePath(baseUrl, baseOrigin) || '/', depth: 0 }];
  const pages = [];
  let totalLinksFound = 0;
  let pagesSkipped = 0;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const contextOptions = { ignoreHTTPSErrors: true };
    if (storageState) contextOptions.storageState = storageState;
    const context = await browser.newContext(contextOptions);

    while (queue.length > 0 && pages.length < maxPages) {
      if (signal?.aborted) break;

      const { path, depth } = queue.shift();
      if (visited.has(path)) continue;
      visited.add(path);

      const fullUrl = baseOrigin + path;
      onProgress?.(`Crawling ${path} (depth ${depth}, ${pages.length}/${maxPages} found)...`);

      try {
        const page = await context.newPage();
        try {
          const response = await page.goto(fullUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });

          const status = response?.status() || 0;

          // Extract same-origin links
          const links = await page.evaluate((origin) => {
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            return anchors
              .map(a => {
                try { return new URL(a.href, window.location.origin).href; }
                catch { return null; }
              })
              .filter(Boolean);
          }, baseOrigin);

          const newPaths = [];
          for (const link of links) {
            const normalized = normalizePath(link, baseOrigin);
            if (normalized && !visited.has(normalized)) {
              newPaths.push(normalized);
              totalLinksFound++;
            }
          }

          const uniqueNewPaths = [...new Set(newPaths)];
          for (const p of uniqueNewPaths) {
            if (!visited.has(p)) {
              queue.push({ path: p, depth: depth + 1 });
            }
          }

          const pageInfo = {
            name: pageNameFromPath(path),
            path,
            depth,
            status,
            links: uniqueNewPaths.length,
          };
          pages.push(pageInfo);
          onPage?.(pageInfo);

        } finally {
          await page.close();
        }

        // Rate limit: 200ms between page loads
        await new Promise(r => setTimeout(r, 200));

      } catch (err) {
        // Page load failed — still record it with error status
        const pageInfo = {
          name: pageNameFromPath(path),
          path,
          depth,
          status: 0,
          links: 0,
          error: err.message,
        };
        pages.push(pageInfo);
        onPage?.(pageInfo);
      }
    }

    pagesSkipped = queue.length;

    await context.close();
  } catch (err) {
    if (err.message?.includes("Executable doesn't exist")) {
      throw new CaptureError('Chromium browser not installed. Run: npx playwright install chromium');
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { pages, totalLinksFound, pagesSkipped };
}

/**
 * Discover pages on a site via sitemap + crawling.
 *
 * @param {Object} options
 * @param {string} options.baseUrl - Site root URL
 * @param {number} [options.maxPages=50] - Maximum pages to discover
 * @param {Function} [options.onPage] - Callback for each discovered page
 * @param {Function} [options.onProgress] - Callback for progress messages
 * @param {boolean} [options.allowPrivate=false] - Allow private IPs
 * @param {Object} [options.storageState] - Playwright auth state
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @returns {Promise<{pages: Array, source: string, totalLinksFound: number, pagesSkipped: number}>}
 */
export async function discoverPages({
  baseUrl,
  maxPages = 50,
  onPage,
  onProgress,
  allowPrivate = false,
  storageState,
  signal,
}) {
  // Validate URL
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`Invalid URL: ${baseUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ConfigError(`Unsupported protocol: ${url.protocol}`);
  }

  // SSRF check
  if (!allowPrivate) {
    try {
      const { address } = await lookup(url.hostname);
      if (PRIVATE_IP_PATTERNS.some(re => re.test(address))) {
        throw new ConfigError(
          `URL resolves to private IP (${address}). Enable "Allow private IPs" to override.`
        );
      }
    } catch (err) {
      if (err instanceof ConfigError) throw err;
    }
  }

  // 1. Try sitemap
  const sitemapPaths = await trySitemap(baseUrl, onProgress);

  if (sitemapPaths && sitemapPaths.length > 0) {
    const pages = sitemapPaths.slice(0, maxPages).map((path, i) => {
      const pageInfo = { name: pageNameFromPath(path), path, depth: 0, status: 0, links: 0 };
      onPage?.(pageInfo);
      return pageInfo;
    });

    return {
      pages,
      source: 'sitemap',
      totalLinksFound: sitemapPaths.length,
      pagesSkipped: Math.max(0, sitemapPaths.length - maxPages),
    };
  }

  // 2. Fall back to crawling
  onProgress?.('No sitemap found, crawling links...');

  const result = await crawlLinks({
    baseUrl,
    maxPages,
    onPage,
    onProgress,
    allowPrivate,
    storageState,
    signal,
  });

  return { ...result, source: 'crawl' };
}
