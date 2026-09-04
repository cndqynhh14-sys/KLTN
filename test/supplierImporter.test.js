const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const { parseSupplierWorkbook, upsertSupplier } = require('../server/services/supplierImporter');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Suppliers');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function tempDb() {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-test-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir: path.resolve(__dirname, '..', 'migrations'), appVersion: 'supplier-import-test' });
  upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
  return { db, dbPath };
}

test('parseSupplierWorkbook maps RUN-32 columns, normalizes codes and returns row-level errors', () => {
  const parsed = parseSupplierWorkbook(workbookBuffer([
    {
      supplier_code: ' ncc001 ', supplier_name: 'Fresh Co', tax_code: '0101',
      address: 'Hà Nội', region: 'MB', province: 'Thành phố Hà Nội',
      business_type: 'Kinh doanh', contact_name: 'Nguyễn A',
      contact_email: 'qa@fresh.vn', contact_phone: '0901 234 567', status: 'active',
    },
    { supplier_code: '', supplier_name: 'Missing Code' },
    { supplier_code: 'NCC003', supplier_name: '', contact_email: 'bad-email', contact_phone: 'abc' },
  ]));

  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    supplier_code: 'NCC001', supplier_name: 'Fresh Co', tax_code: '0101', address: 'Hà Nội',
    region: 'MB', province: 'Thành phố Hà Nội', business_type: 'Kinh doanh',
    contact_name: 'Nguyễn A', contact_email: 'qa@fresh.vn', contact_phone: '0901 234 567', status: 'ACTIVE',
  });
  assert.equal(parsed.errors.length, 2);
  assert.ok(parsed.errors[0].errors.includes('supplier_code_required'));
  assert.ok(parsed.errors[1].errors.includes('supplier_name_required'));
  assert.ok(parsed.errors[1].errors.includes('contact_email_invalid'));
  assert.ok(parsed.errors[1].errors.includes('contact_phone_invalid'));
});

test('upsertSupplier uses normalized supplier_code as the only business key', () => {
  const { db, dbPath } = tempDb();
  try {
    upsertSupplier(db, {
      supplier_code: ' ncc001 ', supplier_name: 'Fresh Co', tax_code: '0101', status: 'ACTIVE',
    }, 'admin@masangroup.com', 'MANUAL', null);
    upsertSupplier(db, {
      supplier_code: 'NCC001', supplier_name: 'Fresh Company Updated', tax_code: '0202',
      address: 'Hà Nội', region: 'MB', province: 'Thành phố Hà Nội', business_type: 'Kinh doanh',
      contact_name: 'Contact', contact_email: 'contact@example.com', contact_phone: '0900000000', status: 'ACTIVE',
    }, 'admin@masangroup.com', 'EXCEL_UPLOAD', null);

    const rows = db.prepare('SELECT * FROM supplier_master').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].supplier_code, 'NCC001');
    assert.equal(rows[0].supplier_name, 'Fresh Company Updated');
    assert.equal(rows[0].tax_code, '0202');
    assert.equal(rows[0].address, 'Hà Nội');
    assert.equal(rows[0].business_type, 'Kinh doanh');
    assert.equal(rows[0].source_type, 'EXCEL_UPLOAD');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
