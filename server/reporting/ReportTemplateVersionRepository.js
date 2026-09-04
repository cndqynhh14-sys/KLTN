'use strict';

const { listDefinitions, getDefinition } = require('./definitionCatalog');
const { validateComponentTree } = require('./componentRegistry');
const { checksum, parseJson, reportError, stableJson } = require('./reportUtils');
const { resolveUserId } = require('../domain/userIdentity');

const VERSION_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  IN_REVIEW: 'IN_REVIEW',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

class ReportTemplateVersionRepository {
  constructor(db) {
    this.db = db;
  }

  ensureCanonicalDefinitions() {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='report_definitions'").get();
    if (!table) return { definitions: 0, versions: 0 };
    const upsertDefinition = this.db.prepare(`
      INSERT INTO report_definitions (
        definition_code, display_name, description, allowed_rounds_json,
        data_contract_version, component_schema_version, active
      ) VALUES (?, ?, ?, ?, 1, 1, 1)
      ON CONFLICT(definition_code) DO UPDATE SET
        display_name=excluded.display_name,
        description=excluded.description,
        allowed_rounds_json=excluded.allowed_rounds_json,
        data_contract_version=excluded.data_contract_version,
        component_schema_version=excluded.component_schema_version,
        active=1,
        updated_at=datetime('now')
    `);
    const hasVersion = this.db.prepare('SELECT COUNT(*) AS n FROM report_template_versions WHERE definition_code=?');
    const insertVersion = this.db.prepare(`
      INSERT INTO report_template_versions (
        definition_code, version_no, version_name, status, definition_json,
        schema_version, checksum, version_note, effective_from,
        lock_version, published_at
      ) VALUES (?, 1, ?, 'PUBLISHED', ?, 1, ?, 'Canonical seed v1', '1970-01-01', 0, datetime('now'))
    `);
    const insertAssignment = this.db.prepare(`
      INSERT INTO report_template_assignments (
        definition_code, report_template_version_id, scope_type, scope_key,
        effective_from, is_default, active
      ) VALUES (?, ?, 'GLOBAL', '*', '1970-01-01', 1, 1)
    `);
    let versions = 0;
    this.db.transaction(() => {
      listDefinitions().forEach((definition) => {
        const tree = definition.validateTree(validateComponentTree(definition.componentTree));
        upsertDefinition.run(
          definition.code,
          definition.label,
          definition.description,
          JSON.stringify(definition.allowedRounds)
        );
        if (hasVersion.get(definition.code).n) return;
        const json = stableJson(tree);
        const info = insertVersion.run(
          definition.code,
          `${definition.label} v1`,
          json,
          checksum(tree)
        );
        insertAssignment.run(definition.code, Number(info.lastInsertRowid));
        versions += 1;
      });
    })();
    return { definitions: listDefinitions().length, versions };
  }

  listDefinitions() {
    return this.db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM report_template_versions v WHERE v.definition_code=d.definition_code) AS version_count,
        (SELECT v.id FROM report_template_versions v WHERE v.definition_code=d.definition_code
          ORDER BY v.version_no DESC LIMIT 1) AS latest_version_id,
        (SELECT v.version_no FROM report_template_versions v WHERE v.definition_code=d.definition_code
          ORDER BY v.version_no DESC LIMIT 1) AS latest_version_no,
        (SELECT v.version_name FROM report_template_versions v WHERE v.definition_code=d.definition_code
          ORDER BY v.version_no DESC LIMIT 1) AS latest_version_name,
        (SELECT v.status FROM report_template_versions v WHERE v.definition_code=d.definition_code
          ORDER BY v.version_no DESC LIMIT 1) AS latest_status,
        (SELECT COALESCE(v.updated_at, v.created_at) FROM report_template_versions v WHERE v.definition_code=d.definition_code
          ORDER BY v.version_no DESC LIMIT 1) AS latest_updated_at,
        (SELECT v.id FROM report_template_assignments a
          JOIN report_template_versions v ON v.id=a.report_template_version_id
          WHERE a.definition_code=d.definition_code AND a.active=1 AND a.is_default=1
          AND a.scope_type='GLOBAL' AND a.scope_key='*' LIMIT 1) AS default_version_id,
        (SELECT v.version_no FROM report_template_assignments a
          JOIN report_template_versions v ON v.id=a.report_template_version_id
          WHERE a.definition_code=d.definition_code AND a.active=1 AND a.is_default=1
          AND a.scope_type='GLOBAL' AND a.scope_key='*' LIMIT 1) AS default_version_no,
        (SELECT v.version_name FROM report_template_assignments a
          JOIN report_template_versions v ON v.id=a.report_template_version_id
          WHERE a.definition_code=d.definition_code AND a.active=1 AND a.is_default=1
          AND a.scope_type='GLOBAL' AND a.scope_key='*' LIMIT 1) AS default_version_name,
        (SELECT v.status FROM report_template_assignments a
          JOIN report_template_versions v ON v.id=a.report_template_version_id
          WHERE a.definition_code=d.definition_code AND a.active=1 AND a.is_default=1
          AND a.scope_type='GLOBAL' AND a.scope_key='*' LIMIT 1) AS default_status,
        (SELECT COUNT(*) FROM report_template_assignments a
          WHERE a.definition_code=d.definition_code AND a.active=1) AS assignment_count
      FROM report_definitions d WHERE d.active=1 ORDER BY d.definition_code
    `).all();
  }

  listVersions(definitionCode) {
    getDefinition(definitionCode);
    return this.db.prepare(`
      SELECT v.*,
        EXISTS(SELECT 1 FROM report_template_assignments a
          WHERE a.report_template_version_id=v.id AND a.active=1 AND a.is_default=1) AS is_default,
        (SELECT COUNT(*) FROM report_exports e WHERE e.report_template_version_id=v.id) AS export_count
      FROM report_template_versions v
      WHERE v.definition_code=? ORDER BY v.version_no DESC
    `).all(definitionCode);
  }

  getVersion(versionId) {
    return this.db.prepare(`
      SELECT v.*,
        EXISTS(SELECT 1 FROM report_template_assignments a
          WHERE a.report_template_version_id=v.id AND a.active=1 AND a.is_default=1) AS is_default
      FROM report_template_versions v WHERE v.id=?
    `).get(Number(versionId)) || null;
  }

  requireVersion(versionId) {
    const row = this.getVersion(versionId);
    if (!row) throw reportError('report_template_version_not_found', 404);
    return row;
  }

  assertLock(row, expectedLockVersion) {
    if (!Number.isInteger(Number(expectedLockVersion)) || Number(expectedLockVersion) !== Number(row.lock_version)) {
      throw reportError('report_template_version_conflict', 409);
    }
  }

  event(versionId, action, actor, before, after, context = {}) {
    this.db.prepare(`
      INSERT INTO report_template_version_events (
        report_template_version_id, action, actor_user_id, before_json, after_json,
        request_id, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      action,
      actor || null,
      before ? stableJson(before) : null,
      after ? stableJson(after) : null,
      clean(context.requestId) || null,
      clean(context.correlationId) || null
    );
  }

  createDraft({ definitionCode, sourceVersionId = null, name, note = null, effectiveFrom = null, effectiveTo = null, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const definition = getDefinition(definitionCode);
    const source = sourceVersionId ? this.requireVersion(sourceVersionId) : this.resolvePublished({ definitionCode: definition.code });
    if (source && source.definition_code !== definition.code) throw reportError('report_template_source_mismatch');
    const tree = definition.validateTree(validateComponentTree(source ? parseJson(source.definition_json) : definition.componentTree));
    if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) throw reportError('report_template_effective_window_invalid');
    return this.db.transaction(() => {
      const versionNo = this.db.prepare('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM report_template_versions WHERE definition_code=?').get(definition.code).n;
      const info = this.db.prepare(`
        INSERT INTO report_template_versions (
          definition_code, version_no, version_name, status, definition_json,
          schema_version, version_note, effective_from, effective_to, created_by
        ) VALUES (?, ?, ?, 'DRAFT', ?, 1, ?, ?, ?, ?)
      `).run(
        definition.code,
        versionNo,
        clean(name) || `${definition.label} v${versionNo}`,
        stableJson(tree),
        clean(note) || null,
        effectiveFrom || null,
        effectiveTo || null,
        actor || null
      );
      const created = this.requireVersion(Number(info.lastInsertRowid));
      this.event(created.id, 'CREATED_DRAFT', actor, null, created, context);
      return created;
    })();
  }

  updateDraft({ versionId, expectedLockVersion, definition, name, note, effectiveFrom, effectiveTo, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.DRAFT) throw reportError('report_template_version_not_draft', 409);
    this.assertLock(row, expectedLockVersion);
    const tree = getDefinition(row.definition_code).validateTree(
      validateComponentTree(definition == null ? parseJson(row.definition_json) : definition)
    );
    const nextFrom = effectiveFrom === undefined ? row.effective_from : (effectiveFrom || null);
    const nextTo = effectiveTo === undefined ? row.effective_to : (effectiveTo || null);
    if (nextFrom && nextTo && nextTo <= nextFrom) throw reportError('report_template_effective_window_invalid');
    const result = this.db.prepare(`
      UPDATE report_template_versions
      SET version_name=?, definition_json=?, schema_version=1, checksum=NULL,
          version_note=?, effective_from=?, effective_to=?, lock_version=lock_version+1,
          updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='DRAFT' AND lock_version=?
    `).run(
      clean(name) || row.version_name,
      stableJson(tree),
      note === undefined ? row.version_note : (clean(note) || null),
      nextFrom,
      nextTo,
      actor || null,
      row.id,
      row.lock_version
    );
    if (result.changes !== 1) throw reportError('report_template_version_conflict', 409);
    const updated = this.requireVersion(row.id);
    this.event(row.id, 'UPDATED_DRAFT', actor, row, updated, context);
    return updated;
  }

  validateVersion(versionId) {
    const row = this.requireVersion(versionId);
    const tree = getDefinition(row.definition_code).validateTree(validateComponentTree(parseJson(row.definition_json)));
    const warnings = [];
    if (!row.effective_from) warnings.push('effective_from_missing');
    if (!tree.components.some((component) => component.type === 'header')) warnings.push('header_missing');
    if (!tree.components.some((component) => component.type === 'signature_block')) warnings.push('signature_block_missing');
    return {
      valid: true,
      checksum: checksum(tree),
      component_count: tree.components.length,
      warnings,
    };
  }

  submit({ versionId, expectedLockVersion, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.DRAFT) throw reportError('report_template_version_not_draft', 409);
    this.assertLock(row, expectedLockVersion);
    const tree = getDefinition(row.definition_code).validateTree(validateComponentTree(parseJson(row.definition_json)));
    const digest = checksum(tree);
    const result = this.db.prepare(`
      UPDATE report_template_versions
      SET status='IN_REVIEW', checksum=?, submitted_at=datetime('now'), submitted_by=?,
          lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='DRAFT' AND lock_version=?
    `).run(digest, actor || null, actor || null, row.id, row.lock_version);
    if (result.changes !== 1) throw reportError('report_template_version_conflict', 409);
    const submitted = this.requireVersion(row.id);
    this.event(row.id, 'SUBMITTED', actor, row, submitted, context);
    return submitted;
  }

  assignAsDefault(version, actor) {
    this.db.prepare(`
      UPDATE report_template_assignments
      SET is_default=0, updated_at=datetime('now'), updated_by=?
      WHERE definition_code=? AND scope_type='GLOBAL' AND scope_key='*'
        AND active=1 AND is_default=1
    `).run(actor || null, version.definition_code);
    this.db.prepare(`
      INSERT INTO report_template_assignments (
        definition_code, report_template_version_id, scope_type, scope_key,
        effective_from, effective_to, is_default, active, created_by, updated_by
      ) VALUES (?, ?, 'GLOBAL', '*', ?, ?, 1, 1, ?, ?)
      ON CONFLICT(report_template_version_id, scope_type, scope_key) DO UPDATE SET
        effective_from=excluded.effective_from, effective_to=excluded.effective_to,
        is_default=1, active=1, updated_at=datetime('now'), updated_by=excluded.updated_by
    `).run(
      version.definition_code,
      version.id,
      version.effective_from,
      version.effective_to,
      actor || null,
      actor || null
    );
  }

  publish({ versionId, expectedLockVersion, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.IN_REVIEW) throw reportError('report_template_version_not_in_review', 409);
    this.assertLock(row, expectedLockVersion);
    const tree = getDefinition(row.definition_code).validateTree(validateComponentTree(parseJson(row.definition_json)));
    if (checksum(tree) !== row.checksum) throw reportError('report_template_checksum_mismatch', 409);
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE report_template_versions
        SET status='PUBLISHED', published_at=datetime('now'), published_by=?,
            retired_at=NULL, retired_by=NULL, lock_version=lock_version+1,
            updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='IN_REVIEW' AND lock_version=?
      `).run(actor || null, actor || null, row.id, row.lock_version);
      if (result.changes !== 1) throw reportError('report_template_version_conflict', 409);
      const published = this.requireVersion(row.id);
      this.assignAsDefault(published, actor);
      const assigned = this.requireVersion(row.id);
      this.event(row.id, 'PUBLISHED', actor, row, assigned, context);
      return assigned;
    })();
  }

  retire({ versionId, expectedLockVersion, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.PUBLISHED) throw reportError('report_template_version_not_published', 409);
    this.assertLock(row, expectedLockVersion);
    if (row.is_default) throw reportError('default_report_template_cannot_retire', 409);
    const result = this.db.prepare(`
      UPDATE report_template_versions
      SET status='RETIRED', retired_at=datetime('now'), retired_by=?,
          lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='PUBLISHED' AND lock_version=?
    `).run(actor || null, actor || null, row.id, row.lock_version);
    if (result.changes !== 1) throw reportError('report_template_version_conflict', 409);
    const retired = this.requireVersion(row.id);
    this.event(row.id, 'RETIRED', actor, row, retired, context);
    return retired;
  }

  rollback({ versionId, expectedLockVersion, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const row = this.requireVersion(versionId);
    if (![VERSION_STATUSES.PUBLISHED, VERSION_STATUSES.RETIRED].includes(row.status)) {
      throw reportError('report_template_rollback_target_invalid', 409);
    }
    this.assertLock(row, expectedLockVersion);
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE report_template_versions
        SET status='PUBLISHED', retired_at=NULL, retired_by=NULL,
            lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status IN ('PUBLISHED','RETIRED') AND lock_version=?
      `).run(actor || null, row.id, row.lock_version);
      if (result.changes !== 1) throw reportError('report_template_version_conflict', 409);
      const target = this.requireVersion(row.id);
      this.assignAsDefault(target, actor);
      const rolledBack = this.requireVersion(row.id);
      this.event(row.id, 'DEFAULT_ROLLED_BACK', actor, row, rolledBack, context);
      return rolledBack;
    })();
  }

  resolvePublished({ definitionCode, at = null }) {
    const definition = getDefinition(definitionCode);
    const effectiveAt = clean(at) || new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT v.*, 1 AS is_default
      FROM report_template_assignments a
      JOIN report_template_versions v ON v.id=a.report_template_version_id
      WHERE a.definition_code=@definition_code
        AND a.scope_type='GLOBAL' AND a.scope_key='*'
        AND a.active=1 AND a.is_default=1 AND v.status='PUBLISHED'
        AND (a.effective_from IS NULL OR date(a.effective_from) <= date(@effective_at))
        AND (a.effective_to IS NULL OR date(a.effective_to) > date(@effective_at))
      ORDER BY v.version_no DESC LIMIT 1
    `).get({ definition_code: definition.code, effective_at: effectiveAt }) || null;
  }

  events(versionId) {
    return this.db.prepare(`
      SELECT * FROM report_template_version_events
      WHERE report_template_version_id=? ORDER BY created_at DESC, id DESC
    `).all(Number(versionId));
  }
}

module.exports = ReportTemplateVersionRepository;
module.exports.VERSION_STATUSES = VERSION_STATUSES;
