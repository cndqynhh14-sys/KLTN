const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 6,
  maxArrayLength: 50,
  maxStringLength: 2048,
});

const SAFE_CODE_KEYS = new Set(['errorcode', 'eventcode', 'statuscode', 'httpstatuscode']);
const SENSITIVE_KEYS = new Set([
  'otp',
  'otpverifier',
  'codeverifier',
  'code',
  'devcode',
  'screencode',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'jwt',
  'cookie',
  'setcookie',
  'authorization',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'maintenancerestoretoken',
  'buffer',
  'body',
  'rawbody',
  'requestbody',
  'responsebody',
  'content',
  'file',
  'files',
  'attachment',
  'attachments',
  'filebuffer',
  'filecontent',
  'attachmentcontent',
  'smtp',
  'smtppass',
  'smtpuser',
  'redis',
  'redisurl',
  'databaseurl',
  'dburl',
  'connectionstring',
]);

function normalizedKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (SAFE_CODE_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token') ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('cookie') ||
    normalized.endsWith('otpcode') ||
    normalized.endsWith('devcode') ||
    normalized.endsWith('screencode') ||
    normalized.endsWith('filecontent') ||
    normalized.endsWith('filebuffer') ||
    (/^(smtp|redis)/.test(normalized) && normalized !== 'redisconnected');
}

function sanitizeString(input, maxLength = DEFAULT_LIMITS.maxStringLength) {
  let value = String(input)
    .replace(/[\r\n\u2028\u2029]+/g, '\\n')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:redis|rediss|postgres|postgresql|mysql|mongodb|sqlite|smtp|smtps):\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/\b(otp|code|devcode|screencode|token|jwt|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');

  if (value.length > maxLength) {
    value = `${value.slice(0, maxLength)}...[TRUNCATED ${value.length - maxLength} chars]`;
  }
  return value;
}

function redact(value, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const seen = new WeakSet();

  function visit(current, depth, key) {
    if (isSensitiveKey(key)) return '[REDACTED]';
    if (current == null || typeof current === 'boolean' || typeof current === 'number') return current;
    if (typeof current === 'bigint') return current.toString();
    if (typeof current === 'string') return sanitizeString(current, limits.maxStringLength);
    if (typeof current === 'function' || typeof current === 'symbol') return `[${typeof current}]`;
    if (Buffer.isBuffer(current) || ArrayBuffer.isView(current)) {
      return `[REDACTED_BUFFER size=${current.byteLength}]`;
    }
    if (current instanceof Date) return current.toISOString();
    if (depth >= limits.maxDepth) return '[MAX_DEPTH]';
    if (seen.has(current)) return '[CIRCULAR]';
    seen.add(current);

    if (Array.isArray(current)) {
      const output = current.slice(0, limits.maxArrayLength).map((item) => visit(item, depth + 1, ''));
      if (current.length > limits.maxArrayLength) {
        output.push(`[TRUNCATED ${current.length - limits.maxArrayLength} items]`);
      }
      return output;
    }

    const output = {};
    for (const [childKey, childValue] of Object.entries(current)) {
      output[sanitizeString(childKey, 128)] = visit(childValue, depth + 1, childKey);
    }
    return output;
  }

  return visit(value, 0, '');
}

module.exports = {
  DEFAULT_LIMITS,
  isSensitiveKey,
  redact,
  sanitizeString,
};
