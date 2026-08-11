-- RUN-33: evaluation locations belong to the immutable ticket snapshot.
-- Rename only the three approved location fields; workflow, scoring and audit
-- storage remain unchanged.

ALTER TABLE evaluation_tickets
  RENAME COLUMN evaluation_address TO snapshot_evaluation_address;

ALTER TABLE evaluation_tickets
  RENAME COLUMN linked_facility_name TO snapshot_linked_facility_name;

ALTER TABLE evaluation_tickets
  RENAME COLUMN linked_facility_address TO snapshot_linked_facility_address;
