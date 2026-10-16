import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/inspect-smart-charge.mjs');
const source = fs.readFileSync(script, 'utf8');

function run(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-inspection-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = path.join(directory, 'calls');
  const forbidden = path.join(directory, 'forbidden');
  const hook = path.join(directory, 'hook.cjs');
  fs.writeFileSync(hook, `
const fs = require('node:fs');
const Module = require('node:module');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@next/env') {
    if (process.env.HEP_CLI_TEST_MODE === 'startup') throw Error('PRIVATE_STARTUP_DETAIL');
    return { loadEnvConfig() {} };
  }
  if (request.endsWith('/src/lib/site/current-site.ts')) return { currentSite: { id: 'synthetic' } };
  if (request.endsWith('/src/lib/site/inspect-smart-charge.ts')) return { inspectSmartCharge: async site => {
    fs.appendFileSync(process.env.HEP_CLI_CALLS, site.id + '\\n');
    if (process.env.HEP_CLI_TEST_MODE === 'runtime') throw Error('PRIVATE_RUNTIME_DETAIL');
    return { text: 'SYNTHETIC INSPECTION\\npayload: null\\nwriteReady: false' };
  } };
  if (/supervised|journal|ownership|restor|time.of.use.settings|setKrakenVehiclePreferences/.test(request)) {
    fs.appendFileSync(process.env.HEP_CLI_FORBIDDEN, request + '\\n');
    throw Error('FORBIDDEN_IMPORT');
  }
  return Reflect.apply(original, this, [request, parent, isMain]);
};
`);
  const result = spawnSync(process.execPath, ['--require', hook, script], {
    encoding: 'utf8', env: { ...process.env, HEP_CLI_TEST_MODE: mode,
      HEP_CLI_CALLS: calls, HEP_CLI_FORBIDDEN: forbidden, PRIVATE_CREDENTIAL: 'DO_NOT_PRINT' },
  });
  return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '',
    forbidden: fs.existsSync(forbidden) ? fs.readFileSync(forbidden, 'utf8') : '' };
}

test('CLI imports only the read-only inspection entry and invokes it exactly once', t => {
  const runResult = run(t, 'success');
  assert.equal(runResult.result.status, 0, runResult.result.stderr);
  assert.equal(runResult.calls, 'synthetic\n');
  assert.equal(runResult.forbidden, '');
  assert.match(runResult.result.stdout, /SYNTHETIC INSPECTION/);
  assert.match(runResult.result.stdout, /payload: null/);
  assert.doesNotMatch(source, /tesla-tariff-experiment|supervised-(?:local|experiment)|ownership|journal|restoration|time_of_use_settings|setKrakenVehiclePreferences/);
  assert.match(source, /site\/inspect-smart-charge\.ts/);
});

test('runtime failures are sanitized and exit nonzero', t => {
  const runResult = run(t, 'runtime');
  assert.notEqual(runResult.result.status, 0);
  assert.equal(runResult.calls, 'synthetic\n');
  assert.equal(runResult.result.stdout, '');
  assert.equal(runResult.result.stderr.trim(), 'SMART_INSPECTION_FAILED');
  assert.doesNotMatch(runResult.result.stderr, /PRIVATE|DO_NOT_PRINT/);
});

test('startup failures are sanitized, make no inspection call and exit nonzero', t => {
  const runResult = run(t, 'startup');
  assert.notEqual(runResult.result.status, 0);
  assert.equal(runResult.calls, '');
  assert.equal(runResult.forbidden, '');
  assert.equal(runResult.result.stdout, '');
  assert.equal(runResult.result.stderr.trim(), 'SMART_INSPECTION_STARTUP_FAILED');
  assert.doesNotMatch(runResult.result.stderr, /PRIVATE|DO_NOT_PRINT/);
});
