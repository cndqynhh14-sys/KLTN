-- RUN-15: two-phase question workbook import into Draft versions only.

ALTER TABLE question_items ADD COLUMN variant_code TEXT;
ALTER TABLE question_items ADD COLUMN category_code TEXT;
ALTER TABLE question_items ADD COLUMN clause_code TEXT;

CREATE INDEX idx_question_items_stable_codes
  ON question_items(question_template_version_id, variant_code, category_code, clause_code);

CREATE TABLE question_import_batches (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id                TEXT NOT NULL UNIQUE,
  template_id              INTEGER NOT NULL,
  target_version_id        INTEGER NOT NULL,
  source_format            TEXT NOT NULL CHECK (source_format IN ('CANONICAL', 'LEGACY_BM')),
  original_filename        TEXT NOT NULL,
  mime_type                TEXT NOT NULL,
  file_size                INTEGER NOT NULL CHECK (file_size > 0),
  source_sha256            TEXT NOT NULL CHECK (length(source_sha256) = 64),
  status                   TEXT NOT NULL CHECK (status IN ('PREVIEWED', 'VALID', 'COMMITTED', 'ROLLED_BACK', 'FAILED')),
  acceptance_status        TEXT CHECK (acceptance_status IN ('VALID', 'PARTIAL_ACCEPTED')),
  total_rows               INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows               INTEGER NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  invalid_rows             INTEGER NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  duplicate_rows           INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  added_count              INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  changed_count            INTEGER NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  removed_count            INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  unchanged_count          INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  confirmation_token_hash  TEXT NOT NULL CHECK (length(confirmation_token_hash) = 64),
  normalized_items_json    TEXT NOT NULL,
  snapshot_items_json      TEXT NOT NULL,
  snapshot_checksum        TEXT NOT NULL CHECK (length(snapshot_checksum) = 64),
  expected_lock_version    INTEGER NOT NULL CHECK (expected_lock_version > 0),
  committed_lock_version   INTEGER,
  idempotency_key          TEXT,
  created_by               TEXT,
  committed_by             TEXT,
  rolled_back_by           TEXT,
  request_id               TEXT,
  correlation_id           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at             TEXT,
  rolled_back_at           TEXT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id),
  FOREIGN KEY (target_version_id) REFERENCES question_template_versions(id),
  UNIQUE (target_version_id, idempotency_key)
);

CREATE INDEX idx_question_import_batches_version_time
  ON question_import_batches(target_version_id, created_at DESC, id DESC);
CREATE INDEX idx_question_import_batches_source_hash
  ON question_import_batches(source_sha256);

CREATE TABLE question_import_rows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL,
  sheet_name      TEXT NOT NULL,
  row_number      INTEGER NOT NULL CHECK (row_number > 0),
  column_name     TEXT,
  stable_key      TEXT,
  row_status      TEXT NOT NULL CHECK (row_status IN ('VALID', 'INVALID', 'DUPLICATE')),
  error_code      TEXT,
  item_hash       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES question_import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_question_import_rows_batch_status
  ON question_import_rows(batch_id, row_status, row_number);

CREATE TABLE question_import_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL,
  stable_key      TEXT NOT NULL,
  change_type     TEXT NOT NULL CHECK (change_type IN ('ADDED', 'CHANGED', 'REMOVED', 'UNCHANGED', 'DUPLICATE', 'INVALID')),
  sheet_name      TEXT,
  row_number      INTEGER,
  before_hash     TEXT,
  after_hash      TEXT,
  before_json     TEXT,
  after_json      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES question_import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_question_import_changes_batch_type
  ON question_import_changes(batch_id, change_type, id);

CREATE TABLE question_import_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL,
  action          TEXT NOT NULL,
  actor_user_id   TEXT,
  metadata_json   TEXT,
  request_id      TEXT,
  correlation_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES question_import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_question_import_events_batch_time
  ON question_import_events(batch_id, created_at, id);

CREATE TRIGGER question_import_rows_append_only_update
BEFORE UPDATE ON question_import_rows BEGIN
  SELECT RAISE(ABORT, 'question_import_rows_append_only');
END;
CREATE TRIGGER question_import_rows_append_only_delete
BEFORE DELETE ON question_import_rows BEGIN
  SELECT RAISE(ABORT, 'question_import_rows_append_only');
END;
CREATE TRIGGER question_import_changes_append_only_update
BEFORE UPDATE ON question_import_changes BEGIN
  SELECT RAISE(ABORT, 'question_import_changes_append_only');
END;
CREATE TRIGGER question_import_changes_append_only_delete
BEFORE DELETE ON question_import_changes BEGIN
  SELECT RAISE(ABORT, 'question_import_changes_append_only');
END;
CREATE TRIGGER question_import_events_append_only_update
BEFORE UPDATE ON question_import_events BEGIN
  SELECT RAISE(ABORT, 'question_import_events_append_only');
END;
CREATE TRIGGER question_import_events_append_only_delete
BEFORE DELETE ON question_import_events BEGIN
  SELECT RAISE(ABORT, 'question_import_events_append_only');
END;
CREATE TRIGGER question_import_batches_no_delete
BEFORE DELETE ON question_import_batches BEGIN
  SELECT RAISE(ABORT, 'question_import_batches_append_only');
END;
CREATE TRIGGER question_import_batches_immutable_metadata
BEFORE UPDATE ON question_import_batches
WHEN OLD.public_id IS NOT NEW.public_id
  OR OLD.template_id IS NOT NEW.template_id
  OR OLD.target_version_id IS NOT NEW.target_version_id
  OR OLD.source_format IS NOT NEW.source_format
  OR OLD.original_filename IS NOT NEW.original_filename
  OR OLD.mime_type IS NOT NEW.mime_type
  OR OLD.file_size IS NOT NEW.file_size
  OR OLD.source_sha256 IS NOT NEW.source_sha256
  OR OLD.confirmation_token_hash IS NOT NEW.confirmation_token_hash
  OR OLD.normalized_items_json IS NOT NEW.normalized_items_json
  OR OLD.snapshot_items_json IS NOT NEW.snapshot_items_json
  OR OLD.snapshot_checksum IS NOT NEW.snapshot_checksum
  OR OLD.expected_lock_version IS NOT NEW.expected_lock_version
BEGIN
  SELECT RAISE(ABORT, 'question_import_batch_metadata_immutable');
END;
