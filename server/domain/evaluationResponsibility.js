'use strict';

function normalizeUserId(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalEvaluationOwner(row = {}) {
  return normalizeUserId(row.assigned_specialist_id) || normalizeUserId(row.created_by);
}

function isEvaluationResponsible(row, user) {
  const userId = normalizeUserId(typeof user === 'string' ? user : (user?.userId || user?.user_id || user?.email));
  return Boolean(userId) && canonicalEvaluationOwner(row) === userId;
}

function isEvaluationCreatedAndResponsible(row = {}, user) {
  const userId = normalizeUserId(typeof user === 'string' ? user : (user?.userId || user?.user_id || user?.email));
  const creatorId = normalizeUserId(row.created_by);
  const assignedId = normalizeUserId(row.assigned_specialist_id);
  return Boolean(userId) && creatorId === userId && (!assignedId || assignedId === userId);
}

function canonicalEvaluationOwnerSql(alias = 't') {
  return `COALESCE(NULLIF(TRIM(${alias}.assigned_specialist_id), ''), NULLIF(TRIM(${alias}.created_by), ''))`;
}

module.exports = {
  canonicalEvaluationOwner,
  canonicalEvaluationOwnerSql,
  isEvaluationCreatedAndResponsible,
  isEvaluationResponsible,
  normalizeUserId,
};
