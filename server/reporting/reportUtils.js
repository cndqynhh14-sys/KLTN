'use strict';

const crypto = require('node:crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function checksum(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function reportError(code, status = 400, details = {}) {
  return Object.assign(new Error(code), { code, status, details });
}

function parseJson(value, code = 'report_template_definition_invalid') {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw reportError(code);
  }
}

module.exports = { checksum, parseJson, reportError, stableJson, stableValue };
