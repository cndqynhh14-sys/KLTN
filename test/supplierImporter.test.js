const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const { parseSupplierWorkbook, upsertSupplier } = require('../server/services/supplierImporter');

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Suppliers');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function tempDb() {
  const dbPath = path.join(os.tmpdir(), `qlcl-supplier-test-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.resolve(__dirname, '..', 'migrations', '0001_current_schema.sql'), 'utf8'));
  db.prepare("INSERT INTO users (email, is_admin, is_active) VALUES ('admin@masangroup.com', 1, 1)").run();
  return { db, dbPath };
}

test('parseSupplierWorkbook maps common columns and returns row-level validation errors', () => {
  const parsed = parseSupplierWorkbook(workbookBuffer([
    {
      supplier_code: 'NCC001',
      supplier_name: 'Fresh Co',
      tax_code: '0101',
      contact_email: 'qa@fresh.vn',
      mch2: 'Thực phẩm tươi sống, chế biến',
      mch3: 'Rau củ',
      product_name: 'Rau',
      'Địa chỉ đánh giá NCC': 'Kho Long Biên',
      'Địa chỉ đánh giá đơn vị liên kết/gia công': 'Xưởng Gia Công A',
      'Khu vực': 'Miền Bắc',
      'Tỉnh': 'Hà Nội',
      'Loại hình kinh doanh': 'Sản xuất',
      'CMC phụ trách ngành hàng': 'owner@masangroup.com',
      'CMC Trưởng phòng ngành hàng': 'head@masangroup.com',
      'Loại chứng nhận ATTP': 'ISO 22000',
    },
    { supplier_code: '', supplier_name: 'Missing Code' },
    { supplier_code: 'NCC003', supplier_name: '', contact_email: 'bad-email' },
  ]));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].supplier_code, 'NCC001');
  assert.equal(parsed.rows[0].product_name, 'Rau');
  assert.equal(parsed.rows[0].evaluation_address, 'Kho Long Biên');
  assert.equal(parsed.rows[0].linked_facility_address, 'Xưởng Gia Công A');
  assert.equal(parsed.rows[0].region, 'Miền Bắc');
  assert.equal(parsed.rows[0].province, 'Hà Nội');
  assert.equal(parsed.rows[0].business_type, 'Sản xuất');
  assert.equal(parsed.rows[0].cmc_owner, 'owner@masangroup.com');
  assert.equal(parsed.rows[0].cmc_head, 'head@masangroup.com');
  assert.equal(parsed.rows[0].attp_certificate_type, 'ISO 22000');
  assert.equal(parsed.rows[0].status, 'ACTIVE');
  assert.equal(parsed.errors.length, 2);
  assert.ok(parsed.errors[0].errors.includes('supplier_code_required'));
  assert.ok(parsed.errors[0].errors.includes('mch2_required'));
  assert.ok(parsed.errors[1].errors.includes('supplier_name_required'));
  assert.ok(parsed.errors[1].errors.includes('contact_email_invalid'));
  assert.ok(parsed.errors[1].errors.includes('mch2_required'));
});

test('upsertSupplier updates existing supplier by supplier_code', () => {
  const { db, dbPath } = tempDb();
  try {
    upsertSupplier(db, {
      supplier_code: 'NCC001',
      supplier_name: 'Fresh Co',
      tax_code: '0101',
      status: 'ACTIVE',
    }, 'admin@masangroup.com', 'MANUAL', null);
    upsertSupplier(db, {
      supplier_code: 'NCC001',
      supplier_name: 'Fresh Company Updated',
      tax_code: '0202',
      production_address: 'Farm A',
      evaluation_address: 'Warehouse B',
      linked_facility_name: 'Processor C',
      linked_facility_address: 'Processor address',
      region: 'South',
      province: 'Long An',
      business_type: 'Manufacturing',
      cmc_owner: 'cmc-owner',
      cmc_head: 'cmc-head',
      business_license_file: 'business-license.pdf',
      attp_certificate_type: 'HACCP',
      attp_certificate_file: 'attp.pdf',
      mch2: 'Rau củ quả',
      status: 'ACTIVE',
    }, 'admin@masangroup.com', 'EXCEL_UPLOAD', null);

    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_master').get().n;
    const row = db.prepare('SELECT * FROM supplier_master WHERE supplier_code = ?').get('NCC001');
    assert.equal(count, 1);
    assert.equal(row.supplier_name, 'Fresh Company Updated');
    assert.equal(row.tax_code, '0202');
    assert.equal(row.production_address, 'Farm A');
    assert.equal(row.evaluation_address, 'Warehouse B');
    assert.equal(row.linked_facility_name, 'Processor C');
    assert.equal(row.linked_facility_address, 'Processor address');
    assert.equal(row.region, 'South');
    assert.equal(row.province, 'Long An');
    assert.equal(row.business_type, 'Manufacturing');
    assert.equal(row.cmc_owner, 'cmc-owner');
    assert.equal(row.cmc_head, 'cmc-head');
    assert.equal(row.business_license_file, 'business-license.pdf');
    assert.equal(row.attp_certificate_type, 'HACCP');
    assert.equal(row.attp_certificate_file, 'attp.pdf');
    assert.equal(row.source_type, 'EXCEL_UPLOAD');
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
