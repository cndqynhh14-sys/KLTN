const XLSX = require('xlsx');
const { supplierMasterDataErrorCodes } = require('../domain/masterData');
const { normalizeSupplierCode } = require('../domain/supplierCode');
const { recordSupplierHistory } = require('../domain/supplierHistory');

const SUPPLIER_IMPORT_HEADERS = Object.freeze([
  'supplier_code', 'supplier_name', 'tax_code', 'address', 'region', 'province',
  'business_type', 'contact_name', 'contact_email', 'contact_phone', 'status',
]);

const HEADER_ALIASES = Object.freeze({
  supplier_code: ['supplier_code', 'supplier code', 'ma ncc', 'mã ncc', 'code', 'sap_code', 'ma nha cung cap'],
  supplier_name: ['supplier_name', 'supplier name', 'ten ncc', 'tên ncc', 'ncc_name', 'ten nha cung cap'],
  tax_code: ['tax_code', 'tax code', 'ma so thue', 'mã số thuế', 'mst'],
  address: ['address', 'dia chi', 'địa chỉ'],
  region: ['region', 'mien', 'vung', 'khu vuc', 'khu vực'],
  province: ['province', 'tinh thanh', 'tinh', 'tỉnh'],
  business_type: ['business_type', 'business type', 'loai hinh kinh doanh', 'loại hình kinh doanh'],
  contact_name: ['contact_name', 'contact name', 'nguoi lien he', 'người liên hệ'],
  contact_email: ['contact_email', 'contact email', 'email', 'email lien he'],
  contact_phone: ['contact_phone', 'contact phone', 'phone', 'sdt', 'số điện thoại'],
  status: ['status', 'trang thai', 'trạng thái'],
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
  const lower = normalizeHeader(raw);
  if (['hoat dong', 'active', 'a'].includes(lower)) return 'ACTIVE';
  if (['khong hoat dong', 'inactive', 'i'].includes(lower)) return 'INACTIVE';
  if (['tam ngung', 'suspended', 's'].includes(lower)) return 'SUSPENDED';
  return upper;
}

function errorColumn(code) {
  const exact = {
    supplier_code_required: 'supplier_code',
    supplier_code_duplicate_in_file: 'supplier_code',
    supplier_name_required: 'supplier_name',
    contact_email_invalid: 'contact_email',
    contact_phone_invalid: 'contact_phone',
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
    contact_phone_invalid: 'Số điện thoại không đúng định dạng.',
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

function validateSupplierHeaders(headers) {
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  const hasAlias = (field) => HEADER_ALIASES[field].map(normalizeHeader).some((alias) => normalizedHeaders.has(alias));
  return ['supplier_code', 'supplier_name'].filter((field) => !hasAlias(field));
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
  out.supplier_code = normalizeSupplierCode(out.supplier_code);
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
    if (row.contact_phone && !/^[0-9+\-\s.]{8,20}$/.test(row.contact_phone)) rowErrors.push('contact_phone_invalid');
    rowErrors.push(...supplierMasterDataErrorCodes(row));
    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(row.status)) rowErrors.push('status_invalid');

    const supplierKey = normalizeSupplierCode(row.supplier_code);
    if (supplierKey && seenSupplierCodes.has(supplierKey)) rowErrors.push('supplier_code_duplicate_in_file');
    if (supplierKey) seenSupplierCodes.add(supplierKey);

    if (rowErrors.length) {
      errors.push({
        row: rowNumber,
        supplier_code: row.supplier_code || null,
        errors: rowErrors,
        details: errorDetails(rowErrors),
      });
    } else {
      rows.push(row);
    }
  });
  return { rows, errors, headers };
}

function upsertSupplier(db, supplier, userReference, sourceType, importBatchId) {
  const { resolveUserId } = require('../domain/userIdentity');
  const actorUserId = resolveUserId(db, userReference, { required: true });
  const now = new Date().toISOString();
  const supplierCode = normalizeSupplierCode(supplier.supplier_code);
  const before = db.prepare('SELECT * FROM supplier_master WHERE UPPER(TRIM(supplier_code)) = ?').get(supplierCode);
  const info = db.prepare(`
    INSERT INTO supplier_master (
      supplier_code, supplier_name, tax_code, address, region, province, business_type,
      contact_name, contact_email, contact_phone, status, source_type, import_batch_id,
      created_at, created_by, updated_at, updated_by
    ) VALUES (
      @supplier_code, @supplier_name, @tax_code, @address, @region, @province, @business_type,
      @contact_name, @contact_email, @contact_phone, @status, @source_type, @import_batch_id,
      @now, @actorUserId, @now, @actorUserId
    )
    ON CONFLICT(supplier_code) DO UPDATE SET
      supplier_name = excluded.supplier_name,
      tax_code = excluded.tax_code,
      address = excluded.address,
      region = excluded.region,
      province = excluded.province,
      business_type = excluded.business_type,
      contact_name = excluded.contact_name,
      contact_email = excluded.contact_email,
      contact_phone = excluded.contact_phone,
      status = excluded.status,
      source_type = excluded.source_type,
      import_batch_id = excluded.import_batch_id,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run({
    supplier_code: supplierCode,
    supplier_name: supplier.supplier_name,
    tax_code: supplier.tax_code || null,
    address: supplier.address || null,
    region: supplier.region || null,
    province: supplier.province || null,
    business_type: supplier.business_type || null,
    contact_name: supplier.contact_name || null,
    contact_email: supplier.contact_email || null,
    contact_phone: supplier.contact_phone || null,
    status: supplier.status || 'ACTIVE',
    source_type: sourceType,
    import_batch_id: importBatchId || null,
    now,
    actorUserId,
  });
  const after = db.prepare('SELECT * FROM supplier_master WHERE UPPER(TRIM(supplier_code)) = ?').get(supplierCode);
  const fromExcel = sourceType === 'EXCEL_UPLOAD';
  recordSupplierHistory(db, {
    before,
    after,
    actorUserId,
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
