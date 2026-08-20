'use strict';

const express = require('express');
const multer = require('multer');
const { AuthorizationAdminError, AuthorizationAdminService } = require('../services/AuthorizationAdminService');
const { AuthorizationError } = require('../services/AuthorizationService');
const { LIMITS: WORKBOOK_LIMITS } = require('../services/QuestionImportService');
const { XLSX_MIME } = require('../services/personnelImportContract');

const personnelImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: WORKBOOK_LIMITS.maxBytes,
  },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype === XLSX_MIME) return callback(null, true);
    return callback(Object.assign(new Error('workbook_mime_invalid'), {
      code: 'workbook_mime_invalid',
      status: 415,
    }));
  },
});

function asyncBoundary(handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
}

function uploadPersonnelWorkbook(req, _res, next) {
  personnelImportUpload.single('file')(req, _res, next);
}

function createAuthorizationAdminRouter(options = {}) {
  const router = express.Router();
  const service = options.service;
  if (!service) throw new TypeError('authorization_admin_service_required');
  if (typeof options.authenticate !== 'function' || typeof options.authorize !== 'function') {
    throw new TypeError('authorization_admin_guards_required');
  }

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, options.authenticate, options.authorize);

  const context = (req) => ({
    actor: req.user.email,
    actorUserId: req.user.userId,
    requestId: req.requestId,
    correlationId: req.correlationId,
  });

  const personnelImportService = () => {
    if (!options.personnelImportService) throw new TypeError('personnel_import_service_required');
    return options.personnelImportService;
  };

  router.get('/personnel-import/template.xlsx', (req, res) => {
    const body = personnelImportService().templateWorkbook();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="personnel-import-template.xlsx"');
    res.send(body);
  });
  router.get('/personnel-import/example.xlsx', (req, res) => {
    const body = personnelImportService().exampleWorkbook();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="personnel-import-example.xlsx"');
    res.send(body);
  });
  router.post(
    '/personnel-import/batches/preview',
    uploadPersonnelWorkbook,
    asyncBoundary((req, res) => res.status(201).json({
      item: personnelImportService().preview({
        file: req.file,
        actor: req.user.email,
        context: context(req),
      }),
    }))
  );
  router.post(
    '/personnel-import/batches/:batchId/validate',
    asyncBoundary((req, res) => res.json({
      item: personnelImportService().validate(req.params.batchId, req.body || {}, context(req)),
    }))
  );
  router.post(
    '/personnel-import/batches/:batchId/commit',
    asyncBoundary((req, res) => res.json({
      item: personnelImportService().commit(req.params.batchId, {
        ...(req.body || {}),
        idempotencyKey: req.get('idempotency-key') || '',
      }, context(req)),
    }))
  );

  router.get('/catalog', (req, res) => res.json(service.catalog()));
  router.get('/export.xlsx', asyncBoundary((req, res) => {
    const result = service.exportWorkbook(req.query || {}, context(req));
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="authorization-${stamp}.xlsx"`);
    res.setHeader('X-Authorization-Row-Count', String(result.rowCount));
    res.send(result.buffer);
  }));
  router.get('/roles/:roleCode', (req, res) => res.json(service.roleDetail(req.params.roleCode)));
  router.post('/roles', asyncBoundary((req, res) => res.status(201).json(service.createRole(req.body || {}, context(req)))));
  router.patch('/roles/:roleCode', asyncBoundary((req, res) => res.json(service.updateRole(req.params.roleCode, req.body || {}, context(req)))));
  router.delete('/roles/:roleCode', asyncBoundary((req, res) => res.json(service.deleteRole(req.params.roleCode, req.body || {}, context(req)))));
  router.put('/roles/:roleCode/permissions', asyncBoundary((req, res) => res.json(service.setRolePermissions(req.params.roleCode, req.body || {}, context(req)))));
  router.put('/roles/:roleCode/configuration', asyncBoundary((req, res) => res.json(service.saveRoleConfiguration(req.params.roleCode, req.body || {}, context(req)))));

  // :userId is canonical. Email identifiers remain accepted by the service for
  // clients using the Phase 2 URL shape.
  router.get('/users/:userId', (req, res) => res.json(service.userDetail(req.params.userId)));
  router.put('/users/:userId/roles', asyncBoundary((req, res) => res.json(service.setUserRoles(req.params.userId, req.body || {}, context(req)))));
  router.put('/users/:userId/scopes', asyncBoundary((req, res) => res.json(service.setUserScopes(req.params.userId, req.body || {}, context(req)))));
  router.put('/users/:userId/authorization', asyncBoundary((req, res) => res.json(service.saveUserAuthorization(req.params.userId, req.body || {}, context(req)))));

  router.get('/approval-assignments', (req, res) => res.json({ items: service.listApprovalAssignments() }));
  router.post('/approval-assignments/preview', (req, res) => res.json(service.previewApprovalAssignment(req.body || {})));
  router.post('/approval-assignments/publish', asyncBoundary((req, res) => res.json(service.publishApprovalAssignment(req.body || {}, context(req)))));
  router.get('/history', (req, res) => res.json(service.historyPage(req.query || {})));

  router.use((error, req, res, next) => {
    const personnelError = error?.name === 'PersonnelImportError'
      || (typeof error?.code === 'string' && (
        error.code.startsWith('personnel_import_')
        || error.code.startsWith('workbook_')
        || error.code === 'exact_confirmation_required'
        || error.code === 'idempotency_key_conflict'
        || error.code === 'cannot_self_escalate'
      ));
    if (error instanceof multer.MulterError || personnelError) {
      const sizeLimit = error.code === 'LIMIT_FILE_SIZE';
      const code = sizeLimit ? 'workbook_size_limit_exceeded' : error.code;
      res.locals.error_code = code;
      return res.status(sizeLimit ? 413 : (error.status || 400)).json({
        error: code,
        ...(error.details || {}),
        request_id: req.requestId,
      });
    }
    if (!(error instanceof AuthorizationAdminError) && !(error instanceof AuthorizationError)) {
      const message = String(error?.message || '');
      if (message.includes('last_super_admin_required')) {
        res.locals.error_code = 'last_super_admin_required';
        return res.status(409).json({ error: 'last_super_admin_required', request_id: req.requestId });
      }
      return next(error);
    }
    res.locals.error_code = error.code;
    return res.status(error.status || 400).json({
      error: error.code,
      ...(error.details || {}),
      request_id: req.requestId,
    });
  });

  return router;
}

let defaultRouter = null;
function lazyAuthorizationAdminRouter(req, res, next) {
  if (!defaultRouter) {
    const { db, authorizationService, approvalAssignmentService, auditEventService } = require('../db');
    const { PersonnelImportService } = require('../services/PersonnelImportService');
    const { requireAuth } = require('../middleware/auth');
    const { requirePermission } = require('../middleware/policy');
    const { PERMISSIONS } = require('../authorization/permissionCatalog');
    const authorizationAdminService = new AuthorizationAdminService(
      db,
      authorizationService,
      approvalAssignmentService,
      auditEventService
    );
    defaultRouter = createAuthorizationAdminRouter({
      service: authorizationAdminService,
      personnelImportService: new PersonnelImportService(
        db,
        authorizationAdminService,
        authorizationService,
        auditEventService
      ),
      authenticate: requireAuth,
      authorize: requirePermission(PERMISSIONS.USER_MANAGE),
    });
  }
  return defaultRouter(req, res, next);
}

module.exports = lazyAuthorizationAdminRouter;
module.exports.createAuthorizationAdminRouter = createAuthorizationAdminRouter;
