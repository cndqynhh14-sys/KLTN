const { normalizeComparableText, safeRatio } = require('../../domain/reporting/month');
const { offsetPeriod, parseDashboardPeriod, periodWindow } = require('../../domain/reporting/dashboardPeriod');

const STATUS_GROUPS = Object.freeze([
  { code: 'DRAFT', label: 'Khởi tạo', statuses: ['Khởi tạo'] },
  { code: 'IN_PROGRESS', label: 'Đang xử lý', statuses: ['Đang xử lý'] },
  { code: 'WAITING_APPROVAL', label: 'Chờ phê duyệt', statuses: ['Chờ duyệt (Lead)', 'Chờ duyệt (TBP)', 'Chờ duyệt (GĐK)'] },
  { code: 'WAITING_CORRECTION', label: 'Chờ khắc phục', statuses: ['Chờ khắc phục'] },
  { code: 'ROUND_2', label: 'Đang đánh giá lần 2', statuses: ['Đang đánh giá lần 2'] },
  { code: 'EXTENDED', label: 'Gia hạn', statuses: ['Gia hạn'] },
  { code: 'SUSPENDED', label: 'Tạm ngừng', statuses: ['Tạm ngừng'] },
  { code: 'COMPLETED', label: 'Hoàn thành', statuses: ['Hoàn thành'] },
  { code: 'CANCELLED', label: 'Hủy', statuses: ['Hủy', 'Đã hủy'] },
]);

const DONUT_EXCLUDED_STATUS_CODES = new Set(['EXTENDED', 'SUSPENDED']);
const DONUT_STATUS_GROUPS = Object.freeze(STATUS_GROUPS.filter((group) => !DONUT_EXCLUDED_STATUS_CODES.has(group.code)));
const DONUT_STATUS_CODES = new Set(DONUT_STATUS_GROUPS.map((group) => group.code));
const GROUP_BY_STATUS = new Map(STATUS_GROUPS.flatMap((group) => group.statuses.map((status) => [normalizeComparableText(status), group])));
const TERMINAL_CODES = new Set(['COMPLETED', 'CANCELLED']);

function list(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',');
}

function normalizeFilters(input = {}) {
  const clean = (value) => [...new Set(list(value).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 50);
  return {
    regions: clean(input.regions || input.regionIds),
    evaluationTypes: clean(input.evaluationTypes || input.evaluationTypeIds),
    mch2: clean(input.mch2 || input.mch2Ids),
  };
}

function timeValue(value) {
  const parsed = Date.parse(String(value || '').replace(' ', 'T') + (String(value || '').includes('T') ? '' : 'Z'));
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

function statusGroup(status) {
  return GROUP_BY_STATUS.get(normalizeComparableText(status)) || null;
}

function classifyResult(round) {
  if (!round) return null;
  const score = Number(round.total_score);
  const normalizedResult = normalizeComparableText(round.final_result);
  const classification = String(round.classification || '').trim().toUpperCase();
  if (normalizedResult.includes('khong dat') || classification === 'D') return 'FAILED';
  if (Number.isFinite(score)) return score >= 60 ? 'PASSED' : 'FAILED';
  if (normalizedResult.includes('dat') || ['A', 'B', 'C'].includes(classification)) return 'PASSED';
  return null;
}

function comparison(currentValue, previousValue, inverse = false) {
  const absoluteChange = currentValue - previousValue;
  return {
    current_value: currentValue,
    previous_value: previousValue,
    absolute_change: absoluteChange,
    percentage_change: previousValue === 0 ? null : Math.round((absoluteChange / previousValue) * 1000) / 10,
    trend: absoluteChange > 0 ? 'UP' : absoluteChange < 0 ? 'DOWN' : 'UNCHANGED',
    sentiment: absoluteChange === 0 ? 'NEUTRAL' : ((absoluteChange > 0) !== inverse ? 'POSITIVE' : 'NEGATIVE'),
  };
}

class StatisticalDashboardService {
  constructor({ repository }) {
    this.repository = repository;
  }

  factsThrough(period, filters) {
    const tickets = this.repository.listTicketsBefore(period.periodEndExclusive, filters);
    const ids = tickets.map((ticket) => ticket.id);
    const historyByTicket = new Map();
    this.repository.listWorkflowHistory(ids, period.periodEndExclusive).forEach((row) => {
      if (!historyByTicket.has(row.ticket_id)) historyByTicket.set(row.ticket_id, []);
      historyByTicket.get(row.ticket_id).push(row);
    });
    const roundsByTicket = new Map();
    this.repository.listCompletedRounds(ids, period.periodEndExclusive).forEach((row) => {
      if (!roundsByTicket.has(row.ticket_id)) roundsByTicket.set(row.ticket_id, []);
      roundsByTicket.get(row.ticket_id).push(row);
    });
    return { tickets, historyByTicket, roundsByTicket };
  }

  statusAt(ticket, history, endExclusive) {
    const rows = history.filter((row) => String(row.created_at) < endExclusive);
    const latest = rows[rows.length - 1];
    return latest?.to_status || latest?.from_status || ticket.current_status;
  }

  finalRoundAt(rounds, endExclusive) {
    return rounds
      .filter((row) => String(row.completed_at || row.locked_at || row.assessment_date || '') < endExclusive)
      .sort((a, b) => Number(b.round_no) - Number(a.round_no) || timeValue(b.completed_at || b.locked_at || b.assessment_date) - timeValue(a.completed_at || a.locked_at || a.assessment_date) || Number(b.id) - Number(a.id))[0] || null;
  }

  terminalAt(ticket, group, history, rounds, endExclusive) {
    const matching = history.filter((row) => {
      if (String(row.created_at) >= endExclusive) return false;
      return statusGroup(row.to_status)?.code === group.code;
    });
    if (matching.length) return matching[matching.length - 1].created_at;
    if (group.code === 'CANCELLED') return ticket.cancelled_at || null;
    const round = this.finalRoundAt(rounds, endExclusive);
    return round?.completed_at || round?.locked_at || round?.assessment_date || null;
  }

  completedRecords(period, facts) {
    const records = [];
    facts.tickets.forEach((ticket) => {
      const history = facts.historyByTicket.get(ticket.id) || [];
      const rounds = facts.roundsByTicket.get(ticket.id) || [];
      const group = statusGroup(this.statusAt(ticket, history, period.periodEndExclusive));
      if (group?.code !== 'COMPLETED') return;
      const completedAt = this.terminalAt(ticket, group, history, rounds, period.periodEndExclusive);
      if (!completedAt || completedAt < period.periodStart || completedAt >= period.periodEndExclusive) return;
      const finalRound = this.finalRoundAt(rounds, period.periodEndExclusive);
      const result = classifyResult(finalRound);
      const score = Number(finalRound?.total_score);
      if (!result || !Number.isFinite(score)) return;
      records.push({ ...ticket, completed_at: completedAt, final_round: finalRound, result, final_score: score });
    });
    return records;
  }

  summary(period, facts) {
    const records = this.completedRecords(period, facts);
    const supplierIds = new Set(records.map((row) => row.supplier_id).filter((value) => value != null));
    const passed = records.filter((row) => row.result === 'PASSED').length;
    const failed = records.filter((row) => row.result === 'FAILED').length;
    return {
      records,
      evaluated_supplier_count: supplierIds.size,
      evaluation_ticket_count: records.length,
      passed_ticket_count: passed,
      failed_ticket_count: failed,
      failed_rate: safeRatio(failed, records.length),
    };
  }

  statusDistribution(period, facts) {
    const counts = new Map(DONUT_STATUS_GROUPS.map((group) => [group.code, 0]));
    facts.tickets.forEach((ticket) => {
      const history = facts.historyByTicket.get(ticket.id) || [];
      const rounds = facts.roundsByTicket.get(ticket.id) || [];
      const group = statusGroup(this.statusAt(ticket, history, period.periodEndExclusive));
      if (!group || !DONUT_STATUS_CODES.has(group.code)) return;
      if (TERMINAL_CODES.has(group.code)) {
        const terminalAt = this.terminalAt(ticket, group, history, rounds, period.periodEndExclusive);
        if (!terminalAt || terminalAt < period.periodStart || terminalAt >= period.periodEndExclusive) return;
      }
      counts.set(group.code, counts.get(group.code) + 1);
    });
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    return {
      total,
      items: DONUT_STATUS_GROUPS.map((group) => ({
        code: group.code,
        label: group.label,
        count: counts.get(group.code),
        percentage: total ? Math.round((counts.get(group.code) / total) * 1000) / 10 : 0,
      })),
    };
  }

  ranking(records) {
    const suppliers = new Map();
    records.forEach((row) => {
      const key = row.supplier_id == null ? `CODE:${row.supplier_code}` : `ID:${row.supplier_id}`;
      if (!suppliers.has(key)) suppliers.set(key, {
        supplier_id: row.supplier_id,
        supplier_code: row.supplier_code,
        supplier_name: row.supplier_name,
        score_sum: 0,
        evaluation_count: 0,
        latest_evaluation_date: '',
        ticket_codes: [],
      });
      const item = suppliers.get(key);
      item.score_sum += row.final_score;
      item.evaluation_count += 1;
      item.latest_evaluation_date = [item.latest_evaluation_date, row.completed_at].sort().pop();
      item.ticket_codes.push(row.ticket_code);
    });
    return [...suppliers.values()].map((row) => {
      const average = row.score_sum / row.evaluation_count;
      return {
        supplier_id: row.supplier_id,
        supplier_code: row.supplier_code,
        supplier_name: row.supplier_name,
        average_final_score: Math.round(average * 10) / 10,
        evaluation_count: row.evaluation_count,
        latest_evaluation_date: row.latest_evaluation_date,
        classification: average < 60 ? 'Không đạt' : average <= 75 ? 'Cơ bản' : average <= 90 ? 'Khá' : 'Cao',
        ticket_codes: row.ticket_codes,
      };
    }).sort((a, b) => b.average_final_score - a.average_final_score || b.evaluation_count - a.evaluation_count || String(b.latest_evaluation_date).localeCompare(String(a.latest_evaluation_date)) || String(a.supplier_name).localeCompare(String(b.supplier_name), 'vi')).slice(0, 10).map((row, index) => ({ rank: index + 1, ...row }));
  }

  get(input = {}) {
    const legacyValue = typeof input === 'string' ? input : null;
    const period = parseDashboardPeriod(legacyValue ? 'MONTH' : input.periodType, legacyValue || input.periodValue);
    const filters = normalizeFilters(typeof input === 'string' ? {} : input);
    const facts = this.factsThrough(period, filters);
    const current = this.summary(period, facts);
    const previousPeriod = offsetPeriod(period, -1);
    const previousFacts = this.factsThrough(previousPeriod, filters);
    const previous = this.summary(previousPeriod, previousFacts);
    const status = this.statusDistribution(period, facts);
    const trend = periodWindow(period, 6).map((item) => {
      const itemFacts = this.factsThrough(item, filters);
      const itemSummary = this.summary(item, itemFacts);
      return {
        period_type: item.type,
        period_value: item.value,
        label: item.label,
        evaluated_supplier_count: itemSummary.evaluated_supplier_count,
        passed_ticket_count: itemSummary.passed_ticket_count,
        failed_ticket_count: itemSummary.failed_ticket_count,
        failed_rate: itemSummary.failed_rate,
        is_selected: item.value === period.value,
      };
    });
    return {
      period: {
        type: period.type,
        value: period.value,
        label: period.label,
        start: period.periodStart,
        end_exclusive: period.periodEndExclusive,
        timezone: period.timezone,
      },
      filters: { applied: filters, options: this.repository.filterOptions() },
      kpis: {
        evaluated_supplier_count: comparison(current.evaluated_supplier_count, previous.evaluated_supplier_count),
        evaluation_ticket_count: comparison(current.evaluation_ticket_count, previous.evaluation_ticket_count),
        passed_ticket_count: comparison(current.passed_ticket_count, previous.passed_ticket_count),
        failed_ticket_count: comparison(current.failed_ticket_count, previous.failed_ticket_count, true),
      },
      status_distribution: status,
      top_suppliers: this.ranking(current.records),
      trend,
      meta: {
        data_source: 'workflow',
        status_rule: 'latest_workflow_status_at_period_end',
        completed_period_rule: 'transition_to_completed_at',
        final_score_rule: 'official_round_2_else_official_round_1',
        ratio_unit: 'fraction',
      },
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = StatisticalDashboardService;
