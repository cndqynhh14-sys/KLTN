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
  '../server/services/WorkTransferService',
];

function clearModules() {
  MODULES.forEach((modulePath) => { delete require.cache[require.resolve(modulePath)]; });
}

function removeDbFiles(dbPath) {
  [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function addUser(db, authorizationService, email, roleCode, { active = true, globalScope = true } = {}) {
  upsertCanonicalUser(db, {
    email,
    roleCode,
    isActive: active,
    displayName: `Synthetic ${email.split('@')[0]}`,
  });
  const user = db.prepare('SELECT user_id, email, display_name, is_active FROM users WHERE email = ?').get(email);
  if (active && globalScope) {
    authorizationService.assignScope({
      userId: user.user_id,
      roleCode,
      scopeType: 'GLOBAL',
      scopeValue: null,
      effect: 'ALLOW',
      actor: null,
    });
  }
  return user;
}

function insertTicket(db, owner, suffix, status = 'Đang xử lý') {
  const supplierId = Number(db.prepare(`INSERT INTO supplier_master
    (supplier_code, supplier_name, status, source_type)
    VALUES (?, ?, 'ACTIVE', 'MANUAL')`).run(`PHASE4-NCC-${suffix}`, `Phase 4 Supplier ${suffix}`).lastInsertRowid);
  const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get()
    || db.prepare('SELECT id FROM question_templates ORDER BY id LIMIT 1').get();
  const ticketId = Number(db.prepare(`INSERT INTO evaluation_tickets
    (ticket_code, supplier_id, supplier_code, supplier_name, region, mch2,
     evaluation_type, template_id, facility_type, supplier_scale, current_status,
     assigned_specialist_id, assigned_specialist_user_id, created_by, created_by_user_id)
    VALUES (?, ?, ?, ?, 'MB', 'Thực phẩm công nghệ', 'Định kỳ', ?, 'CHUNG', 'LARGE',
      ?, ?, ?, ?, ?)`).run(
    `PHASE4-EVAL-${suffix}`, supplierId, `PHASE4-NCC-${suffix}`, `Phase 4 Supplier ${suffix}`,
    template.id, status, owner.email, owner.user_id, owner.email, owner.user_id
  ).lastInsertRowid);
  return ticketId;
}

function insertParticipant(db, { ticketId = null, roundId = null, user, role }) {
  return Number(db.prepare(`INSERT INTO evaluation_participants
    (ticket_id, round_id, user_id, principal_id, display_name, participant_role,
     active, assigned_by, assigned_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
    ticketId, roundId, user.email, user.user_id, user.display_name, role, user.email, user.user_id
  ).lastInsertRowid);
}

test('Phase 4 transfers evaluation-only active work atomically, idempotently and keeps history immutable', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-phase4-${Date.now()}-${Math.random()}.db`);
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  clearModules();
  const { db, authorizationService, auditEventService } = require('../server/db');
  const { ROLE_CODES } = require('../server/authorization/permissionCatalog');
  const { WorkTransferService } = require('../server/services/WorkTransferService');
  const service = new WorkTransferService(db, authorizationService, auditEventService);

  try {
    const actor = addUser(db, authorizationService, 'phase4-actor@example.invalid', ROLE_CODES.SYS_ADMIN);
    const from = addUser(db, authorizationService, 'phase4-from@example.invalid', ROLE_CODES.QLCL_SPECIALIST);
    const recipient = addUser(db, authorizationService, 'phase4-recipient@example.invalid', ROLE_CODES.SYS_ADMIN);
    const noScope = addUser(db, authorizationService, 'phase4-no-scope@example.invalid', ROLE_CODES.SYS_ADMIN, { globalScope: false });
    const inactive = addUser(db, authorizationService, 'phase4-inactive@example.invalid', ROLE_CODES.SYS_ADMIN, { active: false });
    const ineligible = addUser(db, authorizationService, 'phase4-ineligible@example.invalid', ROLE_CODES.SUPPLIER_USER);

    const ticketId = insertTicket(db, from, 'ACTIVE');
    insertParticipant(db, { ticketId, user: from, role: 'OWNER' });
    insertParticipant(db, { ticketId, user: from, role: 'EVALUATOR' });
    const roundId = Number(db.prepare(`INSERT INTO evaluation_rounds
      (ticket_id, round_no, status) VALUES (?, 1, 'Đang xử lý')`).run(ticketId).lastInsertRowid);
    insertParticipant(db, { roundId, user: from, role: 'EVALUATOR' });
    const approvalId = Number(db.prepare(`INSERT INTO approval_tasks
      (ticket_id, approval_level, assigned_role, assigned_user_id, assigned_principal_id, status)
      VALUES (?, 'LEAD', 'Lead miền', ?, ?, 'PENDING')`).run(ticketId, from.email, from.user_id).lastInsertRowid);
    const stageId = Number(db.prepare(`INSERT INTO approval_stage_assignments
      (workflow_type, stage_code, assigned_user_id, assigned_principal_id,
       scope_type, active, created_by)
      VALUES ('EVALUATION', 'GDK', ?, ?, 'GLOBAL', 1, ?)`)
      .run(from.email, from.user_id, actor.email).lastInsertRowid);
    const historyId = Number(db.prepare(`INSERT INTO workflow_history
      (ticket_id, actor_user_id, actor_principal_id, actor_role, action, from_status, to_status)
      VALUES (?, ?, ?, 'Chuyên viên', 'PHASE4_HISTORY', 'Khởi tạo', 'Đang xử lý')`)
      .run(ticketId, from.email, from.user_id).lastInsertRowid);
    const completedTicketId = insertTicket(db, from, 'COMPLETED', 'Hoàn thành');
    insertParticipant(db, { ticketId: completedTicketId, user: from, role: 'OWNER' });
    const completedBefore = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(completedTicketId);
    const session = authorizationService.createSession(from.user_id, { ttlSeconds: 3600 });

    const workload = service.workload(from.user_id);
    assert.deepEqual(workload.summary, {
      total: 3,
      evaluation_tickets: 1,
      evaluation_approval_tasks: 1,
      approval_stage_assignments: 1,
    });
    assert.ok(workload.eligible_recipients.some((user) => user.user_id === recipient.user_id));
    assert.ok(!workload.eligible_recipients.some((user) => user.user_id === noScope.user_id));
    assert.ok(!workload.eligible_recipients.some((user) => user.user_id === ineligible.user_id));
    assert.throws(() => db.prepare('UPDATE users SET is_active = 0 WHERE user_id = ?').run(from.user_id), /work_transfer_required/);

    const common = {
      fromUserId: from.user_id,
      reason: 'Employee resigned after approved handover review',
      createdByUserId: actor.user_id,
    };
    assert.throws(() => service.offboard({ ...common, idempotencyKey: 'phase4-missing-recipient' }),
      (error) => error.code === 'work_transfer_required');
    assert.throws(() => service.offboard({ ...common, transferToUserId: inactive.user_id, idempotencyKey: 'phase4-inactive-recipient' }),
      (error) => error.code === 'transfer_recipient_inactive');
    assert.throws(() => service.offboard({ ...common, transferToUserId: ineligible.user_id, idempotencyKey: 'phase4-ineligible-recipient' }),
      (error) => error.code === 'transfer_recipient_ineligible');
    assert.throws(() => service.offboard({ ...common, transferToUserId: from.user_id, idempotencyKey: 'phase4-same-recipient' }),
      (error) => error.code === 'transfer_recipient_same_user');
    assert.throws(() => service.offboard({
      fromUserId: actor.user_id,
      reason: 'Attempt to disable the current administrative actor',
      createdByUserId: actor.user_id,
      idempotencyKey: 'phase4-self-deactivation',
    }), (error) => error.code === 'cannot_deactivate_self');

    const result = service.offboard({
      ...common,
      transferToUserId: recipient.user_id,
      idempotencyKey: 'phase4-transfer-request-0001',
      requestId: 'request-phase4-transfer-0001',
      correlationId: 'correlation-phase4-transfer-0001',
    });
    assert.equal(result.transferred_count, 3);
    assert.equal(result.user.active, false);
    assert.equal(db.prepare('SELECT assigned_specialist_user_id FROM evaluation_tickets WHERE id = ?').get(ticketId).assigned_specialist_user_id,
      recipient.user_id);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants p
      LEFT JOIN evaluation_rounds er ON er.id = p.round_id
      WHERE p.active = 1 AND p.principal_id = ?
        AND (p.ticket_id = ? OR (er.ticket_id = ? AND er.completed_at IS NULL))
        AND p.participant_role IN ('OWNER', 'EVALUATOR')`).pluck().get(recipient.user_id, ticketId, ticketId), 3);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants p
      LEFT JOIN evaluation_rounds er ON er.id = p.round_id
      WHERE p.active = 1 AND p.principal_id = ?
        AND (p.ticket_id = ? OR (er.ticket_id = ? AND er.completed_at IS NULL))
        AND p.participant_role IN ('OWNER', 'EVALUATOR')`).pluck().get(from.user_id, ticketId, ticketId), 0);
    assert.equal(db.prepare('SELECT assigned_principal_id FROM approval_tasks WHERE id = ?').get(approvalId).assigned_principal_id,
      recipient.user_id);
    assert.equal(db.prepare('SELECT assigned_principal_id FROM approval_stage_assignments WHERE id = ?').get(stageId).assigned_principal_id,
      recipient.user_id);
    assert.equal(db.prepare('SELECT actor_principal_id FROM workflow_history WHERE id = ?').get(historyId).actor_principal_id,
      from.user_id);
    const completedAfter = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(completedTicketId);
    assert.equal(completedAfter.assigned_specialist_user_id, completedBefore.assigned_specialist_user_id);
    assert.equal(service.workload(from.user_id).summary.total, 0);

    const storedSession = db.prepare('SELECT revoked_at, revoke_reason FROM auth_sessions WHERE session_id = ?').get(session.sessionId);
    assert.ok(storedSession.revoked_at);
    assert.equal(storedSession.revoke_reason, 'ACCOUNT_STATUS_CHANGED');
    const ledger = db.prepare('SELECT * FROM work_transfers WHERE transfer_id = ?').get(result.transfer.transfer_id);
    assert.equal(ledger.status, 'COMPLETED');
    assert.equal(JSON.parse(ledger.workload_before_json).total, 3);
    assert.equal(JSON.parse(ledger.workload_after_json).total, 0);
    const ledgerItems = db.prepare('SELECT * FROM work_transfer_items WHERE transfer_id = ? ORDER BY id').all(ledger.transfer_id);
    assert.deepEqual(ledgerItems.map((item) => item.entity_type), [
      'EVALUATION_TICKET', 'EVALUATION_APPROVAL_TASK', 'APPROVAL_STAGE_ASSIGNMENT',
    ]);
    assert.ok(ledgerItems.every((item) => JSON.parse(item.before_json) && JSON.parse(item.after_json)));
    assert.throws(() => db.prepare('DELETE FROM work_transfers WHERE transfer_id = ?').run(ledger.transfer_id), /work_transfer_immutable/);
    assert.throws(() => db.prepare('UPDATE work_transfer_items SET entity_id = entity_id WHERE id = ?').run(ledgerItems[0].id),
      /work_transfer_item_immutable/);
    const audit = db.prepare("SELECT metadata_json FROM audit_events WHERE event_name='work.transfer.completed' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(audit.metadata_json).transfer_id, ledger.transfer_id);

    const replay = service.offboard({
      ...common,
      transferToUserId: recipient.email,
      idempotencyKey: 'phase4-transfer-request-0001',
      requestId: 'request-phase4-transfer-0001',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.transfer.transfer_id, result.transfer.transfer_id);
    assert.equal(db.prepare('SELECT COUNT(*) FROM work_transfers WHERE from_user_id = ?').pluck().get(from.user_id), 1);
    assert.throws(() => service.offboard({
      ...common,
      transferToUserId: recipient.user_id,
      reason: 'A different reason must conflict with the same request key',
      idempotencyKey: 'phase4-transfer-request-0001',
    }), (error) => error.code === 'idempotency_key_conflict');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
    clearModules();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    removeDbFiles(dbPath);
  }
});

test('Phase 4 rolls every transfer mutation back when deactivation fails', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-phase4-rollback-${Date.now()}-${Math.random()}.db`);
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = dbPath;
  clearModules();
  const { db, authorizationService, auditEventService } = require('../server/db');
  const { ROLE_CODES } = require('../server/authorization/permissionCatalog');
  const { WorkTransferService } = require('../server/services/WorkTransferService');
  const service = new WorkTransferService(db, authorizationService, auditEventService);
  try {
    const actor = addUser(db, authorizationService, 'phase4-rb-actor@example.invalid', ROLE_CODES.SYS_ADMIN);
    const from = addUser(db, authorizationService, 'phase4-rb-from@example.invalid', ROLE_CODES.QLCL_SPECIALIST);
    const recipient = addUser(db, authorizationService, 'phase4-rb-recipient@example.invalid', ROLE_CODES.SYS_ADMIN);
    const ticketId = insertTicket(db, from, 'ROLLBACK');
    insertParticipant(db, { ticketId, user: from, role: 'OWNER' });
    db.exec(`CREATE TRIGGER phase4_forced_failure BEFORE UPDATE OF is_active ON users
      WHEN OLD.user_id = '${from.user_id}' AND NEW.is_active = 0
      BEGIN SELECT RAISE(ABORT, 'phase4_forced_failure'); END`);

    assert.throws(() => service.offboard({
      fromUserId: from.user_id,
      transferToUserId: recipient.user_id,
      reason: 'Force a transaction rollback after all transfer writes',
      createdByUserId: actor.user_id,
      idempotencyKey: 'phase4-rollback-request-0001',
    }), /phase4_forced_failure/);
    assert.equal(db.prepare('SELECT is_active FROM users WHERE user_id = ?').pluck().get(from.user_id), 1);
    assert.equal(db.prepare('SELECT assigned_specialist_user_id FROM evaluation_tickets WHERE id = ?').pluck().get(ticketId), from.user_id);
    assert.equal(db.prepare(`SELECT principal_id FROM evaluation_participants
      WHERE ticket_id = ? AND participant_role = 'OWNER' AND active = 1`).pluck().get(ticketId), from.user_id);
    assert.equal(db.prepare("SELECT COUNT(*) FROM work_transfers WHERE idempotency_key='phase4-rollback-request-0001'").pluck().get(), 0);
  } finally {
    db.close();
    clearModules();
    if (previousDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = previousDbPath;
    removeDbFiles(dbPath);
  }
});

test('Phase 4 frontend exposes the workload modal without legacy module labels', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'server', 'routes', 'admin.js'), 'utf8');
  assert.match(html, /id="user-offboard-modal"/);
  assert.match(html, /id="user-offboard-recipient"/);
  assert.match(app, /evaluation_approval_tasks/);
  assert.match(app, /approval_stage_assignments/);
  assert.doesNotMatch(app.slice(app.indexOf('async function deactivateUser'), app.indexOf('async function reactivateUser')), /input_dossiers/);
  assert.match(route, /users\/:userId\/workload/);
  assert.match(route, /users\/:userId\/offboard/);
});
