-- RUN-11: extend the existing notification outbox without changing workflow data.
-- Idempotency continues to be enforced by UNIQUE(unique_key).
CREATE TABLE notifications_new (
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
    'INPUT_DOSSIER_ASSIGNED',
    'INPUT_DOSSIER_COMPLETED',
    'INPUT_DOSSIER_SUPPLEMENT_REQUESTED',
    'INPUT_DOSSIER_OUT_OF_POLICY_SUBMITTED',
    'INPUT_DOSSIER_CLOSED',
    'INPUT_DOSSIER_APPROVAL_APPROVED',
    'INPUT_DOSSIER_APPROVAL_REJECTED',
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

INSERT INTO notifications_new (
  id, receiver_user_id, sender_user_id, ticket_id, notification_type,
  title, message, payload_json, unique_key, is_read, read_at, created_at
)
SELECT id, receiver_user_id, sender_user_id, ticket_id, notification_type,
       title, message, payload_json, unique_key, is_read, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notifications_receiver_read_time
  ON notifications(receiver_user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_ticket
  ON notifications(ticket_id, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unique_key
  ON notifications(unique_key);
