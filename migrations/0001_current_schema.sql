-- Migration 0001: QLCL schema baseline captured from the pre-ledger bootstrap.
-- Fresh installs execute this file transactionally. Existing compatible databases
-- adopt its checksum without replay; older databases use the temporary compatibility
-- adapter before adoption.

-- ===== Auth & audit =====

CREATE TABLE IF NOT EXISTS users (
  email          TEXT PRIMARY KEY,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  role           TEXT NOT NULL DEFAULT 'Chuyên viên',
  is_active      INTEGER NOT NULL DEFAULT 1,
  display_name   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  created_by     TEXT
);

-- Usage-rules acknowledgement — Nghị định 13 compliance, same pattern as CHT.
-- Bump rules_version in server/routes/auth.js when policy text changes materially.
CREATE TABLE IF NOT EXISTS usage_acknowledgements (
  email           TEXT PRIMARY KEY,
  rules_version   INTEGER NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip              TEXT,
  ua              TEXT
);

CREATE TABLE IF NOT EXISTS access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT,
  action      TEXT NOT NULL,
  details     TEXT,
  ip          TEXT,
  ua          TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_log_email_time ON access_log(email, created_at DESC);

-- ===== Data source: Hồ sơ đầu vào NCC =====

-- Raw import rows. One row = one product/supplier record from the uploaded xlsx.
-- status: 'Y' = hồ sơ đạt, 'N' = không đạt (matches source file convention).
CREATE TABLE IF NOT EXISTS ncc_documents (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id          TEXT NOT NULL DEFAULT 'WCM',
  upload_id          INTEGER NOT NULL,
  sap_code           TEXT,           -- Mã NCC
  sku_name           TEXT,           -- Tên sản phẩm
  mch2_name          TEXT,           -- Ngành hàng L2
  mch3_name          TEXT,           -- Ngành hàng L3
  status             TEXT NOT NULL CHECK (status IN ('Y', 'N')),
  person_in_charge   TEXT,           -- Tên nhân sự phụ trách
  report_month       TEXT NOT NULL,  -- YYYY-MM — derived from upload metadata
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ncc_docs_month_status ON ncc_documents(report_month, status);
CREATE INDEX IF NOT EXISTS idx_ncc_docs_mch2 ON ncc_documents(mch2_name);
CREATE INDEX IF NOT EXISTS idx_ncc_docs_pic ON ncc_documents(person_in_charge);

-- ===== Data source: Đánh giá NCC =====

-- Mỗi row = 1 lượt đánh giá NCC trong tháng. Thang điểm A/B/C/D quy đổi về %,
-- trong đó A = đạt, B-C-D = không đạt (tùy quy định, v1 coi B+ = pass). Để đơn
-- giản dashboard, lưu thêm cột `status` đã phân loại.
CREATE TABLE IF NOT EXISTS ncc_evaluations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'WCM',
  upload_id       INTEGER NOT NULL,
  sap_code        TEXT,                    -- Mã NCC
  ncc_name        TEXT,                    -- Tên NCC
  mch2_name       TEXT,                    -- Ngành hàng L2
  score_grade     TEXT,                    -- A / B / C / D
  score_percent   REAL,                    -- 0-1, null nếu không có
  status          TEXT NOT NULL CHECK (status IN ('Y', 'N')),
  violation_flags TEXT,                    -- JSON array: ['legal','quality','traceability','hygiene']
  report_month    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ncc_eval_month_status ON ncc_evaluations(report_month, status);
CREATE INDEX IF NOT EXISTS idx_ncc_eval_mch2 ON ncc_evaluations(mch2_name);

-- ===== Upload audit =====

-- Every xlsx import writes one row here. Allows admin to trace/rollback imports.
-- status: 'ok' | 'failed' | 'partial'. On rollback, delete this row → CASCADE
-- removes the linked ncc_documents rows.
CREATE TABLE IF NOT EXISTS upload_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL,
  source_type    TEXT NOT NULL,        -- 'ncc_documents' for v1; future: 'ncc_evaluations', 'qc_warehouse', ...
  filename       TEXT NOT NULL,
  file_size      INTEGER,
  row_count      INTEGER NOT NULL DEFAULT 0,
  row_rejected   INTEGER NOT NULL DEFAULT 0,
  report_month   TEXT NOT NULL,        -- YYYY-MM the user picked for this import
  status         TEXT NOT NULL,
  notes          TEXT,                 -- error messages if status != 'ok'
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_upload_log_email ON upload_log(email, created_at DESC);

-- ===== Summary tables (aggregate format) =====
-- Format các table summary mirror đúng cấu trúc sheet "4. Mẫu báo cáo tổng quan".
-- Mỗi upload 1 file tổng = populate TOÀN BỘ summary tables cho 1 tháng.
-- UNIQUE(tenant_id, report_month) đảm bảo upload lại cùng tháng sẽ replace (qua
-- DELETE-by-upload trước khi INSERT trong transaction của importer).

CREATE TABLE IF NOT EXISTS monthly_overview (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id                 TEXT NOT NULL DEFAULT 'WCM',
  upload_id                 INTEGER NOT NULL,
  report_month              TEXT NOT NULL,
  ncc_docs_failed           INTEGER, ncc_docs_rate         REAL,
  ncc_eval_failed           INTEGER, ncc_eval_rate         REAL,
  qc_warehouse_failed       INTEGER, qc_warehouse_rate     REAL,
  lab_tests_failed          INTEGER, lab_tests_rate        REAL,
  kph_incidents_total       INTEGER,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_monthly_overview_month ON monthly_overview(report_month, tenant_id);

-- Section B — Hồ sơ đầu vào theo ngành hàng + PIC
CREATE TABLE IF NOT EXISTS ncc_documents_summary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL DEFAULT 'WCM',
  upload_id      INTEGER NOT NULL,
  report_month   TEXT NOT NULL,
  mch2_name      TEXT,
  mch3_name      TEXT,
  passed_count   INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  total_count    INTEGER NOT NULL DEFAULT 0,
  pic            TEXT,
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ncc_docs_summary_month ON ncc_documents_summary(report_month, tenant_id);

-- Section C part 1 — Đánh giá NCC theo ngành hàng
CREATE TABLE IF NOT EXISTS ncc_evaluations_summary (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL DEFAULT 'WCM',
  upload_id      INTEGER NOT NULL,
  report_month   TEXT NOT NULL,
  mch2_name      TEXT,
  passed_count   INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  total_count    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ncc_eval_summary_month ON ncc_evaluations_summary(report_month, tenant_id);

-- Section C part 2 — 4 nhóm lỗi vi phạm
CREATE TABLE IF NOT EXISTS ncc_violations_summary (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id        TEXT NOT NULL DEFAULT 'WCM',
  upload_id        INTEGER NOT NULL,
  report_month     TEXT NOT NULL,
  violation_label  TEXT NOT NULL,   -- 'Lỗi vi phạm điều khoản pháp lý', ...
  ncc_count        INTEGER NOT NULL DEFAULT 0,
  rate             REAL,
  notes            TEXT,
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);

-- Section D — Kiểm nghiệm theo nhóm sản phẩm
CREATE TABLE IF NOT EXISTS lab_tests_summary (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'WCM',
  upload_id       INTEGER NOT NULL,
  report_month    TEXT NOT NULL,
  product_group   TEXT,
  total_samples   INTEGER NOT NULL DEFAULT 0,
  passed_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lab_tests_summary_month ON lab_tests_summary(report_month, tenant_id);

-- Section E — Sự cố KPH theo nguồn (khiếu nại / kiểm nghiệm / PMP / bán hàng / truyền thông)
CREATE TABLE IF NOT EXISTS kph_incidents_summary (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             TEXT NOT NULL DEFAULT 'WCM',
  upload_id             INTEGER NOT NULL,
  report_month          TEXT NOT NULL,
  mch2_name             TEXT,
  mch3_name             TEXT,
  source_breakdown      TEXT,         -- JSON: {"khiếu nại": 2, "kiểm nghiệm": 1, ...}
  total_incidents       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kph_summary_month ON kph_incidents_summary(report_month, tenant_id);

-- Section F — QC Kho theo loại hàng (RAU / TCN / NKTT / …)
CREATE TABLE IF NOT EXISTS qc_warehouse_summary (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'WCM',
  upload_id       INTEGER NOT NULL,
  report_month    TEXT NOT NULL,
  product_group   TEXT,
  total_lots      INTEGER NOT NULL DEFAULT 0,
  failed_lots     INTEGER NOT NULL DEFAULT 0,
  fail_rate       REAL,
  discount_rate   REAL,           -- % cấn trừ trung bình
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qc_summary_month ON qc_warehouse_summary(report_month, tenant_id);

-- Section F bottom — Top 10 NCC Local chất lượng kém. Operational priority cao
-- vì mỗi row = 1 NCC cụ thể cần làm việc, không như bảng theo loại hàng (aggregate).
-- v1 schema cố tình bỏ qua; thêm lại 2026-04 sau khi data 4 tháng cho thấy đây là
-- insight quan trọng nhất cho QC team (NCC nào fail-rate cao → yêu cầu khắc phục).
CREATE TABLE IF NOT EXISTS qc_warehouse_top_ncc (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       TEXT NOT NULL DEFAULT 'WCM',
  upload_id       INTEGER NOT NULL,
  report_month    TEXT NOT NULL,
  rank            INTEGER NOT NULL,         -- 1..10 thứ tự xuất hiện trong file
  sap_code        TEXT,                     -- Mã NCC (vd. 2060456)
  ncc_name        TEXT,                     -- Tên NCC (vd. An Minh, WinEco Lạc Dương)
  total_lots      INTEGER NOT NULL DEFAULT 0,
  failed_lots     INTEGER NOT NULL DEFAULT 0,
  fail_rate       REAL,                     -- 0-1
  FOREIGN KEY (upload_id) REFERENCES upload_log(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qc_top_ncc_month ON qc_warehouse_top_ncc(report_month, tenant_id);

-- ===== Threshold config =====

-- Alert thresholds for "không đạt" rates. Hard-coded defaults seeded at startup,
-- admin-editable in v2. metric_key examples: 'ncc_docs.overall', 'ncc_docs.mch2.<name>'.
CREATE TABLE IF NOT EXISTS thresholds (
  metric_key       TEXT PRIMARY KEY,
  red_threshold    REAL NOT NULL,      -- e.g. 0.20  → ≥20% = red
  amber_threshold  REAL NOT NULL,      -- e.g. 0.10  → ≥10% = amber
  updated_by       TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- ===== BRD workflow foundation: Supplier/NCC evaluation =====
-- These tables are additive and intentionally separate from the existing
-- dashboard import/summary tables above. They provide durable storage for the
-- BRD ticket workflow without changing current dashboard behavior.

CREATE TABLE IF NOT EXISTS supplier_import_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name      TEXT NOT NULL,
  uploaded_by    TEXT,
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now')),
  total_rows     INTEGER NOT NULL DEFAULT 0,
  success_rows   INTEGER NOT NULL DEFAULT 0,
  failed_rows    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIAL')),
  error_summary  TEXT,
  FOREIGN KEY (uploaded_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_import_batches_uploaded_at ON supplier_import_batches(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_import_batches_status ON supplier_import_batches(status);

CREATE TABLE IF NOT EXISTS supplier_master (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code   TEXT NOT NULL UNIQUE,
  supplier_name   TEXT NOT NULL,
  tax_code        TEXT,
  address         TEXT,
  production_address TEXT,
  evaluation_address TEXT,
  linked_facility_code TEXT,
  linked_facility_name TEXT,
  linked_facility_address TEXT,
  linked_facility_type TEXT,
  region          TEXT,
  province        TEXT,
  business_type   TEXT,
  cmc_owner       TEXT,
  cmc_head        TEXT,
  business_license_file TEXT,
  attp_certificate_type TEXT,
  attp_certificate_file TEXT,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  mch2            TEXT,
  mch3            TEXT,
  product_group   TEXT,
  product_name    TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  source_type     TEXT NOT NULL CHECK (source_type IN ('EXCEL_UPLOAD', 'MANUAL')),
  import_batch_id INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  FOREIGN KEY (import_batch_id) REFERENCES supplier_import_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_master_code ON supplier_master(supplier_code);
CREATE INDEX IF NOT EXISTS idx_supplier_master_name ON supplier_master(supplier_name);
CREATE INDEX IF NOT EXISTS idx_supplier_master_mch ON supplier_master(mch2, mch3);
CREATE INDEX IF NOT EXISTS idx_supplier_master_status ON supplier_master(status);

CREATE TABLE IF NOT EXISTS supplier_master_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id     INTEGER,
  supplier_code   TEXT NOT NULL,
  actor_user_id   TEXT,
  action          TEXT NOT NULL,
  comment         TEXT,
  field_name      TEXT,
  previous_value  TEXT,
  new_value       TEXT,
  payload_json    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_master_history_code_time ON supplier_master_history(supplier_code, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_master_history_supplier_time ON supplier_master_history(supplier_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS question_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template_code  TEXT NOT NULL UNIQUE,
  template_name  TEXT NOT NULL,
  description    TEXT,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_question_templates_active ON question_templates(active);

CREATE TABLE IF NOT EXISTS evaluation_questions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id           INTEGER NOT NULL,
  facility_type         TEXT NOT NULL,
  supplier_scale        TEXT NOT NULL CHECK (supplier_scale IN ('LARGE', 'SMALL', 'ALL')),
  question_code         TEXT NOT NULL,
  question_text         TEXT NOT NULL,
  category              TEXT NOT NULL,
  is_elimination_clause INTEGER NOT NULL DEFAULT 0 CHECK (is_elimination_clause IN (0, 1)),
  is_critical_clause    INTEGER NOT NULL DEFAULT 0 CHECK (is_critical_clause IN (0, 1)),
  requires_attachment   INTEGER NOT NULL DEFAULT 0 CHECK (requires_attachment IN (0, 1)),
  allowed_scores        TEXT NOT NULL DEFAULT 'A/B/C/D/NA',
  weight                REAL NOT NULL DEFAULT 1,
  order_index           INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE CASCADE,
  UNIQUE (template_id, facility_type, supplier_scale, question_code)
);
CREATE INDEX IF NOT EXISTS idx_eval_questions_template_filter ON evaluation_questions(template_id, facility_type, supplier_scale, active);
CREATE INDEX IF NOT EXISTS idx_eval_questions_category ON evaluation_questions(category);
CREATE INDEX IF NOT EXISTS idx_eval_questions_order ON evaluation_questions(template_id, facility_type, supplier_scale, order_index);

CREATE TABLE IF NOT EXISTS evaluation_tickets (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_code            TEXT NOT NULL UNIQUE,
  supplier_id            INTEGER NOT NULL,
  supplier_code          TEXT,
  supplier_name          TEXT,
  tax_code               TEXT,
  supplier_address       TEXT,
  production_address     TEXT,
  evaluation_address     TEXT,
  linked_facility_code    TEXT,
  linked_facility_name    TEXT,
  linked_facility_address TEXT,
  linked_facility_type    TEXT,
  region                  TEXT,
  province                TEXT,
  business_type           TEXT,
  cmc_owner               TEXT,
  cmc_head                TEXT,
  business_license_file   TEXT,
  attp_certificate_type   TEXT,
  attp_certificate_file   TEXT,
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
  evaluator_name         TEXT,
  qa_lead_id             TEXT,
  qa_support_ids         TEXT,
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
  corrected_grade_code    TEXT,
  corrected_result_label  TEXT,
  correction_date         TEXT,
  next_evaluation_date    TEXT,
  final_conclusion        TEXT,
  specialist_proposal     TEXT,
  supplier_introduction   TEXT,
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
  FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id) REFERENCES question_templates(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_specialist_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (qa_lead_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (deleted_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_tickets_code ON evaluation_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_eval_tickets_status ON evaluation_tickets(current_status);
CREATE INDEX IF NOT EXISTS idx_eval_tickets_specialist ON evaluation_tickets(assigned_specialist_id);
CREATE INDEX IF NOT EXISTS idx_eval_tickets_created_at ON evaluation_tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_tickets_supplier ON evaluation_tickets(supplier_id);

CREATE TABLE IF NOT EXISTS evaluation_rounds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL,
  round_no       INTEGER NOT NULL CHECK (round_no IN (1, 2)),
  source_round_id INTEGER,
  assessment_code TEXT,
  assessment_date TEXT,
  evaluator_id   TEXT,
  status         TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at   TEXT,
  total_score    REAL,
  final_result   TEXT,
  classification TEXT,
  attendees_json TEXT,
  locked_at      TEXT,
  locked_by      TEXT,
  correction_locked INTEGER NOT NULL DEFAULT 0 CHECK (correction_locked IN (0, 1)),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (source_round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (evaluator_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (locked_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (ticket_id, round_no)
);
CREATE INDEX IF NOT EXISTS idx_eval_rounds_ticket_round ON evaluation_rounds(ticket_id, round_no);
CREATE INDEX IF NOT EXISTS idx_eval_rounds_status ON evaluation_rounds(status);

CREATE TABLE IF NOT EXISTS evaluation_answers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id         INTEGER NOT NULL,
  question_id      INTEGER NOT NULL,
  score            TEXT CHECK (score IN ('A', 'B', 'C', 'D', 'NA')),
  comment          TEXT,
  calculated_score REAL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT,
  answered_by      TEXT,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES evaluation_questions(id) ON DELETE RESTRICT,
  FOREIGN KEY (answered_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (round_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_eval_answers_round ON evaluation_answers(round_id);
CREATE INDEX IF NOT EXISTS idx_eval_answers_question ON evaluation_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_eval_answers_score ON evaluation_answers(score);

CREATE TABLE IF NOT EXISTS evaluation_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id    INTEGER,
  ticket_id    INTEGER,
  file_name    TEXT NOT NULL,
  file_path    TEXT,
  storage_key  TEXT,
  mime_type    TEXT,
  size_bytes   INTEGER,
  uploaded_by  TEXT,
  uploaded_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (answer_id) REFERENCES evaluation_answers(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(email) ON DELETE SET NULL,
  CHECK (answer_id IS NOT NULL OR ticket_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_eval_attachments_answer ON evaluation_attachments(answer_id);
CREATE INDEX IF NOT EXISTS idx_eval_attachments_ticket ON evaluation_attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_eval_attachments_uploaded_at ON evaluation_attachments(uploaded_at DESC);

CREATE TABLE IF NOT EXISTS corrective_actions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id              INTEGER NOT NULL,
  round_id               INTEGER NOT NULL,
  issue_description      TEXT NOT NULL,
  required_action        TEXT NOT NULL,
  responsible_party      TEXT,
  due_date               TEXT,
  status                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  evidence_attachment_id INTEGER,
  created_by             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by             TEXT,
  updated_at             TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_attachment_id) REFERENCES evaluation_attachments(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_corrective_actions_ticket ON corrective_actions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_corrective_actions_round ON corrective_actions(round_id);
CREATE INDEX IF NOT EXISTS idx_corrective_actions_status_due ON corrective_actions(status, due_date);

CREATE TABLE IF NOT EXISTS evaluation_nonconformities (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id              INTEGER NOT NULL,
  round_id               INTEGER,
  question_id            INTEGER,
  clause_code            TEXT,
  category               TEXT,
  nonconformity          TEXT NOT NULL,
  remediation            TEXT,
  due_date               TEXT,
  severity               TEXT,
  status                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  corrective_action_id   INTEGER,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by             TEXT,
  updated_at             TEXT,
  updated_by             TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (question_id) REFERENCES evaluation_questions(id) ON DELETE SET NULL,
  FOREIGN KEY (corrective_action_id) REFERENCES corrective_actions(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_ticket ON evaluation_nonconformities(ticket_id);
CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_round ON evaluation_nonconformities(round_id);
CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_status_due ON evaluation_nonconformities(status, due_date);

CREATE TABLE IF NOT EXISTS correction_extensions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL,
  extension_no     INTEGER NOT NULL,
  old_due_date     TEXT,
  new_due_date     TEXT NOT NULL,
  reason           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_correction_extensions_ticket ON correction_extensions(ticket_id, extension_no);

CREATE TABLE IF NOT EXISTS approval_tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id        INTEGER NOT NULL,
  approval_level   TEXT NOT NULL CHECK (approval_level IN ('LEAD', 'TBP', 'GDK')),
  assigned_role    TEXT NOT NULL,
  assigned_user_id TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  comment          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  acted_at         TEXT,
  acted_by         TEXT,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (acted_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_ticket ON approval_tasks(ticket_id);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_level_status ON approval_tasks(approval_level, status);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_assigned_user ON approval_tasks(assigned_user_id, status);

CREATE TABLE IF NOT EXISTS workflow_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id     INTEGER NOT NULL,
  actor_user_id TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  comment       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_history_ticket_time ON workflow_history(ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_history_actor ON workflow_history(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  receiver_user_id   TEXT NOT NULL,
  sender_user_id     TEXT,
  ticket_id          INTEGER,
  notification_type  TEXT NOT NULL CHECK (notification_type IN (
    'REJECTED',
    'APPROVED',
    'REASSESSMENT_DUE',
    'INPUT_DOSSIER_COMPLETED',
    'INPUT_DOSSIER_SUPPLEMENT_REQUESTED',
    'INPUT_DOSSIER_OUT_OF_POLICY_SUBMITTED',
    'INPUT_DOSSIER_CLOSED',
    'INPUT_DOSSIER_APPROVAL_APPROVED',
    'INPUT_DOSSIER_APPROVAL_REJECTED'
  )),
  title              TEXT,
  message            TEXT NOT NULL,
  payload_json       TEXT,
  unique_key         TEXT,
  is_read            INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  read_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (receiver_user_id) REFERENCES users(email) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  UNIQUE (unique_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_receiver_read_time ON notifications(receiver_user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_ticket ON notifications(ticket_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  report_type   TEXT NOT NULL CHECK (report_type IN ('INTERNAL', 'NCC', 'WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT')),
  template_body TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT,
  UNIQUE (template_name, report_type)
);
CREATE INDEX IF NOT EXISTS idx_report_templates_type_active ON report_templates(report_type, active);

CREATE TABLE IF NOT EXISTS report_exports (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id          INTEGER NOT NULL,
  round_id           INTEGER,
  report_template_id INTEGER,
  report_type        TEXT NOT NULL CHECK (report_type IN ('INTERNAL', 'NCC', 'WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT')),
  file_format        TEXT NOT NULL DEFAULT 'PDF',
  export_scope       TEXT NOT NULL DEFAULT 'TICKET',
  file_path          TEXT NOT NULL,
  exported_by        TEXT,
  exported_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
  FOREIGN KEY (report_template_id) REFERENCES report_templates(id) ON DELETE SET NULL,
  FOREIGN KEY (exported_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_report_exports_ticket ON report_exports(ticket_id);
CREATE INDEX IF NOT EXISTS idx_report_exports_type_time ON report_exports(report_type, exported_at DESC);

-- ===== Ho so dau vao NCC workflow foundation =====
-- These tables are additive and intentionally separate from dashboard import
-- rows and the supplier evaluation workflow tables above.

CREATE TABLE IF NOT EXISTS input_dossiers (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_code                TEXT NOT NULL UNIQUE,
  dossier_year                INTEGER,
  dossier_month               INTEGER CHECK (dossier_month IS NULL OR dossier_month BETWEEN 1 AND 12),
  chain                       TEXT,
  cmc_director                TEXT,
  cmc_manager                 TEXT,
  cmc_owner                   TEXT,
  model_id                    TEXT,
  mch1_id                     TEXT,
  mch1_name                   TEXT,
  mch2_id                     TEXT,
  mch2_name                   TEXT,
  mch3_id                     TEXT,
  mch3_name                   TEXT,
  tax_code                    TEXT,
  supplier_code               TEXT,
  supplier_name               TEXT,
  new_supplier_name           TEXT,
  offer_type                  TEXT,
  article_code                TEXT,
  barcode                     TEXT,
  product_name                TEXT,
  shelf_life                  TEXT,
  origin                      TEXT,
  product_dossier_type        TEXT,
  product_dossier_number      TEXT,
  product_dossier_expiry_date TEXT,
  receiving_unit              TEXT,
  supplier_business_type      TEXT,
  production_unit_name        TEXT,
  production_address          TEXT,
  certificate_type            TEXT,
  certificate_field           TEXT,
  certificate_number          TEXT,
  certificate_expiry_date     TEXT,
  received_date               TEXT,
  completed_date              TEXT,
  final_conclusion            TEXT CHECK (final_conclusion IS NULL OR final_conclusion IN ('Y', 'N')),
  qa_owner                    TEXT,
  qa_by_category              TEXT,
  special_project_flag        INTEGER NOT NULL DEFAULT 0 CHECK (special_project_flag IN (0, 1)),
  special_project_name        TEXT,
  current_status              TEXT NOT NULL DEFAULT 'Khoi tao' CHECK (
    current_status IN (
      'Khoi tao',
      'Dang kiem tra',
      'Yeu cau bo sung',
      'Cho duyet ngoai luong',
      'Hoan thanh',
      'Dong',
      'Huy'
    )
  ),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by                  TEXT,
  updated_at                  TEXT,
  updated_by                  TEXT,
  cancelled_at                TEXT,
  cancelled_by                TEXT,
  cancelled_reason            TEXT,
  FOREIGN KEY (qa_owner) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_input_dossiers_status ON input_dossiers(current_status);
CREATE INDEX IF NOT EXISTS idx_input_dossiers_period ON input_dossiers(dossier_year, dossier_month);
CREATE INDEX IF NOT EXISTS idx_input_dossiers_supplier ON input_dossiers(supplier_code, supplier_name);
CREATE INDEX IF NOT EXISTS idx_input_dossiers_product ON input_dossiers(article_code, barcode, product_name);
CREATE INDEX IF NOT EXISTS idx_input_dossiers_qa_owner ON input_dossiers(qa_owner);

CREATE TABLE IF NOT EXISTS input_dossier_items (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id                  INTEGER NOT NULL,
  item_no                     INTEGER NOT NULL DEFAULT 1,
  offer_type                  TEXT,
  article_code                TEXT,
  barcode                     TEXT,
  product_name                TEXT,
  shelf_life                  TEXT,
  origin                      TEXT,
  product_dossier_type        TEXT,
  product_dossier_number      TEXT,
  product_dossier_expiry_date TEXT,
  receiving_unit              TEXT,
  supplier_business_type      TEXT,
  production_unit_name        TEXT,
  production_address          TEXT,
  certificate_type            TEXT,
  certificate_field           TEXT,
  certificate_number          TEXT,
  certificate_expiry_date     TEXT,
  received_date               TEXT,
  completed_date              TEXT,
  final_conclusion            TEXT CHECK (final_conclusion IS NULL OR final_conclusion IN ('Y', 'N')),
  current_status              TEXT NOT NULL DEFAULT 'Khoi tao' CHECK (
    current_status IN (
      'Khoi tao',
      'Dang kiem tra',
      'Yeu cau bo sung',
      'Cho duyet ngoai luong',
      'Hoan thanh',
      'Dong',
      'Huy'
    )
  ),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  created_by                  TEXT,
  updated_at                  TEXT,
  updated_by                  TEXT,
  cancelled_at                TEXT,
  cancelled_by                TEXT,
  cancelled_reason            TEXT,
  FOREIGN KEY (dossier_id) REFERENCES input_dossiers(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (cancelled_by) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (dossier_id, item_no)
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_items_dossier ON input_dossier_items(dossier_id, item_no);
CREATE INDEX IF NOT EXISTS idx_input_dossier_items_status ON input_dossier_items(current_status);
CREATE INDEX IF NOT EXISTS idx_input_dossier_items_product ON input_dossier_items(article_code, barcode, product_name);

CREATE TABLE IF NOT EXISTS input_dossier_reviews (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id            INTEGER NOT NULL,
  dossier_item_id       INTEGER,
  review_number         INTEGER NOT NULL,
  conclusion            TEXT NOT NULL CHECK (conclusion IN ('Y', 'N')),
  note                  TEXT,
  supplement_deadline   TEXT,
  out_of_policy_flag    INTEGER NOT NULL DEFAULT 0 CHECK (out_of_policy_flag IN (0, 1)),
  out_of_policy_reason  TEXT,
  closure_reason        TEXT,
  action_taken          TEXT,
  reviewer_user_id      TEXT,
  reviewed_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dossier_id) REFERENCES input_dossiers(id) ON DELETE CASCADE,
  FOREIGN KEY (dossier_item_id) REFERENCES input_dossier_items(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_user_id) REFERENCES users(email) ON DELETE SET NULL,
  UNIQUE (dossier_item_id, review_number)
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_reviews_dossier ON input_dossier_reviews(dossier_id, review_number);
CREATE INDEX IF NOT EXISTS idx_input_dossier_reviews_item ON input_dossier_reviews(dossier_item_id, review_number);
CREATE INDEX IF NOT EXISTS idx_input_dossier_reviews_reviewer ON input_dossier_reviews(reviewer_user_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS input_dossier_review_errors (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id                     INTEGER NOT NULL,
  elimination_clause_errors     TEXT,
  dossier_errors                TEXT,
  dossier_error_description     TEXT,
  label_errors                  TEXT,
  label_error_description       TEXT,
  quality_error_description     TEXT,
  created_at                    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (review_id) REFERENCES input_dossier_reviews(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_review_errors_review ON input_dossier_review_errors(review_id);

CREATE TABLE IF NOT EXISTS input_dossier_workflow_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id     INTEGER,
  dossier_item_id INTEGER,
  actor_user_id  TEXT,
  actor_role     TEXT,
  action         TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  comment        TEXT,
  payload_json   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (dossier_id) REFERENCES input_dossiers(id) ON DELETE CASCADE,
  FOREIGN KEY (dossier_item_id) REFERENCES input_dossier_items(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_history_dossier_time ON input_dossier_workflow_history(dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_input_dossier_history_item_time ON input_dossier_workflow_history(dossier_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_input_dossier_history_actor ON input_dossier_workflow_history(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS input_dossier_export_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  exported_by     TEXT,
  exported_at     TEXT NOT NULL DEFAULT (datetime('now')),
  filter_payload  TEXT,
  row_count       INTEGER NOT NULL DEFAULT 0,
  file_name       TEXT,
  FOREIGN KEY (exported_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_export_logs_user_time ON input_dossier_export_logs(exported_by, exported_at DESC);

-- Dedicated approval tasks are needed because the existing approval_tasks table
-- is tied to evaluation_tickets through a required foreign key.
CREATE TABLE IF NOT EXISTS input_dossier_approval_tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id        INTEGER NOT NULL,
  dossier_item_id   INTEGER,
  approval_level    TEXT NOT NULL CHECK (approval_level IN ('TBP', 'GDK')),
  assigned_role     TEXT NOT NULL,
  assigned_user_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  comment           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  acted_at          TEXT,
  acted_by          TEXT,
  FOREIGN KEY (dossier_id) REFERENCES input_dossiers(id) ON DELETE CASCADE,
  FOREIGN KEY (dossier_item_id) REFERENCES input_dossier_items(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_user_id) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY (acted_by) REFERENCES users(email) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_approval_tasks_dossier ON input_dossier_approval_tasks(dossier_id);
CREATE INDEX IF NOT EXISTS idx_input_dossier_approval_tasks_item ON input_dossier_approval_tasks(dossier_item_id);
CREATE INDEX IF NOT EXISTS idx_input_dossier_approval_tasks_level_status ON input_dossier_approval_tasks(approval_level, status);

CREATE TABLE IF NOT EXISTS input_dossier_email_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dossier_id        INTEGER NOT NULL,
  event_type        TEXT NOT NULL,
  recipient_email   TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  subject           TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at           TEXT,
  FOREIGN KEY (dossier_id) REFERENCES input_dossiers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_input_dossier_email_logs_dossier ON input_dossier_email_logs(dossier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_input_dossier_email_logs_recipient ON input_dossier_email_logs(recipient_email, created_at DESC);
