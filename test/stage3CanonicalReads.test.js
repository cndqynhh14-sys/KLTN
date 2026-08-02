'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const EvaluationParticipantRepository = require('../server/repositories/EvaluationParticipantRepository');
const CorrectiveActionRepository = require('../server/repositories/CorrectiveActionRepository');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'stage3-test' });
  for (const [email, name] of [
    ['owner@example.invalid', 'Canonical Owner'],
    ['lead@example.invalid', 'Canonical Lead'],
    ['round@example.invalid', 'Canonical Evaluator'],
    ['legacy-round@example.invalid', 'Legacy Round Evaluator'],
  ]) {
    upsertCanonicalUser(db, {
      email, roleCode: 'QLCL_SPECIALIST', displayName: name, createdBy: 'fixture',
    });
  }
  const supplierId = db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE3-NCC', 'Stage 3 Supplier', 'ACTIVE', 'MANUAL', 'owner@example.invalid')`).run().lastInsertRowid;
  const templateId = db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active)
    VALUES ('STAGE3-TEMPLATE', 'Stage 3 Template', 1)`).run().lastInsertRowid;
  const versionId = db.prepare(`INSERT INTO question_template_versions
    (template_id, version_no, status, checksum, lock_version, created_by)
    VALUES (?, 1, 'DRAFT', ?, 1, 'fixture')`).run(templateId, 'f'.repeat(64)).lastInsertRowid;
  const questionItemId = db.prepare(`INSERT INTO question_items
    (question_template_version_id, facility_type, supplier_scale, question_code,
     question_text, category, order_index, active)
    VALUES (?, 'CHUNG', 'LARGE', 'STAGE3-Q1', 'Canonical criterion', 'Quality', 1, 1)`)
    .run(versionId).lastInsertRowid;
  db.prepare("UPDATE question_template_versions SET status='PUBLISHED' WHERE id=?").run(versionId);
  const ticketId = db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, question_template_version_id, facility_type, supplier_scale,
     current_status, assigned_specialist_id, created_by)
    VALUES ('STAGE3-TICKET', ?, 'Periodic', ?, ?, 'CHUNG', 'LARGE', 'Khởi tạo',
      'lead@example.invalid', 'owner@example.invalid')`).run(
    supplierId,
    templateId,
    versionId,
  ).lastInsertRowid;
  const roundId = db.prepare(`INSERT INTO evaluation_rounds
    (ticket_id, round_no, status)
    VALUES (?, 1, 'Khởi tạo')`).run(
    ticketId,
  ).lastInsertRowid;
  const answerId = db.prepare(`INSERT INTO evaluation_answers
    (round_id, question_item_id, score, comment, answered_by)
    VALUES (?, ?, 'B', 'Canonical finding', 'owner@example.invalid')`)
    .run(roundId, questionItemId).lastInsertRowid;
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, user_id, display_name, participant_role)
    VALUES (?, 'owner@example.invalid', 'Canonical Owner', 'OWNER')`).run(ticketId);
  db.prepare(`INSERT INTO evaluation_participants
    (round_id, user_id, display_name, participant_role)
    VALUES (?, 'round@example.invalid', 'Canonical Evaluator', 'EVALUATOR')`).run(roundId);
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, user_id, display_name, participant_role)
    VALUES (?, 'lead@example.invalid', 'Canonical Lead', 'QA_LEAD')`).run(ticketId);
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, display_name, participant_role)
    VALUES (?, 'Canonical Support', 'QA_SUPPORT')`).run(ticketId);
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, display_name, participant_role)
    VALUES (?, 'Canonical Ticket Evaluator', 'EVALUATOR')`).run(ticketId);
  db.prepare(`INSERT INTO evaluation_participants
    (round_id, display_name, participant_role, opening_meeting, closing_meeting)
    VALUES (?, 'Canonical Attendee', 'ATTENDEE', 1, 0)`).run(roundId);
  return { answerId, db, roundId, ticketId };
}

test('participant reads use canonical rows exclusively without fallback mutation', () => {
  const { answerId, db, roundId, ticketId } = fixture();
  try {
    const repository = new EvaluationParticipantRepository(db);
    const ticket = repository.resolveTicketParticipants(ticketId);
    assert.equal(ticket.source, 'CANONICAL');
    assert.equal(ticket.mismatch, false);
    assert.equal(ticket.participants.find((row) => row.participant_role === 'OWNER').user_id, 'owner@example.invalid');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'QA_LEAD').user_id, 'lead@example.invalid');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'QA_SUPPORT').display_name, 'Canonical Support');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'EVALUATOR').display_name, 'Canonical Ticket Evaluator');

    const round = repository.resolveRoundParticipants(roundId);
    assert.equal(round.source, 'CANONICAL');
    assert.equal(round.participants.find((row) => row.participant_role === 'EVALUATOR').user_id, 'round@example.invalid');
    assert.equal(round.participants.find((row) => row.participant_role === 'ATTENDEE').display_name, 'Canonical Attendee');
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_participants').pluck().get(), 6, 'read must not mutate');
  } finally {
    db.close();
  }
});

test('nonconformity reads expose canonical content through response compatibility aliases', () => {
  const { answerId, db, roundId, ticketId } = fixture();
  try {
    const id = db.prepare(`INSERT INTO evaluation_nonconformities
      (ticket_id, round_id, evaluation_answer_id, nonconformity_content, remediation_content, due_date, status, created_by)
      VALUES (?, ?, ?, 'Canonical finding', 'Canonical remediation',
        '2026-12-31', 'OPEN', 'owner@example.invalid')`).run(ticketId, roundId, answerId).lastInsertRowid;
    const repository = new CorrectiveActionRepository(db);
    const row = repository.listNonconformitiesByTicket(ticketId).find((item) => item.id === id);
    assert.equal(row.nonconformity_content, 'Canonical finding');
    assert.equal(row.remediation_content, 'Canonical remediation');
    assert.equal(row.nonconformity, 'Canonical finding');
    assert.equal(row.remediation, 'Canonical remediation');
    assert.equal(row.read_source, 'CANONICAL');
  } finally {
    db.close();
  }
});

test('frontend canonical adapter owns participant, question-item and nonconformity compatibility', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /ticket\.participants/);
  assert.match(source, /question\.question_item_id/);
  assert.match(source, /row\?\.nonconformity_content/);
  assert.match(source, /row\?\.remediation_content/);
});
