const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseDashboardPeriod, periodWindow } = require('../server/domain/reporting/dashboardPeriod');
const StatisticalDashboardService = require('../server/services/dashboard/statisticalDashboardService');

function fixtureRepository() {
  const tickets = [
    {
      id: 1,
      ticket_code: 'EVAL-001',
      supplier_id: 101,
      supplier_code: 'NCC-101',
      supplier_name: 'NCC Minh Anh',
      region: 'MB',
      evaluation_type: 'Đánh giá định kỳ',
      mch2: 'Thực phẩm tươi sống',
      current_status: 'Hoàn thành',
      created_at: '2026-06-20 08:00:00',
      cancelled_at: null,
    },
  ];
  const history = [
    { id: 1, ticket_id: 1, action: 'TICKET_CREATE', from_status: null, to_status: 'Khởi tạo', created_at: '2026-06-20 08:00:00' },
    { id: 2, ticket_id: 1, action: 'START', from_status: 'Khởi tạo', to_status: 'Đang xử lý', created_at: '2026-07-01 08:00:00' },
    { id: 3, ticket_id: 1, action: 'ROUND_1_COMPLETE', from_status: 'Đang xử lý', to_status: 'Chờ khắc phục', created_at: '2026-07-18 16:00:00' },
    { id: 4, ticket_id: 1, action: 'ROUND_2_OPEN', from_status: 'Chờ khắc phục', to_status: 'Đang đánh giá lần 2', created_at: '2026-08-01 08:00:00' },
    { id: 5, ticket_id: 1, action: 'FINAL_APPROVE', from_status: 'Đang đánh giá lần 2', to_status: 'Hoàn thành', created_at: '2026-08-03 16:00:00' },
  ];
  const rounds = [
    { id: 1, ticket_id: 1, round_no: 1, assessment_date: '2026-07-18', completed_at: '2026-07-18 15:00:00', locked_at: '2026-07-18 15:00:00', total_score: 55, final_result: 'Không đạt', classification: 'D', status: 'Hoàn thành' },
    { id: 2, ticket_id: 1, round_no: 2, assessment_date: '2026-08-03', completed_at: '2026-08-03 15:00:00', locked_at: '2026-08-03 15:00:00', total_score: 92, final_result: 'Đạt mức cao', classification: 'A', status: 'Hoàn thành' },
  ];
  return {
    listTicketsBefore(end, filters) {
      return tickets.filter((row) => row.created_at < end && (!filters.regions.length || filters.regions.includes(row.region)));
    },
    listWorkflowHistory(ids, end) { return history.filter((row) => ids.includes(row.ticket_id) && row.created_at < end); },
    listCompletedRounds(ids, end) { return rounds.filter((row) => ids.includes(row.ticket_id) && row.completed_at < end); },
    filterOptions() { return { regions: ['MB'], evaluation_types: ['Đánh giá định kỳ'], mch2: ['Thực phẩm tươi sống'] }; },
  };
}

test('dashboard periods support month, quarter, year and a six-period history', () => {
  assert.deepEqual(parseDashboardPeriod('MONTH', '2026-07'), {
    type: 'MONTH', value: '2026-07', label: 'Tháng 07/2026', periodStart: '2026-07-01', periodEndExclusive: '2026-08-01', timezone: 'Asia/Ho_Chi_Minh',
  });
  assert.equal(parseDashboardPeriod('QUARTER', '2026-Q3').periodEndExclusive, '2026-10-01');
  assert.equal(parseDashboardPeriod('YEAR', '2026').periodEndExclusive, '2027-01-01');
  assert.deepEqual(periodWindow(parseDashboardPeriod('MONTH', '2026-07')).map((row) => row.value), ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
  assert.throws(() => parseDashboardPeriod('QUARTER', '2026-Q5'), /Invalid dashboard reporting period/);
});

test('dashboard snapshot follows the ticket lifecycle once per period and final KPI uses round 2', () => {
  const service = new StatisticalDashboardService({ repository: fixtureRepository() });
  const june = service.get({ periodType: 'MONTH', periodValue: '2026-06' });
  const july = service.get({ periodType: 'MONTH', periodValue: '2026-07' });
  const august = service.get({ periodType: 'MONTH', periodValue: '2026-08' });

  assert.equal(june.status_distribution.items.find((row) => row.code === 'DRAFT').count, 1);
  assert.equal(july.status_distribution.items.find((row) => row.code === 'WAITING_CORRECTION').count, 1);
  assert.equal(july.kpis.evaluation_ticket_count.current_value, 0, 'round 1 is not a final completed ticket');
  assert.equal(august.status_distribution.items.find((row) => row.code === 'COMPLETED').count, 1);
  assert.equal(august.kpis.evaluated_supplier_count.current_value, 1);
  assert.equal(august.kpis.evaluation_ticket_count.current_value, 1);
  assert.equal(august.kpis.passed_ticket_count.current_value, 1);
  assert.equal(august.kpis.failed_ticket_count.current_value, 0);
  assert.equal(august.top_suppliers[0].average_final_score, 92);
  assert.equal(august.top_suppliers[0].classification, 'Cao');
  assert.equal(august.trend.length, 6);
});

test('dashboard trend counts completed tickets rather than distinct suppliers or completed rounds', () => {
  const tickets = [
    { id: 1, ticket_code: 'EVAL-A-1', supplier_id: 101, supplier_code: 'NCC-101', supplier_name: 'NCC A', current_status: 'Hoàn thành', created_at: '2026-07-01 08:00:00' },
    { id: 2, ticket_code: 'EVAL-A-2', supplier_id: 101, supplier_code: 'NCC-101', supplier_name: 'NCC A', current_status: 'Hoàn thành', created_at: '2026-08-01 08:00:00' },
  ];
  const history = [
    { id: 1, ticket_id: 1, to_status: 'Khởi tạo', created_at: '2026-07-01 08:00:00' },
    { id: 2, ticket_id: 1, to_status: 'Chờ khắc phục', created_at: '2026-07-20 16:00:00' },
    { id: 3, ticket_id: 1, to_status: 'Hoàn thành', created_at: '2026-08-10 16:00:00' },
    { id: 4, ticket_id: 2, to_status: 'Khởi tạo', created_at: '2026-08-01 08:00:00' },
    { id: 5, ticket_id: 2, to_status: 'Hoàn thành', created_at: '2026-08-15 16:00:00' },
  ];
  const rounds = [
    { id: 1, ticket_id: 1, round_no: 1, completed_at: '2026-07-20 15:00:00', total_score: 45, final_result: 'Không đạt', classification: 'D' },
    { id: 2, ticket_id: 1, round_no: 2, completed_at: '2026-08-10 15:00:00', total_score: 92, final_result: 'Đạt mức cao', classification: 'A' },
    { id: 3, ticket_id: 2, round_no: 1, completed_at: '2026-08-15 15:00:00', total_score: 50, final_result: 'Không đạt', classification: 'D' },
  ];
  const service = new StatisticalDashboardService({
    repository: {
      listTicketsBefore(end) { return tickets.filter((row) => row.created_at < end); },
      listWorkflowHistory(ids, end) { return history.filter((row) => ids.includes(row.ticket_id) && row.created_at < end); },
      listCompletedRounds(ids, end) { return rounds.filter((row) => ids.includes(row.ticket_id) && row.completed_at < end); },
      filterOptions() { return { regions: [], evaluation_types: [], mch2: [] }; },
    },
  });

  const august = service.get({ periodType: 'MONTH', periodValue: '2026-08' });
  const selected = august.trend.find((row) => row.is_selected);
  assert.equal(selected.evaluated_supplier_count, 1, 'the two tickets belong to one supplier');
  assert.equal(selected.evaluation_ticket_count, 2, 'both completed tickets are counted');
  assert.equal(selected.passed_ticket_count, 1, 'ticket 1 uses its final round 2 result');
  assert.equal(selected.failed_ticket_count, 1, 'ticket 2 uses its final round 1 result');
  assert.equal(selected.evaluation_ticket_count, selected.passed_ticket_count + selected.failed_ticket_count);
  assert.equal(selected.failed_rate, 0.5);
});

test('dashboard applies shared business filters and quarter completion rules', () => {
  const service = new StatisticalDashboardService({ repository: fixtureRepository() });
  const q3 = service.get({ periodType: 'QUARTER', periodValue: '2026-Q3', regions: ['MB'] });
  assert.equal(q3.kpis.evaluation_ticket_count.current_value, 1);
  assert.equal(q3.period.start, '2026-07-01');
  assert.equal(q3.filters.applied.regions[0], 'MB');
  const excluded = service.get({ periodType: 'QUARTER', periodValue: '2026-Q3', regions: ['MN'] });
  assert.equal(excluded.kpis.evaluation_ticket_count.current_value, 0);
  assert.equal(excluded.status_distribution.total, 0);
});

test('frontend exposes the complete supplier evaluation dashboard contract', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /DASHBOARD ĐÁNH GIÁ NCC/);
  assert.match(html, /data-dashboard-period-type="MONTH"[\s\S]*data-dashboard-period-type="QUARTER"[\s\S]*data-dashboard-period-type="YEAR"/);
  assert.match(html, /id="dashboard-filter-region"[\s\S]*id="dashboard-filter-evaluation-type"[\s\S]*id="dashboard-filter-mch2"/);
  assert.match(html, /id="dashboard-refresh"[\s\S]*data-action-id="dashboard\.refresh"[\s\S]*Làm mới/);
  assert.doesNotMatch(html, /id="dashboard-export"|Xuất báo cáo/);
  assert.match(html, /id="status-donut-canvas"/);
  assert.match(html, /id="statistics-ranking-body"/);
  assert.match(html, /id="quality-trend-canvas"/);
  assert.match(app, /\/dashboard\/statistics\?' \+ dashboardReportQuery\(\)/);
  assert.match(app, /function refreshStatisticalDashboardFilters\(\)/);
  assert.match(app, /regions:\s*\[\][\s\S]*evaluationTypes:\s*\[\][\s\S]*mch2:\s*\[\]/);
  assert.match(app, /\$\('dashboard-refresh'\)\?\.addEventListener\('click', refreshStatisticalDashboardFilters\)/);
  assert.doesNotMatch(app, /\/dashboard\/statistics\/export\?/);
  assert.match(app, /DASHBOARD_STATUS_COLORS/);
  assert.match(app, /Không thể tải dữ liệu\. Vui lòng thử lại\./);
});

test('RUN-27 dashboard removes secondary copy and quick search while promoting section titles', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

  assert.doesNotMatch(html, /id="global-command-search"|class="cmd-search"/);
  assert.doesNotMatch(app, /global-command-search/);
  assert.doesNotMatch(html, /T\u1ed5ng h\u1ee3p k\u1ebft qu\u1ea3, tr\u1ea1ng th\u00e1i x\u1eed l\u00fd v\u00e0 xu h\u01b0\u1edbng ch\u1ea5t l\u01b0\u1ee3ng nh\u00e0 cung c\u1ea5p/u);
  assert.doesNotMatch(html, /Snapshot t\u1ea1i th\u1eddi \u0111i\u1ec3m cu\u1ed1i k\u1ef3/u);
  assert.doesNotMatch(html, /\u0110i\u1ec3m b\u00ecnh qu\u00e2n t\u1eeb k\u1ebft qu\u1ea3 cu\u1ed1i c\u00f9ng h\u1ee3p l\u1ec7/u);
  assert.doesNotMatch(html, /S\u00e1u k\u1ef3 g\u1ea7n nh\u1ea5t \u00b7 s\u1ed1 NCC \u0111\u01b0\u1ee3c \u0111\u00e1nh gi\u00e1 v\u00e0 t\u1ef7 l\u1ec7 kh\u00f4ng \u0111\u1ea1t/u);
  assert.doesNotMatch(html, /id="statistics-period-caption"/);
  assert.doesNotMatch(app, /statistics-period-caption/);
  assert.match(html, /\.statistics-card-head h2\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*800;/);
  assert.match(html, /\.statistics-trend-head h2\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*800;/);
});

test('RUN-28 donut aggregation excludes extension and suspension while keeping displayed totals exact', () => {
  const statuses = [
    'Kh\u1edfi t\u1ea1o',
    '\u0110ang x\u1eed l\u00fd',
    'Ch\u1edd duy\u1ec7t (Lead)',
    'Ch\u1edd kh\u1eafc ph\u1ee5c',
    '\u0110ang \u0111\u00e1nh gi\u00e1 l\u1ea7n 2',
    'Gia h\u1ea1n',
    'T\u1ea1m ng\u1eebng',
  ];
  const tickets = statuses.map((currentStatus, index) => ({
    id: index + 1,
    ticket_code: `RUN28-${index + 1}`,
    supplier_id: index + 1,
    supplier_code: `NCC-${index + 1}`,
    supplier_name: `NCC ${index + 1}`,
    region: 'MB',
    evaluation_type: '\u0110\u00e1nh gi\u00e1 \u0111\u1ecbnh k\u1ef3',
    mch2: 'Synthetic',
    current_status: currentStatus,
    created_at: '2026-08-01 08:00:00',
    cancelled_at: null,
  }));
  const service = new StatisticalDashboardService({
    repository: {
      listTicketsBefore(end) { return tickets.filter((row) => row.created_at < end); },
      listWorkflowHistory() { return []; },
      listCompletedRounds() { return []; },
      filterOptions() { return { regions: ['MB'], evaluation_types: [], mch2: [] }; },
    },
  });

  const distribution = service.get({ periodType: 'MONTH', periodValue: '2026-08' }).status_distribution;
  assert.deepEqual(distribution.items.map((item) => item.code), [
    'DRAFT', 'IN_PROGRESS', 'WAITING_APPROVAL', 'WAITING_CORRECTION', 'ROUND_2', 'COMPLETED', 'CANCELLED',
  ]);
  assert.equal(distribution.total, 5);
  assert.equal(distribution.items.reduce((sum, item) => sum + item.count, 0), distribution.total);
  assert.equal(distribution.items.reduce((sum, item) => sum + item.percentage, 0), 100);
});

test('RUN-28 donut UI uses the approved palette, 60/40 layout, thicker ring and label-only nonzero legend', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const donut = app.slice(app.indexOf('function drawStatusDonut'), app.indexOf('function renderRanking'));

  const expectedColors = {
    DRAFT: '#F3C7CB',
    IN_PROGRESS: '#E98D95',
    WAITING_APPROVAL: '#E45C68',
    WAITING_CORRECTION: '#DC3545',
    ROUND_2: '#F02D48',
    COMPLETED: '#A30D22',
    CANCELLED: '#540812',
  };
  Object.entries(expectedColors).forEach(([code, color]) => {
    assert.match(app, new RegExp(`${code}:\\s*['"]${color}['"]`));
  });
  assert.match(app, /DASHBOARD_DONUT_EXCLUDED_STATUS_CODES\s*=\s*new Set\(\['EXTENDED',\s*'SUSPENDED'\]\)/);
  assert.match(html, /\.statistics-donut-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*3fr\)\s+minmax\(0,\s*2fr\)/);
  assert.match(html, /\.statistics-status-item\s*\{[^}]*grid-template-columns:\s*10px\s+minmax\(0,\s*1fr\)/);
  assert.match(donut, /Number\(item\.count\s*\|\|\s*0\)\s*>\s*0/);
  assert.doesNotMatch(donut, /el\('strong',[\s\S]*item\.count|el\('em',[\s\S]*item\.percentage/);
  assert.match(donut, /lineWidth\s*=\s*active\s*===\s*item\.code\s*\?\s*46\.5\s*:\s*40\.5/);
  assert.match(donut, /items\.reduce\(\(sum,\s*item\)\s*=>\s*sum\s*\+\s*Number\(item\.count/);
  assert.match(donut, /S\u1ed1 phi\u1ebfu:[\s\S]*T\u1ef7 l\u1ec7:/u);
});

test('RUN-29 ranking uses 1:5:2:2 columns, required alignment and score-only cells', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const ranking = app.slice(app.indexOf('function renderRanking'), app.indexOf('function drawQualityTrend'));

  assert.match(html, /<colgroup>\s*<col class="statistics-ranking-col-rank">\s*<col class="statistics-ranking-col-supplier">\s*<col class="statistics-ranking-col-score">\s*<col class="statistics-ranking-col-grade">\s*<\/colgroup>/);
  assert.match(html, /\.statistics-ranking-col-rank\s*\{\s*width:\s*10%;\s*\}/);
  assert.match(html, /\.statistics-ranking-col-supplier\s*\{\s*width:\s*50%;\s*\}/);
  assert.match(html, /\.statistics-ranking-col-score\s*\{\s*width:\s*20%;\s*\}/);
  assert.match(html, /\.statistics-ranking-col-grade\s*\{\s*width:\s*20%;\s*\}/);
  assert.match(html, /\.statistics-ranking-table th\s*\{[^}]*text-align:\s*center;/);
  assert.match(html, /\.statistics-ranking-table td:nth-child\(1\),[\s\S]*td:nth-child\(3\),[\s\S]*td:nth-child\(4\)\s*\{[^}]*text-align:\s*center;/);
  assert.match(html, /\.statistics-ranking-table td:nth-child\(2\)\s*\{[^}]*text-align:\s*left;/);
  assert.doesNotMatch(html, /statistics-score-track|statistics-score-fill|statistics-score-line/);
  assert.doesNotMatch(ranking, /statistics-score-track|statistics-score-fill|statistics-score-line|evaluation_count/);
  assert.match(ranking, /maximumFractionDigits:\s*1/);
  assert.match(ranking, /className:\s*'statistics-score',[\s\S]*text:\s*`\$\{[^}]+\}%`/);
});

test('RUN-29 trend uses stacked ticket columns, segment hit testing and subtle selected-period highlighting', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const trend = app.slice(app.indexOf('function drawQualityTrend'), app.indexOf('function validStatisticalDashboard'));

  assert.match(html, /\.statistics-chart-wrap\s*\{[^}]*min-width:\s*0;/);
  assert.match(html, /\.statistics-chart-scroll\s*\{[^}]*overflow-x:\s*hidden;/);
  assert.match(html, /Phiếu đạt[\s\S]*Phiếu không đạt[\s\S]*Tỷ lệ không đạt \(%\)/);
  assert.match(html, /Tỷ lệ không đạt = Phiếu không đạt \/ Tổng số phiếu đánh giá/);
  assert.match(trend, /const width = Math\.max\(280,\s*Math\.round\(canvas\.parentElement\?\.clientWidth \|\| 760\)\)/);
  assert.match(trend, /evaluation_ticket_count:\s*total/);
  assert.match(trend, /const columnWidth = Math\.max\(16,\s*Math\.min\(78,\s*step \* \.54\)\)/);
  assert.doesNotMatch(trend, /Math\.max\(680/);
  assert.doesNotMatch(trend, /row\.evaluated_supplier_count/);
  assert.match(trend, /const yCount[\s\S]*const yRate/);
  assert.match(trend, /drawSegment\(row, 'passed'[\s\S]*drawSegment\(row, 'failed'/);
  assert.match(trend, /context\.lineTo\(x, y\)[\s\S]*context\.stroke\(\)/);
  assert.match(trend, /row\.is_selected[\s\S]*rgba\(37,99,235,\.045\)/);
  assert.doesNotMatch(trend, /selected \? '#D84646'/);
  assert.match(trend, /_dashboardTrendHitTargets/);
  assert.match(trend, /target\.kind === 'rate'[\s\S]*target\.kind === 'passed'/);
  assert.match(trend, /Phiếu đạt'[\s\S]*'Phiếu không đạt'/);
  assert.doesNotMatch(trend, /NCC \u0111\u01b0\u1ee3c \u0111\u00e1nh gi\u00e1:/u);
  assert.match(trend, /fmtInt\(row\.evaluation_ticket_count\)/);
  assert.match(trend, /formatRate\(row\.failed_rate\)/);
  assert.match(trend, /width < 520 && label\.includes\('\/'\)/);
  assert.match(trend, /width >= 560 \|\| row\.is_selected/);
});
