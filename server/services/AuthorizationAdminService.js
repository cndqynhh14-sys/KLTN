'use strict';

const XLSX = require('xlsx');
const { isCanonicalMch2Id } = require('./AuthorizationService');
const {
  PERMISSIONS,
  ROLE_CODES,
  SCOPE_TYPES,
  isActivePermission,
} = require('../authorization/permissionCatalog');
const { sanitizeString } = require('../observability/redact');

const REQUIRED_APPROVAL_STAGES = Object.freeze([
  Object.freeze({ workflowType: 'EVALUATION', stageCode: 'LEAD' }),
  Object.freeze({ workflowType: 'EVALUATION', stageCode: 'TBP' }),
  Object.freeze({ workflowType: 'EVALUATION', stageCode: 'GDK' }),
]);

const PERMISSION_DESCRIPTIONS = Object.freeze({
  'SYSTEM.ADMIN': 'Quản trị toàn bộ cấu hình hệ thống.',
  'USER.MANAGE': 'Quản lý người dùng, vai trò, quyền và phạm vi dữ liệu.',
  'DASHBOARD.READ': 'Xem các bảng điều khiển chất lượng.',
  'AUDIT.READ': 'Đọc và tìm kiếm nhật ký audit.',
  'AUDIT.EXPORT': 'Xuất nhật ký audit trong giới hạn được duyệt.',
  'SUPPLIER.READ': 'Xem danh mục NCC.',
  'SUPPLIER.WRITE': 'Tạo và cập nhật danh mục NCC.',
  'SUPPLIER.SELF_READ': 'NCC xem dữ liệu thuộc chính mình.',
  'EVALUATION.READ': 'Xem phiếu đánh giá NCC.',
  'EVALUATION.CREATE': 'Tạo phiếu đánh giá NCC.',
  'EVALUATION.SCORE': 'Chấm điểm vòng đánh giá.',
  'EVALUATION.DELETE_DRAFT': 'Xóa phiếu đánh giá còn ở trạng thái nháp.',
  'EVALUATION.APPROVE_LEAD': 'Phê duyệt đánh giá ở bước Lead.',
  'EVALUATION.APPROVE_TBP': 'Phê duyệt đánh giá ở bước TBP.',
  'EVALUATION.APPROVE_GDK': 'Phê duyệt đánh giá ở bước GĐK.',
  'REPORT.READ': 'Xem lịch sử và bản xem trước báo cáo.',
  'REPORT.EXPORT': 'Tạo và tải báo cáo xuất.',
  'REPORT_TEMPLATE.MANAGE': 'Quản lý mẫu báo cáo.',
  'REPORT_TEMPLATE.PUBLISH': 'Publish, retire hoặc rollback mẫu báo cáo.',
  'REPORT_TEMPLATE.ADVANCED': 'Chỉnh sửa JSON nâng cao của mẫu báo cáo qua schema guard.',
  'QUESTION_TEMPLATE.MANAGE': 'Quản lý bộ câu hỏi đánh giá NCC.',
  'SCORING_POLICY.MANAGE': 'Tạo, kiểm tra và mô phỏng bản nháp chính sách chấm điểm.',
  'SCORING_POLICY.PUBLISH': 'Publish hoặc rollback chính sách chấm điểm theo nguyên tắc bốn mắt.',
});

const SCOPE_DESCRIPTIONS = Object.freeze({
  GLOBAL: 'Toàn bộ dữ liệu trong hệ thống.',
  REGION: 'Dữ liệu thuộc một miền/vùng cụ thể.',
  MCH2: 'Dữ liệu thuộc một mã ngành hàng MCH2 ổn định.',
  ASSIGNED: 'Chỉ bản ghi được phân công cho người dùng.',
  OWN: 'Chỉ bản ghi do người dùng sở hữu hoặc tạo.',
  SUPPLIER: 'Chỉ dữ liệu của một NCC cụ thể.',
  CUSTOM: 'Phạm vi theo schema tùy chỉnh đã đăng ký.',
});

class AuthorizationAdminError extends Error {
  constructor(code, status = 400, details) {
    super(code);
    this.name = 'AuthorizationAdminError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCode(value, field = 'code') {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) throw new AuthorizationAdminError(`invalid_${field}`, 400);
  return code;
}

function normalizeReason(value) {
  const reason = sanitizeString(String(value || '').trim(), 500);
  if (reason.length < 8 || reason.length > 500) throw new AuthorizationAdminError('change_reason_required', 400);
  return reason;
}

function requiredConfirmation(action, objectKey) {
  const verbs = {
    PUBLISH_ROLE: 'PUBLISH ROLE',
    DELETE_ROLE: 'DELETE ROLE',
    ASSIGN_ROLES: 'ASSIGN ROLES',
    ASSIGN_SCOPE: 'ASSIGN SCOPE',
    PUBLISH_APPROVER: 'PUBLISH APPROVER',
    COMMIT_PERSONNEL_IMPORT: 'COMMIT PERSONNEL IMPORT',
  };
  const verb = verbs[String(action || '')];
  if (!verb) throw new TypeError('confirmation_action_invalid');
  return `${verb} ${String(objectKey || '').trim()}`;
}

function requireExactConfirmation(value, action, objectKey) {
  const expected = requiredConfirmation(action, objectKey);
  if (String(value || '') !== expected) {
    throw new AuthorizationAdminError('exact_confirmation_required', 409, { expectedConfirmation: expected });
  }
}

function sqliteTime(value, field) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new AuthorizationAdminError(`invalid_${field}`, 400);
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new AuthorizationAdminError(`invalid_${field}`, 400);
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function validityWindow(validFrom, validUntil) {
  const from = sqliteTime(validFrom, 'valid_from');
  const until = sqliteTime(validUntil, 'valid_until');
  if (from && until && until <= from) throw new AuthorizationAdminError('invalid_validity_window', 400);
  return { validFrom: from, validUntil: until };
}

function permissionRisk(permissionCode) {
  const code = String(permissionCode || '');
  if ([PERMISSIONS.SYSTEM_ADMIN, PERMISSIONS.USER_MANAGE].includes(code)) return 'critical';
  if (code.startsWith('AUDIT.') || code.endsWith('.EXPORT') || code.includes('.APPROVE_') || code.endsWith('.MANAGE')) return 'high';
  if (code.endsWith('.WRITE') || code.endsWith('.CREATE') || code.includes('.DELETE')) return 'medium';
  return 'low';
}

function permissionScopes(permissionCode) {
  const code = String(permissionCode || '');
  if (code.startsWith('SYSTEM.') || code.startsWith('USER.') || code.startsWith('AUDIT.')
      || code.includes('TEMPLATE')) return ['GLOBAL'];
  if (code.startsWith('SUPPLIER.')) return ['GLOBAL', 'REGION', 'MCH2', 'SUPPLIER', 'CUSTOM'];
  return ['GLOBAL', 'REGION', 'MCH2', 'ASSIGNED', 'OWN', 'SUPPLIER', 'CUSTOM'];
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function positiveInteger(value, fallback, maximum, field) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new AuthorizationAdminError(`invalid_${field}`, 400);
  }
  return number;
}

function historyDate(value, field) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AuthorizationAdminError(`invalid_${field}`, 400);
  }
  const [year, month, day] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== raw) throw new AuthorizationAdminError(`invalid_${field}`, 400);
  return raw;
}

function spreadsheetValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function activeAt(row, now) {
  return row.active === 1 && (!row.valid_from || row.valid_from <= now) && (!row.valid_until || row.valid_until > now);
}

class AuthorizationAdminService {
  constructor(db, authorizationService, approvalAssignmentService, auditEventService) {
    this.db = db;
    this.authorizationService = authorizationService;
    this.approvalAssignmentService = approvalAssignmentService;
    this.auditEventService = auditEventService;
  }

  _user(identifier) {
    const value = String(identifier || '').trim();
    return this.db.prepare(`SELECT user_id, email, display_name, is_active, authz_version, created_at
      FROM users WHERE user_id = ? OR lower(email) = lower(?)`).get(value, value) || null;
  }

  _userEmail(identifier) {
    const user = this._user(identifier);
    if (!user) throw new AuthorizationAdminError('user_not_found', 404);
    return user.email;
  }

  _actorVersion(actor) {
    return this._user(actor)?.authz_version || 1;
  }

  _targetVersion(target, actor) {
    return this._user(target)?.authz_version
      || this._actorVersion(actor);
  }

  _record({ context, target, changeType, objectType, objectKey, before, after, reason, authzVersion, eventName, metadata }) {
    const actor = this._user(context.actorUserId || context.actor);
    const targetUser = target ? this._user(target) : null;
    this.db.prepare(`INSERT INTO authz_change_log
      (actor_user_id, target_user_id, actor_principal_id, target_principal_id,
       change_type, object_type, object_key,
       before_json, after_json, request_id, correlation_id, reason, authz_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      actor?.email || normalizeEmail(context.actor) || null,
      targetUser?.email || (target ? normalizeEmail(target) : null),
      actor?.user_id || null,
      targetUser?.user_id || null,
      changeType,
      objectType,
      objectKey,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      context.requestId || null,
      context.correlationId || null,
      reason,
      authzVersion
    );
    this.auditEventService.record({
      eventName,
      actorUserId: actor?.email || context.actor,
      actorPrincipalId: actor?.user_id || context.actorUserId,
      entityType: objectType,
      entityId: target || objectKey,
      action: changeType,
      outcome: 'SUCCESS',
      summary: `${changeType} ${objectType}`,
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata: { ...metadata, reason, authz_version: authzVersion },
      before,
      after,
    });
  }

  _role(roleCode) {
    return this.db.prepare(`SELECT id, role_code, display_label, role_kind, active, created_at, updated_at
      FROM roles WHERE role_code = ?`).get(String(roleCode || '').trim().toUpperCase());
  }

  _roleSnapshot(roleCode) {
    const role = this._role(roleCode);
    if (!role) return null;
    return {
      role_code: role.role_code,
      display_label: role.display_label,
      role_kind: role.role_kind === 'SYSTEM' ? 'system' : 'custom',
      active: Boolean(role.active),
      permissions: this.db.prepare(`SELECT permission_code, effect FROM role_permissions
        WHERE role_id = ? ORDER BY permission_code, effect`).all(role.id)
        .filter((item) => isActivePermission(item.permission_code)),
    };
  }

  _manualUserSnapshot(email) {
    return {
      role_codes: this.db.prepare(`SELECT r.role_code, ur.active, ur.valid_from, ur.valid_until
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ? AND ur.source = 'MANUAL' ORDER BY r.role_code`).all(email),
      scopes: this.db.prepare(`SELECT r.role_code, usa.scope_type, usa.scope_value, usa.effect,
          usa.active, usa.valid_from, usa.valid_until, usa.custom_schema_code, usa.custom_schema_version
        FROM user_scope_assignments usa LEFT JOIN roles r ON r.id = usa.role_id
        WHERE usa.user_id = ? AND usa.source = 'MANUAL'
        ORDER BY usa.scope_type, usa.scope_value, usa.effect`).all(email),
      authz_version: this._targetVersion(email),
    };
  }

  catalog() {
    const roles = this.db.prepare(`SELECT r.role_code, r.display_label, r.role_kind, r.active,
        COUNT(DISTINCT CASE WHEN ur.active = 1 THEN ur.user_id END) AS user_count,
        COUNT(DISTINCT ur.user_id) AS assignment_count,
        COUNT(DISTINCT rp.permission_code || ':' || rp.effect) AS permission_count,
        COUNT(DISTINCT asa.id) AS approval_count
      FROM roles r
      LEFT JOIN user_roles ur ON ur.role_id = r.id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN approval_stage_assignments asa ON asa.role_id = r.id
      GROUP BY r.id ORDER BY r.role_kind = 'SYSTEM' DESC, r.display_label, r.role_code`).all().map((row) => ({
      roleCode: row.role_code,
      displayLabel: row.display_label,
      kind: row.role_kind === 'SYSTEM' ? 'system' : 'custom',
      status: row.active ? 'active' : 'inactive',
      active: Boolean(row.active),
      userCount: Number(row.user_count),
      assignmentCount: Number(row.assignment_count),
      permissionCount: Number(row.permission_count),
      approvalCount: Number(row.approval_count),
      inUse: Number(row.assignment_count) > 0 || Number(row.approval_count) > 0,
    }));
    const permissions = this.db.prepare(`SELECT permission_code, description, resource_type, action_code, active
      FROM permissions ORDER BY resource_type, permission_code`).all()
      .filter((row) => isActivePermission(row.permission_code)).map((row) => ({
      permissionCode: row.permission_code,
      module: row.resource_type,
      action: row.action_code,
      description: PERMISSION_DESCRIPTIONS[row.permission_code] || row.description,
      risk: permissionRisk(row.permission_code),
      scopeTypes: permissionScopes(row.permission_code),
      active: Boolean(row.active),
    }));
    return {
      roles,
      permissions,
      scopeTypes: SCOPE_TYPES.map((scopeType) => ({ scopeType, description: SCOPE_DESCRIPTIONS[scopeType] })),
      requiredApprovalStages: REQUIRED_APPROVAL_STAGES,
    };
  }

  roleDetail(roleCode) {
    const role = this._roleSnapshot(roleCode);
    if (!role) throw new AuthorizationAdminError('role_not_found', 404);
    const counts = this.catalog().roles.find((item) => item.roleCode === role.role_code);
    return { ...role, ...counts };
  }

  createRole(input, context) {
    const roleCode = normalizeCode(input.roleCode, 'role_code');
    const displayLabel = String(input.displayLabel || '').trim();
    if (!displayLabel || displayLabel.length > 160) throw new AuthorizationAdminError('invalid_role_label', 400);
    const reason = normalizeReason(input.reason);
    const clone = input.cloneFrom ? this._roleSnapshot(input.cloneFrom) : null;
    if (input.cloneFrom && !clone) throw new AuthorizationAdminError('clone_role_not_found', 404);
    if (clone?.permissions.some((item) => ['high', 'critical'].includes(permissionRisk(item.permission_code)))) {
      requireExactConfirmation(input.confirmation, 'PUBLISH_ROLE', roleCode);
    }
    const create = this.db.transaction(() => {
      if (this._role(roleCode)) throw new AuthorizationAdminError('role_code_exists', 409);
      this.db.prepare(`INSERT INTO roles (role_code, display_label, role_kind)
        VALUES (?, ?, 'FUNCTIONAL')`).run(roleCode, displayLabel);
      if (clone) {
        this.db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect, created_by)
          SELECT target.id, rp.permission_code, rp.effect, ?
          FROM roles target CROSS JOIN roles source
          JOIN role_permissions rp ON rp.role_id = source.id
          WHERE target.role_code = ? AND source.role_code = ?`).run(context.actor || null, roleCode, clone.role_code);
      }
      const after = this._roleSnapshot(roleCode);
      const version = this._actorVersion(context.actor);
      this._record({ context, changeType: 'ROLE_CREATED', objectType: 'ROLE', objectKey: roleCode,
        before: null, after, reason, authzVersion: version, eventName: 'role.catalog.changed',
        metadata: { role_code: roleCode, change_type: 'ROLE_CREATED' } });
      return this.roleDetail(roleCode);
    });
    return create();
  }

  updateRole(roleCodeInput, input, context) {
    const roleCode = normalizeCode(roleCodeInput, 'role_code');
    const current = this._role(roleCode);
    if (!current) throw new AuthorizationAdminError('role_not_found', 404);
    const reason = normalizeReason(input.reason);
    const displayLabel = input.displayLabel === undefined ? current.display_label : String(input.displayLabel || '').trim();
    if (!displayLabel || displayLabel.length > 160) throw new AuthorizationAdminError('invalid_role_label', 400);
    const active = input.active === undefined ? Boolean(current.active) : input.active === true;
    if (active !== Boolean(current.active)) requireExactConfirmation(input.confirmation, 'PUBLISH_ROLE', roleCode);
    const update = this.db.transaction(() => {
      const before = this._roleSnapshot(roleCode);
      this.db.prepare(`UPDATE roles SET display_label = ?, active = ?, updated_at = datetime('now')
        WHERE role_code = ?`).run(displayLabel, active ? 1 : 0, roleCode);
      const after = this._roleSnapshot(roleCode);
      const version = this.db.prepare(`SELECT COALESCE(MAX(u.authz_version), ?) AS version
        FROM users u JOIN user_roles ur ON ur.user_id = u.email
        JOIN roles r ON r.id = ur.role_id WHERE r.role_code = ?`).get(this._actorVersion(context.actor), roleCode).version;
      this._record({ context, changeType: 'ROLE_UPDATED', objectType: 'ROLE', objectKey: roleCode,
        before, after, reason, authzVersion: version, eventName: 'role.catalog.changed',
        metadata: { role_code: roleCode, change_type: 'ROLE_UPDATED' } });
      return this.roleDetail(roleCode);
    });
    return update();
  }

  deleteRole(roleCodeInput, input, context) {
    const roleCode = normalizeCode(roleCodeInput, 'role_code');
    const role = this._role(roleCode);
    if (!role) throw new AuthorizationAdminError('role_not_found', 404);
    if (role.role_kind === 'SYSTEM') throw new AuthorizationAdminError('system_role_delete_forbidden', 409);
    const reason = normalizeReason(input.reason);
    requireExactConfirmation(input.confirmation, 'DELETE_ROLE', roleCode);
    const inUse = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM user_roles WHERE role_id = ?) AS users,
      (SELECT COUNT(*) FROM approval_stage_assignments WHERE role_id = ?) AS approvals`).get(role.id, role.id);
    if (inUse.users || inUse.approvals) throw new AuthorizationAdminError('role_in_use', 409, inUse);
    const remove = this.db.transaction(() => {
      const before = this._roleSnapshot(roleCode);
      const version = this._actorVersion(context.actor);
      this.db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
      this._record({ context, changeType: 'ROLE_DELETED', objectType: 'ROLE', objectKey: roleCode,
        before, after: null, reason, authzVersion: version, eventName: 'role.catalog.changed',
        metadata: { role_code: roleCode, change_type: 'ROLE_DELETED' } });
      return { ok: true };
    });
    return remove();
  }

  setRolePermissions(roleCodeInput, input, context) {
    const roleCode = normalizeCode(roleCodeInput, 'role_code');
    const role = this._role(roleCode);
    if (!role) throw new AuthorizationAdminError('role_not_found', 404);
    const reason = normalizeReason(input.reason);
    if (!Array.isArray(input.permissions)) throw new AuthorizationAdminError('permissions_required', 400);
    const available = new Set(this.db.prepare('SELECT permission_code FROM permissions WHERE active = 1').all()
      .map((row) => row.permission_code).filter(isActivePermission));
    const seen = new Set();
    const permissions = input.permissions.map((item) => {
      const permissionCode = String(item?.permissionCode || '').trim().toUpperCase();
      const effect = String(item?.effect || 'ALLOW').trim().toUpperCase();
      const key = `${permissionCode}:${effect}`;
      if (!available.has(permissionCode)) throw new AuthorizationAdminError('permission_not_found', 404);
      if (!['ALLOW', 'DENY'].includes(effect) || seen.has(key)) throw new AuthorizationAdminError('invalid_permission_assignment', 400);
      seen.add(key);
      return { permissionCode, effect };
    });
    const before = this._roleSnapshot(roleCode);
    if (roleCode === ROLE_CODES.SYS_ADMIN) {
      const required = new Set([PERMISSIONS.SYSTEM_ADMIN, PERMISSIONS.USER_MANAGE]);
      const allowed = new Set(permissions.filter((item) => item.effect === 'ALLOW').map((item) => item.permissionCode));
      if ([...required].some((code) => !allowed.has(code))) {
        throw new AuthorizationAdminError('sys_admin_baseline_required', 409);
      }
    }
    const touchesSensitive = [...before.permissions.map((row) => row.permission_code), ...permissions.map((row) => row.permissionCode)]
      .some((code) => ['high', 'critical'].includes(permissionRisk(code)));
    if (touchesSensitive) requireExactConfirmation(input.confirmation, 'PUBLISH_ROLE', roleCode);
    const actorBefore = this.authorizationService.effectivePermissions(context.actor).permissions;
    const actorUsesRole = Boolean(this.db.prepare(`SELECT 1 FROM user_roles
      WHERE user_id = ? AND role_id = ? AND active = 1`).get(normalizeEmail(context.actor), role.id));
    const publish = this.db.transaction(() => {
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
      const insert = this.db.prepare(`INSERT INTO role_permissions
        (role_id, permission_code, effect, created_by) VALUES (?, ?, ?, ?)`);
      permissions.forEach((item) => insert.run(role.id, item.permissionCode, item.effect, context.actor || null));
      this.authorizationService.cache.delete(normalizeEmail(context.actor));
      const actorAfter = this.authorizationService.effectivePermissions(context.actor).permissions;
      if (actorUsesRole && actorAfter.some((code) => !actorBefore.includes(code))) {
        throw new AuthorizationAdminError('cannot_self_escalate', 409);
      }
      const after = this._roleSnapshot(roleCode);
      const version = this.db.prepare(`SELECT COALESCE(MAX(u.authz_version), ?) AS version
        FROM users u JOIN user_roles ur ON ur.user_id = u.email WHERE ur.role_id = ?`).get(
        this._actorVersion(context.actor), role.id
      ).version;
      this._record({ context, changeType: 'ROLE_PERMISSIONS_PUBLISHED', objectType: 'ROLE_PERMISSION', objectKey: roleCode,
        before: { permissions: before.permissions, authz_version: version },
        after: { permissions: after.permissions, authz_version: version }, reason, authzVersion: version,
        eventName: 'role.permissions.changed', metadata: { role_code: roleCode, change_type: 'PUBLISHED' } });
      return this.roleDetail(roleCode);
    });
    try { return publish(); } finally { this.authorizationService.cache.delete(normalizeEmail(context.actor)); }
  }

  saveRoleConfiguration(roleCodeInput, input, context) {
    const roleCode = normalizeCode(roleCodeInput, 'role_code');
    if (!Array.isArray(input.permissions)) throw new AuthorizationAdminError('permissions_required', 400);
    const save = this.db.transaction(() => {
      this.updateRole(roleCode, {
        displayLabel: input.displayLabel,
        active: input.active,
        reason: input.reason,
        confirmation: input.confirmation,
      }, context);
      return this.setRolePermissions(roleCode, {
        permissions: input.permissions,
        reason: input.reason,
        confirmation: input.confirmation,
      }, context);
    });
    try { return save(); } finally { this.authorizationService.cache.delete(normalizeEmail(context.actor)); }
  }

  userDetail(userId) {
    const user = this._user(userId);
    if (!user) throw new AuthorizationAdminError('user_not_found', 404);
    const email = user.email;
    const now = this.authorizationService._now();
    const roles = this.db.prepare(`SELECT r.role_code, r.display_label, r.active AS role_active,
        ur.active, ur.valid_from, ur.valid_until, ur.source
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE (ur.principal_id = ? OR (ur.principal_id IS NULL AND ur.user_id = ?))
      ORDER BY r.role_code`).all(user.user_id, email).map((row) => ({
      roleCode: row.role_code,
      displayLabel: row.display_label,
      roleActive: Boolean(row.role_active),
      active: Boolean(row.active),
      effective: Boolean(row.role_active) && activeAt(row, now),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      source: row.source,
    }));
    const scopes = this.db.prepare(`SELECT usa.id, r.role_code, usa.scope_type, usa.scope_value, usa.effect,
        usa.active, usa.valid_from, usa.valid_until, usa.source
      FROM user_scope_assignments usa LEFT JOIN roles r ON r.id = usa.role_id
      WHERE (usa.principal_id = ? OR (usa.principal_id IS NULL AND usa.user_id = ?))
      ORDER BY usa.scope_type, usa.scope_value, usa.effect`).all(user.user_id, email).map((row) => ({
      id: row.id,
      roleCode: row.role_code,
      scopeType: row.scope_type,
      scopeValue: row.scope_value,
      effect: row.effect,
      active: Boolean(row.active),
      effective: activeAt(row, now),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      source: row.source,
    })).map((scope) => ({
      ...scope,
      effective: scope.effective && (!scope.roleCode || roles.some((role) => role.roleCode === scope.roleCode && role.effective)),
    }));
    const permissionRows = this.db.prepare(`SELECT r.role_code, p.permission_code, rp.effect
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.active = 1
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.permission_code = rp.permission_code AND p.active = 1
      WHERE (ur.principal_id = ? OR (ur.principal_id IS NULL AND ur.user_id = ?)) AND ur.active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
        AND (ur.valid_until IS NULL OR ur.valid_until > ?)
      ORDER BY p.permission_code, rp.effect, r.role_code`).all(user.user_id, email, now, now)
      .filter((row) => isActivePermission(row.permission_code));
    // Admins must still be able to inspect the preserved RBAC snapshot after an
    // account is deactivated. Do not use this snapshot for authorization:
    // effectivePermissions() intentionally remains active-account-only.
    const authz = user.is_active
      ? this.authorizationService.effectivePermissions(user.user_id)
      : this.authorizationService.effectivePermissionsForRoleAssignments(
        roles.map((role) => ({
          roleCode: role.roleCode,
          active: role.effective,
          validFrom: role.validFrom,
          validUntil: role.validUntil,
        })),
        { userId: user.user_id, authzVersion: user.authz_version, now }
      );
    const explanations = [];
    const byPermission = new Map();
    permissionRows.forEach((row) => {
      const effects = byPermission.get(row.permission_code) || new Set();
      effects.add(row.effect);
      byPermission.set(row.permission_code, effects);
    });
    for (const [permissionCode, effects] of byPermission) {
      if (effects.has('ALLOW') && effects.has('DENY')) explanations.push({
        type: 'permission_conflict', permissionCode, resolution: 'DENY_WINS',
      });
    }
    roles.filter((role) => role.active && !role.effective).forEach((role) => explanations.push({
      type: 'expired_role', roleCode: role.roleCode, validUntil: role.validUntil,
    }));
    const scopeEffects = new Map();
    scopes.filter((scope) => scope.effective).forEach((scope) => {
      const key = `${scope.scopeType}:${scope.scopeValue || 'GLOBAL'}`;
      const effects = scopeEffects.get(key) || new Set();
      effects.add(scope.effect);
      scopeEffects.set(key, effects);
    });
    for (const [scopeKey, effects] of scopeEffects) {
      if (effects.has('ALLOW') && effects.has('DENY')) explanations.push({
        type: 'scope_conflict', scopeKey, resolution: 'DENY_WINS',
      });
    }
    return {
      user: { userId: user.user_id, user_id: user.user_id, email: user.email, displayName: user.display_name, active: Boolean(user.is_active), authzVersion: user.authz_version, createdAt: user.created_at },
      roles,
      scopes,
      effective: {
        roleCodes: authz.roleCodes,
        permissions: authz.permissions.filter(isActivePermission),
        deniedPermissions: authz.deniedPermissions.filter(isActivePermission),
        authzVersion: authz.authzVersion,
        sources: permissionRows.map((row) => ({ roleCode: row.role_code, permissionCode: row.permission_code, effect: row.effect })),
        explanations,
      },
    };
  }

  _roleAssignmentsBySource(email, sources) {
    const normalizedSources = [...new Set(sources.map((source) => String(source || '').trim().toUpperCase()).filter(Boolean))];
    if (!normalizedSources.length) return [];
    const placeholders = normalizedSources.map(() => '?').join(',');
    return this.db.prepare(`SELECT r.role_code, ur.active, ur.valid_from, ur.valid_until, ur.source
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND ur.source IN (${placeholders})
      ORDER BY r.role_code`).all(email, ...normalizedSources);
  }

  _normalizeUserRoles(email, input) {
    if (!Array.isArray(input.roles)) throw new AuthorizationAdminError('roles_required', 400);
    const seen = new Set();
    return input.roles.map((item) => {
      const roleCode = normalizeCode(item?.roleCode, 'role_code');
      if (seen.has(roleCode)) throw new AuthorizationAdminError('duplicate_role_assignment', 400);
      seen.add(roleCode);
      const role = this._role(roleCode);
      if (!role || !role.active) throw new AuthorizationAdminError('role_not_found', 404);
      const window = validityWindow(item.validFrom, item.validUntil);
      return { role, roleCode, ...window };
    });
  }

  _replaceUserRoles(userId, input, context, replaceSources) {
    const email = this._userEmail(userId);
    const reason = normalizeReason(input.reason);
    const roles = this._normalizeUserRoles(email, input);
    const beforeRoles = this._roleAssignmentsBySource(email, replaceSources);
    const beforeVersion = this._targetVersion(email, context.actor);
    const touchesSensitiveRole = roles.some((item) => this.db.prepare(`SELECT permission_code FROM role_permissions
      WHERE role_id = ?`).all(item.role.id).some((row) => ['high', 'critical'].includes(permissionRisk(row.permission_code))))
      || beforeRoles.some((item) => item.active && item.role_code === ROLE_CODES.SYS_ADMIN);
    if (touchesSensitiveRole) {
      requireExactConfirmation(input.confirmation, 'ASSIGN_ROLES', email);
    }
    const beforeEffective = this.authorizationService.effectivePermissions(email);
    const replace = this.db.transaction(() => {
      const placeholders = replaceSources.map(() => '?').join(',');
      this.db.prepare(`UPDATE user_roles SET active = 0, updated_at = datetime('now')
        WHERE user_id = ? AND source IN (${placeholders})`).run(email, ...replaceSources);
      const existing = this.db.prepare('SELECT id, source FROM user_roles WHERE user_id = ? AND role_id = ?');
      const insert = this.db.prepare(`INSERT INTO user_roles
        (user_id, role_id, active, valid_from, valid_until, source, created_by)
        VALUES (?, ?, 1, ?, ?, 'MANUAL', ?)`);
      const update = this.db.prepare(`UPDATE user_roles SET active = 1, valid_from = ?, valid_until = ?,
        source = 'MANUAL', updated_at = datetime('now') WHERE id = ?`);
      roles.forEach((item) => {
        const row = existing.get(email, item.role.id);
        // The schema has one row per user/role. Never convert an externally
        // managed assignment into MANUAL just because the imported desired set
        // contains the same role.
        if (row && ['IDP', 'MIGRATION'].includes(row.source)) {
          throw new AuthorizationAdminError('role_source_conflict', 409, { roleCode: item.roleCode, source: row.source });
        }
        if (row) update.run(item.validFrom, item.validUntil, row.id);
        else insert.run(email, item.role.id, item.validFrom, item.validUntil, context.actor || null);
      });
      this.authorizationService.cache.delete(email);
      const afterEffective = this.authorizationService.effectivePermissions(email);
      if (!afterEffective.roleCodes.length) throw new AuthorizationAdminError('canonical_role_assignment_required', 409);
      if (email === normalizeEmail(context.actor)
          && (afterEffective.permissions.some((code) => !beforeEffective.permissions.includes(code))
            || (!beforeEffective.roleCodes.includes(ROLE_CODES.SYS_ADMIN) && afterEffective.roleCodes.includes(ROLE_CODES.SYS_ADMIN)))) {
        throw new AuthorizationAdminError('cannot_self_escalate', 409);
      }
      const afterRoles = this._roleAssignmentsBySource(email, [...new Set([...replaceSources, 'MANUAL'])]);
      const version = this._targetVersion(email, context.actor);
      this._record({ context, target: email, changeType: 'USER_ROLES_REPLACED', objectType: 'USER_AUTHORIZATION', objectKey: email,
        before: { role_codes: beforeRoles, authz_version: beforeVersion },
        after: { role_codes: afterRoles, authz_version: version }, reason, authzVersion: version,
        eventName: 'user.authorization.changed', metadata: { target_user_id: email, change_type: 'ROLES_REPLACED' } });
      return this.userDetail(email);
    });
    try { return replace(); } finally { this.authorizationService.cache.delete(email); }
  }

  setUserRoles(userId, input, context) {
    return this._replaceUserRoles(userId, input, context, ['MANUAL']);
  }

  setImportedUserRoles(userId, input, context) {
    if (this._userEmail(userId) === this._userEmail(context.actorUserId || context.actor)) {
      throw new AuthorizationAdminError('cannot_self_escalate', 409);
    }
    return this._replaceUserRoles(userId, input, context, ['MANUAL', 'LEGACY_COMPAT']);
  }

  _normalizeScope(item, email) {
    const scopeType = String(item?.scopeType || '').trim().toUpperCase();
    const effect = String(item?.effect || 'ALLOW').trim().toUpperCase();
    if (!SCOPE_TYPES.includes(scopeType)) throw new AuthorizationAdminError('invalid_scope_type', 400);
    if (!['ALLOW', 'DENY'].includes(effect)) throw new AuthorizationAdminError('invalid_scope_effect', 400);
    let scopeValue = item.scopeValue == null ? null : String(item.scopeValue).trim();
    if (scopeType === 'GLOBAL') scopeValue = null;
    else if (!scopeValue) throw new AuthorizationAdminError('scope_value_required', 400);
    if (scopeType === 'MCH2' && !isCanonicalMch2Id(scopeValue)) throw new AuthorizationAdminError('invalid_mch2_id', 400);
    const roleCode = item.roleCode ? normalizeCode(item.roleCode, 'role_code') : null;
    let role = null;
    if (roleCode) {
      role = this._role(roleCode);
      if (!role) throw new AuthorizationAdminError('role_not_found', 404);
      if (!this.db.prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND active = 1`).get(email, role.id)) {
        throw new AuthorizationAdminError('scope_role_not_assigned', 409);
      }
    }
    const window = validityWindow(item.validFrom, item.validUntil);
    if (scopeType === 'CUSTOM') {
      const schemaCode = String(item.customSchemaCode || '').trim();
      const schemaVersion = Number(item.customSchemaVersion);
      if (!this.db.prepare(`SELECT 1 FROM custom_scope_schemas
        WHERE schema_code = ? AND version = ? AND active = 1`).get(schemaCode, schemaVersion)) {
        throw new AuthorizationAdminError('custom_scope_schema_not_found', 400);
      }
      return { scopeType, scopeValue, effect, role, roleCode, customSchemaCode: schemaCode, customSchemaVersion: schemaVersion, ...window };
    }
    return { scopeType, scopeValue, effect, role, roleCode, customSchemaCode: null, customSchemaVersion: null, ...window };
  }

  normalizeScopeAssignment(item, email) {
    return this._normalizeScope(item, normalizeEmail(email));
  }

  setUserScopes(userId, input, context) {
    const email = this._userEmail(userId);
    if (!Array.isArray(input.scopes)) throw new AuthorizationAdminError('scopes_required', 400);
    const reason = normalizeReason(input.reason);
    const scopes = input.scopes.map((item) => this._normalizeScope(item, email));
    const keys = scopes.map((scope) => `${scope.roleCode || ''}:${scope.scopeType}:${scope.scopeValue || ''}:${scope.effect}`);
    if (new Set(keys).size !== keys.length) throw new AuthorizationAdminError('duplicate_scope_assignment', 400);
    const before = this._manualUserSnapshot(email);
    if (scopes.some((scope) => scope.scopeType === 'GLOBAL' && scope.effect === 'ALLOW')
        || before.scopes.some((scope) => scope.active && scope.scope_type === 'GLOBAL' && scope.effect === 'ALLOW')) {
      requireExactConfirmation(input.confirmation, 'ASSIGN_SCOPE', email);
    }
    const beforeAllows = new Set(before.scopes.filter((scope) => scope.active && scope.effect === 'ALLOW')
      .map((scope) => `${scope.role_code || ''}:${scope.scope_type}:${scope.scope_value || ''}`));
    const replace = this.db.transaction(() => {
      this.db.prepare(`UPDATE user_scope_assignments SET active = 0
        WHERE user_id = ? AND source = 'MANUAL'`).run(email);
      const insert = this.db.prepare(`INSERT INTO user_scope_assignments
        (user_id, role_id, scope_type, scope_value, effect, active, valid_from, valid_until,
         custom_schema_code, custom_schema_version, source, created_by)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'MANUAL', ?)`);
      scopes.forEach((scope) => insert.run(email, scope.role?.id || null, scope.scopeType, scope.scopeValue,
        scope.effect, scope.validFrom, scope.validUntil, scope.customSchemaCode, scope.customSchemaVersion, context.actor || null));
      const after = this._manualUserSnapshot(email);
      const newAllows = after.scopes.filter((scope) => scope.active && scope.effect === 'ALLOW')
        .map((scope) => `${scope.role_code || ''}:${scope.scope_type}:${scope.scope_value || ''}`)
        .filter((key) => !beforeAllows.has(key));
      if (email === normalizeEmail(context.actor) && newAllows.length) throw new AuthorizationAdminError('cannot_self_escalate', 409);
      const version = this._targetVersion(email, context.actor);
      this._record({ context, target: email, changeType: 'USER_SCOPES_REPLACED', objectType: 'USER_AUTHORIZATION', objectKey: email,
        before: { scopes: before.scopes, authz_version: before.authz_version },
        after: { scopes: after.scopes, authz_version: version }, reason, authzVersion: version,
        eventName: 'user.authorization.changed', metadata: { target_user_id: email, change_type: 'SCOPES_REPLACED' } });
      return this.userDetail(email);
    });
    try { return replace(); } finally { this.authorizationService.cache.delete(email); }
  }

  saveUserAuthorization(userId, input, context) {
    const email = this._userEmail(userId);
    if (!Array.isArray(input.roles)) throw new AuthorizationAdminError('roles_required', 400);
    if (!Array.isArray(input.scopes)) throw new AuthorizationAdminError('scopes_required', 400);
    const before = this._manualUserSnapshot(email);
    if (input.expectedAuthzVersion != null
        && Number(input.expectedAuthzVersion) !== Number(before.authz_version)) {
      throw new AuthorizationAdminError('authz_version_conflict', 409, {
        expectedAuthzVersion: Number(input.expectedAuthzVersion),
        currentAuthzVersion: Number(before.authz_version),
      });
    }
    const desiredRoles = this._normalizeUserRoles(email, input);
    const comparableRoles = (rows) => rows
      .filter((row) => row.active === undefined || Boolean(row.active))
      .map((row) => [row.role_code || row.roleCode, row.valid_from || row.validFrom || '', row.valid_until || row.validUntil || ''])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const rolesChanged = JSON.stringify(comparableRoles(before.role_codes)) !== JSON.stringify(comparableRoles(desiredRoles));
    const save = this.db.transaction(() => {
      if (rolesChanged) {
        this.setUserRoles(email, {
          roles: input.roles,
          reason: input.reason,
          confirmation: input.roleConfirmation || input.confirmation,
        }, context);
      } else if (!this.authorizationService.effectivePermissions(email).roleCodes.length) {
        throw new AuthorizationAdminError('canonical_role_assignment_required', 409);
      }

      const normalizedScopes = input.scopes.map((item) => this._normalizeScope(item, email));
      const desired = normalizedScopes.map((scope) => ({
        role_code: scope.roleCode,
        scope_type: scope.scopeType,
        scope_value: scope.scopeValue,
        effect: scope.effect,
        active: 1,
        valid_from: scope.validFrom,
        valid_until: scope.validUntil,
        custom_schema_code: scope.customSchemaCode,
        custom_schema_version: scope.customSchemaVersion,
      }));
      const comparable = (rows) => rows
        .filter((row) => Boolean(row.active))
        .map((row) => [
          row.role_code || '', row.scope_type, row.scope_value || '', row.effect,
          row.valid_from || '', row.valid_until || '', row.custom_schema_code || '',
          row.custom_schema_version == null ? '' : Number(row.custom_schema_version),
        ])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      if (JSON.stringify(comparable(before.scopes)) !== JSON.stringify(comparable(desired))) {
        this.setUserScopes(email, {
          scopes: input.scopes,
          reason: input.reason,
          confirmation: input.scopeConfirmation || input.confirmation,
        }, context);
      }
      return this.userDetail(email);
    });
    try { return save(); } finally { this.authorizationService.cache.delete(email); }
  }

  upsertUserScope(userId, input, context) {
    const email = this._userEmail(userId);
    const reason = normalizeReason(input.reason);
    const scope = this._normalizeScope(input.scope || {}, email);
    if (scope.scopeType === 'GLOBAL' && scope.effect === 'ALLOW') {
      requireExactConfirmation(input.confirmation, 'ASSIGN_SCOPE', email);
    }
    const before = this._manualUserSnapshot(email);
    const beforeAllows = new Set(before.scopes.filter((item) => item.active && item.effect === 'ALLOW')
      .map((item) => `${item.role_code || ''}:${item.scope_type}:${item.scope_value || ''}`));
    const apply = this.db.transaction(() => {
      const protectedAssignment = this.db.prepare(`SELECT source FROM user_scope_assignments
        WHERE user_id = ? AND COALESCE(role_id, -1) = COALESCE(?, -1)
          AND scope_type = ? AND COALESCE(scope_value, '') = COALESCE(?, '')
          AND effect = ? AND active = 1 AND source <> 'MANUAL'
        ORDER BY id DESC LIMIT 1`).get(
        email, scope.role?.id || null, scope.scopeType, scope.scopeValue, scope.effect
      );
      if (protectedAssignment) {
        throw new AuthorizationAdminError('scope_source_conflict', 409, { source: protectedAssignment.source });
      }
      const existing = this.db.prepare(`SELECT id FROM user_scope_assignments
        WHERE user_id = ? AND COALESCE(role_id, -1) = COALESCE(?, -1)
          AND scope_type = ? AND COALESCE(scope_value, '') = COALESCE(?, '')
          AND effect = ? AND source = 'MANUAL'
        ORDER BY active DESC, id DESC LIMIT 1`).get(
        email, scope.role?.id || null, scope.scopeType, scope.scopeValue, scope.effect
      );
      if (existing) {
        this.db.prepare(`UPDATE user_scope_assignments SET active = 1, valid_from = ?, valid_until = ?,
          custom_schema_code = ?, custom_schema_version = ?, source = 'MANUAL'
          WHERE id = ?`).run(scope.validFrom, scope.validUntil, scope.customSchemaCode, scope.customSchemaVersion, existing.id);
      } else {
        this.db.prepare(`INSERT INTO user_scope_assignments
          (user_id, role_id, scope_type, scope_value, effect, active, valid_from, valid_until,
           custom_schema_code, custom_schema_version, source, created_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'MANUAL', ?)`).run(
          email, scope.role?.id || null, scope.scopeType, scope.scopeValue, scope.effect,
          scope.validFrom, scope.validUntil, scope.customSchemaCode, scope.customSchemaVersion, context.actor || null
        );
      }
      const after = this._manualUserSnapshot(email);
      const newAllows = after.scopes.filter((item) => item.active && item.effect === 'ALLOW')
        .map((item) => `${item.role_code || ''}:${item.scope_type}:${item.scope_value || ''}`)
        .filter((key) => !beforeAllows.has(key));
      if (email === normalizeEmail(context.actor) && newAllows.length) {
        throw new AuthorizationAdminError('cannot_self_escalate', 409);
      }
      const version = this._targetVersion(email, context.actor);
      this._record({ context, target: email, changeType: 'USER_SCOPE_UPSERTED', objectType: 'USER_AUTHORIZATION', objectKey: email,
        before: { scopes: before.scopes, authz_version: before.authz_version },
        after: { scopes: after.scopes, authz_version: version }, reason, authzVersion: version,
        eventName: 'user.authorization.changed', metadata: { target_user_id: email, change_type: 'SCOPE_UPSERTED' } });
      return this.userDetail(email);
    });
    try { return apply(); } finally { this.authorizationService.cache.delete(email); }
  }

  listApprovalAssignments() {
    return this.db.prepare(`SELECT asa.id, asa.workflow_type, asa.stage_code, r.role_code,
        asa.assigned_user_id, asa.assigned_principal_id, asa.scope_type, asa.scope_value, asa.custom_schema_code,
        asa.custom_schema_version, asa.priority, asa.active,
        asa.valid_from, asa.valid_until, asa.created_at
      FROM approval_stage_assignments asa LEFT JOIN roles r ON r.id = asa.role_id
      ORDER BY asa.workflow_type, asa.stage_code, asa.priority, asa.id`).all().map((row) => ({
      id: row.id,
      workflowType: row.workflow_type,
      stageCode: row.stage_code,
      roleCode: row.role_code,
      assignedUserId: row.assigned_user_id,
      assignedPrincipalId: row.assigned_principal_id,
      scopeType: row.scope_type,
      scopeValue: row.scope_value,
      customSchemaCode: row.custom_schema_code,
      customSchemaVersion: row.custom_schema_version,
      priority: row.priority,
      active: Boolean(row.active),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      createdAt: row.created_at,
    }));
  }

  _normalizeApproval(input) {
    const workflowType = String(input.workflowType || '').trim().toUpperCase();
    const stageCode = String(input.stageCode || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(workflowType) || !/^[A-Z][A-Z0-9_]{1,63}$/.test(stageCode)) {
      throw new AuthorizationAdminError('invalid_approval_stage', 400);
    }
    const roleCode = input.roleCode ? normalizeCode(input.roleCode, 'role_code') : null;
    const assignedUser = input.assignedPrincipalId || input.assignedUserId
      ? this._user(input.assignedPrincipalId || input.assignedUserId) : null;
    const assignedUserId = assignedUser?.email || null;
    const assignedPrincipalId = assignedUser?.user_id || null;
    if ((input.assignedPrincipalId || input.assignedUserId) && !assignedUser) {
      throw new AuthorizationAdminError('user_not_found', 404);
    }
    if (Boolean(roleCode) === Boolean(assignedUserId)) throw new AuthorizationAdminError('approval_subject_required', 400);
    const role = roleCode ? this._role(roleCode) : null;
    if (roleCode && (!role || !role.active)) throw new AuthorizationAdminError('role_not_found', 404);
    if (assignedUserId && !assignedUser.is_active) {
      throw new AuthorizationAdminError('user_not_found', 404);
    }
    const scopeType = String(input.scopeType || 'GLOBAL').trim().toUpperCase();
    if (!SCOPE_TYPES.includes(scopeType)) throw new AuthorizationAdminError('invalid_scope_type', 400);
    const scopeValue = scopeType === 'GLOBAL' ? null : String(input.scopeValue || '').trim();
    if (scopeType !== 'GLOBAL' && !scopeValue) throw new AuthorizationAdminError('scope_value_required', 400);
    if (scopeType === 'MCH2' && !isCanonicalMch2Id(scopeValue)) throw new AuthorizationAdminError('invalid_mch2_id', 400);
    let customSchemaCode = null;
    let customSchemaVersion = null;
    if (scopeType === 'CUSTOM') {
      customSchemaCode = String(input.customSchemaCode || '').trim();
      customSchemaVersion = Number(input.customSchemaVersion);
      if (!this.db.prepare(`SELECT 1 FROM custom_scope_schemas
        WHERE schema_code = ? AND version = ? AND active = 1`).get(customSchemaCode, customSchemaVersion)) {
        throw new AuthorizationAdminError('custom_scope_schema_not_found', 400);
      }
    }
    const priority = Number(input.priority ?? 100);
    if (!Number.isSafeInteger(priority) || priority < 1 || priority > 10000) throw new AuthorizationAdminError('invalid_priority', 400);
    const window = validityWindow(input.validFrom, input.validUntil);
    return { id: input.id == null ? null : Number(input.id), workflowType, stageCode, roleCode, role,
      assignedUserId, assignedPrincipalId, scopeType, scopeValue, customSchemaCode, customSchemaVersion,
      priority, active: input.active !== false, ...window };
  }

  previewApprovalAssignment(input) {
    const assignment = this._normalizeApproval(input);
    const fixture = input.fixture && typeof input.fixture === 'object' ? input.fixture : {};
    const probe = {
      scope_type: assignment.scopeType,
      scope_value: assignment.scopeValue,
      custom_schema_code: assignment.customSchemaCode,
      custom_schema_version: assignment.customSchemaVersion,
      effect: 'ALLOW',
    };
    let candidates = [];
    if (assignment.assignedUserId) {
      if (this.authorizationService._scopeMatches(probe, fixture, assignment.assignedUserId)
          && this.authorizationService.isInScope(assignment.assignedUserId, fixture)) candidates = [assignment.assignedUserId];
    } else {
      const now = this.authorizationService._now();
      candidates = this.db.prepare(`SELECT DISTINCT u.email FROM user_roles ur
        JOIN users u ON u.email = ur.user_id
        WHERE ur.role_id = ? AND ur.active = 1 AND u.is_active = 1
          AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
          AND (ur.valid_until IS NULL OR ur.valid_until > ?)
        ORDER BY u.email`).all(assignment.role.id, now, now).map((row) => row.email)
        .filter((email) => this.authorizationService._scopeMatches(probe, fixture, email))
        .filter((email) => this.authorizationService.isInScope(email, fixture));
    }
    const conflicts = this.db.prepare(`SELECT id FROM approval_stage_assignments
      WHERE workflow_type = ? AND stage_code = ? AND priority = ? AND active = 1
        AND scope_type = ? AND COALESCE(scope_value, '') = COALESCE(?, '')
        AND id != COALESCE(?, -1) ORDER BY id`).all(assignment.workflowType, assignment.stageCode,
      assignment.priority, assignment.scopeType, assignment.scopeValue, assignment.id).map((row) => row.id);
    return { assignment: { ...assignment, role: undefined }, candidates, conflicts,
      warnings: candidates.length ? [] : ['approval_candidate_missing'] };
  }

  _missingRequiredStages() {
    return REQUIRED_APPROVAL_STAGES.filter((stage) => !this.db.prepare(`SELECT 1 FROM approval_stage_assignments
      WHERE workflow_type = ? AND stage_code = ? AND active = 1
        AND (valid_until IS NULL OR valid_until > datetime('now'))`).get(stage.workflowType, stage.stageCode));
  }

  publishApprovalAssignment(input, context) {
    const reason = normalizeReason(input.reason);
    const normalized = this._normalizeApproval(input);
    const key = `${normalized.workflowType}:${normalized.stageCode}`;
    requireExactConfirmation(input.confirmation, 'PUBLISH_APPROVER', key);
    const preview = this.previewApprovalAssignment(input);
    if (normalized.active && preview.conflicts.length) throw new AuthorizationAdminError('approval_assignment_conflict', 409, { conflicts: preview.conflicts });
    if (normalized.active && !preview.candidates.length) throw new AuthorizationAdminError('approval_candidate_missing', 409);
    const publish = this.db.transaction(() => {
      let before = null;
      let assignmentId = normalized.id;
      if (assignmentId) {
        before = this.listApprovalAssignments().find((item) => item.id === assignmentId);
        if (!before) throw new AuthorizationAdminError('approval_assignment_not_found', 404);
        this.db.prepare(`UPDATE approval_stage_assignments SET workflow_type = ?, stage_code = ?, role_id = ?,
          assigned_user_id = ?, assigned_principal_id = ?, scope_type = ?, scope_value = ?, custom_schema_code = ?,
          custom_schema_version = ?, priority = ?, active = ?, valid_from = ?, valid_until = ? WHERE id = ?`).run(normalized.workflowType, normalized.stageCode,
          normalized.role?.id || null, normalized.assignedUserId, normalized.assignedPrincipalId, normalized.scopeType, normalized.scopeValue,
          normalized.customSchemaCode, normalized.customSchemaVersion, normalized.priority,
          normalized.active ? 1 : 0, normalized.validFrom, normalized.validUntil, assignmentId);
      } else {
        assignmentId = Number(this.db.prepare(`INSERT INTO approval_stage_assignments
          (workflow_type, stage_code, role_id, assigned_user_id, assigned_principal_id, scope_type, scope_value,
           custom_schema_code, custom_schema_version, priority, active, valid_from, valid_until, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(normalized.workflowType, normalized.stageCode,
          normalized.role?.id || null, normalized.assignedUserId, normalized.assignedPrincipalId, normalized.scopeType, normalized.scopeValue,
          normalized.customSchemaCode, normalized.customSchemaVersion, normalized.priority,
          normalized.active ? 1 : 0, normalized.validFrom, normalized.validUntil,
          context.actor || null).lastInsertRowid);
      }
      const missing = this._missingRequiredStages();
      if (missing.length) throw new AuthorizationAdminError('approval_stage_missing', 409, { missing });
      const after = this.listApprovalAssignments().find((item) => item.id === assignmentId);
      const version = this._actorVersion(context.actor);
      this._record({ context, changeType: 'APPROVAL_ASSIGNMENT_PUBLISHED', objectType: 'APPROVAL_ASSIGNMENT', objectKey: String(assignmentId),
        before, after, reason, authzVersion: version, eventName: 'approval.assignment.changed',
        metadata: { workflow_type: normalized.workflowType, stage_code: normalized.stageCode, reason } });
      return { item: after, preview };
    });
    return publish();
  }

  history(limit = 100) {
    const bounded = Math.max(1, Math.min(250, Number(limit) || 100));
    return this.db.prepare(`SELECT id, actor_user_id, target_user_id, actor_principal_id, target_principal_id, change_type, object_type,
        object_key, before_json, after_json, request_id, correlation_id, reason, authz_version, created_at
      FROM authz_change_log ORDER BY id DESC LIMIT ?`).all(bounded).map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      actorPrincipalId: row.actor_principal_id,
      targetPrincipalId: row.target_principal_id,
      changeType: row.change_type,
      objectType: row.object_type,
      objectKey: row.object_key,
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      requestId: row.request_id,
      correlationId: row.correlation_id,
      reason: row.reason,
      authzVersion: row.authz_version,
      createdAt: row.created_at,
    }));
  }

  _historyFilter(input = {}) {
    const search = sanitizeString(String(input.search || '').trim(), 200);
    const actor = String(input.actor || '').trim().toLowerCase();
    const changeType = String(input.changeType || input.change_type || '').trim().toUpperCase();
    const from = historyDate(input.from, 'from_date');
    const to = historyDate(input.to, 'to_date');
    if (from && to && to < from) throw new AuthorizationAdminError('invalid_date_range', 400);
    if (changeType && changeType !== 'ALL' && !/^[A-Z][A-Z0-9_]{1,127}$/.test(changeType)) {
      throw new AuthorizationAdminError('invalid_change_type', 400);
    }
    const clauses = [];
    const params = [];
    if (search) {
      const pattern = `%${search.toLowerCase()}%`;
      clauses.push(`(LOWER(COALESCE(actor_user_id, 'system')) LIKE ?
        OR LOWER(COALESCE(target_user_id, '')) LIKE ?
        OR LOWER(COALESCE(actor_principal_id, '')) LIKE ?
        OR LOWER(COALESCE(target_principal_id, '')) LIKE ?
        OR LOWER(change_type) LIKE ? OR LOWER(object_type) LIKE ?
        OR LOWER(COALESCE(object_key, '')) LIKE ? OR LOWER(COALESCE(reason, '')) LIKE ?
        OR LOWER(COALESCE(request_id, '')) LIKE ? OR LOWER(COALESCE(correlation_id, '')) LIKE ?)`);
      params.push(...Array(10).fill(pattern));
    }
    if (actor && actor !== 'all') {
      if (actor === 'system') clauses.push("(actor_user_id IS NULL OR TRIM(actor_user_id) = '')");
      else if (actor === 'manual') clauses.push("(actor_user_id IS NOT NULL AND TRIM(actor_user_id) <> '')");
      else {
        clauses.push(`(LOWER(actor_user_id) LIKE ?
          OR LOWER(COALESCE(actor_principal_id, '')) LIKE ?)`);
        params.push(`%${actor}%`, `%${actor}%`);
      }
    }
    if (changeType && changeType !== 'ALL') {
      clauses.push('change_type = ?');
      params.push(changeType);
    }
    if (from) { clauses.push('substr(created_at, 1, 10) >= ?'); params.push(from); }
    if (to) { clauses.push('substr(created_at, 1, 10) <= ?'); params.push(to); }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params,
      filters: { search, actor: actor || 'all', changeType: changeType || 'ALL', from, to } };
  }

  _historyRows(input = {}, limit = 250, offset = 0) {
    const filter = this._historyFilter(input);
    return this.db.prepare(`SELECT id, actor_user_id, target_user_id, actor_principal_id, target_principal_id, change_type, object_type,
        object_key, before_json, after_json, request_id, correlation_id, reason, authz_version, created_at
      FROM authz_change_log ${filter.where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(
      ...filter.params, limit, offset
    ).map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      actorPrincipalId: row.actor_principal_id,
      targetPrincipalId: row.target_principal_id,
      changeType: row.change_type,
      objectType: row.object_type,
      objectKey: row.object_key,
      before: parseJson(row.before_json),
      after: parseJson(row.after_json),
      requestId: row.request_id,
      correlationId: row.correlation_id,
      reason: row.reason,
      authzVersion: row.authz_version,
      createdAt: row.created_at,
    }));
  }

  historyPage(input = {}) {
    const page = positiveInteger(input.page, 1, 1000000, 'page');
    const pageSize = positiveInteger(input.pageSize || input.page_size || input.limit, 20, 250, 'page_size');
    const filter = this._historyFilter(input);
    const summary = this.db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN actor_user_id IS NULL OR TRIM(actor_user_id) = '' THEN 1 ELSE 0 END) AS system_count,
        SUM(CASE WHEN actor_user_id IS NOT NULL AND TRIM(actor_user_id) <> '' THEN 1 ELSE 0 END) AS manual_count,
        SUM(CASE WHEN reason IS NULL OR TRIM(reason) = '' THEN 1 ELSE 0 END) AS missing_reason_count
      FROM authz_change_log ${filter.where}`).get(...filter.params);
    const total = Number(summary.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const items = this._historyRows(input, pageSize, (safePage - 1) * pageSize);
    const changeTypes = this.db.prepare(`SELECT DISTINCT change_type FROM authz_change_log
      WHERE change_type IS NOT NULL AND TRIM(change_type) <> '' ORDER BY change_type`).all().map((row) => row.change_type);
    return {
      items,
      pagination: {
        page: safePage, pageSize, total, totalPages,
        hasPrevious: safePage > 1,
        hasNext: safePage < totalPages,
      },
      summary: {
        total,
        system: Number(summary.system_count || 0),
        manual: Number(summary.manual_count || 0),
        missingReason: Number(summary.missing_reason_count || 0),
      },
      filters: { ...filter.filters, changeTypes },
    };
  }

  exportWorkbook(input = {}, context = {}) {
    const history = this._historyRows(input, 10000, 0);
    const sheets = {
      Nguoi_dung: this.db.prepare(`SELECT user_id, email, display_name, is_active, authz_version, created_at
        FROM users ORDER BY email`).all(),
      Vai_tro_nguoi_dung: this.db.prepare(`SELECT ur.user_id AS email, r.role_code, ur.active,
          ur.valid_from, ur.valid_until, ur.source
        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        ORDER BY ur.user_id, r.role_code, ur.source`).all(),
      Pham_vi: this.db.prepare(`SELECT usa.user_id AS email, r.role_code, usa.scope_type,
          usa.scope_value, usa.effect, usa.active, usa.valid_from, usa.valid_until,
          usa.custom_schema_code, usa.custom_schema_version, usa.source
        FROM user_scope_assignments usa LEFT JOIN roles r ON r.id = usa.role_id
        ORDER BY usa.user_id, usa.scope_type, usa.scope_value, usa.effect`).all(),
      Vai_tro: this.db.prepare(`SELECT role_code, display_label, role_kind, active, created_at, updated_at
        FROM roles ORDER BY role_code`).all(),
      Quyen_vai_tro: this.db.prepare(`SELECT r.role_code, rp.permission_code, rp.effect
        FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        ORDER BY r.role_code, rp.permission_code, rp.effect`).all(),
      Lich_su: history.map((item) => ({
        id: item.id, created_at: item.createdAt, actor_user_id: item.actorUserId || 'system',
        target_user_id: item.targetUserId, change_type: item.changeType,
        object_type: item.objectType, object_key: item.objectKey,
        before: spreadsheetValue(item.before), after: spreadsheetValue(item.after),
        reason: item.reason, request_id: item.requestId, correlation_id: item.correlationId,
        authz_version: item.authzVersion,
      })),
    };
    const workbook = XLSX.utils.book_new();
    Object.entries(sheets).forEach(([name, rows]) => {
      const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ thong_bao: 'Không có dữ liệu' }]);
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    });
    const rowCount = Object.values(sheets).reduce((sum, rows) => sum + rows.length, 0);
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
    this.auditEventService.record({
      eventName: 'authz.exported', actorUserId: context.actor,
      entityType: 'AUTHORIZATION', action: 'EXPORT', outcome: 'SUCCESS',
      summary: 'Export authorization workbook', requestId: context.requestId,
      correlationId: context.correlationId,
      metadata: {
        export_format: 'XLSX', row_count: rowCount,
        filter_names: Object.entries(this._historyFilter(input).filters)
          .filter(([, value]) => value && value !== 'all' && value !== 'ALL').map(([key]) => key),
      },
    });
    return { buffer, rowCount };
  }
}

module.exports = {
  AuthorizationAdminError,
  AuthorizationAdminService,
  PERMISSION_DESCRIPTIONS,
  REQUIRED_APPROVAL_STAGES,
  permissionRisk,
  permissionScopes,
  normalizeEmail,
  normalizeReason,
  requireExactConfirmation,
  requiredConfirmation,
  validityWindow,
};
