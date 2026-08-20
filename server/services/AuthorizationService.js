'use strict';

const crypto = require('crypto');
const {
  ROLE_CODES,
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

  _user(identifier, activeOnly = true) {
    const value = String(identifier || '').trim();
    return this.db.prepare(`SELECT user_id, email, is_active, display_name, authz_version
      FROM users
      WHERE (user_id = ? OR lower(email) = lower(?)) ${activeOnly ? 'AND is_active = 1' : ''}`)
      .get(value, value);
  }

  _reference(identifier, activeOnly = false) {
    const user = this._user(identifier, activeOnly);
    return user ? { userId: user.user_id, email: user.email } : { userId: null, email: null };
  }

  _forget(user) {
    if (!user) return;
    this.cache.delete(user.user_id);
    this.cache.delete(user.email);
  }

  _audit({ actor, target, changeType, objectType, objectKey, before, after, requestId, correlationId }) {
    const actorRef = this._reference(actor);
    const targetRef = this._reference(target);
    this.db.prepare(`INSERT INTO authz_change_log
      (actor_user_id, target_user_id, actor_principal_id, target_principal_id,
       change_type, object_type, object_key, before_json, after_json, request_id, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actorRef.email, targetRef.email, actorRef.userId, targetRef.userId, changeType, objectType, objectKey,
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
        actorUserId: actorRef.email,
        actorPrincipalId: actorRef.userId,
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
    // Deprecated compatibility method. Stage 4E never synthesizes canonical
    // assignments from users.role/users.is_admin; callers must assign RBAC first.
    return this.identityForUser(email);
  }

  syncLegacyUsers(options = {}) {
    const users = this.db.prepare('SELECT email FROM users ORDER BY email').all();
    return users.map(({ email }) => this.identityForUser(email, options));
  }

  syncMissingLegacyUsers(options = {}) {
    const users = this.db.prepare(`SELECT u.email FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.email AND ur.active = 1)
      ORDER BY u.email`).all();
    if (users.length) throw new AuthorizationError('canonical_role_assignment_required', 409);
    return [];
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

  effectivePermissions(identifier) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const key = user.user_id;
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
      WHERE (ur.principal_id = ? OR (ur.principal_id IS NULL AND ur.user_id = ?)) AND ur.active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
        AND (ur.valid_until IS NULL OR ur.valid_until > ?)`
    ).all(user.user_id, user.email, now, now);
    const nearestExpiry = rows.map((row) => row.valid_until && Date.parse(`${row.valid_until.replace(' ', 'T')}Z`))
      .filter(Number.isFinite).reduce((min, value) => Math.min(min, value), Infinity);
    const value = this._permissionValue(rows, { userId: user.user_id, authzVersion: user.authz_version });
    this.cache.set(key, {
      authzVersion: user.authz_version,
      expiresAt: Math.min(nearestExpiry, this.clock().getTime() + 30_000),
      value,
    });
    return value;
  }

  can(identifier, permissionCode) {
    return this.effectivePermissions(identifier).permissions.includes(String(permissionCode));
  }

  requirePermission(permissionCode, contextFactory) {
    return (req, res, next) => {
      try {
        if (!req.user || !this.can(req.user.userId || req.user.email, permissionCode)) {
          return res.status(403).json({ error: 'forbidden', code: 'AUTHZ_PERMISSION_REQUIRED', request_id: req.requestId });
        }
        if (contextFactory) {
          const context = contextFactory(req);
          if (!this.isInScope(req.user.userId || req.user.email, context)) {
            return res.status(403).json({ error: 'forbidden', code: 'AUTHZ_SCOPE_REQUIRED', request_id: req.requestId });
          }
        }
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  _activeScopes(identifier) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const now = this._now();
    return this.db.prepare(`SELECT usa.*, r.role_code
      FROM user_scope_assignments usa
      LEFT JOIN roles r ON r.id = usa.role_id
      WHERE (usa.principal_id = ? OR (usa.principal_id IS NULL AND usa.user_id = ?)) AND usa.active = 1
        AND (usa.valid_from IS NULL OR usa.valid_from <= ?)
        AND (usa.valid_until IS NULL OR usa.valid_until > ?)
        AND (usa.role_id IS NULL OR EXISTS (
          SELECT 1 FROM user_roles ur
          WHERE (ur.principal_id = usa.principal_id
            OR (ur.principal_id IS NULL AND ur.user_id = usa.user_id))
          AND ur.role_id = usa.role_id
          AND ur.active = 1 AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
          AND (ur.valid_until IS NULL OR ur.valid_until > ?)))`).all(user.user_id, user.email, now, now, now, now);
  }

  _scopeMatches(scope, context, userOrIdentifier) {
    const user = typeof userOrIdentifier === 'object' && userOrIdentifier
      ? userOrIdentifier : this._user(userOrIdentifier);
    if (!user) return false;
    if (scope.scope_type === 'GLOBAL') return true;
    if (scope.scope_type === 'REGION') return String(context.regionId || context.region || '') === scope.scope_value;
    if (scope.scope_type === 'MCH2') {
      return isStableMch2Id(scope.scope_value)
        && String(context.mch2Id || context.mch2_id || '') === scope.scope_value;
    }
    if (scope.scope_type === 'ASSIGNED') {
      const value = String(context.assignedPrincipalId || context.assigned_principal_id
        || context.assignedUserId || context.assigned_user_id || '').trim();
      return value === user.user_id || normalizeEmail(value) === normalizeEmail(user.email);
    }
    if (scope.scope_type === 'OWN') {
      const value = String(context.ownerUserId || context.created_by_user_id
        || context.ownerId || context.created_by || context.userId || '').trim();
      return value === user.user_id || normalizeEmail(value) === normalizeEmail(user.email);
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

  isInScope(identifier, context = {}, options = {}) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const scopes = this._scopesForDecision(user.user_id, options);
    const denied = scopes.some((scope) => scope.effect === 'DENY' && this._scopeMatches(scope, context, user));
    if (denied) return false;
    return scopes.some((scope) => scope.effect === 'ALLOW' && this._scopeMatches(scope, context, user));
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

  buildSqlScope(identifier, options = {}) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const alias = options.alias || 't';
    const fields = {
      owner: 'created_by', assigned: 'assigned_specialist_id', region: 'region',
      mch2: 'mch2_id', supplier: 'supplier_code', ...(options.fields || {}),
    };
    const fieldExpressions = options.fieldExpressions || {};
    const fieldSql = (fieldName) => fieldExpressions[fieldName] || `${alias}.${fields[fieldName]}`;
    const scopes = this._activeScopes(user.user_id);
    const params = { scope_user_id: user.user_id, scope_user_email: user.email };
    const clauseFor = (scope, index) => {
      if (scope.scope_type === 'GLOBAL') return '1 = 1';
      if (scope.scope_type === 'OWN') return `(COALESCE(${fieldSql('owner')}, '') = @scope_user_id OR LOWER(COALESCE(${fieldSql('owner')}, '')) = LOWER(@scope_user_email))`;
      if (scope.scope_type === 'ASSIGNED') return `(COALESCE(${fieldSql('assigned')}, '') = @scope_user_id OR LOWER(COALESCE(${fieldSql('assigned')}, '')) = LOWER(@scope_user_email))`;
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
    const user = this._user(userId, false);
    const email = user?.email;
    const actorRef = this._reference(actor);
    const role = this.db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
    if (!user) throw new AuthorizationError('user_not_found', 404);
    if (!role) throw new AuthorizationError('role_not_found', 404);
    this.db.prepare(`INSERT INTO user_roles
      (user_id, principal_id, role_id, active, valid_from, valid_until, source, created_by)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(user_id, role_id) DO UPDATE SET active = 1, valid_from = excluded.valid_from,
        valid_until = excluded.valid_until, principal_id = excluded.principal_id, updated_at = datetime('now')`).run(
      email, user.user_id, role.id, validFrom || null, validUntil || null, source, actorRef.email
    );
    this._audit({ actor, target: email, changeType: 'ROLE_ASSIGNED', objectType: 'USER_ROLE',
      objectKey: roleCode, after: { role_code: roleCode, valid_from: validFrom || null, valid_until: validUntil || null },
      requestId, correlationId });
    this._forget(user);
  }

  revokeRole({ userId, roleCode, actor, requestId, correlationId }) {
    const user = this._user(userId, false);
    if (!user) throw new AuthorizationError('user_not_found', 404);
    const email = user.email;
    const info = this.db.prepare(`UPDATE user_roles SET active = 0, updated_at = datetime('now')
      WHERE (principal_id = ? OR (principal_id IS NULL AND user_id = ?))
        AND active = 1 AND role_id = (SELECT id FROM roles WHERE role_code = ?)`)
      .run(user.user_id, email, roleCode);
    if (info.changes) this._audit({ actor, target: email, changeType: 'ROLE_REVOKED', objectType: 'USER_ROLE',
      objectKey: roleCode, before: { role_code: roleCode, active: true }, requestId, correlationId });
    this._forget(user);
    return info.changes;
  }

  setPrimaryRole({ userId, roleCode, actor, requestId, correlationId, source = 'MANUAL' }) {
    const user = this._user(userId, false);
    const email = user?.email;
    const actorRef = this._reference(actor);
    if (!LEGACY_PRIMARY_ROLE_PRIORITY.includes(roleCode)) {
      throw new AuthorizationError('invalid_primary_role', 400);
    }
    if (!user) throw new AuthorizationError('user_not_found', 404);
    const desiredRole = this.db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
    if (!desiredRole) throw new AuthorizationError('role_not_found', 404);

    const apply = this.db.transaction(() => {
      let changed = false;
      const existing = this.db.prepare('SELECT id, active FROM user_roles WHERE user_id=? AND role_id=?')
        .get(email, desiredRole.id);
      if (!existing) {
        this.db.prepare(`INSERT INTO user_roles
          (user_id, principal_id, role_id, active, source, created_by) VALUES (?, ?, ?, 1, ?, ?)`
        ).run(email, user.user_id, desiredRole.id, source, actorRef.email);
        changed = true;
      } else if (!existing.active) {
        this.db.prepare(`UPDATE user_roles SET active=1, source=?, updated_at=datetime('now') WHERE id=?`)
          .run(source, existing.id);
        changed = true;
      }

      const placeholders = LEGACY_PRIMARY_ROLE_PRIORITY.map(() => '?').join(',');
      const deactivated = this.db.prepare(`UPDATE user_roles SET active = 0, updated_at = datetime('now')
        WHERE user_id = ? AND role_id <> ? AND active = 1
          AND role_id IN (SELECT id FROM roles WHERE role_code IN (${placeholders}))`
      ).run(email, desiredRole.id, ...LEGACY_PRIMARY_ROLE_PRIORITY);
      changed = changed || deactivated.changes > 0;

      const scopes = roleCode === ROLE_CODES.SUPPLIER_USER
        ? [['SUPPLIER', email]]
        : roleCode === ROLE_CODES.QLCL_SPECIALIST
          ? [['OWN', 'SELF'], ['ASSIGNED', 'SELF']]
          : [['GLOBAL', null]];
      for (const [scopeType, scopeValue] of scopes) {
        const scope = this.db.prepare(`INSERT INTO user_scope_assignments
          (user_id, principal_id, role_id, scope_type, scope_value, effect, source, created_by)
          VALUES (?, ?, ?, ?, ?, 'ALLOW', ?, ?)
          ON CONFLICT DO NOTHING`
        ).run(email, user.user_id, desiredRole.id, scopeType, scopeValue, source, actorRef.email);
        changed = changed || scope.changes > 0;
      }
      if (changed) {
        this._audit({
          actor,
          target: email,
          changeType: 'PRIMARY_ROLE_SET',
          objectType: 'USER_ROLE',
          objectKey: roleCode,
          after: { role_code: roleCode },
          requestId,
          correlationId,
        });
      }
    });
    apply();
    this._forget(user);
    return this.identityForUser(user.user_id);
  }

  assignScope({ userId, roleCode, scopeType, scopeValue, effect = 'ALLOW', actor,
    validFrom, validUntil, customSchemaCode, customSchemaVersion, requestId, correlationId }) {
    const user = this._user(userId, false);
    if (!user) throw new AuthorizationError('user_not_found', 404);
    const email = user.email;
    const actorRef = this._reference(actor);
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
      (user_id, principal_id, role_id, scope_type, scope_value, effect, valid_from, valid_until,
       custom_schema_code, custom_schema_version, source, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?)
      ON CONFLICT DO NOTHING`).run(email, user.user_id, role?.id || null, scopeType, scopeValue ?? null, effect,
      validFrom || null, validUntil || null, customSchemaCode || null, customSchemaVersion || null, actorRef.email);
    this._audit({ actor, target: email, changeType: 'SCOPE_ASSIGNED', objectType: 'USER_SCOPE',
      objectKey: `${scopeType}:${scopeValue || 'GLOBAL'}`, after: { role_code: roleCode || null, scope_type: scopeType, scope_value: scopeValue ?? null, effect },
      requestId, correlationId });
    this._forget(user);
  }

  identityForUser(identifier) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationError('account_disabled', 401);
    const authz = this.effectivePermissions(user.user_id);
    const roleLabels = this.db.prepare(`SELECT r.role_code, r.display_label
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE (ur.principal_id = ? OR (ur.principal_id IS NULL AND ur.user_id = ?))
        AND ur.active = 1 AND r.active = 1
      ORDER BY r.role_code`).all(user.user_id, user.email);
    const primaryCode = LEGACY_PRIMARY_ROLE_PRIORITY.find((code) => authz.roleCodes.includes(code))
      || authz.roleCodes[0];
    if (!primaryCode) throw new AuthorizationError('canonical_role_assignment_required', 403);
    return {
      id: user.user_id,
      userId: user.user_id,
      email: user.email,
      isAdmin: authz.roleCodes.includes(ROLE_CODES.SYS_ADMIN),
      primaryRoleCode: primaryCode,
      role: ROLE_CODE_TO_LEGACY[primaryCode] || null,
      displayName: user.display_name || null,
      authzVersion: user.authz_version,
      roleCodes: authz.roleCodes,
      roleLabels,
      capabilities: authz.permissions,
    };
  }

  identityForLegacyRoutes(email) {
    return this.identityForUser(email);
  }

  createSession(identifier, options = {}) {
    const identity = this.identityForUser(identifier);
    const ttlSeconds = Number(options.ttlSeconds || 28_800);
    const issued = this.clock();
    const expires = new Date(issued.getTime() + ttlSeconds * 1000);
    const sessionId = crypto.randomUUID();
    this.db.prepare(`INSERT INTO auth_sessions
      (session_id, user_id, principal_id, authz_version, issued_at, expires_at, created_ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, identity.email, identity.userId, identity.authzVersion,
      sqliteTime(issued), sqliteTime(expires), options.ip || null, options.userAgent || null);
    return { sessionId, authzVersion: identity.authzVersion, expiresAt: expires, identity };
  }

  resolveSession(sessionId, expectedUserId, expectedAuthzVersion) {
    const now = this._now();
    const row = this.db.prepare(`SELECT s.session_id, s.user_id, s.principal_id, u.user_id AS immutable_user_id,
        s.authz_version AS session_authz_version, u.authz_version AS user_authz_version, u.is_active
      FROM auth_sessions s JOIN users u
        ON u.user_id = s.principal_id OR (s.principal_id IS NULL AND u.email = s.user_id)
      WHERE s.session_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(sessionId, now);
    if (!row || !row.is_active) throw new AuthorizationError('invalid_session', 401);
    if (expectedUserId && String(expectedUserId) !== row.immutable_user_id
        && normalizeEmail(expectedUserId) !== normalizeEmail(row.user_id)) {
      throw new AuthorizationError('invalid_session', 401);
    }
    if (Number(row.session_authz_version) !== Number(row.user_authz_version)
        || Number(row.session_authz_version) !== Number(expectedAuthzVersion)) {
      throw new AuthorizationError('authz_version_mismatch', 401);
    }
    return this.identityForUser(row.immutable_user_id);
  }

  revokeSession(sessionId, reason = 'LOGOUT') {
    if (!sessionId) return 0;
    return this.db.prepare(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')),
      revoke_reason = COALESCE(revoke_reason, ?) WHERE session_id = ?`).run(reason, sessionId).changes;
  }
}

module.exports = { AuthorizationService, AuthorizationError, isStableMch2Id, isCanonicalMch2Id };
