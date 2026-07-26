'use strict';

class ReportArtifactRepository {
  constructor(db) {
    this.db = db;
  }

  jobById(jobId) {
    return this.db.prepare('SELECT * FROM report_export_jobs WHERE id=?').get(jobId) || null;
  }

  jobByIdempotency(requesterUserId, idempotencyKey) {
    return this.db.prepare(`
      SELECT * FROM report_export_jobs WHERE requester_user_id=? AND idempotency_key=?
    `).get(requesterUserId, idempotencyKey) || null;
  }

  completedByJobId(jobId) {
    return this.db.prepare(`
      SELECT a.*, j.status AS job_status, j.definition_code, j.definition_version,
        j.report_template_version_id, j.template_checksum, j.ticket_id, j.round_id,
        j.round_no, j.data_contract_version, j.context_checksum, j.renderer_version,
        j.app_commit, j.scoring_policy_version_id, j.scoring_policy_checksum, j.scoring_rules_marker,
        j.scoring_rules_checksum,
        COALESCE(j.legacy_source, e.legacy_source) AS legacy_source,
        COALESCE(j.legacy_alias_version, e.legacy_alias_version) AS legacy_alias_version,
        j.requester_user_id, j.generator_id,
        j.request_id, j.correlation_id, j.requested_at, j.generated_at, j.completed_at,
        e.id AS export_id, e.report_type, e.exported_by, e.component_checksum,
        e.scoring_compatibility_marker, v.version_no AS template_version_no
      FROM report_export_jobs j
      JOIN report_artifacts a ON a.job_id=j.id
      JOIN report_exports e ON e.artifact_id=a.id
      LEFT JOIN report_template_versions v ON v.id=j.report_template_version_id
      WHERE j.id=? AND j.status='COMPLETED'
    `).get(jobId) || null;
  }

  byExportId(exportId) {
    return this.db.prepare(`
      SELECT a.*, j.status AS job_status, j.definition_code, j.definition_version,
        j.report_template_version_id, j.template_checksum, j.ticket_id, j.round_id,
        j.round_no, j.data_contract_version, j.context_checksum, j.renderer_version,
        j.app_commit, j.scoring_policy_version_id, j.scoring_policy_checksum, j.scoring_rules_marker,
        j.scoring_rules_checksum,
        COALESCE(j.legacy_source, e.legacy_source) AS legacy_source,
        COALESCE(j.legacy_alias_version, e.legacy_alias_version) AS legacy_alias_version,
        j.requester_user_id, j.generator_id,
        j.request_id, j.correlation_id, j.requested_at, j.generated_at, j.completed_at,
        e.id AS export_id, e.report_type, e.exported_by, e.component_checksum,
        e.scoring_compatibility_marker, v.version_no AS template_version_no,
        e.availability_status AS export_availability_status,
        e.legacy_reconciliation_status,
        t.created_by AS ticket_created_by
      FROM report_exports e
      LEFT JOIN report_artifacts a ON a.id=e.artifact_id
      LEFT JOIN report_export_jobs j ON j.id=e.job_id
      LEFT JOIN report_template_versions v ON v.id=j.report_template_version_id
      LEFT JOIN evaluation_tickets t ON t.id=e.ticket_id
      WHERE e.id=?
    `).get(Number(exportId)) || null;
  }

  listForTicket(ticketId, limit = 50) {
    return this.db.prepare(`
      SELECT e.id AS export_id, e.ticket_id, e.round_id, e.report_type, e.file_format,
        e.exported_by, e.exported_at, e.availability_status,
        e.legacy_reconciliation_status, e.is_regenerated,
        a.id AS artifact_id, a.file_name, a.sha256, a.size_bytes, a.mime_type,
        a.retention_class, a.retain_until, a.created_at AS artifact_created_at,
        j.id AS job_id, j.definition_code, j.report_template_version_id,
        j.template_checksum, j.context_checksum, j.renderer_version, j.app_commit,
        j.scoring_policy_version_id, j.scoring_policy_checksum, j.scoring_rules_marker, j.scoring_rules_checksum,
        COALESCE(j.legacy_source, e.legacy_source) AS legacy_source,
        COALESCE(j.legacy_alias_version, e.legacy_alias_version) AS legacy_alias_version,
        t.created_by AS ticket_created_by
      FROM report_exports e
      LEFT JOIN report_artifacts a ON a.id=e.artifact_id
      LEFT JOIN report_export_jobs j ON j.id=e.job_id
      LEFT JOIN evaluation_tickets t ON t.id=e.ticket_id
      WHERE e.ticket_id=?
      ORDER BY e.exported_at DESC, e.id DESC
      LIMIT ?
    `).all(Number(ticketId), Math.min(100, Math.max(1, Number(limit) || 50)));
  }

  markAvailability(artifactId, status, at) {
    this.db.prepare('UPDATE report_artifacts SET availability_status=?, last_verified_at=? WHERE id=?')
      .run(status, at, Number(artifactId));
    this.db.prepare('UPDATE report_exports SET availability_status=? WHERE artifact_id=?')
      .run(status, Number(artifactId));
  }

  event({ jobId, artifactId = null, eventCode, actor = null, outcome, requestId = null, correlationId = null, metadata = null, uniqueKey, at }) {
    this.db.prepare(`
      INSERT INTO report_artifact_events (
        job_id, artifact_id, event_code, actor_user_id, outcome,
        request_id, correlation_id, metadata_json, unique_event_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(unique_event_key) DO NOTHING
    `).run(
      jobId,
      artifactId,
      eventCode,
      actor,
      outcome,
      requestId,
      correlationId,
      metadata ? JSON.stringify(metadata) : null,
      uniqueKey,
      at
    );
  }
}

module.exports = ReportArtifactRepository;
