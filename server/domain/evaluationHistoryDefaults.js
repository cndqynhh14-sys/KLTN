'use strict';

const REUSABLE_EVALUATION_TYPES = new Set([
  'danh gia dinh ky',
  'dinh ky',
  'danh gia dot xuat',
  'dot xuat',
]);

function normalizeEvaluationType(value) {
  return String(value || '')
    .replace(/[\u0111\u0110]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function supportsPreviousEvaluationDefaults(value) {
  return REUSABLE_EVALUATION_TYPES.has(normalizeEvaluationType(value));
}

module.exports = {
  normalizeEvaluationType,
  supportsPreviousEvaluationDefaults,
};
