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

function columns(db, table) {
  return new Set(db.pragma(`table_info('${String(table).replaceAll("'", "''")}')`).map((row) => row.name));
}

function runParity(db) {
  const userColumns = columns(db, 'users');
  const exportColumns = columns(db, 'report_exports');
  const unresolvedReports = exportColumns.has('job_id') && exportColumns.has('artifact_id')
    ? scalar(db, 'SELECT COUNT(*) FROM report_exports WHERE job_id IS NULL AND artifact_id IS NULL')
    : 0;
  const hard = {
    migration_0030_missing: scalar(db, "SELECT CASE WHEN EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id='0030') THEN 0 ELSE 1 END"),
    users_role_column_present: userColumns.has('role') ? 1 : 0,
    users_is_admin_column_present: userColumns.has('is_admin') ? 1 : 0,
    user_without_canonical_role_history: scalar(db, `SELECT COUNT(*) FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=u.user_id
      )`),
    active_user_without_effective_role: scalar(db, `SELECT COUNT(*) FROM users u
      WHERE u.is_active=1 AND NOT EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=u.user_id AND ur.active=1 AND r.active=1
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
    status: pass
      ? (unresolvedReports > 0 ? 'PASS_WITH_REPORT_PROVENANCE_DEFERRED' : 'PASS')
      : 'FAIL',
    integrity_check: integrity,
    hard_failures: hard,
    report_provenance: {
      unresolved_exports: unresolvedReports,
      cleanup: unresolvedReports > 0 ? 'DEFERRED' : 'ELIGIBLE_FOR_SEPARATE_VERIFIED_CLEANUP',
      destructive_action_taken: false,
    },
    counts: {
      users: scalar(db, 'SELECT COUNT(*) FROM users'),
      active_users: scalar(db, 'SELECT COUNT(*) FROM users WHERE is_active=1'),
      canonical_role_assignments: scalar(db, 'SELECT COUNT(*) FROM user_roles'),
      auth_sessions: scalar(db, 'SELECT COUNT(*) FROM auth_sessions'),
      report_exports: scalar(db, 'SELECT COUNT(*) FROM report_exports'),
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

module.exports = { columns, parseArgs, runParity };
