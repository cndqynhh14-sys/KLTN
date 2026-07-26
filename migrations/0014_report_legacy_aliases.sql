ALTER TABLE report_exports ADD COLUMN legacy_source TEXT;
ALTER TABLE report_exports ADD COLUMN legacy_alias_version TEXT;
ALTER TABLE report_export_jobs ADD COLUMN legacy_source TEXT;
ALTER TABLE report_export_jobs ADD COLUMN legacy_alias_version TEXT;

CREATE TABLE IF NOT EXISTS report_legacy_template_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_template_id INTEGER NOT NULL UNIQUE,
  legacy_source TEXT NOT NULL,
  canonical_definition_code TEXT NOT NULL,
  report_template_version_id INTEGER NOT NULL,
  mapping_version TEXT NOT NULL,
  decision_reference TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  FOREIGN KEY (legacy_template_id) REFERENCES report_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (canonical_definition_code) REFERENCES report_definitions(definition_code),
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id),
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_legacy_links_canonical
  ON report_legacy_template_links(canonical_definition_code, report_template_version_id);

CREATE TABLE IF NOT EXISTS report_legacy_migration_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_template_id INTEGER NOT NULL UNIQUE,
  legacy_source TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  proposed_canonical_code TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RESOLVED', 'REJECTED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  FOREIGN KEY (legacy_template_id) REFERENCES report_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (proposed_canonical_code) REFERENCES report_definitions(definition_code),
  FOREIGN KEY (resolved_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_legacy_review_status
  ON report_legacy_migration_review(status, legacy_source, id);

CREATE TRIGGER IF NOT EXISTS trg_report_legacy_link_immutable_update
BEFORE UPDATE ON report_legacy_template_links
BEGIN
  SELECT RAISE(ABORT, 'report_legacy_template_link_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_legacy_link_immutable_delete
BEFORE DELETE ON report_legacy_template_links
BEGIN
  SELECT RAISE(ABORT, 'report_legacy_template_link_immutable');
END;
