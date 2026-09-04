const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { sanitizeString } = require('../server/observability/redact');

const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || 'local';
const scenarioIndex = process.argv.indexOf('--scenario');
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : 'smoke';
const grepByScenario = {
  smoke: '@smoke',
  run05: '@smoke RUN-05',
  full: '@full',
  prompt124: '@prompt124',
  phase4: '@phase4',
  'evidence-failure': '@evidence-failure',
};

if (!grepByScenario[scenario]) {
  process.stderr.write(`Unsupported UAT scenario: ${sanitizeString(scenario)}\n`);
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), delay(5000)]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function waitForHealth(origin, child, logs) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Local UAT server exited early (${child.exitCode}): ${logs.slice(-5).join(' | ')}`);
    try {
      const response = await fetch(`${origin}/qlcl/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Timed out waiting for local UAT server: ${logs.slice(-5).join(' | ')}`);
}

function writeCiOutput(runId, outputDir) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${runId}\nrun_dir=${outputDir.replace(/\\/g, '/')}\n`, 'utf8');
}

function localBrowserChannel() {
  if (process.env.UAT_BROWSER_CHANNEL) return process.env.UAT_BROWSER_CHANNEL;
  if (process.platform !== 'win32') return '';
  const chrome = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find((candidate) => fs.existsSync(candidate));
  if (chrome) return 'chrome';
  const edge = [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => fs.existsSync(candidate));
  return edge ? 'msedge' : '';
}

async function main() {
  const runId = process.env.UAT_RUN_ID || crypto.randomUUID();
  const outputDir = path.join(root, 'artifacts', 'uat-runs', runId);
  fs.mkdirSync(outputDir, { recursive: true });
  let tempDir = null;
  let serverProcess = null;
  let baseUrl = process.env.UAT_BASE_URL;
  const serverLogs = [];
  const playwrightTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-uat-pw-'));

  try {
    if (mode === 'local') {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-uat-'));
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      baseUrl = `${origin}/qlcl/`;
      const adminEmail = `uat.${runId.slice(0, 8)}@winmart.masangroup.com`;
      const managerEmail = `uat.manager.${runId.slice(0, 8)}@winmart.masangroup.com`;
      serverProcess = spawn(process.execPath, ['server/index.js'], {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          HOST: '127.0.0.1',
          PORT: String(port),
          JWT_SECRET: `synthetic-uat-${runId}`,
          ADMIN_EMAILS: adminEmail,
          DB_PATH: path.join(tempDir, 'qlcl-uat.db'),
          DATA_DIR: tempDir,
          ATTACHMENT_DIR: path.join(tempDir, 'attachments'),
          REPORT_EXPORT_DIR: path.join(tempDir, 'report-exports'),
          OTP_DELIVERY_MODE: 'screen',
          OTP_HMAC_SECRET: `synthetic-uat-otp-hmac-${runId}`,
          SCREEN_OTP_ENABLED: 'true',
          SCREEN_OTP_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          SCREEN_OTP_OWNER: 'synthetic-uat-security-owner@example.test',
          SCREEN_OTP_ALLOWED_EMAILS: `${adminEmail},${managerEmail}`,
          SCREEN_OTP_DEV_RELAXED: 'false',
          DEV_SHOW_OTP: 'false',
          SHOW_TEST_OTP: 'false',
          USE_IN_MEMORY_OTP: 'true',
          EMAIL_MODE: 'console',
          UAT_RUN_ID: runId,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const collect = (chunk) => {
        const line = sanitizeString(chunk.toString(), 800);
        serverLogs.push(line);
        if (serverLogs.length > 100) serverLogs.shift();
      };
      serverProcess.stdout.on('data', collect);
      serverProcess.stderr.on('data', collect);
      await waitForHealth(origin, serverProcess, serverLogs);
      process.env.UAT_ADMIN_EMAIL = adminEmail;
      process.env.UAT_MANAGER_EMAIL = managerEmail;
    }

    if (!baseUrl) throw new Error(`${mode} mode requires UAT_BASE_URL.`);
    process.env.UAT_MODE = mode;
    process.env.UAT_RUN_ID = runId;
    process.env.UAT_BASE_URL = baseUrl;
    process.env.UAT_OUTPUT_DIR = outputDir;
    process.env.UAT_PLAYWRIGHT_TEMP_DIR = playwrightTempDir;
    const browserChannel = localBrowserChannel();
    if (browserChannel) process.env.UAT_BROWSER_CHANNEL = browserChannel;
    if (scenario === 'evidence-failure') process.env.UAT_EXPECT_FAILURE = 'true';

    fs.writeFileSync(path.join(outputDir, 'run-meta.json'), `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      mode,
      scenario,
      base_target: (() => { const url = new URL(baseUrl); return `${url.origin}${url.pathname}`; })(),
      started_at: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      browser_channel: browserChannel || 'playwright-chromium',
      temp_data_cleaned_by_runner: mode === 'local',
    }, null, 2)}\n`, 'utf8');
    writeCiOutput(runId, outputDir);

    const cli = require.resolve('@playwright/test/cli');
    const child = spawn(process.execPath, [cli, 'test', '--config', 'uat/playwright.config.js', '--grep', grepByScenario[scenario]], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    const [status] = await once(child, 'exit');
    process.stdout.write(`UAT_RUN_ID=${runId}\nUAT_OUTPUT_DIR=${outputDir}\n`);
    return status == null ? 1 : status;
  } finally {
    await stop(serverProcess);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(playwrightTempDir, { recursive: true, force: true });
  }
}

main().then((status) => process.exit(status)).catch((error) => {
  process.stderr.write(`${sanitizeString(error.message)}\n`);
  process.exit(1);
});
