const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const StatisticalDashboardService = require('../server/services/dashboard/statisticalDashboardService');

function aggregate(overrides = {}) {
  const total = overrides.total ?? 4;
  const failed = overrides.failed ?? 1;
  return {
    overview: {
      total,
      passed: total - failed,
      failed,
      passed_ratio: total ? (total - failed) / total : 0,
      failed_ratio: total ? failed / total : 0,
    },
  };
}

test('RUN-13 evaluation statistics ends at selected period and uses three backend months', () => {
  const evalsByMonth = new Map([
    ['2026-02', aggregate({ total: 1, failed: 0 })],
    ['2026-03', aggregate({ total: 2, failed: 1 })],
    ['2026-04', aggregate({ total: 2, failed: 1 })],
  ]);
  const service = new StatisticalDashboardService({
    nccEvaluationsAggregateService: { get: (period) => evalsByMonth.get(period) },
  });

  const result = service.get('2026-04');
  assert.equal(result.period, '2026-04');
  assert.deepEqual(result.trend.months, ['2026-02', '2026-03', '2026-04']);
  assert.deepEqual(result.kpis.map((item) => item.id), ['supplier_evaluations']);
  assert.deepEqual(result.kpis[0], {
    id: 'supplier_evaluations',
    title: 'NCC đánh giá không đạt',
    value: 1,
    total: 2,
    rate: 0.5,
    status: 'ready',
    detail: '1 / 2 NCC đã hoàn tất đánh giá',
  });
  assert.deepEqual(result.trend.series.map((item) => item.id), ['supplier_evaluations']);
  assert.equal(result.trend.series[0].points[0].value, 0, 'a real zero-failure month remains a valid zero');
});

test('RUN-13 evaluation statistics reports its source failure without leaking details', () => {
  const service = new StatisticalDashboardService({
    nccEvaluationsAggregateService: { get: () => { throw new Error('synthetic upstream failure'); } },
  });

  const result = service.get('2026-04');
  assert.equal(result.status, 'error');
  assert.equal(result.sources.supplier_evaluations.status, 'error');
  assert.equal(result.sources.supplier_evaluations.failed, null);
  assert.equal(result.kpis.find((item) => item.id === 'supplier_evaluations').value, null);
  assert.ok(result.trend.series[0].points.every((point) => point.value === null));
  assert.doesNotMatch(JSON.stringify(result), /synthetic upstream failure/);
});

test('RUN-13 statistics represents a fully empty period with null KPI and trend values', () => {
  const emptyAggregate = { get: () => aggregate({ total: 0, failed: 0 }) };
  const service = new StatisticalDashboardService({
    nccEvaluationsAggregateService: emptyAggregate,
  });

  const result = service.get('2026-01');
  assert.equal(result.status, 'empty');
  assert.equal(result.kpis.find((item) => item.id === 'supplier_evaluations').rate, null);
  result.trend.series.forEach((series) => {
    assert.ok(series.points.every((point) => point.value === null));
  });
});

test('RUN-16 frontend keeps the overview route and renders KPI content without duplicate navigation', () => {
  const root = path.resolve(__dirname, '..');
  const navigation = require('../public/js/navigation-manifest');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const actionRegistry = fs.readFileSync(path.join(root, 'public', 'js', 'action-registry.js'), 'utf8');
  const overview = navigation.NAVIGATION_MANIFEST.find((item) => item.id === 'overview');

  assert.equal(overview.route, '/dashboard');
  assert.equal(overview.parent, 'analytics');
  assert.equal(overview.label, 'Báo cáo thống kê');
  assert.deepEqual(overview.permissions, ['DASHBOARD.READ']);
  assert.doesNotMatch(html, /class="statistics-titlebar"/);
  assert.doesNotMatch(html, /id="statistics-report-period"/);
  assert.doesNotMatch(html, /id="dashboard-statistics-tabs"/);
  assert.doesNotMatch(html, /data-dashboard-section|data-statistics-panel/);
  assert.match(html, /id="statistics-kpi-cards"/);
  assert.match(html, /id="quality-trend-canvas"/);
  assert.match(app, /\/dashboard\/statistics\?period=/);
  assert.match(app, /Chưa có dữ liệu/);
  assert.match(app, /drawQualityTrend/);
  assert.doesNotMatch(app, /statisticalDashboardSection|renderStatisticsSection/);
  assert.doesNotMatch(actionRegistry, /dashboard\.tab_open/);
  assert.doesNotMatch(html, /data-statistic-sample|Số liệu mẫu/);
});
