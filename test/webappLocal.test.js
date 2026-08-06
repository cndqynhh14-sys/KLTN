const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { MCH3_BY_MCH2 } = require('../server/domain/merchandising');
const { BUSINESS_TYPE_OPTIONS, PROVINCES_BY_REGION } = require('../server/domain/masterData');

const enabled = process.env.RUN_WEBAPP_E2E === '1';
const root = path.resolve(__dirname, '..');
const adminEmail = 'e2e.admin@winmart.masangroup.com';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(origin, serverProcess, logs) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode != null) {
      throw new Error(`Server exited early with code ${serverProcess.exitCode}.\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${origin}/qlcl/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for local server.\n${logs.join('')}`);
}

async function stopServer(serverProcess) {
  if (!serverProcess || serverProcess.exitCode != null) return;
  serverProcess.kill();
  await Promise.race([
    once(serverProcess, 'exit'),
    delay(5000),
  ]);
}

async function launchChromium() {
  const { chromium } = require('playwright');
  try {
    return await chromium.launch();
  } catch (error) {
    if (/Executable doesn't exist|Please run.*playwright install/i.test(error.message)) {
      throw new Error('Playwright Chromium is not installed. Run `npx playwright install chromium`, then retry `npm run test:webapp`.');
    }
    throw error;
  }
}

async function openRoute(page, route, visibleSelector) {
  await page.evaluate((nextRoute) => {
    window.location.hash = nextRoute;
  }, route);
  await page.waitForSelector(visibleSelector, { state: 'visible', timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

test('local webapp renders, authenticates with guarded screen OTP, and opens evaluation-only core routes', {
  skip: enabled ? false : 'Set RUN_WEBAPP_E2E=1 or run `npm run test:webapp`.',
  timeout: 120000,
}, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-webapp-e2e-'));
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const unexpectedResponses = [];
  const requestFailures = [];
  const pageErrors = [];

  const serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      JWT_SECRET: 'webapp-e2e-secret',
      ADMIN_EMAILS: adminEmail,
      DB_PATH: path.join(tempDir, 'qlcl-e2e.db'),
      DATA_DIR: tempDir,
      ATTACHMENT_DIR: path.join(tempDir, 'evaluation-attachments'),
      REPORT_EXPORT_DIR: path.join(tempDir, 'report-exports'),
      OTP_DELIVERY_MODE: 'screen',
      OTP_HMAC_SECRET: 'synthetic-webapp-otp-hmac-secret-distinct-from-jwt',
      SCREEN_OTP_ENABLED: 'true',
      SCREEN_OTP_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      SCREEN_OTP_OWNER: 'synthetic-webapp-owner@example.test',
      SCREEN_OTP_ALLOWED_EMAILS: adminEmail,
      SCREEN_OTP_DEV_RELAXED: 'false',
      DEV_SHOW_OTP: 'false',
      SHOW_TEST_OTP: 'false',
      USE_IN_MEMORY_OTP: 'true',
      EMAIL_MODE: 'console',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  serverProcess.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  let browser;
  t.after(async () => {
    if (browser) await browser.close();
    await stopServer(serverProcess);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForHealth(origin, serverProcess, logs);
  browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    const allowed =
      (status === 401 && url.endsWith('/qlcl/api/auth/me')) ||
      (status === 400 && url.endsWith('/qlcl/api/auth/request-otp'));
    if (!allowed) unexpectedResponses.push(`${status} ${url}`);
  });

  await page.goto(`${origin}/qlcl/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-login', { state: 'visible' });
  assert.match(await page.title(), /QLCL/);
  assert.equal(await page.locator('#main').isHidden(), true);
  assert.equal(await page.locator('#sidebar').isHidden(), true);

  await page.fill('#email', 'outside@example.com');
  await page.click('#btn-send-otp');
  await page.waitForFunction(() => /domain|Masan|email/i.test(document.querySelector('#login-msg')?.textContent || ''));
  assert.match(await page.locator('#login-msg').textContent(), /domain|Masan|email/i);

  await page.fill('#email', adminEmail);
  await page.click('#btn-send-otp');
  await page.waitForSelector('#view-otp', { state: 'visible' });
  await page.click('#btn-copy-screen-otp');
  await page.waitForFunction(() => /sao chép/i.test(document.querySelector('#otp-msg')?.textContent || ''));
  await page.focus('#otp');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await page.click('#btn-verify');
  await page.waitForSelector('#main', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('#sidebar', { state: 'visible' });
  await page.waitForFunction((email) => document.querySelector('#user-email')?.textContent === email, adminEmail);
  assert.equal(await page.locator('#view-login').isHidden(), true);
  assert.ok(await page.locator('#month-picker option').count() >= 1);

  await openRoute(page, '/dashboard', '#view-overview');
  await page.waitForFunction(() => document.querySelectorAll('#statistics-kpi-cards .statistics-kpi-card').length === 4);
  assert.match(page.url(), /#\/dashboard\?periodType=MONTH&periodValue=\d{4}-\d{2}$/);
  assert.equal(await page.locator('#quality-trend-canvas').isVisible(), true);
  assert.equal(await page.locator('#status-donut-canvas').isVisible(), true);
  assert.equal(await page.locator('#statistics-ranking-body').count(), 1);
  assert.equal(await page.locator('.statistics-titlebar').count(), 0);
  assert.equal(await page.locator('#dashboard-statistics-tabs').count(), 0);
  assert.equal(await page.locator('#module-navigation').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.statistics-titlebar, #dashboard-statistics-tabs').count(), 0);
  assert.equal(await page.locator('#statistics-kpi-cards .statistics-kpi-card').count(), 4);
  await page.setViewportSize({ width: 1366, height: 900 });

  await openRoute(page, '/evaluations', '#view-evaluations');
  await page.waitForFunction(() => document.querySelector('#eval-page-meta')?.textContent.trim().length > 0);
  assert.equal(
    (await page.locator('#eval-empty').isVisible()) || (await page.locator('#eval-tbody tr').count() > 0),
    true,
  );

  await openRoute(page, '/suppliers', '#view-suppliers');
  await page.waitForFunction(() => document.querySelector('#supplier-page-meta')?.textContent.trim().length > 0);
  assert.ok(await page.locator('#supplier-tbody tr').count() >= 1);

  await openRoute(page, '/reports', '#view-reports');
  assert.equal(await page.locator('#report-tbody').count(), 1);
  assert.equal(
    (await page.locator('#report-empty').isVisible()) || (await page.locator('#report-tbody tr').count() > 0),
    true,
  );

  await openRoute(page, '/admin/users', '#view-admin');
  await page.waitForFunction((email) => document.querySelector('#admin-users-tbody')?.textContent.includes(email), adminEmail);
  assert.equal(await page.locator('#nav-admin').isVisible(), true);
  await page.click('[data-authz-tab="roles"]');
  await page.waitForFunction(() => document.querySelector('#authz-role-list')?.textContent.includes('SYS_ADMIN'));
  assert.equal(await page.locator('#authz-role-form').isVisible(), true);
  await page.click('[data-authz-tab="permissions"]');
  await page.waitForFunction(() => document.querySelector('#authz-permission-matrix')?.textContent.includes('SYSTEM.ADMIN'));
  await page.click('[data-authz-tab="users"]');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requestFailures, []);
  assert.deepEqual(unexpectedResponses, []);
});
