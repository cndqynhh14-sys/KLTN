CREATE TABLE IF NOT EXISTS report_definitions (
  definition_code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT,
  allowed_rounds_json TEXT NOT NULL,
  data_contract_version INTEGER NOT NULL DEFAULT 1 CHECK (data_contract_version > 0),
  component_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (component_schema_version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS report_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_code TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  version_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED')),
  definition_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  checksum TEXT,
  version_note TEXT,
  effective_from TEXT,
  effective_to TEXT,
  lock_version INTEGER NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  submitted_at TEXT,
  submitted_by TEXT,
  published_at TEXT,
  published_by TEXT,
  retired_at TEXT,
  retired_by TEXT,
  FOREIGN KEY (definition_code) REFERENCES report_definitions(definition_code),
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (submitted_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (published_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (retired_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (definition_code, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_report_template_versions_catalog
  ON report_template_versions(definition_code, status, version_no DESC);

CREATE TABLE IF NOT EXISTS report_template_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  definition_code TEXT NOT NULL,
  report_template_version_id INTEGER NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope_type IN ('GLOBAL', 'FACILITY', 'SUPPLIER_SCALE')),
  scope_key TEXT NOT NULL DEFAULT '*',
  effective_from TEXT,
  effective_to TEXT,
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  FOREIGN KEY (definition_code) REFERENCES report_definitions(definition_code),
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id),
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (report_template_version_id, scope_type, scope_key),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_report_template_assignments_resolve
  ON report_template_assignments(definition_code, scope_type, scope_key, active, is_default, effective_from, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_template_assignments_one_default
  ON report_template_assignments(definition_code, scope_type, scope_key)
  WHERE active = 1 AND is_default = 1;

CREATE TABLE IF NOT EXISTS report_template_version_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_template_version_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  before_json TEXT,
  after_json TEXT,
  request_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_template_version_events_version_time
  ON report_template_version_events(report_template_version_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_report_published_content_immutable
BEFORE UPDATE OF definition_code, version_no, version_name, definition_json,
  schema_version, checksum, version_note, effective_from, effective_to
ON report_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_report_template_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_published_delete_immutable
BEFORE DELETE ON report_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_report_template_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_template_event_append_only_update
BEFORE UPDATE ON report_template_version_events
BEGIN
  SELECT RAISE(ABORT, 'report_template_event_append_only');
END;

CREATE TRIGGER IF NOT EXISTS trg_report_template_event_append_only_delete
BEFORE DELETE ON report_template_version_events
BEGIN
  SELECT RAISE(ABORT, 'report_template_event_append_only');
END;

ALTER TABLE report_exports ADD COLUMN report_template_version_id INTEGER REFERENCES report_template_versions(id) ON DELETE SET NULL;
ALTER TABLE report_exports ADD COLUMN definition_code TEXT REFERENCES report_definitions(definition_code);
ALTER TABLE report_exports ADD COLUMN context_checksum TEXT;
ALTER TABLE report_exports ADD COLUMN component_checksum TEXT;
ALTER TABLE report_exports ADD COLUMN scoring_compatibility_marker TEXT;
CREATE INDEX IF NOT EXISTS idx_report_exports_template_version
  ON report_exports(report_template_version_id, exported_at DESC);
