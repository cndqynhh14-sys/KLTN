const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { db, logAccess, policyService } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, policyErrorResponse } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { resourceContext } = require('../services/PolicyService');
const { validateMerchandising } = require('../domain/merchandising');
const { validateSupplierMasterData } = require('../domain/masterData');
const { normalizePage } = require('../domain/pagination');
const { parseSupplierWorkbook, upsertSupplier } = require('../services/supplierImporter');
const SupplierRepository = require('../repositories/SupplierRepository');
const { recordSupplierHistory } = require('../domain/supplierHistory');

const router = express.Router();
const supplierRepository = new SupplierRepository(db);
router.use(requireAuth, requirePermission(PERMISSIONS.SUPPLIER_READ));

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '10', 10);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    cb(ok ? null : new Error('only_xlsx_allowed'), ok);
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user && req.user.email) || req.ip,
  message: { error: 'too_many_uploads' },
});

function supplierPayload(body, sourceType) {
  const text = (field) => String(body?.[field] || '').trim() || null;
  return {
    supplier_code: String(body?.supplier_code || '').trim(),
    supplier_name: String(body?.supplier_name || '').trim(),
    tax_code: text('tax_code'),
    address: text('address'),
    production_address: text('production_address'),
    evaluation_address: text('evaluation_address'),
    linked_facility_code: text('linked_facility_code'),
    linked_facility_name: text('linked_facility_name'),
    linked_facility_address: text('linked_facility_address'),
    linked_facility_type: text('linked_facility_type'),
    region: text('region'),
    province: text('province'),
    business_type: text('business_type'),
    cmc_owner: text('cmc_owner'),
    cmc_head: text('cmc_head'),
    business_license_file: text('business_license_file'),
    attp_certificate_type: text('attp_certificate_type'),
    attp_certificate_file: text('attp_certificate_file'),
    contact_name: text('contact_name'),
    contact_email: text('contact_email'),
    contact_phone: text('contact_phone'),
    mch2: text('mch2'),
    mch3: text('mch3'),
    product_group: text('product_group'),
    product_name: text('product_name'),
    status: String(body?.status || 'ACTIVE').trim().toUpperCase(),
    source_type: sourceType,
  };
}

const MANUAL_CREATE_REQUIRED_FIELDS = [
  'tax_code',
  'address',
  'production_address',
  'evaluation_address',
  'region',
  'province',
  'business_type',
  'contact_name',
  'contact_email',
  'contact_phone',
  'mch2',
  'mch3',
  'product_name',
];

function withActions(item, user) {
  return item ? { ...item, ...policyService.actionEnvelope('SUPPLIER', item, user) } : item;
}

function assertSupplierScope(req, res, item, permission = PERMISSIONS.SUPPLIER_READ) {
  try {
    policyService.assert(req.user, permission, { context: resourceContext(item) });
    return true;
  } catch (error) {
    policyErrorResponse(res, error, req);
    return false;
  }
}

function validateSupplier(supplier, options = {}) {
  const errors = {};
  if (!supplier.supplier_code) errors.supplier_code = 'required';
  if (!supplier.supplier_name) errors.supplier_name = 'required';
  if (options.requireManualCreateFields) {
    MANUAL_CREATE_REQUIRED_FIELDS.forEach((field) => {
      if (!String(supplier[field] || '').trim()) errors[field] = 'required';
    });
  }
  if (supplier.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplier.contact_email)) {
    errors.contact_email = 'invalid';
  }
  Object.assign(errors, validateSupplierMasterData(supplier));
  const merchandisingErrors = validateMerchandising(supplier.mch2, supplier.mch3);
  if (merchandisingErrors.length) errors.merchandising = merchandisingErrors;
  if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(supplier.status)) errors.status = 'invalid';
  return errors;
}

router.get('/', (req, res) => {
  const page = normalizePage(req.query.page, 1, 1, 100000);
  const pageSize = normalizePage(req.query.page_size || req.query.pageSize, 15, 1, 100);
  const offset = (page - 1) * pageSize;
  const q = String(req.query.q || req.query.search || '').trim();
  const mch2 = String(req.query.mch2 || '').trim();
  const mch3 = String(req.query.mch3 || '').trim();
  const status = String(req.query.status || '').trim().toUpperCase();

  const { items, total } = supplierRepository.list({
    q,
    mch2,
    mch3,
    status,
    pageSize,
    offset,
    scopeFilter: (rows) => policyService.filter(req.user, PERMISSIONS.SUPPLIER_READ, rows, resourceContext),
  });

  res.json({ items: items.map((item) => withActions(item, req.user)), total, page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(total / pageSize)) });
});

router.get('/import-template', requirePermission(PERMISSIONS.SUPPLIER_WRITE), (_req, res) => {
  const workbook = path.resolve(__dirname, '..', '..', 'database', 'templates', 'supplier-import-template.xlsx');
  res.download(workbook, 'mau-import-danh-sach-ncc.xlsx');
});

router.get('/:id/history', (req, res) => {
  const item = supplierRepository.getByIdOrCode(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (!assertSupplierScope(req, res, item)) return;
  res.json({ items: supplierRepository.listHistory(item) });
});

router.get('/:id', (req, res) => {
  const item = supplierRepository.getByIdOrCode(req.params.id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (!assertSupplierScope(req, res, item)) return;
  res.json({ item: withActions(item, req.user) });
});

router.post('/', requirePermission(PERMISSIONS.SUPPLIER_WRITE), (req, res) => {
  const supplier = supplierPayload(req.body, 'MANUAL');
  const errors = validateSupplier(supplier, { requireManualCreateFields: true });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'validation_failed', errors });

  try {
    upsertSupplier(db, supplier, req.user.email, 'MANUAL', null);
    const item = supplierRepository.getByCode(supplier.supplier_code);
    logAccess({ email: req.user.email, action: 'SUPPLIER_UPSERT', details: { supplier_code: supplier.supplier_code, source_type: 'MANUAL' }, ip: req.ip, ua: req.get('user-agent') });
    res.status(201).json({ item: withActions(item, req.user) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'supplier_code_exists' });
    throw e;
  }
});

router.put('/:id', requirePermission(PERMISSIONS.SUPPLIER_WRITE), (req, res) => {
  const existing = supplierRepository.getByIdOrCode(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!assertSupplierScope(req, res, existing, PERMISSIONS.SUPPLIER_WRITE)) return;

  const supplier = supplierPayload({ ...existing, ...req.body }, 'MANUAL');
  const errors = validateSupplier(supplier);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'validation_failed', errors });

  try {
    const info = supplierRepository.update({ ...supplier, updated_by: req.user.email, id: existing.id });
    if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
    const item = supplierRepository.getById(existing.id);
    recordSupplierHistory(db, {
      before: existing,
      after: item,
      actorUserId: req.user.email,
      action: 'Cập nhật NCC',
      comment: 'Lưu thủ công',
    });
    logAccess({ email: req.user.email, action: 'SUPPLIER_UPDATE', details: { supplier_id: existing.id, supplier_code: supplier.supplier_code }, ip: req.ip, ua: req.get('user-agent') });
    res.json({ item: withActions(item, req.user) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'supplier_code_exists' });
    throw e;
  }
});

router.post('/import-excel', requirePermission(PERMISSIONS.SUPPLIER_WRITE), uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });

  const parsed = parseSupplierWorkbook(req.file.buffer);
  const totalRows = parsed.rows.length + parsed.errors.length;
  const hasValidationErrors = parsed.errors.length > 0;
  const status = hasValidationErrors ? 'FAILED' : 'COMPLETED';
  const committedRows = hasValidationErrors ? [] : parsed.rows;
  const successRows = committedRows.length;
  const failedRows = hasValidationErrors ? totalRows : 0;

  const batchId = supplierRepository.importExcel({
    fileName: req.file.originalname,
    userEmail: req.user.email,
    totalRows,
    successRows,
    failedRows,
    status,
    errors: parsed.errors,
    rows: committedRows,
    upsertSupplier,
  });
  const batch = supplierRepository.getImportBatch(batchId);
  logAccess({
    email: req.user.email,
    action: 'SUPPLIER_IMPORT_EXCEL',
    details: { batch_id: batchId, filename: req.file.originalname, total_rows: totalRows, success_rows: successRows, failed_rows: failedRows },
    ip: req.ip,
    ua: req.get('user-agent'),
  });

  res.status(hasValidationErrors ? 422 : 200).json({
    batch,
    summary: {
      total_rows: totalRows,
      success_rows: successRows,
      failed_rows: failedRows,
      ...(hasValidationErrors ? { validation_error_rows: parsed.errors.length } : {}),
      status,
    },
    errors: parsed.errors,
    headers: parsed.headers,
  });
});

module.exports = router;
