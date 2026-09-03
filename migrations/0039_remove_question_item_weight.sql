DROP VIEW IF EXISTS pinned_evaluation_questions;

ALTER TABLE question_items DROP COLUMN weight;

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
  qi.order_index,
  qi.active,
  qi.created_at,
  NULL AS updated_at
FROM evaluation_tickets t
JOIN question_template_versions v ON v.id = t.question_template_version_id
JOIN question_templates qt ON qt.id = v.template_id
JOIN question_items qi ON qi.question_template_version_id = v.id;
