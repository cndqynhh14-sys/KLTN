'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/policy');
const { PERMISSIONS } = require('../authorization/permissionCatalog');
const { getContext } = require('../observability/context');
const ScoringPolicyRepository = require('../scoring/ScoringPolicyRepository');

const router = express.Router();
const repository = new ScoringPolicyRepository(db);

router.use(requireAuth, requirePermission(PERMISSIONS.SCORING_POLICY_MANAGE));

function requestContext(req, decisionId = null) {
  const context = getContext();
  return {
    requestId: context.request_id,
    correlationId: context.correlation_id,
    decisionId: decisionId || null,
    route: req.originalUrl,
  };
}

function hasPermission(user, permission) {
  return Array.isArray(user?.capabilities) && user.capabilities.includes(permission);
}

function actionEnvelope(row, user) {
  const allowed = [
    'scoring_policy.preview',
    'scoring_policy.simulate',
    'scoring_policy.impact',
    'scoring_policy.validate',
    'scoring_policy.create_draft',
  ];
  const disabled = {};
  const status = String(row?.status || '');
  if (status === 'DRAFT') allowed.push('scoring_policy.save_draft', 'scoring_policy.submit_review');
  else {
    disabled['scoring_policy.save_draft'] = 'scoring_policy_version_not_draft';
    disabled['scoring_policy.submit_review'] = 'scoring_policy_version_not_draft';
  }
  const canPublish = hasPermission(user, PERMISSIONS.SCORING_POLICY_PUBLISH);
  if (!canPublish) {
    disabled['scoring_policy.publish'] = 'forbidden_permission';
    disabled['scoring_policy.rollback'] = 'forbidden_permission';
  } else if (!repository.publishingEnabled()) {
    disabled['scoring_policy.publish'] = 'scoring_policy_publish_disabled';
    disabled['scoring_policy.rollback'] = 'scoring_policy_publish_disabled';
  } else {
    if (status === 'IN_REVIEW') allowed.push('scoring_policy.publish');
    else disabled['scoring_policy.publish'] = 'scoring_policy_version_not_in_review';
    if (['PUBLISHED', 'RETIRED'].includes(status) && !row.is_default) allowed.push('scoring_policy.rollback');
    else disabled['scoring_policy.rollback'] = row.is_default
      ? 'scoring_policy_already_default'
      : 'scoring_policy_rollback_target_invalid';
  }
  return { allowed_actions: allowed, disabled_reasons: disabled };
}

function mapVersion(row, includeDefinition = false, user = null) {
  if (!row) return row;
  const item = {
    id: row.id,
    policy_code: row.policy_code,
    policy_name: row.policy_name,
    version_no: row.version_no,
    status: row.status,
    schema_version: row.schema_version,
    checksum: row.checksum,
    formula_checksum: row.formula_checksum,
    version_note: row.version_note,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    decision_id: row.decision_id,
    lock_version: row.lock_version,
    is_default: !!row.is_default,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    submitted_at: row.submitted_at,
    submitted_by: row.submitted_by,
    published_at: row.published_at,
    published_by: row.published_by,
    retired_at: row.retired_at,
    retired_by: row.retired_by,
    ...actionEnvelope(row, user),
  };
  if (includeDefinition) item.definition = repository.definition(row);
  return item;
}

function sendError(res, error) {
  const payload = { error: error.code || 'scoring_policy_failed' };
  if (error.details?.current_lock_version != null) payload.current_lock_version = error.details.current_lock_version;
  if (Number.isInteger(error.details?.index)) payload.field_path = `${error.code?.includes('category') ? 'categories' : 'bands'}[${error.details.index}]`;
  return res.status(error.status || 500).json(payload);
}

router.get('/', (_req, res) => {
  res.json({ items: repository.listPolicies() });
});

router.get('/:policyCode/versions', (req, res) => {
  try {
    return res.json({ items: repository.listVersions(req.params.policyCode).map((row) => mapVersion(row, false, req.user)) });
  } catch (error) { return sendError(res, error); }
});

router.post('/:policyCode/versions', (req, res) => {
  try {
    const item = repository.createDraft({
      policyCode: req.params.policyCode,
      sourceVersionId: req.body?.source_version_id,
      note: req.body?.version_note,
      actor: req.user.userId,
      context: requestContext(req),
    });
    return res.status(201).json({ item: mapVersion(item, true, req.user) });
  } catch (error) { return sendError(res, error); }
});

router.get('/versions/:versionId', (req, res) => {
  try {
    const item = repository.requireVersion(req.params.versionId);
    return res.json({ item: mapVersion(item, true, req.user), events: repository.events(item.id) });
  } catch (error) { return sendError(res, error); }
});

router.put('/versions/:versionId', (req, res) => {
  try {
    const item = repository.updateDraft({
      versionId: req.params.versionId,
      expectedLockVersion: req.body?.lock_version,
      definition: req.body?.definition,
      note: req.body?.version_note,
      effectiveFrom: req.body?.effective_from,
      effectiveTo: req.body?.effective_to,
      actor: req.user.userId,
      context: requestContext(req),
    });
    return res.json({ item: mapVersion(item, true, req.user) });
  } catch (error) { return sendError(res, error); }
});

router.post('/versions/:versionId/validate', (req, res) => {
  try { return res.json(repository.validateVersion(req.params.versionId)); }
  catch (error) { return sendError(res, error); }
});

for (const action of ['simulate', 'impact']) {
  router.post(`/versions/:versionId/${action}`, (req, res) => {
    try {
      return res.json(repository.simulate({ versionId: req.params.versionId, fixtures: req.body?.fixtures || [] }));
    } catch (error) { return sendError(res, error); }
  });
}

router.post('/versions/:versionId/submit', (req, res) => {
  try {
    const item = repository.submit({
      versionId: req.params.versionId,
      expectedLockVersion: req.body?.lock_version,
      actor: req.user.userId,
      context: requestContext(req),
    });
    return res.json({ item: mapVersion(item, true, req.user) });
  } catch (error) { return sendError(res, error); }
});

for (const action of ['publish', 'rollback']) {
  router.post(`/versions/:versionId/${action}`, requirePermission(PERMISSIONS.SCORING_POLICY_PUBLISH), (req, res) => {
    try {
      const decisionId = String(req.body?.decision_id || '').trim();
      const item = repository[action]({
        versionId: req.params.versionId,
        expectedLockVersion: req.body?.lock_version,
        decisionId,
        actor: req.user.userId,
        context: requestContext(req, decisionId),
      });
      return res.json({ item: mapVersion(item, true, req.user) });
    } catch (error) { return sendError(res, error); }
  });
}

module.exports = router;
