-- Phase 4: atomic, evaluation-only work transfer before account deactivation.
-- Email references remain as compatibility projections; user_id is canonical.

CREATE TABLE work_transfers (
  transfer_id          TEXT PRIMARY KEY,
  from_user_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  to_user_id           TEXT REFERENCES users(user_id) ON DELETE RESTRICT,
  from_email_snapshot  TEXT NOT NULL,
  to_email_snapshot    TEXT,
  reason               TEXT NOT NULL,
  created_by_user_id   TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  status               TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
  idempotency_key      TEXT NOT NULL,
  request_sha256       TEXT NOT NULL,
  workload_before_json TEXT NOT NULL CHECK (json_valid(workload_before_json)),
  workload_after_json  TEXT CHECK (workload_after_json IS NULL OR json_valid(workload_after_json)),
  request_id           TEXT,
  correlation_id       TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at         TEXT,
  CHECK (to_user_id IS NULL OR to_user_id != from_user_id),
  UNIQUE (created_by_user_id, idempotency_key)
);

CREATE TABLE work_transfer_items (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id               TEXT NOT NULL REFERENCES work_transfers(transfer_id) ON DELETE RESTRICT,
  entity_type               TEXT NOT NULL CHECK (entity_type IN (
    'EVALUATION_TICKET',
    'EVALUATION_APPROVAL_TASK',
    'APPROVAL_STAGE_ASSIGNMENT'
  )),
  entity_id                 TEXT NOT NULL,
  previous_assignee_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  new_assignee_user_id      TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  required_permission       TEXT NOT NULL,
  before_json               TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json                TEXT NOT NULL CHECK (json_valid(after_json)),
  transferred_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (transfer_id, entity_type, entity_id)
);

CREATE INDEX idx_work_transfers_from_time ON work_transfers(from_user_id, created_at DESC);
CREATE INDEX idx_work_transfers_to_time ON work_transfers(to_user_id, created_at DESC);
CREATE INDEX idx_work_transfer_items_transfer ON work_transfer_items(transfer_id, id);

CREATE TRIGGER work_transfers_completed_immutable
BEFORE UPDATE ON work_transfers
WHEN NOT (
  OLD.status = 'PENDING' AND NEW.status = 'COMPLETED'
  AND OLD.transfer_id = NEW.transfer_id
  AND OLD.from_user_id = NEW.from_user_id
  AND COALESCE(OLD.to_user_id, '') = COALESCE(NEW.to_user_id, '')
  AND OLD.from_email_snapshot = NEW.from_email_snapshot
  AND COALESCE(OLD.to_email_snapshot, '') = COALESCE(NEW.to_email_snapshot, '')
  AND OLD.reason = NEW.reason
  AND OLD.created_by_user_id = NEW.created_by_user_id
  AND OLD.idempotency_key = NEW.idempotency_key
  AND OLD.request_sha256 = NEW.request_sha256
  AND OLD.workload_before_json = NEW.workload_before_json
  AND NEW.workload_after_json IS NOT NULL
  AND COALESCE(OLD.request_id, '') = COALESCE(NEW.request_id, '')
  AND COALESCE(OLD.correlation_id, '') = COALESCE(NEW.correlation_id, '')
  AND OLD.created_at = NEW.created_at
  AND NEW.completed_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'work_transfer_immutable'); END;

CREATE TRIGGER work_transfers_no_delete
BEFORE DELETE ON work_transfers
BEGIN SELECT RAISE(ABORT, 'work_transfer_immutable'); END;

CREATE TRIGGER work_transfer_items_no_update
BEFORE UPDATE ON work_transfer_items
BEGIN SELECT RAISE(ABORT, 'work_transfer_item_immutable'); END;

CREATE TRIGGER work_transfer_items_no_delete
BEFORE DELETE ON work_transfer_items
BEGIN SELECT RAISE(ABORT, 'work_transfer_item_immutable'); END;

-- Defense in depth: direct SQL and legacy DELETE paths cannot leave active work
-- assigned to an inactive account. Historical/completed evaluations are excluded.
CREATE TRIGGER users_open_evaluation_work_deactivation_guard
BEFORE UPDATE OF is_active ON users
WHEN OLD.is_active = 1 AND NEW.is_active = 0 AND (
  EXISTS (
    SELECT 1 FROM evaluation_tickets t
    WHERE t.source_kind = 'NATIVE' AND t.is_deleted = 0
      AND t.current_status NOT IN ('Hoàn thành', 'Hủy')
      AND (
        t.assigned_specialist_user_id = OLD.user_id
        OR EXISTS (
          SELECT 1 FROM evaluation_participants p
          LEFT JOIN evaluation_rounds er ON er.id = p.round_id
          WHERE p.active = 1
            AND (p.principal_id = OLD.user_id OR (p.principal_id IS NULL AND lower(p.user_id) = lower(OLD.email)))
            AND p.participant_role IN ('OWNER', 'EVALUATOR')
            AND (p.ticket_id = t.id OR (er.ticket_id = t.id AND er.completed_at IS NULL))
        )
      )
  ) OR EXISTS (
    SELECT 1 FROM approval_tasks a
    JOIN evaluation_tickets t ON t.id = a.ticket_id
    WHERE a.assigned_principal_id = OLD.user_id AND a.status = 'PENDING'
      AND t.source_kind = 'NATIVE' AND t.is_deleted = 0
      AND t.current_status NOT IN ('Hoàn thành', 'Hủy')
  ) OR EXISTS (
    SELECT 1 FROM approval_stage_assignments
    WHERE workflow_type = 'EVALUATION'
      AND assigned_principal_id = OLD.user_id AND active = 1
      AND (valid_from IS NULL OR valid_from <= datetime('now'))
      AND (valid_until IS NULL OR valid_until > datetime('now'))
  )
)
BEGIN SELECT RAISE(ABORT, 'work_transfer_required'); END;

INSERT INTO authz_change_log
  (change_type, object_type, object_key, after_json, reason)
VALUES
  ('MIGRATION_APPLIED', 'WORK_TRANSFER', '0036_evaluation_work_transfers',
   json_object('evaluation_only', 1, 'identity_key', 'user_id', 'append_only_ledger', 1),
   'Phase 4 atomic evaluation work transfer and offboarding');
