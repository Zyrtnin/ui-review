import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './errors.js';

/** Known viewport definitions */
const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

/** Default configuration */
const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  model: 'qwen3-vl:8b',
  timeout: 600_000,
  numPredict: 32768,
  numCtx: 32768,
  temperature: 0.1,
  concurrency: 6,
  viewports: ['desktop', 'laptop', 'tablet', 'mobile'],
  ignoreHttpsErrors: false,
  debug: false,
};

/**
 * Load and merge configuration from env → manifest → CLI args.
 *
 * @param {Object} options
 * @param {Object} [options.cliArgs] - CLI flag overrides (highest priority)
 * @param {string} [options.manifestPath] - Path to .ui-review.json
 * @param {Object} [options.env] - Environment variables (defaults to process.env)
 * @returns {Object} Frozen merged config
 */
export function loadConfig({ cliArgs = {}, manifestPath, env = process.env } = {}) {
  const config = { ...DEFAULTS };

  // Layer 1: Environment variables
  if (env.OLLAMA_URL) config.ollamaUrl = env.OLLAMA_URL;
  if (env.OLLAMA_MODEL) config.model = env.OLLAMA_MODEL;
  if (env.CF_ACCESS_CLIENT_ID) config.cfClientId = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) config.cfClientSecret = env.CF_ACCESS_CLIENT_SECRET;

  // Layer 2: Manifest file
  const mPath = manifestPath || '.ui-review.json';
  if (existsSync(mPath)) {
    const manifest = loadManifest(mPath);
    if (manifest.baseUrl) config.baseUrl = manifest.baseUrl;
    if (manifest.authState) config.authState = manifest.authState;
    if (manifest.viewports) config.viewports = manifest.viewports;
    if (manifest.pages) config.pages = manifest.pages;
    if (manifest.model) config.model = manifest.model;
  }

  // Layer 3: CLI args (highest priority)
  if (cliArgs.ollamaUrl !== undefined) config.ollamaUrl = cliArgs.ollamaUrl;
  if (cliArgs.model !== undefined) config.model = cliArgs.model;
  if (cliArgs.timeout !== undefined) config.timeout = cliArgs.timeout;
  if (cliArgs.viewport !== undefined) config.viewports = cliArgs.viewport.split(',').map(v => v.trim());
  if (cliArgs.ignoreHttpsErrors !== undefined) config.ignoreHttpsErrors = cliArgs.ignoreHttpsErrors;
  if (cliArgs.debug !== undefined) config.debug = cliArgs.debug;
  if (cliArgs.format !== undefined) config.format = cliArgs.format;
  if (cliArgs.output !== undefined) config.output = cliArgs.output;
  if (cliArgs.dryRun !== undefined) config.dryRun = cliArgs.dryRun;
  if (cliArgs.concurrency !== undefined) config.concurrency = cliArgs.concurrency;

  // Resolve viewport definitions
  config.resolvedViewports = config.viewports.map(name => {
    const vp = VIEWPORTS[name];
    if (!vp) throw new ConfigError(`Unknown viewport: ${name}. Known: ${Object.keys(VIEWPORTS).join(', ')}`);
    return { name, ...vp };
  });

  // Validate
  validate(config);

  return Object.freeze(config);
}

/**
 * Load and validate a .ui-review.json manifest.
 */
function loadManifest(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Failed to read manifest: ${filePath}: ${err.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in manifest: ${filePath}: ${err.message}`);
  }

  validateManifest(manifest);
  return manifest;
}

/**
 * Validate manifest fields for security and correctness.
 */
function validateManifest(manifest) {
  if (manifest.baseUrl) {
    let base;
    try {
      base = new URL(manifest.baseUrl);
    } catch {
      throw new ConfigError(`Invalid baseUrl: ${manifest.baseUrl}`);
    }
    if (!['http:', 'https:'].includes(base.protocol)) {
      throw new ConfigError(`baseUrl must be http or https, got: ${base.protocol}`);
    }
  }

  if (manifest.authState) {
    if (typeof manifest.authState !== 'string') {
      throw new ConfigError('authState must be a string path');
    }
    if (resolve(manifest.authState) !== resolve(process.cwd(), manifest.authState)) {
      // Path is absolute — not allowed
    }
    if (manifest.authState.includes('..')) {
      throw new ConfigError('authState must not contain path traversal (..)');
    }
  }

  if (manifest.pages) {
    if (!Array.isArray(manifest.pages)) {
      throw new ConfigError('pages must be an array');
    }
    for (const page of manifest.pages) {
      if (!page.name || typeof page.name !== 'string') {
        throw new ConfigError('Each page must have a "name" string');
      }
      if (!/^[a-z0-9_-]+$/i.test(page.name)) {
        throw new ConfigError(`Invalid page name "${page.name}": use only alphanumeric, hyphens, underscores`);
      }
      if (!page.path || typeof page.path !== 'string') {
        throw new ConfigError(`Page "${page.name}" must have a "path" string`);
      }
      if (!page.path.startsWith('/') || page.path.startsWith('//')) {
        throw new ConfigError(`Invalid page path "${page.path}": must start with / and not //`);
      }
    }
  }

  if (manifest.viewports) {
    if (!Array.isArray(manifest.viewports)) {
      throw new ConfigError('viewports must be an array');
    }
    const known = Object.keys(VIEWPORTS);
    for (const vp of manifest.viewports) {
      if (!known.includes(vp)) {
        throw new ConfigError(`Unknown viewport "${vp}". Known: ${known.join(', ')}`);
      }
    }
  }
}

/**
 * Validate the merged configuration.
 */
function validate(config) {
  // ollamaUrl must be valid
  try {
    new URL(config.ollamaUrl);
  } catch {
    throw new ConfigError(`Invalid OLLAMA_URL: ${config.ollamaUrl}`);
  }

  if (config.timeout < 1000 || config.timeout > 600_000) {
    throw new ConfigError(`Timeout must be between 1000ms and 600000ms, got: ${config.timeout}`);
  }

  if (config.concurrency < 1 || config.concurrency > 20) {
    throw new ConfigError(`Concurrency must be between 1 and 20, got: ${config.concurrency}`);
  }
}

export { VIEWPORTS };
