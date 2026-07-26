'use strict';

const crypto = require('crypto');
const {
  ROLE_CODES,
  LEGACY_ROLE_TO_CODE,
  ROLE_CODE_TO_LEGACY,
  LEGACY_PRIMARY_ROLE_PRIORITY,
  SCOPE_TYPES,
  isActivePermission,
} = require('../authorization/permissionCatalog');

class AuthorizationError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = 'AuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function sqliteTime(value) {
  return new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z` : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isStableMch2Id(value) {
  const text = String(value || '').trim();
  return /^\d+$/.test(text) || /^MCH2_[A-Z0-9_-]+$/.test(text);
}

function isCanonicalMch2Id(value) {
  return /^\d+$/.test(String(value || '').trim());
}

class AuthorizationService {
  constructor(db, options = {}) {
    this.db = db;
    this.clock = options.clock || (() => new Date());
    this.cache = new Map();
    this.customScopeValidators = new Map();
    this.auditEventService = options.auditEventService || null;
  }

  setAuditEventService(auditEventService) {
    this.auditEventService = auditEventService;
  }

  registerCustomScopeValidator(schemaCode, version, validator) {
    if (typeof validator !== 'function') throw new TypeError('custom_scope_validator_required');
    this.customScopeValidators.set(`${schemaCode}:${Number(version)}`, validator);
  }

  _now() {
    return sqliteTime(this.clock());
  }

  _user(email, activeOnly = true) {
    return this.db.prepare(`SELECT email, is_admin, role, is_active, display_name, authz_version
      FROM users WHERE email = ? ${activeOnly ? 'AND is_active = 1' : ''}`).get(normalizeEmail(email));
  }

  _audit({ actor, target, changeType, objectType, objectKey, before, after, requestId, correlationId }) {
    this.db.prepare(`INSERT INTO authz_change_log
      (actor_user_id, target_user_id, change_type, object_type, object_key,
       before_json, after_json, request_id, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actor || null, target || null, changeType, objectType, objectKey,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      requestId || null, correlationId || null
    );
    if (this.auditEventService) {
      const eventName = changeType === 'SCOPE_ASSIGNED'
        ? 'authz.scope.assigned'
        : (changeType === 'LEGACY_COMPAT_SYNC' ? 'authz.compatibility.synced' : 'role.assignment.changed');
      this.auditEventService.record({
        eventName,
        actorUserId: actor || null,
        entityType: objectType,
        entityId: target || objectKey,
        action: changeType,
        outcome: 'SUCCESS',
        summary: `${changeType} ${objectType}`,
        requestId,
        correlationId,
        metadata: eventName === 'authz.scope.assigned'
          ? { scope_type: after?.scope_type, scope_value: after?.scope_value, effect: after?.effect }
          : { role_code: after?.role_code || before?.role_code || objectKey, change_type: changeType },
      });
    }
  }

  syncLegacyUser(email, options = {}) {
    const user = this._user(email, false);
    if (!user) throw new AuthorizationError('user_not_found', 404);
    const roleCode = user.is_admin ? ROLE_CODES.SYS_ADMIN
      : (LEGACY_ROLE_TO_CODE[user.role] || ROLE_CODES.QLCL_SPECIALIST);
    const role = this.db.prepare('SELECT id, role_code FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
    if (!role) throw new AuthorizationError('compatibility_role_not_found', 500);

    let changed = false;
    const apply = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT ur.id, r.role_code FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND ur.source = 'LEGACY_COMPAT' AND ur.active = 1`).all(user.email);
      for (const row of existing) {
        if (row.role_code !== roleCode) {
          this.db.prepare('UPDATE user_roles SET active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(row.id);
          changed = true;
        }
      }
      const desired = this.db.prepare('SELECT id, active FROM user_roles WHERE user_id = ? AND role_id = ?').get(user.email, role.id);
      if (!desired) {
        this.db.prepare(`INSERT INTO user_roles (user_id, role_id, source, created_by)
          VALUES (?, ?, 'LEGACY_COMPAT', ?)`).run(user.email, role.id, options.actor || null);
        changed = true;
      } else if (!desired.active) {
        this.db.prepare(`UPDATE user_roles SET active = 1, source = 'LEGACY_COMPAT',
          updated_at = datetime('now') WHERE id = ?`).run(desired.id);
        changed = true;
      }
      const desiredScopes = roleCode === ROLE_CODES.SUPPLIER_USER
        ? [['SUPPLIER', user.email]]
        : roleCode === ROLE_CODES.QLCL_SPECIALIST
          ? [['OWN', 'SELF'], ['ASSIGNED', 'SELF']]
          : [['GLOBAL', null]];
      const desiredKeys = new Set(desiredScopes.map(([type, value]) => `${type}:${value || ''}`));
      const compatibilityScopes = this.db.prepare(`SELECT id, scope_type, scope_value FROM user_scope_assignments
        WHERE user_id = ? AND role_id = ? AND source = 'LEGACY_COMPAT' AND active = 1`).all(user.email, role.id);
      for (const scope of compatibilityScopes) {
        if (!desiredKeys.has(`${scope.scope_type}:${scope.scope_value || ''}`)) {
          this.db.prepare('UPDATE user_scope_assignments SET active = 0 WHERE id = ?').run(scope.id);
          changed = true;
        }
      }
      for (const [scopeType, scopeValue] of desiredScopes) {
        const scopeInfo = this.db.prepare(`INSERT INTO user_scope_assignments
            (user_id, role_id, scope_type, scope_value, effect, source, created_by)
            VALUES (?, ?, ?, ?, 'ALLOW', 'LEGACY_COMPAT', ?)
            ON CONFLICT DO NOTHING`).run(user.email, role.id, scopeType, scopeValue, options.actor || null);
        changed = changed || scopeInfo.changes > 0;
      }
      if (changed) {
        this._audit({
          actor: options.actor, target: user.email, changeType: 'LEGACY_COMPAT_SYNC',
          objectType: 'USER_ROLE', objectKey: roleCode, after: { role_code: roleCode },
          requestId: options.requestId, correlationId: options.correlationId,
        });
      }
    });
    apply();
    this.cache.delete(user.email);
    return this.identityForLegacyRoutes(user.email);
  }

  syncLegacyUsers(options = {}) {
    const users = this.db.prepare('SELECT email FROM users ORDER BY email').all();
    return users.map(({ email }) => this.syncLegacyUser(email, options));
  }

  syncMissingLegacyUsers(options = {}) {
    const users = this.db.prepare(`SELECT u.email FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.email AND ur.active = 1)
      ORDER BY u.email`).all();
    return users.map(({ email }) => this.syncLegacyUser(email, options));
  }

  _permissionValue(rows, { userId, authzVersion }) {
    const activeRows = rows.filter((row) => isActivePermission(row.permission_code));
    const denied = new Set(activeRows.filter((row) => row.effect === 'DENY').map((row) => row.permission_code));
    const allowed = new Set(activeRows.filter((row) => row.effect === 'ALLOW').map((row) => row.permission_code));
    for (const code of denied) allowed.delete(code);
    const effectByPermission = new Map();
    activeRows.forEach((row) => {
      const effects = effectByPermission.get(row.permission_code) || new Set();
      effects.add(row.effect);
      effectByPermission.set(row.permission_code, effects);
    });
    return Object.freeze({
      userId,
      authzVersion,
      roleCodes: Object.freeze([...new Set(rows.map((row) => row.role_code))].sort()),
      permissions: Object.freeze([...allowed].sort()),
      deniedPermissions: Object.freeze([...denied].sort()),
      sources: Object.freeze(activeRows.map((row) => Object.freeze({
        roleCode: row.role_code,
        permissionCode: row.permission_code,
        effect: row.effect,
      }))),
      conflicts: Object.freeze([...effectByPermission.entries()]
        .filter(([, effects]) => effects.has('ALLOW') && effects.has('DENY'))
        .map(([permissionCode]) => Object.freeze({ permissionCode, resolution: 'DENY_WINS' }))),
    });
  }

  effectivePermissionsForRoleAssignments(assignments, options = {}) {
    const now = timestampMs(options.now || this.clock());
    const activeAssignments = (Array.isArray(assignments) ? assignments : []).filter((item) => (
      item && item.active !== false
      && (!item.validFrom || timestampMs(item.validFrom) <= now)
      && (!item.validUntil || timestampMs(item.validUntil) > now)
    ));
    const byRole = new Map(activeAssignments.map((item) => [String(item.roleCode || '').trim().toUpperCase(), item]));
    const roleCodes = [...byRole.keys()].filter(Boolean).sort();
    if (!roleCodes.length) {
      return this._permissionValue([], {
        userId: options.userId || null,
        authzVersion: Number(options.authzVersion || 1),
      });
    }
    const placeholders = roleCodes.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT r.role_code, p.permission_code, rp.effect
      FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.permission_code = rp.permission_code AND p.active = 1
      WHERE r.active = 1 AND r.role_code IN (${placeholders})
      ORDER BY p.permission_code, rp.effect, r.role_code`).all(...roleCodes).map((row) => ({
      ...row,
      valid_until: byRole.get(row.role_code)?.validUntil || null,
    }));
    return this._permissionValue(rows, {
      userId: options.userId || null,
      authzVersion: Number(options.authzVersion || 1),
    });
  }

  effectivePermissions(email) {
    const user = this._user(email);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const key = user.email;
    const cached = this.cache.get(key);
    if (cached && cached.authzVersion === user.authz_version && cached.expiresAt > this.clock().getTime()) {
      return cached.value;
    }
    const now = this._now();
    const rows = this.db.prepare(`SELECT r.role_code, ur.valid_until, p.permission_code, rp.effect
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id AND r.active = 1
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.permission_code = rp.permission_code AND p.active = 1
      WHERE ur.user_id = ? AND ur.active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
        AND (ur.valid_until IS NULL OR ur.valid_until > ?)`
    ).all(user.email, now, now);
    const nearestExpiry = rows.map((row) => row.valid_until && Date.parse(`${row.valid_until.replace(' ', 'T')}Z`))
      .filter(Number.isFinite).reduce((min, value) => Math.min(min, value), Infinity);
    const value = this._permissionValue(rows, { userId: user.email, authzVersion: user.authz_version });
    this.cache.set(key, {
      authzVersion: user.authz_version,
      expiresAt: Math.min(nearestExpiry, this.clock().getTime() + 30_000),
      value,
    });
    return value;
  }

  can(email, permissionCode) {
    return this.effectivePermissions(email).permissions.includes(String(permissionCode));
  }

  requirePermission(permissionCode, contextFactory) {
    return (req, res, next) => {
      try {
        if (!req.user || !this.can(req.user.email, permissionCode)) {
          return res.status(403).json({ error: 'forbidden', code: 'AUTHZ_PERMISSION_REQUIRED', request_id: req.requestId });
        }
        if (contextFactory) {
          const context = contextFactory(req);
          if (!this.isInScope(req.user.email, context)) {
            return res.status(403).json({ error: 'forbidden', code: 'AUTHZ_SCOPE_REQUIRED', request_id: req.requestId });
          }
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  _activeScopes(email) {
    const now = this._now();
    return this.db.prepare(`SELECT usa.*, r.role_code
      FROM user_scope_assignments usa
      LEFT JOIN roles r ON r.id = usa.role_id
      WHERE usa.user_id = ? AND usa.active = 1
        AND (usa.valid_from IS NULL OR usa.valid_from <= ?)
        AND (usa.valid_until IS NULL OR usa.valid_until > ?)
        AND (usa.role_id IS NULL OR EXISTS (
          SELECT 1 FROM user_roles ur WHERE ur.user_id = usa.user_id AND ur.role_id = usa.role_id
          AND ur.active = 1 AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
          AND (ur.valid_until IS NULL OR ur.valid_until > ?)))`).all(normalizeEmail(email), now, now, now, now);
  }

  _scopeMatches(scope, context, email) {
    if (scope.scope_type === 'GLOBAL') return true;
    if (scope.scope_type === 'REGION') return String(context.regionId || context.region || '') === scope.scope_value;
    if (scope.scope_type === 'MCH2') {
      return isStableMch2Id(scope.scope_value)
        && String(context.mch2Id || context.mch2_id || '') === scope.scope_value;
    }
    if (scope.scope_type === 'ASSIGNED') {
      return normalizeEmail(context.assignedUserId || context.assigned_user_id) === email;
    }
    if (scope.scope_type === 'OWN') {
      return normalizeEmail(context.ownerId || context.created_by || context.userId) === email;
    }
    if (scope.scope_type === 'SUPPLIER') {
      return String(context.supplierId || context.supplier_id || context.supplierCode || '') === scope.scope_value;
    }
    if (scope.scope_type === 'CUSTOM') {
      const key = `${scope.custom_schema_code}:${scope.custom_schema_version}`;
      const schema = this.db.prepare(`SELECT 1 FROM custom_scope_schemas
        WHERE schema_code = ? AND version = ? AND active = 1`).get(scope.custom_schema_code, scope.custom_schema_version);
      const validator = this.customScopeValidators.get(key);
      return !!schema && !!validator && validator(scope.scope_value, context) === true;
    }
    return false;
  }

  _scopesForDecision(email, options = {}) {
    const excludedGlobalRoleCodes = new Set(options.excludeGlobalRoleCodes || []);
    return this._activeScopes(email).filter((scope) => !(
      scope.scope_type === 'GLOBAL' &&
      scope.role_code &&
      excludedGlobalRoleCodes.has(scope.role_code)
    ));
  }

  isInScope(email, context = {}, options = {}) {
    const userId = normalizeEmail(email);
    const scopes = this._scopesForDecision(userId, options);
    const denied = scopes.some((scope) => scope.effect === 'DENY' && this._scopeMatches(scope, context, userId));
    if (denied) return false;
    return scopes.some((scope) => scope.effect === 'ALLOW' && this._scopeMatches(scope, context, userId));
  }

  hasGlobalScope(email) {
    const scopes = this._activeScopes(normalizeEmail(email));
    if (scopes.some((scope) => scope.effect === 'DENY' && scope.scope_type === 'GLOBAL')) return false;
    return scopes.some((scope) => scope.effect === 'ALLOW' && scope.scope_type === 'GLOBAL');
  }

  applyScope(email, records, contextFactory = (row) => row, options = {}) {
    if (!Array.isArray(records)) throw new TypeError('records_array_required');
    return records.filter((row) => this.isInScope(email, contextFactory(row), options));
  }

  buildSqlScope(email, options = {}) {
    const alias = options.alias || 't';
    const fields = {
      owner: 'created_by', assigned: 'assigned_specialist_id', region: 'region',
      mch2: 'mch2_id', supplier: 'supplier_code', ...(options.fields || {}),
    };
    const fieldExpressions = options.fieldExpressions || {};
    const fieldSql = (fieldName) => fieldExpressions[fieldName] || `${alias}.${fields[fieldName]}`;
    const scopes = this._activeScopes(email);
    const params = { scope_user_id: normalizeEmail(email) };
    const clauseFor = (scope, index) => {
      if (scope.scope_type === 'GLOBAL') return '1 = 1';
      if (scope.scope_type === 'OWN') return `LOWER(COALESCE(${fieldSql('owner')}, '')) = LOWER(@scope_user_id)`;
      if (scope.scope_type === 'ASSIGNED') return `LOWER(COALESCE(${fieldSql('assigned')}, '')) = LOWER(@scope_user_id)`;
      const fieldName = scope.scope_type === 'REGION' ? 'region'
        : scope.scope_type === 'MCH2' ? 'mch2'
          : scope.scope_type === 'SUPPLIER' ? 'supplier' : null;
      if (!fieldName || (!fields[fieldName] && !fieldExpressions[fieldName])) return null;
      const key = `scope_value_${index}`;
      params[key] = scope.scope_value;
      // SQL three-valued logic must match _scopeMatches(): an unmapped/NULL
      // resource value is a non-match, including inside a DENY predicate.
      return `COALESCE(${fieldSql(fieldName)} = @${key}, 0)`;
    };
    const allow = [];
    const deny = [];
    scopes.forEach((scope, index) => {
      const clause = clauseFor(scope, index);
      if (!clause) return;
      (scope.effect === 'DENY' ? deny : allow).push(clause);
    });
    const allowSql = allow.length ? `(${allow.join(' OR ')})` : '0 = 1';
    const denySql = deny.length ? ` AND NOT (${deny.join(' OR ')})` : '';
    return { where: `${allowSql}${denySql}`, params };
  }

  assignRole({ userId, roleCode, actor, validFrom, validUntil, source = 'MANUAL', requestId, correlationId }) {
    const email = normalizeEmail(userId);
    const role = this.db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
    if (!this._user(email, false)) throw new AuthorizationError('user_not_found', 404);
    if (!role) throw new AuthorizationError('role_not_found', 404);
    this.db.prepare(`INSERT INTO user_roles
      (user_id, role_id, active, valid_from, valid_until, source, created_by)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(user_id, role_id) DO UPDATE SET active = 1, valid_from = excluded.valid_from,
        valid_until = excluded.valid_until, updated_at = datetime('now')`).run(
      email, role.id, validFrom || null, validUntil || null, source, actor || null
    );
    this._audit({ actor, target: email, changeType: 'ROLE_ASSIGNED', objectType: 'USER_ROLE',
      objectKey: roleCode, after: { role_code: roleCode, valid_from: validFrom || null, valid_until: validUntil || null },
      requestId, correlationId });
    this.cache.delete(email);
  }

  revokeRole({ userId, roleCode, actor, requestId, correlationId }) {
    const email = normalizeEmail(userId);
    const info = this.db.prepare(`UPDATE user_roles SET active = 0, updated_at = datetime('now')
      WHERE user_id = ? AND active = 1 AND role_id = (SELECT id FROM roles WHERE role_code = ?)`).run(email, roleCode);
    if (info.changes) this._audit({ actor, target: email, changeType: 'ROLE_REVOKED', objectType: 'USER_ROLE',
      objectKey: roleCode, before: { role_code: roleCode, active: true }, requestId, correlationId });
    this.cache.delete(email);
    return info.changes;
  }

  assignScope({ userId, roleCode, scopeType, scopeValue, effect = 'ALLOW', actor,
    validFrom, validUntil, customSchemaCode, customSchemaVersion, requestId, correlationId }) {
    const email = normalizeEmail(userId);
    if (!SCOPE_TYPES.includes(scopeType)) throw new AuthorizationError('invalid_scope_type', 400);
    if (scopeType === 'MCH2' && !isCanonicalMch2Id(scopeValue)) throw new AuthorizationError('invalid_mch2_id', 400);
    const role = roleCode ? this.db.prepare('SELECT id FROM roles WHERE role_code = ?').get(roleCode) : null;
    if (roleCode && !role) throw new AuthorizationError('role_not_found', 404);
    if (scopeType === 'CUSTOM') {
      const schema = this.db.prepare(`SELECT 1 FROM custom_scope_schemas
        WHERE schema_code = ? AND version = ? AND active = 1`).get(customSchemaCode, customSchemaVersion);
      if (!schema) throw new AuthorizationError('custom_scope_schema_not_found', 400);
    }
    this.db.prepare(`INSERT INTO user_scope_assignments
      (user_id, role_id, scope_type, scope_value, effect, valid_from, valid_until,
       custom_schema_code, custom_schema_version, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?)
      ON CONFLICT DO NOTHING`).run(email, role?.id || null, scopeType, scopeValue ?? null, effect,
      validFrom || null, validUntil || null, customSchemaCode || null, customSchemaVersion || null, actor || null);
    this._audit({ actor, target: email, changeType: 'SCOPE_ASSIGNED', objectType: 'USER_SCOPE',
      objectKey: `${scopeType}:${scopeValue || 'GLOBAL'}`, after: { role_code: roleCode || null, scope_type: scopeType, scope_value: scopeValue ?? null, effect },
      requestId, correlationId });
    this.cache.delete(email);
  }

  identityForLegacyRoutes(email) {
    const user = this._user(email);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const authz = this.effectivePermissions(user.email);
    const roleLabels = this.db.prepare(`SELECT r.role_code, r.display_label
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.active = 1 AND r.active = 1
      ORDER BY r.role_code`).all(user.email);
    const primaryCode = LEGACY_PRIMARY_ROLE_PRIORITY.find((code) => authz.roleCodes.includes(code)) || ROLE_CODES.QLCL_SPECIALIST;
    return {
      email: user.email,
      isAdmin: authz.roleCodes.includes(ROLE_CODES.SYS_ADMIN),
      role: ROLE_CODE_TO_LEGACY[primaryCode] || ROLE_CODE_TO_LEGACY[ROLE_CODES.QLCL_SPECIALIST],
      displayName: user.display_name || null,
      authzVersion: user.authz_version,
      roleCodes: authz.roleCodes,
      roleLabels,
      capabilities: authz.permissions,
    };
  }

  createSession(email, options = {}) {
    const identity = this.identityForLegacyRoutes(email);
    const ttlSeconds = Number(options.ttlSeconds || 28_800);
    const issued = this.clock();
    const expires = new Date(issued.getTime() + ttlSeconds * 1000);
    const sessionId = crypto.randomUUID();
    this.db.prepare(`INSERT INTO auth_sessions
      (session_id, user_id, authz_version, issued_at, expires_at, created_ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sessionId, identity.email, identity.authzVersion,
      sqliteTime(issued), sqliteTime(expires), options.ip || null, options.userAgent || null);
    return { sessionId, authzVersion: identity.authzVersion, expiresAt: expires, identity };
  }

  resolveSession(sessionId, expectedUserId, expectedAuthzVersion) {
    const now = this._now();
    const row = this.db.prepare(`SELECT s.session_id, s.user_id,
        s.authz_version AS session_authz_version, u.authz_version AS user_authz_version, u.is_active
      FROM auth_sessions s JOIN users u ON u.email = s.user_id
      WHERE s.session_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(sessionId, now);
    if (!row || !row.is_active) throw new AuthorizationError('invalid_session', 401);
    if (expectedUserId && row.user_id !== normalizeEmail(expectedUserId)) throw new AuthorizationError('invalid_session', 401);
    if (Number(row.session_authz_version) !== Number(row.user_authz_version)
        || Number(row.session_authz_version) !== Number(expectedAuthzVersion)) {
      throw new AuthorizationError('authz_version_mismatch', 401);
    }
    return this.identityForLegacyRoutes(row.user_id);
  }

  revokeSession(sessionId, reason = 'LOGOUT') {
    if (!sessionId) return 0;
    return this.db.prepare(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')),
      revoke_reason = COALESCE(revoke_reason, ?) WHERE session_id = ?`).run(reason, sessionId).changes;
  }
}

module.exports = { AuthorizationService, AuthorizationError, isStableMch2Id, isCanonicalMch2Id };
