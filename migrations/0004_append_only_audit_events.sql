-- RUN-07: durable append-only, tamper-evident audit event chain.
-- The hash chain detects modification; it is intentionally not described as tamper-proof.
CREATE TABLE audit_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at      TEXT NOT NULL,
  catalog_version  TEXT NOT NULL,
  category         TEXT NOT NULL CHECK (category IN (
    'auth', 'authz', 'user', 'role', 'supplier', 'dossier', 'evaluation',
    'approval', 'question', 'report', 'scoring', 'import', 'export',
    'artifact', 'config', 'audit', 'uat'
  )),
  event_name       TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'HIGH', 'CRITICAL')),
  actor_user_id    TEXT,
  actor_roles_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(actor_roles_json)),
  request_id       TEXT,
  correlation_id   TEXT,
  uat_run_id       TEXT,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT,
  action           TEXT NOT NULL,
  outcome          TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'DENIED', 'DEGRADED')),
  reason_code      TEXT,
  summary          TEXT NOT NULL,
  metadata_json    TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  idempotency_key  TEXT UNIQUE,
  previous_hash    TEXT NOT NULL CHECK (length(previous_hash) = 64),
  event_hash       TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64)
);

CREATE INDEX idx_audit_events_request ON audit_events(request_id, id);
CREATE INDEX idx_audit_events_actor_time ON audit_events(actor_user_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_entity_time ON audit_events(entity_type, entity_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_name_time ON audit_events(event_name, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_uat_run ON audit_events(uat_run_id, id) WHERE uat_run_id IS NOT NULL;

CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;

CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;
