const fs = require('node:fs');
const path = require('node:path');
const { redact, sanitizeString } = require('../../server/observability/redact');
const { safeUrl } = require('./runtimeConfig');

function safeSlug(value) {
  return String(value || 'scenario').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'scenario';
}

function createSafeTrace(outputDir, title) {
  const scenarioDir = path.join(outputDir, 'scenarios', safeSlug(title));
  fs.mkdirSync(scenarioDir, { recursive: true });
  const events = [];
  const requestIds = new Set();
  const correlationIds = new Set();

  function record(eventName, details = {}) {
    const entry = redact({
      timestamp: new Date().toISOString(),
      event_name: eventName,
      ...details,
    }, { maxStringLength: 512, maxArrayLength: 20, maxDepth: 4 });
    events.push(entry);
    if (entry.request_id && entry.request_id !== '[REDACTED]') requestIds.add(entry.request_id);
    if (entry.correlation_id && entry.correlation_id !== '[REDACTED]') correlationIds.add(entry.correlation_id);
  }

  function recordResponse(response) {
    const headers = response.headers();
    record('http.response', {
      method: response.request().method(),
      url: safeUrl(response.url()),
      status: response.status(),
      request_id: headers['x-request-id'] || null,
      correlation_id: headers['x-correlation-id'] || null,
      uat_run_id: headers['x-uat-run-id'] || null,
    });
  }

  function write(status) {
    record('scenario.completed', {
      status,
      request_ids: [...requestIds],
      correlation_ids: [...correlationIds],
    });
    const tracePath = path.join(scenarioDir, 'safe-trace.ndjson');
    fs.writeFileSync(tracePath, `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    return {
      scenarioDir,
      tracePath,
      requestIds: [...requestIds],
      correlationIds: [...correlationIds],
    };
  }

  return { record, recordResponse, write, scenarioDir, sanitize: sanitizeString };
}

module.exports = { createSafeTrace, safeSlug };
