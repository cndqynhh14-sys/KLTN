const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertRequestAllowed,
  assertTargetBoundary,
  loadUatConfig,
  parseBaseUrl,
} = require('../uat/helpers/runtimeConfig');
const { createSafeTrace } = require('../uat/helpers/safeTrace');
const SafeEvidenceReporter = require('../uat/reporters/SafeEvidenceReporter');

const RUN_ID = 'run-04-production-guard-0001';

function productionConfig(overrides = {}) {
  return loadUatConfig({
    UAT_MODE: 'production-readonly',
    UAT_RUN_ID: RUN_ID,
    UAT_BASE_URL: 'https://quality.example.com/qlcl/',
    UAT_PRODUCTION_HOSTS: 'quality.example.com',
    ...overrides,
  });
}

test('UAT config fails closed on URL typo, ambiguous target and base-path edge cases', () => {
  assert.throws(() => parseBaseUrl('quality.example.com/qlcl'), /absolute URL/);
  assert.throws(() => parseBaseUrl('https://quality.example.com/qlcl-evil'), /exact \/qlcl/);
  assert.throws(() => parseBaseUrl('https://quality.example.com/qlcl/?next=evil'), /Query strings/);
  assert.throws(() => productionConfig({ UAT_BASE_URL: 'https://quality.example.com.evil/qlcl/' }), /exact UAT_PRODUCTION_HOSTS/);
  assert.throws(() => productionConfig({ UAT_PRODUCTION_HOSTS: '' }), /exact UAT_PRODUCTION_HOSTS/);
  assert.throws(() => productionConfig({ UAT_BASE_URL: 'https://quality.example.com:444/qlcl/' }), /exact UAT_PRODUCTION_HOSTS/);
  assert.throws(() => loadUatConfig({
    UAT_MODE: 'staging', UAT_RUN_ID: RUN_ID, UAT_BASE_URL: 'http://staging.example.com/qlcl/',
  }), /non-production HTTPS/);
  assert.throws(() => loadUatConfig({
    UAT_MODE: 'staging', UAT_RUN_ID: RUN_ID, UAT_BASE_URL: 'https://staging.example.com/qlcl/',
  }), /UAT_PRODUCTION_HOSTS/);
});

test('production-readonly blocks every non-auth mutation and cannot be bypassed by redirect or path prefix', () => {
  const config = productionConfig();
  assert.deepEqual(assertRequestAllowed(config, {
    method: 'GET', url: 'https://quality.example.com/qlcl/api/suppliers',
  }), { allowed: true, reason: 'read_only' });
  assert.deepEqual(assertRequestAllowed(config, {
    method: 'POST', url: 'https://quality.example.com/qlcl/api/auth/request-otp',
  }), { allowed: true, reason: 'auth_allowlist' });
  assert.throws(() => assertRequestAllowed(config, {
    method: 'POST', url: 'https://quality.example.com/qlcl/api/suppliers', postData: '{}',
  }), /Production mutation blocked/);
  assert.throws(() => assertRequestAllowed(config, {
    method: 'POST', url: 'https://quality.example.com/qlcl/api/auth/request-otp/extra', postData: '{}',
  }), /Production mutation blocked/);
  assert.throws(() => assertRequestAllowed(config, {
    method: 'POST', url: 'https://quality.example.com/qlcl/api/auth/request-otp?next=mutation', postData: '{}',
  }), /Production mutation blocked/);
  assert.throws(() => assertTargetBoundary(config, 'https://quality.example.com.evil/qlcl/api/health'), /escaped configured origin/);
  assert.throws(() => assertTargetBoundary(config, 'https://quality.example.com/qlcl-evil/api/health'), /escaped configured base path/);
  assert.throws(() => assertTargetBoundary(config, 'https://other.example.com/qlcl/api/health'), /escaped configured origin/);
});

test('staging mutations require flag, exact non-production URL, run prefix and registered cleanup', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-uat-config-'));
  fs.writeFileSync(path.join(tempRoot, 'cleanup.js'), 'module.exports = async () => {};\n');
  try {
    const base = {
      UAT_MODE: 'staging',
      UAT_RUN_ID: RUN_ID,
      UAT_BASE_URL: 'https://staging.example.com/qlcl/',
      UAT_PRODUCTION_HOSTS: 'quality.example.com',
    };
    const readOnly = loadUatConfig(base, tempRoot);
    assert.throws(() => assertRequestAllowed(readOnly, {
      method: 'POST', url: 'https://staging.example.com/qlcl/api/suppliers', postData: '{}',
    }), /ALLOW_MUTATION/);
    assert.throws(() => loadUatConfig({ ...base, ALLOW_MUTATION: 'true' }, tempRoot), /UAT_CLEANUP_MODULE/);

    const mutable = loadUatConfig({
      ...base, ALLOW_MUTATION: 'true', UAT_CLEANUP_MODULE: 'cleanup.js',
    }, tempRoot);
    assert.throws(() => assertRequestAllowed(mutable, {
      method: 'POST', url: 'https://staging.example.com/qlcl/api/suppliers', postData: `{\"name\":\"${mutable.dataPrefix}NCC\"}`,
    }, { cleanupRegistered: false }), /cleanup is not registered/);
    assert.throws(() => assertRequestAllowed(mutable, {
      method: 'POST', url: 'https://staging.example.com/qlcl/api/suppliers', postData: '{"name":"ordinary"}',
    }, { cleanupRegistered: true }), /missing run prefix/);
    assert.throws(() => assertRequestAllowed(mutable, {
      method: 'POST', url: 'https://staging.example.com/qlcl/api/suppliers', postData: `{\"name\":\"ordinary\",\"note\":\"contains ${mutable.dataPrefix} elsewhere\"}`,
    }, { cleanupRegistered: true }), /missing run prefix/);
    assert.equal(assertRequestAllowed(mutable, {
      method: 'POST', url: 'https://staging.example.com/qlcl/api/suppliers', postData: `{\"name\":\"${mutable.dataPrefix}NCC\"}`,
    }, { cleanupRegistered: true }).reason, 'staging_guarded_mutation');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('safe trace stores request metadata and IDs but no bodies, cookies or query values', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-uat-trace-'));
  try {
    const trace = createSafeTrace(tempDir, 'failure scenario');
    trace.recordResponse({
      url: () => 'https://quality.example.com/qlcl/api/health?token=must-not-appear',
      status: () => 200,
      headers: () => ({
        'x-request-id': 'request-run04-0001',
        'x-correlation-id': 'correlation-run04-0001',
        'x-uat-run-id': RUN_ID,
        'set-cookie': 'must-not-appear',
      }),
      request: () => ({ method: () => 'GET' }),
    });
    const written = trace.write('failed');
    const content = fs.readFileSync(written.tracePath, 'utf8');
    assert.match(content, /request-run04-0001/);
    assert.match(content, /correlation-run04-0001/);
    assert.doesNotMatch(content, /must-not-appear/);
    assert.doesNotMatch(content, /set-cookie|response_body|request_body/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('safe reporter emits HTML, JSON, JUnit and Markdown with sensitive failure text redacted', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-uat-reporter-'));
  const old = {
    UAT_RUN_ID: process.env.UAT_RUN_ID,
    UAT_MODE: process.env.UAT_MODE,
    UAT_BASE_URL: process.env.UAT_BASE_URL,
  };
  process.env.UAT_RUN_ID = RUN_ID;
  process.env.UAT_MODE = 'local';
  process.env.UAT_BASE_URL = 'http://127.0.0.1:3999/qlcl/';
  try {
    const reporter = new SafeEvidenceReporter({ outputDir: tempDir, quiet: true });
    reporter.onBegin({ workers: 1, projects: [{ name: 'chromium' }] }, { allTests: () => [{}] });
    reporter.onTestEnd({ titlePath: () => ['suite', 'scenario'] }, {
      status: 'failed', duration: 12, retry: 0,
      error: { message: 'otp=654321 token=abc user@masangroup.com' },
      attachments: [{ name: 'safe-trace', contentType: 'application/x-ndjson' }],
    });
    reporter.onEnd({ status: 'failed' });
    for (const file of ['report.html', 'report.json', 'report.junit.xml', 'report.md']) {
      assert.equal(fs.existsSync(path.join(tempDir, file)), true);
      const content = fs.readFileSync(path.join(tempDir, file), 'utf8');
      assert.doesNotMatch(content, /654321|token=abc|user@masangroup\.com/);
    }
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
