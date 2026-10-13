'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { request } = require('./transport');
const { failure } = require('./failure');
const { input, mask, output } = require('./runtime');
const { responseHeaders, errorMessage } = require('./diagnostics');

function integer(value, fallback, minimum, maximum, name) {
  const result = value === '' ? fallback : Number(value);
  if (!/^\d+$/.test(value || String(fallback)) || !Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  return result;
}

function retryDelay(header, attempt, random = Math.random, now = Date.now()) {
  const value = header?.trim();
  let seconds = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (seconds === Infinity) throw new Error('The service requested a Retry-After delay longer than 300 seconds. Retry the workflow later.');
  if (value && !Number.isFinite(seconds) && /^[A-Za-z]{3}, /.test(value))
    seconds = (Date.parse(value) - now) / 1000;
  if (Number.isFinite(seconds)) {
    if (seconds > 300) throw new Error('The service requested a Retry-After delay longer than 300 seconds. Retry the workflow later.');
    return Math.max(0, seconds * 1000);
  }
  const base = Math.min(120000, 10000 * 3 ** attempt);
  return base + Math.floor(random() * base * 0.5);
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function requestJson(url, options, label, settings, fetchImpl, wait) {
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    // Token exchange retries must acquire a fresh, single-use OIDC token.
    const requestOptions = typeof options === 'function' ? await options() : options;
    const timeout = Math.min(settings.timeout * (settings.fixedTimeout ? 1 : 2 ** attempt), 600) * 1000;
    settings.info(`${label}: attempt ${attempt + 1}/${settings.retries + 1} starting (timeout ${timeout}ms).`);
    const started = settings.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
    let response;
    let body;
    let diagnosticMessage;
    let transportFailure;
    try {
      await abortable(async () => {
        response = await fetchImpl(url, {
          ...requestOptions,
          redirect: 'manual',
          signal
        });
        if (response.ok) body = await response.text();
        // Cleanup must not turn a definitive HTTP rejection into a retryable error.
        else {
          try {
            await abortable(async () => {
              if (settings.logResponses) diagnosticMessage = await errorMessage(response, settings.secrets);
              else await response.body?.cancel();
            }, AbortSignal.timeout(2000));
          } catch {
            // Stop stalled diagnostic reads without changing the definitive HTTP status.
            diagnosticMessage = { bodyStatus: 'timeout' };
            controller.abort();
          }
        }
      }, signal);
    } catch (error) {
      if (!response || response.ok) transportFailure = failure(error, signal);
    }
    const status = transportFailure
      ? `network error or timeout: ${transportFailure.code}; response headers ${response ? 'received' : 'not received'}`
      : `HTTP ${response.status}`;

    settings.info(`${label}: attempt ${attempt + 1}/${settings.retries + 1} completed in ${Math.round(settings.now() - started)}ms (${status}).`);
    if (settings.logResponses && response && !response.ok) {
      const details = { httpStatus: response.status, ...responseHeaders(response, settings.secrets), ...(diagnosticMessage || { bodyStatus: 'unavailable' }) };
      settings.info(`${label}: response diagnostics ${JSON.stringify(details)}`);
    }

    if (!transportFailure && response.ok) {
      try { return JSON.parse(body); }
      catch { throw new Error(`${label} returned invalid JSON.`); }
    }

    const transient = transportFailure ? transportFailure.retry : [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!transient || attempt === settings.retries) {
      const hint = transportFailure && !transportFailure.retry
        ? ' Fix the runner certificate trust or request configuration; retrying will not help.'
        : response && [400, 401, 403].includes(response.status)
        ? ' Check id-token: write, the NuGet policy creator username, repository, workflow filename, and environment in your trusted publishing policy.'
        : ' Check service availability and runner network access.';
      throw new Error(`${label} failed (${status}).${hint}`);
    }
    const delay = retryDelay(response?.headers.get('retry-after') ?? null, attempt, settings.random, Date.now());
    settings.info(`${label}: retry ${attempt + 1}/${settings.retries}: waiting ${delay}ms... (${status}).`);
    await wait(delay);
  }
}

async function run(env = process.env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || request;
  const wait = dependencies.sleep || sleep;
  const setSecret = dependencies.mask || mask;
  const setOutput = dependencies.output || ((name, value) => output(name, value, env));
  if (!dependencies.output && !env.GITHUB_OUTPUT)
    throw new Error('GITHUB_OUTPUT is unavailable. Run this action in a GitHub Actions step.');
  const user = input('user', env);
  if (!user) throw new Error('The user input must be the NuGet.org username of the trusted publishing policy creator.');
  const logResponses = input('log-responses', env) || 'true';
  if (!['true', 'false'].includes(logResponses)) throw new Error('log-responses must be true or false.');
  const now = dependencies.now || (() => performance.now());
  const settings = {
    now,
    secrets: [],
    logResponses: logResponses === 'true',
    retries: integer(input('max-retries', env), 2, 0, 5, 'max-retries'),
    timeout: integer(input('timeout-seconds', env), 60, 1, 600, 'timeout-seconds'),
    random: dependencies.random || Math.random,
    info: dependencies.info || (message => process.stdout.write(`${message}\n`))
  };
  const audience = input('audience', env) || 'https://www.nuget.org';
  let tokenServiceUrl;
  try {
    tokenServiceUrl = new URL(input('token-service-url', env) || 'https://www.nuget.org/api/v2/token');
    if (tokenServiceUrl.protocol !== 'https:' || tokenServiceUrl.username || tokenServiceUrl.password || tokenServiceUrl.hash)
      throw new Error();
  } catch { throw new Error('token-service-url must be an HTTPS URL without embedded credentials or a fragment.'); }

  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestToken || !env.ACTIONS_ID_TOKEN_REQUEST_URL)
    throw new Error('GitHub OIDC is unavailable. Add permissions: id-token: write to this job.');
  settings.secrets.push(requestToken);
  setSecret(requestToken);

  let requestUrl;
  try {
    requestUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password) throw new Error();
  } catch { throw new Error('GitHub supplied an invalid OIDC request URL; HTTPS is required.'); }
  requestUrl.searchParams.set('audience', audience);

  const token = await requestJson(tokenServiceUrl, async () => {
    const identity = await requestJson(requestUrl, {
      headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' }
    }, 'GitHub OIDC request', { ...settings, retries: Math.min(settings.retries, 2), timeout: 15, fixedTimeout: true }, fetchImpl, wait);
    if (typeof identity?.value !== 'string' || !identity.value.trim())
      throw new Error('GitHub OIDC response did not contain a token.');
    settings.secrets.push(identity.value);
    setSecret(identity.value);

    return {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${identity.value}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'nuget-resilient-login'
      },
      body: JSON.stringify({ username: user, tokenType: 'ApiKey' })
    };
  }, 'NuGet token exchange', settings, fetchImpl, wait);
  if (typeof token?.apiKey !== 'string' || !token.apiKey.trim())
    throw new Error('NuGet.org response did not contain an API key.');
  setSecret(token.apiKey);
  setOutput('NUGET_API_KEY', token.apiKey);
}

module.exports = { run, retryDelay };
