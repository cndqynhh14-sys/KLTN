'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const XLSX = require('xlsx');
const { finiteScore, normalizeSupplierCode } = require('./HistoricalEvaluationImporter');

const COLUMN = Object.freeze({
  STT: 0,
  YEAR: 1,
  MONTH: 2,
  MCH2: 3,
  MCH3: 4,
  CMC_OWNER: 5,
  CMC_HEAD: 6,
  REGION: 7,
  PROVINCE: 8,
  EVALUATION_TYPE: 9,
  BUSINESS_TYPE: 10,
  SUPPLIER_CODE: 11,
  SUPPLIER_NAME: 12,
  SUPPLIER_EVALUATION_ADDRESS: 13,
  LINKED_FACILITY_NAME: 14,
  LINKED_FACILITY_ADDRESS: 15,
  CONTACT_NAME: 16,
  CONTACT_PHONE: 17,
  CONTACT_EMAIL: 18,
  PRODUCT_NAME: 19,
  QA_LEAD: 20,
  QA_SUPPORT: 21,
  EVALUATION_DEPARTMENT: 22,
  ACTUAL_EVALUATION_DATE: 23,
  SCORE_ROUND_1: 24,
  CONCLUSION_ROUND_1: 25,
  LEGAL_GROUP: 26,
  LEGAL_CONTENT: 27,
  QUALITY_GROUP: 28,
  QUALITY_CONTENT: 29,
  TRACEABILITY_GROUP: 30,
  TRACEABILITY_CONTENT: 31,
  HYGIENE_GROUP: 32,
  HYGIENE_CONTENT: 33,
  SCORE_AFTER_CORRECTION: 34,
  CONCLUSION_AFTER_CORRECTION: 35,
  ADJUSTMENT_REASON: 36,
  CORRECTION_DATE: 37,
  NEXT_EVALUATION_DATE: 38,
  FINAL_CONCLUSION: 39,
});

const VIOLATION_PAIRS = Object.freeze([
  [COLUMN.LEGAL_GROUP, COLUMN.LEGAL_CONTENT, 'Lỗi vi phạm điều khoản pháp lý'],
  [COLUMN.QUALITY_GROUP, COLUMN.QUALITY_CONTENT, 'Lỗi kiểm soát chất lượng'],
  [COLUMN.TRACEABILITY_GROUP, COLUMN.TRACEABILITY_CONTENT, 'Lỗi truy xuất nguồn gốc SP'],
  [COLUMN.HYGIENE_GROUP, COLUMN.HYGIENE_CONTENT, 'Lỗi an toàn vệ sinh thực phẩm'],
]);

function text(value) {
  if (value == null) return '';
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function nullableText(value) {
  return text(value) || null;
}

function splitNames(value) {
  return [...new Set(text(value).split(/[\r\n;]+/).map((item) => item.trim()).filter(Boolean))];
}

function datePartsToIso(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function excelDateToIso(value) {
  if (value == null || value === false || text(value) === '') return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return datePartsToIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? datePartsToIso(parsed.y, parsed.m, parsed.d) : null;
  }
  const raw = text(value);
  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return datePartsToIso(match[1], match[2], match[3]);
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    return datePartsToIso(year, match[1], match[2]);
  }
  return null;
}

function sourcePayload(headers, row) {
  return headers.reduce((payload, header, index) => {
    const key = text(header) || `COLUMN_${index + 1}`;
    const value = row[index];
    payload[key] = value instanceof Date ? value.toISOString() : value;
    return payload;
  }, {});
}

function violationsForRow(row) {
  return VIOLATION_PAIRS.map(([groupIndex, contentIndex, fallbackGroup]) => ({
    group: nullableText(row[groupIndex]) || fallbackGroup,
    content: nullableText(row[contentIndex]),
  })).filter((item) => item.content);
}

function parseHistoricalWorksheetRows(rows) {
  const headerIndex = rows.findIndex((row) => text(row?.[0]).toUpperCase() === 'STT');
  if (headerIndex < 0) throw Object.assign(new Error('historical_header_not_found'), { code: 'historical_header_not_found' });
  const headers = rows[headerIndex];
  const sourceRows = rows.slice(headerIndex + 1)
    .map((row, index) => ({ row, sourceRowNumber: headerIndex + index + 2 }))
    .filter(({ row }) => text(row[COLUMN.STT]));
  const invalidRows = [];
  const records = sourceRows.map(({ row, sourceRowNumber }) => {
    const sourceStt = Number(row[COLUMN.STT]);
    const supplierCode = normalizeSupplierCode(row[COLUMN.SUPPLIER_CODE]);
    const supplierName = nullableText(row[COLUMN.SUPPLIER_NAME]);
    if (!Number.isInteger(sourceStt) || sourceStt <= 0 || !supplierCode || !supplierName) {
      invalidRows.push({
        sourceRowNumber,
        sourceStt: Number.isFinite(sourceStt) ? sourceStt : null,
        errors: [
          ...(!Number.isInteger(sourceStt) || sourceStt <= 0 ? ['source_stt_invalid'] : []),
          ...(!supplierCode ? ['supplier_code_required'] : []),
          ...(!supplierName ? ['supplier_name_required'] : []),
        ],
      });
      return null;
    }
    return {
      sourceRowNumber,
      sourceStt,
      year: Number(row[COLUMN.YEAR]) || null,
      month: nullableText(row[COLUMN.MONTH]),
      mch2: nullableText(row[COLUMN.MCH2]),
      mch3: nullableText(row[COLUMN.MCH3]),
      cmcOwner: nullableText(row[COLUMN.CMC_OWNER]),
      cmcHead: nullableText(row[COLUMN.CMC_HEAD]),
      region: nullableText(row[COLUMN.REGION]),
      province: nullableText(row[COLUMN.PROVINCE]),
      evaluationType: nullableText(row[COLUMN.EVALUATION_TYPE]),
      businessType: nullableText(row[COLUMN.BUSINESS_TYPE]),
      supplierCode,
      supplierName,
      supplierEvaluationAddress: nullableText(row[COLUMN.SUPPLIER_EVALUATION_ADDRESS]),
      linkedFacilityName: nullableText(row[COLUMN.LINKED_FACILITY_NAME]),
      linkedFacilityAddress: nullableText(row[COLUMN.LINKED_FACILITY_ADDRESS]),
      contactName: nullableText(row[COLUMN.CONTACT_NAME]),
      contactPhone: nullableText(row[COLUMN.CONTACT_PHONE]),
      contactEmail: nullableText(row[COLUMN.CONTACT_EMAIL]),
      productName: nullableText(row[COLUMN.PRODUCT_NAME]),
      qaLeadNames: splitNames(row[COLUMN.QA_LEAD]),
      qaSupportNames: splitNames(row[COLUMN.QA_SUPPORT]),
      evaluationDepartment: nullableText(row[COLUMN.EVALUATION_DEPARTMENT]),
      actualEvaluationDate: excelDateToIso(row[COLUMN.ACTUAL_EVALUATION_DATE]),
      scoreRound1: finiteScore(row[COLUMN.SCORE_ROUND_1]),
      conclusionRound1: nullableText(row[COLUMN.CONCLUSION_ROUND_1]),
      scoreAfterCorrection: finiteScore(row[COLUMN.SCORE_AFTER_CORRECTION]),
      conclusionAfterCorrection: nullableText(row[COLUMN.CONCLUSION_AFTER_CORRECTION]),
      adjustmentReason: nullableText(row[COLUMN.ADJUSTMENT_REASON]),
      correctionDate: excelDateToIso(row[COLUMN.CORRECTION_DATE]),
      nextEvaluationDate: excelDateToIso(row[COLUMN.NEXT_EVALUATION_DATE]),
      finalConclusion: nullableText(row[COLUMN.FINAL_CONCLUSION]),
      violations: violationsForRow(row),
      sourcePayload: sourcePayload(headers, row),
    };
  }).filter(Boolean);
  return {
    headerRowNumber: headerIndex + 1,
    headers,
    totalSourceRows: sourceRows.length,
    validRows: records.length,
    invalidRows,
    records,
  };
}

function readHistoricalEvaluationWorkbook(filePath) {
  const bytes = fs.readFileSync(filePath);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: false, raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw Object.assign(new Error('historical_sheet_not_found'), { code: 'historical_sheet_not_found' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });
  return {
    ...parseHistoricalWorksheetRows(rows),
    sheetName,
    sourceFileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

module.exports = {
  COLUMN,
  VIOLATION_PAIRS,
  excelDateToIso,
  parseHistoricalWorksheetRows,
  readHistoricalEvaluationWorkbook,
};
