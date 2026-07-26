'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { WorkspaceService } = require('../services/WorkspaceService');
const { EvaluationWorkspaceProvider } = require('../services/EvaluationWorkspaceProvider');

function createWorkspaceRouter(options = {}) {
  const router = express.Router();
  const runtime = options.runtime || require('../db');
  const service = options.workspaceService || new WorkspaceService({
    providers: [
      new EvaluationWorkspaceProvider({ db: runtime.db, policyService: runtime.policyService }),
    ],
  });

  router.use(options.requireAuth || requireAuth);
  router.get('/', requirePermission(PERMISSIONS.EVALUATION_READ), async (req, res, next) => {
    try {
      return res.json(await service.getWorkspace({ user: req.user, query: req.query }));
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

let defaultRouter;
function lazyDefaultRouter(req, res, next) {
  if (!defaultRouter) defaultRouter = createWorkspaceRouter();
  return defaultRouter(req, res, next);
}

module.exports = lazyDefaultRouter;
module.exports.createWorkspaceRouter = createWorkspaceRouter;
