import { chromium } from 'playwright';
import { lookup } from 'node:dns/promises';
import { ConfigError, CaptureError } from './errors.js';

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i,
];

/** File extensions to skip during crawling (not navigable pages). */
const SKIP_EXTENSIONS = new Set([
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.css', '.js', '.mjs', '.map', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.gz', '.tar', '.mp4', '.mp3', '.webm', '.ogg', '.wav',
  '.json', '.xml', '.txt', '.csv', '.md', '.yml', '.yaml', '.toml',
]);

/** Normalize a URL path for deduplication. Returns null for non-page resources. */
function normalizePath(urlString, baseOrigin) {
  try {
    const url = new URL(urlString, baseOrigin);
    if (url.origin !== baseOrigin) return null;
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    let path = url.pathname.replace(/\/+$/, '') || '/';

    // Skip non-page file extensions
    const ext = path.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase();
    if (ext && SKIP_EXTENSIONS.has(ext)) return null;

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
 * Deep link extraction — finds URLs from anchor tags, any [href] element,
 * onclick handlers, and URL-like patterns in page source.
 * Handles SPAs and JS-heavy sites where standard <a href> crawling fails.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} Array of absolute URLs
 */
async function extractLinks(page) {
  // Try expanding hidden nav menus before extracting
  try {
    const menuTriggers = await page.$$(
      'button[class*="menu"], button[class*="hamburger"], button[class*="nav"], ' +
      '[class*="menu-toggle"], [class*="nav-toggle"], ' +
      'button[aria-label*="menu" i], button[aria-expanded="false"]'
    );
    for (const trigger of menuTriggers.slice(0, 3)) {
      try {
        await trigger.click();
        await page.waitForTimeout(300);
      } catch { /* element may not be interactable */ }
    }
  } catch { /* no menu triggers found */ }

  return page.evaluate(() => {
    const urls = new Set();
    const origin = window.location.origin;

    function addUrl(raw) {
      if (!raw || typeof raw !== 'string') return;
      raw = raw.trim();
      if (!raw || raw === '#' || raw.startsWith('javascript:') || raw.startsWith('data:')) return;
      try {
        const url = new URL(raw, origin);
        if (url.origin === origin && ['http:', 'https:'].includes(url.protocol)) {
          urls.add(url.href);
        }
      } catch {}
    }

    // 1. Standard <a href> links
    document.querySelectorAll('a[href]').forEach(a => addUrl(a.href));

    // 2. Any element with href attribute (link, area, base, etc.)
    document.querySelectorAll('[href]').forEach(el => addUrl(el.getAttribute('href')));

    // 3. Links in onclick/data attributes
    document.querySelectorAll('[onclick], [data-href], [data-url], [data-link]').forEach(el => {
      for (const attr of ['onclick', 'data-href', 'data-url', 'data-link']) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        // Extract quoted strings that look like paths
        const matches = val.match(/['"](\/?[a-zA-Z0-9_\/.:-]+\.(?:html|php|htm|asp|aspx|jsp))['"]/g);
        if (matches) {
          matches.forEach(m => addUrl(m.replace(/['"]/g, '')));
        }
        // Also match window.location patterns
        const locMatch = val.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/);
        if (locMatch) addUrl(locMatch[1]);
      }
    });

    // 4. Scan full page source for URL-like file references
    //    Catches routes in JS, hidden links, template strings, etc.
    const html = document.documentElement.innerHTML;
    const filePattern = /['"`](\/?[a-zA-Z0-9_\/-]+\.(?:html|php|htm|asp|aspx|jsp))['"`\s?#)]/g;
    let match;
    while ((match = filePattern.exec(html)) !== null) {
      const path = match[1];
      // Skip obvious non-page references (minified JS filenames, assets)
      if (path.includes('.min.') || path.startsWith('//')) continue;
      addUrl(path);
    }

    // 5. Check meta refresh redirects
    document.querySelectorAll('meta[http-equiv="refresh"]').forEach(meta => {
      const content = meta.getAttribute('content') || '';
      const urlMatch = content.match(/url=(.+)/i);
      if (urlMatch) addUrl(urlMatch[1].trim());
    });

    return [...urls];
  });
}

/**
 * Crawl a site using Playwright with deep link extraction.
 * Uses BFS following links, onclick handlers, and URL patterns in page source.
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
            waitUntil: 'networkidle',
            timeout: 20000,
          });

          const status = response?.status() || 0;

          // Deep link extraction (handles SPAs, JS nav, hidden menus)
          const links = await extractLinks(page);

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
