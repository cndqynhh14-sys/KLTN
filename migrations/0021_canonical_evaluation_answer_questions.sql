ALTER TABLE evaluation_answers
  ADD COLUMN question_item_id INTEGER REFERENCES question_items(id) ON DELETE RESTRICT;

UPDATE evaluation_answers
SET question_item_id = (
  SELECT MIN(qi.id)
  FROM evaluation_rounds r
  JOIN evaluation_tickets t ON t.id = r.ticket_id
  JOIN question_items qi
    ON qi.question_template_version_id = t.question_template_version_id
   AND qi.legacy_question_id = evaluation_answers.question_id
  WHERE r.id = evaluation_answers.round_id
  HAVING COUNT(*) = 1
)
WHERE question_item_id IS NULL;

CREATE INDEX idx_evaluation_answers_question_item
  ON evaluation_answers(question_item_id, round_id);
CREATE UNIQUE INDEX idx_evaluation_answers_round_question_item
  ON evaluation_answers(round_id, question_item_id)
  WHERE question_item_id IS NOT NULL;
