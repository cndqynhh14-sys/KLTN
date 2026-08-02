'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'synthetic-run09-jwt-secret-for-tests';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
  PRODUCTION_SCREEN_ACK,
  otpReadiness,
  resolveOtpDeliveryConfig,
} = require('../server/domain/otpDelivery');
const {
  MemoryOtpStore,
  OtpSessionService,
} = require('../server/services/otp');
const {
  createAuthRouter,
  createRequestOtpLimiter,
  requestRateLimitKey,
} = require('../server/routes/auth');

const root = path.resolve(__dirname, '..');
const NOW = new Date('2026-07-14T10:00:00.000Z');
const ELIGIBLE_EMAIL = 'run09.user@winmart.masangroup.com';
const UNKNOWN_EMAIL = 'unknown@winmart.masangroup.com';
const DISABLED_EMAIL = 'disabled@winmart.masangroup.com';
const HMAC_SECRET = 'synthetic-run09-otp-hmac-secret-32-bytes-minimum';

function screenEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    JWT_SECRET: 'synthetic-run09-jwt-secret-distinct',
    OTP_HMAC_SECRET: HMAC_SECRET,
    OTP_DELIVERY_MODE: 'screen',
    SCREEN_OTP_ENABLED: 'true',
    SCREEN_OTP_EXPIRES_AT: '2026-07-15T10:00:00.000Z',
    SCREEN_OTP_OWNER: 'security-iam@example.test',
    SCREEN_OTP_ALLOWED_EMAILS: `${ELIGIBLE_EMAIL},${UNKNOWN_EMAIL},${DISABLED_EMAIL}`,
    OTP_RESEND_COOLDOWN_SECONDS: '30',
    ...overrides,
  };
}

function makeOtpService(options = {}) {
  let sequence = 0;
  const codes = ['135790', '246801', '112233', '445566', '778899'];
  const store = options.store || new MemoryOtpStore();
  const service = new OtpSessionService({
    store,
    secret: HMAC_SECRET,
    ttlSeconds: options.ttlSeconds || 120,
    maxAttempts: options.maxAttempts || 3,
    clock: options.clock || (() => NOW),
    codeFactory: () => codes[sequence % codes.length],
    sessionIdFactory: () => `run09-session-${++sequence}`,
  });
  return { service, store };
}

function hasSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    /^(?:code|otp|screenCode|devCode)$/i.test(key) || hasSensitiveKey(child)
  ));
}

async function startAuthApi(options = {}) {
  const env = options.env || screenEnv();
  const otp = options.otp || makeOtpService();
  const audit = [];
  const emailCalls = [];
  const lookup = options.lookup || ((email) => email === ELIGIBLE_EMAIL ? {
    email, is_admin: 0, role: 'Chuyên viên', is_active: 1, display_name: 'RUN-09 Synthetic',
  } : null);
  const identity = (email) => ({
    email, isAdmin: false, role: 'Chuyên viên', displayName: 'RUN-09 Synthetic',
    roleCodes: ['QLCL_SPECIALIST'], roleLabels: ['Chuyên viên'], capabilities: [], authzVersion: 1,
  });
  const router = createAuthRouter({
    stmts: {
      getUser: { get: lookup },
      getAck: { get: () => ({ rules_version: 1, acknowledged_at: '2026-07-14 09:00:00' }) },
      upsertAck: { run() {} },
    },
    authorizationService: { identityForUser: identity, revokeSession() {} },
    policyService: { identityPayload: (item) => ({
      ...item,
      policy_version: 1,
      navigation_version: 1,
      action_version: 1,
    }) },
    otpService: otp.service,
    getDeliveryConfig: () => resolveOtpDeliveryConfig(env, { now: NOW }),
    sendEmail: async (message) => { emailCalls.push(message); return true; },
    buildOtpEmail: () => ({ subject: 'RUN-09 synthetic email', htmlContent: '<p>synthetic</p>' }),
    signToken: () => 'synthetic-run09-jwt',
    requireAuth: (req, res, next) => next(),
    logAccess: (event) => audit.push(event),
    logger: { info() {}, warn() {}, error() {} },
    requestLimiter: options.requestLimiter || ((req, res, next) => next()),
    verifyLimiter: (req, res, next) => next(),
    now: () => NOW,
  });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/auth', router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    audit,
    emailCalls,
    env,
    otp,
    server,
    url: `http://127.0.0.1:${server.address().port}/auth`,
  };
}

async function closeApi(api) {
  await new Promise((resolve) => api.server.close(resolve));
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('screen delivery requires owner, future expiry, exact allow-list and production acknowledgement', () => {
  const development = resolveOtpDeliveryConfig(screenEnv(), { now: NOW });
  assert.equal(development.available, true);
  assert.equal(development.mode, 'screen');
  assert.equal(development.allowsEmail(`  ${ELIGIBLE_EMAIL.toUpperCase()}  `), true);
  assert.equal(development.allowsEmail('other@winmart.masangroup.com'), false);

  const booleanOnlyProduction = resolveOtpDeliveryConfig(screenEnv({ NODE_ENV: 'production' }), { now: NOW });
  assert.equal(booleanOnlyProduction.available, false);
  assert.equal(booleanOnlyProduction.reason, 'production_acknowledgement_required');

  const acknowledged = resolveOtpDeliveryConfig(screenEnv({
    NODE_ENV: 'production',
    SCREEN_OTP_PRODUCTION_ACK: PRODUCTION_SCREEN_ACK,
  }), { now: NOW });
  assert.equal(acknowledged.available, true);

  const prdWithoutAcknowledgement = resolveOtpDeliveryConfig(screenEnv({
    NODE_ENV: 'development',
    APP_ENV: 'PRD',
  }), { now: NOW });
  assert.equal(prdWithoutAcknowledgement.available, false);
  assert.equal(prdWithoutAcknowledgement.reason, 'production_acknowledgement_required');

  const expired = resolveOtpDeliveryConfig(screenEnv({
    SCREEN_OTP_EXPIRES_AT: '2026-07-14T09:59:59.000Z',
  }), { now: NOW });
  assert.equal(expired.available, false);
  assert.equal(expired.reason, 'screen_expired');

  const tooFar = resolveOtpDeliveryConfig(screenEnv({
    SCREEN_OTP_EXPIRES_AT: '2026-08-01T10:00:00.000Z',
  }), { now: NOW });
  assert.equal(tooFar.available, false);
  assert.equal(tooFar.reason, 'screen_expiry_too_far');

  const legacyBypass = resolveOtpDeliveryConfig(screenEnv({ SHOW_TEST_OTP: 'true' }), { now: NOW });
  assert.equal(legacyBypass.available, false);
  assert.equal(legacyBypass.reason, 'legacy_otp_flag_forbidden');
});

test('explicit relaxed screen profile is development-only and reports that it is not production ready', () => {
  const relaxed = resolveOtpDeliveryConfig(screenEnv({
    SCREEN_OTP_DEV_RELAXED: 'true',
    SCREEN_OTP_EXPIRES_AT: '',
    SCREEN_OTP_OWNER: '',
    SCREEN_OTP_ALLOWED_EMAILS: '',
  }), { now: NOW });
  assert.equal(relaxed.available, true);
  assert.equal(relaxed.mode, 'screen');
  assert.equal(relaxed.securityProfile, 'development_relaxed');
  assert.equal(relaxed.productionReady, false);
  assert.equal(relaxed.expiresAt, null);
  assert.equal(relaxed.allowsEmail('developer@winmart.masangroup.com'), true);

  const readiness = otpReadiness(screenEnv({
    SCREEN_OTP_DEV_RELAXED: 'true',
    SCREEN_OTP_EXPIRES_AT: '',
    SCREEN_OTP_OWNER: '',
    SCREEN_OTP_ALLOWED_EMAILS: '',
  }), { now: NOW });
  assert.equal(readiness.status, 'ready');
  assert.equal(readiness.securityProfile, 'development_relaxed');
  assert.equal(readiness.productionReady, false);

  for (const environment of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'development', APP_ENV: 'PRD' },
  ]) {
    const forbidden = resolveOtpDeliveryConfig(screenEnv({
      ...environment,
      SCREEN_OTP_DEV_RELAXED: 'true',
      SCREEN_OTP_EXPIRES_AT: '',
      SCREEN_OTP_OWNER: '',
      SCREEN_OTP_ALLOWED_EMAILS: '',
    }), { now: NOW });
    assert.equal(forbidden.available, false);
    assert.equal(forbidden.reason, 'development_relaxed_forbidden');
  }
});

test('test delivery is test-only and invalid configuration degrades readiness without secrets', () => {
  const outsideTest = resolveOtpDeliveryConfig(screenEnv({
    OTP_DELIVERY_MODE: 'test', NODE_ENV: 'development',
  }), { now: NOW });
  assert.equal(outsideTest.available, false);
  assert.equal(outsideTest.reason, 'test_mode_forbidden');

  const inTest = resolveOtpDeliveryConfig(screenEnv({
    OTP_DELIVERY_MODE: 'test', NODE_ENV: 'test',
  }), { now: NOW });
  assert.equal(inTest.available, true);
  assert.equal(inTest.mode, 'test');

  const readiness = otpReadiness(screenEnv({ SCREEN_OTP_ENABLED: 'false' }), { now: NOW });
  assert.equal(readiness.status, 'degraded');
  assert.equal(readiness.error, 'otp_delivery_unavailable');
  assert.equal(hasSensitiveKey(readiness), false);
  assert.equal(JSON.stringify(readiness).includes(HMAC_SECRET), false);
});

test('OTP store persists only an HMAC verifier and enforces expiry, attempts and one-time use', async () => {
  let now = new Date(NOW);
  const store = new MemoryOtpStore();
  let codeIndex = 0;
  const service = new OtpSessionService({
    store,
    secret: HMAC_SECRET,
    ttlSeconds: 60,
    maxAttempts: 2,
    clock: () => now,
    codeFactory: () => ['123789', '987123', '456987', '741852'][codeIndex++],
    sessionIdFactory: () => `run09-hmac-session-${codeIndex}`,
  });

  const first = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'screen' });
  const stored = await store.get(first.sessionId);
  assert.equal(Object.hasOwn(stored, 'code'), false);
  assert.equal(Object.hasOwn(stored, 'screenCode'), false);
  assert.equal(typeof stored.otpVerifier, 'string');
  assert.equal(stored.otpVerifier.length, 64);
  assert.equal(stored.eligible, true);
  assert.equal(stored.attempts, 0);
  assert.equal(typeof stored.createdAt, 'string');
  assert.equal(typeof stored.expiresAt, 'string');

  const invalid = await service.verifyOtp(first.sessionId, '000000');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid');
  assert.equal(invalid.attemptsLeft, 1);
  const maxed = await service.verifyOtp(first.sessionId, '000000');
  assert.equal(maxed.ok, false);
  assert.equal(maxed.reason, 'too_many_attempts');
  assert.equal(await store.get(first.sessionId), null);

  const oneTime = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'screen' });
  const success = await service.verifyOtp(oneTime.sessionId, oneTime.code);
  assert.equal(success.ok, true);
  assert.equal(success.deliveryMode, 'screen');
  assert.equal((await service.verifyOtp(oneTime.sessionId, oneTime.code)).reason, 'expired');

  const concurrent = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'screen' });
  const concurrentResults = await Promise.all([
    service.verifyOtp(concurrent.sessionId, concurrent.code),
    service.verifyOtp(concurrent.sessionId, concurrent.code),
  ]);
  assert.equal(concurrentResults.filter((item) => item.ok).length, 1);

  const expiring = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'email' });
  now = new Date(NOW.getTime() + 61_000);
  assert.equal((await service.verifyOtp(expiring.sessionId, expiring.code)).reason, 'expired');
});

test('resend invalidates the prior session and non-eligible sessions never authenticate', async () => {
  const { service } = makeOtpService();
  const previous = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'screen' });
  const replacement = await service.createOtpSession(ELIGIBLE_EMAIL, { eligible: true, deliveryMode: 'screen' });
  assert.equal((await service.verifyOtp(previous.sessionId, previous.code)).reason, 'expired');
  assert.equal((await service.verifyOtp(replacement.sessionId, replacement.code)).ok, true);

  const fake = await service.createOtpSession('unknown@winmart.masangroup.com', {
    eligible: false,
    deliveryMode: 'screen',
  });
  const denied = await service.verifyOtp(fake.sessionId, fake.code);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'invalid');
  assert.equal(Object.hasOwn(denied, 'email'), false);
});

test('request API returns equivalent screen shapes for eligible and unknown users, then marks screen login degraded', async () => {
  const api = await startAuthApi();
  try {
    const known = await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    const unknown = await postJson(`${api.url}/request-otp`, { email: UNKNOWN_EMAIL });
    const disabled = await postJson(`${api.url}/request-otp`, { email: DISABLED_EMAIL });
    assert.equal(known.response.status, 200);
    assert.equal(unknown.response.status, 200);
    assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
    assert.equal(disabled.response.status, 200);
    assert.deepEqual(Object.keys(known.body).sort(), Object.keys(disabled.body).sort());
    assert.equal(known.body.deliveryMode, 'screen');
    assert.equal(typeof known.body.screenCode, 'string');
    assert.equal(known.body.screenCode.length, 6);
    assert.equal(typeof known.body.expiresAt, 'string');
    assert.equal(known.body.retryAfter, 30);

    const unknownVerify = await postJson(`${api.url}/verify-otp`, {
      sessionId: unknown.body.sessionId,
      code: unknown.body.screenCode,
    });
    assert.equal(unknownVerify.response.status, 401);
    assert.equal(unknownVerify.body.error, 'invalid');

    const disabledVerify = await postJson(`${api.url}/verify-otp`, {
      sessionId: disabled.body.sessionId,
      code: disabled.body.screenCode,
    });
    assert.equal(disabledVerify.response.status, 401);
    assert.equal(disabledVerify.body.error, 'invalid');

    const knownVerify = await postJson(`${api.url}/verify-otp`, {
      sessionId: known.body.sessionId,
      code: known.body.screenCode,
    });
    assert.equal(knownVerify.response.status, 200, 'unknown-user session must not invalidate another normalized email');
    assert.equal(knownVerify.body.degradedAuth, true);
    assert.equal(hasSensitiveKey(api.audit), false);
  } finally {
    await closeApi(api);
  }
});

test('valid screen resend works, email mode never returns a code, and invalid config returns unavailable', async () => {
  const api = await startAuthApi();
  try {
    const first = await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    const second = await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    assert.equal((await postJson(`${api.url}/verify-otp`, {
      sessionId: first.body.sessionId, code: first.body.screenCode,
    })).body.error, 'expired');
    const verified = await postJson(`${api.url}/verify-otp`, {
      sessionId: second.body.sessionId, code: second.body.screenCode,
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.degradedAuth, true);
    assert.equal(verified.body.authDeliveryMode, 'screen');
  } finally {
    await closeApi(api);
  }

  const emailApi = await startAuthApi({ env: screenEnv({ OTP_DELIVERY_MODE: 'email' }) });
  try {
    const requested = await postJson(`${emailApi.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    assert.equal(requested.response.status, 200);
    assert.equal(requested.body.deliveryMode, 'email');
    assert.equal(Object.hasOwn(requested.body, 'screenCode'), false);
    assert.equal(emailApi.emailCalls.length, 1);
  } finally {
    await closeApi(emailApi);
  }

  const invalidApi = await startAuthApi({ env: screenEnv({ SCREEN_OTP_ENABLED: 'false' }) });
  try {
    const unavailable = await postJson(`${invalidApi.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error, 'otp_delivery_unavailable');
    assert.equal(Object.hasOwn(unavailable.body, 'screenCode'), false);
    assert.equal(hasSensitiveKey(invalidApi.audit), false);
  } finally {
    await closeApi(invalidApi);
  }
});

test('relaxed DEV profile is visible through auth and warns before Go Live or PRD', async () => {
  const api = await startAuthApi({ env: screenEnv({
    SCREEN_OTP_DEV_RELAXED: 'true',
    SCREEN_OTP_EXPIRES_AT: '',
    SCREEN_OTP_OWNER: '',
    SCREEN_OTP_ALLOWED_EMAILS: '',
  }) });
  try {
    const requested = await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    assert.equal(requested.response.status, 200);
    assert.equal(requested.body.securityProfile, 'development_relaxed');
    const verified = await postJson(`${api.url}/verify-otp`, {
      sessionId: requested.body.sessionId,
      code: requested.body.screenCode,
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.authSecurityProfile, 'development_relaxed');
  } finally {
    await closeApi(api);
  }

  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'public', 'js', 'state.js'), 'utf8');
  assert.match(html, /id="screen-otp-dev-warning"[^>]*class="[^\"]*hidden/);
  assert.match(html, /Go Live/);
  assert.match(html, /PRD/);
  assert.match(app, /development_relaxed/);
  assert.match(state, /authSecurityProfile/);
});

test('request limiter keys normalized email with IP and returns retry metadata', async () => {
  assert.equal(
    requestRateLimitKey({ ip: '127.0.0.1', body: { email: ` ${ELIGIBLE_EMAIL.toUpperCase()} ` } }),
    requestRateLimitKey({ ip: '127.0.0.1', body: { email: ELIGIBLE_EMAIL } })
  );
  assert.notEqual(
    requestRateLimitKey({ ip: '127.0.0.2', body: { email: ELIGIBLE_EMAIL } }),
    requestRateLimitKey({ ip: '127.0.0.1', body: { email: ELIGIBLE_EMAIL } })
  );

  const limiter = createRequestOtpLimiter({ max: 2, windowMs: 60_000, validate: false });
  const api = await startAuthApi({ requestLimiter: limiter });
  try {
    const variant = ` ${ELIGIBLE_EMAIL.toUpperCase()} `;
    assert.equal((await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL })).response.status, 200);
    assert.equal((await postJson(`${api.url}/request-otp`, { email: variant })).response.status, 200);
    const limited = await postJson(`${api.url}/request-otp`, { email: ELIGIBLE_EMAIL });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error, 'too_many_requests');
    assert.equal(typeof limited.body.retryAfter, 'number');
  } finally {
    await closeApi(api);
  }
});

test('screen OTP UI is explicit, does not auto-fill/submit, and UAT masks the OTP DOM', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'public', 'js', 'state.js'), 'utf8');
  const uatFixture = fs.readFileSync(path.join(root, 'uat', 'fixtures', 'uatTest.js'), 'utf8');
  const playwright = fs.readFileSync(path.join(root, 'uat', 'playwright.config.js'), 'utf8');
  const runUat = fs.readFileSync(path.join(root, 'scripts', 'run-uat.js'), 'utf8');
  const authSlice = app.slice(app.indexOf('// ============ Login flow ============'), app.indexOf('function applySession'));

  assert.match(html, /id="screen-otp-callout"[^>]*data-sensitive="otp"/);
  assert.match(html, /Mã đăng nhập tạm/);
  assert.match(html, /id="screen-otp-code"/);
  assert.match(html, /id="btn-copy-screen-otp"/);
  assert.match(html, /id="otp-countdown"/);
  assert.match(html, /id="btn-resend-otp"/);
  assert.match(html, /id="degraded-auth-banner"/);
  assert.match(app, /screenCode/);
  assert.match(state, /otpExpiresAt/);
  assert.doesNotMatch(app, /devCode|SHOW_TEST_OTP|DEV_SHOW_OTP/);
  assert.doesNotMatch(authSlice, /localStorage|sessionStorage|console\./);
  assert.doesNotMatch(authSlice, /\$\('otp'\)\.value\s*=\s*r\.data\.(?:screenCode|code)/);
  assert.match(uatFixture, /\[data-sensitive="otp"\]/);
  assert.match(playwright, /trace:\s*'off'/);
  assert.match(runUat, /SCREEN_OTP_DEV_RELAXED:\s*'false'/);
});

test('temporary screen OTP runbook contains owner, deadline, controls and removal criteria', () => {
  const docs = fs.readFileSync(path.join(root, 'docs', 'temporary-screen-otp.md'), 'utf8');
  for (const term of [
    'Owner', 'SCREEN_OTP_EXPIRES_AT', 'SCREEN_OTP_ENABLED', 'Monitoring',
    'Incident response', 'Removal criteria', 'OTP_DELIVERY_MODE=email',
  ]) assert.match(docs, new RegExp(term));
});
