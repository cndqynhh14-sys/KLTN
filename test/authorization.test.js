'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuthorizationService, AuthorizationError } = require('../server/services/AuthorizationService');
const { ApprovalAssignmentService } = require('../server/services/ApprovalAssignmentService');
const { PolicyService } = require('../server/services/PolicyService');
const { ROLE_CODES, PERMISSIONS, ACTIVE_PERMISSION_CODES } = require('../server/authorization/permissionCatalog');
const { ROLES } = require('../server/domain/roles');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'run-05-test' });
  const authz = new AuthorizationService(db);
  const approvals = new ApprovalAssignmentService(db, authz);
  return { db, authz, approvals };
}

function addUser(db, email, role = ROLES.SPECIALIST, isAdmin = false) {
  db.prepare(`INSERT INTO users
    (email, is_admin, role, is_active, display_name, created_at, created_by)
    VALUES (?, ?, ?, 1, 'SYNTHETIC RUN-05 USER', datetime('now'), 'fixture')`
  ).run(email, isAdmin ? 1 : 0, role);
}

function close(db) {
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
}

test('fresh seed has immutable policy keys and the supplier-evaluation authorization catalog', () => {
  const { db } = fixture();
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roles').get().n, 9);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n, ACTIVE_PERMISSION_CODES.length);
    assert.throws(
      () => db.prepare("UPDATE permissions SET permission_code = 'CHANGED' WHERE permission_code = 'REPORT.READ'").run(),
      /permission_code_immutable/
    );
    assert.throws(
      () => db.prepare("UPDATE roles SET role_code = 'CHANGED' WHERE role_code = 'SYS_ADMIN'").run(),
      /role_code_immutable/
    );
  } finally { close(db); }
});

test('legacy users map to stable role codes without exposing retired runtime permissions', () => {
  const { db, authz } = fixture();
  try {
    assert.equal(ACTIVE_PERMISSION_CODES.includes('UPLOAD.MANAGE'), false);
    assert.equal(ACTIVE_PERMISSION_CODES.some((code) => code.startsWith('INPUT_DOSSIER.')), false);
    const cases = [
      ['admin@example.invalid', ROLES.ADMIN, true, ROLE_CODES.SYS_ADMIN, PERMISSIONS.SYSTEM_ADMIN],
      ['specialist@example.invalid', ROLES.SPECIALIST, false, ROLE_CODES.QLCL_SPECIALIST, PERMISSIONS.EVALUATION_SCORE],
      ['lead@example.invalid', ROLES.LEAD, false, ROLE_CODES.REGIONAL_LEAD_APPROVER, PERMISSIONS.EVALUATION_APPROVE_LEAD],
      ['tbp@example.invalid', ROLES.TBP, false, ROLE_CODES.DEPARTMENT_HEAD_APPROVER, PERMISSIONS.EVALUATION_APPROVE_TBP],
      ['gdk@example.invalid', ROLES.GDK, false, ROLE_CODES.BLOCK_DIRECTOR_APPROVER, PERMISSIONS.EVALUATION_APPROVE_GDK],
      ['supplier@example.invalid', ROLES.SUPPLIER, false, ROLE_CODES.SUPPLIER_USER, PERMISSIONS.SUPPLIER_SELF_READ],
    ];
    for (const [email, role, isAdmin, roleCode, permission] of cases) {
      addUser(db, email, role, isAdmin);
      const identity = authz.syncLegacyUser(email);
      const effective = authz.effectivePermissions(email);
      assert.ok(identity.roleCodes.includes(roleCode));
      assert.equal(authz.can(email, permission), true);
      assert.equal(identity.role, role);
      assert.equal(
        effective.permissions.some((code) => code.startsWith('INPUT_DOSSIER.')),
        false,
        `${roleCode} effective permissions must be evaluation-only`
      );
      assert.equal(
        identity.capabilities.some((code) => code.startsWith('INPUT_DOSSIER.')),
        false,
        `${roleCode} session capabilities must be evaluation-only`
      );
      assert.equal(effective.permissions.includes('UPLOAD.MANAGE'), false);
      assert.equal(identity.capabilities.includes('UPLOAD.MANAGE'), false);
    }
  } finally { close(db); }
});

test('multiple roles combine ALLOW while DENY wins and invalidates cached decisions', () => {
  const { db, authz } = fixture();
  try {
    addUser(db, 'multi@example.invalid');
    authz.syncLegacyUser('multi@example.invalid');
    authz.assignRole({ userId: 'multi@example.invalid', roleCode: ROLE_CODES.AUDITOR });
    assert.equal(authz.can('multi@example.invalid', PERMISSIONS.AUDIT_READ), true);
    assert.equal(authz.can('multi@example.invalid', PERMISSIONS.REPORT_READ), true);
    const beforeVersion = db.prepare('SELECT authz_version FROM users WHERE email = ?').get('multi@example.invalid').authz_version;
    db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'DENY' FROM roles WHERE role_code = ?`).run(PERMISSIONS.REPORT_READ, ROLE_CODES.AUDITOR);
    const afterVersion = db.prepare('SELECT authz_version FROM users WHERE email = ?').get('multi@example.invalid').authz_version;
    assert.ok(afterVersion > beforeVersion);
    assert.equal(authz.can('multi@example.invalid', PERMISSIONS.REPORT_READ), false);
  } finally { close(db); }
});

test('scope evaluation supports every base type, strict MCH2 IDs and versioned CUSTOM', () => {
  const { db, authz } = fixture();
  try {
    addUser(db, 'scoped@example.invalid');
    authz.assignRole({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER });
    authz.assignScope({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER,
      scopeType: 'REGION', scopeValue: 'REGION_SOUTH' });
    authz.assignScope({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER,
      scopeType: 'MCH2', scopeValue: '203' });
    authz.assignScope({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER,
      scopeType: 'ASSIGNED', scopeValue: 'SELF' });
    authz.assignScope({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER,
      scopeType: 'OWN', scopeValue: 'SELF' });
    authz.assignScope({ userId: 'scoped@example.invalid', roleCode: ROLE_CODES.READ_ONLY_VIEWER,
      scopeType: 'SUPPLIER', scopeValue: 'SUP-0007' });
    assert.equal(authz.isInScope('scoped@example.invalid', { regionId: 'REGION_SOUTH' }), true);
    assert.equal(authz.isInScope('scoped@example.invalid', { mch2Id: '203' }), true);
    assert.equal(authz.isInScope('scoped@example.invalid', { assignedUserId: 'scoped@example.invalid' }), true);
    assert.equal(authz.isInScope('scoped@example.invalid', { ownerId: 'scoped@example.invalid' }), true);
    assert.equal(authz.isInScope('scoped@example.invalid', { supplierId: 'SUP-0007' }), true);
    assert.throws(() => authz.assignScope({ userId: 'scoped@example.invalid', scopeType: 'MCH2', scopeValue: 'Miền Nam' }),
      (error) => error instanceof AuthorizationError && error.code === 'invalid_mch2_id');

    db.prepare(`INSERT INTO custom_scope_schemas (schema_code, version, schema_json)
      VALUES ('PRODUCT_GROUP', 1, '{"type":"string"}')`).run();
    authz.registerCustomScopeValidator('PRODUCT_GROUP', 1, (value, context) => value === context.productGroup);
    authz.assignScope({ userId: 'scoped@example.invalid', scopeType: 'CUSTOM', scopeValue: 'FRESH',
      customSchemaCode: 'PRODUCT_GROUP', customSchemaVersion: 1 });
    assert.equal(authz.isInScope('scoped@example.invalid', { productGroup: 'FRESH' }), true);

    const visible = authz.applyScope('scoped@example.invalid', [
      { id: 1, regionId: 'REGION_SOUTH' }, { id: 2, regionId: 'REGION_NORTH' },
    ]);
    assert.deepEqual(visible.map((row) => row.id), [1]);
  } finally { close(db); }
});

test('expired roles are ignored and authorization changes revoke existing sessions', () => {
  const { db, authz } = fixture();
  try {
    addUser(db, 'expiry@example.invalid');
    authz.assignRole({ userId: 'expiry@example.invalid', roleCode: ROLE_CODES.AUDITOR,
      validFrom: '2025-01-01 00:00:00', validUntil: '2025-02-01 00:00:00' });
    assert.equal(authz.can('expiry@example.invalid', PERMISSIONS.AUDIT_READ), false);

    authz.syncLegacyUser('expiry@example.invalid');
    const session = authz.createSession('expiry@example.invalid', { ttlSeconds: 3600 });
    assert.equal(authz.resolveSession(session.sessionId, 'expiry@example.invalid', session.authzVersion).email,
      'expiry@example.invalid');
    authz.assignRole({ userId: 'expiry@example.invalid', roleCode: ROLE_CODES.DATA_UPLOADER });
    assert.throws(() => authz.resolveSession(session.sessionId, 'expiry@example.invalid', session.authzVersion),
      (error) => error instanceof AuthorizationError && error.code === 'invalid_session');
  } finally { close(db); }
});

test('last active SYS_ADMIN is protected at the database boundary', () => {
  const { db, authz } = fixture();
  try {
    addUser(db, 'admin-one@example.invalid', ROLES.ADMIN, true);
    authz.syncLegacyUser('admin-one@example.invalid');
    assert.throws(() => authz.revokeRole({ userId: 'admin-one@example.invalid', roleCode: ROLE_CODES.SYS_ADMIN }),
      /last_super_admin_required/);
    assert.throws(() => db.prepare('UPDATE users SET is_active = 0 WHERE email = ?').run('admin-one@example.invalid'),
      /last_super_admin_required/);
    assert.throws(() => db.prepare("UPDATE roles SET active = 0 WHERE role_code = 'SYS_ADMIN'").run(),
      /last_super_admin_required/);

    addUser(db, 'expired-admin@example.invalid');
    authz.assignRole({ userId: 'expired-admin@example.invalid', roleCode: ROLE_CODES.SYS_ADMIN,
      validFrom: '2025-01-01 00:00:00', validUntil: '2025-02-01 00:00:00' });
    assert.throws(() => authz.revokeRole({ userId: 'admin-one@example.invalid', roleCode: ROLE_CODES.SYS_ADMIN }),
      /last_super_admin_required/);

    addUser(db, 'admin-two@example.invalid', ROLES.ADMIN, true);
    authz.syncLegacyUser('admin-two@example.invalid');
    assert.equal(authz.revokeRole({ userId: 'admin-one@example.invalid', roleCode: ROLE_CODES.SYS_ADMIN }), 1);
  } finally { close(db); }
});

test('approval resolution and permission checks survive role display-label rename', () => {
  const { db, authz, approvals } = fixture();
  try {
    addUser(db, 'lead-approver@example.invalid', ROLES.LEAD);
    authz.syncLegacyUser('lead-approver@example.invalid');
    db.prepare(`UPDATE roles SET display_label = 'SYNTHETIC RENAMED LABEL'
      WHERE role_code = ?`).run(ROLE_CODES.REGIONAL_LEAD_APPROVER);
    assert.equal(authz.can('lead-approver@example.invalid', PERMISSIONS.EVALUATION_APPROVE_LEAD), true);
    const result = approvals.resolve('evaluation', 'lead', { regionId: 'ANY' });
    assert.equal(result.roleCode, ROLE_CODES.REGIONAL_LEAD_APPROVER);
    assert.deepEqual(result.candidates, ['lead-approver@example.invalid']);

    db.prepare(`INSERT INTO approval_stage_assignments
      (workflow_type, stage_code, role_id, scope_type, scope_value, priority)
      SELECT 'EVALUATION', 'LEAD_SCOPED', id, 'ASSIGNED', 'SELF', 1
      FROM roles WHERE role_code = ?`).run(ROLE_CODES.REGIONAL_LEAD_APPROVER);
    const scoped = approvals.resolve('EVALUATION', 'LEAD_SCOPED', {
      assignedUserId: 'lead-approver@example.invalid',
    });
    assert.deepEqual(scoped.candidates, ['lead-approver@example.invalid']);
    assert.throws(() => approvals.resolve('EVALUATION', 'LEAD_SCOPED', {
      assignedUserId: 'someone-else@example.invalid',
    }), (error) => error instanceof AuthorizationError && error.code === 'approval_assignment_not_found');
  } finally { close(db); }
});

test('role-based approval assignments ignore inactive roles', () => {
  const { db, authz, approvals } = fixture();
  try {
    addUser(db, 'inactive-role-approver@example.invalid', ROLES.LEAD);
    authz.syncLegacyUser('inactive-role-approver@example.invalid');
    db.prepare('UPDATE roles SET active = 0 WHERE role_code = ?')
      .run(ROLE_CODES.REGIONAL_LEAD_APPROVER);

    assert.equal(authz.can('inactive-role-approver@example.invalid', PERMISSIONS.EVALUATION_APPROVE_LEAD), false);
    assert.throws(
      () => approvals.resolve('EVALUATION', 'LEAD', {}),
      (error) => error instanceof AuthorizationError && error.code === 'approval_assignment_not_found'
    );
  } finally { close(db); }
});

test('explicit approval assignees require an active matching data scope', () => {
  const { db, authz, approvals } = fixture();
  try {
    for (const email of ['expired-scope@example.invalid', 'missing-scope@example.invalid']) {
      addUser(db, email, ROLES.TBP);
      authz.syncLegacyUser(email);
    }
    db.prepare(`UPDATE user_scope_assignments
      SET valid_until = '2000-01-01 00:00:00'
      WHERE user_id = 'expired-scope@example.invalid'`).run();
    db.prepare(`DELETE FROM user_scope_assignments
      WHERE user_id = 'missing-scope@example.invalid'`).run();
    db.prepare(`INSERT INTO approval_stage_assignments
      (workflow_type, stage_code, assigned_user_id, scope_type, priority)
      VALUES ('EVALUATION', 'EXPLICIT_EXPIRED', 'expired-scope@example.invalid', 'GLOBAL', 1),
             ('EVALUATION', 'EXPLICIT_MISSING', 'missing-scope@example.invalid', 'GLOBAL', 1)`).run();

    for (const stage of ['EXPLICIT_EXPIRED', 'EXPLICIT_MISSING']) {
      assert.throws(
        () => approvals.resolve('EVALUATION', stage, {}),
        (error) => error instanceof AuthorizationError && error.code === 'approval_assignment_not_found'
      );
    }
  } finally { close(db); }
});

test('shared policy keeps evaluation scope, allowed actions and approval errors consistent', () => {
  const { db, authz, approvals } = fixture();
  const policy = new PolicyService(authz, approvals);
  try {
    addUser(db, 'specialist-a@example.invalid', ROLES.SPECIALIST);
    addUser(db, 'specialist-b@example.invalid', ROLES.SPECIALIST);
    addUser(db, 'tbp-policy@example.invalid', ROLES.TBP);
    const specialist = authz.syncLegacyUser('specialist-a@example.invalid');
    authz.syncLegacyUser('specialist-b@example.invalid');
    const tbp = authz.syncLegacyUser('tbp-policy@example.invalid');

    assert.equal(policy.decision(specialist, PERMISSIONS.EVALUATION_READ, {
      context: { ownerId: specialist.email },
    }).allowed, true);
    assert.deepEqual(policy.decision(specialist, PERMISSIONS.EVALUATION_READ, {
      context: { ownerId: 'specialist-b@example.invalid' },
    }), { allowed: false, reason: 'forbidden_scope' });

    const draftEvaluationActions = policy.actionEnvelope('EVALUATION', {
      current_status: 'Khởi tạo', created_by: specialist.email,
    }, specialist);
    assert.equal(draftEvaluationActions.allowed_actions.includes('view'), true);
    assert.equal(draftEvaluationActions.allowed_actions.includes('edit'), true);
    assert.equal(draftEvaluationActions.allowed_actions.includes('score'), true);
    assert.equal(draftEvaluationActions.allowed_actions.includes('delete'), true);

    for (const currentStatus of ['Chờ khắc phục', 'Chờ duyệt (Lead)', 'Hoàn thành', 'Hủy']) {
      const stateActions = policy.actionEnvelope('EVALUATION', {
        current_status: currentStatus, created_by: specialist.email,
      }, specialist);
      assert.equal(stateActions.allowed_actions.includes('score'), false, currentStatus);
      assert.equal(stateActions.allowed_actions.includes('edit'), false, currentStatus);
      assert.equal(stateActions.allowed_actions.includes('delete'), false, currentStatus);
      assert.equal(stateActions.allowed_actions.includes('view'), true, currentStatus);
    }

  } finally { close(db); }
});
