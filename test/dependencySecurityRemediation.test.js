'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function packageVersion(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
}

function versionAtLeast(actual, minimum) {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

test('security-patched dependency versions and official SheetJS provenance are pinned', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.nodemailer, '9.0.3');
  assert.equal(
    manifest.dependencies.xlsx,
    'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  );
  assert.equal(manifest.devDependencies.postcss, '8.5.25');
  assert.equal(manifest.overrides['body-parser'], '1.20.6');
  assert.ok(versionAtLeast(packageVersion('nodemailer'), '9.0.3'));
  assert.ok(versionAtLeast(packageVersion('xlsx'), '0.20.3'));
  assert.ok(versionAtLeast(packageVersion('postcss'), '8.5.18'));
  assert.ok(versionAtLeast(packageVersion('body-parser'), '1.20.6'));
});

test('SMTP transport disables external content access and enforces certificate validation', () => {
  const { buildSmtpTransportOptions } = require('../server/services/email');
  const options = buildSmtpTransportOptions({
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_PORT: '587',
    SMTP_USER: 'sender@example.invalid',
    SMTP_PASS: 'synthetic-secret',
  });
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.tls.minVersion, 'TLSv1.2');
});

test('mail header validation rejects CRLF and malformed single-recipient addresses', () => {
  const { validateEmailMessage } = require('../server/services/email');
  assert.deepEqual(validateEmailMessage({
    to: 'recipient@example.invalid',
    subject: 'Synthetic subject',
    htmlContent: '<p>safe</p>',
  }), {
    to: 'recipient@example.invalid',
    subject: 'Synthetic subject',
    htmlContent: '<p>safe</p>',
  });
  assert.throws(() => validateEmailMessage({
    to: 'recipient@example.invalid\r\nBcc: attacker@example.invalid',
    subject: 'Synthetic subject',
    htmlContent: '<p>safe</p>',
  }), /email_recipient_invalid/);
  assert.throws(() => validateEmailMessage({
    to: 'recipient@example.invalid',
    subject: 'Synthetic\r\nX-Injected: true',
    htmlContent: '<p>safe</p>',
  }), /email_subject_invalid/);
});

test('patched body parser preserves the explicit 32kb JSON request boundary', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.post('/synthetic', (_req, res) => res.status(204).end());
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.type }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/synthetic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(33 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'entity.too.large' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
