const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const ROOT = path.resolve(__dirname, '..');

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'run33-test-secret';
  for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/evaluations']) {
    delete require.cache[require.resolve(modulePath)];
  }
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  return {
    ...dbModule,
    signToken: canonicalTokenFactory(dbModule, auth),
    evaluationsRouter: require('../server/routes/evaluations'),
  };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/evaluations', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function baseTicket(overrides = {}) {
  return {
    evaluation_type: 'Đánh giá định kỳ',
    planned_date: '2026-08-20',
    template: 'BM04',
    facility_type: 'CHUNG',
    supplier_scale: 'LARGE',
    cmc_owner: 'CMC phụ trách RUN-33',
    cmc_head: 'CMC trưởng phòng RUN-33',
    mch2: 'Thực phẩm công nghệ',
    mch3: 'Thực phẩm khô',
    snapshot_product_name: 'Sản phẩm RUN-33',
    ...overrides,
  };
}

test('RUN-33 migration uses canonical per-ticket location snapshot columns', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run33-schema-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const { db } = freshModules(dbPath);
  try {
    const columns = db.pragma("table_info('evaluation_tickets')").map((column) => column.name);
    for (const column of [
      'snapshot_evaluation_address',
      'snapshot_linked_facility_name',
      'snapshot_linked_facility_address',
      'snapshot_product_name',
      'supplier_introduction',
      'evaluation_department',
    ]) assert.ok(columns.includes(column), column);
    for (const legacy of ['evaluation_address', 'linked_facility_name', 'linked_facility_address', 'product_name']) {
      assert.equal(columns.includes(legacy), false, legacy);
    }
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
    process.env.DB_PATH = oldDbPath;
  }
});

test('RUN-33 form has exactly six business groups and no retired location inputs', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const form = html.slice(html.indexOf('<form id="evaluation-form"'), html.indexOf('</form>', html.indexOf('<form id="evaluation-form"')));
  assert.equal((form.match(/data-evaluation-group=/g) || []).length, 6);
  for (const title of [
    'THÔNG TIN ĐÁNH GIÁ',
    'THÔNG TIN NGÀNH HÀNG',
    'THÔNG TIN NHÀ CUNG CẤP',
    'THÔNG TIN LIÊN HỆ NCC',
    'THÔNG TIN ĐƠN VỊ LIÊN KẾT/GIA CÔNG',
    'XÁC NHẬN BỘ TIÊU CHÍ ĐÁNH GIÁ',
  ]) assert.match(form, new RegExp(title));
  for (const retiredId of [
    'new-production-address',
    'new-linked-facility-code',
    'new-linked-facility-type',
    'new-business-license-file',
    'new-attp-certificate-type',
    'new-attp-certificate-file',
    'new-method',
  ]) assert.doesNotMatch(form, new RegExp(`id="${retiredId}"`));
});

test('RUN-33 creates/reuses suppliers transactionally and preserves independent ticket locations', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run33-flow-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;
  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierId = Number(db.prepare(`INSERT INTO supplier_master (
      supplier_code, supplier_name, tax_code, address, region, province, business_type,
      contact_name, contact_email, contact_phone, status, source_type, created_by
    ) VALUES (
      'RUN33-EXISTING', 'NCC RUN-33 hiện có', 'RUN33-TAX-1', 'Trụ sở ban đầu',
      'MB', 'Thành phố Hà Nội', 'Tự sản xuất', 'Liên hệ RUN-33',
      'run33-existing@example.test', '0900000033', 'ACTIVE', 'MANUAL', 'admin@masangroup.com'
    )`).run().lastInsertRowid);
    const app = await startApp(evaluationsRouter);
    server = app.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const post = async (payload) => {
      const response = await fetch(`${app.baseUrl}/evaluations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
        body: JSON.stringify(payload),
      });
      return { response, body: await response.json() };
    };

    const supplierOnly = await post(baseTicket({
      supplier_id: supplierId,
      snapshot_evaluation_address: 'Điểm đánh giá NCC số 1',
    }));
    assert.equal(supplierOnly.response.status, 201, JSON.stringify(supplierOnly.body));

    const linkedOnly = await post(baseTicket({
      supplier_id: supplierId,
      planned_date: '2026-09-20',
      snapshot_linked_facility_name: 'Đơn vị gia công A',
      snapshot_linked_facility_address: 'Điểm gia công A',
    }));
    assert.equal(linkedOnly.response.status, 201, JSON.stringify(linkedOnly.body));

    const both = await post(baseTicket({
      supplier_id: supplierId,
      planned_date: '2026-10-20',
      snapshot_evaluation_address: 'Điểm đánh giá NCC số 2',
      snapshot_linked_facility_name: 'Đơn vị gia công B',
      snapshot_linked_facility_address: 'Điểm gia công B',
    }));
    assert.equal(both.response.status, 201, JSON.stringify(both.body));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets WHERE supplier_id=?').get(supplierId).n, 3);

    const snapshots = db.prepare(`SELECT snapshot_evaluation_address,
      snapshot_linked_facility_name, snapshot_linked_facility_address
      FROM evaluation_tickets WHERE supplier_id=? ORDER BY id`).all(supplierId);
    assert.deepEqual(snapshots, [
      { snapshot_evaluation_address: 'Điểm đánh giá NCC số 1', snapshot_linked_facility_name: null, snapshot_linked_facility_address: null },
      { snapshot_evaluation_address: null, snapshot_linked_facility_name: 'Đơn vị gia công A', snapshot_linked_facility_address: 'Điểm gia công A' },
      { snapshot_evaluation_address: 'Điểm đánh giá NCC số 2', snapshot_linked_facility_name: 'Đơn vị gia công B', snapshot_linked_facility_address: 'Điểm gia công B' },
    ]);

    db.prepare("UPDATE supplier_master SET supplier_name='Tên NCC đã đổi', address='Trụ sở đã đổi' WHERE id=?").run(supplierId);
    const original = db.prepare('SELECT supplier_name, supplier_address, snapshot_evaluation_address FROM evaluation_tickets WHERE id=?')
      .get(supplierOnly.body.ticket.id);
    assert.deepEqual(original, {
      supplier_name: 'NCC RUN-33 hiện có',
      supplier_address: 'Trụ sở ban đầu',
      snapshot_evaluation_address: 'Điểm đánh giá NCC số 1',
    });

    const newSupplierPayload = baseTicket({
      supplier_code: ' run33-new ',
      supplier_name: 'NCC RUN-33 mới',
      tax_code: 'RUN33-TAX-NEW',
      address: 'Trụ sở NCC mới',
      region: 'MB',
      province: 'Thành phố Hà Nội',
      business_type: 'Tự sản xuất',
      contact_name: 'Liên hệ NCC mới',
      contact_email: 'run33-new@example.test',
      contact_phone: '0900000133',
      snapshot_evaluation_address: 'Điểm đánh giá NCC mới',
    });
    const newSupplierTicket = await post(newSupplierPayload);
    assert.equal(newSupplierTicket.response.status, 201, JSON.stringify(newSupplierTicket.body));
    const createdSupplier = db.prepare("SELECT * FROM supplier_master WHERE supplier_code='RUN33-NEW'").get();
    assert.ok(createdSupplier);
    assert.equal(newSupplierTicket.body.ticket.supplier_id, createdSupplier.id);

    const duplicateCodeTicket = await post({ ...newSupplierPayload, supplier_code: 'RUN33-new', planned_date: '2026-11-20' });
    assert.equal(duplicateCodeTicket.response.status, 201, JSON.stringify(duplicateCodeTicket.body));
    assert.equal(duplicateCodeTicket.body.ticket.supplier_id, createdSupplier.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM supplier_master WHERE supplier_code='RUN33-NEW'").get().n, 1);

    for (const invalid of [
      baseTicket({ supplier_id: supplierId }),
      baseTicket({ supplier_id: supplierId, snapshot_linked_facility_name: 'Thiếu địa chỉ' }),
      baseTicket({ supplier_id: supplierId, snapshot_linked_facility_address: 'Thiếu tên' }),
    ]) {
      const result = await post(invalid);
      assert.equal(result.response.status, 400, JSON.stringify(result.body));
      assert.equal(result.body.error, 'validation_failed');
    }

    const rollbackCode = 'RUN33-ROLLBACK';
    const failed = await post({
      ...newSupplierPayload,
      supplier_code: rollbackCode,
      supplier_name: 'NCC phải rollback',
      facility_type: 'INVALID_VARIANT',
    });
    assert.equal(failed.response.status, 400, JSON.stringify(failed.body));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM supplier_master WHERE supplier_code=?').get(rollbackCode).n, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dbPath, { force: true });
    process.env.DB_PATH = oldDbPath;
    process.env.JWT_SECRET = oldJwtSecret;
  }
});
