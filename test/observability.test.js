process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createLogger } = require('../server/logger');
const { getContext, setActor } = require('../server/observability/context');
const { sanitizeAccessDetails } = require('../server/observability/accessLog');
const { redact } = require('../server/observability/redact');
const {
  apiErrorHandler,
  requestContext,
  validClientId,
} = require('../server/middleware/requestContext');

function captureLogger() {
  const lines = [];
  return {
    lines,
    logger: createLogger({
      level: 'debug',
      clock: () => new Date('2026-07-13T00:00:00.000Z'),
      writeLine: (line) => lines.push(line),
    }),
  };
}

async function withServer(configure, callback) {
  const app = express();
  const captured = captureLogger();
  app.use(requestContext({ logger: captured.logger }));
  app.use(express.json());
  configure(app);
  app.use(apiErrorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback({ origin, lines: captured.lines });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function parsedLines(lines) {
  return lines.map((line) => JSON.parse(line));
}

test('structured logger emits parseable NDJSON with stable envelope, child context and safe Error fields', () => {
  const captured = captureLogger();
  const child = captured.logger.child({ component: 'reporting' });
  const error = new Error('synthetic failure');
  error.code = 'SYNTHETIC_FAILURE';
  child.error('report.render.failed', { report_type: 'SYNTHETIC', error });

  assert.equal(captured.lines.length, 1);
  const entry = JSON.parse(captured.lines[0]);
  assert.equal(entry.timestamp, '2026-07-13T00:00:00.000Z');
  assert.equal(entry.level, 'error');
  assert.equal(entry.event_name, 'report.render.failed');
  assert.equal(entry.service, 'qlcl');
  assert.equal(entry.version, '0.1.0');
  assert.equal(entry.component, 'reporting');
  assert.equal(entry.error.name, 'Error');
  assert.equal(entry.error.error_code, 'SYNTHETIC_FAILURE');
  assert.match(entry.error.stack, /synthetic failure/);
});

test('recursive redactor removes fixture secrets, buffers and injection while enforcing limits', () => {
  const fixtures = {
    otp: '654321',
    code: 'CODE-MUST-NOT-LEAK',
    devCode: 'DEV-MUST-NOT-LEAK',
    screenCode: 'SCREEN-MUST-NOT-LEAK',
    token: 'TOKEN-MUST-NOT-LEAK',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
    cookie: 'qlcl_token=COOKIE-MUST-NOT-LEAK',
    authorization: 'Bearer AUTH-MUST-NOT-LEAK',
    password: 'PASSWORD-MUST-NOT-LEAK',
    secret: 'SECRET-MUST-NOT-LEAK',
    smtp_pass: 'SMTP-MUST-NOT-LEAK',
    redis_url: 'redis://user:REDIS-MUST-NOT-LEAK@localhost:6379',
    db_url: 'postgres://user:DB-MUST-NOT-LEAK@localhost/db',
    file: { content: 'FILE-CONTENT-MUST-NOT-LEAK', buffer: Buffer.from('FILE-MUST-NOT-LEAK') },
    message: 'first line\r\nforged line token=INLINE-MUST-NOT-LEAK',
    long: 'x'.repeat(100),
    array: [1, 2, 3, 4],
    nested: { one: { two: { three: 'too deep' } } },
  };
  const output = redact(fixtures, { maxStringLength: 24, maxArrayLength: 2, maxDepth: 2 });
  const serialized = JSON.stringify(output);

  for (const secret of [
    '654321', 'CODE-MUST-NOT-LEAK', 'DEV-MUST-NOT-LEAK', 'SCREEN-MUST-NOT-LEAK',
    'TOKEN-MUST-NOT-LEAK', 'signature', 'COOKIE-MUST-NOT-LEAK', 'AUTH-MUST-NOT-LEAK',
    'PASSWORD-MUST-NOT-LEAK', 'SECRET-MUST-NOT-LEAK', 'SMTP-MUST-NOT-LEAK',
    'REDIS-MUST-NOT-LEAK', 'DB-MUST-NOT-LEAK', 'FILE-CONTENT-MUST-NOT-LEAK',
    'FILE-MUST-NOT-LEAK', 'INLINE-MUST-NOT-LEAK',
  ]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(serialized.includes('\r'), false);
  assert.equal(serialized.includes('\nforged line'), false);
  assert.match(serialized, /TRUNCATED/);
  assert.match(serialized, /MAX_DEPTH/);
});

test('legacy access-log adapter only retains metadata allowlisted for its action', () => {
  assert.deepEqual(sanitizeAccessDetails('SUPPLIER_UPSERT', {
    supplier_code: 'SYN-NCC-001',
    source_type: 'MANUAL',
    password: 'MUST-NOT-LEAK',
    arbitrary: { body: 'MUST-NOT-BE-STRINGIFIED' },
  }), {
    supplier_code: 'SYN-NCC-001',
    source_type: 'MANUAL',
  });
  assert.equal(sanitizeAccessDetails('UNKNOWN_ACTION', { arbitrary: 'value' }), null);
  assert.equal(sanitizeAccessDetails('LOGIN', { code: 'MUST-NOT-LEAK' }), null);
});

test('client IDs use a constrained format', () => {
  assert.equal(validClientId('uat-RUN-02:0001'), true);
  assert.equal(validClientId('short'), false);
  assert.equal(validClientId('bad\r\nforged'), false);
  assert.equal(validClientId('x'.repeat(129)), false);
});

test('request and correlation IDs propagate from response to one completion log with normalized route', async () => {
  await withServer((app) => {
    app.get('/items/:id', (req, res) => {
      setActor({
        email: 'synthetic.actor@example.invalid',
        primaryRoleCode: 'SYS_ADMIN',
        roleCodes: ['SYS_ADMIN'],
      });
      const context = getContext();
      res.json({ observed_request_id: context.request_id, observed_correlation_id: context.correlation_id });
    });
  }, async ({ origin, lines }) => {
    const response = await fetch(`${origin}/items/42`, {
      headers: {
        'X-Request-Id': 'request-alpha-0001',
        'X-Correlation-Id': 'correlation-alpha-0001',
        'X-UAT-Run-Id': 'uat-RUN-02:0001',
      },
    });
    const body = await response.json();
    assert.equal(response.headers.get('x-request-id'), 'request-alpha-0001');
    assert.equal(response.headers.get('x-correlation-id'), 'correlation-alpha-0001');
    assert.equal(response.headers.get('x-uat-run-id'), 'uat-RUN-02:0001');
    assert.deepEqual(body, {
      observed_request_id: 'request-alpha-0001',
      observed_correlation_id: 'correlation-alpha-0001',
    });

    const entries = parsedLines(lines);
    const completed = entries.filter((entry) => entry.event_name === 'http.request.completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].request_id, response.headers.get('x-request-id'));
    assert.equal(completed[0].correlation_id, response.headers.get('x-correlation-id'));
    assert.equal(completed[0].uat_run_id, 'uat-RUN-02:0001');
    assert.equal(completed[0].route, '/items/:id');
    assert.equal(completed[0].method, 'GET');
    assert.equal(completed[0].status_code, 200);
    assert.equal(completed[0].event_code, 'HTTP_SUCCESS');
    assert.equal(completed[0].actor.role, 'SYS_ADMIN');
    assert.match(completed[0].actor.id_hash, /^[a-f0-9]{16}$/);
    assert.equal(JSON.stringify(completed[0]).includes('synthetic.actor@example.invalid'), false);
  });
});

test('AsyncLocalStorage isolates concurrent requests', async () => {
  await withServer((app) => {
    app.get('/concurrent/:delay', async (req, res) => {
      const before = getContext().request_id;
      await new Promise((resolve) => setTimeout(resolve, Number(req.params.delay)));
      res.json({ before, after: getContext().request_id });
    });
  }, async ({ origin, lines }) => {
    const [slow, fast] = await Promise.all([
      fetch(`${origin}/concurrent/30`, { headers: { 'X-Request-Id': 'request-slow-0001' } }).then((res) => res.json()),
      fetch(`${origin}/concurrent/1`, { headers: { 'X-Request-Id': 'request-fast-0001' } }).then((res) => res.json()),
    ]);
    assert.deepEqual(slow, { before: 'request-slow-0001', after: 'request-slow-0001' });
    assert.deepEqual(fast, { before: 'request-fast-0001', after: 'request-fast-0001' });
    const completedIds = parsedLines(lines).map((entry) => entry.request_id).sort();
    assert.deepEqual(completedIds, ['request-fast-0001', 'request-slow-0001']);
  });
});

test('invalid client IDs are not reflected and errors include code/request ID without stack', async () => {
  await withServer((app) => {
    app.get('/explode', () => {
      const error = new Error('synthetic internal failure token=SYNTHETIC-MUST-NOT-LEAK');
      error.stack = 'SYNTHETIC-INTERNAL-STACK token=SYNTHETIC-MUST-NOT-LEAK';
      throw error;
    });
  }, async ({ origin, lines }) => {
    const response = await fetch(`${origin}/explode`, {
      headers: {
        'X-Request-Id': 'bad\trequest',
        'X-Correlation-Id': 'tiny',
        'X-UAT-Run-Id': 'bad uat id',
      },
    });
    const body = await response.json();
    const requestId = response.headers.get('x-request-id');
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-correlation-id'), requestId);
    assert.equal(response.headers.has('x-uat-run-id'), false);
    assert.deepEqual(body, { error: 'internal_error', error_code: 'internal_error', request_id: requestId });
    assert.equal(JSON.stringify(body).includes('SYNTHETIC-INTERNAL-STACK'), false);
    assert.equal(JSON.stringify(body).includes('synthetic internal failure'), false);

    const entries = parsedLines(lines);
    const completed = entries.filter((entry) => entry.event_name === 'http.request.completed');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].event_code, 'HTTP_SERVER_ERROR');
    assert.deepEqual(completed[0].rejected_client_ids, ['request_id', 'correlation_id', 'uat_run_id']);

    const operational = entries.filter((entry) => entry.event_name === 'http.request.unhandled_error');
    assert.equal(operational.length, 1);
    assert.equal(operational[0].level, 'error');
    assert.equal(operational[0].request_id, requestId);
    assert.equal(operational[0].error.name, 'Error');
    assert.match(operational[0].error.stack, /SYNTHETIC-INTERNAL-STACK/);
    assert.equal(JSON.stringify(operational[0]).includes('SYNTHETIC-MUST-NOT-LEAK'), false);
  });
});

test('401, 403 and 429 completion events have stable event codes and all lines parse', async () => {
  await withServer((app) => {
    app.get('/unauthorized', (req, res) => res.status(401).json({ error: 'unauthorized' }));
    app.get('/forbidden', (req, res) => res.status(403).json({ error: 'forbidden' }));
    app.get('/rate-limited', (req, res) => res.status(429).json({ error: 'too_many_requests' }));
  }, async ({ origin, lines }) => {
    const cases = [
      ['/unauthorized', 'AUTH_UNAUTHORIZED'],
      ['/forbidden', 'AUTH_FORBIDDEN'],
      ['/rate-limited', 'RATE_LIMITED'],
    ];
    for (const [path, eventCode] of cases) {
      const response = await fetch(`${origin}${path}`);
      const body = await response.json();
      assert.equal(body.request_id, response.headers.get('x-request-id'));
      assert.equal(body.error_code, body.error);
      assert.equal(response.status >= 400, true);
      assert.equal(eventCode.length > 0, true);
    }
    const entries = parsedLines(lines);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.event_code), cases.map((item) => item[1]));
    assert.equal(entries.every((entry) => entry.event_name === 'http.request.completed'), true);
  });
});
