'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PDF_RENDER_MAX_BUFFER = 100 * 1024 * 1024;

function renderPdf(html) {
  return execFileSync(process.execPath, [
    path.resolve(__dirname, '..', 'services', 'renderPdfWithPlaywright.js'),
    '-',
    '-',
  ], {
    input: html,
    maxBuffer: PDF_RENDER_MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

module.exports = { renderPdf };
