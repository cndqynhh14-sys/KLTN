// Email delivery for OTP and workflow notifications.
// Graph mode keeps the existing app-permission flow; SMTP mode lets a configured
// mailbox send mail directly when SMTP AUTH is available.

const https = require('https');
const nodemailer = require('nodemailer');
const { DefaultAzureCredential } = require('@azure/identity');
const { SecretClient } = require('@azure/keyvault-secrets');
const logger = require('../logger');

const DEFAULT_SENDER = 'iso-app@masangroup.onmicrosoft.com';
const EMAIL_PATTERN = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

let credentials = null;
let accessToken = null;
let tokenExpiry = 0;
let smtpTransporter = null;

function boolEnv(name, defaultValue = false) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function boolValue(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function boundedInteger(value, fallback, { minimum = 1, maximum = 300000 } = {}) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function validateHeaderText(value, code, maximum = 200) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function validateMailbox(value, code = 'email_recipient_invalid') {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (normalized.length > 320 || CONTROL_CHARACTERS.test(normalized) || !EMAIL_PATTERN.test(normalized)) {
    throw new Error(code);
  }
  return normalized;
}

function validateEmailMessage({ to, subject, htmlContent }) {
  const html = String(htmlContent == null ? '' : htmlContent);
  if (Buffer.byteLength(html, 'utf8') > 256 * 1024) throw new Error('email_content_too_large');
  return {
    to: validateMailbox(to),
    subject: validateHeaderText(subject, 'email_subject_invalid'),
    htmlContent: html,
  };
}

function hasGraphCredentials() {
  return !!(
    process.env.USE_AZURE_KEYVAULT === 'true' ||
    (process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET && process.env.GRAPH_TENANT_ID)
  );
}

function hasSmtpCredentials() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function selectedProvider() {
  const configured = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (configured) return configured;
  if (hasSmtpCredentials()) return 'smtp';
  if (hasGraphCredentials()) return 'graph';
  return 'fallback';
}

function formatAddress(address, name) {
  if (!name) return address;
  const safeName = validateHeaderText(name, 'email_from_name_invalid', 160);
  return '"' + safeName.replace(/"/g, '\\"') + '" <' + address + '>';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSmtpTransportOptions(env = process.env) {
  const port = boundedInteger(env.SMTP_PORT, 587, { maximum: 65535 });
  const secure = boolValue(env.SMTP_SECURE, port === 465);
  const service = String(env.SMTP_SERVICE || '').trim();
  if (service && CONTROL_CHARACTERS.test(service)) throw new Error('smtp_service_invalid');
  const host = String(env.SMTP_HOST || 'smtp.office365.com').trim();
  if (!service && (!host || CONTROL_CHARACTERS.test(host))) throw new Error('smtp_host_invalid');
  const options = service ? { service } : { host, port, secure };
  return {
    ...options,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
    requireTLS: boolValue(env.SMTP_REQUIRE_TLS, !secure),
    connectionTimeout: boundedInteger(env.SMTP_CONNECTION_TIMEOUT_MS, 10000),
    greetingTimeout: boundedInteger(env.SMTP_GREETING_TIMEOUT_MS, 10000),
    socketTimeout: boundedInteger(env.SMTP_SOCKET_TIMEOUT_MS, 20000),
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
  };
}

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;
  smtpTransporter = nodemailer.createTransport(buildSmtpTransportOptions());
  return smtpTransporter;
}

async function sendSmtpEmail({ to, subject, htmlContent }) {
  if (!hasSmtpCredentials()) {
    throw new Error('SMTP_USER and SMTP_PASS must be configured for EMAIL_PROVIDER=smtp');
  }

  const fromAddress = validateMailbox(
    process.env.SMTP_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER,
    'email_from_invalid',
  );
  const fromName = process.env.SMTP_FROM_NAME || process.env.EMAIL_FROM_NAME || 'QLCL';
  const replyTo = validateMailbox(
    process.env.SMTP_REPLY_TO || process.env.SMTP_USER,
    'email_reply_to_invalid',
  );
  const info = await getSmtpTransporter().sendMail({
    from: formatAddress(fromAddress, fromName),
    replyTo,
    to,
    subject,
    html: htmlContent,
  });

  logger.info('[email:smtp] sent', { messageId: info.messageId });
  return true;
}

async function loadCredentials() {
  if (credentials) return credentials;

  if (process.env.USE_AZURE_KEYVAULT === 'true') {
    const vaultName = process.env.KEY_VAULT_NAME;
    if (!vaultName) throw new Error('KEY_VAULT_NAME not set');
    const sc = new SecretClient('https://' + vaultName + '.vault.azure.net', new DefaultAzureCredential());
    const [clientId, clientSecret, tenantId] = await Promise.all([
      sc.getSecret('ms-graph-client-id').then((s) => s.value),
      sc.getSecret('ms-graph-client-secret').then((s) => s.value),
      sc.getSecret('ms-graph-tenant-id').then((s) => s.value),
    ]);
    credentials = { clientId, clientSecret, tenantId, sender: process.env.GRAPH_SENDER || DEFAULT_SENDER };
  } else {
    credentials = {
      clientId: process.env.GRAPH_CLIENT_ID,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
      tenantId: process.env.GRAPH_TENANT_ID,
      sender: process.env.GRAPH_SENDER || DEFAULT_SENDER,
    };
  }
  logger.info('[email] Credentials loaded');
  return credentials;
}

function httpsPost(host, pathUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: pathUrl, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const c = await loadCredentials();
  const form =
    'grant_type=client_credentials' +
    '&client_id=' + encodeURIComponent(c.clientId) +
    '&client_secret=' + encodeURIComponent(c.clientSecret) +
    '&scope=' + encodeURIComponent('https://graph.microsoft.com/.default');

  const res = await httpsPost(
    'login.microsoftonline.com',
    '/' + c.tenantId + '/oauth2/v2.0/token',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    form
  );
  if (res.status !== 200) throw new Error('Token fetch failed: ' + res.status);
  const parsed = JSON.parse(res.data);
  accessToken = parsed.access_token;
  tokenExpiry = Date.now() + parsed.expires_in * 1000;
  return accessToken;
}

async function sendEmail({ to, subject, htmlContent }) {
  const message = validateEmailMessage({ to, subject, htmlContent });
  if (process.env.EMAIL_MODE === 'console' || process.env.DEV_EMAIL_CONSOLE === 'true') {
    logger.info('[email:console] accepted');
    return true;
  }

  const provider = selectedProvider();
  if (provider === 'smtp') {
    return sendSmtpEmail(message);
  }
  if (provider !== 'graph') {
    logger.info('[email:dev-fallback] accepted');
    return true;
  }
  if (!hasGraphCredentials()) {
    throw new Error('Graph credentials must be configured for EMAIL_PROVIDER=graph');
  }

  const token = await getAccessToken();
  const c = await loadCredentials();
  const body = JSON.stringify({
    message: {
      subject: message.subject,
      body: { contentType: 'HTML', content: message.htmlContent },
      toRecipients: [{ emailAddress: { address: message.to } }],
    },
    saveToSentItems: false,
  });

  const res = await httpsPost(
    'graph.microsoft.com',
    '/v1.0/users/' + encodeURIComponent(c.sender) + '/sendMail',
    {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body
  );
  if (res.status !== 202) throw new Error('sendMail failed: ' + res.status);
  return true;
}

function buildWorkflowEmail({ title, ticketCode, supplierName, status, comment }) {
  return {
    subject: `QLCL - ${title}: ${ticketCode}`,
    htmlContent: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px">
        <h2 style="color:#1a2232;margin:0 0 12px">${escapeHtml(title)}</h2>
        <p><b>Phi&#7871;u:</b> ${escapeHtml(ticketCode)}</p>
        <p><b>NCC:</b> ${escapeHtml(supplierName)}</p>
        <p><b>Tr&#7841;ng th&#225;i:</b> ${escapeHtml(status)}</p>
        ${comment ? `<p><b>Ghi ch&#250;:</b> ${escapeHtml(comment)}</p>` : ''}
        <p style="font-size:12px;color:#6b7280">Email &#273;&#432;&#7907;c g&#7917;i t&#7921; &#273;&#7897;ng t&#7915; h&#7879; th&#7889;ng QLCL.</p>
      </div>
    `,
  };
}

function buildOtpEmail(code) {
  return {
    subject: 'QLCL - M\u00e3 x\u00e1c th\u1ef1c \u0111\u0103ng nh\u1eadp: ' + code,
    htmlContent: `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px">
        <h2 style="color:#1a2232;margin-bottom:8px">M&#227; x&#225;c th&#7921;c QLCL Dashboard</h2>
        <p style="color:#4b5563">Nh&#7853;p m&#227; sau v&#224;o m&#224;n h&#236;nh &#273;&#259;ng nh&#7853;p:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#c8102e;background:#fff0f1;padding:16px 24px;text-align:center;border-radius:8px;margin:20px 0">
          ${escapeHtml(code)}
        </div>
        <p style="color:#6b7280;font-size:13px">M&#227; c&#243; hi&#7879;u l&#7921;c trong 5 ph&#250;t. N&#7871;u b&#7841;n kh&#244;ng y&#234;u c&#7847;u m&#227; n&#224;y, vui l&#242;ng b&#7887; qua email.</p>
      </div>
    `,
  };
}

module.exports = {
  buildOtpEmail,
  buildSmtpTransportOptions,
  buildWorkflowEmail,
  sendEmail,
  validateEmailMessage,
};
