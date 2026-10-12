'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { input, mask, output } = require('./runtime');

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
  return Math.min(30000, 1000 * 2 ** attempt + Math.floor(random() * 250));
}

async function requestJson(url, options, label, settings, fetchImpl, wait) {
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    // Token exchange retries must acquire a fresh, single-use OIDC token.
    const requestOptions = typeof options === 'function' ? await options() : options;
    let response;
    let body;
    let transient = false;
    try {
      response = await fetchImpl(url, {
        ...requestOptions,
        redirect: 'manual',
        signal: AbortSignal.timeout(settings.timeout * 1000)
      });
      if (response.ok) body = await response.text();
      // Cleanup must not turn a definitive HTTP rejection into a retryable error.
      else {
        try { await response.body?.cancel(); } catch { /* The HTTP status remains authoritative. */ }
      }
    } catch {
      // Never include fetch errors, headers, URLs, or response bodies in logs.
      transient = true;
    }

    if (!transient && response.ok) {
      try { return JSON.parse(body); }
      catch { throw new Error(`${label} returned invalid JSON.`); }
    }

    transient ||= [408, 429, 500, 502, 503, 504].includes(response.status);
    if (!transient || attempt === settings.retries) {
      const status = transient && (!response || response.ok) ? 'network error or timeout' : `HTTP ${response.status}`;
      const hint = response && [400, 401, 403].includes(response.status)
        ? ' Check id-token: write, the NuGet policy creator username, repository, workflow filename, and environment in your trusted publishing policy.'
        : ' Check service availability and runner network access.';
      throw new Error(`${label} failed (${status}).${hint}`);
    }
    const delay = retryDelay(response?.headers.get('retry-after') ?? null, attempt, settings.random);
    settings.info(`${label}: retry ${attempt + 1}/${settings.retries} in ${delay}ms (${response && !response.ok ? `HTTP ${response.status}` : 'network error or timeout'}).`);
    await wait(delay);
  }
}

async function run(env = process.env, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const wait = dependencies.sleep || sleep;
  const setSecret = dependencies.mask || mask;
  const setOutput = dependencies.output || ((name, value) => output(name, value, env));
  if (!dependencies.output && !env.GITHUB_OUTPUT)
    throw new Error('GITHUB_OUTPUT is unavailable. Run this action in a GitHub Actions step.');
  const user = input('user', env);
  if (!user) throw new Error('The user input must be the NuGet.org username of the trusted publishing policy creator.');
  const settings = {
    retries: integer(input('max-retries', env), 3, 0, 5, 'max-retries'),
    timeout: integer(input('timeout-seconds', env), 240, 1, 600, 'timeout-seconds'),
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
    }, 'GitHub OIDC request', settings, fetchImpl, wait);
    if (typeof identity?.value !== 'string' || !identity.value.trim())
      throw new Error('GitHub OIDC response did not contain a token.');
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
