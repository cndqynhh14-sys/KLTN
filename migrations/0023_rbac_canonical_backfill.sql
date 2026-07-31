INSERT OR IGNORE INTO user_roles (user_id, role_id, source, created_by)
SELECT u.email, r.id, 'MIGRATION', NULL
FROM users u
JOIN roles r ON r.role_code = CASE
  WHEN u.is_admin = 1 OR u.role = 'Admin' THEN 'SYS_ADMIN'
  WHEN u.role = 'Lead miền' THEN 'REGIONAL_LEAD_APPROVER'
  WHEN u.role = 'TBP' THEN 'DEPARTMENT_HEAD_APPROVER'
  WHEN u.role = 'GĐK' THEN 'BLOCK_DIRECTOR_APPROVER'
  WHEN u.role = 'NCC' THEN 'SUPPLIER_USER'
  ELSE 'QLCL_SPECIALIST'
END
WHERE NOT EXISTS (
  SELECT 1 FROM user_roles active_role
  WHERE active_role.user_id = u.email AND active_role.active = 1
);

INSERT OR IGNORE INTO user_scope_assignments (
  user_id, role_id, scope_type, scope_value, effect, source
)
SELECT ur.user_id, ur.role_id,
       CASE WHEN r.role_code = 'SUPPLIER_USER' THEN 'SUPPLIER' ELSE 'GLOBAL' END,
       CASE WHEN r.role_code = 'SUPPLIER_USER' THEN ur.user_id ELSE NULL END,
       'ALLOW', 'MIGRATION'
FROM user_roles ur
JOIN roles r ON r.id = ur.role_id
WHERE ur.source = 'MIGRATION'
  AND ur.active = 1
  AND NOT EXISTS (
    SELECT 1 FROM user_scope_assignments usa
    WHERE usa.user_id = ur.user_id
      AND usa.role_id = ur.role_id
      AND usa.scope_type = CASE WHEN r.role_code = 'SUPPLIER_USER' THEN 'SUPPLIER' ELSE 'GLOBAL' END
      AND COALESCE(usa.scope_value, '') = COALESCE(
        CASE WHEN r.role_code = 'SUPPLIER_USER' THEN ur.user_id ELSE NULL END, ''
      )
      AND usa.effect = 'ALLOW'
      AND usa.active = 1
  );

CREATE INDEX idx_user_roles_active_window
  ON user_roles(user_id, active, valid_from, valid_until, role_id);
