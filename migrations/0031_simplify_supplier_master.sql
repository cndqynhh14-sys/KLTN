-- migrate: foreign_keys=off
-- RUN-32: supplier_code is the normalized business key and supplier_master
-- retains only supplier-owned business fields plus technical metadata.

CREATE TABLE supplier_master_run32 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_code   TEXT NOT NULL UNIQUE,
  supplier_name   TEXT NOT NULL,
  tax_code        TEXT,
  address         TEXT,
  region          TEXT,
  province        TEXT,
  business_type   TEXT,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
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

INSERT INTO supplier_master_run32 (
  id, supplier_code, supplier_name, tax_code, address,
  region, province, business_type, status,
  contact_name, contact_email, contact_phone,
  source_type, import_batch_id,
  created_at, created_by, updated_at, updated_by
)
SELECT
  id, UPPER(TRIM(supplier_code)), supplier_name, tax_code, address,
  region, province, business_type, status,
  contact_name, contact_email, contact_phone,
  source_type, import_batch_id,
  created_at, created_by, updated_at, updated_by
FROM supplier_master;

DROP TABLE supplier_master;
ALTER TABLE supplier_master_run32 RENAME TO supplier_master;

CREATE UNIQUE INDEX ux_supplier_master_code_normalized
  ON supplier_master (UPPER(TRIM(supplier_code)));
CREATE INDEX idx_supplier_master_code ON supplier_master(supplier_code);
CREATE INDEX idx_supplier_master_name ON supplier_master(supplier_name);
CREATE INDEX idx_supplier_master_status ON supplier_master(status);
CREATE INDEX idx_supplier_master_region ON supplier_master(region, province);
