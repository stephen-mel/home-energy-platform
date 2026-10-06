import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, Error, structuredClone, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    assert.equal(name, 'node:crypto', 'Pure layer must not import filesystem/network/executor clients'); return crypto;
  } }); return exports;
}
const { prepareMutationContext: build } = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const { prepareSupervisedExperiment: prepare } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const { ownershipFingerprint: hash, checkOwnershipDomain } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const site = load('src/lib/site/current-site.ts').currentSite;
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const capturedAt = '2026-09-23T08:11:55.000Z', generatedAt = '2026-09-23T08:12:00.000Z';
function input() { return { site: structuredClone(site), capture: structuredClone(fixture),
  selection: { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' } }; }
function ledger(intervals = []) {
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London',
    createdAt: '2026-09-23T07:00:00Z', updatedAt: '2026-09-23T07:00:00Z', validUntil: '2026-09-23T23:00:00Z',
    basis: 'confirmed-write-readback', baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64),
    proposalFingerprint: 'c'.repeat(64), smartEvidenceFingerprint: 'd'.repeat(64), intervals };
  const generation = '11111111-1111-1111-1111-111111111111';
  return { status: 'available', snapshot: { version: 2, generation, evidence, checksum: hash({ generation, evidence }), historyDigest: hash("captured history") } };
}
const owned = () => ({ start: '2026-09-23T08:00:00Z', end: '2026-09-23T10:00:00Z',
  applied: { amount: 0.25177, currency: 'GBP', unit: 'kWh' }, restore: { amount: 0.3, currency: 'GBP', unit: 'kWh' }, restoreBaselineFingerprint: 'e'.repeat(64) });
function harness(read = { status: 'missing' }, id = 'original-mutation') {
  const calls = { ids: 0, reads: [], clock: 0, order: [] };
  const ports = { readOwnership: async site => { calls.reads.push(site); calls.order.push('read'); return read; },
    now: () => { calls.order.push('clock'); return ++calls.clock === 1 ? capturedAt : generatedAt; },
    newMutationId: () => { calls.ids++; calls.order.push('id'); return id; } };
  return { ports, calls };
}
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }

test('ownership capture precedes original preparation; one ID and unchanged original proposal/payload', async () => {
  const i = input(), h = harness(), c = await build(i, h.ports);
  assert.equal(h.calls.ids, 1); assert.deepEqual(h.calls.reads, ['12345']);
  assert.deepEqual(h.calls.order, ['read', 'clock', 'clock', 'id']);
  const expected = prepare(i.site, i.selection, i.capture, generatedAt);
  assert.equal(key(c.original), key(expected)); assert.equal(c.proposalFingerprint, expected.proposal.fingerprint);
  assert.equal(c.payloadKey, expected.payloadJson); assert.equal(c.experimentFingerprint, expected.fingerprint);
  assert.equal(c.ownership.capturedAt, capturedAt); assert.equal(c.original.binding.generatedAt, generatedAt);
  assert.equal(c.writeReady, false); assert.equal(c.rollbackProven, false);
});

test('fresh revalidation retains original context and does not allocate another ID', async () => {
  const i = input(), h = harness(), c = await build(i, h.ports), snapshot = key(c);
  const fresh = structuredClone(i.capture); fresh.before.source.observedAt = generatedAt; fresh.kraken.lastSuccessfulUpdate = generatedAt;
  const checked = prepare(i.site, i.selection, fresh, '2026-09-23T08:12:01.000Z');
  assert.equal(checked.payloadJson, c.payloadKey); assert.equal(h.calls.ids, 1); assert.equal(h.calls.reads.length, 1);
  assert.equal(key(c), snapshot); assert.equal(c.mutationId, 'original-mutation');
});

test('ID values reject without coercion; generator failure is safe', async () => {
  for (const id of [undefined, null, 123, '', 'bad id!', 'a'.repeat(129)]) {
    const h = harness(); h.ports.newMutationId = () => { h.calls.ids++; return id; };
    await assert.rejects(build(input(), h.ports), /PREPARATION_MUTATION_ID_INVALID/); assert.equal(h.calls.ids, 1);
  }
  const h = harness(); h.ports.newMutationId = () => { throw Error('SECRET'); };
  await assert.rejects(build(input(), h.ports), { message: 'PREPARATION_MUTATION_ID_INVALID' });
});

test('missing differs from valid-empty and valid-owned snapshots remain exact', async () => {
  const absent = await build(input(), harness().ports);
  assert.equal(absent.ownership.status, 'missing'); assert.equal(absent.ownership.snapshot, null);
  for (const intervals of [[], [owned()]]) {
    const read = ledger(intervals), c = await build(input(), harness(read).ports);
    assert.equal(c.ownership.status, 'available'); assert.equal(key(c.ownership.snapshot), key(read.snapshot));
    assert.notEqual(c.fingerprint, absent.fingerprint); assert.notEqual(c.ownershipKey, absent.ownershipKey);
  }
});

test('corrupt, incompatible, unavailable and malformed reads fail closed before ID allocation', async () => {
  const corrupt = ledger(); corrupt.snapshot.checksum = 'bad';
  const version = ledger(); version.snapshot.version = 1;
  const missingAnchor = ledger(); delete missingAnchor.snapshot.historyDigest;
  const malformedAnchor = ledger(); malformedAnchor.snapshot.historyDigest = "bad";
  const wrongSite = ledger(); wrongSite.snapshot.evidence.energySiteId = '54321';
  const invalid = ledger(); invalid.snapshot.evidence.updatedAt = '2026-02-30T00:00:00Z';
  for (const read of [{ status: 'invalid' }, { status: 'unavailable' }, null, corrupt, version, missingAnchor, malformedAnchor, wrongSite, invalid,
    { status: 'missing', snapshot: ledger().snapshot }]) {
    const h = harness(read); await assert.rejects(build(input(), h.ports), /PREPARATION_OWNERSHIP_(INVALID|UNAVAILABLE)/);
    assert.equal(h.calls.ids, 0);
  }
  const h = harness(); h.ports.readOwnership = async () => { throw Error('SECRET'); };
  await assert.rejects(build(input(), h.ports), { message: 'PREPARATION_OWNERSHIP_UNAVAILABLE' });
});

test('ownership incompatibility with original Tesla capture rejects without rebasing', async () => {
  for (const change of [s => { s.evidence.timeZone = 'UTC'; },
    s => { s.evidence.intervals[0].applied.amount = 0.08; },
    s => { s.evidence.validUntil = '2026-09-23T08:00:00Z'; }]) {
    const read = ledger([owned()]); change(read.snapshot);
    read.snapshot.checksum = hash({ generation: read.snapshot.generation, evidence: read.snapshot.evidence });
    const h = harness(read); await assert.rejects(build(input(), h.ports), /MANAGED_(OWNERSHIP|IMPORT_OWNERSHIP)/);
    assert.equal(h.calls.ids, 0);
  }
});

test('ownership and complete context are detached and deeply frozen', async () => {
  const i = input(), read = ledger([owned()]), c = await build(i, harness(read).ports), before = key(c);
  frozen(c); frozen(c.ownership);
  read.snapshot.evidence.intervals[0].restore.amount = 999;
  read.snapshot.generation = '22222222-2222-2222-2222-222222222222';
  i.capture.before.tariff.name = 'changed'; i.selection.dispatchStart = 'changed';
  assert.equal(key(c), before);
  assert.throws(() => { c.ownership.snapshot.evidence.intervals[0].restore.amount = 999; });
  assert.throws(() => { c.original.proposal.bound.evidence.push({}); });
  assert.throws(() => { c.selectedDispatch.end = 'changed'; });
  assert.equal(key(c), before);
});

test('inputs are detached before the asynchronous ownership read', async () => {
  const i = input(), h = harness(); let release;
  h.ports.readOwnership = () => new Promise(resolve => { release = resolve; });
  const pending = build(i, h.ports); i.capture.before.tariff.name = 'mutated'; i.selection.assetId = 'other';
  release({ status: 'missing' }); const c = await pending;
  assert.equal(c.selectedDispatch.assetId, 'q7-fixture'); assert.notEqual(c.original.before.tariff.name, 'mutated');
});

test('generation, evidence and history anchor change context identity even with same mutation ID', async () => {
  const a = ledger([owned()]), b = structuredClone(a), d = structuredClone(a), h = structuredClone(a);
  h.snapshot.historyDigest = hash("different committed history");
  b.snapshot.generation = '22222222-2222-2222-2222-222222222222';
  d.snapshot.evidence.intervals[0].restoreBaselineFingerprint = 'f'.repeat(64);
  for (const read of [b, d]) read.snapshot.checksum = hash({ generation: read.snapshot.generation, evidence: read.snapshot.evidence });
  const contexts = await Promise.all([a,b,d,h].map(read => build(input(), harness(read).ports)));
  assert.equal(new Set(contexts.map(c => c.fingerprint)).size, 4);
  assert.equal(new Set(contexts.map(c => c.ownershipKey)).size, 4);
  assert.equal(new Set(contexts.map(c => c.payloadKey)).size, 1);
});

test('additional SMART evidence does not broaden selected mutation scope', async () => {
  const i = input(); i.capture.kraken.vehicles[0].plannedDispatches.push({ ...i.capture.kraken.vehicles[0].plannedDispatches[0],
    start: '2026-09-23T12:00:00+00:00', end: '2026-09-23T13:00:00+00:00' });
  const c = await build(i, harness().ports);
  assert.equal(c.selectedDispatch.start, '2026-09-23T08:00:00+00:00');
  assert.equal(c.selectedDispatch.end, '2026-09-23T10:00:00+00:00');
  assert.equal(key(c.selectedDispatch), key(c.original.proposal.input.observedSmart.dispatch));
});

test('invalid clock order and future ownership update fail before ID allocation', async () => {
  const h = harness(); h.ports.now = () => '2026-02-30T00:00:00Z';
  await assert.rejects(build(input(), h.ports), /PREPARATION_TIME_INVALID/);
  const backwards = harness(); let n = 0; backwards.ports.now = () => ++n === 1 ? generatedAt : capturedAt;
  await assert.rejects(build(input(), backwards.ports), /PREPARATION_TIME_INVALID/);
  const read = ledger(); read.snapshot.evidence.updatedAt = generatedAt;
  read.snapshot.checksum = hash({ generation: read.snapshot.generation, evidence: read.snapshot.evidence });
  await assert.rejects(build(input(), harness(read).ports), /PREPARATION_OWNERSHIP_INVALID/);
  assert.equal(h.calls.ids + backwards.calls.ids, 0);
});

// Test-only execution evidence: no journal issuer, executor or persistence connection.
function simulatedReceipt(c) {
  const time = delta => new Date(Date.parse(c.original.binding.generatedAt) + delta * 1000).toISOString();
  const original = { proposal: structuredClone(c.original.proposal), payloadJson: c.payloadKey,
    approval: { fingerprint: c.proposalFingerprint, approvedAt: time(1) },
    prior: { capturedAt: c.ownership.capturedAt, generation: c.ownership.snapshot?.generation ?? null,
      evidence: structuredClone(c.ownership.snapshot?.evidence ?? null) } };
  const execution = { submittedAt: time(2), completedAt: time(4), apiWrite: { status: 'accepted', httpStatus: 200 },
    classification: 'submitted-representation-preserved', readback: { ...structuredClone(c.original.before),
      source: { ...c.original.before.source, observedAt: time(3) }, tariff: structuredClone(c.original.proposal.bound.representation) } };
  return { version: 1, mutationId: c.mutationId, original, execution,
    journal: { originalKey: hash({ mutationId: c.mutationId, original }), classifiedKey: hash({ mutationId: c.mutationId, execution }), completedAt: time(5) } };
}
const { finaliseConfirmedSmartOwnership: finalise } = load('src/lib/tesla-tariff/ownership-finalisation.ts');
function checksum(read) { read.snapshot.checksum = hash({ generation: read.snapshot.generation, evidence: read.snapshot.evidence }); return read; }

test('Stage A may bind matching tomorrow ownership, but finalisation rejects incomplete selected-day domain', async () => {
  const tomorrow = { ...owned(), start: '2026-09-24T08:00:00Z', end: '2026-09-24T10:00:00Z' };
  const read = ledger([owned(), tomorrow]); read.snapshot.evidence.validUntil = '2026-09-25T00:00:00Z'; checksum(read);
  const c = await build(input(), harness(read).ports);
  assert.equal(key(c.ownership.snapshot), key(read.snapshot));
  assert.ok(Date.parse(tomorrow.start) >= Date.parse(c.comparisonDomain.end));
  const result = finalise(simulatedReceipt(c));
  assert.equal(result.status, 'rejected'); assert.equal(result.code, 'OWNERSHIP_DOMAIN_INCOMPLETE');
  assert.equal(result.evidence, undefined); assert.equal(result.writeReady, false);
  assert.equal(key(c.selectedDispatch), key(c.original.proposal.input.observedSmart.dispatch));
});

test('Stage A handoff preserves capture time, generation, original proposal, payload and mutation identity', async () => {
  const read = ledger([owned()]), c = await build(input(), harness(read).ports), r = simulatedReceipt(c);
  assert.equal(r.original.prior.capturedAt, capturedAt);
  assert.equal(r.original.prior.generation, read.snapshot.generation);
  assert.equal(key(r.original.prior.evidence), key(read.snapshot.evidence));
  assert.equal(key(r.original.proposal), key(c.original.proposal)); assert.equal(r.original.payloadJson, c.payloadKey);
  assert.equal(r.mutationId, c.mutationId);
  const result = finalise(r); assert.equal(result.status, 'derived', result.code);
  assert.equal(result.expectedGeneration, read.snapshot.generation); assert.equal(result.mutationId, c.mutationId);
  assert.equal(result.originalProposalFingerprint, c.proposalFingerprint); assert.equal(result.originalPayloadKey, c.payloadKey);
  assert.equal(result.evidence.intervals[0].restore.amount, 0.3);
  assert.equal(result.evidence.intervals[0].restoreBaselineFingerprint, owned().restoreBaselineFingerprint);
});

test('identical inputs are deterministic while economically equal but exact different tariff identities remain distinct', async () => {
  const a = await build(input(), harness().ports), b = await build(input(), harness().ports);
  assert.equal(key(a), key(b));
  const changed = input(); changed.capture.before.tariff.name = 'Different observed tariff identity, same prices';
  const c = await build(changed, harness().ports);
  const { observedEconomicSignal } = load('src/lib/tesla-tariff/observed-economic.ts');
  const { comparePriceSignalsInDomain } = load('src/lib/tariff/comparison-domain.ts');
  const compare = comparePriceSignalsInDomain(observedEconomicSignal(a.original.before, a.comparisonDomain).signal,
    observedEconomicSignal(c.original.before, c.comparisonDomain).signal, a.comparisonDomain);
  assert.equal(compare.status, 'unchanged');
  assert.equal(a.original.proposal.bound.economicKey, c.original.proposal.bound.economicKey);
  assert.notEqual(a.payloadKey, c.payloadKey); assert.notEqual(a.proposalFingerprint, c.proposalFingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('failed initial selection or stale preparation allocates zero IDs', async () => {
  for (const change of [i => { i.selection.assetId = 'absent'; },
    i => { i.capture.kraken.vehicles[0].plannedDispatches[0].type = 'BOOST'; },
    i => { i.capture.kraken.stale = true; }]) {
    const i = input(), h = harness(); change(i);
    await assert.rejects(build(i, h.ports), /CURRENT_SMART_DISPATCH_REQUIRED|FRESH_CAPTURE_AND_EVIDENCE_REQUIRED/);
    assert.equal(h.calls.ids, 0);
  }
});

test('localised missing coverage at an owned boundary fails Stage A before ID allocation', async () => {
  const i = input(), tou = i.capture.before.tariff.seasons.Tomorrow.tou_periods.hour_6_minute_0;
  const p = tou.periods[0];
  tou.periods = [{ ...p, toHour: 10, toMinute: 0 }, { ...p, fromHour: 10, fromMinute: 1 }];
  // A future one-minute gap at the owned 10:00 London boundary.
  const interval = { ...owned(), start: '2026-09-23T09:00:00Z', end: '2026-09-23T10:00:00Z' };
  const h = harness(ledger([interval]));
  await assert.rejects(build(i, h.ports), /STRUCTURALLY_VALID_BOUND_PROPOSAL_REQUIRED|COMMON_DOMAIN_UNAVAILABLE|MANAGED_IMPORT_OWNERSHIP_CONFLICT/);
  assert.equal(h.calls.ids, 0);
});

function dstCase(date, intervals) {
  const i = input(), now = `${date}T08:12:00Z`, captureTime = `${date}T08:11:50Z`;
  // Synthetic test-only tariff validity, not a change to configured real rates.
  i.site.tariff.versions[0].effectiveFrom = '2026-01-01T00:00:00Z';
  i.site.tariff.versions[0].effectiveTo = '2027-01-01T00:00:00Z';
  const { simulateObservedSmartDate } = load('src/lib/tesla-tariff/observed-simulation.ts');
  const isolated = simulateObservedSmartDate(i.capture.before, { date, fromMinute: 0, toMinute: 360,
    buy: 0.02993, currency: 'GBP', compareDates: [], preserveLabels: false });
  assert.equal(isolated.status, 'simulation-only');
  i.capture.before.tariff = isolated.simulated.tariff; i.capture.before.source.observedAt = captureTime;
  i.capture.kraken.lastSuccessfulUpdate = captureTime;
  const dispatch = i.capture.kraken.vehicles[0].plannedDispatches[0];
  dispatch.start = `${date}T09:00:00Z`; dispatch.end = `${date}T11:00:00Z`; i.selection.dispatchStart = dispatch.start;
  const read = ledger(intervals);
  read.snapshot.evidence.createdAt = `${date}T07:00:00Z`; read.snapshot.evidence.updatedAt = `${date}T07:00:00Z`;
  read.snapshot.evidence.validUntil = new Date(Date.parse(now) + 48 * 3600000).toISOString(); checksum(read);
  const h = harness(read); let calls = 0;
  h.ports.now = () => ++calls === 1 ? `${date}T08:11:55Z` : now;
  return { i, read, h };
}

test('Stage A preserves explicit DST fold and spring-gap ownership instants without wall-clock inference', async () => {
  const cheap = { ...owned(), applied: { amount: 0.02993, currency: 'GBP', unit: 'kWh' } };
  const cases = [dstCase('2026-10-24', [
    { ...cheap, start: '2026-10-25T01:00:00+01:00', end: '2026-10-25T01:00:00+00:00' },
    { ...cheap, start: '2026-10-25T01:00:00+00:00', end: '2026-10-25T02:00:00+00:00' },
  ]), dstCase('2026-03-28', [
    { ...cheap, start: '2026-03-29T00:30:00+00:00', end: '2026-03-29T02:30:00+01:00' },
  ])];
  for (const { i, read, h } of cases) {
    const c = await build(i, h.ports);
    assert.equal(key(c.ownership.snapshot), key(read.snapshot));
    for (const interval of c.ownership.snapshot.evidence.intervals)
      assert.equal(Date.parse(interval.end) - Date.parse(interval.start), 3600000);
    assert.equal(h.calls.ids, 1);
  }
});

test('a deliberately reused valid ID is accepted; uniqueness and replay enforcement belong to journal policy', async () => {
  const a = harness(), b = harness(), first = await build(input(), a.ports), second = await build(input(), b.ports);
  assert.equal(a.calls.ids, 1); assert.equal(b.calls.ids, 1);
  assert.equal(first.mutationId, second.mutationId); assert.equal(first.fingerprint, second.fingerprint);
  const changed = input(); changed.capture.before.tariff.name = 'Another exact representation';
  const third = await build(changed, harness().ports);
  assert.equal(third.mutationId, first.mutationId); assert.notEqual(third.fingerprint, first.fingerprint);
  assert.equal(third.writeReady, false);
});

const { preflightOwnershipDomain: preflight } = load('src/lib/tesla-tariff/linked-experiment-records.ts');
const { validPreparedJournalContext } = load('src/lib/tesla-tariff/linked-experiment-records.ts');
test('preflight preserves missing, empty and owned contexts with no reread or ID allocation', async () => {
  for (const read of [{ status: 'missing' }, ledger(), ledger([owned()])]) {
    const h = harness(read), c = await build(input(), h.ports), before = key(c), calls = key(h.calls);
    assert.ok(validPreparedJournalContext(c));
    assert.equal(preflight(c, generatedAt).status, 'complete');
    assert.equal(key(preflight(c, generatedAt)), key(checkOwnershipDomain({ previous: c.ownership.snapshot?.evidence ?? null, domain: c.comparisonDomain, asOf: generatedAt })));
    assert.equal(key(c), before); assert.equal(key(h.calls), calls); frozen(c);
  }
});
test('valid tomorrow context rejects specifically at containment; malformed context/time fail closed', async () => {
  const read = ledger([{ ...owned(), start: '2026-09-24T08:00:00Z', end: '2026-09-24T10:00:00Z' }]);
  read.snapshot.evidence.validUntil = '2026-09-25T00:00:00Z'; checksum(read);
  const c = await build(input(), harness(read).ports);
  assert.ok(validPreparedJournalContext(c));
  assert.equal(preflight(c, generatedAt).code, 'OWNERSHIP_DOMAIN_INCOMPLETE');
  assert.equal(preflight(c, '2026-02-30T00:00:00Z').code, 'INVALID_TRANSITION');
  assert.equal(preflight(c, capturedAt).code, 'INVALID_TRANSITION');
  const broken = structuredClone(c); broken.ownership.snapshot.generation = 'changed';
  assert.equal(preflight(broken, generatedAt).code, 'JOURNAL_INITIAL_INVALID');
});
test('passing preflight does not establish readback sufficiency', async () => {
  const c = await build(input(), harness().ports);
  assert.equal(preflight(c, generatedAt).status, 'complete');
  const receipt = simulatedReceipt(c); receipt.execution.readback.tariff = null;
  receipt.journal.classifiedKey = hash({ mutationId: receipt.mutationId, execution: receipt.execution });
  assert.equal(finalise(receipt).code, 'READBACK_NOT_EXACT');
});
