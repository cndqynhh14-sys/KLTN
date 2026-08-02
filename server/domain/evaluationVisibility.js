const { ROLE_CODES } = require('../authorization/permissionCatalog');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isSpecialistUser(user) {
  return !!user && user.roleCodes?.includes(ROLE_CODES.QLCL_SPECIALIST);
}

function ownsEvaluationTicket(user, ticket) {
  return normalizeEmail(ticket?.created_by) === normalizeEmail(user?.email);
}

function canAccessEvaluationTicket(user, ticket) {
  if (!ticket) return false;
  if (!isSpecialistUser(user)) return true;
  return ownsEvaluationTicket(user, ticket);
}

module.exports = {
  canAccessEvaluationTicket,
  isSpecialistUser,
  normalizeEmail,
  ownsEvaluationTicket,
};
