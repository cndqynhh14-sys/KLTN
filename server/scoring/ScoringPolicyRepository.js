'use strict';

const {
  calculateWithPolicy,
  classifyWithPolicy,
  buildEvaluationResultWithPolicy,
  definitionChecksum,
  formulaChecksum,
  stableJson,
  validateScoringPolicyDefinition,
} = require('./scoringPolicyEngine');

const PUBLISH_ACKNOWLEDGEMENT = 'SCORE-001:APPROVED';
const VERSION_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  IN_REVIEW: 'IN_REVIEW',
  PUBLISHED: 'PUBLISHED',
  RETIRED: 'RETIRED',
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function policyError(code, status = 400, details = {}) {
  return Object.assign(new Error(code), { code, status, details });
}

function parseDefinition(row) {
  try {
    return validateScoringPolicyDefinition(JSON.parse(row.definition_json));
  } catch (error) {
    if (error.code) throw error;
    throw policyError('scoring_policy_definition_invalid');
  }
}

class ScoringPolicyRepository {
  constructor(db, { env = process.env } = {}) {
    this.db = db;
    this.env = env;
  }

  publishingEnabled() {
    return this.env.SCORING_POLICY_PUBLISH_ACK === PUBLISH_ACKNOWLEDGEMENT;
  }

  listPolicies() {
    return this.db.prepare(`
      SELECT p.*,
        COUNT(v.id) AS version_count,
        SUM(CASE WHEN v.status='PUBLISHED' THEN 1 ELSE 0 END) AS published_count
      FROM scoring_policies p
      LEFT JOIN scoring_policy_versions v ON v.scoring_policy_id=p.id
      GROUP BY p.id ORDER BY p.policy_code
    `).all();
  }

  getPolicy(code) {
    return this.db.prepare('SELECT * FROM scoring_policies WHERE policy_code=?').get(clean(code).toUpperCase()) || null;
  }

  requirePolicy(code) {
    const policy = this.getPolicy(code);
    if (!policy) throw policyError('scoring_policy_not_found', 404);
    return policy;
  }

  listVersions(code) {
    const policy = this.requirePolicy(code);
    return this.db.prepare(`
      SELECT v.*, EXISTS(
        SELECT 1 FROM scoring_policy_assignments a
        WHERE a.scoring_policy_version_id=v.id AND a.active=1 AND a.is_default=1
      ) AS is_default
      FROM scoring_policy_versions v
      WHERE v.scoring_policy_id=? ORDER BY v.version_no DESC
    `).all(policy.id);
  }

  getVersion(id) {
    return this.db.prepare(`
      SELECT v.*, p.policy_code, p.policy_name, EXISTS(
        SELECT 1 FROM scoring_policy_assignments a
        WHERE a.scoring_policy_version_id=v.id AND a.active=1 AND a.is_default=1
      ) AS is_default
      FROM scoring_policy_versions v
      JOIN scoring_policies p ON p.id=v.scoring_policy_id
      WHERE v.id=?
    `).get(Number(id)) || null;
  }

  requireVersion(id) {
    const version = this.getVersion(id);
    if (!version) throw policyError('scoring_policy_version_not_found', 404);
    return version;
  }

  definition(versionOrId) {
    return parseDefinition(typeof versionOrId === 'object' ? versionOrId : this.requireVersion(versionOrId));
  }

  assertLock(row, expectedLockVersion) {
    if (!Number.isInteger(Number(expectedLockVersion)) || Number(expectedLockVersion) !== Number(row.lock_version)) {
      throw policyError('scoring_policy_version_conflict', 409, { current_lock_version: row.lock_version });
    }
  }

  event(versionId, action, actor, before, after, context = {}) {
    this.db.prepare(`
      INSERT INTO scoring_policy_version_events (
        scoring_policy_version_id, action, actor_user_id, before_json, after_json,
        decision_id, request_id, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(versionId),
      clean(action),
      clean(actor) || null,
      before ? stableJson({ id: before.id, status: before.status, checksum: before.checksum, lock_version: before.lock_version }) : null,
      after ? stableJson({ id: after.id, status: after.status, checksum: after.checksum, lock_version: after.lock_version }) : null,
      clean(context.decisionId) || null,
      clean(context.requestId) || null,
      clean(context.correlationId) || null,
    );
  }

  resolvePublished({ ticket = {}, at = null } = {}) {
    const effectiveAt = clean(at) || new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT v.*, p.policy_code, p.policy_name, 1 AS is_default
      FROM scoring_policy_assignments a
      JOIN scoring_policy_versions v ON v.id=a.scoring_policy_version_id
      JOIN scoring_policies p ON p.id=v.scoring_policy_id
      WHERE a.active=1 AND a.is_default=1 AND v.status='PUBLISHED'
        AND (a.template_id IS NULL OR a.template_id=@template_id)
        AND (a.facility_type='ALL' OR a.facility_type=@facility_type)
        AND (a.supplier_scale='ALL' OR a.supplier_scale=@supplier_scale)
        AND (a.evaluation_type='ALL' OR a.evaluation_type=@evaluation_type)
        AND (a.effective_from IS NULL OR date(a.effective_from) <= date(@effective_at))
        AND (a.effective_to IS NULL OR date(a.effective_to) > date(@effective_at))
      ORDER BY
        CASE WHEN a.template_id=@template_id THEN 1 ELSE 0 END DESC,
        CASE WHEN a.facility_type=@facility_type THEN 1 ELSE 0 END DESC,
        CASE WHEN a.supplier_scale=@supplier_scale THEN 1 ELSE 0 END DESC,
        CASE WHEN a.evaluation_type=@evaluation_type THEN 1 ELSE 0 END DESC,
        v.version_no DESC LIMIT 1
    `).get({
      template_id: Number(ticket.template_id || 0),
      facility_type: clean(ticket.facility_type) || 'ALL',
      supplier_scale: clean(ticket.supplier_scale) || 'ALL',
      evaluation_type: clean(ticket.evaluation_type) || 'ALL',
      effective_at: effectiveAt,
    }) || null;
  }

  policyForTicket(ticket) {
    const pinnedId = Number(ticket?.scoring_policy_version_id || 0);
    const version = pinnedId ? this.requireVersion(pinnedId) : this.resolvePublished({ ticket });
    if (!version) throw policyError('published_scoring_policy_not_found', 503);
    return { version, definition: this.definition(version) };
  }

  pinTicket(ticketId) {
    const ticket = this.db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(Number(ticketId));
    if (!ticket) throw policyError('ticket_not_found', 404);
    if (ticket.scoring_policy_version_id) return this.requireVersion(ticket.scoring_policy_version_id);
    const version = this.resolvePublished({ ticket });
    if (!version) throw policyError('published_scoring_policy_not_found', 503);
    this.db.prepare(`
      UPDATE evaluation_tickets SET scoring_policy_version_id=?
      WHERE id=? AND scoring_policy_version_id IS NULL
    `).run(version.id, ticket.id);
    this.db.prepare(`
      UPDATE evaluation_rounds SET scoring_policy_version_id=?
      WHERE ticket_id=? AND scoring_policy_version_id IS NULL
    `).run(version.id, ticket.id);
    return version;
  }

  createDraft({ policyCode, sourceVersionId = null, note = null, actor = null, context = {} }) {
    const policy = this.requirePolicy(policyCode);
    const source = sourceVersionId
      ? this.requireVersion(sourceVersionId)
      : this.resolvePublished({});
    if (source && Number(source.scoring_policy_id) !== Number(policy.id)) throw policyError('scoring_policy_clone_source_invalid', 409);
    const definition = source ? this.definition(source) : null;
    if (!definition) throw policyError('scoring_policy_clone_source_required', 400);
    const next = this.db.prepare('SELECT COALESCE(MAX(version_no),0)+1 AS n FROM scoring_policy_versions WHERE scoring_policy_id=?').get(policy.id).n;
    const inserted = this.db.prepare(`
      INSERT INTO scoring_policy_versions (
        scoring_policy_id, version_no, status, schema_version, definition_json,
        formula_checksum, checksum, version_note, effective_from, effective_to,
        lock_version, created_by
      ) VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      policy.id, next, definition.schema_version, stableJson(definition),
      formulaChecksum(definition), definitionChecksum(definition), clean(note) || null,
      source.effective_from, source.effective_to, clean(actor) || null,
    );
    const created = this.requireVersion(inserted.lastInsertRowid);
    this.event(created.id, 'DRAFT_CREATED', actor, null, created, context);
    return created;
  }

  updateDraft({ versionId, expectedLockVersion, definition, note, effectiveFrom, effectiveTo, actor = null, context = {} }) {
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.DRAFT) throw policyError('scoring_policy_version_not_draft', 409);
    this.assertLock(row, expectedLockVersion);
    const validated = validateScoringPolicyDefinition(definition || this.definition(row));
    const result = this.db.prepare(`
      UPDATE scoring_policy_versions SET
        definition_json=?, formula_checksum=?, checksum=?,
        version_note=?, effective_from=?, effective_to=?, lock_version=lock_version+1,
        updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='DRAFT' AND lock_version=?
    `).run(
      stableJson(validated), formulaChecksum(validated), definitionChecksum(validated),
      note === undefined ? row.version_note : (clean(note) || null),
      effectiveFrom === undefined ? row.effective_from : (clean(effectiveFrom) || null),
      effectiveTo === undefined ? row.effective_to : (clean(effectiveTo) || null),
      clean(actor) || null, row.id, row.lock_version,
    );
    if (result.changes !== 1) throw policyError('scoring_policy_version_conflict', 409);
    const updated = this.requireVersion(row.id);
    this.event(row.id, 'DRAFT_UPDATED', actor, row, updated, context);
    return updated;
  }

  validateVersion(versionId) {
    const row = this.requireVersion(versionId);
    const definition = this.definition(row);
    return {
      valid: true,
      checksum: definitionChecksum(definition),
      formula_checksum: formulaChecksum(definition),
      categories: definition.categories.length,
      bands: definition.bands.length,
    };
  }

  simulate({ versionId, fixtures = [] }) {
    const candidateRow = this.requireVersion(versionId);
    const candidate = this.definition(candidateRow);
    const currentRow = this.resolvePublished({});
    const current = currentRow ? this.definition(currentRow) : candidate;
    const items = (fixtures || []).map((fixture, index) => {
      const before = fixture.questions
        ? calculateWithPolicy(current, fixture.questions, fixture.answers || {})
        : classifyWithPolicy(current, fixture.score, !!fixture.forced_fail);
      const after = fixture.questions
        ? calculateWithPolicy(candidate, fixture.questions, fixture.answers || {})
        : classifyWithPolicy(candidate, fixture.score, !!fixture.forced_fail);
      const beforeScore = before.finalScore ?? Number(fixture.score);
      const afterScore = after.finalScore ?? Number(fixture.score);
      const beforePlan = buildEvaluationResultWithPolicy(current, {
        score: beforeScore,
        forcedFail: !!fixture.forced_fail || before.passed === false,
        evaluationDate: fixture.evaluation_date || '',
      });
      const afterPlan = buildEvaluationResultWithPolicy(candidate, {
        score: afterScore,
        forcedFail: !!fixture.forced_fail || after.passed === false,
        evaluationDate: fixture.evaluation_date || '',
      });
      return {
        fixture_id: clean(fixture.id) || String(index + 1),
        score_before: beforeScore,
        score_after: afterScore,
        band_before: before.band,
        band_after: after.band,
        grade_before: before.grade,
        grade_after: after.grade,
        conclusion_before: before.label,
        conclusion_after: after.label,
        next_evaluation_months_before: before.nextEvaluationMonths,
        next_evaluation_months_after: after.nextEvaluationMonths,
        next_evaluation_date_before: beforePlan.nextEvaluationDate,
        next_evaluation_date_after: afterPlan.nextEvaluationDate,
        changed: before.band !== after.band || before.grade !== after.grade || before.label !== after.label
          || before.finalScore !== after.finalScore
          || beforePlan.nextEvaluationDate !== afterPlan.nextEvaluationDate
          || before.nextEvaluationMonths !== after.nextEvaluationMonths,
      };
    });
    const beforeCategories = new Map((current.categories || []).map((item) => [item.code, stableJson(item)]));
    const affectedCategories = (candidate.categories || [])
      .filter((item) => beforeCategories.get(item.code) !== stableJson(item))
      .map((item) => item.code);
    const candidateCodes = new Set((candidate.categories || []).map((item) => item.code));
    (current.categories || []).forEach((item) => {
      if (!candidateCodes.has(item.code)) affectedCategories.push(item.code);
    });
    return {
      policy_version_id: candidateRow.id,
      compared_to_version_id: currentRow?.id || null,
      formula_changed: formulaChecksum(candidate) !== formulaChecksum(current),
      changed_fixture_count: items.filter((item) => item.changed).length,
      changed_band_count: items.filter((item) => item.band_before !== item.band_after).length,
      affected_categories: affectedCategories,
      items,
    };
  }

  submit({ versionId, expectedLockVersion, actor = null, context = {} }) {
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.DRAFT) throw policyError('scoring_policy_version_not_draft', 409);
    this.assertLock(row, expectedLockVersion);
    this.validateVersion(row.id);
    const result = this.db.prepare(`
      UPDATE scoring_policy_versions SET status='IN_REVIEW', submitted_at=datetime('now'), submitted_by=?,
        lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='DRAFT' AND lock_version=?
    `).run(clean(actor) || null, clean(actor) || null, row.id, row.lock_version);
    if (result.changes !== 1) throw policyError('scoring_policy_version_conflict', 409);
    const submitted = this.requireVersion(row.id);
    this.event(row.id, 'SUBMITTED', actor, row, submitted, context);
    return submitted;
  }

  assertPublishingEnabled() {
    if (!this.publishingEnabled()) {
      throw policyError('scoring_policy_publish_disabled', 403);
    }
  }

  assignDefault(version, actor) {
    const previous = this.db.prepare(`
      SELECT v.* FROM scoring_policy_assignments a
      JOIN scoring_policy_versions v ON v.id=a.scoring_policy_version_id
      WHERE a.scoring_policy_id=? AND a.template_id IS NULL
        AND a.facility_type='ALL' AND a.supplier_scale='ALL' AND a.evaluation_type='ALL'
        AND a.active=1 AND a.is_default=1 LIMIT 1
    `).get(version.scoring_policy_id) || null;
    this.db.prepare(`
      UPDATE scoring_policy_assignments SET is_default=0, updated_at=datetime('now'), updated_by=?
      WHERE scoring_policy_id=? AND template_id IS NULL AND facility_type='ALL'
        AND supplier_scale='ALL' AND evaluation_type='ALL' AND active=1 AND is_default=1
    `).run(clean(actor) || null, version.scoring_policy_id);
    this.db.prepare(`
      INSERT INTO scoring_policy_assignments (
        scoring_policy_id, scoring_policy_version_id, template_id, facility_type,
        supplier_scale, evaluation_type, effective_from, effective_to,
        is_default, active, created_by, updated_by
      ) VALUES (?, ?, NULL, 'ALL', 'ALL', 'ALL', ?, ?, 1, 1, ?, ?)
    `).run(
      version.scoring_policy_id, version.id, version.effective_from, version.effective_to,
      clean(actor) || null, clean(actor) || null,
    );
    return previous;
  }

  retireSuperseded(previous, activeVersionId, actor, context = {}) {
    if (!previous || Number(previous.id) === Number(activeVersionId) || previous.status !== VERSION_STATUSES.PUBLISHED) return;
    const result = this.db.prepare(`
      UPDATE scoring_policy_versions SET status='RETIRED', retired_at=datetime('now'), retired_by=?,
        lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
      WHERE id=? AND status='PUBLISHED'
    `).run(clean(actor) || null, clean(actor) || null, previous.id);
    if (result.changes !== 1) throw policyError('scoring_policy_version_conflict', 409);
    this.event(previous.id, 'SUPERSEDED', actor, previous, this.requireVersion(previous.id), context);
  }

  publish({ versionId, expectedLockVersion, decisionId, actor = null, context = {} }) {
    this.assertPublishingEnabled();
    const row = this.requireVersion(versionId);
    if (row.status !== VERSION_STATUSES.IN_REVIEW) throw policyError('scoring_policy_version_not_in_review', 409);
    this.assertLock(row, expectedLockVersion);
    if (clean(decisionId).length < 6) throw policyError('scoring_policy_decision_id_required', 400);
    if (!clean(actor) || clean(actor).toLowerCase() === clean(row.submitted_by).toLowerCase()) {
      throw policyError('scoring_policy_four_eyes_required', 403);
    }
    const definition = this.definition(row);
    if (definitionChecksum(definition) !== row.checksum || formulaChecksum(definition) !== row.formula_checksum) {
      throw policyError('scoring_policy_checksum_mismatch', 409);
    }
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE scoring_policy_versions SET status='PUBLISHED', decision_id=?,
          published_at=datetime('now'), published_by=?, lock_version=lock_version+1,
          updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status='IN_REVIEW' AND lock_version=?
      `).run(clean(decisionId), clean(actor), clean(actor), row.id, row.lock_version);
      if (result.changes !== 1) throw policyError('scoring_policy_version_conflict', 409);
      const published = this.requireVersion(row.id);
      const previous = this.assignDefault(published, actor);
      this.retireSuperseded(previous, published.id, actor, { ...context, decisionId });
      const assigned = this.requireVersion(row.id);
      this.event(row.id, 'PUBLISHED', actor, row, assigned, { ...context, decisionId });
      return assigned;
    })();
  }

  rollback({ versionId, expectedLockVersion, decisionId, actor = null, context = {} }) {
    this.assertPublishingEnabled();
    const row = this.requireVersion(versionId);
    if (![VERSION_STATUSES.PUBLISHED, VERSION_STATUSES.RETIRED].includes(row.status)) {
      throw policyError('scoring_policy_rollback_target_invalid', 409);
    }
    this.assertLock(row, expectedLockVersion);
    if (clean(decisionId).length < 6 || !clean(actor) || clean(actor).toLowerCase() === clean(row.submitted_by).toLowerCase()) {
      throw policyError('scoring_policy_four_eyes_required', 403);
    }
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE scoring_policy_versions SET status='PUBLISHED', decision_id=?, published_by=?,
          published_at=datetime('now'), retired_at=NULL, retired_by=NULL,
          lock_version=lock_version+1, updated_at=datetime('now'), updated_by=?
        WHERE id=? AND status IN ('PUBLISHED','RETIRED') AND lock_version=?
      `).run(clean(decisionId), clean(actor), clean(actor), row.id, row.lock_version);
      if (result.changes !== 1) throw policyError('scoring_policy_version_conflict', 409);
      const target = this.requireVersion(row.id);
      const previous = this.assignDefault(target, actor);
      this.retireSuperseded(previous, target.id, actor, { ...context, decisionId });
      const assigned = this.requireVersion(row.id);
      this.event(row.id, 'DEFAULT_ROLLED_BACK', actor, row, assigned, { ...context, decisionId });
      return assigned;
    })();
  }

  events(versionId) {
    return this.db.prepare(`
      SELECT * FROM scoring_policy_version_events
      WHERE scoring_policy_version_id=? ORDER BY created_at DESC, id DESC
    `).all(Number(versionId));
  }
}

module.exports = ScoringPolicyRepository;
module.exports.PUBLISH_ACKNOWLEDGEMENT = PUBLISH_ACKNOWLEDGEMENT;
module.exports.VERSION_STATUSES = VERSION_STATUSES;
