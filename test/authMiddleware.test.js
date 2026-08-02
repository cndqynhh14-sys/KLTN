process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { requireAuth, requireRole, requireInternal } = require('../server/middleware/auth');
const { ROLES } = require('../server/domain/roles');

function runMiddleware(mw, user) {
  const req = { user };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { statusCode: res.statusCode, body: res.body, nextCalled };
}

function runAuthMiddleware(token) {
  const req = {
    cookies: { qlcl_token: token },
    requestId: 'synthetic-legacy-session-request',
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextCalled = false;
  requireAuth(req, res, () => { nextCalled = true; });
  return { req, statusCode: res.statusCode, body: res.body, nextCalled };
}

test('legacy JWTs are rejected even when the retired compatibility switch is set', () => {
  const legacyEmail = 'legacy-session@example.invalid';
  const token = jwt.sign(
    { email: legacyEmail, role: ROLES.ADMIN, isAdmin: true },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'masan-rms', audience: 'qlcl-app', expiresIn: 300 }
  );
  const dbModulePath = require.resolve('../server/db');
  const originalDbModule = require.cache[dbModulePath];
  const originalCompatibilitySwitch = process.env.AUTHZ_ALLOW_LEGACY_SESSION;
  let legacyIdentityCalls = 0;

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      authorizationService: {
        identityForLegacyRoutes(email) {
          legacyIdentityCalls += 1;
          assert.equal(email, legacyEmail);
          return { email, role: ROLES.SPECIALIST, isAdmin: false };
        },
      },
    },
  };

  try {
    delete process.env.AUTHZ_ALLOW_LEGACY_SESSION;
    const rejected = runAuthMiddleware(token);
    assert.equal(rejected.statusCode, 401);
    assert.deepEqual(rejected.body, {
      error: 'invalid_token',
      code: 'AUTH_SESSION_INVALID',
      request_id: 'synthetic-legacy-session-request',
    });
    assert.equal(rejected.nextCalled, false);
    assert.equal(legacyIdentityCalls, 0);

    process.env.AUTHZ_ALLOW_LEGACY_SESSION = 'false';
    const explicitlyDisabled = runAuthMiddleware(token);
    assert.equal(explicitlyDisabled.statusCode, 401);
    assert.equal(explicitlyDisabled.nextCalled, false);
    assert.equal(legacyIdentityCalls, 0);

    process.env.AUTHZ_ALLOW_LEGACY_SESSION = 'true';
    const stillRejected = runAuthMiddleware(token);
    assert.equal(stillRejected.statusCode, 401);
    assert.equal(stillRejected.nextCalled, false);
    assert.equal(legacyIdentityCalls, 0);
  } finally {
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
    if (originalCompatibilitySwitch === undefined) delete process.env.AUTHZ_ALLOW_LEGACY_SESSION;
    else process.env.AUTHZ_ALLOW_LEGACY_SESSION = originalCompatibilitySwitch;
  }
});

test('requireRole returns 403 for users outside the allowed role set', () => {
  const denied = runMiddleware(requireRole([ROLES.ADMIN]), {
    email: 'lead@masangroup.com',
    roleCodes: ['REGIONAL_LEAD_APPROVER'],
  });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.body, { error: 'forbidden' });
  assert.equal(denied.nextCalled, false);

  const allowed = runMiddleware(requireRole([ROLES.ADMIN]), {
    email: 'admin@masangroup.com',
    roleCodes: ['SYS_ADMIN'],
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.nextCalled, true);
});

test('requireInternal blocks NCC role from internal APIs', () => {
  const denied = runMiddleware(requireInternal, { email: 'ncc@example.com', roleCodes: ['SUPPLIER_USER'] });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.body, { error: 'forbidden' });

  const allowed = runMiddleware(requireInternal, { email: 'spec@masangroup.com', roleCodes: ['QLCL_SPECIALIST'] });
  assert.equal(allowed.nextCalled, true);
});
