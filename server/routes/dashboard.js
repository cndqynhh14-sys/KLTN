const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const NccEvaluationsAggregateRepository = require('../repositories/dashboard/nccEvaluationsAggregateRepository');
const SupplierEvaluationStatisticsRepository = require('../repositories/dashboard/supplierEvaluationStatisticsRepository');
const NccEvaluationsAggregateService = require('../services/dashboard/nccEvaluationsAggregateService');
const StatisticalDashboardService = require('../services/dashboard/statisticalDashboardService');

const router = express.Router();
const nccEvaluationsAggregateService = new NccEvaluationsAggregateService({
  repository: new NccEvaluationsAggregateRepository(db),
});
const statisticalDashboardService = new StatisticalDashboardService({
  repository: new SupplierEvaluationStatisticsRepository(db),
});
router.use(requireAuth, requirePermission(PERMISSIONS.DASHBOARD_READ));

function sendDashboardError(err, res, next) {
  if (err && err.status === 400 && err.code === 'INVALID_DASHBOARD_PERIOD') {
    return res.status(400).json({
      error: {
        code: err.code,
        message: err.publicMessage || 'Kỳ báo cáo không hợp lệ.',
      },
    });
  }
  if (err && err.status === 400 && err.code === 'INVALID_MONTH') {
    return res.status(400).json({
      error: {
        code: err.code,
        message: err.publicMessage || 'Query parameter month must use YYYY-MM.',
      },
    });
  }
  return next(err);
}

router.get('/ncc-evaluations', (req, res, next) => {
  try {
    res.json(nccEvaluationsAggregateService.get(req.query.month));
  } catch (err) {
    sendDashboardError(err, res, next);
  }
});

router.get('/months', (req, res) => {
  res.json(nccEvaluationsAggregateService.months());
});

router.get('/statistics', (req, res, next) => {
  try {
    res.json(statisticalDashboardService.get({
      periodType: req.query.periodType || 'MONTH',
      periodValue: req.query.periodValue || req.query.period,
      regions: req.query.regions,
      evaluationTypes: req.query.evaluationTypes,
      mch2: req.query.mch2,
    }));
  } catch (err) {
    return sendDashboardError(err, res, next);
  }
});

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

router.get('/statistics/export', (req, res, next) => {
  try {
    const payload = statisticalDashboardService.get({
      periodType: req.query.periodType || 'MONTH',
      periodValue: req.query.periodValue || req.query.period,
      regions: req.query.regions,
      evaluationTypes: req.query.evaluationTypes,
      mch2: req.query.mch2,
    });
    const rows = [
      ['BÁO CÁO DASHBOARD ĐÁNH GIÁ NCC', payload.period.label],
      ['Chỉ số', 'Giá trị hiện tại', 'Kỳ trước', 'Thay đổi'],
      ['Số lượng NCC được đánh giá', payload.kpis.evaluated_supplier_count.current_value, payload.kpis.evaluated_supplier_count.previous_value, payload.kpis.evaluated_supplier_count.absolute_change],
      ['Số phiếu đánh giá NCC', payload.kpis.evaluation_ticket_count.current_value, payload.kpis.evaluation_ticket_count.previous_value, payload.kpis.evaluation_ticket_count.absolute_change],
      ['Số phiếu đạt', payload.kpis.passed_ticket_count.current_value, payload.kpis.passed_ticket_count.previous_value, payload.kpis.passed_ticket_count.absolute_change],
      ['Số phiếu không đạt', payload.kpis.failed_ticket_count.current_value, payload.kpis.failed_ticket_count.previous_value, payload.kpis.failed_ticket_count.absolute_change],
      [],
      ['Hạng', 'Mã NCC', 'Nhà cung cấp', 'Điểm bình quân', 'Xếp loại', 'Số phiếu'],
      ...payload.top_suppliers.map((row) => [row.rank, row.supplier_code, row.supplier_name, row.average_final_score, row.classification, row.evaluation_count]),
      [],
      ['Phân bố NCC theo mức xếp loại'],
      ['Mức xếp loại', 'Số NCC', 'Tỷ lệ (%)'],
      ...payload.details.rating_distribution.items.map((row) => [row.label, row.count, row.percentage]),
      [],
      ['Hiệu quả đánh giá theo ngành hàng'],
      ['MCH3', 'Tổng NCC', 'Đạt', 'Không đạt', 'Tỷ lệ đạt (%)', 'Tỷ lệ không đạt (%)', 'Điểm trung bình'],
      ...payload.details.industry_performance.map((row) => [row.mch3 || row.industry, row.total_suppliers, row.passed_suppliers, row.failed_suppliers, row.passed_percentage, row.failed_percentage, row.average_score]),
      [],
      ['Tỷ lệ theo nhóm vi phạm'],
      ['Nhóm vi phạm', 'Số lượt', 'Tỷ lệ (%)'],
      ...payload.details.violation_distribution.items.map((row) => [row.label, row.count, row.percentage]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    const safePeriod = payload.period.value.replace(/[^0-9A-Z-]/gi, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dashboard-ncc-${safePeriod}.csv"`);
    res.send(csv);
  } catch (err) {
    return sendDashboardError(err, res, next);
  }
});

module.exports = router;
