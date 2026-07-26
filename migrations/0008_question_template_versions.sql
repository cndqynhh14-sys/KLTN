-- RUN-14: expand question templates into immutable versions and pin evaluation tickets.
CREATE TABLE question_template_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id    INTEGER NOT NULL,
  version_no     INTEGER NOT NULL CHECK (version_no > 0),
  status         TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED')),
  version_note   TEXT,
  effective_from TEXT,
  effective_to   TEXT,
  checksum       TEXT CHECK (checksum IS NULL OR length(checksum) = 64),
  lock_version   INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_by     TEXT,
  updated_at     TEXT,
  updated_by     TEXT,
  submitted_at   TEXT,
  submitted_by   TEXT,
  published_at   TEXT,
  published_by   TEXT,
  retired_at     TEXT,
  retired_by     TEXT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  UNIQUE (template_id, version_no),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)
);
CREATE INDEX idx_question_template_versions_template_status
  ON question_template_versions(template_id, status, version_no DESC);

CREATE TABLE question_template_variants (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_template_version_id INTEGER NOT NULL,
  facility_type                TEXT NOT NULL,
  supplier_scale               TEXT NOT NULL CHECK (supplier_scale IN ('LARGE', 'SMALL', 'ALL')),
  source_sheet                 TEXT,
  active                       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE CASCADE,
  UNIQUE (question_template_version_id, facility_type, supplier_scale)
);
CREATE INDEX idx_question_template_variants_scope
  ON question_template_variants(question_template_version_id, facility_type, supplier_scale, active);

CREATE TABLE question_items (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_template_version_id INTEGER NOT NULL,
  legacy_question_id           INTEGER,
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
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (legacy_question_id) REFERENCES evaluation_questions(id) ON DELETE RESTRICT,
  UNIQUE (question_template_version_id, facility_type, supplier_scale, question_code),
  UNIQUE (question_template_version_id, legacy_question_id)
);
CREATE INDEX idx_question_items_version_scope
  ON question_items(question_template_version_id, facility_type, supplier_scale, active, order_index);
CREATE INDEX idx_question_items_legacy
  ON question_items(legacy_question_id, question_template_version_id);

CREATE TABLE question_template_assignments (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id                  INTEGER NOT NULL,
  question_template_version_id INTEGER NOT NULL,
  facility_type                TEXT NOT NULL,
  supplier_scale               TEXT NOT NULL CHECK (supplier_scale IN ('LARGE', 'SMALL', 'ALL')),
  effective_from               TEXT,
  effective_to                 TEXT,
  is_default                   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  active                       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by                   TEXT,
  updated_at                   TEXT,
  updated_by                   TEXT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE RESTRICT,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  UNIQUE (question_template_version_id, facility_type, supplier_scale)
);
CREATE UNIQUE INDEX idx_question_template_assignments_one_default
  ON question_template_assignments(template_id, facility_type, supplier_scale)
  WHERE active = 1 AND is_default = 1;
CREATE INDEX idx_question_template_assignments_resolve
  ON question_template_assignments(template_id, facility_type, supplier_scale, active, is_default);

CREATE TRIGGER question_assignments_default_requires_published_insert
BEFORE INSERT ON question_template_assignments
WHEN NEW.active = 1 AND NEW.is_default = 1 AND (
  (SELECT status FROM question_template_versions WHERE id = NEW.question_template_version_id) != 'PUBLISHED'
  OR (SELECT template_id FROM question_template_versions WHERE id = NEW.question_template_version_id) != NEW.template_id
)
BEGIN
  SELECT RAISE(ABORT, 'default_question_version_must_be_published');
END;
CREATE TRIGGER question_assignments_default_requires_published_update
BEFORE UPDATE ON question_template_assignments
WHEN NEW.active = 1 AND NEW.is_default = 1 AND (
  (SELECT status FROM question_template_versions WHERE id = NEW.question_template_version_id) != 'PUBLISHED'
  OR (SELECT template_id FROM question_template_versions WHERE id = NEW.question_template_version_id) != NEW.template_id
)
BEGIN
  SELECT RAISE(ABORT, 'default_question_version_must_be_published');
END;

CREATE TABLE question_template_version_events (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  question_template_version_id INTEGER NOT NULL,
  action                       TEXT NOT NULL,
  actor_user_id                TEXT,
  before_json                  TEXT,
  after_json                   TEXT,
  request_id                   TEXT,
  correlation_id               TEXT,
  created_at                   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (question_template_version_id) REFERENCES question_template_versions(id) ON DELETE RESTRICT
);
CREATE INDEX idx_question_version_events_version_time
  ON question_template_version_events(question_template_version_id, created_at, id);

CREATE TABLE question_version_reconciliations (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_id               TEXT NOT NULL,
  source_template_count      INTEGER NOT NULL,
  source_question_count      INTEGER NOT NULL,
  versioned_template_count   INTEGER NOT NULL,
  versioned_item_count       INTEGER NOT NULL,
  pinned_ticket_count        INTEGER NOT NULL,
  orphan_ticket_count        INTEGER NOT NULL,
  orphan_answer_count        INTEGER NOT NULL,
  unexpected_duplicate_count INTEGER NOT NULL,
  source_hash                TEXT NOT NULL,
  versioned_hash             TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN ('PENDING_HASH', 'CLEAN', 'FAILED')),
  created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE evaluation_tickets
  ADD COLUMN question_template_version_id INTEGER REFERENCES question_template_versions(id) ON DELETE RESTRICT;
CREATE INDEX idx_evaluation_tickets_question_version
  ON evaluation_tickets(question_template_version_id);

-- Upgrade databases already contain the current BM catalog here. Fresh databases are
-- populated by the compatibility adapter after the DOC-3 import, using the same service.
INSERT INTO question_template_versions (
  template_id, version_no, status, version_note, effective_from, checksum,
  created_at, updated_at, submitted_at, published_at
)
SELECT id, 1, 'PUBLISHED', 'RUN-14 legacy migration', '1970-01-01',
       '0000000000000000000000000000000000000000000000000000000000000000',
       COALESCE(created_at, datetime('now')), COALESCE(updated_at, datetime('now')),
       datetime('now'), datetime('now')
FROM question_templates;

INSERT INTO question_template_variants (
  question_template_version_id, facility_type, supplier_scale, active
)
SELECT v.id, q.facility_type, q.supplier_scale,
       MAX(CASE WHEN q.active = 1 THEN 1 ELSE 0 END)
FROM evaluation_questions q
JOIN question_template_versions v ON v.template_id = q.template_id AND v.version_no = 1
GROUP BY v.id, q.facility_type, q.supplier_scale;

INSERT INTO question_items (
  question_template_version_id, legacy_question_id, facility_type, supplier_scale,
  question_code, question_text, category, is_elimination_clause, is_critical_clause,
  requires_attachment, allowed_scores, weight, order_index, active, created_at
)
SELECT v.id, q.id, q.facility_type, q.supplier_scale,
       q.question_code, q.question_text, q.category, q.is_elimination_clause,
       q.is_critical_clause, q.requires_attachment, q.allowed_scores, q.weight,
       q.order_index, q.active, q.created_at
FROM evaluation_questions q
JOIN question_template_versions v ON v.template_id = q.template_id AND v.version_no = 1;

INSERT INTO question_template_assignments (
  template_id, question_template_version_id, facility_type, supplier_scale,
  effective_from, effective_to, is_default, active, created_by
)
SELECT v.template_id, v.id, x.facility_type, x.supplier_scale,
       '1970-01-01', NULL, 1, 1, 'RUN-14 migration'
FROM question_template_versions v
JOIN (
  SELECT DISTINCT template_id, facility_type, supplier_scale
  FROM evaluation_questions
  WHERE active = 1
) x ON x.template_id = v.template_id
WHERE v.version_no = 1;

UPDATE evaluation_tickets
SET question_template_version_id = (
  SELECT v.id
  FROM question_template_versions v
  WHERE v.template_id = evaluation_tickets.template_id AND v.version_no = 1
)
WHERE question_template_version_id IS NULL;

INSERT INTO question_template_version_events (
  question_template_version_id, action, actor_user_id, after_json
)
SELECT id, 'MIGRATED_PUBLISHED_V1', NULL,
       json_object('template_id', template_id, 'version_no', version_no, 'status', status)
FROM question_template_versions
WHERE version_no = 1;

INSERT INTO question_version_reconciliations (
  migration_id, source_template_count, source_question_count,
  versioned_template_count, versioned_item_count, pinned_ticket_count,
  orphan_ticket_count, orphan_answer_count, unexpected_duplicate_count,
  source_hash, versioned_hash, status
)
SELECT
  '0008_question_template_versions',
  (SELECT COUNT(*) FROM question_templates),
  (SELECT COUNT(*) FROM evaluation_questions),
  (SELECT COUNT(*) FROM question_template_versions WHERE version_no = 1),
  (SELECT COUNT(*) FROM question_items qi JOIN question_template_versions v ON v.id = qi.question_template_version_id WHERE v.version_no = 1),
  (SELECT COUNT(*) FROM evaluation_tickets WHERE question_template_version_id IS NOT NULL),
  (SELECT COUNT(*) FROM evaluation_tickets WHERE question_template_version_id IS NULL),
  (SELECT COUNT(*) FROM evaluation_answers a LEFT JOIN evaluation_questions q ON q.id = a.question_id WHERE q.id IS NULL),
  (SELECT COUNT(*) FROM (
    SELECT question_template_version_id, facility_type, supplier_scale, question_code
    FROM question_items
    GROUP BY question_template_version_id, facility_type, supplier_scale, question_code
    HAVING COUNT(*) > 1
  )),
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000000',
  'PENDING_HASH';

-- One compatibility view gives legacy consumers a ticket-scoped question record.
-- Pinned tickets always resolve through immutable question_items; only unpinned synthetic
-- or pre-migration fixtures fall back to evaluation_questions.
CREATE VIEW pinned_evaluation_questions AS
SELECT
  t.id AS ticket_id,
  qi.legacy_question_id AS id,
  qi.id AS version_item_id,
  v.template_id,
  qt.template_code,
  qi.facility_type,
  qi.supplier_scale,
  qi.question_code,
  qi.question_text,
  qi.category,
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
JOIN question_items qi ON qi.question_template_version_id = v.id
UNION ALL
SELECT
  t.id AS ticket_id,
  q.id,
  NULL AS version_item_id,
  q.template_id,
  qt.template_code,
  q.facility_type,
  q.supplier_scale,
  q.question_code,
  q.question_text,
  q.category,
  q.is_elimination_clause,
  q.is_critical_clause,
  q.requires_attachment,
  q.allowed_scores,
  q.weight,
  q.order_index,
  q.active,
  q.created_at,
  q.updated_at
FROM evaluation_tickets t
JOIN question_templates qt ON qt.id = t.template_id
JOIN evaluation_questions q ON q.template_id = t.template_id
WHERE t.question_template_version_id IS NULL;

CREATE TRIGGER question_versions_published_content_immutable
BEFORE UPDATE ON question_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED') AND (
  OLD.template_id IS NOT NEW.template_id OR
  OLD.version_no IS NOT NEW.version_no OR
  OLD.version_note IS NOT NEW.version_note OR
  OLD.effective_from IS NOT NEW.effective_from OR
  OLD.effective_to IS NOT NEW.effective_to OR
  (OLD.checksum IS NOT NEW.checksum AND OLD.checksum != '0000000000000000000000000000000000000000000000000000000000000000')
)
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_versions_published_delete_immutable
BEFORE DELETE ON question_template_versions
WHEN OLD.status IN ('PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_items_published_insert_immutable
BEFORE INSERT ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = NEW.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;
CREATE TRIGGER question_items_published_update_immutable
BEFORE UPDATE ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;
CREATE TRIGGER question_items_published_delete_immutable
BEFORE DELETE ON question_items
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_variants_published_insert_immutable
BEFORE INSERT ON question_template_variants
WHEN (SELECT status FROM question_template_versions WHERE id = NEW.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;
CREATE TRIGGER question_variants_published_update_immutable
BEFORE UPDATE ON question_template_variants
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;
CREATE TRIGGER question_variants_published_delete_immutable
BEFORE DELETE ON question_template_variants
WHEN (SELECT status FROM question_template_versions WHERE id = OLD.question_template_version_id) IN ('IN_REVIEW', 'PUBLISHED', 'RETIRED')
BEGIN
  SELECT RAISE(ABORT, 'published_version_immutable');
END;

CREATE TRIGGER question_version_events_append_only_update
BEFORE UPDATE ON question_template_version_events BEGIN
  SELECT RAISE(ABORT, 'question_version_events_append_only');
END;
CREATE TRIGGER question_version_events_append_only_delete
BEFORE DELETE ON question_template_version_events BEGIN
  SELECT RAISE(ABORT, 'question_version_events_append_only');
END;
