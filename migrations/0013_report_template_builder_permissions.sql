-- RUN-20 separates publishing and raw JSON authoring from the standard designer permission.
INSERT INTO permissions (permission_code, description, resource_type, action_code)
VALUES
  ('REPORT_TEMPLATE.PUBLISH', 'Publish, retire, or roll back report template assignments', 'REPORT_TEMPLATE', 'PUBLISH'),
  ('REPORT_TEMPLATE.ADVANCED', 'Edit report template component definitions as validated JSON', 'REPORT_TEMPLATE', 'ADVANCED');

INSERT INTO role_permissions (role_id, permission_code, effect, created_by)
SELECT r.id, p.permission_code, 'ALLOW', NULL
FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'SYS_ADMIN'
  AND p.permission_code IN ('REPORT_TEMPLATE.PUBLISH', 'REPORT_TEMPLATE.ADVANCED');
