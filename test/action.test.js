'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, retryDelay } = require('../src/action');
const { escapeCommand } = require('../src/runtime');

const environment = {
  INPUT_USER: 'policy-creator',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/oidc?existing=yes',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret'
};
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function harness(responses) {
  const calls = [], events = [], waits = [], logs = [];
  return {
    calls, events, waits, logs,
    now: () => 0,
    random: () => 0,
    info: message => logs.push(message),
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected request');
      return response;
    },
    mask: value => events.push(['mask', value]),
    output: (name, value) => events.push(['output', name, value]),
    sleep: async delay => waits.push(delay)
  };
}

test('exchanges OIDC with the required audience and masks all credentials before output', async () => {
  const context = harness([json({ value: 'identity-secret' }), json({ apiKey: 'api-secret' })]);
  await run(environment, context);
  const url = new URL(context.calls[0].url);
  assert.equal(url.searchParams.get('existing'), 'yes');
  assert.equal(url.searchParams.get('audience'), 'https://www.nuget.org');
  assert.equal(context.calls[1].url, 'https://www.nuget.org/api/v2/token');
  assert.deepEqual(JSON.parse(context.calls[1].options.body), { username: 'policy-creator', tokenType: 'ApiKey' });
  assert.equal(context.calls[1].options.headers.Authorization, 'Bearer identity-secret');
  assert.ok(context.calls.every(call => call.options.redirect === 'manual' && call.options.signal instanceof AbortSignal));
  assert.deepEqual(context.events, [
    ['mask', 'request-secret'], ['mask', 'identity-secret'], ['mask', 'api-secret'], ['output', 'NUGET_API_KEY', 'api-secret']
  ]);
});

test('retries throttling and network failures with bounded delays', async () => {
  const context = harness([json({}, 429, { 'retry-after': '120' }), new Error('private network details'), json({ value: 'oidc' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.deepEqual(context.waits, [120000, 30000]);
  assert.equal(context.logs.filter(message => message.includes(': retry')).length, 2);
  assert.ok(context.logs.every(message => !message.includes('secret') && !message.includes('private network details')));
  assert.equal(retryDelay('0', 0), 0);
});

test('obtains a fresh OIDC token for each token-exchange retry', async () => {
  const context = harness([json({ value: 'oidc' }), json({}, 503), json({ value: 'fresh-oidc' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.equal(context.calls.length, 4);
  assert.equal(context.calls[3].options.headers.Authorization, 'Bearer fresh-oidc');
  assert.deepEqual(context.waits, [10000]);
});

test('fails without retrying or exposing the response on a rejected policy', async () => {
  const context = harness([json({ value: 'oidc' }), json({ error: 'sensitive-response' }, 403)]);
  await assert.rejects(run(environment, context), error => error.message.includes('HTTP 403') && !error.message.includes('sensitive-response'));
  assert.equal(context.calls.length, 2);
  assert.deepEqual(context.waits, []);
  assert.ok(context.events.every(event => event[0] !== 'output'));
});

test('honors a zero retry budget and hides network errors', async () => {
  const context = harness([new Error('request-secret')]);
  await assert.rejects(run({ ...environment, 'INPUT_MAX-RETRIES': '0' }, context), /network error or timeout/);
  assert.equal(context.calls.length, 1);
});

test('validates permissions, numeric settings, and HTTPS before making requests', async () => {
  for (const invalid of [
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }, { INPUT_USER: '' },
    { 'INPUT_MAX-RETRIES': '6' }, { 'INPUT_TIMEOUT-SECONDS': '0' },
    { 'INPUT_TIMEOUT-SECONDS': '601' }, { 'INPUT_TOKEN-SERVICE-URL': 'http://example.com/token' },
    { 'INPUT_TIMEOUT-SECONDS': '1.5' }, { ACTIONS_ID_TOKEN_REQUEST_URL: 'http://example.com' }
  ]) {
    const context = harness([]);
    await assert.rejects(run({ ...environment, ...invalid }, context));
    assert.equal(context.calls.length, 0);
  }
});

test('defaults to 60 seconds with only user supplied and allows timeout overrides', async t => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    durations.push(milliseconds);
    return new AbortController().signal;
  });
  await run(environment, harness([json({ value: 'oidc' }), json({ apiKey: 'key' })]));
  assert.deepEqual(durations, [15000, 60000]);
  durations.length = 0;
  await run({ ...environment, 'INPUT_TIMEOUT-SECONDS': '300' }, harness([json({ value: 'oidc' }), json({ apiKey: 'key' })]));
  assert.deepEqual(durations, [15000, 300000]);
});

test('supports the upstream audience and token-service-url inputs', async () => {
  const context = harness([json({ value: 'oidc' }), json({ apiKey: 'key' })]);
  await run({ ...environment, INPUT_AUDIENCE: 'https://packages.example.com', 'INPUT_TOKEN-SERVICE-URL': 'https://packages.example.com/token' }, context);
  assert.equal(new URL(context.calls[0].url).searchParams.get('audience'), 'https://packages.example.com');
  assert.equal(context.calls[1].url, 'https://packages.example.com/token');
});

test('rejects malformed JSON and missing tokens without emitting outputs', async () => {
  for (const responses of [[new Response('secret-body')], [json({})], [json({ value: 'oidc' }), json({ apiKey: '' })]]) {
    const context = harness(responses);
    await assert.rejects(run(environment, context));
    assert.ok(context.events.every(event => event[0] !== 'output'));
    assert.deepEqual(context.waits, []);
  }
});

test('escapes workflow command control characters', () => {
  assert.equal(escapeCommand('a%\r\n::error::b'), 'a%25%0D%0A::error::b');
});

test('honors Retry-After dates, rejects excessive delays, and adds bounded jitter', () => {
  const now = Date.parse('Mon, 12 Oct 2026 12:00:00 GMT');
  assert.equal(retryDelay('Mon, 12 Oct 2026 12:02:00 GMT', 0, () => 0, now), 120000);
  assert.equal(retryDelay('Mon, 12 Oct 2026 11:59:00 GMT', 0, () => 0, now), 0);
  assert.equal(retryDelay('invalid', 0, () => 0.5), 12500);
  assert.equal(retryDelay('-1', 0, () => 0), 10000);
  assert.equal(retryDelay(' ', 0, () => 0), 10000);
  assert.equal(retryDelay(null, 5, () => 0.99), 179400);
  assert.throws(() => retryDelay('301', 0), /longer than 300/);
  assert.throws(() => retryDelay('9'.repeat(400), 0), /longer than 300/);
});

test('does not retry before an excessive Retry-After period', async () => {
  const context = harness([json({}, 429, { 'retry-after': '301' })]);
  await assert.rejects(run(environment, context), /Retry the workflow later/);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(context.waits, []);
});

test('does not retry authentication failures when response cleanup fails', async () => {
  const context = harness([{
    ok: false, status: 403, headers: new Headers(),
    body: { cancel: async () => { throw new Error('sensitive cleanup failure'); } }
  }]);
  await assert.rejects(run(environment, context), /HTTP 403/);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(context.waits, []);
});

test('refuses redirects without forwarding credentials or retrying', async () => {
  const context = harness([json({}, 302, { location: 'https://untrusted.example/token' })]);
  await assert.rejects(run(environment, context), /HTTP 302/);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(context.waits, []);
});

test('refreshes identity after an interrupted successful exchange response', async () => {
  const interrupted = { ok: true, status: 200, headers: new Headers(), text: async () => { throw new Error('secret-body'); } };
  const context = harness([json({ value: 'old-identity' }), interrupted, json({ value: 'new-identity' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.equal(context.calls[3].options.headers.Authorization, 'Bearer new-identity');
  assert.ok(context.logs.some(message => message.includes('network error or timeout')));
  assert.ok(!context.logs[0].includes('secret-body'));
});

test('reports interrupted response bodies as transport failures instead of HTTP 200', async () => {
  const context = harness([{ ok: true, status: 200, text: async () => { throw new Error('secret-body'); } }]);
  await assert.rejects(run({ ...environment, 'INPUT_MAX-RETRIES': '0' }, context), error =>
    error.message.includes('network error or timeout') && !error.message.includes('HTTP 200') && !error.message.includes('secret-body'));
});

test('fails before requesting credentials when GitHub output is unavailable', async () => {
  const context = harness([]);
  delete context.output;
  await assert.rejects(run(environment, context), /GITHUB_OUTPUT/);
  assert.equal(context.calls.length, 0);
});

test('the request deadline covers a stalled response body', async t => {
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    if (milliseconds === 240000) return new AbortController().signal;
    const controller = new AbortController();
    timers.push(setTimeout(() => controller.abort(), 10));
    return controller.signal;
  });
  const context = harness([]);
  context.fetch = async (_url, options) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true });
    })
  });
  await assert.rejects(run({ ...environment, 'INPUT_MAX-RETRIES': '0' }, context), /network error or timeout/);
  assert.ok(context.events.every(event => event[0] !== 'output'));
});


test('defaults to two retries with ten and thirty second pauses', async () => {
  const context = harness(Array.from({ length: 4 }, () => json({}, 500)));
  await assert.rejects(run(environment, context), /GitHub OIDC request failed \(HTTP 500\)/);
  assert.deepEqual(context.waits, [10000, 30000]);
  assert.equal(context.calls.length, 3);
  assert.ok(context.events.every(event => event[0] !== 'output'));
});

test('recovers from an exchange HTTP 500 with a fresh identity after the retry delay', async () => {
  const context = harness([json({ value: 'old' }), json({}, 500), json({ value: 'fresh' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.deepEqual(context.waits, [10000]);
  assert.equal(context.calls[3].options.headers.Authorization, 'Bearer fresh');
});

test('honors Retry-After on HTTP 500 and uses the same backoff for transient failures', async () => {
  for (const status of [408, 429, 502, 503, 504, 500]) {
    const context = harness([json({}, status, status === 500 ? { 'retry-after': '15' } : {}), json({ value: 'oidc' }), json({ apiKey: 'key' })]);
    await run(environment, context);
    assert.deepEqual(context.waits, [status === 500 ? 15000 : 10000]);
  }
  assert.equal(retryDelay(null, 0, () => 0.5, 0, 500), 12500);
  assert.equal(retryDelay(null, 5, () => 0.5, 0, 500), 150000);
});


test('exchange timeouts double on retries and recovery can exceed four minutes', async t => {
  const durations = [];
  const controllers = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    durations.push(milliseconds);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  const context = harness([
    json({ value: 'first' }), json({}),
    json({ value: 'second' }), json({}),
    json({ value: 'third' }), json({ apiKey: 'key' })
  ]);
  let elapsed = 0;
  context.now = () => elapsed;
  const fetch = context.fetch;
  context.fetch = async (...args) => {
    const response = await fetch(...args);
    if (context.calls.length === 2 || context.calls.length === 4) {
      elapsed += durations.at(-1);
      controllers.at(-1).abort();
      return new Promise(() => {});
    }
    if (context.calls.length === 6) elapsed += 100000;
    return response;
  };
  context.sleep = async delay => {
    assert.ok(context.logs.at(-1).includes('waiting ' + delay + 'ms...'));
    context.waits.push(delay);
    elapsed += delay;
  };
  await run(environment, context);
  assert.deepEqual(durations, [15000, 60000, 15000, 120000, 15000, 240000]);
  assert.ok(elapsed > 240000);
  assert.deepEqual(context.waits, [10000, 30000]);
  assert.equal(context.calls[5].options.headers.Authorization, 'Bearer third');
  assert.ok(context.logs.some(log => log.includes('starting (timeout 240000ms)')));
  assert.deepEqual(context.events.at(-1), ['output', 'NUGET_API_KEY', 'key']);
});

test('OIDC retry timeouts stay at fifteen seconds regardless of exchange configuration', async t => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    durations.push(milliseconds);
    return new AbortController().signal;
  });
  const context = harness(Array.from({ length: 6 }, () => json({}, 503)));
  await assert.rejects(run({ ...environment, 'INPUT_TIMEOUT-SECONDS': '200', 'INPUT_MAX-RETRIES': '5' }, context), /HTTP 503/);
  assert.deepEqual(durations, [15000, 2000, 15000, 2000, 15000, 2000]);
});

test('honors Retry-After even when the wait exceeds four minutes', async () => {
  const context = harness([json({}, 429, { 'retry-after': '300' }), json({ value: 'oidc' }), json({ apiKey: 'key' })]);
  let elapsed = 0;
  context.now = () => elapsed;
  context.sleep = async delay => { context.waits.push(delay); elapsed += delay; };
  await run(environment, context);
  assert.deepEqual(context.waits, [300000]);
  assert.equal(context.calls.length, 3);
  assert.deepEqual(context.events.at(-1), ['output', 'NUGET_API_KEY', 'key']);
});

test('logs selected failure diagnostics and sanitizes reflected credentials', async () => {
  const context = harness([json({ value: 'identity-secret' }), json({
    error: 'Failure request-secret identity-secret unknown-key token=hidden-value\n::error:: injected',
    apiKey: 'unknown-key'
  }, 500, {
    'content-type': 'application/json', 'retry-after': '10', 'x-request-id': 'request-123',
    authorization: 'Bearer header-secret', 'set-cookie': 'cookie-secret'
  })]);
  await assert.rejects(run({ ...environment, 'INPUT_MAX-RETRIES': '0', 'INPUT_LOG-RESPONSES': 'true' }, context), /HTTP 500/);
  const logs = context.logs.join('\n');
  assert.match(logs, /request-123/);
  assert.match(logs, /retry-after/);
  assert.match(logs, /Failure/);
  for (const secret of ['request-secret', 'identity-secret', 'unknown-key', 'hidden-value', 'header-secret', 'cookie-secret', '::error::'])
    assert.ok(!logs.includes(secret), secret);
});

test('does not log successful response bodies, HTML, malformed JSON, or oversized JSON', async () => {
  const success = harness([json({ value: 'identity-secret' }), json({ apiKey: 'api-secret', message: 'success-private' })]);
  await run({ ...environment, 'INPUT_LOG-RESPONSES': 'true' }, success);
  assert.ok(!success.logs.join(' ').includes('success-private'));
  for (const [body, type] of [
    ['<html>private-body</html>', 'text/html'],
    ['private-body', 'application/json'],
    [JSON.stringify({ error: 'private-body' + 'x'.repeat(8192) }), 'application/json']
  ]) {
    const context = harness([new Response(body, { status: 403, headers: { 'content-type': type } })]);
    await assert.rejects(run({ ...environment, 'INPUT_LOG-RESPONSES': 'true' }, context), /HTTP 403/);
    assert.ok(!context.logs.join(' ').includes('private-body'));
    assert.match(context.logs.join(' '), /content-type/);
    assert.equal(context.calls.length, 1);
  }
});

test('stalled diagnostic bodies preserve nonretryable HTTP status', async t => {
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController();
    timers.push(setTimeout(() => controller.abort(), 10));
    return controller.signal;
  });
  const context = harness([new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
    status: 403, headers: { 'content-type': 'application/json' }
  })]);
  await assert.rejects(run({ ...environment, 'INPUT_LOG-RESPONSES': 'true' }, context), /HTTP 403/);
  assert.equal(context.calls.length, 1);
  assert.deepEqual(context.waits, []);
});


test('response diagnostics default on, can be disabled, and reject invalid options', async () => {
  const enabled = harness([Response.json({ error: 'Diagnostic message' }, { status: 403 })]);
  await assert.rejects(run(environment, enabled), /HTTP 403/);
  assert.ok(enabled.logs.some(log => log.includes('Diagnostic message')));
  for (const value of ['false']) {
    const context = harness([{ ok: false, status: 403, headers: new Headers({ 'x-request-id': 'private-id' }),
      body: { cancel: async () => {}, getReader: () => { assert.fail('Disabled diagnostics read the body'); } } }]);
    await assert.rejects(run({ ...environment, 'INPUT_LOG-RESPONSES': value }, context), /HTTP 403/);
    assert.ok(context.logs.every(log => !log.includes('response diagnostics') && !log.includes('private-id')));
  }
  const context = harness([]);
  await assert.rejects(run({ ...environment, 'INPUT_LOG-RESPONSES': 'yes' }, context), /log-responses/);
  assert.equal(context.calls.length, 0);
});


test('permanent nested transport errors fail immediately without leaking arbitrary details', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_CHAR']) {
    const error = new TypeError('request-secret', { cause: Object.assign(new Error('identity-secret'), { code }) });
    const context = harness([error]);
    await assert.rejects(run(environment, context), new RegExp(code));
    assert.deepEqual(context.waits, []);
    assert.equal(context.calls.length, 1);
    assert.ok(!context.logs.join(' ').includes('request-secret'));
    assert.match(context.logs.join(' '), /response headers not received/);
  }
});

test('temporary nested transport errors retry and identify the code', async () => {
  const error = new TypeError('private', { cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) });
  const context = harness([error, json({ value: 'oidc' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.deepEqual(context.waits, [10000]);
  assert.match(context.logs.join(' '), /ECONNRESET/);
});

test('stalled diagnostic reading stops at two seconds even with a long attempt', async t => {
  const durations = [];
  const timers = [];
  t.after(() => timers.forEach(clearTimeout));
  t.mock.method(AbortSignal, 'timeout', ms => {
    durations.push(ms);
    const controller = new AbortController();
    if (ms === 2000) timers.push(setTimeout(() => controller.abort(), 5));
    return controller.signal;
  });
  const context = harness([json({ value: 'oidc' }), new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
    status: 403, headers: { 'content-type': 'application/json' }
  })]);
  await assert.rejects(run({ ...environment, 'INPUT_TIMEOUT-SECONDS': '600' }, context), /HTTP 403/);
  assert.deepEqual(durations, [15000, 600000, 2000]);
  assert.deepEqual(context.waits, []);
});

test('exchange timeouts cap at ten minutes', async t => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', ms => { durations.push(ms); return new AbortController().signal; });
  const context = harness([json({ value: 'a' }), json({}, 503), json({ value: 'b' }), json({}, 503), json({ value: 'c' }), json({ apiKey: 'key' })]);
  await run({ ...environment, 'INPUT_TIMEOUT-SECONDS': '200' }, context);
  assert.deepEqual(durations, [15000, 200000, 2000, 15000, 400000, 2000, 15000, 600000]);
});


test('HTTP failures always emit diagnostics even without headers or a body', async () => {
  const context = harness([new Response(null, { status: 500 })]);
  await assert.rejects(run({ ...environment, 'INPUT_MAX-RETRIES': '0' }, context), /HTTP 500/);
  const log = context.logs.find(line => line.includes('response diagnostics'));
  assert.match(log, /"httpStatus":500/);
  assert.match(log, /"bodyStatus":"empty"/);
});
