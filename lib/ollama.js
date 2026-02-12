import { OllamaConnectionError, OllamaTimeoutError, OllamaAuthError, OllamaModelError } from './errors.js';

/**
 * Ollama HTTP client for VLM analysis.
 *
 * Handles local and remote (CF Access tunnel) Ollama instances,
 * model health checks, prewarm, and image analysis via /api/chat.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** 1x1 transparent PNG as base64 for model prewarm */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB'
  + 'Nl7BcQAAAABJRU5ErkJggg==';

const MAX_RESPONSE_SIZE = 1_000_000; // 1MB

/**
 * Mask a secret for safe logging (first 4 chars + ****).
 * @param {string} [s]
 * @returns {string}
 */
function maskSecret(s) {
  return s ? s.slice(0, 4) + '****' : '<not set>';
}

/**
 * Determine whether the Ollama URL points to a local server.
 * @param {string} ollamaUrl
 * @returns {boolean}
 */
function isLocal(ollamaUrl) {
  try {
    const { hostname } = new URL(ollamaUrl);
    return LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

/**
 * Build request headers, adding CF Access credentials for remote hosts.
 * @param {Object} config
 * @returns {Object}
 */
function buildHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (!isLocal(config.ollamaUrl)) {
    if (config.cfClientId) headers['CF-Access-Client-Id'] = config.cfClientId;
    if (config.cfClientSecret) headers['CF-Access-Client-Secret'] = config.cfClientSecret;
  }
  return headers;
}

/**
 * Perform a fetch with standard error handling for Ollama responses.
 * @param {string} url
 * @param {Object} options - fetch options
 * @param {Object} config - app config (for debug logging)
 * @returns {Promise<Response>}
 */
async function ollamaFetch(url, options, config) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new OllamaTimeoutError(`Ollama request timed out: ${url}`);
    }
    throw new OllamaConnectionError(
      `Cannot connect to Ollama at ${config.ollamaUrl}: ${err.message}`
    );
  }

  // CF Access challenge detection — HTML instead of JSON
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const remote = !isLocal(config.ollamaUrl);
    const hint = remote
      ? ` Check CF_ACCESS_CLIENT_ID (${maskSecret(config.cfClientId)}) and CF_ACCESS_CLIENT_SECRET (${maskSecret(config.cfClientSecret)}).`
      : '';
    throw new OllamaAuthError(
      `Received HTML response from Ollama — likely a Cloudflare Access challenge.${hint}`
    );
  }

  return response;
}

/**
 * Parse VLM response text as JSON with fallback extraction.
 *
 * Tries:
 *  1. Direct JSON.parse
 *  2. Fenced code block extraction (```json ... ```)
 *  3. First { ... } brace-matched extraction
 *  4. Returns raw text wrapped as fallback
 *
 * @param {string} text
 * @returns {Object}
 */
export function parseVlmJson(text) {
  // Tier 1: direct parse
  try { return JSON.parse(text); } catch { /* continue */ }

  // Tier 2: fenced code block
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* continue */ }
  }

  // Tier 3: first brace-matched object
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) {
    try { return JSON.parse(braced[0]); } catch { /* continue */ }
  }

  // Tier 4: return raw text as fallback
  return { issues: [], summary: text, _raw: true };
}

/**
 * Check Ollama server health by hitting /api/tags.
 *
 * @param {Object} config - App config with ollamaUrl
 * @returns {Promise<{ models: string[] }>} List of available model names
 */
export async function healthCheck(config) {
  const url = `${config.ollamaUrl}/api/tags`;
  const response = await ollamaFetch(url, {
    method: 'GET',
    headers: buildHeaders(config),
    signal: AbortSignal.timeout(10_000),
  }, config);

  if (!response.ok) {
    if (response.status === 403) {
      throw new OllamaAuthError('Ollama returned 403 Forbidden — check CF Access credentials.');
    }
    throw new OllamaConnectionError(`Ollama health check failed: HTTP ${response.status}`);
  }

  const data = await response.json();
  const models = (data.models || []).map(m => m.name);
  return { models };
}

/**
 * Prewarm the model by sending a tiny image.
 * Loads the model into GPU memory so subsequent requests are fast.
 *
 * @param {Object} config - App config with ollamaUrl, model
 * @returns {Promise<void>}
 */
export async function prewarm(config) {
  const url = `${config.ollamaUrl}/api/chat`;
  const body = {
    model: config.model,
    messages: [{
      role: 'user',
      content: 'Respond with "ready".',
      images: [TINY_PNG],
    }],
    stream: false,
    keep_alive: '10m',
    options: { temperature: 0, num_predict: 8 },
  };

  const response = await ollamaFetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout),
  }, config);

  if (!response.ok) {
    if (response.status === 404) {
      throw new OllamaModelError(
        `Model "${config.model}" not found on Ollama. Run: ollama pull ${config.model}`
      );
    }
    throw new OllamaConnectionError(`Ollama prewarm failed: HTTP ${response.status}`);
  }

  // Consume the response body to complete the connection
  await response.json();
}

/**
 * Analyze one or more images with a prompt via the Ollama VLM.
 *
 * @param {Object} options
 * @param {Object} options.config - App config
 * @param {string} options.prompt - The review prompt text
 * @param {Buffer[]} options.images - Screenshot buffers (PNG/JPEG)
 * @param {Object} [options.formatSchema] - Optional JSON schema for structured output
 * @returns {Promise<Object>} Parsed VLM response
 */
export async function analyze({ config, prompt, images, formatSchema }) {
  const url = `${config.ollamaUrl}/api/chat`;
  const base64Images = images.map(buf => buf.toString('base64'));

  const body = {
    model: config.model,
    messages: [{
      role: 'user',
      content: prompt,
      images: base64Images,
    }],
    stream: false,
    keep_alive: '10m',
    options: {
      temperature: config.temperature ?? 0.1,
      num_predict: config.numPredict ?? 2048,
    },
  };

  // Try structured format if schema provided
  if (formatSchema) {
    body.format = formatSchema;
  }

  if (config.debug) {
    const sizes = images.map(b => `${(b.length / 1024).toFixed(0)}KB`);
    console.error(`[ollama] analyze: model=${config.model} images=[${sizes.join(', ')}] prompt=${prompt.length}chars`);
  }

  const response = await ollamaFetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeout),
  }, config);

  if (!response.ok) {
    if (response.status === 404) {
      throw new OllamaModelError(
        `Model "${config.model}" not found. Run: ollama pull ${config.model}`
      );
    }
    throw new OllamaConnectionError(`Ollama analyze failed: HTTP ${response.status}`);
  }

  // Read response with size limit
  const text = await response.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new OllamaConnectionError(
      `Ollama response too large (${(text.length / 1024 / 1024).toFixed(1)}MB > 1MB limit)`
    );
  }

  const data = JSON.parse(text);

  // Truncation detection
  if (data.done_reason === 'length') {
    console.error('[ollama] Warning: VLM response was truncated — consider increasing num_predict');
  }

  if (config.debug) {
    const dur = data.total_duration ? `${(data.total_duration / 1e9).toFixed(1)}s` : 'unknown';
    console.error(`[ollama] response: done_reason=${data.done_reason} duration=${dur}`);
  }

  // Parse the message content as JSON
  const content = data.message?.content || '';
  return parseVlmJson(content);
}
