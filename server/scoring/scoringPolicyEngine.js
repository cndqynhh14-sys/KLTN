'use strict';

const crypto = require('node:crypto');

const RESULT_LABELS = Object.freeze({
  FAIL: 'Không đạt',
  BASIC_PASS: 'Đạt mức cơ bản, đánh giá lại sau 6 tháng',
  GOOD_PASS: 'Đạt mức khá, đánh giá lại sau 1 năm',
  HIGH_PASS: 'Đạt mức cao',
});

const CATEGORY_CODES_BY_LABEL = Object.freeze({
  'Hồ sơ pháp lý': 'LEGAL_RECORDS',
  'Kiểm soát ATVSTP': 'FOOD_SAFETY_CONTROL',
  'Kiểm soát chất lượng': 'QUALITY_CONTROL',
  'Kiểm soát chất lượng sản phẩm': 'PRODUCT_QUALITY_CONTROL',
  'Truy xuất nguồn gốc': 'TRACEABILITY',
});

function categoryCodeForLabel(label) {
  return CATEGORY_CODES_BY_LABEL[String(label || '').trim()] || null;
}

const GOLDEN_V1_DEFINITION = Object.freeze({
  schema_version: 1,
  policy_code: 'LEGACY_RULES',
  policy_name: 'Quy tắc chấm điểm tương thích v1',
  grades: {
    A: { label: 'A', passed: true, next_evaluation_months: 24 },
    B: { label: 'B', passed: true, next_evaluation_months: 12 },
    C: { label: 'C', passed: true, next_evaluation_months: 6 },
    D: { label: 'D', passed: false, next_evaluation_months: null },
    NA: { label: 'Không áp dụng', passed: null, next_evaluation_months: null },
  },
  score_values: { A: 100, B: 75, C: 25, D: 0, NA: null },
  bands: [
    { key: 'FAIL', grade: 'D', min: null, min_inclusive: false, max: 60, max_inclusive: false, result_label: RESULT_LABELS.FAIL },
    { key: 'BASIC_PASS', grade: 'C', min: 60, min_inclusive: true, max: 75, max_inclusive: true, result_label: RESULT_LABELS.BASIC_PASS },
    { key: 'GOOD_PASS', grade: 'B', min: 75, min_inclusive: false, max: 90, max_inclusive: true, result_label: RESULT_LABELS.GOOD_PASS },
    { key: 'HIGH_PASS', grade: 'A', min: 90, min_inclusive: false, max: null, max_inclusive: false, result_label: RESULT_LABELS.HIGH_PASS },
  ],
  penalties: [
    { code: 'CRITICAL_C', question_flag: 'critical', score: 'C', multiplier: 0.90, priority: 20, reason: 'Điều khoản chính yếu C: điểm trung bình × 90%.' },
    { code: 'CRITICAL_B', question_flag: 'critical', score: 'B', multiplier: 0.95, priority: 10, reason: 'Điều khoản chính yếu B: điểm trung bình × 95%.' },
  ],
  elimination: {
    clause_type: 'exclusion',
    score: 'D',
    forced_score: 0,
    reason: 'Không đạt do vi phạm điều khoản loại.',
  },
  default_reason: 'Tính theo điểm trung bình các điều khoản.',
  final_conclusion: { pass_min: 60, pass_label: 'Đạt', fail_label: 'Không đạt' },
  workflow_thresholds: { lead_submission_score_below: 60, lead_submission_critical_scores: ['D'] },
  rounding: { calculation_mode: 'NONE', calculation_decimals: null, display_decimals: 1 },
  categories: [
    { code: 'LEGAL_RECORDS', label: 'Hồ sơ pháp lý', order: 10 },
    { code: 'FOOD_SAFETY_CONTROL', label: 'Kiểm soát ATVSTP', order: 20 },
    { code: 'QUALITY_CONTROL', label: 'Kiểm soát chất lượng', order: 30 },
    { code: 'PRODUCT_QUALITY_CONTROL', label: 'Kiểm soát chất lượng sản phẩm', order: 40 },
    { code: 'TRACEABILITY', label: 'Truy xuất nguồn gốc', order: 50 },
  ],
  compliance_overview: {
    title: 'Tổng hợp tuân thủ',
    category_column_label: 'Hạng mục',
    grade_columns: ['A', 'B', 'C', 'D', 'NA'],
    show_totals: true,
    totals_label: 'Tổng',
    show_percentage: true,
    percentage_label: '%',
    show_legend: true,
    legend_label: 'Chú giải',
    show_elimination: true,
    elimination_label: 'Điều khoản loại',
    show_result: true,
    result_label: 'Kết quả',
    chart: { enabled: true, type: 'radar', max_axes: 8, fallback: 'bar_table' },
  },
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function checksum(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function policyError(code, details = {}) {
  return Object.assign(new Error(code), { code, status: 400, details });
}

function formulaDefinition(definition) {
  return {
    schema_version: definition.schema_version,
    grades: definition.grades,
    score_values: definition.score_values,
    bands: definition.bands,
    penalties: definition.penalties,
    elimination: definition.elimination,
    default_reason: definition.default_reason,
    final_conclusion: definition.final_conclusion,
    workflow_thresholds: definition.workflow_thresholds,
    rounding: definition.rounding,
  };
}

function formulaChecksum(definition) {
  return checksum(formulaDefinition(definition));
}

function definitionChecksum(definition) {
  return checksum(definition);
}

function validateScoringPolicyDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Number(definition.schema_version) !== 1) {
    throw policyError('scoring_policy_schema_invalid');
  }
  const gradeCodes = ['A', 'B', 'C', 'D', 'NA'];
  if (!definition.grades || gradeCodes.some((code) => !definition.grades[code])) {
    throw policyError('scoring_policy_grades_invalid');
  }
  if (!definition.score_values || gradeCodes.some((code) => !Object.prototype.hasOwnProperty.call(definition.score_values, code))) {
    throw policyError('scoring_policy_score_values_invalid');
  }
  if (!Array.isArray(definition.bands) || !definition.bands.length) throw policyError('scoring_policy_bands_required');
  const bands = definition.bands;
  if (bands[0].min != null || bands[bands.length - 1].max != null) throw policyError('scoring_policy_band_gap');
  bands.forEach((band, index) => {
    if (!gradeCodes.includes(band.grade) || band.grade === 'NA' || !String(band.key || '').trim()) {
      throw policyError('scoring_policy_band_invalid', { index });
    }
    if (band.min != null && !Number.isFinite(Number(band.min))) throw policyError('scoring_policy_band_invalid', { index });
    if (band.max != null && !Number.isFinite(Number(band.max))) throw policyError('scoring_policy_band_invalid', { index });
    if (band.min != null && band.max != null && Number(band.min) >= Number(band.max)) {
      throw policyError('scoring_policy_band_invalid', { index });
    }
    if (index === 0) return;
    const previous = bands[index - 1];
    const previousMax = Number(previous.max);
    const currentMin = Number(band.min);
    if (previousMax > currentMin) throw policyError('scoring_policy_band_overlap', { index });
    if (previousMax < currentMin) throw policyError('scoring_policy_band_gap', { index });
    if (previous.max_inclusive && band.min_inclusive) throw policyError('scoring_policy_band_overlap', { index });
    if (!previous.max_inclusive && !band.min_inclusive) throw policyError('scoring_policy_band_gap', { index });
  });
  const categoryCodes = new Set();
  (definition.categories || []).forEach((category, index) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(String(category.code || '')) || categoryCodes.has(category.code)
      || !String(category.label || '').trim() || !Number.isFinite(Number(category.order))) {
      throw policyError('scoring_policy_category_invalid', { index });
    }
    categoryCodes.add(category.code);
  });
  const overview = definition.compliance_overview;
  if (!Number.isFinite(Number(definition.final_conclusion?.pass_min))
    || !String(definition.final_conclusion?.pass_label || '').trim()
    || !String(definition.final_conclusion?.fail_label || '').trim()) {
    throw policyError('scoring_policy_final_conclusion_invalid');
  }
  if (!Number.isFinite(Number(definition.workflow_thresholds?.lead_submission_score_below))
    || !Array.isArray(definition.workflow_thresholds?.lead_submission_critical_scores)
    || definition.workflow_thresholds.lead_submission_critical_scores.some((score) => !gradeCodes.includes(score))) {
    throw policyError('scoring_policy_workflow_thresholds_invalid');
  }
  if (!overview || !String(overview.title || '').trim() || !Array.isArray(overview.grade_columns)
    || overview.grade_columns.some((grade) => !gradeCodes.includes(grade))
    || (overview.show_totals && !String(overview.totals_label || '').trim())
    || (overview.show_legend && !String(overview.legend_label || '').trim())
    || (overview.show_elimination && !String(overview.elimination_label || '').trim())
    || (overview.show_result && !String(overview.result_label || '').trim())) {
    throw policyError('scoring_policy_overview_invalid');
  }
  const maxAxes = Number(overview.chart?.max_axes);
  if (overview.chart?.enabled && (!Number.isInteger(maxAxes) || maxAxes < 3 || maxAxes > 24)) {
    throw policyError('scoring_policy_chart_invalid');
  }
  return definition;
}

function inBand(band, score) {
  const aboveMin = band.min == null || (band.min_inclusive ? score >= Number(band.min) : score > Number(band.min));
  const belowMax = band.max == null || (band.max_inclusive ? score <= Number(band.max) : score < Number(band.max));
  return aboveMin && belowMax;
}

function classifyWithPolicy(definition, score, forcedFail = false) {
  validateScoringPolicyDefinition(definition);
  const numeric = Number(score);
  const band = forcedFail || !Number.isFinite(numeric)
    ? definition.bands[0]
    : definition.bands.find((candidate) => inBand(candidate, numeric)) || definition.bands[0];
  const grade = definition.grades[band.grade];
  return {
    label: band.result_label,
    grade: band.grade,
    passed: grade.passed,
    band: band.key,
    nextEvaluationMonths: grade.next_evaluation_months,
  };
}

function parseDate(value) {
  const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function addMonths(dateText, months) {
  const date = parseDate(dateText);
  if (!date || !months) return '';
  const day = date.getUTCDate();
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + Number(months), 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next.toISOString().slice(0, 10);
}

function buildEvaluationResultWithPolicy(definition, { score, forcedFail = false, evaluationDate = '' }) {
  const numeric = Number(score);
  const value = Number.isFinite(numeric) ? numeric : null;
  const classified = classifyWithPolicy(definition, value, forcedFail);
  return {
    score: value,
    grade: classified.grade,
    label: classified.label,
    passed: classified.passed,
    band: classified.band,
    nextEvaluationMonths: classified.nextEvaluationMonths,
    nextEvaluationDate: value == null || !classified.passed ? '' : addMonths(evaluationDate, classified.nextEvaluationMonths),
    finalConclusion: value == null
      ? ''
      : (value >= Number(definition.final_conclusion.pass_min)
        ? definition.final_conclusion.pass_label
        : definition.final_conclusion.fail_label),
  };
}

function questionCategory(question) {
  return {
    code: String(question.categoryCode || question.category_code || '').trim() || null,
    label: String(
      question.categoryLabel
      || question.category_label_snapshot
      || question.category_label
      || question.section
      || ''
    ).trim() || 'Khác',
  };
}

function roundScore(value, rounding) {
  if (rounding?.calculation_mode !== 'DECIMAL') return value;
  const decimals = Number(rounding.calculation_decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function calculateWithPolicy(definition, questionBank, answers) {
  validateScoringPolicyDefinition(definition);
  let total = 0;
  let denominator = 0;
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const countsWithNa = { ...counts, NA: 0 };
  const category = {};
  const categoryByCode = {};
  const nonconformities = [];
  let eliminated = false;
  const activePenalties = [];

  (questionBank || []).forEach((question) => {
    const answer = answers?.[question.id] || {};
    const score = String(answer.score || '');
    if (Object.prototype.hasOwnProperty.call(countsWithNa, score)) countsWithNa[score] += 1;
    if (Object.prototype.hasOwnProperty.call(counts, score)) counts[score] += 1;
    const categoryIdentity = questionCategory(question);
    if (!category[categoryIdentity.label]) category[categoryIdentity.label] = { total: 0, denom: 0, score: null };
    const codeKey = categoryIdentity.code || `UNMAPPED:${categoryIdentity.label}`;
    if (!categoryByCode[codeKey]) {
      categoryByCode[codeKey] = {
        category_code: categoryIdentity.code,
        category_label: categoryIdentity.label,
        total: 0,
        denom: 0,
        score: null,
        counts: { A: 0, B: 0, C: 0, D: 0, NA: 0 },
      };
    }
    if (Object.prototype.hasOwnProperty.call(categoryByCode[codeKey].counts, score)) categoryByCode[codeKey].counts[score] += 1;
    const scoreValue = definition.score_values[score];
    if (score !== 'NA' && Number.isFinite(Number(scoreValue))) {
      total += Number(scoreValue);
      denominator += 1;
      category[categoryIdentity.label].total += Number(scoreValue);
      category[categoryIdentity.label].denom += 1;
      categoryByCode[codeKey].total += Number(scoreValue);
      categoryByCode[codeKey].denom += 1;
    }
    if (question.clause === definition.elimination.clause_type && score === definition.elimination.score) eliminated = true;
    (definition.penalties || []).forEach((penalty) => {
      if (question[penalty.question_flag] && score === penalty.score) activePenalties.push(penalty);
    });
    if (['B', 'C', 'D'].includes(score)) nonconformities.push({ ...question, score, note: answer.note || '' });
  });

  Object.values(category).forEach((row) => { row.score = row.denom ? row.total / row.denom : null; });
  Object.values(categoryByCode).forEach((row) => { row.score = row.denom ? row.total / row.denom : null; });
  const average = denominator ? total / denominator : 0;
  let finalScore = eliminated ? Number(definition.elimination.forced_score) : average;
  let reason = eliminated ? definition.elimination.reason : definition.default_reason;
  if (!eliminated && activePenalties.length) {
    const selected = activePenalties.sort((left, right) => Number(right.priority) - Number(left.priority))[0];
    finalScore = average * Number(selected.multiplier);
    reason = selected.reason;
  }
  finalScore = roundScore(finalScore, definition.rounding);
  const classified = classifyWithPolicy(definition, finalScore, eliminated);
  return {
    average,
    finalScore,
    reason,
    counts,
    counts_with_na: countsWithNa,
    category,
    category_by_code: categoryByCode,
    nonconformities,
    eliminated,
    ...classified,
  };
}

function leadSubmissionEligibilityWithPolicy(definition, questionBank, answers, scoreResult) {
  validateScoringPolicyDefinition(definition);
  const finalScore = Number(scoreResult?.finalScore);
  const criticalScores = new Set(definition.workflow_thresholds.lead_submission_critical_scores);
  const failedCritical = (questionBank || []).filter((question) => (
    question.critical && criticalScores.has(answers?.[question.id]?.score)
  ));
  const scoreBelowThreshold = Number.isFinite(finalScore)
    && finalScore < Number(definition.workflow_thresholds.lead_submission_score_below);
  return {
    eligible: scoreBelowThreshold || failedCritical.length > 0,
    score_percent: Number.isFinite(finalScore) ? finalScore : null,
    score_below_threshold: scoreBelowThreshold,
    failed_critical_count: failedCritical.length,
    failed_critical_question_ids: failedCritical.map((question) => String(question.id)),
  };
}

function sumCounts(rows) {
  return rows.reduce((total, row) => {
    ['A', 'B', 'C', 'D', 'NA'].forEach((grade) => { total[grade] += Number(row.counts?.[grade] || 0); });
    return total;
  }, { A: 0, B: 0, C: 0, D: 0, NA: 0 });
}

function buildComplianceOverview(definition, { categoryRows = [], result = {} } = {}) {
  validateScoringPolicyDefinition(definition);
  const config = definition.compliance_overview;
  const remaining = [...categoryRows];
  const configured = [...(definition.categories || [])].sort((left, right) => Number(left.order) - Number(right.order));
  const rows = configured.map((category) => {
    const sourceIndex = remaining.findIndex((row) => String(row.category_code || '') === category.code);
    const source = sourceIndex >= 0 ? remaining.splice(sourceIndex, 1)[0] : {};
    const counts = { A: 0, B: 0, C: 0, D: 0, NA: 0, ...(source.counts || {}) };
    return {
      category_code: category.code,
      category_label: source.category_label || category.label,
      counts,
      total: Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0),
      percentage: source.percentage == null ? source.score : source.percentage,
    };
  });
  const warnings = [];
  for (const source of remaining) {
    rows.push({
      category_code: source.category_code || null,
      category_label: source.category_label || 'Chưa ánh xạ',
      counts: { A: 0, B: 0, C: 0, D: 0, NA: 0, ...(source.counts || {}) },
      total: Object.values(source.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0),
      percentage: source.percentage == null ? source.score : source.percentage,
      reconciliation_status: 'UNMAPPED',
    });
    warnings.push('compliance_category_unmapped');
  }
  const columns = [{ key: 'category_label', label: config.category_column_label }];
  config.grade_columns.forEach((grade) => columns.push({ key: `counts.${grade}`, label: definition.grades[grade].label }));
  if (config.show_totals) columns.push({ key: 'total', label: config.totals_label });
  if (config.show_percentage) columns.push({ key: 'percentage', label: config.percentage_label });
  let chartType = config.chart?.enabled ? config.chart.type : 'none';
  if (config.chart?.enabled && rows.length > Number(config.chart.max_axes)) {
    chartType = config.chart.fallback;
    warnings.push('compliance_chart_axis_limit_exceeded');
  }
  const totalCounts = sumCounts(rows);
  const scoredTotal = ['A', 'B', 'C', 'D'].reduce((sum, grade) => sum + totalCounts[grade], 0);
  const weightedTotal = ['A', 'B', 'C', 'D'].reduce((sum, grade) => (
    sum + totalCounts[grade] * Number(definition.score_values[grade])
  ), 0);
  return {
    title: config.title,
    columns,
    rows,
    totals: config.show_totals ? {
      category_label: config.totals_label,
      counts: totalCounts,
      total: Object.values(totalCounts).reduce((sum, value) => sum + value, 0),
      percentage: scoredTotal ? weightedTotal / scoredTotal : null,
    } : null,
    chart: {
      enabled: !!config.chart?.enabled,
      type: chartType,
      categories: rows.map((row) => row.category_label),
      values: rows.map((row) => row.percentage),
    },
    legend: config.show_legend ? {
      label: config.legend_label,
      items: config.grade_columns.map((grade) => ({ code: grade, label: definition.grades[grade].label })),
    } : null,
    elimination: config.show_elimination ? { label: config.elimination_label, applied: !!result.eliminated } : null,
    result: config.show_result ? { title: config.result_label, grade: result.grade || '', label: result.label || '', passed: result.passed ?? null } : null,
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  GOLDEN_V1_DEFINITION,
  RESULT_LABELS,
  buildComplianceOverview,
  buildEvaluationResultWithPolicy,
  calculateWithPolicy,
  categoryCodeForLabel,
  classifyWithPolicy,
  definitionChecksum,
  formulaChecksum,
  leadSubmissionEligibilityWithPolicy,
  stableJson,
  validateScoringPolicyDefinition,
};
