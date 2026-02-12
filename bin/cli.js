#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig, VIEWPORTS } from '../lib/config.js';
import { healthCheck, prewarm, analyze } from '../lib/ollama.js';
import { captureScreenshot } from '../lib/capture.js';
import { loadPrompt } from '../lib/prompts.js';
import { sanitizeResult, writeReport } from '../lib/report.js';
import { UiReviewError } from '../lib/errors.js';

const program = new Command();

program
  .name('ui-review')
  .description('Automated UI/UX review using Qwen3-VL vision model via Ollama')
  .version('0.1.0')
  .argument('<url>', 'URL of the page to review')
  .option('--ollama-url <url>', 'Ollama server URL')
  .option('--model <name>', 'Vision model name')
  .option('--timeout <ms>', 'Ollama request timeout in milliseconds', parseInt)
  .option('--viewport <names>', `Comma-separated viewports (${Object.keys(VIEWPORTS).join(', ')})`)
  .option('--format <type>', 'Output format: json or text', 'json')
  .option('--output <path>', 'Write report to file instead of stdout')
  .option('--concurrency <n>', 'Max concurrent screenshots', parseInt)
  .option('--dry-run', 'Capture screenshot but skip VLM analysis')
  .option('--debug', 'Enable verbose debug logging')
  .option('--ignore-https-errors', 'Ignore TLS certificate errors')
  .option('--allow-private', 'Allow URLs that resolve to private/internal IPs')
  .action(run);

async function run(url, opts) {
  let config;
  try {
    config = loadConfig({ cliArgs: opts });
  } catch (err) {
    if (err instanceof UiReviewError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (config.debug) {
    console.error('[config]', JSON.stringify(config, null, 2));
  }

  // Use first configured viewport for single-URL mode
  const viewport = config.resolvedViewports[0];

  try {
    // Step 1: Capture screenshot
    console.error(`Capturing ${url} at ${viewport.name} (${viewport.width}x${viewport.height})...`);
    const buffer = await captureScreenshot({
      url,
      viewport,
      config,
      allowPrivate: opts.allowPrivate || false,
    });
    console.error(`Screenshot captured: ${(buffer.length / 1024).toFixed(0)}KB`);

    // Step 2: Dry-run exits here
    if (opts.dryRun) {
      console.error('Dry run — skipping VLM analysis.');
      const dryResult = sanitizeResult(
        { issues: [], summary: 'Dry run — no analysis performed.' },
        { url, viewport: viewport.name }
      );
      writeReport(dryResult, { format: config.format, output: config.output });
      return;
    }

    // Step 3: Health check + prewarm
    console.error(`Checking Ollama at ${config.ollamaUrl}...`);
    const { models } = await healthCheck(config);
    if (!models.some(m => m.startsWith(config.model.split(':')[0]))) {
      console.error(`Warning: Model "${config.model}" not found in available models: ${models.join(', ')}`);
      console.error(`Attempting to proceed anyway (model may be pulled on demand).`);
    }

    console.error(`Prewarming model ${config.model}...`);
    await prewarm(config);

    // Step 4: Analyze with VLM (streaming NDJSON)
    console.error(`Analyzing with ${config.model}...`);
    const systemPrompt = loadPrompt('review-system');
    const prompt = loadPrompt('review', {
      viewport: viewport.name,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      url,
    });

    const raw = await analyze({
      config,
      systemPrompt,
      prompt,
      images: [buffer],
    });

    const result = sanitizeResult(raw, { url, viewport: viewport.name });
    writeReport(result, { format: config.format, output: config.output });

    // Summary to stderr
    const counts = { critical: 0, warning: 0, suggestion: 0 };
    for (const issue of result.issues) {
      counts[issue.severity] = (counts[issue.severity] || 0) + 1;
    }
    console.error(
      `Done: ${result.issues.length} issue(s) — ` +
      `${counts.critical} critical, ${counts.warning} warning, ${counts.suggestion} suggestion`
    );

    // Exit with non-zero if critical issues found
    if (counts.critical > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof UiReviewError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(`Unexpected error: ${err.message}`);
      if (config.debug) console.error(err.stack);
      process.exitCode = 2;
    }
  }
}

program.parse();
