'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { runParity } = require('../scripts/check-stage2-parity');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function migrationIds() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, 4));
}

function columnNames(db, table) {
  return db.pragma(`table_info('${table}')`).map((row) => row.name);
}

function historicalDirectory(lastId) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage2-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function seedCanonicalBackfillFixture(db) {
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES ('stage2-owner@example.invalid', 0, 'ChuyÃªn viÃªn', 1, 'Stage 2 Owner', 'fixture')`).run();
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES ('stage2-unmapped@example.invalid', 0, 'Lead miền', 1, 'Stage 2 Unmapped', 'fixture')`).run();
  db.prepare(`DELETE FROM user_roles WHERE user_id = 'stage2-unmapped@example.invalid'`).run();

  const supplierId = db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE2-NCC', 'Synthetic Stage 2 NCC', 'ACTIVE', 'MANUAL', 'stage2-owner@example.invalid')`).run().lastInsertRowid;
  const templateId = db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active) VALUES ('STAGE2-Q', 'Synthetic Stage 2 Questions', 1)`).run().lastInsertRowid;
  const legacyQuestionId = db.prepare(`INSERT INTO evaluation_questions
    (template_id, facility_type, supplier_scale, question_code, question_text, category,
     allowed_scores, weight, order_index, active)
    VALUES (?, 'FACTORY', 'LARGE', 'S2-Q1', 'Synthetic question', 'Synthetic category',
      'A/B/C/D/NA', 1, 1, 1)`).run(templateId).lastInsertRowid;
  const versionId = db.prepare(`INSERT INTO question_template_versions
    (template_id, version_no, status, checksum, created_by)
    VALUES (?, 1, 'DRAFT', ?, 'stage2-owner@example.invalid')`).run(templateId, '1'.repeat(64)).lastInsertRowid;
  const itemId = db.prepare(`INSERT INTO question_items
    (question_template_version_id, legacy_question_id, facility_type, supplier_scale,
     question_code, question_text, category, allowed_scores, weight, order_index, active)
    VALUES (?, ?, 'FACTORY', 'LARGE', 'S2-Q1', 'Synthetic question', 'Synthetic category',
      'A/B/C/D/NA', 1, 1, 1)`).run(versionId, legacyQuestionId).lastInsertRowid;
  db.prepare(`UPDATE question_template_versions SET status='PUBLISHED', published_at=datetime('now'),
    published_by='stage2-owner@example.invalid' WHERE id=?`).run(versionId);

  const scoringVersionId = db.prepare(`SELECT id FROM scoring_policy_versions
    WHERE status='PUBLISHED' ORDER BY id LIMIT 1`).pluck().get();
  const ticketId = db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, facility_type, supplier_scale,
     current_status, current_round_no, assigned_specialist_id, evaluator_name, qa_lead_id,
     qa_support_ids, question_template_version_id, scoring_policy_version_id, created_by)
    VALUES ('STAGE2-TICKET', ?, 'Periodic', ?, 'FACTORY', 'LARGE', 'Draft', 1,
      'stage2-owner@example.invalid', 'External evaluator', 'stage2-owner@example.invalid',
      ?, ?, ?, 'stage2-owner@example.invalid')`).run(
    supplierId,
    templateId,
    JSON.stringify(['stage2-owner@example.invalid']),
    versionId,
    scoringVersionId,
  ).lastInsertRowid;
  const roundId = db.prepare(`INSERT INTO evaluation_rounds
    (ticket_id, round_no, status, evaluator_id, attendees_json, scoring_policy_version_id)
    VALUES (?, 1, 'Draft', 'stage2-owner@example.invalid', ?, ?)`).run(
    ticketId,
    JSON.stringify([{ name: 'External attendee', opening: true, closing: false }]),
    scoringVersionId,
  ).lastInsertRowid;
  const answerId = db.prepare(`INSERT INTO evaluation_answers
    (round_id, question_id, score, comment, answered_by)
    VALUES (?, ?, 'B', 'Synthetic nonconformity', 'stage2-owner@example.invalid')`).run(
    roundId,
    legacyQuestionId,
  ).lastInsertRowid;
  const nonconformityId = db.prepare(`INSERT INTO evaluation_nonconformities
    (ticket_id, round_id, question_id, nonconformity, remediation, due_date, severity, created_by)
    VALUES (?, ?, ?, 'Synthetic nonconformity', 'Synthetic remediation', '2026-12-31', 'B',
      'stage2-owner@example.invalid')`).run(ticketId, roundId, legacyQuestionId).lastInsertRowid;
  return { answerId, itemId, nonconformityId, roundId, ticketId };
}

test('stage 2 fresh schema is additive and exposes every canonical bridge', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage2-test' });
    assert.deepEqual(migrationIds().slice(-6), ['0020', '0021', '0022', '0023', '0024', '0025']);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evaluation_participants'").get());
    assert.ok(columnNames(db, 'evaluation_answers').includes('question_item_id'));
    assert.ok(columnNames(db, 'evaluation_nonconformities').includes('evaluation_answer_id'));
    assert.ok(columnNames(db, 'evaluation_nonconformities').includes('nonconformity_content'));
    assert.ok(columnNames(db, 'evaluation_nonconformities').includes('remediation_content'));
    assert.ok(columnNames(db, 'evaluation_tickets').includes('snapshot_locked_at'));
    assert.ok(columnNames(db, 'evaluation_answers').includes('question_id'), 'legacy answer link remains');
    assert.ok(columnNames(db, 'evaluation_tickets').includes('qa_support_ids'), 'legacy participant JSON remains');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='corrective_actions'").get(), 'legacy corrective actions remain');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('stage 2 upgrades a populated 0019 database with deterministic backfill and no legacy deletion', () => {
  const historical = historicalDirectory('0019');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage1-test' });
    const fixture = seedCanonicalBackfillFixture(db);
    migrateDatabase(db, { migrationsDir, appVersion: 'stage2-test' });

    assert.equal(db.prepare('SELECT question_item_id FROM evaluation_answers WHERE id=?').pluck().get(fixture.answerId), fixture.itemId);
    const nc = db.prepare(`SELECT evaluation_answer_id, nonconformity_content, remediation_content
      FROM evaluation_nonconformities WHERE id=?`).get(fixture.nonconformityId);
    assert.equal(nc.evaluation_answer_id, fixture.answerId);
    assert.equal(nc.nonconformity_content, 'Synthetic nonconformity');
    assert.equal(nc.remediation_content, 'Synthetic remediation');
    assert.equal(db.prepare('SELECT snapshot_locked_at FROM evaluation_tickets WHERE id=?').pluck().get(fixture.ticketId),
      db.prepare('SELECT started_at FROM evaluation_rounds WHERE id=?').pluck().get(fixture.roundId));
    assert.ok(db.prepare(`SELECT 1 FROM evaluation_participants
      WHERE ticket_id=? AND participant_role='OWNER' AND user_id='stage2-owner@example.invalid'`).get(fixture.ticketId));
    assert.ok(db.prepare(`SELECT 1 FROM evaluation_participants
      WHERE round_id=? AND participant_role='ATTENDEE' AND display_name='External attendee'`).get(fixture.roundId));
    assert.ok(db.prepare(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
      WHERE ur.user_id='stage2-unmapped@example.invalid' AND ur.active=1 AND r.role_code='REGIONAL_LEAD_APPROVER'`).get());
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='corrective_actions'").pluck().get(), 'corrective_actions');
    const parity = runParity(db);
    assert.equal(parity.status, 'PASS', JSON.stringify(parity));
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});
