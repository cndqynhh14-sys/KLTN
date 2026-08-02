'use strict';

const {
  LEGACY_ROLE_TO_CODE,
  ROLE_CODES,
} = require('../../server/authorization/permissionCatalog');

function canonicalTokenFactory(dbModule, authModule) {
  return (payload, ttlSeconds) => {
    const email = String(payload?.sub || payload?.email || '').trim().toLowerCase();
    const fixture = dbModule.db.prepare('SELECT role, is_admin FROM users WHERE email=?').get(email);
    if (!fixture) throw new Error('synthetic_user_required_before_token');
    const roleCode = payload?.isAdmin || fixture.is_admin
      ? ROLE_CODES.SYS_ADMIN
      : (LEGACY_ROLE_TO_CODE[payload?.role || fixture.role] || ROLE_CODES.QLCL_SPECIALIST);
    dbModule.authorizationService.setPrimaryRole({
      userId: email,
      roleCode,
      actor: null,
      source: 'MANUAL',
    });
    return authModule.signToken(payload, ttlSeconds);
  };
}

module.exports = { canonicalTokenFactory };
