'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

test('RUN-02 evaluation list export button uses the approved label', () => {
  const button = indexHtml.match(/<button\s+id="eval-export-excel"[^>]*>([^<]*)<\/button>/);

  assert.ok(button, 'evaluation export button must exist');
  assert.equal(button[1].trim(), 'Export Excel');
  assert.doesNotMatch(indexHtml, />Xuất danh sách [Ee]xcel<\/button>/);
});
