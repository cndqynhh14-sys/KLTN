-- RUN-08: read/export authorization and report-only retention configuration.
-- Purge remains intentionally unavailable until OBS-01 is explicitly approved.

INSERT INTO permissions (permission_code, description, resource_type, action_code)
VALUES ('AUDIT.EXPORT', 'Export bounded and redacted audit records', 'AUDIT', 'EXPORT');

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT id, 'AUDIT.EXPORT', 'ALLOW'
FROM roles
WHERE role_code IN ('SYS_ADMIN', 'AUDITOR');

CREATE INDEX idx_audit_events_category_time
  ON audit_events(category, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_severity_time
  ON audit_events(severity, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_outcome_time
  ON audit_events(outcome, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_correlation
  ON audit_events(correlation_id, id);

CREATE TABLE audit_retention_policies (
  retention_class    TEXT PRIMARY KEY,
  categories_json    TEXT NOT NULL CHECK (json_valid(categories_json)),
  retention_days     INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 36500),
  purge_approved     INTEGER NOT NULL DEFAULT 0 CHECK (purge_approved IN (0, 1)),
  approval_reference TEXT NOT NULL DEFAULT 'OBS-01',
  config_version     INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_retention_policies
  (retention_class, categories_json, retention_days, purge_approved, approval_reference)
VALUES
  ('BUSINESS_RECORD', '["supplier","dossier","evaluation","approval","question","report","scoring","export","artifact"]', 2555, 0, 'OBS-01'),
  ('OPERATIONAL', '["import"]', 1095, 0, 'OBS-01'),
  ('SECURITY_CRITICAL', '["auth","authz","user","role","config","audit"]', 2555, 0, 'OBS-01'),
  ('UAT_EVIDENCE', '["uat"]', 365, 0, 'OBS-01');

CREATE TRIGGER audit_retention_policy_delete_guard
BEFORE DELETE ON audit_retention_policies
BEGIN
  SELECT RAISE(ABORT, 'audit_retention_policy_version_required');
END;
