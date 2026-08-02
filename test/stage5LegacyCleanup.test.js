'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function historicalDirectory(lastId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage5-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function addCanonicalUser(db, { email, roleCode, isAdmin = false }) {
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES (?, ?, ?, 1, 'Stage 5 synthetic user', 'fixture')`)
    .run(email, isAdmin ? 1 : 0, isAdmin ? 'Admin' : 'Chuyên viên');
  db.prepare(`INSERT INTO user_roles (user_id, role_id, source)
    SELECT ?, id, 'MANUAL' FROM roles WHERE role_code=?`).run(email, roleCode);
}

test('Stage 5 removes legacy user authorization columns without losing accounts or foreign keys', () => {
  const historical = historicalDirectory('0029');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage5-before' });
    addCanonicalUser(db, {
      email: 'stage5-admin@example.invalid',
      roleCode: 'SYS_ADMIN',
      isAdmin: true,
    });
    addCanonicalUser(db, {
      email: 'stage5-specialist@example.invalid',
      roleCode: 'QLCL_SPECIALIST',
    });
    db.prepare(`INSERT INTO auth_sessions
      (session_id, user_id, authz_version, issued_at, expires_at, revoked_at, revoke_reason)
      VALUES ('stage5-session', 'stage5-admin@example.invalid',
        (SELECT authz_version FROM users WHERE email='stage5-admin@example.invalid'),
        datetime('now'), datetime('now', '+1 hour'), datetime('now'), 'RBAC_CANONICAL_CUTOVER')`).run();

    migrateDatabase(db, { migrationsDir, appVersion: 'stage5-test' });

    const columns = new Set(db.pragma("table_info('users')").map((row) => row.name));
    assert.equal(columns.has('role'), false);
    assert.equal(columns.has('is_admin'), false);
    assert.deepEqual(
      db.prepare('SELECT email, is_active, display_name, created_by FROM users ORDER BY email').all(),
      [
        {
          email: 'stage5-admin@example.invalid',
          is_active: 1,
          display_name: 'Stage 5 synthetic user',
          created_by: 'fixture',
        },
        {
          email: 'stage5-specialist@example.invalid',
          is_active: 1,
          display_name: 'Stage 5 synthetic user',
          created_by: 'fixture',
        },
      ],
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0030'").pluck().get(), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('Stage 5 fails closed and keeps legacy columns when any account lacks canonical role history', () => {
  const historical = historicalDirectory('0029');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage5-before' });
    db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name)
      VALUES ('stage5-unmapped@example.invalid', 0, 'Chuyên viên', 0, 'Unmapped historical user')`).run();

    assert.throws(
      () => migrateDatabase(db, { migrationsDir, appVersion: 'stage5-test' }),
      /CHECK constraint failed/,
    );
    const columns = new Set(db.pragma("table_info('users')").map((row) => row.name));
    assert.equal(columns.has('role'), true);
    assert.equal(columns.has('is_admin'), true);
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0030'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM users WHERE email='stage5-unmapped@example.invalid'").pluck().get(), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});
