'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const { migrateDatabase } = require('../server/database/migrationRunner');
const { AuditEventService } = require('../server/services/AuditEventService');
const { AuthorizationService } = require('../server/services/AuthorizationService');
const { ApprovalAssignmentService } = require('../server/services/ApprovalAssignmentService');
const { AuthorizationAdminService } = require('../server/services/AuthorizationAdminService');
const {
  CANONICAL_PERSONNEL_HEADERS,
  PersonnelImportService,
  XLSX_MIME,
} = require('../server/services/PersonnelImportService');
const { createAuthorizationAdminRouter } = require('../server/routes/authorizationAdmin');
const { auditMutations } = require('../server/middleware/audit');
const { requestContext } = require('../server/middleware/requestContext');
const {
  buildPersonnelImportWorkbook,
} = require('../scripts/generate-personnel-import-workbooks');
const { PERMISSIONS, ROLE_CODES } = require('../server/authorization/permissionCatalog');
const { ROLES } = require('../server/domain/roles');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');
const ACTOR = 'personnel-admin@example.invalid';

function addUser(db, email, role = ROLES.SPECIALIST, isAdmin = false, displayName = 'Synthetic user') {
  db.prepare(`INSERT INTO users
    (email, is_admin, role, is_active, display_name, created_at, created_by)
    VALUES (?, ?, ?, 1, ?, datetime('now'), 'fixture')`
  ).run(email, isAdmin ? 1 : 0, role, displayName);
}

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'prompt-06-test' });
  addUser(db, ACTOR, ROLES.ADMIN, true, 'Synthetic import administrator');
  const audit = new AuditEventService(db);
  const authz = new AuthorizationService(db, { auditEventService: audit });
  const approvals = new ApprovalAssignmentService(db, authz);
  authz.syncLegacyUser(ACTOR);
  const authorizationAdmin = new AuthorizationAdminService(db, authz, approvals, audit);
  const personnelImport = new PersonnelImportService(db, authorizationAdmin, authz, audit, {
    clock: () => new Date('2026-07-18T08:00:00.000Z'),
  });
  return { db, audit, authz, authorizationAdmin, personnelImport };
}

function workbookBuffer(rows, { headers = CANONICAL_PERSONNEL_HEADERS, formula = false } = {}) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Synthetic personnel import workbook'],
  ]), 'Huong_dan');
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  if (formula) sheet.A2 = { t: 's', v: 'person@example.test', f: 'LOWER("PERSON@example.test")' };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Nhan_su');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function canonicalRow(overrides = {}) {
  const values = {
    email: 'person-001@example.test',
    display_name: 'Synthetic imported person',
    active: 'TRUE',
    role_codes: `${ROLE_CODES.QLCL_SPECIALIST};${ROLE_CODES.AUDITOR}`,
    valid_from: '2026-08-01',
    valid_until: '2030-12-31',
    scope_type: 'MCH2',
    scope_value: '203',
    scope_effect: 'ALLOW',
    ...overrides,
  };
  return CANONICAL_PERSONNEL_HEADERS.map((header) => values[header] ?? '');
}

function mapping() {
  return Object.fromEntries(CANONICAL_PERSONNEL_HEADERS.map((header) => [header, header]));
}

async function withServer(fx, callback, { actor = ACTOR, authorized = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.requestId = 'request-prompt06-0001';
    req.correlationId = 'correlation-prompt06-0001';
    next();
  });
  app.use('/admin/authorization', createAuthorizationAdminRouter({
    service: fx.authorizationAdmin,
    personnelImportService: fx.personnelImport,
    authenticate: (req, res, next) => { req.user = { email: actor }; next(); },
    authorize: authorized ? ((req, res, next) => next()) : ((req, res) => res.status(403).json({ error: 'forbidden_permission' })),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}/admin/authorization`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withAuditedServer(fx, callback, { actor = ACTOR } = {}) {
  const app = express();
  app.use(requestContext({ logger: { info() {} } }));
  app.use(auditMutations(fx.audit, { logger: { error() {} } }));
  app.use(express.json());
  app.use('/qlcl/api/admin/authorization', createAuthorizationAdminRouter({
    service: fx.authorizationAdmin,
    personnelImportService: fx.personnelImport,
    authenticate: (req, _res, next) => { req.user = { email: actor }; next(); },
    authorize: (_req, _res, next) => next(),
  }));
  app.use((error, req, res, _next) => {
    res.locals.error_code = error.code || 'synthetic_apply_failure';
    res.status(error.status || 500).json({ error: res.locals.error_code, request_id: req.requestId });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}/qlcl/api/admin/authorization`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function preview(baseUrl, buffer, name = 'personnel.xlsx') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: XLSX_MIME }), name);
  const response = await fetch(`${baseUrl}/personnel-import/batches/preview`, { method: 'POST', body: form });
  return { response, body: await response.json() };
}

async function validate(baseUrl, batch, overrides = {}) {
  const response = await fetch(`${baseUrl}/personnel-import/batches/${encodeURIComponent(batch.batchId)}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedSourceChecksum: batch.sourceChecksum,
      columnMapping: mapping(),
      ignoredColumns: [],
      roleValueMapping: {},
      ...overrides,
    }),
  });
  return { response, body: await response.json() };
}

async function commit(baseUrl, validated, overrides = {}) {
  const response = await fetch(`${baseUrl}/personnel-import/batches/${encodeURIComponent(validated.batchId)}/commit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': overrides.idempotencyKey || 'PROMPT06-IDEMPOTENCY-0001',
    },
    body: JSON.stringify({
      expectedBatchChecksum: validated.batchChecksum,
      reason: 'Apply the approved synthetic personnel import batch',
      confirmation: validated.requiredConfirmation,
      ...overrides.body,
    }),
  });
  return { response, body: await response.json() };
}

test('deterministic template and example use exact sheets, canonical headers and synthetic rows', () => {
  const templateOne = buildPersonnelImportWorkbook({ example: false });
  const templateTwo = buildPersonnelImportWorkbook({ example: false });
  const example = buildPersonnelImportWorkbook({ example: true });
  assert.deepEqual(templateOne, templateTwo);

  for (const [buffer, hasExample] of [[templateOne, false], [example, true]]) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, ['Huong_dan', 'Nhan_su']);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Nhan_su, { header: 1, defval: '', raw: false });
    assert.deepEqual(rows[0], CANONICAL_PERSONNEL_HEADERS);
    if (hasExample) {
      assert.ok(rows.length >= 3);
      assert.ok(rows.slice(1).every((row) => String(row[0]).endsWith('@example.test')));
      assert.ok(rows.slice(1).every((row) => String(row[3]).split(';').every((code) => Object.values(ROLE_CODES).includes(code))));
    } else {
      assert.equal(rows.length, 1);
    }
  }
});

test('public API is guarded and template/example downloads contain no production identity', async () => {
  const fx = fixture();
  try {
    await withServer(fx, async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/personnel-import/template.xlsx`);
      assert.equal(denied.status, 403);
    }, { authorized: false });

    await withServer(fx, async (baseUrl) => {
      for (const name of ['template.xlsx', 'example.xlsx']) {
        const response = await fetch(`${baseUrl}/personnel-import/${name}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /spreadsheetml/);
        const workbook = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' });
        assert.deepEqual(workbook.SheetNames, ['Huong_dan', 'Nhan_su']);
        assert.doesNotMatch(JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets.Nhan_su, { header: 1 })), /masangroup|winmart/i);
      }
    });
  } finally { fx.db.close(); }
});

test('upload creates an ephemeral preview only and workbook security rejects formulas', async () => {
  const fx = fixture();
  try {
    await withServer(fx, async (baseUrl) => {
      const beforeUsers = fx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const result = await preview(baseUrl, workbookBuffer([canonicalRow()]));
      assert.equal(result.response.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.item.status, 'UPLOADED');
      assert.deepEqual(result.body.item.headers, CANONICAL_PERSONNEL_HEADERS);
      assert.equal(result.body.item.suggestedColumnMapping.email, 'email');
      assert.deepEqual(result.body.item.distinctRoleValues, [ROLE_CODES.AUDITOR, ROLE_CODES.QLCL_SPECIALIST]);
      assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, beforeUsers);
      assert.equal(fx.db.prepare('SELECT COUNT(*) AS n FROM personnel_import_batches').get().n, 0);

      const malicious = await preview(baseUrl, workbookBuffer([canonicalRow()], { formula: true }), 'formula.xlsx');
      assert.equal(malicious.response.status, 400);
      assert.equal(malicious.body.error, 'workbook_formula_forbidden');

      const formulaLike = await preview(baseUrl, workbookBuffer([
        canonicalRow({ display_name: '=HYPERLINK("https://example.test")' }),
      ]), 'formula-like.xlsx');
      assert.equal(formulaLike.response.status, 400);
      assert.equal(formulaLike.body.error, 'workbook_formula_like_cell_forbidden');
    });
  } finally { fx.db.close(); }
});

test('validation reports duplicate/unknown roles and an invalid batch can never partially commit', async () => {
  const fx = fixture();
  try {
    const buffer = workbookBuffer([
      canonicalRow({ email: 'duplicate@example.test', role_codes: 'UNKNOWN ROLE' }),
      canonicalRow({ email: 'DUPLICATE@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST }),
    ]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.response.status, 200);
      assert.equal(checked.body.item.status, 'INVALID');
      assert.equal(checked.body.item.commitAllowed, false);
      const codes = checked.body.item.rows.flatMap((row) => row.errors.map((error) => error.code));
      assert.ok(codes.includes('role_value_mapping_required'));
      assert.ok(codes.includes('email_duplicate_in_file'));

      const attempted = await commit(baseUrl, {
        batchId: checked.body.item.batchId,
        batchChecksum: checked.body.item.batchChecksum,
        requiredConfirmation: checked.body.item.requiredConfirmation,
      });
      assert.equal(attempted.response.status, 409);
      assert.equal(attempted.body.error, 'personnel_import_not_committable');
      assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@example.test'").get().n, 0);
    });
  } finally { fx.db.close(); }
});

test('validation explains permission and scope conflicts with DENY_WINS', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'scope-conflict@example.test');
    fx.authz.syncLegacyUser('scope-conflict@example.test');
    fx.db.prepare("INSERT INTO roles (role_code, display_label, role_kind) VALUES ('IMPORT_DENY_VIEW', 'Synthetic deny view', 'FUNCTIONAL')").run();
    fx.db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'DENY' FROM roles WHERE role_code='IMPORT_DENY_VIEW'`).run(PERMISSIONS.DASHBOARD_READ);
    fx.db.prepare(`INSERT INTO user_scope_assignments
      (user_id, scope_type, scope_value, effect, source, created_by)
      VALUES (?, 'MCH2', '203', 'DENY', 'MANUAL', ?)`).run('scope-conflict@example.test', ACTOR);

    const buffer = workbookBuffer([
      canonicalRow({
        email: 'permission-conflict@example.test',
        role_codes: `${ROLE_CODES.QLCL_SPECIALIST};IMPORT_DENY_VIEW`,
        scope_type: '', scope_value: '', scope_effect: '',
      }),
      canonicalRow({ email: 'scope-conflict@example.test', role_codes: '' }),
    ]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'VALIDATED', JSON.stringify(checked.body));
      assert.ok(checked.body.item.riskFlags.includes('DENY_CONFLICT'));
      assert.ok(checked.body.item.riskFlags.includes('SCOPE_CONFLICT'));
      assert.equal(checked.body.item.rows[0].effectiveRightsDelta.conflicts.length, 0);
      assert.ok(checked.body.item.rows[0].scheduledRightsDelta.conflicts.some((conflict) => (
        conflict.permissionCode === PERMISSIONS.DASHBOARD_READ && conflict.resolution === 'DENY_WINS'
      )));
      assert.ok(checked.body.item.rows[1].effectiveRightsDelta.scopeConflicts.some((conflict) => (
        conflict.scopeType === 'MCH2' && conflict.scopeValue === '203' && conflict.resolution === 'DENY_WINS'
      )));
      assert.match(checked.body.item.requiredConfirmation, /^COMMIT PERSONNEL IMPORT pib_/);
    });
  } finally { fx.db.close(); }
});

test('blank active is a no-op for updates and does not reactivate an inactive account', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'inactive-person@example.test');
    fx.authz.syncLegacyUser('inactive-person@example.test');
    fx.db.prepare('UPDATE users SET is_active=0 WHERE email=?').run('inactive-person@example.test');
    const buffer = workbookBuffer([canonicalRow({
      email: 'inactive-person@example.test',
      display_name: 'Updated synthetic inactive person',
      active: '',
      role_codes: '',
      valid_from: '', valid_until: '',
      scope_type: '', scope_value: '', scope_effect: '',
    })]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'VALIDATED', JSON.stringify(checked.body));
      assert.equal(checked.body.item.counts.update, 1);
      const committed = await commit(baseUrl, checked.body.item, { idempotencyKey: 'PROMPT06-INACTIVE-0001' });
      assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
      const user = fx.db.prepare('SELECT is_active, display_name FROM users WHERE email=?').get('inactive-person@example.test');
      assert.equal(user.is_active, 0);
      assert.equal(user.display_name, 'Updated synthetic inactive person');
    });
  } finally { fx.db.close(); }
});

test('role desired state distinguishes MANUAL windows from LEGACY_COMPAT source', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'manual-window@example.test', ROLES.SPECIALIST, false, 'Synthetic imported person');
    fx.authz.syncLegacyUser('manual-window@example.test');
    fx.db.prepare(`UPDATE user_roles SET source='MANUAL', valid_from='2026-08-01 00:00:00',
      valid_until='2031-01-01 00:00:00' WHERE user_id=?`).run('manual-window@example.test');
    addUser(fx.db, 'legacy-source@example.test', ROLES.SPECIALIST, false, 'Synthetic imported person');
    fx.authz.syncLegacyUser('legacy-source@example.test');

    const buffer = workbookBuffer([
      canonicalRow({ email: 'manual-window@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST,
        scope_type: '', scope_value: '', scope_effect: '' }),
      canonicalRow({ email: 'legacy-source@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST,
        valid_from: '', valid_until: '', scope_type: '', scope_value: '', scope_effect: '' }),
    ]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'VALIDATED', JSON.stringify(checked.body));
      assert.equal(checked.body.item.counts.unchanged, 1);
      assert.equal(checked.body.item.counts.update, 1);
      assert.equal(checked.body.item.rows.find((row) => row.email === 'manual-window@example.test').outcome, 'UNCHANGED');
      assert.ok(checked.body.item.rows.find((row) => row.email === 'legacy-source@example.test').changes.includes('roles.replace'));
    });
  } finally { fx.db.close(); }
});

test('IDP role and scope assignments fail closed instead of being converted to MANUAL', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'idp-role@example.test', ROLES.SPECIALIST, false, 'Synthetic imported person');
    fx.authz.syncLegacyUser('idp-role@example.test');
    fx.db.prepare("UPDATE user_roles SET source='IDP' WHERE user_id=?").run('idp-role@example.test');
    addUser(fx.db, 'idp-scope@example.test', ROLES.SPECIALIST, false, 'Synthetic imported person');
    fx.authz.syncLegacyUser('idp-scope@example.test');
    fx.db.prepare(`INSERT INTO user_scope_assignments
      (user_id, scope_type, scope_value, effect, source, created_by)
      VALUES (?, 'REGION', 'REGION_SOUTH', 'ALLOW', 'IDP', ?)`).run('idp-scope@example.test', ACTOR);

    const buffer = workbookBuffer([
      canonicalRow({ email: 'idp-role@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST,
        valid_from: '', valid_until: '', scope_type: '', scope_value: '', scope_effect: '' }),
      canonicalRow({ email: 'idp-scope@example.test', role_codes: '', valid_from: '', valid_until: '',
        scope_type: 'REGION', scope_value: 'REGION_SOUTH', scope_effect: 'ALLOW' }),
    ]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'INVALID');
      const codes = checked.body.item.rows.flatMap((row) => row.errors.map((error) => error.code));
      assert.ok(codes.includes('role_source_conflict'));
      assert.ok(codes.includes('scope_source_conflict'));
    });
    assert.equal(fx.db.prepare('SELECT source FROM user_roles WHERE user_id=?').get('idp-role@example.test').source, 'IDP');
    assert.equal(fx.db.prepare(`SELECT source FROM user_scope_assignments
      WHERE user_id=? AND scope_type='REGION'`).get('idp-scope@example.test').source, 'IDP');
  } finally { fx.db.close(); }
});

test('validated sensitive batch commits atomically, audits versions and is idempotent without persisted row data', async () => {
  const fx = fixture();
  try {
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, workbookBuffer([canonicalRow()]));
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'VALIDATED', JSON.stringify(checked.body));
      assert.equal(checked.body.item.counts.create, 1);
      assert.equal(checked.body.item.commitAllowed, true);
      assert.match(checked.body.item.requiredConfirmation, /^COMMIT PERSONNEL IMPORT pib_/);
      assert.equal(checked.body.item.rows[0].effectiveRightsDelta.addedPermissions.length, 0);
      assert.ok(checked.body.item.rows[0].scheduledRightsDelta.addedPermissions.length > 0);

      const missingConfirmation = await commit(baseUrl, checked.body.item, { body: { confirmation: '' } });
      assert.equal(missingConfirmation.response.status, 409);
      assert.equal(missingConfirmation.body.error, 'exact_confirmation_required');

      const committed = await commit(baseUrl, checked.body.item);
      assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
      assert.equal(committed.body.item.status, 'COMMITTED');
      assert.equal(committed.body.item.counts.created, 1);
      assert.equal(committed.body.item.idempotent, false);

      const user = fx.db.prepare('SELECT email, authz_version FROM users WHERE email = ?').get('person-001@example.test');
      assert.ok(user.authz_version > 1);
      const roleCodes = fx.db.prepare(`SELECT r.role_code FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.user_id=? AND ur.active=1 ORDER BY r.role_code`).all(user.email).map((row) => row.role_code);
      assert.deepEqual(roleCodes, [ROLE_CODES.AUDITOR, ROLE_CODES.QLCL_SPECIALIST].sort());
      assert.ok(fx.db.prepare("SELECT 1 FROM audit_events WHERE event_name='personnel.import.committed'").get());
      assert.ok(fx.db.prepare("SELECT 1 FROM authz_change_log WHERE target_user_id=? AND reason IS NOT NULL").get(user.email));

      const ledger = fx.db.prepare(`SELECT mapping_json, summary_json, diagnostics_json
        FROM personnel_import_batches WHERE public_id=?`).get(checked.body.item.batchId);
      assert.ok(ledger);
      assert.doesNotMatch(JSON.stringify(ledger), /person-001@example\.test|Synthetic imported person/);

      const repeated = await commit(baseUrl, checked.body.item);
      assert.equal(repeated.response.status, 200);
      assert.equal(repeated.body.item.idempotent, true);
      assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_name='personnel.import.committed'").get().n, 1);

      const conflict = await commit(baseUrl, checked.body.item, {
        body: { reason: 'A different approved synthetic import reason' },
      });
      assert.equal(conflict.response.status, 409);
      assert.equal(conflict.body.error, 'idempotency_key_conflict');
    });
  } finally { fx.db.close(); }
});

test('batch-level last SYS_ADMIN guard validates final state and applies replacement admin first', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'import-manager@example.invalid');
    fx.db.prepare("INSERT INTO roles (role_code, display_label, role_kind) VALUES ('IMPORT_MANAGER', 'Synthetic import manager', 'FUNCTIONAL')").run();
    fx.db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'ALLOW' FROM roles WHERE role_code='IMPORT_MANAGER'`).run(PERMISSIONS.USER_MANAGE);
    fx.authz.assignRole({ userId: 'import-manager@example.invalid', roleCode: 'IMPORT_MANAGER', actor: ACTOR });
    addUser(fx.db, 'admin-a@example.test', ROLES.ADMIN, true, 'Synthetic imported person');
    fx.authz.syncLegacyUser('admin-a@example.test');
    fx.db.prepare('UPDATE users SET is_active=0 WHERE email=?').run(ACTOR);

    await withServer(fx, async (baseUrl) => {
      const invalidUpload = await preview(baseUrl, workbookBuffer([canonicalRow({
        email: 'admin-a@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST,
        valid_from: '', valid_until: '', scope_type: '', scope_value: '', scope_effect: '',
      })]));
      const invalid = await validate(baseUrl, invalidUpload.body.item);
      assert.equal(invalid.body.item.status, 'INVALID');
      assert.ok(invalid.body.item.rows[0].errors.some((error) => error.code === 'last_super_admin_required'));

      const safeUpload = await preview(baseUrl, workbookBuffer([
        canonicalRow({ email: 'admin-a@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST,
          valid_from: '', valid_until: '', scope_type: '', scope_value: '', scope_effect: '' }),
        canonicalRow({ email: 'z-new-admin@example.test', role_codes: ROLE_CODES.SYS_ADMIN,
          valid_from: '', valid_until: '', scope_type: '', scope_value: '', scope_effect: '' }),
      ]));
      const safe = await validate(baseUrl, safeUpload.body.item);
      assert.equal(safe.body.item.status, 'VALIDATED', JSON.stringify(safe.body));
      const committed = await commit(baseUrl, safe.body.item, { idempotencyKey: 'PROMPT06-ADMIN-SWAP-0001' });
      assert.equal(committed.response.status, 200, JSON.stringify(committed.body));
      const activeAdmins = fx.db.prepare(`SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id=u.email
        JOIN roles r ON r.id=ur.role_id WHERE u.is_active=1 AND ur.active=1 AND r.active=1
          AND r.role_code=? ORDER BY u.email`).all(ROLE_CODES.SYS_ADMIN).map((row) => row.email);
      assert.deepEqual(activeAdmins, ['z-new-admin@example.test']);
    }, { actor: 'import-manager@example.invalid' });
  } finally { fx.db.close(); }
});

test('outer rollback clears nested audit marker so middleware records failed commit', async () => {
  const fx = fixture();
  try {
    const originalApply = fx.personnelImport._applyOperation.bind(fx.personnelImport);
    let applied = 0;
    fx.personnelImport._applyOperation = (...args) => {
      originalApply(...args);
      applied += 1;
      if (applied === 2) throw new Error('synthetic_apply_failure');
    };
    const buffer = workbookBuffer([
      canonicalRow({ email: 'audit-failure-a@example.test', scope_type: '', scope_value: '', scope_effect: '' }),
      canonicalRow({ email: 'audit-failure-b@example.test', scope_type: '', scope_value: '', scope_effect: '' }),
    ]);
    await withAuditedServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, buffer);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'VALIDATED', JSON.stringify(checked.body));
      const attempted = await commit(baseUrl, checked.body.item, { idempotencyKey: 'PROMPT06-AUDIT-ROLLBACK-0001' });
      assert.equal(attempted.response.status, 500);
    });
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'audit-failure-%'").get().n, 0);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_name='personnel.import.committed'").get().n, 0);
    assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_name='personnel.import.failed'").get().n, 1);
  } finally { fx.db.close(); }
});

test('stale previews and self-escalation roll back every preceding row', async () => {
  const fx = fixture();
  try {
    addUser(fx.db, 'target-existing@example.test');
    fx.authz.syncLegacyUser('target-existing@example.test');
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, workbookBuffer([
        canonicalRow({ email: 'target-existing@example.test' }),
      ]));
      const checked = await validate(baseUrl, uploaded.body.item);
      fx.authz.assignRole({ userId: 'target-existing@example.test', roleCode: ROLE_CODES.DATA_UPLOADER, actor: ACTOR });
      const stale = await commit(baseUrl, checked.body.item, { idempotencyKey: 'PROMPT06-STALE-0001' });
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.error, 'personnel_import_preview_stale');
    });

    addUser(fx.db, 'manager@example.invalid');
    fx.db.prepare("INSERT INTO roles (role_code, display_label, role_kind) VALUES ('IMPORT_MANAGER', 'Synthetic import manager', 'FUNCTIONAL')").run();
    fx.db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
      SELECT id, ?, 'ALLOW' FROM roles WHERE role_code='IMPORT_MANAGER'`).run(PERMISSIONS.USER_MANAGE);
    fx.authz.assignRole({ userId: 'manager@example.invalid', roleCode: 'IMPORT_MANAGER', actor: ACTOR });
    const selfEscalationWorkbook = workbookBuffer([
      canonicalRow({ email: 'aaa-created-before-failure@example.test', role_codes: ROLE_CODES.QLCL_SPECIALIST }),
      canonicalRow({ email: 'manager@example.invalid', role_codes: ROLE_CODES.SYS_ADMIN, scope_type: '', scope_value: '', scope_effect: '' }),
    ]);
    await withServer(fx, async (baseUrl) => {
      const uploaded = await preview(baseUrl, selfEscalationWorkbook);
      const checked = await validate(baseUrl, uploaded.body.item);
      assert.equal(checked.body.item.status, 'INVALID');
      assert.ok(checked.body.item.rows.some((row) => row.errors.some((error) => error.code === 'cannot_self_escalate')));
      const attempted = await commit(baseUrl, checked.body.item, { idempotencyKey: 'PROMPT06-SELF-0001' });
      assert.equal(attempted.response.status, 409);
      assert.equal(fx.db.prepare('SELECT 1 FROM users WHERE email=?').get('aaa-created-before-failure@example.test'), undefined);
    }, { actor: 'manager@example.invalid' });
  } finally { fx.db.close(); }
});
