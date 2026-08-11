'use strict';

function normalizeSupplierCode(value) {
  return String(value || '').trim().toUpperCase();
}

module.exports = { normalizeSupplierCode };
