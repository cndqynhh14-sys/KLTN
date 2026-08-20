const { normalizeSupplierScale, validateCriteriaVariant } = require('../domain/criteriaVariants');
const { validateMerchandising } = require('../domain/merchandising');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { resourceContext: baseResourceContext } = require('./PolicyService');
const { stableMch2Sql } = require('../domain/mchIdentifiers');
const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const { assertValidDateField } = require('../domain/dateValidation');
const { normalizeMasterDataText, supplierMasterDataErrorCodes } = require('../domain/masterData');
const { normalizeSupplierCode } = require('../domain/supplierCode');
const { upsertSupplier } = require('./supplierImporter');
const { QuestionVersionService } = require('./QuestionVersionService');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');
const { supportsPreviousEvaluationDefaults } = require('../domain/evaluationHistoryDefaults');
const { canonicalEvaluationOwnerSql, isEvaluationCreatedAndResponsible } = require('../domain/evaluationResponsibility');
const { assertTicketMutable } = require('../domain/historicalEvaluation');

const DRAFT_STATUS = WORKFLOW_STATUSES.DRAFT;
const PROCESSING_STATUS = WORKFLOW_STATUSES.IN_PROGRESS;

function resourceContext(row = {}) {
  const context = baseResourceContext(row);
  const ownerId = row.assigned_specialist_id || row.created_by || null;
  return { ...context, ownerId, assignedUserId: ownerId };
}

function todayCode() {
  return new Date().toISOString().slice(2, 10).replace(/-/g, '');
}

function normalizeScale(value) {
  const normalized = normalizeSupplierScale(value);
  return normalized === 'SMALL' ? 'SMALL' : 'LARGE';
}

function templateCodeFromBody(body) {
  return String(body.template || body.template_code || body.template_id || '').trim();
}

function supplierFromBody(body) {
  return {
    supplier_code: normalizeSupplierCode(body.supplier_code),
    supplier_name: String(body.supplier_name || '').trim(),
    tax_code: String(body.tax_code || '').trim(),
    address: String(body.address || body.supplier_address || '').trim(),
    region: String(body.region || '').trim(),
    province: String(body.province || '').trim(),
    business_type: String(body.business_type || '').trim(),
    contact_name: String(body.contact_name || '').trim(),
    contact_email: String(body.email || body.contact_email || '').trim(),
    contact_phone: String(body.phone || body.contact_phone || '').trim(),
    status: 'ACTIVE',
  };
}

function hasOwnField(body, field) {
  return Object.prototype.hasOwnProperty.call(body || {}, field);
}

function participantPayload(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function participantIdentity(row) {
  return String(row?.user_id || row?.display_name || '').trim();
}

function supplierSnapshotField(body, supplier, existing, field) {
  if (hasOwnField(body, field)) return body[field];
  if (hasOwnField(existing, field)) return existing[field];
  return supplier ? supplier[field] : '';
}

function standardSupplierFields(body, supplier, existing = {}) {
  return {
    region: normalizeMasterDataText(supplierSnapshotField(body, supplier, existing, 'region')),
    province: normalizeMasterDataText(supplierSnapshotField(body, supplier, existing, 'province')),
    business_type: normalizeMasterDataText(supplierSnapshotField(body, supplier, existing, 'business_type')),
  };
}

function hasExplicitStandardSupplierField(body) {
  return ['region', 'province', 'business_type'].some((field) => hasOwnField(body, field));
}

function canonicalBodyValue(body, canonicalField, compatibilityField) {
  if (hasOwnField(body, canonicalField)) return body[canonicalField];
  if (compatibilityField && hasOwnField(body, compatibilityField)) return body[compatibilityField];
  return undefined;
}

function ticketSnapshotText(body, existing, canonicalField, compatibilityField) {
  const value = canonicalBodyValue(body, canonicalField, compatibilityField);
  if (value !== undefined) return String(value || '').trim();
  return String(existing[canonicalField] || '').trim();
}

function normalizedEvaluationType(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd').toLowerCase().trim();
}

function validContactEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function validContactPhone(value) {
  return /^[0-9+\-\s.]{8,20}$/.test(String(value || '').trim());
}

function missingSupplierFields(supplier) {
  return [
    ['supplier_code', 'supplier_code_required'],
    ['supplier_name', 'supplier_name_required'],
    ['tax_code', 'tax_code_required'],
    ['address', 'supplier_address_required'],
    ['region', 'region_required'],
    ['province', 'province_required'],
    ['business_type', 'business_type_required'],
    ['contact_name', 'contact_name_required'],
    ['contact_email', 'contact_email_required'],
    ['contact_phone', 'contact_phone_required'],
  ].filter(([field]) => !String(supplier[field] || '').trim()).map(([, error]) => error);
}

function assertValidSupplierMasterData(fields) {
  const errors = supplierMasterDataErrorCodes(fields);
  if (errors.length) {
    throw Object.assign(new Error('supplier_master_data_invalid'), {
      status: 400,
      code: 'validation_failed',
      errors,
    });
  }
}

class EvaluationTicketService {
  constructor({ db, ticketRepository, roundRepository, logWorkflow, attachLegalFiles, detailProviders = {}, policyService }) {
    this.db = db;
    this.ticketRepository = ticketRepository;
    this.roundRepository = roundRepository;
    this.logWorkflow = logWorkflow;
    this.attachLegalFiles = attachLegalFiles;
    this.detailProviders = detailProviders;
    this.policyService = policyService;
    this.questionVersionService = new QuestionVersionService(db);
    this.scoringPolicyRepository = new ScoringPolicyRepository(db);
    this.statements = {
      getTemplateId: db.prepare('SELECT id FROM question_templates WHERE template_code = ?'),
      insertTemplate: db.prepare('INSERT INTO question_templates (template_code, template_name, active) VALUES (?, ?, 1)'),
      getSupplierById: db.prepare('SELECT * FROM supplier_master WHERE id = ?'),
      getSupplierByCode: db.prepare('SELECT * FROM supplier_master WHERE UPPER(TRIM(supplier_code)) = ?'),
      lockSnapshot: db.prepare(`UPDATE evaluation_tickets
        SET snapshot_locked_at = COALESCE(snapshot_locked_at, (
          SELECT started_at FROM evaluation_rounds
          WHERE ticket_id = evaluation_tickets.id AND round_no = 1
        ))
        WHERE id = ?`),
    };
  }

  nextTicketCode(supplierCode) {
    const prefix = `${todayCode()}-${supplierCode}`;
    const count = this.ticketRepository.countTicketsWithCodePrefix(prefix);
    return `${prefix}-${String(count + 1).padStart(3, '0')}`;
  }

  getTicketByCode(code) {
    return this.ticketRepository.getByCode(code);
  }

  getTicketByIdentifier(identifier) {
    return this.ticketRepository.getByIdOrCode(identifier);
  }

  listBootstrap(user) {
    const rows = this.ticketRepository.listBootstrap();
    const scoped = this.policyService.filter(user, PERMISSIONS.EVALUATION_READ, rows, resourceContext);
    if (this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN)) return scoped;
    if (this.policyService.has(user, PERMISSIONS.EVALUATION_CREATE) ||
        this.policyService.has(user, PERMISSIONS.EVALUATION_SCORE)) {
      return scoped.filter((row) => isEvaluationCreatedAndResponsible(row, user));
    }
    const levels = this.policyService.approvalLevels(user, 'EVALUATION');
    if (!levels.length) return scoped;
    const pending = new Set(this.ticketRepository.pendingTicketIdsForLevels(levels));
    return scoped.filter((row) => pending.has(row.id));
  }

  listTickets(query, user) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(query.page_size || '15', 10)));
    const where = [];
    const params = {};
    const q = String(query.q || '').trim();
    const scope = this.workspaceScopeForUser(user, 't');
    Object.assign(params, scope.params);
    where.push(scope.where);
    if (q) {
      params.q = `%${q}%`;
      where.push('(t.ticket_code LIKE @q OR t.supplier_code LIKE @q OR t.supplier_name LIKE @q)');
    }
    ['evaluation_type', 'current_status', 'mch2', 'mch3'].forEach((field) => {
      const value = String(query[field] || '').trim();
      if (value) {
        params[field] = value;
        where.push(`t.${field} = @${field}`);
      }
    });
    const includeDeleted = String(query.include_deleted || '') === '1';
    if (includeDeleted && !this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN)) {
      throw Object.assign(new Error('forbidden_permission'), { status: 403, code: 'forbidden_permission' });
    }
    if (!includeDeleted) where.push('COALESCE(t.is_deleted, 0) = 0');
    if (query.from) {
      params.from = String(query.from);
      where.push('date(t.created_at) >= date(@from)');
    }
    if (query.to) {
      params.to = String(query.to);
      where.push('date(t.created_at) <= date(@to)');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows, total } = this.ticketRepository.list({
      whereSql,
      params,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  getPreviousEvaluationDefaults({ supplierId, evaluationType, user }) {
    if (!supportsPreviousEvaluationDefaults(evaluationType)) return null;
    const normalizedSupplierId = Number(supplierId);
    if (!Number.isSafeInteger(normalizedSupplierId) || normalizedSupplierId <= 0) return null;
    const scope = this.workspaceScopeForUser(user, 't');
    const row = this.ticketRepository.findPreviousEvaluationDefaults({
      supplierId: normalizedSupplierId,
      whereSql: scope.where,
      params: scope.params,
    });
    if (!row) return null;
    return {
      template_code: row.template_code || null,
      facility_type: row.facility_type || null,
      supplier_scale: row.supplier_scale || null,
      source_ticket_id: row.source_ticket_id,
      source_ticket_code: row.source_ticket_code,
      evaluation_date: row.evaluation_date,
    };
  }

  assertVisible(row, user) {
    this.policyService.assert(user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(row) });
    if (!this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN) && !isEvaluationCreatedAndResponsible(row, user)) {
      throw Object.assign(new Error('forbidden_scope'), { status: 403, code: 'forbidden_scope' });
    }
  }

  assertDetailVisible(row, user) {
    if (this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN) || isEvaluationCreatedAndResponsible(row, user)) {
      this.assertVisible(row, user);
      return;
    }
    this.policyService.assert(user, PERMISSIONS.EVALUATION_READ, { context: resourceContext(row) });
    const actions = this.policyService.actionEnvelope('EVALUATION', row, user).allowed_actions || [];
    if (!actions.some((action) => ['approve_lead', 'approve_tbp', 'approve_gdk'].includes(action))) {
      throw Object.assign(new Error('forbidden_scope'), { status: 403, code: 'forbidden_scope' });
    }
  }

  isWorkspaceVisible(row, user) {
    if (this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN)) return true;
    const isOperator = this.policyService.has(user, PERMISSIONS.EVALUATION_CREATE) ||
      this.policyService.has(user, PERMISSIONS.EVALUATION_SCORE);
    return isOperator && isEvaluationCreatedAndResponsible(row, user);
  }

  scopeForUser(user, alias = 't') {
    const owner = canonicalEvaluationOwnerSql(alias);
    return this.policyService.sqlScope(user, {
      alias,
      fieldExpressions: { owner, assigned: owner, mch2: stableMch2Sql(`${alias}.mch2`) },
    });
  }

  workspaceScopeForUser(user, alias = 't') {
    if (this.policyService.has(user, PERMISSIONS.SYSTEM_ADMIN)) return this.scopeForUser(user, alias);
    const isOperator = this.policyService.has(user, PERMISSIONS.EVALUATION_CREATE) ||
      this.policyService.has(user, PERMISSIONS.EVALUATION_SCORE);
    if (!isOperator) return { where: '0 = 1', params: {} };
    const scope = this.scopeForUser(user, alias);
    return {
      where: `(${scope.where}) AND (
        COALESCE(${alias}.created_by_user_id, '') = @scope_user_id
        OR LOWER(COALESCE(${alias}.created_by, '')) = LOWER(@scope_user_email)
      )`,
      params: scope.params,
    };
  }

  getTicketDetail(code, user) {
    const row = this.getTicketByCode(code);
    if (!row) return null;
    this.assertDetailVisible(row, user);
    const attachments = this.detailProviders.attachmentsForTicket(row.id);
    const legalAttachments = {};
    attachments.forEach((item) => {
      if (item.kind && !legalAttachments[item.kind]) legalAttachments[item.kind] = item;
    });
    return {
      row,
      corrective_actions: this.detailProviders.correctiveActionsForTicket(row.id),
      correction_extensions: this.detailProviders.correctionExtensionsForTicket(row.id),
      nonconformities: this.detailProviders.nonconformitiesForTicket(row.id),
      category_summary: this.detailProviders.categorySummaryForTicket(row.id),
      attachments,
      assessments: this.detailProviders.assessmentRoundsForTicket(row),
      legal_attachments: legalAttachments,
      approval_tasks: this.detailProviders.approvalTasksForTicket(row.id),
      workflow_history: this.detailProviders.workflowHistoryForTicket(row.id),
      rejection_history: this.detailProviders.rejectionHistoryForTicket(row.id),
    };
  }

  validateTicketBody(body, partial = false) {
    const required = [
      ['evaluation_type', 'evaluation_type_required'],
      ['facility_type', 'facility_type_required'],
      ['planned_date', 'planned_date_required'],
    ];
    const errors = [];
    for (const [field, error] of required) {
      if (!partial && !String(body[field] || '').trim()) errors.push(error);
    }
    if (!partial && !templateCodeFromBody(body)) errors.push('template_required');
    if (!partial && !String(body.supplier_id || body.supplier_code || '').trim()) errors.push('supplier_required');
    if (!partial && !String(body.supplier_id || body.supplier_name || '').trim()) errors.push('supplier_name_required');
    if (!partial && normalizedEvaluationType(body.evaluation_type).includes('dot xuat') && !String(body.ad_hoc_reason || '').trim()) {
      errors.push('ad_hoc_reason_required');
    }
    return errors;
  }

  createTicket({ body, files, user }) {
    const errors = this.validateTicketBody(body);
    if (errors.length) throw Object.assign(new Error('validation_failed'), { status: 400, code: 'validation_failed', errors });
    return this.db.transaction(() => {
      const supplier = this.resolveSupplier(body, user);
      const payload = this.ticketPayload(body, supplier, user.email);
      this.policyService.assert(user, PERMISSIONS.EVALUATION_CREATE, {
        context: resourceContext({ ...payload, created_by: user.email }),
      });
      this.assertTicketSnapshot(payload);
      if (files?.business_license_file?.[0]) payload.business_license_file = files.business_license_file[0].originalname;
      if (files?.attp_certificate_file?.[0]) payload.attp_certificate_file = files.attp_certificate_file[0].originalname;
      const ticketCode = this.nextTicketCode(supplier.supplier_code);
      const info = this.ticketRepository.insert({ ...payload, ticket_code: ticketCode, created_by: user.email });
      const scoringVersion = this.scoringPolicyRepository.pinTicket(info.lastInsertRowid);
      this.ticketRepository.updateCreateExtras({ ...payload, id: info.lastInsertRowid });
      this.updateLegalFiles(info.lastInsertRowid, files, user.email);
      this.roundRepository.insert({
        ticket_id: info.lastInsertRowid,
        round_no: 1,
        source_round_id: null,
        assessment_code: `${ticketCode}-R1`,
        assessment_date: null,
        evaluator_id: user.email,
        status: DRAFT_STATUS,
      });
      this.statements.lockSnapshot.run(info.lastInsertRowid);
      this.logWorkflow(info.lastInsertRowid, user, 'TICKET_CREATE', null, DRAFT_STATUS, JSON.stringify({
        ticket_code: ticketCode,
        scoring_policy_version_id: scoringVersion.id,
        scoring_policy_checksum: scoringVersion.checksum,
      }));
      return this.getTicketByCode(ticketCode);
    })();
  }

  updateTicket({ code, body, files, user }) {
    const existing = this.getTicketByCode(code);
    if (!existing) throw Object.assign(new Error('ticket_not_found'), { status: 404, code: 'ticket_not_found' });
    this.assertVisible(existing, user);
    assertTicketMutable(existing);
    if (![DRAFT_STATUS, PROCESSING_STATUS].includes(existing.current_status)) {
      throw Object.assign(new Error('ticket_locked'), { status: 403, code: 'ticket_locked' });
    }
    return this.db.transaction(() => {
      const supplier = this.resolveSupplier(
        { ...existing, ...body, supplier_id: body.supplier_id || existing.supplier_id },
        user,
        { allowInactiveSupplierId: existing.supplier_id },
      );
      const payload = this.ticketPayload(body, supplier, user.email, existing);
      this.policyService.assert(user, PERMISSIONS.EVALUATION_CREATE, {
        context: resourceContext({ ...existing, ...payload }),
      });
      this.assertTicketSnapshot(payload);
      if (files?.business_license_file?.[0]) payload.business_license_file = files.business_license_file[0].originalname;
      if (files?.attp_certificate_file?.[0]) payload.attp_certificate_file = files.attp_certificate_file[0].originalname;
      this.ticketRepository.updateByCode({ ...payload, ticket_code: existing.ticket_code });
      this.updateLegalFiles(existing.id, files, user.email);
      this.logWorkflow(existing.id, user, 'TICKET_EDIT', existing.current_status, existing.current_status, null);
      return this.getTicketByCode(existing.ticket_code);
    })();
  }

  deleteTicket({ code, reason, user }) {
    const existing = this.getTicketByCode(code);
    if (!existing) throw Object.assign(new Error('ticket_not_found'), { status: 404, code: 'ticket_not_found' });
    this.assertVisible(existing, user);
    assertTicketMutable(existing);
    const decision = this.policyService.decision(user, PERMISSIONS.EVALUATION_DELETE_DRAFT, {
      context: resourceContext(existing), stateAllowed: existing.current_status === DRAFT_STATUS,
      stateReason: 'ticket_delete_not_allowed',
    });
    if (!decision.allowed) {
      throw Object.assign(new Error('ticket_delete_not_allowed'), { status: 403, code: 'ticket_delete_not_allowed' });
    }
    if (!reason) throw Object.assign(new Error('delete_reason_required'), { status: 400, code: 'delete_reason_required' });
    this.ticketRepository.softDelete({ id: existing.id, deleted_by: user.email, deleted_reason: reason });
    this.logWorkflow(existing.id, user, 'TICKET_SOFT_DELETE', existing.current_status, existing.current_status, reason);
    return { ok: true, deleted: existing.ticket_code, soft_deleted: true };
  }

  updateLegalFiles(ticketId, files, userEmail) {
    const savedFiles = this.attachLegalFiles(ticketId, files, userEmail);
    if (savedFiles.business_license || savedFiles.attp_certificate) {
      this.ticketRepository.updateLegalFileNames({
        id: ticketId,
        business_license_file: savedFiles.business_license?.file_name || null,
        attp_certificate_file: savedFiles.attp_certificate?.file_name || null,
      });
    }
  }

  getTemplateId(templateCode) {
    const code = String(templateCode || '').trim();
    let row = this.statements.getTemplateId.get(code);
    if (!row && code) {
      const info = this.statements.insertTemplate.run(code, code);
      row = { id: info.lastInsertRowid };
    }
    return row ? row.id : null;
  }

  assertSupplierActive(supplier, allowInactiveSupplierId = null) {
    if (supplier?.status === 'ACTIVE') return;
    if (allowInactiveSupplierId && Number(supplier?.id) === Number(allowInactiveSupplierId)) return;
    throw Object.assign(new Error('supplier_inactive'), { status: 409, code: 'supplier_inactive' });
  }

  resolveSupplier(body, user, options = {}) {
    const userEmail = user?.email;
    this.policyService.assert(user, PERMISSIONS.SUPPLIER_READ);
    if (body.supplier_id) {
      const supplier = this.statements.getSupplierById.get(parseInt(body.supplier_id, 10));
      if (!supplier) throw Object.assign(new Error('supplier_not_found'), { status: 400, code: 'supplier_not_found' });
      this.policyService.assert(user, PERMISSIONS.SUPPLIER_READ, { context: resourceContext(supplier) });
      this.assertSupplierActive(supplier, options.allowInactiveSupplierId);
      return supplier;
    }
    const supplier = supplierFromBody(body);
    if (!supplier.supplier_code || !supplier.supplier_name) {
      throw Object.assign(new Error('supplier_required'), { status: 400, code: 'supplier_required' });
    }
    const existing = this.statements.getSupplierByCode.get(supplier.supplier_code);
    if (existing) {
      this.policyService.assert(user, PERMISSIONS.SUPPLIER_READ, { context: resourceContext(existing) });
      this.assertSupplierActive(existing, options.allowInactiveSupplierId);
      return existing;
    }
    const supplierErrors = missingSupplierFields(supplier);
    if (supplier.contact_email && !validContactEmail(supplier.contact_email)) supplierErrors.push('contact_email_invalid');
    if (supplier.contact_phone && !validContactPhone(supplier.contact_phone)) supplierErrors.push('contact_phone_invalid');
    if (supplierErrors.length) {
      throw Object.assign(new Error('supplier_validation_failed'), {
        status: 400,
        code: 'validation_failed',
        errors: supplierErrors,
      });
    }
    assertValidSupplierMasterData(supplier);
    this.policyService.assert(user, PERMISSIONS.SUPPLIER_WRITE, {
      context: resourceContext({ ...(existing || {}), ...supplier }),
    });
    upsertSupplier(this.db, supplier, userEmail, 'MANUAL', null);
    const resolved = this.statements.getSupplierByCode.get(supplier.supplier_code);
    this.policyService.assert(user, PERMISSIONS.SUPPLIER_READ, { context: resourceContext(resolved) });
    return resolved;
  }

  assertTicketSnapshot(payload) {
    const snapshotErrors = missingSupplierFields({
      supplier_code: payload.supplier_code,
      supplier_name: payload.supplier_name,
      tax_code: payload.tax_code,
      address: payload.supplier_address,
      region: payload.region,
      province: payload.province,
      business_type: payload.business_type,
      contact_name: payload.contact_name,
      contact_email: payload.contact_email,
      contact_phone: payload.contact_phone,
    });
    if (!payload.cmc_owner) snapshotErrors.push('cmc_owner_required');
    if (!payload.cmc_head) snapshotErrors.push('cmc_head_required');
    if (!payload.mch2) snapshotErrors.push('mch2_required');
    if (!payload.mch3) snapshotErrors.push('mch3_required');
    if (!payload.snapshot_product_name) snapshotErrors.push('product_name_required');
    if (!payload.snapshot_evaluation_address && !payload.snapshot_linked_facility_address) {
      snapshotErrors.push('evaluation_location_required');
    }
    if (Boolean(payload.snapshot_linked_facility_name) !== Boolean(payload.snapshot_linked_facility_address)) {
      snapshotErrors.push('linked_facility_pair_required');
    }
    if (payload.contact_email && !validContactEmail(payload.contact_email)) snapshotErrors.push('contact_email_invalid');
    if (payload.contact_phone && !validContactPhone(payload.contact_phone)) snapshotErrors.push('contact_phone_invalid');
    if (snapshotErrors.length) {
      throw Object.assign(new Error('ticket_snapshot_validation_failed'), {
        status: 400,
        code: 'validation_failed',
        errors: [...new Set(snapshotErrors)],
      });
    }
  }

  ticketPayload(body, supplier, userEmail, existing = {}) {
    const templateCode = templateCodeFromBody(body) || existing.template_code;
    const facilityType = String(body.facility_type || existing.facility_type || '').trim();
    const supplierScale = normalizeScale(body.supplier_scale || existing.supplier_scale);
    const variantCheck = validateCriteriaVariant(templateCode, facilityType, supplierScale);
    if (!variantCheck.ok) {
      throw Object.assign(new Error('criteria_variant_invalid'), {
        status: 400,
        code: 'criteria_variant_invalid',
        errors: variantCheck.errors,
      });
    }
    const templateId = this.getTemplateId(templateCode);
    if (!templateId) throw Object.assign(new Error('template_required'), { status: 400, code: 'template_required' });
    let questionTemplateVersionId = existing.question_template_version_id || null;
    if (questionTemplateVersionId) {
      const pinned = this.questionVersionService.getRow(questionTemplateVersionId);
      if (!pinned || Number(pinned.template_id) !== Number(templateId)) {
        throw Object.assign(new Error('ticket_question_version_immutable'), { status: 409, code: 'ticket_question_version_immutable' });
      }
      const scopedItems = this.questionVersionService.questionsForVersion(questionTemplateVersionId, {
        facilityType,
        supplierScale,
      });
      if (!scopedItems.length) {
        throw Object.assign(new Error('question_version_scope_unavailable'), { status: 409, code: 'question_version_scope_unavailable' });
      }
    } else {
      const published = this.questionVersionService.resolvePublished({
        templateId,
        facilityType,
        supplierScale,
        at: body.planned_date || existing.planned_date || null,
      });
      if (!published) {
        throw Object.assign(new Error('question_version_not_published'), { status: 409, code: 'question_version_not_published' });
      }
      questionTemplateVersionId = published.id;
    }
    const mch2 = String(body.mch2 || existing.mch2 || '').trim();
    const mch3 = String(body.mch3 || existing.mch3 || '').trim();
    const merchandisingErrors = validateMerchandising(mch2, mch3);
    if (merchandisingErrors.length) {
      throw Object.assign(new Error('merchandising_invalid'), {
        status: 400,
        code: 'validation_failed',
        errors: merchandisingErrors,
      });
    }
    const plannedDate = assertValidDateField(body.planned_date || existing.planned_date, 'planned_date_invalid', true);
    const actualEvaluationDate = assertValidDateField(body.actual_evaluation_date || existing.actual_evaluation_date, 'actual_evaluation_date_invalid');
    const supplierFields = standardSupplierFields(body, supplier, existing);
    if (hasExplicitStandardSupplierField(body)) assertValidSupplierMasterData(supplierFields);
    const existingAssignments = existing.id
      ? this.ticketRepository.participantAssignments(existing.id)
      : { evaluator: '', qaLead: '', qaSupport: [] };
    const canonicalParticipants = participantPayload(body.participants);
    const hasCanonicalParticipants = hasOwnField(body, 'participants');
    const identitiesForRole = (role) => canonicalParticipants
      .filter((row) => row?.participant_role === role)
      .map(participantIdentity)
      .filter(Boolean);
    const evaluator = hasCanonicalParticipants
      ? identitiesForRole('EVALUATOR')[0] || ''
      : String(body.evaluator_name || body.assignee || existingAssignments.evaluator || userEmail).trim();
    const qaLead = hasCanonicalParticipants
      ? identitiesForRole('QA_LEAD')[0] || ''
      : hasOwnField(body, 'qa_lead_id')
        ? String(body.qa_lead_id || '').trim()
        : existingAssignments.qaLead;
    let qaSupport = existingAssignments.qaSupport;
    if (hasCanonicalParticipants) qaSupport = identitiesForRole('QA_SUPPORT');
    else if (hasOwnField(body, 'qa_support_ids')) {
      qaSupport = Array.isArray(body.qa_support_ids)
        ? body.qa_support_ids
        : participantPayload(body.qa_support_ids);
    }
    const owner = String(
      body.assigned_specialist_id || existing.assigned_specialist_id || userEmail,
    ).trim();
    const payload = {
      supplier_id: supplier.id,
      supplier_code: supplier.supplier_code,
      supplier_name: String(body.supplier_name || supplier.supplier_name || '').trim(),
      tax_code: String(body.tax_code || supplier.tax_code || '').trim() || null,
      supplier_address: String(body.address || supplier.address || '').trim() || null,
      production_address: String(body.production_address || existing.production_address || '').trim() || null,
      snapshot_evaluation_address: ticketSnapshotText(
        body, existing, 'snapshot_evaluation_address', 'evaluation_address',
      ) || null,
      linked_facility_code: String(body.linked_facility_code || existing.linked_facility_code || '').trim() || null,
      snapshot_linked_facility_name: ticketSnapshotText(
        body, existing, 'snapshot_linked_facility_name', 'linked_facility_name',
      ) || null,
      snapshot_linked_facility_address: ticketSnapshotText(
        body, existing, 'snapshot_linked_facility_address', 'linked_facility_address',
      ) || null,
      linked_facility_type: String(body.linked_facility_type || existing.linked_facility_type || '').trim() || null,
      region: supplierFields.region || null,
      province: supplierFields.province || null,
      business_type: supplierFields.business_type || null,
      cmc_owner: String(body.cmc_owner || existing.cmc_owner || '').trim() || null,
      cmc_head: String(body.cmc_head || existing.cmc_head || '').trim() || null,
      business_license_file: String(body.business_license_file || existing.business_license_file || '').trim() || null,
      attp_certificate_type: String(body.attp_certificate_type || existing.attp_certificate_type || '').trim() || null,
      attp_certificate_file: String(body.attp_certificate_file || existing.attp_certificate_file || '').trim() || null,
      contact_name: String(body.contact_name || supplier.contact_name || '').trim() || null,
      contact_email: String(body.email || body.contact_email || supplier.contact_email || '').trim() || null,
      contact_phone: String(body.phone || body.contact_phone || supplier.contact_phone || '').trim() || null,
      mch2: mch2 || null,
      mch3: mch3 || null,
      product_group: String(body.product_group || existing.product_group || '').trim() || null,
      snapshot_product_name: String(
        body.snapshot_product_name
        || body.product_name
        || body.products
        || existing.snapshot_product_name
        || existing.product_name
        || ''
      ).trim() || null,
      evaluation_type: String(body.evaluation_type || existing.evaluation_type || '').trim(),
      template_id: templateId,
      question_template_version_id: questionTemplateVersionId,
      facility_type: facilityType,
      supplier_scale: supplierScale,
      evaluation_method: String(body.method || body.evaluation_method || existing.evaluation_method || '').trim() || null,
      participant_assignments: {
        owner,
        evaluator,
        qaLead,
        qaSupport: qaSupport.map((value) => String(value || '').trim()).filter(Boolean),
      },
      evaluation_department: String(body.evaluation_department || existing.evaluation_department || '').trim() || null,
      planned_date: plannedDate,
      actual_evaluation_date: actualEvaluationDate,
      assigned_specialist_id: owner,
      updated_by: userEmail,
    };
    return payload;
  }
}

module.exports = EvaluationTicketService;
