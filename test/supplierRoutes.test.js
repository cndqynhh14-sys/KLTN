const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  [
    '../server/db',
    '../server/middleware/auth',
    '../server/routes/suppliers',
    '../server/domain/merchandising',
  ].forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const suppliersRouter = require('../server/routes/suppliers');
  const merchandising = require('../server/domain/merchandising');
  const roles = require('../server/domain/roles');
  return { ...dbModule, ...auth, signToken: canonicalTokenFactory(dbModule, auth), suppliersRouter, merchandising, roles };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/suppliers', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('manual supplier dialog wires required field validation before submit', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  [
    'supplier-tax-code',
    'supplier-address',
    'supplier-region',
    'supplier-province',
    'supplier-business-type',
    'supplier-contact-name',
    'supplier-contact-email',
    'supplier-contact-phone',
  ].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"[^>]*required`), id);
    assert.match(html, new RegExp(`data-supplier-error-for="${id}"`), id);
  });
  assert.match(app, /SUPPLIER_REQUIRED_FIELD_SPECS/);
  assert.match(html, /<select id="new-region"[^>]*name="region"/);
  assert.match(html, /<select id="new-province"[^>]*name="province"[^>]*disabled/);
  assert.match(html, /<select id="new-business-type"[^>]*name="business_type"/);
  assert.match(app, /PROVINCES_BY_REGION/);
  assert.match(app, /refreshProvinceOptions\('new', true\)/);
  assert.match(app, /validateSupplierRequiredFields\(\)/);
  assert.match(app, /applySupplierServerErrors\(errors\)/);
  assert.match(html, /class="supplier-modal-panel manual-supplier-modal/);
  assert.match(html, /class="manual-supplier-grid"/);
  [
    'Thông tin nhà cung cấp',
    'Thông tin liên hệ',
  ].forEach((label) => assert.match(html, new RegExp(label), label));
  [
    'supplier-production-address', 'supplier-evaluation-address', 'supplier-linked-facility-code',
    'supplier-mch2', 'supplier-mch3', 'supplier-product-name', 'supplier-cmc-owner',
  ].forEach((id) => assert.doesNotMatch(html, new RegExp(`id="${id}"`), id));
  assert.match(html, /id="btn-cancel-supplier"[^>]*modal-x-button/);
  assert.doesNotMatch(html, /id="btn-cancel-supplier"[^>]*>Bỏ thay đổi</);
  assert.match(html, /id="btn-save-supplier" class="btn-primary">Lưu NCC<\/button>/);
  assert.match(app, /Vui lòng nhập đầy đủ các trường bắt buộc/);
});

test('manual supplier creation requires business fields before insert', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-route-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, suppliersRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const appInfo = await startApp(suppliersRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const res = await fetch(`${appInfo.baseUrl}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ supplier_code: 'NCC-MISSING', supplier_name: 'Missing Fields Supplier' }),
    });
    const json = await res.json();
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.equal(json.error, 'validation_failed');
    [
      'tax_code',
      'address',
      'region',
      'province',
      'business_type',
      'contact_name',
      'contact_email',
      'contact_phone',
    ].forEach((field) => assert.equal(json.errors[field], 'required', field));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_master WHERE supplier_code = ?').get('NCC-MISSING').count, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    ['../server/db', '../server/middleware/auth', '../server/routes/suppliers'].forEach((modulePath) => {
      delete require.cache[require.resolve(modulePath)];
    });
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});

test('manual supplier creation succeeds after required fields are provided', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-route-ok-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, suppliersRouter, merchandising } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const appInfo = await startApp(suppliersRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const mch2 = merchandising.MCH2_VALUES[0];
    const mch3 = merchandising.MCH3_BY_MCH2[mch2][0];

    const res = await fetch(`${appInfo.baseUrl}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        supplier_code: 'NCC-OK',
        supplier_name: 'Complete Supplier',
        tax_code: '0101234567',
        address: 'Supplier HQ',
        production_address: 'Factory A',
        evaluation_address: 'Audit Site A',
        region: 'MB',
        province: 'Thành phố Hà Nội',
        business_type: 'Tự sản xuất',
        contact_name: 'Nguyen Van A',
        contact_email: 'supplier@example.com',
        contact_phone: '0900000000',
        mch2,
        mch3,
        product_name: 'Product A',
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 201, JSON.stringify(json));
    assert.equal(json.item.supplier_code, 'NCC-OK');
    assert.equal(json.item.tax_code, '0101234567');
    assert.equal(json.item.region, 'MB');
    assert.equal(json.item.province, 'Thành phố Hà Nội');
    assert.equal(json.item.business_type, 'Tự sản xuất');
    assert.equal(json.item.contact_email, 'supplier@example.com');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_master WHERE supplier_code = ?').get('NCC-OK').count, 1);
    const duplicateRes = await fetch(`${appInfo.baseUrl}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        supplier_code: ' ncc-ok ', supplier_name: 'Duplicate Supplier', tax_code: '0109999999',
        address: 'Other HQ', region: 'MB', province: 'Thành phố Hà Nội', business_type: 'Kinh doanh',
        contact_name: 'Duplicate', contact_email: 'duplicate@example.com', contact_phone: '0911111111',
      }),
    });
    assert.equal(duplicateRes.status, 409, JSON.stringify(await duplicateRes.json()));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_master').get().count, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    ['../server/db', '../server/middleware/auth', '../server/routes/suppliers', '../server/domain/merchandising'].forEach((modulePath) => {
      delete require.cache[require.resolve(modulePath)];
    });
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});

test('manual supplier creation rejects non-standard master data values', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-route-master-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, suppliersRouter, merchandising } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const appInfo = await startApp(suppliersRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const mch2 = merchandising.MCH2_VALUES[0];
    const mch3 = merchandising.MCH3_BY_MCH2[mch2][0];

    const res = await fetch(`${appInfo.baseUrl}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        supplier_code: 'NCC-BAD-MASTER',
        supplier_name: 'Bad Master Supplier',
        tax_code: '0101234567',
        address: 'Supplier HQ',
        production_address: 'Factory A',
        evaluation_address: 'Audit Site A',
        region: 'MB',
        province: 'Thành phố Hồ Chí Minh',
        business_type: 'Sản xuất',
        contact_name: 'Nguyen Van A',
        contact_email: 'supplier@example.com',
        contact_phone: '0900000000',
        mch2,
        mch3,
        product_name: 'Product A',
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.equal(json.error, 'validation_failed');
    assert.equal(json.errors.province, 'invalid');
    assert.equal(json.errors.business_type, 'invalid');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM supplier_master WHERE supplier_code = ?').get('NCC-BAD-MASTER').count, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    ['../server/db', '../server/middleware/auth', '../server/routes/suppliers', '../server/domain/merchandising'].forEach((modulePath) => {
      delete require.cache[require.resolve(modulePath)];
    });
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});

test('supplier detail and history support internal read and specialist edit permissions', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-route-history-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, suppliersRouter, merchandising, roles } = freshModules(dbPath);
  let server;

  try {
    const users = [
      ['specialist@masangroup.com', 0, roles.ROLES.SPECIALIST, 'Specialist User'],
      ['lead@masangroup.com', 0, roles.ROLES.LEAD, 'Lead User'],
      ['ncc@partner.com', 0, roles.ROLES.SUPPLIER, 'Supplier Portal'],
    ];
    users.forEach(([email, isAdmin, role, displayName]) => upsertCanonicalUser(db, {
      email, role, isAdmin: Boolean(isAdmin), displayName,
    }));
    const appInfo = await startApp(suppliersRouter);
    server = appInfo.server;
    const specialistToken = signToken({ email: 'specialist@masangroup.com', isAdmin: false, role: roles.ROLES.SPECIALIST }, 3600);
    const leadToken = signToken({ email: 'lead@masangroup.com', isAdmin: false, role: roles.ROLES.LEAD }, 3600);
    const supplierToken = signToken({ email: 'ncc@partner.com', isAdmin: false, role: roles.ROLES.SUPPLIER }, 3600);
    const mch2 = merchandising.MCH2_VALUES[0];
    const mch3 = merchandising.MCH3_BY_MCH2[mch2][0];

    const createRes = await fetch(`${appInfo.baseUrl}/suppliers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${specialistToken}` },
      body: JSON.stringify({
        supplier_code: 'NCC-HISTORY',
        supplier_name: 'History Supplier',
        tax_code: '0101234567',
        address: 'Supplier HQ',
        production_address: 'Factory A',
        evaluation_address: 'Audit Site A',
        region: 'MB',
        province: 'Thành phố Hà Nội',
        business_type: 'Tự sản xuất',
        contact_name: 'Contact A',
        contact_email: 'supplier@example.com',
        contact_phone: '0900000000',
        mch2,
        mch3,
        product_name: 'Product A',
      }),
    });
    const createJson = await createRes.json();
    assert.equal(createRes.status, 201, JSON.stringify(createJson));

    const detailRes = await fetch(`${appInfo.baseUrl}/suppliers/NCC-HISTORY`, {
      headers: { Cookie: `qlcl_token=${leadToken}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.equal(detailJson.item.supplier_code, 'NCC-HISTORY');
    assert.equal(detailJson.item.created_by_display_name, 'Specialist User');

    const forbiddenUpdateRes = await fetch(`${appInfo.baseUrl}/suppliers/${createJson.item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${leadToken}` },
      body: JSON.stringify({ contact_name: 'Lead Edit' }),
    });
    assert.equal(forbiddenUpdateRes.status, 403);

    const updateRes = await fetch(`${appInfo.baseUrl}/suppliers/${createJson.item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${specialistToken}` },
      body: JSON.stringify({ contact_name: 'Contact B' }),
    });
    const updateJson = await updateRes.json();
    assert.equal(updateRes.status, 200, JSON.stringify(updateJson));
    assert.equal(updateJson.item.contact_name, 'Contact B');

    const historyRes = await fetch(`${appInfo.baseUrl}/suppliers/NCC-HISTORY/history`, {
      headers: { Cookie: `qlcl_token=${leadToken}` },
    });
    const historyJson = await historyRes.json();
    assert.equal(historyRes.status, 200, JSON.stringify(historyJson));
    assert.equal(historyJson.items[0].action, 'Cập nhật NCC');
    assert.equal(historyJson.items[0].field_name, 'Người liên hệ');
    assert.equal(historyJson.items[0].previous_value, 'Contact A');
    assert.equal(historyJson.items[0].new_value, 'Contact B');
    assert.equal(historyJson.items[0].actor_user_id_display_name, 'Specialist User');
    assert.ok(historyJson.items.some((row) => row.action === 'Tạo NCC'));

    const forbiddenDetailRes = await fetch(`${appInfo.baseUrl}/suppliers/NCC-HISTORY`, {
      headers: { Cookie: `qlcl_token=${supplierToken}` },
    });
    assert.equal(forbiddenDetailRes.status, 403);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    ['../server/db', '../server/middleware/auth', '../server/routes/suppliers', '../server/domain/merchandising'].forEach((modulePath) => {
      delete require.cache[require.resolve(modulePath)];
    });
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});
