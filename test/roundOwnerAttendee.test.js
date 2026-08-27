'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const MODULES = [
  '../server/config/paths',
  '../server/db',
  '../server/repositories/EvaluationParticipantRepository',
  '../server/repositories/EvaluationRoundRepository',
  '../server/services/WorkTransferService',
];

function clearModules() {
  MODULES.forEach((modulePath) => { delete require.cache[require.resolve(modulePath)]; });
}

function removeDbFiles(dbPath) {
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function addUser(db, authorizationService, email, roleCode, displayName) {
  upsertCanonicalUser(db, { email, roleCode, displayName });
  const user = db.prepare('SELECT user_id, email, display_name FROM users WHERE email = ?').get(email);
  authorizationService.assignScope({
    userId: user.user_id,
    roleCode,
    scopeType: 'GLOBAL',
    scopeValue: null,
    effect: 'ALLOW',
    actor: null,
  });
  return user;
}

function insertTicket(db, owner) {
  const supplierId = Number(db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type)
    VALUES ('ROUND-OWNER-NCC', 'Round owner supplier', 'ACTIVE', 'MANUAL')`).run().lastInsertRowid);
  const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get()
    || db.prepare('SELECT id FROM question_templates ORDER BY id LIMIT 1').get();
  return Number(db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
     template_id, facility_type, supplier_scale, current_status, current_round_no,
     assigned_specialist_id, assigned_specialist_user_id, created_by, created_by_user_id)
    VALUES ('ROUND-OWNER-TICKET', ?, 'ROUND-OWNER-NCC', 'Round owner supplier',
      'Đánh giá định kỳ', ?, 'CHUNG', 'LARGE', 'Chờ khắc phục', 1, ?, ?, ?, ?)`)
    .run(supplierId, template.id, owner.email, owner.user_id, owner.email, owner.user_id).lastInsertRowid);
}

function ticketOwnerParticipant(db, ticketId, owner, actor) {
  db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, user_id, principal_id, display_name, participant_role,
     assigned_by, assigned_by_user_id)
    VALUES (?, ?, ?, ?, 'OWNER', ?, ?)`)
    .run(ticketId, owner.email, owner.user_id, owner.display_name, actor.email, actor.user_id);
}

function attendeeRows(db, roundId) {
  return db.prepare(`SELECT user_id, principal_id, display_name, opening_meeting, closing_meeting
    FROM evaluation_participants
    WHERE round_id = ? AND participant_role = 'ATTENDEE' AND active = 1
    ORDER BY id`).all(roundId);
}

test('round attendance defaults to the current ticket owner, stays idempotent and is isolated across transfer', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-round-owner-${Date.now()}-${Math.random()}.db`);
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  clearModules();
  const { db, authorizationService, auditEventService } = require('../server/db');
  const { ROLE_CODES } = require('../server/authorization/permissionCatalog');
  const EvaluationParticipantRepository = require('../server/repositories/EvaluationParticipantRepository');
  const EvaluationRoundRepository = require('../server/repositories/EvaluationRoundRepository');
  const { WorkTransferService } = require('../server/services/WorkTransferService');

  try {
    const admin = addUser(db, authorizationService, 'round-admin@example.invalid', ROLE_CODES.SYS_ADMIN, 'Round Admin');
    const ownerA = addUser(db, authorizationService, 'round-owner-a@example.invalid', ROLE_CODES.QLCL_SPECIALIST, 'Evaluator A');
    const ownerB = addUser(db, authorizationService, 'round-owner-b@example.invalid', ROLE_CODES.SYS_ADMIN, 'Evaluator B');
    const ticketId = insertTicket(db, ownerA);
    ticketOwnerParticipant(db, ticketId, ownerA, admin);
    const participantRepository = new EvaluationParticipantRepository(db);
    const roundRepository = new EvaluationRoundRepository(db);

    const round1Id = Number(roundRepository.insert({
      ticket_id: ticketId,
      round_no: 1,
      source_round_id: null,
      assessment_code: 'ROUND-OWNER-TICKET-R1',
      assessment_date: null,
      evaluator_id: admin.user_id,
      status: 'Khởi tạo',
    }).lastInsertRowid);
    let round1Attendees = attendeeRows(db, round1Id);
    assert.equal(round1Attendees.length, 1);
    assert.equal(round1Attendees[0].principal_id, ownerA.user_id, 'admin opening/creating the round must not become an attendee');
    assert.equal(round1Attendees[0].opening_meeting, 1);
    assert.equal(round1Attendees[0].closing_meeting, 1);

    participantRepository.ensureRoundOwnerAttendee(round1Id, admin.user_id);
    participantRepository.ensureRoundOwnerAttendee(round1Id, admin.user_id);
    roundRepository.updateAttendees(round1Id, [{
      name: ownerA.display_name,
      principal_id: ownerA.user_id,
      user_id: ownerA.email,
      opening: true,
      closing: true,
    }, { name: 'Đại diện NCC', opening: true, closing: false }], admin.user_id);
    round1Attendees = attendeeRows(db, round1Id);
    assert.equal(round1Attendees.filter((row) => row.principal_id === ownerA.user_id).length, 1, 'refresh/save must not duplicate the owner');
    assert.equal(round1Attendees.length, 2);

    db.prepare(`UPDATE evaluation_rounds
      SET status = 'Hoàn thành', completed_at = datetime('now'), locked_at = datetime('now')
      WHERE id = ?`).run(round1Id);
    const transfer = new WorkTransferService(db, authorizationService, auditEventService);
    transfer.offboard({
      fromUserId: ownerA.user_id,
      transferToUserId: ownerB.user_id,
      reason: 'Approved handover before the second evaluation round',
      createdByUserId: admin.user_id,
      idempotencyKey: 'round-owner-transfer-0001',
      requestId: 'request-round-owner-transfer-0001',
    });
    assert.equal(db.prepare('SELECT assigned_specialist_user_id FROM evaluation_tickets WHERE id = ?').pluck().get(ticketId), ownerB.user_id);
    assert.equal(attendeeRows(db, round1Id).find((row) => row.principal_id === ownerA.user_id)?.display_name, ownerA.display_name,
      'completed round 1 must retain A');

    db.prepare('UPDATE evaluation_tickets SET current_round_no = 2 WHERE id = ?').run(ticketId);
    const round2Id = Number(roundRepository.insert({
      ticket_id: ticketId,
      round_no: 2,
      source_round_id: round1Id,
      assessment_code: 'ROUND-OWNER-TICKET-R2',
      assessment_date: null,
      evaluator_id: ownerB.user_id,
      status: 'Đang xử lý',
    }).lastInsertRowid);
    const round2Attendees = attendeeRows(db, round2Id);
    assert.equal(round2Attendees.length, 1, 'manual round 1 attendees must not be copied');
    assert.equal(round2Attendees[0].principal_id, ownerB.user_id);
    assert.equal(round2Attendees[0].opening_meeting, 1);
    assert.equal(round2Attendees[0].closing_meeting, 1);
    assert.equal(attendeeRows(db, round1Id).length, 2, 'round 1 remains unchanged after round 2 creation');
  } finally {
    db.close();
    process.env.DB_PATH = previousDbPath;
    clearModules();
    removeDbFiles(dbPath);
  }
});

test('frontend keeps canonical attendee identity while retaining the existing attendance table', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /principal_id: String\(row && row\.principal_id/);
  assert.match(app, /principal_id: existingRows\[index\]\?\.principal_id/);
  assert.match(html, /<th>Tên\/Chức danh<\/th><th>Tham dự họp khai mạc<\/th><th>Tham dự họp bế mạc<\/th><th class="table-action-cell">Thao tác<\/th>/);
});
