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
  assert.deepEqual(context.waits, [120000, 2000]);
  assert.equal(context.logs.length, 2);
  assert.ok(context.logs.every(message => !message.includes('secret') && !message.includes('private network details')));
  assert.equal(retryDelay('0', 0), 0);
});

test('obtains a fresh OIDC token for each token-exchange retry', async () => {
  const context = harness([json({ value: 'oidc' }), json({}, 503), json({ value: 'fresh-oidc' }), json({ apiKey: 'key' })]);
  await run(environment, context);
  assert.equal(context.calls.length, 4);
  assert.equal(context.calls[3].options.headers.Authorization, 'Bearer fresh-oidc');
  assert.deepEqual(context.waits, [1000]);
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

test('defaults to 240 seconds with only user supplied and allows timeout overrides', async t => {
  const durations = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    durations.push(milliseconds);
    return new AbortController().signal;
  });
  await run(environment, harness([json({ value: 'oidc' }), json({ apiKey: 'key' })]));
  assert.deepEqual(durations, [240000, 240000]);
  durations.length = 0;
  await run({ ...environment, 'INPUT_TIMEOUT-SECONDS': '300' }, harness([json({ value: 'oidc' }), json({ apiKey: 'key' })]));
  assert.deepEqual(durations, [300000, 300000]);
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
  assert.equal(retryDelay('invalid', 0, () => 0.5), 1125);
  assert.equal(retryDelay('-1', 0, () => 0), 1000);
  assert.equal(retryDelay(' ', 0, () => 0), 1000);
  assert.equal(retryDelay(null, 5, () => 0.99), 30000);
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
  assert.ok(context.logs[0].includes('network error or timeout'));
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
  t.mock.method(AbortSignal, 'timeout', () => {
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
