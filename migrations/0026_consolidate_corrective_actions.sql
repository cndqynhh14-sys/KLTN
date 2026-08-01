-- Stage 4 removes the duplicate corrective-action store only after every row
-- is represented by exactly one canonical nonconformity. The guard table makes
-- the migration fail transactionally instead of discarding unresolved data.

UPDATE evaluation_nonconformities
SET nonconformity_content = COALESCE(
      NULLIF(TRIM(nonconformity_content), ''),
      NULLIF(TRIM(nonconformity), ''),
      (SELECT NULLIF(TRIM(ca.issue_description), '')
       FROM corrective_actions ca
       WHERE ca.id = evaluation_nonconformities.corrective_action_id)
    ),
    remediation_content = COALESCE(
      NULLIF(TRIM(remediation_content), ''),
      NULLIF(TRIM(remediation), ''),
      (SELECT NULLIF(TRIM(ca.required_action), '')
       FROM corrective_actions ca
       WHERE ca.id = evaluation_nonconformities.corrective_action_id)
    ),
    due_date = COALESCE(
      NULLIF(TRIM(due_date), ''),
      (SELECT NULLIF(TRIM(ca.due_date), '')
       FROM corrective_actions ca
       WHERE ca.id = evaluation_nonconformities.corrective_action_id)
    );

CREATE TEMP TABLE stage4_corrective_cleanup_guard (
  violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

-- An independent corrective action cannot be represented in the target model.
INSERT INTO stage4_corrective_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM corrective_actions ca
LEFT JOIN evaluation_nonconformities nc ON nc.corrective_action_id = ca.id
WHERE nc.id IS NULL;

DELETE FROM stage4_corrective_cleanup_guard;

-- A mismatch means both stores contain distinct business data. Require manual
-- reconciliation before retrying instead of choosing one value automatically.
INSERT INTO stage4_corrective_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM corrective_actions ca
JOIN evaluation_nonconformities nc ON nc.corrective_action_id = ca.id
WHERE COALESCE(NULLIF(TRIM(nc.nonconformity_content), ''), '')
        <> COALESCE(NULLIF(TRIM(ca.issue_description), ''), '')
   OR COALESCE(NULLIF(TRIM(nc.remediation_content), ''), '')
        <> COALESCE(NULLIF(TRIM(ca.required_action), ''), '')
   OR COALESCE(NULLIF(TRIM(nc.due_date), ''), '')
        <> COALESCE(NULLIF(TRIM(ca.due_date), ''), '')
   OR COALESCE(nc.status, 'OPEN') <> COALESCE(ca.status, 'OPEN');

DELETE FROM stage4_corrective_cleanup_guard;

-- Evidence and responsible-party data are explicitly outside the approved
-- target model. If real values exist, stop for an explicit data decision.
INSERT INTO stage4_corrective_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM corrective_actions
WHERE evidence_attachment_id IS NOT NULL
   OR NULLIF(TRIM(responsible_party), '') IS NOT NULL;

DELETE FROM stage4_corrective_cleanup_guard;

INSERT INTO stage4_corrective_cleanup_guard (violation_count)
SELECT COUNT(*)
FROM evaluation_nonconformities
WHERE NULLIF(TRIM(nonconformity_content), '') IS NULL;

DROP TABLE stage4_corrective_cleanup_guard;

CREATE TABLE evaluation_nonconformities_stage4 (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id               INTEGER NOT NULL,
  round_id                INTEGER,
  question_id             INTEGER,
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
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (question_id) REFERENCES evaluation_questions(id) ON DELETE SET NULL,
  FOREIGN KEY (evaluation_answer_id) REFERENCES evaluation_answers(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
);

INSERT INTO evaluation_nonconformities_stage4 (
  id, ticket_id, round_id, question_id, clause_code, category,
  due_date, severity, status, created_at, created_by, updated_at, updated_by,
  evaluation_answer_id, nonconformity_content, remediation_content
)
SELECT
  id, ticket_id, round_id, question_id, clause_code, category,
  due_date, severity, status, created_at, created_by, updated_at, updated_by,
  evaluation_answer_id, nonconformity_content, remediation_content
FROM evaluation_nonconformities;

DROP TABLE evaluation_nonconformities;
ALTER TABLE evaluation_nonconformities_stage4 RENAME TO evaluation_nonconformities;
DROP TABLE corrective_actions;

CREATE INDEX idx_eval_nonconformities_ticket
  ON evaluation_nonconformities(ticket_id);
CREATE INDEX idx_eval_nonconformities_round
  ON evaluation_nonconformities(round_id);
CREATE INDEX idx_eval_nonconformities_status_due
  ON evaluation_nonconformities(status, due_date);
CREATE INDEX idx_evaluation_nonconformities_answer
  ON evaluation_nonconformities(evaluation_answer_id);
CREATE UNIQUE INDEX idx_evaluation_nonconformities_one_per_answer
  ON evaluation_nonconformities(evaluation_answer_id)
  WHERE evaluation_answer_id IS NOT NULL;
