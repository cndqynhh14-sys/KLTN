const packageJson = require('../package.json');
const { getContext } = require('./observability/context');
const { redact, sanitizeString } = require('./observability/redact');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const LEGACY_METADATA_FIELDS = Object.freeze({
  'evaluation-summary-export': ['report_type', 'row_count', 'filters'],
  'email:smtp': ['messageId'],
});
const STRUCTURED_METADATA_FIELDS = Object.freeze({
  'application.started': ['host', 'port', 'base_path'],
  'http.request.completed': [
    'status_code', 'duration_ms', 'event_code', 'error_code', 'content_length', 'aborted',
    'request_id_source', 'correlation_id_source', 'rejected_client_ids',
  ],
  'http.request.unhandled_error': ['status_code', 'error_code', 'error'],
  'audit.access.recorded': ['access_action', 'metadata'],
  'audit.access.write_failed': ['access_action', 'error'],
  'audit.event.write_failed': ['status_code', 'error_code', 'error'],
  'report.render.failed': ['report_type', 'error'],
  'evaluation.canonical_read_mismatch': [
    'resource_type', 'ticket_id', 'round_id', 'mismatch_count', 'fallback_count',
  ],
});

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    error_code: error.code || null,
    status_code: error.status || error.statusCode || null,
    stack: error.stack || null,
  };
}

function sanitizeEventName(value) {
  const normalized = sanitizeString(value || 'application.event', 128)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
  return normalized || 'application.event';
}

function legacyEventName(first) {
  const match = String(first || '').match(/^\[([^\]]+)\]/);
  return `legacy.${sanitizeEventName(match ? match[1].replaceAll('/', '.') : 'message')}`;
}

function pickLegacyMetadata(label, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Error) return {};
  const allowed = LEGACY_METADATA_FIELDS[label] || [];
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]));
}

function pickStructuredMetadata(eventName, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = STRUCTURED_METADATA_FIELDS[eventName] || ['error'];
  return Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]));
}

function normalizeCall(parts) {
  const first = parts[0];
  const structured = typeof first === 'string' && /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/.test(first);
  if (structured) {
    const fields = pickStructuredMetadata(first, parts[1]);
    const error = parts.find((part) => part instanceof Error) || fields.error;
    if (error instanceof Error) fields.error = serializeError(error);
    return { eventName: sanitizeEventName(first), fields };
  }

  const firstText = typeof first === 'string' ? first : '';
  const labelMatch = firstText.match(/^\[([^\]]+)\]/);
  const label = labelMatch ? labelMatch[1] : 'message';
  const fields = {};
  const messages = [];
  for (const part of parts) {
    if (part instanceof Error) {
      fields.error = serializeError(part);
    } else if (part && typeof part === 'object') {
      Object.assign(fields, pickLegacyMetadata(label, part));
    } else if (part != null) {
      messages.push(String(part));
    }
  }
  if (messages.length) fields.message = messages.join(' ');
  return { eventName: legacyEventName(firstText), fields };
}

function defaultBaseContext() {
  return {
    service: process.env.SERVICE_NAME || 'qlcl',
    version: process.env.APP_VERSION || packageJson.version,
    env: process.env.APP_ENV || process.env.NODE_ENV || 'development',
    commit: process.env.COMMIT_SHA || process.env.GIT_COMMIT || 'unknown',
  };
}

function createLogger(options = {}) {
  const childFields = options.childFields || {};
  const clock = options.clock || (() => new Date());
  const configuredLevel = String(options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = LEVELS[configuredLevel] || LEVELS.info;
  const writeLine = options.writeLine || ((line, level) => {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  });

  function write(level, parts) {
    if (LEVELS[level] < threshold) return;
    const { eventName, fields } = normalizeCall(parts);
    const context = getContext();
    const envelope = redact({
      ...childFields,
      ...fields,
      ...defaultBaseContext(),
      ...context,
      timestamp: clock().toISOString(),
      level,
      event_name: eventName,
    });
    writeLine(JSON.stringify(envelope), level);
  }

  const logger = {
    debug: (...parts) => write('debug', parts),
    info: (...parts) => write('info', parts),
    warn: (...parts) => write('warn', parts),
    error: (...parts) => write('error', parts),
    child(fields) {
      return createLogger({
        ...options,
        childFields: { ...childFields, ...redact(fields || {}) },
        clock,
        writeLine,
      });
    },
  };
  return logger;
}

const logger = createLogger();

module.exports = Object.assign(logger, {
  createLogger,
  legacyEventName,
  normalizeCall,
  pickStructuredMetadata,
  sanitizeEventName,
  serializeError,
});
