import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const cache = new Map();
function domain(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  vm.runInNewContext(compile(file), { exports, structuredClone, require(name) {
    assert.ok(name.startsWith('.'), `Unexpected domain dependency: ${name}`);
    return domain(path.resolve(path.dirname(file), name + '.ts'));
  } });
  return exports;
}
const core = domain('src/lib/tesla-tariff/supervised-experiment.ts');
const site = domain('src/lib/site/current-site.ts').currentSite;
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const source = compile('src/lib/tesla-tariff/supervised-local.ts');
const secret = 'SECRET_TOKEN_AUTH_HEADER_RAW_RESPONSE_ENV_VALUE';
const fail = () => { throw new Error(secret); };
function harness(fault) {
  const calls = { claims: 0, writes: 0, prompts: 0, reads: 0, output: [] };
  const exports = {};
  const dependencies = {
    'node:fs/promises': { readFile: async () => {
      if (fault === 'token-read') fail();
      if (fault === 'token-json') return secret;
      if (fault === 'token-invalid') return 'null';
      return JSON.stringify({ access_token: secret });
    }, mkdir: fail, writeFile: fail },
    'node:path': path,
    'node:crypto': { createHash: fail, randomUUID: fail },
    'node:readline/promises': { createInterface() { calls.prompts++; fail(); } },
    '@next/env': { loadEnvConfig() {} },
    '../site/current-site': { currentSite: site },
    '../kraken/client': {
      async getKrakenDevices() {
        if (fault === 'devices') fail();
        if (fault === 'capture') return null;
        return fixture.kraken.vehicles;
      },
      async getKrakenPlannedDispatches() { if (fault === 'dispatches') fail(); return fixture.kraken.vehicles[0].plannedDispatches; },
    },
    './observed-tariff': { captureObservedTariff() {
      if (fault === 'tesla-capture') fail();
      if (fault === 'preparation') return {};
      if (fault === 'known-preparation') return { ...fixture.before, source: { ...fixture.before.source, observedAt: '2000-01-01T00:00:00Z' } };
      return fixture.before;
    } },
    './supervised-journal': { claimExperimentJournal() { calls.claims++; fail(); } },
    './supervised-experiment': core,
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-23T08:12:00.000Z'])); } }
  vm.runInNewContext(source, {
    exports, Date: FixedDate, AbortSignal,
    process: { cwd: () => '/mock', env: {}, stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: { isTTY: true } },
    console: { log: value => calls.output.push(value) },
    async fetch(url, options) {
      if (options.method !== 'GET') { calls.writes++; fail(); }
      calls.reads++;
      if (fault === 'tesla-network') fail();
      return { ok: fault !== 'tesla-http', async json() {
        if (fault === 'tesla-json') fail();
        return { response: { energy_site_id: fault === 'site' ? '999' : '12345' } };
      } };
    },
    require(name) { assert.ok(name in dependencies, name); return dependencies[name]; },
  });
  return { calls, api: exports, run: execute => exports.runLocalExperiment([
    '--site', '12345', '--vehicle', 'q7-fixture', '--dispatch-start', '2026-09-23T08:00:00+00:00',
    ...(execute ? ['--execute-supervised'] : []),
  ]) };
}

const failures = {
  'token-read': 'TESLA_TOKEN_READ_FAILED', 'token-json': 'TESLA_TOKEN_READ_FAILED',
  'token-invalid': 'READ_ACCESS_REQUIRED', 'tesla-network': 'TESLA_READ_FAILED',
  'tesla-http': 'TESLA_READ_FAILED', 'tesla-json': 'TESLA_READ_DECODE_FAILED',
  site: 'SITE_MISMATCH', devices: 'KRAKEN_DEVICE_READ_FAILED',
  dispatches: 'KRAKEN_PLANNED_DISPATCH_READ_FAILED', 'tesla-capture': 'TESLA_CAPTURE_FAILED',
  capture: 'CAPTURE_PREPARATION_FAILED', preparation: 'PREPARATION_FAILED',
  'known-preparation': 'FRESH_CAPTURE_AND_EVIDENCE_REQUIRED',
};
for (const [fault, code] of Object.entries(failures)) {
  test(`${fault} retains safe ${code}, with no confirmation, claim or write`, async () => {
    for (const execute of [false, true]) {
      const h = harness(fault);
      await assert.rejects(h.run(execute), error => {
        assert.equal(error.message, code);
        assert.equal(h.api.safeExperimentFailureCode(error), code);
        assert.ok(!String(error.stack).includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(h.calls.claims + h.calls.writes + h.calls.prompts, 0);
      assert.deepEqual(h.calls.output, []);
      assert.ok(h.calls.reads <= 1, 'No retries');
    }
  });
}

test('CLI sanitizer discards arbitrary messages, causes, response bodies and non-error throws', () => {
  const { api } = harness();
  for (const error of [null, undefined, secret, new Error(secret), { message: secret, response: secret }, { message: 'SITE_MISMATCH ' + secret }]) {
    assert.equal(api.safeExperimentFailureCode(error), 'READ_OR_EXECUTION_FAILED');
  }
  assert.equal(api.safeExperimentFailureCode({ message: 'SITE_MISMATCH', cause: secret, token: secret }), 'SITE_MISMATCH');
  assert.equal(api.safeExperimentFailureCode({ code: 'EEXIST', message: secret }), 'SITE_ATTEMPT_ALREADY_RECORDED');
  const cli = fs.readFileSync('scripts/tesla-tariff-experiment.mjs', 'utf8');
  assert.match(cli, /console\.error\(safeExperimentFailureCode\(error\)\)/);
  assert.doesNotMatch(cli, /console\.error\(error[.)]/);
});
