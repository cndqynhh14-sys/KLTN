-- RUN-19: version scoring policy independently from report-template layout.
CREATE TABLE scoring_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_code TEXT NOT NULL UNIQUE,
  policy_name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE scoring_policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scoring_policy_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  formula_checksum TEXT NOT NULL CHECK (length(formula_checksum) = 64),
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  version_note TEXT,
  effective_from TEXT,
  effective_to TEXT,
  decision_id TEXT,
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
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
  FOREIGN KEY (scoring_policy_id) REFERENCES scoring_policies(id) ON DELETE RESTRICT,
  UNIQUE (scoring_policy_id, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX idx_scoring_policy_versions_policy_status
  ON scoring_policy_versions(scoring_policy_id, status, version_no DESC);

CREATE TABLE scoring_policy_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scoring_policy_id INTEGER NOT NULL,
  scoring_policy_version_id INTEGER NOT NULL,
  template_id INTEGER,
  facility_type TEXT NOT NULL DEFAULT 'ALL',
  supplier_scale TEXT NOT NULL DEFAULT 'ALL' CHECK (supplier_scale IN ('LARGE', 'SMALL', 'ALL')),
  evaluation_type TEXT NOT NULL DEFAULT 'ALL',
  effective_from TEXT,
  effective_to TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  FOREIGN KEY (scoring_policy_id) REFERENCES scoring_policies(id) ON DELETE RESTRICT,
  FOREIGN KEY (scoring_policy_version_id) REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX idx_scoring_policy_assignments_one_default
  ON scoring_policy_assignments(
    scoring_policy_id, COALESCE(template_id, -1), facility_type, supplier_scale, evaluation_type
  ) WHERE active = 1 AND is_default = 1;
CREATE INDEX idx_scoring_policy_assignments_resolve
  ON scoring_policy_assignments(template_id, facility_type, supplier_scale, evaluation_type, active, is_default);

CREATE TABLE scoring_policy_version_events (
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
  FOREIGN KEY (scoring_policy_version_id) REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT
);
CREATE INDEX idx_scoring_policy_events_version_time
  ON scoring_policy_version_events(scoring_policy_version_id, created_at, id);

CREATE TABLE scoring_policy_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  category_label_snapshot TEXT,
  category_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('CLEAN', 'UNMAPPED', 'LEGACY_RESULT_NO_CHECKSUM', 'FAILED')),
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scoring_reconciliation_status
  ON scoring_policy_reconciliations(migration_id, status, source_type);

CREATE TRIGGER scoring_assignment_requires_published_insert
BEFORE INSERT ON scoring_policy_assignments
WHEN NEW.active = 1 AND (
  (SELECT status FROM scoring_policy_versions WHERE id = NEW.scoring_policy_version_id) != 'PUBLISHED'
  OR (SELECT scoring_policy_id FROM scoring_policy_versions WHERE id = NEW.scoring_policy_version_id) != NEW.scoring_policy_id
)
BEGIN SELECT RAISE(ABORT, 'scoring_assignment_requires_published'); END;

CREATE TRIGGER scoring_assignment_requires_published_update
BEFORE UPDATE ON scoring_policy_assignments
WHEN NEW.active = 1 AND (
  (SELECT status FROM scoring_policy_versions WHERE id = NEW.scoring_policy_version_id) != 'PUBLISHED'
  OR (SELECT scoring_policy_id FROM scoring_policy_versions WHERE id = NEW.scoring_policy_version_id) != NEW.scoring_policy_id
)
BEGIN SELECT RAISE(ABORT, 'scoring_assignment_requires_published'); END;

CREATE TRIGGER scoring_policy_publish_four_eyes
BEFORE UPDATE OF status ON scoring_policy_versions
WHEN OLD.status != 'PUBLISHED' AND NEW.status = 'PUBLISHED' AND (
  length(trim(COALESCE(NEW.decision_id, ''))) < 6
  OR NEW.submitted_by IS NULL
  OR NEW.published_by IS NULL
  OR lower(NEW.submitted_by) = lower(NEW.published_by)
)
BEGIN SELECT RAISE(ABORT, 'scoring_policy_publish_four_eyes_required'); END;

CREATE TRIGGER scoring_policy_published_immutable_update
BEFORE UPDATE ON scoring_policy_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED') AND (
  NEW.scoring_policy_id != OLD.scoring_policy_id
  OR NEW.version_no != OLD.version_no
  OR NEW.schema_version != OLD.schema_version
  OR NEW.definition_json != OLD.definition_json
  OR NEW.formula_checksum != OLD.formula_checksum
  OR NEW.checksum != OLD.checksum
  OR COALESCE(NEW.effective_from, '') != COALESCE(OLD.effective_from, '')
  OR COALESCE(NEW.effective_to, '') != COALESCE(OLD.effective_to, '')
  OR NEW.status NOT IN ('PUBLISHED', 'RETIRED')
)
BEGIN SELECT RAISE(ABORT, 'published_scoring_policy_immutable'); END;

CREATE TRIGGER scoring_policy_published_immutable_delete
BEFORE DELETE ON scoring_policy_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN SELECT RAISE(ABORT, 'published_scoring_policy_immutable'); END;

CREATE TRIGGER scoring_policy_event_append_only_update
BEFORE UPDATE ON scoring_policy_version_events
BEGIN SELECT RAISE(ABORT, 'scoring_policy_event_append_only'); END;

CREATE TRIGGER scoring_policy_event_append_only_delete
BEFORE DELETE ON scoring_policy_version_events
BEGIN SELECT RAISE(ABORT, 'scoring_policy_event_append_only'); END;

INSERT INTO scoring_policies (policy_code, policy_name, description, created_by)
VALUES ('LEGACY_RULES', 'Quy tắc chấm điểm tương thích v1',
  'SCORE-001 pending: exact migration of evaluationRules.js behavior.', 'SYSTEM_MIGRATION');

INSERT INTO scoring_policy_versions (
  scoring_policy_id, version_no, status, schema_version, definition_json,
  formula_checksum, checksum, version_note, effective_from, decision_id,
  created_by, submitted_at, submitted_by, published_at, published_by
)
SELECT id, 1, 'PUBLISHED', 1,
  '{"schema_version":1,"policy_code":"LEGACY_RULES","policy_name":"Quy tắc chấm điểm tương thích v1","grades":{"A":{"label":"A","passed":true,"next_evaluation_months":24},"B":{"label":"B","passed":true,"next_evaluation_months":12},"C":{"label":"C","passed":true,"next_evaluation_months":6},"D":{"label":"D","passed":false,"next_evaluation_months":null},"NA":{"label":"Không áp dụng","passed":null,"next_evaluation_months":null}},"score_values":{"A":100,"B":75,"C":25,"D":0,"NA":null},"bands":[{"key":"FAIL","grade":"D","min":null,"min_inclusive":false,"max":60,"max_inclusive":false,"result_label":"Không đạt"},{"key":"BASIC_PASS","grade":"C","min":60,"min_inclusive":true,"max":75,"max_inclusive":true,"result_label":"Đạt mức cơ bản, đánh giá lại sau 6 tháng"},{"key":"GOOD_PASS","grade":"B","min":75,"min_inclusive":false,"max":90,"max_inclusive":true,"result_label":"Đạt mức khá, đánh giá lại sau 1 năm"},{"key":"HIGH_PASS","grade":"A","min":90,"min_inclusive":false,"max":null,"max_inclusive":false,"result_label":"Đạt mức cao"}],"penalties":[{"code":"CRITICAL_C","question_flag":"critical","score":"C","multiplier":0.9,"priority":20,"reason":"Điều khoản chính yếu C: điểm trung bình × 90%."},{"code":"CRITICAL_B","question_flag":"critical","score":"B","multiplier":0.95,"priority":10,"reason":"Điều khoản chính yếu B: điểm trung bình × 95%."}],"elimination":{"clause_type":"exclusion","score":"D","forced_score":0,"reason":"Không đạt do vi phạm điều khoản loại."},"default_reason":"Tính theo điểm trung bình các điều khoản.","final_conclusion":{"pass_min":60,"pass_label":"Đạt","fail_label":"Không đạt"},"workflow_thresholds":{"lead_submission_score_below":60,"lead_submission_critical_scores":["D"]},"rounding":{"calculation_mode":"NONE","calculation_decimals":null,"display_decimals":1},"categories":[{"code":"LEGAL_RECORDS","label":"Hồ sơ pháp lý","order":10},{"code":"FOOD_SAFETY_CONTROL","label":"Kiểm soát ATVSTP","order":20},{"code":"QUALITY_CONTROL","label":"Kiểm soát chất lượng","order":30},{"code":"PRODUCT_QUALITY_CONTROL","label":"Kiểm soát chất lượng sản phẩm","order":40},{"code":"TRACEABILITY","label":"Truy xuất nguồn gốc","order":50}],"compliance_overview":{"title":"Tổng hợp tuân thủ","category_column_label":"Hạng mục","grade_columns":["A","B","C","D","NA"],"show_totals":true,"totals_label":"Tổng","show_percentage":true,"percentage_label":"%","show_legend":true,"legend_label":"Chú giải","show_elimination":true,"elimination_label":"Điều khoản loại","show_result":true,"result_label":"Kết quả","chart":{"enabled":true,"type":"radar","max_axes":8,"fallback":"bar_table"}}}',
  '5ac496c648d99850d6f9c37dfa238aa98d216732a44ab7446643cdae63bc0039',
  '3e01700574b7407f71fc305027df040027fe0df227e69311dd29a92639f9ba80',
  'RUN-19 golden migration from evaluationRules.js', '1970-01-01', 'RUN-19-MIGRATION',
  'SYSTEM_MIGRATION', datetime('now'), 'SYSTEM_MIGRATION', datetime('now'), 'SYSTEM_MIGRATION'
FROM scoring_policies WHERE policy_code = 'LEGACY_RULES';

INSERT INTO scoring_policy_assignments (
  scoring_policy_id, scoring_policy_version_id, template_id, facility_type,
  supplier_scale, evaluation_type, effective_from, is_default, created_by
)
SELECT p.id, v.id, NULL, 'ALL', 'ALL', 'ALL', '1970-01-01', 1, 'SYSTEM_MIGRATION'
FROM scoring_policies p JOIN scoring_policy_versions v ON v.scoring_policy_id = p.id
WHERE p.policy_code = 'LEGACY_RULES' AND v.version_no = 1;

ALTER TABLE evaluation_questions ADD COLUMN category_code TEXT;
ALTER TABLE evaluation_questions ADD COLUMN category_label_snapshot TEXT;
ALTER TABLE question_items ADD COLUMN category_label_snapshot TEXT;

-- Additive metadata backfill only: copy the already immutable category label/code
-- into the new explicit snapshot fields, then restore the RUN-14 guard.
DROP TRIGGER question_items_published_update_immutable;

UPDATE evaluation_questions SET
  category_code = CASE category
    WHEN 'Hồ sơ pháp lý' THEN 'LEGAL_RECORDS'
    WHEN 'Kiểm soát ATVSTP' THEN 'FOOD_SAFETY_CONTROL'
    WHEN 'Kiểm soát chất lượng' THEN 'QUALITY_CONTROL'
    WHEN 'Kiểm soát chất lượng sản phẩm' THEN 'PRODUCT_QUALITY_CONTROL'
    WHEN 'Truy xuất nguồn gốc' THEN 'TRACEABILITY'
    ELSE NULL END,
  category_label_snapshot = category;
UPDATE question_items SET
  category_code = CASE category
    WHEN 'Hồ sơ pháp lý' THEN 'LEGAL_RECORDS'
    WHEN 'Kiểm soát ATVSTP' THEN 'FOOD_SAFETY_CONTROL'
    WHEN 'Kiểm soát chất lượng' THEN 'QUALITY_CONTROL'
    WHEN 'Kiểm soát chất lượng sản phẩm' THEN 'PRODUCT_QUALITY_CONTROL'
    WHEN 'Truy xuất nguồn gốc' THEN 'TRACEABILITY'
    ELSE NULL END,
  category_label_snapshot = category;
CREATE TRIGGER question_items_published_update_immutable
BEFORE UPDATE ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN SELECT RAISE(ABORT, 'published_version_immutable'); END;
CREATE INDEX idx_evaluation_questions_category_code ON evaluation_questions(category_code);
CREATE INDEX idx_question_items_category_code ON question_items(question_template_version_id, category_code);

DROP VIEW pinned_evaluation_questions;
CREATE VIEW pinned_evaluation_questions AS
SELECT
  t.id AS ticket_id, qi.legacy_question_id AS id, qi.id AS version_item_id,
  v.template_id, qt.template_code, qi.facility_type, qi.supplier_scale,
  qi.question_code, qi.question_text, qi.category, qi.category_code,
  COALESCE(qi.category_label_snapshot, qi.category) AS category_label_snapshot,
  qi.is_elimination_clause, qi.is_critical_clause, qi.requires_attachment,
  qi.allowed_scores, qi.weight, qi.order_index, qi.active, qi.created_at,
  NULL AS updated_at
FROM evaluation_tickets t
JOIN question_template_versions v ON v.id = t.question_template_version_id
JOIN question_templates qt ON qt.id = v.template_id
JOIN question_items qi ON qi.question_template_version_id = v.id
UNION ALL
SELECT
  t.id AS ticket_id, q.id, NULL AS version_item_id,
  q.template_id, qt.template_code, q.facility_type, q.supplier_scale,
  q.question_code, q.question_text, q.category, q.category_code,
  COALESCE(q.category_label_snapshot, q.category) AS category_label_snapshot,
  q.is_elimination_clause, q.is_critical_clause, q.requires_attachment,
  q.allowed_scores, q.weight, q.order_index, q.active, q.created_at, q.updated_at
FROM evaluation_tickets t
JOIN question_templates qt ON qt.id = t.template_id
JOIN evaluation_questions q ON q.template_id = t.template_id
WHERE t.question_template_version_id IS NULL;

INSERT INTO scoring_policy_reconciliations (
  migration_id, source_type, source_id, category_label_snapshot, category_code, status
)
SELECT 'RUN-19-V1', 'EVALUATION_QUESTION', CAST(id AS TEXT), category, category_code,
  CASE WHEN category_code IS NULL THEN 'UNMAPPED' ELSE 'CLEAN' END
FROM evaluation_questions;

ALTER TABLE evaluation_tickets
  ADD COLUMN scoring_policy_version_id INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_rounds
  ADD COLUMN scoring_policy_version_id INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_rounds ADD COLUMN scoring_result_snapshot_json TEXT;
ALTER TABLE evaluation_rounds ADD COLUMN scoring_result_checksum TEXT;
CREATE INDEX idx_evaluation_tickets_scoring_policy ON evaluation_tickets(scoring_policy_version_id);
CREATE INDEX idx_evaluation_rounds_scoring_policy ON evaluation_rounds(scoring_policy_version_id);

UPDATE evaluation_tickets SET scoring_policy_version_id = (
  SELECT v.id FROM scoring_policy_versions v
  JOIN scoring_policies p ON p.id = v.scoring_policy_id
  WHERE p.policy_code = 'LEGACY_RULES' AND v.version_no = 1
) WHERE scoring_policy_version_id IS NULL;
UPDATE evaluation_rounds SET scoring_policy_version_id = (
  SELECT scoring_policy_version_id FROM evaluation_tickets t WHERE t.id = evaluation_rounds.ticket_id
) WHERE scoring_policy_version_id IS NULL;

INSERT INTO scoring_policy_reconciliations (
  migration_id, source_type, source_id, status, details_json
)
SELECT 'RUN-19-V1', 'EVALUATION_ROUND', CAST(id AS TEXT), 'LEGACY_RESULT_NO_CHECKSUM',
  json_object('round_no', round_no, 'total_score', total_score, 'classification', classification)
FROM evaluation_rounds WHERE locked_at IS NOT NULL OR total_score IS NOT NULL;

-- Application services resolve and audit the assignment explicitly. This
-- database safety net also pins tickets created through import/test seams.
CREATE TRIGGER evaluation_ticket_scoring_policy_pin_insert
AFTER INSERT ON evaluation_tickets
WHEN NEW.scoring_policy_version_id IS NULL
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

CREATE TRIGGER evaluation_round_scoring_policy_pin_insert
AFTER INSERT ON evaluation_rounds
WHEN NEW.scoring_policy_version_id IS NULL
BEGIN
  UPDATE evaluation_rounds SET scoring_policy_version_id = (
    SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id = NEW.ticket_id
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER evaluation_ticket_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_tickets
WHEN OLD.scoring_policy_version_id IS NOT NULL AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'ticket_scoring_policy_pin_immutable'); END;

CREATE TRIGGER evaluation_round_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_rounds
WHEN OLD.scoring_policy_version_id IS NOT NULL AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'round_scoring_policy_pin_immutable'); END;

ALTER TABLE report_export_jobs ADD COLUMN scoring_policy_checksum TEXT;
ALTER TABLE report_source_snapshots ADD COLUMN scoring_policy_version_id INTEGER;
ALTER TABLE report_source_snapshots ADD COLUMN scoring_policy_checksum TEXT;
ALTER TABLE report_exports ADD COLUMN scoring_policy_version_id INTEGER;
ALTER TABLE report_exports ADD COLUMN scoring_policy_checksum TEXT;

INSERT INTO permissions (permission_code, description, resource_type, action_code)
VALUES
  ('SCORING_POLICY.MANAGE', 'Create, validate, simulate, and submit scoring policy drafts', 'SCORING_POLICY', 'MANAGE'),
  ('SCORING_POLICY.PUBLISH', 'Publish or roll back scoring policy assignments with four-eyes approval', 'SCORING_POLICY', 'PUBLISH');
INSERT INTO role_permissions (role_id, permission_code, effect, created_by)
SELECT r.id, p.permission_code, 'ALLOW', NULL
FROM roles r CROSS JOIN permissions p
WHERE r.role_code = 'SYS_ADMIN' AND p.permission_code IN ('SCORING_POLICY.MANAGE', 'SCORING_POLICY.PUBLISH');
