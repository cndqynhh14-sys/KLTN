const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { getCriteriaVariantBySheetName } = require('../domain/criteriaVariants');
const { categoryCodeForLabel } = require('../scoring/scoringPolicyEngine');

const DEFAULT_CRITERIA_WORKBOOK = path.resolve(__dirname, '..', '..', 'document', 'Bộ điều khoản đánh giá NCC.xlsx');

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stripVietnameseMarks(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeFacilityType(value) {
  const ascii = stripVietnameseMarks(value).toLowerCase();
  return ascii
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'GENERAL';
}

function parseSheetName(sheetName) {
  const canonical = getCriteriaVariantBySheetName(sheetName);
  if (canonical) {
    return {
      sheet_name: sheetName,
      template_code: canonical.template_code,
      facility_type: canonical.facility_type,
      facility_label: canonical.facility_label,
      supplier_scale: canonical.supplier_scale,
      expected_criterion_count: canonical.expected_criterion_count,
      source_sheet: canonical.source_sheet,
    };
  }

  const name = normalizeText(sheetName);
  const templateMatch = name.match(/\b(BM0[1-4])\b/i);
  if (!templateMatch) return null;

  const templateCode = templateMatch[1].toUpperCase();
  const supplierScale = stripVietnameseMarks(name).toLowerCase().includes('nho') ? 'SMALL' : 'LARGE';
  const withoutTemplate = name.replace(new RegExp(`^\\s*${templateCode}\\s*-?\\s*`, 'i'), '');
  const facilityLabel = withoutTemplate
    .replace(/[-\s]*NCC\s*(lớn|nhỏ)\s*$/i, '')
    .replace(/[-\s]*ncc\s*(lon|nho|lớn|nhỏ)\s*$/i, '')
    .replace(/[-\s]*ncc(lớn|nhỏ|lon|nho)\s*$/i, '')
    .trim() || 'Chung';

  return {
    sheet_name: sheetName,
    template_code: templateCode,
    facility_type: normalizeFacilityType(facilityLabel),
    facility_label: facilityLabel,
    supplier_scale: supplierScale,
  };
}

function cleanQuestionText(value) {
  return normalizeText(value)
    .replace(/\*?\s*Điều khoản loại/gi, '')
    .replace(/\(?\s*Điều khoản chính yếu\s*\)?/gi, '')
    .replace(/\s+([:;,.])/g, '$1')
    .trim();
}

function normalizedHeaderSet(row) {
  return new Set((row || []).map((cell) => stripVietnameseMarks(cell).toLowerCase()));
}

function validateCriteriaSheet(rows, sheetName) {
  const headers = normalizedHeaderSet(rows[0] || []);
  const hasCode = headers.has('tt') || headers.has('stt') || headers.has('ma dieu khoan') || headers.has('clause code');
  const hasCategory = headers.has('hang muc') || headers.has('category');
  const hasQuestion = headers.has('dieu khoan') || headers.has('cau hoi') || headers.has('question');
  const missing = [];
  if (!hasCode) missing.push('TT/Mã điều khoản');
  if (!hasCategory) missing.push('Hạng mục');
  if (!hasQuestion) missing.push('Điều khoản/Câu hỏi');
  if (missing.length) {
    throw Object.assign(
      new Error(`criteria_template_invalid — sheet "${sheetName}" missing required columns: ${missing.join(', ')}`),
      { code: 'criteria_template_invalid', sheet: sheetName, missing_columns: missing }
    );
  }
}

function parseCriteriaWorkbook(input) {
  const workbook = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer', cellDates: false })
    : XLSX.readFile(input);
  const criteria = [];
  const variants = [];
  const errors = [];
  let recognizedSheets = 0;

  workbook.SheetNames.forEach((sheetName) => {
    const variant = parseSheetName(sheetName);
    if (!variant) return;
    recognizedSheets += 1;
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
    validateCriteriaSheet(rows, sheetName);
    let count = 0;
    const seenClauseCodes = new Map();

    rows.slice(1).forEach((row, index) => {
      const clauseCode = normalizeText(row[0]);
      const category = normalizeText(row[1]);
      const rawQuestionText = normalizeText(row[2]);
      if (!rawQuestionText) return;
      if (!clauseCode) {
        errors.push({ sheet_name: sheetName, row: index + 2, error: 'question_code_required' });
        return;
      }
      const isElimination = /Điều khoản loại/i.test(rawQuestionText);
      const isCritical = /Điều khoản chính yếu/i.test(rawQuestionText);
      count += 1;
      const seenCount = (seenClauseCodes.get(clauseCode) || 0) + 1;
      seenClauseCodes.set(clauseCode, seenCount);
      criteria.push({
        ...variant,
        source_row: index + 2,
        question_code: seenCount === 1 ? clauseCode : `${clauseCode}#${seenCount}`,
        question_text: cleanQuestionText(rawQuestionText),
        category: category || 'Chưa phân loại',
        category_code: categoryCodeForLabel(category || 'Chưa phân loại'),
        category_label_snapshot: category || 'Chưa phân loại',
        is_elimination_clause: isElimination ? 1 : 0,
        is_critical_clause: isCritical ? 1 : 0,
        requires_attachment: 0,
        allowed_scores: isElimination ? 'A/D/NA' : 'A/B/C/D/NA',
        weight: 1,
        order_index: count,
        active: 1,
      });
    });

    variants.push({ ...variant, criterion_count: count });
  });

  if (recognizedSheets === 0) {
    throw Object.assign(
      new Error('criteria_sheet_not_found — expected at least one BM01/BM02/BM03/BM04 sheet'),
      { code: 'criteria_sheet_not_found', missing_sheets: ['BM01', 'BM02', 'BM03', 'BM04'] }
    );
  }

  return { criteria, variants, errors };
}

function ensureTemplate(db, templateCode) {
  const existing = db.prepare('SELECT id FROM question_templates WHERE template_code = ?').get(templateCode);
  if (existing) return existing.id;
  const info = db.prepare(`
    INSERT INTO question_templates (template_code, template_name, description, active)
    VALUES (?, ?, ?, 1)
  `).run(templateCode, templateCode, 'Imported DOC-3 criteria');
  return info.lastInsertRowid;
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

function hasQuestionCategoryMetadata(db) {
  return db.prepare('PRAGMA table_info(evaluation_questions)').all()
    .some((column) => column.name === 'category_code');
}

function recordScoringCategoryReconciliation(db, questionId, item) {
  // The controlled pre-ledger upgrade imports into RUN-01 before RUN-19 adds
  // reconciliation storage. Category metadata is populated after migration.
  if (!tableExists(db, 'scoring_policy_reconciliations')) return;
  const status = item.category_code ? 'CLEAN' : 'UNMAPPED';
  const updated = db.prepare(`
    UPDATE scoring_policy_reconciliations SET
      category_label_snapshot=?, category_code=?, status=?, created_at=datetime('now')
    WHERE migration_id='RUN-19-RUNTIME' AND source_type='EVALUATION_QUESTION' AND source_id=?
  `).run(item.category_label_snapshot || item.category, item.category_code || null, status, String(questionId));
  if (updated.changes) return;
  db.prepare(`
    INSERT INTO scoring_policy_reconciliations (
      migration_id, source_type, source_id, category_label_snapshot, category_code, status
    ) VALUES ('RUN-19-RUNTIME', 'EVALUATION_QUESTION', ?, ?, ?, ?)
  `).run(String(questionId), item.category_label_snapshot || item.category, item.category_code || null, status);
}

function importCriteriaWorkbook(db, input = DEFAULT_CRITERIA_WORKBOOK) {
  const parsed = parseCriteriaWorkbook(input);
  const upsert = db.prepare(hasQuestionCategoryMetadata(db) ? `
    INSERT INTO evaluation_questions (
      template_id, facility_type, supplier_scale, question_code, question_text, category,
      category_code, category_label_snapshot,
      is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
      weight, order_index, active, updated_at
    )
    VALUES (
      @template_id, @facility_type, @supplier_scale, @question_code, @question_text, @category,
      @category_code, @category_label_snapshot,
      @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
      @weight, @order_index, @active, datetime('now')
    )
    ON CONFLICT(template_id, facility_type, supplier_scale, question_code) DO UPDATE SET
      question_text = excluded.question_text,
      category = excluded.category,
      category_code = excluded.category_code,
      category_label_snapshot = excluded.category_label_snapshot,
      is_elimination_clause = excluded.is_elimination_clause,
      is_critical_clause = excluded.is_critical_clause,
      requires_attachment = CASE
        WHEN excluded.is_elimination_clause = 1 THEN 0
        ELSE evaluation_questions.requires_attachment
      END,
      allowed_scores = excluded.allowed_scores,
      weight = excluded.weight,
      order_index = excluded.order_index,
      active = 1,
      updated_at = datetime('now')
  ` : `
    INSERT INTO evaluation_questions (
      template_id, facility_type, supplier_scale, question_code, question_text, category,
      is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
      weight, order_index, active, updated_at
    )
    VALUES (
      @template_id, @facility_type, @supplier_scale, @question_code, @question_text, @category,
      @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
      @weight, @order_index, @active, datetime('now')
    )
    ON CONFLICT(template_id, facility_type, supplier_scale, question_code) DO UPDATE SET
      question_text = excluded.question_text,
      category = excluded.category,
      is_elimination_clause = excluded.is_elimination_clause,
      is_critical_clause = excluded.is_critical_clause,
      requires_attachment = CASE
        WHEN excluded.is_elimination_clause = 1 THEN 0
        ELSE evaluation_questions.requires_attachment
      END,
      allowed_scores = excluded.allowed_scores,
      weight = excluded.weight,
      order_index = excluded.order_index,
      active = 1,
      updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    let imported = 0;
    for (const item of parsed.criteria) {
      const templateId = ensureTemplate(db, item.template_code);
      upsert.run({ ...item, template_id: templateId });
      const question = db.prepare(`
        SELECT id FROM evaluation_questions
        WHERE template_id=? AND facility_type=? AND supplier_scale=? AND question_code=?
      `).get(templateId, item.facility_type, item.supplier_scale, item.question_code);
      recordScoringCategoryReconciliation(db, question.id, item);
      imported += 1;
    }
    return imported;
  });

  return { ...parsed, imported: tx() };
}

function inputBuffer(input) {
  return Buffer.isBuffer(input) ? input : fs.readFileSync(input);
}

function verifyCriteriaSeedSource(input, expectedChecksum) {
  if (!expectedChecksum || !/^[a-f0-9]{64}$/i.test(String(expectedChecksum))) {
    return { status: 'degraded', code: 'question_seed_checksum_config_invalid' };
  }
  if (!Buffer.isBuffer(input) && !fs.existsSync(input)) {
    return { status: 'degraded', code: 'question_seed_source_missing', expected_sha256: String(expectedChecksum).toLowerCase() };
  }
  const actual = crypto.createHash('sha256').update(inputBuffer(input)).digest('hex');
  if (actual !== String(expectedChecksum).toLowerCase()) {
    return {
      status: 'degraded',
      code: 'question_seed_checksum_mismatch',
      expected_sha256: String(expectedChecksum).toLowerCase(),
      actual_sha256: actual,
    };
  }
  return { status: 'ready', code: 'question_seed_source_verified', expected_sha256: actual, actual_sha256: actual };
}

function seedCriteriaWorkbook(db, input, { expectedChecksum } = {}) {
  const verified = verifyCriteriaSeedSource(input, expectedChecksum);
  if (verified.status !== 'ready') {
    throw Object.assign(new Error(verified.code), { code: verified.code, readiness: verified });
  }
  const parsed = parseCriteriaWorkbook(inputBuffer(input));
  const insert = db.prepare(hasQuestionCategoryMetadata(db) ? `
    INSERT INTO evaluation_questions (
      template_id, facility_type, supplier_scale, question_code, question_text, category,
      category_code, category_label_snapshot,
      is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
      weight, order_index, active, updated_at
    ) VALUES (
      @template_id, @facility_type, @supplier_scale, @question_code, @question_text, @category,
      @category_code, @category_label_snapshot,
      @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
      @weight, @order_index, @active, datetime('now')
    )
  ` : `
    INSERT INTO evaluation_questions (
      template_id, facility_type, supplier_scale, question_code, question_text, category,
      is_elimination_clause, is_critical_clause, requires_attachment, allowed_scores,
      weight, order_index, active, updated_at
    ) VALUES (
      @template_id, @facility_type, @supplier_scale, @question_code, @question_text, @category,
      @is_elimination_clause, @is_critical_clause, @requires_attachment, @allowed_scores,
      @weight, @order_index, @active, datetime('now')
    )
  `);
  const imported = db.transaction(() => {
    const existing = db.prepare('SELECT COUNT(*) AS n FROM evaluation_questions').get().n;
    if (existing !== 0) throw Object.assign(new Error('criteria_seed_requires_empty_target'), { code: 'criteria_seed_requires_empty_target' });
    let count = 0;
    parsed.criteria.forEach((item) => {
      const info = insert.run({ ...item, template_id: ensureTemplate(db, item.template_code) });
      recordScoringCategoryReconciliation(db, info.lastInsertRowid, item);
      count += 1;
    });
    return count;
  })();
  return { ...parsed, imported, source_sha256: verified.actual_sha256, mode: 'INSERT_ONLY_EMPTY_DATABASE' };
}

module.exports = {
  DEFAULT_CRITERIA_WORKBOOK,
  importCriteriaWorkbook,
  seedCriteriaWorkbook,
  verifyCriteriaSeedSource,
  normalizeFacilityType,
  parseCriteriaWorkbook,
  parseSheetName,
};
