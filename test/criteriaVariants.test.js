const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CRITERIA_VARIANTS,
  getCriteriaVariant,
  getCriteriaVariantsForTemplate,
  normalizeSupplierScale,
  validateCriteriaVariant,
} = require('../server/domain/criteriaVariants');

test('canonical criteria variants cover all DOC-3 BM facility and scale combinations', () => {
  assert.equal(CRITERIA_VARIANTS.length, 16);
  assert.equal(CRITERIA_VARIANTS.reduce((sum, variant) => sum + variant.expected_criterion_count, 0), 827);
  assert.equal(getCriteriaVariantsForTemplate('BM01').length, 4);
  assert.equal(getCriteriaVariantsForTemplate('BM02').length, 4);
  assert.equal(getCriteriaVariantsForTemplate('BM03').length, 6);
  assert.equal(getCriteriaVariantsForTemplate('BM04').length, 2);
});

test('criteria variant validation accepts only canonical combinations', () => {
  const valid = validateCriteriaVariant('BM03', 'KINH_DOANH_THUY_SAN', 'SMALL');
  assert.equal(valid.ok, true);
  assert.equal(valid.variant.source_sheet, 'BM03-Kinh doanh thủy sản-nccnho');

  const invalid = validateCriteriaVariant('BM04', 'KINH_DOANH_THUY_SAN', 'SMALL');
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors, ['criteria_variant_invalid']);
  assert.equal(getCriteriaVariant('BM02', 'CO_SO_PHA_LOC', 'LARGE').expected_criterion_count, 32);
});

test('supplier scale normalization preserves enum values and legacy labels', () => {
  assert.equal(normalizeSupplierScale('LARGE'), 'LARGE');
  assert.equal(normalizeSupplierScale('SMALL'), 'SMALL');
  assert.equal(normalizeSupplierScale('Nhỏ lẻ'), 'SMALL');
  assert.equal(normalizeSupplierScale('Lớn'), 'LARGE');
});
