import { OllamaConnectionError, OllamaTimeoutError, OllamaAuthError, OllamaModelError } from './errors.js';

/**
 * Ollama HTTP client for VLM analysis.
 *
 * Uses streaming NDJSON to avoid Cloudflare tunnel ~100s idle timeouts.
 * Each token chunk resets CF's idle timer, allowing long-running inference.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const MAX_CONTENT_SIZE = 5_000_000; // 5MB accumulated content limit

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
    // CF 524 (idle timeout) returns HTML — retryable via withRetry
    if (response.status === 524) {
      throw new OllamaTimeoutError(
        `Cloudflare 524 timeout — server took too long to respond.`
      );
    }
    const hint = remote
      ? ` Check CF_ACCESS_CLIENT_ID (${maskSecret(config.cfClientId)}) and CF_ACCESS_CLIENT_SECRET (${maskSecret(config.cfClientSecret)}).`
      : '';
    if (config.debug) {
      const body = await response.text().catch(() => '<unreadable>');
      console.error(`[ollama] HTML response: status=${response.status} body=${body.slice(0, 300)}`);
    }
    throw new OllamaAuthError(
      `Received HTML response (HTTP ${response.status}) from Ollama — likely a Cloudflare Access challenge.${hint}`
    );
  }

  return response;
}

/**
 * Retry wrapper for transient errors (CF 524, connection drops, timeouts).
 * Uses exponential backoff: 2s, 4s, 8s between retries.
 *
 * @param {Function} fn - Async function to retry
 * @param {Object} config - App config (for debug logging)
 * @param {number} [maxRetries=3] - Max retry attempts
 * @returns {Promise<*>} Result of fn
 */
async function withRetry(fn, config, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const wait = 2 ** attempt * 1000; // 2s, 4s, 8s
      if (config.debug) {
        console.error(`[ollama] Retry ${attempt}/${maxRetries - 1} after ${wait / 1000}s...`);
      }
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Retry on timeout and connection errors, not auth/model errors
      if (err instanceof OllamaTimeoutError || err instanceof OllamaConnectionError) {
        continue;
      }
      throw err; // Auth/model errors: don't retry
    }
  }
  throw lastError;
}

/**
 * Strip <think>...</think> reasoning blocks from VLM output.
 * qwen3-vl wraps internal reasoning in think tags; we don't want them in final output.
 * @param {string} text
 * @returns {string}
 */
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}

/**
 * Read a streaming NDJSON response from Ollama, accumulating content chunks.
 *
 * Each line is a JSON object: {"message":{"content":"token"},"done":false}
 * Final line has "done":true with metadata (total_duration, done_reason, etc.)
 *
 * @param {Response} response - fetch Response with streaming body
 * @param {Object} config - app config (for debug logging)
 * @returns {Promise<{ content: string, doneReason: string|null, totalDuration: number|null }>}
 */
async function readStreamingResponse(response, config) {
  const chunks = [];
  let doneReason = null;
  let totalDuration = null;
  let evalCount = null;
  let contentLength = 0;
  let thinkingChunks = 0;

  // Inter-chunk timeout: if no data arrives within this window, cancel the stream.
  // With streaming, each token resets the timer. This replaces the total
  // AbortSignal.timeout — see cloudflare-tunnel-streaming-guide.md.
  const CHUNK_TIMEOUT = config.timeout || 300_000;
  let chunkTimer;
  const resetChunkTimer = () => {
    clearTimeout(chunkTimer);
    chunkTimer = setTimeout(() => {
      response.body.cancel().catch(() => {}); // Cancel stream on silence timeout
    }, CHUNK_TIMEOUT);
  };

  const decoder = new TextDecoder();
  let lineBuf = '';

  try {
    resetChunkTimer();
    for await (const rawChunk of response.body) {
      resetChunkTimer(); // Reset on every chunk received
      lineBuf += decoder.decode(rawChunk, { stream: true });

      // Process complete NDJSON lines
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        let data;
        try {
          data = JSON.parse(line);
        } catch {
          if (config.debug) {
            console.error(`[ollama] Skipping unparseable NDJSON line: ${line.slice(0, 100)}`);
          }
          continue;
        }

        // Server-side error
        if (data.error) {
          throw new OllamaConnectionError(`Ollama error: ${data.error}`);
        }

        // Track thinking vs content tokens
        if (data.message?.thinking) {
          thinkingChunks++;
        }

        const content = data.message?.content || '';
        if (content) {
          contentLength += content.length;
          if (contentLength > MAX_CONTENT_SIZE) {
            throw new OllamaConnectionError(
              `Ollama response content too large (>${(MAX_CONTENT_SIZE / 1024 / 1024).toFixed(0)}MB limit)`
            );
          }
          chunks.push(content);
          if (config.debug && chunks.length <= 3) {
            console.error(`[ollama] content chunk ${chunks.length}: ${JSON.stringify(content.slice(0, 80))}`);
          }
        }

        if (data.done) {
          doneReason = data.done_reason || null;
          totalDuration = data.total_duration || null;
          evalCount = data.eval_count || null;
        }
      }
    }
  } catch (err) {
    if (err instanceof OllamaConnectionError) throw err;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new OllamaTimeoutError(
        `Ollama streaming timed out (no data for ${CHUNK_TIMEOUT / 1000}s) after ${thinkingChunks} thinking + ${chunks.length} content chunks`
      );
    }
    throw new OllamaConnectionError(`Ollama stream error: ${err.message}`);
  } finally {
    clearTimeout(chunkTimer);
  }

  if (config.debug) {
    console.error(`[ollama] stream stats: ${thinkingChunks} thinking chunks, ${chunks.length} content chunks, eval_count=${evalCount}`);
  }

  // Process any remaining buffer content
  if (lineBuf.trim()) {
    try {
      const data = JSON.parse(lineBuf);
      if (data.error) throw new OllamaConnectionError(`Ollama error: ${data.error}`);
      const content = data.message?.content || '';
      if (content) chunks.push(content);
      if (data.done) {
        doneReason = data.done_reason || null;
        totalDuration = data.total_duration || null;
      }
    } catch (err) {
      if (err instanceof OllamaConnectionError) throw err;
      if (config.debug) {
        console.error(`[ollama] Ignoring trailing buffer: ${lineBuf.slice(0, 100)}`);
      }
    }
  }

  return { content: chunks.join(''), doneReason, totalDuration };
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
 * Prewarm the model by sending a text-only streaming request.
 * Loads the model into GPU memory so subsequent requests are fast.
 * Uses text-only (no image) because some VLMs crash on tiny/degenerate images.
 * Uses streaming to avoid CF tunnel idle timeouts during model load.
 *
 * @param {Object} config - App config with ollamaUrl, model
 * @returns {Promise<void>}
 */
export async function prewarm(config) {
  return withRetry(async () => {
    const url = `${config.ollamaUrl}/api/chat`;
    const body = {
      model: config.model,
      messages: [{
        role: 'user',
        content: 'Respond with "ready".',
      }],
      stream: true,
      think: false,
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

    await readStreamingResponse(response, config);
  }, config);
}

/**
 * Analyze one or more images with a prompt via the Ollama VLM.
 * Uses streaming NDJSON to avoid Cloudflare tunnel ~100s idle timeouts.
 *
 * Uses system message with "Do not think step by step" to prevent
 * qwen3-vl from consuming all tokens on thinking with no content output.
 *
 * @param {Object} options
 * @param {Object} options.config - App config
 * @param {string} options.systemPrompt - System message (sets role, disables thinking)
 * @param {string} options.prompt - User message with review instructions
 * @param {Buffer[]} options.images - Screenshot buffers (PNG/JPEG)
 * @returns {Promise<Object>} Parsed VLM response
 */
export async function analyze({ config, systemPrompt, prompt, images }) {
  return withRetry(async () => {
    const url = `${config.ollamaUrl}/api/chat`;
    const base64Images = images.map(buf => buf.toString('base64'));

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt, images: base64Images });

    const body = {
      model: config.model,
      messages,
      stream: true,
      keep_alive: '10m',
      options: {
        temperature: 0,
        num_predict: config.numPredict ?? 32768,
        num_ctx: config.numCtx ?? 32768,
      },
    };

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

    const { content, doneReason, totalDuration } = await readStreamingResponse(response, config);

    if (doneReason === 'length') {
      console.error('[ollama] Warning: response truncated — consider increasing num_predict');
    }

    if (config.debug) {
      const dur = totalDuration ? `${(totalDuration / 1e9).toFixed(1)}s` : 'unknown';
      console.error(`[ollama] analyze done: reason=${doneReason} duration=${dur} content=${content.length}chars`);
    }

    const cleaned = stripThinkTags(content);
    return parseVlmJson(cleaned);
  }, config);
}
