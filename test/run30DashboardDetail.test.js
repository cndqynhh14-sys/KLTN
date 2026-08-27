'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const StatisticalDashboardService = require('../server/services/dashboard/statisticalDashboardService');
const navigation = require('../public/js/navigation-manifest');

function detailFixtureRepository() {
  const tickets = [
    { id: 1, ticket_code: 'A-OLD', supplier_id: 1, supplier_code: 'NCC-A', supplier_name: 'NCC A', region: 'MB', evaluation_type: 'Định kỳ', mch2: 'Hàng tươi', mch3: 'Rau củ', current_status: 'Hoàn thành', created_at: '2026-06-01 08:00:00', cancelled_at: null },
    { id: 2, ticket_code: 'A-LATEST', supplier_id: 1, supplier_code: 'NCC-A', supplier_name: 'NCC A', region: 'MB', evaluation_type: 'Định kỳ', mch2: 'Hàng tươi', mch3: 'Rau củ', current_status: 'Hoàn thành', created_at: '2026-06-02 08:00:00', cancelled_at: null },
    { id: 3, ticket_code: 'B', supplier_id: 2, supplier_code: 'NCC-B', supplier_name: 'NCC B', region: 'MB', evaluation_type: 'Định kỳ', mch2: 'Hàng tươi', mch3: 'Thịt tươi', current_status: 'Hoàn thành', created_at: '2026-06-03 08:00:00', cancelled_at: null },
    { id: 4, ticket_code: 'C', supplier_id: 3, supplier_code: 'NCC-C', supplier_name: 'NCC C', region: 'MN', evaluation_type: 'Mở mới', mch2: 'Hàng khô', mch3: 'Đồ uống', current_status: 'Hoàn thành', created_at: '2026-06-04 08:00:00', cancelled_at: null },
    { id: 5, ticket_code: 'D', supplier_id: 4, supplier_code: 'NCC-D', supplier_name: 'NCC D', region: 'MN', evaluation_type: 'Mở mới', mch2: 'Hàng khô', mch3: 'Đồ uống', current_status: 'Hoàn thành', created_at: '2026-06-05 08:00:00', cancelled_at: null },
  ];
  const rounds = [
    { id: 11, ticket_id: 1, round_no: 1, assessment_date: '2026-07-02', completed_at: '2026-07-02 10:00:00', locked_at: '2026-07-02 10:00:00', total_score: 50, final_result: 'Không đạt', classification: 'D', status: 'Hoàn thành' },
    { id: 12, ticket_id: 2, round_no: 1, assessment_date: '2026-07-20', completed_at: '2026-07-20 10:00:00', locked_at: '2026-07-20 10:00:00', total_score: 80, final_result: 'Đạt mức khá', classification: 'B', status: 'Hoàn thành' },
    { id: 13, ticket_id: 3, round_no: 1, assessment_date: '2026-07-10', completed_at: '2026-07-10 10:00:00', locked_at: '2026-07-10 10:00:00', total_score: 55, final_result: 'Không đạt', classification: 'D', status: 'Hoàn thành' },
    { id: 14, ticket_id: 4, round_no: 1, assessment_date: '2026-07-12', completed_at: '2026-07-12 10:00:00', locked_at: '2026-07-12 10:00:00', total_score: 75, final_result: 'Đạt mức cơ bản', classification: 'C', status: 'Hoàn thành' },
    { id: 15, ticket_id: 5, round_no: 1, assessment_date: '2026-07-15', completed_at: '2026-07-15 10:00:00', locked_at: '2026-07-15 10:00:00', total_score: 95, final_result: 'Đạt mức cao', classification: 'A', status: 'Hoàn thành' },
  ];
  const primary = [
    { violation_id: 1, round_id: 12, evaluation_answer_id: 101, clause_code: 'LEGAL-01', category: 'Pháp lý' },
    { violation_id: 2, round_id: 12, evaluation_answer_id: 102, clause_code: 'LEGAL-02', category: 'Pháp lý' },
    { violation_id: 3, round_id: 13, evaluation_answer_id: 103, clause_code: 'QUALITY-01', category: 'Kiểm soát chất lượng' },
    { violation_id: 4, round_id: 15, evaluation_answer_id: 104, clause_code: 'LEGAL-03', category: 'Pháp lý' },
  ];
  const fallback = [
    { round_id: 13, evaluation_answer_id: 103, question_code: 'QUALITY-01', category: 'Kiểm soát chất lượng' },
    { round_id: 13, evaluation_answer_id: 105, question_code: 'TRACE-01', category: 'Truy xuất nguồn gốc' },
  ];
  return {
    listTicketsBefore(end, filters) {
      return tickets.filter((row) => row.created_at < end && (!filters.regions.length || filters.regions.includes(row.region)));
    },
    listWorkflowHistory() { return []; },
    listCompletedRounds(ids, end) { return rounds.filter((row) => ids.includes(row.ticket_id) && row.completed_at < end); },
    listViolationSources(ids) {
      return {
        primary: primary.filter((row) => ids.includes(row.round_id)),
        fallback: fallback.filter((row) => ids.includes(row.round_id)),
      };
    },
    filterOptions() { return { regions: ['MB', 'MN'], evaluation_types: ['Định kỳ', 'Mở mới'], mch2: ['Hàng tươi', 'Hàng khô'] }; },
  };
}

test('RUN-30 detail analytics use the latest evaluation per supplier and count violation occurrences', () => {
  const service = new StatisticalDashboardService({ repository: detailFixtureRepository() });
  const result = service.get({ periodType: 'MONTH', periodValue: '2026-07' });
  const rating = new Map(result.details.rating_distribution.items.map((row) => [row.code, row]));

  assert.equal(result.details.rating_distribution.total_suppliers, 4);
  assert.equal(rating.get('FAILED').count, 1);
  assert.equal(rating.get('BASIC').count, 1);
  assert.equal(rating.get('GOOD').count, 1, 'the latest NCC-A evaluation replaces its older failed result');
  assert.equal(rating.get('HIGH').count, 1);
  assert.equal([...rating.values()].reduce((sum, row) => sum + row.percentage, 0), 100);

  const industries = new Map(result.details.industry_performance.map((row) => [row.industry, row]));
  assert.deepEqual(industries.get('Rau củ'), {
    industry: 'Rau củ', mch3: 'Rau củ', total_suppliers: 1, passed_suppliers: 1, failed_suppliers: 0,
    passed_percentage: 100, failed_percentage: 0, average_score: 80,
  });
  assert.deepEqual(industries.get('Thịt tươi'), {
    industry: 'Thịt tươi', mch3: 'Thịt tươi', total_suppliers: 1, passed_suppliers: 0, failed_suppliers: 1,
    passed_percentage: 0, failed_percentage: 100, average_score: 55,
  });
  assert.deepEqual(industries.get('Đồ uống'), {
    industry: 'Đồ uống', mch3: 'Đồ uống', total_suppliers: 2, passed_suppliers: 2, failed_suppliers: 0,
    passed_percentage: 100, failed_percentage: 0, average_score: 85,
  });
  assert.equal(result.meta.industry_dimension, 'mch3');

  const violations = new Map(result.details.violation_distribution.items.map((row) => [row.code, row]));
  assert.equal(result.details.violation_distribution.total_violations, 5);
  assert.deepEqual(violations.get('LEGAL'), { code: 'LEGAL', label: 'Lỗi vi phạm điều khoản pháp lý', count: 3, percentage: 60 });
  assert.equal(violations.get('QUALITY_CONTROL').count, 1);
  assert.equal(violations.get('TRACEABILITY').count, 1);
  assert.equal(violations.get('QUALITY_CONTROL').percentage, 20);
  assert.equal(violations.get('TRACEABILITY').percentage, 20);
});

test('RUN-30 shared filters apply to KPI and all detailed datasets', () => {
  const service = new StatisticalDashboardService({ repository: detailFixtureRepository() });
  const result = service.get({ periodType: 'MONTH', periodValue: '2026-07', regions: ['MB'] });
  assert.equal(result.kpis.evaluated_supplier_count.current_value, 2);
  assert.equal(result.details.rating_distribution.total_suppliers, 2);
  assert.deepEqual(result.details.industry_performance.map((row) => row.industry), ['Rau củ', 'Thịt tươi']);
  assert.equal(result.details.violation_distribution.total_violations, 4);
});

test('RUN-30 exposes one dashboard route and switches local chart modes below KPI', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'public', 'js', 'state.js'), 'utf8');
  const segmentIndex = html.indexOf('id="dashboard-view-segment"');

  assert.ok(segmentIndex > html.indexOf('id="statistics-kpi-cards"'));
  assert.ok(segmentIndex < html.indexOf('id="statistics-overview-charts"'));
  assert.match(html, /data-dashboard-mode="overview">Tổng quan<[\s\S]*data-dashboard-mode="detail">Chi tiết</);
  assert.match(html, /id="rating-distribution-bar"[\s\S]*id="industry-performance-chart"[\s\S]*id="violation-distribution-canvas"/);
  assert.match(html, /statistics-composition-bar[^}]*height:\s*24px/);
  assert.match(html, /statistics-industry-row[^}]*grid-template-columns:\s*minmax\(145px,\s*22%\)\s+minmax\(240px,\s*1fr\)\s+88px\s+88px/);
  assert.doesNotMatch(html, /id="view-ncc-eval"/);
  assert.ok(!navigation.NAVIGATION_MANIFEST.some((item) => item.id === 'ncc-eval'));
  assert.equal(navigation.resolveRoute('/dashboard/ncc-evaluations', ['DASHBOARD.READ']).status, 'not_found');
  assert.match(state, /dashboardReport:\s*\{[\s\S]*mode:\s*'overview'/);
  assert.doesNotMatch(state, /nccEvaluationsDashboard/);

  const switcher = app.slice(app.indexOf('function renderDashboardMode'), app.indexOf('function validStatisticalDashboard'));
  assert.match(switcher, /statistics-overview-charts[\s\S]*statistics-detail-charts/);
  assert.match(switcher, /mode === 'detail'[\s\S]*drawIndustryPerformance[\s\S]*drawRatingDistribution[\s\S]*drawViolationDistribution/);
  assert.doesNotMatch(app.slice(app.indexOf('function selectDashboardMode'), app.indexOf('function validStatisticalDashboard')), /loadTab\(|api\(/);
  assert.match(app, /route\.split\('\?'\)\[0\] !== '\/dashboard\/ncc-evaluations'[\s\S]*history\.replaceState/);
});

test('RUN-30 chart palettes and tooltips implement the approved rules', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /FAILED:\s*'#220006'[\s\S]*BASIC:\s*'#73000E'[\s\S]*GOOD:\s*'#BA001D'[\s\S]*HIGH:\s*'#E53945'/);
  assert.match(app, /passed:\s*'#E53945'[\s\S]*failed:\s*'#220006'/);
  assert.match(app, /industry_dimension|row\.mch3\s*\|\|\s*row\.industry/);
  const industryRenderer = app.slice(app.indexOf('function drawIndustryPerformance'), app.indexOf('function drawViolationDistribution'));
  assert.match(industryRenderer, /Tổng NCC[\s\S]*Điểm TB/);
  assert.doesNotMatch(industryRenderer, /showStatisticsTooltip\([^\n]*Tổng NCC|showStatisticsTooltip\([^\n]*Điểm TB/);
  assert.match(app, /Số lượt:[\s\S]*Tỷ lệ:/);
});
