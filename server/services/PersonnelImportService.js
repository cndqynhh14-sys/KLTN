'use strict';

const crypto = require('node:crypto');
const XLSX = require('xlsx');
const {
  LIMITS,
  validateWorkbookSecurity,
} = require('./QuestionImportService');
const {
  AuthorizationAdminError,
  normalizeEmail,
  normalizeReason,
  permissionRisk,
  requiredConfirmation,
  validityWindow,
} = require('./AuthorizationAdminService');
const {
  ROLE_CODES,
  ROLE_CODE_TO_LEGACY,
} = require('../authorization/permissionCatalog');
const {
  CANONICAL_PERSONNEL_HEADERS,
  PERSONNEL_IMPORT_SHEETS,
  XLSX_MIME,
} = require('./personnelImportContract');
const { updateContext } = require('../observability/context');
const {
  buildPersonnelImportWorkbook,
} = require('../../scripts/generate-personnel-import-workbooks');

const BATCH_TTL_MS = 30 * 60 * 1000;
const MAX_BATCHES_PER_ACTOR = 3;
const MAX_EPHEMERAL_BATCHES = 10;
const MAX_PERSONNEL_ROWS = 2000;
const REPLACED_ROLE_SOURCES = new Set(['MANUAL', 'LEGACY_COMPAT']);
const PRESERVED_ROLE_SOURCES = new Set(['IDP', 'MIGRATION']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HEADER_ALIASES = Object.freeze({
  email: ['email', 'e-mail', 'mail', 'user email', 'email nhan su', 'email nhân sự'],
  display_name: ['display_name', 'display name', 'name', 'full name', 'ho ten', 'họ tên', 'ten nhan su', 'tên nhân sự'],
  active: ['active', 'is_active', 'status', 'trang thai', 'trạng thái'],
  role_codes: ['role_codes', 'role codes', 'roles', 'role', 'vai tro', 'vai trò'],
  valid_from: ['valid_from', 'valid from', 'tu ngay', 'từ ngày'],
  valid_until: ['valid_until', 'valid until', 'den ngay', 'đến ngày'],
  scope_type: ['scope_type', 'scope type', 'loai pham vi', 'loại phạm vi'],
  scope_value: ['scope_value', 'scope value', 'gia tri pham vi', 'giá trị phạm vi'],
  scope_effect: ['scope_effect', 'scope effect', 'hieu luc pham vi', 'hiệu lực phạm vi'],
});

const DEPARTMENT_HEADERS = new Set([
  'department', 'department name', 'department_code', 'department code',
  'phong ban', 'phòng ban', 'bo phan', 'bộ phận',
].map(normalizeHeader));

class PersonnelImportError extends Error {
  constructor(code, status = 400, details) {
    super(code);
    this.name = 'PersonnelImportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function clean(value, maxLength = 4000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeHeader(value) {
  return clean(value, 160).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_]+/g, ' ').trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function checksum(value) {
  return `sha256:${sha256(Buffer.isBuffer(value) ? value : canonicalJson(value))}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function difference(left, right) {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

function safeParseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeBoolean(value, defaultValue) {
  if (value == null || clean(value) === '') return defaultValue;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = clean(value).toLowerCase();
  if (['true', '1'].includes(normalized)) return true;
  if (['false', '0'].includes(normalized)) return false;
  throw new PersonnelImportError('active_invalid', 400);
}

function normalizeDate(value, field, endExclusive = false) {
  const raw = clean(value);
  if (!raw) return null;
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
      || calendarProbe.getUTCFullYear() !== year || calendarProbe.getUTCMonth() !== month - 1
      || calendarProbe.getUTCDate() !== day) {
    throw new PersonnelImportError(`invalid_${field}`, 400);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
      throw new PersonnelImportError(`invalid_${field}`, 400);
    }
    if (endExclusive) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new PersonnelImportError(`invalid_${field}`, 400);
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new PersonnelImportError(`invalid_${field}`, 400);
  return date.toISOString();
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const raw = value instanceof Date ? value.toISOString() : String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z` : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function timestampKey(value) {
  const parsed = timestampMs(value);
  return parsed == null ? null : (Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value));
}

function permissionDelta(before, after) {
  const resolvedDeniedPermissions = difference(before.deniedPermissions, after.deniedPermissions);
  return {
    addedPermissions: difference(after.permissions, before.permissions),
    removedPermissions: difference(before.permissions, after.permissions),
    newlyDeniedPermissions: difference(after.deniedPermissions, before.deniedPermissions),
    resolvedDeniedPermissions,
    resolvedDenials: resolvedDeniedPermissions,
    conflicts: after.conflicts,
    permissionSourcesBefore: before.sources,
    permissionSourcesAfter: after.sources,
    resolution: 'DENY_WINS',
  };
}

function publicError(error, field) {
  return { code: error.code || error.message || 'personnel_import_validation_failed', ...(field ? { field } : {}) };
}

function sourceChecksumValue(value) {
  const raw = clean(value);
  return raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
}

function publicBatchSummary(batch) {
  return {
    batchId: batch.batchId,
    status: batch.status,
    sourceChecksum: batch.sourceChecksum,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
  };
}

class PersonnelImportService {
  constructor(db, authorizationAdminService, authorizationService, auditEventService, options = {}) {
    if (!db || !authorizationAdminService || !authorizationService || !auditEventService) {
      throw new TypeError('personnel_import_dependencies_required');
    }
    this.db = db;
    this.authorizationAdmin = authorizationAdminService;
    this.authorizationService = authorizationService;
    this.auditEventService = auditEventService;
    this.clock = options.clock || (() => new Date());
    this.batchTtlMs = options.batchTtlMs || BATCH_TTL_MS;
    this.maxBatchesPerActor = options.maxBatchesPerActor || MAX_BATCHES_PER_ACTOR;
    this.maxEphemeralBatches = options.maxEphemeralBatches || MAX_EPHEMERAL_BATCHES;
    this.batches = new Map();
  }

  templateWorkbook() {
    return buildPersonnelImportWorkbook({ example: false });
  }

  exampleWorkbook() {
    return buildPersonnelImportWorkbook({ example: true });
  }

  _actor(context, explicitActor) {
    const actor = normalizeEmail(explicitActor || context?.actor);
    if (!actor) throw new PersonnelImportError('personnel_import_actor_required', 401);
    return actor;
  }

  _cleanup() {
    const now = this.clock().getTime();
    for (const [batchId, batch] of this.batches) {
      if (new Date(batch.expiresAt).getTime() <= now) this.batches.delete(batchId);
    }
  }

  _getBatch(batchId, actor) {
    this._cleanup();
    const batch = this.batches.get(clean(batchId, 128));
    if (!batch || batch.actor !== actor) throw new PersonnelImportError('personnel_import_batch_not_found', 404);
    return batch;
  }

  _suggestMapping(headers) {
    const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
    return Object.fromEntries(CANONICAL_PERSONNEL_HEADERS.map((canonical) => {
      const aliases = [canonical, ...(HEADER_ALIASES[canonical] || [])].map(normalizeHeader);
      const match = aliases.map((alias) => normalized.get(alias)).find(Boolean) || null;
      return [canonical, match];
    }));
  }

  _sheetRows(workbook) {
    const exact = workbook.SheetNames.find((name) => name === PERSONNEL_IMPORT_SHEETS.data);
    const candidateNames = exact ? [exact] : workbook.SheetNames.filter((name) => name !== PERSONNEL_IMPORT_SHEETS.guide);
    let best = null;
    for (const sheetName of candidateNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
      for (let offset = 0; offset < Math.min(rows.length, 20); offset += 1) {
        const header = (rows[offset] || []).map((value) => clean(value, 160));
        const suggested = this._suggestMapping(header);
        const score = Object.values(suggested).filter(Boolean).length;
        if (!best || score > best.score) best = { sheetName, rows, headerOffset: offset, header, score, suggested };
      }
    }
    if (!best || !best.header.length) throw new PersonnelImportError('personnel_import_header_missing', 422);
    const dataRows = best.rows.slice(best.headerOffset + 1).filter((row) => row.some((value) => clean(value)));
    if (!dataRows.length) throw new PersonnelImportError('personnel_import_rows_required', 422);
    if (dataRows.length > MAX_PERSONNEL_ROWS) throw new PersonnelImportError('personnel_import_row_limit_exceeded', 413);
    if (dataRows.some((row) => row.some((value) => /^[=+\-@]/.test(clean(value))))) {
      throw new PersonnelImportError('workbook_formula_like_cell_forbidden', 400);
    }
    if (new Set(best.header.map(normalizeHeader).filter(Boolean)).size !== best.header.map(normalizeHeader).filter(Boolean).length) {
      throw new PersonnelImportError('personnel_import_duplicate_header', 422);
    }
    return { ...best, dataRows };
  }

  preview({ file, actor: explicitActor, context = {} }) {
    const actor = this._actor(context, explicitActor);
    let secured;
    try {
      secured = validateWorkbookSecurity(file, {
        limits: { ...LIMITS, maxRowsPerSheet: MAX_PERSONNEL_ROWS + 21, maxCellChars: 1000 },
      });
    } catch (error) {
      throw new PersonnelImportError(error.code || 'workbook_parse_failed', error.status || 400, error.details);
    }
    const parsed = this._sheetRows(secured.workbook);
    this._cleanup();
    const actorBatches = [...this.batches.values()].filter((batch) => batch.actor === actor)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (actorBatches.length >= this.maxBatchesPerActor) {
      const removed = actorBatches.shift();
      this.batches.delete(removed.batchId);
    }
    while (this.batches.size >= this.maxEphemeralBatches) {
      const oldest = [...this.batches.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      this.batches.delete(oldest.batchId);
    }
    const now = this.clock();
    const batch = {
      batchId: `pib_${crypto.randomUUID()}`,
      actor,
      status: 'UPLOADED',
      sourceChecksum: checksum(file.buffer),
      filename: clean(file.originalname || 'personnel.xlsx', 180),
      sheetName: parsed.sheetName,
      headers: parsed.header,
      rows: parsed.dataRows.map((row, index) => ({
        rowNumber: parsed.headerOffset + index + 2,
        cells: parsed.header.map((_header, column) => clean(row[column])),
      })),
      suggestedColumnMapping: parsed.suggested,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.batchTtlMs).toISOString(),
      validation: null,
    };
    this.batches.set(batch.batchId, batch);
    this.auditEventService.record({
      eventName: 'personnel.import.previewed',
      actorUserId: actor,
      entityType: 'PERSONNEL_IMPORT_BATCH',
      entityId: batch.batchId,
      action: 'PREVIEW',
      outcome: 'SUCCESS',
      summary: 'Created ephemeral personnel import preview',
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata: {
        batch_id: batch.batchId,
        source_checksum: batch.sourceChecksum,
        row_count: batch.rows.length,
        size_bytes: file.buffer.length,
      },
    });
    return {
      ...publicBatchSummary(batch),
      contractVersion: 1,
      sheetName: batch.sheetName,
      headers: [...batch.headers],
      suggestedColumnMapping: { ...batch.suggestedColumnMapping },
      distinctRoleValues: (() => {
        const roleHeader = batch.suggestedColumnMapping.role_codes;
        const roleIndex = roleHeader ? batch.headers.indexOf(roleHeader) : -1;
        if (roleIndex < 0) return [];
        return uniqueSorted(batch.rows.flatMap((row) => String(row.cells[roleIndex] || '')
          .split(';').map((value) => clean(value, 160)).filter(Boolean))).slice(0, 500);
      })(),
      ignoredColumnSuggestions: batch.headers.filter((header) => DEPARTMENT_HEADERS.has(normalizeHeader(header)))
        .map((sourceHeader) => ({ sourceHeader, target: 'IGNORE', reason: 'unsupported_department' })),
      sampleRows: batch.rows.slice(0, 10).map((row) => ({
        rowNumber: row.rowNumber,
        cells: [...row.cells],
        values: [...row.cells],
      })),
      totalRows: batch.rows.length,
    };
  }

  _mapping(batch, input) {
    const mapping = input?.columnMapping && typeof input.columnMapping === 'object' && !Array.isArray(input.columnMapping)
      ? input.columnMapping : {};
    const ignored = Array.isArray(input?.ignoredColumns) ? input.ignoredColumns.map(clean) : [];
    const known = new Set(batch.headers);
    const normalized = {};
    const used = new Set();
    for (const canonical of CANONICAL_PERSONNEL_HEADERS) {
      const source = mapping[canonical] == null ? null : clean(mapping[canonical], 160);
      if (source && !known.has(source)) throw new PersonnelImportError('column_mapping_header_unknown', 400, { canonical });
      if (source && used.has(source)) throw new PersonnelImportError('column_mapping_header_reused', 400, { source });
      if (source && DEPARTMENT_HEADERS.has(normalizeHeader(source))) {
        throw new PersonnelImportError('department_column_cannot_be_persisted', 400, { source });
      }
      if (source) used.add(source);
      normalized[canonical] = source;
    }
    if (!normalized.email) throw new PersonnelImportError('email_mapping_required', 400);
    for (const header of ignored) {
      if (!known.has(header)) throw new PersonnelImportError('ignored_column_unknown', 400, { header });
      if (used.has(header)) throw new PersonnelImportError('ignored_column_is_mapped', 400, { header });
    }
    const unhandled = batch.headers.filter((header) => !used.has(header) && !ignored.includes(header));
    if (unhandled.length) throw new PersonnelImportError('unhandled_source_columns', 400, { headers: unhandled });
    const indexes = Object.fromEntries(Object.entries(normalized).map(([canonical, source]) => [
      canonical, source == null ? -1 : batch.headers.indexOf(source),
    ]));
    return { mapping: normalized, ignoredColumns: uniqueSorted(ignored), indexes };
  }

  _roleCatalog() {
    const rows = this.db.prepare(`SELECT r.id, r.role_code, r.active, p.permission_code, rp.effect
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions p ON p.permission_code = rp.permission_code AND p.active = 1
      ORDER BY r.role_code, p.permission_code, rp.effect`).all();
    const roles = new Map();
    for (const row of rows) {
      const role = roles.get(row.role_code) || {
        id: row.id, roleCode: row.role_code, active: Boolean(row.active), permissions: [],
      };
      if (row.permission_code) role.permissions.push({ permissionCode: row.permission_code, effect: row.effect });
      roles.set(row.role_code, role);
    }
    return { roles, fingerprint: sha256(canonicalJson(rows)) };
  }

  _roleValueMapping(input, catalog) {
    const value = input?.roleValueMapping || {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new PersonnelImportError('role_value_mapping_invalid', 400);
    }
    const normalized = new Map();
    for (const [source, target] of Object.entries(value)) {
      const sourceValue = clean(source, 160);
      const targetCode = clean(target, 64).toUpperCase();
      if (!sourceValue || !catalog.roles.get(targetCode)?.active) {
        throw new PersonnelImportError('role_value_mapping_invalid', 400, { source: sourceValue });
      }
      normalized.set(sourceValue, targetCode);
    }
    return normalized;
  }

  _currentAccount(email) {
    return this.db.prepare(`SELECT u.email, u.display_name, u.is_active, u.authz_version,
      (SELECT r.role_code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = u.email AND ur.active = 1 AND r.active = 1
         AND r.role_code IN (
           'SYS_ADMIN', 'BLOCK_DIRECTOR_APPROVER', 'DEPARTMENT_HEAD_APPROVER',
           'REGIONAL_LEAD_APPROVER', 'SUPPLIER_USER', 'QLCL_SPECIALIST'
         )
         AND (ur.valid_from IS NULL OR ur.valid_from <= datetime('now'))
         AND (ur.valid_until IS NULL OR ur.valid_until > datetime('now'))
       ORDER BY CASE r.role_code
         WHEN 'SYS_ADMIN' THEN 1 WHEN 'BLOCK_DIRECTOR_APPROVER' THEN 2
         WHEN 'DEPARTMENT_HEAD_APPROVER' THEN 3 WHEN 'REGIONAL_LEAD_APPROVER' THEN 4
         WHEN 'SUPPLIER_USER' THEN 5 WHEN 'QLCL_SPECIALIST' THEN 6 ELSE 99 END
       LIMIT 1) AS primary_role_code
      FROM users u WHERE u.email = ?`).get(email) || null;
  }

  _accountSnapshot(account) {
    if (!account) return null;
    const roles = this.db.prepare(`SELECT r.role_code, ur.active, ur.valid_from, ur.valid_until, ur.source
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? ORDER BY r.role_code, ur.source`).all(account.email);
    const scopes = this.db.prepare(`SELECT r.role_code, usa.scope_type, usa.scope_value, usa.effect,
        usa.active, usa.valid_from, usa.valid_until, usa.source
      FROM user_scope_assignments usa LEFT JOIN roles r ON r.id = usa.role_id
      WHERE usa.user_id = ? ORDER BY usa.scope_type, usa.scope_value, usa.effect, usa.source`).all(account.email);
    return {
      hash: sha256(canonicalJson({ account, roles, scopes })),
      authzVersion: Number(account.authz_version),
      roles,
      scopes,
    };
  }

  _assignment(item) {
    return {
      roleCode: item.role_code || item.roleCode,
      active: item.active !== 0 && item.active !== false,
      validFrom: item.valid_from || item.validFrom || null,
      validUntil: item.valid_until || item.validUntil || null,
      source: item.source || 'MANUAL',
    };
  }

  _currentAssignments(snapshot) {
    return (snapshot?.roles || []).map((row) => this._assignment(row));
  }

  _permissions(assignments, email, account) {
    if (account && !account.is_active) {
      return this.authorizationService.effectivePermissionsForRoleAssignments([], {
        userId: email, authzVersion: Number(account.authz_version || 1),
      });
    }
    return this.authorizationService.effectivePermissionsForRoleAssignments(assignments, {
      userId: email, authzVersion: Number(account?.authz_version || 1),
      now: this.clock().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ''),
    });
  }

  _normalizeRoleCodes(raw, roleMapping, catalog, errors) {
    if (!clean(raw)) return [];
    const codes = [];
    for (const value of String(raw).split(';').map((part) => clean(part, 160)).filter(Boolean)) {
      const direct = value.toUpperCase();
      const roleCode = catalog.roles.has(direct) ? direct : roleMapping.get(value);
      if (!roleCode) {
        errors.push({ code: 'role_value_mapping_required', field: 'role_codes', value: value.slice(0, 80) });
        continue;
      }
      if (!catalog.roles.get(roleCode)?.active) {
        errors.push({ code: 'role_not_found', field: 'role_codes', value: value.slice(0, 80) });
        continue;
      }
      if (codes.includes(roleCode)) errors.push({ code: 'role_code_duplicate', field: 'role_codes', value: roleCode });
      else codes.push(roleCode);
    }
    return codes.sort();
  }

  _normalizeScope(values, email, window, errors) {
    const type = clean(values.scope_type, 64).toUpperCase();
    const value = clean(values.scope_value, 320);
    const effect = clean(values.scope_effect, 16).toUpperCase();
    if (!type && !value && !effect) return null;
    if (!type || !effect) {
      errors.push({ code: 'scope_triplet_incomplete', field: 'scope_type' });
      return null;
    }
    if (type === 'CUSTOM') {
      errors.push({ code: 'custom_scope_not_supported_in_v1', field: 'scope_type' });
      return null;
    }
    if (type === 'GLOBAL' && value) {
      errors.push({ code: 'global_scope_value_forbidden', field: 'scope_value' });
      return null;
    }
    try {
      const normalized = this.authorizationAdmin.normalizeScopeAssignment({
        scopeType: type,
        scopeValue: value || null,
        effect,
        validFrom: window.validFrom,
        validUntil: window.validUntil,
      }, email);
      return { ...normalized, validFrom: window.validFrom, validUntil: window.validUntil };
    } catch (error) {
      errors.push(publicError(error, 'scope_type'));
      return null;
    }
  }

  _normalizeRow(batch, row, mapped, roleMapping, catalog) {
    const value = (field) => mapped.indexes[field] < 0 ? '' : row.cells[mapped.indexes[field]];
    const values = Object.fromEntries(CANONICAL_PERSONNEL_HEADERS.map((field) => [field, value(field)]));
    const errors = [];
    const email = normalizeEmail(values.email);
    if (!email || email.length > 320 || !EMAIL_PATTERN.test(email)) errors.push({ code: 'email_invalid', field: 'email' });
    const displayNameValue = clean(values.display_name);
    if (displayNameValue.length > 160) errors.push({ code: 'display_name_too_long', field: 'display_name' });
    const displayName = displayNameValue || null;
    const activeSpecified = mapped.indexes.active >= 0 && clean(values.active) !== '';
    let active = null;
    try { active = normalizeBoolean(values.active, null); } catch (error) { errors.push(publicError(error, 'active')); }
    let window = { validFrom: null, validUntil: null };
    const validationWarnings = [];
    try {
      const validFrom = normalizeDate(values.valid_from, 'valid_from');
      const validUntil = normalizeDate(values.valid_until, 'valid_until', /^\d{4}-\d{2}-\d{2}$/.test(clean(values.valid_until)));
      // Validate through the authorization domain, but retain RFC 3339 values.
      // Mutation services own the conversion to SQLite timestamps.
      validityWindow(validFrom, validUntil);
      window = { validFrom, validUntil };
      const now = this.clock().getTime();
      if (validFrom && new Date(validFrom).getTime() > now) validationWarnings.push({ code: 'VALIDITY_WINDOW_NOT_STARTED' });
      if (validUntil && new Date(validUntil).getTime() <= now) validationWarnings.push({ code: 'VALIDITY_WINDOW_EXPIRED' });
    } catch (error) {
      errors.push(publicError(error, error.code?.includes('until') ? 'valid_until' : 'valid_from'));
    }
    const rolesSpecified = mapped.indexes.role_codes >= 0 && clean(values.role_codes) !== '';
    const roleCodes = this._normalizeRoleCodes(values.role_codes, roleMapping, catalog, errors);
    if (rolesSpecified && !roleCodes.some((code) => ROLE_CODE_TO_LEGACY[code])) {
      errors.push({ code: 'legacy_projection_role_required', field: 'role_codes' });
    }
    if (!rolesSpecified && !this._currentAccount(email)) errors.push({ code: 'role_codes_required_for_create', field: 'role_codes' });
    const scope = this._normalizeScope(values, email, window, errors);
    const hasScopeInput = ['scope_type', 'scope_value', 'scope_effect'].some((field) => clean(values[field]) !== '');
    if ((clean(values.valid_from) || clean(values.valid_until)) && !rolesSpecified && !hasScopeInput) {
      errors.push({ code: 'validity_target_required', field: 'valid_from' });
    }
    return {
      rowNumber: row.rowNumber,
      email,
      displayName,
      active,
      activeSpecified,
      roleCodes,
      rolesSpecified,
      roleAssignments: roleCodes.map((roleCode) => ({ roleCode, ...window, active: true, source: 'MANUAL' })),
      scope,
      errors,
      validationWarnings,
    };
  }

  _roleStateEqual(before, after) {
    const comparable = (items) => items.map((item) => ({
      roleCode: item.roleCode, active: item.active !== false,
      source: item.source || 'MANUAL',
      validFrom: timestampKey(item.validFrom), validUntil: timestampKey(item.validUntil),
    })).sort((left, right) => left.roleCode.localeCompare(right.roleCode));
    return canonicalJson(comparable(before)) === canonicalJson(comparable(after));
  }

  _scopeStateEqual(scope, snapshot) {
    if (!scope) return true;
    const plannedWindow = validityWindow(scope.validFrom, scope.validUntil);
    return (snapshot?.scopes || []).some((item) => item.source === 'MANUAL' && item.active
      && (item.role_code || null) === (scope.roleCode || null)
      && item.scope_type === scope.scopeType
      && (item.scope_value || null) === (scope.scopeValue || null)
      && item.effect === scope.effect
      && (item.valid_from || null) === plannedWindow.validFrom
      && (item.valid_until || null) === plannedWindow.validUntil);
  }

  _activeSuperAdmins() {
    const now = this.clock().getTime();
    return new Set(this.db.prepare(`SELECT DISTINCT ur.user_id, ur.valid_from, ur.valid_until
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.email = ur.user_id
      WHERE r.role_code = ? AND r.active = 1 AND ur.active = 1 AND u.is_active = 1`).all(ROLE_CODES.SYS_ADMIN)
      .filter((row) => (!row.valid_from || timestampMs(row.valid_from) <= now)
        && (!row.valid_until || timestampMs(row.valid_until) > now))
      .map((row) => row.user_id));
  }

  _applyBatchSafetyGuards(evaluated) {
    const finalAdmins = this._activeSuperAdmins();
    evaluated.filter((row) => row.operation).forEach((row) => {
      if (row.operation.finalActiveSysAdmin) finalAdmins.add(row.operation.email);
      else finalAdmins.delete(row.operation.email);
    });
    if (finalAdmins.size) return;
    const removals = evaluated.filter((row) => row.operation?.hadActiveSysAdmin && !row.operation.finalActiveSysAdmin);
    const targets = removals.length ? removals : evaluated.filter((row) => row.operation).slice(0, 1);
    targets.forEach((row) => {
      row.errors.push({ code: 'last_super_admin_required', field: 'role_codes' });
      row.outcome = 'ERROR';
      row.operation = null;
    });
  }

  _evaluateRow(normalized, actor, catalog) {
    const account = this._currentAccount(normalized.email);
    const desiredActive = normalized.activeSpecified ? normalized.active : (account ? Boolean(account.is_active) : true);
    const snapshot = this._accountSnapshot(account);
    const beforeAssignments = this._currentAssignments(snapshot);
    const desiredAssignments = normalized.rolesSpecified
      ? [
        ...beforeAssignments.filter((assignment) => PRESERVED_ROLE_SOURCES.has(assignment.source)),
        ...normalized.roleAssignments,
      ]
      : beforeAssignments;
    const withoutWindows = (assignments) => assignments.map((assignment) => ({
      ...assignment, validFrom: null, validUntil: null,
    }));
    const afterAccount = account ? { ...account, is_active: desiredActive ? 1 : 0 } : { authz_version: 1, is_active: desiredActive ? 1 : 0 };
    const beforeEffective = this._permissions(beforeAssignments, normalized.email, account);
    const afterEffective = this._permissions(desiredAssignments, normalized.email, afterAccount);
    const beforeScheduled = this._permissions(withoutWindows(beforeAssignments), normalized.email, account);
    const afterScheduled = this._permissions(withoutWindows(desiredAssignments), normalized.email, afterAccount);
    const immediateDelta = permissionDelta(beforeEffective, afterEffective);
    const scheduledDelta = permissionDelta(beforeScheduled, afterScheduled);
    const roleBefore = beforeAssignments.filter((assignment) => REPLACED_ROLE_SOURCES.has(assignment.source));
    if (normalized.rolesSpecified) {
      beforeAssignments.filter((assignment) => PRESERVED_ROLE_SOURCES.has(assignment.source)
        && normalized.roleCodes.includes(assignment.roleCode)).forEach((assignment) => {
        normalized.errors.push({
          code: 'role_source_conflict',
          field: 'role_codes',
          roleCode: assignment.roleCode,
          source: assignment.source,
        });
      });
    }
    const roleChanged = normalized.rolesSpecified && !this._roleStateEqual(roleBefore, normalized.roleAssignments);
    if (normalized.scope) {
      (snapshot?.scopes || []).filter((item) => item.active && item.source !== 'MANUAL'
        && (item.role_code || null) === (normalized.scope.roleCode || null)
        && item.scope_type === normalized.scope.scopeType
        && (item.scope_value || null) === (normalized.scope.scopeValue || null)
        && item.effect === normalized.scope.effect).forEach((item) => {
        normalized.errors.push({
          code: 'scope_source_conflict',
          field: 'scope_type',
          source: item.source,
        });
      });
    }
    const scopeChanged = !this._scopeStateEqual(normalized.scope, snapshot);
    const accountChanged = !account || Boolean(account.is_active) !== desiredActive
      || (normalized.displayName != null && normalized.displayName !== (account.display_name || null));
    const afterRoleCodes = afterScheduled.roleCodes;
    const risks = [];
    if (roleChanged) {
      const touched = uniqueSorted([
        ...beforeAssignments.map((assignment) => assignment.roleCode),
        ...desiredAssignments.map((assignment) => assignment.roleCode),
      ]);
      if (touched.some((roleCode) => catalog.roles.get(roleCode)?.permissions
        .some((permission) => ['high', 'critical'].includes(permissionRisk(permission.permissionCode))))) {
        risks.push('SENSITIVE_ROLE_CHANGE');
      }
      if (beforeScheduled.roleCodes.includes(ROLE_CODES.SYS_ADMIN) !== afterRoleCodes.includes(ROLE_CODES.SYS_ADMIN)) {
        risks.push('SYS_ADMIN_CHANGE');
      }
    }
    if (normalized.scope?.scopeType === 'GLOBAL' && normalized.scope.effect === 'ALLOW') risks.push('GLOBAL_SCOPE_ALLOW');
    const scopeConflicts = normalized.scope ? (snapshot?.scopes || []).filter((item) => item.active
      && item.scope_type === normalized.scope.scopeType
      && (item.scope_value || null) === (normalized.scope.scopeValue || null)
      && item.effect !== normalized.scope.effect).map((item) => ({
      scopeType: item.scope_type,
      scopeValue: item.scope_value || null,
      effects: uniqueSorted([item.effect, normalized.scope.effect]),
      resolution: 'DENY_WINS',
    })) : [];
    if (scopeConflicts.length) risks.push('SCOPE_CONFLICT');
    if (account && Boolean(account.is_active) !== desiredActive) risks.push('ACCOUNT_STATUS_CHANGE');
    if (immediateDelta.removedPermissions.length || scheduledDelta.removedPermissions.length) risks.push('PERMISSION_REMOVAL');
    if (afterEffective.conflicts.length || afterScheduled.conflicts.length) risks.push('DENY_CONFLICT');

    if (normalized.email === actor) {
      if (!desiredActive) normalized.errors.push({ code: 'cannot_disable_self', field: 'active' });
      if (roleChanged || immediateDelta.addedPermissions.length || scheduledDelta.addedPermissions.length
          || normalized.scope?.effect === 'ALLOW'
          || (!beforeScheduled.roleCodes.includes(ROLE_CODES.SYS_ADMIN) && afterRoleCodes.includes(ROLE_CODES.SYS_ADMIN))) {
        normalized.errors.push({ code: 'cannot_self_escalate', field: 'role_codes' });
      }
    }

    const outcome = normalized.errors.length ? 'ERROR'
      : (!account ? 'CREATE' : (roleChanged || scopeChanged || accountChanged ? 'UPDATE' : 'UNCHANGED'));
    const changes = [];
    if (!account) changes.push('account.create');
    else if (accountChanged) changes.push('account.update');
    if (roleChanged) changes.push('roles.replace');
    if (scopeChanged) changes.push('scope.upsert');
    return {
      rowNumber: normalized.rowNumber,
      email: normalized.email,
      outcome,
      errors: normalized.errors,
      warnings: uniqueSorted([
        ...normalized.validationWarnings.map((warning) => warning.code),
        ...risks,
      ]),
      changes,
      riskFlags: uniqueSorted(risks),
      effectiveRightsDelta: {
        ...immediateDelta,
        scopeConflicts,
      },
      scheduledRightsDelta: { ...scheduledDelta, scopeConflicts },
      operation: normalized.errors.length ? null : {
        rowNumber: normalized.rowNumber,
        outcome,
        email: normalized.email,
        displayName: normalized.displayName,
        active: desiredActive,
        rolesSpecified: normalized.rolesSpecified,
        rolesChanged: roleChanged,
        roles: normalized.roleAssignments,
        hadActiveSysAdmin: beforeEffective.roleCodes.includes(ROLE_CODES.SYS_ADMIN),
        finalActiveSysAdmin: afterEffective.roleCodes.includes(ROLE_CODES.SYS_ADMIN),
        scopeChanged,
        scope: normalized.scope ? {
          scopeType: normalized.scope.scopeType,
          scopeValue: normalized.scope.scopeValue,
          effect: normalized.scope.effect,
          validFrom: normalized.scope.validFrom,
          validUntil: normalized.scope.validUntil,
        } : null,
        expectedAccountHash: snapshot?.hash || null,
        expectedAuthzVersion: snapshot?.authzVersion || null,
      },
    };
  }

  validate(batchId, input = {}, context = {}) {
    const actor = this._actor(context);
    const batch = this._getBatch(batchId, actor);
    if (sourceChecksumValue(input.expectedSourceChecksum) !== batch.sourceChecksum) {
      throw new PersonnelImportError('personnel_import_source_checksum_mismatch', 409);
    }
    const mapped = this._mapping(batch, input);
    const catalog = this._roleCatalog();
    const roleMapping = this._roleValueMapping(input, catalog);
    const rows = batch.rows.map((row) => this._normalizeRow(batch, row, mapped, roleMapping, catalog));
    const countsByEmail = new Map();
    rows.forEach((row) => countsByEmail.set(row.email, (countsByEmail.get(row.email) || 0) + 1));
    rows.forEach((row) => {
      if (row.email && countsByEmail.get(row.email) > 1) row.errors.push({ code: 'email_duplicate_in_file', field: 'email' });
    });
    const evaluated = rows.map((row) => this._evaluateRow(row, actor, catalog));
    this._applyBatchSafetyGuards(evaluated);
    const counts = { create: 0, update: 0, unchanged: 0, error: 0 };
    evaluated.forEach((row) => { counts[row.outcome.toLowerCase()] += 1; });
    const operations = evaluated.filter((row) => row.operation).map((row) => row.operation)
      .sort((left, right) => left.email.localeCompare(right.email) || left.rowNumber - right.rowNumber);
    const roleValueMapping = Object.fromEntries([...roleMapping.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const plan = {
      contractVersion: 1,
      sourceChecksum: batch.sourceChecksum,
      roleCatalogFingerprint: catalog.fingerprint,
      actorAuthzVersion: Number(this._currentAccount(actor)?.authz_version || 0),
      mapping: mapped.mapping,
      ignoredColumns: mapped.ignoredColumns,
      roleValueMapping,
      operations,
    };
    const planSha256 = sha256(canonicalJson(plan));
    const batchChecksum = `sha256:${planSha256}`;
    const riskFlags = uniqueSorted(evaluated.flatMap((row) => row.riskFlags));
    const status = counts.error ? 'INVALID' : 'VALIDATED';
    const commitAllowed = status === 'VALIDATED' && counts.create + counts.update > 0;
    const required = riskFlags.length ? requiredConfirmation('COMMIT_PERSONNEL_IMPORT', batch.batchId) : null;
    batch.status = status;
    batch.validation = {
      ...plan,
      planSha256,
      batchChecksum,
      rows: evaluated,
      counts,
      riskFlags,
      requiredConfirmation: required,
      commitAllowed,
      validatedAt: this.clock().toISOString(),
    };
    this.auditEventService.record({
      eventName: 'personnel.import.validated',
      actorUserId: actor,
      entityType: 'PERSONNEL_IMPORT_BATCH',
      entityId: batch.batchId,
      action: 'VALIDATE',
      outcome: 'SUCCESS',
      summary: 'Validated personnel import plan',
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata: {
        batch_id: batch.batchId,
        plan_checksum: batchChecksum,
        row_count: evaluated.length,
        error_count: counts.error,
        risk_flags: riskFlags,
      },
    });
    return {
      ...publicBatchSummary(batch),
      contractVersion: 1,
      batchChecksum,
      counts,
      rows: evaluated.map(({ operation: _operation, ...row }) => row),
      riskFlags,
      requiredConfirmation: required,
      commitAllowed,
    };
  }

  _idempotentResult(actor, batchId, idempotencyKey, requestSha256) {
    let row = this.db.prepare(`SELECT public_id, idempotency_key, request_sha256, summary_json
      FROM personnel_import_batches WHERE actor_user_id = ? AND idempotency_key = ?`).get(actor, idempotencyKey);
    if (!row) {
      row = this.db.prepare(`SELECT public_id, idempotency_key, request_sha256, summary_json
        FROM personnel_import_batches WHERE actor_user_id = ? AND public_id = ?`).get(actor, batchId);
      if (!row) return null;
    }
    if (row.public_id !== batchId || row.idempotency_key !== idempotencyKey || row.request_sha256 !== requestSha256) {
      throw new PersonnelImportError('idempotency_key_conflict', 409);
    }
    // The original commit already owns the canonical audit event. Prevent the
    // request middleware from adding a duplicate event for a safe retry.
    updateContext({ audit_mutation_recorded: true });
    return { ...safeParseJson(row.summary_json, {}), idempotent: true };
  }

  _assertFresh(operation) {
    const account = this._currentAccount(operation.email);
    const snapshot = this._accountSnapshot(account);
    if ((snapshot?.hash || null) !== operation.expectedAccountHash
        || (snapshot?.authzVersion || null) !== operation.expectedAuthzVersion) {
      throw new PersonnelImportError('personnel_import_preview_stale', 409);
    }
  }

  _accountAudit(before, after, context, reason) {
    const changed = !before || before.display_name !== after.display_name || Boolean(before.is_active) !== Boolean(after.is_active)
      || before.primary_role_code !== after.primary_role_code;
    if (!changed) return;
    const eventName = before && before.is_active && !after.is_active
      ? 'user.account.deactivated' : 'user.account.upserted';
    this.auditEventService.record({
      eventName,
      actorUserId: context.actor,
      entityType: 'USER_ACCOUNT',
      entityId: after.email,
      action: before ? 'ACCOUNT_UPDATED' : 'ACCOUNT_CREATED',
      outcome: 'SUCCESS',
      summary: `${before ? 'Updated' : 'Created'} user account through personnel import`,
      requestId: context.requestId,
      correlationId: context.correlationId,
      metadata: {
        target_user_id: after.email,
        role_code: after.primary_role_code,
        reason,
        authz_version: after.authz_version,
      },
      before: before ? { active: Boolean(before.is_active), display_name: before.display_name, role_code: before.primary_role_code } : {},
      after: { active: Boolean(after.is_active), display_name: after.display_name, role_code: after.primary_role_code },
    });
  }

  _applyOperation(operation, context, reason) {
    if (operation.outcome === 'UNCHANGED') return;
    const before = this._currentAccount(operation.email);
    if (!before) {
      this.db.prepare(`INSERT INTO users
        (email, is_active, display_name, created_at, created_by)
        VALUES (?, 1, ?, datetime('now'), ?)`).run(
        operation.email, operation.displayName, context.actor || null
      );
    } else if (!before.is_active && (operation.rolesChanged || (operation.scope && operation.scopeChanged))) {
      this.db.prepare('UPDATE users SET is_active = 1 WHERE email = ?').run(operation.email);
    }

    if (operation.rolesChanged) {
      this.authorizationAdmin.setImportedUserRoles(operation.email, {
        roles: operation.roles,
        reason,
        confirmation: requiredConfirmation('ASSIGN_ROLES', operation.email),
      }, context);
      this.authorizationService.cache.delete(operation.email);
    }
    if (operation.scope && operation.scopeChanged) {
      this.authorizationAdmin.upsertUserScope(operation.email, {
        scope: operation.scope,
        reason,
        confirmation: requiredConfirmation('ASSIGN_SCOPE', operation.email),
      }, context);
    }
    if (operation.displayName != null) {
      this.db.prepare('UPDATE users SET display_name = ? WHERE email = ?').run(operation.displayName, operation.email);
    }
    this.db.prepare('UPDATE users SET is_active = ? WHERE email = ?').run(operation.active ? 1 : 0, operation.email);
    this.authorizationService.cache.delete(operation.email);
    const after = this._currentAccount(operation.email);
    this._accountAudit(before, after, context, reason);
  }

  commit(batchId, input = {}, context = {}) {
    const actor = this._actor(context);
    const idempotencyKey = clean(input.idempotencyKey, 128);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new PersonnelImportError('idempotency_key_required', 400);
    }
    const reason = normalizeReason(input.reason);
    const expectedBatchChecksum = sourceChecksumValue(input.expectedBatchChecksum);
    const requestSha256 = sha256(canonicalJson({ batchId: clean(batchId), expectedBatchChecksum, reason, confirmation: clean(input.confirmation) }));
    const replay = this._idempotentResult(actor, clean(batchId), idempotencyKey, requestSha256);
    if (replay) return replay;

    const batch = this._getBatch(batchId, actor);
    if (batch.status !== 'VALIDATED' || !batch.validation?.commitAllowed) {
      throw new PersonnelImportError('personnel_import_not_committable', 409);
    }
    if (expectedBatchChecksum !== batch.validation.batchChecksum) {
      throw new PersonnelImportError('personnel_import_batch_checksum_mismatch', 409);
    }
    if (batch.validation.requiredConfirmation && input.confirmation !== batch.validation.requiredConfirmation) {
      throw new PersonnelImportError('exact_confirmation_required', 409, {
        expectedConfirmation: batch.validation.requiredConfirmation,
      });
    }

    const execute = this.db.transaction(() => {
      const duplicate = this._idempotentResult(actor, batch.batchId, idempotencyKey, requestSha256);
      if (duplicate) return duplicate;
      if (this._roleCatalog().fingerprint !== batch.validation.roleCatalogFingerprint) {
        throw new PersonnelImportError('personnel_import_preview_stale', 409);
      }
      if (Number(this._currentAccount(actor)?.authz_version || 0) !== batch.validation.actorAuthzVersion) {
        throw new PersonnelImportError('personnel_import_preview_stale', 409);
      }
      batch.validation.operations.forEach((operation) => this._assertFresh(operation));
      const applyPriority = (operation) => {
        if (!operation.hadActiveSysAdmin && operation.finalActiveSysAdmin) return 0;
        if (operation.hadActiveSysAdmin && !operation.finalActiveSysAdmin) return 2;
        return 1;
      };
      [...batch.validation.operations]
        .sort((left, right) => applyPriority(left) - applyPriority(right)
          || left.email.localeCompare(right.email) || left.rowNumber - right.rowNumber)
        .forEach((operation) => this._applyOperation(operation, context, reason));
      const counts = {
        created: batch.validation.counts.create,
        updated: batch.validation.counts.update,
        unchanged: batch.validation.counts.unchanged,
        errors: 0,
      };
      const summary = {
        batchId: batch.batchId,
        status: 'COMMITTED',
        sourceChecksum: batch.sourceChecksum,
        batchChecksum: batch.validation.batchChecksum,
        counts,
        authzVersions: batch.validation.operations.filter((operation) => operation.outcome !== 'UNCHANGED')
          .map((operation) => this._currentAccount(operation.email)?.authz_version).filter(Number.isFinite),
        idempotent: false,
        committedAt: this.clock().toISOString(),
      };
      this.db.prepare(`INSERT INTO personnel_import_batches
        (public_id, actor_user_id, source_sha256, plan_sha256, request_sha256,
         idempotency_key, status, mapping_json, summary_json, diagnostics_json,
         reason, request_id, correlation_id, created_at, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'COMMITTED', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        batch.batchId,
        actor,
        batch.sourceChecksum.replace(/^sha256:/, ''),
        batch.validation.planSha256,
        requestSha256,
        idempotencyKey,
        canonicalJson({
          mapped_columns: Object.keys(batch.validation.mapping).filter((key) => batch.validation.mapping[key]),
          ignored_column_count: batch.validation.ignoredColumns.length,
          explicit_role_mapping_count: Object.keys(batch.validation.roleValueMapping).length,
        }),
        canonicalJson(summary),
        canonicalJson(batch.validation.rows.map((row) => ({ row_number: row.rowNumber, outcome: row.outcome, risk_flags: row.riskFlags }))),
        reason,
        context.requestId || null,
        context.correlationId || context.requestId || null,
        batch.createdAt,
        summary.committedAt
      );
      this.auditEventService.record({
        eventName: 'personnel.import.committed',
        actorUserId: actor,
        entityType: 'PERSONNEL_IMPORT_BATCH',
        entityId: batch.batchId,
        action: 'COMMIT',
        outcome: 'SUCCESS',
        summary: 'Committed validated personnel import batch',
        requestId: context.requestId,
        correlationId: context.correlationId,
        idempotencyKey: `personnel-import:${actor}:${idempotencyKey}`,
        metadata: {
          batch_id: batch.batchId,
          source_checksum: batch.sourceChecksum,
          plan_checksum: batch.validation.batchChecksum,
          counts,
          risk_flags: batch.validation.riskFlags,
          reason,
          authz_version: Math.max(1, ...summary.authzVersions),
        },
      });
      return summary;
    });

    try {
      const result = execute();
      this.batches.delete(batch.batchId);
      return result;
    } catch (error) {
      batch.status = batch.validation ? 'VALIDATED' : batch.status;
      // Nested authorization/account audits were rolled back with the outer
      // transaction. Let the HTTP audit middleware record the failed commit.
      updateContext({ audit_mutation_recorded: false, audit_event_id: null });
      if (error instanceof PersonnelImportError || error instanceof AuthorizationAdminError) throw error;
      if (error?.code === 'SQLITE_CONSTRAINT_TRIGGER' || /last_super_admin_required/.test(error?.message || '')) {
        throw new PersonnelImportError('last_super_admin_required', 409);
      }
      throw error;
    }
  }
}

module.exports = {
  BATCH_TTL_MS,
  CANONICAL_PERSONNEL_HEADERS,
  MAX_PERSONNEL_ROWS,
  MAX_EPHEMERAL_BATCHES,
  PersonnelImportError,
  PersonnelImportService,
  XLSX_MIME,
};
