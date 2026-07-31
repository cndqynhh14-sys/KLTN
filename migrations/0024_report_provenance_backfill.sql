UPDATE report_exports
SET artifact_id = (
      SELECT a.id FROM report_artifacts a WHERE a.job_id = report_exports.job_id
    ),
    report_template_version_id = COALESCE(
      report_template_version_id,
      (SELECT j.report_template_version_id FROM report_export_jobs j
       WHERE j.id = report_exports.job_id)
    ),
    definition_code = COALESCE(
      definition_code,
      (SELECT j.definition_code FROM report_export_jobs j
       WHERE j.id = report_exports.job_id)
    ),
    context_checksum = COALESCE(
      context_checksum,
      (SELECT j.context_checksum FROM report_export_jobs j
       WHERE j.id = report_exports.job_id)
    ),
    scoring_policy_version_id = COALESCE(
      scoring_policy_version_id,
      CAST((SELECT j.scoring_policy_version_id FROM report_export_jobs j
            WHERE j.id = report_exports.job_id) AS INTEGER)
    ),
    availability_status = CASE
      WHEN EXISTS (SELECT 1 FROM report_artifacts a WHERE a.job_id = report_exports.job_id)
        THEN 'AVAILABLE'
      ELSE availability_status
    END,
    legacy_reconciliation_status = CASE
      WHEN EXISTS (SELECT 1 FROM report_artifacts a WHERE a.job_id = report_exports.job_id)
        THEN 'IMPORTED'
      ELSE legacy_reconciliation_status
    END
WHERE job_id IS NOT NULL;

UPDATE report_exports
SET job_id = (SELECT a.job_id FROM report_artifacts a WHERE a.id = report_exports.artifact_id)
WHERE job_id IS NULL AND artifact_id IS NOT NULL;

CREATE INDEX idx_report_exports_provenance_status
  ON report_exports(legacy_reconciliation_status, availability_status, exported_at DESC);
CREATE INDEX idx_report_source_snapshots_ticket_round
  ON report_source_snapshots(ticket_id, round_id, created_at DESC);
CREATE INDEX idx_report_artifacts_job_availability
  ON report_artifacts(job_id, availability_status);
