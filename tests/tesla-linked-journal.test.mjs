import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { exports, Error, structuredClone, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    const natives = { 'node:crypto': crypto, 'node:fs/promises': io, 'node:path': path };
    assert.ok(name in natives, `No transport dependency: ${name}`); return natives[name];
  } }); return exports;
}
const records = load('src/lib/tesla-tariff/linked-experiment-records.ts');
const { runSupervisedExperiment } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const { prepareMutationContext } = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const { claimExperimentJournal } = load('src/lib/tesla-tariff/supervised-journal.ts');
const { ownershipFingerprint: hash } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const site = load('src/lib/site/current-site.ts').currentSite;
const selection = { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' };
function harness(overrides = {}, ownership = { status: 'missing' }) {
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
      return { async finish(result) { calls.order.push('finish'); calls.result = result; } }; },
    async write() { calls.order.push('write'); calls.writes++; clock += 1000; return { status: 'accepted', httpStatus: 200 }; },
    async readBack() { calls.order.push('readback'); clock += 1000; return { ...structuredClone(fixture.before),
      source: { ...fixture.before.source, observedAt: now() }, tariff: structuredClone(review.proposal.bound.representation) }; },
    ...overrides };
  return { calls, ports, run: () => runSupervisedExperiment({ site, selection, mode: 'execute-supervised', authority: 'supervised-experiment' }, ports) };
}
const example = harness(); await example.run();
const initial = example.calls.claim, classified = example.calls.result, context = example.calls.context;
const without = (r, ...fields) => Object.fromEntries(Object.entries(r).filter(([field]) => !fields.includes(field)));
const rehashInitial = r => { r.initialRecordId = hash(without(r, 'initialRecordId')); return r; };
const rehashClassified = r => { r.classifiedRecordId = hash(without(r, 'classifiedRecordId')); return r; };
function evidence(r) { return without(r, 'journalSchemaVersion', 'mutationId', 'preparedContext', 'initialRecordId'); }

test('one Stage A ID survives revalidation and linked initial/classified records with unchanged execution order', () => {
  assert.equal(example.calls.ids, 1); assert.equal(example.calls.captures, 2); assert.equal(example.calls.writes, 1);
  assert.deepEqual(example.calls.order, ['capture','prepare','confirm','capture','claim','write','readback','finish']);
  assert.equal(initial.mutationId, context.mutationId); assert.equal(classified.mutationId, initial.mutationId);
  assert.equal(classified.initialRecordId, initial.initialRecordId); assert.equal(initial.journalSchemaVersion, 1);
  assert.equal(classified.journalSchemaVersion, 1);
  assert.equal(key(initial.review), key(context.original)); assert.equal(initial.review.payloadJson, context.payloadKey);
  assert.ok(records.validLinkedInitialRecord(initial, '12345')); assert.ok(records.validLinkedClassifiedRecord(classified, initial));
});

test('initial and classified identity are deterministic and cover the whole record except their own identity', () => {
  const a = records.createLinkedInitialRecord(context, evidence(initial));
  assert.equal(key(a), key(initial));
  assert.equal(rehashInitial(structuredClone(initial)).initialRecordId, initial.initialRecordId);
  assert.equal(rehashClassified(structuredClone(classified)).classifiedRecordId, classified.classifiedRecordId);
  for (const [record, idField, validate] of [[initial, 'initialRecordId', r => records.validLinkedInitialRecord(r, '12345')],
    [classified, 'classifiedRecordId', r => records.validLinkedClassifiedRecord(r, initial)]]) {
    for (const field of Object.keys(record)) {
      if (field === idField) continue;
      const r = structuredClone(record); r[field] = record[field] === null ? 'changed' : null;
      assert.equal(validate(r), false, field);
      assert.notEqual(hash(without(r, idField)), record[idField], field);
    }
  }
});

test('proposal, payload, approval, before/recheck and ownership mutations invalidate initial identity', () => {
  for (const change of [r => { r.review.proposal.bound.economicKey += 'x'; }, r => { r.review.payloadJson += ' '; },
    r => { r.exception.consent.challenge += 'x'; }, r => { r.exception.approvedAt = '2026-09-23T08:12:02Z'; },
    r => { r.preWriteRecheck.krakenObservedAt = '2026-09-23T08:12:02Z'; }, r => { r.preWriteRecheck.tariffKey += 'x'; },
    r => { r.preWriteRecheck.smartEvidenceKey += 'x'; }, r => { r.review.before.tariff.name = 'other'; },
    r => { r.preparedContext.ownership.capturedAt = '2026-09-23T08:12:01Z'; },
    r => { r.preparedContext.fingerprint = 'a'.repeat(64); }, r => { r.preparedContext.ownership.energySiteId = '999'; }]) {
    const r = structuredClone(initial); change(r); assert.equal(records.validLinkedInitialRecord(r, '12345'), false);
  }
});

test('classified API/readback/classification/timestamps changes invalidate identity', () => {
  for (const change of [r => { r.apiWrite.httpStatus = 201; }, r => { r.apiWrite.status = 'unknown'; },
    r => { r.apiTariffReadBack.observation.tariff.name = 'other'; }, r => { r.apiTariffReadBack.comparison.representationMatches = false; },
    r => { r.classification = 'request-rejected'; }, r => { r.completedAt = '2026-09-23T08:12:30Z'; },
    r => { r.attemptedAt = '2026-09-23T08:12:00Z'; }]) {
    const r = structuredClone(classified); change(r); assert.equal(records.validLinkedClassifiedRecord(r, initial), false);
  }
});

test('cross-mutation, cross-site and cross-initial substitutions reject even after outer rehash', () => {
  for (const change of [r => { r.mutationId = 'different'; }, r => { r.energySiteId = '999'; },
    r => { r.initialRecordId = 'a'.repeat(64); }, r => { r.apiTariffReadBack.observation.source.energySiteId = '999'; }]) {
    const r = structuredClone(classified); change(r); rehashClassified(r);
    assert.equal(records.validLinkedClassifiedRecord(r, initial), false);
  }
  assert.equal(records.validLinkedInitialRecord(initial, '999'), false);
  const r = structuredClone(initial); r.preWriteRecheck.teslaSource.energySiteId = '999'; rehashInitial(r);
  assert.equal(records.validLinkedInitialRecord(r, '12345'), false);
});

test('missing/coerced IDs and unsupported schema never become linked records', () => {
  for (const value of [undefined, null, 123, '', 'invalid value', 'trailing\n']) {
    const a = structuredClone(initial); a.mutationId = value; rehashInitial(a);
    const b = structuredClone(classified); b.mutationId = value; rehashClassified(b);
    assert.equal(records.validLinkedInitialRecord(a, '12345'), false);
    assert.equal(records.validLinkedClassifiedRecord(b, initial), false);
  }
  for (const version of [undefined, '1', 0, 2]) {
    const r = structuredClone(initial); r.journalSchemaVersion = version; rehashInitial(r);
    assert.equal(records.validLinkedInitialRecord(r, '12345'), false);
  }
});

test('legacy JSONL is diagnostic only and still occupies the same exclusive site latch', async () => {
  const dir = await io.mkdtemp(path.join(os.tmpdir(), 'hep-linked-'));
  try {
    const legacy = { phase: 'approval-consumed-before-write', review: initial.review, exception: initial.exception, preWriteRecheck: initial.preWriteRecheck };
    assert.equal(records.validLinkedInitialRecord(legacy, '12345'), false);
    await io.writeFile(path.join(dir, 'site-12345.jsonl'), JSON.stringify(legacy) + '\n');
    await assert.rejects(claimExperimentJournal(dir, '12345', initial), { code: 'EEXIST' });
    assert.equal(await io.readFile(path.join(dir, 'site-12345.jsonl'), 'utf8'), JSON.stringify(legacy) + '\n');
  } finally { await io.rm(dir, { recursive: true, force: true }); }
});

test('real journal validates both boundaries, preserves JSONL identities and returns no completion capability', async () => {
  const dir = await io.mkdtemp(path.join(os.tmpdir(), 'hep-linked-'));
  try {
    const invalid = structuredClone(initial); invalid.mutationId = null;
    await assert.rejects(claimExperimentJournal(dir, '12345', invalid), /JOURNAL_INITIAL_INVALID/);
    assert.deepEqual(await io.readdir(dir), []);
    const journal = await claimExperimentJournal(dir, '12345', initial);
    assert.equal(await journal.finish(classified), undefined);
    const lines = (await io.readFile(path.join(dir, 'site-12345.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(key(lines[0]), key(initial)); assert.equal(key(lines[1]), key(classified));
    await assert.rejects(journal.finish(classified), /RESULT_ALREADY_RECORDED/);
    await assert.rejects(claimExperimentJournal(dir, '12345', initial), { code: 'EEXIST' });
  } finally { await io.rm(dir, { recursive: true, force: true }); }
});

test('initial validation/claim failure produces no POST; finish failure never resends or changes classification', async () => {
  const invalid = harness(); const prepare = invalid.ports.prepareContext;
  invalid.ports.prepareContext = async capture => { const c = structuredClone(await prepare(capture)); c.fingerprint = 'bad'; return c; };
  await assert.rejects(invalid.run(), /JOURNAL_INITIAL_INVALID/); assert.equal(invalid.calls.writes, 0);
  const claim = harness({ claim: async () => { throw Error('disk unavailable'); } });
  await assert.rejects(claim.run()); assert.equal(claim.calls.writes, 0);
  let recorded;
  const finish = harness({ claim: async () => ({ finish: async r => { recorded = r; throw Error('disk unavailable'); } }) });
  await assert.rejects(finish.run()); assert.equal(finish.calls.writes, 1);
  assert.equal(recorded.classification, 'submitted-representation-preserved');
});

function tomorrowLedger() {
  const generation = '11111111-1111-1111-1111-111111111111';
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: '2026-09-23T07:00:00Z',
    updatedAt: '2026-09-23T07:00:00Z', validUntil: '2026-09-25T00:00:00Z', basis: 'confirmed-write-readback',
    baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64), proposalFingerprint: 'c'.repeat(64), smartEvidenceFingerprint: 'd'.repeat(64),
    intervals: [{ start: '2026-09-24T08:00:00Z', end: '2026-09-24T10:00:00Z', restoreBaselineFingerprint: 'e'.repeat(64),
      applied: { amount: 0.25177, currency: 'GBP', unit: 'kWh' }, restore: { amount: 0.3, currency: 'GBP', unit: 'kWh' } }] };
  return { status: 'available', snapshot: { version: 1, generation, evidence, checksum: hash({ generation, evidence }) } };
}
async function ownedInitial() {
  const capture = structuredClone(fixture); capture.before.source.observedAt = '2026-09-23T08:12:00.000Z'; capture.kraken.lastSuccessfulUpdate = capture.before.source.observedAt;
  const c = await prepareMutationContext({ site, selection, capture }, { now: () => capture.before.source.observedAt,
    readOwnership: async () => tomorrowLedger(), newMutationId: () => 'test-mutation' });
  return records.createLinkedInitialRecord(c, evidence(initial));
}

test('altered ownership generation/evidence/checksum/context fingerprint cannot be substituted', async () => {
  const a = await ownedInitial();
  for (const mutate of [r => { r.preparedContext.ownership.snapshot.generation = '22222222-2222-2222-2222-222222222222'; },
    r => { r.preparedContext.ownership.snapshot.evidence.intervals[0].restore.amount = 0.4; },
    r => { r.preparedContext.ownership.snapshot.checksum = 'a'.repeat(64); }, r => { r.preparedContext.fingerprint = 'b'.repeat(64); }]) {
    const r = structuredClone(a); mutate(r); rehashInitial(r);
    assert.equal(records.validLinkedInitialRecord(r, '12345'), false);
  }
});

test('outside-domain ownership remains accurately linked but linkage is not finalisation eligibility or a pre-write coverage gate', async () => {
  const a = await ownedInitial(); assert.ok(records.validLinkedInitialRecord(a, '12345'));
  assert.ok(Date.parse(a.preparedContext.ownership.snapshot.evidence.intervals[0].end) > Date.parse(a.review.proposal.bound.comparisonDomain.end));
  assert.equal(a.review.productionWriteReady, false); assert.equal(a.review.rollbackProven, false);
  assert.equal(key(a.review.proposal.input.observedSmart.dispatch), key(context.selectedDispatch));
  for (const field of ['confirmedReceipt','completionCapability','ownershipTransition','finalisationEligible']) assert.equal(a[field], undefined);
  // The existing Stage A cross-layer regression proves finaliser rejection:
  // OWNERSHIP_DOMAIN_INCOMPLETE. B1 intentionally supplies no coverage authority.
});

test('classified validation failure leaves the consumed latch and initial line, with no second finish', async () => {
  const dir = await io.mkdtemp(path.join(os.tmpdir(), 'hep-linked-'));
  try {
    const journal = await claimExperimentJournal(dir, '12345', initial), broken = structuredClone(classified);
    broken.initialRecordId = 'bad';
    await assert.rejects(journal.finish(broken), /JOURNAL_CLASSIFIED_INVALID/);
    await assert.rejects(journal.finish(classified), /RESULT_ALREADY_RECORDED/);
    await assert.rejects(claimExperimentJournal(dir, '12345', initial), { code: 'EEXIST' });
    assert.equal((await io.readFile(path.join(dir, 'site-12345.jsonl'), 'utf8')).trim().split('\n').length, 1);
  } finally { await io.rm(dir, { recursive: true, force: true }); }
});

const { compareObservedTariffReadBack } = load('src/lib/tesla-tariff/restoration-review.ts');
function recomparison(r) {
  r.apiTariffReadBack.comparison = compareObservedTariffReadBack({
    intended: { ...initial.review.before, source: { ...initial.review.before.source, kind: 'simulation' },
      tariff: initial.review.proposal.bound.representation },
    readBack: r.apiTariffReadBack.observation, after: r.attemptedAt, dates: [initial.review.date] });
  return rehashClassified(r);
}
test('accepted API status requires concrete integer HTTP success even with exact readback and recomputed identity', () => {
  for (const status of [undefined, null, '200', NaN, Infinity, 200.5, 199, 300, 503]) {
    const r = structuredClone(classified); r.apiWrite.httpStatus = status; rehashClassified(r);
    assert.equal(records.validLinkedClassifiedRecord(r, initial), false, String(status));
  }
  for (const status of [200, 299]) {
    const r = structuredClone(classified); r.apiWrite.httpStatus = status; rehashClassified(r);
    assert.ok(records.validLinkedClassifiedRecord(r, initial));
  }
});
test('classification is recomputed; matching readback cannot promote rejected or unknown API outcomes', () => {
  for (const [status, httpStatus, expected] of [['rejected', 403, 'request-rejected'], ['unknown', null, 'write-outcome-unknown']]) {
    const r = structuredClone(classified); r.apiWrite = { status, httpStatus }; rehashClassified(r);
    assert.equal(records.validLinkedClassifiedRecord(r, initial), false);
    r.classification = expected; rehashClassified(r);
    assert.ok(records.validLinkedClassifiedRecord(r, initial));
  }
  const wrong = structuredClone(classified); wrong.classification = 'buy-raised-to-sell'; rehashClassified(wrong);
  assert.equal(records.validLinkedClassifiedRecord(wrong, initial), false);
  const missing = structuredClone(classified); missing.apiTariffReadBack.observation = null; recomparison(missing);
  assert.equal(records.validLinkedClassifiedRecord(missing, initial), false);
  missing.classification = 'read-back-unavailable-or-insufficient'; rehashClassified(missing);
  assert.ok(records.validLinkedClassifiedRecord(missing, initial));
});
test('attempt chronology enforces original approval and proposal limits without new TTLs', () => {
  for (const time of [Date.parse(initial.exception.approvedAt) - 1, Date.parse(initial.exception.approvedAt) + 60_001,
    Date.parse(initial.review.proposal.bound.validFrom) - 1, Date.parse(initial.review.proposal.bound.expiresAt)]) {
    const r = structuredClone(classified); r.attemptedAt = new Date(time).toISOString();
    r.completedAt = new Date(time + 1000).toISOString(); r.apiTariffReadBack.observation = null;
    r.classification = 'read-back-unavailable-or-insufficient'; recomparison(r);
    assert.equal(records.validLinkedClassifiedRecord(r, initial), false);
  }
});
test('post-write evidence cannot occur after completion; invalid or equal-attempt times cannot confirm', () => {
  const late = structuredClone(classified); late.completedAt = late.attemptedAt; rehashClassified(late);
  assert.equal(records.validLinkedClassifiedRecord(late, initial), false);
  const impossible = structuredClone(classified); impossible.apiTariffReadBack.observation.source.observedAt = '2026-02-30T08:12:03Z'; recomparison(impossible);
  assert.equal(records.validLinkedClassifiedRecord(impossible, initial), false);
  const equal = structuredClone(classified); equal.apiTariffReadBack.observation.source.observedAt = equal.attemptedAt; recomparison(equal);
  assert.equal(records.validLinkedClassifiedRecord(equal, initial), false);
  equal.classification = 'read-back-unavailable-or-insufficient'; rehashClassified(equal);
  assert.ok(records.validLinkedClassifiedRecord(equal, initial));
});
test('JSON-safe validation prevents NaN/null digest collision and rejects lossy or unsupported values before construction', () => {
  const diagnostic = structuredClone(classified); diagnostic.apiWrite = { status: 'unknown', httpStatus: null };
  diagnostic.classification = 'write-outcome-unknown'; rehashClassified(diagnostic);
  assert.ok(records.validLinkedClassifiedRecord(diagnostic, initial));
  const nan = structuredClone(diagnostic); nan.apiWrite.httpStatus = NaN;
  assert.equal(hash(without(nan, 'classifiedRecordId')), diagnostic.classifiedRecordId);
  assert.equal(records.validLinkedClassifiedRecord(nan, initial), false);
  const unsupported = [undefined, NaN, Infinity, new Date(), new Map(), new Set(), 1n, () => {}, Symbol('x'), [, 'x']];
  for (const value of unsupported) {
    const e = structuredClone(evidence(initial)); e.preWriteRecheck.teslaSource.extra = value;
    assert.throws(() => records.createLinkedInitialRecord(context, e), /JOURNAL_INITIAL_INVALID/);
    const r = structuredClone(classified); r.apiTariffReadBack.observation.diagnostics = [value];
    assert.equal(records.validLinkedClassifiedRecord(r, initial), false);
    assert.throws(() => records.createLinkedClassifiedRecord(initial,
      without(r, 'journalSchemaVersion', 'mutationId', 'energySiteId', 'initialRecordId', 'classifiedRecordId')), /JOURNAL_CLASSIFIED_INVALID/);
  }
});
test('unexpected Tesla provenance keys and simulation substitution reject after rehash', () => {
  const a = structuredClone(initial); a.preWriteRecheck.teslaSource.unexpected = 'not allowed'; rehashInitial(a);
  assert.equal(records.validLinkedInitialRecord(a, '12345'), false);
  const b = structuredClone(classified); b.apiTariffReadBack.observation.source.unexpected = 'not allowed'; rehashClassified(b);
  assert.equal(records.validLinkedClassifiedRecord(b, initial), false);
  const simulated = structuredClone(classified); simulated.apiTariffReadBack.observation.source.kind = 'simulation'; recomparison(simulated);
  assert.equal(records.validLinkedClassifiedRecord(simulated, initial), false);
});
