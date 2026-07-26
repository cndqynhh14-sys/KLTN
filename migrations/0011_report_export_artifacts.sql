CREATE TABLE IF NOT EXISTS report_export_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  definition_code TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  report_template_version_id INTEGER,
  template_version_marker TEXT,
  template_checksum TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  round_id INTEGER,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  file_format TEXT NOT NULL CHECK (file_format IN ('HTML', 'PDF', 'XLSX')),
  data_contract_version INTEGER NOT NULL CHECK (data_contract_version > 0),
  context_checksum TEXT,
  renderer_version TEXT NOT NULL,
  app_commit TEXT NOT NULL,
  scoring_policy_version_id TEXT,
  scoring_rules_marker TEXT,
  scoring_rules_checksum TEXT,
  requester_user_id TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  request_id TEXT,
  correlation_id TEXT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('INLINE', 'WORKER')),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  outcome TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (outcome IN ('PENDING', 'SUCCESS', 'FAILURE', 'CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  generated_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  regenerate_of_artifact_id INTEGER,
  regeneration_reason TEXT,
  regeneration_policy TEXT,
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (regenerate_of_artifact_id) REFERENCES report_artifacts(id) ON DELETE SET NULL,
  UNIQUE (requester_user_id, idempotency_key),
  CHECK (
    (report_template_version_id IS NOT NULL AND template_version_marker IS NULL)
    OR (report_template_version_id IS NULL AND template_version_marker IS NOT NULL)
  ),
  CHECK (
    (scoring_policy_version_id IS NOT NULL AND scoring_rules_marker IS NULL)
    OR (
      scoring_policy_version_id IS NULL
      AND scoring_rules_marker = 'LEGACY_RULES_V1'
      AND scoring_rules_checksum IS NOT NULL
    )
  ),
  CHECK (
    regenerate_of_artifact_id IS NULL
    OR (length(trim(regeneration_reason)) >= 8 AND length(trim(regeneration_policy)) >= 3)
  )
);
CREATE INDEX IF NOT EXISTS idx_report_export_jobs_status_time
  ON report_export_jobs(status, requested_at, id);
CREATE INDEX IF NOT EXISTS idx_report_export_jobs_ticket_time
  ON report_export_jobs(ticket_id, requested_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS report_source_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  ticket_id INTEGER NOT NULL,
  round_id INTEGER,
  round_no INTEGER NOT NULL,
  question_template_version_id INTEGER,
  report_template_version_id INTEGER,
  definition_code TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  data_contract_version INTEGER NOT NULL,
  context_checksum TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES report_export_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE SET NULL,
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS report_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  source_snapshot_id INTEGER NOT NULL,
  storage_adapter TEXT NOT NULL CHECK (storage_adapter IN ('LOCAL', 'OBJECT')),
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  mime_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_format TEXT NOT NULL CHECK (file_format IN ('HTML', 'PDF', 'XLSX')),
  retention_class TEXT NOT NULL,
  retain_until TEXT,
  availability_status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (availability_status IN ('AVAILABLE', 'MISSING', 'QUARANTINED', 'DELETED')),
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  regenerated_from_artifact_id INTEGER,
  FOREIGN KEY (job_id) REFERENCES report_export_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_snapshot_id) REFERENCES report_source_snapshots(id),
  FOREIGN KEY (regenerated_from_artifact_id) REFERENCES report_artifacts(id) ON DELETE SET NULL,
  CHECK (
    substr(storage_key, 1, 1) NOT IN ('/', char(92))
    AND instr(storage_key, '..') = 0
    AND instr(storage_key, ':') = 0
    AND instr(storage_key, char(92)) = 0
  ),
  CHECK (
    instr(file_name, '/') = 0
    AND instr(file_name, char(92)) = 0
    AND instr(file_name, char(10)) = 0
    AND instr(file_name, char(13)) = 0
  ),
  CHECK (
    (file_format = 'HTML' AND mime_type = 'text/html; charset=utf-8')
    OR (file_format = 'PDF' AND mime_type = 'application/pdf')
    OR (file_format = 'XLSX' AND mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  )
);
CREATE INDEX IF NOT EXISTS idx_report_artifacts_availability_retention
  ON report_artifacts(availability_status, retain_until, id);

CREATE TABLE IF NOT EXISTS report_artifact_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  artifact_id INTEGER,
  event_code TEXT NOT NULL,
  actor_user_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  request_id TEXT,
  correlation_id TEXT,
  metadata_json TEXT,
  unique_event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES report_export_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES report_artifacts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_artifact_events_job_time
  ON report_artifact_events(job_id, created_at, id);

ALTER TABLE report_exports ADD COLUMN job_id TEXT REFERENCES report_export_jobs(id) ON DELETE SET NULL;
ALTER TABLE report_exports ADD COLUMN artifact_id INTEGER REFERENCES report_artifacts(id) ON DELETE SET NULL;
ALTER TABLE report_exports ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'LEGACY_UNASSESSED'
  CHECK (availability_status IN ('AVAILABLE', 'MISSING', 'QUARANTINED', 'DELETED', 'LEGACY_UNASSESSED'));
ALTER TABLE report_exports ADD COLUMN legacy_reconciliation_status TEXT NOT NULL DEFAULT 'UNASSESSED'
  CHECK (legacy_reconciliation_status IN ('UNASSESSED', 'IMPORTABLE', 'IMPORTED', 'MISSING', 'OUTSIDE_ROOT', 'INVALID'));
ALTER TABLE report_exports ADD COLUMN is_regenerated INTEGER NOT NULL DEFAULT 0 CHECK (is_regenerated IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_exports_job ON report_exports(job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_exports_artifact ON report_exports(artifact_id) WHERE artifact_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_report_source_snapshot_immutable_update
BEFORE UPDATE ON report_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'report_source_snapshot_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_source_snapshot_immutable_delete
BEFORE DELETE ON report_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'report_source_snapshot_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_artifact_identity_immutable
BEFORE UPDATE OF job_id, source_snapshot_id, storage_adapter, storage_key,
  sha256, size_bytes, mime_type, file_name, file_format, created_at
ON report_artifacts
BEGIN
  SELECT RAISE(ABORT, 'report_artifact_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_artifact_event_append_only_update
BEFORE UPDATE ON report_artifact_events
BEGIN
  SELECT RAISE(ABORT, 'report_artifact_event_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_artifact_event_append_only_delete
BEFORE DELETE ON report_artifact_events
BEGIN
  SELECT RAISE(ABORT, 'report_artifact_event_append_only');
END;
