-- migrate: foreign_keys=off
-- Final identity cutover: user_id becomes the only relational user key.

CREATE TEMP TABLE _identity_cutover_guard (ok INTEGER NOT NULL CHECK (ok = 1));
-- Guard: users.user_id contains NULL/blank values
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM users WHERE user_id IS NULL OR trim(user_id) = '')) = 0 THEN 1 ELSE 0 END;
-- Guard: users.user_id contains duplicates
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) - COUNT(DISTINCT user_id) FROM users)) = 0 THEN 1 ELSE 0 END;
-- Guard: users.email contains NULL/blank values
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM users WHERE email IS NULL OR trim(email) = '')) = 0 THEN 1 ELSE 0 END;
-- Guard: users.email contains case-insensitive duplicates
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) - COUNT(DISTINCT lower(trim(email))) FROM users)) = 0 THEN 1 ELSE 0 END;
-- Guard: user_roles.principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_roles" x WHERE x."principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: user_roles.user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_roles" x WHERE x."user_id" IS NOT NULL AND x."principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: user_scope_assignments.principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_scope_assignments" x WHERE x."principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: user_scope_assignments.user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_scope_assignments" x WHERE x."user_id" IS NOT NULL AND x."principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: auth_sessions.principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "auth_sessions" x WHERE x."principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: auth_sessions.user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "auth_sessions" x WHERE x."user_id" IS NOT NULL AND x."principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: authz_change_log.actor_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "authz_change_log" x WHERE x."actor_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: authz_change_log.actor_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "authz_change_log" x WHERE x."actor_user_id" IS NOT NULL AND x."actor_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: authz_change_log.target_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "authz_change_log" x WHERE x."target_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."target_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: authz_change_log.target_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "authz_change_log" x WHERE x."target_user_id" IS NOT NULL AND x."target_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."target_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: audit_events.actor_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "audit_events" x WHERE x."actor_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.assigned_specialist_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."assigned_specialist_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."assigned_specialist_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.assigned_specialist_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."assigned_specialist_id" IS NOT NULL AND x."assigned_specialist_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."assigned_specialist_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.created_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."created_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."created_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."created_by" IS NOT NULL AND x."created_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.updated_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."updated_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."updated_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.updated_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."updated_by" IS NOT NULL AND x."updated_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."updated_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.deleted_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."deleted_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."deleted_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.deleted_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."deleted_by" IS NOT NULL AND x."deleted_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."deleted_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.cancelled_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."cancelled_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."cancelled_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_tickets.cancelled_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_tickets" x WHERE x."cancelled_by" IS NOT NULL AND x."cancelled_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."cancelled_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_participants.principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_participants" x WHERE x."principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_participants.user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_participants" x WHERE x."user_id" IS NOT NULL AND x."principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_participants.assigned_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_participants" x WHERE x."assigned_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."assigned_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_participants.assigned_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_participants" x WHERE x."assigned_by" IS NOT NULL AND x."assigned_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."assigned_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_rounds.locked_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_rounds" x WHERE x."locked_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."locked_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_rounds.locked_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_rounds" x WHERE x."locked_by" IS NOT NULL AND x."locked_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."locked_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_answers.answered_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_answers" x WHERE x."answered_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."answered_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_answers.answered_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_answers" x WHERE x."answered_by" IS NOT NULL AND x."answered_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."answered_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_nonconformities.created_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_nonconformities" x WHERE x."created_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."created_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_nonconformities.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_nonconformities" x WHERE x."created_by" IS NOT NULL AND x."created_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_nonconformities.updated_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_nonconformities" x WHERE x."updated_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."updated_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_nonconformities.updated_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_nonconformities" x WHERE x."updated_by" IS NOT NULL AND x."updated_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."updated_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_tasks.assigned_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_tasks" x WHERE x."assigned_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."assigned_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_tasks.assigned_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_tasks" x WHERE x."assigned_user_id" IS NOT NULL AND x."assigned_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."assigned_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_tasks.acted_by_user_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_tasks" x WHERE x."acted_by_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."acted_by_user_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_tasks.acted_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_tasks" x WHERE x."acted_by" IS NOT NULL AND x."acted_by_user_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."acted_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: workflow_history.actor_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "workflow_history" x WHERE x."actor_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: workflow_history.actor_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "workflow_history" x WHERE x."actor_user_id" IS NOT NULL AND x."actor_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: notifications.receiver_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "notifications" x WHERE x."receiver_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."receiver_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: notifications.receiver_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "notifications" x WHERE x."receiver_user_id" IS NOT NULL AND x."receiver_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."receiver_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: notifications.sender_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "notifications" x WHERE x."sender_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."sender_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: notifications.sender_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "notifications" x WHERE x."sender_user_id" IS NOT NULL AND x."sender_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."sender_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_stage_assignments.assigned_principal_id contains an orphan user_id
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_stage_assignments" x WHERE x."assigned_principal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."assigned_principal_id"))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_stage_assignments.assigned_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_stage_assignments" x WHERE x."assigned_user_id" IS NOT NULL AND x."assigned_principal_id" IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."assigned_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: approval_stage_assignments.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "approval_stage_assignments" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: correction_extensions.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "correction_extensions" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: evaluation_attachments.uploaded_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "evaluation_attachments" x WHERE x."uploaded_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."uploaded_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: personnel_import_batches.actor_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "personnel_import_batches" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_exports.exported_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_exports" x WHERE x."exported_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."exported_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_legacy_migration_review.resolved_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_legacy_migration_review" x WHERE x."resolved_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."resolved_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_legacy_template_links.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_legacy_template_links" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_assignments.updated_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_assignments" x WHERE x."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."updated_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_assignments.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_assignments" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_version_events.actor_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_version_events" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_versions.retired_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_versions" x WHERE x."retired_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."retired_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_versions.published_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_versions" x WHERE x."published_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."published_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_versions.submitted_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_versions" x WHERE x."submitted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."submitted_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_versions.updated_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_versions" x WHERE x."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."updated_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_template_versions.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_template_versions" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: role_permissions.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "role_permissions" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: supplier_import_batches.uploaded_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "supplier_import_batches" x WHERE x."uploaded_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."uploaded_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: supplier_master.updated_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "supplier_master" x WHERE x."updated_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."updated_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: supplier_master.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "supplier_master" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: supplier_master_history.actor_user_id contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "supplier_master_history" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: user_roles.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_roles" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: user_scope_assignments.created_by contains an email that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "user_scope_assignments" x WHERE x."created_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(trim(x."created_by"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: question_import_events.actor_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "question_import_events" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_user_id" OR lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: question_template_version_events.actor_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "question_template_version_events" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_user_id" OR lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_artifact_events.actor_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_artifact_events" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_user_id" OR lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: report_export_jobs.requester_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "report_export_jobs" x WHERE x."requester_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."requester_user_id" OR lower(u.email) = lower(trim(x."requester_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: scoring_policy_version_events.actor_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "scoring_policy_version_events" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_user_id" OR lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
-- Guard: supplier_master_history.actor_user_id contains an identity that cannot be mapped
INSERT INTO _identity_cutover_guard(ok) SELECT CASE WHEN ((SELECT COUNT(*) FROM "supplier_master_history" x WHERE x."actor_user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = x."actor_user_id" OR lower(u.email) = lower(trim(x."actor_user_id"))))) = 0 THEN 1 ELSE 0 END;
DROP TABLE _identity_cutover_guard;

-- These triggers depend on tables rebuilt below and must be detached before the
-- first DROP TABLE. They are recreated against canonical user_id values later.
DROP TRIGGER IF EXISTS roles_active_version_update;
DROP TRIGGER IF EXISTS prevent_super_admin_role_disable;
DROP TRIGGER IF EXISTS prevent_last_super_admin_user_deactivate;
DROP TRIGGER IF EXISTS users_active_authz_invalidation;
DROP TRIGGER IF EXISTS users_open_evaluation_work_deactivation_guard;
DROP TRIGGER IF EXISTS users_user_id_immutable;
DROP TRIGGER IF EXISTS users_assign_immutable_id;
DROP TRIGGER IF EXISTS approval_stage_assignments_sync_principal_insert;
DROP TRIGGER IF EXISTS approval_stage_assignments_sync_principal_update;
DROP TRIGGER IF EXISTS approval_tasks_sync_principal_insert;
DROP TRIGGER IF EXISTS approval_tasks_sync_principal_update;
DROP TRIGGER IF EXISTS audit_events_append_only_delete;
DROP TRIGGER IF EXISTS audit_events_append_only_update;
DROP TRIGGER IF EXISTS auth_sessions_sync_principal_insert;
DROP TRIGGER IF EXISTS authz_change_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_answers_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_answers_sync_principal_update;
DROP TRIGGER IF EXISTS evaluation_nonconformities_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_nonconformities_sync_principal_update;
DROP TRIGGER IF EXISTS evaluation_participants_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_participants_sync_principal_update;
DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_immutable;
DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_insert;
DROP TRIGGER IF EXISTS evaluation_rounds_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_rounds_sync_principal_update;
DROP TRIGGER IF EXISTS evaluation_ticket_scoring_policy_pin_immutable;
DROP TRIGGER IF EXISTS evaluation_ticket_scoring_policy_pin_insert;
DROP TRIGGER IF EXISTS evaluation_tickets_sync_principal_insert;
DROP TRIGGER IF EXISTS evaluation_tickets_sync_principal_update;
DROP TRIGGER IF EXISTS notifications_sync_principal_insert;
DROP TRIGGER IF EXISTS personnel_import_batches_append_only_delete;
DROP TRIGGER IF EXISTS personnel_import_batches_append_only_update;
DROP TRIGGER IF EXISTS prevent_last_super_admin_role_delete;
DROP TRIGGER IF EXISTS prevent_last_super_admin_role_update;
DROP TRIGGER IF EXISTS question_import_events_append_only_delete;
DROP TRIGGER IF EXISTS question_import_events_append_only_update;
DROP TRIGGER IF EXISTS question_version_events_append_only_delete;
DROP TRIGGER IF EXISTS question_version_events_append_only_update;
DROP TRIGGER IF EXISTS role_permissions_version_delete;
DROP TRIGGER IF EXISTS role_permissions_version_insert;
DROP TRIGGER IF EXISTS role_permissions_version_update;
DROP TRIGGER IF EXISTS scoring_policy_event_append_only_delete;
DROP TRIGGER IF EXISTS scoring_policy_event_append_only_update;
DROP TRIGGER IF EXISTS trg_report_artifact_event_append_only_delete;
DROP TRIGGER IF EXISTS trg_report_artifact_event_append_only_update;
DROP TRIGGER IF EXISTS trg_report_legacy_link_immutable_delete;
DROP TRIGGER IF EXISTS trg_report_legacy_link_immutable_update;
DROP TRIGGER IF EXISTS trg_report_published_content_immutable;
DROP TRIGGER IF EXISTS trg_report_published_delete_immutable;
DROP TRIGGER IF EXISTS trg_report_template_event_append_only_delete;
DROP TRIGGER IF EXISTS trg_report_template_event_append_only_update;
DROP TRIGGER IF EXISTS user_roles_sync_principal_insert;
DROP TRIGGER IF EXISTS user_roles_sync_principal_update;
DROP TRIGGER IF EXISTS user_roles_version_delete;
DROP TRIGGER IF EXISTS user_roles_version_insert;
DROP TRIGGER IF EXISTS user_roles_version_update;
DROP TRIGGER IF EXISTS user_scopes_sync_principal_insert;
DROP TRIGGER IF EXISTS user_scopes_sync_principal_update;
DROP TRIGGER IF EXISTS user_scopes_version_delete;
DROP TRIGGER IF EXISTS user_scopes_version_insert;
DROP TRIGGER IF EXISTS user_scopes_version_update;
DROP TRIGGER IF EXISTS workflow_history_sync_principal_insert;
DROP VIEW IF EXISTS pinned_evaluation_questions;

-- Rebuild approval_stage_assignments.
CREATE TABLE "__cutover_approval_stage_assignments" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_type    TEXT NOT NULL,
  stage_code       TEXT NOT NULL,
  role_id          INTEGER,
  assigned_user_id TEXT,
  scope_type       TEXT NOT NULL DEFAULT 'GLOBAL' CHECK (scope_type IN ('GLOBAL', 'REGION', 'MCH2', 'ASSIGNED', 'OWN', 'SUPPLIER', 'CUSTOM')),
  scope_value      TEXT,
  custom_schema_code TEXT,
  custom_schema_version INTEGER,
  priority         INTEGER NOT NULL DEFAULT 100,
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  valid_from       TEXT,
  valid_until      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT,
  CHECK ((role_id IS NOT NULL AND assigned_user_id IS NULL) OR (role_id IS NULL AND assigned_user_id IS NOT NULL)),
  CHECK ((scope_type = 'GLOBAL' AND scope_value IS NULL) OR (scope_type != 'GLOBAL' AND scope_value IS NOT NULL)),
  CHECK (scope_type != 'MCH2' OR (length(scope_value) > 0 AND (scope_value NOT GLOB '*[^0-9]*' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'))),
  CHECK (scope_type != 'CUSTOM' OR (custom_schema_code IS NOT NULL AND custom_schema_version IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_approval_stage_assignments" ("id", "workflow_type", "stage_code", "role_id", "assigned_user_id", "scope_type", "scope_value", "custom_schema_code", "custom_schema_version", "priority", "active", "valid_from", "valid_until", "created_at", "created_by")
SELECT old."id",
       old."workflow_type",
       old."stage_code",
       old."role_id",
       COALESCE(old."assigned_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."assigned_user_id")))),
       old."scope_type",
       old."scope_value",
       old."custom_schema_code",
       old."custom_schema_version",
       old."priority",
       old."active",
       old."valid_from",
       old."valid_until",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))) FROM "approval_stage_assignments" old;
DROP TABLE "approval_stage_assignments";
ALTER TABLE "__cutover_approval_stage_assignments" RENAME TO "approval_stage_assignments";

-- Rebuild approval_tasks.
CREATE TABLE "__cutover_approval_tasks" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL,
  approval_level   TEXT NOT NULL CHECK (approval_level IN ('LEAD', 'TBP', 'GDK')),
  assigned_role    TEXT NOT NULL,
  assigned_user_id TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  comment          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  acted_at         TEXT,
  acted_by         TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (acted_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_approval_tasks" ("id", "ticket_id", "approval_level", "assigned_role", "assigned_user_id", "status", "comment", "created_at", "acted_at", "acted_by")
SELECT old."id",
       old."ticket_id",
       old."approval_level",
       old."assigned_role",
       COALESCE(old."assigned_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."assigned_user_id")))),
       old."status",
       old."comment",
       old."created_at",
       old."acted_at",
       COALESCE(old."acted_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."acted_by")))) FROM "approval_tasks" old;
DROP TABLE "approval_tasks";
ALTER TABLE "__cutover_approval_tasks" RENAME TO "approval_tasks";

-- Rebuild audit_events.
CREATE TABLE "__cutover_audit_events" (
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
  actor_user_id    TEXT REFERENCES users(user_id) ON DELETE SET NULL,
  actor_email_snapshot TEXT,
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
INSERT INTO "__cutover_audit_events" ("id", "occurred_at", "catalog_version", "category", "event_name", "severity", "actor_user_id", "actor_email_snapshot", "actor_roles_json", "request_id", "correlation_id", "uat_run_id", "entity_type", "entity_id", "action", "outcome", "reason_code", "summary", "metadata_json", "idempotency_key", "previous_hash", "event_hash")
SELECT old."id",
       old."occurred_at",
       old."catalog_version",
       old."category",
       old."event_name",
       old."severity",
       COALESCE(old."actor_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."actor_user_id",
       old."actor_roles_json",
       old."request_id",
       old."correlation_id",
       old."uat_run_id",
       old."entity_type",
       old."entity_id",
       old."action",
       old."outcome",
       old."reason_code",
       old."summary",
       old."metadata_json",
       old."idempotency_key",
       old."previous_hash",
       old."event_hash" FROM "audit_events" old;
DROP TABLE "audit_events";
ALTER TABLE "__cutover_audit_events" RENAME TO "audit_events";

-- Rebuild auth_sessions.
CREATE TABLE "__cutover_auth_sessions" (
  session_id    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  authz_version INTEGER NOT NULL,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoke_reason TEXT,
  created_ip    TEXT,
  user_agent    TEXT,
  CHECK (expires_at > issued_at),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
INSERT INTO "__cutover_auth_sessions" ("session_id", "user_id", "authz_version", "issued_at", "expires_at", "revoked_at", "revoke_reason", "created_ip", "user_agent")
SELECT old."session_id",
       COALESCE(old."principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."user_id")))),
       old."authz_version",
       old."issued_at",
       old."expires_at",
       old."revoked_at",
       old."revoke_reason",
       old."created_ip",
       old."user_agent" FROM "auth_sessions" old;
DROP TABLE "auth_sessions";
ALTER TABLE "__cutover_auth_sessions" RENAME TO "auth_sessions";

-- Rebuild authz_change_log.
CREATE TABLE "__cutover_authz_change_log" (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  TEXT,
  target_user_id TEXT,
  change_type    TEXT NOT NULL,
  object_type    TEXT NOT NULL,
  object_key     TEXT NOT NULL,
  before_json    TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json     TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  request_id     TEXT,
  correlation_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT,
  authz_version INTEGER,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_authz_change_log" ("id", "actor_user_id", "target_user_id", "change_type", "object_type", "object_key", "before_json", "after_json", "request_id", "correlation_id", "created_at", "reason", "authz_version")
SELECT old."id",
       COALESCE(old."actor_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       COALESCE(old."target_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."target_user_id")))),
       old."change_type",
       old."object_type",
       old."object_key",
       old."before_json",
       old."after_json",
       old."request_id",
       old."correlation_id",
       old."created_at",
       old."reason",
       old."authz_version" FROM "authz_change_log" old;
DROP TABLE "authz_change_log";
ALTER TABLE "__cutover_authz_change_log" RENAME TO "authz_change_log";

-- Rebuild correction_extensions.
CREATE TABLE "__cutover_correction_extensions" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL,
  extension_no     INTEGER NOT NULL,
  old_due_date     TEXT,
  new_due_date     TEXT NOT NULL,
  reason           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_correction_extensions" ("id", "ticket_id", "extension_no", "old_due_date", "new_due_date", "reason", "created_at", "created_by")
SELECT old."id",
       old."ticket_id",
       old."extension_no",
       old."old_due_date",
       old."new_due_date",
       old."reason",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))) FROM "correction_extensions" old;
DROP TABLE "correction_extensions";
ALTER TABLE "__cutover_correction_extensions" RENAME TO "correction_extensions";

-- Rebuild evaluation_answers.
CREATE TABLE "__cutover_evaluation_answers" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id         INTEGER NOT NULL,
  question_item_id INTEGER NOT NULL,
  score            TEXT CHECK (score IN ('A', 'B', 'C', 'D', 'NA')),
  comment          TEXT,
  calculated_score REAL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT,
  answered_by      TEXT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (question_item_id) REFERENCES "question_items"(id) ON DELETE RESTRICT,
  FOREIGN KEY (answered_by) REFERENCES users(user_id) ON DELETE SET NULL,
  UNIQUE (round_id, question_item_id)
);
INSERT INTO "__cutover_evaluation_answers" ("id", "round_id", "question_item_id", "score", "comment", "calculated_score", "created_at", "updated_at", "answered_by")
SELECT old."id",
       old."round_id",
       old."question_item_id",
       old."score",
       old."comment",
       old."calculated_score",
       old."created_at",
       old."updated_at",
       COALESCE(old."answered_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."answered_by")))) FROM "evaluation_answers" old;
DROP TABLE "evaluation_answers";
ALTER TABLE "__cutover_evaluation_answers" RENAME TO "evaluation_answers";

-- Rebuild evaluation_attachments.
CREATE TABLE "__cutover_evaluation_attachments" (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id    INTEGER,
  ticket_id    INTEGER,
  file_name    TEXT NOT NULL,
  file_path    TEXT,
  storage_key  TEXT,
  mime_type    TEXT,
  size_bytes   INTEGER,
  uploaded_by  TEXT,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (answer_id) REFERENCES evaluation_answers(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE SET NULL,
  CHECK (answer_id IS NOT NULL OR ticket_id IS NOT NULL)
);
INSERT INTO "__cutover_evaluation_attachments" ("id", "answer_id", "ticket_id", "file_name", "file_path", "storage_key", "mime_type", "size_bytes", "uploaded_by", "uploaded_at")
SELECT old."id",
       old."answer_id",
       old."ticket_id",
       old."file_name",
       old."file_path",
       old."storage_key",
       old."mime_type",
       old."size_bytes",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."uploaded_by"))),
       old."uploaded_at" FROM "evaluation_attachments" old;
DROP TABLE "evaluation_attachments";
ALTER TABLE "__cutover_evaluation_attachments" RENAME TO "evaluation_attachments";

-- Rebuild evaluation_nonconformities.
CREATE TABLE "__cutover_evaluation_nonconformities" (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id               INTEGER NOT NULL,
  round_id                INTEGER NOT NULL,
  clause_code             TEXT,
  category                TEXT,
  due_date                TEXT,
  severity                TEXT,
  status                  TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  created_by              TEXT,
  updated_at              TEXT,
  updated_by              TEXT,
  evaluation_answer_id    INTEGER,
  nonconformity_content   TEXT NOT NULL CHECK (NULLIF(TRIM(nonconformity_content), '') IS NOT NULL),
  remediation_content     TEXT,
  corrective_requirement_id INTEGER REFERENCES corrective_requirements(id) ON DELETE RESTRICT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_answer_id) REFERENCES evaluation_answers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_evaluation_nonconformities" ("id", "ticket_id", "round_id", "clause_code", "category", "due_date", "severity", "status", "created_at", "created_by", "updated_at", "updated_by", "evaluation_answer_id", "nonconformity_content", "remediation_content", "corrective_requirement_id")
SELECT old."id",
       old."ticket_id",
       old."round_id",
       old."clause_code",
       old."category",
       old."due_date",
       old."severity",
       old."status",
       old."created_at",
       COALESCE(old."created_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by")))),
       old."updated_at",
       COALESCE(old."updated_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."updated_by")))),
       old."evaluation_answer_id",
       old."nonconformity_content",
       old."remediation_content",
       old."corrective_requirement_id" FROM "evaluation_nonconformities" old;
DROP TABLE "evaluation_nonconformities";
ALTER TABLE "__cutover_evaluation_nonconformities" RENAME TO "evaluation_nonconformities";

-- Rebuild evaluation_participants.
CREATE TABLE "__cutover_evaluation_participants" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER,
  round_id         INTEGER,
  user_id          TEXT,
  display_name     TEXT NOT NULL,
  participant_role TEXT NOT NULL CHECK (participant_role IN (
    'OWNER', 'QA_LEAD', 'QA_SUPPORT', 'EVALUATOR', 'ATTENDEE', 'SUPPLIER_REP', 'OTHER'
  )),
  opening_meeting  INTEGER NOT NULL DEFAULT 0 CHECK (opening_meeting IN (0, 1)),
  closing_meeting  INTEGER NOT NULL DEFAULT 0 CHECK (closing_meeting IN (0, 1)),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  assigned_at      TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_by      TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by) REFERENCES users(user_id) ON DELETE SET NULL,
  CHECK (
    (ticket_id IS NOT NULL AND round_id IS NULL)
    OR (ticket_id IS NULL AND round_id IS NOT NULL)
  ),
  CHECK (length(trim(display_name)) > 0)
);
INSERT INTO "__cutover_evaluation_participants" ("id", "ticket_id", "round_id", "user_id", "display_name", "participant_role", "opening_meeting", "closing_meeting", "active", "assigned_at", "assigned_by")
SELECT old."id",
       old."ticket_id",
       old."round_id",
       COALESCE(old."principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."user_id")))),
       old."display_name",
       old."participant_role",
       old."opening_meeting",
       old."closing_meeting",
       old."active",
       old."assigned_at",
       COALESCE(old."assigned_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."assigned_by")))) FROM "evaluation_participants" old;
DROP TABLE "evaluation_participants";
ALTER TABLE "__cutover_evaluation_participants" RENAME TO "evaluation_participants";

-- Rebuild evaluation_rounds.
CREATE TABLE "__cutover_evaluation_rounds" (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id                    INTEGER NOT NULL,
  round_no                     INTEGER NOT NULL CHECK (round_no IN (1, 2)),
  source_round_id              INTEGER,
  assessment_code              TEXT,
  assessment_date              TEXT,
  status                       TEXT NOT NULL,
  started_at                   TEXT DEFAULT (datetime('now')),
  completed_at                 TEXT,
  total_score                  REAL,
  final_result                 TEXT,
  classification               TEXT,
  locked_at                    TEXT,
  locked_by                    TEXT,
  correction_locked            INTEGER NOT NULL DEFAULT 0 CHECK (correction_locked IN (0, 1)),
  scoring_policy_version_id    INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  scoring_result_snapshot_json TEXT,
  scoring_result_checksum      TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (source_round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (locked_by) REFERENCES users(user_id) ON DELETE SET NULL,
  UNIQUE (ticket_id, round_no)
);
INSERT INTO "__cutover_evaluation_rounds" ("id", "ticket_id", "round_no", "source_round_id", "assessment_code", "assessment_date", "status", "started_at", "completed_at", "total_score", "final_result", "classification", "locked_at", "locked_by", "correction_locked", "scoring_policy_version_id", "scoring_result_snapshot_json", "scoring_result_checksum")
SELECT old."id",
       old."ticket_id",
       old."round_no",
       old."source_round_id",
       old."assessment_code",
       old."assessment_date",
       old."status",
       old."started_at",
       old."completed_at",
       old."total_score",
       old."final_result",
       old."classification",
       old."locked_at",
       COALESCE(old."locked_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."locked_by")))),
       old."correction_locked",
       old."scoring_policy_version_id",
       old."scoring_result_snapshot_json",
       old."scoring_result_checksum" FROM "evaluation_rounds" old;
DROP TABLE "evaluation_rounds";
ALTER TABLE "__cutover_evaluation_rounds" RENAME TO "evaluation_rounds";

-- Rebuild evaluation_tickets.
CREATE TABLE "__cutover_evaluation_tickets" (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_code                     TEXT NOT NULL UNIQUE,
  supplier_id                     INTEGER NOT NULL,
  supplier_code                   TEXT,
  supplier_name                   TEXT,
  tax_code                        TEXT,
  supplier_address                TEXT,
  production_address              TEXT,
  snapshot_evaluation_address     TEXT,
  linked_facility_code            TEXT,
  snapshot_linked_facility_name   TEXT,
  snapshot_linked_facility_address TEXT,
  linked_facility_type            TEXT,
  region                          TEXT,
  province                        TEXT,
  business_type                   TEXT,
  cmc_owner                       TEXT,
  cmc_head                        TEXT,
  business_license_file           TEXT,
  attp_certificate_type           TEXT,
  attp_certificate_file           TEXT,
  contact_name                    TEXT,
  contact_email                   TEXT,
  contact_phone                   TEXT,
  mch2                            TEXT,
  mch3                            TEXT,
  product_group                   TEXT,
  snapshot_product_name           TEXT,
  evaluation_type                 TEXT NOT NULL,
  template_id                     INTEGER,
  facility_type                   TEXT,
  supplier_scale                  TEXT CHECK (supplier_scale IS NULL OR supplier_scale IN ('LARGE', 'SMALL')),
  evaluation_method               TEXT,
  evaluation_department           TEXT,
  planned_date                    TEXT,
  actual_evaluation_date          TEXT,
  current_status                  TEXT NOT NULL,
  current_round_no                INTEGER NOT NULL DEFAULT 1 CHECK (current_round_no IN (1, 2)),
  assigned_specialist_id          TEXT,
  score_percent                   REAL,
  grade_code                      TEXT,
  result_label                    TEXT,
  result_reason                   TEXT,
  corrected_score_percent         REAL,
  corrected_grade_code            TEXT,
  corrected_result_label          TEXT,
  correction_date                 TEXT,
  next_evaluation_date            TEXT,
  final_conclusion                TEXT,
  specialist_proposal             TEXT,
  supplier_introduction           TEXT,
  scoring_locked                  INTEGER NOT NULL DEFAULT 0 CHECK (scoring_locked IN (0, 1)),
  completed_round                 INTEGER NOT NULL DEFAULT 1 CHECK (completed_round IN (1, 2)),
  is_deleted                      INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  deleted_at                      TEXT,
  deleted_by                      TEXT,
  deleted_reason                  TEXT,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by                      TEXT,
  updated_at                      TEXT,
  updated_by                      TEXT,
  cancelled_reason                TEXT,
  cancelled_by                    TEXT,
  cancelled_at                    TEXT,
  question_template_version_id    INTEGER REFERENCES question_template_versions(id) ON DELETE RESTRICT,
  scoring_policy_version_id       INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  snapshot_locked_at              TEXT,
  source_kind                     TEXT NOT NULL DEFAULT 'NATIVE'
                                  CHECK (source_kind IN ('NATIVE', 'HISTORICAL')),
  historical_source_key           TEXT,
  historical_source_file          TEXT,
  historical_source_file_hash     TEXT,
  historical_source_row_number    INTEGER,
  historical_source_stt           INTEGER,
  historical_source_payload_json  TEXT,
  FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_specialist_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(user_id) ON DELETE SET NULL,
  CHECK (
    source_kind = 'HISTORICAL'
    OR (
      template_id IS NOT NULL
      AND facility_type IS NOT NULL
      AND supplier_scale IN ('LARGE', 'SMALL')
    )
  ),
  CHECK (
    source_kind = 'NATIVE'
    OR NULLIF(TRIM(COALESCE(historical_source_key, '')), '') IS NOT NULL
  )
);
INSERT INTO "__cutover_evaluation_tickets" ("id", "ticket_code", "supplier_id", "supplier_code", "supplier_name", "tax_code", "supplier_address", "production_address", "snapshot_evaluation_address", "linked_facility_code", "snapshot_linked_facility_name", "snapshot_linked_facility_address", "linked_facility_type", "region", "province", "business_type", "cmc_owner", "cmc_head", "business_license_file", "attp_certificate_type", "attp_certificate_file", "contact_name", "contact_email", "contact_phone", "mch2", "mch3", "product_group", "snapshot_product_name", "evaluation_type", "template_id", "facility_type", "supplier_scale", "evaluation_method", "evaluation_department", "planned_date", "actual_evaluation_date", "current_status", "current_round_no", "assigned_specialist_id", "score_percent", "grade_code", "result_label", "result_reason", "corrected_score_percent", "corrected_grade_code", "corrected_result_label", "correction_date", "next_evaluation_date", "final_conclusion", "specialist_proposal", "supplier_introduction", "scoring_locked", "completed_round", "is_deleted", "deleted_at", "deleted_by", "deleted_reason", "created_at", "created_by", "updated_at", "updated_by", "cancelled_reason", "cancelled_by", "cancelled_at", "question_template_version_id", "scoring_policy_version_id", "snapshot_locked_at", "source_kind", "historical_source_key", "historical_source_file", "historical_source_file_hash", "historical_source_row_number", "historical_source_stt", "historical_source_payload_json")
SELECT old."id",
       old."ticket_code",
       old."supplier_id",
       old."supplier_code",
       old."supplier_name",
       old."tax_code",
       old."supplier_address",
       old."production_address",
       old."snapshot_evaluation_address",
       old."linked_facility_code",
       old."snapshot_linked_facility_name",
       old."snapshot_linked_facility_address",
       old."linked_facility_type",
       old."region",
       old."province",
       old."business_type",
       old."cmc_owner",
       old."cmc_head",
       old."business_license_file",
       old."attp_certificate_type",
       old."attp_certificate_file",
       old."contact_name",
       old."contact_email",
       old."contact_phone",
       old."mch2",
       old."mch3",
       old."product_group",
       old."snapshot_product_name",
       old."evaluation_type",
       old."template_id",
       old."facility_type",
       old."supplier_scale",
       old."evaluation_method",
       old."evaluation_department",
       old."planned_date",
       old."actual_evaluation_date",
       old."current_status",
       old."current_round_no",
       COALESCE(old."assigned_specialist_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."assigned_specialist_id")))),
       old."score_percent",
       old."grade_code",
       old."result_label",
       old."result_reason",
       old."corrected_score_percent",
       old."corrected_grade_code",
       old."corrected_result_label",
       old."correction_date",
       old."next_evaluation_date",
       old."final_conclusion",
       old."specialist_proposal",
       old."supplier_introduction",
       old."scoring_locked",
       old."completed_round",
       old."is_deleted",
       old."deleted_at",
       COALESCE(old."deleted_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."deleted_by")))),
       old."deleted_reason",
       old."created_at",
       COALESCE(old."created_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by")))),
       old."updated_at",
       COALESCE(old."updated_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."updated_by")))),
       old."cancelled_reason",
       COALESCE(old."cancelled_by_user_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."cancelled_by")))),
       old."cancelled_at",
       old."question_template_version_id",
       old."scoring_policy_version_id",
       old."snapshot_locked_at",
       old."source_kind",
       old."historical_source_key",
       old."historical_source_file",
       old."historical_source_file_hash",
       old."historical_source_row_number",
       old."historical_source_stt",
       old."historical_source_payload_json" FROM "evaluation_tickets" old;
DROP TABLE "evaluation_tickets";
ALTER TABLE "__cutover_evaluation_tickets" RENAME TO "evaluation_tickets";

-- Rebuild notifications.
CREATE TABLE "__cutover_notifications" (
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
  FOREIGN KEY (receiver_user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  UNIQUE (unique_key)
);
INSERT INTO "__cutover_notifications" ("id", "receiver_user_id", "sender_user_id", "ticket_id", "notification_type", "title", "message", "payload_json", "unique_key", "is_read", "read_at", "created_at")
SELECT old."id",
       COALESCE(old."receiver_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."receiver_user_id")))),
       COALESCE(old."sender_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."sender_user_id")))),
       old."ticket_id",
       old."notification_type",
       old."title",
       old."message",
       old."payload_json",
       old."unique_key",
       old."is_read",
       old."read_at",
       old."created_at" FROM "notifications" old;
DROP TABLE "notifications";
ALTER TABLE "__cutover_notifications" RENAME TO "notifications";

-- Rebuild personnel_import_batches.
CREATE TABLE "__cutover_personnel_import_batches" (
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
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE RESTRICT,
  UNIQUE (actor_user_id, idempotency_key)
);
INSERT INTO "__cutover_personnel_import_batches" ("id", "public_id", "actor_user_id", "source_sha256", "plan_sha256", "request_sha256", "idempotency_key", "status", "mapping_json", "summary_json", "diagnostics_json", "reason", "request_id", "correlation_id", "created_at", "committed_at")
SELECT old."id",
       old."public_id",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id"))),
       old."source_sha256",
       old."plan_sha256",
       old."request_sha256",
       old."idempotency_key",
       old."status",
       old."mapping_json",
       old."summary_json",
       old."diagnostics_json",
       old."reason",
       old."request_id",
       old."correlation_id",
       old."created_at",
       old."committed_at" FROM "personnel_import_batches" old;
DROP TABLE "personnel_import_batches";
ALTER TABLE "__cutover_personnel_import_batches" RENAME TO "personnel_import_batches";

-- Rebuild question_import_events.
CREATE TABLE "__cutover_question_import_events" (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL,
  action          TEXT NOT NULL,
  actor_user_id   TEXT,
  metadata_json   TEXT,
  request_id      TEXT,
  correlation_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (batch_id) REFERENCES question_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_question_import_events" ("id", "batch_id", "action", "actor_user_id", "metadata_json", "request_id", "correlation_id", "created_at")
SELECT old."id",
       old."batch_id",
       old."action",
       COALESCE((SELECT u.user_id FROM users u WHERE u.user_id = old."actor_user_id"), (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."metadata_json",
       old."request_id",
       old."correlation_id",
       old."created_at" FROM "question_import_events" old;
DROP TABLE "question_import_events";
ALTER TABLE "__cutover_question_import_events" RENAME TO "question_import_events";

-- Rebuild question_template_version_events.
CREATE TABLE "__cutover_question_template_version_events" (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_template_version_id INTEGER NOT NULL,
  action                       TEXT NOT NULL,
  actor_user_id                TEXT,
  before_json                  TEXT,
  after_json                   TEXT,
  request_id                   TEXT,
  correlation_id               TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_question_template_version_events" ("id", "question_template_version_id", "action", "actor_user_id", "before_json", "after_json", "request_id", "correlation_id", "created_at")
SELECT old."id",
       old."question_template_version_id",
       old."action",
       COALESCE((SELECT u.user_id FROM users u WHERE u.user_id = old."actor_user_id"), (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."before_json",
       old."after_json",
       old."request_id",
       old."correlation_id",
       old."created_at" FROM "question_template_version_events" old;
DROP TABLE "question_template_version_events";
ALTER TABLE "__cutover_question_template_version_events" RENAME TO "question_template_version_events";

-- Rebuild report_artifact_events.
CREATE TABLE "__cutover_report_artifact_events" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  artifact_id INTEGER,
  event_code TEXT NOT NULL,
  actor_user_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE')),
  request_id TEXT,
  correlation_id TEXT,
  metadata_json TEXT,
  unique_event_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES report_export_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES report_artifacts(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_artifact_events" ("id", "job_id", "artifact_id", "event_code", "actor_user_id", "outcome", "request_id", "correlation_id", "metadata_json", "unique_event_key", "created_at")
SELECT old."id",
       old."job_id",
       old."artifact_id",
       old."event_code",
       COALESCE((SELECT u.user_id FROM users u WHERE u.user_id = old."actor_user_id"), (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."outcome",
       old."request_id",
       old."correlation_id",
       old."metadata_json",
       old."unique_event_key",
       old."created_at" FROM "report_artifact_events" old;
DROP TABLE "report_artifact_events";
ALTER TABLE "__cutover_report_artifact_events" RENAME TO "report_artifact_events";

-- Rebuild report_export_jobs.
CREATE TABLE "__cutover_report_export_jobs" (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  definition_code TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  report_template_version_id INTEGER,
  template_version_marker TEXT,
  template_checksum TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  round_id INTEGER,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  file_format TEXT NOT NULL CHECK (file_format IN ('HTML', 'PDF', 'XLSX')),
  data_contract_version INTEGER NOT NULL CHECK (data_contract_version > 0),
  context_checksum TEXT,
  renderer_version TEXT NOT NULL,
  app_commit TEXT NOT NULL,
  scoring_policy_version_id TEXT,
  scoring_rules_marker TEXT,
  scoring_rules_checksum TEXT,
  requester_user_id TEXT NOT NULL,
  generator_id TEXT NOT NULL,
  request_id TEXT,
  correlation_id TEXT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('INLINE', 'WORKER')),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  outcome TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (outcome IN ('PENDING', 'SUCCESS', 'FAILURE', 'CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  generated_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  regenerate_of_artifact_id INTEGER,
  regeneration_reason TEXT,
  regeneration_policy TEXT,
  scoring_policy_checksum TEXT,
  legacy_source TEXT,
  legacy_alias_version TEXT,
  FOREIGN KEY (report_template_version_id) REFERENCES report_template_versions(id),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE RESTRICT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (regenerate_of_artifact_id) REFERENCES report_artifacts(id) ON DELETE SET NULL,
  UNIQUE (requester_user_id, idempotency_key),
  CHECK (
    (report_template_version_id IS NOT NULL AND template_version_marker IS NULL)
    OR (report_template_version_id IS NULL AND template_version_marker IS NOT NULL)
  ),
  CHECK (
    (scoring_policy_version_id IS NOT NULL AND scoring_rules_marker IS NULL)
    OR (
      scoring_policy_version_id IS NULL
      AND scoring_rules_marker = 'LEGACY_RULES_V1'
      AND scoring_rules_checksum IS NOT NULL
    )
  ),
  CHECK (
    regenerate_of_artifact_id IS NULL
    OR (length(trim(regeneration_reason)) >= 8 AND length(trim(regeneration_policy)) >= 3)
  ),
  FOREIGN KEY (requester_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_export_jobs" ("id", "idempotency_key", "definition_code", "definition_version", "report_template_version_id", "template_version_marker", "template_checksum", "ticket_id", "round_id", "round_no", "file_format", "data_contract_version", "context_checksum", "renderer_version", "app_commit", "scoring_policy_version_id", "scoring_rules_marker", "scoring_rules_checksum", "requester_user_id", "generator_id", "request_id", "correlation_id", "execution_mode", "status", "outcome", "attempt_count", "error_code", "requested_at", "started_at", "generated_at", "completed_at", "failed_at", "regenerate_of_artifact_id", "regeneration_reason", "regeneration_policy", "scoring_policy_checksum", "legacy_source", "legacy_alias_version")
SELECT old."id",
       old."idempotency_key",
       old."definition_code",
       old."definition_version",
       old."report_template_version_id",
       old."template_version_marker",
       old."template_checksum",
       old."ticket_id",
       old."round_id",
       old."round_no",
       old."file_format",
       old."data_contract_version",
       old."context_checksum",
       old."renderer_version",
       old."app_commit",
       old."scoring_policy_version_id",
       old."scoring_rules_marker",
       old."scoring_rules_checksum",
       COALESCE((SELECT u.user_id FROM users u WHERE u.user_id = old."requester_user_id"), (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."requester_user_id")))),
       old."generator_id",
       old."request_id",
       old."correlation_id",
       old."execution_mode",
       old."status",
       old."outcome",
       old."attempt_count",
       old."error_code",
       old."requested_at",
       old."started_at",
       old."generated_at",
       old."completed_at",
       old."failed_at",
       old."regenerate_of_artifact_id",
       old."regeneration_reason",
       old."regeneration_policy",
       old."scoring_policy_checksum",
       old."legacy_source",
       old."legacy_alias_version" FROM "report_export_jobs" old;
DROP TABLE "report_export_jobs";
ALTER TABLE "__cutover_report_export_jobs" RENAME TO "report_export_jobs";

-- Rebuild report_exports.
CREATE TABLE "__cutover_report_exports" (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id          INTEGER NOT NULL,
  round_id           INTEGER,
  report_template_id INTEGER,
  report_type        TEXT NOT NULL CHECK (report_type IN ('INTERNAL', 'NCC', 'WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT')),
  file_format        TEXT NOT NULL DEFAULT 'PDF',
  export_scope       TEXT NOT NULL DEFAULT 'TICKET',
  file_path          TEXT NOT NULL,
  exported_by        TEXT,
  exported_at        TEXT NOT NULL DEFAULT (datetime('now')),
  report_template_version_id INTEGER REFERENCES report_template_versions(id) ON DELETE SET NULL,
  definition_code TEXT REFERENCES report_definitions(definition_code),
  context_checksum TEXT,
  component_checksum TEXT,
  scoring_compatibility_marker TEXT,
  job_id TEXT REFERENCES report_export_jobs(id) ON DELETE SET NULL,
  artifact_id INTEGER REFERENCES report_artifacts(id) ON DELETE SET NULL,
  availability_status TEXT NOT NULL DEFAULT 'LEGACY_UNASSESSED'
  CHECK (availability_status IN ('AVAILABLE', 'MISSING', 'QUARANTINED', 'DELETED', 'LEGACY_UNASSESSED')),
  legacy_reconciliation_status TEXT NOT NULL DEFAULT 'UNASSESSED'
  CHECK (legacy_reconciliation_status IN ('UNASSESSED', 'IMPORTABLE', 'IMPORTED', 'MISSING', 'OUTSIDE_ROOT', 'INVALID')),
  is_regenerated INTEGER NOT NULL DEFAULT 0 CHECK (is_regenerated IN (0, 1)),
  scoring_policy_version_id INTEGER,
  scoring_policy_checksum TEXT,
  legacy_source TEXT,
  legacy_alias_version TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (report_template_id) REFERENCES report_templates(id) ON DELETE SET NULL,
  FOREIGN KEY (exported_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_exports" ("id", "ticket_id", "round_id", "report_template_id", "report_type", "file_format", "export_scope", "file_path", "exported_by", "exported_at", "report_template_version_id", "definition_code", "context_checksum", "component_checksum", "scoring_compatibility_marker", "job_id", "artifact_id", "availability_status", "legacy_reconciliation_status", "is_regenerated", "scoring_policy_version_id", "scoring_policy_checksum", "legacy_source", "legacy_alias_version")
SELECT old."id",
       old."ticket_id",
       old."round_id",
       old."report_template_id",
       old."report_type",
       old."file_format",
       old."export_scope",
       old."file_path",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."exported_by"))),
       old."exported_at",
       old."report_template_version_id",
       old."definition_code",
       old."context_checksum",
       old."component_checksum",
       old."scoring_compatibility_marker",
       old."job_id",
       old."artifact_id",
       old."availability_status",
       old."legacy_reconciliation_status",
       old."is_regenerated",
       old."scoring_policy_version_id",
       old."scoring_policy_checksum",
       old."legacy_source",
       old."legacy_alias_version" FROM "report_exports" old;
DROP TABLE "report_exports";
ALTER TABLE "__cutover_report_exports" RENAME TO "report_exports";

-- Rebuild report_legacy_migration_review.
CREATE TABLE "__cutover_report_legacy_migration_review" (
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
  FOREIGN KEY (resolved_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_legacy_migration_review" ("id", "legacy_template_id", "legacy_source", "mapping_version", "reason_code", "proposed_canonical_code", "status", "created_at", "resolved_at", "resolved_by", "resolution_note")
SELECT old."id",
       old."legacy_template_id",
       old."legacy_source",
       old."mapping_version",
       old."reason_code",
       old."proposed_canonical_code",
       old."status",
       old."created_at",
       old."resolved_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."resolved_by"))),
       old."resolution_note" FROM "report_legacy_migration_review" old;
DROP TABLE "report_legacy_migration_review";
ALTER TABLE "__cutover_report_legacy_migration_review" RENAME TO "report_legacy_migration_review";

-- Rebuild report_legacy_template_links.
CREATE TABLE "__cutover_report_legacy_template_links" (
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
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_legacy_template_links" ("id", "legacy_template_id", "legacy_source", "canonical_definition_code", "report_template_version_id", "mapping_version", "decision_reference", "created_at", "created_by")
SELECT old."id",
       old."legacy_template_id",
       old."legacy_source",
       old."canonical_definition_code",
       old."report_template_version_id",
       old."mapping_version",
       old."decision_reference",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))) FROM "report_legacy_template_links" old;
DROP TABLE "report_legacy_template_links";
ALTER TABLE "__cutover_report_legacy_template_links" RENAME TO "report_legacy_template_links";

-- Rebuild report_template_assignments.
CREATE TABLE "__cutover_report_template_assignments" (
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
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL,
  UNIQUE (report_template_version_id, scope_type, scope_key),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
INSERT INTO "__cutover_report_template_assignments" ("id", "definition_code", "report_template_version_id", "scope_type", "scope_key", "effective_from", "effective_to", "is_default", "active", "created_at", "created_by", "updated_at", "updated_by")
SELECT old."id",
       old."definition_code",
       old."report_template_version_id",
       old."scope_type",
       old."scope_key",
       old."effective_from",
       old."effective_to",
       old."is_default",
       old."active",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))),
       old."updated_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."updated_by"))) FROM "report_template_assignments" old;
DROP TABLE "report_template_assignments";
ALTER TABLE "__cutover_report_template_assignments" RENAME TO "report_template_assignments";

-- Rebuild report_template_version_events.
CREATE TABLE "__cutover_report_template_version_events" (
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
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_report_template_version_events" ("id", "report_template_version_id", "action", "actor_user_id", "before_json", "after_json", "request_id", "correlation_id", "created_at")
SELECT old."id",
       old."report_template_version_id",
       old."action",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id"))),
       old."before_json",
       old."after_json",
       old."request_id",
       old."correlation_id",
       old."created_at" FROM "report_template_version_events" old;
DROP TABLE "report_template_version_events";
ALTER TABLE "__cutover_report_template_version_events" RENAME TO "report_template_version_events";

-- Rebuild report_template_versions.
CREATE TABLE "__cutover_report_template_versions" (
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
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (submitted_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (published_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (retired_by) REFERENCES users(user_id) ON DELETE SET NULL,
  UNIQUE (definition_code, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
INSERT INTO "__cutover_report_template_versions" ("id", "definition_code", "version_no", "version_name", "status", "definition_json", "schema_version", "checksum", "version_note", "effective_from", "effective_to", "lock_version", "created_at", "created_by", "updated_at", "updated_by", "submitted_at", "submitted_by", "published_at", "published_by", "retired_at", "retired_by")
SELECT old."id",
       old."definition_code",
       old."version_no",
       old."version_name",
       old."status",
       old."definition_json",
       old."schema_version",
       old."checksum",
       old."version_note",
       old."effective_from",
       old."effective_to",
       old."lock_version",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))),
       old."updated_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."updated_by"))),
       old."submitted_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."submitted_by"))),
       old."published_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."published_by"))),
       old."retired_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."retired_by"))) FROM "report_template_versions" old;
DROP TABLE "report_template_versions";
ALTER TABLE "__cutover_report_template_versions" RENAME TO "report_template_versions";

-- Rebuild role_permissions.
CREATE TABLE "__cutover_role_permissions" (
  role_id         INTEGER NOT NULL,
  permission_code TEXT NOT NULL,
  effect          TEXT NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW', 'DENY')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT,
  PRIMARY KEY (role_id, permission_code, effect),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_code) REFERENCES permissions(permission_code) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_role_permissions" ("role_id", "permission_code", "effect", "created_at", "created_by")
SELECT old."role_id",
       old."permission_code",
       old."effect",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))) FROM "role_permissions" old;
DROP TABLE "role_permissions";
ALTER TABLE "__cutover_role_permissions" RENAME TO "role_permissions";

-- Rebuild scoring_policy_version_events.
CREATE TABLE "__cutover_scoring_policy_version_events" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scoring_policy_version_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_user_id TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  decision_id TEXT,
  request_id TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (scoring_policy_version_id) REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_scoring_policy_version_events" ("id", "scoring_policy_version_id", "action", "actor_user_id", "before_json", "after_json", "decision_id", "request_id", "correlation_id", "created_at")
SELECT old."id",
       old."scoring_policy_version_id",
       old."action",
       COALESCE((SELECT u.user_id FROM users u WHERE u.user_id = old."actor_user_id"), (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."before_json",
       old."after_json",
       old."decision_id",
       old."request_id",
       old."correlation_id",
       old."created_at" FROM "scoring_policy_version_events" old;
DROP TABLE "scoring_policy_version_events";
ALTER TABLE "__cutover_scoring_policy_version_events" RENAME TO "scoring_policy_version_events";

-- Rebuild supplier_import_batches.
CREATE TABLE "__cutover_supplier_import_batches" (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT NOT NULL,
  uploaded_by    TEXT,
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  total_rows     INTEGER NOT NULL DEFAULT 0,
  success_rows   INTEGER NOT NULL DEFAULT 0,
  failed_rows    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL')),
  error_summary  TEXT,
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_supplier_import_batches" ("id", "file_name", "uploaded_by", "uploaded_at", "total_rows", "success_rows", "failed_rows", "status", "error_summary")
SELECT old."id",
       old."file_name",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."uploaded_by"))),
       old."uploaded_at",
       old."total_rows",
       old."success_rows",
       old."failed_rows",
       old."status",
       old."error_summary" FROM "supplier_import_batches" old;
DROP TABLE "supplier_import_batches";
ALTER TABLE "__cutover_supplier_import_batches" RENAME TO "supplier_import_batches";

-- Rebuild supplier_master.
CREATE TABLE "__cutover_supplier_master" (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code   TEXT NOT NULL UNIQUE,
  supplier_name   TEXT NOT NULL,
  tax_code        TEXT,
  address         TEXT,
  region          TEXT,
  province        TEXT,
  business_type   TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  source_type     TEXT NOT NULL CHECK (source_type IN ('EXCEL_UPLOAD', 'MANUAL')),
  import_batch_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  FOREIGN KEY (import_batch_id) REFERENCES supplier_import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_supplier_master" ("id", "supplier_code", "supplier_name", "tax_code", "address", "region", "province", "business_type", "status", "contact_name", "contact_email", "contact_phone", "source_type", "import_batch_id", "created_at", "created_by", "updated_at", "updated_by")
SELECT old."id",
       old."supplier_code",
       old."supplier_name",
       old."tax_code",
       old."address",
       old."region",
       old."province",
       old."business_type",
       old."status",
       old."contact_name",
       old."contact_email",
       old."contact_phone",
       old."source_type",
       old."import_batch_id",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))),
       old."updated_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."updated_by"))) FROM "supplier_master" old;
DROP TABLE "supplier_master";
ALTER TABLE "__cutover_supplier_master" RENAME TO "supplier_master";

-- Rebuild supplier_master_history.
CREATE TABLE "__cutover_supplier_master_history" (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER,
  supplier_code   TEXT NOT NULL,
  actor_user_id   TEXT,
  action          TEXT NOT NULL,
  comment         TEXT,
  field_name      TEXT,
  previous_value  TEXT,
  new_value       TEXT,
  payload_json    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_supplier_master_history" ("id", "supplier_id", "supplier_code", "actor_user_id", "action", "comment", "field_name", "previous_value", "new_value", "payload_json", "created_at")
SELECT old."id",
       old."supplier_id",
       old."supplier_code",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id"))),
       old."action",
       old."comment",
       old."field_name",
       old."previous_value",
       old."new_value",
       old."payload_json",
       old."created_at" FROM "supplier_master_history" old;
DROP TABLE "supplier_master_history";
ALTER TABLE "__cutover_supplier_master_history" RENAME TO "supplier_master_history";

-- Rebuild user_roles.
CREATE TABLE "__cutover_user_roles" (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  role_id    INTEGER NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  valid_from TEXT,
  valid_until TEXT,
  source     TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'LEGACY_COMPAT', 'IDP', 'MIGRATION')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT,
  UNIQUE (user_id, role_id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_user_roles" ("id", "user_id", "role_id", "active", "valid_from", "valid_until", "source", "created_at", "created_by", "updated_at")
SELECT old."id",
       COALESCE(old."principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."user_id")))),
       old."role_id",
       old."active",
       old."valid_from",
       old."valid_until",
       old."source",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))),
       old."updated_at" FROM "user_roles" old;
DROP TABLE "user_roles";
ALTER TABLE "__cutover_user_roles" RENAME TO "user_roles";

-- Rebuild user_scope_assignments.
CREATE TABLE "__cutover_user_scope_assignments" (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  role_id     INTEGER,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('GLOBAL', 'REGION', 'MCH2', 'ASSIGNED', 'OWN', 'SUPPLIER', 'CUSTOM')),
  scope_value TEXT,
  effect      TEXT NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW', 'DENY')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  valid_from  TEXT,
  valid_until TEXT,
  custom_schema_code TEXT,
  custom_schema_version INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by  TEXT,
  source      TEXT NOT NULL DEFAULT 'MANUAL',
  CHECK ((scope_type = 'GLOBAL' AND scope_value IS NULL) OR (scope_type != 'GLOBAL' AND scope_value IS NOT NULL)),
  CHECK (scope_type != 'MCH2' OR (length(scope_value) > 0 AND (scope_value NOT GLOB '*[^0-9]*' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'))),
  CHECK (scope_type != 'CUSTOM' OR (custom_schema_code IS NOT NULL AND custom_schema_version IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_user_scope_assignments" ("id", "user_id", "role_id", "scope_type", "scope_value", "effect", "active", "valid_from", "valid_until", "custom_schema_code", "custom_schema_version", "created_at", "created_by", "source")
SELECT old."id",
       COALESCE(old."principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."user_id")))),
       old."role_id",
       old."scope_type",
       old."scope_value",
       old."effect",
       old."active",
       old."valid_from",
       old."valid_until",
       old."custom_schema_code",
       old."custom_schema_version",
       old."created_at",
       (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."created_by"))),
       old."source" FROM "user_scope_assignments" old;
DROP TABLE "user_scope_assignments";
ALTER TABLE "__cutover_user_scope_assignments" RENAME TO "user_scope_assignments";

-- Rebuild workflow_history.
CREATE TABLE "__cutover_workflow_history" (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL,
  actor_user_id TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
INSERT INTO "__cutover_workflow_history" ("id", "ticket_id", "actor_user_id", "actor_role", "action", "from_status", "to_status", "comment", "created_at")
SELECT old."id",
       old."ticket_id",
       COALESCE(old."actor_principal_id", (SELECT u.user_id FROM users u WHERE lower(u.email) = lower(trim(old."actor_user_id")))),
       old."actor_role",
       old."action",
       old."from_status",
       old."to_status",
       old."comment",
       old."created_at" FROM "workflow_history" old;
DROP TABLE "workflow_history";
ALTER TABLE "__cutover_workflow_history" RENAME TO "workflow_history";

-- Replace the email-primary-key users table last, after every dependent row is canonicalized.
CREATE TABLE __cutover_users (
  user_id       TEXT NOT NULL PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', (random() & 3) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))
  ) CHECK (trim(user_id) <> ''),
  email         TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (email = lower(trim(email)) AND trim(email) <> ''),
  display_name  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  authz_version INTEGER NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT
);
INSERT INTO __cutover_users (user_id, email, display_name, is_active, authz_version, created_at, created_by)
SELECT user_id, lower(trim(email)), display_name, is_active, authz_version, created_at, created_by FROM users;
DROP TABLE users;
ALTER TABLE __cutover_users RENAME TO users;

-- Recreate preserved indexes and business triggers.
CREATE INDEX idx_stage_assignments_lookup ON approval_stage_assignments(workflow_type, stage_code, active, priority);
CREATE INDEX idx_approval_tasks_assigned_user ON approval_tasks(assigned_user_id, status);
CREATE INDEX idx_approval_tasks_level_status ON approval_tasks(approval_level, status);
CREATE INDEX idx_approval_tasks_ticket ON approval_tasks(ticket_id);
CREATE INDEX idx_audit_events_actor_time ON audit_events(actor_user_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_category_time
  ON audit_events(category, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_correlation
  ON audit_events(correlation_id, id);
CREATE INDEX idx_audit_events_entity_time ON audit_events(entity_type, entity_id, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_name_time ON audit_events(event_name, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_outcome_time
  ON audit_events(outcome, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_request ON audit_events(request_id, id);
CREATE INDEX idx_audit_events_severity_time
  ON audit_events(severity, occurred_at DESC, id DESC);
CREATE INDEX idx_audit_events_uat_run ON audit_events(uat_run_id, id) WHERE uat_run_id IS NOT NULL;
CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;
CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_append_only');
END;
CREATE INDEX idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_authz_change_object_time
  ON authz_change_log(object_type, object_key, created_at DESC);
CREATE INDEX idx_authz_change_target_time ON authz_change_log(target_user_id, created_at DESC);
CREATE INDEX idx_correction_extensions_ticket ON correction_extensions(ticket_id, extension_no);
CREATE INDEX idx_eval_answers_round ON evaluation_answers(round_id);
CREATE INDEX idx_eval_answers_score ON evaluation_answers(score);
CREATE INDEX idx_evaluation_answers_question_item
  ON evaluation_answers(question_item_id, round_id);
CREATE INDEX idx_eval_attachments_answer ON evaluation_attachments(answer_id);
CREATE INDEX idx_eval_attachments_ticket ON evaluation_attachments(ticket_id);
CREATE INDEX idx_eval_attachments_uploaded_at ON evaluation_attachments(uploaded_at DESC);
CREATE INDEX idx_eval_nonconformities_round ON evaluation_nonconformities(round_id);
CREATE INDEX idx_eval_nonconformities_status_due ON evaluation_nonconformities(status, due_date);
CREATE INDEX idx_eval_nonconformities_ticket ON evaluation_nonconformities(ticket_id);
CREATE INDEX idx_evaluation_nonconformities_answer ON evaluation_nonconformities(evaluation_answer_id);
CREATE INDEX idx_evaluation_nonconformities_corrective_requirement
  ON evaluation_nonconformities(corrective_requirement_id);
CREATE UNIQUE INDEX ux_evaluation_nonconformities_answer
  ON evaluation_nonconformities(evaluation_answer_id)
  WHERE evaluation_answer_id IS NOT NULL;
CREATE INDEX idx_evaluation_participants_round
  ON evaluation_participants(round_id, participant_role, active);
CREATE UNIQUE INDEX idx_evaluation_participants_round_identity
  ON evaluation_participants(
    round_id, participant_role, COALESCE(user_id, ''), lower(trim(display_name))
  ) WHERE round_id IS NOT NULL;
CREATE INDEX idx_evaluation_participants_ticket
  ON evaluation_participants(ticket_id, participant_role, active);
CREATE UNIQUE INDEX idx_evaluation_participants_ticket_identity
  ON evaluation_participants(
    ticket_id, participant_role, COALESCE(user_id, ''), lower(trim(display_name))
  ) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_evaluation_participants_user
  ON evaluation_participants(user_id, active);
CREATE INDEX idx_eval_rounds_assessment_code ON evaluation_rounds(assessment_code);
CREATE INDEX idx_eval_rounds_source ON evaluation_rounds(source_round_id);
CREATE INDEX idx_eval_rounds_status ON evaluation_rounds(status);
CREATE INDEX idx_eval_rounds_ticket_round ON evaluation_rounds(ticket_id, round_no);
CREATE INDEX idx_evaluation_rounds_scoring_policy ON evaluation_rounds(scoring_policy_version_id);
CREATE INDEX idx_evaluation_rounds_ticket_scoring
  ON evaluation_rounds(ticket_id, scoring_policy_version_id, round_no);
CREATE TRIGGER evaluation_round_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_rounds
WHEN OLD.scoring_policy_version_id IS NOT NULL
  AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'round_scoring_policy_pin_immutable'); END;
CREATE TRIGGER evaluation_round_scoring_policy_pin_insert
AFTER INSERT ON evaluation_rounds
WHEN NEW.scoring_policy_version_id IS NULL
  AND (SELECT source_kind FROM evaluation_tickets WHERE id = NEW.ticket_id) = 'NATIVE'
BEGIN
  UPDATE evaluation_rounds SET scoring_policy_version_id = (
    SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id = NEW.ticket_id
  ) WHERE id = NEW.id;
END;
CREATE INDEX idx_eval_tickets_code ON evaluation_tickets(ticket_code);
CREATE INDEX idx_eval_tickets_created_at ON evaluation_tickets(created_at DESC);
CREATE INDEX idx_eval_tickets_deleted_status ON evaluation_tickets(is_deleted, current_status);
CREATE INDEX idx_eval_tickets_specialist ON evaluation_tickets(assigned_specialist_id);
CREATE INDEX idx_eval_tickets_status ON evaluation_tickets(current_status);
CREATE INDEX idx_eval_tickets_supplier ON evaluation_tickets(supplier_id);
CREATE INDEX idx_evaluation_tickets_question_version ON evaluation_tickets(question_template_version_id);
CREATE INDEX idx_evaluation_tickets_scoring_policy ON evaluation_tickets(scoring_policy_version_id);
CREATE INDEX idx_evaluation_tickets_snapshot_lock ON evaluation_tickets(snapshot_locked_at, id);
CREATE INDEX idx_evaluation_tickets_source_kind ON evaluation_tickets(source_kind, current_status);
CREATE UNIQUE INDEX ux_evaluation_tickets_historical_source_key
  ON evaluation_tickets(historical_source_key)
  WHERE historical_source_key IS NOT NULL;
CREATE TRIGGER evaluation_ticket_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_tickets
WHEN OLD.scoring_policy_version_id IS NOT NULL
  AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'ticket_scoring_policy_pin_immutable'); END;
CREATE TRIGGER evaluation_ticket_scoring_policy_pin_insert
AFTER INSERT ON evaluation_tickets
WHEN NEW.source_kind = 'NATIVE' AND NEW.scoring_policy_version_id IS NULL
BEGIN
  UPDATE evaluation_tickets SET scoring_policy_version_id = (
    SELECT a.scoring_policy_version_id
    FROM scoring_policy_assignments a
    JOIN scoring_policy_versions v ON v.id = a.scoring_policy_version_id
    WHERE a.active = 1 AND a.is_default = 1 AND v.status = 'PUBLISHED'
      AND (a.effective_from IS NULL OR a.effective_from <= datetime('now'))
      AND (a.effective_to IS NULL OR a.effective_to > datetime('now'))
      AND (a.template_id IS NULL OR a.template_id = NEW.template_id)
      AND (a.facility_type = 'ALL' OR a.facility_type = NEW.facility_type)
      AND (a.supplier_scale = 'ALL' OR a.supplier_scale = NEW.supplier_scale)
      AND (a.evaluation_type = 'ALL' OR a.evaluation_type = NEW.evaluation_type)
    ORDER BY
      CASE WHEN a.template_id = NEW.template_id THEN 1 ELSE 0 END DESC,
      CASE WHEN a.facility_type = NEW.facility_type THEN 1 ELSE 0 END DESC,
      CASE WHEN a.supplier_scale = NEW.supplier_scale THEN 1 ELSE 0 END DESC,
      CASE WHEN a.evaluation_type = NEW.evaluation_type THEN 1 ELSE 0 END DESC,
      v.version_no DESC
    LIMIT 1
  ) WHERE id = NEW.id;
END;
CREATE INDEX idx_notifications_receiver_read_time
  ON notifications(receiver_user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_ticket
  ON notifications(ticket_id, created_at DESC);
CREATE UNIQUE INDEX idx_notifications_unique_key
  ON notifications(unique_key);
CREATE INDEX idx_personnel_import_batches_actor_time
  ON personnel_import_batches(actor_user_id, committed_at DESC, id DESC);
CREATE INDEX idx_personnel_import_batches_source_hash
  ON personnel_import_batches(source_sha256);
CREATE TRIGGER personnel_import_batches_append_only_delete
BEFORE DELETE ON personnel_import_batches BEGIN
  SELECT RAISE(ABORT, 'personnel_import_batches_append_only');
END;
CREATE TRIGGER personnel_import_batches_append_only_update
BEFORE UPDATE ON personnel_import_batches BEGIN
  SELECT RAISE(ABORT, 'personnel_import_batches_append_only');
END;
CREATE INDEX idx_question_import_events_batch_time
  ON question_import_events(batch_id, created_at, id);
CREATE TRIGGER question_import_events_append_only_delete
BEFORE DELETE ON question_import_events BEGIN
  SELECT RAISE(ABORT, 'question_import_events_append_only');
END;
CREATE TRIGGER question_import_events_append_only_update
BEFORE UPDATE ON question_import_events BEGIN
  SELECT RAISE(ABORT, 'question_import_events_append_only');
END;
CREATE INDEX idx_question_version_events_version_time
  ON question_template_version_events(question_template_version_id, created_at, id);
CREATE TRIGGER question_version_events_append_only_delete
BEFORE DELETE ON question_template_version_events BEGIN
  SELECT RAISE(ABORT, 'question_version_events_append_only');
END;
CREATE TRIGGER question_version_events_append_only_update
BEFORE UPDATE ON question_template_version_events BEGIN
  SELECT RAISE(ABORT, 'question_version_events_append_only');
END;
CREATE INDEX idx_report_artifact_events_job_time
  ON report_artifact_events(job_id, created_at, id);
CREATE TRIGGER trg_report_artifact_event_append_only_delete
BEFORE DELETE ON report_artifact_events
BEGIN
  SELECT RAISE(ABORT, 'report_artifact_event_append_only');
END;
CREATE TRIGGER trg_report_artifact_event_append_only_update
BEFORE UPDATE ON report_artifact_events
BEGIN
  SELECT RAISE(ABORT, 'report_artifact_event_append_only');
END;
CREATE INDEX idx_report_export_jobs_status_time
  ON report_export_jobs(status, requested_at, id);
CREATE INDEX idx_report_export_jobs_ticket_time
  ON report_export_jobs(ticket_id, requested_at DESC, id DESC);
CREATE UNIQUE INDEX idx_report_exports_artifact ON report_exports(artifact_id) WHERE artifact_id IS NOT NULL;
CREATE UNIQUE INDEX idx_report_exports_job ON report_exports(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_report_exports_provenance_status
  ON report_exports(legacy_reconciliation_status, availability_status, exported_at DESC);
CREATE INDEX idx_report_exports_round ON report_exports(round_id);
CREATE INDEX idx_report_exports_template_version
  ON report_exports(report_template_version_id, exported_at DESC);
CREATE INDEX idx_report_exports_ticket ON report_exports(ticket_id);
CREATE INDEX idx_report_exports_type_time ON report_exports(report_type, exported_at DESC);
CREATE INDEX idx_report_legacy_review_status
  ON report_legacy_migration_review(status, legacy_source, id);
CREATE INDEX idx_report_legacy_links_canonical
  ON report_legacy_template_links(canonical_definition_code, report_template_version_id);
CREATE TRIGGER trg_report_legacy_link_immutable_delete
BEFORE DELETE ON report_legacy_template_links
BEGIN
  SELECT RAISE(ABORT, 'report_legacy_template_link_immutable');
END;
CREATE TRIGGER trg_report_legacy_link_immutable_update
BEFORE UPDATE ON report_legacy_template_links
BEGIN
  SELECT RAISE(ABORT, 'report_legacy_template_link_immutable');
END;
CREATE UNIQUE INDEX idx_report_template_assignments_one_default
  ON report_template_assignments(definition_code, scope_type, scope_key)
  WHERE active = 1 AND is_default = 1;
CREATE INDEX idx_report_template_assignments_resolve
  ON report_template_assignments(definition_code, scope_type, scope_key, active, is_default, effective_from, effective_to);
CREATE INDEX idx_report_template_version_events_version_time
  ON report_template_version_events(report_template_version_id, created_at DESC, id DESC);
CREATE TRIGGER trg_report_template_event_append_only_delete
BEFORE DELETE ON report_template_version_events
BEGIN
  SELECT RAISE(ABORT, 'report_template_event_append_only');
END;
CREATE TRIGGER trg_report_template_event_append_only_update
BEFORE UPDATE ON report_template_version_events
BEGIN
  SELECT RAISE(ABORT, 'report_template_event_append_only');
END;
CREATE INDEX idx_report_template_versions_catalog
  ON report_template_versions(definition_code, status, version_no DESC);
CREATE TRIGGER trg_report_published_content_immutable
BEFORE UPDATE OF definition_code, version_no, version_name, definition_json,
  schema_version, checksum, version_note, effective_from, effective_to
ON report_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_report_template_immutable');
END;
CREATE TRIGGER trg_report_published_delete_immutable
BEFORE DELETE ON report_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_report_template_immutable');
END;
CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_code, effect);
CREATE TRIGGER role_permissions_version_delete AFTER DELETE ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id AND active = 1) AND revoked_at IS NULL;
END;
CREATE TRIGGER role_permissions_version_insert AFTER INSERT ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id AND active = 1) AND revoked_at IS NULL;
END;
CREATE TRIGGER role_permissions_version_update AFTER UPDATE ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id IN (OLD.role_id, NEW.role_id) AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id IN (OLD.role_id, NEW.role_id) AND active = 1) AND revoked_at IS NULL;
END;
CREATE INDEX idx_scoring_policy_events_version_time
  ON scoring_policy_version_events(scoring_policy_version_id, created_at, id);
CREATE TRIGGER scoring_policy_event_append_only_delete
BEFORE DELETE ON scoring_policy_version_events
BEGIN SELECT RAISE(ABORT, 'scoring_policy_event_append_only'); END;
CREATE TRIGGER scoring_policy_event_append_only_update
BEFORE UPDATE ON scoring_policy_version_events
BEGIN SELECT RAISE(ABORT, 'scoring_policy_event_append_only'); END;
CREATE INDEX idx_supplier_import_batches_status ON supplier_import_batches(status);
CREATE INDEX idx_supplier_import_batches_uploaded_at ON supplier_import_batches(uploaded_at DESC);
CREATE INDEX idx_supplier_master_code ON supplier_master(supplier_code);
CREATE INDEX idx_supplier_master_name ON supplier_master(supplier_name);
CREATE INDEX idx_supplier_master_region ON supplier_master(region, province);
CREATE INDEX idx_supplier_master_status ON supplier_master(status);
CREATE UNIQUE INDEX ux_supplier_master_code_normalized
  ON supplier_master (UPPER(TRIM(supplier_code)));
CREATE INDEX idx_supplier_master_history_code_time ON supplier_master_history(supplier_code, created_at DESC, id DESC);
CREATE INDEX idx_supplier_master_history_supplier_time ON supplier_master_history(supplier_id, created_at DESC, id DESC);
CREATE INDEX idx_user_roles_active_window
  ON user_roles(user_id, active, valid_from, valid_until, role_id);
CREATE INDEX idx_user_roles_role_active ON user_roles(role_id, active, valid_until);
CREATE INDEX idx_user_roles_user_active ON user_roles(user_id, active, valid_until);
CREATE TRIGGER prevent_last_super_admin_role_delete
BEFORE DELETE ON user_roles
WHEN OLD.active = 1
 AND (SELECT role_code FROM roles WHERE id = OLD.role_id) = 'SYS_ADMIN'
 AND (SELECT is_active FROM users WHERE user_id = OLD.user_id) = 1
 AND (OLD.valid_from IS NULL OR OLD.valid_from <= datetime('now'))
 AND (OLD.valid_until IS NULL OR OLD.valid_until > datetime('now'))
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.user_id = ur.user_id
      WHERE r.role_code = 'SYS_ADMIN' AND r.active = 1 AND ur.active = 1 AND u.is_active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))) <= 1
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;
CREATE TRIGGER prevent_last_super_admin_role_update
BEFORE UPDATE OF active, role_id, user_id, valid_from, valid_until ON user_roles
WHEN OLD.active = 1
 AND (SELECT role_code FROM roles WHERE id = OLD.role_id) = 'SYS_ADMIN'
 AND (OLD.valid_from IS NULL OR OLD.valid_from <= datetime('now'))
 AND (OLD.valid_until IS NULL OR OLD.valid_until > datetime('now'))
 AND (NEW.active = 0 OR NEW.role_id != OLD.role_id OR NEW.user_id != OLD.user_id
      OR (NEW.valid_from IS NOT NULL AND NEW.valid_from > datetime('now'))
      OR (NEW.valid_until IS NOT NULL AND NEW.valid_until <= datetime('now')))
 AND (SELECT is_active FROM users WHERE user_id = OLD.user_id) = 1
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.user_id = ur.user_id
      WHERE r.role_code = 'SYS_ADMIN' AND r.active = 1 AND ur.active = 1 AND u.is_active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))) <= 1
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;
CREATE TRIGGER user_roles_version_delete AFTER DELETE ON user_roles BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id = OLD.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_roles_version_insert AFTER INSERT ON user_roles BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id = NEW.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_roles_version_update
AFTER UPDATE OF user_id, role_id, active, valid_from, valid_until, source ON user_roles
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
    WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;
CREATE UNIQUE INDEX idx_user_scopes_active_unique
  ON user_scope_assignments(user_id, COALESCE(role_id, -1), scope_type, COALESCE(scope_value, ''), effect)
  WHERE active = 1;
CREATE INDEX idx_user_scopes_user_active ON user_scope_assignments(user_id, active, valid_until);
CREATE TRIGGER user_scopes_version_delete AFTER DELETE ON user_scope_assignments BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id = OLD.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_scopes_version_insert AFTER INSERT ON user_scope_assignments BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id = NEW.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_scopes_version_update
AFTER UPDATE OF user_id, role_id, scope_type, scope_value, effect, active, valid_from, valid_until,
  custom_schema_code, custom_schema_version, source ON user_scope_assignments
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
    WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;
CREATE INDEX idx_workflow_history_actor ON workflow_history(actor_user_id, created_at DESC);
CREATE INDEX idx_workflow_history_ticket_time ON workflow_history(ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_email_lookup ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_active ON user_roles(user_id, active);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user_active ON user_scope_assignments(user_id, active);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_authz_change_actor_user ON authz_change_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_authz_change_target_user ON authz_change_log(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor_user_time ON audit_events(actor_user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_evaluation_participants_user ON evaluation_participants(user_id, ticket_id, round_id);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_assigned_user ON approval_tasks(assigned_user_id, status);
CREATE INDEX IF NOT EXISTS idx_workflow_history_actor_user ON workflow_history(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_receiver_user ON notifications(receiver_user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_approval_stage_assigned_user ON approval_stage_assignments(assigned_user_id, active);

CREATE TRIGGER roles_active_version_update AFTER UPDATE OF active ON roles
WHEN NEW.active != OLD.active
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id IN (
    SELECT user_id FROM user_roles WHERE role_id = NEW.id AND active = 1
  );
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
  WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.id AND active = 1) AND revoked_at IS NULL;
END;

CREATE TRIGGER prevent_super_admin_role_disable
BEFORE UPDATE OF active ON roles
WHEN OLD.role_code = 'SYS_ADMIN' AND OLD.active = 1 AND NEW.active = 0
 AND EXISTS (
   SELECT 1 FROM user_roles ur JOIN users u ON u.user_id = ur.user_id
   WHERE ur.role_id = OLD.id AND ur.active = 1 AND u.is_active = 1
     AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
     AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
 )
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;

CREATE TRIGGER users_user_id_immutable
BEFORE UPDATE OF user_id ON users
WHEN NEW.user_id IS NOT OLD.user_id
BEGIN SELECT RAISE(ABORT, 'user_id_immutable'); END;

CREATE TRIGGER users_active_authz_invalidation
AFTER UPDATE OF is_active ON users
WHEN OLD.is_active IS NOT NEW.is_active
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE user_id = NEW.user_id;
  UPDATE auth_sessions
  SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'ACCOUNT_STATUS_CHANGED'
  WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER prevent_last_super_admin_user_deactivate
BEFORE UPDATE OF is_active ON users
WHEN OLD.is_active = 1 AND NEW.is_active = 0
 AND EXISTS (
   SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = OLD.user_id AND ur.active = 1 AND r.active = 1 AND r.role_code = 'SYS_ADMIN'
     AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
     AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
 )
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.user_id = ur.user_id
      WHERE r.role_code = 'SYS_ADMIN' AND r.active = 1 AND ur.active = 1 AND u.is_active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))) <= 1
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;

CREATE TRIGGER users_open_evaluation_work_deactivation_guard
BEFORE UPDATE OF is_active ON users
WHEN OLD.is_active = 1 AND NEW.is_active = 0 AND (
  EXISTS (
    SELECT 1 FROM evaluation_tickets t
    WHERE t.source_kind = 'NATIVE' AND t.is_deleted = 0
      AND t.current_status NOT IN ('Hoàn thành', 'Hủy')
      AND (
        t.assigned_specialist_id = OLD.user_id OR EXISTS (
          SELECT 1 FROM evaluation_participants p
          LEFT JOIN evaluation_rounds er ON er.id = p.round_id
          WHERE p.active = 1 AND p.user_id = OLD.user_id
            AND p.participant_role IN ('OWNER', 'EVALUATOR')
            AND (p.ticket_id = t.id OR (er.ticket_id = t.id AND er.completed_at IS NULL))
        )
      )
  ) OR EXISTS (
    SELECT 1 FROM approval_tasks a JOIN evaluation_tickets t ON t.id = a.ticket_id
    WHERE a.assigned_user_id = OLD.user_id AND a.status = 'PENDING'
      AND t.source_kind = 'NATIVE' AND t.is_deleted = 0
      AND t.current_status NOT IN ('Hoàn thành', 'Hủy')
  ) OR EXISTS (
    SELECT 1 FROM approval_stage_assignments
    WHERE workflow_type = 'EVALUATION' AND assigned_user_id = OLD.user_id AND active = 1
      AND (valid_from IS NULL OR valid_from <= datetime('now'))
      AND (valid_until IS NULL OR valid_until > datetime('now'))
  )
)
BEGIN SELECT RAISE(ABORT, 'work_transfer_required'); END;

INSERT INTO authz_change_log
  (change_type, object_type, object_key, after_json, reason)
VALUES
  ('MIGRATION_APPLIED', 'USER_IDENTITY', '0040_users_user_id_primary_key',
   json_object('strategy', 'final_cutover', 'identity_key', 'user_id', 'email_foreign_keys', 0),
   'Final immutable user_id primary-key cutover');

CREATE VIEW pinned_evaluation_questions AS
SELECT
  t.id AS ticket_id,
  qi.id AS id,
  qi.id AS version_item_id,
  v.template_id,
  qt.template_code,
  qi.facility_type,
  qi.supplier_scale,
  qi.question_code,
  qi.question_text,
  qi.category,
  qi.category_code,
  COALESCE(qi.category_label_snapshot, qi.category) AS category_label_snapshot,
  qi.is_elimination_clause,
  qi.is_critical_clause,
  qi.requires_attachment,
  qi.allowed_scores,
  qi.order_index,
  qi.active,
  qi.created_at,
  NULL AS updated_at
FROM evaluation_tickets t
JOIN question_template_versions v ON v.id = t.question_template_version_id
JOIN question_templates qt ON qt.id = v.template_id
JOIN question_items qi ON qi.question_template_version_id = v.id;
