const { WORKFLOW_STATUSES } = require('./workflowHistory');

const ROLES = {
  SPECIALIST: 'Chuyên viên',
  LEAD: 'Lead miền',
  TBP: 'TBP',
  GDK: 'GĐK',
  ADMIN: 'Admin',
  SUPPLIER: 'NCC',
};

const ROLE_VALUES = Object.values(ROLES);

function normalizeRole(value, fallback = ROLES.SPECIALIST) {
  const raw = String(value || '').trim();
  return ROLE_VALUES.includes(raw) ? raw : fallback;
}

function isAdminRole(role) {
  return normalizeRole(role) === ROLES.ADMIN;
}

function isInternalRole(role) {
  return normalizeRole(role) !== ROLES.SUPPLIER;
}

function canScore(role) {
  const r = normalizeRole(role);
  return r === ROLES.SPECIALIST || r === ROLES.ADMIN;
}

function canDeleteEvaluationTicket(role, status) {
  const r = normalizeRole(role);
  return (r === ROLES.SPECIALIST || r === ROLES.ADMIN) && status === WORKFLOW_STATUSES.DRAFT;
}

function canApproveLevel(role, level) {
  const r = normalizeRole(role);
  if (r === ROLES.ADMIN) return true;
  if (level === 'LEAD') return r === ROLES.LEAD;
  if (level === 'TBP') return r === ROLES.TBP;
  if (level === 'GDK') return r === ROLES.GDK;
  return false;
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  normalizeRole,
  isAdminRole,
  isInternalRole,
  canScore,
  canDeleteEvaluationTicket,
  canApproveLevel,
};
