'use strict';

const { AUDIT_CATEGORIES } = require('../audit/eventCatalog');

const AUDIT_SEVERITIES = Object.freeze(['INFO', 'WARN', 'HIGH', 'CRITICAL']);
const AUDIT_OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE', 'DENIED', 'DEGRADED']);
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

class AuditQueryError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuditQueryError';
    this.code = code;
    this.status = status;
  }
}

function boundedText(value, name, maxLength = 320) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\r\n\u2028\u2029]/.test(text)) {
    throw new AuditQueryError(`audit_filter_${name}_invalid`);
  }
  return text;
}

function isoTime(value, name) {
  if (value == null || value === '') return null;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new AuditQueryError(`audit_filter_${name}_invalid`);
  return parsed.toISOString();
}

function positiveInteger(value, name, fallback, maximum) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new AuditQueryError(`audit_${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AuditQueryError(`audit_${name}_invalid`);
  }
  return parsed;
}

function encodeAuditCursor(row) {
  return Buffer.from(JSON.stringify({ v: 1, occurred_at: row.occurred_at, id: Number(row.id) }))
    .toString('base64url');
}

function decodeAuditCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const occurredAt = isoTime(parsed.occurred_at, 'cursor');
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.id) || parsed.id < 1 || !occurredAt) throw new Error('invalid');
    return { occurred_at: occurredAt, id: parsed.id };
  } catch {
    throw new AuditQueryError('audit_cursor_invalid');
  }
}

function exactChoice(value, name, choices, normalize = (item) => item) {
  const text = boundedText(value, name, 128);
  if (!text) return null;
  const normalized = normalize(text);
  if (!choices.includes(normalized)) throw new AuditQueryError(`audit_filter_${name}_invalid`);
  return normalized;
}

function normalizeAuditFilters(query = {}, options = {}) {
  const from = isoTime(query.from, 'from');
  const to = isoTime(query.to, 'to');
  if (from && to && from > to) throw new AuditQueryError('audit_filter_time_range_invalid');
  const exportMode = options.exportMode === true;
  const maxRows = options.maxRows || 10000;
  const filters = {
    from,
    to,
    category: exactChoice(query.category, 'category', AUDIT_CATEGORIES, (value) => value.toLowerCase()),
    event: boundedText(query.event || query.event_name, 'event', 128),
    severity: exactChoice(query.severity, 'severity', AUDIT_SEVERITIES, (value) => value.toUpperCase()),
    actor: boundedText(query.actor || query.actor_user_id, 'actor', 320)?.toLowerCase() || null,
    entity: boundedText(query.entity || query.entity_id, 'entity', 320),
    entity_type: boundedText(query.entity_type, 'entity_type', 64)?.toUpperCase() || null,
    outcome: exactChoice(query.outcome, 'outcome', AUDIT_OUTCOMES, (value) => value.toUpperCase()),
    request: boundedText(query.request || query.request_id, 'request', 128),
    correlation: boundedText(query.correlation || query.correlation_id, 'correlation', 128),
    uat: boundedText(query.uat || query.uat_run_id, 'uat', 128),
  };
  if (exportMode) {
    filters.limit = positiveInteger(query.row_limit || query.limit, 'row_limit', maxRows, maxRows);
  } else {
    filters.limit = positiveInteger(query.limit, 'limit', LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
    filters.cursor = decodeAuditCursor(query.cursor);
  }
  return filters;
}

module.exports = {
  AUDIT_OUTCOMES,
  AUDIT_SEVERITIES,
  AuditQueryError,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  decodeAuditCursor,
  encodeAuditCursor,
  isoTime,
  normalizeAuditFilters,
};
