'use strict';

const {
  LEGACY_ROLE_TO_CODE,
  ROLE_CODES,
} = require('../../server/authorization/permissionCatalog');

function canonicalTokenFactory(dbModule, authModule) {
  return (payload, ttlSeconds) => {
    const email = String(payload?.sub || payload?.email || '').trim().toLowerCase();
    const fixture = dbModule.db.prepare('SELECT user_id, email FROM users WHERE email=?').get(email);
    if (!fixture) throw new Error('synthetic_user_required_before_token');
    const roleCode = payload?.isAdmin === true
      ? ROLE_CODES.SYS_ADMIN
      : (payload?.roleCode || LEGACY_ROLE_TO_CODE[payload?.role] || null);
    if (roleCode) {
      dbModule.authorizationService.setPrimaryRole({
        userId: fixture.user_id,
        roleCode,
        actor: null,
        source: 'MANUAL',
      });
    }
    return authModule.signToken(payload, ttlSeconds);
  };
}

module.exports = { canonicalTokenFactory };
