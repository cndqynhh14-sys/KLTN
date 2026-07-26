require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const authRouter = require('./routes/auth');
const dashboardRouter = require('./routes/dashboard');
const adminRouter = require('./routes/admin');
const authorizationAdminRouter = require('./routes/authorizationAdmin');
const auditEventsRouter = require('./routes/auditEvents');
const evaluationsRouter = require('./routes/evaluations');
const suppliersRouter = require('./routes/suppliers');
const questionTemplatesRouter = require('./routes/questionTemplates');
const reportTemplatesRouter = require('./routes/reportTemplates');
const scoringPoliciesRouter = require('./routes/scoringPolicies');
const reportExportsRouter = require('./routes/reportExports');
const helpRouter = require('./routes/help');
const notificationsRouter = require('./routes/notifications');
const workspaceRouter = require('./routes/workspace');
const logger = require('./logger');
const { apiErrorHandler, requestContext } = require('./middleware/requestContext');
const { auditMutations } = require('./middleware/audit');
const { auditEventService, db, questionSeedReadiness } = require('./db');
const { otpReadiness } = require('./domain/otpDelivery');
const { reportArtifactRuntimeReadiness } = require('./reporting/artifacts/config');

const app = express();
const PORT = parseInt(process.env.PORT || '3005', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE = '/qlcl';

app.set('trust proxy', 1);  // nginx reverse proxy sets X-Forwarded-For

// Request/correlation context must wrap parsers, guards, routes and error handling.
app.use(requestContext());
app.use(auditMutations(auditEventService));

// Reject non-JSON POST (except multipart uploads) — cheap CSRF defense on top
// of SameSite=Strict cookie.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  const ct = req.get('content-type') || '';
  if (!ct) return next();
  if (ct.includes('application/json') || ct.includes('multipart/form-data')) return next();
  return res.status(415).json({ error: 'unsupported_media_type' });
});

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

// Health — unauthenticated for nginx/deploy smoke check.
app.get(BASE + '/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
function scoringPolicyReadiness() {
  const publishedDefault = db.prepare(`
    SELECT v.id, v.checksum, v.formula_checksum
    FROM scoring_policy_assignments a
    JOIN scoring_policy_versions v ON v.id=a.scoring_policy_version_id
    WHERE a.active=1 AND a.is_default=1 AND v.status='PUBLISHED'
      AND a.template_id IS NULL AND a.facility_type='ALL'
      AND a.supplier_scale='ALL' AND a.evaluation_type='ALL'
    LIMIT 1
  `).get();
  const unmapped = db.prepare(`
    SELECT COUNT(*) AS n FROM evaluation_questions
    WHERE category_code IS NULL OR trim(category_code)=''
  `).get().n;
  const status = publishedDefault && unmapped === 0 ? 'ready' : 'degraded';
  return {
    status,
    code: status === 'ready' ? 'scoring_policy_ready' : (publishedDefault ? 'scoring_category_unmapped' : 'published_scoring_policy_missing'),
    scoring_policy_version_id: publishedDefault?.id || null,
    scoring_policy_checksum: publishedDefault?.checksum || null,
    formula_checksum: publishedDefault?.formula_checksum || null,
    unmapped_category_count: unmapped,
    publishing: process.env.SCORING_POLICY_PUBLISH_ACK === 'SCORE-001:APPROVED' ? 'enabled' : 'disabled',
    decision: 'SCORE-001',
  };
}
const readiness = (req, res) => {
  const otp = otpReadiness(process.env);
  const reportArtifacts = reportArtifactRuntimeReadiness({ db, env: process.env });
  const scoringPolicy = scoringPolicyReadiness();
  const ready = otp.status === 'ready'
    && questionSeedReadiness.status === 'ready'
    && ['ready', 'disabled'].includes(reportArtifacts.status)
    && scoringPolicy.status === 'ready';
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    components: { otp, question_seed: questionSeedReadiness, report_artifacts: reportArtifacts, scoring_policy: scoringPolicy },
  });
};
app.get(BASE + '/api/readiness', readiness);
app.get('/readiness', readiness);
app.get('/', (req, res) => res.redirect(BASE + '/'));

// API routes — mounted under /qlcl/api để nginx path-prefix compatible.
app.use(BASE + '/api/auth', authRouter);
app.use(BASE + '/api/dashboard', dashboardRouter);
app.use(BASE + '/api/admin/audit-events', auditEventsRouter);
app.use(BASE + '/api/admin/authorization', authorizationAdminRouter);
app.use(BASE + '/api/admin', adminRouter);
app.use(BASE + '/api/evaluations', evaluationsRouter);
app.use(BASE + '/api/suppliers', suppliersRouter);
app.use(BASE + '/api/question-templates', questionTemplatesRouter);
app.use(BASE + '/api/report-templates', reportTemplatesRouter);
app.use(BASE + '/api/scoring-policies', scoringPoliciesRouter);
app.use(BASE + '/api/report-exports', reportExportsRouter);
app.use(BASE + '/api/notifications', notificationsRouter);
app.use(BASE + '/api/workspace', workspaceRouter);

// API paths must fail as JSON instead of falling through to the SPA shell.
app.use(BASE + '/api', (req, res) => res.status(404).json({ error: 'not_found' }));

// Authenticated, allowlisted operating guides. Mount before the static SPA fallback.
app.use(BASE + '/help', helpRouter);

// Static frontend — etag revalidation + maxAge=0 tránh user cache app.js cũ
// sau deploy (vấn đề đã thấy ở CHT).
app.use(BASE, express.static(path.resolve(__dirname, '..', 'public'), {
  index: 'index.html',
  extensions: ['html'],
  maxAge: 0,
  etag: true,
  lastModified: true,
}));

// SPA fallback — any unknown /qlcl/* path returns index.html cho client-side routing.
app.get(BASE + '/*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'index.html'));
});

app.use(apiErrorHandler);

app.listen(PORT, HOST, () => {
  logger.info('application.started', { host: HOST, port: PORT, base_path: BASE });
});
