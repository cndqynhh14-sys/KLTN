'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../server/config/paths');

function parseArgs(argv) {
  const index = argv.indexOf('--db');
  return { dbPath: path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : DB_PATH) };
}

function scalar(db, sql) {
  return Number(db.prepare(sql).pluck().get() || 0);
}

function runParity(db) {
  const hard = {
    migration_0029_missing: scalar(db, "SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id='0029') THEN 0 ELSE 1 END"),
    active_user_without_canonical_role: scalar(db, `SELECT COUNT(*) FROM users u
      WHERE u.is_active=1 AND NOT EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1
          AND (ur.valid_from IS NULL OR ur.valid_from<=datetime('now'))
          AND (ur.valid_until IS NULL OR ur.valid_until>datetime('now'))
      )`),
    legacy_admin_without_sys_admin: scalar(db, `SELECT COUNT(*) FROM users u
      WHERE u.is_active=1 AND u.is_admin=1 AND NOT EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='SYS_ADMIN'
          AND (ur.valid_from IS NULL OR ur.valid_from<=datetime('now'))
          AND (ur.valid_until IS NULL OR ur.valid_until>datetime('now'))
      )`),
    pre_cutover_session_still_live: scalar(db, `SELECT COUNT(*) FROM auth_sessions s
      JOIN schema_migrations sm ON sm.migration_id='0029'
      WHERE datetime(s.issued_at)<=datetime(sm.applied_at) AND s.revoked_at IS NULL`),
    foreign_key_violations: db.pragma('foreign_key_check').length,
  };
  const integrity = db.pragma('integrity_check', { simple: true });
  const pass = integrity === 'ok' && Object.values(hard).every((value) => value === 0);
  return {
    status: pass ? 'CANONICAL_RUNTIME_COMPLETE_COLUMN_CLEANUP_DEFERRED' : 'FAIL',
    integrity_check: integrity,
    hard_failures: hard,
    deferred_cleanup: {
      users_role_non_null: scalar(db, 'SELECT COUNT(*) FROM users WHERE role IS NOT NULL'),
      users_is_admin_true: scalar(db, 'SELECT COUNT(*) FROM users WHERE is_admin=1'),
      reason: 'Physical column deletion requires full authorization UAT and an approved compatibility-window closure.',
    },
    counts: {
      users: scalar(db, 'SELECT COUNT(*) FROM users'),
      active_users: scalar(db, 'SELECT COUNT(*) FROM users WHERE is_active=1'),
      active_role_assignments: scalar(db, 'SELECT COUNT(*) FROM user_roles WHERE active=1'),
      auth_sessions: scalar(db, 'SELECT COUNT(*) FROM auth_sessions'),
    },
  };
}

function main() {
  const { dbPath } = parseArgs(process.argv.slice(2));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = { database: dbPath, ...runParity(db) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'FAIL') process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, runParity };
