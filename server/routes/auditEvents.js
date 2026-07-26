'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { AuditEventRepository } = require('../repositories/AuditEventRepository');
const { AuditReadError, AuditReadService } = require('../services/AuditReadService');

const SAFE_FILTER_NAMES = Object.freeze([
  'from', 'to', 'category', 'event', 'severity', 'actor', 'entity', 'entity_type',
  'outcome', 'request', 'correlation', 'uat', 'row_limit',
]);

function filterNames(query) {
  return SAFE_FILTER_NAMES.filter((name) => query[name] != null && query[name] !== '');
}

function deploymentLimit(value, hardMaximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, hardMaximum) : hardMaximum;
}

function createAuditEventsRouter(options = {}) {
  const router = express.Router();
  const authGuard = options.requireAuth || requireAuth;
  const permissionGuard = options.requirePermission || requirePermission;
  const readService = options.auditReadService || new AuditReadService(
    new AuditEventRepository(require('../db').db),
    {
      maxExportRows: deploymentLimit(process.env.AUDIT_EXPORT_MAX_ROWS, 10000),
      maxExportRangeDays: deploymentLimit(process.env.AUDIT_EXPORT_MAX_DAYS, 31),
    }
  );
  const eventService = options.auditEventService || require('../db').auditEventService;
  const globalAuditScope = { requireGlobalScope: true };
  const canReadAudit = options.requirePermission
    ? permissionGuard(PERMISSIONS.AUDIT_READ, globalAuditScope)
    : requirePermission(PERMISSIONS.AUDIT_READ, globalAuditScope);
  const canExportAudit = options.requirePermission
    ? permissionGuard(PERMISSIONS.AUDIT_EXPORT, globalAuditScope)
    : requirePermission(PERMISSIONS.AUDIT_EXPORT, globalAuditScope);

  function accessEvent(req, eventName, action, outcome, details = {}) {
    return eventService.record({
      eventName,
      actorUserId: req.user?.email || null,
      actorRoles: req.user?.roleCodes || [],
      requestId: req.requestId,
      correlationId: req.correlationId,
      uatRunId: req.uatRunId,
      entityType: details.entityType || 'AUDIT_COLLECTION',
      entityId: details.entityId || null,
      action,
      outcome,
      reasonCode: details.reasonCode || null,
      summary: eventName === 'audit.export' ? 'Audit events exported' : 'Audit events read',
      metadata: {
        access_type: action,
        target_event_id: details.targetEventId,
        export_format: details.exportFormat,
        row_count: details.rowCount,
        filter_names: filterNames(req.query),
      },
    });
  }

  function accessDescriptor(req) {
    if (req.path === '/export') {
      const format = String(req.query.format || 'csv').toUpperCase();
      return { eventName: 'audit.export', action: `EXPORT_${format}`, exportFormat: format };
    }
    if (req.path === '/retention/dry-run') return { eventName: 'audit.read', action: 'RETENTION_DRY_RUN' };
    if (/^\/\d+$/.test(req.path)) return { eventName: 'audit.read', action: 'DETAIL', entityId: req.path.slice(1) };
    return { eventName: 'audit.read', action: 'LIST' };
  }

  function auditDeniedGuard(guard) {
    return (req, res, next) => {
      const originalJson = res.json.bind(res);
      let continued = false;
      let recorded = false;
      res.json = (body) => {
        if (!continued && !recorded && (res.statusCode === 401 || res.statusCode === 403)) {
          recorded = true;
          const descriptor = accessDescriptor(req);
          accessEvent(req, descriptor.eventName, descriptor.action, 'DENIED', {
            entityType: descriptor.entityId ? 'AUDIT_EVENT' : 'AUDIT_COLLECTION',
            entityId: descriptor.entityId || null,
            targetEventId: descriptor.entityId,
            exportFormat: descriptor.exportFormat,
            rowCount: 0,
            reasonCode: body?.error || (res.statusCode === 401 ? 'unauthorized' : 'forbidden_permission'),
          });
        }
        return originalJson(body);
      };
      return guard(req, res, (error) => {
        continued = true;
        res.json = originalJson;
        return error ? next(error) : next();
      });
    };
  }

  function sendError(error, req, res, next) {
    if (error instanceof AuditReadError) {
      return res.status(error.status || 400).json({ error: error.code, request_id: req.requestId });
    }
    return next(error);
  }

  router.use(auditDeniedGuard(authGuard));

  router.get('/retention/dry-run', auditDeniedGuard(canReadAudit), (req, res, next) => {
    let auditWriteStarted = false;
    try {
      const report = readService.retentionDryRun(req.query);
      auditWriteStarted = true;
      accessEvent(req, 'audit.read', 'RETENTION_DRY_RUN', 'SUCCESS', { rowCount: report.total_eligible_rows });
      res.json({ report });
    } catch (error) {
      if (!auditWriteStarted) {
        auditWriteStarted = true;
        try {
          accessEvent(req, 'audit.read', 'RETENTION_DRY_RUN', 'FAILURE', { rowCount: 0, reasonCode: error.code || 'request_failed' });
        } catch (auditError) {
          return next(auditError);
        }
      }
      sendError(error, req, res, next);
    }
  });

  router.get('/export', auditDeniedGuard(canExportAudit), (req, res, next) => {
    let auditWriteStarted = false;
    try {
      const exported = readService.export(req.query, req.query.format);
      auditWriteStarted = true;
      accessEvent(req, 'audit.export', `EXPORT_${exported.format.toUpperCase()}`, 'SUCCESS', {
        exportFormat: exported.format.toUpperCase(),
        rowCount: exported.row_count,
      });
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      res.setHeader('Content-Type', exported.content_type);
      res.setHeader('Content-Disposition', `attachment; filename="audit-events-${stamp}.${exported.extension}"`);
      res.setHeader('X-Audit-Row-Count', String(exported.row_count));
      res.send(exported.content);
    } catch (error) {
      if (!auditWriteStarted) {
        auditWriteStarted = true;
        const format = String(req.query.format || 'csv').toUpperCase();
        try {
          accessEvent(req, 'audit.export', `EXPORT_${format}`, 'FAILURE', {
            exportFormat: format,
            rowCount: 0,
            reasonCode: error.code || 'request_failed',
          });
        } catch (auditError) {
          return next(auditError);
        }
      }
      sendError(error, req, res, next);
    }
  });

  router.get('/:id', auditDeniedGuard(canReadAudit), (req, res, next) => {
    let auditWriteStarted = false;
    try {
      const item = readService.detail(req.params.id);
      auditWriteStarted = true;
      accessEvent(req, 'audit.read', 'DETAIL', item ? 'SUCCESS' : 'FAILURE', {
        entityType: 'AUDIT_EVENT',
        entityId: String(req.params.id),
        targetEventId: String(req.params.id),
        rowCount: item ? 1 : 0,
        reasonCode: item ? null : 'not_found',
      });
      if (!item) return res.status(404).json({ error: 'audit_event_not_found', request_id: req.requestId });
      return res.json({ item });
    } catch (error) {
      if (!auditWriteStarted) {
        auditWriteStarted = true;
        try {
          accessEvent(req, 'audit.read', 'DETAIL', 'FAILURE', {
            entityType: 'AUDIT_EVENT', entityId: String(req.params.id), targetEventId: String(req.params.id),
            rowCount: 0, reasonCode: error.code || 'request_failed',
          });
        } catch (auditError) {
          return next(auditError);
        }
      }
      return sendError(error, req, res, next);
    }
  });

  router.get('/', auditDeniedGuard(canReadAudit), (req, res, next) => {
    let auditWriteStarted = false;
    try {
      const result = readService.list(req.query);
      auditWriteStarted = true;
      accessEvent(req, 'audit.read', 'LIST', 'SUCCESS', { rowCount: result.items.length });
      res.json(result);
    } catch (error) {
      if (!auditWriteStarted) {
        auditWriteStarted = true;
        try {
          accessEvent(req, 'audit.read', 'LIST', 'FAILURE', { rowCount: 0, reasonCode: error.code || 'request_failed' });
        } catch (auditError) {
          return next(auditError);
        }
      }
      sendError(error, req, res, next);
    }
  });

  return router;
}

let defaultRouter;
function lazyDefaultRouter(req, res, next) {
  if (!defaultRouter) defaultRouter = createAuditEventsRouter();
  return defaultRouter(req, res, next);
}

module.exports = lazyDefaultRouter;
module.exports.createAuditEventsRouter = createAuditEventsRouter;
