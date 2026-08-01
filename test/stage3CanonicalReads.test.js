'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const EvaluationParticipantRepository = require('../server/repositories/EvaluationParticipantRepository');
const CorrectiveActionRepository = require('../server/repositories/CorrectiveActionRepository');

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
    db.prepare(`INSERT INTO users (email, is_admin, role, is_active, display_name, created_by)
      VALUES (?, 0, 'Chuyên viên', 1, ?, 'fixture')`).run(email, name);
  }
  const supplierId = db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type, created_by)
    VALUES ('STAGE3-NCC', 'Stage 3 Supplier', 'ACTIVE', 'MANUAL', 'owner@example.invalid')`).run().lastInsertRowid;
  const templateId = db.prepare(`INSERT INTO question_templates
    (template_code, template_name, active)
    VALUES ('STAGE3-TEMPLATE', 'Stage 3 Template', 1)`).run().lastInsertRowid;
  const ticketId = db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, evaluation_type, template_id, facility_type, supplier_scale,
     current_status, assigned_specialist_id, qa_lead_id, qa_support_ids, evaluator_name, created_by)
    VALUES ('STAGE3-TICKET', ?, 'Periodic', ?, 'CHUNG', 'LARGE', 'Khởi tạo',
      'lead@example.invalid', 'lead@example.invalid', ?, 'Legacy evaluator', 'owner@example.invalid')`).run(
    supplierId,
    templateId,
    JSON.stringify(['legacy-support@example.invalid']),
  ).lastInsertRowid;
  const roundId = db.prepare(`INSERT INTO evaluation_rounds
    (ticket_id, round_no, evaluator_id, attendees_json, status)
    VALUES (?, 1, 'legacy-round@example.invalid', ?, 'Khởi tạo')`).run(
    ticketId,
    JSON.stringify([{ name: 'Legacy attendee', opening: true, closing: false }]),
  ).lastInsertRowid;
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, user_id, display_name, participant_role)
    VALUES (?, 'owner@example.invalid', 'Canonical Owner', 'OWNER')`).run(ticketId);
  db.prepare(`INSERT INTO evaluation_participants
    (round_id, user_id, display_name, participant_role)
    VALUES (?, 'round@example.invalid', 'Canonical Evaluator', 'EVALUATOR')`).run(roundId);
  return { db, roundId, ticketId };
}

test('participant reads prefer canonical rows and fall back per missing role without mutating data', () => {
  const { db, roundId, ticketId } = fixture();
  try {
    const repository = new EvaluationParticipantRepository(db);
    const ticket = repository.resolveTicketParticipants(ticketId);
    assert.equal(ticket.source, 'MIXED');
    assert.equal(ticket.mismatch, true);
    assert.equal(ticket.participants.find((row) => row.participant_role === 'OWNER').user_id, 'owner@example.invalid');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'QA_LEAD').user_id, 'lead@example.invalid');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'QA_SUPPORT').display_name, 'legacy-support@example.invalid');
    assert.equal(ticket.participants.find((row) => row.participant_role === 'EVALUATOR').display_name, 'Legacy evaluator');

    const round = repository.resolveRoundParticipants(roundId);
    assert.equal(round.source, 'MIXED');
    assert.equal(round.participants.find((row) => row.participant_role === 'EVALUATOR').user_id, 'round@example.invalid');
    assert.equal(round.participants.find((row) => row.participant_role === 'ATTENDEE').display_name, 'Legacy attendee');
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_participants').pluck().get(), 2, 'read must not backfill');
  } finally {
    db.close();
  }
});

test('nonconformity reads expose canonical content through response compatibility aliases', () => {
  const { db, roundId, ticketId } = fixture();
  try {
    const id = db.prepare(`INSERT INTO evaluation_nonconformities
      (ticket_id, round_id, nonconformity_content, remediation_content, due_date, status, created_by)
      VALUES (?, ?, 'Canonical finding', 'Canonical remediation',
        '2026-12-31', 'OPEN', 'owner@example.invalid')`).run(ticketId, roundId).lastInsertRowid;
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
