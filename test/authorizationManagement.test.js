'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuditEventService } = require('../server/services/AuditEventService');
const { AuthorizationService } = require('../server/services/AuthorizationService');
const { ApprovalAssignmentService } = require('../server/services/ApprovalAssignmentService');
const {
  AuthorizationAdminError,
  AuthorizationAdminService,
  requiredConfirmation,
} = require('../server/services/AuthorizationAdminService');
const { createAuthorizationAdminRouter } = require('../server/routes/authorizationAdmin');
const { PERMISSIONS, ROLE_CODES, LEGACY_ROLE_TO_CODE } = require('../server/authorization/permissionCatalog');
const { ROLES } = require('../server/domain/roles');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const ACTOR = 'run10-admin@example.invalid';
const TARGET = 'run10-designer@example.invalid';

function addUser(db, email, role = ROLES.SPECIALIST, isAdmin = false) {
  const roleCode = isAdmin ? ROLE_CODES.SYS_ADMIN : LEGACY_ROLE_TO_CODE[role];
  upsertCanonicalUser(db, {
    email, roleCode, displayName: 'SYNTHETIC RUN-10 USER', createdBy: 'fixture',
  });
  const scopes = roleCode === ROLE_CODES.QLCL_SPECIALIST
    ? [['OWN', 'SELF'], ['ASSIGNED', 'SELF']]
    : [['GLOBAL', null]];
  for (const [scopeType, scopeValue] of scopes) {
    db.prepare(`INSERT INTO user_scope_assignments
      (user_id, role_id, scope_type, scope_value, effect, source)
      SELECT ?, id, ?, ?, 'ALLOW', 'MANUAL' FROM roles WHERE role_code = ?`
    ).run(email, scopeType, scopeValue, roleCode);
  }
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'run-10-test' });
  addUser(db, ACTOR, ROLES.ADMIN, true);
  addUser(db, TARGET);
  const audit = new AuditEventService(db);
  const authz = new AuthorizationService(db, { auditEventService: audit });
  const approvals = new ApprovalAssignmentService(db, authz);
  authz.syncLegacyUser(ACTOR);
  authz.syncLegacyUser(TARGET);
  const service = new AuthorizationAdminService(db, authz, approvals, audit);
  return { db, audit, authz, approvals, service };
}

function context(actor = ACTOR) {
  return {
    actor,
    requestId: 'request-run10-0001',
    correlationId: 'correlation-run10-0001',
  };
}

function close(db) {
  assert.equal(db.pragma('foreign_key_check').length, 0);
  db.close();
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('custom report designer can be created, configured and assigned without code changes', () => {
  const { db, authz, service } = fixture();
  try {
    service.createRole({
      roleCode: 'REPORT_DESIGNER',
      displayLabel: 'Thiết kế báo cáo',
      cloneFrom: ROLE_CODES.READ_ONLY_VIEWER,
      reason: 'Create the approved synthetic report designer role',
    }, context());
    service.setRolePermissions('REPORT_DESIGNER', {
      permissions: [
        { permissionCode: PERMISSIONS.REPORT_READ, effect: 'ALLOW' },
        { permissionCode: PERMISSIONS.REPORT_EXPORT, effect: 'ALLOW' },
        { permissionCode: PERMISSIONS.REPORT_TEMPLATE_MANAGE, effect: 'ALLOW' },
      ],
      reason: 'Publish approved report design and export permissions',
      confirmation: requiredConfirmation('PUBLISH_ROLE', 'REPORT_DESIGNER'),
    }, context());
    service.setUserRoles(TARGET, {
      roles: [
        { roleCode: ROLE_CODES.QLCL_SPECIALIST, validFrom: null, validUntil: null },
        { roleCode: 'REPORT_DESIGNER', validFrom: null, validUntil: null },
      ],
      reason: 'Assign the synthetic report designer role to the test account',
      confirmation: requiredConfirmation('ASSIGN_ROLES', TARGET),
    }, context());

    const catalogRole = service.catalog().roles.find((role) => role.roleCode === 'REPORT_DESIGNER');
    assert.equal(catalogRole.kind, 'custom');
    assert.equal(catalogRole.userCount, 1);
    assert.equal(catalogRole.permissionCount, 3);
    assert.equal(authz.can(TARGET, PERMISSIONS.REPORT_TEMPLATE_MANAGE), true);
    assert.equal(authz.can(TARGET, PERMISSIONS.REPORT_EXPORT), true);

    const changes = db.prepare(`SELECT reason, before_json, after_json, request_id,
      correlation_id, authz_version FROM authz_change_log
      WHERE actor_user_id = ? ORDER BY id`).all(ACTOR);
    assert.ok(changes.length >= 3);
    assert.ok(changes.every((row) => row.reason && row.request_id && row.correlation_id));
    assert.ok(changes.some((row) => row.before_json && row.after_json && row.authz_version >= 1));
    assert.ok(db.prepare(`SELECT 1 FROM audit_events
      WHERE event_name = 'role.permissions.changed' AND correlation_id = ?`).get('correlation-run10-0001'));
  } finally { close(db); }
});

test('role label rename preserves immutable code and approval workflow resolution', () => {
  const { db, approvals, service } = fixture();
  try {
    addUser(db, 'run10-lead@example.invalid', ROLES.LEAD);
    service.authorizationService.syncLegacyUser('run10-lead@example.invalid');
    service.updateRole(ROLE_CODES.REGIONAL_LEAD_APPROVER, {
      displayLabel: 'Lead vùng — nhãn mới',
      active: true,
      reason: 'Rename the display label while preserving the workflow key',
    }, context());
    const renamed = service.catalog().roles.find((role) => role.roleCode === ROLE_CODES.REGIONAL_LEAD_APPROVER);
    assert.equal(renamed.displayLabel, 'Lead vùng — nhãn mới');
    assert.equal(renamed.approvalCount, 1);
    assert.equal(renamed.inUse, true);
    assert.equal(approvals.resolve('EVALUATION', 'LEAD', {}).roleCode, ROLE_CODES.REGIONAL_LEAD_APPROVER);
    assert.throws(() => db.prepare(`UPDATE roles SET role_code = 'BROKEN'
      WHERE role_code = ?`).run(ROLE_CODES.REGIONAL_LEAD_APPROVER), /role_code_immutable/);
    assert.throws(() => service.deleteRole(ROLE_CODES.SYS_ADMIN, {
      reason: 'Attempt to delete a protected system role in a synthetic test',
      confirmation: requiredConfirmation('DELETE_ROLE', ROLE_CODES.SYS_ADMIN),
    }, context()), (error) => error.code === 'system_role_delete_forbidden');
  } finally { close(db); }
});

test('role catalog keeps inactive historical assignments in the deletion guard', () => {
  const { db, service } = fixture();
  try {
    service.createRole({
      roleCode: 'RUN10_ARCHIVED_ASSIGNMENT',
      displayLabel: 'Synthetic archived assignment role',
      reason: 'Create a role used only by an inactive historical assignment',
    }, context());
    const role = db.prepare('SELECT id FROM roles WHERE role_code = ?').get('RUN10_ARCHIVED_ASSIGNMENT');
    db.prepare(`INSERT INTO user_roles (user_id, role_id, active, source, created_by)
      VALUES (?, ?, 0, 'MANUAL', ?)`).run(TARGET, role.id, ACTOR);

    const catalogRole = service.catalog().roles.find((item) => item.roleCode === 'RUN10_ARCHIVED_ASSIGNMENT');
    assert.equal(catalogRole.userCount, 0);
    assert.equal(catalogRole.assignmentCount, 1);
    assert.equal(catalogRole.approvalCount, 0);
    assert.equal(catalogRole.inUse, true);
    assert.throws(() => service.deleteRole('RUN10_ARCHIVED_ASSIGNMENT', {
      reason: 'Reject deletion while a historical assignment still references the role',
      confirmation: requiredConfirmation('DELETE_ROLE', 'RUN10_ARCHIVED_ASSIGNMENT'),
    }, context()), (error) => error.code === 'role_in_use');
  } finally { close(db); }
});

test('effective-rights preview explains expiry, permission deny and scope conflict', () => {
  const { db, service } = fixture();
  try {
    service.createRole({
      roleCode: 'RUN10_CONFLICT_ROLE', displayLabel: 'Synthetic conflict role',
      reason: 'Create a synthetic conflict role for deterministic tests',
    }, context());
    service.setRolePermissions('RUN10_CONFLICT_ROLE', {
      permissions: [
        { permissionCode: PERMISSIONS.REPORT_READ, effect: 'ALLOW' },
        { permissionCode: PERMISSIONS.REPORT_EXPORT, effect: 'DENY' },
      ],
      reason: 'Publish an explicit report export deny for conflict testing',
      confirmation: requiredConfirmation('PUBLISH_ROLE', 'RUN10_CONFLICT_ROLE'),
    }, context());
    service.setUserRoles(TARGET, {
      roles: [
        { roleCode: ROLE_CODES.QLCL_SPECIALIST, validFrom: null, validUntil: null },
        { roleCode: 'RUN10_CONFLICT_ROLE', validFrom: null, validUntil: null },
        { roleCode: ROLE_CODES.AUDITOR, validFrom: '2020-01-01T00:00:00Z', validUntil: '2020-01-02T00:00:00Z' },
      ],
      reason: 'Assign active and expired synthetic roles for preview testing',
      confirmation: requiredConfirmation('ASSIGN_ROLES', TARGET),
    }, context());
    service.setUserScopes(TARGET, {
      scopes: [
        { roleCode: 'RUN10_CONFLICT_ROLE', scopeType: 'MCH2', scopeValue: '203', effect: 'ALLOW' },
        { roleCode: null, scopeType: 'MCH2', scopeValue: '203', effect: 'DENY' },
      ],
      reason: 'Create deterministic allow and deny scope overlap for preview',
    }, context());

    const detail = service.userDetail(TARGET);
    assert.ok(detail.effective.deniedPermissions.includes(PERMISSIONS.REPORT_EXPORT));
    assert.ok(detail.effective.explanations.some((item) => item.type === 'permission_conflict'));
    assert.ok(detail.effective.explanations.some((item) => item.type === 'expired_role'));
    assert.ok(detail.effective.explanations.some((item) => item.type === 'scope_conflict'));
  } finally { close(db); }
});

test('self escalation and last SYS_ADMIN removal fail closed', () => {
  const { db, service } = fixture();
  try {
    addUser(db, 'run10-manager@example.invalid');
    service.authorizationService.syncLegacyUser('run10-manager@example.invalid');
    db.prepare(`INSERT INTO roles (role_code, display_label, role_kind)
      VALUES ('RUN10_MANAGER', 'Synthetic authorization manager', 'FUNCTIONAL')`).run();
    db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'ALLOW' FROM roles WHERE role_code = 'RUN10_MANAGER'`).run(PERMISSIONS.USER_MANAGE);
    db.prepare(`INSERT INTO user_roles (user_id, role_id, source)
      SELECT ?, id, 'MANUAL' FROM roles WHERE role_code = 'RUN10_MANAGER'`).run('run10-manager@example.invalid');

    assert.throws(() => service.setUserRoles('run10-manager@example.invalid', {
      roles: [{ roleCode: ROLE_CODES.SYS_ADMIN }],
      reason: 'Attempt a prohibited self assignment to system administrator',
      confirmation: requiredConfirmation('ASSIGN_ROLES', 'run10-manager@example.invalid'),
    }, context('run10-manager@example.invalid')), (error) =>
      error instanceof AuthorizationAdminError && error.code === 'cannot_self_escalate');

    assert.throws(() => service.updateRole(ROLE_CODES.SYS_ADMIN, {
      displayLabel: 'System administrator', active: false,
      reason: 'Attempt to disable the final active system administrator role',
      confirmation: requiredConfirmation('PUBLISH_ROLE', ROLE_CODES.SYS_ADMIN),
    }, context()), /last_super_admin_required/);
  } finally { close(db); }
});

test('approval preview and publish reject missing or conflicting approvers', () => {
  const { db, service } = fixture();
  try {
    addUser(db, 'run10-no-scope@example.invalid', ROLES.TBP);
    service.authorizationService.syncLegacyUser('run10-no-scope@example.invalid');
    db.prepare(`UPDATE user_scope_assignments SET active = 0
      WHERE user_id = 'run10-no-scope@example.invalid'`).run();
    const input = {
      workflowType: 'EVALUATION', stageCode: 'TBP', assignedUserId: 'run10-no-scope@example.invalid',
      scopeType: 'GLOBAL', scopeValue: null, priority: 10,
      fixture: { regionId: 'REGION_SYNTHETIC', mch2Id: '203' },
    };
    assert.deepEqual(service.previewApprovalAssignment(input).candidates, []);
    assert.throws(() => service.publishApprovalAssignment({
      ...input,
      reason: 'Publish should fail because the explicit approver has no active scope',
      confirmation: requiredConfirmation('PUBLISH_APPROVER', 'EVALUATION:TBP'),
    }, context()), (error) => error.code === 'approval_candidate_missing');

    assert.throws(() => service.publishApprovalAssignment({
      workflowType: 'EVALUATION', stageCode: 'LEAD', roleCode: ROLE_CODES.REGIONAL_LEAD_APPROVER,
      scopeType: 'GLOBAL', scopeValue: null, priority: 100, fixture: {},
      reason: 'Publish should fail because the same stage priority already exists',
      confirmation: requiredConfirmation('PUBLISH_APPROVER', 'EVALUATION:LEAD'),
    }, context()), (error) => error.code === 'approval_assignment_conflict');

    const seededLead = service.listApprovalAssignments().find((item) =>
      item.workflowType === 'EVALUATION' && item.stageCode === 'LEAD');
    assert.throws(() => service.publishApprovalAssignment({
      ...seededLead,
      roleCode: seededLead.roleCode,
      active: false,
      fixture: {},
      reason: 'Attempt to remove the final configured approver for a required stage',
      confirmation: requiredConfirmation('PUBLISH_APPROVER', 'EVALUATION:LEAD'),
    }, context()), (error) => error.code === 'approval_stage_missing');
  } finally { close(db); }
});

test('valid approval assignment publishes its fixture preview and audit record', () => {
  const { db, service } = fixture();
  try {
    const input = {
      workflowType: 'EVALUATION', stageCode: 'LEAD', assignedUserId: ACTOR,
      scopeType: 'GLOBAL', scopeValue: null, priority: 50, fixture: {},
    };
    assert.deepEqual(service.previewApprovalAssignment(input).candidates, [ACTOR]);

    const published = service.publishApprovalAssignment({
      ...input,
      reason: 'Publish a deterministic explicit approver for the RUN-10 fixture',
      confirmation: requiredConfirmation('PUBLISH_APPROVER', 'EVALUATION:LEAD'),
    }, context());

    assert.equal(published.item.assignedUserId, ACTOR);
    assert.deepEqual(published.preview.candidates, [ACTOR]);
    assert.ok(db.prepare(`SELECT 1 FROM audit_events
      WHERE event_name = 'approval.assignment.changed' AND correlation_id = ?`)
      .get('correlation-run10-0001'));
  } finally { close(db); }
});

test('Phase 2 user authorization save is atomic across roles and scopes', () => {
  const { db, service } = fixture();
  try {
    const rolesBefore = db.prepare(`SELECT r.role_code, ur.active, ur.source
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.role_code`).all(TARGET);
    const historyBefore = db.prepare('SELECT COUNT(*) AS count FROM authz_change_log').get().count;
    const auditBefore = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;

    assert.throws(() => service.saveUserAuthorization(TARGET, {
      roles: [
        { roleCode: ROLE_CODES.QLCL_SPECIALIST },
        { roleCode: ROLE_CODES.READ_ONLY_VIEWER },
      ],
      scopes: [{ roleCode: ROLE_CODES.READ_ONLY_VIEWER, scopeType: 'MCH2', scopeValue: 'not-canonical', effect: 'ALLOW' }],
      reason: 'Reject an invalid scope without partially changing assigned roles',
      roleConfirmation: requiredConfirmation('ASSIGN_ROLES', TARGET),
      expectedAuthzVersion: service.userDetail(TARGET).user.authzVersion,
    }, context()), (error) => error.code === 'invalid_mch2_id');

    assert.deepEqual(db.prepare(`SELECT r.role_code, ur.active, ur.source
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.role_code`).all(TARGET), rolesBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authz_change_log').get().count, historyBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, auditBefore);

    const saved = service.saveUserAuthorization(TARGET, {
      roles: [
        { roleCode: ROLE_CODES.QLCL_SPECIALIST },
        { roleCode: ROLE_CODES.READ_ONLY_VIEWER },
      ],
      scopes: [{ roleCode: ROLE_CODES.READ_ONLY_VIEWER, scopeType: 'REGION', scopeValue: 'MB', effect: 'ALLOW' }],
      reason: 'Save the approved Phase 2 roles and scopes as one transaction',
      roleConfirmation: requiredConfirmation('ASSIGN_ROLES', TARGET),
      expectedAuthzVersion: service.userDetail(TARGET).user.authzVersion,
    }, context());
    assert.deepEqual(saved.roles.filter((item) => item.source === 'MANUAL' && item.active)
      .map((item) => item.roleCode).sort(), [ROLE_CODES.QLCL_SPECIALIST, ROLE_CODES.READ_ONLY_VIEWER].sort());
    assert.deepEqual(saved.scopes.filter((item) => item.source === 'MANUAL' && item.active)
      .map((item) => [item.roleCode, item.scopeType, item.scopeValue, item.effect]),
    [[ROLE_CODES.READ_ONLY_VIEWER, 'REGION', 'MB', 'ALLOW']]);

    const scopeOnlySave = service.saveUserAuthorization(TARGET, {
      roles: [
        { roleCode: ROLE_CODES.QLCL_SPECIALIST },
        { roleCode: ROLE_CODES.READ_ONLY_VIEWER },
      ],
      scopes: [{ roleCode: ROLE_CODES.READ_ONLY_VIEWER, scopeType: 'REGION', scopeValue: 'MN', effect: 'ALLOW' }],
      reason: 'Update scopes atomically without republishing unchanged roles',
      expectedAuthzVersion: saved.user.authzVersion,
    }, context());
    assert.deepEqual(scopeOnlySave.scopes.filter((item) => item.source === 'MANUAL' && item.active)
      .map((item) => item.scopeValue), ['MN']);

    assert.throws(() => service.saveUserAuthorization(TARGET, {
      roles: [{ roleCode: ROLE_CODES.QLCL_SPECIALIST }], scopes: [],
      reason: 'Reject a stale authorization editor without overwriting a newer save',
      expectedAuthzVersion: 1,
    }, context()), (error) => error.code === 'authz_version_conflict');
  } finally { close(db); }
});

test('Phase 2 role configuration save rolls back metadata when permissions fail', () => {
  const { db, service } = fixture();
  try {
    service.createRole({
      roleCode: 'PHASE2_ATOMIC_ROLE', displayLabel: 'Phase 2 original role',
      reason: 'Create a synthetic role for atomic configuration verification',
    }, context());
    const historyBefore = db.prepare('SELECT COUNT(*) AS count FROM authz_change_log').get().count;
    assert.throws(() => service.saveRoleConfiguration('PHASE2_ATOMIC_ROLE', {
      displayLabel: 'This label must roll back', active: true,
      permissions: [{ permissionCode: 'UNKNOWN.PERMISSION', effect: 'ALLOW' }],
      reason: 'Reject an invalid permission without changing role metadata',
    }, context()), (error) => error.code === 'permission_not_found');
    assert.equal(service.roleDetail('PHASE2_ATOMIC_ROLE').display_label, 'Phase 2 original role');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authz_change_log').get().count, historyBefore);

    const saved = service.saveRoleConfiguration('PHASE2_ATOMIC_ROLE', {
      displayLabel: 'Phase 2 configured role', active: true,
      permissions: [{ permissionCode: PERMISSIONS.REPORT_READ, effect: 'ALLOW' }],
      reason: 'Publish role metadata and permissions in one transaction',
    }, context());
    assert.equal(saved.display_label, 'Phase 2 configured role');
    assert.deepEqual(saved.permissions, [{ permission_code: PERMISSIONS.REPORT_READ, effect: 'ALLOW' }]);
  } finally { close(db); }
});

test('Phase 2 history uses server filters and pagination and export produces an audited XLSX', () => {
  const { db, service } = fixture();
  try {
    const insert = db.prepare(`INSERT INTO authz_change_log
      (actor_user_id, target_user_id, change_type, object_type, object_key, reason, authz_version, created_at)
      VALUES (?, ?, ?, 'USER_AUTHORIZATION', ?, ?, 7, ?)`);
    insert.run(ACTOR, TARGET, 'USER_ROLES_REPLACED', 'phase2-january', 'January manual update', '2026-01-15 08:00:00');
    insert.run(null, TARGET, 'MIGRATION_APPLIED', 'phase2-february', null, '2026-02-15 08:00:00');
    insert.run(ACTOR, TARGET, 'USER_SCOPES_REPLACED', 'phase2-march', 'March manual update', '2026-03-15 08:00:00');

    const first = service.historyPage({ search: 'phase2', actor: 'manual', page: 1, pageSize: 1 });
    assert.equal(first.pagination.total, 2);
    assert.equal(first.pagination.totalPages, 2);
    assert.equal(first.pagination.hasNext, true);
    const second = service.historyPage({ search: 'phase2', actor: 'manual', page: 2, pageSize: 1 });
    assert.notEqual(second.items[0].id, first.items[0].id);
    const january = service.historyPage({ from: '2026-01-01', to: '2026-01-31', pageSize: 20 });
    assert.deepEqual(january.items.map((item) => item.objectKey), ['phase2-january']);
    const system = service.historyPage({ search: 'phase2', actor: 'system', changeType: 'MIGRATION_APPLIED' });
    assert.equal(system.pagination.total, 1);
    assert.equal(system.summary.system, 1);

    const exported = service.exportWorkbook({ search: 'phase2' }, context());
    assert.ok(Buffer.isBuffer(exported.buffer));
    assert.ok(exported.rowCount >= 3);
    const workbook = XLSX.read(exported.buffer, { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, [
      'Nguoi_dung', 'Vai_tro_nguoi_dung', 'Pham_vi', 'Vai_tro', 'Quyen_vai_tro', 'Lich_su',
    ]);
    const exportedHistory = XLSX.utils.sheet_to_json(workbook.Sheets.Lich_su);
    assert.equal(exportedHistory.length, 3);
    assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE event_name = 'authz.exported'").get());
  } finally { close(db); }
});

test('authorization management API denies unauthorized reads and self-escalation', async () => {
  const { db, service } = fixture();
  try {
    const deniedApp = express();
    deniedApp.use(express.json());
    deniedApp.use('/admin/authorization', createAuthorizationAdminRouter({
      service,
      authenticate: (req, res, next) => { req.user = { email: TARGET }; next(); },
      authorize: (req, res) => res.status(403).json({ error: 'forbidden_permission' }),
    }));
    await withServer(deniedApp, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/admin/authorization/catalog`);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error, 'forbidden_permission');
    });

    const managerApp = express();
    managerApp.use(express.json());
    managerApp.use((req, res, next) => {
      req.requestId = 'request-run10-http-0001';
      req.correlationId = 'correlation-run10-http-0001';
      next();
    });
    managerApp.use('/admin/authorization', createAuthorizationAdminRouter({
      service,
      authenticate: (req, res, next) => { req.user = { email: TARGET }; next(); },
      authorize: (req, res, next) => next(),
    }));
    await withServer(managerApp, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/admin/authorization/users/${encodeURIComponent(TARGET)}/roles`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roles: [{ roleCode: ROLE_CODES.SYS_ADMIN }],
          reason: 'Attempt prohibited self escalation over the direct HTTP API',
          confirmation: requiredConfirmation('ASSIGN_ROLES', TARGET),
        }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'cannot_self_escalate');
    });
  } finally { close(db); }
});

test('authorization admin UI exposes IA, master-detail, safety and responsive states', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'tailwind.css'), 'utf8');
  for (const label of ['Nhân sự', 'Vai trò', 'Người phê duyệt', 'Lịch sử thay đổi']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /data-testid="authorization-admin"/);
  assert.match(html, /authz-master-detail/);
  assert.match(html, /authz-sticky-save/);
  assert.match(html, /authz-admin-state/);
  assert.match(html, /aria-live="polite"/);
  assert.match(app, /beforeunload/);
  assert.match(app, /authzUnsaved/);
  assert.match(app, /requiredConfirmation/);
  assert.match(css, /authz-master-detail/);
  assert.match(css, /@media[^{}]*max-width[^{}]*\{[\s\S]*authz-master-detail/);
});

test('authorization workspace exposes user filters, effective-rights sources and permission preview controls', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'tailwind.css'), 'utf8');

  for (const id of [
    'authz-user-search',
    'authz-user-active-filter',
    'authz-user-role-filter',
    'authz-user-health-filter',
    'authz-user-filter-summary',
    'authz-permission-search',
    'authz-permission-effect-filter',
    'authz-permission-preview',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(app, /authzUserDetails/);
  assert.match(app, /permission_conflict/);
  assert.match(app, /expired_role/);
  assert.match(app, /deniedPermissions/);
  assert.match(app, /effective\.sources/);
  assert.match(app, /DENY_WINS/);
  assert.match(app, /confirmAuthzRouteLeave/);
  assert.match(css, /authz-filter-bar/);
  assert.match(css, /authz-effective-columns/);
  assert.match(css, /\.authz-filter-bar\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.authz-choice-row\s*>\s*\.authz-role-meta\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.authz-summary-chip\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.authz-source-row\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /#authz-user-detail-title,\s*#authz-user-detail-sub\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('authorization UI preserves dual permission effects and guards mutations with reasons', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  assert.match(html, /id="authz-permission-effect-filter"[\s\S]*?<option value="ALLOW_DENY">Cho phép \+ Từ chối<\/option>/);
  assert.match(html, /id="new-user-reason"[^>]*minlength="8"[^>]*maxlength="500"/);
  assert.match(html, /id="confirm-reason-field"[\s\S]*?id="confirm-reason"[^>]*minlength="8"[^>]*maxlength="500"[\s\S]*?id="confirm-reason-error"/);

  assert.match(app, /function permissionEffectsForValue\(value\)/);
  assert.match(app, /value === 'ALLOW_DENY'[\s\S]*?'ALLOW'[\s\S]*?'DENY'/);
  assert.match(app, /permissionEffectsForValue\(select\?\.value\)\.includes\(effect\)/);
  assert.match(app, /reasonRequired/);
  assert.match(app, /body:\s*\{\s*reason:\s*confirmed\s*\}/);
  assert.match(app, /reason:\s*\$\('new-user-reason'\)\.value\.trim\(\)/);
  assert.match(app, /authzRoleDetail\.assignmentCount \?\? authzRoleDetail\.userCount/);
});

test('authorization draft guard runs before navigation and logout mutations and stale loads are ignored', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const navigateSource = app.slice(app.indexOf('async function navigateToTab'), app.indexOf('function closeMobileFilters'));
  const logoutSource = app.slice(app.indexOf("$('btn-logout').addEventListener"), app.indexOf('// Route buttons are rendered'));

  assert.ok(navigateSource.includes('await confirmAuthzRouteLeave'), 'navigateToTab must await the authorization draft guard');
  assert.ok(navigateSource.indexOf('await confirmAuthzRouteLeave') < navigateSource.indexOf('activateRouteResolution'), 'navigation guard must run before route state/hash mutation');
  assert.ok(logoutSource.includes('await confirmAuthzRouteLeave'), 'logout must await the authorization draft guard');
  assert.ok(logoutSource.indexOf('await confirmAuthzRouteLeave') < logoutSource.indexOf("api('/auth/logout'"), 'logout guard must run before the logout request');

  assert.match(app, /let authzRoleRequestSequence = 0;/);
  assert.match(app, /let authzUserRequestSequence = 0;/);
  assert.match(app, /const requestSequence = \+\+authzRoleRequestSequence;[\s\S]*?requestSequence !== authzRoleRequestSequence/);
  assert.match(app, /const requestSequence = \+\+authzUserRequestSequence;[\s\S]*?requestSequence !== authzUserRequestSequence/);
});

test('authorization setup navigation and audit history expose a scannable responsive public seam', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'tailwind.css'), 'utf8');

  for (const [tab, pane] of [
    ['users', 'authz-pane-users'],
    ['roles', 'authz-pane-roles'],
    ['approvals', 'authz-pane-approvals'],
    ['history', 'authz-pane-history'],
  ]) {
    assert.match(html, new RegExp(`<button(?=[^>]*data-authz-tab="${tab}")(?=[^>]*aria-controls="${pane}")[^>]*>`));
  }
  assert.doesNotMatch(html, /data-authz-tab="(?:permissions|scopes)"/);

  for (const id of [
    'authz-history-total',
    'authz-history-system',
    'authz-history-manual',
    'authz-history-missing-reason',
    'authz-history-search',
    'authz-history-actor-filter',
    'authz-history-change-filter',
    'authz-history-result-count',
    'authz-export-authorization',
  ]) assert.match(html, new RegExp(`id="${id}"`));

  assert.match(html, /class="data-table authz-history-table"[\s\S]*?<th>Thời gian<\/th>[\s\S]*?<th>Người thực hiện<\/th>[\s\S]*?<th[^>]*>Chi tiết<\/th>/);
  assert.match(app, /let authzHistoryRows = \[\];/);
  assert.match(app, /function renderAuthzHistory\(\)/);
  assert.match(app, /\/admin\/authorization\/history\?\$\{authzHistoryQuery\(\)\.toString\(\)\}/);
  assert.match(app, /\/admin\/authorization\/export\.xlsx/);
  assert.match(app, /\/roles\/\$\{encodeURIComponent\(authzSelectedRole\)\}\/configuration/);
  assert.match(app, /\/users\/\$\{encodeURIComponent\(authzSelectedUser\)\}\/authorization/);
  assert.match(app, /function authzHistoryCell\(label, options = \{\}\)/);
  assert.match(css, /\.authz-tab-step\s*\{/);
  assert.match(css, /\.authz-history-overview\s*\{/);
  assert.match(css, /@media\s*\(max-width:\s*767px\)[\s\S]*\.authz-history-table\s+thead\s*\{[^}]*position:\s*absolute;/);
});
