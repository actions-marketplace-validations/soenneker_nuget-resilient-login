'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { request } = require('../src/transport');

async function server(t, handler) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
  });
  return 'http://127.0.0.1:' + instance.address().port;
}

test('transport sends the exchange body with explicit timeout options', async t => {
  const url = await server(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(body, '{"username":"test"}');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"apiKey":"test-key"}');
  });
  const response = await request(url, {
    method: 'POST', body: '{"username":"test"}', signal: AbortSignal.timeout(600000)
  }, (target, options, callback) => {
    assert.equal(options.timeout, 0);
    assert.equal(options.agent, false);
    return http.request(target, options, callback);
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await response.text()), { apiKey: 'test-key' });
});

test('transport does not follow redirects', async t => {
  let calls = 0;
  const url = await server(t, (_req, res) => {
    calls++;
    res.writeHead(302, { location: '/other' });
    res.end();
  });
  const response = await request(url, {}, http.request);
  assert.equal(response.status, 302);
  await response.body.cancel();
  assert.equal(calls, 1);
});

test('attempt cancellation interrupts a real stalled response body', async t => {
  const url = await server(t, (_req, res) => {
    res.writeHead(200);
    res.write('{');
  });
  const controller = new AbortController();
  const response = await request(url, { signal: controller.signal }, http.request);
  const body = response.text();
  controller.abort();
  await assert.rejects(body);
});


test('connection establishment stops after ten seconds', async t => {
  const { EventEmitter } = require('node:events');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  const req = new EventEmitter();
  req.end = () => req.emit('socket', socket);
  req.destroy = error => { req.emit('error', error); req.emit('close'); };
  const result = request('https://example.test', {}, () => req);
  const rejection = assert.rejects(result, { code: 'CONNECT_TIMEOUT' });
  t.mock.timers.tick(10000);
  await rejection;
});

test('TLS connection completion clears the connection deadline', async t => {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new EventEmitter();
  const req = new EventEmitter();
  let callback;
  req.end = () => { req.emit('socket', socket); socket.emit('secureConnect'); };
  req.destroy = () => assert.fail('Connected request was cut off by the connection deadline');
  const result = request('https://example.test', {}, (_url, _options, cb) => { callback = cb; return req; });
  t.mock.timers.tick(600000);
  const res = Readable.from([Buffer.from('{}')]);
  res.headers = {};
  res.statusCode = 200;
  callback(res);
  assert.equal(await (await result).text(), '{}');
});
