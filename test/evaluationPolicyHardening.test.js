const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const XLSX = require('xlsx');
const { MCH2_VALUES, MCH3_BY_MCH2 } = require('../server/domain/merchandising');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const MODULES = [
  '../server/config/paths',
  '../server/db',
  '../server/middleware/auth',
  '../server/services/evaluationSummaryExport',
  '../server/routes/evaluations',
];

function clearModules() {
  MODULES.forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function createSummaryTemplate(filePath) {
  const workbook = XLSX.utils.book_new();
  const headers = new Array(44).fill('');
  headers[0] = 'STT';
  headers[1] = 'Mã NCC';
  headers[2] = 'Tên NCC chính';
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['THÔNG TIN CHUNG'],
    [],
    headers,
    new Array(44).fill(''),
  ]);
  worksheet['!ref'] = 'A1:AR4';
  XLSX.utils.book_append_sheet(workbook, worksheet, 'file chi tiet kq danh gia');
  XLSX.writeFile(workbook, filePath);
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/evaluations', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function withEvaluationFixture(prefix, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const dbPath = path.join(tempDir, 'qlcl.db');
  const templatePath = path.join(tempDir, 'summary-template.xlsx');
  const exportDir = path.join(tempDir, 'exports');
  createSummaryTemplate(templatePath);

  const previous = {
    DB_PATH: process.env.DB_PATH,
    JWT_SECRET: process.env.JWT_SECRET,
    EVALUATION_SUMMARY_TEMPLATE_PATH: process.env.EVALUATION_SUMMARY_TEMPLATE_PATH,
    REPORT_EXPORT_DIR: process.env.REPORT_EXPORT_DIR,
  };
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'evaluation-policy-hardening-test-secret';
  process.env.EVALUATION_SUMMARY_TEMPLATE_PATH = templatePath;
  process.env.REPORT_EXPORT_DIR = exportDir;
  clearModules();

  const dbModule = require('../server/db');
  const router = require('../server/routes/evaluations');
  const appInfo = await startApp(router);

  try {
    await run({ ...dbModule, ...appInfo });
  } finally {
    await new Promise((resolve) => appInfo.server.close(resolve));
    dbModule.db.close();
    clearModules();
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function grantRoleAndScope(db, email, roleCode, scopeType, scopeValue = null) {
  upsertCanonicalUser(db, { email, roleCode });
  const role = db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
  assert.ok(role?.id, `role fixture ${roleCode} must exist`);
  db.prepare(`
    INSERT INTO user_scope_assignments (
      user_id, role_id, scope_type, scope_value, effect, active, source
    ) VALUES (?, ?, ?, ?, 'ALLOW', 1, 'MANUAL')
  `).run(email, role.id, scopeType, scopeValue);
}

function addScope(db, email, roleCode, scopeType, scopeValue, effect = 'ALLOW') {
  const role = db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
  assert.ok(role?.id, `role fixture ${roleCode} must exist`);
  db.prepare(`
    INSERT INTO user_scope_assignments (
      user_id, role_id, scope_type, scope_value, effect, active, source
    ) VALUES (?, ?, ?, ?, ?, 1, 'MANUAL')
  `).run(email, role.id, scopeType, scopeValue ?? null, effect);
}

function denyPermission(db, roleCode, permissionCode) {
  const role = db.prepare('SELECT id FROM roles WHERE role_code = ? AND active = 1').get(roleCode);
  assert.ok(role?.id, `role fixture ${roleCode} must exist`);
  db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
    VALUES (?, ?, 'DENY')`).run(role.id, permissionCode);
}

function tokenFor(authorizationService, email) {
  const session = authorizationService.createSession(email, { ttlSeconds: 3600 });
  return jwt.sign({ sub: email, sid: session.sessionId, av: session.authzVersion }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: 3600,
    issuer: 'masan-rms',
    audience: process.env.JWT_AUDIENCE || 'qlcl-app',
  });
}

function insertSupplier(db, fields) {
  return db.prepare(`
    INSERT INTO supplier_master (
      supplier_code, supplier_name, tax_code, address, region, province, business_type,
      contact_name, contact_email, contact_phone, status, source_type, created_by
    ) VALUES (
      @supplier_code, @supplier_name, @tax_code, @address, 'MB', 'Thành phố Hà Nội', 'Tự sản xuất',
      'Policy Contact', 'policy-contact@example.test', '0900000018', @status, 'MANUAL', @created_by
    )
  `).run({
    ...fields,
    tax_code: fields.tax_code || `${fields.supplier_code}-TAX`,
    address: fields.address || 'Policy supplier address',
    status: fields.status || 'ACTIVE',
  }).lastInsertRowid;
}

function insertEvaluation(db, fields) {
  const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04' ORDER BY id LIMIT 1").get();
  assert.ok(template?.id, 'BM04 template fixture must exist');
  return db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
      facility_type, supplier_scale, mch2, mch3, planned_date, current_status,
      current_round_no, assigned_specialist_id, created_by, created_at
    ) VALUES (
      @ticket_code, @supplier_id, @supplier_code, @supplier_name, 'Dinh ky', @template_id,
      'CHUNG', 'LARGE', @mch2, @mch3, '2026-07-14', 'Khởi tạo',
      1, @created_by, @created_by, @created_at
    )
  `).run({ ...fields, template_id: template.id }).lastInsertRowid;
}

function seedScopedEvaluations(db, ownerEmail) {
  const allowedSupplierId = insertSupplier(db, {
    supplier_code: 'POLICY-EVAL-ALLOWED-SUPPLIER',
    supplier_name: 'Allowed Evaluation Supplier',
    mch2: 'Homeline',
    mch3: 'Văn phòng phẩm',
    created_by: ownerEmail,
  });
  const deniedSupplierId = insertSupplier(db, {
    supplier_code: 'POLICY-EVAL-DENIED-SUPPLIER',
    supplier_name: 'Denied Evaluation Supplier',
    mch2: 'Dệt may',
    mch3: 'Bông vải sợi',
    created_by: ownerEmail,
  });
  const unmappedSupplierId = insertSupplier(db, {
    supplier_code: 'POLICY-EVAL-UNMAPPED-SUPPLIER',
    supplier_name: 'Unmapped Evaluation Supplier',
    mch2: 'Legacy Unmapped MCH2',
    mch3: 'Legacy Unmapped MCH3',
    created_by: ownerEmail,
  });
  insertEvaluation(db, {
    ticket_code: 'POLICY-EVAL-ALLOWED',
    supplier_id: allowedSupplierId,
    supplier_code: 'POLICY-EVAL-ALLOWED-SUPPLIER',
    supplier_name: 'Allowed Evaluation Supplier',
    mch2: 'Homeline',
    mch3: 'Văn phòng phẩm',
    created_by: ownerEmail,
    created_at: '2026-07-14 08:00:00',
  });
  insertEvaluation(db, {
    ticket_code: 'POLICY-EVAL-DENIED',
    supplier_id: deniedSupplierId,
    supplier_code: 'POLICY-EVAL-DENIED-SUPPLIER',
    supplier_name: 'Denied Evaluation Supplier',
    mch2: 'Dệt may',
    mch3: 'Bông vải sợi',
    created_by: ownerEmail,
    created_at: '2026-07-14 09:00:00',
  });
  insertEvaluation(db, {
    ticket_code: 'POLICY-EVAL-UNMAPPED',
    supplier_id: unmappedSupplierId,
    supplier_code: 'POLICY-EVAL-UNMAPPED-SUPPLIER',
    supplier_name: 'Unmapped Evaluation Supplier',
    mch2: 'Legacy Unmapped MCH2',
    mch3: 'Legacy Unmapped MCH3',
    created_by: ownerEmail,
    created_at: '2026-07-14 10:00:00',
  });
  return { allowedSupplierId, deniedSupplierId, unmappedSupplierId };
}

test('evaluation summary export requires REPORT.EXPORT independently of EVALUATION.READ', async () => {
  await withEvaluationFixture('qlcl-evaluation-export-permission', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-auditor@example.invalid';
    grantRoleAndScope(db, email, 'AUDITOR', 'GLOBAL');
    const supplierId = insertSupplier(db, {
      supplier_code: 'POLICY-AUDIT-SUPPLIER',
      supplier_name: 'Audit Visible Supplier',
      mch2: 'Homeline',
      mch3: 'Văn phòng phẩm',
      created_by: email,
    });
    insertEvaluation(db, {
      ticket_code: 'POLICY-AUDIT-TICKET',
      supplier_id: supplierId,
      supplier_code: 'POLICY-AUDIT-SUPPLIER',
      supplier_name: 'Audit Visible Supplier',
      mch2: 'Homeline',
      mch3: 'Văn phòng phẩm',
      created_by: email,
      created_at: '2026-07-14 08:00:00',
    });

    const response = await fetch(`${baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden_permission' });
  });
});

test('evaluation summary export applies the shared MCH2 resource scope', async () => {
  await withEvaluationFixture('qlcl-evaluation-export-scope', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-mch2-exporter@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'MCH2', 'MCH2_HOMELINE');
    seedScopedEvaluations(db, email);

    const response = await fetch(`${baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({ sort: { field: 'ticket_code', dir: 'asc' } }),
    });
    const buffer = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-export-row-count'), '1');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets['file chi tiet kq danh gia']);
    assert.match(csv, /Allowed Evaluation Supplier/);
    assert.doesNotMatch(csv, /Denied Evaluation Supplier/);
    assert.doesNotMatch(csv, /Unmapped Evaluation Supplier/);
  });
});

test('evaluation MCH2 scope is consistent for list and detail without invalid-column SQL', async () => {
  await withEvaluationFixture('qlcl-evaluation-mch2-scope', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-mch2-reader@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'MCH2', 'MCH2_HOMELINE');
    seedScopedEvaluations(db, email);
    const cookie = `qlcl_token=${tokenFor(authorizationService, email)}`;

    const listResponse = await fetch(`${baseUrl}/evaluations?q=POLICY-EVAL-&page_size=10`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listResponse.json();
    const allowedResponse = await fetch(`${baseUrl}/evaluations/POLICY-EVAL-ALLOWED`, {
      headers: { Cookie: cookie },
    });
    const deniedResponse = await fetch(`${baseUrl}/evaluations/POLICY-EVAL-DENIED`, {
      headers: { Cookie: cookie },
    });
    const deniedBody = await deniedResponse.json();
    const unmappedResponse = await fetch(`${baseUrl}/evaluations/POLICY-EVAL-UNMAPPED`, {
      headers: { Cookie: cookie },
    });
    const unmappedBody = await unmappedResponse.json();

    assert.deepEqual({
      listStatus: listResponse.status,
      total: listBody.total,
      codes: listBody.tickets?.map((ticket) => ticket.ticket_code),
      allowedDetailStatus: allowedResponse.status,
      deniedDetailStatus: deniedResponse.status,
      deniedDetailError: deniedBody.error,
      unmappedDetailStatus: unmappedResponse.status,
      unmappedDetailError: unmappedBody.error,
    }, {
      listStatus: 200,
      total: 1,
      codes: ['POLICY-EVAL-ALLOWED'],
      allowedDetailStatus: 200,
      deniedDetailStatus: 403,
      deniedDetailError: 'forbidden_scope',
      unmappedDetailStatus: 403,
      unmappedDetailError: 'forbidden_scope',
    });
  });
});

test('global supplier read does not bypass evaluation create and update MCH2 scope', async () => {
  await withEvaluationFixture('qlcl-evaluation-supplier-scope', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-supplier-reader@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'MCH2', 'MCH2_HOMELINE');
    const supplierId = insertSupplier(db, {
      supplier_code: 'POLICY-OUT-OF-SCOPE-SUPPLIER',
      supplier_name: 'Out Of Scope Supplier',
      mch2: 'Dệt may',
      mch3: 'Bông vải sợi',
      created_by: null,
    });
    const allowedSupplierId = insertSupplier(db, {
      supplier_code: 'POLICY-IN-SCOPE-SUPPLIER',
      supplier_name: 'In Scope Supplier',
      mch2: 'Homeline',
      mch3: 'Văn phòng phẩm',
      created_by: email,
    });
    insertEvaluation(db, {
      ticket_code: 'POLICY-SUPPLIER-UPDATE-TICKET',
      supplier_id: allowedSupplierId,
      supplier_code: 'POLICY-IN-SCOPE-SUPPLIER',
      supplier_name: 'In Scope Supplier',
      mch2: 'Homeline',
      mch3: 'Văn phòng phẩm',
      created_by: email,
      created_at: '2026-07-14 08:00:00',
    });
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count;

    const createResponse = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({
        supplier_id: supplierId,
        evaluation_type: 'Dinh ky',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        planned_date: '2026-07-20',
        mch2: 'Dệt may',
        mch3: 'Bông vải sợi',
      }),
    });
    const createBody = await createResponse.json();
    const updateResponse = await fetch(`${baseUrl}/evaluations/POLICY-SUPPLIER-UPDATE-TICKET`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({ supplier_id: supplierId, mch2: 'Dệt may', mch3: 'Bông vải sợi' }),
    });
    const updateBody = await updateResponse.json();

    assert.deepEqual({
      createStatus: createResponse.status,
      createError: createBody.error,
      updateStatus: updateResponse.status,
      updateError: updateBody.error,
      ticketCount: db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count,
      storedSupplierId: db.prepare('SELECT supplier_id FROM evaluation_tickets WHERE ticket_code = ?')
        .get('POLICY-SUPPLIER-UPDATE-TICKET').supplier_id,
    }, {
      createStatus: 403,
      createError: 'forbidden_scope',
      updateStatus: 403,
      updateError: 'forbidden_scope',
      ticketCount: countBefore,
      storedSupplierId: allowedSupplierId,
    });
  });
});

test('evaluation create and update reject a final ticket resource outside the caller scope', async () => {
  await withEvaluationFixture('qlcl-evaluation-final-resource-scope', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-final-scope@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'MCH2', 'MCH2_HOMELINE');
    const supplierId = insertSupplier(db, {
      supplier_code: 'POLICY-FINAL-SCOPE-SUPPLIER',
      supplier_name: 'Final Scope Supplier',
      mch2: 'Homeline',
      mch3: MCH3_BY_MCH2.Homeline[0],
      created_by: email,
    });
    insertEvaluation(db, {
      ticket_code: 'POLICY-FINAL-SCOPE-TICKET',
      supplier_id: supplierId,
      supplier_code: 'POLICY-FINAL-SCOPE-SUPPLIER',
      supplier_name: 'Final Scope Supplier',
      mch2: 'Homeline',
      mch3: MCH3_BY_MCH2.Homeline[0],
      created_by: email,
      created_at: '2026-07-14 08:00:00',
    });
    const deniedMch2 = MCH2_VALUES.find((value) => value !== 'Homeline');
    const deniedMch3 = MCH3_BY_MCH2[deniedMch2][0];
    const cookie = `qlcl_token=${tokenFor(authorizationService, email)}`;
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count;

    const createResponse = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        supplier_id: supplierId,
        supplier_name: 'Final Scope Supplier',
        evaluation_type: 'Dinh ky',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        planned_date: '2026-07-20',
        mch2: deniedMch2,
        mch3: deniedMch3,
      }),
    });
    const createBody = await createResponse.json();
    const updateResponse = await fetch(`${baseUrl}/evaluations/POLICY-FINAL-SCOPE-TICKET`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ mch2: deniedMch2, mch3: deniedMch3 }),
    });
    const updateBody = await updateResponse.json();
    const stored = db.prepare('SELECT mch2, mch3 FROM evaluation_tickets WHERE ticket_code = ?')
      .get('POLICY-FINAL-SCOPE-TICKET');

    assert.deepEqual({
      createStatus: createResponse.status,
      createError: createBody.error,
      updateStatus: updateResponse.status,
      updateError: updateBody.error,
      ticketCount: db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count,
      stored,
    }, {
      createStatus: 403,
      createError: 'forbidden_scope',
      updateStatus: 403,
      updateError: 'forbidden_scope',
      ticketCount: countBefore,
      stored: { mch2: 'Homeline', mch3: MCH3_BY_MCH2.Homeline[0] },
    });
  });
});

test('RUN-18 existing supplier reference needs only global supplier read and never overwrites master data', async () => {
  await withEvaluationFixture('qlcl-evaluation-inline-supplier-write', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-inline-supplier@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'OWN', 'SELF');
    denyPermission(db, 'QLCL_SPECIALIST', 'SUPPLIER.WRITE');
    insertSupplier(db, {
      supplier_code: 'POLICY-INLINE-SUPPLIER',
      supplier_name: 'Original Supplier Name',
      mch2: 'Homeline',
      mch3: MCH3_BY_MCH2.Homeline[0],
      created_by: null,
    });
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count;

    const response = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({
        supplier_code: 'POLICY-INLINE-SUPPLIER',
        supplier_name: 'Unauthorized Supplier Rename',
        evaluation_type: 'Dinh ky',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        planned_date: '2026-07-20',
        cmc_owner: 'CMC Owner',
        cmc_head: 'CMC Head',
        mch2: 'Homeline',
        mch3: MCH3_BY_MCH2.Homeline[0],
        product_name: 'Policy product',
        snapshot_evaluation_address: 'Policy audit address',
      }),
    });
    const body = await response.json();

    assert.deepEqual({
      status: response.status,
      error: body.error,
      ticketCount: db.prepare('SELECT COUNT(*) AS count FROM evaluation_tickets').get().count,
      supplierName: db.prepare('SELECT supplier_name FROM supplier_master WHERE supplier_code = ?')
        .get('POLICY-INLINE-SUPPLIER').supplier_name,
    }, {
      status: 201,
      error: undefined,
      ticketCount: countBefore + 1,
      supplierName: 'Original Supplier Name',
    });
  });
});

test('RUN-18 evaluation selection and backend accept only ACTIVE suppliers', async () => {
  await withEvaluationFixture('qlcl-evaluation-active-supplier', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-active-supplier@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'OWN', 'SELF');
    const supplierId = insertSupplier(db, {
      supplier_code: 'POLICY-INACTIVE-SUPPLIER',
      supplier_name: 'Inactive Supplier',
      mch2: 'Homeline',
      mch3: MCH3_BY_MCH2.Homeline[0],
      status: 'INACTIVE',
      created_by: null,
    });

    const response = await fetch(`${baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${tokenFor(authorizationService, email)}`,
      },
      body: JSON.stringify({
        supplier_id: supplierId,
        evaluation_type: 'Dinh ky',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        planned_date: '2026-07-20',
      }),
    });
    const body = await response.json();
    const app = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');

    assert.equal(response.status, 409);
    assert.equal(body.error, 'supplier_inactive');
    assert.match(app, /\/suppliers\?q=' \+ encodeURIComponent\(query\) \+ '&page_size=20&status=ACTIVE'/);
  });
});

test('mixed OWN allow and MCH2 deny keep SQL list and resource detail parity for legacy MCH2', async () => {
  await withEvaluationFixture('qlcl-evaluation-mixed-scope-parity', async ({ db, authorizationService, baseUrl }) => {
    const email = 'evaluation-mixed-scope@example.invalid';
    grantRoleAndScope(db, email, 'QLCL_SPECIALIST', 'OWN', 'SELF');
    addScope(db, email, 'QLCL_SPECIALIST', 'MCH2', 'MCH2_HOMELINE', 'DENY');
    seedScopedEvaluations(db, email);
    const cookie = `qlcl_token=${tokenFor(authorizationService, email)}`;

    const listResponse = await fetch(`${baseUrl}/evaluations?q=POLICY-EVAL-&page_size=10`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listResponse.json();
    const legacyDetailResponse = await fetch(`${baseUrl}/evaluations/POLICY-EVAL-UNMAPPED`, {
      headers: { Cookie: cookie },
    });

    assert.deepEqual({
      listStatus: listResponse.status,
      codes: listBody.tickets?.map((ticket) => ticket.ticket_code).sort(),
      legacyDetailStatus: legacyDetailResponse.status,
    }, {
      listStatus: 200,
      codes: ['POLICY-EVAL-DENIED', 'POLICY-EVAL-UNMAPPED'],
      legacyDetailStatus: 200,
    });
  });
});
