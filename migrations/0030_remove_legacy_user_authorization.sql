-- Stage 5 closes the users.role/users.is_admin compatibility window. Runtime
-- authorization has used canonical RBAC since 0029; abort before rebuilding
-- whenever any account or pre-cutover session is not safely represented.

CREATE TEMP TABLE stage5_user_cleanup_guard (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

-- The cutover must have invalidated sessions and established user_roles first.
INSERT INTO stage5_user_cleanup_guard (violation_count)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM schema_migrations WHERE migration_id = '0029'
) THEN 0 ELSE 1 END;
DELETE FROM stage5_user_cleanup_guard;

-- Preserve authorization history for every account, including inactive ones.
INSERT INTO stage5_user_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  WHERE ur.user_id = u.email
);
DELETE FROM stage5_user_cleanup_guard;

-- Every active account must retain one currently-effective canonical role.
INSERT INTO stage5_user_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM users u
WHERE u.is_active = 1
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = u.email
      AND ur.active = 1
      AND r.active = 1
      AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
      AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
  );
DELETE FROM stage5_user_cleanup_guard;

-- A historical administrator flag may only be discarded after SYS_ADMIN is
-- represented canonically. Other stale legacy labels intentionally do not win
-- over the canonical assignments selected during Stage 4E.
INSERT INTO stage5_user_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM users u
WHERE u.is_active = 1
  AND u.is_admin = 1
  AND NOT EXISTS (
    SELECT 1
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = u.email
      AND ur.active = 1
      AND r.active = 1
      AND r.role_code = 'SYS_ADMIN'
      AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
      AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
  );
DELETE FROM stage5_user_cleanup_guard;

-- No session issued under the pre-cutover model may remain live.
INSERT INTO stage5_user_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM auth_sessions s
JOIN schema_migrations cutover ON cutover.migration_id = '0029'
WHERE datetime(s.issued_at) <= datetime(cutover.applied_at)
  AND s.revoked_at IS NULL;
DELETE FROM stage5_user_cleanup_guard;

-- SQLite performs the table rewrite internally and preserves every FK/index/
-- trigger that does not reference the retired columns. Keeping FK enforcement
-- enabled avoids a no-table interval across the many users(email) consumers.
ALTER TABLE users DROP COLUMN role;
ALTER TABLE users DROP COLUMN is_admin;

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES (
  'MIGRATION_APPLIED',
  'MIGRATION',
  '0030_remove_legacy_user_authorization',
  json_object(
    'authorization_source', 'user_roles',
    'removed_columns', json_array('role', 'is_admin'),
    'report_provenance_cleanup', 'DEFERRED'
  )
);

DROP TABLE stage5_user_cleanup_guard;
