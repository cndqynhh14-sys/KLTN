'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { PERMISSIONS } = require('../authorization/permissionCatalog');

const ROOT = path.resolve(__dirname, '..', '..');
const GUIDE_FILES = Object.freeze({
  'role-permission-management': 'docs/user-guide/role-permission-management.md',
  'question-template-management': 'docs/user-guide/question-template-management.md',
  'question-template-import': 'docs/user-guide/question-template-import.md',
  'report-template-management': 'docs/user-guide/report-template-management.md',
  'replace-current-report': 'docs/user-guide/replace-current-report.md',
  'compliance-overview-and-scoring-policy': 'docs/user-guide/compliance-overview-and-scoring-policy.md',
  'report-troubleshooting': 'docs/user-guide/report-troubleshooting.md',
  'configuration-rollback': 'docs/admin-runbook/configuration-rollback.md',
});

const FILE_TO_SLUG = Object.freeze(Object.fromEntries(
  Object.entries(GUIDE_FILES).map(([slug, file]) => [path.basename(file), slug]),
));

const GUIDE_PERMISSIONS = Object.freeze({
  'role-permission-management': PERMISSIONS.USER_MANAGE,
  'question-template-management': PERMISSIONS.QUESTION_TEMPLATE_MANAGE,
  'question-template-import': PERMISSIONS.QUESTION_TEMPLATE_MANAGE,
  'report-template-management': PERMISSIONS.REPORT_READ,
  'replace-current-report': PERMISSIONS.REPORT_READ,
  'compliance-overview-and-scoring-policy': PERMISSIONS.REPORT_READ,
  'report-troubleshooting': PERMISSIONS.REPORT_READ,
  'configuration-rollback': PERMISSIONS.REPORT_READ,
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

function safeHref(rawHref) {
  const href = String(rawHref || '').trim();
  if (/^https:\/\/[^\s]+$/i.test(href)) return href;
  if (/^#[a-z0-9-]+$/.test(href)) return href;
  const match = href.match(/(?:^|\/)([^/#]+\.md)(?:#([a-z0-9-]+))?$/i);
  if (!match) return '#';
  let slug = FILE_TO_SLUG[match[1]];
  if (!slug && match[1].toLowerCase() === 'readme.md') slug = 'role-permission-management';
  if (!slug) return '#';
  return `/qlcl/help/${slug}${match[2] ? `#${match[2]}` : ''}`;
}

function renderInline(value) {
  const tokens = [];
  const tokenized = String(value || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const token = `HELP_LINK_${tokens.length}_TOKEN`;
    const safe = safeHref(href);
    const external = safe.startsWith('https://');
    tokens.push(`<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(label)}</a>`);
    return token;
  });
  let html = escapeHtml(tokenized)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  tokens.forEach((link, index) => {
    html = html.replace(`HELP_LINK_${index}_TOKEN`, link);
  });
  return html;
}

function renderGuide(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let list = null;
  let inCode = false;
  let codeLines = [];

  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList();
      if (inCode) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const explicitAnchor = line.match(/^<a id="([a-z0-9-]+)"><\/a>$/);
    if (explicitAnchor) {
      closeList();
      output.push(`<a id="${explicitAnchor[1]}" class="guide-anchor" aria-hidden="true"></a>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level} id="${slugify(heading[2])}">${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextList = unordered ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    output.push(`<p>${renderInline(line)}</p>`);
  }
  closeList();
  if (inCode) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  return output.join('\n');
}

function renderPage(slug, markdown) {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1] || 'Hướng dẫn QLCL';
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — QLCL</title>
  <link rel="icon" href="/qlcl/winmart-logo.png">
  <style>
    :root{font-family:"Be Vietnam Pro",system-ui,sans-serif;color:#172033;background:#f7f7fa;line-height:1.65}
    *{box-sizing:border-box}body{margin:0}.guide-shell{max-width:900px;margin:0 auto;padding:24px 20px 64px}
    .guide-nav{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-bottom:20px;padding:12px 16px;background:#fff;border:1px solid #e2e5ec;border-radius:12px;position:sticky;top:8px;z-index:2}
    .guide-nav a,.guide-content a{color:#a5112a;text-underline-offset:3px}.guide-nav a{font-weight:700}.guide-slug{color:#667085;font-size:.85rem;overflow-wrap:anywhere}
    .guide-content{background:#fff;border:1px solid #e2e5ec;border-radius:16px;padding:clamp(20px,4vw,48px);box-shadow:0 8px 24px rgba(25,31,45,.06)}
    h1{font-size:clamp(1.65rem,5vw,2.4rem);line-height:1.25;margin-top:0}h2{font-size:1.35rem;margin-top:2rem;border-top:1px solid #eceef3;padding-top:1.25rem}h3{font-size:1.1rem;margin-top:1.5rem}h4{font-size:1rem}
    p,li{max-width:78ch}code{background:#f2f3f6;border-radius:4px;padding:.1em .35em;font-size:.9em}pre{overflow:auto;background:#172033;color:#fff;padding:16px;border-radius:10px}pre code{background:transparent;padding:0}
    .guide-anchor{scroll-margin-top:88px}@media print{.guide-nav{display:none}.guide-shell{padding:0}.guide-content{border:0;box-shadow:none;padding:0}}@media(max-width:520px){.guide-shell{padding:12px 10px 40px}.guide-content{border-radius:12px}.guide-nav{top:4px}}
  </style>
</head>
<body><main class="guide-shell"><nav class="guide-nav" aria-label="Điều hướng hướng dẫn"><a href="/qlcl/">← Quay lại QLCL</a><span class="guide-slug">${escapeHtml(slug)}</span></nav><article class="guide-content">${renderGuide(markdown)}</article></main></body>
</html>`;
}

function requireHelpAuthentication(req, res, next) {
  // Lazy import keeps the pure Markdown renderer testable without booting auth/DB.
  const { requireAuth } = require('../middleware/auth');
  return requireAuth(req, res, next);
}

function requireGuidePermission(req, res, next) {
  const permission = GUIDE_PERMISSIONS[req.params.slug];
  if (!permission) return res.status(404).type('text/plain').send('Không tìm thấy hướng dẫn');
  const { requirePermission } = require('../middleware/policy');
  return requirePermission(permission)(req, res, next);
}

const router = express.Router();
router.use(requireHelpAuthentication);
router.get('/:slug', requireGuidePermission, (req, res) => {
  const relative = GUIDE_FILES[req.params.slug];
  if (!relative) return res.status(404).type('text/plain').send('Không tìm thấy hướng dẫn');
  const markdown = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  return res.status(200).type('html').send(renderPage(req.params.slug, markdown));
});

module.exports = router;
module.exports.GUIDE_FILES = GUIDE_FILES;
module.exports.renderGuide = renderGuide;
module.exports.renderPage = renderPage;
