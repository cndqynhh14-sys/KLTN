-- Stage 4E makes user_roles the authorization source of truth. Legacy user
-- columns remain physically present until the separate, full-UAT cleanup gate.

CREATE TEMP TABLE stage4e_rbac_cutover_guard (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

-- Every active account needs at least one currently-effective canonical role.
INSERT INTO stage4e_rbac_cutover_guard (violation_count)
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
DELETE FROM stage4e_rbac_cutover_guard;

-- A historical admin flag may not silently lose administrator access at cutover.
INSERT INTO stage4e_rbac_cutover_guard (violation_count)
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
DELETE FROM stage4e_rbac_cutover_guard;

-- Invalidate every token/session issued under the compatibility authorization
-- model, even when its role assignment did not otherwise change.
UPDATE users SET authz_version = authz_version + 1;
UPDATE auth_sessions
SET revoked_at = COALESCE(revoked_at, datetime('now')),
    revoke_reason = CASE
      WHEN revoked_at IS NULL THEN 'RBAC_CANONICAL_CUTOVER'
      ELSE revoke_reason
    END;

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES (
  'MIGRATION_APPLIED',
  'MIGRATION',
  '0029_rbac_canonical_cutover',
  json_object('authorization_source', 'user_roles', 'legacy_columns_retained', 1)
);

DROP TABLE stage4e_rbac_cutover_guard;
