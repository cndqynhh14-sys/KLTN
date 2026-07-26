'use strict';

const crypto = require('node:crypto');
const { createClient } = require('redis');
const logger = require('../logger');
const { normalizeEmail } = require('../domain/otpDelivery');

const KEY_PREFIX = 'qlcl:otp:';
const EMAIL_KEY_PREFIX = 'qlcl:otp-email:';

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

class MemoryOtpStore {
  constructor() {
    this.sessions = new Map();
    this.emailSessions = new Map();
  }

  async replaceForEmail(emailKey, sessionId, payload) {
    const previous = this.emailSessions.get(emailKey);
    if (previous) this.sessions.delete(previous);
    this.sessions.set(sessionId, { ...payload });
    this.emailSessions.set(emailKey, sessionId);
  }

  async get(sessionId) {
    const value = this.sessions.get(sessionId);
    return value ? { ...value } : null;
  }

  async set(sessionId, payload) {
    this.sessions.set(sessionId, { ...payload });
  }

  async claim(sessionId, expectedAttempts, payload) {
    const current = this.sessions.get(sessionId);
    if (!current || Number(current.attempts || 0) !== Number(expectedAttempts)) return false;
    if (payload == null) this.sessions.delete(sessionId);
    else this.sessions.set(sessionId, { ...payload });
    return true;
  }

  async delete(sessionId) {
    return this.sessions.delete(sessionId);
  }
}

class RedisOtpStore {
  constructor(options = {}) {
    this.url = options.url || process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.logger = options.logger || logger;
    this.client = options.client || null;
    this.ready = null;
  }

  async _client() {
    if (this.client?.isReady) return this.client;
    if (this.ready) return this.ready;
    this.client = this.client || createClient({ url: this.url });
    this.client.on('error', (error) => this.logger.error('otp.store.error', { error }));
    this.ready = this.client.connect().then(() => this.client);
    return this.ready;
  }

  async replaceForEmail(emailKey, sessionId, payload, ttlSeconds) {
    const client = await this._client();
    const emailIndex = EMAIL_KEY_PREFIX + emailKey;
    const script = `
      local previous = redis.call('GET', KEYS[2])
      if previous then redis.call('DEL', ARGV[1] .. previous) end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[3])
      return 1
    `;
    await client.eval(script, {
      keys: [KEY_PREFIX + sessionId, emailIndex],
      arguments: [KEY_PREFIX, JSON.stringify(payload), String(ttlSeconds), sessionId],
    });
  }

  async get(sessionId) {
    const client = await this._client();
    const raw = await client.get(KEY_PREFIX + sessionId);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      await client.del(KEY_PREFIX + sessionId);
      return null;
    }
  }

  async set(sessionId, payload, ttlSeconds) {
    const client = await this._client();
    await client.set(KEY_PREFIX + sessionId, JSON.stringify(payload), { EX: ttlSeconds });
  }

  async claim(sessionId, expectedAttempts, payload, ttlSeconds) {
    const client = await this._client();
    const script = `
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local current = cjson.decode(raw)
      if tonumber(current.attempts or 0) ~= tonumber(ARGV[1]) then return 0 end
      if ARGV[2] == 'DELETE' then
        redis.call('DEL', KEYS[1])
      else
        redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
      end
      return 1
    `;
    const result = await client.eval(script, {
      keys: [KEY_PREFIX + sessionId],
      arguments: [
        String(expectedAttempts),
        payload == null ? 'DELETE' : 'SET',
        payload == null ? '{}' : JSON.stringify(payload),
        String(Math.max(1, ttlSeconds || 1)),
      ],
    });
    return Number(result) === 1;
  }

  async delete(sessionId) {
    const client = await this._client();
    return client.del(KEY_PREFIX + sessionId);
  }
}

class OtpSessionService {
  constructor(options = {}) {
    const secret = String(options.secret || '');
    if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('otp_hmac_secret_invalid');
    const jwtSecret = String(options.jwtSecret || process.env.JWT_SECRET || '');
    if (jwtSecret && secret === jwtSecret) throw new Error('otp_hmac_secret_reused');
    this.secret = Buffer.from(secret, 'utf8');
    this.store = options.store;
    if (!this.store) throw new TypeError('otp_store_required');
    this.ttlSeconds = boundedInteger(options.ttlSeconds, 300, 30, 900);
    this.maxAttempts = boundedInteger(options.maxAttempts, 5, 1, 10);
    this.clock = options.clock || (() => new Date());
    this.codeFactory = options.codeFactory || (() => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'));
    this.sessionIdFactory = options.sessionIdFactory || (() => crypto.randomBytes(24).toString('base64url'));
    this.fakeVerifier = this._verifier('missing-session', '000000');
  }

  _verifier(sessionId, code) {
    return crypto.createHmac('sha256', this.secret)
      .update(String(sessionId))
      .update('\0')
      .update(String(code))
      .digest('hex');
  }

  _emailKey(email) {
    return crypto.createHmac('sha256', this.secret).update(normalizeEmail(email)).digest('hex');
  }

  _constantTimeMatches(storedHex, expectedHex) {
    const expected = Buffer.from(expectedHex, 'hex');
    let stored;
    try {
      stored = Buffer.from(String(storedHex || ''), 'hex');
    } catch {
      stored = Buffer.alloc(expected.length);
    }
    if (stored.length !== expected.length) stored = Buffer.alloc(expected.length);
    return crypto.timingSafeEqual(stored, expected);
  }

  async createOtpSession(email, options = {}) {
    const normalized = normalizeEmail(email);
    const now = this.clock();
    const defaultExpiry = new Date(now.getTime() + this.ttlSeconds * 1000);
    const configuredExpiry = options.expiresAt ? new Date(options.expiresAt) : null;
    const expires = configuredExpiry && configuredExpiry < defaultExpiry ? configuredExpiry : defaultExpiry;
    const ttlSeconds = Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000));
    const sessionId = this.sessionIdFactory();
    const code = this.codeFactory();
    if (!/^\d{6}$/.test(code)) throw new Error('otp_code_factory_invalid');
    const payload = {
      email: normalized,
      eligible: options.eligible === true,
      otpVerifier: this._verifier(sessionId, code),
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      deliveryMode: String(options.deliveryMode || 'email'),
      securityProfile: options.securityProfile === 'development_relaxed' ? 'development_relaxed' : 'guarded',
    };
    await this.store.replaceForEmail(this._emailKey(normalized), sessionId, payload, ttlSeconds);
    return { sessionId, code, expiresAt: payload.expiresAt };
  }

  async invalidate(sessionId) {
    await this.store.delete(String(sessionId || ''));
  }

  async verifyOtp(sessionId, submittedCode) {
    const id = String(sessionId || '');
    const code = String(submittedCode || '');
    const expectedVerifier = this._verifier(id, code);
    for (let retry = 0; retry < 3; retry += 1) {
      const data = await this.store.get(id);
      if (!data) {
        this._constantTimeMatches(this.fakeVerifier, expectedVerifier);
        return { ok: false, reason: 'expired' };
      }

      const now = this.clock();
      const expiresAt = new Date(data.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
        this._constantTimeMatches(data.otpVerifier, expectedVerifier);
        await this.store.delete(id);
        return { ok: false, reason: 'expired' };
      }

      const matches = this._constantTimeMatches(data.otpVerifier, expectedVerifier);
      const previousAttempts = Number(data.attempts || 0);
      data.attempts = previousAttempts + 1;
      const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
      if (matches && data.eligible === true) {
        const claimed = await this.store.claim(id, previousAttempts, null, ttlSeconds);
        if (claimed) return {
          ok: true,
          email: data.email,
          deliveryMode: data.deliveryMode,
          securityProfile: data.securityProfile === 'development_relaxed' ? 'development_relaxed' : 'guarded',
        };
        continue;
      }
      if (data.attempts >= this.maxAttempts) {
        const claimed = await this.store.claim(id, previousAttempts, null, ttlSeconds);
        if (claimed) return { ok: false, reason: 'too_many_attempts', attemptsLeft: 0 };
        continue;
      }

      const claimed = await this.store.claim(id, previousAttempts, data, ttlSeconds);
      if (claimed) return { ok: false, reason: 'invalid', attemptsLeft: this.maxAttempts - data.attempts };
    }
    return { ok: false, reason: 'invalid' };
  }
}

let defaultService = null;

function defaultOtpService() {
  if (defaultService) return defaultService;
  const useMemory = process.env.USE_IN_MEMORY_OTP === 'true' && process.env.NODE_ENV !== 'production';
  defaultService = new OtpSessionService({
    store: useMemory ? new MemoryOtpStore() : new RedisOtpStore(),
    secret: process.env.OTP_HMAC_SECRET,
    ttlSeconds: boundedInteger(process.env.OTP_TTL_SECONDS, 300, 30, 900),
    maxAttempts: boundedInteger(process.env.OTP_MAX_ATTEMPTS, 5, 1, 10),
  });
  return defaultService;
}

async function createOtpSession(email, options) {
  return defaultOtpService().createOtpSession(email, options);
}

async function verifyOtp(sessionId, code) {
  return defaultOtpService().verifyOtp(sessionId, code);
}

async function invalidateOtpSession(sessionId) {
  return defaultOtpService().invalidate(sessionId);
}

function resetOtpServiceForTests() {
  defaultService = null;
}

module.exports = {
  MemoryOtpStore,
  OtpSessionService,
  RedisOtpStore,
  createOtpSession,
  invalidateOtpSession,
  resetOtpServiceForTests,
  verifyOtp,
};
