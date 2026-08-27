CREATE TABLE corrective_requirements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL CHECK (NULLIF(TRIM(name), '') IS NOT NULL AND length(name) <= 120),
  normalized_name TEXT NOT NULL CHECK (NULLIF(TRIM(normalized_name), '') IS NOT NULL),
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX ux_corrective_requirements_normalized_name
  ON corrective_requirements(normalized_name);
CREATE INDEX idx_corrective_requirements_active_name
  ON corrective_requirements(is_active, name COLLATE NOCASE);

INSERT INTO corrective_requirements (name, normalized_name)
VALUES
  ('Bổ sung hồ sơ', 'bổ sung hồ sơ'),
  ('Gửi hình ảnh khắc phục', 'gửi hình ảnh khắc phục');

INSERT OR IGNORE INTO corrective_requirements (name, normalized_name)
SELECT MIN(display_name), normalized_name
FROM (
  SELECT
    TRIM(remediation_content) AS display_name,
    LOWER(TRIM(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        remediation_content, '  ', ' '), '  ', ' '), '  ', ' '),
        '  ', ' '), '  ', ' '), '  ', ' ')
    )) AS normalized_name
  FROM evaluation_nonconformities
  WHERE NULLIF(TRIM(COALESCE(remediation_content, '')), '') IS NOT NULL
)
GROUP BY normalized_name;

ALTER TABLE evaluation_nonconformities
  ADD COLUMN corrective_requirement_id INTEGER REFERENCES corrective_requirements(id) ON DELETE RESTRICT;

UPDATE evaluation_nonconformities
SET corrective_requirement_id = (
  SELECT cr.id
  FROM corrective_requirements cr
  WHERE cr.normalized_name = LOWER(TRIM(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      evaluation_nonconformities.remediation_content, '  ', ' '), '  ', ' '), '  ', ' '),
      '  ', ' '), '  ', ' '), '  ', ' ')
  ))
  LIMIT 1
)
WHERE NULLIF(TRIM(COALESCE(remediation_content, '')), '') IS NOT NULL;

CREATE INDEX idx_evaluation_nonconformities_corrective_requirement
  ON evaluation_nonconformities(corrective_requirement_id);
