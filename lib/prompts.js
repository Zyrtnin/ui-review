import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Cache for loaded prompt templates (they don't change during a run) */
const cache = new Map();

/**
 * Load a prompt template from the prompts/ directory.
 *
 * Templates support {{variable}} placeholders that are replaced
 * by the provided variables object.
 *
 * @param {string} name - Prompt file name without extension (e.g., 'review')
 * @param {Object} [variables={}] - Template variables to inject
 * @returns {string} The rendered prompt text
 */
export function loadPrompt(name, variables = {}) {
  let template = cache.get(name);

  if (!template) {
    const promptsDir = join(import.meta.dirname, '..', 'prompts');
    const filePath = join(promptsDir, `${name}.txt`);
    template = readFileSync(filePath, 'utf8');
    cache.set(name, template);
  }

  // Replace {{variable}} placeholders
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, String(value));
  }

  return rendered;
}

/**
 * Clear the prompt cache (useful for testing).
 */
export function clearPromptCache() {
  cache.clear();
}
