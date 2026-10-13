'use strict';

const permanent = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'INVALID_CA', 'CERT_REVOKED',
  'ERR_INVALID_URL', 'ERR_INVALID_PROTOCOL', 'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_HTTP_TOKEN', 'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_INVALID_CHAR'
]);
const temporary = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'CONNECT_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE'
]);

function failure(error, signal) {
  if (signal.aborted) return { code: 'ATTEMPT_TIMEOUT', retry: true };
  const codes = [];
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 20) return;
    seen.add(value);
    if (permanent.has(value.code) || temporary.has(value.code)) codes.push(value.code);
    visit(value.cause);
    if (Array.isArray(value.errors)) value.errors.slice(0, 20).forEach(visit);
  }
  visit(error);
  const code = codes.find(value => permanent.has(value)) || codes[0];
  // Unknown failures get bounded retries, but their arbitrary messages/codes stay private.
  return { code: code || 'UNKNOWN_TRANSPORT_ERROR', retry: !permanent.has(code) };
}

module.exports = { failure };
