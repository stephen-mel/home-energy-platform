import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

class InputDate extends Date {
  constructor(...args) { assert.ok(args.length, 'Domain must use injected clock'); super(...args); }
  static now() { throw Error('No wall clock in domain'); }
}
const modules = new Map();
function load(file, natives = {}) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, structuredClone, Date: InputDate, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    assert.ok(name in natives, `Forbidden domain dependency: ${name}`); return natives[name];
  } });
  return exports;
}
const api = load('src/lib/tesla-tariff/supervised-experiment.ts');
const proposalAPI = load('src/lib/tesla-tariff/proposal-approval.ts');
const journalAPI = load('src/lib/tesla-tariff/supervised-journal.ts', { 'node:fs/promises': fsp, 'node:path': path });
const site = load('src/lib/site/current-site.ts').currentSite;
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const selection = { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' };
const generatedAt = '2026-09-23T08:12:00.000Z';
const prepared = () => api.prepareSupervisedExperiment(site, selection, structuredClone(fixture), generatedAt);
function harness(overrides = {}) {
  let time = Date.parse(generatedAt), captures = 0, consumed = false;
  const calls = { writes: [], confirmations: 0, claims: [], finishes: [], reads: 0 };
  let lastReview;
  const ports = {
    now: () => new Date(time).toISOString(),
    capture: async () => { captures++; const c = structuredClone(fixture);
      if (captures > 1) { time += 1000; c.before.source.observedAt = ports.now(); c.kraken.lastSuccessfulUpdate = ports.now(); }
      return c; },
    confirm: async (review, challenge) => { calls.confirmations++; lastReview = review; time += 1000;
      return { challenge, automaticRollbackUnproven: true, manualAppRecoveryMayBeRequired: true }; },
    challenge: text => createHash('sha256').update(text).digest('hex'),
    claim: async (site, record) => { if (consumed) throw Error('ALREADY_CONSUMED'); consumed = true; calls.claims.push({ site, record });
      return { finish: async record => calls.finishes.push(record) }; },
    write: async (site, payload) => { calls.writes.push({ site, payload }); time += 1000; return { status: 'accepted', httpStatus: 200 }; },
    readBack: async () => { calls.reads++; time += 1000; return { ...structuredClone(fixture.before),
      source: { ...fixture.before.source, observedAt: ports.now() }, tariff: JSON.parse(lastReview.payloadJson).tou_settings.tariff_content_v2 }; },
    ...overrides,
  };
  return { ports, calls, advance: ms => { time += ms; }, run: (extra = {}) => api.runSupervisedExperiment({ site, selection,
    mode: 'execute-supervised', authority: 'supervised-experiment', ...extra }, ports) };
}

test('historical payload preserves original season/labels/export, adds exact 09:00–11:00 price and binds its mapping', () => {
  const r = prepared(), t = JSON.parse(r.payloadJson).tou_settings.tariff_content_v2;
  assert.deepEqual(t.sell_tariff, fixture.before.tariff.sell_tariff);
  for (const season of ['Yesterday', 'Today', 'TwoDays', 'ThreeDays']) assert.deepEqual(t.seasons[season], fixture.before.tariff.seasons[season]);
  assert.deepEqual(t.energy_charges.Tomorrow.rates, { hour_0_minute_0: 0.02993, hour_6_minute_0: 0.25177, hour_9_minute_0: 0.0299 });
  assert.deepEqual(t.seasons.Tomorrow.tou_periods.hour_0_minute_0, fixture.before.tariff.seasons.Tomorrow.tou_periods.hour_0_minute_0);
  assert.deepEqual(t.seasons.Tomorrow.tou_periods.hour_9_minute_0.periods, [{ toDayOfWeek: 6, fromHour: 9, fromMinute: 0, toHour: 11, toMinute: 0 }]);
  assert.equal(t.seasons.Tomorrow.tou_periods.hour_6_minute_0.periods.length, 2);
  assert.ok(!r.payloadJson.includes('SUPER_OFF_PEAK')); assert.ok(r.proposal.fingerprint.includes('hour_9_minute_0'));
  assert.ok(r.fingerprint.includes('hour_9_minute_0'));
  assert.equal(r.proposal.writeReady, false); assert.equal(r.rollbackProven, false);
  assert.ok(r.proposal.bound.evidence.every(p => p.state === 'planned-conditional'));
  assert.equal(r.fingerprint, prepared().fingerprint);
  const altered = structuredClone(r.proposal); altered.bound.representation.energy_charges.Tomorrow.rates.hour_9_minute_0 = 0.17;
  assert.throws(() => proposalAPI.approveTariffProposal(altered, { fingerprint: altered.fingerprint, approvedAt: generatedAt }));
});

test('default dry-run never confirms, claims, writes or reads back; automatic authority cannot execute', async () => {
  const h = harness(); const r = await h.run({ mode: undefined });
  assert.equal(r.status, 'dry-run'); assert.equal(h.calls.writes.length + h.calls.claims.length + h.calls.reads + h.calls.confirmations, 0);
  await assert.rejects(h.run({ authority: 'automatic' }), /SUPERVISED_AUTHORITY/);
});

test('one supervised attempt records API/read-back separately and preserves every production risk', async () => {
  const h = harness(), r = await h.run();
  assert.equal(r.record.classification, 'submitted-representation-preserved');
  assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.writes[0].payload, r.review.payloadJson);
  assert.equal(h.calls.claims[0].record.phase, 'approval-consumed-before-write');
  assert.equal(r.record.laterTeslaAppObservation, null); assert.equal(r.record.laterPowerwallOpticasterObservation, null);
  assert.equal(r.record.productionWriteReady, false); assert.equal(r.record.rollbackProven, false);
  for (const code of ['BUY_BELOW_SELL', 'ROLLBACK_UNPROVEN', 'BOUNDED_FORECAST', 'RESTORATION_REQUIRED', 'OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED'])
    assert.ok(r.record.exception.productionBlockers.includes(code));
  await assert.rejects(h.run(), /ALREADY_CONSUMED/); assert.equal(h.calls.writes.length, 1);
});

test('wrong challenge or either missing acknowledgement prevents claim/write', async () => {
  for (const change of [{ challenge: 'old' }, { automaticRollbackUnproven: false }, { manualAppRecoveryMayBeRequired: false }]) {
    const h = harness({ confirm: async (_, challenge) => ({ challenge, automaticRollbackUnproven: true, manualAppRecoveryMayBeRequired: true, ...change }) });
    await assert.rejects(h.run(), /EXACT_HUMAN_APPROVAL/); assert.equal(h.calls.claims.length + h.calls.writes.length, 0);
  }
});

test('changed, moved, shortened, cancelled, disappeared, BOOST or modified-energy SMART evidence invalidates approval', async () => {
  for (const mutate of [c => { c.kraken.vehicles[0].plannedDispatches = []; }, c => { c.kraken.vehicles = []; },
    c => { c.kraken.vehicles[0].plannedDispatches[0].start = '2026-09-23T08:30:00+00:00'; },
    c => { c.kraken.vehicles[0].plannedDispatches[0].end = '2026-09-23T09:30:00+00:00'; },
    c => { c.kraken.vehicles[0].plannedDispatches[0].type = 'BOOST'; },
    c => { c.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh = '-3'; }]) {
    const h = harness(), read = h.ports.capture; let n = 0;
    h.ports.capture = async () => { const c = await read(); if (++n > 1) mutate(c); return c; };
    await assert.rejects(h.run(), /SMART_EVIDENCE_CHANGED/); assert.equal(h.calls.writes.length, 0);
  }
});

test('freshness-only recheck is allowed; stale evidence, changed Tesla tariff/site and slow approval are blocked', async () => {
  for (const [mutate, expected] of [
    [c => { c.kraken.stale = true; }, /STALE/],
    [c => { c.before.tariff.name = 'changed'; }, /TESLA_BEFORE/],
    [c => { c.before.source.energySiteId = 'other'; }, /TESLA_BEFORE/],
    [c => { c.kraken.lastSuccessfulUpdate = '2026-09-23T07:00:00Z'; }, /STALE/],
  ]) {
    const h = harness(), read = h.ports.capture; let n = 0;
    h.ports.capture = async () => { const c = await read(); if (++n > 1) mutate(c); return c; };
    await assert.rejects(h.run(), expected); assert.equal(h.calls.writes.length, 0);
  }
  const h = harness(), confirm = h.ports.confirm;
  h.ports.confirm = async (...args) => { h.advance(180000); return confirm(...args); };
  await assert.rejects(h.run(), /STALE/); assert.equal(h.calls.writes.length, 0);
});

test('expiry at 11:00, approval TTL and delayed persistence fail before POST', async () => {
  for (const at of ['2026-09-23T10:00:00Z', '2026-09-23T09:59:40Z']) {
    const h = harness(), read = h.ports.capture; let n = 0;
    h.ports.capture = async () => { const c = await read(); if (++n > 1) h.advance(Date.parse(at) - Date.parse(h.ports.now())); return c; };
    await assert.rejects(h.run()); assert.equal(h.calls.writes.length, 0);
  }
  const h = harness(), claim = h.ports.claim;
  h.ports.claim = async (...args) => { const journal = await claim(...args); h.advance(61000); return journal; };
  await assert.rejects(h.run(), /APPROVAL_EXPIRED_AFTER_CLAIM/); assert.equal(h.calls.writes.length, 0); assert.equal(h.calls.claims.length, 1);
});

test('write rejection, pure buy-raising, other transformation and absent read-back are classified independently', async () => {
  for (const scenario of ['rejected', 'raised', 'partial-raised', 'different', 'missing', 'unknown']) {
    const h = harness(), write = h.ports.write, read = h.ports.readBack;
    h.ports.write = async (...args) => { const r = await write(...args); return scenario === 'rejected' ? { status: 'rejected', httpStatus: 400 }
      : scenario === 'unknown' ? { status: 'unknown', httpStatus: null } : r; };
    h.ports.readBack = async () => { const r = await read();
      if (scenario === 'missing') throw Error('network failure');
      if (scenario === 'partial-raised') r.tariff.energy_charges.Tomorrow.rates.hour_9_minute_0 = 0.17;
      if (scenario === 'different') r.tariff.name = 'Tesla changed identity';
      if (scenario === 'raised') for (const c of Object.values(r.tariff.energy_charges)) for (const key of Object.keys(c.rates)) c.rates[key] = Math.max(c.rates[key], 0.17);
      return r; };
    const r = await h.run();
    assert.equal(r.record.classification, ({ rejected: 'request-rejected', raised: 'buy-raised-to-sell', 'partial-raised': 'buy-raised-to-sell', different: 'accepted-but-transformed-differently',
      missing: 'read-back-unavailable-or-insufficient', unknown: 'write-outcome-unknown' })[scenario]);
    assert.equal(h.calls.writes.length, 1); assert.equal(h.calls.reads, 1);
    assert.equal(r.record.laterPowerwallOpticasterObservation, null);
  }
});

test('transport throw never retries; journal failures never permit resend', async () => {
  const h = harness(); h.ports.write = async () => { h.calls.writes.push('attempt'); throw Error('SECRET must not be recorded'); };
  const r = await h.run(); assert.equal(r.record.classification, 'write-outcome-unknown'); assert.equal(h.calls.writes.length, 1);
  assert.doesNotMatch(JSON.stringify(r.record), /SECRET/);
  const failed = harness({ claim: async () => { throw Error('disk unavailable'); } });
  await assert.rejects(failed.run()); assert.equal(failed.calls.writes.length, 0);
  const completion = harness(), claim = completion.ports.claim;
  completion.ports.claim = async (...args) => { await claim(...args); return { finish: async () => { throw Error('disk failed after write'); } }; };
  await assert.rejects(completion.run()); await assert.rejects(completion.run()); assert.equal(completion.calls.writes.length, 1);
});

test('real local journal atomically excludes concurrent/restarted attempts and contains no executable approval loader', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'hep-experiment-test-'));
  try {
    const claims = await Promise.allSettled([journalAPI.claimExperimentJournal(directory, '12345', { approval: 'fixture' }), journalAPI.claimExperimentJournal(directory, '12345', {})]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    await claims.find(r => r.status === 'fulfilled').value.finish({ classification: 'fixture-only' });
    await assert.rejects(journalAPI.claimExperimentJournal(directory, '12345', {}));
    assert.equal((await fsp.stat(path.join(directory, 'site-12345.jsonl'))).mode & 0o777, 0o600);
    assert.equal((await fsp.readFile(path.join(directory, 'site-12345.jsonl'), 'utf8')).trim().split('\n').length, 2);
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
});

test('HTTP/API outcomes are sanitized, conservative and do not infer acceptance from HTTP 200 alone', () => {
  for (const [http, body, expected] of [[200, { response: { result: true } }, 'accepted'], [201, { response: { code: 201 } }, 'accepted'],
    [200, { response: { result: false } }, 'rejected'], [400, {}, 'rejected'], [500, {}, 'unknown'], [200, {}, 'unknown'], [408, {}, 'unknown']]) {
    const r = api.interpretWriteResponse(http, { ...body, access_token: 'NEVER_PERSIST', error: 'PRIVATE' });
    assert.equal(r.status, expected); assert.doesNotMatch(JSON.stringify(r), /NEVER_PERSIST|PRIVATE/);
  }
});

test('local entry refuses noninteractive/test execution before reads and is not wired into app/planner', () => {
  const r = spawnSync(process.execPath, ['scripts/tesla-tariff-experiment.mjs', '--execute-supervised'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(r.status, 1); assert.match(r.stderr, /Experiment stopped/);
  const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(folder, e.name)) : [path.join(folder, e.name)]);
  for (const file of [...walk('src/app'), 'src/lib/tesla-tariff/sync-planner.ts']) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /supervised-(experiment|local)/);
  assert.match(fs.readFileSync('.gitignore', 'utf8'), /\.cache\/home-energy-platform/);
});

test('a different vehicle/date/start derives a new label and no historical interval is hardcoded', () => {
  const c = structuredClone(fixture);
  c.kraken.vehicles[0].id = 'a3-fixture'; c.kraken.vehicles[0].name = 'Audi A3';
  c.kraken.vehicles[0].plannedDispatches = [{ start: '2026-09-24T12:15:00+00:00', end: '2026-09-24T13:00:00+00:00', type: 'SMART', energyAddedKwh: '-2' }];
  c.before.source.observedAt = c.kraken.lastSuccessfulUpdate = '2026-09-24T12:10:00Z';
  const r = api.prepareSupervisedExperiment(site, { energySiteId: '12345', assetId: 'a3-fixture', dispatchStart: '2026-09-24T12:15:00+00:00' }, c, '2026-09-24T12:10:10Z');
  const t = JSON.parse(r.payloadJson).tou_settings.tariff_content_v2;
  assert.equal(t.energy_charges.TwoDays.rates.hour_13_minute_15, 0.0299);
  assert.deepEqual(t.seasons.Tomorrow, fixture.before.tariff.seasons.Tomorrow);
  assert.equal(r.proposal.bound.expiresAt, '2026-09-24T13:00:00+00:00');
});

test('stale preparation, BOOST-only, unknown future prices and non-isolated date seasons fail closed', () => {
  const c = structuredClone(fixture); c.kraken.stale = true;
  assert.throws(() => api.prepareSupervisedExperiment(site, selection, c, generatedAt), /FRESH/);
  c.kraken.stale = false; c.kraken.vehicles[0].plannedDispatches[0].type = 'BOOST';
  assert.throws(() => api.prepareSupervisedExperiment(site, selection, c, generatedAt), /SMART/);
  const future = structuredClone(fixture);
  future.before.source.observedAt = future.kraken.lastSuccessfulUpdate = '2026-10-01T08:01:00Z';
  future.kraken.vehicles[0].plannedDispatches = [{ type: 'SMART', start: '2026-10-01T08:00:00Z', end: '2026-10-01T10:00:00Z', energyAddedKwh: null }];
  assert.throws(() => api.prepareSupervisedExperiment(site, { ...selection, dispatchStart: '2026-10-01T08:00:00Z' }, future, '2026-10-01T08:01:01Z'), /COMMON_DOMAIN/);
  const wrapped = structuredClone(fixture);
  wrapped.before.source.observedAt = wrapped.kraken.lastSuccessfulUpdate = '2026-09-25T08:01:00Z';
  wrapped.kraken.vehicles[0].plannedDispatches = [{ type: 'SMART', start: '2026-09-25T08:00:00Z', end: '2026-09-25T10:00:00Z', energyAddedKwh: null }];
  assert.throws(() => api.prepareSupervisedExperiment(site, { ...selection, dispatchStart: '2026-09-25T08:00:00Z' }, wrapped, '2026-09-25T08:01:01Z'), /STRUCTURALLY_VALID/);
});

test('committed example is the exact deterministic fixture payload, not a live approval', () => {
  assert.equal(JSON.stringify(JSON.parse(prepared().payloadJson)), JSON.stringify(JSON.parse(fs.readFileSync('docs/examples/tesla-q7-2026-09-23-payload.json', 'utf8'))));
});
