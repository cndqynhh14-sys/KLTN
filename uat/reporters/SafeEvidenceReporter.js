const fs = require('node:fs');
const path = require('node:path');
const { sanitizeString } = require('../../server/observability/redact');

function safeText(value) {
  return sanitizeString(String(value || '').replace(/\u001b\[[0-9;]*m/g, ''), 1200)
    .replace(/\b\d{6}\b/g, '[REDACTED_6_DIGIT]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
}

function xml(value) {
  return safeText(value).replace(/[<>&"']/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function html(value) {
  return xml(value).replace(/&apos;/g, '&#39;');
}

class SafeEvidenceReporter {
  constructor(options = {}) {
    this.outputDir = path.resolve(options.outputDir || process.env.UAT_OUTPUT_DIR || 'artifacts/uat-runs/unknown');
    this.quiet = options.quiet === true;
    this.results = [];
    this.startedAt = new Date().toISOString();
  }

  onBegin(config, suite) {
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.total = suite.allTests().length;
    this.config = {
      workers: config.workers,
      projects: config.projects.map((project) => project.name),
    };
  }

  onTestEnd(test, result) {
    this.results.push({
      title: safeText(test.titlePath().filter(Boolean).join(' > ')),
      status: result.status,
      duration_ms: result.duration,
      retry: result.retry,
      error: result.error ? safeText(result.error.message) : null,
      attachments: result.attachments.map((item) => ({
        name: safeText(item.name),
        content_type: safeText(item.contentType),
      })),
    });
  }

  onEnd(result) {
    const endedAt = new Date().toISOString();
    const document = {
      schema_version: 1,
      run_id: process.env.UAT_RUN_ID,
      mode: process.env.UAT_MODE,
      base_target: (() => {
        const url = new URL(process.env.UAT_BASE_URL);
        return `${url.origin}${url.pathname}`;
      })(),
      started_at: this.startedAt,
      ended_at: endedAt,
      status: result.status,
      total: this.total,
      tests: this.results,
      policy: {
        response_bodies_stored: false,
        cookies_stored: false,
        native_playwright_trace_stored: false,
        failure_screenshots_mask_sensitive: true,
      },
    };
    fs.writeFileSync(path.join(this.outputDir, 'report.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');

    const counts = this.results.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const rows = this.results.map((item) => `| ${item.title.replace(/\|/g, '\\|')} | ${item.status} | ${item.duration_ms} |`).join('\n');
    const markdown = `# UAT ${safeText(process.env.UAT_RUN_ID)}\n\n` +
      `- Mode: ${safeText(process.env.UAT_MODE)}\n` +
      `- Status: ${safeText(result.status)}\n` +
      `- Passed: ${counts.passed || 0}\n` +
      `- Failed: ${counts.failed || counts.timedOut || 0}\n` +
      `- Request context: see per-scenario safe-trace.ndjson files.\n\n` +
      `| Scenario | Status | Duration (ms) |\n|---|---:|---:|\n${rows}\n`;
    fs.writeFileSync(path.join(this.outputDir, 'report.md'), markdown, 'utf8');

    const cases = this.results.map((item) => {
      const failure = item.error ? `<failure message="${xml(item.error)}"/>` : '';
      return `<testcase name="${xml(item.title)}" time="${(item.duration_ms / 1000).toFixed(3)}">${failure}</testcase>`;
    }).join('');
    fs.writeFileSync(path.join(this.outputDir, 'report.junit.xml'),
      `<?xml version="1.0" encoding="UTF-8"?><testsuite name="QLCL UAT" tests="${this.results.length}" failures="${this.results.filter((item) => item.error).length}">${cases}</testsuite>\n`,
      'utf8');

    const cards = this.results.map((item) => `<tr><td>${html(item.title)}</td><td>${html(item.status)}</td><td>${item.duration_ms}</td></tr>`).join('');
    fs.writeFileSync(path.join(this.outputDir, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>QLCL UAT ${html(process.env.UAT_RUN_ID)}</title><style>body{font:14px system-ui;margin:2rem;color:#18212f}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border:1px solid #d6dbe3;text-align:left}</style><h1>QLCL UAT</h1><p>Run ${html(process.env.UAT_RUN_ID)} · ${html(process.env.UAT_MODE)} · ${html(result.status)}</p><table><thead><tr><th>Scenario</th><th>Status</th><th>Duration ms</th></tr></thead><tbody>${cards}</tbody></table></html>\n`, 'utf8');
    if (!this.quiet) process.stdout.write(`UAT ${safeText(process.env.UAT_RUN_ID)}: ${safeText(result.status)} (${this.results.length} scenario(s))\n`);
  }
}

module.exports = SafeEvidenceReporter;
module.exports.safeText = safeText;
