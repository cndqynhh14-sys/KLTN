const test = require('node:test');
const assert = require('node:assert/strict');
const { sendEmail } = require('../server/services/email');

const ENV_KEYS = [
  'EMAIL_MODE',
  'EMAIL_PROVIDER',
  'DEV_EMAIL_CONSOLE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'GRAPH_CLIENT_ID',
  'GRAPH_CLIENT_SECRET',
  'GRAPH_TENANT_ID',
  'USE_AZURE_KEYVAULT',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] == null) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test('sendEmail returns ok in console mode without provider credentials', async () => {
  const env = snapshotEnv();
  try {
    process.env.EMAIL_MODE = 'console';
    delete process.env.EMAIL_PROVIDER;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.GRAPH_CLIENT_ID;
    delete process.env.GRAPH_CLIENT_SECRET;
    delete process.env.GRAPH_TENANT_ID;

    const ok = await sendEmail({
      to: 'user@masangroup.com',
      subject: 'Test',
      htmlContent: '<p>ok</p>',
    });

    assert.equal(ok, true);
  } finally {
    restoreEnv(env);
  }
});

test('sendEmail requires SMTP credentials when SMTP provider is selected', async () => {
  const env = snapshotEnv();
  try {
    delete process.env.EMAIL_MODE;
    delete process.env.DEV_EMAIL_CONSOLE;
    process.env.EMAIL_PROVIDER = 'smtp';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    await assert.rejects(
      () => sendEmail({ to: 'user@masangroup.com', subject: 'Test', htmlContent: '<p>ok</p>' }),
      /SMTP_USER and SMTP_PASS/
    );
  } finally {
    restoreEnv(env);
  }
});
