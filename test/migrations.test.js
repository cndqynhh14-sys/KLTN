'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  CORE_TABLES,
  FIXTURE,
  createLegacyFixture,
  snapshotCounts,
} = require('../fixtures/migrations/legacyFixtureBuilder');

const RETIRED_SCOPE_TABLES = Object.freeze([
  'ncc_documents', 'ncc_evaluations', 'upload_log', 'monthly_overview',
  'ncc_documents_summary', 'ncc_evaluations_summary', 'ncc_violations_summary',
  'lab_tests_summary', 'kph_incidents_summary', 'qc_warehouse_summary',
  'qc_warehouse_top_ncc', 'thresholds', 'input_dossiers', 'input_dossier_items',
  'input_dossier_reviews', 'input_dossier_review_errors',
  'input_dossier_workflow_history', 'input_dossier_export_logs',
  'input_dossier_approval_tasks', 'input_dossier_email_logs',
  'corrective_actions',
]);

function freshDbModule(dbPath) {
  process.env.DB_PATH = dbPath;
  const pathsModule = require.resolve('../server/config/paths');
  const dbModule = require.resolve('../server/db');
  delete require.cache[pathsModule];
  delete require.cache[dbModule];
  return require('../server/db');
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => row.name);
}

function assertHasColumns(db, table, columns) {
  const existing = tableColumns(db, table);
  for (const column of columns) assert.ok(existing.includes(column), `${table}.${column}`);
}

function assertRetiredParticipantColumnsAbsent(db) {
  const ticketColumns = tableColumns(db, 'evaluation_tickets');
  const roundColumns = tableColumns(db, 'evaluation_rounds');
  for (const column of ['evaluator_name', 'qa_lead_id', 'qa_support_ids']) {
    assert.ok(!ticketColumns.includes(column), `evaluation_tickets.${column}`);
  }
  for (const column of ['evaluator_id', 'attendees_json']) {
    assert.ok(!roundColumns.includes(column), `evaluation_rounds.${column}`);
  }
}

function closeTempDb(db) {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.pragma('journal_mode = DELETE'); } catch {}
  db.close();
}

function cleanupDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(filePath, { force: true });
        break;
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 4) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
}

test('legacy synthetic fixture upgrades through controlled forward-repair and preserves rows/FKs', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-migration-upgrade-${process.pid}-${Date.now()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const before = createLegacyFixture(dbPath).counts;

  try {
    let mod = freshDbModule(dbPath);
    closeTempDb(mod.db);
    mod = freshDbModule(dbPath);
    const db = mod.db;

    const ledger = db.prepare('SELECT * FROM schema_migrations ORDER BY migration_id').all();
    assert.equal(ledger.length, 36);
    assert.equal(ledger[0].migration_id, '0001');
    assert.equal(ledger[0].execution_mode, 'forward-repair');
    assert.match(ledger[0].checksum, /^[a-f0-9]{64}$/);
    assert.equal(ledger[0].app_version, '0.1.0');
    assert.equal(ledger[1].migration_id, '0002');
    assert.equal(ledger[1].execution_mode, 'applied');
    assert.equal(ledger[2].migration_id, '0003');
    assert.equal(ledger[2].execution_mode, 'applied');
    assert.equal(ledger[3].migration_id, '0004');
    assert.equal(ledger[3].execution_mode, 'applied');
    assert.equal(ledger[4].migration_id, '0005');
    assert.equal(ledger[4].execution_mode, 'applied');
    assert.equal(ledger[5].migration_id, '0006');
    assert.equal(ledger[5].execution_mode, 'applied');
    assert.equal(ledger[6].migration_id, '0007');
    assert.equal(ledger[6].execution_mode, 'applied');
    assert.equal(ledger[7].migration_id, '0008');
    assert.equal(ledger[8].migration_id, '0009');
    assert.equal(ledger[9].migration_id, '0010');
    assert.equal(ledger[10].migration_id, '0011');
    assert.equal(ledger[11].migration_id, '0012');
    assert.equal(ledger[12].migration_id, '0013');
    assert.equal(ledger[13].migration_id, '0014');
    assert.equal(ledger[14].migration_id, '0015');
    assert.equal(ledger[15].migration_id, '0016');
    assert.equal(ledger[16].migration_id, '0017');
    assert.equal(ledger[17].migration_id, '0018');
    assert.equal(ledger[17].execution_mode, 'applied');
    assert.equal(ledger[18].migration_id, '0019');
    assert.equal(ledger[18].execution_mode, 'applied');
    assert.deepEqual(ledger.slice(19).map((row) => row.migration_id),
      ['0020', '0021', '0022', '0023', '0024', '0025', '0026', '0027', '0028', '0029', '0030', '0031', '0032', '0033', '0034', '0035', '0036']);
    assert.ok(ledger.slice(19).every((row) => row.execution_mode === 'applied'));
    assert.equal(ledger[7].execution_mode, 'applied');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.deepEqual(snapshotCounts(db, CORE_TABLES), before);

    assert.equal(
      db.prepare('SELECT supplier_name FROM supplier_master WHERE supplier_code = ?').get(FIXTURE.supplierCode).supplier_name,
      FIXTURE.supplierName
    );
    assert.equal(
      db.prepare('SELECT ticket_code FROM evaluation_tickets WHERE ticket_code = ?').get(FIXTURE.ticketCode).ticket_code,
      FIXTURE.ticketCode
    );
    assert.equal(db.prepare('SELECT file_format FROM report_exports WHERE id = 1').get().file_format, 'PDF');
    assert.equal(db.prepare('SELECT export_scope FROM report_exports WHERE id = 1').get().export_scope, 'TICKET');
    assertHasColumns(db, 'supplier_master', [
      'supplier_code', 'supplier_name', 'tax_code', 'address', 'region', 'province',
      'business_type', 'status', 'contact_name', 'contact_email', 'contact_phone',
      'source_type', 'created_at', 'created_by', 'updated_at', 'updated_by',
    ]);
    for (const column of ['production_address', 'evaluation_address', 'linked_facility_code', 'mch2', 'mch3', 'product_name', 'cmc_owner']) {
      assert.equal(tableColumns(db, 'supplier_master').includes(column), false, column);
    }
    assertHasColumns(db, 'evaluation_tickets', [
      'production_address', 'snapshot_evaluation_address', 'snapshot_product_name', 'evaluation_department',
      'corrected_score_percent', 'next_evaluation_date', 'final_conclusion', 'is_deleted',
    ]);
    assertHasColumns(db, 'evaluation_rounds', [
      'assessment_code', 'assessment_date', 'source_round_id',
    ]);
    assertHasColumns(db, 'report_exports', ['round_id', 'file_format', 'export_scope']);
    assertHasColumns(db, 'users', ['authz_version', 'user_id']);
    assert.equal(tableColumns(db, 'users').includes('role'), false);
    assert.equal(tableColumns(db, 'users').includes('is_admin'), false);
    assertHasColumns(db, 'authz_change_log', ['reason', 'authz_version', 'actor_principal_id', 'target_principal_id']);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM roles').get().count, 9);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM permissions').get().count, 23);
    for (const table of RETIRED_SCOPE_TABLES) {
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table),
        undefined,
        table
      );
    }
    assert.equal(db.prepare("SELECT COUNT(*) FROM approval_stage_assignments WHERE workflow_type='INPUT_DOSSIER'").pluck().get(), 0);
    assert.equal(db.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
    closeTempDb(db);
  } finally {
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    cleanupDb(dbPath);
  }
});

test('fresh database survives two consecutive normal startups without recreating retired tables', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-migration-fresh-startup-${process.pid}-${Date.now()}.db`);
  const oldDbPath = process.env.DB_PATH;

  try {
    let mod = freshDbModule(dbPath);
    assert.equal(mod.db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 36);
    for (const table of RETIRED_SCOPE_TABLES) {
      assert.equal(mod.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined, table);
    }
    assertRetiredParticipantColumnsAbsent(mod.db);
    closeTempDb(mod.db);

    mod = freshDbModule(dbPath);
    assert.equal(mod.db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), 36);
    for (const table of RETIRED_SCOPE_TABLES) {
      assert.equal(mod.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined, table);
    }
    assertRetiredParticipantColumnsAbsent(mod.db);
    assert.equal(mod.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(mod.db.pragma('foreign_key_check').length, 0);
    closeTempDb(mod.db);
  } finally {
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    cleanupDb(dbPath);
  }
});
