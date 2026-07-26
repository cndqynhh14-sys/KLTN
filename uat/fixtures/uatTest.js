const path = require('node:path');
const { test: base, expect } = require('@playwright/test');
const { loadUatConfig, assertRequestAllowed, safeUrl } = require('../helpers/runtimeConfig');
const { createSafeTrace } = require('../helpers/safeTrace');

const test = base.extend({
  uat: [async ({ context, page }, use, testInfo) => {
    const config = loadUatConfig();
    const trace = createSafeTrace(config.outputDir, testInfo.titlePath.join(' '));
    const stagingState = { cleanupRegistered: Boolean(config.cleanupModule) };
    const safetyViolations = [];

    if (config.mode === 'local') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: config.origin });
    }
    await context.setExtraHTTPHeaders({ 'X-UAT-Run-Id': config.runId });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (!/^https?:/i.test(url)) return route.continue();
      try {
        const decision = assertRequestAllowed(config, {
          method: request.method(),
          url,
          postData: request.postData() || '',
        }, stagingState);
        trace.record('http.request', {
          method: request.method(),
          url: safeUrl(url),
          safety_decision: decision.reason,
        });
        await route.continue();
      } catch (error) {
        safetyViolations.push(trace.sanitize(error.message));
        trace.record('safety.request_blocked', {
          method: request.method(),
          url: safeUrl(url),
          error_message: error.message,
        });
        await route.abort('blockedbyclient');
      }
    });

    page.on('response', (response) => trace.recordResponse(response));
    page.on('requestfailed', (request) => trace.record('http.request_failed', {
      method: request.method(),
      url: safeUrl(request.url()),
      error_message: request.failure() && request.failure().errorText,
    }));
    page.on('pageerror', (error) => trace.record('browser.page_error', { error_message: error.message }));

    trace.record('scenario.started', { mode: config.mode, uat_run_id: config.runId });
    await use({ config, trace, dataPrefix: config.dataPrefix });

    if (config.cleanupModule) {
      const cleanup = require(config.cleanupModule);
      if (typeof cleanup !== 'function') throw new Error('UAT_CLEANUP_MODULE must export a cleanup function.');
      await cleanup({ runId: config.runId, prefix: config.dataPrefix, baseUrl: config.baseUrl });
      trace.record('staging.cleanup_completed');
    }

    const failed = testInfo.status !== testInfo.expectedStatus || safetyViolations.length > 0;
    if (failed) {
      const screenshotPath = path.join(trace.scenarioDir, 'failure-masked.png');
      const mask = [
        page.locator('[data-sensitive="true"]'),
        page.locator('[data-sensitive="otp"]'),
        page.locator('input[type="password"]'),
        page.locator('input[autocomplete="one-time-code"]'),
      ];
      await page.screenshot({ path: screenshotPath, fullPage: true, mask }).catch((error) => {
        trace.record('browser.screenshot_failed', { error_message: error.message });
      });
      if (require('node:fs').existsSync(screenshotPath)) {
        await testInfo.attach('failure-masked', { path: screenshotPath, contentType: 'image/png' });
      }
    }

    const written = trace.write(failed ? 'failed' : 'passed');
    await testInfo.attach('safe-trace', { path: written.tracePath, contentType: 'application/x-ndjson' });
    await testInfo.attach('request-context', {
      body: Buffer.from(JSON.stringify({ request_ids: written.requestIds, correlation_ids: written.correlationIds })),
      contentType: 'application/json',
    });
    if (safetyViolations.length) throw new Error(`UAT safety guard blocked ${safetyViolations.length} request(s).`);
  }, { auto: true }],
});

module.exports = { test, expect };
