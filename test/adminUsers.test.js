'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const MODULES = [
  '../server/config/paths',
  '../server/db',
  '../server/middleware/auth',
  '../server/middleware/policy',
  '../server/routes/admin',
];

function clearModules() {
  MODULES.forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function removeDbFiles(dbPath) {
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function tokenFor(authorizationService, email) {
  const session = authorizationService.createSession(email, { ttlSeconds: 3600 });
  return jwt.sign({ sub: email, sid: session.sessionId, av: session.authzVersion }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: 3600,
    issuer: 'masan-rms',
    audience: process.env.JWT_AUDIENCE || 'qlcl-app',
  });
}

async function requestJson(baseUrl, route, token, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: `qlcl_token=${token}`,
      'x-request-id': options.requestId || 'request-admin-users-0001',
      ...(options.headers || {}),
    },
  });
  return { response, body: await response.json() };
}

test('admin user upsert and deactivation require a bounded reason and record versioned before/after audit', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-admin-users-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'admin-users-route-test-secret';
  clearModules();

  const { db, authorizationService } = require('../server/db');
  const { requestContext } = require('../server/middleware/requestContext');
  const { ROLES } = require('../server/domain/roles');
  const { ROLE_CODES } = require('../server/authorization/permissionCatalog');
  const router = require('../server/routes/admin');
  const actor = 'admin-user-actor@example.invalid';
  const target = 'admin-user-target@example.invalid';
  upsertCanonicalUser(db, {
    email: actor,
    roleCode: ROLE_CODES.SYS_ADMIN,
    displayName: 'Synthetic admin actor',
    createdBy: 'fixture',
  });
  authorizationService.setPrimaryRole({ userId: actor, roleCode: ROLE_CODES.SYS_ADMIN, source: 'MANUAL' });
  const token = tokenFor(authorizationService, actor);
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(express.json());
  app.use(cookieParser());
  app.use('/admin', router);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const reason of [undefined, '1234567', 'x'.repeat(501)]) {
      const attempted = await requestJson(baseUrl, '/admin/users', token, {
        method: 'POST',
        body: JSON.stringify({
          email: target,
          role: ROLES.SPECIALIST,
          display_name: 'Synthetic target',
          ...(reason === undefined ? {} : { reason }),
        }),
      });
      assert.equal(attempted.response.status, 400);
      assert.equal(attempted.body.error, 'change_reason_required');
    }
    assert.equal(db.prepare('SELECT 1 FROM users WHERE email = ?').get(target), undefined);

    const created = await requestJson(baseUrl, '/admin/users', token, {
      method: 'POST',
      requestId: 'request-admin-users-create-0001',
      body: JSON.stringify({
        email: target,
        role: ROLES.SPECIALIST,
        display_name: 'Synthetic target',
        reason: 'Provision the approved synthetic user account',
      }),
    });
    assert.equal(created.response.status, 200);
    const createdUser = db.prepare(`SELECT is_active, display_name, authz_version
      FROM users WHERE email = ?`).get(target);
    assert.equal(createdUser.is_active, 1);
    const targetSession = authorizationService.createSession(target, { ttlSeconds: 3600 });

    const createAudit = db.prepare(`SELECT metadata_json, request_id, correlation_id
      FROM audit_events WHERE event_name = 'user.account.upserted' ORDER BY id DESC LIMIT 1`).get();
    const createMetadata = JSON.parse(createAudit.metadata_json);
    assert.equal(createAudit.request_id, 'request-admin-users-create-0001');
    assert.equal(createAudit.correlation_id, 'request-admin-users-create-0001');
    assert.equal(createMetadata.reason, 'Provision the approved synthetic user account');
    assert.equal(createMetadata.authz_version, createdUser.authz_version);
    assert.equal(createMetadata.role_code, 'QLCL_SPECIALIST');
    assert.deepEqual(createMetadata.changed_fields, ['active', 'display_name', 'role_code']);
    assert.deepEqual(createMetadata.changes.active, { before: null, after: true });

    const rejectedDelete = await requestJson(baseUrl, `/admin/users/${encodeURIComponent(target)}`, token, {
      method: 'DELETE',
      body: JSON.stringify({}),
    });
    assert.equal(rejectedDelete.response.status, 400);
    assert.equal(rejectedDelete.body.error, 'change_reason_required');
    assert.equal(db.prepare('SELECT is_active FROM users WHERE email = ?').get(target).is_active, 1);

    const deactivated = await requestJson(baseUrl, `/admin/users/${encodeURIComponent(target)}`, token, {
      method: 'DELETE',
      requestId: 'request-admin-users-deactivate-0001',
      body: JSON.stringify({ reason: 'Deactivate the synthetic account after access review' }),
    });
    assert.equal(deactivated.response.status, 200);
    const deactivatedUser = db.prepare(`SELECT is_active, authz_version
      FROM users WHERE email = ?`).get(target);
    assert.equal(deactivatedUser.is_active, 0);
    assert.ok(deactivatedUser.authz_version > createdUser.authz_version);
    const revokedSession = db.prepare(`SELECT revoked_at, revoke_reason FROM auth_sessions
      WHERE session_id = ?`).get(targetSession.sessionId);
    assert.ok(revokedSession.revoked_at);
    assert.equal(revokedSession.revoke_reason, 'ACCOUNT_STATUS_CHANGED');

    const deleteAudit = db.prepare(`SELECT metadata_json, request_id, correlation_id
      FROM audit_events WHERE event_name = 'user.account.deactivated' ORDER BY id DESC LIMIT 1`).get();
    const deleteMetadata = JSON.parse(deleteAudit.metadata_json);
    assert.equal(deleteAudit.request_id, 'request-admin-users-deactivate-0001');
    assert.equal(deleteAudit.correlation_id, 'request-admin-users-deactivate-0001');
    assert.equal(deleteMetadata.reason, 'Deactivate the synthetic account after access review');
    assert.equal(deleteMetadata.authz_version, deactivatedUser.authz_version);
    assert.deepEqual(deleteMetadata.changed_fields, ['active']);
    assert.deepEqual(deleteMetadata.changes.active, { before: true, after: false });

    const assignmentsBeforeReactivate = {
      roles: db.prepare(`SELECT role_id, active, valid_from, valid_until, source
        FROM user_roles WHERE user_id = ? ORDER BY id`).all(target),
      scopes: db.prepare(`SELECT role_id, scope_type, scope_value, effect, active, valid_from, valid_until, source
        FROM user_scope_assignments WHERE user_id = ? ORDER BY id`).all(target),
    };
    const reactivated = await requestJson(baseUrl, `/admin/users/${encodeURIComponent(target)}/reactivate`, token, {
      method: 'PATCH',
      requestId: 'request-admin-users-reactivate-0001',
      body: JSON.stringify({ reason: 'Reactivate the approved synthetic account after access review' }),
    });
    assert.equal(reactivated.response.status, 200);
    const reactivatedUser = db.prepare(`SELECT is_active, authz_version
      FROM users WHERE email = ?`).get(target);
    assert.equal(reactivatedUser.is_active, 1);
    assert.ok(reactivatedUser.authz_version > deactivatedUser.authz_version);
    assert.deepEqual({
      roles: db.prepare(`SELECT role_id, active, valid_from, valid_until, source
        FROM user_roles WHERE user_id = ? ORDER BY id`).all(target),
      scopes: db.prepare(`SELECT role_id, scope_type, scope_value, effect, active, valid_from, valid_until, source
        FROM user_scope_assignments WHERE user_id = ? ORDER BY id`).all(target),
    }, assignmentsBeforeReactivate);
    const reactivateAudit = db.prepare(`SELECT metadata_json, request_id
      FROM audit_events WHERE event_name = 'user.account.reactivated' ORDER BY id DESC LIMIT 1`).get();
    assert.equal(reactivateAudit.request_id, 'request-admin-users-reactivate-0001');
    const reactivateMetadata = JSON.parse(reactivateAudit.metadata_json);
    assert.equal(reactivateMetadata.reason, 'Reactivate the approved synthetic account after access review');
    assert.deepEqual(reactivateMetadata.changes.active, { before: false, after: true });

    const alreadyActive = await requestJson(baseUrl, `/admin/users/${encodeURIComponent(target)}/reactivate`, token, {
      method: 'PATCH', body: JSON.stringify({ reason: 'Reject duplicate account reactivation attempts safely' }),
    });
    assert.equal(alreadyActive.response.status, 409);
    assert.equal(alreadyActive.body.error, 'account_already_active');

    for (const action of ['USER_UPSERT', 'USER_DEACTIVATE', 'USER_REACTIVATE']) {
      const access = db.prepare('SELECT details FROM access_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
      const details = JSON.parse(access.details);
      assert.ok(details.reason.length >= 8);
      assert.ok(Number.isInteger(details.authz_version));
      assert.ok(Object.hasOwn(details, 'before'));
      assert.ok(Object.hasOwn(details, 'after'));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    clearModules();
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    removeDbFiles(dbPath);
  }
});
