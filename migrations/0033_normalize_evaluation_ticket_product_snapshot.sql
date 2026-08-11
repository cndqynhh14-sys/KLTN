-- RUN-33: product is a per-ticket snapshot, not supplier master data.
ALTER TABLE evaluation_tickets
  RENAME COLUMN product_name TO snapshot_product_name;
