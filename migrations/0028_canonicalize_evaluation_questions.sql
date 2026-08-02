-- migrate: foreign_keys=off
-- Stage 4C makes versioned question_items the only question identity used by
-- tickets, answers and nonconformities. Every destructive step is preceded by
-- a transactional guard; unresolved legacy rows make the migration abort.

CREATE TEMP TABLE stage4c_question_cleanup_guard (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

-- Every ticket must pin one version belonging to its selected template.
INSERT INTO stage4c_question_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_tickets t
LEFT JOIN question_template_versions v ON v.id = t.question_template_version_id
WHERE v.id IS NULL OR v.template_id <> t.template_id;
DELETE FROM stage4c_question_cleanup_guard;

-- Every legacy criterion must already be represented in canonical storage.
INSERT INTO stage4c_question_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_questions q
WHERE NOT EXISTS (
  SELECT 1 FROM question_items qi WHERE qi.legacy_question_id = q.id
);
DELETE FROM stage4c_question_cleanup_guard;

-- An answer must resolve to exactly one item in the version pinned by its
-- ticket, and its two identifiers must describe the same historical row.
INSERT INTO stage4c_question_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_answers a
JOIN evaluation_rounds r ON r.id = a.round_id
JOIN evaluation_tickets t ON t.id = r.ticket_id
LEFT JOIN question_items qi ON qi.id = a.question_item_id
WHERE qi.id IS NULL
   OR qi.question_template_version_id <> t.question_template_version_id
   OR qi.legacy_question_id IS NULL
   OR qi.legacy_question_id <> a.question_id;
DELETE FROM stage4c_question_cleanup_guard;

-- Canonical answer identity must remain unique within a round.
INSERT INTO stage4c_question_cleanup_guard (violation_count)
SELECT COUNT(*) FROM (
  SELECT round_id, question_item_id
  FROM evaluation_answers
  GROUP BY round_id, question_item_id
  HAVING question_item_id IS NULL OR COUNT(*) <> 1
);
DELETE FROM stage4c_question_cleanup_guard;

-- A finding derives its question through one answer in the same ticket/round.
INSERT INTO stage4c_question_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_nonconformities nc
LEFT JOIN evaluation_answers a ON a.id = nc.evaluation_answer_id
LEFT JOIN evaluation_rounds r ON r.id = a.round_id
WHERE a.id IS NULL
   OR r.id IS NULL
   OR nc.ticket_id <> r.ticket_id
   OR nc.round_id IS NULL
   OR nc.round_id <> r.id
   OR nc.question_id IS NULL
   OR nc.question_id <> a.question_id;
DELETE FROM stage4c_question_cleanup_guard;

DROP VIEW pinned_evaluation_questions;
DROP TRIGGER question_items_published_insert_immutable;
DROP TRIGGER question_items_published_update_immutable;
DROP TRIGGER question_items_published_delete_immutable;

CREATE TABLE question_items_stage4c (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_template_version_id INTEGER NOT NULL,
  facility_type                TEXT NOT NULL,
  supplier_scale               TEXT NOT NULL CHECK (supplier_scale IN ('LARGE', 'SMALL', 'ALL')),
  question_code                TEXT NOT NULL,
  question_text                TEXT NOT NULL,
  category                     TEXT NOT NULL,
  is_elimination_clause        INTEGER NOT NULL DEFAULT 0 CHECK (is_elimination_clause IN (0, 1)),
  is_critical_clause           INTEGER NOT NULL DEFAULT 0 CHECK (is_critical_clause IN (0, 1)),
  requires_attachment          INTEGER NOT NULL DEFAULT 0 CHECK (requires_attachment IN (0, 1)),
  allowed_scores               TEXT NOT NULL DEFAULT 'A/B/C/D/NA',
  weight                       REAL NOT NULL DEFAULT 1,
  order_index                  INTEGER NOT NULL DEFAULT 0,
  active                       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  variant_code                 TEXT,
  category_code                TEXT,
  clause_code                  TEXT,
  category_label_snapshot      TEXT,
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE CASCADE,
  UNIQUE (question_template_version_id, facility_type, supplier_scale, question_code)
);

INSERT INTO question_items_stage4c (
  id, question_template_version_id, facility_type, supplier_scale,
  question_code, question_text, category, is_elimination_clause,
  is_critical_clause, requires_attachment, allowed_scores, weight,
  order_index, active, created_at, variant_code, category_code,
  clause_code, category_label_snapshot
)
SELECT
  id, question_template_version_id, facility_type, supplier_scale,
  question_code, question_text, category, is_elimination_clause,
  is_critical_clause, requires_attachment, allowed_scores, weight,
  order_index, active, created_at, variant_code, category_code,
  clause_code, category_label_snapshot
FROM question_items;

CREATE TABLE evaluation_answers_stage4c (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id         INTEGER NOT NULL,
  question_item_id INTEGER NOT NULL,
  score            TEXT CHECK (score IN ('A', 'B', 'C', 'D', 'NA')),
  comment          TEXT,
  calculated_score REAL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT,
  answered_by      TEXT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (question_item_id) REFERENCES question_items_stage4c(id) ON DELETE RESTRICT,
  FOREIGN KEY (answered_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (round_id, question_item_id)
);

INSERT INTO evaluation_answers_stage4c (
  id, round_id, question_item_id, score, comment, calculated_score,
  created_at, updated_at, answered_by
)
SELECT
  id, round_id, question_item_id, score, comment, calculated_score,
  created_at, updated_at, answered_by
FROM evaluation_answers;

CREATE TABLE evaluation_nonconformities_stage4c (
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
  evaluation_answer_id    INTEGER NOT NULL,
  nonconformity_content   TEXT NOT NULL CHECK (NULLIF(TRIM(nonconformity_content), '') IS NOT NULL),
  remediation_content     TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (evaluation_answer_id) REFERENCES evaluation_answers_stage4c(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (evaluation_answer_id)
);

INSERT INTO evaluation_nonconformities_stage4c (
  id, ticket_id, round_id, clause_code, category, due_date, severity,
  status, created_at, created_by, updated_at, updated_by,
  evaluation_answer_id, nonconformity_content, remediation_content
)
SELECT
  id, ticket_id, round_id, clause_code, category, due_date, severity,
  status, created_at, created_by, updated_at, updated_by,
  evaluation_answer_id, nonconformity_content, remediation_content
FROM evaluation_nonconformities;

DROP TABLE evaluation_nonconformities;
DROP TABLE evaluation_answers;
DROP TABLE question_items;
DROP TABLE evaluation_questions;

ALTER TABLE question_items_stage4c RENAME TO question_items;
ALTER TABLE evaluation_answers_stage4c RENAME TO evaluation_answers;
ALTER TABLE evaluation_nonconformities_stage4c RENAME TO evaluation_nonconformities;

CREATE INDEX idx_question_items_category_code
  ON question_items(question_template_version_id, category_code);
CREATE INDEX idx_question_items_stable_codes
  ON question_items(question_template_version_id, variant_code, category_code, clause_code);
CREATE INDEX idx_question_items_version_scope
  ON question_items(question_template_version_id, facility_type, supplier_scale, active, order_index);

CREATE INDEX idx_eval_answers_round ON evaluation_answers(round_id);
CREATE INDEX idx_eval_answers_score ON evaluation_answers(score);
CREATE INDEX idx_evaluation_answers_question_item
  ON evaluation_answers(question_item_id, round_id);

CREATE INDEX idx_eval_nonconformities_round
  ON evaluation_nonconformities(round_id);
CREATE INDEX idx_eval_nonconformities_status_due
  ON evaluation_nonconformities(status, due_date);
CREATE INDEX idx_eval_nonconformities_ticket
  ON evaluation_nonconformities(ticket_id);
CREATE INDEX idx_evaluation_nonconformities_answer
  ON evaluation_nonconformities(evaluation_answer_id);

CREATE TRIGGER question_items_published_insert_immutable
BEFORE INSERT ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = NEW.question_template_version_id)
     IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_items_published_update_immutable
BEFORE UPDATE ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id)
     IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_items_published_delete_immutable
BEFORE DELETE ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id)
     IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

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

DROP TABLE stage4c_question_cleanup_guard;
