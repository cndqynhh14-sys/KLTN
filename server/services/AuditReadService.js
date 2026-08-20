'use strict';

const { isSensitiveKey, redact, sanitizeString } = require('../observability/redact');
const {
  AuditQueryError,
  encodeAuditCursor,
  isoTime,
  normalizeAuditFilters,
} = require('../domain/auditManagement');

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_FORMATS = new Set(['csv', 'ndjson']);

class AuditReadError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AuditReadError';
    this.code = code;
    this.status = status;
  }
}

function cleanMetadata(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => cleanMetadata(item, seen));
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (String(key).toLowerCase() === 'stack' || isSensitiveKey(key)) continue;
    output[sanitizeString(key, 128)] = cleanMetadata(child, seen);
  }
  return output;
}

function parseSafeJson(value, fallback) {
  if (!value) return fallback;
  try {
    return cleanMetadata(JSON.parse(value));
  } catch {
    return fallback;
  }
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[\t ]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function retentionMap(policies) {
  const map = new Map();
  for (const policy of policies) {
    const categories = parseSafeJson(policy.categories_json, []);
    if (!Array.isArray(categories)) continue;
    for (const category of categories) map.set(category, policy.retention_class);
  }
  return map;
}

class AuditReadService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.maxExportRows = options.maxExportRows || 10000;
    this.maxExportRangeDays = options.maxExportRangeDays || 31;
  }

  _policies() {
    return this.repository.retentionPolicies();
  }

  _publicRow(row, classes = retentionMap(this._policies())) {
    return {
      id: Number(row.id),
      occurred_at: row.occurred_at,
      catalog_version: row.catalog_version,
      category: row.category,
      event_name: row.event_name,
      severity: row.severity,
      actor_user_id: row.actor_user_id,
      actor_principal_id: row.actor_principal_id,
      actor_roles: parseSafeJson(row.actor_roles_json, []),
      request_id: row.request_id,
      correlation_id: row.correlation_id,
      uat_run_id: row.uat_run_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      action: row.action,
      outcome: row.outcome,
      reason_code: row.reason_code,
      summary: sanitizeString(row.summary, 512),
      metadata: redact(parseSafeJson(row.metadata_json, {})),
      retention_class: classes.get(row.category) || 'UNCLASSIFIED',
    };
  }

  list(query = {}) {
    let filters;
    try {
      filters = normalizeAuditFilters(query);
    } catch (error) {
      if (error instanceof AuditQueryError) throw new AuditReadError(error.code, error.status);
      throw error;
    }
    const rows = this.repository.list(filters);
    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, filters.limit) : rows;
    const classes = retentionMap(this._policies());
    return {
      items: page.map((row) => this._publicRow(row, classes)),
      next_cursor: hasMore ? encodeAuditCursor(page.at(-1)) : null,
      limit: filters.limit,
    };
  }

  detail(id) {
    if (!/^\d+$/.test(String(id)) || Number(id) < 1) throw new AuditReadError('audit_event_id_invalid');
    const row = this.repository.getById(Number(id));
    return row ? this._publicRow(row) : null;
  }

  export(query = {}, requestedFormat = 'csv') {
    const format = String(requestedFormat || 'csv').toLowerCase();
    if (!EXPORT_FORMATS.has(format)) throw new AuditReadError('audit_export_format_invalid');
    let filters;
    try {
      filters = normalizeAuditFilters(query, { exportMode: true, maxRows: this.maxExportRows });
    } catch (error) {
      if (error instanceof AuditQueryError) throw new AuditReadError(error.code, error.status);
      throw error;
    }
    if (!filters.from || !filters.to) throw new AuditReadError('audit_export_time_range_required');
    if ((Date.parse(filters.to) - Date.parse(filters.from)) > this.maxExportRangeDays * DAY_MS) {
      throw new AuditReadError('audit_export_time_range_too_large');
    }
    const rows = this.repository.exportRows(filters);
    if (rows.length > filters.limit) throw new AuditReadError('audit_export_row_limit_exceeded', 422);
    const classes = retentionMap(this._policies());
    const items = rows.map((row) => this._publicRow(row, classes));
    if (format === 'ndjson') {
      return {
        format,
        row_count: items.length,
        content_type: 'application/x-ndjson; charset=utf-8',
        extension: 'ndjson',
        content: items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''),
      };
    }
    const fields = [
      'id', 'occurred_at', 'category', 'event_name', 'severity', 'actor_user_id', 'actor_principal_id', 'actor_roles',
      'request_id', 'correlation_id', 'uat_run_id', 'entity_type', 'entity_id', 'action',
      'outcome', 'reason_code', 'summary', 'retention_class', 'metadata',
    ];
    const lines = [fields.map(csvCell).join(',')];
    for (const item of items) {
      lines.push(fields.map((field) => csvCell(
        typeof item[field] === 'object' ? JSON.stringify(item[field]) : item[field]
      )).join(','));
    }
    return {
      format,
      row_count: items.length,
      content_type: 'text/csv; charset=utf-8',
      extension: 'csv',
      content: `\uFEFF${lines.join('\r\n')}\r\n`,
    };
  }

  retentionDryRun(query = {}) {
    let asOf;
    try {
      asOf = isoTime(query.as_of || new Date().toISOString(), 'as_of');
    } catch (error) {
      throw new AuditReadError(error.code || 'audit_filter_as_of_invalid');
    }
    const policies = this._policies();
    const classes = policies.map((policy) => {
      const categories = parseSafeJson(policy.categories_json, []);
      const cutoff = new Date(Date.parse(asOf) - Number(policy.retention_days) * DAY_MS).toISOString();
      return {
        retention_class: policy.retention_class,
        categories,
        retention_days: Number(policy.retention_days),
        cutoff,
        eligible_rows: this.repository.countBefore(categories, cutoff),
        purge_approved: Boolean(policy.purge_approved),
        approval_reference: policy.approval_reference,
        config_version: Number(policy.config_version),
        action: 'REPORT_ONLY',
      };
    });
    return {
      mode: 'dry-run',
      as_of: asOf,
      purge_allowed: false,
      approval_reference: 'OBS-01',
      classes,
      total_eligible_rows: classes.reduce((sum, item) => sum + item.eligible_rows, 0),
    };
  }
}

module.exports = {
  AuditReadError,
  AuditReadService,
  cleanMetadata,
};
