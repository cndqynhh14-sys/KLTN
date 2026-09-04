'use strict';

function normalizeUserReference(value) {
  return String(value || '').trim();
}

function findUserByReference(db, reference) {
  const value = normalizeUserReference(reference);
  if (!value) return null;
  return db.prepare(`SELECT user_id, email, display_name, is_active
    FROM users
    WHERE user_id = @value OR email = @value COLLATE NOCASE
    LIMIT 1`).get({ value }) || null;
}

function resolveUserId(db, reference, { required = false } = {}) {
  const value = normalizeUserReference(reference);
  if (!value) {
    if (required) throw Object.assign(new Error('user_identity_required'), { code: 'user_identity_required' });
    return null;
  }
  const user = findUserByReference(db, value);
  if (user) return user.user_id;
  if (required) {
    throw Object.assign(new Error('user_identity_not_found'), {
      code: 'user_identity_not_found',
      reference: value,
    });
  }
  return null;
}

function resolveUserEmail(db, reference) {
  const value = normalizeUserReference(reference);
  if (!value) return '';
  return findUserByReference(db, value)?.email || value;
}

module.exports = { findUserByReference, normalizeUserReference, resolveUserEmail, resolveUserId };
