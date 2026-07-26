const { ROLES, normalizeRole } = require('./roles');

const APPROVAL_LEVEL_BY_ROLE = Object.freeze({
  [ROLES.LEAD]: 'LEAD',
  [ROLES.TBP]: 'TBP',
  [ROLES.GDK]: 'GDK',
});

function approvalLevelForRole(role) {
  return APPROVAL_LEVEL_BY_ROLE[normalizeRole(role, '')] || null;
}

function isApprovalQueueRole(role) {
  return !!approvalLevelForRole(role);
}

module.exports = {
  approvalLevelForRole,
  isApprovalQueueRole,
};
