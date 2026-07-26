-- RUN-05: scoped RBAC foundation. Existing route guards remain in compatibility mode.
ALTER TABLE users ADD COLUMN authz_version INTEGER NOT NULL DEFAULT 1 CHECK (authz_version >= 1);

CREATE TABLE roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role_code     TEXT NOT NULL UNIQUE,
  display_label TEXT NOT NULL,
  role_kind     TEXT NOT NULL DEFAULT 'SYSTEM' CHECK (role_kind IN ('SYSTEM', 'FUNCTIONAL')),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE permissions (
  permission_code TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  action_code     TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_permissions (
  role_id         INTEGER NOT NULL,
  permission_code TEXT NOT NULL,
  effect          TEXT NOT NULL DEFAULT 'ALLOW' CHECK (effect IN ('ALLOW', 'DENY')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT,
  PRIMARY KEY (role_id, permission_code, effect),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_code) REFERENCES permissions(permission_code) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

CREATE TABLE user_roles (
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
  FOREIGN KEY (user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

CREATE TABLE org_units (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_code      TEXT NOT NULL UNIQUE,
  org_type      TEXT NOT NULL CHECK (org_type IN ('REGION', 'MCH2', 'CUSTOM')),
  display_label TEXT NOT NULL,
  parent_id     INTEGER,
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  metadata_json TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT,
  FOREIGN KEY (parent_id) REFERENCES org_units(id) ON DELETE RESTRICT
);

CREATE TABLE custom_scope_schemas (
  schema_code TEXT NOT NULL,
  version     INTEGER NOT NULL CHECK (version >= 1),
  schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (schema_code, version)
);

CREATE TABLE user_scope_assignments (
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
  CHECK ((scope_type = 'GLOBAL' AND scope_value IS NULL) OR (scope_type != 'GLOBAL' AND scope_value IS NOT NULL)),
  CHECK (scope_type != 'MCH2' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'),
  CHECK (scope_type != 'CUSTOM' OR (custom_schema_code IS NOT NULL AND custom_schema_version IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

CREATE TABLE approval_stage_assignments (
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
  CHECK (scope_type != 'MCH2' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'),
  CHECK (scope_type != 'CUSTOM' OR (custom_schema_code IS NOT NULL AND custom_schema_version IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

CREATE TABLE authz_change_log (
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
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(email) ON DELETE SET NULL
);

CREATE TABLE auth_sessions (
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
  FOREIGN KEY (user_id) REFERENCES users(email) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_user_scopes_active_unique
  ON user_scope_assignments(user_id, COALESCE(role_id, -1), scope_type, COALESCE(scope_value, ''), effect)
  WHERE active = 1;
CREATE INDEX idx_user_roles_user_active ON user_roles(user_id, active, valid_until);
CREATE INDEX idx_user_roles_role_active ON user_roles(role_id, active, valid_until);
CREATE INDEX idx_role_permissions_permission ON role_permissions(permission_code, effect);
CREATE INDEX idx_user_scopes_user_active ON user_scope_assignments(user_id, active, valid_until);
CREATE INDEX idx_org_units_type_code ON org_units(org_type, org_code, active);
CREATE INDEX idx_stage_assignments_lookup ON approval_stage_assignments(workflow_type, stage_code, active, priority);
CREATE INDEX idx_authz_change_target_time ON authz_change_log(target_user_id, created_at DESC);
CREATE INDEX idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at, expires_at);

CREATE TRIGGER permission_code_immutable
BEFORE UPDATE OF permission_code ON permissions
WHEN NEW.permission_code != OLD.permission_code
BEGIN SELECT RAISE(ABORT, 'permission_code_immutable'); END;

CREATE TRIGGER role_code_immutable
BEFORE UPDATE OF role_code ON roles
WHEN NEW.role_code != OLD.role_code
BEGIN SELECT RAISE(ABORT, 'role_code_immutable'); END;

CREATE TRIGGER org_code_immutable
BEFORE UPDATE OF org_code ON org_units
WHEN NEW.org_code != OLD.org_code
BEGIN SELECT RAISE(ABORT, 'org_code_immutable'); END;

INSERT INTO roles (role_code, display_label, role_kind) VALUES
  ('SYS_ADMIN', 'Quản trị hệ thống', 'SYSTEM'),
  ('QLCL_SPECIALIST', 'Chuyên viên QLCL', 'SYSTEM'),
  ('REGIONAL_LEAD_APPROVER', 'Phê duyệt Lead miền', 'SYSTEM'),
  ('DEPARTMENT_HEAD_APPROVER', 'Phê duyệt Trưởng bộ phận', 'SYSTEM'),
  ('BLOCK_DIRECTOR_APPROVER', 'Phê duyệt Giám đốc khối', 'SYSTEM'),
  ('SUPPLIER_USER', 'Người dùng NCC', 'SYSTEM'),
  ('DATA_UPLOADER', 'Tải dữ liệu', 'FUNCTIONAL'),
  ('AUDITOR', 'Kiểm toán chỉ đọc', 'FUNCTIONAL'),
  ('READ_ONLY_VIEWER', 'Người xem', 'FUNCTIONAL');

INSERT INTO permissions (permission_code, description, resource_type, action_code) VALUES
  ('SYSTEM.ADMIN', 'Full system administration compatibility permission', 'SYSTEM', 'ADMIN'),
  ('USER.MANAGE', 'Manage users and authorization assignments', 'USER', 'MANAGE'),
  ('DASHBOARD.READ', 'Read quality dashboards', 'DASHBOARD', 'READ'),
  ('UPLOAD.MANAGE', 'Upload and manage dashboard imports', 'UPLOAD', 'MANAGE'),
  ('AUDIT.READ', 'Read audit records', 'AUDIT', 'READ'),
  ('SUPPLIER.READ', 'Read supplier master', 'SUPPLIER', 'READ'),
  ('SUPPLIER.WRITE', 'Create and update supplier master', 'SUPPLIER', 'WRITE'),
  ('SUPPLIER.SELF_READ', 'Read supplier-owned portal data', 'SUPPLIER', 'SELF_READ'),
  ('EVALUATION.READ', 'Read evaluation tickets', 'EVALUATION', 'READ'),
  ('EVALUATION.CREATE', 'Create evaluation tickets', 'EVALUATION', 'CREATE'),
  ('EVALUATION.SCORE', 'Score evaluation rounds', 'EVALUATION', 'SCORE'),
  ('EVALUATION.DELETE_DRAFT', 'Delete draft evaluation tickets', 'EVALUATION', 'DELETE_DRAFT'),
  ('EVALUATION.APPROVE_LEAD', 'Act at regional lead approval stage', 'EVALUATION', 'APPROVE_LEAD'),
  ('EVALUATION.APPROVE_TBP', 'Act at department head approval stage', 'EVALUATION', 'APPROVE_TBP'),
  ('EVALUATION.APPROVE_GDK', 'Act at block director approval stage', 'EVALUATION', 'APPROVE_GDK'),
  ('INPUT_DOSSIER.READ', 'Read input dossiers', 'INPUT_DOSSIER', 'READ'),
  ('INPUT_DOSSIER.WRITE', 'Create and review input dossiers', 'INPUT_DOSSIER', 'WRITE'),
  ('INPUT_DOSSIER.APPROVE_TBP', 'Act at input dossier department-head stage', 'INPUT_DOSSIER', 'APPROVE_TBP'),
  ('INPUT_DOSSIER.APPROVE_GDK', 'Act at input dossier block-director stage', 'INPUT_DOSSIER', 'APPROVE_GDK'),
  ('REPORT.READ', 'Read report history and previews', 'REPORT', 'READ'),
  ('REPORT.EXPORT', 'Generate report exports', 'REPORT', 'EXPORT'),
  ('REPORT_TEMPLATE.MANAGE', 'Manage report templates', 'REPORT_TEMPLATE', 'MANAGE'),
  ('QUESTION_TEMPLATE.MANAGE', 'Manage evaluation question templates', 'QUESTION_TEMPLATE', 'MANAGE');

-- SYS_ADMIN receives every catalog permission. DENY overrides ALLOW in AuthorizationService.
INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r CROSS JOIN permissions p WHERE r.role_code = 'SYS_ADMIN';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW'
FROM roles r JOIN permissions p ON p.permission_code IN (
  'DASHBOARD.READ','SUPPLIER.READ','SUPPLIER.WRITE','EVALUATION.READ','EVALUATION.CREATE',
  'EVALUATION.SCORE','EVALUATION.DELETE_DRAFT','INPUT_DOSSIER.READ','INPUT_DOSSIER.WRITE',
  'REPORT.READ','REPORT.EXPORT'
) WHERE r.role_code = 'QLCL_SPECIALIST';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN (
  'DASHBOARD.READ','SUPPLIER.READ','EVALUATION.READ','INPUT_DOSSIER.READ','REPORT.READ','REPORT.EXPORT','EVALUATION.APPROVE_LEAD'
) WHERE r.role_code = 'REGIONAL_LEAD_APPROVER';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN (
  'DASHBOARD.READ','SUPPLIER.READ','EVALUATION.READ','INPUT_DOSSIER.READ','REPORT.READ','REPORT.EXPORT',
  'EVALUATION.APPROVE_TBP','INPUT_DOSSIER.APPROVE_TBP'
) WHERE r.role_code = 'DEPARTMENT_HEAD_APPROVER';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN (
  'DASHBOARD.READ','SUPPLIER.READ','EVALUATION.READ','INPUT_DOSSIER.READ','REPORT.READ','REPORT.EXPORT',
  'EVALUATION.APPROVE_GDK','INPUT_DOSSIER.APPROVE_GDK'
) WHERE r.role_code = 'BLOCK_DIRECTOR_APPROVER';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code = 'SUPPLIER.SELF_READ'
WHERE r.role_code = 'SUPPLIER_USER';

INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN ('DASHBOARD.READ','UPLOAD.MANAGE')
WHERE r.role_code = 'DATA_UPLOADER';
INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN ('DASHBOARD.READ','SUPPLIER.READ','EVALUATION.READ','INPUT_DOSSIER.READ','REPORT.READ','AUDIT.READ')
WHERE r.role_code = 'AUDITOR';
INSERT INTO role_permissions (role_id, permission_code, effect)
SELECT r.id, p.permission_code, 'ALLOW' FROM roles r JOIN permissions p ON p.permission_code IN ('DASHBOARD.READ','SUPPLIER.READ','EVALUATION.READ','INPUT_DOSSIER.READ','REPORT.READ')
WHERE r.role_code = 'READ_ONLY_VIEWER';

-- One compatibility role per legacy user. This is the only migration boundary that reads users.role.
INSERT INTO user_roles (user_id, role_id, source)
SELECT u.email, r.id, 'LEGACY_COMPAT'
FROM users u JOIN roles r ON r.role_code = CASE
  WHEN u.is_admin = 1 OR u.role = 'Admin' THEN 'SYS_ADMIN'
  WHEN u.role = 'Lead miền' THEN 'REGIONAL_LEAD_APPROVER'
  WHEN u.role = 'TBP' THEN 'DEPARTMENT_HEAD_APPROVER'
  WHEN u.role = 'GĐK' THEN 'BLOCK_DIRECTOR_APPROVER'
  WHEN u.role = 'NCC' THEN 'SUPPLIER_USER'
  ELSE 'QLCL_SPECIALIST' END;

INSERT INTO user_scope_assignments (user_id, role_id, scope_type, scope_value, effect)
SELECT ur.user_id, ur.role_id,
       CASE WHEN r.role_code = 'SUPPLIER_USER' THEN 'SUPPLIER' ELSE 'GLOBAL' END,
       CASE WHEN r.role_code = 'SUPPLIER_USER' THEN ur.user_id ELSE NULL END,
       'ALLOW'
FROM user_roles ur JOIN roles r ON r.id = ur.role_id;

INSERT INTO approval_stage_assignments (workflow_type, stage_code, role_id, scope_type, priority)
SELECT 'EVALUATION', stage_code, r.id, 'GLOBAL', 100 FROM roles r JOIN (
  SELECT 'LEAD' stage_code, 'REGIONAL_LEAD_APPROVER' role_code
  UNION ALL SELECT 'TBP', 'DEPARTMENT_HEAD_APPROVER'
  UNION ALL SELECT 'GDK', 'BLOCK_DIRECTOR_APPROVER'
) x ON x.role_code = r.role_code;

INSERT INTO approval_stage_assignments (workflow_type, stage_code, role_id, scope_type, priority)
SELECT 'INPUT_DOSSIER', stage_code, r.id, 'GLOBAL', 100 FROM roles r JOIN (
  SELECT 'TBP' stage_code, 'DEPARTMENT_HEAD_APPROVER' role_code
  UNION ALL SELECT 'GDK', 'BLOCK_DIRECTOR_APPROVER'
) x ON x.role_code = r.role_code;

CREATE TRIGGER user_roles_version_insert AFTER INSERT ON user_roles BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email = NEW.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_roles_version_update AFTER UPDATE ON user_roles BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;
CREATE TRIGGER user_roles_version_delete AFTER DELETE ON user_roles BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email = OLD.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER user_scopes_version_insert AFTER INSERT ON user_scope_assignments BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email = NEW.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = NEW.user_id AND revoked_at IS NULL;
END;
CREATE TRIGGER user_scopes_version_update AFTER UPDATE ON user_scope_assignments BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (OLD.user_id, NEW.user_id);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (OLD.user_id, NEW.user_id) AND revoked_at IS NULL;
END;
CREATE TRIGGER user_scopes_version_delete AFTER DELETE ON user_scope_assignments BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email = OLD.user_id;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER role_permissions_version_insert AFTER INSERT ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.role_id AND active = 1) AND revoked_at IS NULL;
END;
CREATE TRIGGER role_permissions_version_update AFTER UPDATE ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (SELECT user_id FROM user_roles WHERE role_id IN (OLD.role_id, NEW.role_id) AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id IN (OLD.role_id, NEW.role_id) AND active = 1) AND revoked_at IS NULL;
END;
CREATE TRIGGER role_permissions_version_delete AFTER DELETE ON role_permissions BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id AND active = 1);
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED' WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = OLD.role_id AND active = 1) AND revoked_at IS NULL;
END;

CREATE TRIGGER roles_active_version_update AFTER UPDATE OF active ON roles
WHEN NEW.active != OLD.active
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email IN (
    SELECT user_id FROM user_roles WHERE role_id = NEW.id AND active = 1
  );
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'AUTHZ_CHANGED'
  WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_id = NEW.id AND active = 1) AND revoked_at IS NULL;
END;

CREATE TRIGGER prevent_super_admin_role_disable
BEFORE UPDATE OF active ON roles
WHEN OLD.role_code = 'SYS_ADMIN' AND OLD.active = 1 AND NEW.active = 0
 AND EXISTS (
   SELECT 1 FROM user_roles ur JOIN users u ON u.email = ur.user_id
   WHERE ur.role_id = OLD.id AND ur.active = 1 AND u.is_active = 1
     AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
     AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
 )
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;

CREATE TRIGGER prevent_last_super_admin_role_delete
BEFORE DELETE ON user_roles
WHEN OLD.active = 1
 AND (SELECT role_code FROM roles WHERE id = OLD.role_id) = 'SYS_ADMIN'
 AND (SELECT is_active FROM users WHERE email = OLD.user_id) = 1
 AND (OLD.valid_from IS NULL OR OLD.valid_from <= datetime('now'))
 AND (OLD.valid_until IS NULL OR OLD.valid_until > datetime('now'))
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.email = ur.user_id
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
 AND (SELECT is_active FROM users WHERE email = OLD.user_id) = 1
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.email = ur.user_id
      WHERE r.role_code = 'SYS_ADMIN' AND r.active = 1 AND ur.active = 1 AND u.is_active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))) <= 1
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;

CREATE TRIGGER prevent_last_super_admin_user_deactivate
BEFORE UPDATE OF is_active ON users
WHEN OLD.is_active = 1 AND NEW.is_active = 0
 AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = OLD.email AND ur.active = 1 AND r.active = 1 AND r.role_code = 'SYS_ADMIN'
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now')))
 AND (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.email = ur.user_id
      WHERE r.role_code = 'SYS_ADMIN' AND r.active = 1 AND ur.active = 1 AND u.is_active = 1
        AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
        AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))) <= 1
BEGIN SELECT RAISE(ABORT, 'last_super_admin_required'); END;

CREATE TRIGGER users_active_authz_invalidation
AFTER UPDATE OF is_active ON users
WHEN NEW.is_active != OLD.is_active
BEGIN
  UPDATE users SET authz_version = authz_version + 1 WHERE email = NEW.email;
  UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now')), revoke_reason = 'ACCOUNT_STATUS_CHANGED'
  WHERE user_id = NEW.email AND revoked_at IS NULL;
END;

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES ('MIGRATION_APPLIED', 'MIGRATION', '0002_scoped_rbac_foundation', json_object('compatibility_mode', 1));
