CREATE TABLE evaluation_participants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER,
  round_id         INTEGER,
  user_id          TEXT,
  display_name     TEXT NOT NULL,
  participant_role TEXT NOT NULL CHECK (participant_role IN (
    'OWNER', 'QA_LEAD', 'QA_SUPPORT', 'EVALUATOR', 'ATTENDEE', 'SUPPLIER_REP', 'OTHER'
  )),
  opening_meeting  INTEGER NOT NULL DEFAULT 0 CHECK (opening_meeting IN (0, 1)),
  closing_meeting  INTEGER NOT NULL DEFAULT 0 CHECK (closing_meeting IN (0, 1)),
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  assigned_at      TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_by      TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (assigned_by) REFERENCES users(email) ON DELETE SET NULL,
  CHECK (
    (ticket_id IS NOT NULL AND round_id IS NULL)
    OR (ticket_id IS NULL AND round_id IS NOT NULL)
  ),
  CHECK (length(trim(display_name)) > 0)
);

CREATE INDEX idx_evaluation_participants_ticket
  ON evaluation_participants(ticket_id, participant_role, active);
CREATE INDEX idx_evaluation_participants_round
  ON evaluation_participants(round_id, participant_role, active);
CREATE INDEX idx_evaluation_participants_user
  ON evaluation_participants(user_id, active);
CREATE UNIQUE INDEX idx_evaluation_participants_ticket_identity
  ON evaluation_participants(
    ticket_id, participant_role, COALESCE(user_id, ''), lower(trim(display_name))
  ) WHERE ticket_id IS NOT NULL;
CREATE UNIQUE INDEX idx_evaluation_participants_round_identity
  ON evaluation_participants(
    round_id, participant_role, COALESCE(user_id, ''), lower(trim(display_name))
  ) WHERE round_id IS NOT NULL;

-- Ticket-level ownership and assignments. display_name is a historical label;
-- user_id is populated only for an exact, unique case-insensitive account match.
INSERT OR IGNORE INTO evaluation_participants (
  ticket_id, user_id, display_name, participant_role, assigned_at, assigned_by
)
SELECT t.id, u.email, COALESCE(NULLIF(trim(u.display_name), ''), u.email), 'OWNER',
       COALESCE(t.created_at, datetime('now')),
       CASE WHEN creator.email IS NOT NULL THEN creator.email END
FROM evaluation_tickets t
JOIN users u ON lower(u.email) = lower(trim(t.assigned_specialist_id))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(trim(t.assigned_specialist_id), '') IS NOT NULL
  AND (SELECT COUNT(*) FROM users matched
       WHERE lower(matched.email) = lower(trim(t.assigned_specialist_id))) = 1;

INSERT OR IGNORE INTO evaluation_participants (
  ticket_id, user_id, display_name, participant_role, assigned_at, assigned_by
)
SELECT t.id, u.email, COALESCE(NULLIF(trim(u.display_name), ''), u.email), 'QA_LEAD',
       COALESCE(t.created_at, datetime('now')),
       CASE WHEN creator.email IS NOT NULL THEN creator.email END
FROM evaluation_tickets t
JOIN users u ON lower(u.email) = lower(trim(t.qa_lead_id))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(trim(t.qa_lead_id), '') IS NOT NULL
  AND (SELECT COUNT(*) FROM users matched
       WHERE lower(matched.email) = lower(trim(t.qa_lead_id))) = 1;

INSERT OR IGNORE INTO evaluation_participants (
  ticket_id, user_id, display_name, participant_role, assigned_at, assigned_by
)
SELECT t.id,
       CASE WHEN COUNT(u.email) = 1 THEN MIN(u.email) END,
       COALESCE(NULLIF(trim(MIN(u.display_name)), ''), trim(CAST(j.value AS TEXT))),
       'QA_SUPPORT', COALESCE(t.created_at, datetime('now')),
       CASE WHEN creator.email IS NOT NULL THEN creator.email END
FROM evaluation_tickets t
JOIN json_each(CASE WHEN json_valid(t.qa_support_ids) THEN t.qa_support_ids ELSE '[]' END) j
LEFT JOIN users u ON lower(u.email) = lower(trim(CAST(j.value AS TEXT)))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE json_valid(t.qa_support_ids) = 1
  AND json_type(t.qa_support_ids) = 'array'
  AND j.type = 'text'
  AND NULLIF(trim(CAST(j.value AS TEXT)), '') IS NOT NULL
GROUP BY t.id, lower(trim(CAST(j.value AS TEXT)));

INSERT OR IGNORE INTO evaluation_participants (
  ticket_id, user_id, display_name, participant_role, assigned_at, assigned_by
)
SELECT t.id,
       CASE WHEN COUNT(u.email) = 1 THEN MIN(u.email) END,
       COALESCE(NULLIF(trim(MIN(u.display_name)), ''), trim(t.evaluator_name)),
       'EVALUATOR', COALESCE(t.created_at, datetime('now')),
       CASE WHEN creator.email IS NOT NULL THEN creator.email END
FROM evaluation_tickets t
LEFT JOIN users u ON lower(u.email) = lower(trim(t.evaluator_name))
LEFT JOIN users creator ON lower(creator.email) = lower(trim(t.created_by))
WHERE NULLIF(trim(t.evaluator_name), '') IS NOT NULL
GROUP BY t.id, lower(trim(t.evaluator_name));

-- Round evaluator assignments are independent from meeting attendance.
INSERT OR IGNORE INTO evaluation_participants (
  round_id, user_id, display_name, participant_role, assigned_at, assigned_by
)
SELECT r.id, u.email, COALESCE(NULLIF(trim(u.display_name), ''), u.email), 'EVALUATOR',
       COALESCE(r.started_at, datetime('now')), u.email
FROM evaluation_rounds r
JOIN users u ON lower(u.email) = lower(trim(r.evaluator_id))
WHERE NULLIF(trim(r.evaluator_id), '') IS NOT NULL
  AND (SELECT COUNT(*) FROM users matched
       WHERE lower(matched.email) = lower(trim(r.evaluator_id))) = 1;

INSERT OR IGNORE INTO evaluation_participants (
  round_id, user_id, display_name, participant_role,
  opening_meeting, closing_meeting, assigned_at, assigned_by
)
SELECT r.id,
       CASE WHEN COUNT(u.email) = 1 THEN MIN(u.email) END,
       trim(COALESCE(json_extract(j.value, '$.name'), json_extract(j.value, '$.title'))),
       'ATTENDEE',
       MAX(CASE WHEN COALESCE(json_extract(j.value, '$.opening'),
                              json_extract(j.value, '$.opening_meeting'), 0) THEN 1 ELSE 0 END),
       MAX(CASE WHEN COALESCE(json_extract(j.value, '$.closing'),
                              json_extract(j.value, '$.closing_meeting'), 0) THEN 1 ELSE 0 END),
       COALESCE(r.started_at, datetime('now')),
       CASE WHEN evaluator.email IS NOT NULL THEN evaluator.email END
FROM evaluation_rounds r
JOIN json_each(CASE WHEN json_valid(r.attendees_json) THEN r.attendees_json ELSE '[]' END) j
LEFT JOIN users u ON lower(u.email) = lower(trim(COALESCE(
  json_extract(j.value, '$.name'), json_extract(j.value, '$.title')
)))
LEFT JOIN users evaluator ON lower(evaluator.email) = lower(trim(r.evaluator_id))
WHERE json_valid(r.attendees_json) = 1
  AND json_type(r.attendees_json) = 'array'
  AND j.type = 'object'
  AND NULLIF(trim(COALESCE(json_extract(j.value, '$.name'),
                           json_extract(j.value, '$.title'))), '') IS NOT NULL
GROUP BY r.id, lower(trim(COALESCE(json_extract(j.value, '$.name'),
                                   json_extract(j.value, '$.title'))));
