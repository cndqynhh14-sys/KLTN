-- RUN-13 / MCH-01: canonical merchandise hierarchy and MCH2 scope reconciliation.
CREATE TABLE master_data_catalogs (
  catalog_key  TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  checksum     TEXT NOT NULL CHECK (length(checksum) = 64),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  activated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE merchandise_hierarchy (
  mch3_id          TEXT PRIMARY KEY,
  mch3_name        TEXT NOT NULL,
  mch2_id          TEXT NOT NULL,
  mch2_name        TEXT NOT NULL,
  mch1_id          TEXT NOT NULL,
  mch1_name        TEXT NOT NULL,
  catalog_key      TEXT NOT NULL DEFAULT 'MCH',
  catalog_version  TEXT NOT NULL,
  catalog_checksum TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  FOREIGN KEY (catalog_key) REFERENCES master_data_catalogs(catalog_key) ON DELETE RESTRICT
);

CREATE INDEX idx_merchandise_hierarchy_mch2_id ON merchandise_hierarchy(mch2_id, mch3_id);
CREATE INDEX idx_merchandise_hierarchy_mch1_id ON merchandise_hierarchy(mch1_id, mch2_id, mch3_id);

INSERT INTO master_data_catalogs (catalog_key, version, checksum, record_count)
VALUES ('MCH', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c', 56);

INSERT INTO merchandise_hierarchy
  (mch1_id, mch1_name, mch2_id, mch2_name, mch3_id, mch3_name, catalog_version, catalog_checksum)
VALUES
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10101', 'Bánh mỳ', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10102', 'Thức ăn nấu sẵn', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10103', 'Rau củ', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10104', 'Thịt', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10105', 'Thủy hải sản', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '101', 'Thực phẩm Tươi sống, chế biến', '10106', 'Trái cây', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10201', 'Bánh kẹo', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10202', 'Bơ, sữa, trứng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10203', 'Đồ uống, thuốc lá', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10204', 'Đông lạnh', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10205', 'Thịt nguội, xúc xích, hàng chua', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10206', 'Thực phẩm khô', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('1', 'Thực phẩm', '102', 'Thực phẩm công nghệ', '10207', 'Giỏ quà', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '201', 'Dệt may', '20107', 'Bông Vải Sợi', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '201', 'Dệt may', '20108', 'Phụ kiện', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '201', 'Dệt may', '20109', 'Thời Trang', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '201', 'Dệt may', '20110', 'Đồng phục', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '202', 'Hoá mỹ phẩm', '20201', 'Giấy và bông', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '202', 'Hoá mỹ phẩm', '20202', 'Hóa phẩm', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '202', 'Hoá mỹ phẩm', '20203', 'Mỹ phẩm, chăm sóc cá nhân', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '203', 'Homeline', '20301', 'Đồ chơi/Giải trí thể thao', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '203', 'Homeline', '20302', 'Đồ dùng Dân dụng/Trang trí', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '203', 'Homeline', '20303', 'Gia dụng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '203', 'Homeline', '20304', 'Văn phòng phẩm', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('2', 'Phi thực phẩm', '203', 'Homeline', '20305', 'Điện gia dụng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '301', 'Điện máy VPr', '30101', 'Điện gia dụng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '301', 'Điện máy VPr', '30102', 'Điện lạnh', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '301', 'Điện máy VPr', '30103', 'Điện tử', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30201', 'Thu chi hộ, hoa hồng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30202', 'Kinh doanh', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30203', 'Dịch vụ quảng cáo', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30204', 'Máy tính bảng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30205', 'Phụ Kiện', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '302', 'Dịch vụ tiện ích', '30206', 'Thiết bị văn phòng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30301', 'Khuyến mại Điện gia', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30302', 'Khuyến mại Điện lạnh', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30303', 'Khuyến mại Điện thoại', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30304', 'Khuyến mại Điện tử', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30305', 'Khuyến mại IT', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('3', 'Công nghệ-điện máy', '303', 'Khuyến mãi điện máy', '30306', 'Khuyến mại MTB', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('4', 'Dịch vụ', '412', 'Dịch vụ vận chuyển', '41201', 'Phí vận chuyển', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('5', 'Phi thương mại', '501', 'Phi thương mại', '50101', 'Phi thương mại', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('5', 'Phi thương mại', '501', 'Phi thương mại', '50102', 'Chi phí vận hành', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('5', 'Phi thương mại', '501', 'Phi thương mại', '50103', 'Chi phí khối văn phòng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('5', 'Phi thương mại', '501', 'Phi thương mại', '50104', 'Bếp Trung Tâm-CP Chu', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('6', 'Khác', '601', 'Dự án', '60101', 'Dự án', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('6', 'Khác', '602', 'Coupon', '60201', 'Coupon', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('6', 'Khác', '603', 'Voucher', '60301', 'Voucher', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70201', 'WPH_Thực phẩm chức năng', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70202', 'WPH_Mỹ phẩm', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70203', 'WPH_Thiết bị, dụng cụ', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70204', 'WPH_Thuốc kê đơn', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70205', 'WPH_Thuốc không kê đơn', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '702', 'Winphar', '70206', 'WPH_Các loại khác', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('7', 'Shop in Shop', '703', 'Homeline SIS', '70304', 'Văn phòng phẩm SIS', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c'),
  ('9', 'Interim', '999', 'Interim', '99999', 'Interim', 'MCH-01', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c');

CREATE TRIGGER merchandise_hierarchy_read_only_update
BEFORE UPDATE ON merchandise_hierarchy BEGIN
  SELECT RAISE(ABORT, 'merchandise_hierarchy_read_only');
END;
CREATE TRIGGER merchandise_hierarchy_read_only_delete
BEFORE DELETE ON merchandise_hierarchy BEGIN
  SELECT RAISE(ABORT, 'merchandise_hierarchy_read_only');
END;

-- Label-derived RUN-05 MCH2 scopes are not silently mapped. They are disabled
-- and queued for review; new assignments use the canonical numeric MCH2_ID.
CREATE TABLE authz_scope_review_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_table  TEXT NOT NULL,
  source_id     INTEGER NOT NULL,
  scope_type    TEXT NOT NULL,
  scope_value   TEXT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'REJECTED')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT,
  resolution    TEXT,
  UNIQUE (source_table, source_id)
);

INSERT INTO authz_scope_review_queue (source_table, source_id, scope_type, scope_value, reason)
SELECT 'user_scope_assignments', id, scope_type, scope_value, 'non_canonical_mch2_scope'
FROM user_scope_assignments
WHERE scope_type = 'MCH2'
  AND (scope_value IS NULL OR scope_value = '' OR scope_value GLOB '*[^0-9]*');

INSERT INTO authz_scope_review_queue (source_table, source_id, scope_type, scope_value, reason)
SELECT 'approval_stage_assignments', id, scope_type, scope_value, 'non_canonical_mch2_scope'
FROM approval_stage_assignments
WHERE scope_type = 'MCH2'
  AND (scope_value IS NULL OR scope_value = '' OR scope_value GLOB '*[^0-9]*');

UPDATE user_scope_assignments
SET active = 0
WHERE scope_type = 'MCH2'
  AND (scope_value IS NULL OR scope_value = '' OR scope_value GLOB '*[^0-9]*');

UPDATE approval_stage_assignments
SET active = 0
WHERE scope_type = 'MCH2'
  AND (scope_value IS NULL OR scope_value = '' OR scope_value GLOB '*[^0-9]*');

-- Rebuild both scope tables so canonical numeric MCH2_ID values can be stored.
CREATE TABLE user_scope_assignments_v2 (
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
  FOREIGN KEY (user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

INSERT INTO user_scope_assignments_v2
SELECT id, user_id, role_id, scope_type, scope_value, effect, active, valid_from, valid_until,
       custom_schema_code, custom_schema_version, created_at, created_by, source
FROM user_scope_assignments
WHERE scope_type != 'MCH2' OR (length(scope_value) > 0 AND (scope_value NOT GLOB '*[^0-9]*' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'));

DROP TABLE user_scope_assignments;
ALTER TABLE user_scope_assignments_v2 RENAME TO user_scope_assignments;

CREATE UNIQUE INDEX idx_user_scopes_active_unique
  ON user_scope_assignments(user_id, COALESCE(role_id, -1), scope_type, COALESCE(scope_value, ''), effect)
  WHERE active = 1;
CREATE INDEX idx_user_scopes_user_active ON user_scope_assignments(user_id, active, valid_until);

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

CREATE TABLE approval_stage_assignments_v2 (
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
  FOREIGN KEY (assigned_user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (custom_schema_code, custom_schema_version) REFERENCES custom_scope_schemas(schema_code, version) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);

INSERT INTO approval_stage_assignments_v2
SELECT id, workflow_type, stage_code, role_id, assigned_user_id, scope_type, scope_value,
       custom_schema_code, custom_schema_version, priority, active, valid_from, valid_until, created_at, created_by
FROM approval_stage_assignments
WHERE scope_type != 'MCH2' OR (length(scope_value) > 0 AND (scope_value NOT GLOB '*[^0-9]*' OR scope_value GLOB 'MCH2_[A-Z0-9_-]*'));

DROP TABLE approval_stage_assignments;
ALTER TABLE approval_stage_assignments_v2 RENAME TO approval_stage_assignments;
CREATE INDEX idx_stage_assignments_lookup ON approval_stage_assignments(workflow_type, stage_code, active, priority);

INSERT INTO authz_change_log (change_type, object_type, object_key, after_json)
VALUES ('MIGRATION_APPLIED', 'MIGRATION', '0007_merchandise_hierarchy',
        json_object('catalog_version', 'MCH-01', 'catalog_checksum', '497d3cbac19c9d0c217b05a7f4a69a3b82173a8a731668b891129dddf6e1473c', 'record_count', 56));
