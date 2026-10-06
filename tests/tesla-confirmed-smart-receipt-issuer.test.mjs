import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
let fault = null, closeGate = null;
const operations = [];
const controlledIO = { ...io, async open(file, mode, ...args) {
  const phase = mode === 'wx' ? 'initial' : mode === 'a' ? 'classified' : 'directory';
  operations.push(phase + '-open');
  if (fault === phase + '-open') throw Error('INJECTED_IO');
  const handle = await io.open(file, mode, ...args);
  return Object.fromEntries(['writeFile', 'sync', 'close'].map(method => [method, async (...values) => {
    const boundary = phase + '-' + method; operations.push(boundary);
    // Close the real fixture descriptor even when simulating close failure.
    if (method === 'close') {
      await handle.close();
      if (phase === 'classified' && closeGate) await closeGate;
    }
    if (fault === boundary) throw Error('INJECTED_IO');
    if (method !== 'close') return handle[method](...values);
  }]));
} };
class NoClock extends Date {
  constructor(...args) { assert.ok(args.length, 'No current-time input'); super(...args); }
  static now() { assert.fail('No clock access'); }
}
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { exports, Error, structuredClone, Date: NoClock, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    const natives = { 'node:crypto': crypto, 'node:fs/promises': controlledIO, 'node:path': path };
    assert.ok(name in natives, `No transport dependency: ${name}`); return natives[name];
  } }); return exports;
}
const records = load('src/lib/tesla-tariff/linked-experiment-records.ts');
const { runSupervisedExperiment } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const { prepareMutationContext } = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const { claimExperimentJournal, journalCompletionForRecords } = load('src/lib/tesla-tariff/supervised-journal.ts');
const { ownershipFingerprint: hash } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const site = load('src/lib/site/current-site.ts').currentSite;
const selection = { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' };
function harness(directory, overrides = {}, ownership = { status: 'missing' }) {
  let clock = Date.parse('2026-09-23T08:12:00Z'), review;
  const calls = { ids: 0, captures: 0, writes: 0, claim: null, result: null, context: null, order: [] };
  const now = () => new Date(clock).toISOString();
  const ports = { now, journalRecords: records,
    async capture() { calls.captures++; calls.order.push('capture'); const c = structuredClone(fixture);
      c.before.source.observedAt = now(); c.kraken.lastSuccessfulUpdate = now(); return c; },
    async prepareContext(capture) { calls.order.push('prepare'); calls.context = await prepareMutationContext({ site, selection, capture },
      { now, readOwnership: async () => ownership, newMutationId: () => { calls.ids++; return 'test-mutation'; } }); return calls.context; },
    challenge: value => hash(value),
    async confirm(r, challenge) { calls.order.push('confirm'); review = r; clock += 1000;
      return { challenge, automaticRollbackUnproven: true, manualAppRecoveryMayBeRequired: true }; },
    async claim(_site, record) { calls.order.push('claim'); calls.claim = record;
      const journal = await claimExperimentJournal(directory, _site, record);
      return { async finish(result) { calls.order.push('finish'); calls.result = result; return journal.finish(result); } }; },
    async write() { calls.order.push('write'); calls.writes++; clock += 1000; return { status: 'accepted', httpStatus: 200 }; },
    async readBack() { calls.order.push('readback'); clock += 1000; return { ...structuredClone(fixture.before),
      source: { ...fixture.before.source, observedAt: now() }, tariff: structuredClone(review.proposal.bound.representation) }; },
    ...overrides };
  return { calls, ports, advance: ms => { clock += ms; }, run: () => runSupervisedExperiment({ site, selection, mode: 'execute-supervised', authority: 'supervised-experiment' }, ports) };
}
async function usingHarness(fn, overrides = {}) {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'hep-b2-'));
  fault = null; closeGate = null; operations.length = 0;
  try { await fn(harness(directory, overrides), directory); }
  finally { fault = null; closeGate = null; await io.rm(directory, { recursive: true, force: true }); }
}


const { issueConfirmedSmartReceipt: issue } = load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
const { finaliseConfirmedSmartOwnership: finalise } = load('src/lib/tesla-tariff/ownership-finalisation.ts');
const { compareObservedTariffReadBack } = load('src/lib/tesla-tariff/restoration-review.ts');
const { classifyExperimentResult, interpretWriteResponse } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const without = (r, ...fields) => Object.fromEntries(Object.entries(r).filter(([k]) => !fields.includes(k)));
let base;
await usingHarness(async h => { const result = await h.run(); base = { initial: h.calls.claim, classified: h.calls.result, capability: result.journalCompletion, calls: h.calls }; });
async function complete(initial, classified) {
  const dir = await io.mkdtemp(path.join(os.tmpdir(), 'hep-issuer-'));
  try { const journal = await claimExperimentJournal(dir, initial.review.proposal.bound.energySiteId, initial);
    return { initial, classified, capability: await journal.finish(classified) }; }
  finally { await io.rm(dir, { recursive: true, force: true }); }
}
function changedOutcome(change) {
  const c = structuredClone(base.classified); change(c);
  const intended = { ...base.initial.review.before, source: { ...base.initial.review.before.source, kind: 'simulation' }, tariff: base.initial.review.proposal.bound.representation };
  c.apiTariffReadBack.comparison = compareObservedTariffReadBack({ intended, readBack: c.apiTariffReadBack.observation,
    after: c.attemptedAt, dates: [base.initial.review.date] });
  c.classification = classifyExperimentResult(c.apiWrite, intended, c.apiTariffReadBack.observation, c.apiTariffReadBack.comparison);
  return records.createLinkedClassifiedRecord(base.initial, without(c, 'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId'));
}
const issued = b => issue(b.capability, b.initial, b.classified);

test('exact B2 completion issues deterministic existing receipt plus exact chain identity without I/O or authority consumption', () => {
  const before = key(operations), calls = key(base.calls), input = key([base.initial, base.classified]);
  const a = issued(base), b = issued(base);
  assert.equal(a.status, 'issued', a.code); assert.equal(key(a), key(b));
  assert.equal(key(operations), before); assert.equal(key(base.calls), calls); assert.equal(key([base.initial, base.classified]), input);
  assert.equal(a.receiptKey, hash(a.receipt));
  assert.equal(a.issuanceKey, hash({ version: 1, completion: a.completion, receiptKey: a.receiptKey }));
  assert.equal(a.receipt.journal.originalKey, hash({ mutationId: a.receipt.mutationId, original: a.receipt.original }));
  assert.equal(a.receipt.journal.classifiedKey, hash({ mutationId: a.receipt.mutationId, execution: a.receipt.execution }));
  assert.notEqual(a.receipt.journal.originalKey, base.initial.initialRecordId);
  assert.equal(a.receipt.journal.completedAt, base.classified.completedAt);
  assert.equal(a.receipt.original.prior.capturedAt, base.initial.preparedContext.ownership.capturedAt);
  assert.equal(a.receipt.original.payloadJson, base.initial.review.payloadJson);
  assert.equal(key(a.receipt.original.approval), key(base.initial.exception.approval));
  assert.equal(a.receipt.mutationId, base.initial.mutationId);
  assert.ok(journalCompletionForRecords(base.capability, base.initial, base.classified));
  assert.equal(a.writeReady, false); assert.equal(a.rollbackProven, false);
});

test('fabricated, copied, serialized and evidence-shaped capabilities cannot issue receipts', () => {
  for (const fake of [{}, { ...base.capability }, structuredClone(base.capability), JSON.parse(JSON.stringify(base.capability)),
    issued(base).completion, issued(base), JSON.parse(JSON.stringify(issued(base)))])
    assert.equal(issue(fake, base.initial, base.classified).code, 'JOURNAL_COMPLETION_NOT_BOUND');
});

test('record substitutions and altered proposal/payload/approval/context/generation/site/timestamps reject', () => {
  for (const mutate of [i => { i.initialRecordId = 'other'; }, i => { i.mutationId = 'other'; },
    i => { i.review.payloadJson += ' '; }, i => { i.review.proposal.bound.energySiteId = '999'; },
    i => { i.exception.approval.approvedAt = '2026-09-23T08:12:00Z'; },
    i => { i.preparedContext.fingerprint = 'bad'; }, i => { i.preparedContext.ownership.snapshot = { generation: 'other' }; }]) {
    const i = structuredClone(base.initial); mutate(i);
    assert.equal(issue(base.capability, i, base.classified).code, 'JOURNAL_COMPLETION_NOT_BOUND');
  }
  for (const mutate of [c => { c.classifiedRecordId = 'other'; }, c => { c.energySiteId = '999'; },
    c => { c.completedAt = '2026-02-30T00:00:00Z'; }]) {
    const c = structuredClone(base.classified); mutate(c);
    assert.equal(issue(base.capability, base.initial, c).code, 'JOURNAL_COMPLETION_NOT_BOUND');
  }
});

for (const [name, change] of [
  ['rejected', c => { c.apiWrite = { status: 'rejected', httpStatus: 403 }; }],
  ['unknown', c => { c.apiWrite = { status: 'unknown', httpStatus: null }; }],
  ['HTTP 200 without recognised acceptance', c => { c.apiWrite = interpretWriteResponse(200, { response: {} }); }],
  ['transformed', c => { c.apiTariffReadBack.observation.tariff.name += ' other'; }],
  ['unexpected export change', c => { for (const charge of Object.values(c.apiTariffReadBack.observation.tariff.sell_tariff.energy_charges))
    for (const label of Object.keys(charge.rates)) charge.rates[label] = 0.18; }],
  ['buy raised to sell', c => { const t = c.apiTariffReadBack.observation.tariff;
    const sell = Object.values(t.sell_tariff.energy_charges)[0].rates; const amount = Object.values(sell)[0];
    for (const charge of Object.values(t.energy_charges)) for (const label of Object.keys(charge.rates))
      if (charge.rates[label] < amount) charge.rates[label] = amount; }],
  ['missing readback', c => { c.apiTariffReadBack.observation = null; }],
  ['unauthenticated readback', c => { c.apiTariffReadBack.observation.source.kind = 'simulation'; }],
]) test('genuine completed diagnostic evidence issues no receipt: ' + name, async () => {
  const c = changedOutcome(change), b = await complete(base.initial, c);
  assert.ok(journalCompletionForRecords(b.capability, b.initial, b.classified));
  assert.equal(issued(b).code, 'MUTATION_NOT_CONFIRMED'); assert.equal(issued(b).receipt, undefined);
});

test('genuine B1/B2 preserved outcome still fails finaliser confirmation timing when completion is too late', async () => {
  const c = changedOutcome(c => { c.completedAt = new Date(Date.parse(c.apiTariffReadBack.observation.source.observedAt) + 120_001).toISOString(); });
  assert.equal(c.classification, 'submitted-representation-preserved');
  const b = await complete(base.initial, c);
  assert.equal(issued(b).code, 'INVALID_CONFIRMATION_TIME');
});

test('different valid linked evidence with same receipt projection gets a different issuance key', async () => {
  const i = structuredClone(base.initial); i.preWriteRecheck.krakenObservedAt = '2026-09-23T08:12:00.000Z';
  i.initialRecordId = hash(without(i, 'initialRecordId'));
  assert.ok(records.validLinkedInitialRecord(i, '12345')); assert.notEqual(i.initialRecordId, base.initial.initialRecordId);
  const c = records.createLinkedClassifiedRecord(i, without(base.classified, 'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId'));
  const other = await complete(i,c), a = issued(base), b = issued(other);
  assert.equal(b.status, 'issued', b.code); assert.equal(a.receiptKey, b.receiptKey); assert.equal(key(a.receipt), key(b.receipt));
  assert.notEqual(a.issuanceKey,b.issuanceKey);
  assert.equal(issue(base.capability, i, c).code, 'JOURNAL_COMPLETION_NOT_BOUND');
  assert.equal(issue(other.capability, base.initial, base.classified).code, 'JOURNAL_COMPLETION_NOT_BOUND');
});

test('valid-empty ownership keeps generation and empty evidence rather than becoming missing', async () => {
  const i = structuredClone(base.initial), captured = i.preparedContext.ownership;
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: '2026-09-23T07:00:00Z',
    updatedAt: '2026-09-23T07:00:00Z', validUntil: '2026-09-24T00:00:00Z', basis: 'confirmed-write-readback',
    baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64), proposalFingerprint: 'c'.repeat(64), smartEvidenceFingerprint: 'd'.repeat(64), intervals: [] };
  const generation = '11111111-1111-1111-1111-111111111111';
  captured.status = 'available'; captured.snapshot = { version: 2, generation, evidence, checksum: hash({ generation, evidence }), historyDigest: hash("captured history") };
  const smart = i.review.proposal.input.observedSmart;
  i.preparedContext.fingerprint = hash({ version: 1, mutationId: i.mutationId, original: i.review, ownership: captured,
    energySiteId: '12345', timeZone: 'Europe/London', selectedDispatch: smart.dispatch, comparisonDomain: smart.comparisonDomain,
    experimentFingerprint: i.review.fingerprint, proposalFingerprint: i.review.proposal.fingerprint, payloadKey: i.review.payloadJson,
    smartEvidenceKey: i.review.binding.smartEvidenceKey, selectedEvidenceKey: i.review.proposal.bound.dispatchEvidenceKey, ownershipKey: hash(captured) });
  i.initialRecordId = hash(without(i, 'initialRecordId')); assert.ok(records.validLinkedInitialRecord(i,'12345'));
  const c = records.createLinkedClassifiedRecord(i, without(base.classified, 'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId'));
  const result = issued(await complete(i,c)); assert.equal(result.status, 'issued', result.code);
  assert.equal(result.receipt.original.prior.generation, generation); assert.deepEqual(result.receipt.original.prior.evidence.intervals, []);
  assert.equal(issued(base).receipt.original.prior.generation, null); assert.equal(issued(base).receipt.original.prior.evidence, null);
});

test('output is deeply frozen and detached, and finalisation owns only future selected import change', () => {
  const i = structuredClone(base.initial), c = structuredClone(base.classified), r = issue(base.capability,i,c);
  assert.equal(r.status,'issued'); const before = key(r);
  const walk = v => { if (v && typeof v === 'object') { assert.ok(Object.isFrozen(v)); Object.values(v).forEach(walk); } }; walk(r);
  assert.throws(() => { r.receipt.original.proposal.bound.energySiteId = '999'; });
  i.review.payloadJson = 'changed'; c.apiWrite.status = 'unknown'; assert.equal(key(r),before);
  const derived = finalise(r.receipt); assert.equal(derived.status,'derived',derived.code); assert.equal(derived.receiptKey,r.receiptKey);
  const dispatch = r.receipt.original.proposal.input.observedSmart.dispatch;
  for (const p of derived.evidence.intervals) {
    assert.ok(Date.parse(p.start) >= Math.max(Date.parse(dispatch.start),Date.parse(r.receipt.execution.submittedAt)));
    assert.ok(Date.parse(p.end) <= Date.parse(dispatch.end)); assert.equal(p.applied.amount,0.0299);
    assert.equal(p.restore.amount,0.25177);
  }
  assert.equal(key(r.receipt.execution.readback.tariff.sell_tariff), key(r.receipt.original.proposal.input.observedSmart.observation.tariff.sell_tariff));
  assert.equal(derived.evidence.export,undefined); assert.equal(derived.rollbackProven,false);
});


test('wider SMART evidence does not expand the selected receipt/finalisation scope', async () => {
  await usingHarness(async h => {
    const capture = h.ports.capture;
    h.ports.capture = async () => {
      const c = await capture(), vehicle = c.kraken.vehicles.find(v => v.id === selection.assetId);
      vehicle.plannedDispatches.push({ ...vehicle.plannedDispatches[0], start: '2026-09-23T12:00:00Z', end: '2026-09-23T13:00:00Z' });
      return c;
    };
    const result = await h.run(), r = issue(result.journalCompletion, h.calls.claim, h.calls.result);
    assert.equal(r.status, 'issued', r.code);
    const derived = finalise(r.receipt); assert.equal(derived.status, 'derived', derived.code);
    assert.ok(derived.evidence.intervals.length > 0);
    for (const p of derived.evidence.intervals) assert.ok(Date.parse(p.end) <= Date.parse('2026-09-23T10:00:00Z'));
    assert.equal(key(r.receipt.original.proposal.input.observedSmart.dispatch), key(h.calls.context.selectedDispatch));
  });
});

test('issuance never derives a transition or suppresses a later coverage rejection', () => {
  const transition = load('src/lib/tesla-tariff/ownership-transition.ts');
  const derive = transition.deriveOwnershipTransition; let calls = 0;
  assert.equal(transition.checkOwnershipDomain({ previous: null,
    domain: base.initial.review.proposal.input.observedSmart.comparisonDomain,
    asOf: base.classified.attemptedAt }).status, 'complete');
  // Controlled downstream coverage failure. The existing finalisation suite also
  // exercises real missing/ambiguous tariff coverage beside a restoration boundary.
  transition.deriveOwnershipTransition = () => { calls++; return { status: 'rejected', code: 'OWNERSHIP_DOMAIN_INCOMPLETE' }; };
  try {
    const r = issued(base); assert.equal(r.status, 'issued', r.code); assert.equal(calls, 0);
    assert.equal(finalise(r.receipt).code, 'OWNERSHIP_DOMAIN_INCOMPLETE'); assert.equal(calls, 1);
  } finally { transition.deriveOwnershipTransition = derive; }
});

test('non-empty retained ownership survives genuine issuance and selected SMART finalisation with exact lineage', async () => {
  const i = structuredClone(base.initial), captured = i.preparedContext.ownership;
  const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
  const at = time => `2026-09-23T${time}:00.000Z`;
  const overlap = { start: at('09:00'), end: at('09:30'), applied: price(0.25177),
    restore: price(0.30), restoreBaselineFingerprint: 'e'.repeat(64) };
  const outside = { start: at('11:00'), end: at('12:00'), applied: price(0.25177),
    restore: price(0.31), restoreBaselineFingerprint: 'f'.repeat(64) };
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: at('07:00'),
    updatedAt: at('07:00'), validUntil: '2026-09-24T00:00:00Z', basis: 'confirmed-write-readback',
    baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64), proposalFingerprint: 'c'.repeat(64),
    smartEvidenceFingerprint: 'd'.repeat(64), intervals: [overlap, outside] };
  const generation = '22222222-2222-2222-2222-222222222222';
  captured.status = 'available'; captured.snapshot = { version: 2, generation, evidence, checksum: hash({ generation, evidence }), historyDigest: hash("captured history") };
  const smart = i.review.proposal.input.observedSmart;
  i.preparedContext.fingerprint = hash({ version: 1, mutationId: i.mutationId, original: i.review, ownership: captured,
    energySiteId: '12345', timeZone: 'Europe/London', selectedDispatch: smart.dispatch, comparisonDomain: smart.comparisonDomain,
    experimentFingerprint: i.review.fingerprint, proposalFingerprint: i.review.proposal.fingerprint, payloadKey: i.review.payloadJson,
    smartEvidenceKey: i.review.binding.smartEvidenceKey, selectedEvidenceKey: i.review.proposal.bound.dispatchEvidenceKey, ownershipKey: hash(captured) });
  i.initialRecordId = hash(without(i, 'initialRecordId'));
  assert.ok(records.validLinkedInitialRecord(i, '12345'));
  const c = records.createLinkedClassifiedRecord(i, without(base.classified,
    'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId'));
  const completed = await complete(i, c);
  assert.ok(journalCompletionForRecords(completed.capability, i, c));
  const r = issued(completed); assert.equal(r.status, 'issued', r.code);
  assert.equal(r.receipt.original.prior.generation, generation);
  assert.equal(r.receipt.original.prior.capturedAt, captured.capturedAt);
  assert.equal(key(r.receipt.original.prior.evidence), key(evidence));
  const result = finalise(r.receipt); assert.equal(result.status, 'derived', result.code);
  assert.equal(result.expectedGeneration, generation);
  const addedLineage = hash(i.review.before.tariff);
  assert.equal(key(result.evidence.intervals), key([
    { start: c.attemptedAt, end: overlap.start, applied: price(0.0299), restore: price(0.25177), restoreBaselineFingerprint: addedLineage },
    { ...overlap, applied: price(0.0299) },
    { start: overlap.end, end: at('10:00'), applied: price(0.0299), restore: price(0.25177), restoreBaselineFingerprint: addedLineage },
    outside,
  ]));
  assert.equal(result.evidence.createdAt, evidence.createdAt);
  assert.equal(result.evidence.baselineFingerprint, addedLineage);
  assert.equal(key(r.receipt.execution.readback.tariff.sell_tariff), key(i.review.before.tariff.sell_tariff));
  assert.equal(result.evidence.export, undefined); assert.equal(result.rollbackProven, false); assert.equal(result.writeReady, false);
  assert.equal(key(captured.snapshot.evidence), key(evidence));
});
