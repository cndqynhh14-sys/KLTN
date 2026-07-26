const fs = require('node:fs');
const path = require('node:path');

const MODES = new Set(['local', 'staging', 'production-readonly']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_MUTATION_PATHS = new Set([
  '/qlcl/api/auth/request-otp',
  '/qlcl/api/auth/verify-otp',
  '/qlcl/api/auth/logout',
  '/qlcl/api/auth/acknowledge',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseHosts(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
}

function parseBaseUrl(value) {
  if (!value) throw new Error('UAT_BASE_URL is required; refusing an ambiguous target.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('UAT_BASE_URL is not a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('UAT_BASE_URL must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Credentials are forbidden in UAT_BASE_URL.');
  if (url.search || url.hash) throw new Error('Query strings and fragments are forbidden in UAT_BASE_URL.');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/qlcl') throw new Error('UAT_BASE_URL must end at the exact /qlcl base path.');
  url.pathname = '/qlcl/';
  return url;
}

function isProductionHost(hostname, productionHosts) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return productionHosts.includes(normalized);
}

function assertCleanupModule(root, modulePath) {
  if (!modulePath) throw new Error('Staging mutation requires UAT_CLEANUP_MODULE.');
  const resolved = path.resolve(root, modulePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UAT_CLEANUP_MODULE must stay inside the repository.');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('UAT_CLEANUP_MODULE does not exist.');
  if (typeof require(resolved) !== 'function') throw new Error('UAT_CLEANUP_MODULE must export a cleanup function.');
  return resolved;
}

function payloadOwnsPrefix(postData, prefix) {
  let parsed;
  try {
    parsed = JSON.parse(String(postData || ''));
  } catch {
    return false;
  }
  const pending = [parsed];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && value.startsWith(prefix)) return true;
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  return false;
}

function loadUatConfig(env = process.env, root = path.resolve(__dirname, '..', '..')) {
  const mode = String(env.UAT_MODE || 'local');
  if (!MODES.has(mode)) throw new Error(`Unsupported UAT_MODE: ${mode || '(empty)'}.`);
  const baseUrl = parseBaseUrl(env.UAT_BASE_URL);
  const productionHosts = parseHosts(env.UAT_PRODUCTION_HOSTS);
  const hostname = baseUrl.hostname.toLowerCase();
  const production = isProductionHost(hostname, productionHosts);
  const runId = String(env.UAT_RUN_ID || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(runId)) throw new Error('UAT_RUN_ID is missing or invalid.');

  if (mode === 'local') {
    if (!LOOPBACK_HOSTS.has(hostname) || baseUrl.protocol !== 'http:') {
      throw new Error('Local mode requires an exact loopback HTTP URL.');
    }
  }
  if (mode === 'staging') {
    if (!productionHosts.length || LOOPBACK_HOSTS.has(hostname) || production || baseUrl.protocol !== 'https:') {
      throw new Error('Staging mode requires UAT_PRODUCTION_HOSTS and a non-production HTTPS host.');
    }
  }
  if (mode === 'production-readonly') {
    if (!productionHosts.length || !production || baseUrl.protocol !== 'https:' || (baseUrl.port && baseUrl.port !== '443')) {
      throw new Error('Production-readonly requires HTTPS and an exact UAT_PRODUCTION_HOSTS match.');
    }
  }

  const allowMutation = env.ALLOW_MUTATION === 'true';
  const dataPrefix = `UAT_${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 20)}_`;
  let cleanupModule = null;
  if (mode === 'staging' && allowMutation) cleanupModule = assertCleanupModule(root, env.UAT_CLEANUP_MODULE);

  return {
    mode,
    runId,
    baseUrl: baseUrl.toString(),
    origin: baseUrl.origin,
    basePath: '/qlcl',
    productionHosts,
    allowMutation,
    dataPrefix,
    cleanupModule,
    outputDir: path.resolve(env.UAT_OUTPUT_DIR || path.join(root, 'artifacts', 'uat-runs', runId)),
    adminEmail: String(env.UAT_ADMIN_EMAIL || ''),
    managerEmail: String(env.UAT_MANAGER_EMAIL || ''),
  };
}

function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function assertTargetBoundary(config, target) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) return;
  if (url.origin !== config.origin) throw new Error(`UAT request escaped configured origin: ${url.origin}`);
  if (!(url.pathname === config.basePath || url.pathname.startsWith(`${config.basePath}/`))) {
    throw new Error(`UAT request escaped configured base path: ${url.pathname}`);
  }
  if (config.mode === 'production-readonly' && !isProductionHost(url.hostname, config.productionHosts)) {
    throw new Error(`Production hostname mismatch: ${url.hostname}`);
  }
}

function assertRequestAllowed(config, request, stagingState = {}) {
  const method = String(request.method || 'GET').toUpperCase();
  const target = new URL(request.url);
  assertTargetBoundary(config, target);
  if (SAFE_METHODS.has(method)) return { allowed: true, reason: 'read_only' };

  if (method === 'POST' && !target.search && AUTH_MUTATION_PATHS.has(target.pathname)) {
    return { allowed: true, reason: 'auth_allowlist' };
  }
  if (config.mode === 'production-readonly') throw new Error(`Production mutation blocked: ${method} ${target.pathname}`);
  if (config.mode === 'local') return { allowed: true, reason: 'local_temp_data' };

  if (!config.allowMutation) throw new Error('Staging mutation blocked: ALLOW_MUTATION is not true.');
  if (!config.cleanupModule || !stagingState.cleanupRegistered) {
    throw new Error('Staging mutation blocked: cleanup is not registered.');
  }
  const ownedPathSegment = target.pathname.split('/').some((segment) => decodeURIComponent(segment).startsWith(config.dataPrefix));
  if (!payloadOwnsPrefix(request.postData, config.dataPrefix) && !ownedPathSegment) {
    throw new Error(`Staging mutation blocked: payload is missing run prefix ${config.dataPrefix}.`);
  }
  return { allowed: true, reason: 'staging_guarded_mutation' };
}

module.exports = {
  AUTH_MUTATION_PATHS,
  MODES,
  assertRequestAllowed,
  assertTargetBoundary,
  isProductionHost,
  loadUatConfig,
  parseBaseUrl,
  parseHosts,
  payloadOwnsPrefix,
  safeUrl,
};
