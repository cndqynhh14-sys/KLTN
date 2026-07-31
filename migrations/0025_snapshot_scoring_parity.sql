ALTER TABLE evaluation_tickets ADD COLUMN snapshot_locked_at TEXT;

UPDATE evaluation_tickets
SET snapshot_locked_at = (
  SELECT MIN(r.started_at)
  FROM evaluation_rounds r
  WHERE r.ticket_id = evaluation_tickets.id AND r.round_no = 1
)
WHERE snapshot_locked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM evaluation_rounds r
    WHERE r.ticket_id = evaluation_tickets.id AND r.round_no = 1
  );

UPDATE evaluation_tickets
SET scoring_policy_version_id = (
  SELECT a.scoring_policy_version_id
  FROM scoring_policy_assignments a
  JOIN scoring_policy_versions v ON v.id = a.scoring_policy_version_id
  WHERE a.active = 1 AND a.is_default = 1 AND v.status = 'PUBLISHED'
    AND (a.template_id IS NULL OR a.template_id = evaluation_tickets.template_id)
    AND (a.facility_type IS NULL OR a.facility_type = evaluation_tickets.facility_type)
    AND (a.supplier_scale IS NULL OR a.supplier_scale = evaluation_tickets.supplier_scale)
  ORDER BY
    (a.template_id IS NOT NULL) DESC,
    (a.facility_type IS NOT NULL) DESC,
    (a.supplier_scale IS NOT NULL) DESC,
    a.id DESC
  LIMIT 1
)
WHERE scoring_policy_version_id IS NULL
  AND 1 = (
    SELECT COUNT(*) FROM (
      SELECT a.scoring_policy_version_id
      FROM scoring_policy_assignments a
      JOIN scoring_policy_versions v ON v.id = a.scoring_policy_version_id
      WHERE a.active = 1 AND a.is_default = 1 AND v.status = 'PUBLISHED'
        AND (a.template_id IS NULL OR a.template_id = evaluation_tickets.template_id)
        AND (a.facility_type IS NULL OR a.facility_type = evaluation_tickets.facility_type)
        AND (a.supplier_scale IS NULL OR a.supplier_scale = evaluation_tickets.supplier_scale)
      GROUP BY a.scoring_policy_version_id
    ) candidates
  );

UPDATE evaluation_rounds
SET scoring_policy_version_id = (
  SELECT t.scoring_policy_version_id
  FROM evaluation_tickets t WHERE t.id = evaluation_rounds.ticket_id
)
WHERE scoring_policy_version_id IS NULL
  AND (SELECT t.scoring_policy_version_id FROM evaluation_tickets t
       WHERE t.id = evaluation_rounds.ticket_id) IS NOT NULL;

CREATE INDEX idx_evaluation_tickets_snapshot_lock
  ON evaluation_tickets(snapshot_locked_at, id);
CREATE INDEX idx_evaluation_rounds_ticket_scoring
  ON evaluation_rounds(ticket_id, scoring_policy_version_id, round_no);
