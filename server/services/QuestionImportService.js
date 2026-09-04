'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { resolveUserId } = require('../domain/userIdentity');
const XLSX = require('xlsx');
const { parseCriteriaWorkbook, parseSheetName } = require('./criteriaImporter');
const { QuestionVersionService } = require('./QuestionVersionService');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxSheets: 20,
  maxRowsPerSheet: 5000,
  maxColumnsPerSheet: 32,
  maxCells: 50000,
  maxCellChars: 4000,
  maxSharedStrings: 50000,
  maxSharedStringChars: 4 * 1024 * 1024,
  maxZipEntries: 2000,
  maxZipUncompressedBytes: 64 * 1024 * 1024,
  maxZipEntryBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
});

const CANONICAL_HEADERS = Object.freeze([
  'template_code', 'variant_code', 'facility_type', 'supplier_scale',
  'category_code', 'category_name', 'question_code', 'clause_code',
  'question_text', 'allowed_scores', 'order', 'active',
  'critical', 'elimination', 'requires_evidence',
]);

const IMPORT_COMPARE_FIELDS = Object.freeze([
  'variant_code', 'facility_type', 'supplier_scale', 'category_code', 'category',
  'question_code', 'clause_code', 'question_text', 'allowed_scores',
  'order_index', 'active', 'is_critical_clause', 'is_elimination_clause',
  'requires_attachment',
]);

function importError(code, status = 400, extra = {}) {
  return Object.assign(new Error(code), { code, status, ...extra });
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableKey(item) {
  return `${item.facility_type}|${item.supplier_scale}|${item.question_code}`;
}

function comparable(item) {
  return Object.fromEntries(IMPORT_COMPARE_FIELDS.map((field) => [field, item[field] == null ? null : item[field]]));
}

function safeFilename(value) {
  const basename = path.basename(clean(value) || 'questions.xlsx');
  return basename.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'questions.xlsx';
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw importError('workbook_zip_directory_invalid');
}

function inspectZipMetadata(buffer, limits = LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw importError('workbook_zip_signature_invalid', 415);
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0) throw importError('workbook_multidisk_forbidden');
  if (entryCount < 1 || entryCount > limits.maxZipEntries) throw importError('workbook_zip_entry_limit_exceeded');
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw importError('workbook_zip_directory_invalid');

  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw importError('workbook_zip_directory_invalid');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) throw importError('workbook_zip_directory_invalid');
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    const lower = name.toLowerCase();
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw importError('workbook_zip_path_invalid');
    if (flags & 0x0001) throw importError('workbook_encrypted_forbidden');
    if (/^xl\/externallinks\//i.test(name)) throw importError('workbook_external_link_forbidden');
    if (/^xl\/(?:embeddings|oleobjects|activex)\//i.test(name)) throw importError('workbook_object_forbidden');
    if (lower.includes('vbaproject.bin') || /^xl\/macrosheets\//i.test(name)) throw importError('workbook_macro_forbidden');
    if (uncompressedSize > limits.maxZipEntryBytes) throw importError('workbook_zip_entry_limit_exceeded');
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)) {
      throw importError('workbook_zip_bomb_suspected');
    }
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxZipUncompressedBytes) throw importError('workbook_zip_size_limit_exceeded');
    entries.push({ name, compressed_size: compressedSize, uncompressed_size: uncompressedSize });
    offset = end;
  }
  return { entry_count: entryCount, total_compressed: totalCompressed, total_uncompressed: totalUncompressed, entries };
}

function validateWorkbookSecurity(file, options = {}) {
  const limits = { ...LIMITS, ...(options.limits || {}) };
  if (!file || !Buffer.isBuffer(file.buffer)) throw importError('workbook_file_required');
  if (file.mimetype !== XLSX_MIME) throw importError('workbook_mime_invalid', 415);
  const actualSize = file.buffer.length;
  const configuredMax = Number.parseInt(process.env.QUESTION_IMPORT_MAX_BYTES || '', 10);
  const maxBytes = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : limits.maxBytes;
  if (actualSize < 1 || actualSize > maxBytes) throw importError('workbook_size_limit_exceeded', 413);
  const zip = inspectZipMetadata(file.buffer, limits);
  let workbook;
  try {
    workbook = XLSX.read(file.buffer, {
      type: 'buffer',
      cellDates: false,
      cellFormula: true,
      cellHTML: false,
      cellNF: false,
      bookFiles: true,
      bookVBA: true,
    });
  } catch (error) {
    throw importError('workbook_parse_failed', 422);
  }
  if (workbook.vbaraw) throw importError('workbook_macro_forbidden');
  if (!workbook.SheetNames.length || workbook.SheetNames.length > limits.maxSheets) {
    throw importError('workbook_sheet_limit_exceeded');
  }
  let cellCount = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
    const rowCount = range.e.r - range.s.r + 1;
    const columnCount = range.e.c - range.s.c + 1;
    if (rowCount > limits.maxRowsPerSheet || columnCount > limits.maxColumnsPerSheet) {
      throw importError('workbook_dimension_limit_exceeded');
    }
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      cellCount += 1;
      if (cellCount > limits.maxCells) throw importError('workbook_cell_count_limit_exceeded');
      if (cell.f || cell.F) throw importError('workbook_formula_forbidden');
      if (cell.l) throw importError('workbook_hyperlink_forbidden');
      if (clean(cell.v).length > limits.maxCellChars) throw importError('workbook_cell_limit_exceeded');
    }
  }
  const sharedStrings = Array.isArray(workbook.Strings) ? workbook.Strings : [];
  if (sharedStrings.length > limits.maxSharedStrings) throw importError('workbook_shared_string_limit_exceeded');
  const sharedChars = sharedStrings.reduce((sum, value) => sum + clean(value?.t ?? value).length, 0);
  if (sharedChars > limits.maxSharedStringChars) throw importError('workbook_shared_string_limit_exceeded');
  return { workbook, zip, limits };
}

function parseBoolean(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  const normalized = clean(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'active'].includes(normalized)) return 1;
  if (['0', 'false', 'no', 'n', 'inactive'].includes(normalized)) return 0;
  return null;
}

function normalizeScores(value) {
  const parts = clean(value).toUpperCase().split(/[\/,;|]/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length || new Set(parts).size !== parts.length || parts.some((part) => !['A', 'B', 'C', 'D', 'NA'].includes(part))) return null;
  return parts.join('/');
}

function stableCode(value) {
  const normalized = clean(value).toUpperCase();
  return /^[A-Z0-9][A-Z0-9._#\/-]{0,63}$/.test(normalized) ? normalized : null;
}

function legacyCategoryCode(category) {
  const slug = clean(category).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug ? `LEGACY-${slug}` : `LEGACY-${sha256(clean(category)).slice(0, 12).toUpperCase()}`;
}

function validateCanonicalRows(workbook, templateCode) {
  const sheetName = workbook.SheetNames.find((name) => name.trim().toLowerCase() === 'questions');
  if (!sheetName) throw importError('canonical_questions_sheet_missing', 422);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
  const headers = (rows[0] || []).map((value) => clean(value).toLowerCase());
  const missing = CANONICAL_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw importError('canonical_header_invalid', 422, { missing_columns: missing });
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const records = [];
  const seen = new Set();
  rows.slice(1).forEach((row, offset) => {
    if (!row.some((value) => clean(value))) return;
    const rowNumber = offset + 2;
    const value = (name) => row[index[name]];
    const errors = [];
    const addError = (column, code) => errors.push({ sheet_name: sheetName, row_number: rowNumber, column_name: column, error_code: code });
    const rowTemplate = stableCode(value('template_code'));
    const variantCode = stableCode(value('variant_code'));
    const categoryCode = stableCode(value('category_code'));
    const questionCode = stableCode(value('question_code'));
    const clauseCode = stableCode(value('clause_code'));
    const scale = clean(value('supplier_scale')).toUpperCase();
    const allowedScores = normalizeScores(value('allowed_scores'));
    const orderIndex = Number(value('order'));
    const active = parseBoolean(value('active'));
    const critical = parseBoolean(value('critical'));
    const elimination = parseBoolean(value('elimination'));
    const evidence = parseBoolean(value('requires_evidence'));
    if (!rowTemplate || rowTemplate !== templateCode) addError('template_code', rowTemplate ? 'template_code_mismatch' : 'template_code_invalid');
    if (!variantCode) addError('variant_code', 'variant_code_invalid');
    if (!clean(value('facility_type'))) addError('facility_type', 'facility_type_required');
    if (!['LARGE', 'SMALL', 'ALL'].includes(scale)) addError('supplier_scale', 'supplier_scale_invalid');
    if (!categoryCode) addError('category_code', 'category_code_invalid');
    if (!clean(value('category_name'))) addError('category_name', 'category_name_required');
    if (!questionCode) addError('question_code', 'question_code_invalid');
    if (!clauseCode) addError('clause_code', 'clause_code_invalid');
    if (!clean(value('question_text'))) addError('question_text', 'question_text_required');
    if (!allowedScores) addError('allowed_scores', 'allowed_scores_invalid');
    if (!Number.isInteger(orderIndex) || orderIndex <= 0 || orderIndex > 10000) addError('order', 'order_invalid');
    if (active == null) addError('active', 'active_invalid');
    if (critical == null) addError('critical', 'critical_invalid');
    if (elimination == null) addError('elimination', 'elimination_invalid');
    if (evidence == null) addError('requires_evidence', 'requires_evidence_invalid');
    if (elimination === 1 && allowedScores !== 'A/D/NA') addError('allowed_scores', 'elimination_scores_invalid');

    const item = {
      template_code: rowTemplate,
      variant_code: variantCode,
      facility_type: clean(value('facility_type')).toUpperCase(),
      supplier_scale: scale,
      category_code: categoryCode,
      category: clean(value('category_name')),
      question_code: questionCode,
      clause_code: clauseCode,
      question_text: clean(value('question_text')),
      allowed_scores: allowedScores,
      order_index: orderIndex,
      active,
      is_critical_clause: critical,
      is_elimination_clause: elimination,
      requires_attachment: elimination === 1 ? 0 : evidence,
    };
    const key = stableKey(item);
    if (!errors.length && seen.has(key)) addError('question_code', 'question_item_duplicate');
    if (!errors.length) seen.add(key);
    records.push({ item, stable_key: key, sheet_name: sheetName, row_number: rowNumber, errors });
  });
  if (!records.length) throw importError('question_items_required', 422);
  return records;
}

function validateLegacyRows(buffer, templateCode) {
  const parsed = parseCriteriaWorkbook(buffer);
  const records = parsed.criteria
    .filter((item) => item.template_code === templateCode)
    .map((item, index) => {
      const questionCode = clean(item.question_code).toUpperCase();
      const canonical = {
        ...item,
        template_code: templateCode,
        variant_code: `${templateCode}-${item.facility_type}-${item.supplier_scale}`.slice(0, 64),
        category_code: legacyCategoryCode(item.category),
        question_code: questionCode,
        clause_code: questionCode,
      };
      const errors = [];
      const addError = (column_name, error_code) => errors.push({
        sheet_name: item.sheet_name || item.source_sheet || 'legacy',
        row_number: item.source_row || index + 2,
        column_name,
        error_code,
      });
      if (!stableCode(canonical.variant_code)) addError('variant_code', 'variant_code_invalid');
      if (!clean(canonical.facility_type)) addError('facility_type', 'facility_type_required');
      if (!['LARGE', 'SMALL', 'ALL'].includes(canonical.supplier_scale)) addError('supplier_scale', 'supplier_scale_invalid');
      if (!stableCode(canonical.category_code)) addError('category_code', 'category_code_invalid');
      if (!clean(canonical.category)) addError('category_name', 'category_name_required');
      if (!stableCode(canonical.question_code)) addError('question_code', 'question_code_invalid');
      if (!stableCode(canonical.clause_code)) addError('clause_code', 'clause_code_invalid');
      if (!clean(canonical.question_text)) addError('question_text', 'question_text_required');
      if (!normalizeScores(canonical.allowed_scores)) addError('allowed_scores', 'allowed_scores_invalid');
      if (!Number.isInteger(Number(canonical.order_index)) || Number(canonical.order_index) <= 0 || Number(canonical.order_index) > 10000) addError('order', 'order_invalid');
      return {
        item: canonical,
        stable_key: stableKey(canonical),
        sheet_name: item.sheet_name || item.source_sheet || 'legacy',
        row_number: item.source_row || index + 2,
        errors,
      };
    });
  parsed.errors.forEach((error) => {
    const variant = parseSheetName(error.sheet_name);
    if (variant?.template_code !== templateCode) return;
    records.push({
      item: {
        facility_type: variant.facility_type,
        supplier_scale: variant.supplier_scale,
        question_code: `INVALID-ROW-${error.row}`,
      },
      stable_key: `${variant.facility_type}|${variant.supplier_scale}|INVALID-ROW-${error.row}`,
      sheet_name: error.sheet_name,
      row_number: error.row,
      errors: [{
        sheet_name: error.sheet_name,
        row_number: error.row,
        column_name: null,
        error_code: error.error,
      }],
    });
  });
  if (!records.length) throw importError('legacy_template_not_found', 422);
  const seen = new Set();
  records.forEach((record) => {
    if (seen.has(record.stable_key)) record.errors.push({
      sheet_name: record.sheet_name,
      row_number: record.row_number,
      column_name: 'question_code',
      error_code: 'question_item_duplicate',
    });
    else seen.add(record.stable_key);
  });
  return records;
}

function buildDiff(currentItems, records) {
  const current = new Map(currentItems.map((item) => [stableKey(item), item]));
  const validRecords = records.filter((record) => !record.errors.length);
  const after = new Map(validRecords.map((record) => [record.stable_key, record]));
  const hasInvalid = records.some((record) => record.errors.length);
  const diff = { ADDED: [], CHANGED: [], REMOVED: [], UNCHANGED: [], DUPLICATE: [], INVALID: [] };
  for (const record of records) {
    if (record.errors.length) {
      const type = record.errors.some((error) => error.error_code === 'question_item_duplicate') ? 'DUPLICATE' : 'INVALID';
      diff[type].push({ key: record.stable_key, sheet: record.sheet_name, row: record.row_number, errors: record.errors.map((error) => error.error_code) });
      continue;
    }
    const before = current.get(record.stable_key);
    if (!before) diff.ADDED.push({ key: record.stable_key, after: comparable(record.item), sheet: record.sheet_name, row: record.row_number });
    else if (stableJson(comparable(before)) === stableJson(comparable(record.item))) {
      diff.UNCHANGED.push({ key: record.stable_key, sheet: record.sheet_name, row: record.row_number });
    } else {
      diff.CHANGED.push({ key: record.stable_key, before: comparable(before), after: comparable(record.item), sheet: record.sheet_name, row: record.row_number });
    }
  }
  if (!hasInvalid) {
    for (const [key, before] of current) {
      if (!after.has(key)) diff.REMOVED.push({ key, before: comparable(before) });
    }
  }
  return diff;
}

function publicBatch(row) {
  if (!row) return null;
  const {
    confirmation_token_hash: _token,
    normalized_items_json: _normalized,
    snapshot_items_json: _snapshot,
    ...safe
  } = row;
  return safe;
}

function csvCell(value) {
  let text = clean(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildZipMetadataFixture(entryName, { compressedSize = 0, uncompressedSize = 0 } = {}) {
  const name = Buffer.from(entryName, 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

class QuestionImportService {
  constructor(db, options = {}) {
    this.db = db;
    this.versions = options.versionService || new QuestionVersionService(db);
  }

  getBatchRow(batchId) {
    const numeric = Number(batchId);
    return this.db.prepare('SELECT * FROM question_import_batches WHERE public_id=? OR id=?').get(String(batchId), Number.isFinite(numeric) ? numeric : -1);
  }

  event(batchId, action, actor, metadata = {}, context = {}) {
    this.db.prepare(`
      INSERT INTO question_import_events (batch_id, action, actor_user_id, metadata_json, request_id, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      action,
      actor || null,
      JSON.stringify(metadata),
      context.requestId || null,
      context.correlationId || context.requestId || null
    );
  }

  getBatch(batchId) {
    const row = this.getBatchRow(batchId);
    if (!row) throw importError('import_batch_not_found', 404);
    const rows = this.db.prepare(`
      SELECT sheet_name, row_number, column_name, stable_key, row_status, error_code, item_hash
      FROM question_import_rows WHERE batch_id=? ORDER BY row_number, id
    `).all(row.id);
    const changes = this.db.prepare(`
      SELECT stable_key, change_type, sheet_name, row_number, before_hash, after_hash, before_json, after_json
      FROM question_import_changes WHERE batch_id=? ORDER BY id
    `).all(row.id).map((change) => ({
      ...change,
      before: change.before_json ? JSON.parse(change.before_json) : null,
      after: change.after_json ? JSON.parse(change.after_json) : null,
      before_json: undefined,
      after_json: undefined,
    }));
    const events = this.db.prepare(`
      SELECT action, actor_user_id, metadata_json, request_id, correlation_id, created_at
      FROM question_import_events WHERE batch_id=? ORDER BY id
    `).all(row.id).map((event) => ({ ...event, metadata: JSON.parse(event.metadata_json || '{}'), metadata_json: undefined }));
    return { batch: publicBatch(row), rows, changes, events };
  }

  listBatches({ templateId, versionId, status = '', errorOnly = false } = {}) {
    const where = ['template_id=@template_id', 'target_version_id=@version_id'];
    const params = { template_id: Number(templateId), version_id: Number(versionId) };
    if (clean(status)) { where.push('status=@status'); params.status = clean(status).toUpperCase(); }
    if (errorOnly) where.push('(invalid_rows > 0 OR duplicate_rows > 0)');
    return this.db.prepare(`
      SELECT * FROM question_import_batches
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
    `).all(params).map(publicBatch);
  }

  preview({ templateId, versionId, file, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const version = this.versions.getRow(versionId);
    if (!version || version.template_id !== Number(templateId)) throw importError('question_version_not_found', 404);
    if (version.status !== 'DRAFT') throw importError('question_version_not_draft', 409);
    const templateCode = clean(version.template_code).toUpperCase();
    const { workbook } = validateWorkbookSecurity(file);
    const isCanonical = workbook.SheetNames.some((name) => name.trim().toLowerCase() === 'questions');
    const records = isCanonical
      ? validateCanonicalRows(workbook, templateCode)
      : validateLegacyRows(file.buffer, templateCode);
    const detail = this.versions.get(version.id);
    const diff = buildDiff(detail.items, records);
    const validItems = records.filter((record) => !record.errors.length).map((record) => record.item);
    const invalidRows = records.filter((record) => record.errors.length && !record.errors.some((error) => error.error_code === 'question_item_duplicate')).length;
    const duplicateRows = records.filter((record) => record.errors.some((error) => error.error_code === 'question_item_duplicate')).length;
    const publicId = `qib_${crypto.randomUUID()}`;
    const confirmationToken = crypto.randomBytes(24).toString('base64url');
    const confirmationHash = sha256(`${publicId}:${confirmationToken}`);
    const sourceHash = sha256(file.buffer);
    const snapshot = JSON.stringify(detail.items);
    const status = invalidRows + duplicateRows === 0 ? 'VALID' : 'PREVIEWED';
    const filename = safeFilename(file.originalname);

    const batch = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO question_import_batches (
          public_id, template_id, target_version_id, source_format, original_filename,
          mime_type, file_size, source_sha256, status, total_rows, valid_rows,
          invalid_rows, duplicate_rows, added_count, changed_count, removed_count,
          unchanged_count, confirmation_token_hash, normalized_items_json,
          snapshot_items_json, snapshot_checksum, expected_lock_version,
          created_by, request_id, correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        publicId, version.template_id, version.id, isCanonical ? 'CANONICAL' : 'LEGACY_BM',
        filename, file.mimetype, file.buffer.length, sourceHash, status, records.length,
        validItems.length, invalidRows, duplicateRows, diff.ADDED.length, diff.CHANGED.length,
        diff.REMOVED.length, diff.UNCHANGED.length, confirmationHash, JSON.stringify(validItems),
        snapshot, sha256(snapshot), version.lock_version, actor,
        context.requestId || null, context.correlationId || context.requestId || null
      );
      const batchId = Number(info.lastInsertRowid);
      const insertRow = this.db.prepare(`
        INSERT INTO question_import_rows (
          batch_id, sheet_name, row_number, column_name, stable_key, row_status, error_code, item_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      records.forEach((record) => {
        if (!record.errors.length) {
          insertRow.run(batchId, record.sheet_name, record.row_number, null, record.stable_key, 'VALID', null, sha256(stableJson(comparable(record.item))));
        } else {
          record.errors.forEach((error) => insertRow.run(
            batchId, error.sheet_name, error.row_number, error.column_name, record.stable_key,
            error.error_code === 'question_item_duplicate' ? 'DUPLICATE' : 'INVALID', error.error_code, null
          ));
        }
      });
      const insertChange = this.db.prepare(`
        INSERT INTO question_import_changes (
          batch_id, stable_key, change_type, sheet_name, row_number,
          before_hash, after_hash, before_json, after_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      Object.entries(diff).forEach(([type, changes]) => changes.forEach((change) => {
        const beforeJson = change.before ? stableJson(change.before) : null;
        const afterJson = change.after ? stableJson(change.after) : null;
        insertChange.run(
          batchId, change.key, type, change.sheet || null, change.row || null,
          beforeJson ? sha256(beforeJson) : null, afterJson ? sha256(afterJson) : null,
          beforeJson, afterJson
        );
      }));
      this.event(batchId, 'PREVIEWED', actor, {
        status, source_format: isCanonical ? 'CANONICAL' : 'LEGACY_BM',
        total_rows: records.length, valid_rows: validItems.length,
        invalid_rows: invalidRows, duplicate_rows: duplicateRows,
        added_count: diff.ADDED.length, changed_count: diff.CHANGED.length,
        removed_count: diff.REMOVED.length, unchanged_count: diff.UNCHANGED.length,
      }, context);
      return this.db.prepare('SELECT * FROM question_import_batches WHERE id=?').get(batchId);
    })();
    return { batch: publicBatch(batch), diff, confirmation_token: confirmationToken };
  }

  assertConfirmation(batch, token) {
    const actual = Buffer.from(sha256(`${batch.public_id}:${clean(token)}`), 'hex');
    const expected = Buffer.from(batch.confirmation_token_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw importError('import_confirmation_invalid', 403);
    }
  }

  commit({ batchId, confirmationToken, idempotencyKey, expectedLockVersion, acceptPartial = false, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const initial = this.getBatchRow(batchId);
    if (!initial) throw importError('import_batch_not_found', 404);
    const key = clean(idempotencyKey);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw importError('idempotency_key_required');
    if (initial.status === 'COMMITTED') {
      if (initial.idempotency_key !== key) throw importError('idempotency_key_conflict', 409);
      return { batch: publicBatch(initial), version: this.versions.getRow(initial.target_version_id), idempotent: true };
    }
    if (!['VALID', 'PREVIEWED'].includes(initial.status)) throw importError('import_batch_not_committable', 409);
    if (initial.valid_rows === 0) throw importError('import_batch_not_committable', 409);
    if (initial.status === 'PREVIEWED' && !acceptPartial) throw importError('import_batch_not_committable', 409);
    this.assertConfirmation(initial, confirmationToken);
    if (Number(expectedLockVersion) !== Number(initial.expected_lock_version)) {
      throw importError('question_version_conflict', 409, { current_lock_version: this.versions.getRow(initial.target_version_id)?.lock_version });
    }

    return this.db.transaction(() => {
      const batch = this.getBatchRow(batchId);
      if (batch.status === 'COMMITTED') {
        if (batch.idempotency_key !== key) throw importError('idempotency_key_conflict', 409);
        return { batch: publicBatch(batch), version: this.versions.getRow(batch.target_version_id), idempotent: true };
      }
      const version = this.versions.getRow(batch.target_version_id);
      if (!version || version.status !== 'DRAFT') throw importError('question_version_not_draft', 409);
      if (Number(version.lock_version) !== Number(batch.expected_lock_version)) {
        throw importError('question_version_conflict', 409, { current_lock_version: version.lock_version });
      }
      const imported = JSON.parse(batch.normalized_items_json);
      let items = imported;
      if (batch.status === 'PREVIEWED') {
        const current = JSON.parse(batch.snapshot_items_json);
        const merged = new Map(current.map((item) => [stableKey(item), item]));
        imported.forEach((item) => merged.set(stableKey(item), item));
        items = [...merged.values()];
      }
      const updated = this.versions.updateDraft({
        versionId: version.id,
        expectedLockVersion: version.lock_version,
        items,
        actor,
        context,
      });
      const acceptance = batch.status === 'VALID' ? 'VALID' : 'PARTIAL_ACCEPTED';
      const changed = this.db.prepare(`
        UPDATE question_import_batches
        SET status='COMMITTED', acceptance_status=?, idempotency_key=?,
            committed_lock_version=?, committed_by=?, committed_at=datetime('now')
        WHERE id=? AND status IN ('VALID', 'PREVIEWED')
      `).run(acceptance, key, updated.lock_version, actor, batch.id);
      if (changed.changes !== 1) throw importError('import_batch_conflict', 409);
      this.event(batch.id, 'COMMITTED', actor, {
        acceptance_status: acceptance,
        target_version_id: version.id,
        committed_lock_version: updated.lock_version,
      }, context);
      return { batch: publicBatch(this.getBatchRow(batch.id)), version: updated, idempotent: false };
    })();
  }

  rollback({ batchId, expectedLockVersion, actor = null, context = {} }) {
    actor = resolveUserId(this.db, actor);
    const initial = this.getBatchRow(batchId);
    if (!initial) throw importError('import_batch_not_found', 404);
    if (initial.status === 'ROLLED_BACK') {
      return { batch: publicBatch(initial), version: this.versions.getRow(initial.target_version_id), idempotent: true };
    }
    if (initial.status !== 'COMMITTED') throw importError('import_batch_not_rollbackable', 409);
    if (Number(expectedLockVersion) !== Number(initial.committed_lock_version)) {
      throw importError('question_version_conflict', 409, { current_lock_version: this.versions.getRow(initial.target_version_id)?.lock_version });
    }
    return this.db.transaction(() => {
      const batch = this.getBatchRow(batchId);
      const version = this.versions.getRow(batch.target_version_id);
      if (!version || version.status !== 'DRAFT') throw importError('question_version_not_draft', 409);
      if (Number(version.lock_version) !== Number(batch.committed_lock_version)) {
        throw importError('question_version_conflict', 409, { current_lock_version: version.lock_version });
      }
      const snapshot = JSON.parse(batch.snapshot_items_json);
      if (sha256(batch.snapshot_items_json) !== batch.snapshot_checksum) throw importError('import_snapshot_checksum_mismatch', 409);
      const updated = this.versions.updateDraft({
        versionId: version.id,
        expectedLockVersion: version.lock_version,
        items: snapshot,
        actor,
        context,
      });
      this.db.prepare(`
        UPDATE question_import_batches
        SET status='ROLLED_BACK', rolled_back_by=?, rolled_back_at=datetime('now')
        WHERE id=? AND status='COMMITTED'
      `).run(actor, batch.id);
      this.event(batch.id, 'ROLLED_BACK', actor, {
        target_version_id: version.id,
        restored_lock_version: updated.lock_version,
      }, context);
      return { batch: publicBatch(this.getBatchRow(batch.id)), version: updated, idempotent: false };
    })();
  }

  exportErrors(batchId, format = 'csv') {
    const batch = this.getBatchRow(batchId);
    if (!batch) throw importError('import_batch_not_found', 404);
    const rows = this.db.prepare(`
      SELECT sheet_name AS sheet, row_number AS row, column_name AS column, error_code AS code
      FROM question_import_rows
      WHERE batch_id=? AND row_status IN ('INVALID', 'DUPLICATE')
      ORDER BY row_number, id
    `).all(batch.id);
    const safeName = `question-import-errors-${batch.public_id}`;
    if (format === 'xlsx') {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: ['sheet', 'row', 'column', 'code'] }), 'Errors');
      return {
        body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }),
        contentType: XLSX_MIME,
        filename: `${safeName}.xlsx`,
      };
    }
    if (format !== 'csv') throw importError('error_export_format_invalid');
    const lines = ['sheet,row,column,code', ...rows.map((row) => [row.sheet, row.row, row.column, row.code].map(csvCell).join(','))];
    return { body: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `${safeName}.csv` };
  }
}

module.exports = {
  CANONICAL_HEADERS,
  LIMITS,
  XLSX_MIME,
  QuestionImportService,
  buildZipMetadataFixture,
  inspectZipMetadata,
  validateWorkbookSecurity,
};
