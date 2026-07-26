'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const NotificationRepository = require('../repositories/NotificationRepository');
const { NotificationService, NOTIFICATION_TYPES } = require('../services/NotificationService');

function createNotificationsRouter(options = {}) {
  const router = express.Router();
  const runtime = options.runtime || require('../db');
  const service = options.notificationService || new NotificationService({
    notificationRepository: new NotificationRepository(runtime.db),
    policyService: runtime.policyService,
    warningDays: process.env.NOTIFICATION_DEADLINE_WARNING_DAYS,
  });

  router.use(options.requireAuth || requireAuth);

  router.get('/', (req, res, next) => {
    try { res.json(service.listForUser(req.user, req.query)); } catch (error) { next(error); }
  });

  router.patch('/:id/read', (req, res, next) => {
    try {
      const item = service.markReadForUser(Number(req.params.id), req.user);
      if (!item) return res.status(404).json({ error: 'notification_not_found' });
      return res.json({ item });
    } catch (error) { return next(error); }
  });

  router.post('/read-all', (req, res, next) => {
    try { res.json(service.markAllReadForUser(req.user)); } catch (error) { next(error); }
  });

  router.post('/system', requirePermission(PERMISSIONS.SYSTEM_ADMIN), (req, res, next) => {
    try {
      const kind = String(req.body?.kind || '').toUpperCase();
      const type = kind === 'MAINTENANCE' ? NOTIFICATION_TYPES.SYSTEM_MAINTENANCE
        : kind === 'INCIDENT' ? NOTIFICATION_TYPES.SYSTEM_INCIDENT : '';
      if (!type || !String(req.body?.event_key || '').trim()) return res.status(400).json({ error: 'invalid_system_notification' });
      const receivers = Array.isArray(req.body?.receivers) ? req.body.receivers : [];
      service.createSystemAnnouncement({
        type,
        title: req.body.title,
        message: req.body.message,
        receivers,
        actor: req.user,
        eventKey: String(req.body.event_key).trim(),
        severity: String(req.body.severity || 'MEDIUM').toUpperCase(),
      });
      return res.status(202).json({ accepted: true });
    } catch (error) { return next(error); }
  });

  return router;
}

let defaultRouter;
function lazyDefaultRouter(req, res, next) {
  if (!defaultRouter) defaultRouter = createNotificationsRouter();
  return defaultRouter(req, res, next);
}

module.exports = lazyDefaultRouter;
module.exports.createNotificationsRouter = createNotificationsRouter;
