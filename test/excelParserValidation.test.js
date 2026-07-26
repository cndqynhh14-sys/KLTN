const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { parseCriteriaWorkbook } = require('../server/services/criteriaImporter');
const { parseSupplierWorkbook } = require('../server/services/supplierImporter');

function aoaWorkbookBuffer(sheetName, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function jsonWorkbookBuffer(sheetName, rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('supplier importer returns template validation error for missing required columns', () => {
  const parsed = parseSupplierWorkbook(jsonWorkbookBuffer('Suppliers', [
    { supplier_code: 'NCC001', tax_code: '0101' },
  ]));

  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.errors[0].error, 'template_invalid');
  assert.equal(parsed.errors[0].sheet, 'Suppliers');
  assert.deepEqual(parsed.errors[0].missing_headers, ['supplier_name']);
});

test('criteria importer rejects BM sheet missing question column before parsing rows', () => {
  const buffer = aoaWorkbookBuffer('BM01 - Cơ sở trồng trọt-NCC lớn', [
    ['TT', 'Hạng mục'],
    ['1.1', 'Hồ sơ pháp lý'],
  ]);

  assert.throws(
    () => parseCriteriaWorkbook(buffer),
    (error) => {
      assert.equal(error.code, 'criteria_template_invalid');
      assert.equal(error.sheet, 'BM01 - Cơ sở trồng trọt-NCC lớn');
      assert.deepEqual(error.missing_columns, ['Điều khoản/Câu hỏi']);
      return true;
    }
  );
});

