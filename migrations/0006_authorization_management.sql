-- RUN-10: authorization-management metadata and accountable change reasons.
ALTER TABLE authz_change_log ADD COLUMN reason TEXT;
ALTER TABLE authz_change_log ADD COLUMN authz_version INTEGER;

CREATE INDEX idx_authz_change_object_time
  ON authz_change_log(object_type, object_key, created_at DESC);
