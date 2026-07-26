-- PROMPT-06: durable commit/idempotency ledger for personnel imports.
-- Raw workbooks and normalized personnel rows remain ephemeral and are never persisted here.

CREATE TABLE personnel_import_batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id          TEXT NOT NULL UNIQUE,
  actor_user_id      TEXT NOT NULL,
  source_sha256      TEXT NOT NULL CHECK (length(source_sha256) = 64),
  plan_sha256        TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  request_sha256     TEXT NOT NULL CHECK (length(request_sha256) = 64),
  idempotency_key    TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('COMMITTED')),
  mapping_json       TEXT NOT NULL CHECK (json_valid(mapping_json)),
  summary_json       TEXT NOT NULL CHECK (json_valid(summary_json)),
  diagnostics_json   TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  reason             TEXT NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  request_id         TEXT,
  correlation_id     TEXT,
  created_at         TEXT NOT NULL,
  committed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE RESTRICT,
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX idx_personnel_import_batches_actor_time
  ON personnel_import_batches(actor_user_id, committed_at DESC, id DESC);
CREATE INDEX idx_personnel_import_batches_source_hash
  ON personnel_import_batches(source_sha256);

CREATE TRIGGER personnel_import_batches_append_only_update
BEFORE UPDATE ON personnel_import_batches BEGIN
  SELECT RAISE(ABORT, 'personnel_import_batches_append_only');
END;

CREATE TRIGGER personnel_import_batches_append_only_delete
BEFORE DELETE ON personnel_import_batches BEGIN
  SELECT RAISE(ABORT, 'personnel_import_batches_append_only');
END;
