const fs = require('fs');
const path = require('path');
const { QuestionVersionService } = require('./QuestionVersionService');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const { REPORT_EXPORT_DIR } = require('../config/paths');
const { calculateNextEvaluationDate, normalizeResultLabel } = require('../domain/evaluationRules');
const { userDisplayNameMap } = require('./userDisplayNames');
const { GOLDEN_V1_DEFINITION, buildEvaluationResultWithPolicy, validateScoringPolicyDefinition } = require('../scoring/scoringPolicyEngine');
const { resolveReportAlias } = require('../reporting/reportAliasCatalog');
const EvaluationParticipantRepository = require('../repositories/EvaluationParticipantRepository');

const EXPORT_DIR = REPORT_EXPORT_DIR;
const PDF_RENDER_MAX_BUFFER = 100 * 1024 * 1024;
const WORKING_MINUTES_SHEET_NAME = '1. Biên bản làm việc với NCC';

const REPORT_TYPE_CODES = Object.freeze([
  'INTERNAL',
  'NCC',
  'WORKING_MINUTES',
  'ROUND1_RESULT',
  'ROUND2_RESULT',
]);

const REPORT_TYPE_DEFINITIONS = Object.freeze({
  INTERNAL: {
    code: 'INTERNAL',
    label: 'KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP',
    templateFallbackTypes: [],
    defaultRoundNo: null,
    renderer: 'result',
    showScores: true,
    requireRound: false,
  },
  NCC: {
    code: 'NCC',
    label: 'Biên bản làm việc với NCC',
    templateFallbackTypes: [],
    defaultRoundNo: 1,
    renderer: 'workingMinutes',
    showScores: false,
    requireRound: true,
  },
  WORKING_MINUTES: {
    code: 'WORKING_MINUTES',
    label: 'Biên bản làm việc với NCC',
    templateFallbackTypes: ['NCC'],
    defaultRoundNo: 1,
    renderer: 'workingMinutes',
    showScores: false,
    requireRound: true,
  },
  ROUND1_RESULT: {
    code: 'ROUND1_RESULT',
    label: 'Kết quả đánh giá lần 1',
    templateFallbackTypes: ['INTERNAL'],
    defaultRoundNo: 1,
    renderer: 'result',
    showScores: true,
    requireRound: true,
  },
  ROUND2_RESULT: {
    code: 'ROUND2_RESULT',
    label: 'Kết quả đánh giá lần 2',
    templateFallbackTypes: ['INTERNAL'],
    defaultRoundNo: 2,
    renderer: 'result',
    showScores: true,
    requireRound: true,
  },
});

function normalizeReportType(value) {
  const resolution = resolveReportAlias(value);
  return resolution.canonical_code || resolution.legacy_source || null;
}

function reportDefinitionFor(value) {
  return REPORT_TYPE_DEFINITIONS[normalizeReportType(value)] || REPORT_TYPE_DEFINITIONS.INTERNAL;
}

function isAllowedReportType(value) {
  return resolveReportAlias(value).known;
}

function datePart(value) {
  return String(value || '').slice(0, 10);
}

function actualAssessmentDateForReport(ticket, round, reportType) {
  const code = normalizeReportType(reportType);
  const ticketActualDate = datePart(ticket?.actual_evaluation_date);
  const roundAssessmentDate = datePart(round?.assessment_date);
  const scoringCompletionDate = datePart(round?.completed_at || round?.locked_at);
  if (code === 'WORKING_MINUTES' || code === 'ROUND1_RESULT') {
    if (ticketActualDate) return ticketActualDate;
    if (roundAssessmentDate && roundAssessmentDate !== datePart(ticket?.planned_date)) return roundAssessmentDate;
    return scoringCompletionDate || roundAssessmentDate || '';
  }
  return roundAssessmentDate || ticketActualDate || datePart(ticket?.planned_date) || datePart(ticket?.created_at);
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd');
}

function formatPercent(value) {
  if (value == null || value === '') return '0.00%';
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return htmlEscape(value);
  return `${numeric.toFixed(2)}%`;
}

function formatDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return text;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function uniqueTextList(values) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter((value) => {
    if (!value) return false;
    const key = normalizeText(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function participantDisplayName(row = {}) {
  const name = String(row.name || '').trim();
  const position = String(row.position || row.title || row.role || '').trim();
  if (name && position && !normalizeText(name).includes(normalizeText(position))) return `${name} - ${position}`;
  return name || position;
}

function assessmentTeamMemberIds(ticket, round) {
  return uniqueTextList([
    round?.evaluator_id,
    ticket.evaluator_name,
    ticket.qa_lead_id,
    ...parseJsonArray(ticket.qa_support_ids),
  ]);
}

function resolveUserDisplayName(value, displayNames) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return '';
  const displayName = displayNames.get(text.toLowerCase());
  return displayName || '';
}

function assessmentTeamMembers(ticket, round, displayNames) {
  return uniqueTextList(assessmentTeamMemberIds(ticket, round).map((value) => resolveUserDisplayName(value, displayNames)));
}

function firstUserDisplayName(values, displayNames) {
  return values.map((value) => resolveUserDisplayName(value, displayNames)).find(Boolean) || '';
}

function supplierIntroductionText(doc4) {
  const intro = doc4?.supplier_introduction || {};
  return String(intro.content || intro.text || '').trim();
}

function valueLine(value = '', extraClass = '') {
  const text = String(value == null ? '' : value).trim();
  return `<span class="value-line ${extraClass}">${htmlEscape(text)}</span>`;
}

function fieldRow(label, value) {
  return `<div class="field-row"><span class="field-label">${htmlEscape(label)}:</span>${valueLine(value)}</div>`;
}

function participantTick(checked) {
  return checked ? '<span class="participant-tick">&#10003;</span>' : '';
}

function participantRowsForInternalHtml(attendees, minRows = 6) {
  const rows = Array.isArray(attendees) ? attendees : [];
  return Array.from({ length: Math.max(minRows, rows.length) }, (_, index) => {
    const row = rows[index] || {};
    return `
    <tr>
      <td class="center">${index + 1}.</td>
      <td>${htmlEscape(participantDisplayName(row))}</td>
      <td class="center">${participantTick(row.opening)}</td>
      <td class="center">${participantTick(row.closing)}</td>
    </tr>`;
  }).join('');
}

function participantRowsForSimpleHtml(attendees, minRows = 1) {
  const rows = Array.isArray(attendees) ? attendees : [];
  return Array.from({ length: Math.max(minRows, rows.length) }, (_, index) => {
    const row = rows[index] || {};
    return `
    <tr>
      <td>${htmlEscape(participantDisplayName(row))}</td>
      <td class="center">${participantTick(row.opening)}</td>
      <td class="center">${participantTick(row.closing)}</td>
    </tr>`;
  }).join('');
}

function participantRowsForText(attendees) {
  const rows = Array.isArray(attendees) ? attendees : [];
  if (!rows.length) return '';
  return [
    'Ten/Chuc danh | Tham du hop khai mac | Tham du hop be mac',
    ...rows.map((row) => [
      participantDisplayName(row) || '-',
      row.opening ? '[x]' : '[ ]',
      row.closing ? '[x]' : '[ ]',
    ].join(' | ')),
  ].join('\n');
}

function scoreCount(row, grade) {
  return row?.counts?.[grade] || 0;
}

function complianceRowsForReport(summary) {
  const buckets = [
    { key: 'legal', label: 'Hồ sơ pháp lý', match: ['phap ly', 'legal', 'ho so'] },
    { key: 'quality', label: 'Kiểm soát chất lượng sản phẩm', match: ['chat luong', 'quality'] },
    { key: 'trace', label: 'Truy xuất nguồn gốc', match: ['truy xuat', 'trace'] },
    { key: 'foodSafety', label: 'Kiểm soát ATVSTP', match: ['atv', 'thuc pham', 'food safety', 'vsat'] },
  ];
  return buckets.map((bucket) => {
    const matched = summary.find((row) => {
      const category = normalizeText(row.category);
      return bucket.match.some((needle) => category.includes(needle));
    });
    return {
      label: bucket.label,
      counts: matched?.counts || { A: 0, B: 0, C: 0, D: 0 },
      percentage: matched?.percentage ?? 0,
    };
  });
}

function renderRadarChart(rows) {
  const points = [
    { x: 100, y: 18, label: 'Hồ sơ pháp lý', anchor: 'middle', dx: 0, dy: -8 },
    { x: 182, y: 100, label: 'Kiểm soát chất\nlượng sản phẩm', anchor: 'start', dx: 8, dy: 2 },
    { x: 100, y: 182, label: 'Truy xuất nguồn\ngốc', anchor: 'middle', dx: 0, dy: 20 },
    { x: 18, y: 100, label: 'Kiểm soát\nATVSTP', anchor: 'end', dx: -8, dy: 2 },
  ];
  const center = { x: 100, y: 100 };
  const maxRadius = 82;
  const dataPoints = rows.map((row, index) => {
    const axis = points[index];
    const pct = Math.max(0, Math.min(100, Number(row.percentage || 0))) / 100;
    return {
      x: center.x + (axis.x - center.x) * pct,
      y: center.y + (axis.y - center.y) * pct,
    };
  });
  const polygon = dataPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const labelText = points.map((point) => {
    const lines = point.label.split('\n');
    return `<text x="${point.x + point.dx}" y="${point.y + point.dy}" text-anchor="${point.anchor}" class="radar-label">${
      lines.map((line, index) => `<tspan x="${point.x + point.dx}" dy="${index ? 13 : 0}">${htmlEscape(line)}</tspan>`).join('')
    }</text>`;
  }).join('');
  return `
    <svg class="radar" viewBox="-28 -8 256 242" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Biểu đồ radar tổng quan tuân thủ">
      <polygon points="100,18 182,100 100,182 18,100" fill="none" stroke="#9ca3af" stroke-width="1"/>
      <polygon points="100,59 141,100 100,141 59,100" fill="none" stroke="#c7c7c7" stroke-width="1"/>
      <line x1="100" y1="18" x2="100" y2="182" stroke="#9ca3af" stroke-width="1"/>
      <line x1="18" y1="100" x2="182" y2="100" stroke="#9ca3af" stroke-width="1"/>
      <text x="88" y="103" class="radar-tick">0</text>
      <text x="70" y="65" class="radar-tick">0.5</text>
      <text x="78" y="34" class="radar-tick">1</text>
      <polygon points="${polygon}" fill="rgba(239,68,68,.16)" stroke="#ef4444" stroke-width="2"/>
      <circle cx="${center.x}" cy="${center.y}" r="2" fill="#111"/>
      ${labelText}
    </svg>`;
}

function renderTemplate(templateBody, variables) {
  return String(templateBody || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = variables[key];
    return value == null ? '' : String(value);
  });
}

function recordReportExport(db, { ticket, round, template, reportType, fileFormat, fileName, exportedBy, alias }) {
  const info = db.prepare(`
    INSERT INTO report_exports (
      ticket_id, round_id, report_template_id, report_type, file_format,
      export_scope, file_path, exported_by, legacy_source, legacy_alias_version
    ) VALUES (?, ?, ?, ?, ?, 'TICKET', ?, ?, ?, ?)
  `).run(
    ticket.id, round?.id || null, template?.id || null, reportType, fileFormat,
    fileName, exportedBy || null, alias?.legacy_source || null,
    alias?.legacy_source ? alias.mapping_version : null
  );
  return {
    id: info.lastInsertRowid,
    round_id: round?.id || null,
    round_no: round?.round_no || null,
    file_name: fileName,
    file_path: fileName,
    storage_key: fileName,
    file_format: fileFormat,
    report_type: reportType,
    canonical_code: alias?.canonical_code || null,
    legacy_source: alias?.legacy_source || null,
    legacy_alias_version: alias?.legacy_source ? alias.mapping_version : null,
    deprecation: alias?.deprecation || null,
  };
}

function safeExportName(ticket, reportType, extension) {
  const safeCode = String(ticket.ticket_code).replace(/[^\w.\-]+/g, '_');
  const safeType = String(reportType).replace(/[^\w.\-]+/g, '_');
  return `${safeCode}-${safeType}-${Date.now()}.${extension}`;
}

function contentDisposition(fileName) {
  const asciiName = String(fileName || 'report')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function reportArtifact(record, { fileName, contentType, buffer }) {
  return {
    ...record,
    file_name: fileName,
    content_type: contentType,
    content_disposition: contentDisposition(fileName),
    buffer,
  };
}

function listText(rows, mapper) {
  if (!rows || rows.length === 0) return '-';
  return rows.map(mapper).join('\n');
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseRoundAttendees(value) {
  return parseJsonArray(value).map((row) => {
    const parsed = {
      name: String(row?.name || '').trim(),
      opening: !!(row?.opening || row?.opening_meeting),
      closing: !!(row?.closing || row?.closing_meeting),
    };
    const position = String(row?.position || row?.title || row?.role || '').trim();
    if (!parsed.name && position) parsed.name = position;
    else if (position) parsed.position = position;
    return parsed;
  }).filter((row) => participantDisplayName(row) || row.opening || row.closing);
}

function scoreValue(score, scoreValues) {
  const value = scoreValues?.[score];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function computeCategorySummary(answers, scoreValues = GOLDEN_V1_DEFINITION.score_values) {
  const byCategory = new Map();
  answers.forEach((answer) => {
    const category = answer.category || 'Khác';
    const categoryCode = String(answer.category_code || '').trim() || null;
    const categoryKey = categoryCode || `UNMAPPED:${category}`;
    if (!byCategory.has(categoryKey)) {
      byCategory.set(categoryKey, {
        category,
        category_code: categoryCode,
        category_label: answer.category_label_snapshot || category,
        total_questions: 0,
        answered_count: 0,
        counts: { A: 0, B: 0, C: 0, D: 0, NA: 0 },
        denominator: 0,
        score_total: 0,
        percentage: null,
        nonconformity_count: 0,
      });
    }
    const row = byCategory.get(categoryKey);
    row.total_questions += 1;
    if (answer.score) row.answered_count += 1;
    if (Object.prototype.hasOwnProperty.call(row.counts, answer.score)) row.counts[answer.score] += 1;
    const numeric = scoreValue(answer.score, scoreValues);
    if (numeric != null) {
      row.denominator += 1;
      row.score_total += numeric;
    }
    if (['B', 'C', 'D'].includes(answer.score)) row.nonconformity_count += 1;
  });
  return Array.from(byCategory.values()).map((row) => ({
    ...row,
    percentage: row.denominator ? Number((row.score_total / row.denominator).toFixed(2)) : null,
  }));
}

function nonconformitySummaryRows(structuredRows, answerRows) {
  if (structuredRows.length) {
    return structuredRows.map((row, index) => ({
      item_no: index + 1,
      clause: row.clause_code || row.question_code || '',
      requirement: row.question_text || row.category || '',
      category: row.category || '',
      score: row.severity || '',
      description: row.nonconformity || '',
      corrective_action: row.remediation || '',
      due_date: row.due_date || '',
      status: row.status || '',
    }));
  }
  return answerRows.map((row, index) => ({
    item_no: index + 1,
    clause: row.question_code || '',
    requirement: row.question_text || row.category || '',
    category: row.category || '',
    score: row.score || '',
    description: row.comment || row.question_text || '',
    corrective_action: '',
    due_date: '',
    status: '',
  }));
}

function finalScoreContext(ticket, latestRound, scoringDefinition = GOLDEN_V1_DEFINITION) {
  const selectedRoundNo = Number(latestRound.round_no || 0);
  const completedRound = Number(ticket.completed_round || 0);
  const firstScore = selectedRoundNo === 1
    ? (latestRound.total_score ?? ticket.score_percent ?? null)
    : (completedRound >= 1 ? (ticket.score_percent ?? null) : null);
  const correctedScore = selectedRoundNo === 2 ? (latestRound.total_score ?? ticket.corrected_score_percent ?? null) : null;
  const finalScore = correctedScore ?? firstScore;
  const classified = finalScore == null
    ? { label: normalizeResultLabel(ticket.result_label || latestRound.final_result || ''), grade: ticket.grade_code || latestRound.classification || '', passed: null }
    : buildEvaluationResultWithPolicy(scoringDefinition, {
      score: Number(finalScore),
      forcedFail: false,
      evaluationDate: ticket.correction_date || ticket.actual_evaluation_date || ticket.planned_date || '',
    });
  return {
    first_score: firstScore,
    first_conclusion: normalizeResultLabel(selectedRoundNo === 1 ? (latestRound.final_result || ticket.result_label || '') : (ticket.result_label || '')),
    corrected_score: correctedScore,
    corrected_conclusion: normalizeResultLabel(selectedRoundNo === 2 ? (latestRound.final_result || ticket.corrected_result_label || '') : ''),
    final_score: finalScore,
    final_score_percent: finalScore == null ? '' : Number(finalScore).toFixed(1) + '%',
    final_grade: latestRound.classification || (selectedRoundNo === 2 ? ticket.corrected_grade_code : ticket.grade_code) || classified.grade,
    final_conclusion: finalScore == null ? '' : classified.finalConclusion,
    final_result_label: normalizeResultLabel(latestRound.final_result || (selectedRoundNo === 2 ? ticket.corrected_result_label : ticket.result_label) || classified.label),
    adjustment_reason: correctedScore == null ? '' : (ticket.result_reason || 'Supplier corrective action'),
    correction_date: selectedRoundNo === 2 ? (ticket.correction_date || latestRound.assessment_date || '') : '',
    passed: classified.passed,
  };
}

function inputColumnsForDoc4(ticket, score, nextEvaluationDate, nonconformities) {
  const evaluationDate = ticket.actual_evaluation_date || ticket.planned_date || String(ticket.created_at || '').slice(0, 10);
  const year = String(evaluationDate || '').slice(0, 4);
  const month = String(evaluationDate || '').slice(5, 7);
  const violationContent = (category) => nonconformities
    .filter((row) => String(row.category || '').toLowerCase().includes(category))
    .map((row) => row.nonconformity)
    .filter(Boolean)
    .join('; ');
  return {
    A: { label: 'STT', value: ticket.id },
    B: { label: 'Năm', value: year },
    C: { label: 'Tháng đánh giá', value: month },
    D: { label: 'Ngành hàng MCH2', value: ticket.mch2 || '' },
    E: { label: 'Ngành hàng MCH3', value: ticket.mch3 || '' },
    F: { label: 'CMC phụ trách ngành hàng', value: ticket.cmc_owner || '' },
    G: { label: 'CMC Trưởng phòng ngành hàng', value: ticket.cmc_head || '' },
    H: { label: 'Khu vực', value: ticket.region || '' },
    I: { label: 'Tỉnh', value: ticket.province || '' },
    J: { label: 'Loại hình đánh giá', value: ticket.evaluation_type || '' },
    K: { label: 'Loại hình kinh doanh', value: ticket.business_type || '' },
    L: { label: 'Mã NCC', value: ticket.supplier_code || '' },
    M: { label: 'Tên NCC chính', value: ticket.supplier_name || '' },
    N: { label: 'Địa chỉ đánh giá NCC', value: ticket.evaluation_address || ticket.supplier_address || '' },
    O: { label: 'Địa chỉ đánh giá đơn vị liên kết/gia công', value: ticket.linked_facility_address || '' },
    P: { label: 'Người liên hệ', value: ticket.contact_name || '' },
    Q: { label: 'Số điện thoại liên hệ', value: ticket.contact_phone || '' },
    R: { label: 'Email', value: ticket.contact_email || '' },
    S: { label: 'Sản phẩm đánh giá', value: ticket.product_name || ticket.product_group || '' },
    T: { label: 'QA lead đánh giá', value: ticket.qa_lead_id || '' },
    U: { label: 'QA hỗ trợ', value: parseJsonArray(ticket.qa_support_ids).join(', ') || ticket.qa_support_ids || '' },
    V: { label: 'Bộ phận đánh giá', value: ticket.evaluation_department || '' },
    W: { label: 'Ngày ĐG thực tế', value: evaluationDate || '' },
    X: { label: 'Điểm đánh giá lần 1 (%)', value: score.first_score == null ? '' : Number(score.first_score).toFixed(1) },
    Y: { label: 'Kết luận lần 1', value: score.first_conclusion || '' },
    Z: { label: 'Vi phạm hồ sơ pháp lý', value: violationContent('pháp') },
    AA: { label: 'Vi phạm kiểm soát chất lượng', value: violationContent('lượng') },
    AB: { label: 'Vi phạm truy xuất nguồn gốc', value: violationContent('truy') },
    AC: { label: 'Vi phạm kiểm soát ATVSTP', value: violationContent('atv') || violationContent('thực') },
    AD: { label: 'Nội dung điểm không phù hợp', value: nonconformities.map((row) => row.nonconformity).filter(Boolean).join('; ') },
    AE: { label: 'Điểm sau khắc phục (%)', value: score.corrected_score == null ? '' : Number(score.corrected_score).toFixed(1) },
    AF: { label: 'Kết luận sau khắc phục', value: score.corrected_conclusion || '' },
    AG: { label: 'Lý do điều chỉnh kết quả', value: score.adjustment_reason || '' },
    AH: { label: 'Ngày khắc phục', value: score.correction_date || '' },
    AI: { label: 'Ngày đánh giá kế tiếp', value: nextEvaluationDate || '' },
    AJ: { label: 'Kết luận cuối cùng', value: score.final_conclusion || '' },
    AK: { label: 'Đề xuất chuyên viên', value: ticket.specialist_proposal || '' },
    AL: { label: 'Loại chứng nhận ATTP', value: ticket.attp_certificate_type || '' },
    AM: { label: 'Phương thức đánh giá', value: ticket.evaluation_method || '' },
  };
}

function buildReportContext(db, ticket, options = {}) {
  try {
    ticket = new QuestionVersionService(db).ensureTicketPinned(ticket);
  } catch (error) {
    if (error.code !== 'question_version_not_published') throw error;
    // Compatibility only for synthetic/versionless fixtures created after startup.
  }
  const reportDefinition = reportDefinitionFor(options.reportType);
  const rounds = db.prepare('SELECT * FROM evaluation_rounds WHERE ticket_id = ? ORDER BY round_no').all(ticket.id);
  const explicitRoundRequested = options.roundNo !== undefined
    && options.roundNo !== null
    && String(options.roundNo).trim() !== '';
  const requestedRoundNo = Number(options.roundNo || reportDefinition.defaultRoundNo || 0);
  if (reportDefinition.renderer === 'workingMinutes' && requestedRoundNo !== 1) {
    throw Object.assign(new Error('report_round_not_allowed'), {
      status: 400,
      code: 'report_round_not_allowed',
      details: { definition_code: reportDefinition.code, requested_round_no: requestedRoundNo, allowed_rounds: [1] },
    });
  }
  const requireRound = reportDefinition.renderer === 'workingMinutes'
    ? true
    : (Object.prototype.hasOwnProperty.call(options, 'requireRound') ? options.requireRound : reportDefinition.requireRound);
  let latestRound = requestedRoundNo ? rounds.find((round) => Number(round.round_no) === requestedRoundNo) : null;
  if (requestedRoundNo && !latestRound && (requireRound || explicitRoundRequested)) {
    throw Object.assign(new Error('round_not_found'), {
      status: 404,
      code: 'round_not_found',
      round_no: requestedRoundNo,
    });
  }
  latestRound = latestRound
    || rounds.filter((round) => round.completed_at || round.locked_at || round.total_score != null).slice(-1)[0]
    || rounds[rounds.length - 1]
    || {};
  if (reportDefinition.code === 'ROUND2_RESULT' && latestRound.id && !latestRound.completed_at && !latestRound.locked_at) {
    throw Object.assign(new Error('report_round_not_ready'), {
      status: 409,
      code: 'report_round_not_ready',
      details: { definition_code: reportDefinition.code, required_round_no: 2 },
    });
  }
  const answers = latestRound.id ? db.prepare(`
    SELECT COALESCE(qi.category, q.category) AS category,
      q.category_code, q.category_label_snapshot,
      COALESCE(qi.question_code, q.question_code) AS question_code,
      COALESCE(qi.question_text, q.question_text) AS question_text,
      a.score, a.comment, er.round_no
    FROM evaluation_answers a
    JOIN evaluation_rounds er ON er.id = a.round_id
    LEFT JOIN question_items qi ON qi.id = a.question_item_id
    LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = er.ticket_id AND q.id = a.question_id
    WHERE a.round_id = ?
    ORDER BY COALESCE(qi.order_index, q.order_index), COALESCE(qi.question_code, q.question_code)
  `).all(latestRound.id) : [];
  const structuredNonconformities = db.prepare(`
    SELECT nc.*,
      COALESCE(qi.question_code, q.question_code) AS question_code,
      COALESCE(qi.question_text, q.question_text) AS question_text,
      COALESCE(qi.order_index, q.order_index) AS order_index
    FROM evaluation_nonconformities nc
    LEFT JOIN evaluation_answers a ON a.id = nc.evaluation_answer_id
    LEFT JOIN question_items qi ON qi.id = a.question_item_id
    LEFT JOIN pinned_evaluation_questions q ON q.ticket_id = nc.ticket_id AND q.id = nc.question_id
    WHERE nc.ticket_id = @ticket_id AND (@round_id IS NULL OR nc.round_id = @round_id)
    ORDER BY COALESCE(q.order_index, 999999), nc.clause_code, nc.created_at
  `).all({ ticket_id: ticket.id, round_id: latestRound.id || null }).map((row) => ({
    ...row,
    nonconformity: row.nonconformity_content || row.nonconformity,
    remediation: row.remediation_content || row.remediation,
  }));
  const answerNonconformities = answers.filter((a) => ['B', 'C', 'D'].includes(a.score));
  const correctiveActions = db.prepare(`
    SELECT * FROM corrective_actions
    WHERE ticket_id = @ticket_id AND (@round_id IS NULL OR round_id = @round_id)
    ORDER BY created_at
  `).all({ ticket_id: ticket.id, round_id: latestRound.id || null });
  const correctionExtensions = db.prepare(`
    SELECT * FROM correction_extensions WHERE ticket_id = ? ORDER BY extension_no, created_at
  `).all(ticket.id);
  const approvals = db.prepare(`
    SELECT * FROM approval_tasks WHERE ticket_id = ? ORDER BY created_at
  `).all(ticket.id);
  const history = db.prepare(`
    SELECT * FROM workflow_history WHERE ticket_id = ? ORDER BY created_at
  `).all(ticket.id);
  const finalApproval = approvals.filter((a) => a.status === 'APPROVED').slice(-1)[0] || {};
  let scoringDefinition = GOLDEN_V1_DEFINITION;
  const scoringPolicyVersionId = latestRound.scoring_policy_version_id || ticket.scoring_policy_version_id;
  if (scoringPolicyVersionId) {
    const scoringVersion = db.prepare('SELECT definition_json FROM scoring_policy_versions WHERE id=?').get(scoringPolicyVersionId);
    if (scoringVersion) scoringDefinition = validateScoringPolicyDefinition(JSON.parse(scoringVersion.definition_json));
  }
  const categorySummary = computeCategorySummary(answers, scoringDefinition.score_values);
  const score = finalScoreContext(ticket, latestRound, scoringDefinition);
  const participantRepository = new EvaluationParticipantRepository(db);
  const ticketParticipants = participantRepository.resolveTicketParticipants(ticket.id).participants;
  const roundParticipants = latestRound.id
    ? participantRepository.resolveRoundParticipants(latestRound.id).participants
    : [];
  const attendees = roundParticipants
    .filter((participant) => participant.participant_role === 'ATTENDEE')
    .map((participant) => ({
      name: participant.display_name,
      opening: !!participant.opening_meeting,
      closing: !!participant.closing_meeting,
    }));
  const teamMemberIds = uniqueTextList([...ticketParticipants, ...roundParticipants]
    .filter((participant) => participant.participant_role !== 'ATTENDEE')
    .map((participant) => participant.user_id || participant.display_name));
  const displayNames = userDisplayNameMap(db, teamMemberIds);
  const teamMembers = assessmentTeamMembers(ticket, latestRound, displayNames);
  const primaryEvaluatorParticipant = [...roundParticipants, ...ticketParticipants]
    .find((participant) => ['EVALUATOR', 'QA_LEAD'].includes(participant.participant_role));
  const primaryEvaluator = primaryEvaluatorParticipant?.display_name
    || firstUserDisplayName(teamMemberIds, displayNames);
  const evaluationDate = actualAssessmentDateForReport(ticket, latestRound, reportDefinition.code);
  const selectedRoundNo = Number(latestRound.round_no || 0);
  const nextEvaluationDate = score.passed
    ? (selectedRoundNo === 1
      ? calculateNextEvaluationDate(evaluationDate, score.final_score)
      : (ticket.next_evaluation_date || calculateNextEvaluationDate(score.correction_date || evaluationDate, score.final_score)))
    : '';
  const inputColumns = inputColumnsForDoc4(ticket, score, nextEvaluationDate, structuredNonconformities);
  const doc4 = {
    input_columns: inputColumns,
    related_information: {
      report_no: latestRound.assessment_code || `${ticket.ticket_code}-R${latestRound.round_no || 1}`,
      evaluation_date: evaluationDate,
      evaluators: teamMembers.join(', '),
      evaluator_list: teamMembers,
      supplier_name: ticket.supplier_name || '',
      supplier_code: ticket.supplier_code || '',
      evaluation_address: ticket.evaluation_address || ticket.supplier_address || '',
      linked_evaluation_address: ticket.linked_facility_address || '',
    },
    scope: {
      product: ticket.product_name || '',
      product_group: ticket.product_group || '',
      business_type: ticket.business_type || '',
      evaluation_type: ticket.evaluation_type || '',
      method: ticket.evaluation_method || '',
      template_id: ticket.template_id,
      question_template_version_id: ticket.question_template_version_id || null,
      facility_type: ticket.facility_type || '',
      supplier_scale: ticket.supplier_scale || '',
    },
    participants: {
      rows: attendees,
      opening_meeting: attendees.filter((row) => row.opening).map(participantDisplayName),
      closing_meeting: attendees.filter((row) => row.closing).map(participantDisplayName),
      qa_lead: ticketParticipants.find((participant) => participant.participant_role === 'QA_LEAD')?.display_name || '',
      qa_support: ticketParticipants
        .filter((participant) => participant.participant_role === 'QA_SUPPORT')
        .map((participant) => participant.display_name),
      department: ticket.evaluation_department || '',
      supplier_contact: {
        name: ticket.contact_name || '',
        phone: ticket.contact_phone || '',
        email: ticket.contact_email || '',
      },
    },
    supplier_introduction: {
      content: ticket.supplier_introduction || '',
      supplier_scale: ticket.supplier_scale || '',
      capability: ticket.business_type || '',
      products: ticket.product_name || ticket.product_group || '',
      qc_personnel: ticket.qc_personnel || ticket.quality_control_personnel || '',
      certificates: {
        business_license_file: ticket.business_license_file || '',
        attp_certificate_type: ticket.attp_certificate_type || '',
        attp_certificate_file: ticket.attp_certificate_file || '',
      },
    },
    compliance_summary: categorySummary,
    result_summary: {
      ...score,
      assessment_code: latestRound.assessment_code || `${ticket.ticket_code}-R${latestRound.round_no || 1}`,
      round_no: latestRound.round_no || '',
      next_evaluation_date: nextEvaluationDate,
      reason: ticket.result_reason || '',
    },
    nonconformity_summary: nonconformitySummaryRows(structuredNonconformities, answerNonconformities),
    signatures: {
      evaluator: primaryEvaluator,
      supplier_representative: ticket.contact_name || '',
      approved_by: finalApproval.acted_by || ticket.updated_by || '',
      approval_date: finalApproval.acted_at || ticket.updated_at || '',
    },
  };

  const workingMinutesNonconformities = structuredNonconformities.length
    ? listText(structuredNonconformities, (r) => `- ${r.clause_code || ''} ${r.category || ''}: ${r.nonconformity}${r.remediation ? ' | ' + r.remediation : ''}${r.due_date ? ' | due ' + r.due_date : ''}`)
    : listText(answerNonconformities, (r) => `- ${r.category} / ${r.question_code}: ${r.question_text}${r.comment ? ' - ' + r.comment : ''}`);

  return {
    report_type: reportDefinition.code,
    report_label: reportDefinition.label,
    report_definition: reportDefinition,
    show_scores: reportDefinition.showScores,
    selected_round: latestRound,
    doc4,
    input_columns: inputColumns,
    category_summary: categorySummary,
    result_summary: doc4.result_summary,
    ticket_code: ticket.ticket_code,
    assessment_code: latestRound.assessment_code || `${ticket.ticket_code}-R${latestRound.round_no || 1}`,
    round_no: latestRound.round_no || '',
    supplier_name: ticket.supplier_name,
    supplier_code: ticket.supplier_code,
    tax_code: ticket.tax_code,
    address: ticket.supplier_address || ticket.evaluation_address || '',
    evaluators: doc4.related_information.evaluators,
    evaluator: doc4.signatures.evaluator,
    evaluation_date: evaluationDate,
    evaluation_result: score.final_result_label,
    final_conclusion: score.final_conclusion,
    round_1_conclusion: score.first_conclusion,
    round_2_conclusion: score.corrected_conclusion,
    score_percent: score.final_score_percent,
    classification: score.final_grade,
    next_evaluation_date: nextEvaluationDate,
    doc4_input_columns_json: JSON.stringify(inputColumns, null, 2),
    doc4_sections_json: JSON.stringify(doc4, null, 2),
    category_summary_text: listText(categorySummary, (r) => `- ${r.category}: A=${r.counts.A}, B=${r.counts.B}, C=${r.counts.C}, D=${r.counts.D}, NA=${r.counts.NA}, score=${r.percentage == null ? '-' : r.percentage.toFixed(1) + '%'}`),
    attendees: listText(attendees, (r) => `- ${r.name || '-'} | Khai mac: ${r.opening ? 'Co' : 'Khong'} | Be mac: ${r.closing ? 'Co' : 'Khong'}`),
    participants: participantRowsForText(attendees),
    participants_table: participantRowsForText(attendees),
    participants_json: JSON.stringify(attendees, null, 2),
    supplier_introduction: supplierIntroductionText(doc4),
    nonconformities: structuredNonconformities.length
      ? listText(structuredNonconformities, (r) => `- ${r.clause_code || ''} ${r.category || ''}: ${r.nonconformity}${r.remediation ? ' | ' + r.remediation : ''}${r.due_date ? ' | due ' + r.due_date : ''}`)
      : listText(answerNonconformities, (r) => `- [${r.score}] ${r.category} / ${r.question_code}: ${r.question_text}${r.comment ? ' - ' + r.comment : ''}`),
    working_minutes_nonconformities: workingMinutesNonconformities,
    corrective_actions: listText(correctiveActions, (r) => `- ${r.issue_description} | ${r.required_action} | ${r.responsible_party || ''} | ${r.due_date || ''} | ${r.status}`),
    correction_extensions: listText(correctionExtensions, (r) => `- Lan ${r.extension_no}: ${r.old_due_date || '-'} -> ${r.new_due_date} | ${r.reason} | ${r.created_by || ''} | ${r.created_at || ''}`),
    corrective_action_rows: correctiveActions,
    approved_by: finalApproval.acted_by || ticket.updated_by || '',
    approval_date: finalApproval.acted_at || ticket.updated_at || '',
    approval_history: listText(history, (r) => `- ${r.created_at}: ${r.actor_role || ''} ${r.action} ${r.from_status || ''} -> ${r.to_status || ''}${r.comment ? ' | ' + r.comment : ''}`),
    approval_history_rows: history,
    detailed_scoring: listText(answers, (r) => `- [${r.score || '-'}] ${r.category} / ${r.question_code}: ${r.question_text}${r.comment ? ' - ' + r.comment : ''}`),
  };
}

function doc4ResultRows(context) {
  const doc4 = context.doc4;
  const participantRows = Array.isArray(doc4.participants.rows) ? doc4.participants.rows : [];
  const rows = [
    [context.report_label || 'KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP', '', ''],
    ['Số báo cáo', doc4.related_information.report_no, ''],
    ['Ngày đánh giá', doc4.related_information.evaluation_date, ''],
    [],
    ['I. Thông tin liên quan', '', ''],
    ['Người đánh giá', doc4.related_information.evaluators, ''],
    ['Nhà cung cấp', doc4.related_information.supplier_name, doc4.related_information.supplier_code],
    ['Địa chỉ đánh giá', doc4.related_information.evaluation_address, ''],
    ['Địa chỉ đơn vị liên kết', doc4.related_information.linked_evaluation_address, ''],
    [],
    ['II. Phạm vi đánh giá', '', ''],
    ['Sản phẩm', doc4.scope.product, ''],
    ['Nhóm sản phẩm', doc4.scope.product_group, ''],
    ['Loại hình kinh doanh', doc4.scope.business_type, ''],
    ['Loại hình đánh giá', doc4.scope.evaluation_type, ''],
    [],
    ['III. Người tham dự', '', ''],
    ['QA lead', doc4.participants.qa_lead, ''],
    ['QA hỗ trợ', doc4.participants.qa_support.join(', '), ''],
    ['Liên hệ NCC', [doc4.participants.supplier_contact.name, doc4.participants.supplier_contact.phone, doc4.participants.supplier_contact.email].filter(Boolean).join(' / '), ''],
    [],
    ['IV. Giới thiệu NCC', '', ''],
    ['Nội dung', supplierIntroductionText(doc4), ''],
    [],
    ['V. Tổng hợp tuân thủ', '', ''],
    ['Hạng mục', 'A/B/C/D/NA', 'Điểm %'],
  ];
  if (participantRows.length) {
    const supplierIntroIndex = rows.findIndex((row) => Array.isArray(row) && String(row[0] || '').startsWith('IV.'));
    const insertAt = supplierIntroIndex > 0 ? supplierIntroIndex - 1 : rows.length;
    rows.splice(
      insertAt,
      0,
      ['Ten/Chuc danh', 'Tham du hop khai mac', 'Tham du hop be mac'],
      ...participantRows.map((row) => [row.name || '', row.opening ? 'x' : '', row.closing ? 'x' : ''])
    );
  }
  doc4.compliance_summary.forEach((row) => {
    rows.push([
      row.category,
      `${row.counts.A}/${row.counts.B}/${row.counts.C}/${row.counts.D}/${row.counts.NA}`,
      row.percentage == null ? '' : row.percentage,
    ]);
  });
  rows.push([], ['VI. Kết quả', '', '']);
  if (context.report_type === 'ROUND1_RESULT') {
    rows.push(
      ['Điểm lần 1', doc4.result_summary.first_score ?? '', doc4.result_summary.first_conclusion || ''],
      ['Kết luận lần 1', doc4.result_summary.first_conclusion || '', ''],
      ['Ngày đánh giá kế tiếp', doc4.result_summary.next_evaluation_date || '', '']
    );
  } else {
    rows.push(
      ['Điểm lần 1', doc4.result_summary.first_score ?? '', doc4.result_summary.first_conclusion || ''],
      ['Điểm sau khắc phục', doc4.result_summary.corrected_score ?? '', doc4.result_summary.corrected_conclusion || ''],
      ['Điểm cuối', doc4.result_summary.final_score ?? '', doc4.result_summary.final_result_label || ''],
      ['Kết luận cuối cùng', doc4.result_summary.final_conclusion || '', ''],
      ['Ngày đánh giá kế tiếp', doc4.result_summary.next_evaluation_date || '', '']
    );
  }
  rows.push(
    [],
    ['VII. Điểm không phù hợp', '', ''],
    ['Điều khoản', 'Mô tả', 'Khắc phục / hạn']
  );
  doc4.nonconformity_summary.forEach((row) => {
    rows.push([row.clause, row.description, [row.corrective_action, row.due_date, row.status].filter(Boolean).join(' / ')]);
  });
  rows.push(
    [],
    ['VIII. Chữ ký', '', ''],
    ['Người đánh giá', doc4.signatures.evaluator, ''],
    ['Đại diện NCC', doc4.signatures.supplier_representative, ''],
    ['Người duyệt', doc4.signatures.approved_by, doc4.signatures.approval_date]
  );
  return rows;
}

function sheetRange(ws) {
  return XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
}

function mergeAcross(ws, rowIndex, startCol, endCol) {
  ws['!merges'] = ws['!merges'] || [];
  ws['!merges'].push({ s: { r: rowIndex, c: startCol }, e: { r: rowIndex, c: endCol } });
}

function applyA4PrintSettings(ws, orientation) {
  ws['!margins'] = { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.12, footer: 0.12 };
  ws['!pageSetup'] = {
    paperSize: 9,
    orientation: orientation || 'portrait',
    fitToWidth: 1,
    fitToHeight: 0,
  };
  ws['!printOptions'] = { horizontalCentered: true, gridLines: false };
}

function styleCell(cell, style) {
  if (!cell) return;
  cell.s = {
    ...(cell.s || {}),
    ...style,
    font: { ...((cell.s && cell.s.font) || {}), ...(style.font || {}) },
    alignment: { ...((cell.s && cell.s.alignment) || {}), ...(style.alignment || {}) },
    border: { ...((cell.s && cell.s.border) || {}), ...(style.border || {}) },
    fill: { ...((cell.s && cell.s.fill) || {}), ...(style.fill || {}) },
  };
}

function applyTableBorders(ws) {
  const range = sheetRange(ws);
  const border = {
    top: { style: 'thin', color: { rgb: '000000' } },
    right: { style: 'thin', color: { rgb: '000000' } },
    bottom: { style: 'thin', color: { rgb: '000000' } },
    left: { style: 'thin', color: { rgb: '000000' } },
  };
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      if (!ws[address]) continue;
      styleCell(ws[address], {
        border,
        alignment: { vertical: 'top', wrapText: true },
      });
    }
  }
}

function styleDoc4InputWorksheet(ws) {
  ws['!cols'] = [{ wch: 12 }, { wch: 34 }, { wch: 64 }];
  ws['!rows'] = [{ hpt: 22 }];
  ws['!autofilter'] = { ref: 'A1:C1' };
  applyA4PrintSettings(ws, 'landscape');
  applyTableBorders(ws);
  ['A1', 'B1', 'C1'].forEach((address) => styleCell(ws[address], {
    font: { bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: 'DCEAF6' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  }));
}

function styleDoc4ResultWorksheet(ws, rows) {
  ws['!cols'] = [{ wch: 28 }, { wch: 58 }, { wch: 40 }];
  ws['!rows'] = rows.map((row, index) => {
    const text = row.map((value) => String(value || '')).join(' ');
    if (index === 0) return { hpt: 28 };
    if (/^(I|II|III|IV|V|VI|VII|VIII)\./.test(String(row[0] || ''))) return { hpt: 22 };
    if (text.length > 160) return { hpt: 58 };
    if (text.length > 90) return { hpt: 42 };
    return { hpt: 24 };
  });
  rows.forEach((row, index) => {
    const first = String(row[0] || '');
    const isTitle = index === 0;
    const isSection = /^(I|II|III|IV|V|VI|VII|VIII)\./.test(first);
    if ((isTitle || isSection) && !row[1] && !row[2]) mergeAcross(ws, index, 0, 2);
  });
  applyA4PrintSettings(ws, 'portrait');
  applyTableBorders(ws);
  rows.forEach((row, index) => {
    const first = String(row[0] || '');
    const isTitle = index === 0;
    const isSection = /^(I|II|III|IV|V|VI|VII|VIII)\./.test(first);
    const isTableHeader = ['Hạng mục', 'Điều khoản', 'Ten/Chuc danh'].includes(first);
    if (!isTitle && !isSection && !isTableHeader) return;
    for (let col = 0; col <= 2; col += 1) {
      const address = XLSX.utils.encode_cell({ r: index, c: col });
      if (!ws[address]) ws[address] = { t: 's', v: '' };
      styleCell(ws[address], {
        font: { bold: true, sz: isTitle ? 16 : 12 },
        fill: { patternType: 'solid', fgColor: { rgb: isTitle ? 'FFFFFF' : 'DCEAF6' } },
        alignment: { horizontal: isTitle || isSection ? 'center' : 'left', vertical: 'center', wrapText: true },
      });
    }
  });
}

function workingMinutesRows(context) {
  const doc4 = context.doc4;
  const teamMembers = doc4.related_information.evaluator_list || [];
  const participantRows = doc4.participants.rows || [];
  const supplierIntro = supplierIntroductionText(doc4);
  const rows = [
    [context.report_label || 'Biên bản làm việc với NCC', '', '', '', ''],
    ['Số biên bản', doc4.related_information.report_no, '', 'Ngày đánh giá', doc4.related_information.evaluation_date],
    [],
    ['I. Thông tin liên quan', '', ''],
    ['Đánh giá viên', '', ''],
    ...(teamMembers.length ? teamMembers : ['']).map((member, index) => [`${index + 1}.`, member, '']),
    ['Nhà cung cấp', doc4.related_information.supplier_name, doc4.related_information.supplier_code],
    ['Địa chỉ đánh giá', doc4.related_information.evaluation_address, ''],
    ['Địa chỉ liên kết đánh giá', doc4.related_information.linked_evaluation_address, ''],
    [],
    ['II. Phạm vi đánh giá', '', ''],
    ['Sản phẩm', doc4.scope.product, ''],
    ['Nhóm sản phẩm', doc4.scope.product_group, ''],
    ['Loại hình nhà cung cấp', doc4.scope.business_type, ''],
    ['Loại đánh giá', doc4.scope.evaluation_type || doc4.scope.method, ''],
    [],
    ['III. Thành phần tham dự', '', ''],
    ['Tên/Chức danh', 'Họp khai mạc', 'Họp bế mạc'],
  ];
  participantRows.forEach((row) => {
    rows.push([participantDisplayName(row), row.opening ? '√' : '', row.closing ? '√' : '']);
  });
  rows.push(
    [],
    ['IV. Giới thiệu nhà cung cấp', '', ''],
    [supplierIntro, '', ''],
    [],
    ['V. Tổng kết những điểm không phù hợp', '', ''],
    ['TT', 'Điều khoản / yêu cầu', 'Mô tả điểm không phù hợp', 'Hành động khắc phục', 'Thời hạn thực hiện']
  );
  doc4.nonconformity_summary.forEach((row, index) => {
    rows.push([
      row.item_no || index + 1,
      [row.clause, row.requirement].filter(Boolean).join(' - '),
      row.description || '',
      row.corrective_action || '',
      row.due_date || '',
    ]);
  });
  rows.push(
    [],
    ['Đánh giá viên', doc4.signatures.evaluator || doc4.related_information.evaluators, '', 'Ngày / Đại diện Nhà cung cấp', doc4.signatures.supplier_representative]
  );
  return rows;
}

function renderReportHtml(context) {
  const doc4 = context.doc4;
  const inputRows = Object.entries(doc4.input_columns)
    .map(([col, item]) => `<tr><td>${htmlEscape(col)}</td><th>${htmlEscape(item.label)}</th><td>${htmlEscape(item.value)}</td></tr>`)
    .join('');
  const complianceRows = doc4.compliance_summary.map((row) => `
    <tr>
      <td>${htmlEscape(row.category)}</td>
      <td>${row.counts.A}</td><td>${row.counts.B}</td><td>${row.counts.C}</td><td>${row.counts.D}</td><td>${row.counts.NA}</td>
      <td>${row.percentage == null ? '' : htmlEscape(row.percentage + '%')}</td>
    </tr>`).join('');
  const nonconformityRows = doc4.nonconformity_summary.map((row) => `
    <tr>
      <td>${htmlEscape(row.clause)}</td><td>${htmlEscape(row.category)}</td><td>${htmlEscape(row.score)}</td>
      <td>${htmlEscape(row.description)}</td><td>${htmlEscape(row.corrective_action)}</td><td>${htmlEscape(row.due_date)}</td><td>${htmlEscape(row.status)}</td>
    </tr>`).join('');
  const participantTableRows = participantRowsForSimpleHtml(doc4.participants.rows || [], doc4.participants.rows?.length ? 0 : 1);
  const supplierIntro = supplierIntroductionText(doc4);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(doc4.related_information.report_no)} - DOC-4</title>
<style>
body{font-family:Arial,sans-serif;color:#111827;margin:32px;line-height:1.45}
h1{font-size:22px;margin:0 0 8px} h2{font-size:16px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;margin:8px 0 16px} th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f3f4f6}.meta{color:#4b5563}.sign{height:72px}.center{text-align:center}.participant-tick{font-weight:700}
@media print{body{margin:16mm}.no-print{display:none}}
</style></head><body>
<button class="no-print" onclick="window.print()">Print</button>
<h1>KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP</h1>
<div class="meta">Số báo cáo: ${htmlEscape(doc4.related_information.report_no)} · Ngày đánh giá: ${htmlEscape(doc4.related_information.evaluation_date)}</div>
<h2>Thông tin DOC-4 đầu vào</h2><table><tbody>${inputRows}</tbody></table>
<h2>Thông tin liên quan</h2><table><tbody>
<tr><th>Người đánh giá</th><td>${htmlEscape(doc4.related_information.evaluators)}</td></tr>
<tr><th>NCC</th><td>${htmlEscape(doc4.related_information.supplier_name)} (${htmlEscape(doc4.related_information.supplier_code)})</td></tr>
<tr><th>Địa chỉ đánh giá</th><td>${htmlEscape(doc4.related_information.evaluation_address)}</td></tr>
</tbody></table>
<h2>Phạm vi và người tham dự</h2><table><tbody>
<tr><th>Sản phẩm</th><td>${htmlEscape(doc4.scope.product)}</td></tr>
<tr><th>Loại hình</th><td>${htmlEscape(doc4.scope.business_type)} / ${htmlEscape(doc4.scope.evaluation_type)}</td></tr>
<tr><th>QA</th><td>${htmlEscape(doc4.participants.qa_lead)} ${htmlEscape(doc4.participants.qa_support.join(', '))}</td></tr>
</tbody></table>
<h2>Thanh phan tham du</h2><table><thead><tr><th>Ten/Chuc danh</th><th>Tham du hop khai mac</th><th>Tham du hop be mac</th></tr></thead><tbody>${participantTableRows}</tbody></table>
<h2>GIỚI THIỆU NHÀ CUNG CẤP</h2><div style="white-space:pre-line;margin:8px 0 16px">${htmlEscape(supplierIntro)}</div>
<h2>Tổng hợp tuân thủ</h2><table><thead><tr><th>Hạng mục</th><th>A</th><th>B</th><th>C</th><th>D</th><th>NA</th><th>%</th></tr></thead><tbody>${complianceRows}</tbody></table>
<h2>Kết quả</h2><table><tbody>
<tr><th>Điểm cuối</th><td>${htmlEscape(doc4.result_summary.final_score_percent)}</td></tr>
<tr><th>Kết luận</th><td>${htmlEscape(doc4.result_summary.final_result_label)}</td></tr>
<tr><th>Kết luận cuối cùng</th><td>${htmlEscape(doc4.result_summary.final_conclusion)}</td></tr>
<tr><th>Ngày đánh giá kế tiếp</th><td>${htmlEscape(doc4.result_summary.next_evaluation_date)}</td></tr>
</tbody></table>
<h2>Điểm không phù hợp</h2><table><thead><tr><th>Điều khoản</th><th>Hạng mục</th><th>Điểm</th><th>Mô tả</th><th>Khắc phục</th><th>Hạn</th><th>Trạng thái</th></tr></thead><tbody>${nonconformityRows}</tbody></table>
<h2>Chữ ký</h2><table><tbody><tr><th>Người đánh giá</th><th>Đại diện NCC</th><th>Người duyệt</th></tr><tr class="sign"><td>${htmlEscape(doc4.signatures.evaluator)}</td><td>${htmlEscape(doc4.signatures.supplier_representative)}</td><td>${htmlEscape(doc4.signatures.approved_by)}</td></tr></tbody></table>
</body></html>`;
}

function renderWorkingMinutesHtml(context) {
  const doc4 = context.doc4;
  const teamMembers = doc4.related_information.evaluator_list || [];
  const evaluatorRows = Array.from({ length: Math.max(3, teamMembers.length) }, (_, index) => `
    <div class="line-row"><span>${index + 1}.</span>${valueLine(teamMembers[index] || '', 'line-fill')}</div>
  `).join('');
  const participantRows = Array.from({ length: Math.max(6, doc4.participants.rows?.length || 0) }, (_, index) => {
    const row = doc4.participants.rows?.[index] || {};
    return `
    <tr>
      <td class="center">${index + 1}.</td>
      <td>${htmlEscape(participantDisplayName(row))}</td>
      <td class="center">${participantTick(row.opening)}</td>
      <td class="center">${participantTick(row.closing)}</td>
    </tr>`;
  }).join('');
  const nonconformityRows = Array.from({ length: Math.max(11, doc4.nonconformity_summary.length) }, (_, index) => {
    const row = doc4.nonconformity_summary[index] || {};
    return `
    <tr>
      <td class="center">${index + 1}</td>
      <td>${htmlEscape([row.clause, row.requirement].filter(Boolean).join(' - '))}</td>
      <td>${htmlEscape(row.description || '')}</td>
      <td>${htmlEscape(row.corrective_action || '')}</td>
      <td>${htmlEscape(formatDate(row.due_date || ''))}</td>
    </tr>`;
  }).join('');
  const supplierIntro = supplierIntroductionText(doc4);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(doc4.related_information.report_no)} - ${htmlEscape(context.report_label)}</title>
<style>
*{box-sizing:border-box}
body{font-family:"Times New Roman",Times,serif;color:#000;margin:0;background:#f3f4f6;font-size:14px;line-height:1.22}
.no-print{position:fixed;right:24px;top:24px;z-index:10;border:1px solid #111;background:#fff;padding:8px 14px;font-family:Arial,sans-serif;cursor:pointer}
.sheet{width:960px;margin:18px auto;background:#fff;border:1px solid #000;padding-bottom:0}
.header{display:grid;grid-template-columns:300px 1fr;min-height:58px;border-bottom:1px solid #000}
.brand{display:flex;align-items:center;padding:8px 36px;border-right:1px solid #000}
.brand .win{font-family:Arial,sans-serif;font-size:34px;font-weight:800;color:#f31325;letter-spacing:-2px}
.brand .commerce{font-family:Arial,sans-serif;font-size:31px;font-weight:700;color:#c99438;letter-spacing:-1px}
.title{display:flex;align-items:center;justify-content:center;text-align:center;font-size:22px;font-weight:700;text-transform:uppercase}
.top-meta{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:18px 8px 14px}
.top-meta .right{text-align:right}.top-meta .value-line{width:150px;margin-left:8px}
.section-title{display:flex;align-items:center;justify-content:center;min-height:30px;border-top:1px solid #000;border-bottom:1px solid #000;background:#dceaf6;font-weight:700;text-transform:uppercase}
.block{padding:8px}.block.tight{padding-top:4px;padding-bottom:10px}
.field-row{display:grid;grid-template-columns:185px 1fr;align-items:end;min-height:24px}
.line-row{display:grid;grid-template-columns:34px 1fr;align-items:end;min-height:23px}
.field-label{white-space:nowrap}.value-line{display:inline-block;border-bottom:1px dashed #000;min-height:19px;width:100%;padding:0 4px}
.line-fill{width:100%}
table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #000;padding:5px 5px;vertical-align:middle}th{font-weight:700}.blue th,.blue td{background:#dceaf6}
.center{text-align:center}.participant-tick{font-weight:700}.participants td{height:24px}.participants .no-col{width:36px}.participants .name-col{width:59%}.participants .meet-col{width:20.5%}
.intro{min-height:72px;white-space:pre-line;padding:12px 8px}
.nonconformity th{height:31px}.nonconformity td{height:31px}
.signatures{display:grid;grid-template-columns:1fr 1fr;min-height:118px;text-align:center;font-weight:700;border-top:1px solid #000}
.signatures>div{padding:8px}.signatures>div+div{border-left:1px solid #000}.signature-lines{white-space:pre-line;margin-top:8px}
@media print{body{background:#fff}.sheet{margin:0;width:100%;border:1px solid #000}.no-print{display:none}@page{size:A4 portrait;margin:8mm}}
</style></head><body>
<button class="no-print" onclick="window.print()">Print</button>
<main class="sheet">
  <header class="header">
    <div class="brand"><span class="win">Win</span><span class="commerce">Commerce</span></div>
    <div class="title">${htmlEscape(context.report_label || 'Biên bản làm việc với NCC')}</div>
  </header>
  <section class="top-meta">
    <div>Số: ${valueLine(doc4.related_information.report_no)}</div>
    <div class="right">Ngày đánh giá ${valueLine(formatDate(doc4.related_information.evaluation_date))}</div>
  </section>
  <div class="section-title">THÔNG TIN LIÊN QUAN</div>
  <section class="block tight">
    <div>Đánh giá viên:</div>
    ${evaluatorRows}
  </section>
  <section class="block">
    ${fieldRow('Nhà cung cấp', [doc4.related_information.supplier_name, doc4.related_information.supplier_code].filter(Boolean).join(' - '))}
    ${fieldRow('Địa chỉ đánh giá', doc4.related_information.evaluation_address)}
    ${fieldRow('Địa chỉ liên kết đánh giá', doc4.related_information.linked_evaluation_address)}
  </section>
  <div class="section-title">PHẠM VI ĐÁNH GIÁ</div>
  <section class="block">
    ${fieldRow('Sản phẩm', doc4.scope.product)}
    ${fieldRow('Nhóm sản phẩm', doc4.scope.product_group)}
    ${fieldRow('Loại hình nhà cung cấp', doc4.scope.business_type)}
    ${fieldRow('Loại đánh giá', doc4.scope.evaluation_type || doc4.scope.method)}
  </section>
  <div class="section-title">THÀNH PHẦN THAM DỰ</div>
  <table class="participants">
    <thead>
      <tr class="blue"><th class="no-col"></th><th class="name-col" rowspan="2">Tên/Chức danh</th><th colspan="2">Tham dự (√)</th></tr>
      <tr class="blue"><th></th><th class="meet-col">Họp khai mạc</th><th class="meet-col">Họp bế mạc</th></tr>
    </thead>
    <tbody>${participantRows}</tbody>
  </table>
  <div class="section-title">GIỚI THIỆU NHÀ CUNG CẤP</div>
  <section class="intro">${htmlEscape(supplierIntro)}</section>
  <div class="section-title">TỔNG KẾT NHỮNG ĐIỂM KHÔNG PHÙ HỢP</div>
  <table class="nonconformity">
    <thead><tr class="blue"><th style="width:42px">TT</th><th style="width:170px">Điều khoản</th><th>Mô tả điểm không phù hợp</th><th style="width:210px">Hành động khắc phục</th><th style="width:130px">Thời hạn thực hiện</th></tr></thead>
    <tbody>${nonconformityRows}</tbody>
  </table>
  <section class="signatures">
    <div>Đánh giá viên:<div class="signature-lines">${htmlEscape(doc4.signatures.evaluator || doc4.related_information.evaluators)}</div></div>
    <div>Ngày: ${htmlEscape(formatDate(doc4.signatures.approval_date || ''))}<br>Đại diện Nhà cung cấp<div class="signature-lines">${htmlEscape(doc4.signatures.supplier_representative)}</div></div>
  </section>
</main>
</body></html>`;
}

function officialWorkingMinutesTemplatePath() {
  const templateDir = path.resolve(__dirname, '..', '..', 'Template');
  if (!fs.existsSync(templateDir)) return null;
  const fileName = fs.readdirSync(templateDir).find((name) => {
    const normalized = normalizeText(name);
    return normalized.includes('phieu ket qua danh gia ncc') && normalized.endsWith('.xlsx');
  });
  return fileName ? path.join(templateDir, fileName) : null;
}

function cloneCellShell(cell) {
  if (!cell) return {};
  const clone = { ...cell };
  delete clone.v;
  delete clone.w;
  delete clone.f;
  delete clone.h;
  delete clone.r;
  return clone;
}

function cloneMerge(merge) {
  return {
    s: { r: merge.s.r, c: merge.s.c },
    e: { r: merge.e.r, c: merge.e.c },
  };
}

function setCellValue(ws, address, value) {
  const finalValue = value == null ? '' : value;
  const cell = cloneCellShell(ws[address]);
  cell.v = finalValue;
  cell.t = typeof finalValue === 'number' ? 'n' : 's';
  ws[address] = cell;
}

function insertWorksheetRows(ws, startRow, count, templateRow, startCol = 1, endCol = 16) {
  if (!count || count < 1) return;
  const startIndex = startRow - 1;
  const templateIndex = templateRow - 1;
  const templateMerges = (ws['!merges'] || [])
    .filter((merge) => merge.s.r === templateIndex && merge.e.r === templateIndex)
    .map(cloneMerge);

  Object.keys(ws)
    .filter((key) => !key.startsWith('!'))
    .map((key) => ({ key, cell: XLSX.utils.decode_cell(key) }))
    .filter(({ cell }) => cell.r >= startIndex)
    .sort((a, b) => b.cell.r - a.cell.r || b.cell.c - a.cell.c)
    .forEach(({ key, cell }) => {
      const nextAddress = XLSX.utils.encode_cell({ r: cell.r + count, c: cell.c });
      ws[nextAddress] = ws[key];
      delete ws[key];
    });

  if (Array.isArray(ws['!rows'])) {
    for (let index = ws['!rows'].length - 1; index >= startIndex; index -= 1) {
      ws['!rows'][index + count] = ws['!rows'][index];
    }
    const templateMeta = ws['!rows'][templateIndex] ? { ...ws['!rows'][templateIndex] } : undefined;
    for (let offset = 0; offset < count; offset += 1) ws['!rows'][startIndex + offset] = templateMeta;
  }

  ws['!merges'] = (ws['!merges'] || []).map((merge) => {
    const shifted = cloneMerge(merge);
    if (shifted.s.r >= startIndex) {
      shifted.s.r += count;
      shifted.e.r += count;
    } else if (shifted.e.r >= startIndex) {
      shifted.e.r += count;
    }
    return shifted;
  });

  for (let offset = 0; offset < count; offset += 1) {
    const targetRow = startIndex + offset;
    for (let col = startCol; col <= endCol; col += 1) {
      const sourceAddress = XLSX.utils.encode_cell({ r: templateIndex, c: col });
      const targetAddress = XLSX.utils.encode_cell({ r: targetRow, c: col });
      ws[targetAddress] = cloneCellShell(ws[sourceAddress]);
    }
    templateMerges.forEach((merge) => {
      const shifted = cloneMerge(merge);
      const rowDelta = targetRow - templateIndex;
      shifted.s.r += rowDelta;
      shifted.e.r += rowDelta;
      ws['!merges'].push(shifted);
    });
  }

  if (ws['!ref']) {
    const range = XLSX.utils.decode_range(ws['!ref']);
    if (range.e.r >= startIndex) range.e.r += count;
    if (range.s.r >= startIndex) range.s.r += count;
    ws['!ref'] = XLSX.utils.encode_range(range);
  }
}

function fallbackWorkingMinutesWorkbook(context) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(workingMinutesRows(context)), WORKING_MINUTES_SHEET_NAME);
  return wb;
}

function removeExternalWorkbookFormulas(workbook) {
  let removed = 0;
  for (const sheetName of workbook.SheetNames || []) {
    const worksheet = workbook.Sheets[sheetName];
    for (const [address, cell] of Object.entries(worksheet || {})) {
      if (address.startsWith('!') || !cell?.f || !/\[[0-9]+\][^!]+!/.test(String(cell.f))) continue;
      delete cell.f;
      cell.v = cell.v == null ? '' : cell.v;
      cell.t = typeof cell.v === 'number' ? 'n' : 's';
      delete cell.w;
      removed += 1;
    }
  }
  return removed;
}

function buildWorkingMinutesWorkbook(context) {
  const templatePath = officialWorkingMinutesTemplatePath();
  if (!templatePath) return fallbackWorkingMinutesWorkbook(context);

  const wb = XLSX.readFile(templatePath, { cellStyles: true, cellFormula: true, cellDates: true });
  removeExternalWorkbookFormulas(wb);
  const sheetName = wb.SheetNames.includes(WORKING_MINUTES_SHEET_NAME) ? WORKING_MINUTES_SHEET_NAME : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return fallbackWorkingMinutesWorkbook(context);

  const doc4 = context.doc4;
  const participants = doc4.participants.rows || [];
  const findings = doc4.nonconformity_summary || [];
  const participantExtraRows = Math.max(0, participants.length - 6);
  insertWorksheetRows(ws, 31, participantExtraRows, 30);
  const nonconformityExtraRows = Math.max(0, findings.length - 11);
  insertWorksheetRows(ws, 48 + participantExtraRows, nonconformityExtraRows, 47 + participantExtraRows);

  const rowOffset = participantExtraRows;
  const signatureRow = 48 + participantExtraRows + nonconformityExtraRows;
  const teamMembers = doc4.related_information.evaluator_list || [];
  const teamRows = [
    teamMembers[0] || '',
    teamMembers[1] || '',
    teamMembers.slice(2).join(', '),
  ];

  setCellValue(ws, 'G2', context.report_label || 'Biên bản làm việc với NCC');
  setCellValue(ws, 'G4', doc4.related_information.report_no || '');
  setCellValue(ws, 'P4', formatDate(doc4.related_information.evaluation_date || ''));
  teamRows.forEach((member, index) => setCellValue(ws, `C${8 + index}`, member));
  setCellValue(ws, 'C12', [doc4.related_information.supplier_name, doc4.related_information.supplier_code].filter(Boolean).join(' - '));
  setCellValue(ws, 'C13', doc4.related_information.evaluation_address || '');
  setCellValue(ws, 'C14', doc4.related_information.linked_evaluation_address || '');
  setCellValue(ws, 'C17', doc4.scope.product || '');
  setCellValue(ws, 'C18', doc4.scope.product_group || '');
  setCellValue(ws, 'C19', doc4.scope.business_type || '');
  setCellValue(ws, 'C20', doc4.scope.evaluation_type || doc4.scope.method || '');

  const participantRowCount = Math.max(6, participants.length);
  for (let index = 0; index < participantRowCount; index += 1) {
    const sheetRow = 25 + index;
    const row = participants[index] || {};
    setCellValue(ws, `B${sheetRow}`, `${index + 1}.`);
    setCellValue(ws, `C${sheetRow}`, participantDisplayName(row));
    setCellValue(ws, `L${sheetRow}`, row.opening ? '√' : '');
    setCellValue(ws, `O${sheetRow}`, row.closing ? '√' : '');
  }

  setCellValue(ws, `B${33 + rowOffset}`, supplierIntroductionText(doc4));

  const findingRowCount = Math.max(11, findings.length);
  for (let index = 0; index < findingRowCount; index += 1) {
    const sheetRow = 37 + rowOffset + index;
    const row = findings[index] || {};
    setCellValue(ws, `B${sheetRow}`, index + 1);
    setCellValue(ws, `C${sheetRow}`, [row.clause, row.requirement].filter(Boolean).join(' - '));
    setCellValue(ws, `D${sheetRow}`, row.description || '');
    setCellValue(ws, `L${sheetRow}`, row.corrective_action || '');
    setCellValue(ws, `P${sheetRow}`, formatDate(row.due_date || ''));
  }

  setCellValue(ws, `B${signatureRow}`, `Đánh giá viên:\n${doc4.signatures.evaluator || doc4.related_information.evaluators || ''}`);
  setCellValue(ws, `L${signatureRow}`, `Ngày: ${formatDate(doc4.signatures.approval_date || '')}\nĐại diện Nhà cung cấp\n\n${doc4.signatures.supplier_representative || ''}`);

  if (sheetName !== WORKING_MINUTES_SHEET_NAME && WORKING_MINUTES_SHEET_NAME.length <= 31) {
    wb.Sheets[WORKING_MINUTES_SHEET_NAME] = ws;
    wb.SheetNames[wb.SheetNames.indexOf(sheetName)] = WORKING_MINUTES_SHEET_NAME;
    delete wb.Sheets[sheetName];
  }
  return wb;
}

function renderInternalReportHtml(context) {
  const doc4 = context.doc4;
  const complianceRows = complianceRowsForReport(doc4.compliance_summary);
  const totalCounts = complianceRows.reduce((acc, row) => ({
    A: acc.A + scoreCount(row, 'A'),
    B: acc.B + scoreCount(row, 'B'),
    C: acc.C + scoreCount(row, 'C'),
    D: acc.D + scoreCount(row, 'D'),
  }), { A: 0, B: 0, C: 0, D: 0 });
  const complianceTableRows = complianceRows.map((row, index) => `
    <tr>
      <td class="center">${index + 1}</td>
      <td>${htmlEscape(row.label)}</td>
      <td class="center">${scoreCount(row, 'A')}</td>
      <td class="center">${scoreCount(row, 'B')}</td>
      <td class="center">${scoreCount(row, 'C')}</td>
      <td class="center">${scoreCount(row, 'D')}</td>
      <td class="center">${formatPercent(row.percentage)}</td>
    </tr>`).join('');
  const nonconformityRows = Array.from({ length: Math.max(11, doc4.nonconformity_summary.length) }, (_, index) => {
    const row = doc4.nonconformity_summary[index] || {};
    return `
    <tr>
      <td class="center">${index + 1}</td>
      <td>${htmlEscape(row.clause || '')}</td>
      <td>${htmlEscape(row.description || '')}</td>
      <td>${htmlEscape(row.corrective_action || '')}</td>
      <td>${htmlEscape(formatDate(row.due_date || ''))}</td>
    </tr>`;
  }).join('');
  const participantRows = participantRowsForInternalHtml(doc4.participants.rows || [], 6);
  const finalResult = context.report_type === 'ROUND2_RESULT'
    ? (doc4.result_summary.final_conclusion || doc4.result_summary.final_result_label || '')
    : (doc4.result_summary.final_result_label || doc4.result_summary.final_conclusion || '');
  const finalScore = doc4.result_summary.final_score_percent || '';
  const conclusionLabel = context.report_type === 'ROUND1_RESULT'
    ? 'Kết luận lần 1'
    : (context.report_type === 'ROUND2_RESULT' ? 'Kết luận cuối cùng' : 'Kết luận');
  const supplierIntro = supplierIntroductionText(doc4);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(doc4.related_information.report_no)} - ${htmlEscape(context.report_label || 'Kết quả đánh giá')}</title>
<style>
*{box-sizing:border-box}
html,body{width:100%;min-height:100%}
body{font-family:"Times New Roman",Times,serif;color:#000;margin:0;background:#fff;font-size:13px;line-height:1.22}
.no-print{position:fixed;right:24px;top:24px;z-index:10;border:1px solid #111;background:#fff;padding:8px 14px;font-family:Arial,sans-serif;cursor:pointer}
.sheet{width:960px;max-width:calc(100vw - 32px);margin:18px auto;background:#fff;border:1px solid #000;padding-bottom:0}
.header{display:grid;grid-template-columns:78mm 1fr;border-bottom:1px solid #000;min-height:15mm;background:#fff}
.brand{border-right:1px solid #000;display:flex;align-items:center;justify-content:center;padding:2mm 6mm;white-space:nowrap}
.brand .win{font-family:Arial,sans-serif;font-size:30px;font-weight:800;color:#f31325;letter-spacing:-1px}
.brand .commerce{font-family:Arial,sans-serif;font-size:27px;font-weight:700;color:#c99438;letter-spacing:-.5px}
.title{display:flex;align-items:center;justify-content:center;text-align:center;font-size:21px;font-weight:700;text-transform:uppercase;padding:0 6mm}
.top-meta{display:grid;grid-template-columns:1fr 1fr;padding:7mm 3mm 5mm}
.top-meta .right{text-align:right}.top-meta .value-line{width:115px;margin-left:8px}
.section-title{min-height:8mm;display:flex;align-items:center;justify-content:center;text-align:center;border-top:1px solid #000;border-bottom:1px solid #000;background:#dceaf6;font-weight:700;text-transform:uppercase;padding:1mm 3mm;break-after:avoid}
.block{padding:0 3mm}.block.spaced{padding-top:4mm;padding-bottom:5mm}
.field-row{display:grid;grid-template-columns:38mm minmax(0,1fr);align-items:end;min-height:6mm}
.field-label{white-space:nowrap}.value-line{display:inline-block;min-height:18px;width:100%;padding:0 4px;background:transparent}
.field-row .value-line{display:block}.muted-fill{background:transparent}
.evaluator-lines{padding-top:1px}.evaluator-lines .field-row{grid-template-columns:34px 1fr}
.two-column-note{min-height:22mm;padding:7mm 3mm 3mm;white-space:pre-line;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;border-spacing:0;table-layout:fixed;page-break-inside:auto}th,td{border:1px solid #000;padding:1.5mm 1.2mm;vertical-align:middle;overflow-wrap:anywhere;word-break:normal}th{font-weight:700}.blue th,.blue td{background:#dceaf6}
tr{break-inside:avoid;page-break-inside:avoid}
.center{text-align:center}.line-fill{flex:1}.participant-tick{font-weight:700}
.participants th{height:10mm}.participants td{height:24px}.participants .no-col{width:36px}.participants .name-col{width:59%}.participants .meet-col{width:20.5%}
.overview{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(72mm,.85fr);border-bottom:1px solid #000;break-inside:avoid-page}.overview-left{border-right:1px solid #000;min-width:0}.overview table th,.overview table td{height:8mm}.overview .result-area{min-height:50mm;border-top:0;padding:3mm 2mm}
.note-box{height:18mm;background:#fde2d3;margin:9mm 8mm 3mm}
.chart-wrap{min-height:60mm;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #000;padding:3mm;overflow:visible}.radar{display:block;width:58mm;max-width:100%;height:auto;overflow:visible}.radar-label{font-size:12px}.radar-tick{font-size:11px}
.legend{padding:3mm 2mm 0}.legend p{margin:0 0 3mm}.legend-row{display:grid;grid-template-columns:8mm minmax(0,1fr);gap:1mm;margin:0 0 4mm}
.nonconformity th{height:8mm}.nonconformity td{min-height:8mm;vertical-align:top}
.signatures{display:grid;grid-template-columns:1fr 1fr;min-height:32mm;text-align:center;font-weight:700;padding-top:2mm;break-inside:avoid}
.supplier-sign{display:grid;grid-template-rows:20px 22px 1fr}
@media print{body{background:#fff;font-size:12px}.sheet{margin:0;width:100%;max-width:none;border:1px solid #000}.no-print{display:none}.section-title{break-after:avoid}.overview{break-inside:avoid-page}.radar{width:54mm}@page{size:A4 landscape;margin:8mm}}
</style></head><body>
<button class="no-print" onclick="window.print()">Print</button>
<main class="sheet">
  <header class="header">
    <div class="brand"><span class="win">Win</span><span class="commerce">Commerce</span></div>
    <div class="title">${htmlEscape(context.report_label || 'KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP')}</div>
  </header>
  <section class="top-meta">
    <div>Số: ${valueLine(doc4.related_information.report_no, 'muted-fill')}</div>
    <div class="right">Ngày đánh giá ${valueLine(formatDate(doc4.related_information.evaluation_date), 'muted-fill')}</div>
  </section>
  <div class="section-title">THÔNG TIN LIÊN QUAN</div>
  <section class="block">
    <div>Đánh giá viên:</div>
    <div class="evaluator-lines">
      ${fieldRow('1.', doc4.related_information.evaluators)}
      ${fieldRow('2.', '')}
      ${fieldRow('3.', '')}
    </div>
  </section>
  <section class="block spaced">
    ${fieldRow('Nhà cung cấp', doc4.related_information.supplier_name)}
    ${fieldRow('Địa chỉ đánh giá', doc4.related_information.evaluation_address)}
    ${fieldRow('Địa chỉ liên kết đánh giá', doc4.related_information.linked_evaluation_address)}
  </section>
  <div class="section-title">PHẠM VI ĐÁNH GIÁ</div>
  <section class="block spaced">
    ${fieldRow('Sản phẩm', doc4.scope.product || doc4.scope.product_group)}
    ${fieldRow('Nhóm sản phẩm', doc4.scope.product_group)}
    ${fieldRow('Loại hình nhà cung cấp', doc4.scope.business_type)}
    ${fieldRow('Loại đánh giá', doc4.scope.evaluation_type || doc4.scope.method)}
  </section>
  <div class="section-title">THÀNH PHẦN THAM DỰ</div>
  <table class="participants">
    <thead>
      <tr class="blue"><th class="no-col"></th><th class="name-col" rowspan="2">Tên/Chức danh</th><th colspan="2">Tham dự (√)</th></tr>
      <tr class="blue"><th></th><th class="meet-col">Họp khai mạc</th><th class="meet-col">Họp bế mạc</th></tr>
    </thead>
    <tbody>${participantRows}</tbody>
  </table>
  <div class="section-title">GIỚI THIỆU NHÀ CUNG CẤP</div>
  <section class="two-column-note">${htmlEscape(supplierIntro)}</section>
  <div class="section-title">TỔNG QUAN VỀ VIỆC THỰC HIỆN CÁC YÊU CẦU TIÊU CHUẨN</div>
  <section class="overview">
    <div class="overview-left">
      <table>
        <thead><tr><th style="width:36px">TT</th><th>HẠNG MỤC</th><th style="width:66px">A</th><th style="width:66px">B</th><th style="width:66px">C</th><th style="width:66px">D</th><th style="width:74px">Tỷ lệ (%)</th></tr></thead>
        <tbody>
          ${complianceTableRows}
          <tr><td class="center">Loại</td><td>Điều khoản 1.1</td><td colspan="4"></td><td class="center">Đầy đủ</td></tr>
          <tr><td colspan="2">Tổng kết:</td><td class="center">${totalCounts.A}</td><td class="center">${totalCounts.B}</td><td class="center">${totalCounts.C}</td><td class="center">${totalCounts.D}</td><td></td></tr>
        </tbody>
      </table>
      <div class="result-area">
        <p><strong>Kết quả (% tuân thủ)</strong> ${htmlEscape(finalScore)}</p>
        <p style="margin-top:34px"><strong>${htmlEscape(conclusionLabel)}:</strong> ${htmlEscape(finalResult)}</p>
        <div class="note-box"></div>
      </div>
    </div>
    <div>
      <div class="chart-wrap">${renderRadarChart(complianceRows)}</div>
      <div class="legend">
        <p><strong><u>Ghi chú:</u></strong></p>
        <p><strong>Nguyên tắc đánh giá:</strong></p>
        <div class="legend-row"><span>*</span><span>&lt; 60% tổng điểm --&gt; Không đạt</span></div>
        <div class="legend-row"><span>*</span><span>60% - 75% điểm --&gt; Đạt mức cơ bản, đánh giá lại sau 6 tháng</span></div>
        <div class="legend-row"><span>*</span><span>&gt;75% - 90% điểm --&gt; Đạt mức khá, đánh giá lại sau 1 năm</span></div>
        <div class="legend-row"><span>*</span><span>&gt; 90% điểm --&gt; Đạt mức cao</span></div>
      </div>
    </div>
  </section>
  <div class="section-title">TỔNG KẾT NHỮNG ĐIỂM KHÔNG PHÙ HỢP</div>
  <table class="nonconformity">
    <thead><tr class="blue"><th style="width:36px">TT</th><th style="width:114px">Điều khoản</th><th>Mô tả điểm không phù hợp</th><th style="width:320px">Hành động khắc phục</th><th style="width:168px">Thời hạn thực hiện</th></tr></thead>
    <tbody>${nonconformityRows}</tbody>
  </table>
  <section class="signatures">
    <div>Đánh giá viên:<br>${htmlEscape(doc4.signatures.evaluator)}</div>
    <div class="supplier-sign"><span>Ngày: ${htmlEscape(formatDate(doc4.signatures.approval_date))}</span><span>Đại diện Nhà cung cấp</span><span>${htmlEscape(doc4.signatures.supplier_representative)}</span></div>
  </section>
</main>
</body></html>`;
}

function renderTemplatePdfHtml({ title, body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
body{font-family:Arial,"Segoe UI",sans-serif;color:#111827;margin:0;line-height:1.45;font-size:12px}
h1{font-size:20px;margin:0 0 12px}
.meta{color:#4b5563;margin-bottom:16px}
.body{white-space:pre-wrap;font-family:Arial,"Segoe UI",sans-serif;border-top:1px solid #d1d5db;padding-top:12px}
@page{size:A4;margin:14mm 12mm}
</style></head><body>
<h1>${htmlEscape(title)}</h1>
<div class="meta">QLCL report export</div>
<div class="body">${htmlEscape(body)}</div>
</body></html>`;
}

function createPdfBufferFromHtml(html) {
  return execFileSync(process.execPath, [
    path.resolve(__dirname, 'renderPdfWithPlaywright.js'),
    '-',
    '-',
  ], {
    input: html,
    maxBuffer: PDF_RENDER_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function renderHtmlForReport(context) {
  return context.report_definition.renderer === 'workingMinutes'
    ? renderWorkingMinutesHtml(context)
    : renderInternalReportHtml(context);
}

function exportReportHtml(db, { ticket, template, exportedBy, reportType, roundNo, legacyCompatibility = false }) {
  const alias = resolveReportAlias(reportType || template?.report_type || 'INTERNAL', { roundNo });
  const finalReportType = alias.canonical_code || alias.legacy_source || 'INTERNAL';
  if (!legacyCompatibility && ['WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT'].includes(finalReportType)) {
    return require('../reporting/canonicalReportExports').exportCanonicalReport(db, {
      ticket, definitionCode: finalReportType, format: 'HTML', exportedBy, roundNo,
      legacySource: alias.legacy_source, legacyAliasVersion: alias.mapping_version,
    });
  }
  const context = buildReportContext(db, ticket, { reportType: finalReportType, roundNo });
  const fileName = safeExportName({ ticket_code: context.assessment_code || ticket.ticket_code }, finalReportType, 'html');
  const buffer = Buffer.from(renderHtmlForReport(context), 'utf8');
  const record = recordReportExport(db, {
    ticket,
    round: context.selected_round,
    template,
    reportType: finalReportType,
    fileFormat: 'HTML',
    fileName,
    exportedBy,
    alias,
  });
  return reportArtifact(record, { fileName, contentType: 'text/html; charset=utf-8', buffer });
}

function exportReportXlsx(db, { ticket, template, exportedBy, reportType, roundNo, legacyCompatibility = false }) {
  const alias = resolveReportAlias(reportType || template?.report_type || 'INTERNAL', { roundNo });
  const finalReportType = alias.canonical_code || alias.legacy_source || 'INTERNAL';
  if (!legacyCompatibility && ['WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT'].includes(finalReportType)) {
    return require('../reporting/canonicalReportExports').exportCanonicalReport(db, {
      ticket, definitionCode: finalReportType, format: 'XLSX', exportedBy, roundNo,
      legacySource: alias.legacy_source, legacyAliasVersion: alias.mapping_version,
    });
  }
  const context = buildReportContext(db, ticket, { reportType: finalReportType, roundNo });
  const wb = context.report_definition.renderer === 'workingMinutes' ? buildWorkingMinutesWorkbook(context) : XLSX.utils.book_new();
  if (context.report_definition.renderer === 'workingMinutes') {
    if (!wb.SheetNames.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(workingMinutesRows(context)), WORKING_MINUTES_SHEET_NAME);
  } else {
    const inputRows = [['Column', 'DOC-4 label', 'Value']].concat(
      Object.entries(context.doc4.input_columns).map(([col, item]) => [col, item.label, item.value])
    );
    const inputSheet = XLSX.utils.aoa_to_sheet(inputRows);
    styleDoc4InputWorksheet(inputSheet);
    XLSX.utils.book_append_sheet(wb, inputSheet, '1. Nhap data');
    const resultRows = doc4ResultRows(context);
    const resultSheet = XLSX.utils.aoa_to_sheet(resultRows);
    styleDoc4ResultWorksheet(resultSheet, resultRows);
    XLSX.utils.book_append_sheet(wb, resultSheet, '2. Ket qua');
  }
  const fileName = safeExportName({ ticket_code: context.assessment_code || ticket.ticket_code }, finalReportType, 'xlsx');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const record = recordReportExport(db, {
    ticket,
    round: context.selected_round,
    template,
    reportType: finalReportType,
    fileFormat: 'XLSX',
    fileName,
    exportedBy,
    alias,
  });
  return reportArtifact(record, {
    fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
}

function exportReportPdf(db, { ticket, template, exportedBy, reportType, roundNo, legacyCompatibility = false }) {
  const alias = resolveReportAlias(reportType || template?.report_type || 'INTERNAL', { roundNo });
  const finalReportType = alias.canonical_code || alias.legacy_source || 'INTERNAL';
  if (!legacyCompatibility && ['WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT'].includes(finalReportType)) {
    return require('../reporting/canonicalReportExports').exportCanonicalReport(db, {
      ticket, definitionCode: finalReportType, format: 'PDF', exportedBy, roundNo,
      legacySource: alias.legacy_source, legacyAliasVersion: alias.mapping_version,
    });
  }
  const variables = buildReportContext(db, ticket, { reportType: finalReportType, roundNo });
  const fileName = safeExportName({ ticket_code: variables.assessment_code || ticket.ticket_code }, finalReportType, 'pdf');
  let buffer;
  if (variables.report_definition.renderer === 'result' || variables.report_definition.renderer === 'workingMinutes') {
    buffer = createPdfBufferFromHtml(renderHtmlForReport(variables));
  } else {
    const body = renderTemplate(template.template_body, variables);
    buffer = createPdfBufferFromHtml(renderTemplatePdfHtml({
      title: `${variables.report_label} - ${variables.assessment_code || ticket.ticket_code}`,
      body,
    }));
  }
  const record = recordReportExport(db, {
    ticket,
    round: variables.selected_round,
    template,
    reportType: finalReportType,
    fileFormat: 'PDF',
    fileName,
    exportedBy,
    alias,
  });
  return reportArtifact(record, { fileName, contentType: 'application/pdf', buffer });
}

function ensureDefaultReportTemplates(db) {
  const insert = db.prepare(`
    INSERT INTO report_templates (template_name, report_type, template_body, active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(template_name, report_type) DO NOTHING
  `);
  const legacyInternalBody = [
    'PHIEU KET QUA DANH GIA NCC - INTERNAL',
    'Ticket: {{ticket_code}}',
    'Supplier: {{supplier_name}} ({{supplier_code}})',
    'Tax code: {{tax_code}}',
    'Address: {{address}}',
    'Evaluation date: {{evaluation_date}}',
    'Result: {{evaluation_result}}',
    'Score: {{score_percent}}',
    'Classification: {{classification}}',
    '',
    'Detailed scoring:',
    '{{detailed_scoring}}',
    '',
    'Nonconformities:',
    '{{nonconformities}}',
    '',
    'Corrective actions:',
    '{{corrective_actions}}',
    '',
    'Approval history:',
    '{{approval_history}}',
    'Approved by: {{approved_by}} at {{approval_date}}',
  ].join('\n');
  const legacyWorkingMinutesBody = [
    'BIEN BAN LAM VIEC VOI NCC',
    'Report no: {{assessment_code}}',
    'Assessment date: {{evaluation_date}}',
    'Supplier: {{supplier_name}} ({{supplier_code}})',
    'Address: {{address}}',
    '',
    'Participants:',
    '{{participants_table}}',
    '',
    'Supplier introduction:',
    '{{supplier_introduction}}',
    '',
    'Nonconformities:',
    '{{working_minutes_nonconformities}}',
  ].join('\n');
  const legacyRound1Body = [
    'PHIEU KET QUA DANH GIA NCC - LAN 1',
    'Ticket: {{ticket_code}}',
    'Supplier: {{supplier_name}} ({{supplier_code}})',
    'Tax code: {{tax_code}}',
    'Address: {{address}}',
    'Evaluation date: {{evaluation_date}}',
    'Result: {{evaluation_result}}',
    'Score: {{score_percent}}',
    'Classification: {{classification}}',
    'Round 1 conclusion: {{round_1_conclusion}}',
    '',
    'Participants:',
    '{{participants_table}}',
    '',
    'Detailed scoring:',
    '{{detailed_scoring}}',
    '',
    'Nonconformities:',
    '{{nonconformities}}',
    '',
    'Corrective actions:',
    '{{corrective_actions}}',
    '',
    'Approval history:',
    '{{approval_history}}',
    'Approved by: {{approved_by}} at {{approval_date}}',
  ].join('\n');
  const legacyRound2Body = [
    'PHIEU KET QUA DANH GIA NCC - LAN 2',
    'Ticket: {{ticket_code}}',
    'Supplier: {{supplier_name}} ({{supplier_code}})',
    'Tax code: {{tax_code}}',
    'Address: {{address}}',
    'Evaluation date: {{evaluation_date}}',
    'Result: {{evaluation_result}}',
    'Score: {{score_percent}}',
    'Classification: {{classification}}',
    'Final conclusion: {{final_conclusion}}',
    '',
    'Participants:',
    '{{participants_table}}',
    '',
    'Detailed scoring:',
    '{{detailed_scoring}}',
    '',
    'Nonconformities:',
    '{{nonconformities}}',
    '',
    'Corrective actions:',
    '{{corrective_actions}}',
    '',
    'Approval history:',
    '{{approval_history}}',
    'Approved by: {{approved_by}} at {{approval_date}}',
  ].join('\n');
  const reportCopy = Object.freeze({
    internalTitle: 'PHIẾU KẾT QUẢ ĐÁNH GIÁ NCC - NỘI BỘ',
    nccTitle: 'BIÊN BẢN / KẾT QUẢ LÀM VIỆC VỚI NCC',
    workingMinutesTitle: 'BIÊN BẢN LÀM VIỆC VỚI NCC',
    round1Title: 'PHIẾU KẾT QUẢ ĐÁNH GIÁ NCC - LẦN 1',
    round2Title: 'PHIẾU KẾT QUẢ ĐÁNH GIÁ NCC - LẦN 2',
    ticket: 'Phiếu',
    reportNo: 'Số báo cáo',
    supplier: 'NCC',
    taxCode: 'Mã số thuế',
    address: 'Địa chỉ',
    evaluationDate: 'Ngày đánh giá',
    assessmentDate: 'Ngày đánh giá',
    result: 'Kết quả',
    score: 'Điểm',
    classification: 'Phân hạng',
    conclusion: 'Kết luận',
    round1Conclusion: 'Kết luận lần 1',
    finalConclusion: 'Kết luận cuối cùng',
    participants: 'Thành phần tham dự',
    detailedScoring: 'Chi tiết chấm điểm',
    nonconformities: 'Điểm không phù hợp',
    correctiveActions: 'Yêu cầu khắc phục',
    approvalHistory: 'Lịch sử phê duyệt',
    approvedBy: 'Phê duyệt bởi',
    issuesRequiringAction: 'Điểm cần khắc phục',
    requiredCorrectiveActions: 'Yêu cầu khắc phục',
    supplierIntroduction: 'Giới thiệu NCC',
  });
  const reportLine = (label, value) => `${label}: ${value}`;
  const internalBody = [
    reportCopy.internalTitle,
    reportLine(reportCopy.ticket, '{{ticket_code}}'),
    reportLine(reportCopy.supplier, '{{supplier_name}} ({{supplier_code}})'),
    reportLine(reportCopy.taxCode, '{{tax_code}}'),
    reportLine(reportCopy.address, '{{address}}'),
    reportLine(reportCopy.evaluationDate, '{{evaluation_date}}'),
    reportLine(reportCopy.result, '{{evaluation_result}}'),
    reportLine(reportCopy.score, '{{score_percent}}'),
    reportLine(reportCopy.classification, '{{classification}}'),
    '',
    reportCopy.participants + ':',
    '{{participants_table}}',
    '',
    reportCopy.detailedScoring + ':',
    '{{detailed_scoring}}',
    '',
    reportCopy.nonconformities + ':',
    '{{nonconformities}}',
    '',
    reportCopy.correctiveActions + ':',
    '{{corrective_actions}}',
    '',
    reportCopy.approvalHistory + ':',
    '{{approval_history}}',
    reportLine(reportCopy.approvedBy, '{{approved_by}} - {{approval_date}}'),
  ].join('\n');
  const legacyNccBody = [
    'BIEN BAN / KET QUA LAM VIEC VOI NCC',
    'Ticket: {{ticket_code}}',
    'Supplier: {{supplier_name}} ({{supplier_code}})',
    'Tax code: {{tax_code}}',
    'Address: {{address}}',
    'Evaluation date: {{evaluation_date}}',
    'Conclusion: {{evaluation_result}}',
    '',
    'Issues requiring corrective action:',
    '{{nonconformities}}',
    '',
    'Required corrective actions:',
    '{{corrective_actions}}',
    '',
    'Approved by: {{approved_by}} at {{approval_date}}',
  ].join('\n');
  const nccBody = [
    reportCopy.nccTitle,
    reportLine(reportCopy.ticket, '{{ticket_code}}'),
    reportLine(reportCopy.supplier, '{{supplier_name}} ({{supplier_code}})'),
    reportLine(reportCopy.taxCode, '{{tax_code}}'),
    reportLine(reportCopy.address, '{{address}}'),
    reportLine(reportCopy.evaluationDate, '{{evaluation_date}}'),
    reportLine(reportCopy.conclusion, '{{evaluation_result}}'),
    '',
    reportCopy.participants + ':',
    '{{participants_table}}',
    '',
    reportCopy.supplierIntroduction + ':',
    '{{supplier_introduction}}',
    '',
    reportCopy.issuesRequiringAction + ':',
    '{{nonconformities}}',
    '',
    reportCopy.requiredCorrectiveActions + ':',
    '{{corrective_actions}}',
    '',
    reportLine(reportCopy.approvedBy, '{{approved_by}} - {{approval_date}}'),
  ].join('\n');
  const workingMinutesBody = [
    reportCopy.workingMinutesTitle,
    reportLine(reportCopy.reportNo, '{{assessment_code}}'),
    reportLine(reportCopy.assessmentDate, '{{evaluation_date}}'),
    reportLine(reportCopy.supplier, '{{supplier_name}} ({{supplier_code}})'),
    reportLine(reportCopy.address, '{{address}}'),
    '',
    reportCopy.participants + ':',
    '{{participants_table}}',
    '',
    reportCopy.supplierIntroduction + ':',
    '{{supplier_introduction}}',
    '',
    reportCopy.nonconformities + ':',
    '{{working_minutes_nonconformities}}',
  ].join('\n');
  const round1Body = [
    reportCopy.round1Title,
    reportLine(reportCopy.ticket, '{{ticket_code}}'),
    reportLine(reportCopy.supplier, '{{supplier_name}} ({{supplier_code}})'),
    reportLine(reportCopy.taxCode, '{{tax_code}}'),
    reportLine(reportCopy.address, '{{address}}'),
    reportLine(reportCopy.evaluationDate, '{{evaluation_date}}'),
    reportLine(reportCopy.result, '{{evaluation_result}}'),
    reportLine(reportCopy.score, '{{score_percent}}'),
    reportLine(reportCopy.classification, '{{classification}}'),
    reportLine(reportCopy.round1Conclusion, '{{round_1_conclusion}}'),
    '',
    reportCopy.participants + ':',
    '{{participants_table}}',
    '',
    reportCopy.supplierIntroduction + ':',
    '{{supplier_introduction}}',
    '',
    reportCopy.detailedScoring + ':',
    '{{detailed_scoring}}',
    '',
    reportCopy.nonconformities + ':',
    '{{nonconformities}}',
    '',
    reportCopy.correctiveActions + ':',
    '{{corrective_actions}}',
    '',
    reportCopy.approvalHistory + ':',
    '{{approval_history}}',
    reportLine(reportCopy.approvedBy, '{{approved_by}} - {{approval_date}}'),
  ].join('\n');
  const round2Body = [
    reportCopy.round2Title,
    reportLine(reportCopy.ticket, '{{ticket_code}}'),
    reportLine(reportCopy.supplier, '{{supplier_name}} ({{supplier_code}})'),
    reportLine(reportCopy.taxCode, '{{tax_code}}'),
    reportLine(reportCopy.address, '{{address}}'),
    reportLine(reportCopy.evaluationDate, '{{evaluation_date}}'),
    reportLine(reportCopy.result, '{{evaluation_result}}'),
    reportLine(reportCopy.score, '{{score_percent}}'),
    reportLine(reportCopy.classification, '{{classification}}'),
    reportLine(reportCopy.finalConclusion, '{{final_conclusion}}'),
    '',
    reportCopy.participants + ':',
    '{{participants_table}}',
    '',
    reportCopy.supplierIntroduction + ':',
    '{{supplier_introduction}}',
    '',
    reportCopy.detailedScoring + ':',
    '{{detailed_scoring}}',
    '',
    reportCopy.nonconformities + ':',
    '{{nonconformities}}',
    '',
    reportCopy.correctiveActions + ':',
    '{{corrective_actions}}',
    '',
    reportCopy.approvalHistory + ':',
    '{{approval_history}}',
    reportLine(reportCopy.approvedBy, '{{approved_by}} - {{approval_date}}'),
  ].join('\n');
  insert.run('Internal evaluation result', 'INTERNAL', internalBody);
  insert.run('NCC working minutes', 'NCC', nccBody);
  insert.run('Biên bản làm việc với NCC', 'WORKING_MINUTES', workingMinutesBody);
  insert.run('Kết quả đánh giá lần 1', 'ROUND1_RESULT', round1Body);
  insert.run('Kết quả đánh giá lần 2', 'ROUND2_RESULT', round2Body);
  const migrateUntouchedDefault = db.prepare(`
    UPDATE report_templates
    SET template_body = ?, updated_at = datetime('now')
    WHERE template_name = ? AND report_type = ? AND template_body = ?
  `);
  migrateUntouchedDefault.run(internalBody, 'Internal evaluation result', 'INTERNAL', legacyInternalBody);
  migrateUntouchedDefault.run(nccBody, 'NCC working minutes', 'NCC', legacyNccBody);
  migrateUntouchedDefault.run(workingMinutesBody, 'Biên bản làm việc với NCC', 'WORKING_MINUTES', legacyWorkingMinutesBody);
  migrateUntouchedDefault.run(round1Body, 'Kết quả đánh giá lần 1', 'ROUND1_RESULT', legacyRound1Body);
  migrateUntouchedDefault.run(round2Body, 'Kết quả đánh giá lần 2', 'ROUND2_RESULT', legacyRound2Body);
}

module.exports = {
  EXPORT_DIR,
  REPORT_TYPE_CODES,
  buildReportContext,
  calculateNextEvaluationDate,
  computeCategorySummary,
  ensureDefaultReportTemplates,
  exportReportHtml,
  exportReportPdf,
  exportReportXlsx,
  isAllowedReportType,
  normalizeReportType,
  reportDefinitionFor,
  renderInternalReportHtml,
  renderReportHtml,
  renderWorkingMinutesHtml,
  renderTemplate,
};
