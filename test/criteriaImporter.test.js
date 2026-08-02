const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const { migrateDatabase } = require('../server/database/migrationRunner');

const {
  importCriteriaWorkbook,
  normalizeFacilityType,
  parseCriteriaWorkbook,
  parseSheetName,
} = require('../server/services/criteriaImporter');

function fixtureWorkbookBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['TT', 'Hạng mục', 'Điều khoản'],
    ['1', 'Giấy phép, hồ sơ', ''],
    ['1.1', 'Hồ sơ pháp lý', 'Giấy phép kinh doanh\n*Điều khoản loại'],
    ['1.2', 'Kiểm soát chất lượng sản phẩm', 'Hồ sơ chất lượng (Điều khoản chính yếu)'],
    ['1.3', 'Truy xuất nguồn gốc', 'Lưu hồ sơ lô sản xuất'],
  ]), 'BM01 - Cơ sở trồng trọt-NCC lớn');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['TT', 'Hạng mục', 'Điều khoản'],
    ['2.1', 'Hồ sơ pháp lý', 'Giấy chứng nhận ATTP\n*Điều khoản loại'],
  ]), 'BM02-Giết mổ + sơ chế-NCC nhỏ');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function tempDb() {
  const dbPath = path.join(os.tmpdir(), `qlcl-criteria-test-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir: path.resolve(__dirname, '..', 'migrations'), appVersion: 'criteria-test' });
  return { db, dbPath };
}

test('parseSheetName derives BM form, facility type, and supplier scale', () => {
  assert.deepEqual(parseSheetName('BM03-Kinh doanh thủy sản-nccnho'), {
    sheet_name: 'BM03-Kinh doanh thủy sản-nccnho',
    template_code: 'BM03',
    facility_type: 'KINH_DOANH_THUY_SAN',
    facility_label: 'Kinh doanh thủy sản',
    supplier_scale: 'SMALL',
    expected_criterion_count: 49,
    source_sheet: 'BM03-Kinh doanh thủy sản-nccnho',
  });
  assert.equal(normalizeFacilityType('Cơ sở sơ chế'), 'CO_SO_SO_CHE');
});

test('criteria workbook import maps DOC-3 markers and is idempotent', () => {
  const { db, dbPath } = tempDb();
  try {
    const buffer = fixtureWorkbookBuffer();
    const parsed = parseCriteriaWorkbook(buffer);
    assert.equal(parsed.criteria.length, 4);
    assert.equal(parsed.variants.length, 2);
    assert.equal(parsed.variants[0].criterion_count, 3);

    const first = importCriteriaWorkbook(db, buffer);
    const second = importCriteriaWorkbook(db, buffer);
    assert.equal(first.imported, 4);
    assert.equal(second.imported, 4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM question_items').get().n, 4);

    const elimination = db.prepare(`
      SELECT q.*, t.template_code
      FROM question_items q
      JOIN question_template_versions v ON v.id=q.question_template_version_id
      JOIN question_templates t ON t.id = v.template_id
      WHERE t.template_code = 'BM01' AND q.question_code = '1.1'
    `).get();
    assert.equal(elimination.facility_type, 'CO_SO_TRONG_TROT');
    assert.equal(elimination.supplier_scale, 'LARGE');
    assert.equal(elimination.is_elimination_clause, 1);
    assert.equal(elimination.requires_attachment, 0);
    assert.equal(elimination.allowed_scores, 'A/D/NA');
    assert.doesNotMatch(elimination.question_text, /Điều khoản loại/);

    const critical = db.prepare(`
      SELECT q.*
      FROM question_items q
      JOIN question_template_versions v ON v.id=q.question_template_version_id
      JOIN question_templates t ON t.id = v.template_id
      WHERE t.template_code = 'BM01' AND q.question_code = '1.2'
    `).get();
    assert.equal(critical.is_critical_clause, 1);
    assert.equal(critical.allowed_scores, 'A/B/C/D/NA');
    db.prepare('UPDATE question_items SET requires_attachment = 1 WHERE id = ?').run(critical.id);
    db.prepare('UPDATE question_items SET requires_attachment = 1 WHERE id = ?').run(elimination.id);
    importCriteriaWorkbook(db, buffer);
    assert.equal(db.prepare('SELECT requires_attachment FROM question_items WHERE id = ?').get(elimination.id).requires_attachment, 0);
    assert.equal(db.prepare('SELECT requires_attachment FROM question_items WHERE id = ?').get(critical.id).requires_attachment, 1);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
