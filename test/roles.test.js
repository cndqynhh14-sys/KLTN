const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES,
  normalizeRole,
  canApproveLevel,
  canDeleteEvaluationTicket,
  canScore,
  isInternalRole,
} = require('../server/domain/roles');

test('normalizeRole keeps BRD roles and falls back safely', () => {
  assert.equal(normalizeRole('Admin'), ROLES.ADMIN);
  assert.equal(normalizeRole('Lead miền'), ROLES.LEAD);
  assert.equal(normalizeRole('unknown'), ROLES.SPECIALIST);
});

test('role helpers enforce workflow permissions', () => {
  assert.equal(canScore(ROLES.SPECIALIST), true);
  assert.equal(canScore(ROLES.LEAD), false);
  assert.equal(canScore(ROLES.ADMIN), true);
  assert.equal(canApproveLevel(ROLES.LEAD, 'LEAD'), true);
  assert.equal(canApproveLevel(ROLES.TBP, 'LEAD'), false);
  assert.equal(canApproveLevel(ROLES.ADMIN, 'GDK'), true);
  assert.equal(isInternalRole(ROLES.SUPPLIER), false);
});

test('ticket delete permission follows BRD draft-only rule', () => {
  assert.equal(canDeleteEvaluationTicket(ROLES.SPECIALIST, 'Khởi tạo'), true);
  assert.equal(canDeleteEvaluationTicket(ROLES.ADMIN, 'Khởi tạo'), true);
  assert.equal(canDeleteEvaluationTicket(ROLES.SPECIALIST, 'Đang xử lý'), false);
  assert.equal(canDeleteEvaluationTicket(ROLES.LEAD, 'Khởi tạo'), false);
});
