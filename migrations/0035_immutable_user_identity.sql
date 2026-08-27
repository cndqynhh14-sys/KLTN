-- Phase 3: introduce an immutable technical identity without changing the
-- meaning of legacy email-backed columns during the compatibility window.

ALTER TABLE users ADD COLUMN user_id TEXT;

UPDATE users
SET user_id = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
)
WHERE user_id IS NULL;

CREATE UNIQUE INDEX idx_users_user_id_unique ON users(user_id);

CREATE TRIGGER users_assign_immutable_id
AFTER INSERT ON users
WHEN NEW.user_id IS NULL
BEGIN
  UPDATE users
  SET user_id = lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )
  WHERE email = NEW.email;
END;

CREATE TRIGGER users_user_id_immutable
BEFORE UPDATE OF user_id ON users
WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
BEGIN
  SELECT RAISE(ABORT, 'user_id_immutable');
END;

-- RBAC and session identity. The old user_id columns remain email-backed until
-- every consumer has completed the compatibility cutover.
ALTER TABLE user_roles ADD COLUMN principal_id TEXT REFERENCES users(user_id);
ALTER TABLE user_scope_assignments ADD COLUMN principal_id TEXT REFERENCES users(user_id);
ALTER TABLE auth_sessions ADD COLUMN principal_id TEXT REFERENCES users(user_id);
ALTER TABLE authz_change_log ADD COLUMN actor_principal_id TEXT REFERENCES users(user_id);
ALTER TABLE authz_change_log ADD COLUMN target_principal_id TEXT REFERENCES users(user_id);

-- Principal backfill does not change effective authorization. Suspend the two
-- broad UPDATE triggers so it does not bump authz_version or revoke sessions.
DROP TRIGGER user_roles_version_update;
DROP TRIGGER user_scopes_version_update;

UPDATE user_roles
SET principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(user_roles.user_id));
UPDATE user_scope_assignments
SET principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(user_scope_assignments.user_id));
UPDATE auth_sessions
SET principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(auth_sessions.user_id));
UPDATE authz_change_log
SET actor_principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(authz_change_log.actor_user_id)),
    target_principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(authz_change_log.target_user_id));

CREATE TRIGGER user_roles_version_update
AFTER UPDATE OF user_id, role_id, active, valid_from, valid_until, source ON user_roles
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
    WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;
CREATE TRIGGER user_scopes_version_update
AFTER UPDATE OF user_id, role_id, scope_type, scope_value, effect, active, valid_from, valid_until,
  custom_schema_code, custom_schema_version, source ON user_scope_assignments
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
    WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;

CREATE INDEX idx_user_roles_principal_active ON user_roles(principal_id, active, role_id);
CREATE INDEX idx_user_scopes_principal_active ON user_scope_assignments(principal_id, active, role_id);
CREATE INDEX idx_auth_sessions_principal ON auth_sessions(principal_id, expires_at);
CREATE INDEX idx_authz_change_actor_principal ON authz_change_log(actor_principal_id, created_at DESC);
CREATE INDEX idx_authz_change_target_principal ON authz_change_log(target_principal_id, created_at DESC);

CREATE TRIGGER user_roles_sync_principal_insert
AFTER INSERT ON user_roles
WHEN NEW.principal_id IS NULL
BEGIN
  UPDATE user_roles SET principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id))
  WHERE id = NEW.id;
END;
CREATE TRIGGER user_roles_sync_principal_update
AFTER UPDATE OF user_id ON user_roles
BEGIN
  UPDATE user_roles SET principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id))
  WHERE id = NEW.id;
END;

CREATE TRIGGER user_scopes_sync_principal_insert
AFTER INSERT ON user_scope_assignments
WHEN NEW.principal_id IS NULL
BEGIN
  UPDATE user_scope_assignments SET principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id))
  WHERE id = NEW.id;
END;
CREATE TRIGGER user_scopes_sync_principal_update
AFTER UPDATE OF user_id ON user_scope_assignments
BEGIN
  UPDATE user_scope_assignments SET principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id))
  WHERE id = NEW.id;
END;

CREATE TRIGGER auth_sessions_sync_principal_insert
AFTER INSERT ON auth_sessions
WHEN NEW.principal_id IS NULL
BEGIN
  UPDATE auth_sessions SET principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id))
  WHERE session_id = NEW.session_id;
END;

CREATE TRIGGER authz_change_sync_principal_insert
AFTER INSERT ON authz_change_log
BEGIN
  UPDATE authz_change_log
  SET actor_principal_id = COALESCE(NEW.actor_principal_id,
        (SELECT user_id FROM users WHERE lower(email) = lower(NEW.actor_user_id))),
      target_principal_id = COALESCE(NEW.target_principal_id,
        (SELECT user_id FROM users WHERE lower(email) = lower(NEW.target_user_id)))
  WHERE id = NEW.id;
END;

-- Audit events remain append-only. Temporarily suspend only the update guard
-- inside this transaction to backfill the new reference, then restore it.
ALTER TABLE audit_events ADD COLUMN actor_principal_id TEXT REFERENCES users(user_id);
DROP TRIGGER audit_events_append_only_update;
UPDATE audit_events
SET actor_principal_id = (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(audit_events.actor_user_id));
CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;
CREATE INDEX idx_audit_events_actor_principal_time
  ON audit_events(actor_principal_id, occurred_at DESC, id DESC);

-- Evaluation/workflow identity references. Email columns stay intact for
-- display and backward-compatible joins; these columns carry stable identity.
ALTER TABLE evaluation_tickets ADD COLUMN assigned_specialist_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_tickets ADD COLUMN created_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_tickets ADD COLUMN updated_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_tickets ADD COLUMN deleted_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_tickets ADD COLUMN cancelled_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_participants ADD COLUMN principal_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_participants ADD COLUMN assigned_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_rounds ADD COLUMN locked_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_answers ADD COLUMN answered_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_nonconformities ADD COLUMN created_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE evaluation_nonconformities ADD COLUMN updated_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE approval_tasks ADD COLUMN assigned_principal_id TEXT REFERENCES users(user_id);
ALTER TABLE approval_tasks ADD COLUMN acted_by_user_id TEXT REFERENCES users(user_id);
ALTER TABLE workflow_history ADD COLUMN actor_principal_id TEXT REFERENCES users(user_id);
ALTER TABLE notifications ADD COLUMN receiver_principal_id TEXT REFERENCES users(user_id);
ALTER TABLE notifications ADD COLUMN sender_principal_id TEXT REFERENCES users(user_id);
ALTER TABLE approval_stage_assignments ADD COLUMN assigned_principal_id TEXT REFERENCES users(user_id);

UPDATE evaluation_tickets SET
  assigned_specialist_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_tickets.assigned_specialist_id)),
  created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_tickets.created_by)),
  updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_tickets.updated_by)),
  deleted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_tickets.deleted_by)),
  cancelled_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_tickets.cancelled_by));
UPDATE evaluation_participants SET
  principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_participants.user_id)),
  assigned_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_participants.assigned_by));
UPDATE evaluation_rounds SET locked_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_rounds.locked_by));
UPDATE evaluation_answers SET answered_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_answers.answered_by));
UPDATE evaluation_nonconformities SET
  created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_nonconformities.created_by)),
  updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(evaluation_nonconformities.updated_by));
UPDATE approval_tasks SET
  assigned_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(approval_tasks.assigned_user_id)),
  acted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(approval_tasks.acted_by));
UPDATE workflow_history SET actor_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(workflow_history.actor_user_id));
UPDATE notifications SET
  receiver_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(notifications.receiver_user_id)),
  sender_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(notifications.sender_user_id));
UPDATE approval_stage_assignments SET assigned_principal_id =
  (SELECT user_id FROM users WHERE lower(email) = lower(approval_stage_assignments.assigned_user_id));

CREATE INDEX idx_evaluation_tickets_assignee_principal ON evaluation_tickets(assigned_specialist_user_id, current_status);
CREATE INDEX idx_evaluation_participants_principal ON evaluation_participants(principal_id, ticket_id, round_id);
CREATE INDEX idx_approval_tasks_assignee_principal ON approval_tasks(assigned_principal_id, status);
CREATE INDEX idx_workflow_history_actor_principal ON workflow_history(actor_principal_id, created_at DESC);
CREATE INDEX idx_notifications_receiver_principal ON notifications(receiver_principal_id, read_at, created_at DESC);
CREATE INDEX idx_approval_stage_assignee_principal ON approval_stage_assignments(assigned_principal_id, active);

-- Compatibility triggers cover inserts made by still-email-based repositories.
CREATE TRIGGER evaluation_tickets_sync_principal_insert AFTER INSERT ON evaluation_tickets BEGIN
  UPDATE evaluation_tickets SET
    assigned_specialist_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_specialist_id)),
    created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.created_by)),
    updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.updated_by)),
    deleted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.deleted_by)),
    cancelled_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.cancelled_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_tickets_sync_principal_update
AFTER UPDATE OF assigned_specialist_id, created_by, updated_by, deleted_by, cancelled_by ON evaluation_tickets BEGIN
  UPDATE evaluation_tickets SET
    assigned_specialist_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_specialist_id)),
    created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.created_by)),
    updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.updated_by)),
    deleted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.deleted_by)),
    cancelled_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.cancelled_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_participants_sync_principal_insert AFTER INSERT ON evaluation_participants BEGIN
  UPDATE evaluation_participants SET
    principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id)),
    assigned_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_participants_sync_principal_update
AFTER UPDATE OF user_id, assigned_by ON evaluation_participants BEGIN
  UPDATE evaluation_participants SET
    principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.user_id)),
    assigned_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_rounds_sync_principal_insert AFTER INSERT ON evaluation_rounds BEGIN
  UPDATE evaluation_rounds SET locked_by_user_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.locked_by)) WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_rounds_sync_principal_update AFTER UPDATE OF locked_by ON evaluation_rounds BEGIN
  UPDATE evaluation_rounds SET locked_by_user_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.locked_by)) WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_answers_sync_principal_insert AFTER INSERT ON evaluation_answers BEGIN
  UPDATE evaluation_answers SET answered_by_user_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.answered_by)) WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_answers_sync_principal_update AFTER UPDATE OF answered_by ON evaluation_answers BEGIN
  UPDATE evaluation_answers SET answered_by_user_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.answered_by)) WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_nonconformities_sync_principal_insert AFTER INSERT ON evaluation_nonconformities BEGIN
  UPDATE evaluation_nonconformities SET
    created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.created_by)),
    updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.updated_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER evaluation_nonconformities_sync_principal_update
AFTER UPDATE OF created_by, updated_by ON evaluation_nonconformities BEGIN
  UPDATE evaluation_nonconformities SET
    created_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.created_by)),
    updated_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.updated_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER workflow_history_sync_principal_insert AFTER INSERT ON workflow_history BEGIN
  UPDATE workflow_history SET actor_principal_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.actor_user_id)) WHERE id = NEW.id;
END;
CREATE TRIGGER approval_tasks_sync_principal_update
AFTER UPDATE OF assigned_user_id, acted_by ON approval_tasks BEGIN
  UPDATE approval_tasks SET
    assigned_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_user_id)),
    acted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.acted_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER approval_tasks_sync_principal_insert AFTER INSERT ON approval_tasks BEGIN
  UPDATE approval_tasks SET
    assigned_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_user_id)),
    acted_by_user_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.acted_by))
  WHERE id = NEW.id;
END;
CREATE TRIGGER approval_stage_assignments_sync_principal_insert AFTER INSERT ON approval_stage_assignments BEGIN
  UPDATE approval_stage_assignments SET assigned_principal_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_user_id)) WHERE id = NEW.id;
END;
CREATE TRIGGER approval_stage_assignments_sync_principal_update
AFTER UPDATE OF assigned_user_id ON approval_stage_assignments BEGIN
  UPDATE approval_stage_assignments SET assigned_principal_id =
    (SELECT user_id FROM users WHERE lower(email) = lower(NEW.assigned_user_id)) WHERE id = NEW.id;
END;
CREATE TRIGGER notifications_sync_principal_insert AFTER INSERT ON notifications BEGIN
  UPDATE notifications SET
    receiver_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.receiver_user_id)),
    sender_principal_id = (SELECT user_id FROM users WHERE lower(email) = lower(NEW.sender_user_id))
  WHERE id = NEW.id;
END;

INSERT INTO authz_change_log
  (change_type, object_type, object_key, after_json, reason)
VALUES
  ('MIGRATION_APPLIED', 'USER_IDENTITY', '0035_immutable_user_identity',
   json_object('strategy', 'additive', 'legacy_email_compatibility', 1),
   'Phase 3 immutable user identity cutover');
