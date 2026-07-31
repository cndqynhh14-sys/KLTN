ALTER TABLE evaluation_nonconformities
  ADD COLUMN evaluation_answer_id INTEGER REFERENCES evaluation_answers(id) ON DELETE RESTRICT;
ALTER TABLE evaluation_nonconformities
  ADD COLUMN nonconformity_content TEXT;
ALTER TABLE evaluation_nonconformities
  ADD COLUMN remediation_content TEXT;

UPDATE evaluation_nonconformities
SET evaluation_answer_id = (
  SELECT MIN(a.id)
  FROM evaluation_answers a
  WHERE a.round_id = evaluation_nonconformities.round_id
    AND a.question_id = evaluation_nonconformities.question_id
  HAVING COUNT(*) = 1
)
WHERE evaluation_answer_id IS NULL;

UPDATE evaluation_nonconformities
SET nonconformity_content = COALESCE(nonconformity_content, nonconformity),
    remediation_content = COALESCE(
      remediation_content,
      remediation,
      (SELECT ca.required_action FROM corrective_actions ca
       WHERE ca.id = evaluation_nonconformities.corrective_action_id)
    ),
    due_date = COALESCE(
      due_date,
      (SELECT ca.due_date FROM corrective_actions ca
       WHERE ca.id = evaluation_nonconformities.corrective_action_id)
    );

CREATE INDEX idx_evaluation_nonconformities_answer
  ON evaluation_nonconformities(evaluation_answer_id);
CREATE UNIQUE INDEX idx_evaluation_nonconformities_one_per_answer
  ON evaluation_nonconformities(evaluation_answer_id)
  WHERE evaluation_answer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_evaluation_nonconformities_corrective_action
  ON evaluation_nonconformities(corrective_action_id)
  WHERE corrective_action_id IS NOT NULL;
