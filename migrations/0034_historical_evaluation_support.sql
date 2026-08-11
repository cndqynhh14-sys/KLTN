-- migrate: foreign_keys=off
-- RUN-34: historical evaluations keep aggregate source facts without inventing
-- question/scoring data. Native tickets retain their existing constraints.

DROP TRIGGER IF EXISTS evaluation_ticket_scoring_policy_pin_immutable;
DROP TRIGGER IF EXISTS evaluation_ticket_scoring_policy_pin_insert;
DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_immutable;
DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_insert;
DROP VIEW IF EXISTS pinned_evaluation_questions;

CREATE TABLE evaluation_tickets_run34 (
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
  FOREIGN KEY (assigned_specialist_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(email) ON DELETE SET NULL,
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

INSERT INTO evaluation_tickets_run34 (
  id, ticket_code, supplier_id, supplier_code, supplier_name, tax_code,
  supplier_address, production_address, snapshot_evaluation_address,
  linked_facility_code, snapshot_linked_facility_name, snapshot_linked_facility_address,
  linked_facility_type, region, province, business_type, cmc_owner, cmc_head,
  business_license_file, attp_certificate_type, attp_certificate_file,
  contact_name, contact_email, contact_phone, mch2, mch3, product_group,
  snapshot_product_name, evaluation_type, template_id, facility_type, supplier_scale,
  evaluation_method, evaluation_department, planned_date, actual_evaluation_date,
  current_status, current_round_no, assigned_specialist_id, score_percent, grade_code,
  result_label, result_reason, corrected_score_percent, corrected_grade_code,
  corrected_result_label, correction_date, next_evaluation_date, final_conclusion,
  specialist_proposal, supplier_introduction, scoring_locked, completed_round,
  is_deleted, deleted_at, deleted_by, deleted_reason, created_at, created_by,
  updated_at, updated_by, cancelled_reason, cancelled_by, cancelled_at,
  question_template_version_id, scoring_policy_version_id, snapshot_locked_at,
  source_kind
)
SELECT
  id, ticket_code, supplier_id, supplier_code, supplier_name, tax_code,
  supplier_address, production_address, snapshot_evaluation_address,
  linked_facility_code, snapshot_linked_facility_name, snapshot_linked_facility_address,
  linked_facility_type, region, province, business_type, cmc_owner, cmc_head,
  business_license_file, attp_certificate_type, attp_certificate_file,
  contact_name, contact_email, contact_phone, mch2, mch3, product_group,
  snapshot_product_name, evaluation_type, template_id, facility_type, supplier_scale,
  evaluation_method, evaluation_department, planned_date, actual_evaluation_date,
  current_status, current_round_no, assigned_specialist_id, score_percent, grade_code,
  result_label, result_reason, corrected_score_percent, corrected_grade_code,
  corrected_result_label, correction_date, next_evaluation_date, final_conclusion,
  specialist_proposal, supplier_introduction, scoring_locked, completed_round,
  is_deleted, deleted_at, deleted_by, deleted_reason, created_at, created_by,
  updated_at, updated_by, cancelled_reason, cancelled_by, cancelled_at,
  question_template_version_id, scoring_policy_version_id, snapshot_locked_at,
  'NATIVE'
FROM evaluation_tickets;

DROP TABLE evaluation_tickets;
ALTER TABLE evaluation_tickets_run34 RENAME TO evaluation_tickets;

CREATE INDEX idx_eval_tickets_code ON evaluation_tickets(ticket_code);
CREATE INDEX idx_eval_tickets_status ON evaluation_tickets(current_status);
CREATE INDEX idx_eval_tickets_specialist ON evaluation_tickets(assigned_specialist_id);
CREATE INDEX idx_eval_tickets_created_at ON evaluation_tickets(created_at DESC);
CREATE INDEX idx_eval_tickets_supplier ON evaluation_tickets(supplier_id);
CREATE INDEX idx_eval_tickets_deleted_status ON evaluation_tickets(is_deleted, current_status);
CREATE INDEX idx_evaluation_tickets_question_version ON evaluation_tickets(question_template_version_id);
CREATE INDEX idx_evaluation_tickets_scoring_policy ON evaluation_tickets(scoring_policy_version_id);
CREATE INDEX idx_evaluation_tickets_snapshot_lock ON evaluation_tickets(snapshot_locked_at, id);
CREATE INDEX idx_evaluation_tickets_source_kind ON evaluation_tickets(source_kind, current_status);
CREATE UNIQUE INDEX ux_evaluation_tickets_historical_source_key
  ON evaluation_tickets(historical_source_key)
  WHERE historical_source_key IS NOT NULL;

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
  qi.weight,
  qi.order_index,
  qi.active,
  qi.created_at,
  NULL AS updated_at
FROM evaluation_tickets t
JOIN question_template_versions v ON v.id = t.question_template_version_id
JOIN question_templates qt ON qt.id = v.template_id
JOIN question_items qi ON qi.question_template_version_id = v.id;

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

DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_immutable;
DROP TRIGGER IF EXISTS evaluation_round_scoring_policy_pin_insert;

CREATE TABLE evaluation_rounds_run34 (
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
  FOREIGN KEY (locked_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (ticket_id, round_no)
);

INSERT INTO evaluation_rounds_run34 (
  id, ticket_id, round_no, source_round_id, assessment_code, assessment_date,
  status, started_at, completed_at, total_score, final_result, classification,
  locked_at, locked_by, correction_locked, scoring_policy_version_id,
  scoring_result_snapshot_json, scoring_result_checksum
)
SELECT
  id, ticket_id, round_no, source_round_id, assessment_code, assessment_date,
  status, started_at, completed_at, total_score, final_result, classification,
  locked_at, locked_by, correction_locked, scoring_policy_version_id,
  scoring_result_snapshot_json, scoring_result_checksum
FROM evaluation_rounds;

DROP TABLE evaluation_rounds;
ALTER TABLE evaluation_rounds_run34 RENAME TO evaluation_rounds;

CREATE INDEX idx_eval_rounds_ticket_round ON evaluation_rounds(ticket_id, round_no);
CREATE INDEX idx_eval_rounds_status ON evaluation_rounds(status);
CREATE INDEX idx_eval_rounds_assessment_code ON evaluation_rounds(assessment_code);
CREATE INDEX idx_eval_rounds_source ON evaluation_rounds(source_round_id);
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

CREATE TABLE evaluation_nonconformities_run34 (
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
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_answer_id) REFERENCES evaluation_answers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
);

INSERT INTO evaluation_nonconformities_run34 (
  id, ticket_id, round_id, clause_code, category, due_date, severity, status,
  created_at, created_by, updated_at, updated_by, evaluation_answer_id,
  nonconformity_content, remediation_content
)
SELECT
  id, ticket_id, round_id, clause_code, category, due_date, severity, status,
  created_at, created_by, updated_at, updated_by, evaluation_answer_id,
  nonconformity_content, remediation_content
FROM evaluation_nonconformities;

DROP TABLE evaluation_nonconformities;
ALTER TABLE evaluation_nonconformities_run34 RENAME TO evaluation_nonconformities;

CREATE INDEX idx_eval_nonconformities_ticket ON evaluation_nonconformities(ticket_id);
CREATE INDEX idx_eval_nonconformities_round ON evaluation_nonconformities(round_id);
CREATE INDEX idx_eval_nonconformities_status_due ON evaluation_nonconformities(status, due_date);
CREATE INDEX idx_evaluation_nonconformities_answer ON evaluation_nonconformities(evaluation_answer_id);
CREATE UNIQUE INDEX ux_evaluation_nonconformities_answer
  ON evaluation_nonconformities(evaluation_answer_id)
  WHERE evaluation_answer_id IS NOT NULL;
