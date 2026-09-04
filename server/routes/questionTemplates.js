const express = require('express');
const multer = require('multer');
const path = require('node:path');
const { db } = require('../db');
const { CRITERIA_VARIANTS, getCriteriaVariantsForTemplate } = require('../domain/criteriaVariants');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const QuestionTemplateRepository = require('../repositories/QuestionTemplateRepository');
const { QuestionVersionService } = require('../services/QuestionVersionService');
const { QuestionImportService, XLSX_MIME, LIMITS: QUESTION_IMPORT_LIMITS } = require('../services/QuestionImportService');

const router = express.Router();
const questionTemplateRepository = new QuestionTemplateRepository(db);
const questionVersionService = new QuestionVersionService(db);
const questionImportService = new QuestionImportService(db, { versionService: questionVersionService });
const questionImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: QUESTION_IMPORT_LIMITS.maxBytes },
  fileFilter: (_req, file, callback) => callback(
    file.mimetype === XLSX_MIME ? null : Object.assign(new Error('workbook_mime_invalid'), { code: 'workbook_mime_invalid', status: 415 }),
    file.mimetype === XLSX_MIME
  ),
});

router.use(requireAuth);

router.get('/import-template', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (_req, res) => {
  const workbook = path.resolve(__dirname, '..', '..', 'database', 'templates', 'question-template-import.xlsx');
  res.download(workbook, 'question-template-import.xlsx');
});

function versionContext(req) {
  return {
    requestId: req.requestId || req.id || null,
    correlationId: req.correlationId || req.requestId || req.id || null,
  };
}

function versionError(res, error) {
  const status = error.status || 500;
  const payload = { error: error.code || 'question_version_failed' };
  if (error.current_lock_version != null) payload.current_lock_version = error.current_lock_version;
  if (error.item_key) payload.item_key = error.item_key;
  return res.status(status).json(payload);
}

function questionImportError(res, error) {
  const status = error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const payload = { error: error.code === 'LIMIT_FILE_SIZE' ? 'workbook_size_limit_exceeded' : (error.code || 'question_import_failed') };
  if (error.current_lock_version != null) payload.current_lock_version = error.current_lock_version;
  if (Array.isArray(error.missing_columns)) payload.missing_columns = error.missing_columns;
  return res.status(status).json(payload);
}

function uploadQuestionWorkbook(req, res, next) {
  questionImportUpload.single('file')(req, res, (error) => {
    if (error) return questionImportError(res, error);
    return next();
  });
}

function importRouteScope(req, item) {
  return Number(item?.batch?.template_id) === Number(req.params.templateId)
    && Number(item?.batch?.target_version_id) === Number(req.params.versionId);
}

function hasImmutableVersion(templateId) {
  return !!db.prepare(`
    SELECT 1 FROM question_template_versions
    WHERE template_id=? AND status IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
    LIMIT 1
  `).get(templateId);
}

function boolInt(value) {
  return value ? 1 : 0;
}

function normalizeAllowedScores(body) {
  if (Array.isArray(body.allowed_scores)) return body.allowed_scores.join('/');
  const raw = String(body.allowed_scores || '').trim();
  if (raw) return raw;
  return body.is_elimination_clause ? 'A/D/NA' : 'A/B/C/D/NA';
}

function validateQuestion(body) {
  const errors = [];
  if (!String(body.facility_type || '').trim()) errors.push('facility_type_required');
  if (!String(body.supplier_scale || '').trim()) errors.push('supplier_scale_required');
  if (body.supplier_scale && !['ALL', 'LARGE', 'SMALL'].includes(String(body.supplier_scale))) errors.push('supplier_scale_invalid');
  if (!String(body.category || '').trim()) errors.push('category_required');
  if (!String(body.question_code || '').trim()) errors.push('question_code_required');
  if (!String(body.question_text || '').trim()) errors.push('question_text_required');
  const allowedScores = normalizeAllowedScores(body);
  const parts = allowedScores.split('/').map((v) => v.trim()).filter(Boolean);
  const valid = ['A', 'B', 'C', 'D', 'NA'];
  if (!parts.length || parts.some((v) => !valid.includes(v))) errors.push('allowed_scores_invalid');
  if (body.is_elimination_clause && allowedScores !== 'A/D/NA') errors.push('elimination_allowed_scores_must_be_a_d_na');
  return { errors, allowedScores };
}

function requiresAttachmentForQuestion(body) {
  return body.is_elimination_clause ? 0 : boolInt(body.requires_attachment);
}

function mapTemplate(row) {
  return {
    id: row.id,
    template_code: row.template_code,
    template_name: row.template_name,
    description: row.description,
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapQuestion(row) {
  return {
    id: row.id,
    template_id: row.template_id,
    template_code: row.template_code,
    facility_type: row.facility_type,
    supplier_scale: row.supplier_scale,
    question_code: row.question_code,
    question_text: row.question_text,
    category: row.category,
    is_elimination_clause: !!row.is_elimination_clause,
    is_critical_clause: !!row.is_critical_clause,
    requires_attachment: !!row.requires_attachment,
    allowed_scores: row.allowed_scores,
    order_index: row.order_index,
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

router.get('/', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  const rows = questionVersionService.catalog({
    search: req.query.search,
    status: req.query.status,
    facilityType: req.query.facility_type,
    supplierScale: req.query.supplier_scale,
    includeInactive: req.query.include_inactive !== '0',
  });
  res.json({ items: rows });
});

router.get('/:templateId/versions', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  const templateId = parseInt(req.params.templateId, 10);
  if (!questionTemplateRepository.getTemplateById(templateId)) return res.status(404).json({ error: 'template_not_found' });
  res.json({ items: questionVersionService.list({ templateId }) });
});

router.post('/:templateId/versions', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  try {
    const item = questionVersionService.createDraft({
      templateId: parseInt(req.params.templateId, 10),
      cloneFromVersionId: req.body?.clone_from_version_id || req.body?.cloneFromVersionId || null,
      note: req.body?.note || req.body?.version_note || null,
      effectiveFrom: req.body?.effective_from || null,
      effectiveTo: req.body?.effective_to || null,
      actor: req.user.userId,
      context: versionContext(req),
    });
    res.status(201).json({ item });
  } catch (error) {
    versionError(res, error);
  }
});

router.get('/:templateId/versions/:versionId', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  try {
    const item = questionVersionService.get(parseInt(req.params.versionId, 10));
    if (item.template_id !== parseInt(req.params.templateId, 10)) return res.status(404).json({ error: 'question_version_not_found' });
    res.json({ item });
  } catch (error) {
    versionError(res, error);
  }
});

router.put('/:templateId/versions/:versionId', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  try {
    const existing = questionVersionService.getRow(parseInt(req.params.versionId, 10));
    if (!existing || existing.template_id !== parseInt(req.params.templateId, 10)) return res.status(404).json({ error: 'question_version_not_found' });
    const item = questionVersionService.updateDraft({
      versionId: existing.id,
      expectedLockVersion: req.body?.expected_lock_version ?? req.body?.lock_version,
      note: Object.prototype.hasOwnProperty.call(req.body || {}, 'note') ? req.body.note : req.body?.version_note,
      effectiveFrom: req.body?.effective_from,
      effectiveTo: req.body?.effective_to,
      items: req.body?.items,
      actor: req.user.userId,
      context: versionContext(req),
    });
    res.json({ item });
  } catch (error) {
    versionError(res, error);
  }
});

router.patch('/:templateId/versions/:versionId/items', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  try {
    const existing = questionVersionService.getRow(parseInt(req.params.versionId, 10));
    if (!existing || existing.template_id !== parseInt(req.params.templateId, 10)) {
      return res.status(404).json({ error: 'question_version_not_found' });
    }
    const item = questionVersionService.patchDraftItems({
      versionId: existing.id,
      expectedLockVersion: req.body?.expected_lock_version ?? req.body?.lock_version,
      updates: req.body?.updates,
      additions: req.body?.additions,
      actor: req.user.userId,
      context: versionContext(req),
    });
    res.json({ item });
  } catch (error) {
    versionError(res, error);
  }
});

router.get('/:templateId/versions/:versionId/diff', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  try {
    const against = parseInt(req.query.against || req.query.against_version_id, 10);
    if (!against) return res.status(400).json({ error: 'against_version_required' });
    res.json({ item: questionVersionService.diff(parseInt(req.params.versionId, 10), against) });
  } catch (error) {
    versionError(res, error);
  }
});

router.get('/:templateId/versions/:versionId/impact', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  try {
    res.json({ item: questionVersionService.impact(parseInt(req.params.versionId, 10)) });
  } catch (error) {
    versionError(res, error);
  }
});

router.get('/:templateId/versions/:versionId/validate', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  try {
    const existing = questionVersionService.getRow(parseInt(req.params.versionId, 10));
    if (!existing || existing.template_id !== parseInt(req.params.templateId, 10)) {
      return res.status(404).json({ error: 'question_version_not_found' });
    }
    res.json({ item: questionVersionService.validate(existing.id) });
  } catch (error) {
    versionError(res, error);
  }
});

router.post(
  '/:templateId/versions/:versionId/imports/preview',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  uploadQuestionWorkbook,
  (req, res) => {
    try {
      const item = questionImportService.preview({
        templateId: parseInt(req.params.templateId, 10),
        versionId: parseInt(req.params.versionId, 10),
        file: req.file,
        actor: req.user.userId,
        context: versionContext(req),
      });
      res.status(201).json({ item });
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

router.get(
  '/:templateId/versions/:versionId/imports',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  (req, res) => {
    try {
      const version = questionVersionService.getRow(parseInt(req.params.versionId, 10));
      if (!version || version.template_id !== parseInt(req.params.templateId, 10)) return res.status(404).json({ error: 'question_version_not_found' });
      const items = questionImportService.listBatches({
        templateId: req.params.templateId,
        versionId: req.params.versionId,
        status: req.query.status,
        errorOnly: req.query.errors === '1',
      });
      res.json({ items });
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

router.get(
  '/:templateId/versions/:versionId/imports/:batchId',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  (req, res) => {
    try {
      const item = questionImportService.getBatch(req.params.batchId);
      if (!importRouteScope(req, item)) return res.status(404).json({ error: 'import_batch_not_found' });
      res.json({ item });
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

router.get(
  '/:templateId/versions/:versionId/imports/:batchId/errors.:format',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  (req, res) => {
    try {
      const item = questionImportService.getBatch(req.params.batchId);
      if (!importRouteScope(req, item)) return res.status(404).json({ error: 'import_batch_not_found' });
      const artifact = questionImportService.exportErrors(req.params.batchId, req.params.format);
      res.setHeader('Content-Type', artifact.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
      res.send(artifact.body);
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

router.post(
  '/:templateId/versions/:versionId/imports/:batchId/commit',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  (req, res) => {
    try {
      const existing = questionImportService.getBatch(req.params.batchId);
      if (!importRouteScope(req, existing)) return res.status(404).json({ error: 'import_batch_not_found' });
      const item = questionImportService.commit({
        batchId: req.params.batchId,
        confirmationToken: req.body?.confirmation_token,
        idempotencyKey: req.get('Idempotency-Key'),
        expectedLockVersion: req.body?.expected_lock_version ?? req.body?.lock_version,
        acceptPartial: req.body?.accept_partial === true,
        actor: req.user.userId,
        context: versionContext(req),
      });
      res.json({ item });
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

router.post(
  '/:templateId/versions/:versionId/imports/:batchId/rollback',
  requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE),
  (req, res) => {
    try {
      const existing = questionImportService.getBatch(req.params.batchId);
      if (!importRouteScope(req, existing)) return res.status(404).json({ error: 'import_batch_not_found' });
      const item = questionImportService.rollback({
        batchId: req.params.batchId,
        expectedLockVersion: req.body?.expected_lock_version ?? req.body?.lock_version,
        actor: req.user.userId,
        context: versionContext(req),
      });
      res.json({ item });
    } catch (error) {
      questionImportError(res, error);
    }
  }
);

for (const [action, execute] of [
  ['submit', (payload) => questionVersionService.submit(payload)],
  ['publish', (payload) => questionVersionService.publish(payload)],
  ['retire', (payload) => questionVersionService.retire(payload)],
  ['rollback', (payload) => questionVersionService.rollback(payload)],
]) {
  router.post(`/:templateId/versions/:versionId/${action}`, requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
    try {
      const existing = questionVersionService.getRow(parseInt(req.params.versionId, 10));
      if (!existing || existing.template_id !== parseInt(req.params.templateId, 10)) return res.status(404).json({ error: 'question_version_not_found' });
      const item = execute({
        versionId: existing.id,
        expectedLockVersion: req.body?.expected_lock_version ?? req.body?.lock_version,
        actor: req.user.userId,
        context: versionContext(req),
      });
      res.json({ item });
    } catch (error) {
      versionError(res, error);
    }
  });
}

router.post('/', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  const body = req.body || {};
  const templateCode = String(body.template_code || '').trim();
  const templateName = String(body.template_name || '').trim();
  if (!templateCode || !templateName) return res.status(400).json({ error: 'template_code_and_name_required' });
  try {
    const item = questionVersionService.createTemplateWithDraft({
      templateCode,
      templateName,
      description: body.description,
      active: body.active !== false,
      actor: req.user.userId,
      context: versionContext(req),
    });
    res.status(201).json({ item });
  } catch (error) {
    versionError(res, error);
  }
});

router.get('/variants', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  const requestedTemplate = String(req.query.template_code || req.query.template || '').trim();
  const canonical = requestedTemplate ? getCriteriaVariantsForTemplate(requestedTemplate) : CRITERIA_VARIANTS;
  const rows = questionTemplateRepository.listImportedVariants();
  const importedByKey = new Map(rows.map((row) => [
    `${row.template_code}|${row.facility_type}|${row.supplier_scale}`,
    row,
  ]));
  const items = canonical.map((variant) => {
    const imported = importedByKey.get(`${variant.template_code}|${variant.facility_type}|${variant.supplier_scale}`);
    return {
      template_code: variant.template_code,
      facility_type: variant.facility_type,
      facility_label: variant.facility_label,
      supplier_scale: variant.supplier_scale,
      source_sheet: variant.source_sheet,
      expected_criterion_count: variant.expected_criterion_count,
      criterion_count: imported?.criterion_count || 0,
      elimination_count: imported?.elimination_count || 0,
      critical_count: imported?.critical_count || 0,
      order_range: imported ? [imported.first_order_index, imported.last_order_index] : [null, null],
      template_id: imported?.template_id || null,
      template_name: imported?.template_name || null,
    };
  });
  res.json({ items });
});

router.get('/imported-variants', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  const rows = questionTemplateRepository.listImportedVariants();
  res.json({ items: rows.map((row) => ({
    template_id: row.template_id,
    template_code: row.template_code,
    template_name: row.template_name,
    facility_type: row.facility_type,
    supplier_scale: row.supplier_scale,
    criterion_count: row.criterion_count,
    elimination_count: row.elimination_count || 0,
    critical_count: row.critical_count || 0,
    order_range: [row.first_order_index, row.last_order_index],
  })) });
});

router.put('/:id', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const existing = questionTemplateRepository.getTemplateById(id);
  if (!existing) return res.status(404).json({ error: 'template_not_found' });
  if (hasImmutableVersion(id) && req.body?.template_code && String(req.body.template_code).trim() !== existing.template_code) {
    return res.status(409).json({ error: 'template_code_immutable' });
  }
  const templateCode = String(body.template_code || existing.template_code).trim();
  const templateName = String(body.template_name || existing.template_name).trim();
  if (!templateCode || !templateName) return res.status(400).json({ error: 'template_code_and_name_required' });
  try {
    questionTemplateRepository.updateTemplate({
      id,
      template_code: templateCode,
      template_name: templateName,
      description: String(body.description || '').trim() || null,
      active: body.active === false ? 0 : 1,
    });
    res.json({ item: mapTemplate(questionTemplateRepository.getTemplateById(id)) });
  } catch (e) {
    res.status(409).json({ error: 'template_code_exists' });
  }
});

router.get('/:id/questions', requirePermission(PERMISSIONS.EVALUATION_READ), (req, res) => {
  const templateId = parseInt(req.params.id, 10);
  const rows = questionTemplateRepository.listQuestions({
    templateId,
    includeInactive: req.query.include_inactive === '1',
    facilityType: req.query.facility_type ? String(req.query.facility_type) : null,
    supplierScale: req.query.supplier_scale ? String(req.query.supplier_scale) : null,
  });
  res.json({ items: rows.map(mapQuestion) });
});

router.post('/:id/questions', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  const templateId = parseInt(req.params.id, 10);
  const template = questionTemplateRepository.getTemplateById(templateId);
  if (!template) return res.status(404).json({ error: 'template_not_found' });
  if (hasImmutableVersion(templateId)) return res.status(409).json({ error: 'published_version_immutable' });
  const body = req.body || {};
  const { errors, allowedScores } = validateQuestion(body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', errors });
  try {
    const info = questionTemplateRepository.insertQuestion({
      template_id: templateId,
      facility_type: String(body.facility_type).trim(),
      supplier_scale: String(body.supplier_scale).trim(),
      question_code: String(body.question_code).trim(),
      question_text: String(body.question_text).trim(),
      category: String(body.category).trim(),
      is_elimination_clause: boolInt(body.is_elimination_clause),
      is_critical_clause: boolInt(body.is_critical_clause),
      requires_attachment: requiresAttachmentForQuestion(body),
      allowed_scores: allowedScores,
      order_index: parseInt(body.order_index || '0', 10),
      active: body.active === false ? 0 : 1,
    });
    const row = questionTemplateRepository.getQuestionDetail(info.lastInsertRowid);
    res.status(201).json({ item: mapQuestion(row) });
  } catch (e) {
    res.status(409).json({ error: 'question_code_exists_for_scope' });
  }
});

router.put('/:templateId/questions/:questionId', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  const templateId = parseInt(req.params.templateId, 10);
  if (hasImmutableVersion(templateId)) return res.status(409).json({ error: 'published_version_immutable' });
  const questionId = parseInt(req.params.questionId, 10);
  const existing = questionTemplateRepository.getQuestionByTemplate(questionId, templateId);
  if (!existing) return res.status(404).json({ error: 'question_not_found' });
  const body = { ...existing, ...(req.body || {}) };
  const { errors, allowedScores } = validateQuestion(body);
  if (errors.length) return res.status(400).json({ error: 'validation_failed', errors });
  try {
    questionTemplateRepository.updateQuestion({
      id: questionId,
      template_id: templateId,
      facility_type: String(body.facility_type).trim(),
      supplier_scale: String(body.supplier_scale).trim(),
      question_code: String(body.question_code).trim(),
      question_text: String(body.question_text).trim(),
      category: String(body.category).trim(),
      is_elimination_clause: boolInt(body.is_elimination_clause),
      is_critical_clause: boolInt(body.is_critical_clause),
      requires_attachment: requiresAttachmentForQuestion(body),
      allowed_scores: allowedScores,
      order_index: parseInt(body.order_index || '0', 10),
      active: body.active === false ? 0 : 1,
    });
    const row = questionTemplateRepository.getQuestionDetail(questionId);
    res.json({ item: mapQuestion(row) });
  } catch (e) {
    res.status(409).json({ error: 'question_code_exists_for_scope' });
  }
});

router.delete('/:templateId/questions/:questionId', requirePermission(PERMISSIONS.QUESTION_TEMPLATE_MANAGE), (req, res) => {
  if (hasImmutableVersion(parseInt(req.params.templateId, 10))) return res.status(409).json({ error: 'published_version_immutable' });
  const info = questionTemplateRepository.deactivateQuestion(parseInt(req.params.questionId, 10), parseInt(req.params.templateId, 10));
  if (info.changes === 0) return res.status(404).json({ error: 'question_not_found' });
  res.json({ ok: true });
});

module.exports = router;
