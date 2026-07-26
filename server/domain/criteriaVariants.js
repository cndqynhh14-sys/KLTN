const CRITERIA_VARIANTS = [
  { template_code: 'BM01', facility_type: 'CO_SO_TRONG_TROT', facility_label: 'Cơ sở trồng trọt', supplier_scale: 'LARGE', source_sheet: 'BM01 - Cơ sở trồng trọt-NCC lớn', expected_criterion_count: 44 },
  { template_code: 'BM01', facility_type: 'CO_SO_TRONG_TROT', facility_label: 'Cơ sở trồng trọt', supplier_scale: 'SMALL', source_sheet: 'BM01 - Cơ sở trồng trọt-NCC nhỏ', expected_criterion_count: 43 },
  { template_code: 'BM01', facility_type: 'CO_SO_SO_CHE', facility_label: 'Cơ sở sơ chế', supplier_scale: 'LARGE', source_sheet: 'BM01 - Cơ sở sơ chế-NCC lớn', expected_criterion_count: 37 },
  { template_code: 'BM01', facility_type: 'CO_SO_SO_CHE', facility_label: 'Cơ sở sơ chế', supplier_scale: 'SMALL', source_sheet: 'BM01 - Cơ sở sơ chế-NCC nhỏ', expected_criterion_count: 31 },
  { template_code: 'BM02', facility_type: 'GIET_MO_SO_CHE', facility_label: 'Giết mổ + sơ chế', supplier_scale: 'LARGE', source_sheet: 'BM02-Giết mổ + sơ chế-NCC lớn', expected_criterion_count: 84 },
  { template_code: 'BM02', facility_type: 'GIET_MO_SO_CHE', facility_label: 'Giết mổ + sơ chế', supplier_scale: 'SMALL', source_sheet: 'BM02-Giết mổ + sơ chế-NCC nhỏ', expected_criterion_count: 67 },
  { template_code: 'BM02', facility_type: 'CO_SO_PHA_LOC', facility_label: 'Cơ sở pha lóc', supplier_scale: 'LARGE', source_sheet: 'BM02-Cơ sở pha lóc-NCC lớn', expected_criterion_count: 32 },
  { template_code: 'BM02', facility_type: 'CO_SO_PHA_LOC', facility_label: 'Cơ sở pha lóc', supplier_scale: 'SMALL', source_sheet: 'BM02-Cơ sở pha lóc-NCC nhỏ', expected_criterion_count: 31 },
  { template_code: 'BM03', facility_type: 'CO_SO_NUOI_TRONG', facility_label: 'Cơ sở nuôi trồng', supplier_scale: 'LARGE', source_sheet: 'BM03-Cơ sở nuôi trồng- NCC lớn', expected_criterion_count: 27 },
  { template_code: 'BM03', facility_type: 'CO_SO_NUOI_TRONG', facility_label: 'Cơ sở nuôi trồng', supplier_scale: 'SMALL', source_sheet: 'BM03-Cơ sở nuôi trồng- NCC nhỏ', expected_criterion_count: 26 },
  { template_code: 'BM03', facility_type: 'SO_CHE_SAN_XUAT', facility_label: 'Sơ chế, sản xuất', supplier_scale: 'LARGE', source_sheet: 'BM03-Sơ chế,sản xuất- NCC lớn', expected_criterion_count: 95 },
  { template_code: 'BM03', facility_type: 'SO_CHE_SAN_XUAT', facility_label: 'Sơ chế, sản xuất', supplier_scale: 'SMALL', source_sheet: 'BM03-Sơ chế,sản xuất- NCC nhỏ', expected_criterion_count: 86 },
  { template_code: 'BM03', facility_type: 'KINH_DOANH_THUY_SAN', facility_label: 'Kinh doanh thủy sản', supplier_scale: 'LARGE', source_sheet: 'BM03-Kinh doanh thủy sản-ncclớn', expected_criterion_count: 49 },
  { template_code: 'BM03', facility_type: 'KINH_DOANH_THUY_SAN', facility_label: 'Kinh doanh thủy sản', supplier_scale: 'SMALL', source_sheet: 'BM03-Kinh doanh thủy sản-nccnho', expected_criterion_count: 49 },
  { template_code: 'BM04', facility_type: 'CHUNG', facility_label: 'Chung', supplier_scale: 'LARGE', source_sheet: 'BM04-NCC lớn', expected_criterion_count: 63 },
  { template_code: 'BM04', facility_type: 'CHUNG', facility_label: 'Chung', supplier_scale: 'SMALL', source_sheet: 'BM04-NCC nhỏ', expected_criterion_count: 63 },
];

function normalizeTemplateCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSupplierScale(value) {
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  const ascii = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
  if (['SMALL', 'NHO', 'NHỎ', 'NHỎ LẺ'].includes(upper) || ascii.includes('nho')) return 'SMALL';
  if (['LARGE', 'LON', 'LỚN'].includes(upper) || ascii.includes('lon')) return 'LARGE';
  return upper;
}

function getCriteriaVariant(templateCode, facilityType, supplierScale) {
  const code = normalizeTemplateCode(templateCode);
  const facility = String(facilityType || '').trim().toUpperCase();
  const scale = normalizeSupplierScale(supplierScale);
  return CRITERIA_VARIANTS.find((variant) =>
    variant.template_code === code &&
    variant.facility_type === facility &&
    variant.supplier_scale === scale
  ) || null;
}

function getCriteriaVariantsForTemplate(templateCode) {
  const code = normalizeTemplateCode(templateCode);
  return CRITERIA_VARIANTS.filter((variant) => variant.template_code === code);
}

function getCriteriaVariantBySheetName(sheetName) {
  const raw = String(sheetName || '').trim();
  return CRITERIA_VARIANTS.find((variant) => variant.source_sheet === raw) || null;
}

function validateCriteriaVariant(templateCode, facilityType, supplierScale) {
  const errors = [];
  const code = normalizeTemplateCode(templateCode);
  if (!code) errors.push('template_required');
  if (!String(facilityType || '').trim()) errors.push('facility_type_required');
  if (!String(supplierScale || '').trim()) errors.push('supplier_scale_required');
  if (errors.length) return { ok: false, errors, variant: null };
  const variant = getCriteriaVariant(code, facilityType, supplierScale);
  if (!variant) errors.push('criteria_variant_invalid');
  return { ok: errors.length === 0, errors, variant };
}

module.exports = {
  CRITERIA_VARIANTS,
  getCriteriaVariant,
  getCriteriaVariantBySheetName,
  getCriteriaVariantsForTemplate,
  normalizeSupplierScale,
  normalizeTemplateCode,
  validateCriteriaVariant,
};
