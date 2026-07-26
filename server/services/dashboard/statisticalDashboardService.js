const { parseReportingMonth } = require('../../domain/reporting/month');

function periodOffset(period, offset) {
  const [year, month] = period.split('-').map(Number);
  const index = (year * 12) + (month - 1) + offset;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
}

function threeMonthWindow(period) {
  return [-2, -1, 0].map((offset) => periodOffset(period, offset));
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sourcePoint(period, payload) {
  const overview = payload && payload.overview ? payload.overview : {};
  const total = numberOrZero(overview.total);
  if (total <= 0) {
    return { period, status: 'empty', failed: null, total: null, value: null };
  }
  const failed = numberOrZero(overview.failed);
  const providedRatio = Number(overview.failed_ratio);
  const value = Number.isFinite(providedRatio) ? providedRatio : failed / total;
  return { period, status: 'ready', failed, total, value };
}

function failedPoint(period) {
  return { period, status: 'error', failed: null, total: null, value: null };
}

function collectSource(service, periods) {
  const points = periods.map((period) => {
    try {
      return sourcePoint(period, service.get(period));
    } catch {
      return failedPoint(period);
    }
  });
  const current = points[points.length - 1];
  return {
    status: current.status,
    failed: current.failed,
    total: current.total,
    rate: current.value,
    points,
  };
}

function sourceDetail(source, noun) {
  if (source.status === 'ready') return `${source.failed} / ${source.total} ${noun}`;
  if (source.status === 'error') return 'Không tải được dữ liệu';
  return 'Không có dữ liệu trong kỳ';
}

function realKpi(id, title, source, noun) {
  return {
    id,
    title,
    value: source.failed,
    total: source.total,
    rate: source.rate,
    status: source.status,
    detail: sourceDetail(source, noun),
  };
}

function overallStatus(sources) {
  const values = Object.values(sources);
  const currentStatuses = values.map((source) => source.status);
  const historyHasError = values.some((source) => source.points.some((point) => point.status === 'error'));
  if (currentStatuses.every((status) => status === 'error')) return 'error';
  if (historyHasError) return 'partial';
  const readyCount = currentStatuses.filter((status) => status === 'ready').length;
  if (readyCount === values.length) return 'ready';
  if (readyCount > 0) return 'partial';
  return 'empty';
}

class StatisticalDashboardService {
  constructor({ nccEvaluationsAggregateService }) {
    this.nccEvaluationsAggregateService = nccEvaluationsAggregateService;
  }

  get(periodValue) {
    const range = parseReportingMonth(periodValue);
    const periods = threeMonthWindow(range.month);
    const sources = {
      supplier_evaluations: collectSource(this.nccEvaluationsAggregateService, periods),
    };
    const evaluationKpi = realKpi(
      'supplier_evaluations',
      'NCC đánh giá không đạt',
      sources.supplier_evaluations,
      'NCC đã hoàn tất đánh giá',
    );
    return {
      period: range.month,
      status: overallStatus(sources),
      data_source: 'workflow',
      kpis: [evaluationKpi],
      sources,
      trend: {
        months: periods,
        series: [
          { id: 'supplier_evaluations', label: 'Đánh giá NCC', points: sources.supplier_evaluations.points },
        ],
      },
      generated_at: new Date().toISOString(),
    };
  }
}

module.exports = StatisticalDashboardService;
