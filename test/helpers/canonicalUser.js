'use strict';

const crypto = require('node:crypto');

const {
  LEGACY_ROLE_TO_CODE,
  ROLE_CODES,
} = require('../../server/authorization/permissionCatalog');

function roleCodeFor({ roleCode, role, isAdmin = false }) {
  if (roleCode) return roleCode;
  if (isAdmin) return ROLE_CODES.SYS_ADMIN;
  return LEGACY_ROLE_TO_CODE[role] || ROLE_CODES.QLCL_SPECIALIST;
}

function upsertCanonicalUser(db, {
  email,
  roleCode,
  role,
  isAdmin = false,
  isActive = true,
  displayName = null,
  createdAt = null,
  createdBy = null,
  source = 'MANUAL',
} = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('canonical_user_email_required');
  const existing = db.prepare('SELECT user_id FROM users WHERE email=? COLLATE NOCASE').get(normalizedEmail);
  const userId = existing?.user_id || crypto.randomUUID();
  const canonicalCreatedBy = createdBy
    ? db.prepare('SELECT user_id FROM users WHERE user_id=? OR email=? COLLATE NOCASE').get(createdBy, String(createdBy).trim())?.user_id || null
    : null;
  db.prepare(`INSERT INTO users
    (user_id, email, is_active, display_name, created_at, created_by)
    VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
    ON CONFLICT(email) DO UPDATE SET
      is_active=excluded.is_active,
      display_name=COALESCE(excluded.display_name, users.display_name)`)
    .run(userId, normalizedEmail, isActive ? 1 : 0, displayName, createdAt, canonicalCreatedBy);

  const canonicalRoleCode = roleCodeFor({ roleCode, role, isAdmin });
  const roleRow = db.prepare('SELECT id FROM roles WHERE role_code=?').get(canonicalRoleCode);
  if (!roleRow) throw new Error(`canonical_role_missing:${canonicalRoleCode}`);
  db.prepare(`INSERT INTO user_roles (user_id, role_id, active, source, created_by)
    VALUES (?, ?, 1, ?, NULL)
    ON CONFLICT(user_id, role_id) DO UPDATE SET active=1, source=excluded.source`)
    .run(userId, roleRow.id, source);
  return { user_id: userId, userId, email: normalizedEmail, roleCode: canonicalRoleCode };
}

module.exports = { roleCodeFor, upsertCanonicalUser };
