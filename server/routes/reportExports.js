'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { db, policyService } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, policyErrorResponse } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { getContext } = require('../observability/context');
const ReportArtifactRepository = require('../reporting/artifacts/ReportArtifactRepository');
const { createArtifactStorage } = require('../reporting/artifacts/config');
const {
  assertArtifactBytes,
  availabilityForReadError,
  contentDisposition,
} = require('../reporting/artifacts/artifactSecurity');
const { resolveReportAlias } = require('../reporting/reportAliasCatalog');
const { businessErrorPayload } = require('../reporting/reportBusinessErrors');

const router = express.Router();
const repository = new ReportArtifactRepository(db);

router.use(requireAuth, requirePermission(PERMISSIONS.REPORT_READ));

function positiveId(value) {
  return /^\d+$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : null;
}

function reportIdentity(row) {
  const resolution = resolveReportAlias(
    row.legacy_source || row.definition_code || row.report_type,
    { roundNo: row.round_no }
  );
  return {
    canonical_code: row.definition_code || resolution.canonical_code || null,
    legacy_source: row.legacy_source || resolution.legacy_source || null,
    legacy_alias_version: row.legacy_alias_version || (resolution.legacy_source ? resolution.mapping_version : null),
    deprecation: resolution.deprecation,
  };
}

function assertTicketScope(req, res, ownerId) {
  try {
    policyService.assert(req.user, PERMISSIONS.REPORT_READ, { context: { ownerId } });
    return true;
  } catch (error) {
    policyErrorResponse(res, error, req);
    return false;
  }
}

router.get('/', (req, res) => {
  const ticketId = positiveId(req.query.ticket_id);
  if (!ticketId) return res.status(400).json({ error: 'ticket_id_required' });
  const ticket = db.prepare('SELECT id, created_by FROM evaluation_tickets WHERE id=?').get(ticketId);
  if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
  if (!assertTicketScope(req, res, ticket.created_by)) return undefined;
  const items = repository.listForTicket(ticketId, req.query.limit).map((item) => ({
    export_id: item.export_id,
    job_id: item.job_id,
    artifact_id: item.artifact_id,
    ticket_id: item.ticket_id,
    round_id: item.round_id,
    report_type: item.report_type,
    ...reportIdentity(item),
    file_format: item.file_format,
    file_name: item.file_name,
    mime_type: item.mime_type,
    size_bytes: item.size_bytes,
    sha256: item.sha256,
    availability_status: item.availability_status,
    legacy_reconciliation_status: item.legacy_reconciliation_status,
    is_regenerated: !!item.is_regenerated,
    retention_class: item.retention_class,
    retain_until: item.retain_until,
    exported_by: item.exported_by,
    exported_at: item.exported_at,
    provenance: item.job_id ? {
      definition_code: item.definition_code,
      report_template_version_id: item.report_template_version_id,
      template_checksum: item.template_checksum,
      context_checksum: item.context_checksum,
      renderer_version: item.renderer_version,
      app_commit: item.app_commit,
      scoring_policy_version_id: item.scoring_policy_version_id,
      scoring_policy_checksum: item.scoring_policy_checksum,
      scoring_rules_marker: item.scoring_rules_marker,
      scoring_rules_checksum: item.scoring_rules_checksum,
      legacy_source: item.legacy_source || null,
      legacy_alias_version: item.legacy_alias_version || null,
    } : null,
    download_url: item.artifact_id && item.availability_status === 'AVAILABLE'
      ? `/qlcl/api/report-exports/${item.export_id}/download`
      : null,
    allowed_actions: item.artifact_id && item.availability_status === 'AVAILABLE' ? ['download'] : [],
    disabled_reasons: item.artifact_id && item.availability_status === 'AVAILABLE'
      ? {}
      : { download: item.availability_status === 'MISSING' ? 'artifact_missing' : 'artifact_unavailable' },
  }));
  return res.json({ items });
});

router.get('/jobs/:id', (req, res) => {
  const jobId = String(req.params.id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/.test(jobId)) {
    return res.status(404).json({ error: 'report_export_job_not_found' });
  }
  const job = db.prepare(`
    SELECT j.*, t.created_by AS ticket_created_by,
      a.id AS artifact_id, a.availability_status, e.id AS export_id
    FROM report_export_jobs j
    JOIN evaluation_tickets t ON t.id=j.ticket_id
    LEFT JOIN report_artifacts a ON a.job_id=j.id
    LEFT JOIN report_exports e ON e.job_id=j.id
    WHERE j.id=?
  `).get(jobId);
  if (!job) return res.status(404).json({ error: 'report_export_job_not_found' });
  if (!assertTicketScope(req, res, job.ticket_created_by)) return undefined;
  const downloadable = job.status === 'COMPLETED'
    && job.artifact_id
    && job.availability_status === 'AVAILABLE';
  return res.json({
    job_id: job.id,
    status: job.status,
    outcome: job.outcome,
    attempt_count: job.attempt_count,
    error_code: job.error_code,
    ticket_id: job.ticket_id,
    round_id: job.round_id,
    round_no: job.round_no,
    definition_code: job.definition_code,
    ...reportIdentity(job),
    report_template_version_id: job.report_template_version_id,
    template_checksum: job.template_checksum,
    data_contract_version: job.data_contract_version,
    context_checksum: job.context_checksum,
    renderer_version: job.renderer_version,
    app_commit: job.app_commit,
    scoring_policy_version_id: job.scoring_policy_version_id,
    scoring_policy_checksum: job.scoring_policy_checksum,
    scoring_rules_marker: job.scoring_rules_marker,
    scoring_rules_checksum: job.scoring_rules_checksum,
    file_format: job.file_format,
    requested_at: job.requested_at,
    generated_at: job.generated_at,
    completed_at: job.completed_at,
    artifact_id: job.artifact_id,
    export_id: job.export_id,
    availability_status: job.availability_status,
    download_url: downloadable ? `/qlcl/api/report-exports/${job.export_id}/download` : null,
    allowed_actions: downloadable ? ['download'] : [],
  });
});

router.get('/:id/download', (req, res) => {
  const exportId = positiveId(req.params.id);
  if (!exportId) return res.status(404).json({ error: 'export_not_found' });
  const record = repository.byExportId(exportId);
  if (!record) return res.status(404).json({ error: 'export_not_found' });
  if (!assertTicketScope(req, res, record.ticket_created_by)) return undefined;
  if (!record.id || !record.job_id) {
    const code = record.export_availability_status === 'MISSING' ? 'artifact_missing' : 'export_not_stored';
    return res.status(410).json({
      ...businessErrorPayload(code),
      availability_status: record.export_availability_status || 'LEGACY_UNASSESSED',
      reconciliation_status: record.legacy_reconciliation_status || 'UNASSESSED',
      ...reportIdentity(record),
    });
  }
  if (record.availability_status !== 'AVAILABLE') {
    return res.status(410).json({
      ...businessErrorPayload('artifact_unavailable'),
      availability_status: record.availability_status,
      ...reportIdentity(record),
    });
  }
  const context = getContext();
  const verifiedAt = new Date().toISOString();
  let storage;
  try {
    storage = createArtifactStorage({ db });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.code || 'report_storage_unavailable' });
  }
  if (storage.adapterName !== record.storage_adapter) {
    return res.status(503).json({ error: 'report_storage_adapter_mismatch' });
  }
  let buffer;
  try {
    buffer = storage.get(record.storage_key);
    assertArtifactBytes({
      buffer,
      format: record.file_format,
      mimeType: record.mime_type,
      sha256: record.sha256,
      sizeBytes: record.size_bytes,
    });
  } catch (error) {
    const status = availabilityForReadError(error);
    if (status) repository.markAvailability(record.id, status, verifiedAt);
    repository.event({
      jobId: record.job_id,
      artifactId: record.id,
      eventCode: 'ARTIFACT_DOWNLOAD_FAILED',
      actor: req.user.email,
      outcome: 'FAILURE',
      requestId: context.request_id || null,
      correlationId: context.correlation_id || null,
      metadata: { export_id: exportId, error_code: error.code || 'artifact_download_failed' },
      uniqueKey: `download-failed:${record.job_id}:${context.request_id || crypto.randomUUID()}`,
      at: verifiedAt,
    });
    return res.status(error.status || 410).json({ error: error.code || 'artifact_download_failed' });
  }
  try {
    repository.markAvailability(record.id, 'AVAILABLE', verifiedAt);
    repository.event({
      jobId: record.job_id,
      artifactId: record.id,
      eventCode: 'ARTIFACT_DOWNLOADED',
      actor: req.user.email,
      outcome: 'SUCCESS',
      requestId: context.request_id || null,
      correlationId: context.correlation_id || null,
      metadata: { export_id: exportId, source: 'history' },
      uniqueKey: `download:${record.job_id}:${context.request_id || crypto.randomUUID()}`,
      at: verifiedAt,
    });
  } catch (_) {
    return res.status(503).json({ error: 'artifact_access_audit_failed' });
  }
  res.setHeader('Content-Type', record.mime_type);
  res.setHeader('Content-Disposition', contentDisposition(record.file_name));
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Artifact-Id', String(record.id));
  res.setHeader('X-Artifact-SHA256', record.sha256);
  return res.send(buffer);
});

module.exports = router;
