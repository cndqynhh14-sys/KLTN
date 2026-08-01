-- migrate: foreign_keys=off
-- Stage 4B makes evaluation_participants the canonical store for evaluation
-- roles and meeting attendance. Abort transactionally whenever legacy input
-- cannot be represented without guessing or conflicts with canonical rows.

CREATE TEMP TABLE stage4b_participant_cleanup_guard (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

-- JSON containers must be valid arrays when populated.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_tickets
WHERE NULLIF(TRIM(COALESCE(qa_support_ids, '')), '') IS NOT NULL
  AND (json_valid(qa_support_ids) = 0 OR json_type(qa_support_ids) <> 'array');
DELETE FROM stage4b_participant_cleanup_guard;

INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_rounds
WHERE NULLIF(TRIM(COALESCE(attendees_json, '')), '') IS NOT NULL
  AND (json_valid(attendees_json) = 0 OR json_type(attendees_json) <> 'array');
DELETE FROM stage4b_participant_cleanup_guard;

-- QA support IDs are internal user references. Non-text/blank items or an
-- account that cannot be matched uniquely require explicit reconciliation.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_tickets t
JOIN json_each(CASE WHEN json_valid(t.qa_support_ids) THEN t.qa_support_ids ELSE '[]' END) j
WHERE j.type <> 'text'
   OR NULLIF(TRIM(CAST(j.value AS TEXT)), '') IS NULL
   OR (SELECT COUNT(*) FROM users u
       WHERE lower(u.email) = lower(trim(CAST(j.value AS TEXT)))) <> 1;
DELETE FROM stage4b_participant_cleanup_guard;

-- QA lead, ticket owner and round evaluator are internal assignments.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*) FROM (
  SELECT assigned_specialist_id AS user_ref
  FROM evaluation_tickets
  WHERE NULLIF(TRIM(COALESCE(assigned_specialist_id, '')), '') IS NOT NULL
  UNION ALL
  SELECT qa_lead_id
  FROM evaluation_tickets
  WHERE NULLIF(TRIM(COALESCE(qa_lead_id, '')), '') IS NOT NULL
  UNION ALL
  SELECT evaluator_id
  FROM evaluation_rounds
  WHERE NULLIF(TRIM(COALESCE(evaluator_id, '')), '') IS NOT NULL
) refs
WHERE (SELECT COUNT(*) FROM users u
       WHERE lower(u.email) = lower(trim(refs.user_ref))) <> 1;
DELETE FROM stage4b_participant_cleanup_guard;

-- Rebuilding the two owner tables restores their declared user FKs. Refuse
-- orphaned audit actors explicitly instead of failing after the copy.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*) FROM (
  SELECT created_by AS user_ref FROM evaluation_tickets
  UNION ALL SELECT updated_by FROM evaluation_tickets
  UNION ALL SELECT deleted_by FROM evaluation_tickets
  UNION ALL SELECT cancelled_by FROM evaluation_tickets
  UNION ALL SELECT locked_by FROM evaluation_rounds
) refs
WHERE NULLIF(TRIM(COALESCE(refs.user_ref, '')), '') IS NOT NULL
  AND (SELECT COUNT(*) FROM users u
       WHERE lower(u.email) = lower(trim(refs.user_ref))) <> 1;
DELETE FROM stage4b_participant_cleanup_guard;

-- Attendee rows must be objects with one non-blank atomic name/title.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_rounds r
JOIN json_each(CASE WHEN json_valid(r.attendees_json) THEN r.attendees_json ELSE '[]' END) j
WHERE j.type <> 'object'
   OR NULLIF(TRIM(COALESCE(json_extract(j.value, '$.name'),
                           json_extract(j.value, '$.title'))), '') IS NULL;
DELETE FROM stage4b_participant_cleanup_guard;

CREATE TEMP TABLE stage4b_expected_participants (
  ticket_id       INTEGER,
  round_id        INTEGER,
  user_id         TEXT,
  display_name    TEXT NOT NULL,
  participant_role TEXT NOT NULL,
  opening_meeting INTEGER NOT NULL,
  closing_meeting INTEGER NOT NULL,
  assigned_at     TEXT NOT NULL,
  assigned_by     TEXT,
  identity_key    TEXT NOT NULL
);

INSERT INTO stage4b_expected_participants
SELECT t.id, NULL, owner.email,
       COALESCE(NULLIF(TRIM(owner.display_name), ''), owner.email),
       'OWNER', 0, 0, COALESCE(t.created_at, datetime('now')), creator.email,
       lower(owner.email)
FROM evaluation_tickets t
JOIN users owner ON lower(owner.email) = lower(trim(t.assigned_specialist_id))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(TRIM(COALESCE(t.assigned_specialist_id, '')), '') IS NOT NULL;

INSERT INTO stage4b_expected_participants
SELECT t.id, NULL, lead.email,
       COALESCE(NULLIF(TRIM(lead.display_name), ''), lead.email),
       'QA_LEAD', 0, 0, COALESCE(t.created_at, datetime('now')), creator.email,
       lower(lead.email)
FROM evaluation_tickets t
JOIN users lead ON lower(lead.email) = lower(trim(t.qa_lead_id))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(TRIM(COALESCE(t.qa_lead_id, '')), '') IS NOT NULL;

INSERT INTO stage4b_expected_participants
SELECT t.id, NULL, support.email,
       COALESCE(NULLIF(TRIM(support.display_name), ''), support.email),
       'QA_SUPPORT', 0, 0, COALESCE(t.created_at, datetime('now')), creator.email,
       lower(support.email)
FROM evaluation_tickets t
JOIN json_each(CASE WHEN json_valid(t.qa_support_ids) THEN t.qa_support_ids ELSE '[]' END) j
JOIN users support ON lower(support.email) = lower(trim(CAST(j.value AS TEXT)))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE j.type = 'text'
GROUP BY t.id, lower(support.email);

INSERT INTO stage4b_expected_participants
SELECT t.id, NULL,
       CASE WHEN COUNT(evaluator.email) = 1 THEN MIN(evaluator.email) END,
       COALESCE(NULLIF(TRIM(MIN(evaluator.display_name)), ''), TRIM(t.evaluator_name)),
       'EVALUATOR', 0, 0, COALESCE(t.created_at, datetime('now')), creator.email,
       lower(COALESCE(MIN(evaluator.email), TRIM(t.evaluator_name)))
FROM evaluation_tickets t
LEFT JOIN users evaluator ON lower(evaluator.email) = lower(trim(t.evaluator_name))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(TRIM(COALESCE(t.evaluator_name, '')), '') IS NOT NULL
GROUP BY t.id, lower(trim(t.evaluator_name));

INSERT INTO stage4b_expected_participants
SELECT NULL, r.id, evaluator.email,
       COALESCE(NULLIF(TRIM(evaluator.display_name), ''), evaluator.email),
       'EVALUATOR', 0, 0, COALESCE(r.started_at, datetime('now')),
       COALESCE(locker.email, evaluator.email), lower(evaluator.email)
FROM evaluation_rounds r
JOIN users evaluator ON lower(evaluator.email) = lower(trim(r.evaluator_id))
LEFT JOIN users locker ON lower(locker.email) = lower(trim(r.locked_by))
WHERE NULLIF(TRIM(COALESCE(r.evaluator_id, '')), '') IS NOT NULL;

INSERT INTO stage4b_expected_participants
SELECT NULL, r.id,
       CASE WHEN COUNT(attendee_user.email) = 1 THEN MIN(attendee_user.email) END,
       TRIM(COALESCE(json_extract(j.value, '$.name'), json_extract(j.value, '$.title'))),
       'ATTENDEE',
       MAX(CASE WHEN COALESCE(json_extract(j.value, '$.opening'),
                              json_extract(j.value, '$.opening_meeting'), 0) THEN 1 ELSE 0 END),
       MAX(CASE WHEN COALESCE(json_extract(j.value, '$.closing'),
                              json_extract(j.value, '$.closing_meeting'), 0) THEN 1 ELSE 0 END),
       COALESCE(r.started_at, datetime('now')), evaluator.email,
       lower(COALESCE(MIN(attendee_user.email), TRIM(COALESCE(
         json_extract(j.value, '$.name'), json_extract(j.value, '$.title')
       ))))
FROM evaluation_rounds r
JOIN json_each(CASE WHEN json_valid(r.attendees_json) THEN r.attendees_json ELSE '[]' END) j
LEFT JOIN users attendee_user ON lower(attendee_user.email) = lower(trim(COALESCE(
  json_extract(j.value, '$.name'), json_extract(j.value, '$.title')
)))
LEFT JOIN users evaluator ON lower(evaluator.email) = lower(trim(r.evaluator_id))
WHERE j.type = 'object'
GROUP BY r.id, lower(trim(COALESCE(json_extract(j.value, '$.name'),
                                   json_extract(j.value, '$.title'))));

-- Add only missing identities. Existing canonical history is retained, then
-- exact scope/role parity below rejects a conflicting projection.
INSERT INTO evaluation_participants (
  ticket_id, round_id, user_id, display_name, participant_role,
  opening_meeting, closing_meeting, active, assigned_at, assigned_by
)
SELECT e.ticket_id, e.round_id, e.user_id, e.display_name, e.participant_role,
       e.opening_meeting, e.closing_meeting, 1, e.assigned_at, e.assigned_by
FROM stage4b_expected_participants e
WHERE NOT EXISTS (
  SELECT 1
  FROM evaluation_participants p
  WHERE p.active = 1
    AND p.ticket_id IS e.ticket_id
    AND p.round_id IS e.round_id
    AND p.participant_role = e.participant_role
    AND lower(COALESCE(p.user_id, TRIM(p.display_name))) = e.identity_key
);

-- Every expected identity and meeting flag must now be represented exactly.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM stage4b_expected_participants e
WHERE NOT EXISTS (
  SELECT 1
  FROM evaluation_participants p
  WHERE p.active = 1
    AND p.ticket_id IS e.ticket_id
    AND p.round_id IS e.round_id
    AND p.participant_role = e.participant_role
    AND lower(COALESCE(p.user_id, TRIM(p.display_name))) = e.identity_key
    AND p.opening_meeting = e.opening_meeting
    AND p.closing_meeting = e.closing_meeting
);
DELETE FROM stage4b_participant_cleanup_guard;

-- When a legacy role is populated, canonical storage must not contain an
-- additional active identity for that same scope and role.
INSERT INTO stage4b_participant_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_participants p
WHERE p.active = 1
  AND EXISTS (
    SELECT 1 FROM stage4b_expected_participants e
    WHERE e.ticket_id IS p.ticket_id
      AND e.round_id IS p.round_id
      AND e.participant_role = p.participant_role
  )
  AND NOT EXISTS (
    SELECT 1 FROM stage4b_expected_participants e
    WHERE e.ticket_id IS p.ticket_id
      AND e.round_id IS p.round_id
      AND e.participant_role = p.participant_role
      AND e.identity_key = lower(COALESCE(p.user_id, TRIM(p.display_name)))
  );

DROP TABLE stage4b_participant_cleanup_guard;
DROP TABLE stage4b_expected_participants;

DROP VIEW pinned_evaluation_questions;
DROP TRIGGER evaluation_ticket_scoring_policy_pin_insert;
DROP TRIGGER evaluation_ticket_scoring_policy_pin_immutable;
DROP TRIGGER evaluation_round_scoring_policy_pin_insert;
DROP TRIGGER evaluation_round_scoring_policy_pin_immutable;

CREATE TABLE evaluation_tickets_stage4b (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_code            TEXT NOT NULL UNIQUE,
  supplier_id            INTEGER NOT NULL,
  supplier_code          TEXT,
  supplier_name          TEXT,
  tax_code               TEXT,
  supplier_address       TEXT,
  production_address     TEXT,
  evaluation_address     TEXT,
  linked_facility_code   TEXT,
  linked_facility_name   TEXT,
  linked_facility_address TEXT,
  linked_facility_type   TEXT,
  region                 TEXT,
  province               TEXT,
  business_type          TEXT,
  cmc_owner              TEXT,
  cmc_head               TEXT,
  business_license_file  TEXT,
  attp_certificate_type  TEXT,
  attp_certificate_file  TEXT,
  contact_name           TEXT,
  contact_email          TEXT,
  contact_phone          TEXT,
  mch2                   TEXT,
  mch3                   TEXT,
  product_group          TEXT,
  product_name           TEXT,
  evaluation_type        TEXT NOT NULL,
  template_id            INTEGER NOT NULL,
  facility_type          TEXT NOT NULL,
  supplier_scale         TEXT NOT NULL CHECK (supplier_scale IN ('LARGE', 'SMALL')),
  evaluation_method      TEXT,
  evaluation_department  TEXT,
  planned_date           TEXT,
  actual_evaluation_date TEXT,
  current_status         TEXT NOT NULL,
  current_round_no       INTEGER NOT NULL DEFAULT 1 CHECK (current_round_no IN (1, 2)),
  assigned_specialist_id TEXT,
  score_percent          REAL,
  grade_code             TEXT,
  result_label           TEXT,
  result_reason          TEXT,
  corrected_score_percent REAL,
  corrected_grade_code   TEXT,
  corrected_result_label TEXT,
  correction_date        TEXT,
  next_evaluation_date   TEXT,
  final_conclusion       TEXT,
  specialist_proposal    TEXT,
  supplier_introduction  TEXT,
  scoring_locked         INTEGER NOT NULL DEFAULT 0 CHECK (scoring_locked IN (0, 1)),
  completed_round        INTEGER NOT NULL DEFAULT 1 CHECK (completed_round IN (1, 2)),
  is_deleted             INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
  deleted_at             TEXT,
  deleted_by             TEXT,
  deleted_reason         TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by             TEXT,
  updated_at             TEXT,
  updated_by             TEXT,
  cancelled_reason       TEXT,
  cancelled_by           TEXT,
  cancelled_at           TEXT,
  question_template_version_id INTEGER REFERENCES question_template_versions(id) ON DELETE RESTRICT,
  scoring_policy_version_id INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  snapshot_locked_at     TEXT,
  FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_specialist_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(email) ON DELETE SET NULL
);

INSERT INTO evaluation_tickets_stage4b (
  id, ticket_code, supplier_id, supplier_code, supplier_name, tax_code,
  supplier_address, production_address, evaluation_address, linked_facility_code,
  linked_facility_name, linked_facility_address, linked_facility_type, region,
  province, business_type, cmc_owner, cmc_head, business_license_file,
  attp_certificate_type, attp_certificate_file, contact_name, contact_email,
  contact_phone, mch2, mch3, product_group, product_name, evaluation_type,
  template_id, facility_type, supplier_scale, evaluation_method,
  evaluation_department, planned_date, actual_evaluation_date, current_status,
  current_round_no, assigned_specialist_id, score_percent, grade_code,
  result_label, result_reason, corrected_score_percent, corrected_grade_code,
  corrected_result_label, correction_date, next_evaluation_date, final_conclusion,
  specialist_proposal, supplier_introduction, scoring_locked, completed_round,
  is_deleted, deleted_at, deleted_by, deleted_reason, created_at, created_by,
  updated_at, updated_by, cancelled_reason, cancelled_by, cancelled_at,
  question_template_version_id, scoring_policy_version_id, snapshot_locked_at
)
SELECT
  id, ticket_code, supplier_id, supplier_code, supplier_name, tax_code,
  supplier_address, production_address, evaluation_address, linked_facility_code,
  linked_facility_name, linked_facility_address, linked_facility_type, region,
  province, business_type, cmc_owner, cmc_head, business_license_file,
  attp_certificate_type, attp_certificate_file, contact_name, contact_email,
  contact_phone, mch2, mch3, product_group, product_name, evaluation_type,
  template_id, facility_type, supplier_scale, evaluation_method,
  evaluation_department, planned_date, actual_evaluation_date, current_status,
  current_round_no, assigned_specialist_id, score_percent, grade_code,
  result_label, result_reason, corrected_score_percent, corrected_grade_code,
  corrected_result_label, correction_date, next_evaluation_date, final_conclusion,
  specialist_proposal, supplier_introduction, scoring_locked, completed_round,
  is_deleted, deleted_at, deleted_by, deleted_reason, created_at, created_by,
  updated_at, updated_by, cancelled_reason, cancelled_by, cancelled_at,
  question_template_version_id, scoring_policy_version_id, snapshot_locked_at
FROM evaluation_tickets;

DROP TABLE evaluation_tickets;
ALTER TABLE evaluation_tickets_stage4b RENAME TO evaluation_tickets;

CREATE INDEX idx_eval_tickets_code ON evaluation_tickets(ticket_code);
CREATE INDEX idx_eval_tickets_status ON evaluation_tickets(current_status);
CREATE INDEX idx_eval_tickets_specialist ON evaluation_tickets(assigned_specialist_id);
CREATE INDEX idx_eval_tickets_created_at ON evaluation_tickets(created_at DESC);
CREATE INDEX idx_eval_tickets_supplier ON evaluation_tickets(supplier_id);
CREATE INDEX idx_eval_tickets_deleted_status ON evaluation_tickets(is_deleted, current_status);
CREATE INDEX idx_evaluation_tickets_question_version ON evaluation_tickets(question_template_version_id);
CREATE INDEX idx_evaluation_tickets_scoring_policy ON evaluation_tickets(scoring_policy_version_id);
CREATE INDEX idx_evaluation_tickets_snapshot_lock ON evaluation_tickets(snapshot_locked_at, id);

CREATE TABLE evaluation_rounds_stage4b (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL,
  round_no       INTEGER NOT NULL CHECK (round_no IN (1, 2)),
  source_round_id INTEGER,
  assessment_code TEXT,
  assessment_date TEXT,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT,
  total_score    REAL,
  final_result   TEXT,
  classification TEXT,
  locked_at      TEXT,
  locked_by      TEXT,
  correction_locked INTEGER NOT NULL DEFAULT 0 CHECK (correction_locked IN (0, 1)),
  scoring_policy_version_id INTEGER REFERENCES scoring_policy_versions(id) ON DELETE RESTRICT,
  scoring_result_snapshot_json TEXT,
  scoring_result_checksum TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (source_round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (locked_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (ticket_id, round_no)
);

INSERT INTO evaluation_rounds_stage4b (
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
ALTER TABLE evaluation_rounds_stage4b RENAME TO evaluation_rounds;

CREATE INDEX idx_eval_rounds_ticket_round ON evaluation_rounds(ticket_id, round_no);
CREATE INDEX idx_eval_rounds_status ON evaluation_rounds(status);
CREATE INDEX idx_eval_rounds_assessment_code ON evaluation_rounds(assessment_code);
CREATE INDEX idx_eval_rounds_source ON evaluation_rounds(source_round_id);
CREATE INDEX idx_evaluation_rounds_scoring_policy ON evaluation_rounds(scoring_policy_version_id);
CREATE INDEX idx_evaluation_rounds_ticket_scoring
  ON evaluation_rounds(ticket_id, scoring_policy_version_id, round_no);

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

CREATE TRIGGER evaluation_ticket_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_tickets
WHEN OLD.scoring_policy_version_id IS NOT NULL
  AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'ticket_scoring_policy_pin_immutable'); END;

CREATE TRIGGER evaluation_round_scoring_policy_pin_insert
AFTER INSERT ON evaluation_rounds
WHEN NEW.scoring_policy_version_id IS NULL
BEGIN
  UPDATE evaluation_rounds SET scoring_policy_version_id = (
    SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id = NEW.ticket_id
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER evaluation_round_scoring_policy_pin_immutable
BEFORE UPDATE OF scoring_policy_version_id ON evaluation_rounds
WHEN OLD.scoring_policy_version_id IS NOT NULL
  AND NEW.scoring_policy_version_id != OLD.scoring_policy_version_id
BEGIN SELECT RAISE(ABORT, 'round_scoring_policy_pin_immutable'); END;

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
