'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { checksum, stableJson } = require('../reportUtils');
const ReportArtifactRepository = require('./ReportArtifactRepository');
const {
  CONTENT_TYPES,
  EXTENSIONS,
  artifactError,
  assertArtifactBytes,
  checksumBuffer,
  checksumText,
  normalizeStorageKey,
  safeFileName,
} = require('./artifactSecurity');
const { createArtifactStorage } = require('./config');
const {
  DATA_CONTRACT_VERSION,
  RENDERER_VERSION,
  RETENTION_CLASS,
  SCORING_RULES_CHECKSUM,
  SCORING_RULES_MARKER,
} = require('./ReportExportJobService');
const { resolveReportAlias } = require('../reportAliasCatalog');

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function asIso(value = new Date()) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

class LegacyReportArtifactReconciler {
  constructor({ db, legacyRoot, storage = null, env = process.env, now = () => new Date() }) {
    this.db = db;
    this.legacyRoot = path.resolve(legacyRoot);
    this.env = env;
    this.now = now;
    this.storage = storage;
    this.repository = new ReportArtifactRepository(db);
  }

  classify(row) {
    const raw = String(row.file_path || '');
    if (!raw || raw.includes('\0')) return { status: 'INVALID', candidate_path: null };
    let candidate;
    if (path.isAbsolute(raw)) candidate = path.resolve(raw);
    else {
      try { normalizeStorageKey(raw.replace(/\\/g, '/')); } catch (_) {
        return { status: 'INVALID', candidate_path: null };
      }
      candidate = path.resolve(this.legacyRoot, raw);
    }
    if (!within(this.legacyRoot, candidate)) return { status: 'OUTSIDE_ROOT', candidate_path: null };
    if (!fs.existsSync(candidate)) return { status: 'MISSING', candidate_path: candidate };
    let canonicalRoot;
    let canonicalCandidate;
    try {
      canonicalRoot = fs.realpathSync(this.legacyRoot);
      canonicalCandidate = fs.realpathSync(candidate);
    } catch (_) {
      return { status: 'INVALID', candidate_path: null };
    }
    if (!within(canonicalRoot, canonicalCandidate)) return { status: 'OUTSIDE_ROOT', candidate_path: null };
    if (!fs.statSync(canonicalCandidate).isFile()) return { status: 'MISSING', candidate_path: canonicalCandidate };
    return { status: 'IMPORTABLE', candidate_path: canonicalCandidate };
  }

  inspectLegacyRow(row) {
    const classified = this.classify(row);
    const result = {
      export_id: row.id,
      ticket_id: row.ticket_id,
      report_type: row.report_type,
      file_format: row.file_format,
      status: classified.status,
      path_hash: checksumText(String(row.file_path || '')),
      size_bytes: null,
      sha256: null,
      reason_code: null,
    };
    if (classified.status !== 'IMPORTABLE') return result;
    const format = String(row.file_format || '').toUpperCase();
    const mimeType = CONTENT_TYPES[format];
    if (!mimeType) return { ...result, status: 'INVALID', reason_code: 'report_format_not_supported' };
    try {
      const buffer = fs.readFileSync(classified.candidate_path);
      const integrity = assertArtifactBytes({ buffer, format, mimeType });
      return {
        ...result,
        size_bytes: integrity.size_bytes,
        sha256: integrity.sha256,
      };
    } catch (error) {
      return {
        ...result,
        status: 'INVALID',
        reason_code: error.code || 'report_artifact_verification_failed',
      };
    }
  }

  dryRunLegacyMapping() {
    const rows = this.db.prepare(`
      SELECT id, ticket_id, round_id, report_template_id, report_template_version_id,
        definition_code, report_type, file_format, file_path, exported_by,
        context_checksum, component_checksum, scoring_compatibility_marker,
        availability_status, legacy_reconciliation_status
      FROM report_exports
      WHERE artifact_id IS NULL
      ORDER BY id
    `).all();
    const items = rows.map((row) => this.inspectLegacyRow(row));
    const counts = items.reduce((result, item) => {
      result[item.status] = (result[item.status] || 0) + 1;
      return result;
    }, {});
    const inventoryChecksum = checksum(items.map((item) => ({
      export_id: item.export_id,
      status: item.status,
      path_hash: item.path_hash,
      size_bytes: item.size_bytes,
      sha256: item.sha256,
      reason_code: item.reason_code,
    })));
    return {
      mode: 'DRY_RUN',
      mutated: false,
      inventory_checksum: inventoryChecksum,
      counts,
      items,
    };
  }

  applyLegacyClassifications({ expectedInventoryChecksum } = {}) {
    const report = this.dryRunLegacyMapping();
    if (!expectedInventoryChecksum || expectedInventoryChecksum !== report.inventory_checksum) {
      throw artifactError('report_reconciliation_inventory_changed', 409);
    }
    const update = this.db.prepare(`
      UPDATE report_exports
      SET legacy_reconciliation_status=?, availability_status=?
      WHERE id=? AND artifact_id IS NULL
        AND (legacy_reconciliation_status<>? OR availability_status<>?)
    `);
    let updatedCount = 0;
    this.db.transaction(() => {
      for (const item of report.items) {
        const availability = item.status === 'MISSING' ? 'MISSING' : 'LEGACY_UNASSESSED';
        updatedCount += update.run(
          item.status,
          availability,
          item.export_id,
          item.status,
          availability
        ).changes;
      }
    })();
    return {
      ...report,
      mode: 'APPLY_CLASSIFICATIONS',
      mutated: true,
      updated_count: updatedCount,
    };
  }

  auditCanonicalProvenance() {
    const structural = {
      partial_export_links: this.db.prepare(`
        SELECT COUNT(*) AS n FROM report_exports
        WHERE (job_id IS NULL AND artifact_id IS NOT NULL)
           OR (job_id IS NOT NULL AND artifact_id IS NULL)
      `).get().n,
      export_link_mismatch: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM report_exports e
        LEFT JOIN report_export_jobs j ON j.id=e.job_id
        LEFT JOIN report_artifacts a ON a.id=e.artifact_id
        WHERE e.job_id IS NOT NULL AND e.artifact_id IS NOT NULL
          AND (j.id IS NULL OR a.id IS NULL OR a.job_id<>e.job_id)
      `).get().n,
      completed_job_bundle_mismatch: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM report_export_jobs j
        LEFT JOIN report_source_snapshots s ON s.job_id=j.id
        LEFT JOIN report_artifacts a ON a.job_id=j.id
        LEFT JOIN report_exports e ON e.job_id=j.id
        WHERE j.status='COMPLETED'
          AND (s.id IS NULL OR a.id IS NULL OR e.id IS NULL OR e.artifact_id<>a.id)
      `).get().n,
      artifact_job_not_completed: this.db.prepare(`
        SELECT COUNT(*) AS n
        FROM report_artifacts a
        LEFT JOIN report_export_jobs j ON j.id=a.job_id
        WHERE j.id IS NULL OR j.status<>'COMPLETED' OR j.outcome<>'SUCCESS'
      `).get().n,
      unavailable_canonical_artifact: this.db.prepare(`
        SELECT COUNT(*) AS n FROM report_artifacts WHERE availability_status<>'AVAILABLE'
      `).get().n,
    };
    const rows = this.db.prepare(`
      SELECT id, job_id, storage_adapter, storage_key, sha256, size_bytes,
        mime_type, file_format, availability_status
      FROM report_artifacts
      ORDER BY id
    `).all();
    const counts = {
      total: rows.length,
      verified: 0,
      missing: 0,
      checksum_mismatch: 0,
      size_mismatch: 0,
      signature_invalid: 0,
      content_type_invalid: 0,
      storage_adapter_mismatch: 0,
      other: 0,
    };
    let storage = this.storage;
    if (!storage && rows.length) {
      try {
        storage = createArtifactStorage({ db: this.db, env: this.env });
      } catch (_) {
        counts.other = rows.length;
      }
    }
    const verifiedMetadata = [];
    if (storage) {
      for (const row of rows) {
        if (row.storage_adapter !== storage.adapterName) {
          counts.storage_adapter_mismatch += 1;
          continue;
        }
        try {
          const buffer = storage.get(row.storage_key);
          assertArtifactBytes({
            buffer,
            format: row.file_format,
            mimeType: row.mime_type,
            sha256: row.sha256,
            sizeBytes: row.size_bytes,
          });
          counts.verified += 1;
          verifiedMetadata.push([row.id, row.job_id, row.sha256, row.size_bytes]);
        } catch (error) {
          const key = {
            report_artifact_missing: 'missing',
            report_artifact_checksum_mismatch: 'checksum_mismatch',
            report_artifact_size_mismatch: 'size_mismatch',
            report_artifact_signature_invalid: 'signature_invalid',
            report_artifact_content_type_invalid: 'content_type_invalid',
          }[error.code] || 'other';
          counts[key] += 1;
        }
      }
    }
    const structuralTotal = Object.values(structural).reduce((sum, value) => sum + Number(value || 0), 0);
    const byteFailures = counts.total - counts.verified;
    const hardFailureTotal = structuralTotal + byteFailures;
    return {
      status: hardFailureTotal === 0 ? 'PASS' : 'FAIL',
      counts,
      structural,
      hard_failures: {
        structural: structuralTotal,
        artifact_bytes: byteFailures,
        total: hardFailureTotal,
      },
      verified_metadata_checksum: checksum(verifiedMetadata),
    };
  }

  stage4dReport() {
    const legacy = this.dryRunLegacyMapping();
    const canonical = this.auditCanonicalProvenance();
    const cleanupBlockers = legacy.items.length;
    let status = 'READY_FOR_CLEANUP';
    if (canonical.status !== 'PASS') status = 'FAILED';
    else if (cleanupBlockers > 0) status = 'RECONCILIATION_COMPLETE_CLEANUP_DEFERRED';
    return {
      status,
      mutated: false,
      canonical,
      legacy,
      cleanup: {
        allowed: status === 'READY_FOR_CLEANUP',
        blocker_count: cleanupBlockers,
        migration_0029_created: false,
      },
    };
  }

  dryRunRetention({ asOf = new Date() } = {}) {
    const at = asIso(asOf);
    const items = this.db.prepare(`
      SELECT id AS artifact_id, job_id, retention_class, retain_until,
        availability_status, size_bytes
      FROM report_artifacts
      WHERE retain_until IS NOT NULL AND retain_until <= ?
      ORDER BY retain_until, id
    `).all(at);
    return {
      mode: 'DRY_RUN',
      mutated: false,
      as_of: at,
      purge_enabled: false,
      policy_decision: 'REPORT-001-PENDING',
      eligible_count: items.length,
      eligible_bytes: items.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0),
      items,
    };
  }

  repairLegacyExport(exportId, { actor = 'legacy-reconciliation', requestId = null, correlationId = null } = {}) {
    const row = this.db.prepare(`
      SELECT e.*, t.ticket_code, t.question_template_version_id, t.current_round_no,
        r.round_no, v.checksum AS version_checksum
      FROM report_exports e
      JOIN evaluation_tickets t ON t.id=e.ticket_id
      LEFT JOIN evaluation_rounds r ON r.id=e.round_id
      LEFT JOIN report_template_versions v ON v.id=e.report_template_version_id
      WHERE e.id=?
    `).get(Number(exportId));
    if (!row) throw artifactError('legacy_report_export_not_found', 404);
    if (row.artifact_id) return this.repository.byExportId(row.id);
    const classified = this.classify(row);
    if (classified.status !== 'IMPORTABLE') {
      this.db.prepare(`
        UPDATE report_exports
        SET legacy_reconciliation_status=?, availability_status=?
        WHERE id=? AND artifact_id IS NULL
      `).run(classified.status, classified.status === 'MISSING' ? 'MISSING' : 'LEGACY_UNASSESSED', row.id);
      throw artifactError(`legacy_report_${classified.status.toLowerCase()}`, 410);
    }
    const format = String(row.file_format || '').toUpperCase();
    const mimeType = CONTENT_TYPES[format];
    if (!mimeType) throw artifactError('report_format_not_supported', 400);
    const buffer = fs.readFileSync(classified.candidate_path);
    const integrity = assertArtifactBytes({ buffer, format, mimeType });
    const storage = this.storage || createArtifactStorage({ db: this.db, env: this.env });
    const requester = row.exported_by || actor;
    const idempotencyKey = `legacy-export:${row.id}`;
    const existing = this.repository.jobByIdempotency(requester, idempotencyKey);
    if (existing?.status === 'COMPLETED') return this.repository.byExportId(row.id);
    const at = asIso(this.now());
    const jobId = existing?.id || crypto.randomUUID();
    const roundNo = Number(row.round_no || row.current_round_no || 1);
    const alias = resolveReportAlias(row.report_type, { roundNo, env: this.env });
    const source = {
      legacy_export_id: row.id,
      ticket_id: row.ticket_id,
      ticket_code: row.ticket_code,
      round_id: row.round_id || null,
      round_no: roundNo,
      question_template_version_id: row.question_template_version_id || null,
      report_template_version_id: row.report_template_version_id || null,
      definition_code: row.definition_code || `LEGACY_${row.report_type}`,
      definition_version: 'LEGACY_EXPORT_V1',
      data_contract_version: DATA_CONTRACT_VERSION,
      context_checksum: row.context_checksum || checksum({ export_id: row.id, ticket_id: row.ticket_id, round_no: roundNo }),
      canonical_code: row.definition_code || alias.canonical_code || null,
      legacy_source: row.legacy_source || alias.legacy_source || null,
      legacy_alias_version: row.legacy_alias_version || (alias.legacy_source ? alias.mapping_version : null),
    };
    if (!existing) {
      this.db.prepare(`
        INSERT INTO report_export_jobs (
          id, idempotency_key, definition_code, definition_version,
          report_template_version_id, template_version_marker, template_checksum,
          ticket_id, round_id, round_no, file_format, data_contract_version,
          context_checksum, renderer_version, app_commit, scoring_policy_version_id,
          scoring_rules_marker, scoring_rules_checksum, requester_user_id,
          generator_id, request_id, correlation_id, execution_mode, status,
          outcome, attempt_count, requested_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LEGACY_UNKNOWN', NULL,
          ?, ?, ?, 'legacy-reconciliation', ?, ?, 'WORKER', 'RUNNING', 'PENDING', 1, ?, ?)
      `).run(
        jobId,
        idempotencyKey,
        source.definition_code,
        source.definition_version,
        row.report_template_version_id || null,
        row.report_template_version_id ? null : 'LEGACY_REPORT_TEMPLATE_V1',
        row.version_checksum || row.component_checksum || checksumText(`legacy-template:${row.report_template_id || row.report_type}`),
        row.ticket_id,
        row.round_id || null,
        roundNo,
        format,
        DATA_CONTRACT_VERSION,
        source.context_checksum,
        `${RENDERER_VERSION}:LEGACY_IMPORT`,
        SCORING_RULES_MARKER,
        SCORING_RULES_CHECKSUM,
        requester,
        requestId,
        correlationId,
        at,
        at
      );
      this.db.prepare(`
        UPDATE report_export_jobs SET legacy_source=?, legacy_alias_version=? WHERE id=?
      `).run(source.legacy_source, source.legacy_alias_version, jobId);
    }
    const storageKey = `legacy-imports/${row.id}/${integrity.sha256}.${EXTENSIONS[format]}`;
    storage.putAtomic({ storageKey, buffer, contentType: mimeType });
    const fileName = safeFileName(path.basename(classified.candidate_path), format);
    const completedAt = asIso(this.now());
    this.db.transaction(() => {
      const snapshotInfo = this.db.prepare(`
        INSERT INTO report_source_snapshots (
          job_id, ticket_id, round_id, round_no, question_template_version_id,
          report_template_version_id, definition_code, definition_version,
          data_contract_version, context_checksum, source_checksum,
          source_snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId, row.ticket_id, row.round_id || null, roundNo,
        row.question_template_version_id || null, row.report_template_version_id || null,
        source.definition_code, source.definition_version, DATA_CONTRACT_VERSION,
        source.context_checksum, checksum(source), stableJson(source), completedAt
      );
      const artifactInfo = this.db.prepare(`
        INSERT INTO report_artifacts (
          job_id, source_snapshot_id, storage_adapter, storage_key, sha256,
          size_bytes, mime_type, file_name, file_format, retention_class,
          availability_status, created_at, last_verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', ?, ?)
      `).run(
        jobId, Number(snapshotInfo.lastInsertRowid), storage.adapterName, storageKey,
        checksumBuffer(buffer), buffer.length, mimeType, fileName, format,
        RETENTION_CLASS, completedAt, completedAt
      );
      const artifactId = Number(artifactInfo.lastInsertRowid);
      this.db.prepare(`
        UPDATE report_exports
        SET job_id=?, artifact_id=?, file_path=?, availability_status='AVAILABLE',
          legacy_reconciliation_status='IMPORTED', legacy_source=?, legacy_alias_version=?
        WHERE id=? AND artifact_id IS NULL
      `).run(jobId, artifactId, storageKey, source.legacy_source, source.legacy_alias_version, row.id);
      this.db.prepare(`
        UPDATE report_export_jobs
        SET status='COMPLETED', outcome='SUCCESS', generated_at=?, completed_at=?
        WHERE id=?
      `).run(completedAt, completedAt, jobId);
      this.repository.event({
        jobId,
        artifactId,
        eventCode: 'LEGACY_ARTIFACT_IMPORTED',
        actor,
        outcome: 'SUCCESS',
        requestId,
        correlationId,
        metadata: { legacy_export_id: row.id, file_format: format },
        uniqueKey: `legacy-imported:${row.id}`,
        at: completedAt,
      });
    })();
    return this.repository.byExportId(row.id);
  }
}

module.exports = { LegacyReportArtifactReconciler };
