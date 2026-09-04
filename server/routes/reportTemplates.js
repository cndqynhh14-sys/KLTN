const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const ReportTemplateRepository = require('../repositories/ReportTemplateRepository');
const ReportTemplateVersionRepository = require('../reporting/ReportTemplateVersionRepository');
const { ReportOrchestrator } = require('../reporting/ReportOrchestrator');
const { isCanonicalDefinition } = require('../reporting/canonicalReportExports');
const { getDefinition } = require('../reporting/definitionCatalog');
const { createDefinitionPackage, validateDefinitionPackage } = require('../reporting/ReportDefinitionPackage');
const { buildSyntheticReportContext, previewWarnings } = require('../reporting/reportPreviewFixture');
const { resolveReportAlias } = require('../reporting/reportAliasCatalog');
const { LegacyReportTemplateMigration } = require('../reporting/LegacyReportTemplateMigration');
const { businessErrorPayload } = require('../reporting/reportBusinessErrors');
const { getContext } = require('../observability/context');
const {
  buildReportContext,
  isAllowedReportType,
  renderInternalReportHtml,
  renderTemplate,
  renderWorkingMinutesHtml,
  reportDefinitionFor,
} = require('../services/reporting');

const router = express.Router();
const reportTemplateRepository = new ReportTemplateRepository(db);
const reportVersionRepository = new ReportTemplateVersionRepository(db);
const reportOrchestrator = new ReportOrchestrator({ db, repository: reportVersionRepository });

router.use(requireAuth, requirePermission(PERMISSIONS.REPORT_READ));

function mapTemplate(row) {
  if (!row) return row;
  const alias = resolveReportAlias(row.report_type);
  return {
    id: row.id,
    template_name: row.template_name,
    report_type: row.report_type,
    template_body: row.template_body,
    active: !!row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    canonical_code: alias.canonical_code,
    legacy_source: alias.legacy_source,
    legacy_alias_version: alias.mapping_version,
    deprecation: alias.deprecation,
  };
}

function versionContext() {
  const context = getContext();
  return { requestId: context.request_id, correlationId: context.correlation_id };
}

function hasPermission(user, permission) {
  return Array.isArray(user?.capabilities) && user.capabilities.includes(permission);
}

function versionActionEnvelope(row, user) {
  const allowed = ['report_template.preview', 'report_template.export_package'];
  const disabled = {};
  const canManage = hasPermission(user, PERMISSIONS.REPORT_TEMPLATE_MANAGE);
  const canPublish = hasPermission(user, PERMISSIONS.REPORT_TEMPLATE_PUBLISH);
  const canAdvanced = hasPermission(user, PERMISSIONS.REPORT_TEMPLATE_ADVANCED);
  const status = String(row?.status || '');
  if (canManage && status === 'DRAFT') {
    allowed.push('report_template.save_draft', 'report_template.validate', 'report_template.submit_review', 'report_template.import_package');
  } else {
    for (const action of ['report_template.save_draft', 'report_template.validate', 'report_template.submit_review', 'report_template.import_package']) {
      disabled[action] = canManage ? 'report_template_version_not_draft' : 'forbidden_permission';
    }
  }
  if (canAdvanced && status === 'DRAFT') allowed.push('report_template.advanced_json');
  else disabled['report_template.advanced_json'] = canAdvanced ? 'report_template_version_not_draft' : 'forbidden_permission';
  if (canPublish && status === 'IN_REVIEW') allowed.push('report_template.publish');
  else disabled['report_template.publish'] = canPublish ? 'report_template_version_not_in_review' : 'forbidden_permission';
  if (canPublish && ['PUBLISHED', 'RETIRED'].includes(status) && !row.is_default) allowed.push('report_template.rollback');
  else disabled['report_template.rollback'] = canPublish ? (row.is_default ? 'already_default' : 'rollback_target_invalid') : 'forbidden_permission';
  if (canPublish && status === 'PUBLISHED' && !row.is_default) allowed.push('report_template.retire');
  else disabled['report_template.retire'] = canPublish ? (row.is_default ? 'default_report_template_cannot_retire' : 'invalid_status') : 'forbidden_permission';
  allowed.push('report_template.create_draft');
  if (!canManage) {
    allowed.splice(allowed.indexOf('report_template.create_draft'), 1);
    disabled['report_template.create_draft'] = 'forbidden_permission';
  }
  return { allowed_actions: allowed, disabled_reasons: disabled };
}

function mapVersion(row, { includeDefinition = false, user = null } = {}) {
  if (!row) return row;
  const item = {
    id: row.id,
    definition_code: row.definition_code,
    version_no: row.version_no,
    version_name: row.version_name,
    status: row.status,
    schema_version: row.schema_version,
    checksum: row.checksum,
    version_note: row.version_note,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    lock_version: row.lock_version,
    is_default: !!row.is_default,
    export_count: Number(row.export_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at,
    published_at: row.published_at,
    retired_at: row.retired_at,
    ...versionActionEnvelope(row, user),
  };
  if (includeDefinition) item.definition = JSON.parse(row.definition_json);
  return item;
}

function mapDefinition(row, user) {
  const canManage = hasPermission(user, PERMISSIONS.REPORT_TEMPLATE_MANAGE);
  const warnings = [];
  if (!row.default_version_id) warnings.push('default_version_missing');
  if (row.latest_status === 'DRAFT') warnings.push('draft_not_in_production');
  return {
    definition_code: row.definition_code,
    display_name: row.display_name,
    description: row.description,
    allowed_rounds: JSON.parse(row.allowed_rounds_json || '[]'),
    data_contract_version: Number(row.data_contract_version),
    component_schema_version: Number(row.component_schema_version),
    version_count: Number(row.version_count || 0),
    assignment_count: Number(row.assignment_count || 0),
    default_scope: 'GLOBAL/*',
    default_version: row.default_version_id ? {
      id: row.default_version_id, version_no: row.default_version_no,
      version_name: row.default_version_name, status: row.default_status,
    } : null,
    latest_version: row.latest_version_id ? {
      id: row.latest_version_id, version_no: row.latest_version_no,
      version_name: row.latest_version_name, status: row.latest_status, updated_at: row.latest_updated_at,
    } : null,
    warnings,
    allowed_actions: ['report_template.preview', ...(canManage ? ['report_template.create_draft', 'report_template.import_package'] : [])],
    disabled_reasons: canManage ? {} : {
      'report_template.create_draft': 'forbidden_permission',
      'report_template.import_package': 'forbidden_permission',
    },
  };
}

function sendVersionError(res, error) {
  return res.status(error.status || 500).json(businessErrorPayload(error?.code ? error : {
    code: 'report_template_version_failed', details: error?.details,
  }));
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function latestPreviewTicket() {
  return db.prepare(`
    SELECT *
    FROM evaluation_tickets
    WHERE COALESCE(is_deleted, 0) = 0
    ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01')) DESC, id DESC
    LIMIT 1
  `).get();
}

function previewTicketList(limit = 20) {
  return db.prepare(`
    SELECT ticket_code, supplier_code, supplier_name, current_round_no, completed_round, updated_at, created_at
    FROM evaluation_tickets
    WHERE COALESCE(is_deleted, 0) = 0
    ORDER BY datetime(COALESCE(updated_at, created_at, '1970-01-01')) DESC, id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, Number(limit) || 20))).map((ticket) => ({
    source: 'ticket',
    ticket_code: ticket.ticket_code,
    supplier_code: ticket.supplier_code,
    supplier_name: ticket.supplier_name,
    current_round_no: ticket.current_round_no,
    completed_round: ticket.completed_round,
    updated_at: ticket.updated_at || ticket.created_at,
  }));
}

function samplePreviewContext() {
  const doc4 = {
    related_information: {
      report_no: 'PREVIEW-INTERNAL-001',
      evaluation_date: '2026-06-16',
      evaluators: 'Nguyễn Văn A',
      supplier_name: 'Công ty TNHH Nhà cung cấp mẫu',
      supplier_code: 'NCC-DEMO',
      evaluation_address: 'KCN mẫu, TP. Hồ Chí Minh',
      linked_evaluation_address: 'Chi nhánh sản xuất mẫu',
    },
    scope: {
      product: 'Thịt mát / rau củ đóng gói',
      product_group: 'Fresh food',
      business_type: 'Nhà sản xuất',
      evaluation_type: 'Định kỳ',
      method: 'Onsite',
    },
    participants: {
      qa_lead: 'qa.lead@winmart.masangroup.com',
      qa_support: ['qa.support@winmart.masangroup.com'],
    },
    supplier_introduction: {
      supplier_scale: 'LARGE',
      capability: 'Sản xuất và đóng gói thực phẩm',
      products: 'Fresh food',
      certificates: { attp_certificate_type: 'HACCP' },
    },
    compliance_summary: [
      { category: 'Hồ sơ pháp lý', counts: { A: 4, B: 1, C: 0, D: 0, NA: 0 }, percentage: 95 },
      { category: 'Kiểm soát chất lượng sản phẩm', counts: { A: 6, B: 1, C: 0, D: 0, NA: 0 }, percentage: 91.67 },
      { category: 'Truy xuất nguồn gốc', counts: { A: 3, B: 1, C: 0, D: 0, NA: 0 }, percentage: 87.5 },
      { category: 'Kiểm soát ATVSTP', counts: { A: 5, B: 0, C: 1, D: 0, NA: 0 }, percentage: 83.33 },
    ],
    result_summary: {
      final_score_percent: '89.4%',
      final_result_label: 'Đạt mức khá',
      final_conclusion: 'Đạt',
    },
    nonconformity_summary: [
      {
        clause: '2.1',
        description: 'Hồ sơ hiệu chuẩn thiết bị chưa cập nhật đầy đủ.',
        corrective_action: 'Bổ sung hồ sơ hiệu chuẩn và đào tạo lại nhân sự phụ trách.',
        due_date: '2026-07-15',
      },
    ],
    signatures: {
      evaluator: 'Nguyễn Văn A',
      supplier_representative: 'Trần Thị B',
      approved_by: 'TBP QA',
      approval_date: '2026-06-16',
    },
  };
  return {
    doc4,
    ticket_code: 'PREVIEW-INTERNAL-001',
    supplier_name: doc4.related_information.supplier_name,
    supplier_code: doc4.related_information.supplier_code,
    tax_code: 'PREVIEW-TAX',
    address: doc4.related_information.evaluation_address,
    evaluation_date: doc4.related_information.evaluation_date,
    evaluation_result: doc4.result_summary.final_result_label,
    score_percent: doc4.result_summary.final_score_percent,
    classification: 'B',
    nonconformities: '- 2.1: Hồ sơ hiệu chuẩn thiết bị chưa cập nhật đầy đủ.',
    corrective_actions: '- Bổ sung hồ sơ hiệu chuẩn trước 15/07/2026.',
    approved_by: doc4.signatures.approved_by,
    approval_date: doc4.signatures.approval_date,
  };
}

function renderTextTemplatePreview(template, context) {
  const body = renderTemplate(template.template_body, context);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(template.template_name)} preview</title>
<style>
body{font-family:Arial,"Segoe UI",sans-serif;margin:32px;color:#111827;line-height:1.5}
.meta{color:#6b7280;margin:0 0 16px}
pre{white-space:pre-wrap;border:1px solid #d1d5db;background:#f9fafb;padding:16px}
</style></head><body>
<h1>${htmlEscape(template.template_name)}</h1>
<p class="meta">${htmlEscape(template.report_type)} preview</p>
<pre>${htmlEscape(body)}</pre>
</body></html>`;
}

router.get('/', (req, res) => {
  const includeInactive = req.query.include_inactive === '1';
  const type = String(req.query.report_type || '').trim();
  const rows = reportTemplateRepository.list({ includeInactive, type });
  res.json({ items: rows.map(mapTemplate) });
});

router.get('/definitions', (req, res) => {
  const legacy = reportTemplateRepository.list({ includeInactive: true })
    .filter((item) => ['INTERNAL', 'NCC'].includes(item.report_type))
    .map(mapTemplate);
  res.json({
    items: reportVersionRepository.listDefinitions().map((row) => mapDefinition(row, req.user)),
    legacy: { section: 'MIGRATION_ARCHIVED', items: legacy },
  });
});

router.get('/legacy-migration', (req, res) => {
  const migration = new LegacyReportTemplateMigration({ db });
  return res.json({ report: migration.dryRun(), review_queue: migration.reviewQueue() });
});

router.post('/legacy-migration/apply', requirePermission(PERMISSIONS.REPORT_TEMPLATE_PUBLISH), (req, res) => {
  try {
    const migration = new LegacyReportTemplateMigration({ db });
    return res.json({ report: migration.applyApproved({ actor: req.user.userId }) });
  } catch (error) { return sendVersionError(res, error); }
});

router.get('/preview-sources', (req, res) => {
  const definition = getDefinition(req.query.definition_code || 'WORKING_MINUTES');
  return res.json({
    items: [
      { source: 'synthetic', ticket_code: null, supplier_code: 'RUN20-NCC', supplier_name: 'Nhà cung cấp mẫu RUN-20', current_round_no: definition.defaultRoundNo },
      ...previewTicketList(req.query.limit),
    ],
  });
});

router.get('/definitions/:definitionCode/versions', (req, res) => {
  try {
    res.json({ items: reportVersionRepository.listVersions(req.params.definitionCode).map((row) => mapVersion(row, { user: req.user })) });
  } catch (error) { return sendVersionError(res, error); }
});

router.post('/definitions/:definitionCode/versions', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  try {
    const item = reportVersionRepository.createDraft({
      definitionCode: req.params.definitionCode,
      sourceVersionId: req.body?.source_version_id || null,
      name: req.body?.version_name,
      note: req.body?.version_note,
      effectiveFrom: req.body?.effective_from,
      effectiveTo: req.body?.effective_to,
      actor: req.user.userId,
      context: versionContext(),
    });
    return res.status(201).json({ item: mapVersion(item, { includeDefinition: true, user: req.user }) });
  } catch (error) { return sendVersionError(res, error); }
});

router.post('/definitions/:definitionCode/import-package', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  try {
    const imported = validateDefinitionPackage(req.body?.package, {
      targetDefinitionCode: req.params.definitionCode,
      conflictStrategy: req.body?.conflict_strategy,
    });
    const created = reportVersionRepository.createDraft({
      definitionCode: imported.targetCode,
      name: req.body?.version_name || `Imported ${imported.targetCode}`,
      note: `Imported definition package ${imported.checksum}`,
      actor: req.user.userId,
      context: versionContext(),
    });
    const updated = reportVersionRepository.updateDraft({
      versionId: created.id,
      expectedLockVersion: created.lock_version,
      definition: imported.definition,
      actor: req.user.userId,
      context: versionContext(),
    });
    return res.status(201).json({ item: mapVersion(updated, { includeDefinition: true, user: req.user }) });
  } catch (error) { return sendVersionError(res, error); }
});

router.get('/versions/:versionId', (req, res) => {
  const row = reportVersionRepository.getVersion(req.params.versionId);
  if (!row) return res.status(404).json({ error: 'report_template_version_not_found' });
  return res.json({
    item: mapVersion(row, { includeDefinition: true, user: req.user }),
    events: reportVersionRepository.events(row.id),
  });
});

router.put('/versions/:versionId', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  try {
    const existing = reportVersionRepository.requireVersion(req.params.versionId);
    const isAdvanced = req.body?.editor_mode === 'advanced_json' || req.body?.definition != null;
    if (isAdvanced && !hasPermission(req.user, PERMISSIONS.REPORT_TEMPLATE_ADVANCED)) {
      return res.status(403).json({ error: 'forbidden_permission', request_id: req.requestId });
    }
    const definition = isAdvanced ? req.body?.definition : {
      schema_version: Number(existing.schema_version || 1),
      components: req.body?.components,
      styles: req.body?.styles || {},
    };
    const item = reportVersionRepository.updateDraft({
      versionId: req.params.versionId,
      expectedLockVersion: req.body?.lock_version,
      definition,
      name: req.body?.version_name,
      note: req.body?.version_note,
      effectiveFrom: req.body?.effective_from,
      effectiveTo: req.body?.effective_to,
      actor: req.user.userId,
      context: versionContext(),
    });
    return res.json({ item: mapVersion(item, { includeDefinition: true, user: req.user }) });
  } catch (error) { return sendVersionError(res, error); }
});

router.post('/versions/:versionId/validate', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  try {
    const version = reportVersionRepository.requireVersion(req.params.versionId);
    return res.json({
      item: reportVersionRepository.validateVersion(version.id),
      version: mapVersion(version, { user: req.user }),
    });
  } catch (error) { return sendVersionError(res, error); }
});

router.get('/versions/:versionId/package', (req, res) => {
  try {
    const version = reportVersionRepository.requireVersion(req.params.versionId);
    res.setHeader('Content-Disposition', `attachment; filename="${version.definition_code.toLowerCase()}-v${version.version_no}.report.json"`);
    return res.json(createDefinitionPackage(version));
  } catch (error) { return sendVersionError(res, error); }
});

for (const [action, permission, execute] of [
  ['submit', PERMISSIONS.REPORT_TEMPLATE_MANAGE, (body, actor, context) => reportVersionRepository.submit({ versionId: body.version_id, expectedLockVersion: body.lock_version, actor, context })],
  ['publish', PERMISSIONS.REPORT_TEMPLATE_PUBLISH, (body, actor, context) => reportVersionRepository.publish({ versionId: body.version_id, expectedLockVersion: body.lock_version, actor, context })],
  ['retire', PERMISSIONS.REPORT_TEMPLATE_PUBLISH, (body, actor, context) => reportVersionRepository.retire({ versionId: body.version_id, expectedLockVersion: body.lock_version, actor, context })],
  ['rollback', PERMISSIONS.REPORT_TEMPLATE_PUBLISH, (body, actor, context) => reportVersionRepository.rollback({ versionId: body.version_id, expectedLockVersion: body.lock_version, actor, context })],
]) {
  router.post(`/versions/:versionId/${action}`, requirePermission(permission), (req, res) => {
    try {
      const item = execute({ ...req.body, version_id: req.params.versionId }, req.user.userId, versionContext());
      return res.json({ item: mapVersion(item, { includeDefinition: true, user: req.user }) });
    } catch (error) { return sendVersionError(res, error); }
  });
}

router.get('/versions/:versionId/preview', (req, res) => {
  const ticketCode = String(req.query.ticket_code || '').trim();
  const source = String(req.query.source || '').trim().toLowerCase();
  const synthetic = source === 'synthetic';
  const ticket = synthetic
    ? { id: 20001, ticket_code: 'RUN20-SYNTHETIC' }
    : (ticketCode
      ? db.prepare('SELECT * FROM evaluation_tickets WHERE ticket_code=? AND COALESCE(is_deleted,0)=0').get(ticketCode)
      : latestPreviewTicket());
  if (!ticket) return res.status(404).json({ error: 'preview_ticket_not_found' });
  try {
    const version = reportVersionRepository.requireVersion(req.params.versionId);
    const definition = getDefinition(version.definition_code);
    const selectedRound = definition.validateRound(Number(req.query.round_no || 0) || undefined);
    const orchestrator = synthetic
      ? new ReportOrchestrator({ db, repository: reportVersionRepository, contextBuilder: buildSyntheticReportContext })
      : reportOrchestrator;
    const rendered = orchestrator.previewVersion({
      versionId: req.params.versionId,
      ticket,
      roundNo: selectedRound,
      format: String(req.query.format || 'HTML').toUpperCase(),
    });
    if (req.query.envelope === '1') {
      const published = reportVersionRepository.resolvePublished({ definitionCode: version.definition_code });
      const baseline = published ? orchestrator.renderVersion({ version: published, ticket, roundNo: selectedRound, format: 'HTML' }) : null;
      const beforeSections = new Map((baseline?.semantic?.sections || []).map((section) => [section.id, JSON.stringify(section)]));
      const changedComponents = rendered.semantic.sections
        .filter((section) => beforeSections.get(section.id) !== JSON.stringify(section))
        .map((section) => section.id);
      return res.json({
        html: rendered.buffer.toString('utf8'),
        provenance: {
          definition_code: rendered.definition_code,
          template_version_id: rendered.template_version_id,
          template_version_no: rendered.template_version_no,
          template_checksum: rendered.template_checksum,
          data_contract_version: 1,
          context_checksum: rendered.context_checksum,
          semantic_checksum: rendered.semantic_checksum,
          scoring_policy: rendered.scoring_policy_version_id
            ? { version_id: rendered.scoring_policy_version_id, checksum: rendered.scoring_policy_checksum }
            : { compatibility_marker: rendered.scoring_compatibility_marker },
          source: synthetic ? 'synthetic' : 'ticket',
          ticket_code: synthetic ? 'RUN20-SYNTHETIC' : ticket.ticket_code,
          round_no: selectedRound,
        },
        comparison: {
          baseline_template_version_id: published?.id || null,
          baseline_semantic_checksum: baseline?.semantic_checksum || null,
          changed: !baseline || baseline.semantic_checksum !== rendered.semantic_checksum,
          changed_component_ids: changedComponents,
        },
        warnings: previewWarnings(rendered.semantic),
        formats: ['HTML', 'PDF', 'XLSX'].map((format) => ({
          format,
          semantic_checksum: rendered.semantic_checksum,
          url: `/qlcl/api/report-templates/versions/${version.id}/preview?source=${synthetic ? 'synthetic' : 'ticket'}&ticket_code=${encodeURIComponent(ticketCode)}&round_no=${selectedRound}&format=${format}`,
        })),
      });
    }
    res.setHeader('X-Report-Template-Version-Id', String(rendered.template_version_id));
    res.setHeader('X-Report-Context-Checksum', rendered.context_checksum);
    res.setHeader('Content-Type', rendered.content_type);
    return res.send(rendered.buffer);
  } catch (error) { return sendVersionError(res, error); }
});

router.get('/:id/preview', (req, res) => {
  const template = reportTemplateRepository.getById(parseInt(req.params.id, 10));
  if (!template) return res.status(404).send('Template not found');
  const ticket = latestPreviewTicket();
  const alias = resolveReportAlias(template.report_type);
  if (alias.canonical_code) res.setHeader('X-Report-Canonical-Code', alias.canonical_code);
  if (alias.legacy_source) {
    res.setHeader('X-Report-Legacy-Source', alias.legacy_source);
    res.setHeader('X-Report-Legacy-Alias-Version', alias.mapping_version);
    res.setHeader('Deprecation', 'true');
  }
  const definition = reportDefinitionFor(template.report_type);
  if (isCanonicalDefinition(template.report_type)) {
    if (!ticket) return res.status(404).send('Preview ticket not found');
    try {
      const rendered = reportOrchestrator.renderProduction({
        definitionCode: template.report_type,
        ticket,
        roundNo: definition.defaultRoundNo,
        format: 'HTML',
      });
      res.setHeader('X-Report-Template-Version-Id', String(rendered.template_version_id));
      return res.type('html').send(rendered.buffer);
    } catch (error) { return sendVersionError(res, error); }
  }
  const context = ticket ? buildReportContext(db, ticket, { reportType: definition.code, requireRound: false }) : {
    ...samplePreviewContext(),
    report_type: definition.code,
    report_label: definition.label,
    report_definition: definition,
  };
  // APV-REPORT-001/REPORT-002 compatibility only: INTERNAL and NCC are not
  // assigned to a canonical definition until the product decision is approved.
  const html = definition.renderer === 'result'
    ? renderInternalReportHtml(context)
    : (definition.code === 'WORKING_MINUTES' ? renderWorkingMinutesHtml(context) : renderTextTemplatePreview(template, context));
  res.type('html').send(html);
});

router.get('/:id', (req, res) => {
  const row = reportTemplateRepository.getById(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'template_not_found' });
  res.json({ item: mapTemplate(row) });
});

router.post('/', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  const body = req.body || {};
  const name = String(body.template_name || '').trim();
  const type = String(body.report_type || '').trim();
  const templateBody = String(body.template_body || '').trim();
  const alias = resolveReportAlias(type);
  if (alias.legacy_source) {
    return res.status(409).json(businessErrorPayload('report_legacy_creation_disabled', {
      canonical_code: alias.canonical_code,
      legacy_source: alias.legacy_source,
      deprecation: alias.deprecation,
    }));
  }
  if (!name || !isAllowedReportType(type) || !templateBody) return res.status(400).json({ error: 'invalid_template' });
  try {
    const info = reportTemplateRepository.insert(name, type, templateBody, body.active === false ? 0 : 1);
    res.status(201).json({ item: mapTemplate(reportTemplateRepository.getById(info.lastInsertRowid)) });
  } catch {
    res.status(409).json({ error: 'template_exists' });
  }
});

router.put('/:id', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = reportTemplateRepository.getById(id);
  if (!existing) return res.status(404).json({ error: 'template_not_found' });
  const body = req.body || {};
  const name = String(body.template_name || existing.template_name).trim();
  const type = String(body.report_type || existing.report_type).trim();
  const templateBody = String(body.template_body || existing.template_body).trim();
  const alias = resolveReportAlias(type);
  if (alias.legacy_source) {
    return res.status(409).json(businessErrorPayload('report_legacy_creation_disabled', {
      canonical_code: alias.canonical_code,
      legacy_source: alias.legacy_source,
      deprecation: alias.deprecation,
    }));
  }
  if (!name || !isAllowedReportType(type) || !templateBody) return res.status(400).json({ error: 'invalid_template' });
  try {
    reportTemplateRepository.update(id, name, type, templateBody, body.active === false ? 0 : 1);
    res.json({ item: mapTemplate(reportTemplateRepository.getById(id)) });
  } catch {
    res.status(409).json({ error: 'template_exists' });
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.REPORT_TEMPLATE_MANAGE), (req, res) => {
  const info = reportTemplateRepository.deactivate(parseInt(req.params.id, 10));
  if (info.changes === 0) return res.status(404).json({ error: 'template_not_found' });
  res.json({ ok: true });
});

module.exports = router;
