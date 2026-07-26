-- RUN-06: compatibility scopes used by the shared policy engine.
ALTER TABLE user_scope_assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL';

UPDATE user_scope_assignments
SET source = 'LEGACY_COMPAT'
WHERE EXISTS (
  SELECT 1 FROM user_roles ur
  WHERE ur.user_id = user_scope_assignments.user_id
    AND ur.role_id = user_scope_assignments.role_id
    AND ur.source = 'LEGACY_COMPAT'
);

-- Specialists historically see only evaluation records they created and input
-- dossiers assigned to them. Keep that effective scope without using role labels.
UPDATE user_scope_assignments
SET active = 0
WHERE source = 'LEGACY_COMPAT'
  AND scope_type = 'GLOBAL'
  AND role_id = (SELECT id FROM roles WHERE role_code = 'QLCL_SPECIALIST');

INSERT INTO user_scope_assignments
  (user_id, role_id, scope_type, scope_value, effect, source)
SELECT ur.user_id, ur.role_id, 'OWN', 'SELF', 'ALLOW', 'LEGACY_COMPAT'
FROM user_roles ur JOIN roles r ON r.id = ur.role_id
WHERE r.role_code = 'QLCL_SPECIALIST' AND ur.active = 1
ON CONFLICT DO NOTHING;

INSERT INTO user_scope_assignments
  (user_id, role_id, scope_type, scope_value, effect, source)
SELECT ur.user_id, ur.role_id, 'ASSIGNED', 'SELF', 'ALLOW', 'LEGACY_COMPAT'
FROM user_roles ur JOIN roles r ON r.id = ur.role_id
WHERE r.role_code = 'QLCL_SPECIALIST' AND ur.active = 1
ON CONFLICT DO NOTHING;

-- Preserve the pre-policy upload behavior for QLCL specialists.
INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT id, 'UPLOAD.MANAGE', 'ALLOW' FROM roles WHERE role_code = 'QLCL_SPECIALIST'
ON CONFLICT DO NOTHING;

-- Lead miền did not have access to the input-dossier module before policy
-- enforcement. Preserve that effective behavior in compatibility mode.
UPDATE role_permissions
SET effect = 'DENY'
WHERE role_id = (SELECT id FROM roles WHERE role_code = 'REGIONAL_LEAD_APPROVER')
  AND permission_code = 'INPUT_DOSSIER.READ';

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES ('MIGRATION_APPLIED', 'MIGRATION', '0003_policy_scope_compatibility',
        json_object('route_policy_version', 1, 'navigation_version', 1, 'action_version', 1));
