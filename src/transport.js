'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');

// Native HTTPS has no implicit header/body deadline; the attempt signal owns it.
function request(url, options, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    let connectTimer;
    const req = requestImpl(url, {
      method: options.method, headers: options.headers, signal: options.signal,
      agent: false, timeout: 0
    }, res => {
      clearTimeout(connectTimer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const body = Readable.toWeb(res);
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode, headers, body,
        text: () => new Response(body).text()
      });
    });
    req.once('error', reject);
    req.once('close', () => clearTimeout(connectTimer));
    req.once('socket', socket => {
      connectTimer = setTimeout(() => {
        const error = new Error('Connection timed out');
        error.code = 'CONNECT_TIMEOUT';
        req.destroy(error);
      }, 10000);
      connectTimer.unref();
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });
    req.end(options.body);
  });
}

module.exports = { request };
