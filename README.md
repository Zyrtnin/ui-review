# ui-review

Automated UI/UX review CLI tool using Qwen3-VL vision model via Ollama.

Captures screenshots of web pages with Playwright and analyzes them with a self-hosted vision language model to identify UI/UX issues.

## Requirements

- Node.js >= 22.0.0
- Ollama with `qwen3-vl:8b` model pulled
- Chromium (installed via Playwright)

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env  # edit with your Ollama URL
```

Pull the vision model:
```bash
ollama pull qwen3-vl:8b
```

## Usage

```bash
# Basic review (JSON output)
npx ui-review https://example.com

# Human-readable text output
npx ui-review https://example.com --format text

# Specific viewport
npx ui-review https://example.com --viewport mobile

# Dry run (capture screenshot only, skip VLM analysis)
npx ui-review https://example.com --dry-run

# Debug mode
npx ui-review https://example.com --debug

# Write report to file
npx ui-review https://example.com --output report.json

# Remote Ollama via Cloudflare tunnel
OLLAMA_URL=https://ollama.example.com \
CF_ACCESS_CLIENT_ID=xxx \
CF_ACCESS_CLIENT_SECRET=yyy \
npx ui-review https://example.com
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--ollama-url <url>` | Ollama server URL | `http://localhost:11434` |
| `--model <name>` | Vision model | `qwen3-vl:8b` |
| `--timeout <ms>` | Request timeout | `120000` |
| `--viewport <names>` | Comma-separated viewports | `desktop` |
| `--format <type>` | `json` or `text` | `json` |
| `--output <path>` | Write to file | stdout |
| `--dry-run` | Capture only, skip analysis | off |
| `--debug` | Verbose logging | off |
| `--ignore-https-errors` | Skip TLS validation | off |
| `--allow-private` | Allow private IPs | off |

## Viewports

| Name | Resolution |
|------|-----------|
| desktop | 1920x1080 |
| laptop | 1366x768 |
| tablet | 768x1024 |
| mobile | 375x812 |
