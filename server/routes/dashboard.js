const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const NccEvaluationsAggregateRepository = require('../repositories/dashboard/nccEvaluationsAggregateRepository');
const NccEvaluationsAggregateService = require('../services/dashboard/nccEvaluationsAggregateService');
const StatisticalDashboardService = require('../services/dashboard/statisticalDashboardService');

const router = express.Router();
const nccEvaluationsAggregateService = new NccEvaluationsAggregateService({
  repository: new NccEvaluationsAggregateRepository(db),
});
const statisticalDashboardService = new StatisticalDashboardService({
  nccEvaluationsAggregateService,
});
router.use(requireAuth, requirePermission(PERMISSIONS.DASHBOARD_READ));

function sendDashboardError(err, res, next) {
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
    res.json(statisticalDashboardService.get(req.query.period));
  } catch (err) {
    if (err && err.status === 400 && err.code === 'INVALID_MONTH') {
      return res.status(400).json({
        error: {
          code: err.code,
          message: 'Query parameter period must use YYYY-MM.',
        },
      });
    }
    return next(err);
  }
});

module.exports = router;
