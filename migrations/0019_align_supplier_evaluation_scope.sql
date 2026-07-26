-- Commit 2: remove persistence that belonged only to the retired input-dossier
-- and legacy dashboard-import features. Retained evaluation notifications are
-- copied into a narrowed table so normal startup never needs to repair it.

DELETE FROM approval_stage_assignments
WHERE workflow_type = 'INPUT_DOSSIER';

DELETE FROM role_permissions
WHERE permission_code = 'UPLOAD.MANAGE'
   OR permission_code LIKE 'INPUT_DOSSIER.%';

DELETE FROM permissions
WHERE permission_code = 'UPLOAD.MANAGE'
   OR permission_code LIKE 'INPUT_DOSSIER.%';

CREATE TABLE notifications_supplier_evaluation_scope (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  receiver_user_id   TEXT NOT NULL,
  sender_user_id     TEXT,
  ticket_id          INTEGER,
  notification_type  TEXT NOT NULL CHECK (notification_type IN (
    'REJECTED',
    'APPROVED',
    'REASSESSMENT_DUE',
    'EVALUATION_ASSIGNED',
    'EVALUATION_APPROVAL_ASSIGNED',
    'EVALUATION_APPROVED',
    'EVALUATION_REJECTED',
    'EVALUATION_DEADLINE',
    'SYSTEM_MAINTENANCE',
    'SYSTEM_INCIDENT'
  )),
  title              TEXT,
  message            TEXT NOT NULL,
  payload_json       TEXT,
  unique_key         TEXT,
  is_read            INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  read_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (receiver_user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  UNIQUE (unique_key)
);

INSERT INTO notifications_supplier_evaluation_scope (
  id, receiver_user_id, sender_user_id, ticket_id, notification_type,
  title, message, payload_json, unique_key, is_read, read_at, created_at
)
SELECT id, receiver_user_id, sender_user_id, ticket_id, notification_type,
       title, message, payload_json, unique_key, is_read, read_at, created_at
FROM notifications
WHERE notification_type IN (
  'REJECTED',
  'APPROVED',
  'REASSESSMENT_DUE',
  'EVALUATION_ASSIGNED',
  'EVALUATION_APPROVAL_ASSIGNED',
  'EVALUATION_APPROVED',
  'EVALUATION_REJECTED',
  'EVALUATION_DEADLINE',
  'SYSTEM_MAINTENANCE',
  'SYSTEM_INCIDENT'
);

DROP TABLE notifications;
ALTER TABLE notifications_supplier_evaluation_scope RENAME TO notifications;

CREATE INDEX idx_notifications_receiver_read_time
  ON notifications(receiver_user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_ticket
  ON notifications(ticket_id, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unique_key
  ON notifications(unique_key);

-- Input-dossier children are dropped before their parents.
DROP TABLE IF EXISTS input_dossier_review_errors;
DROP TABLE IF EXISTS input_dossier_email_logs;
DROP TABLE IF EXISTS input_dossier_approval_tasks;
DROP TABLE IF EXISTS input_dossier_workflow_history;
DROP TABLE IF EXISTS input_dossier_reviews;
DROP TABLE IF EXISTS input_dossier_export_logs;
DROP TABLE IF EXISTS input_dossier_items;
DROP TABLE IF EXISTS input_dossiers;

-- Legacy dashboard snapshots depend on upload_log, so upload_log is last.
DROP TABLE IF EXISTS ncc_documents;
DROP TABLE IF EXISTS ncc_evaluations;
DROP TABLE IF EXISTS monthly_overview;
DROP TABLE IF EXISTS ncc_documents_summary;
DROP TABLE IF EXISTS ncc_evaluations_summary;
DROP TABLE IF EXISTS ncc_violations_summary;
DROP TABLE IF EXISTS lab_tests_summary;
DROP TABLE IF EXISTS kph_incidents_summary;
DROP TABLE IF EXISTS qc_warehouse_summary;
DROP TABLE IF EXISTS qc_warehouse_top_ncc;
DROP TABLE IF EXISTS upload_log;
DROP TABLE IF EXISTS thresholds;

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES (
  'MIGRATION_APPLIED',
  'MIGRATION',
  '0019_align_supplier_evaluation_scope',
  json_object(
    'removed_permission_codes', json_array(
      'UPLOAD.MANAGE',
      'INPUT_DOSSIER.READ',
      'INPUT_DOSSIER.WRITE',
      'INPUT_DOSSIER.APPROVE_TBP',
      'INPUT_DOSSIER.APPROVE_GDK'
    ),
    'retained_workflow_type', 'EVALUATION'
  )
);
