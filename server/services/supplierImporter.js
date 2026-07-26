const XLSX = require('xlsx');
const { validateMerchandising } = require('../domain/merchandising');
const { recordSupplierHistory } = require('../domain/supplierHistory');

const SUPPLIER_IMPORT_HEADERS = Object.freeze([
  'supplier_code', 'supplier_name', 'tax_code', 'address',
  'production_address', 'evaluation_address', 'linked_facility_code',
  'linked_facility_name', 'linked_facility_address', 'linked_facility_type',
  'region', 'province', 'business_type', 'contact_name', 'contact_email',
  'contact_phone', 'cmc_owner', 'cmc_head', 'business_license_file',
  'attp_certificate_type', 'attp_certificate_file', 'mch2', 'mch3',
  'product_group', 'product_name', 'status',
]);

const HEADER_ALIASES = {
  supplier_code: ['supplier_code', 'supplier code', 'ma ncc', 'mã ncc', 'code', 'sap_code', 'ma nha cung cap'],
  supplier_name: ['supplier_name', 'supplier name', 'ten ncc', 'tên ncc', 'ncc_name', 'ten nha cung cap'],
  tax_code: ['tax_code', 'tax code', 'ma so thue', 'mã số thuế', 'mst'],
  address: ['address', 'dia chi', 'địa chỉ'],
  contact_name: ['contact_name', 'contact name', 'nguoi lien he', 'người liên hệ'],
  contact_email: ['contact_email', 'contact email', 'email', 'email lien he'],
  contact_phone: ['contact_phone', 'contact phone', 'phone', 'sdt', 'số điện thoại'],
  mch2: ['mch2', 'nganh hang mch2', 'ngành hàng mch2'],
  mch3: ['mch3', 'nganh hang mch3', 'ngành hàng mch3'],
  product_group: ['product_group', 'product group', 'nhom san pham', 'nhóm sản phẩm'],
  product_name: ['product_name', 'product name', 'san pham', 'sản phẩm', 'sku_name'],
  status: ['status', 'trang thai', 'trạng thái'],
};

Object.assign(HEADER_ALIASES, {
  production_address: ['production_address', 'production address', 'dia chi san xuat'],
  evaluation_address: ['evaluation_address', 'evaluation address', 'dia chi danh gia', 'dia chi danh gia ncc'],
  linked_facility_code: ['linked_facility_code', 'facility code', 'ma co so', 'ma don vi lien ket'],
  linked_facility_name: ['linked_facility_name', 'facility name', 'ten co so', 'ten don vi lien ket'],
  linked_facility_address: ['linked_facility_address', 'facility address', 'dia chi co so', 'dia chi don vi lien ket', 'dia chi danh gia don vi lien ket/gia cong'],
  linked_facility_type: ['linked_facility_type', 'facility type', 'loai co so', 'loai don vi lien ket'],
  region: ['region', 'mien', 'vung', 'khu vuc'],
  province: ['province', 'tinh thanh', 'tinh'],
  business_type: ['business_type', 'business type', 'loai hinh kinh doanh'],
  cmc_owner: ['cmc_owner', 'cmc owner', 'cmc phu trach nganh hang'],
  cmc_head: ['cmc_head', 'cmc head', 'cmc truong phong nganh hang'],
  business_license_file: ['business_license_file', 'business license file', 'giay phep kinh doanh', 'file giay phep kinh doanh'],
  attp_certificate_type: ['attp_certificate_type', 'attp type', 'loai giay attp', 'loai chung nhan attp'],
  attp_certificate_file: ['attp_certificate_file', 'attp file', 'giay attp', 'file chung nhan attp'],
});

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[_-]+/g, '_');
}

function normalizeStatus(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'ACTIVE';
  const upper = raw.toUpperCase();
  if (['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(upper)) return upper;
  const lower = raw.toLowerCase();
  if (['hoạt động', 'hoat dong', 'active', 'a'].includes(lower)) return 'ACTIVE';
  if (['không hoạt động', 'khong hoat dong', 'inactive', 'i'].includes(lower)) return 'INACTIVE';
  if (['tạm ngừng', 'tam ngung', 'suspended', 's'].includes(lower)) return 'SUSPENDED';
  return upper;
}

function errorColumn(code) {
  const exact = {
    supplier_code_required: 'supplier_code',
    supplier_code_duplicate_in_file: 'supplier_code',
    supplier_name_required: 'supplier_name',
    contact_email_invalid: 'contact_email',
    mch2_required: 'mch2',
    mch2_invalid: 'mch2',
    mch3_required: 'mch3',
    mch3_invalid_for_mch2: 'mch3',
    region_invalid: 'region',
    province_invalid: 'province',
    business_type_invalid: 'business_type',
    status_invalid: 'status',
  };
  return exact[code] || null;
}

function errorMessage(code) {
  const messages = {
    supplier_code_required: 'Thiếu mã NCC.',
    supplier_code_duplicate_in_file: 'Mã NCC bị trùng trong cùng file.',
    supplier_name_required: 'Thiếu tên NCC.',
    contact_email_invalid: 'Email liên hệ không đúng định dạng.',
    mch2_required: 'Thiếu MCH2.',
    mch2_invalid: 'MCH2 không thuộc danh mục hợp lệ.',
    mch3_required: 'Thiếu MCH3.',
    mch3_invalid_for_mch2: 'MCH3 không thuộc MCH2 đã chọn.',
    region_invalid: 'Khu vực không hợp lệ.',
    province_invalid: 'Tỉnh/thành không thuộc khu vực đã chọn.',
    business_type_invalid: 'Loại hình kinh doanh không hợp lệ.',
    status_invalid: 'Trạng thái chỉ nhận ACTIVE, INACTIVE hoặc SUSPENDED.',
  };
  return messages[code] || code;
}

function errorDetails(codes) {
  return codes.map((code) => ({ column: errorColumn(code), code, message: errorMessage(code) }));
}

function firstString(row, headers) {
  for (const header of headers) {
    const value = row[header];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function firstRowHeaderAliases(headers) {
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  return (field) => HEADER_ALIASES[field].map(normalizeHeader).some((alias) => normalizedHeaders.has(alias));
}

function validateSupplierHeaders(headers) {
  const hasAlias = firstRowHeaderAliases(headers);
  const missing = [];
  if (!hasAlias('supplier_code')) missing.push('supplier_code');
  if (!hasAlias('supplier_name')) missing.push('supplier_name');
  return missing;
}

function mapRow(raw) {
  const normalized = {};
  Object.keys(raw || {}).forEach((key) => {
    normalized[normalizeHeader(key)] = raw[key];
  });

  const out = {};
  Object.keys(HEADER_ALIASES).forEach((field) => {
    out[field] = firstString(normalized, HEADER_ALIASES[field].map(normalizeHeader));
  });
  out.status = normalizeStatus(out.status);
  return out;
}

function parseSupplierWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], errors: [{ row: 0, error: 'sheet_required' }], headers: [] };

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const headers = rawRows[0] ? Object.keys(rawRows[0]) : [];
  const missingHeaders = validateSupplierHeaders(headers);
  if (missingHeaders.length) {
    return {
      rows: [],
      errors: [{
        row: 0,
        error: 'template_invalid',
        sheet: sheetName,
        missing_headers: missingHeaders,
        details: missingHeaders.map((column) => ({
          column,
          code: 'header_required',
          message: `Thiếu cột bắt buộc ${column}.`,
        })),
      }],
      headers,
    };
  }
  const rows = [];
  const errors = [];
  const seenSupplierCodes = new Set();

  rawRows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const row = mapRow(raw);
    const rowErrors = [];
    if (!row.supplier_code) rowErrors.push('supplier_code_required');
    if (!row.supplier_name) rowErrors.push('supplier_name_required');
    if (row.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact_email)) rowErrors.push('contact_email_invalid');
    rowErrors.push(...validateMerchandising(row.mch2, row.mch3));
    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(row.status)) rowErrors.push('status_invalid');

    const supplierKey = row.supplier_code.toUpperCase();
    if (supplierKey && seenSupplierCodes.has(supplierKey)) rowErrors.push('supplier_code_duplicate_in_file');
    if (supplierKey) seenSupplierCodes.add(supplierKey);

    if (rowErrors.length) {
      errors.push({
        row: rowNumber,
        supplier_code: row.supplier_code || null,
        errors: rowErrors,
        details: errorDetails(rowErrors),
      });
      return;
    }
    rows.push(row);
  });

  return { rows, errors, headers };
}

function upsertSupplier(db, supplier, userEmail, sourceType, importBatchId) {
  const now = new Date().toISOString();
  const before = db.prepare('SELECT * FROM supplier_master WHERE supplier_code = ?').get(supplier.supplier_code);
  const info = db.prepare(`
    INSERT INTO supplier_master (
      supplier_code, supplier_name, tax_code, address,
      production_address, evaluation_address,
      linked_facility_code, linked_facility_name, linked_facility_address, linked_facility_type,
      region, province, business_type, cmc_owner, cmc_head,
      business_license_file, attp_certificate_type, attp_certificate_file,
      contact_name, contact_email, contact_phone,
      mch2, mch3, product_group, product_name,
      status, source_type, import_batch_id,
      created_at, created_by, updated_at, updated_by
    )
    VALUES (
      @supplier_code, @supplier_name, @tax_code, @address,
      @production_address, @evaluation_address,
      @linked_facility_code, @linked_facility_name, @linked_facility_address, @linked_facility_type,
      @region, @province, @business_type, @cmc_owner, @cmc_head,
      @business_license_file, @attp_certificate_type, @attp_certificate_file,
      @contact_name, @contact_email, @contact_phone,
      @mch2, @mch3, @product_group, @product_name,
      @status, @source_type, @import_batch_id,
      @now, @userEmail, @now, @userEmail
    )
    ON CONFLICT(supplier_code) DO UPDATE SET
      supplier_name = excluded.supplier_name,
      tax_code = excluded.tax_code,
      address = excluded.address,
      production_address = excluded.production_address,
      evaluation_address = excluded.evaluation_address,
      linked_facility_code = excluded.linked_facility_code,
      linked_facility_name = excluded.linked_facility_name,
      linked_facility_address = excluded.linked_facility_address,
      linked_facility_type = excluded.linked_facility_type,
      region = excluded.region,
      province = excluded.province,
      business_type = excluded.business_type,
      cmc_owner = excluded.cmc_owner,
      cmc_head = excluded.cmc_head,
      business_license_file = excluded.business_license_file,
      attp_certificate_type = excluded.attp_certificate_type,
      attp_certificate_file = excluded.attp_certificate_file,
      contact_name = excluded.contact_name,
      contact_email = excluded.contact_email,
      contact_phone = excluded.contact_phone,
      mch2 = excluded.mch2,
      mch3 = excluded.mch3,
      product_group = excluded.product_group,
      product_name = excluded.product_name,
      status = excluded.status,
      source_type = excluded.source_type,
      import_batch_id = excluded.import_batch_id,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run({
    ...supplier,
    tax_code: supplier.tax_code || null,
    address: supplier.address || null,
    production_address: supplier.production_address || null,
    evaluation_address: supplier.evaluation_address || null,
    linked_facility_code: supplier.linked_facility_code || null,
    linked_facility_name: supplier.linked_facility_name || null,
    linked_facility_address: supplier.linked_facility_address || null,
    linked_facility_type: supplier.linked_facility_type || null,
    region: supplier.region || null,
    province: supplier.province || null,
    business_type: supplier.business_type || null,
    cmc_owner: supplier.cmc_owner || null,
    cmc_head: supplier.cmc_head || null,
    business_license_file: supplier.business_license_file || null,
    attp_certificate_type: supplier.attp_certificate_type || null,
    attp_certificate_file: supplier.attp_certificate_file || null,
    contact_name: supplier.contact_name || null,
    contact_email: supplier.contact_email || null,
    contact_phone: supplier.contact_phone || null,
    mch2: supplier.mch2 || null,
    mch3: supplier.mch3 || null,
    product_group: supplier.product_group || null,
    product_name: supplier.product_name || null,
    status: supplier.status || 'ACTIVE',
    source_type: sourceType,
    import_batch_id: importBatchId || null,
    now,
    userEmail,
  });
  const after = db.prepare('SELECT * FROM supplier_master WHERE supplier_code = ?').get(supplier.supplier_code);
  const fromExcel = sourceType === 'EXCEL_UPLOAD';
  recordSupplierHistory(db, {
    before,
    after,
    actorUserId: userEmail,
    action: before
      ? (fromExcel ? 'Cập nhật từ Excel' : 'Cập nhật NCC')
      : (fromExcel ? 'Thêm NCC từ Excel' : 'Tạo NCC'),
    comment: fromExcel
      ? (importBatchId ? `Import batch #${importBatchId}` : 'Nhập từ Excel')
      : 'Lưu thủ công',
  });
  return info;
}

module.exports = {
  SUPPLIER_IMPORT_HEADERS,
  mapRow,
  normalizeStatus,
  parseSupplierWorkbook,
  upsertSupplier,
};
