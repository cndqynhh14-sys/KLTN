'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'database', 'templates', 'supplier-import-template.xlsx');
const EXPECTED_HEADERS = [
  'supplier_code', 'supplier_name', 'tax_code', 'address',
  'production_address', 'evaluation_address', 'linked_facility_code',
  'linked_facility_name', 'linked_facility_address', 'linked_facility_type',
  'region', 'province', 'business_type', 'contact_name', 'contact_email',
  'contact_phone', 'cmc_owner', 'cmc_head', 'business_license_file',
  'attp_certificate_type', 'attp_certificate_file', 'mch2', 'mch3',
  'product_group', 'product_name', 'status',
];

function workbookBuffer(rows, headers = EXPECTED_HEADERS) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Danh sach NCC');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run03-synthetic-secret';
  [
    '../server/db',
    '../server/config/paths',
    '../server/middleware/auth',
    '../server/routes/suppliers',
    '../server/services/supplierImporter',
    '../server/repositories/SupplierRepository',
  ].forEach((modulePath) => delete require.cache[require.resolve(modulePath)]);
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  return {
    ...dbModule,
    ...auth,
    suppliersRouter: require('../server/routes/suppliers'),
    SupplierRepository: require('../server/repositories/SupplierRepository'),
    merchandising: require('../server/domain/merchandising'),
  };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/suppliers', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function validRow(merchandising, overrides = {}) {
  const mch2 = merchandising.MCH2_VALUES[0];
  const mch3 = merchandising.MCH3_BY_MCH2[mch2][0];
  const values = {
    supplier_code: 'NCC-RUN03-001',
    supplier_name: 'NCC Synthetic RUN-03',
    tax_code: '0100000001',
    address: 'Địa chỉ synthetic',
    contact_email: 'run03@example.invalid',
    mch2,
    mch3,
    product_name: 'Sản phẩm synthetic',
    status: 'ACTIVE',
    ...overrides,
  };
  return EXPECTED_HEADERS.map((header) => values[header] || '');
}

async function postWorkbook(baseUrl, token, buffer, fileName = 'supplier-import.xlsx') {
  const form = new FormData();
  form.append('file', new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), fileName);
  return fetch(`${baseUrl}/suppliers/import-excel`, {
    method: 'POST',
    headers: { Cookie: `qlcl_token=${token}` },
    body: form,
  });
}

test('RUN-03 supplier UI uses the approved labels and exposes a template download action', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const actions = require('../public/js/action-registry');

  assert.match(html, /id="btn-import-suppliers"[^>]*>Tải danh sách NCC<\/button>/);
  assert.match(html, /id="supplier-import-modal"[\s\S]*?<h3[^>]*>Tải danh sách NCC<\/h3>/);
  assert.match(html, /id="btn-download-supplier-template"[^>]*>Tải file mẫu<\/button>/);
  assert.doesNotMatch(html, /Tải danh mục NCC lên/);
  assert.match(app, /\/suppliers\/import-template/);
  assert.equal(actions.STATIC_ACTION_BINDINGS['btn-download-supplier-template'], 'supplier.download_template');
  assert.equal(actions.getAction('supplier.download_template').permission, 'SUPPLIER.WRITE');
});

test('RUN-03 downloadable workbook matches the importer contract and its synthetic row is importable', () => {
  assert.equal(fs.existsSync(TEMPLATE_PATH), true, 'supplier import template must exist');
  const workbook = XLSX.readFile(TEMPLATE_PATH);
  assert.deepEqual(workbook.SheetNames, ['Danh sách NCC', 'Hướng dẫn', 'Danh mục']);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Danh sách NCC'], { header: 1, defval: '' });
  assert.deepEqual(rows[0], EXPECTED_HEADERS);
  const { parseSupplierWorkbook, SUPPLIER_IMPORT_HEADERS } = require('../server/services/supplierImporter');
  assert.deepEqual(SUPPLIER_IMPORT_HEADERS, EXPECTED_HEADERS);
  const parsed = parseSupplierWorkbook(fs.readFileSync(TEMPLATE_PATH));
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.equal(parsed.rows.length, 1);
  assert.match(parsed.rows[0].supplier_code, /^NCC-MAU-/);
});

test('RUN-03 template endpoint downloads the canonical workbook with SUPPLIER.WRITE', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run03-template-${Date.now()}-${Math.random()}.db`);
  const fx = freshModules(dbPath);
  let server;
  try {
    fx.db.prepare("INSERT INTO users (email, is_admin, role, is_active) VALUES ('admin@example.invalid', 1, 'Admin', 1)").run();
    const app = await startApp(fx.suppliersRouter);
    server = app.server;
    const token = fx.signToken({ email: 'admin@example.invalid', isAdmin: true, role: 'Admin' }, 3600);
    const response = await fetch(`${app.baseUrl}/suppliers/import-template`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') || '', /mau-import-danh-sach-ncc\.xlsx/i);
    const templateBuffer = Buffer.from(await response.arrayBuffer());
    const parsed = require('../server/services/supplierImporter')
      .parseSupplierWorkbook(templateBuffer);
    assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
    const importResponse = await postWorkbook(app.baseUrl, token, templateBuffer, 'mau-import-danh-sach-ncc.xlsx');
    const importJson = await importResponse.json();
    assert.equal(importResponse.status, 200, JSON.stringify(importJson));
    assert.deepEqual(importJson.summary, {
      total_rows: 1,
      success_rows: 1,
      failed_rows: 0,
      status: 'COMPLETED',
    });
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM supplier_master WHERE supplier_code = ?')
      .get('NCC-MAU-001').count, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-03 invalid row aborts the whole file and reports row plus column', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run03-atomic-${Date.now()}-${Math.random()}.db`);
  const fx = freshModules(dbPath);
  let server;
  try {
    fx.db.prepare("INSERT INTO users (email, is_admin, role, is_active) VALUES ('admin@example.invalid', 1, 'Admin', 1)").run();
    const app = await startApp(fx.suppliersRouter);
    server = app.server;
    const token = fx.signToken({ email: 'admin@example.invalid', isAdmin: true, role: 'Admin' }, 3600);
    const valid = validRow(fx.merchandising);
    const invalid = validRow(fx.merchandising, { supplier_code: 'NCC-RUN03-002', contact_email: 'not-an-email' });
    const response = await postWorkbook(app.baseUrl, token, workbookBuffer([valid, invalid]));
    const json = await response.json();
    assert.equal(response.status, 422, JSON.stringify(json));
    assert.deepEqual(json.summary, {
      total_rows: 2,
      success_rows: 0,
      failed_rows: 2,
      validation_error_rows: 1,
      status: 'FAILED',
    });
    assert.ok(json.errors.some((error) => error.row === 3 &&
      error.details.some((detail) => detail.column === 'contact_email' && detail.code === 'contact_email_invalid')));
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM supplier_master').get().count, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-03 wrong headers and duplicate supplier codes reject the whole workbook', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run03-duplicate-${Date.now()}-${Math.random()}.db`);
  const fx = freshModules(dbPath);
  let server;
  try {
    fx.db.prepare("INSERT INTO users (email, is_admin, role, is_active) VALUES ('admin@example.invalid', 1, 'Admin', 1)").run();
    const app = await startApp(fx.suppliersRouter);
    server = app.server;
    const token = fx.signToken({ email: 'admin@example.invalid', isAdmin: true, role: 'Admin' }, 3600);

    const wrongHeader = await postWorkbook(app.baseUrl, token,
      workbookBuffer([['NCC-RUN03-HDR']], ['supplier_code']), 'wrong-header.xlsx');
    const wrongHeaderJson = await wrongHeader.json();
    assert.equal(wrongHeader.status, 422, JSON.stringify(wrongHeaderJson));
    assert.deepEqual(wrongHeaderJson.errors[0].missing_headers, ['supplier_name']);

    const duplicateCode = 'NCC-RUN03-DUP';
    const duplicate = await postWorkbook(app.baseUrl, token, workbookBuffer([
      validRow(fx.merchandising, { supplier_code: duplicateCode }),
      validRow(fx.merchandising, { supplier_code: duplicateCode, supplier_name: 'Dòng trùng synthetic' }),
    ]), 'duplicate.xlsx');
    const duplicateJson = await duplicate.json();
    assert.equal(duplicate.status, 422, JSON.stringify(duplicateJson));
    assert.ok(duplicateJson.errors.some((error) => error.row === 3 &&
      error.details.some((detail) => detail.column === 'supplier_code' && detail.code === 'supplier_code_duplicate_in_file')));
    assert.equal(fx.db.prepare('SELECT COUNT(*) AS count FROM supplier_master').get().count, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fx.db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-03 repository transaction rolls back the batch and prior rows when persistence fails', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations', '0001_current_schema.sql'), 'utf8'));
  db.prepare("INSERT INTO users (email, is_admin, is_active) VALUES ('admin@example.invalid', 1, 1)").run();
  const SupplierRepository = require('../server/repositories/SupplierRepository');
  const repository = new SupplierRepository(db);
  let attempt = 0;

  assert.throws(() => repository.importExcel({
    fileName: 'rollback.xlsx',
    userEmail: 'admin@example.invalid',
    totalRows: 2,
    successRows: 2,
    failedRows: 0,
    status: 'COMPLETED',
    errors: [],
    rows: [{ supplier_code: 'NCC-RB-1' }, { supplier_code: 'NCC-RB-2' }],
    upsertSupplier(database, row) {
      attempt += 1;
      database.prepare('INSERT INTO supplier_master (supplier_code, supplier_name, source_type) VALUES (?, ?, ?)')
        .run(row.supplier_code, row.supplier_code, 'EXCEL_UPLOAD');
      if (attempt === 2) throw new Error('synthetic_persistence_failure');
    },
  }), /synthetic_persistence_failure/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_master').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_import_batches').get().count, 0);
  db.close();
});
