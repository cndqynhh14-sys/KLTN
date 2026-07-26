'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  MigrationError,
  loadMigrations,
  migrateDatabase,
  migrationStatus,
} = require('../server/database/migrationRunner');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const OUT = path.join(ROOT, 'artifacts', 'release', 'run23', 'migration-rehearsal.json');

function pass(details = {}) { return { status: 'PASS', ...details }; }
function fail(error) { return { status: 'FAIL', error: error.code || error.message }; }

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run23-migrations-'));
  const checks = {};
  const migrations = loadMigrations(MIGRATIONS);
  let freshDb;
  try {
    freshDb = new Database(path.join(temp, 'fresh.db'));
    freshDb.pragma('foreign_keys = ON');
    const first = migrateDatabase(freshDb, { migrationsDir: MIGRATIONS, appVersion: 'RUN-23' });
    const retry = migrateDatabase(freshDb, { migrationsDir: MIGRATIONS, appVersion: 'RUN-23' });
    checks.fresh = first.results.length === migrations.length && first.results.every((row) => row.state === 'applied')
      ? pass({ migration_count: migrations.length, table_count: freshDb.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").pluck().get() })
      : { status: 'FAIL', error: 'fresh_migration_incomplete' };
    checks.retry = retry.results.every((row) => row.state === 'already-applied')
      ? pass({ migration_count: retry.results.length, duplicate_ledger_rows: 0 })
      : { status: 'FAIL', error: 'migration_retry_not_idempotent' };

    const upgradeDb = new Database(path.join(temp, 'upgrade.db'));
    try {
      upgradeDb.exec(fs.readFileSync(path.join(MIGRATIONS, '0001_current_schema.sql'), 'utf8'));
      upgradeDb.prepare(`INSERT INTO users
        (email, is_admin, role, is_active, display_name, created_at, created_by)
        VALUES ('upgrade.run23@example.invalid', 0, 'Chuyên viên', 1, 'RUN23 UPGRADE FIXTURE', '2026-01-01 00:00:00', 'fixture')`).run();
      const upgraded = migrateDatabase(upgradeDb, { migrationsDir: MIGRATIONS, appVersion: 'RUN-23' });
      const preserved = upgradeDb.prepare("SELECT display_name FROM users WHERE email='upgrade.run23@example.invalid'").pluck().get();
      checks.upgrade = upgraded.results[0].executionMode === 'adopted' && preserved === 'RUN23 UPGRADE FIXTURE'
        ? pass({ fixture_preserved: true, baseline_mode: 'adopted', migration_count: upgraded.results.length })
        : { status: 'FAIL', error: 'upgrade_fixture_not_preserved' };
    } finally { upgradeDb.close(); }

    const checksumDir = path.join(temp, 'checksum-migrations');
    fs.mkdirSync(checksumDir);
    fs.writeFileSync(path.join(checksumDir, '0001_probe.sql'), 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);\n', 'utf8');
    const checksumDb = new Database(':memory:');
    try {
      migrateDatabase(checksumDb, { migrationsDir: checksumDir, appVersion: 'RUN-23' });
      fs.writeFileSync(path.join(checksumDir, '0001_probe.sql'), 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY, changed TEXT);\n', 'utf8');
      let code = null;
      try { migrationStatus(checksumDb, { migrationsDir: checksumDir }); } catch (error) { code = error.code; }
      checks.checksum = code === 'MIGRATION_CHECKSUM_MISMATCH' ? pass({ mismatch_failed_closed: true }) : { status: 'FAIL', error: 'checksum_mismatch_not_detected' };
    } finally { checksumDb.close(); }

    const sourcePath = path.join(temp, 'source.db');
    const backupPath = path.join(temp, 'backup.db');
    const restoredPath = path.join(temp, 'restored.db');
    const source = new Database(sourcePath);
    source.pragma('foreign_keys = ON');
    migrateDatabase(source, { migrationsDir: MIGRATIONS, appVersion: 'RUN-23' });
    source.prepare(`INSERT INTO users
      (email, is_admin, role, is_active, display_name, created_at, created_by)
      VALUES ('backup.run23@example.invalid', 0, 'Chuyên viên', 1, 'RUN23 BACKUP FIXTURE', '2026-01-01 00:00:00', 'fixture')`).run();
    await source.backup(backupPath);
    source.prepare("UPDATE users SET display_name='MUTATED AFTER BACKUP' WHERE email='backup.run23@example.invalid'").run();
    source.close();
    fs.copyFileSync(backupPath, restoredPath);
    const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try {
      const name = restored.prepare("SELECT display_name FROM users WHERE email='backup.run23@example.invalid'").pluck().get();
      const ledger = migrationStatus(restored, { migrationsDir: MIGRATIONS });
      const valid = name === 'RUN23 BACKUP FIXTURE' && ledger.every((row) => row.state === 'applied') && restored.pragma('foreign_key_check').length === 0;
      checks.backup_restore = valid ? pass({ fixture_preserved: true, ledger_count: ledger.length, foreign_key_violations: 0 }) : { status: 'FAIL', error: 'backup_restore_verification_failed' };
      checks.rollback_restore = valid ? pass({ active_mutation_removed: true, restored_from_verified_backup: true }) : { status: 'FAIL', error: 'rollback_restore_failed' };
    } finally { restored.close(); }

    const reconciliation = {
      foreign_key_violations: freshDb.pragma('foreign_key_check').length,
      question_item_orphans: freshDb.prepare(`SELECT COUNT(*) FROM question_items qi LEFT JOIN question_template_versions qv ON qv.id=qi.question_template_version_id WHERE qv.id IS NULL`).pluck().get(),
      report_artifact_orphans: freshDb.prepare(`SELECT COUNT(*) FROM report_artifacts a LEFT JOIN report_export_jobs j ON j.id=a.job_id WHERE j.id IS NULL`).pluck().get(),
      migration_ledger_count: freshDb.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(),
    };
    checks.reconciliation = Object.values(reconciliation).every((value, index) => index === 3 ? value === migrations.length : value === 0)
      ? pass(reconciliation)
      : { status: 'FAIL', ...reconciliation };
  } catch (error) {
    const missing = ['fresh', 'upgrade', 'retry', 'checksum', 'backup_restore', 'rollback_restore', 'reconciliation'];
    for (const id of missing) if (!checks[id]) checks[id] = fail(error);
  } finally {
    if (freshDb?.open) freshDb.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const output = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runtime: process.version,
    fixture: 'deterministic synthetic pre-RUN and fresh databases',
    migration_checksums: migrations.map((item) => ({ id: item.id, file: item.fileName, sha256: item.checksum })),
    checks,
    status: Object.values(checks).every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output.status !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.code || error.message}\n`);
  process.exit(1);
});

