'use strict';

const crypto = require('node:crypto');

const VERSION_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  IN_REVIEW: 'IN_REVIEW',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
});

const ITEM_FIELDS = Object.freeze([
  'variant_code', 'facility_type', 'supplier_scale', 'category_code', 'category_label_snapshot',
  'question_code', 'clause_code', 'question_text', 'category',
  'is_elimination_clause', 'is_critical_clause', 'requires_attachment',
  'allowed_scores', 'weight', 'order_index', 'active',
]);
const DRAFT_ITEM_PATCH_FIELDS = Object.freeze([...ITEM_FIELDS]);

function serviceError(code, status = 400, extra = {}) {
  return Object.assign(new Error(code), { code, status, ...extra });
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function boolInt(value) {
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalItem(item, templateCode = '') {
  return {
    template_code: clean(templateCode || item.template_code),
    facility_type: clean(item.facility_type),
    supplier_scale: clean(item.supplier_scale),
    question_code: clean(item.question_code),
    question_text: clean(item.question_text),
    category: clean(item.category),
    is_elimination_clause: boolInt(item.is_elimination_clause),
    is_critical_clause: boolInt(item.is_critical_clause),
    requires_attachment: boolInt(item.is_elimination_clause) ? 0 : boolInt(item.requires_attachment),
    allowed_scores: clean(item.allowed_scores) || (boolInt(item.is_elimination_clause) ? 'A/D/NA' : 'A/B/C/D/NA'),
    weight: Number(item.weight == null ? 1 : item.weight),
    order_index: Number.parseInt(item.order_index == null ? 0 : item.order_index, 10) || 0,
    active: item.active === false || item.active === 0 ? 0 : 1,
  };
}

function canonicalSort(a, b) {
  return [a.template_code, a.facility_type, a.supplier_scale, a.order_index, a.question_code]
    .join('|').localeCompare([b.template_code, b.facility_type, b.supplier_scale, b.order_index, b.question_code].join('|'));
}

function contentHash(rows) {
  return sha256(stableJson(rows.map((row) => canonicalItem(row, row.template_code)).sort(canonicalSort)));
}

function validateItems(items) {
  if (!Array.isArray(items) || !items.length) throw serviceError('question_items_required');
  const seen = new Set();
  return items.map((source) => {
    const item = canonicalItem(source);
    if (!item.facility_type) throw serviceError('facility_type_required');
    if (!['LARGE', 'SMALL', 'ALL'].includes(item.supplier_scale)) throw serviceError('supplier_scale_invalid');
    if (!item.question_code) throw serviceError('question_code_required');
    if (!item.question_text) throw serviceError('question_text_required');
    if (!item.category) throw serviceError('category_required');
    const allowed = item.allowed_scores.split('/').map((value) => value.trim()).filter(Boolean);
    if (!allowed.length || allowed.some((value) => !['A', 'B', 'C', 'D', 'NA'].includes(value))) {
      throw serviceError('allowed_scores_invalid');
    }
    if (item.is_elimination_clause && item.allowed_scores !== 'A/D/NA') {
      throw serviceError('elimination_allowed_scores_must_be_a_d_na');
    }
    const key = `${item.facility_type}|${item.supplier_scale}|${item.question_code}`;
    if (seen.has(key)) throw serviceError('question_item_duplicate', 409, { item_key: key });
    seen.add(key);
    return {
      ...item,
      variant_code: clean(source.variant_code) || null,
      category_code: clean(source.category_code) || null,
      clause_code: clean(source.clause_code) || null,
    };
  });
}

class QuestionVersionService {
  constructor(db, options = {}) {
    this.db = db;
    this.publishEnabledOverride = Object.prototype.hasOwnProperty.call(options, 'publishEnabled')
      ? !!options.publishEnabled
      : null;
  }

  publishEnabled() {
    if (this.publishEnabledOverride != null) return this.publishEnabledOverride;
    return String(process.env.QUESTION_VERSION_PUBLISH_ENABLED || '').trim() === '1';
  }

  assertPublishingEnabled() {
    if (!this.publishEnabled()) throw serviceError('question_version_publish_disabled', 503);
  }

  decorateVersion(row) {
    if (!row) return row;
    const defaultScopeCount = Number(row.default_scope_count || 0);
    const variantCount = Number(row.variant_count || 0);
    const isDefault = defaultScopeCount > 0;
    const isFullyDefault = variantCount > 0 && defaultScopeCount >= variantCount;
    const allowed = ['question_version.preview', 'question_version.validate'];
    const disabled = {};
    if (row.status === VERSION_STATUSES.DRAFT) {
      allowed.push('question_version.save_draft', 'question_version.submit_review', 'question_import.preview');
    } else if (row.status === VERSION_STATUSES.IN_REVIEW) {
      if (this.publishEnabled()) allowed.push('question_version.publish');
      else disabled['question_version.publish'] = 'question_version_publish_disabled';
    } else if (row.status === VERSION_STATUSES.PUBLISHED) {
      allowed.push('question_version.clone_draft');
      if (this.publishEnabled()) {
        if (!isFullyDefault) allowed.push('question_version.rollback_default');
        else disabled['question_version.rollback_default'] = 'already_default';
        if (!isDefault) allowed.push('question_version.retire');
        else disabled['question_version.retire'] = 'default_question_version_cannot_retire';
      }
      else {
        disabled['question_version.rollback_default'] = 'question_version_publish_disabled';
        disabled['question_version.retire'] = 'question_version_publish_disabled';
      }
    } else if (row.status === VERSION_STATUSES.RETIRED) {
      allowed.push('question_version.clone_draft');
      if (this.publishEnabled()) {
        if (!isFullyDefault) allowed.push('question_version.rollback_default');
        else disabled['question_version.rollback_default'] = 'already_default';
      } else disabled['question_version.rollback_default'] = 'question_version_publish_disabled';
    }
    if (row.status !== VERSION_STATUSES.DRAFT) disabled['question_import.preview'] = 'question_version_not_draft';
    return { ...row, is_default: isDefault, allowed_actions: allowed, disabled_reasons: disabled };
  }

  getRow(versionId) {
    return this.db.prepare(`
      SELECT v.*, t.template_code, t.template_name,
        (SELECT COUNT(*) FROM question_template_variants qv
          WHERE qv.question_template_version_id=v.id AND qv.active=1) AS variant_count,
        (SELECT COUNT(*) FROM question_template_assignments qa
          WHERE qa.question_template_version_id=v.id AND qa.active=1 AND qa.is_default=1) AS default_scope_count
      FROM question_template_versions v
      JOIN question_templates t ON t.id = v.template_id
      WHERE v.id = ?
    `).get(Number(versionId));
  }

  list({ templateId } = {}) {
    const where = templateId ? 'WHERE v.template_id = ?' : '';
    return this.db.prepare(`
      SELECT v.*, t.template_code, t.template_name,
             (SELECT COUNT(*) FROM question_items qi WHERE qi.question_template_version_id = v.id) AS item_count,
             (SELECT COUNT(*) FROM question_template_variants qv WHERE qv.question_template_version_id = v.id AND qv.active = 1) AS variant_count,
             (SELECT COUNT(*) FROM question_template_assignments qa WHERE qa.question_template_version_id = v.id AND qa.active = 1 AND qa.is_default = 1) AS default_scope_count
      FROM question_template_versions v
      JOIN question_templates t ON t.id = v.template_id
      ${where}
      ORDER BY t.template_code, v.version_no DESC
    `).all(...(templateId ? [Number(templateId)] : [])).map((row) => this.decorateVersion(row));
  }

  catalog({ search = '', status = '', facilityType = '', supplierScale = '', includeInactive = true } = {}) {
    const where = [];
    const params = {};
    if (!includeInactive) where.push('t.active=1');
    if (clean(search)) {
      where.push('(LOWER(t.template_code) LIKE @search OR LOWER(t.template_name) LIKE @search OR LOWER(COALESCE(t.description, \'\')) LIKE @search)');
      params.search = `%${clean(search).toLowerCase()}%`;
    }
    if (clean(status)) {
      where.push('EXISTS (SELECT 1 FROM question_template_versions sv WHERE sv.template_id=t.id AND sv.status=@status)');
      params.status = clean(status).toUpperCase();
    }
    if (clean(facilityType)) {
      where.push(`EXISTS (
        SELECT 1 FROM question_template_variants sfv
        JOIN question_template_versions sfvv ON sfvv.id=sfv.question_template_version_id
        WHERE sfvv.template_id=t.id AND sfv.facility_type=@facility_type AND sfv.active=1
      )`);
      params.facility_type = clean(facilityType);
    }
    if (clean(supplierScale)) {
      where.push(`EXISTS (
        SELECT 1 FROM question_template_variants ssv
        JOIN question_template_versions ssvv ON ssvv.id=ssv.question_template_version_id
        WHERE ssvv.template_id=t.id AND ssv.supplier_scale=@supplier_scale AND ssv.active=1
      )`);
      params.supplier_scale = clean(supplierScale).toUpperCase();
    }
    const templates = this.db.prepare(`
      SELECT t.* FROM question_templates t
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.active DESC, COALESCE(t.updated_at, t.created_at) DESC, t.template_code
    `).all(params);
    return templates.map((template) => {
      const versions = this.list({ templateId: template.id });
      const matching = params.status ? versions.filter((version) => version.status === params.status) : versions;
      const current = matching[0] || versions[0] || null;
      const defaultRow = this.db.prepare(`
        SELECT v.*, t.template_code, t.template_name,
               (SELECT COUNT(*) FROM question_items qi WHERE qi.question_template_version_id=v.id) AS item_count,
               (SELECT COUNT(*) FROM question_template_variants qv WHERE qv.question_template_version_id=v.id AND qv.active=1) AS variant_count,
               (SELECT COUNT(*) FROM question_template_assignments qa WHERE qa.question_template_version_id=v.id AND qa.active=1 AND qa.is_default=1) AS default_scope_count
        FROM question_template_versions v
        JOIN question_templates t ON t.id=v.template_id
        WHERE v.id=(
          SELECT a.question_template_version_id FROM question_template_assignments a
          WHERE a.template_id=t.id AND a.active=1 AND a.is_default=1
          ORDER BY a.id DESC LIMIT 1
        ) AND t.id=?
      `).get(template.id);
      const defaultVersion = this.decorateVersion(defaultRow || null);
      const ticketPins = current ? this.db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets WHERE question_template_version_id=?').get(current.id).n : 0;
      const warnings = [];
      if (!versions.length) warnings.push('missing_version');
      if (!defaultVersion) warnings.push('missing_default_published_version');
      if (current?.status === VERSION_STATUSES.DRAFT && Number(current.item_count || 0) === 0) warnings.push('draft_has_no_questions');
      if (current?.status === VERSION_STATUSES.IN_REVIEW && !this.publishEnabled()) warnings.push('publishing_disabled');
      return {
        ...template,
        active: !!template.active,
        current_version: current,
        default_version: defaultVersion,
        version_count: versions.length,
        question_count: Number(current?.item_count || 0),
        variant_count: Number(current?.variant_count || 0),
        ticket_pin_count: Number(ticketPins || 0),
        warnings,
        updated_at: current?.updated_at || current?.created_at || template.updated_at || template.created_at,
      };
    });
  }

  createTemplateWithDraft({ templateCode, templateName, description = null, active = true, actor = null, context = {} }) {
    const code = clean(templateCode).toUpperCase();
    const name = clean(templateName);
    if (!code || !name) throw serviceError('template_code_and_name_required');
    return this.db.transaction(() => {
      let info;
      try {
        info = this.db.prepare(`
          INSERT INTO question_templates (template_code, template_name, description, active)
          VALUES (?, ?, ?, ?)
        `).run(code, name, clean(description) || null, active === false ? 0 : 1);
      } catch (error) {
        throw serviceError('template_code_exists', 409);
      }
      const templateId = Number(info.lastInsertRowid);
      const draft = this.createDraft({ templateId, note: 'Bản nháp khởi tạo', actor, context });
      return this.catalog({ search: code, includeInactive: true }).find((item) => item.id === templateId)
        || { ...this.db.prepare('SELECT * FROM question_templates WHERE id=?').get(templateId), current_version: this.decorateVersion(draft) };
    })();
  }

  get(versionId) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    return {
      ...this.decorateVersion(row),
      items: this.db.prepare(`
        SELECT * FROM question_items
        WHERE question_template_version_id = ?
        ORDER BY facility_type, supplier_scale, order_index, question_code
      `).all(row.id),
      variants: this.db.prepare(`
        SELECT * FROM question_template_variants
        WHERE question_template_version_id = ?
        ORDER BY facility_type, supplier_scale
      `).all(row.id),
      assignments: this.db.prepare(`
        SELECT * FROM question_template_assignments
        WHERE question_template_version_id = ?
        ORDER BY facility_type, supplier_scale
      `).all(row.id),
      events: this.db.prepare(`
        SELECT * FROM question_template_version_events
        WHERE question_template_version_id = ?
        ORDER BY id
      `).all(row.id),
    };
  }

  validate(versionId) {
    const version = this.get(versionId);
    const errors = [];
    const warnings = [];
    let checksum = null;

    try {
      const normalized = validateItems(version.items);
      checksum = contentHash(normalized.map((item) => ({ ...item, template_code: version.template_code })));
    } catch (error) {
      errors.push(error.code || 'question_items_invalid');
    }

    if (!version.variants.some((variant) => Number(variant.active) === 1)) {
      warnings.push('question_variants_missing');
    }
    if (version.effective_from && version.effective_to && version.effective_to <= version.effective_from) {
      errors.push('effective_window_invalid');
    }

    const ticketPins = this.db.prepare(`
      SELECT COUNT(*) AS n FROM evaluation_tickets WHERE question_template_version_id=?
    `).get(version.id).n;
    const activeScopes = version.assignments.filter((assignment) => Number(assignment.active) === 1);
    return {
      version_id: version.id,
      status: version.status,
      valid: errors.length === 0,
      error_count: errors.length,
      warning_count: warnings.length,
      errors,
      warnings,
      item_count: version.items.length,
      active_item_count: version.items.filter((item) => Number(item.active) === 1).length,
      variant_count: version.variants.filter((variant) => Number(variant.active) === 1).length,
      scope_count: activeScopes.length,
      ticket_pin_count: Number(ticketPins || 0),
      checksum,
    };
  }

  assertLock(row, expectedLockVersion) {
    if (expectedLockVersion == null || expectedLockVersion === '') throw serviceError('lock_version_required');
    if (Number(expectedLockVersion) !== Number(row.lock_version)) {
      throw serviceError('question_version_conflict', 409, { current_lock_version: row.lock_version });
    }
  }

  event(versionId, action, actor, before, after, context = {}) {
    this.db.prepare(`
      INSERT INTO question_template_version_events (
        question_template_version_id, action, actor_user_id, before_json, after_json,
        request_id, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      action,
      actor || null,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      context.requestId || null,
      context.correlationId || context.requestId || null
    );
  }

  createDraft({ templateId, cloneFromVersionId = null, note = null, effectiveFrom = null, effectiveTo = null, actor = null, context = {} }) {
    const template = this.db.prepare('SELECT * FROM question_templates WHERE id = ?').get(Number(templateId));
    if (!template) throw serviceError('template_not_found', 404);
    return this.db.transaction(() => {
      const next = this.db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM question_template_versions WHERE template_id = ?').get(template.id).n;
      let source = null;
      if (cloneFromVersionId) {
        source = this.get(Number(cloneFromVersionId));
        if (source.template_id !== template.id) throw serviceError('clone_source_template_mismatch');
      }
      const info = this.db.prepare(`
        INSERT INTO question_template_versions (
          template_id, version_no, status, version_note, effective_from, effective_to,
          lock_version, created_by, updated_by
        ) VALUES (?, ?, 'DRAFT', ?, ?, ?, 1, ?, ?)
      `).run(
        template.id,
        next,
        clean(note) || null,
        effectiveFrom || source?.effective_from || null,
        effectiveTo || source?.effective_to || null,
        actor,
        actor
      );
      const versionId = Number(info.lastInsertRowid);
      if (source) {
        const insertItem = this.db.prepare(`
          INSERT INTO question_items (
            question_template_version_id, variant_code, facility_type, supplier_scale,
            category_code, category_label_snapshot, question_code, clause_code, question_text, category, is_elimination_clause, is_critical_clause,
            requires_attachment, allowed_scores, weight, order_index, active
          ) VALUES (@version_id, @variant_code, @facility_type, @supplier_scale,
            @category_code, @category, @question_code, @clause_code, @question_text, @category, @is_elimination_clause, @is_critical_clause,
            @requires_attachment, @allowed_scores, @weight, @order_index, @active)
        `);
        source.items.forEach((item) => insertItem.run({ ...item, version_id: versionId }));
        const insertVariant = this.db.prepare(`
          INSERT INTO question_template_variants (
            question_template_version_id, facility_type, supplier_scale, source_sheet, active
          ) VALUES (?, ?, ?, ?, ?)
        `);
        source.variants.forEach((variant) => insertVariant.run(
          versionId, variant.facility_type, variant.supplier_scale, variant.source_sheet, variant.active
        ));
      }
      const created = this.getRow(versionId);
      this.event(versionId, source ? 'CLONED_DRAFT' : 'CREATED_DRAFT', actor, null, created, context);
      return created;
    })();
  }

  replaceDraftItems(versionId, items) {
    const normalized = validateItems(items);
    this.db.prepare('DELETE FROM question_items WHERE question_template_version_id = ?').run(versionId);
    this.db.prepare('DELETE FROM question_template_variants WHERE question_template_version_id = ?').run(versionId);
    const insertItem = this.db.prepare(`
      INSERT INTO question_items (
        question_template_version_id, variant_code, facility_type, supplier_scale,
        category_code, category_label_snapshot, question_code, clause_code, question_text, category, is_elimination_clause, is_critical_clause,
        requires_attachment, allowed_scores, weight, order_index, active
      ) VALUES (@version_id, @variant_code, @facility_type, @supplier_scale,
        @category_code, @category, @question_code, @clause_code, @question_text, @category, @is_elimination_clause, @is_critical_clause,
        @requires_attachment, @allowed_scores, @weight, @order_index, @active)
    `);
    normalized.forEach((item) => insertItem.run({ ...item, version_id: versionId }));
    const variants = new Map();
    normalized.forEach((item) => {
      const key = `${item.facility_type}|${item.supplier_scale}`;
      variants.set(key, {
        facility_type: item.facility_type,
        supplier_scale: item.supplier_scale,
        active: Math.max(variants.get(key)?.active || 0, item.active),
      });
    });
    const insertVariant = this.db.prepare(`
      INSERT INTO question_template_variants (
        question_template_version_id, facility_type, supplier_scale, active
      ) VALUES (?, ?, ?, ?)
    `);
    variants.forEach((variant) => insertVariant.run(versionId, variant.facility_type, variant.supplier_scale, variant.active));
  }

  updateDraft({ versionId, expectedLockVersion, note, effectiveFrom, effectiveTo, items, actor = null, context = {} }) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (row.status !== VERSION_STATUSES.DRAFT) {
      throw serviceError(row.status === VERSION_STATUSES.PUBLISHED || row.status === VERSION_STATUSES.RETIRED
        ? 'published_version_immutable' : 'question_version_not_draft', 409);
    }
    this.assertLock(row, expectedLockVersion);
    return this.db.transaction(() => {
      if (items !== undefined) this.replaceDraftItems(row.id, items);
      const nextNote = note === undefined ? row.version_note : (clean(note) || null);
      const nextFrom = effectiveFrom === undefined ? row.effective_from : (effectiveFrom || null);
      const nextTo = effectiveTo === undefined ? row.effective_to : (effectiveTo || null);
      if (nextFrom && nextTo && nextTo <= nextFrom) throw serviceError('effective_window_invalid');
      const result = this.db.prepare(`
        UPDATE question_template_versions
        SET version_note=?, effective_from=?, effective_to=?, checksum=NULL,
            lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='DRAFT' AND lock_version=?
      `).run(nextNote, nextFrom, nextTo, actor, row.id, row.lock_version);
      if (result.changes !== 1) throw serviceError('question_version_conflict', 409);
      const updated = this.getRow(row.id);
      this.event(row.id, 'UPDATED_DRAFT', actor, row, updated, context);
      return updated;
    })();
  }

  patchDraftItems({ versionId, expectedLockVersion, updates = [], additions = [], actor = null, context = {} }) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (row.status !== VERSION_STATUSES.DRAFT) {
      throw serviceError(row.status === VERSION_STATUSES.PUBLISHED || row.status === VERSION_STATUSES.RETIRED
        ? 'published_version_immutable' : 'question_version_not_draft', 409);
    }
    this.assertLock(row, expectedLockVersion);
    if (!Array.isArray(updates) || !Array.isArray(additions) || (!updates.length && !additions.length)) {
      throw serviceError('question_item_delta_required');
    }

    const items = this.get(row.id).items.map((item) => ({ ...item }));
    const indexes = new Map(items.map((item, index) => [String(item.id), index]));
    const seen = new Set();
    updates.forEach((source) => {
      const key = String(source?.id || '');
      if (!key || !indexes.has(key)) throw serviceError('question_item_not_found', 404);
      if (seen.has(key)) throw serviceError('question_item_patch_duplicate');
      seen.add(key);
      const patch = {};
      DRAFT_ITEM_PATCH_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(source, field)) patch[field] = source[field];
      });
      items[indexes.get(key)] = { ...items[indexes.get(key)], ...patch };
    });
    additions.forEach((source) => {
      const addition = {};
      DRAFT_ITEM_PATCH_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(source || {}, field)) addition[field] = source[field];
      });
      items.push(addition);
    });

    const normalized = validateItems(items);

    return this.db.transaction(() => {
      const updateItem = this.db.prepare(`
        UPDATE question_items SET
          variant_code=@variant_code, facility_type=@facility_type, supplier_scale=@supplier_scale,
          category_code=@category_code, category_label_snapshot=@category,
          question_code=@question_code, clause_code=@clause_code, question_text=@question_text,
          category=@category, is_elimination_clause=@is_elimination_clause,
          is_critical_clause=@is_critical_clause, requires_attachment=@requires_attachment,
          allowed_scores=@allowed_scores, weight=@weight, order_index=@order_index, active=@active
        WHERE id=@id AND question_template_version_id=@version_id
      `);
      seen.forEach((id) => {
        const index = indexes.get(id);
        const result = updateItem.run({ ...normalized[index], id: Number(id), version_id: row.id });
        if (result.changes !== 1) throw serviceError('question_item_not_found', 404);
      });

      const insertItem = this.db.prepare(`
        INSERT INTO question_items (
          question_template_version_id, variant_code, facility_type, supplier_scale,
          category_code, category_label_snapshot, question_code, clause_code, question_text, category,
          is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
          weight, order_index, active
        ) VALUES (@version_id, @variant_code, @facility_type, @supplier_scale,
          @category_code, @category, @question_code, @clause_code, @question_text, @category,
          @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
          @weight, @order_index, @active)
      `);
      normalized.slice(indexes.size).forEach((item) => insertItem.run({ ...item, version_id: row.id }));

      this.db.prepare('DELETE FROM question_template_variants WHERE question_template_version_id=?').run(row.id);
      const insertVariant = this.db.prepare(`INSERT INTO question_template_variants
        (question_template_version_id, facility_type, supplier_scale, active) VALUES (?, ?, ?, ?)`);
      const variants = new Map();
      normalized.forEach((item) => {
        const key = `${item.facility_type}|${item.supplier_scale}`;
        variants.set(key, Math.max(variants.get(key) || 0, item.active));
      });
      variants.forEach((active, key) => {
        const [facilityType, supplierScale] = key.split('|');
        insertVariant.run(row.id, facilityType, supplierScale, active);
      });
      const result = this.db.prepare(`
        UPDATE question_template_versions
        SET checksum=NULL, lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='DRAFT' AND lock_version=?
      `).run(actor, row.id, row.lock_version);
      if (result.changes !== 1) throw serviceError('question_version_conflict', 409);
      const updated = this.getRow(row.id);
      this.event(row.id, 'UPDATED_DRAFT_ITEMS', actor,
        { version: row, updated_item_ids: [...seen] },
        { version: updated, updated_count: updates.length, added_count: additions.length }, context);
      return updated;
    })();
  }

  checksumForVersion(versionId) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    const items = this.db.prepare(`
      SELECT ?, facility_type, supplier_scale, question_code, question_text, category,
             is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
             weight, order_index, active
      FROM question_items WHERE question_template_version_id=?
    `).all(row.template_code, row.id).map((item) => ({ ...item, template_code: row.template_code }));
    return contentHash(items);
  }

  submit({ versionId, expectedLockVersion, actor = null, context = {} }) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (row.status !== VERSION_STATUSES.DRAFT) throw serviceError('question_version_not_draft', 409);
    this.assertLock(row, expectedLockVersion);
    return this.db.transaction(() => {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM question_items WHERE question_template_version_id=? AND active=1').get(row.id).n;
      if (!count) throw serviceError('question_items_required');
      const checksum = this.checksumForVersion(row.id);
      const result = this.db.prepare(`
        UPDATE question_template_versions
        SET status='IN_REVIEW', checksum=?, submitted_at=datetime('now'), submitted_by=?,
            lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='DRAFT' AND lock_version=?
      `).run(checksum, actor, actor, row.id, row.lock_version);
      if (result.changes !== 1) throw serviceError('question_version_conflict', 409);
      const submitted = this.getRow(row.id);
      this.event(row.id, 'SUBMITTED', actor, row, submitted, context);
      return submitted;
    })();
  }

  activateAssignments(version, actor) {
    const variants = this.db.prepare(`
      SELECT facility_type, supplier_scale
      FROM question_template_variants
      WHERE question_template_version_id=? AND active=1
      ORDER BY facility_type, supplier_scale
    `).all(version.id);
    if (!variants.length) throw serviceError('question_variants_required');
    const unset = this.db.prepare(`
      UPDATE question_template_assignments
      SET is_default=0, updated_at=datetime('now'), updated_by=?
      WHERE template_id=? AND facility_type=? AND supplier_scale=? AND active=1 AND is_default=1
    `);
    const upsert = this.db.prepare(`
      INSERT INTO question_template_assignments (
        template_id, question_template_version_id, facility_type, supplier_scale,
        effective_from, effective_to, is_default, active, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(question_template_version_id, facility_type, supplier_scale) DO UPDATE SET
        effective_from=excluded.effective_from, effective_to=excluded.effective_to,
        is_default=1, active=1, updated_at=datetime('now'), updated_by=excluded.updated_by
    `);
    variants.forEach((variant) => {
      unset.run(actor, version.template_id, variant.facility_type, variant.supplier_scale);
      upsert.run(
        version.template_id, version.id, variant.facility_type, variant.supplier_scale,
        version.effective_from, version.effective_to, actor, actor
      );
    });
  }

  publish({ versionId, expectedLockVersion, actor = null, context = {} }) {
    this.assertPublishingEnabled();
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (row.status !== VERSION_STATUSES.IN_REVIEW) throw serviceError('question_version_not_in_review', 409);
    this.assertLock(row, expectedLockVersion);
    return this.db.transaction(() => {
      const checksum = this.checksumForVersion(row.id);
      if (checksum !== row.checksum) throw serviceError('question_version_checksum_mismatch', 409);
      const result = this.db.prepare(`
        UPDATE question_template_versions
        SET status='PUBLISHED', published_at=datetime('now'), published_by=?,
            retired_at=NULL, retired_by=NULL, lock_version=lock_version+1,
            updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='IN_REVIEW' AND lock_version=?
      `).run(actor, actor, row.id, row.lock_version);
      if (result.changes !== 1) throw serviceError('question_version_conflict', 409);
      const published = this.getRow(row.id);
      this.activateAssignments(published, actor);
      this.event(row.id, 'PUBLISHED', actor, row, published, context);
      return published;
    })();
  }

  retire({ versionId, expectedLockVersion, actor = null, context = {} }) {
    this.assertPublishingEnabled();
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (row.status !== VERSION_STATUSES.PUBLISHED) throw serviceError('question_version_not_published', 409);
    this.assertLock(row, expectedLockVersion);
    const isDefault = this.db.prepare(`
      SELECT COUNT(*) AS n FROM question_template_assignments
      WHERE question_template_version_id=? AND active=1 AND is_default=1
    `).get(row.id).n;
    if (isDefault) throw serviceError('default_question_version_cannot_retire', 409);
    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE question_template_versions
        SET status='RETIRED', retired_at=datetime('now'), retired_by=?,
            lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='PUBLISHED' AND lock_version=?
      `).run(actor, actor, row.id, row.lock_version);
      this.db.prepare(`
        UPDATE question_template_assignments
        SET active=0, is_default=0, updated_at=datetime('now'), updated_by=?
        WHERE question_template_version_id=?
      `).run(actor, row.id);
      const retired = this.getRow(row.id);
      this.event(row.id, 'RETIRED', actor, row, retired, context);
      return retired;
    })();
  }

  rollback({ versionId, expectedLockVersion, actor = null, context = {} }) {
    this.assertPublishingEnabled();
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    if (![VERSION_STATUSES.PUBLISHED, VERSION_STATUSES.RETIRED].includes(row.status)) {
      throw serviceError('rollback_version_not_published', 409);
    }
    this.assertLock(row, expectedLockVersion);
    return this.db.transaction(() => {
      if (row.status === VERSION_STATUSES.RETIRED) {
        this.db.prepare(`
          UPDATE question_template_versions
          SET status='PUBLISHED', retired_at=NULL, retired_by=NULL,
              published_at=datetime('now'), published_by=?, lock_version=lock_version+1,
              updated_at=datetime('now'), updated_by=?
          WHERE id=? AND status='RETIRED' AND lock_version=?
        `).run(actor, actor, row.id, row.lock_version);
      } else {
        this.db.prepare(`
          UPDATE question_template_versions
          SET lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
          WHERE id=? AND status='PUBLISHED' AND lock_version=?
        `).run(actor, row.id, row.lock_version);
      }
      const current = this.getRow(row.id);
      this.activateAssignments(current, actor);
      const rolledBack = this.getRow(row.id);
      this.event(row.id, 'DEFAULT_ROLLED_BACK', actor, row, rolledBack, context);
      return rolledBack;
    })();
  }

  resolvePublished({ templateId, facilityType, supplierScale, at = null }) {
    const effectiveAt = clean(at) || new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT v.*, t.template_code, t.template_name
      FROM question_template_assignments a
      JOIN question_template_versions v ON v.id = a.question_template_version_id
      JOIN question_templates t ON t.id = v.template_id
      WHERE a.template_id=@template_id
        AND a.facility_type=@facility_type
        AND a.supplier_scale=@supplier_scale
        AND a.active=1 AND a.is_default=1 AND v.status='PUBLISHED'
        AND (a.effective_from IS NULL OR date(a.effective_from) <= date(@effective_at))
        AND (a.effective_to IS NULL OR date(a.effective_to) > date(@effective_at))
      ORDER BY v.version_no DESC
      LIMIT 1
    `).get({
      template_id: Number(templateId),
      facility_type: clean(facilityType),
      supplier_scale: clean(supplierScale),
      effective_at: effectiveAt,
    }) || null;
  }

  questionsForVersion(versionId, { facilityType = null, supplierScale = null, includeInactive = false } = {}) {
    const version = this.getRow(versionId);
    if (!version) throw serviceError('question_version_not_found', 404);
    const where = ['qi.question_template_version_id=@version_id'];
    const params = { version_id: version.id };
    if (facilityType) { where.push('qi.facility_type=@facility_type'); params.facility_type = clean(facilityType); }
    if (supplierScale) { where.push('qi.supplier_scale=@supplier_scale'); params.supplier_scale = clean(supplierScale); }
    if (!includeInactive) where.push('qi.active=1');
    return this.db.prepare(`
      SELECT qi.*, v.template_id, t.template_code, v.version_no, v.status AS version_status,
             v.checksum AS version_checksum
      FROM question_items qi
      JOIN question_template_versions v ON v.id = qi.question_template_version_id
      JOIN question_templates t ON t.id = v.template_id
      WHERE ${where.join(' AND ')}
      ORDER BY qi.facility_type, qi.supplier_scale, qi.order_index, qi.question_code
    `).all(params);
  }

  ensureTicketPinned(ticket) {
    if (!ticket) return null;
    if (ticket.question_template_version_id) return ticket;
    const resolved = this.resolvePublished({
      templateId: ticket.template_id,
      facilityType: ticket.facility_type,
      supplierScale: ticket.supplier_scale,
      at: ticket.created_at ? String(ticket.created_at).slice(0, 10) : null,
    });
    if (!resolved) throw serviceError('question_version_not_published', 409);
    this.db.prepare(`
      UPDATE evaluation_tickets
      SET question_template_version_id=?
      WHERE id=? AND question_template_version_id IS NULL
    `).run(resolved.id, ticket.id);
    return this.db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(ticket.id);
  }

  questionsForTicket(ticket, { includeInactive = false } = {}) {
    const pinned = this.ensureTicketPinned(ticket);
    const items = this.questionsForVersion(pinned.question_template_version_id, {
      facilityType: pinned.facility_type,
      supplierScale: pinned.supplier_scale,
      includeInactive,
    });
    return items.map((item) => ({
      ...item,
      db_id: item.id,
      version_item_id: item.id,
      question_template_version_id: pinned.question_template_version_id,
    }));
  }

  ticketQuestionHash(ticketId) {
    const ticket = this.db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(Number(ticketId));
    if (!ticket) throw serviceError('ticket_not_found', 404);
    const pinned = this.ensureTicketPinned(ticket);
    const version = this.getRow(pinned.question_template_version_id);
    return sha256(stableJson({
      ticket_id: pinned.id,
      version_id: version.id,
      checksum: version.checksum,
      facility_type: pinned.facility_type,
      supplier_scale: pinned.supplier_scale,
    }));
  }

  diff(versionId, againstVersionId) {
    const current = this.get(Number(versionId));
    const against = this.get(Number(againstVersionId));
    if (current.template_id !== against.template_id) throw serviceError('diff_template_mismatch');
    const key = (item) => `${item.facility_type}|${item.supplier_scale}|${item.question_code}`;
    const before = new Map(against.items.map((item) => [key(item), item]));
    const after = new Map(current.items.map((item) => [key(item), item]));
    const added = [];
    const removed = [];
    const changed = [];
    after.forEach((item, itemKey) => {
      if (!before.has(itemKey)) added.push(itemKey);
      else {
        const oldItem = before.get(itemKey);
        const oldComparable = Object.fromEntries(ITEM_FIELDS.map((field) => [field, oldItem[field]]));
        const newComparable = Object.fromEntries(ITEM_FIELDS.map((field) => [field, item[field]]));
        if (stableJson(oldComparable) !== stableJson(newComparable)) changed.push({ key: itemKey, before: oldComparable, after: newComparable });
      }
    });
    before.forEach((_item, itemKey) => { if (!after.has(itemKey)) removed.push(itemKey); });
    return { from_version_id: against.id, to_version_id: current.id, added, removed, changed };
  }

  impact(versionId) {
    const row = this.getRow(versionId);
    if (!row) throw serviceError('question_version_not_found', 404);
    return {
      version_id: row.id,
      ticket_count: this.db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets WHERE question_template_version_id=?').get(row.id).n,
      round_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM evaluation_rounds r
        JOIN evaluation_tickets t ON t.id=r.ticket_id
        WHERE t.question_template_version_id=?
      `).get(row.id).n,
      answer_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM evaluation_answers a
        JOIN evaluation_rounds r ON r.id=a.round_id
        JOIN evaluation_tickets t ON t.id=r.ticket_id
        WHERE t.question_template_version_id=?
      `).get(row.id).n,
      default_scope_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM question_template_assignments
        WHERE question_template_version_id=? AND active=1 AND is_default=1
      `).get(row.id).n,
    };
  }

  ensureCanonicalV1() {
    const templates = this.db.prepare('SELECT * FROM question_templates ORDER BY template_code').all();
    this.db.transaction(() => {
      templates.forEach((template) => {
        let version = this.db.prepare(`
          SELECT * FROM question_template_versions WHERE template_id=? AND version_no=1
        `).get(template.id);
        if (!version) return;
        if (version.checksum === '0000000000000000000000000000000000000000000000000000000000000000') {
          this.db.prepare('UPDATE question_template_versions SET checksum=? WHERE id=?').run(this.checksumForVersion(version.id), version.id);
          version = this.getRow(version.id);
        }
        const variants = this.db.prepare(`
          SELECT facility_type, supplier_scale FROM question_template_variants
          WHERE question_template_version_id=? AND active=1
        `).all(version.id);
        variants.forEach((variant) => {
          const existingDefault = this.db.prepare(`
            SELECT id FROM question_template_assignments
            WHERE template_id=? AND facility_type=? AND supplier_scale=? AND active=1 AND is_default=1
          `).get(template.id, variant.facility_type, variant.supplier_scale);
          if (!existingDefault) {
            this.db.prepare(`
              INSERT INTO question_template_assignments (
                template_id, question_template_version_id, facility_type, supplier_scale,
                effective_from, is_default, active, created_by
              ) VALUES (?, ?, ?, ?, '1970-01-01', 1, 1, 'compatibility')
              ON CONFLICT(question_template_version_id, facility_type, supplier_scale) DO UPDATE SET
                is_default=1, active=1, updated_at=datetime('now'), updated_by='compatibility'
            `).run(template.id, version.id, variant.facility_type, variant.supplier_scale);
          }
        });
      });
      this.db.prepare(`
        UPDATE evaluation_tickets
        SET question_template_version_id=(
          SELECT v.id FROM question_template_versions v
          WHERE v.template_id=evaluation_tickets.template_id AND v.version_no=1
        )
        WHERE question_template_version_id IS NULL
          AND UPPER(COALESCE(source_kind, 'NATIVE')) = 'NATIVE'
      `).run();
    })();
    return this.reconcile();
  }

  reconcile() {
    const source = this.db.prepare(`
      SELECT t.template_code, baseline.*
      FROM question_items baseline
      JOIN question_template_versions v ON v.id=baseline.question_template_version_id AND v.version_no=1
      JOIN question_templates t ON t.id=v.template_id
      ORDER BY t.template_code, baseline.facility_type, baseline.supplier_scale, baseline.order_index, baseline.question_code
    `).all();
    const versioned = this.db.prepare(`
      SELECT t.template_code, qi.*
      FROM question_items qi
      JOIN question_template_versions v ON v.id=qi.question_template_version_id AND v.version_no=1
      JOIN question_templates t ON t.id=v.template_id
      ORDER BY t.template_code, qi.facility_type, qi.supplier_scale, qi.order_index, qi.question_code
    `).all();
    const sourceHash = contentHash(source);
    const versionedHash = contentHash(versioned);
    const counts = {
      source_template_count: this.db.prepare('SELECT COUNT(*) AS n FROM question_template_versions WHERE version_no=1').get().n,
      source_question_count: source.length,
      versioned_template_count: this.db.prepare('SELECT COUNT(*) AS n FROM question_template_versions WHERE version_no=1').get().n,
      versioned_item_count: versioned.length,
      pinned_ticket_count: this.db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets WHERE question_template_version_id IS NOT NULL').get().n,
      orphan_ticket_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM evaluation_tickets t
        LEFT JOIN question_template_versions v ON v.id=t.question_template_version_id
        WHERE UPPER(COALESCE(t.source_kind, 'NATIVE')) = 'NATIVE'
          AND (t.question_template_version_id IS NULL OR v.id IS NULL)
      `).get().n,
      orphan_answer_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM evaluation_answers a
        LEFT JOIN question_items qi ON qi.id=a.question_item_id WHERE qi.id IS NULL
      `).get().n,
      unexpected_duplicate_count: this.db.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT question_template_version_id, facility_type, supplier_scale, question_code
          FROM question_items GROUP BY question_template_version_id, facility_type, supplier_scale, question_code
          HAVING COUNT(*) > 1
        )
      `).get().n,
    };
    const status = sourceHash === versionedHash
      && counts.source_template_count === counts.versioned_template_count
      && counts.source_question_count === counts.versioned_item_count
      && counts.orphan_ticket_count === 0
      && counts.orphan_answer_count === 0
      && counts.unexpected_duplicate_count === 0
      ? 'CLEAN' : 'FAILED';
    const info = this.db.prepare(`
      INSERT INTO question_version_reconciliations (
        migration_id, source_template_count, source_question_count,
        versioned_template_count, versioned_item_count, pinned_ticket_count,
        orphan_ticket_count, orphan_answer_count, unexpected_duplicate_count,
        source_hash, versioned_hash, status
      ) VALUES (
        '0008_question_template_versions', @source_template_count, @source_question_count,
        @versioned_template_count, @versioned_item_count, @pinned_ticket_count,
        @orphan_ticket_count, @orphan_answer_count, @unexpected_duplicate_count,
        @source_hash, @versioned_hash, @status
      )
    `).run({ ...counts, source_hash: sourceHash, versioned_hash: versionedHash, status });
    return this.db.prepare('SELECT * FROM question_version_reconciliations WHERE id=?').get(info.lastInsertRowid);
  }
}

module.exports = {
  VERSION_STATUSES,
  QuestionVersionService,
  contentHash,
};
