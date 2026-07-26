-- RUN-14: regional leads may read input dossiers, with record access still
-- constrained by the shared REGION/MCH2/assignment scope policy.
DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE role_code = 'REGIONAL_LEAD_APPROVER')
  AND permission_code = 'INPUT_DOSSIER.READ'
  AND effect = 'DENY';

INSERT OR IGNORE INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, 'INPUT_DOSSIER.READ', 'ALLOW'
FROM roles r
WHERE r.role_code = 'REGIONAL_LEAD_APPROVER';

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES (
  'MIGRATION_APPLIED',
  'MIGRATION',
  '0017_regional_lead_input_dossier_read',
  json_object(
    'role_code', 'REGIONAL_LEAD_APPROVER',
    'permission_code', 'INPUT_DOSSIER.READ',
    'effect', 'ALLOW',
    'policy_version', 2
  )
);
