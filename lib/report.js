import { writeFileSync } from 'node:fs';

const SEVERITY_ORDER = { critical: 0, warning: 1, suggestion: 2 };
const SEVERITY_BADGES = { critical: 'CRITICAL', warning: 'WARNING', suggestion: 'suggestion' };

/**
 * Validate and sanitize a single issue from VLM output.
 * Ensures required fields are present and values are within allowed sets.
 */
const SEVERITIES = new Set(['critical', 'warning', 'suggestion']);
const CATEGORIES = new Set([
  'layout', 'typography', 'components', 'spacing',
  'visual-hierarchy', 'accessibility', 'responsive-fit',
]);

function sanitizeIssue(issue) {
  if (!issue || typeof issue !== 'object') return null;
  if (typeof issue.description !== 'string' || !issue.description) return null;
  if (!SEVERITIES.has(issue.severity)) return null;
  if (!CATEGORIES.has(issue.category)) return null;

  return {
    severity: issue.severity,
    category: issue.category,
    location: typeof issue.location === 'string' ? issue.location : 'unknown',
    description: issue.description,
    recommendation: typeof issue.recommendation === 'string' ? issue.recommendation : '',
  };
}

/**
 * Sanitize and validate a full review result from VLM output.
 *
 * @param {Object} data - Raw parsed VLM response
 * @param {Object} meta - { url, viewport }
 * @returns {Object} Sanitized review result
 */
export function sanitizeResult(data, meta = {}) {
  const rawIssues = Array.isArray(data?.issues) ? data.issues : [];
  const issues = rawIssues
    .map(sanitizeIssue)
    .filter(Boolean)
    .slice(0, 10)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  return {
    url: meta.url || '',
    viewport: meta.viewport || '',
    issues,
    summary: typeof data?.summary === 'string' ? data.summary : '',
    _raw: data?._raw || false,
  };
}

/**
 * Format a review result as JSON.
 *
 * @param {Object} result - Sanitized review result
 * @returns {string} JSON string
 */
export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}

/**
 * Format a review result as human-readable text.
 *
 * @param {Object} result - Sanitized review result
 * @returns {string}
 */
export function formatText(result) {
  const lines = [];

  lines.push(`UI Review: ${result.url}`);
  lines.push(`Viewport: ${result.viewport}`);
  lines.push('─'.repeat(60));

  if (result.summary) {
    lines.push(`\nSummary: ${result.summary}\n`);
  }

  if (result.issues.length === 0) {
    lines.push('No issues found.');
  } else {
    lines.push(`Found ${result.issues.length} issue(s):\n`);

    for (const [i, issue] of result.issues.entries()) {
      const badge = SEVERITY_BADGES[issue.severity] || issue.severity;
      lines.push(`  ${i + 1}. [${badge}] [${issue.category}]`);
      lines.push(`     Location: ${issue.location}`);
      lines.push(`     ${issue.description}`);
      if (issue.recommendation) {
        lines.push(`     Fix: ${issue.recommendation}`);
      }
      lines.push('');
    }
  }

  if (result._raw) {
    lines.push('\nNote: VLM response could not be parsed as structured JSON. Results may be incomplete.');
  }

  return lines.join('\n');
}

/**
 * Write a review result to stdout or a file.
 *
 * @param {Object} result - Sanitized review result
 * @param {Object} options
 * @param {string} [options.format='json'] - 'json' or 'text'
 * @param {string} [options.output] - File path to write to (stdout if omitted)
 */
export function writeReport(result, { format = 'json', output } = {}) {
  const content = format === 'text' ? formatText(result) : formatJson(result);

  if (output) {
    writeFileSync(output, content, 'utf8');
  } else {
    process.stdout.write(content + '\n');
  }
}
