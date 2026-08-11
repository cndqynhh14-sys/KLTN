const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { APP_ROOT } = require('../config/paths');

const DETAIL_SHEET_NAME = 'file chi tiet kq danh gia';
const HEADER_ROW_INDEX = 2;
const DATA_START_ROW_INDEX = 3;
const DETAIL_LAST_COLUMN_INDEX = 43; // AR

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function coalesceText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function isValidISODate(value) {
  const m = cleanText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function parseISODate(value) {
  const text = cleanText(value).slice(0, 10);
  if (!isValidISODate(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dateParts(value) {
  const date = parseISODate(value);
  if (!date) return { year: '', month: '' };
  return {
    year: date.getFullYear(),
    month: `Tháng ${String(date.getMonth() + 1).padStart(2, '0')}`,
  };
}

function toExcelDate(value) {
  return parseISODate(value) || '';
}

function toExcelPercent(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return number > 1 ? number / 100 : number;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(cleanText).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function qaSupportLabel(value) {
  const parsed = parseJsonArray(value);
  return parsed.length ? parsed.join(', ') : cleanText(value);
}

function currentDateFilePrefix(date = new Date()) {
  return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function defaultTemplatePath() {
  if (process.env.EVALUATION_SUMMARY_TEMPLATE_PATH) {
    return path.resolve(process.env.EVALUATION_SUMMARY_TEMPLATE_PATH);
  }
  const templateDir = path.join(APP_ROOT, 'Template');
  if (fs.existsSync(templateDir)) {
    const match = fs.readdirSync(templateDir)
      .find((name) => name.startsWith('04.06_BC') && name.toLowerCase().endsWith('.xlsx'));
    if (match) return path.join(templateDir, match);
  }
  return path.join(templateDir, '04.06_BC danh gia nha cung cap.xlsx');
}

function exportFileName(date = new Date()) {
  return `${currentDateFilePrefix(date)}_Báo cáo đánh giá NCC.xlsx`;
}

function contentDisposition(fileName) {
  const fallback = fileName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]+/g, '');
  return `attachment; filename="${fallback.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function buildWhere(filters = {}, scope = null) {
  const where = ['COALESCE(t.is_deleted, 0) = 0'];
  const params = {};
  if (scope?.where) {
    where.push(`(${scope.where})`);
    Object.assign(params, scope.params || {});
  }
  const q = cleanText(filters.q || filters.search);
  if (q) {
    params.q = `%${q.toLowerCase()}%`;
    where.push(`(
      lower(COALESCE(NULLIF(TRIM(t.ticket_code), ''), '')) LIKE @q
      OR lower(COALESCE(NULLIF(TRIM(t.supplier_code), ''), NULLIF(TRIM(sm.supplier_code), ''), '')) LIKE @q
      OR lower(COALESCE(NULLIF(TRIM(t.supplier_name), ''), NULLIF(TRIM(sm.supplier_name), ''), '')) LIKE @q
    )`);
  }

  const filterMap = {
    type: ['evaluation_type', 't.evaluation_type'],
    evaluation_type: ['evaluation_type', 't.evaluation_type'],
    status: ['status', 't.current_status'],
    current_status: ['status', 't.current_status'],
    mch2: ['mch2', "NULLIF(TRIM(t.mch2), '')"],
    mch3: ['mch3', "NULLIF(TRIM(t.mch3), '')"],
  };
  Object.entries(filterMap).forEach(([inputKey, [paramKey, columnSql]]) => {
    const value = cleanText(filters[inputKey]);
    if (!value || Object.prototype.hasOwnProperty.call(params, paramKey)) return;
    params[paramKey] = value;
    where.push(`${columnSql} = @${paramKey}`);
  });

  const dateField = cleanText(filters.dateType || filters.date_type || 'created_at');
  const dateSql = dateField === 'planned_at' || dateField === 'planned_date'
    ? 'date(t.planned_date)'
    : 'date(t.created_at)';
  const from = cleanText(filters.from || filters.date_from);
  const to = cleanText(filters.to || filters.date_to);
  if (isValidISODate(from)) {
    params.from = from;
    where.push(`${dateSql} >= date(@from)`);
  }
  if (isValidISODate(to)) {
    params.to = to;
    where.push(`${dateSql} <= date(@to)`);
  }

  const reassessment = cleanText(filters.reassessment);
  if (reassessment === 'due' || reassessment === 'overdue') {
    where.push(`
      t.current_status = 'Chờ khắc phục'
      AND (
        SELECT MAX(date(nc_due.due_date))
        FROM evaluation_nonconformities nc_due
        WHERE nc_due.ticket_id = t.id
          AND NULLIF(TRIM(COALESCE(nc_due.due_date, '')), '') IS NOT NULL
          AND nc_due.severity IN ('B', 'C', 'D')
          AND nc_due.status != 'CANCELLED'
      ) ${reassessment === 'overdue' ? '<' : '<='} date('now', 'localtime')
    `);
  }

  return { whereSql: where.join(' AND '), params };
}

function orderBySql(sort = {}) {
  const orderMap = {
    code: 't.ticket_code',
    ticket_code: 't.ticket_code',
    supplier_name: "COALESCE(NULLIF(TRIM(t.supplier_name), ''), NULLIF(TRIM(sm.supplier_name), ''))",
    created_at: 'date(t.created_at)',
    planned_at: 'date(t.planned_date)',
    status: 't.current_status',
    result: 'COALESCE(t.corrected_score_percent, t.score_percent, -1)',
  };
  const field = cleanText(sort.field);
  const dir = cleanText(sort.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${orderMap[field] || 'date(t.created_at)'} ${dir}, t.id ${dir}`;
}

function evaluationRows(db, filters = {}, scope = null) {
  const { whereSql, params } = buildWhere(filters, scope);
  return db.prepare(`
    SELECT
      t.id,
      t.ticket_code,
      COALESCE(NULLIF(TRIM(t.supplier_code), ''), NULLIF(TRIM(sm.supplier_code), '')) AS supplier_code,
      COALESCE(NULLIF(TRIM(t.supplier_name), ''), NULLIF(TRIM(sm.supplier_name), '')) AS supplier_name,
      COALESCE(NULLIF(TRIM(t.supplier_address), ''), NULLIF(TRIM(sm.address), '')) AS supplier_address,
      NULLIF(TRIM(t.snapshot_evaluation_address), '') AS evaluation_address,
      NULLIF(TRIM(t.snapshot_linked_facility_address), '') AS linked_facility_address,
      COALESCE(NULLIF(TRIM(t.region), ''), NULLIF(TRIM(sm.region), '')) AS region,
      COALESCE(NULLIF(TRIM(t.province), ''), NULLIF(TRIM(sm.province), '')) AS province,
      COALESCE(NULLIF(TRIM(t.business_type), ''), NULLIF(TRIM(sm.business_type), '')) AS business_type,
      NULLIF(TRIM(t.cmc_owner), '') AS cmc_owner,
      NULLIF(TRIM(t.cmc_head), '') AS cmc_head,
      COALESCE(NULLIF(TRIM(t.contact_name), ''), NULLIF(TRIM(sm.contact_name), '')) AS contact_name,
      COALESCE(NULLIF(TRIM(t.contact_email), ''), NULLIF(TRIM(sm.contact_email), '')) AS contact_email,
      COALESCE(NULLIF(TRIM(t.contact_phone), ''), NULLIF(TRIM(sm.contact_phone), '')) AS contact_phone,
      NULLIF(TRIM(t.mch2), '') AS mch2,
      NULLIF(TRIM(t.mch3), '') AS mch3,
      NULLIF(TRIM(t.product_group), '') AS product_group,
      NULLIF(TRIM(t.snapshot_product_name), '') AS product_name,
      NULLIF(TRIM(t.attp_certificate_type), '') AS attp_certificate_type,
      t.evaluation_type,
      t.evaluation_method,
      (SELECT p.display_name
       FROM evaluation_participants p
       WHERE p.ticket_id = t.id AND p.participant_role = 'EVALUATOR' AND p.active = 1
       ORDER BY p.id LIMIT 1) AS evaluator_name,
      (SELECT p.display_name
       FROM evaluation_participants p
       WHERE p.ticket_id = t.id AND p.participant_role = 'QA_LEAD' AND p.active = 1
       ORDER BY p.id LIMIT 1) AS qa_lead_id,
      (SELECT group_concat(p.display_name, ', ')
       FROM evaluation_participants p
       WHERE p.ticket_id = t.id AND p.participant_role = 'QA_SUPPORT' AND p.active = 1) AS qa_support_ids,
      t.evaluation_department,
      t.planned_date,
      t.actual_evaluation_date,
      t.score_percent,
      t.grade_code,
      t.result_label,
      t.result_reason,
      t.corrected_score_percent,
      t.corrected_grade_code,
      t.corrected_result_label,
      t.correction_date,
      t.next_evaluation_date,
      t.final_conclusion,
      t.specialist_proposal,
      t.current_status,
      t.completed_round,
      t.created_at,
      qt.template_code,
      r1.id AS round1_id,
      r1.assessment_code AS round1_assessment_code,
      r1.assessment_date AS round1_assessment_date,
      r1.total_score AS round1_total_score,
      r1.final_result AS round1_final_result,
      r1.classification AS round1_classification,
      r2.id AS round2_id,
      r2.assessment_date AS round2_assessment_date,
      r2.total_score AS round2_total_score,
      r2.final_result AS round2_final_result,
      r2.classification AS round2_classification
    FROM evaluation_tickets t
    LEFT JOIN supplier_master sm ON sm.id = t.supplier_id
    LEFT JOIN question_templates qt ON qt.id = t.template_id
    LEFT JOIN evaluation_rounds r1 ON r1.ticket_id = t.id AND r1.round_no = 1
    LEFT JOIN evaluation_rounds r2 ON r2.ticket_id = t.id AND r2.round_no = 2
    WHERE ${whereSql}
    ORDER BY ${orderBySql(filters.sort)}
  `).all(params);
}

function nonconformitiesByTicket(db, ticketIds) {
  if (!ticketIds.length) return new Map();
  const placeholders = ticketIds.map((_, index) => `@id${index}`).join(', ');
  const params = ticketIds.reduce((acc, id, index) => ({ ...acc, [`id${index}`]: id }), {});
  const rows = db.prepare(`
    SELECT
      nc.ticket_id,
      nc.clause_code,
      nc.category,
      nc.nonconformity_content AS nonconformity,
      nc.severity,
      q.question_code,
      q.question_text,
      q.order_index
    FROM evaluation_nonconformities nc
    JOIN evaluation_rounds er ON er.id = nc.round_id AND er.round_no = 1
    LEFT JOIN evaluation_answers a ON a.id=nc.evaluation_answer_id
    LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = nc.ticket_id AND q.id = a.question_item_id
    WHERE nc.ticket_id IN (${placeholders})
      AND nc.status != 'CANCELLED'
    ORDER BY nc.ticket_id, COALESCE(q.order_index, 999999), nc.clause_code, nc.id
  `).all(params);
  const byTicket = new Map();
  rows.forEach((row) => {
    if (!byTicket.has(row.ticket_id)) byTicket.set(row.ticket_id, []);
    byTicket.get(row.ticket_id).push(row);
  });
  return byTicket;
}

function findingBucket(row) {
  const text = normalizeText(`${row.category || ''} ${row.clause_code || ''} ${row.question_code || ''} ${row.question_text || ''}`);
  if (text.includes('phap ly') || text.includes('ho so')) return 'legal';
  if (text.includes('truy xuat')) return 'trace';
  if (text.includes('ve sinh') || text.includes('atvstp') || text.includes('an toan thuc pham') || text.includes('attp')) return 'foodSafety';
  if (text.includes('chat luong') || text.includes('kiem soat') || text.includes('moi nguy') || text.includes('nhan mac')) return 'quality';
  return 'foodSafety';
}

function summarizeFindings(rows = []) {
  const buckets = {
    legal: [],
    quality: [],
    trace: [],
    foodSafety: [],
  };
  rows.forEach((row) => buckets[findingBucket(row)].push(row));
  const summarize = (items) => ({
    label: Array.from(new Set(items.map((row) => coalesceText(row.category, row.clause_code, row.question_code)).filter(Boolean))).join('; '),
    detail: items.map((row) => cleanText(row.nonconformity)).filter(Boolean).join('; '),
  });
  return {
    legal: summarize(buckets.legal),
    quality: summarize(buckets.quality),
    trace: summarize(buckets.trace),
    foodSafety: summarize(buckets.foodSafety),
    all: rows.map((row) => cleanText(row.nonconformity)).filter(Boolean).join('; '),
  };
}

function storedFinalConclusion(row) {
  return coalesceText(
    row.final_conclusion,
    row.round2_final_result,
    row.corrected_result_label,
    row.round1_final_result,
    row.result_label
  );
}

function conclusionFlag(row, expected) {
  const text = normalizeText(storedFinalConclusion(row));
  if (!text) return expected === 'waiting' ? 1 : 0;
  if (expected === 'fail') return text.includes('khong dat') ? 1 : 0;
  if (expected === 'pass') return text.includes('dat') && !text.includes('khong dat') ? 1 : 0;
  return 0;
}

function rowValue(header, row, index, findings) {
  const key = normalizeText(header);
  const evaluationDate = row.actual_evaluation_date || row.round1_assessment_date || row.planned_date || String(row.created_at || '').slice(0, 10);
  const parts = dateParts(evaluationDate);
  const round1Score = row.round1_total_score ?? row.score_percent;
  const round2Score = row.round2_total_score ?? row.corrected_score_percent;

  if (key === 'stt') return index + 1;
  if (key === 'nam') return parts.year;
  if (key.startsWith('thang danh gia')) return parts.month;
  if (key.includes('nganh hang mch2')) return row.mch2 || '';
  if (key.includes('nganh hang mch3')) return row.mch3 || '';
  if (key.includes('cmc phu trach')) return row.cmc_owner || '';
  if (key.includes('cmc truong phong')) return row.cmc_head || '';
  if (key === 'khu vuc') return row.region || '';
  if (key === 'tinh') return row.province || '';
  if (key === 'loai hinh danh gia') return row.evaluation_type || '';
  if (key === 'loai hinh kinh doanh') return row.business_type || '';
  if (key === 'ma ncc') return row.supplier_code || '';
  if (key === 'ten ncc chinh') return row.supplier_name || '';
  if (key === 'dia chi danh gia ncc') return row.evaluation_address || '';
  if (key.includes('dia chi danh gia don vi lien ket')) return row.linked_facility_address || '';
  if (key === 'nguoi lien he') return row.contact_name || '';
  if (key === 'so dien thoai lien he') return row.contact_phone || '';
  if (key === 'email') return row.contact_email || '';
  if (key.includes('san pham danh gia')) return coalesceText(row.product_name, row.product_group);
  if (key === 'qa lead danh gia') return row.qa_lead_id || row.evaluator_name || '';
  if (key === 'qa ho tro') return qaSupportLabel(row.qa_support_ids);
  if (key === 'bo phan danh gia') return row.evaluation_department || '';
  if (key.startsWith('ngay dg thuc te')) return toExcelDate(evaluationDate);
  if (key === 'diem danh gia lan 1 (%)') return toExcelPercent(round1Score);
  if (key === 'ket luan lan 1') return coalesceText(row.round1_final_result, row.result_label);
  if (key === 'loi vi pham dieu khoan phap ly') return findings.legal.label;
  if (key === 'noi dung loi vi pham dieu khoan phap ly') return findings.legal.detail;
  if (key === 'loi kiem soat chat luong') return findings.quality.label;
  if (key === 'noi dung loi kiem soat chat luong') return findings.quality.detail;
  if (key === 'loi truy xuat nguon goc sp') return findings.trace.label;
  if (key === 'noi dung loi truy xuat nguon goc sp') return findings.trace.detail;
  if (key === 'loi an toan ve sinh thuc pham') return findings.foodSafety.label;
  if (key === 'noi dung loi an toan ve sinh thuc pham') return findings.foodSafety.detail;
  if (key === 'diem danh gia sau khac phuc (%)') return row.round2_id ? toExcelPercent(round2Score) : '';
  if (key === 'ket luan sau khac phuc') return row.round2_id ? coalesceText(row.round2_final_result, row.corrected_result_label) : '';
  if (key === 'ly do dieu chinh ket qua diem') return row.round2_id ? row.result_reason || '' : '';
  if (key.startsWith('ngay khac phuc')) return row.round2_id ? toExcelDate(row.correction_date || row.round2_assessment_date) : '';
  if (key.startsWith('ke hoach danh gia tiep theo')) return toExcelDate(row.next_evaluation_date);
  if (key === 'ket luan') return storedFinalConclusion(row);
  if (key === 'ghi chu') return row.specialist_proposal || row.result_reason || '';
  if (key === 'dat') return conclusionFlag(row, 'pass');
  if (key === 'khong dat') return conclusionFlag(row, 'fail');
  if (key === 'cho ket luan') return conclusionFlag(row, 'waiting');
  if (key === 'map1') return `${row.supplier_code || ''}${row.mch3 || ''}`;
  return '';
}

function findDetailSheet(workbook) {
  const sheetName = workbook.SheetNames.find((name) => normalizeText(name) === DETAIL_SHEET_NAME)
    || workbook.SheetNames.find((name) => normalizeText(name).includes('chi tiet'));
  if (!sheetName || !workbook.Sheets[sheetName]) {
    throw Object.assign(new Error('summary_template_sheet_not_found'), { status: 500, code: 'summary_template_sheet_not_found' });
  }
  return { sheetName, worksheet: workbook.Sheets[sheetName] };
}

function cloneTemplateCell(worksheet, colIndex) {
  const source = worksheet[XLSX.utils.encode_cell({ r: DATA_START_ROW_INDEX, c: colIndex })] || {};
  const cell = {};
  if (source.s) cell.s = JSON.parse(JSON.stringify(source.s));
  if (source.z) cell.z = source.z;
  return cell;
}

function setCell(worksheet, rowIndex, colIndex, value) {
  const cell = cloneTemplateCell(worksheet, colIndex);
  if (value instanceof Date) {
    cell.t = 'd';
    cell.v = value;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    cell.t = 'n';
    cell.v = value;
  } else if (value === null || value === undefined || value === '') {
    cell.t = 'z';
  } else {
    cell.t = 's';
    cell.v = String(value);
  }
  delete cell.f;
  worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })] = cell;
}

function clearDetailRows(worksheet, fromRowIndex, toRowIndex, lastColIndex) {
  for (let rowIndex = fromRowIndex; rowIndex <= toRowIndex; rowIndex += 1) {
    for (let colIndex = 0; colIndex <= lastColIndex; colIndex += 1) {
      delete worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })];
    }
  }
}

function headersForDetailSheet(worksheet) {
  const headers = [];
  for (let colIndex = 0; colIndex <= DETAIL_LAST_COLUMN_INDEX; colIndex += 1) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: HEADER_ROW_INDEX, c: colIndex })];
    headers.push(cell ? cleanText(cell.v) : '');
  }
  if (!headers.some((header) => normalizeText(header) === 'ma ncc')) {
    throw Object.assign(new Error('summary_template_header_not_found'), { status: 500, code: 'summary_template_header_not_found' });
  }
  return headers;
}

function populateWorkbook(workbook, rows, findingsByTicket) {
  const { worksheet } = findDetailSheet(workbook);
  const headers = headersForDetailSheet(worksheet);
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:AR4');
  clearDetailRows(worksheet, DATA_START_ROW_INDEX, Math.max(range.e.r, DATA_START_ROW_INDEX + rows.length - 1), DETAIL_LAST_COLUMN_INDEX);

  rows.forEach((row, index) => {
    const rowIndex = DATA_START_ROW_INDEX + index;
    const findings = summarizeFindings(findingsByTicket.get(row.id) || []);
    headers.forEach((header, colIndex) => {
      setCell(worksheet, rowIndex, colIndex, rowValue(header, row, index, findings));
    });
    if (worksheet['!rows']) {
      worksheet['!rows'][rowIndex] = worksheet['!rows'][DATA_START_ROW_INDEX]
        ? { ...worksheet['!rows'][DATA_START_ROW_INDEX] }
        : { hpt: 16.5, hpx: 16.5 };
    }
  });

  const lastRow = DATA_START_ROW_INDEX + Math.max(rows.length, 1) - 1;
  worksheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: lastRow, c: DETAIL_LAST_COLUMN_INDEX },
  });
  worksheet['!autofilter'] = { ref: `A${HEADER_ROW_INDEX + 1}:AR${HEADER_ROW_INDEX + 1}` };
}

function exportEvaluationSummaryXlsx(db, options = {}) {
  const filters = options.filters || {};
  const rows = evaluationRows(db, filters, options.scope || null);
  if (!rows.length) {
    throw Object.assign(new Error('no_matching_evaluations'), { status: 404, code: 'no_matching_evaluations' });
  }
  const templatePath = options.templatePath || defaultTemplatePath();
  if (!fs.existsSync(templatePath)) {
    throw Object.assign(new Error('summary_template_not_found'), { status: 500, code: 'summary_template_not_found' });
  }

  const workbook = XLSX.readFile(templatePath, { cellStyles: true, cellFormula: true, cellDates: true });
  const findingsByTicket = nonconformitiesByTicket(db, rows.map((row) => row.id));
  populateWorkbook(workbook, rows, findingsByTicket);

  const fileName = exportFileName(options.now || new Date());
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellDates: true });

  return {
    file_name: fileName,
    buffer,
    row_count: rows.length,
    content_disposition: contentDisposition(fileName),
  };
}

module.exports = {
  exportEvaluationSummaryXlsx,
  exportFileName,
  buildWhere,
  evaluationRows,
  normalizeText,
};
