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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage4-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function columnNames(db, table) {
  return db.pragma(`table_info('${table}')`).map((row) => row.name);
}

function seedCorrectiveActionFixture(db, { linked = true } = {}) {
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES ('stage4-owner@example.invalid', 0, 'ChuyÃªn viÃªn', 1, 'Stage 4 Owner', 'fixture')`).run();
  const supplierId = db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE4-NCC', 'Synthetic Stage 4 NCC', 'ACTIVE', 'MANUAL', 'stage4-owner@example.invalid')`).run().lastInsertRowid;
  const templateId = db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active) VALUES ('STAGE4-Q', 'Synthetic Stage 4 Questions', 1)`).run().lastInsertRowid;
  const ticketId = db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, facility_type, supplier_scale,
     current_status, current_round_no, assigned_specialist_id, created_by)
    VALUES ('STAGE4-TICKET', ?, 'Periodic', ?, 'FACTORY', 'LARGE', 'Draft', 1,
      'stage4-owner@example.invalid', 'stage4-owner@example.invalid')`).run(supplierId, templateId).lastInsertRowid;
  const roundId = db.prepare(`INSERT INTO evaluation_rounds (ticket_id, round_no, status)
    VALUES (?, 1, 'Draft')`).run(ticketId).lastInsertRowid;
  const actionId = db.prepare(`INSERT INTO corrective_actions
    (ticket_id, round_id, issue_description, required_action, due_date, status, created_by)
    VALUES (?, ?, 'Synthetic finding', 'Synthetic remediation', '2026-12-31', 'OPEN',
      'stage4-owner@example.invalid')`).run(ticketId, roundId).lastInsertRowid;
  let nonconformityId = null;
  if (linked) {
    nonconformityId = db.prepare(`INSERT INTO evaluation_nonconformities
      (ticket_id, round_id, nonconformity, remediation, due_date, status,
       corrective_action_id, nonconformity_content, remediation_content, created_by)
      VALUES (?, ?, 'Synthetic finding', 'Synthetic remediation', '2026-12-31', 'OPEN', ?,
        'Synthetic finding', 'Synthetic remediation', 'stage4-owner@example.invalid')`).run(
      ticketId,
      roundId,
      actionId,
    ).lastInsertRowid;
  }
  return { actionId, nonconformityId, roundId, ticketId };
}

test('stage 4 fresh schema retains only canonical nonconformity remediation storage', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4-test' });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrective_actions'").get(), undefined);
    const columns = columnNames(db, 'evaluation_nonconformities');
    assert.ok(columns.includes('nonconformity_content'));
    assert.ok(columns.includes('remediation_content'));
    assert.ok(!columns.includes('nonconformity'));
    assert.ok(!columns.includes('remediation'));
    assert.ok(!columns.includes('corrective_action_id'));
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('stage 4 upgrades linked legacy corrective actions without losing canonical content and is retry-safe', () => {
  const historical = historicalDirectory('0025');
  const stage4 = historicalDirectory('0026');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage3-test' });
    const fixture = seedCorrectiveActionFixture(db);
    migrateDatabase(db, { migrationsDir: stage4, appVersion: 'stage4-test' });

    const row = db.prepare(`SELECT nonconformity_content, remediation_content, due_date, status
      FROM evaluation_nonconformities WHERE id=?`).get(fixture.nonconformityId);
    assert.deepEqual(row, {
      nonconformity_content: 'Synthetic finding',
      remediation_content: 'Synthetic remediation',
      due_date: '2026-12-31',
      status: 'OPEN',
    });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrective_actions'").get(), undefined);
    migrateDatabase(db, { migrationsDir: stage4, appVersion: 'stage4-retry-test' });
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0026'").pluck().get(), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
    fs.rmSync(stage4, { recursive: true, force: true });
  }
});

test('stage 4 refuses cleanup when an independent corrective action would be lost', () => {
  const historical = historicalDirectory('0025');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage3-test' });
    seedCorrectiveActionFixture(db, { linked: false });
    assert.throws(
      () => migrateDatabase(db, { migrationsDir, appVersion: 'stage4-test' }),
      /CHECK constraint failed/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0026'").pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM corrective_actions').pluck().get(), 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});
