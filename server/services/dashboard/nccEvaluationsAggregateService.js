const { WORKFLOW_STATUSES } = require('../../domain/workflowHistory');
const {
  REPORTING_TIMEZONE,
  EVALUATION_VIOLATION_GROUPS,
  resolveViolationGroup,
} = require('../../domain/reporting/evaluationViolationGroups');
const {
  compareNullableText,
  normalizeComparableText,
  normalizeNullableText,
  parseReportingMonth,
  safeRatio,
} = require('../../domain/reporting/month');

function currentReportingMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORTING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}`;
}

function normalizeSupplierCode(value) {
  const text = String(value || '').trim().toUpperCase();
  return text || null;
}

function failedText(value) {
  const text = normalizeComparableText(value);
  return text === 'khong dat' || text.includes('khong dat');
}

function passedText(value) {
  const text = normalizeComparableText(value);
  return text === 'dat' || text.startsWith('dat ') || text.includes('dat muc') || text.includes('dat co dieu kien');
}

function classifyResult(row) {
  const score = row.total_score == null ? null : Number(row.total_score);
  const hasScore = Number.isFinite(score);
  const classification = String(row.round_classification || '').trim().toUpperCase();
  const failedPersisted = [
    row.round_final_result,
    row.ticket_result_label,
    row.ticket_final_conclusion,
  ].some(failedText) || classification === 'D';
  const passedPersisted = !failedPersisted && ([
    row.round_final_result,
    row.ticket_result_label,
    row.ticket_final_conclusion,
  ].some(passedText) || ['A', 'B', 'C'].includes(classification));
  const conflict = hasScore && ((failedPersisted && score >= 60) || (passedPersisted && score < 60));
  if (failedPersisted) return { result: 'failed', conflict };
  if (hasScore) return { result: score >= 60 ? 'passed' : 'failed', conflict };
  if (passedPersisted) return { result: 'passed', conflict: false };
  return { result: null, conflict: false };
}

function canonicalSupplierKey(row) {
  const masterId = row.supplier_master_id || row.supplier_code_master_id;
  if (masterId) return `ID:${masterId}`;
  const code = normalizeSupplierCode(row.supplier_code);
  if (code) return `CODE:${code}`;
  return null;
}

function categoryFor(row) {
  return normalizeNullableText(row.product_group) || normalizeNullableText(row.mch3) || normalizeNullableText(row.mch2);
}

function compareRounds(a, b) {
  return String(b.reporting_at || '').localeCompare(String(a.reporting_at || '')) ||
    String(b.completion_at || '').localeCompare(String(a.completion_at || '')) ||
    Number(b.round_no || 0) - Number(a.round_no || 0) ||
    Number(b.round_id || 0) - Number(a.round_id || 0);
}

function emptyDataQuality(overrides = {}) {
  return {
    excluded_missing_supplier_identity: Number(overrides.excluded_missing_supplier_identity || 0),
    excluded_missing_reporting_date: Number(overrides.excluded_missing_reporting_date || 0),
    excluded_unclassifiable_result: Number(overrides.excluded_unclassifiable_result || 0),
    score_result_conflicts: Number(overrides.score_result_conflicts || 0),
    unknown_violation_groups: Number(overrides.unknown_violation_groups || 0),
  };
}

class NccEvaluationsAggregateService {
  constructor({ repository }) {
    this.repository = repository;
  }

  get(monthValue) {
    const range = parseReportingMonth(monthValue);
    const rawQuality = this.repository.dataQualityCounts();
    const candidates = this.repository.listRoundCandidates(range);
    let excludedMissingSupplierIdentity = 0;
    let excludedUnclassifiableResult = 0;
    const bySupplier = new Map();

    candidates.forEach((row) => {
      const key = canonicalSupplierKey(row);
      if (!key) {
        excludedMissingSupplierIdentity += 1;
        return;
      }
      const classified = classifyResult(row);
      if (!classified.result) {
        excludedUnclassifiableResult += 1;
        return;
      }
      const item = {
        ...row,
        supplier_key: key,
        result: classified.result,
        score_result_conflict: classified.conflict,
        category: categoryFor(row),
      };
      const existing = bySupplier.get(key);
      if (!existing || compareRounds(item, existing) < 0) bySupplier.set(key, item);
    });

    const selected = Array.from(bySupplier.values()).sort(compareRounds);
    const scoreResultConflicts = selected.filter((row) => row.score_result_conflict).length;
    const overview = selected.reduce((acc, row) => {
      acc.total += 1;
      if (row.result === 'passed') acc.passed += 1;
      if (row.result === 'failed') acc.failed += 1;
      return acc;
    }, { total: 0, passed: 0, failed: 0 });
    overview.passed_ratio = safeRatio(overview.passed, overview.total);
    overview.failed_ratio = safeRatio(overview.failed, overview.total);
    if (overview.total !== overview.passed + overview.failed) {
      throw new Error('ncc_evaluations_overview_reconciliation_failed');
    }

    const categoryGroups = new Map();
    selected.forEach((row) => {
      const key = row.category || '';
      if (!categoryGroups.has(key)) categoryGroups.set(key, { category: row.category || null, passed: 0, failed: 0, total: 0 });
      const target = categoryGroups.get(key);
      target.total += 1;
      if (row.result === 'passed') target.passed += 1;
      if (row.result === 'failed') target.failed += 1;
    });
    const byCategory = Array.from(categoryGroups.values())
      .sort((a, b) => compareNullableText(a.category, b.category))
      .map((row, index) => ({
        stt: index + 1,
        category: row.category,
        passed: row.passed,
        failed: row.failed,
        total: row.total,
        passed_ratio: safeRatio(row.passed, row.total),
        failed_ratio: safeRatio(row.failed, row.total),
      }));
    const reconciled = byCategory.reduce((acc, row) => {
      acc.total += row.total;
      acc.passed += row.passed;
      acc.failed += row.failed;
      return acc;
    }, { total: 0, passed: 0, failed: 0 });
    if (reconciled.total !== overview.total || reconciled.passed !== overview.passed || reconciled.failed !== overview.failed) {
      throw new Error('ncc_evaluations_category_reconciliation_failed');
    }

    const violationResult = this.violationsFor(selected, overview.total);

    return {
      month: range.month,
      data_source: 'workflow',
      overview,
      by_category: byCategory,
      violations: violationResult.rows,
      meta: {
        unit: 'supplier',
        grain: 'latest_completed_round_per_supplier_per_month',
        ratio_unit: 'fraction',
        timezone: range.timezone,
        date_rule: 'assessment_date_else_completed_at_else_locked_at',
        result_rule: 'explicit_fail_override_then_score_threshold_60',
        violation_scope: 'selected_latest_round',
        violation_counts_overlap: true,
        data_quality: emptyDataQuality({
          ...rawQuality,
          excluded_missing_supplier_identity: excludedMissingSupplierIdentity,
          excluded_unclassifiable_result: excludedUnclassifiableResult,
          score_result_conflicts: scoreResultConflicts,
          unknown_violation_groups: violationResult.unknown,
        }),
      },
      generated_at: new Date().toISOString(),
    };
  }

  months() {
    const current = currentReportingMonth();
    const months = this.repository.listReportingMonths().map((row) => ({
      value: row.report_month,
      has_data: true,
      is_current: row.report_month === current,
      updated_at: row.updated_at || null,
    }));
    if (!months.some((item) => item.value === current)) {
      months.push({ value: current, has_data: false, is_current: true, updated_at: null });
    }
    months.sort((a, b) => b.value.localeCompare(a.value));
    return { months };
  }

  violationsFor(selected, total) {
    if (!total) return { rows: [], unknown: 0 };
    const roundIds = selected.map((row) => row.round_id);
    const selectedByRound = new Map(selected.map((row) => [row.round_id, row]));
    const sources = this.repository.listViolationSources(roundIds);
    const primaryByRound = new Map();
    const supplierByGroup = new Map(EVALUATION_VIOLATION_GROUPS.map((group) => [group.code, new Set()]));
    let unknown = 0;

    const add = (row, supplementOnly) => {
      const selectedRound = selectedByRound.get(row.round_id);
      if (!selectedRound) return;
      const group = resolveViolationGroup(row);
      if (!group) {
        unknown += 1;
        return;
      }
      if (!primaryByRound.has(row.round_id)) primaryByRound.set(row.round_id, new Set());
      const roundGroups = primaryByRound.get(row.round_id);
      if (supplementOnly && roundGroups.has(group.code)) return;
      roundGroups.add(group.code);
      supplierByGroup.get(group.code).add(selectedRound.supplier_key);
    };

    sources.primary.forEach((row) => add(row, false));
    sources.fallback.forEach((row) => add(row, true));

    return {
      unknown,
      rows: EVALUATION_VIOLATION_GROUPS.map((group) => {
        const supplierCount = supplierByGroup.get(group.code).size;
        return {
          code: group.code,
          label: group.label,
          supplier_count: supplierCount,
          ratio: safeRatio(supplierCount, total),
          note: group.note,
        };
      }),
    };
  }
}

module.exports = NccEvaluationsAggregateService;
