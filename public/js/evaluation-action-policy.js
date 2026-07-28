(function initEvaluationActionPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QLCL_EVALUATION_ACTION_POLICY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function evaluationActionPolicyFactory() {
  'use strict';

  const ACTION_BACKEND_KEYS = Object.freeze({
    'evaluation.view': 'view',
    'evaluation.history': 'view',
    'evaluation.edit': 'edit',
    'evaluation.delete': 'delete',
    'evaluation.score': 'score',
    'evaluation.complete': 'end',
    'evaluation.round2_start': 'round2_start',
  });

  function normalizedStatus(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .trim()
      .toLowerCase();
  }

  const STATUS_ACTIONS = Object.freeze({
    'khoi tao': Object.freeze([
      'evaluation.view', 'evaluation.score', 'evaluation.history', 'evaluation.edit', 'evaluation.delete',
    ]),
    'dang xu ly': Object.freeze([
      'evaluation.view', 'evaluation.score', 'evaluation.history', 'evaluation.edit',
    ]),
    'cho khac phuc': Object.freeze([
      'evaluation.complete', 'evaluation.round2_start', 'evaluation.view', 'evaluation.history',
    ]),
    'gia han': Object.freeze([
      'evaluation.complete', 'evaluation.round2_start', 'evaluation.view', 'evaluation.history',
    ]),
    'dang danh gia lan 2': Object.freeze([
      'evaluation.view', 'evaluation.score', 'evaluation.history',
    ]),
    'hoan thanh': Object.freeze(['evaluation.view', 'evaluation.history']),
    'huy': Object.freeze(['evaluation.view', 'evaluation.history']),
    'da huy': Object.freeze(['evaluation.view', 'evaluation.history']),
    'tam ngung': Object.freeze(['evaluation.view', 'evaluation.history']),
    'cho duyet (lead)': Object.freeze(['evaluation.view', 'evaluation.history']),
    'cho duyet (tbp)': Object.freeze(['evaluation.view', 'evaluation.history']),
    'cho duyet (gdk)': Object.freeze(['evaluation.view', 'evaluation.history']),
  });

  function getEligibleEvaluationActionIds(ticket = {}) {
    const allowed = new Set(Array.isArray(ticket.allowed_actions) ? ticket.allowed_actions : []);
    const candidates = STATUS_ACTIONS[normalizedStatus(ticket.status || ticket.current_status)] || [];
    return candidates.filter((actionId) => allowed.has(ACTION_BACKEND_KEYS[actionId]));
  }

  return Object.freeze({ ACTION_BACKEND_KEYS, STATUS_ACTIONS, getEligibleEvaluationActionIds });
});
