const { WORKFLOW_STATUSES } = require('../domain/workflowHistory');
const EvaluationParticipantRepository = require('./EvaluationParticipantRepository');

class EvaluationTicketRepository {
  constructor(db) {
    this.db = db;
    this.participantRepository = new EvaluationParticipantRepository(db);
    this.listStatementCache = new Map();
    this.previousDefaultsStatementCache = new Map();
    this.statements = {
      nextCodeCount: db.prepare("SELECT COUNT(*) AS n FROM evaluation_tickets WHERE ticket_code LIKE ?"),
      getByCode: db.prepare(`
        SELECT t.*, qt.template_code, qt.template_name,
               qtv.version_no AS question_template_version_no,
               qtv.status AS question_template_version_status,
               qtv.checksum AS question_template_version_checksum
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
        WHERE t.ticket_code = ?
      `),
      getById: db.prepare(`
        SELECT t.*, qt.template_code, qt.template_name,
               qtv.version_no AS question_template_version_no,
               qtv.status AS question_template_version_status,
               qtv.checksum AS question_template_version_checksum
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
        WHERE t.id = ?
      `),
      bootstrapList: db.prepare(`
        SELECT t.*, qt.template_code, qt.template_name,
               qtv.version_no AS question_template_version_no,
               qtv.status AS question_template_version_status,
               qtv.checksum AS question_template_version_checksum
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
        WHERE COALESCE(t.is_deleted, 0) = 0
        ORDER BY t.created_at DESC
        LIMIT 200
      `),
      bootstrapListByCreator: db.prepare(`
        SELECT t.*, qt.template_code, qt.template_name,
               qtv.version_no AS question_template_version_no,
               qtv.status AS question_template_version_status,
               qtv.checksum AS question_template_version_checksum
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
        WHERE COALESCE(t.is_deleted, 0) = 0
          AND lower(COALESCE(t.created_by, '')) = lower(@created_by)
        ORDER BY t.created_at DESC
        LIMIT 200
      `),
      bootstrapListByApprovalLevel: db.prepare(`
        SELECT t.*, qt.template_code, qt.template_name,
               qtv.version_no AS question_template_version_no,
               qtv.status AS question_template_version_status,
               qtv.checksum AS question_template_version_checksum
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
        WHERE COALESCE(t.is_deleted, 0) = 0
          AND EXISTS (
            SELECT 1
            FROM approval_tasks at
            WHERE at.ticket_id = t.id
              AND at.status = 'PENDING'
              AND at.approval_level = @approval_level
          )
        ORDER BY t.created_at DESC
        LIMIT 200
      `),
      insert: db.prepare(`
        INSERT INTO evaluation_tickets (
          ticket_code, supplier_id, supplier_code, supplier_name, tax_code, supplier_address,
          production_address, evaluation_address,
          linked_facility_code, linked_facility_name, linked_facility_address, linked_facility_type,
          region, province, business_type, cmc_owner, cmc_head,
          business_license_file, attp_certificate_type, attp_certificate_file,
          contact_name, contact_email, contact_phone,
          mch2, mch3, product_group, product_name, evaluation_type, template_id, facility_type,
          supplier_scale, question_template_version_id, evaluation_method, evaluator_name, planned_date, current_status,
          current_round_no, assigned_specialist_id, created_by, updated_by
        )
        VALUES (
          @ticket_code, @supplier_id, @supplier_code, @supplier_name, @tax_code, @supplier_address,
          @production_address, @evaluation_address, @linked_facility_code, @linked_facility_name, @linked_facility_address, @linked_facility_type,
          @region, @province, @business_type, @cmc_owner, @cmc_head,
          @business_license_file, @attp_certificate_type, @attp_certificate_file,
          @contact_name, @contact_email, @contact_phone,
          @mch2, @mch3, @product_group, @product_name, @evaluation_type, @template_id, @facility_type,
          @supplier_scale, @question_template_version_id, @evaluation_method, @evaluator_name, @planned_date, @current_status,
          1, @assigned_specialist_id, @created_by, @updated_by
        )
      `),
      updateCreateExtras: db.prepare(`
        UPDATE evaluation_tickets SET
          qa_lead_id=@qa_lead_id,
          qa_support_ids=@qa_support_ids,
          evaluation_department=@evaluation_department,
          actual_evaluation_date=@actual_evaluation_date
        WHERE id=@id
      `),
      updateLegalFileNames: db.prepare(`
        UPDATE evaluation_tickets SET
          business_license_file = COALESCE(@business_license_file, business_license_file),
          attp_certificate_file = COALESCE(@attp_certificate_file, attp_certificate_file)
        WHERE id = @id
      `),
      updateByCode: db.prepare(`
        UPDATE evaluation_tickets SET
          supplier_id=@supplier_id, supplier_code=@supplier_code, supplier_name=@supplier_name,
          tax_code=@tax_code, supplier_address=@supplier_address, production_address=@production_address,
          evaluation_address=@evaluation_address,
          linked_facility_code=@linked_facility_code,
          linked_facility_name=@linked_facility_name,
          linked_facility_address=@linked_facility_address,
          linked_facility_type=@linked_facility_type,
          region=@region,
          province=@province,
          business_type=@business_type,
          cmc_owner=@cmc_owner,
          cmc_head=@cmc_head,
          business_license_file=@business_license_file,
          attp_certificate_type=@attp_certificate_type,
          attp_certificate_file=@attp_certificate_file,
          contact_name=@contact_name, contact_email=@contact_email,
          contact_phone=@contact_phone, mch2=@mch2, mch3=@mch3, product_group=@product_group,
          product_name=@product_name, evaluation_type=@evaluation_type, template_id=@template_id,
          question_template_version_id=@question_template_version_id,
          facility_type=@facility_type, supplier_scale=@supplier_scale, evaluation_method=@evaluation_method,
          evaluator_name=@evaluator_name, qa_lead_id=@qa_lead_id, qa_support_ids=@qa_support_ids,
          evaluation_department=@evaluation_department, planned_date=@planned_date,
          actual_evaluation_date=@actual_evaluation_date,
          assigned_specialist_id=@assigned_specialist_id, updated_at=datetime('now'), updated_by=@updated_by
        WHERE ticket_code=@ticket_code
      `),
      softDelete: db.prepare(`
        UPDATE evaluation_tickets SET
          is_deleted = 1,
          deleted_at = datetime('now'),
          deleted_by = @deleted_by,
          deleted_reason = @deleted_reason,
          updated_at = datetime('now'),
          updated_by = @deleted_by
        WHERE id = @id
      `),
    };
  }

  countTicketsWithCodePrefix(prefix) {
    return this.statements.nextCodeCount.get(`${prefix}-%`)?.n || 0;
  }

  getByCode(code) {
    return this.statements.getByCode.get(code);
  }

  getById(id) {
    return this.statements.getById.get(id);
  }

  getByIdOrCode(identifier) {
    const raw = String(identifier || '').trim();
    const byId = /^\d+$/.test(raw) ? this.getById(parseInt(raw, 10)) : null;
    return byId || this.getByCode(raw);
  }

  listBootstrap(filters = {}) {
    if (filters.approvalLevel) return this.statements.bootstrapListByApprovalLevel.all({ approval_level: filters.approvalLevel });
    if (filters.createdBy) return this.statements.bootstrapListByCreator.all({ created_by: filters.createdBy });
    return this.statements.bootstrapList.all();
  }

  pendingTicketIdsForLevels(levels) {
    const normalized = [...new Set((levels || []).map((level) => String(level).toUpperCase()))];
    if (!normalized.length) return [];
    const placeholders = normalized.map(() => '?').join(',');
    return this.db.prepare(`SELECT DISTINCT ticket_id FROM approval_tasks
      WHERE status = 'PENDING' AND approval_level IN (${placeholders})`).all(...normalized).map((row) => row.ticket_id);
  }

  list({ whereSql, params, limit, offset }) {
    const cacheKey = whereSql || '';
    if (!this.listStatementCache.has(cacheKey)) {
      this.listStatementCache.set(cacheKey, {
        count: this.db.prepare(`SELECT COUNT(*) AS total FROM evaluation_tickets t ${whereSql}`),
        rows: this.db.prepare(`
          SELECT t.*, qt.template_code, qt.template_name,
                 qtv.version_no AS question_template_version_no,
                 qtv.status AS question_template_version_status,
                 qtv.checksum AS question_template_version_checksum
          FROM evaluation_tickets t
          LEFT JOIN question_templates qt ON qt.id = t.template_id
          LEFT JOIN question_template_versions qtv ON qtv.id = t.question_template_version_id
          ${whereSql}
          ORDER BY t.created_at DESC
          LIMIT @limit OFFSET @offset
        `),
      });
    }
    const statements = this.listStatementCache.get(cacheKey);
    const total = statements.count.get(params).total;
    const rows = statements.rows.all({ ...params, limit, offset });
    return { rows, total };
  }

  findPreviousEvaluationDefaults({ supplierId, whereSql, params }) {
    const cacheKey = whereSql || '';
    if (!this.previousDefaultsStatementCache.has(cacheKey)) {
      this.previousDefaultsStatementCache.set(cacheKey, this.db.prepare(`
        SELECT
          t.id AS source_ticket_id,
          t.ticket_code AS source_ticket_code,
          qt.template_code,
          NULLIF(TRIM(t.facility_type), '') AS facility_type,
          NULLIF(TRIM(t.supplier_scale), '') AS supplier_scale,
          COALESCE(date(t.actual_evaluation_date), rounds.assessment_date) AS evaluation_date
        FROM evaluation_tickets t
        LEFT JOIN question_templates qt ON qt.id = t.template_id
        LEFT JOIN (
          SELECT ticket_id, MAX(date(assessment_date)) AS assessment_date
          FROM evaluation_rounds
          WHERE date(assessment_date) IS NOT NULL
          GROUP BY ticket_id
        ) rounds ON rounds.ticket_id = t.id
        WHERE t.supplier_id = @supplier_id
          AND COALESCE(t.is_deleted, 0) = 0
          AND COALESCE(t.current_status, '') != @cancelled_status
          AND COALESCE(date(t.actual_evaluation_date), rounds.assessment_date) IS NOT NULL
          AND (${whereSql})
        ORDER BY COALESCE(date(t.actual_evaluation_date), rounds.assessment_date) DESC, t.id DESC
        LIMIT 1
      `));
    }
    return this.previousDefaultsStatementCache.get(cacheKey).get({
      ...params,
      supplier_id: supplierId,
      cancelled_status: WORKFLOW_STATUSES.CANCELLED,
    }) || null;
  }

  insert(payload) {
    const info = this.statements.insert.run({ current_status: WORKFLOW_STATUSES.DRAFT, ...payload });
    this.participantRepository.syncTicket(info.lastInsertRowid, payload.created_by || payload.updated_by);
    return info;
  }

  updateCreateExtras(payload) {
    const info = this.statements.updateCreateExtras.run(payload);
    this.participantRepository.syncTicket(payload.id, payload.updated_by || payload.created_by);
    return info;
  }

  updateLegalFileNames(payload) {
    return this.statements.updateLegalFileNames.run(payload);
  }

  updateByCode(payload) {
    const info = this.statements.updateByCode.run(payload);
    const ticket = this.statements.getByCode.get(payload.ticket_code);
    if (ticket) this.participantRepository.syncTicket(ticket.id, payload.updated_by);
    return info;
  }

  softDelete(payload) {
    return this.statements.softDelete.run(payload);
  }
}

module.exports = EvaluationTicketRepository;
