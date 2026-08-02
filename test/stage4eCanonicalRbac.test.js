'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuthorizationService } = require('../server/services/AuthorizationService');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function historicalDirectory(lastId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage4e-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function addCanonicalUser(db, { email, legacyRole, legacyAdmin, roleCode }) {
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES (?, ?, ?, 1, 'Stage 4E synthetic user', 'fixture')`).run(email, legacyAdmin ? 1 : 0, legacyRole);
  db.prepare(`INSERT INTO user_roles (user_id, role_id, source)
    SELECT ?, id, 'MANUAL' FROM roles WHERE role_code=?`).run(email, roleCode);
  db.prepare(`INSERT INTO user_scope_assignments
    (user_id, role_id, scope_type, scope_value, effect, source)
    SELECT ?, id, 'GLOBAL', NULL, 'ALLOW', 'MANUAL' FROM roles WHERE role_code=?`).run(email, roleCode);
}

function addSession(db, email) {
  const version = db.prepare('SELECT authz_version FROM users WHERE email=?').pluck().get(email);
  const sessionId = `stage4e-${email}`;
  db.prepare(`INSERT INTO auth_sessions
    (session_id, user_id, authz_version, issued_at, expires_at)
    VALUES (?, ?, ?, '2026-08-02 00:00:00', '2027-08-02 00:00:00')`).run(sessionId, email, version);
  return { sessionId, version };
}

test('Stage 4E cutover validates canonical roles, bumps authz versions, and revokes old sessions', () => {
  const historical = historicalDirectory('0028');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4d-test' });
    addCanonicalUser(db, {
      email: 'stage4e-admin@example.invalid',
      legacyRole: 'Admin',
      legacyAdmin: true,
      roleCode: 'SYS_ADMIN',
    });
    addCanonicalUser(db, {
      email: 'stage4e-specialist@example.invalid',
      legacyRole: 'Admin',
      legacyAdmin: false,
      roleCode: 'QLCL_SPECIALIST',
    });
    const sessions = [
      addSession(db, 'stage4e-admin@example.invalid'),
      addSession(db, 'stage4e-specialist@example.invalid'),
    ];

    migrateDatabase(db, { migrationsDir, appVersion: 'stage4e-test' });

    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0029'").pluck().get(), 1);
    for (const session of sessions) {
      const row = db.prepare(`SELECT u.authz_version, s.revoked_at, s.revoke_reason
        FROM auth_sessions s JOIN users u ON u.email=s.user_id WHERE s.session_id=?`).get(session.sessionId);
      assert.equal(row.authz_version, session.version + 1);
      assert.ok(row.revoked_at);
      assert.equal(row.revoke_reason, 'RBAC_CANONICAL_CUTOVER');
    }
    const specialistRoles = db.prepare(`SELECT r.role_code FROM user_roles ur
      JOIN roles r ON r.id=ur.role_id WHERE ur.user_id='stage4e-specialist@example.invalid' AND ur.active=1`).all();
    assert.deepEqual(specialistRoles.map((row) => row.role_code), ['QLCL_SPECIALIST']);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('Stage 4E cutover fails closed when an active account has no canonical role', () => {
  const historical = historicalDirectory('0028');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4d-test' });
    db.prepare(`INSERT INTO users (email, is_admin, role, is_active)
      VALUES ('stage4e-unmapped@example.invalid', 0, 'ChuyÃªn viÃªn', 1)`).run();
    const before = db.prepare("SELECT authz_version FROM users WHERE email='stage4e-unmapped@example.invalid'").pluck().get();
    assert.throws(
      () => migrateDatabase(db, { migrationsDir, appVersion: 'stage4e-test' }),
      /CHECK constraint failed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0029'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT authz_version FROM users WHERE email='stage4e-unmapped@example.invalid'").pluck().get(), before);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('Stage 4E keeps legacy user columns until the separate UAT cleanup gate', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4e-test' });
    const columns = new Set(db.pragma("table_info('users')").map((row) => row.name));
    assert.equal(columns.has('role'), true);
    assert.equal(columns.has('is_admin'), true);
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0029'").pluck().get(), 1);
  } finally {
    db.close();
  }
});

test('canonical primary-role seeding is idempotent across consecutive startups', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4e-test' });
    db.prepare("INSERT INTO users (email, is_active, created_by) VALUES ('stage4e-seed@example.invalid', 1, 'fixture')").run();
    const service = new AuthorizationService(db);
    service.setPrimaryRole({
      userId: 'stage4e-seed@example.invalid', roleCode: 'SYS_ADMIN', source: 'MIGRATION',
    });
    const firstVersion = db.prepare("SELECT authz_version FROM users WHERE email='stage4e-seed@example.invalid'").pluck().get();
    const firstChanges = db.prepare("SELECT COUNT(*) FROM authz_change_log WHERE object_key='SYS_ADMIN'").pluck().get();
    service.setPrimaryRole({
      userId: 'stage4e-seed@example.invalid', roleCode: 'SYS_ADMIN', source: 'MIGRATION',
    });
    assert.equal(db.prepare("SELECT authz_version FROM users WHERE email='stage4e-seed@example.invalid'").pluck().get(), firstVersion);
    assert.equal(db.prepare("SELECT COUNT(*) FROM authz_change_log WHERE object_key='SYS_ADMIN'").pluck().get(), firstChanges);
  } finally {
    db.close();
  }
});
