'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { output } = require('../src/runtime');

test('writes multiline credentials as one output and preserves existing outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nuget-login-output-'));
  try {
    const env = { GITHUB_OUTPUT: join(directory, 'output') };
    output('existing', 'value', env);
    output('NUGET_API_KEY', 'first\nother=not-an-output\nlast', env);
    const lines = readFileSync(env.GITHUB_OUTPUT, 'utf8').trimEnd().split('\n');
    assert.equal(lines[0], `existing<<${lines[2]}`);
    assert.equal(lines[1], 'value');
    assert.equal(lines[3], `NUGET_API_KEY<<${lines[7]}`);
    assert.deepEqual(lines.slice(4, 7), ['first', 'other=not-an-output', 'last']);
    assert.notEqual(lines[2], lines[7]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
