/**
 * Error class hierarchy for ui-review CLI tool.
 * Each error type maps to a distinct failure mode, enabling
 * targeted error messages at the CLI boundary.
 */

export class UiReviewError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Ollama server unreachable (connection refused, DNS failure) */
export class OllamaConnectionError extends UiReviewError {}

/** Ollama request timed out */
export class OllamaTimeoutError extends UiReviewError {}

/** CF Access authentication failed (403, HTML challenge page) */
export class OllamaAuthError extends UiReviewError {}

/** Requested model not found on Ollama server */
export class OllamaModelError extends UiReviewError {}

/** Ollama response error (content too large, server-side error in stream) — not retryable */
export class OllamaResponseError extends UiReviewError {}

/** Playwright screenshot capture failed */
export class CaptureError extends UiReviewError {}

/** Configuration validation error (bad manifest, missing env) */
export class ConfigError extends UiReviewError {}
