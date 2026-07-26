'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuditEventService } = require('../server/services/AuditEventService');
const { AuthorizationService } = require('../server/services/AuthorizationService');
const { ApprovalAssignmentService } = require('../server/services/ApprovalAssignmentService');
const { AuthorizationAdminService } = require('../server/services/AuthorizationAdminService');
const { PolicyService, PolicyError } = require('../server/services/PolicyService');
const { createAuthorizationAdminRouter } = require('../server/routes/authorizationAdmin');
const { PERMISSIONS, ROLE_CODES, ADMIN_PERMISSIONS } = require('../server/authorization/permissionCatalog');
const { ROLES } = require('../server/domain/roles');
const navigation = require('../public/js/navigation-manifest');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const TARGETS = Object.freeze([
  {
    roleCode: ROLE_CODES.REGIONAL_LEAD_APPROVER,
    legacyRole: ROLES.LEAD,
    approvalPermissions: [PERMISSIONS.EVALUATION_APPROVE_LEAD],
  },
  {
    roleCode: ROLE_CODES.DEPARTMENT_HEAD_APPROVER,
    legacyRole: ROLES.TBP,
    approvalPermissions: [PERMISSIONS.EVALUATION_APPROVE_TBP],
  },
  {
    roleCode: ROLE_CODES.BLOCK_DIRECTOR_APPROVER,
    legacyRole: ROLES.GDK,
    approvalPermissions: [PERMISSIONS.EVALUATION_APPROVE_GDK],
  },
]);

function migrate(db, directory = migrationsDir) {
  migrateDatabase(db, { migrationsDir: directory, appVersion: 'run-09-test' });
}

function rolePermissions(db, roleCode) {
  return db.prepare(`
    SELECT rp.permission_code
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    WHERE r.role_code = ? AND rp.effect = 'ALLOW'
    ORDER BY rp.permission_code
  `).all(roleCode).map((row) => row.permission_code);
}

function addUser(db, email, role, isAdmin = false) {
  db.prepare(`INSERT INTO users
    (email, is_admin, role, is_active, display_name, created_at, created_by)
    VALUES (?, ?, ?, 1, 'SYNTHETIC RUN-09 USER', datetime('now'), 'run-09')`
  ).run(email, isAdmin ? 1 : 0, role);
}

async function withServer(app, callback) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('RUN-09 approver roles retain workflow rights but receive no administration capability', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    assert.ok(ADMIN_PERMISSIONS.length > 0);
    for (const target of TARGETS) {
      const granted = rolePermissions(db, target.roleCode);
      assert.deepEqual(granted.filter((permission) => ADMIN_PERMISSIONS.includes(permission)), [], target.roleCode);
      for (const permission of target.approvalPermissions) {
        assert.ok(granted.includes(permission), `${target.roleCode}:${permission}`);
      }
    }
  } finally {
    db.close();
  }
});

test('RUN-09 migration removes legacy admin overgrants without an explicit DENY', () => {
  const db = new Database(':memory:');
  const partialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run09-migrations-'));
  try {
    for (const fileName of fs.readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < '0015_')) {
      fs.copyFileSync(path.join(migrationsDir, fileName), path.join(partialDir, fileName));
    }
    migrate(db, partialDir);
    const insert = db.prepare(`
      INSERT OR REPLACE INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'ALLOW' FROM roles WHERE role_code = ?
    `);
    for (const target of TARGETS) {
      for (const permission of ADMIN_PERMISSIONS) insert.run(permission, target.roleCode);
    }
    assert.ok(TARGETS.every((target) =>
      rolePermissions(db, target.roleCode).some((permission) => ADMIN_PERMISSIONS.includes(permission))
    ));

    migrate(db);
    for (const target of TARGETS) {
      const rows = db.prepare(`
        SELECT rp.permission_code, rp.effect
        FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.role_code = ? AND rp.permission_code IN (${ADMIN_PERMISSIONS.map(() => '?').join(',')})
      `).all(target.roleCode, ...ADMIN_PERMISSIONS);
      assert.deepEqual(rows, [], target.roleCode);
    }
  } finally {
    db.close();
    fs.rmSync(partialDir, { recursive: true, force: true });
  }
});

test('RUN-09 desktop, mobile and deep links fail closed for approvers and allow approved admin capability', () => {
  const businessCapabilities = {
    [ROLE_CODES.REGIONAL_LEAD_APPROVER]: [
      PERMISSIONS.DASHBOARD_READ, PERMISSIONS.SUPPLIER_READ, PERMISSIONS.EVALUATION_READ,
      PERMISSIONS.REPORT_READ, PERMISSIONS.REPORT_EXPORT, PERMISSIONS.EVALUATION_APPROVE_LEAD,
    ],
    [ROLE_CODES.DEPARTMENT_HEAD_APPROVER]: [
      PERMISSIONS.DASHBOARD_READ, PERMISSIONS.SUPPLIER_READ, PERMISSIONS.EVALUATION_READ,
      PERMISSIONS.REPORT_READ, PERMISSIONS.REPORT_EXPORT, PERMISSIONS.EVALUATION_APPROVE_TBP,
    ],
    [ROLE_CODES.BLOCK_DIRECTOR_APPROVER]: [
      PERMISSIONS.DASHBOARD_READ, PERMISSIONS.SUPPLIER_READ, PERMISSIONS.EVALUATION_READ,
      PERMISSIONS.REPORT_READ, PERMISSIONS.REPORT_EXPORT, PERMISSIONS.EVALUATION_APPROVE_GDK,
    ],
  };

  for (const target of TARGETS) {
    const capabilities = businessCapabilities[target.roleCode];
    const visibleIds = navigation.visibleNavigation(capabilities).map((item) => item.id);
    const mobileIds = navigation.mobilePrimary(capabilities).map((item) => item.id);
    assert.ok(!visibleIds.includes('administration'), target.roleCode);
    assert.ok(!visibleIds.some((id) => id === 'admin' || id.startsWith('admin-')), target.roleCode);
    assert.ok(!mobileIds.some((id) => id === 'admin' || id.startsWith('admin-')), target.roleCode);
    assert.equal(navigation.resolveRoute('/admin', capabilities).status, 'denied', target.roleCode);
    assert.equal(navigation.resolveRoute('/admin/report-templates', capabilities).status, 'denied', target.roleCode);
  }

  const approvedDesigner = [PERMISSIONS.REPORT_READ, PERMISSIONS.REPORT_TEMPLATE_MANAGE];
  assert.ok(navigation.visibleNavigation(approvedDesigner).some((item) => item.id === 'admin'));
  assert.equal(navigation.resolveRoute('/admin/report-templates', approvedDesigner).status, 'allowed');
  assert.equal(navigation.resolveRoute('/admin', Object.values(PERMISSIONS)).status, 'allowed');
});

test('RUN-09 authorization administration API returns 403 for approvers and remains available to SYS_ADMIN', async () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const audit = new AuditEventService(db);
    const authorization = new AuthorizationService(db, { auditEventService: audit });
    const approvals = new ApprovalAssignmentService(db, authorization);
    const policy = new PolicyService(authorization, approvals);
    const service = new AuthorizationAdminService(db, authorization, approvals, audit);
    const users = new Map();
    for (const [index, target] of TARGETS.entries()) {
      const email = `run09-approver-${index}@example.invalid`;
      addUser(db, email, target.legacyRole);
      authorization.syncLegacyUser(email);
      users.set(target.roleCode, email);
    }
    const adminEmail = 'run09-admin@example.invalid';
    addUser(db, adminEmail, ROLES.ADMIN, true);
    authorization.syncLegacyUser(adminEmail);
    users.set(ROLE_CODES.SYS_ADMIN, adminEmail);

    const app = express();
    app.use('/api/admin/authorization', createAuthorizationAdminRouter({
      service,
      authenticate: (req, res, next) => {
        const email = users.get(req.get('x-run09-role'));
        if (!email) return res.status(401).json({ error: 'unauthorized' });
        req.user = authorization.identityForLegacyRoutes(email);
        return next();
      },
      authorize: (req, res, next) => {
        try {
          policy.assert(req.user, PERMISSIONS.USER_MANAGE);
          return next();
        } catch (error) {
          if (error instanceof PolicyError) return res.status(403).json({ error: error.code });
          return next(error);
        }
      },
    }));

    await withServer(app, async (baseUrl) => {
      for (const target of TARGETS) {
        const response = await fetch(`${baseUrl}/api/admin/authorization/catalog`, {
          headers: { 'x-run09-role': target.roleCode },
        });
        assert.equal(response.status, 403, target.roleCode);
        assert.equal((await response.json()).error, 'forbidden_permission');
      }
      const admin = await fetch(`${baseUrl}/api/admin/authorization/catalog`, {
        headers: { 'x-run09-role': ROLE_CODES.SYS_ADMIN },
      });
      assert.equal(admin.status, 200);
      assert.ok(Array.isArray((await admin.json()).roles));
    });
  } finally {
    db.close();
  }
});
