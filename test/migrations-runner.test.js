'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  MigrationError,
  migrationStatus,
  migrateDatabase,
} = require('../server/database/migrationRunner');

const projectMigrations = path.resolve(__dirname, '..', 'migrations');
const projectMigrationIds = fs.readdirSync(projectMigrations)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => name.slice(0, 4));

const RETIRED_SCOPE_TABLES = Object.freeze([
  'ncc_documents',
  'ncc_evaluations',
  'upload_log',
  'monthly_overview',
  'ncc_documents_summary',
  'ncc_evaluations_summary',
  'ncc_violations_summary',
  'lab_tests_summary',
  'kph_incidents_summary',
  'qc_warehouse_summary',
  'qc_warehouse_top_ncc',
  'thresholds',
  'input_dossiers',
  'input_dossier_items',
  'input_dossier_reviews',
  'input_dossier_review_errors',
  'input_dossier_workflow_history',
  'input_dossier_export_logs',
  'input_dossier_approval_tasks',
  'input_dossier_email_logs',
]);

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-${label}-`));
}

function writeMigration(directory, fileName, sql) {
  fs.writeFileSync(path.join(directory, fileName), sql, 'utf8');
}

function closeAndRemove(db, directory) {
  if (db?.open) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test('fresh install applies baseline transactionally and rerun is idempotent', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    const first = migrateDatabase(db, { migrationsDir: projectMigrations, appVersion: 'test-version' });
    assert.deepEqual(first.results.map((row) => row.id), projectMigrationIds);
    assert.ok(first.results.every((row) => row.state === 'applied' && row.executionMode === 'applied'));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count, 62);
    for (const table of RETIRED_SCOPE_TABLES) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
        undefined,
        table
      );
    }
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_events'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_legacy_template_links'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_legacy_migration_review'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personnel_import_batches'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='personnel_import_batches_append_only_update'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='personnel_import_batches_append_only_delete'").get());
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
    assert.equal(db.prepare("SELECT COUNT(*) FROM approval_stage_assignments WHERE workflow_type='INPUT_DOSSIER'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM permissions WHERE permission_code='UPLOAD.MANAGE' OR permission_code LIKE 'INPUT_DOSSIER.%'").pluck().get(), 0);
    assert.throws(() => db.prepare(`INSERT INTO notifications
      (receiver_user_id, notification_type, message)
      VALUES ('missing@example.invalid', 'INPUT_DOSSIER_ASSIGNED', 'synthetic')`).run(), /CHECK constraint failed/);

    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY migration_id').all();
    assert.deepEqual(ledger.map((row) => row.migration_id), projectMigrationIds);
    assert.ok(ledger.every((row) => row.execution_mode === 'applied'));
    assert.ok(ledger.every((row) => row.app_version === 'test-version'));
    assert.ok(ledger.every((row) => row.duration_ms >= 0));

    const second = migrateDatabase(db, { migrationsDir: projectMigrations, appVersion: 'test-version' });
    assert.deepEqual(second.results.map((row) => row.id), projectMigrationIds);
    assert.ok(second.results.every((row) => row.state === 'already-applied'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, projectMigrationIds.length);
  } finally {
    db.close();
  }
});

test('current pre-ledger database adopts baseline without replaying application rows', () => {
  const db = new Database(':memory:');
  const baselineSql = fs.readFileSync(path.join(projectMigrations, '0001_current_schema.sql'), 'utf8');
  db.exec(baselineSql);
  db.prepare(`INSERT INTO users
    (email, is_admin, role, is_active, display_name, created_at, created_by)
    VALUES ('adopt-001@example.invalid', 0, 'Chuyên viên', 1, 'SYNTHETIC ADOPT USER',
      '2026-01-01 00:00:00', 'fixture')`).run();
  try {
    const result = migrateDatabase(db, { migrationsDir: projectMigrations, appVersion: 'test-version' });
    assert.equal(result.results[0].executionMode, 'adopted');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.equal(db.prepare('SELECT execution_mode FROM schema_migrations WHERE migration_id = ?').get('0001').execution_mode, 'adopted');
  } finally {
    db.close();
  }
});

test('failure in a transactional migration rolls back and a corrected pending migration can retry', () => {
  const directory = tempDir('migration-retry');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    writeMigration(directory, '0001_base.sql', 'CREATE TABLE base_record (id INTEGER PRIMARY KEY);');
    writeMigration(directory, '0002_probe.sql', `
      CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO migration_probe (id, value) VALUES (1, 'SYNTHETIC');
      INSERT INTO missing_table (id) VALUES (1);
    `);
    assert.throws(
      () => migrateDatabase(db, { migrationsDir: directory, appVersion: 'test-version' }),
      (error) => error instanceof MigrationError && error.code === 'MIGRATION_APPLY_FAILED'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_probe'").get(), undefined);

    writeMigration(directory, '0002_probe.sql', `
      CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO migration_probe (id, value) VALUES (1, 'SYNTHETIC');
    `);
    const retry = migrateDatabase(db, { migrationsDir: directory, appVersion: 'test-version' });
    assert.equal(retry.results.find((row) => row.id === '0002').executionMode, 'applied');
    assert.equal(db.prepare('SELECT value FROM migration_probe WHERE id = 1').get().value, 'SYNTHETIC');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
  } finally {
    closeAndRemove(db, directory);
  }
});

test('checksum mismatch and missing applied files fail closed', () => {
  const directory = tempDir('migration-checksum');
  const db = new Database(':memory:');
  try {
    writeMigration(directory, '0001_base.sql', 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY);');
    migrateDatabase(db, { migrationsDir: directory, appVersion: 'test-version' });
    writeMigration(directory, '0001_base.sql', 'CREATE TABLE checksum_probe (id INTEGER PRIMARY KEY, changed TEXT);');
    assert.throws(
      () => migrationStatus(db, { migrationsDir: directory }),
      (error) => error instanceof MigrationError && error.code === 'MIGRATION_CHECKSUM_MISMATCH'
    );
    fs.rmSync(path.join(directory, '0001_base.sql'));
    assert.throws(
      () => migrationStatus(db, { migrationsDir: directory }),
      (error) => error instanceof MigrationError && error.code === 'MIGRATION_FILE_MISSING'
    );
  } finally {
    closeAndRemove(db, directory);
  }
});

test('migration checksums are stable across LF and CRLF worktrees', () => {
  const directory = tempDir('migration-line-endings');
  const db = new Database(':memory:');
  try {
    const lf = 'CREATE TABLE line_ending_probe (\n  id INTEGER PRIMARY KEY\n);\n';
    writeMigration(directory, '0001_base.sql', lf);
    migrateDatabase(db, { migrationsDir: directory, appVersion: 'test-version' });
    writeMigration(directory, '0001_base.sql', lf.replace(/\n/g, '\r\n'));
    const status = migrationStatus(db, { migrationsDir: directory });
    assert.equal(status[0].state, 'applied');
  } finally {
    closeAndRemove(db, directory);
  }
});

test('status/dry-run planning does not create a ledger', () => {
  const db = new Database(':memory:');
  try {
    const status = migrationStatus(db, { migrationsDir: projectMigrations });
    assert.equal(status.length, projectMigrationIds.length);
    assert.ok(status.every((row) => row.state === 'pending'));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(), undefined);
  } finally {
    db.close();
  }
});

test('backup and restored fixture retain ledger, row counts and foreign-key integrity', async () => {
  const directory = tempDir('migration-backup');
  const dbPath = path.join(directory, 'source.db');
  const backupPath = path.join(directory, 'backup.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: projectMigrations, appVersion: 'test-version' });
    db.prepare(`INSERT INTO users
      (email, is_admin, role, is_active, display_name, created_at, created_by)
      VALUES ('backup-001@example.invalid', 0, 'Chuyên viên', 1, 'SYNTHETIC BACKUP USER',
      '2026-01-01 00:00:00', 'fixture')`).run();
    await db.backup(backupPath);
    db.close();

    const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const status = migrationStatus(restored, { migrationsDir: projectMigrations });
      assert.ok(status.every((row) => row.state === 'applied'));
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, projectMigrationIds.length);
      assert.equal(restored.pragma('foreign_key_check').length, 0);
    } finally {
      restored.close();
    }
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('0019 upgrades a populated 0018 database and preserves retained supplier-evaluation rows', () => {
  const directory = tempDir('scope-upgrade');
  const historicalMigrations = path.join(directory, 'migrations-through-0018');
  fs.mkdirSync(historicalMigrations);
  for (const fileName of fs.readdirSync(projectMigrations)) {
    if (/^00(?:0[1-9]|1[0-8])_.+\.sql$/.test(fileName)) {
      fs.copyFileSync(path.join(projectMigrations, fileName), path.join(historicalMigrations, fileName));
    }
  }
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historicalMigrations, appVersion: 'pre-commit-2' });
    db.prepare(`INSERT INTO users
      (email, is_admin, role, is_active, display_name, created_at, created_by)
      VALUES ('scope-upgrade@example.invalid', 0, 'ChuyÃªn viÃªn', 1,
        'SYNTHETIC SCOPE UPGRADE USER', '2026-01-01 00:00:00', 'fixture')`).run();
    db.prepare(`INSERT INTO supplier_master
      (supplier_code, supplier_name, status, source_type, created_at, created_by)
      VALUES ('SYN-SCOPE-001', 'SYNTHETIC RETAINED NCC', 'ACTIVE', 'MANUAL',
        '2026-01-01 00:00:00', 'scope-upgrade@example.invalid')`).run();
    db.prepare(`INSERT INTO upload_log
      (email, source_type, filename, report_month, status)
      VALUES ('scope-upgrade@example.invalid', 'ncc_documents', 'synthetic.xlsx', '2026-01', 'ok')`).run();
    db.prepare("INSERT INTO thresholds (metric_key, red_threshold, amber_threshold) VALUES ('synthetic.scope', 0.2, 0.1)").run();
    db.prepare("INSERT INTO input_dossiers (dossier_code, created_by) VALUES ('SYN-DOSSIER-001', 'scope-upgrade@example.invalid')").run();
    db.prepare(`INSERT INTO notifications
      (receiver_user_id, notification_type, message, unique_key)
      VALUES ('scope-upgrade@example.invalid', 'INPUT_DOSSIER_ASSIGNED', 'synthetic retired', 'scope-retired')`).run();
    db.prepare(`INSERT INTO notifications
      (receiver_user_id, notification_type, message, unique_key)
      VALUES ('scope-upgrade@example.invalid', 'EVALUATION_ASSIGNED', 'synthetic retained', 'scope-retained')`).run();

    const result = migrateDatabase(db, { migrationsDir: projectMigrations, appVersion: 'commit-2' });

    assert.equal(result.results.at(-1).id, '0019');
    assert.equal(result.results.at(-1).executionMode, 'applied');
    assert.equal(db.prepare("SELECT supplier_name FROM supplier_master WHERE supplier_code='SYN-SCOPE-001'").pluck().get(), 'SYNTHETIC RETAINED NCC');
    assert.equal(db.prepare("SELECT COUNT(*) FROM notifications WHERE unique_key='scope-retained'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM notifications WHERE unique_key='scope-retired'").pluck().get(), 0);
    for (const table of RETIRED_SCOPE_TABLES) {
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined, table);
    }
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    closeAndRemove(db, directory);
  }
});

test('nontransactional SQL is rejected unless its migration ID is explicitly approved', () => {
  const directory = tempDir('migration-nontransactional');
  const db = new Database(':memory:');
  try {
    writeMigration(directory, '0001_base.sql', 'CREATE TABLE non_tx_probe (id INTEGER PRIMARY KEY);');
    writeMigration(directory, '0002_vacuum.sql', 'VACUUM;');
    assert.throws(
      () => migrateDatabase(db, { migrationsDir: directory, appVersion: 'test-version' }),
      (error) => error instanceof MigrationError && error.code === 'MIGRATION_NON_TRANSACTIONAL_NOT_APPROVED'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1);
    const result = migrateDatabase(db, {
      migrationsDir: directory,
      appVersion: 'test-version',
      allowedNonTransactionalIds: ['0002'],
    });
    assert.equal(result.status.find((row) => row.id === '0002').execution_mode, 'applied-nontransactional');
  } finally {
    closeAndRemove(db, directory);
  }
});

test('baseline forward-repair rolls back every schema change when the adapter fails', () => {
  const directory = tempDir('migration-forward-repair-rollback');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    writeMigration(directory, '0001_base.sql', `
      CREATE TABLE legacy_record (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE repaired_record (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.exec(`
      CREATE TABLE legacy_record (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO legacy_record (id, value) VALUES (1, 'SYNTHETIC-UNCHANGED');
    `);

    assert.throws(
      () => migrateDatabase(db, {
        migrationsDir: directory,
        appVersion: 'test-version',
        forwardRepair: () => {
          db.exec("CREATE TABLE repaired_record (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
          throw new Error('synthetic_forward_repair_failure');
        },
      }),
      /synthetic_forward_repair_failure/
    );

    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='repaired_record'").get(), undefined);
    assert.equal(db.prepare('SELECT value FROM legacy_record WHERE id = 1').get().value, 'SYNTHETIC-UNCHANGED');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 0);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    closeAndRemove(db, directory);
  }
});
