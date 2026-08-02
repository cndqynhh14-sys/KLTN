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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `qlcl-stage4c-${lastId}-`));
  for (const fileName of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}_.+\.sql$/.test(fileName) || fileName.slice(0, 4) > lastId) continue;
    fs.copyFileSync(path.join(migrationsDir, fileName), path.join(directory, fileName));
  }
  return directory;
}

function columns(db, table) {
  return db.pragma(`table_info('${table}')`).map((row) => row.name);
}

function seedCanonicalQuestionFixture(db) {
  const user = 'stage4c@example.invalid';
  db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
    VALUES (?, 0, 'Chuyên viên', 1, 'Stage 4C', 'fixture')`).run(user);
  const supplierId = Number(db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE4C-NCC', 'Synthetic Stage 4C NCC', 'ACTIVE', 'MANUAL', ?)`)
    .run(user).lastInsertRowid);
  const templateId = Number(db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active) VALUES ('STAGE4C-Q', 'Stage 4C Questions', 1)`)
    .run().lastInsertRowid);
  const legacyQuestionId = Number(db.prepare(`INSERT INTO evaluation_questions
    (template_id, facility_type, supplier_scale, question_code, question_text, category,
     category_code, category_label_snapshot, allowed_scores, weight, order_index, active)
    VALUES (?, 'FACTORY', 'LARGE', 'Q-01', 'Synthetic criterion', 'Quality',
      'QUALITY', 'Quality', 'A/B/C/D/NA', 1, 1, 1)`)
    .run(templateId).lastInsertRowid);
  const versionId = Number(db.prepare(`INSERT INTO question_template_versions
    (template_id, version_no, status, checksum, lock_version, created_by, published_by,
     published_at, effective_from)
    VALUES (?, 1, 'DRAFT', ?, 1, ?, ?, datetime('now'), '2026-01-01')`)
    .run(templateId, 'a'.repeat(64), user, user).lastInsertRowid);
  const itemId = Number(db.prepare(`INSERT INTO question_items
    (question_template_version_id, legacy_question_id, variant_code, facility_type,
     supplier_scale, category_code, category_label_snapshot, question_code, clause_code,
     question_text, category, allowed_scores, weight, order_index, active)
    VALUES (?, ?, 'STAGE4C-FACTORY-LARGE', 'FACTORY', 'LARGE', 'QUALITY', 'Quality',
      'Q-01', 'Q-01', 'Synthetic criterion', 'Quality', 'A/B/C/D/NA', 1, 1, 1)`)
    .run(versionId, legacyQuestionId).lastInsertRowid);
  db.prepare("UPDATE question_template_versions SET status='PUBLISHED' WHERE id=?").run(versionId);
  const ticketId = Number(db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, question_template_version_id,
     facility_type, supplier_scale, current_status, current_round_no, assigned_specialist_id,
     created_by)
    VALUES ('STAGE4C-TICKET', ?, 'Periodic', ?, ?, 'FACTORY', 'LARGE', 'Draft', 1, ?, ?)`)
    .run(supplierId, templateId, versionId, user, user).lastInsertRowid);
  const roundId = Number(db.prepare(`INSERT INTO evaluation_rounds (ticket_id, round_no, status)
    VALUES (?, 1, 'Draft')`).run(ticketId).lastInsertRowid);
  const answerId = Number(db.prepare(`INSERT INTO evaluation_answers
    (round_id, question_id, question_item_id, score, comment, answered_by)
    VALUES (?, ?, ?, 'B', 'Synthetic answer', ?)`)
    .run(roundId, legacyQuestionId, itemId, user).lastInsertRowid);
  const nonconformityId = Number(db.prepare(`INSERT INTO evaluation_nonconformities
    (ticket_id, round_id, question_id, evaluation_answer_id, nonconformity_content,
     remediation_content, status, created_by)
    VALUES (?, ?, ?, ?, 'Synthetic finding', 'Synthetic remediation', 'OPEN', ?)`)
    .run(ticketId, roundId, legacyQuestionId, answerId, user).lastInsertRowid);
  return { answerId, itemId, nonconformityId, roundId, ticketId };
}

test('stage 4C fresh schema retains only canonical question identity', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4c-test' });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluation_questions'").get(), undefined);
    assert.ok(!columns(db, 'question_items').includes('legacy_question_id'));
    assert.ok(!columns(db, 'evaluation_answers').includes('question_id'));
    assert.ok(!columns(db, 'evaluation_nonconformities').includes('question_id'));
    assert.ok(columns(db, 'evaluation_answers').includes('question_item_id'));
    assert.ok(columns(db, 'evaluation_nonconformities').includes('evaluation_answer_id'));
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});

test('stage 4C preserves canonical answers and nonconformities during upgrade', () => {
  const historical = historicalDirectory('0027');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4b-test' });
    const fixture = seedCanonicalQuestionFixture(db);
    migrateDatabase(db, { migrationsDir, appVersion: 'stage4c-test' });
    assert.deepEqual(db.prepare('SELECT round_id, question_item_id, score, comment FROM evaluation_answers WHERE id=?').get(fixture.answerId), {
      round_id: fixture.roundId,
      question_item_id: fixture.itemId,
      score: 'B',
      comment: 'Synthetic answer',
    });
    assert.deepEqual(db.prepare(`SELECT ticket_id, round_id, evaluation_answer_id,
        nonconformity_content, remediation_content
      FROM evaluation_nonconformities WHERE id=?`).get(fixture.nonconformityId), {
      ticket_id: fixture.ticketId,
      round_id: fixture.roundId,
      evaluation_answer_id: fixture.answerId,
      nonconformity_content: 'Synthetic finding',
      remediation_content: 'Synthetic remediation',
    });
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0028'").pluck().get(), 1);
    const retry = migrateDatabase(db, { migrationsDir, appVersion: 'stage4c-test' });
    assert.equal(retry.results.find((row) => row.id === '0028').state, 'already-applied');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});

test('stage 4C refuses cleanup when a legacy answer is not mapped canonically', () => {
  const historical = historicalDirectory('0027');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  try {
    migrateDatabase(db, { migrationsDir: historical, appVersion: 'stage4b-test' });
    const fixture = seedCanonicalQuestionFixture(db);
    db.prepare('UPDATE evaluation_answers SET question_item_id=NULL WHERE id=?').run(fixture.answerId);
    assert.throws(() => migrateDatabase(db, { migrationsDir, appVersion: 'stage4c-test' }), /CHECK constraint failed/);
    assert.equal(db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE migration_id='0028'").pluck().get(), 0);
    assert.ok(columns(db, 'evaluation_answers').includes('question_id'));
    assert.equal(db.prepare('SELECT question_item_id FROM evaluation_answers WHERE id=?').pluck().get(fixture.answerId), null);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
    fs.rmSync(historical, { recursive: true, force: true });
  }
});
