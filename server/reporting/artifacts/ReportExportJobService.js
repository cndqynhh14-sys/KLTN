'use strict';

const crypto = require('node:crypto');
const { ReportOrchestrator } = require('../ReportOrchestrator');
const ReportTemplateVersionRepository = require('../ReportTemplateVersionRepository');
const { getDefinition } = require('../definitionCatalog');
const { checksum, reportError, stableJson } = require('../reportUtils');
const ReportArtifactRepository = require('./ReportArtifactRepository');
const {
  CONTENT_TYPES,
  EXTENSIONS,
  artifactError,
  assertArtifactBytes,
  availabilityForReadError,
  checksumText,
  contentDisposition,
  safeFileName,
} = require('./artifactSecurity');
const { createArtifactStorage } = require('./config');
const ScoringPolicyRepository = require('../../scoring/ScoringPolicyRepository');

const RENDERER_VERSION = 'REPORT_RENDERER_V1';
const DATA_CONTRACT_VERSION = 1;
const SCORING_RULES_MARKER = 'LEGACY_RULES_V1';
const SCORING_RULES_CHECKSUM = checksumText('LEGACY_RULES_V1|LEGACY_SCORING_V1_UNVERSIONED');
const RETENTION_CLASS = 'REPORT_ARTIFACT_STANDARD_V1';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function iso(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function appCommit(env) {
  return clean(env.APP_COMMIT || env.COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || env.SOURCE_VERSION) || 'UNAVAILABLE';
}

function retainUntil(requestedAt, env) {
  const configured = Number(env.REPORT_RETENTION_DAYS || 365);
  const days = Number.isInteger(configured) && configured >= 1 && configured <= 3650 ? configured : 365;
  const date = new Date(requestedAt);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

class ReportExportJobService {
  constructor({
    db,
    storage = null,
    executionMode = null,
    env = process.env,
    now = () => new Date(),
    idFactory = () => crypto.randomUUID(),
    renderer = null,
  }) {
    this.db = db;
    this.env = env;
    this.now = now;
    this.idFactory = idFactory;
    this.executionMode = clean(executionMode || env.REPORT_EXPORT_EXECUTION_MODE || (env.NODE_ENV === 'production' ? 'worker' : 'inline')).toLowerCase();
    if (!['inline', 'worker'].includes(this.executionMode)) throw artifactError('report_execution_mode_invalid', 503);
    if (env.NODE_ENV === 'production' && this.executionMode !== 'worker') throw artifactError('report_worker_required', 503);
    this.storage = storage || createArtifactStorage({ db, env });
    this.templates = new ReportTemplateVersionRepository(db);
    this.scoringPolicies = new ScoringPolicyRepository(db, { env });
    this.orchestrator = renderer || new ReportOrchestrator({ db });
    this.artifacts = new ReportArtifactRepository(db);
    const configuredAttempts = Number(env.REPORT_EXPORT_MAX_ATTEMPTS || 3);
    this.maxAttempts = Number.isInteger(configuredAttempts) && configuredAttempts >= 1 && configuredAttempts <= 10
      ? configuredAttempts
      : 3;
  }

  createOrGetJob(input) {
    const definition = getDefinition(input.definitionCode);
    const roundNo = definition.validateRound(input.roundNo || definition.defaultRoundNo);
    const requester = clean(input.requestedBy);
    const idempotencyKey = clean(input.idempotencyKey);
    if (!requester) throw artifactError('report_requester_required', 400);
    if (!idempotencyKey || idempotencyKey.length > 160) throw artifactError('report_idempotency_key_required', 400);
    const format = clean(input.format).toUpperCase();
    if (!CONTENT_TYPES[format]) throw artifactError('report_format_not_supported', 400);
    const existing = this.artifacts.jobByIdempotency(requester, idempotencyKey);
    if (existing) {
      if (existing.ticket_id !== Number(input.ticket.id)
        || existing.definition_code !== definition.code
        || existing.round_no !== roundNo
        || existing.file_format !== format
        || String(existing.legacy_source || '') !== clean(input.legacySource)
        || String(existing.legacy_alias_version || '') !== clean(input.legacyAliasVersion)) {
        throw artifactError('report_idempotency_conflict', 409);
      }
      return { job: existing, inserted: false };
    }
    const version = this.templates.resolvePublished({ definitionCode: definition.code, at: input.at });
    if (!version) throw artifactError('published_report_template_not_found', 404);
    const scoringVersion = this.scoringPolicies.pinTicket(input.ticket.id);
    const round = this.db.prepare('SELECT id FROM evaluation_rounds WHERE ticket_id=? AND round_no=?').get(input.ticket.id, roundNo);
    if (!round) {
      throw reportError('round_not_found', 404, {
        definition_code: definition.code,
        required_round_no: roundNo,
      });
    }
    const requestedAt = iso(this.now);
    const jobId = this.idFactory();
    try {
      this.db.prepare(`
        INSERT INTO report_export_jobs (
          id, idempotency_key, definition_code, definition_version,
          report_template_version_id, template_version_marker, template_checksum,
          ticket_id, round_id, round_no, file_format, data_contract_version,
          renderer_version, app_commit, scoring_policy_version_id,
          scoring_policy_checksum, scoring_rules_marker, scoring_rules_checksum, requester_user_id,
          generator_id, request_id, correlation_id, legacy_source,
          legacy_alias_version, execution_mode, status,
          outcome, requested_at, regenerate_of_artifact_id,
          regeneration_reason, regeneration_policy
        ) VALUES (
          @id, @idempotency_key, @definition_code, @definition_version,
          @report_template_version_id, NULL, @template_checksum,
          @ticket_id, @round_id, @round_no, @file_format, @data_contract_version,
          @renderer_version, @app_commit, @scoring_policy_version_id,
          @scoring_policy_checksum, NULL, @scoring_rules_checksum, @requester_user_id,
          @generator_id, @request_id, @correlation_id, @legacy_source,
          @legacy_alias_version, @execution_mode,
          'QUEUED', 'PENDING', @requested_at, @regenerate_of_artifact_id,
          @regeneration_reason, @regeneration_policy
        )
      `).run({
        id: jobId,
        idempotency_key: idempotencyKey,
        definition_code: definition.code,
        definition_version: `${definition.code}@1`,
        report_template_version_id: version.id,
        template_checksum: version.checksum,
        ticket_id: Number(input.ticket.id),
        round_id: round.id,
        round_no: roundNo,
        file_format: format,
        data_contract_version: DATA_CONTRACT_VERSION,
        renderer_version: RENDERER_VERSION,
        app_commit: appCommit(this.env),
        scoring_policy_version_id: String(scoringVersion.id),
        scoring_policy_checksum: scoringVersion.checksum,
        scoring_rules_checksum: scoringVersion.formula_checksum,
        requester_user_id: requester,
        generator_id: clean(this.env.REPORT_GENERATOR_ID) || `${this.executionMode}:${RENDERER_VERSION}`,
        request_id: clean(input.requestId) || null,
        correlation_id: clean(input.correlationId) || null,
        legacy_source: clean(input.legacySource) || null,
        legacy_alias_version: clean(input.legacyAliasVersion) || null,
        execution_mode: this.executionMode.toUpperCase(),
        requested_at: requestedAt,
        regenerate_of_artifact_id: input.regenerateOfArtifactId || null,
        regeneration_reason: clean(input.regenerationReason) || null,
        regeneration_policy: clean(input.regenerationPolicy) || null,
      });
    } catch (error) {
      if (!String(error.message).includes('UNIQUE constraint failed')) throw error;
      const raced = this.artifacts.jobByIdempotency(requester, idempotencyKey);
      if (!raced) throw error;
      return { job: raced, inserted: false };
    }
    return { job: this.artifacts.jobById(jobId), inserted: true };
  }

  requestExport(input) {
    const { job } = this.createOrGetJob(input);
    if (job.status === 'COMPLETED') return this.loadCompleted(job.id, input.requestedBy, input);
    if (job.status === 'FAILED' && job.attempt_count >= this.maxAttempts) {
      throw artifactError('report_export_retry_exhausted', 409);
    }
    if (job.status === 'RUNNING') return this.pending(job);
    if (this.executionMode === 'worker') return this.pending(job);
    return this.processJob(job.id, { ticket: input.ticket, at: input.at });
  }

  pending(job) {
    return {
      pending: true,
      job_id: job.id,
      status: job.status,
      retry_after: 3,
      definition_code: job.definition_code,
      canonical_code: job.definition_code,
      legacy_source: job.legacy_source || null,
      legacy_alias_version: job.legacy_alias_version || null,
      file_format: job.file_format,
    };
  }

  claim(jobId) {
    const startedAt = iso(this.now);
    const updated = this.db.prepare(`
      UPDATE report_export_jobs
      SET status='RUNNING', outcome='PENDING', attempt_count=attempt_count+1,
          started_at=?, failed_at=NULL, error_code=NULL
      WHERE id=? AND status IN ('QUEUED', 'FAILED')
    `).run(startedAt, jobId);
    if (updated.changes === 1) return this.artifacts.jobById(jobId);
    return null;
  }

  processJob(jobId, { ticket = null } = {}) {
    let job = this.claim(jobId);
    if (!job) {
      const current = this.artifacts.jobById(jobId);
      if (!current) throw artifactError('report_export_job_not_found', 404);
      if (current.status === 'COMPLETED') return this.loadCompleted(current.id, current.requester_user_id);
      return this.pending(current);
    }
    try {
      const pinnedTicket = ticket || this.db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(job.ticket_id);
      if (!pinnedTicket) throw artifactError('report_ticket_not_found', 404);
      const version = this.templates.requireVersion(job.report_template_version_id);
      const rendered = typeof this.orchestrator === 'function'
        ? this.orchestrator({ job, ticket: pinnedTicket, version })
        : this.orchestrator.renderVersion({
          version,
          ticket: pinnedTicket,
          roundNo: job.round_no,
          format: job.file_format,
        });
      if (rendered.definition_code !== job.definition_code
        || Number(rendered.template_version_id) !== Number(job.report_template_version_id)
        || rendered.format !== job.file_format
        || String(rendered.scoring_policy_version_id || '') !== String(job.scoring_policy_version_id || '')
        || rendered.scoring_policy_checksum !== job.scoring_policy_checksum) {
        throw artifactError('report_render_provenance_mismatch', 500);
      }
      const integrity = assertArtifactBytes({
        buffer: rendered.buffer,
        format: job.file_format,
        mimeType: rendered.content_type,
      });
      const ticketCode = rendered.context?.doc4?.related_information?.report_no || pinnedTicket.ticket_code;
      const fileName = safeFileName(`${ticketCode}-${job.definition_code}`, job.file_format);
      const date = job.requested_at.slice(0, 10).replace(/-/g, '/');
      const storageKey = `reports/${date}/${job.id}/${integrity.sha256}.${EXTENSIONS[job.file_format]}`;
      const persisted = this.storage.putAtomic({
        storageKey,
        buffer: rendered.buffer,
        contentType: rendered.content_type,
      });
      if (persisted.sha256 && persisted.sha256 !== integrity.sha256) throw artifactError('report_storage_checksum_mismatch', 503);
      if (persisted.size_bytes && Number(persisted.size_bytes) !== integrity.size_bytes) throw artifactError('report_storage_size_mismatch', 503);
      const generatedAt = iso(this.now);
      const source = {
        ticket_id: Number(pinnedTicket.id),
        ticket_code: pinnedTicket.ticket_code,
        round_id: rendered.context?.round?.id || job.round_id || null,
        round_no: job.round_no,
        question_template_version_id: pinnedTicket.question_template_version_id || null,
        report_template_version_id: job.report_template_version_id,
        definition_code: job.definition_code,
        definition_version: job.definition_version,
        data_contract_version: job.data_contract_version,
        scoring_policy_version_id: Number(job.scoring_policy_version_id),
        scoring_policy_checksum: job.scoring_policy_checksum,
        context_checksum: rendered.context_checksum,
        legacy_source: job.legacy_source || null,
        legacy_alias_version: job.legacy_alias_version || null,
      };
      const sourceJson = stableJson(source);
      const completed = this.db.transaction(() => {
        const snapshotInfo = this.db.prepare(`
          INSERT INTO report_source_snapshots (
            job_id, ticket_id, round_id, round_no, question_template_version_id,
            report_template_version_id, definition_code, definition_version,
            data_contract_version, scoring_policy_version_id, scoring_policy_checksum,
            context_checksum, source_checksum,
            source_snapshot_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          job.id,
          source.ticket_id,
          source.round_id,
          source.round_no,
          source.question_template_version_id,
          source.report_template_version_id,
          source.definition_code,
          source.definition_version,
          source.data_contract_version,
          source.scoring_policy_version_id,
          source.scoring_policy_checksum,
          source.context_checksum,
          checksum(source),
          sourceJson,
          generatedAt
        );
        const artifactInfo = this.db.prepare(`
          INSERT INTO report_artifacts (
            job_id, source_snapshot_id, storage_adapter, storage_key, sha256,
            size_bytes, mime_type, file_name, file_format, retention_class,
            retain_until, availability_status, created_at, last_verified_at,
            regenerated_from_artifact_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?)
        `).run(
          job.id,
          Number(snapshotInfo.lastInsertRowid),
          this.storage.adapterName,
          storageKey,
          integrity.sha256,
          integrity.size_bytes,
          rendered.content_type,
          fileName,
          job.file_format,
          RETENTION_CLASS,
          retainUntil(job.requested_at, this.env),
          generatedAt,
          generatedAt,
          job.regenerate_of_artifact_id || null
        );
        const artifactId = Number(artifactInfo.lastInsertRowid);
        const exportInfo = this.db.prepare(`
          INSERT INTO report_exports (
            ticket_id, round_id, report_template_id, report_type, file_format,
            export_scope, file_path, exported_by, report_template_version_id,
            definition_code, context_checksum, component_checksum,
            scoring_compatibility_marker, scoring_policy_version_id,
            scoring_policy_checksum, job_id, artifact_id,
            availability_status, legacy_reconciliation_status, is_regenerated,
            legacy_source, legacy_alias_version
          ) VALUES (?, ?, NULL, ?, ?, 'TICKET', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'AVAILABLE', 'IMPORTED', ?, ?, ?)
        `).run(
          job.ticket_id,
          source.round_id,
          job.definition_code,
          job.file_format,
          storageKey,
          job.requester_user_id,
          job.report_template_version_id,
          job.definition_code,
          rendered.context_checksum,
          rendered.component_checksum,
          rendered.scoring_compatibility_marker,
          rendered.scoring_policy_version_id,
          rendered.scoring_policy_checksum,
          job.id,
          artifactId,
          job.regenerate_of_artifact_id ? 1 : 0,
          job.legacy_source || null,
          job.legacy_source ? job.legacy_alias_version : null
        );
        this.db.prepare(`
          UPDATE report_export_jobs
          SET status='COMPLETED', outcome='SUCCESS', context_checksum=?,
              template_checksum=?, generated_at=?, completed_at=?, error_code=NULL
          WHERE id=? AND status='RUNNING'
        `).run(rendered.context_checksum, rendered.template_checksum, generatedAt, generatedAt, job.id);
        this.artifacts.event({
          jobId: job.id,
          artifactId,
          eventCode: 'ARTIFACT_STORED',
          actor: job.requester_user_id,
          outcome: 'SUCCESS',
          requestId: job.request_id,
          correlationId: job.correlation_id,
          metadata: { storage_adapter: this.storage.adapterName, file_format: job.file_format, sha256: integrity.sha256 },
          uniqueKey: `stored:${job.id}`,
          at: generatedAt,
        });
        return { artifactId, exportId: Number(exportInfo.lastInsertRowid) };
      })();
      job = this.artifacts.jobById(job.id);
      return this.loadCompleted(job.id, job.requester_user_id, {
        event: true,
        requestId: job.request_id,
        correlationId: job.correlation_id,
        source: this.executionMode === 'worker' ? 'worker_verification' : 'immediate',
        completed,
      });
    } catch (error) {
      const failedAt = iso(this.now);
      this.db.prepare(`
        UPDATE report_export_jobs
        SET status='FAILED', outcome='FAILURE', error_code=?, failed_at=?
        WHERE id=? AND status='RUNNING'
      `).run(clean(error.code) || 'report_export_failed', failedAt, job.id);
      this.artifacts.event({
        jobId: job.id,
        eventCode: 'ARTIFACT_STORE_FAILED',
        actor: job.requester_user_id,
        outcome: 'FAILURE',
        requestId: job.request_id,
        correlationId: job.correlation_id,
        metadata: { error_code: clean(error.code) || 'report_export_failed' },
        uniqueKey: `store-failed:${job.id}:${job.attempt_count}`,
        at: failedAt,
      });
      throw error;
    }
  }

  loadCompleted(jobId, actor = null, context = {}) {
    const record = this.artifacts.completedByJobId(jobId);
    if (!record) throw artifactError('report_artifact_not_found', 404);
    if (record.availability_status !== 'AVAILABLE') throw artifactError('report_artifact_unavailable', 410);
    if (record.storage_adapter !== this.storage.adapterName) throw artifactError('report_storage_adapter_mismatch', 503);
    let buffer;
    try {
      buffer = this.storage.get(record.storage_key);
      assertArtifactBytes({
        buffer,
        format: record.file_format,
        mimeType: record.mime_type,
        sha256: record.sha256,
        sizeBytes: record.size_bytes,
      });
    } catch (error) {
      const status = availabilityForReadError(error);
      if (status) this.artifacts.markAvailability(record.id, status, iso(this.now));
      throw error;
    }
    const verifiedAt = iso(this.now);
    this.artifacts.markAvailability(record.id, 'AVAILABLE', verifiedAt);
    if (context.event !== false) this.artifacts.event({
      jobId: record.job_id,
      artifactId: record.id,
      eventCode: 'ARTIFACT_READ',
      actor: clean(actor) || null,
      outcome: 'SUCCESS',
      requestId: clean(context.requestId) || null,
      correlationId: clean(context.correlationId) || null,
      metadata: { source: context.source || 'immediate' },
      uniqueKey: `read:${record.job_id}:${clean(context.requestId) || this.idFactory()}`,
      at: verifiedAt,
    });
    return {
      id: record.export_id,
      export_id: record.export_id,
      job_id: record.job_id,
      artifact_id: record.id,
      round_id: record.round_id,
      round_no: record.round_no,
      report_type: record.definition_code,
      definition_code: record.definition_code,
      canonical_code: record.definition_code,
      legacy_source: record.legacy_source || null,
      legacy_alias_version: record.legacy_alias_version || null,
      report_template_version_id: record.report_template_version_id,
      template_version_no: record.template_version_no,
      template_checksum: record.template_checksum,
      context_checksum: record.context_checksum,
      component_checksum: record.component_checksum,
      scoring_compatibility_marker: record.scoring_compatibility_marker,
      scoring_policy_version_id: record.scoring_policy_version_id,
      scoring_policy_checksum: record.scoring_policy_checksum,
      scoring_rules_marker: record.scoring_rules_marker,
      scoring_rules_checksum: record.scoring_rules_checksum,
      file_format: record.file_format,
      file_name: record.file_name,
      file_path: record.storage_key,
      storage_key: record.storage_key,
      sha256: record.sha256,
      size_bytes: record.size_bytes,
      content_type: record.mime_type,
      content_disposition: contentDisposition(record.file_name),
      buffer,
    };
  }

  processNext() {
    const next = this.db.prepare(`
      SELECT id FROM report_export_jobs
      WHERE status IN ('QUEUED', 'FAILED')
        AND attempt_count < ?
      ORDER BY requested_at, id LIMIT 1
    `).get(this.maxAttempts);
    return next ? this.processJob(next.id) : null;
  }

  requestRegeneration(input) {
    if (this.env.REPORT_REGENERATION_ENABLED !== 'REPORT-001:REGENERATION_APPROVED') {
      throw artifactError('report_regeneration_disabled', 403);
    }
    if (clean(input.regenerationReason).length < 8 || clean(input.regenerationPolicy).length < 3) {
      throw artifactError('report_regeneration_reason_required', 400);
    }
    return this.requestExport({ ...input, regenerateOfArtifactId: Number(input.regenerateOfArtifactId) });
  }
}

module.exports = {
  DATA_CONTRACT_VERSION,
  RENDERER_VERSION,
  RETENTION_CLASS,
  SCORING_RULES_CHECKSUM,
  SCORING_RULES_MARKER,
  ReportExportJobService,
};
