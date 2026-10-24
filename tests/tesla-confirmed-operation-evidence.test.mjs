import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

// Pure module graph: filesystem/network/executor imports fail immediately. The
// filesystem read here loads source only, never a database or journal writer.
const modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, structuredClone, Date, Intl, Error, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    assert.equal(name, 'node:crypto', 'Evidence validation must have no I/O or executor imports');
    return crypto;
  } });
  return exports;
}
const api = load('src/lib/tesla-tariff/confirmed-operation-evidence.ts');
const validate = api.validateConfirmedOperationEvidence;
const { ownershipFingerprint: hash } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const { experimentTariff } = load('src/lib/tesla-tariff/experiment-tariff.ts');
const { validLifecycleOwnershipSnapshot } = load('src/lib/tesla-tariff/retained-original.ts');
const clean = x => structuredClone(x);
const at = seconds => new Date(Date.parse('2026-10-23T12:00:00Z') + seconds * 1000).toISOString();
const gen = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tariff = buy => { const t = clean(experimentTariff()); t.energy_charges.Annual.rates.TEST = buy; return t; };
const observed = (t, time) => ({ source: { kind: 'tesla-site-info', energySiteId: '12345', timeZone: 'Europe/London', observedAt: at(time) },
  tariff: clean(t), diagnostics: [], rollbackProven: false });

function seal(record, approve = true) {
  const initial = record.initial, completion = record.completion, intent = initial.intent;
  if (approve) {
    const approval = { version: 2, operationId: intent.operationId, mutationId: intent.mutationId,
      fingerprint: key(intent), approvedAt: initial.approval.approvedAt };
    initial.approval = { ...approval, approvalId: hash(approval) };
  }
  const { initialRecordId: ignoredInitial, ...initialBody } = initial; void ignoredInitial;
  initial.initialRecordId = hash(initialBody);
  completion.initialRecordId = initial.initialRecordId;
  const { completionRecordId: ignoredCompletion, ...completionBody } = completion; void ignoredCompletion;
  completion.completionRecordId = hash(completionBody);
  record.evidenceId = hash({ version: record.version, initial, completion });
  return record;
}
function operation(kind, sequence, original, beforeSnapshot = null, previous = null) {
  const t = (sequence - 1) * 10, operationId = `operation-${sequence}`, mutationId = `mutation-${sequence}`;
  const before = observed(previous?.completion.readback.observation.tariff ?? original.tariff, t);
  const proposed = kind === 'restore' ? original.tariff : tariff(sequence === 1 ? .08 : .06);
  const payload = { tou_settings: { tariff_content_v2: clean(proposed) } };
  return seal({ version: 2, initial: { journalSchemaVersion: 2, phase: 'approved-operation', intent: {
    kind, operationId, mutationId, energySiteId: '12345', timeZone: 'Europe/London',
    predecessor: previous ? { operationId: previous.initial.intent.operationId, mutationId: previous.initial.intent.mutationId,
      evidenceId: previous.evidenceId, completionRecordId: previous.completion.completionRecordId } : null,
    ownershipBefore: clean(beforeSnapshot), ownershipAfterGeneration: gen(sequence), original: clean(original),
    originalFingerprint: hash(original.tariff), origin: clean(beforeSnapshot?.lifecycle.origin ?? null),
    before: { observationId: `before-${sequence}`, observation: before }, payloadJson: key(payload), payloadFingerprint: hash(payload),
    preparedAt: at(t + 1), validFrom: at(t + 1), expiresAt: at(t + 30),
  }, approval: { approvedAt: at(t + 2) } }, completion: {
    journalSchemaVersion: 2, phase: 'confirmed-operation', operationId, mutationId, energySiteId: '12345', timeZone: 'Europe/London',
    ownershipAfterGeneration: gen(sequence), submittedAt: at(t + 3), completedAt: at(t + 5), journalCompletedAt: at(t + 6),
    apiWrite: { status: 'accepted', httpStatus: 200 },
    readback: { observationId: `readback-${sequence}`, observation: observed(proposed, t + 4) },
    finalTariffFingerprint: hash(proposed), outcome: { apply: 'applied', update: 'updated', restore: 'restored' }[kind],
  } });
}
function retained(root) {
  return { version: 1, energySiteId: '12345', timeZone: 'Europe/London', original: clean(root.initial.intent.original),
    originalFingerprint: root.initial.intent.originalFingerprint,
    origin: { mutationId: root.initial.intent.mutationId, initialRecordId: root.initial.initialRecordId,
      classifiedRecordId: root.completion.completionRecordId, issuanceKey: hash('opaque-origin-issuance-reference'),
      receiptKey: root.evidenceId, journal: 'attempt' },
    restorationObligation: 'required', currentGeneration: root.initial.intent.ownershipAfterGeneration,
    latestReadback: { mutationId: root.initial.intent.mutationId, receiptKey: root.evidenceId, fingerprint: root.completion.finalTariffFingerprint } };
}
// Synthetic snapshots are documentary fixtures only. No production V3 writer or
// finalisation path exists or is added by these tests.
function snapshot(record, original) {
  const lifecycle = { ...clean(original), currentGeneration: record.initial.intent.ownershipAfterGeneration,
    latestReadback: { mutationId: record.initial.intent.mutationId, receiptKey: record.evidenceId, fingerprint: record.completion.finalTariffFingerprint } };
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London',
    createdAt: at(5), updatedAt: record.completion.completedAt, validUntil: '2026-10-24T23:00:00Z', basis: 'confirmed-write-readback',
    baselineFingerprint: original.originalFingerprint, readbackFingerprint: record.completion.finalTariffFingerprint,
    proposalFingerprint: hash(record.initial.intent), smartEvidenceFingerprint: hash('offline-schedule'), intervals: [] };
  const bound = { version: 3, generation: record.initial.intent.ownershipAfterGeneration, evidence, lifecycle };
  const s = { ...bound, checksum: hash(bound), historyDigest: hash(record.evidenceId) };
  assert.equal(validLifecycleOwnershipSnapshot(s, '12345'), true);
  return s;
}
const journal = r => ({ initialRecordId: r.initial.initialRecordId, completionRecordId: r.completion.completionRecordId });
function fixture(kind = 'restore') {
  const original = observed(tariff(.30), 0), apply = operation('apply', 1, original), baseline = retained(apply);
  const first = snapshot(apply, baseline), update = operation('update', 2, original, first, apply);
  const second = snapshot(update, baseline), restore = operation('restore', 3, original, second, update);
  const all = { apply: [apply], update: [apply, update], restore: [apply, update, restore] }[kind];
  const record = all.at(-1), intent = record.initial.intent;
  return { record: clean(record), context: { energySiteId: '12345', timeZone: 'Europe/London',
    ownershipBefore: clean(intent.ownershipBefore), ownershipAfterGeneration: intent.ownershipAfterGeneration,
    retainedOriginal: clean(intent.ownershipBefore?.lifecycle ?? baseline), confirmedHistory: clean(all.slice(0, -1)),
    approvals: all.map(r => clean(r.initial.approval)),
    authenticatedObservations: all.flatMap(r => [['before', r.initial.intent.before], ['readback', r.completion.readback]].map(([phase, o]) => ({
      operationId: r.initial.intent.operationId, mutationId: r.initial.intent.mutationId, phase, ...clean(o),
    }))), durableJournal: all.map(journal),
  } };
}
function reseal(f, approve = true) {
  seal(f.record, approve);
  f.context.durableJournal[f.context.durableJournal.length - 1] = journal(f.record);
  return f;
}
const noAuthority = result => {
  for (const name of ['executionReady', 'writeReady', 'rollbackProven', 'restorationProven',
    'grantsRepeatAuthority', 'grantsSuccessorAuthority', 'resolvesHistoricalJournal']) assert.equal(result[name], false, name);
};
function rejects(f, code) {
  const result = validate(f.record, f.context);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  if (code) assert.equal(result.code, code);
  noAuthority(result); return result;
}

for (const kind of ['apply', 'update', 'restore']) test(`valid offline ${kind} evidence validates without granting any authority`, () => {
  const f = fixture(kind), before = key(f), result = validate(f.record, f.context);
  assert.equal(result.status, 'validated', result.code); noAuthority(result);
  assert.equal(key(f), before); assert.equal(key(result.evidence), key(f.record));
  assert.ok(Object.isFrozen(result.evidence.completion.readback.observation.tariff));
  assert.equal(f.context.retainedOriginal.restorationObligation, 'required');
});

test('missing, altered, copied predecessor approval or unrecognised approval identity fails closed', () => {
  const missing = fixture('update'); missing.record.initial.approval = null; reseal(missing, false); rejects(missing);
  const altered = fixture('update'); altered.record.initial.approval.approvalId = hash('wrong'); reseal(altered, false); rejects(altered, 'APPROVAL_NOT_BOUND');
  const changed = fixture('update'); changed.record.initial.approval.approvedAt = at(12.5); reseal(changed); rejects(changed, 'APPROVAL_NOT_BOUND');
  const copied = fixture('update'); copied.record.initial.approval = clean(copied.context.approvals[0]); reseal(copied, false); rejects(copied, 'APPROVAL_NOT_BOUND');
  const absent = fixture('update'); absent.context.approvals.pop(); rejects(absent, 'APPROVAL_NOT_BOUND');
});

test('approval is bound to exact intent, payload, operation, mutation, kind and generation', () => {
  for (const field of ['operationId', 'mutationId', 'kind', 'ownershipAfterGeneration', 'payloadFingerprint']) {
    const f = fixture('update'); f.record.initial.intent[field] = field === 'kind' ? 'restore' : field === 'ownershipAfterGeneration' ? gen(9) : 'changed';
    reseal(f, false); rejects(f);
  }
  const f = fixture('update'), payload = JSON.parse(f.record.initial.intent.payloadJson);
  payload.tou_settings.tariff_content_v2.energy_charges.Annual.rates.TEST = .09;
  f.record.initial.intent.payloadJson = key(payload); f.record.initial.intent.payloadFingerprint = hash(payload);
  reseal(f, false); rejects(f, 'APPROVAL_NOT_BOUND');
});

test('HTTP acceptance alone, missing or mismatching authenticated readback never confirms', () => {
  const absent = fixture('update'); absent.record.completion.readback = null; reseal(absent); rejects(absent, 'AUTHENTICATED_OBSERVATION_NOT_BOUND');
  const untrusted = fixture('update'); untrusted.context.authenticatedObservations.pop(); rejects(untrusted, 'AUTHENTICATED_OBSERVATION_NOT_BOUND');
  const mismatched = fixture('update'); mismatched.record.completion.readback.observation.tariff = tariff(.09); reseal(mismatched);
  rejects(mismatched, 'AUTHENTICATED_OBSERVATION_NOT_BOUND');
  mismatched.context.authenticatedObservations.at(-1).observation = clean(mismatched.record.completion.readback.observation);
  rejects(mismatched, 'READBACK_NOT_EXACT');
  const simulation = fixture('update'); simulation.record.completion.readback.observation.source.kind = 'simulation'; reseal(simulation); rejects(simulation);
});

test('readback must match complete representation, site, timezone and final fingerprint', () => {
  for (const field of ['energySiteId', 'timeZone']) {
    const f = fixture('update'); f.record.completion.readback.observation.source[field] = field === 'timeZone' ? 'UTC' : '999';
    reseal(f); rejects(f, 'AUTHENTICATED_OBSERVATION_NOT_BOUND');
  }
  const fingerprint = fixture('update'); fingerprint.record.completion.finalTariffFingerprint = hash('wrong'); reseal(fingerprint); rejects(fingerprint, 'READBACK_NOT_EXACT');
  const representation = fixture('update'); representation.record.completion.readback.observation.tariff.name = 'Same economics, changed identity'; reseal(representation);
  representation.context.authenticatedObservations.at(-1).observation = clean(representation.record.completion.readback.observation);
  rejects(representation, 'READBACK_NOT_EXACT');
});

test('rejected, unknown and non-2xx execution evidence cannot confirm', () => {
  for (const apiWrite of [{ status: 'unknown', httpStatus: null }, { status: 'rejected', httpStatus: 400 },
    { status: 'accepted', httpStatus: 500 }, { status: 'accepted', httpStatus: 200.5 }, { status: 'accepted', httpStatus: null }]) {
    const f = fixture('update'); f.record.completion.apiWrite = apiWrite; reseal(f); rejects(f, 'EXECUTION_NOT_ACCEPTED');
  }
});

test('wrong predecessor links and pending or ambiguous history reject', () => {
  for (const field of ['operationId', 'mutationId', 'evidenceId', 'completionRecordId']) {
    const f = fixture('restore'); f.record.initial.intent.predecessor[field] = hash('wrong'); reseal(f); rejects(f, 'PREDECESSOR_CONFLICT');
  }
  const missing = fixture('update'); missing.context.confirmedHistory = []; missing.context.durableJournal.shift(); rejects(missing, 'CONFIRMED_APPLY_ROOT_REQUIRED');
  const pending = fixture('update'); delete pending.context.confirmedHistory[0].completion; rejects(pending, 'UNSUPPORTED_OPERATION_EVIDENCE');
  const ambiguous = fixture('update'); ambiguous.context.confirmedHistory[0].completion.outcome = 'write-outcome-unknown';
  seal(ambiguous.context.confirmedHistory[0]); rejects(ambiguous);
});

test('stale expected generation, generation reuse and a rewritten before generation reject', () => {
  const after = fixture('update'); after.context.ownershipAfterGeneration = gen(9); rejects(after, 'STALE_OWNERSHIP_GENERATION');
  const stale = fixture('restore'); stale.context.ownershipBefore = clean(stale.context.confirmedHistory[1].initial.intent.ownershipBefore);
  stale.context.retainedOriginal = clean(stale.context.ownershipBefore.lifecycle); rejects(stale, 'STALE_OWNERSHIP_GENERATION');
  const duplicate = fixture('update'); duplicate.record.initial.intent.ownershipAfterGeneration = gen(1);
  duplicate.record.completion.ownershipAfterGeneration = gen(1); reseal(duplicate); rejects(duplicate, 'DUPLICATE_OPERATION_IDENTITY');
  const rewritten = fixture('update'), s = rewritten.record.initial.intent.ownershipBefore;
  s.generation = gen(9); s.lifecycle.currentGeneration = gen(9);
  s.checksum = hash({ version: 3, generation: s.generation, evidence: s.evidence, lifecycle: s.lifecycle });
  reseal(rewritten); rejects(rewritten, 'OWNERSHIP_PREDECESSOR_CONFLICT');
});

test('baseline substitution, changed original fingerprint and changed origin journal identities reject', () => {
  for (const field of ['mutationId', 'initialRecordId', 'classifiedRecordId', 'receiptKey', 'issuanceKey', 'journal']) {
    const f = fixture('update'); f.record.initial.intent.origin[field] = field === 'journal' ? 'legacy' : hash('changed');
    reseal(f); rejects(f, 'OWNERSHIP_PREDECESSOR_CONFLICT');
  }
  const changed = fixture('update'); changed.record.initial.intent.original.tariff.name = 'Changed baseline'; reseal(changed); rejects(changed, 'ORIGINAL_BASELINE_CONFLICT');
  const wrong = fixture('update'); wrong.record.initial.intent.originalFingerprint = hash('changed'); reseal(wrong); rejects(wrong, 'ORIGINAL_BASELINE_CONFLICT');
  const root = fixture('apply'); root.context.retainedOriginal.origin.classifiedRecordId = hash('changed'); rejects(root, 'ORIGIN_JOURNAL_CONFLICT');
});

test('missing, duplicate, conflicting and corrupted journal identities reject even with rehashed records', () => {
  const absent = fixture('update'); absent.context.durableJournal.pop(); rejects(absent, 'DURABLE_JOURNAL_HISTORY_CONFLICT');
  const duplicate = fixture('update'); duplicate.context.durableJournal[1] = clean(duplicate.context.durableJournal[0]); rejects(duplicate, 'INVALID_DURABLE_JOURNAL_EVIDENCE');
  const unlinked = fixture('update'); unlinked.context.durableJournal.push({ initialRecordId: hash('extra-initial'), completionRecordId: hash('extra-completion') });
  rejects(unlinked, 'DURABLE_JOURNAL_HISTORY_CONFLICT');
  const conflicting = fixture('update'); conflicting.context.durableJournal.at(-1).completionRecordId = hash('other'); rejects(conflicting, 'DURABLE_JOURNAL_EVIDENCE_MISSING');
  const altered = fixture('update'); altered.record.initial.initialRecordId = hash('changed'); rejects(altered, 'OPERATION_CHECKSUM_MISMATCH');
  const wrong = fixture('update'); wrong.record.completion.initialRecordId = wrong.context.confirmedHistory[0].initial.initialRecordId;
  const { completionRecordId: ignored, ...body } = wrong.record.completion; void ignored;
  wrong.record.completion.completionRecordId = hash(body); wrong.record.evidenceId = hash({ version: 2, initial: wrong.record.initial, completion: wrong.record.completion });
  wrong.context.durableJournal[1] = journal(wrong.record); rejects(wrong, 'OPERATION_COMPLETION_CONFLICT');
});

test('duplicate operations, mutations and replayed history cannot create a new confirmation', () => {
  const duplicate = fixture('update'); duplicate.context.confirmedHistory.push(clean(duplicate.context.confirmedHistory[0]));
  duplicate.context.durableJournal.push({ initialRecordId: hash('extra-initial'), completionRecordId: hash('extra-completion') });
  rejects(duplicate, 'DUPLICATE_OPERATION_IDENTITY');
  for (const field of ['operationId', 'mutationId']) {
    const f = fixture('update'); f.record.initial.intent[field] = f.context.confirmedHistory[0].initial.intent[field];
    reseal(f); rejects(f, 'DUPLICATE_OPERATION_IDENTITY');
  }
});

test('restore requires exact original representation and cannot be followed by another operation', () => {
  const wrong = fixture('restore'), payload = { tou_settings: { tariff_content_v2: tariff(.09) } };
  wrong.record.initial.intent.payloadJson = key(payload); wrong.record.initial.intent.payloadFingerprint = hash(payload);
  reseal(wrong); wrong.context.approvals[2] = clean(wrong.record.initial.approval); rejects(wrong, 'INVALID_OPERATION_PAYLOAD');
  const f = fixture('restore'), prior = clean(f.record), root = f.context.confirmedHistory[0];
  const next = operation('update', 4, prior.initial.intent.original, snapshot(prior, retained(root)), prior);
  f.context.confirmedHistory.push(prior); f.record = next; f.context.ownershipBefore = clean(next.initial.intent.ownershipBefore);
  f.context.retainedOriginal = clean(f.context.ownershipBefore.lifecycle); f.context.ownershipAfterGeneration = gen(4);
  f.context.approvals.push(clean(next.initial.approval)); f.context.durableJournal.push(journal(next));
  rejects(f, 'PREDECESSOR_CONFLICT');
});

test('malformed payload, extras, timestamps and stale/future readbacks fail closed', () => {
  for (const payloadJson of ['not JSON', '{}', 'null', '[]', key({ tou_settings: { tariff_content_v2: {} }, extra: true })]) {
    const f = fixture('update'); f.record.initial.intent.payloadJson = payloadJson;
    reseal(f); f.context.approvals[1] = clean(f.record.initial.approval); rejects(f);
  }
  for (const time of [at(13), at(16), '2026-02-30T12:00:00Z']) {
    const f = fixture('update'); f.record.completion.readback.observation.source.observedAt = time;
    reseal(f); f.context.authenticatedObservations.at(-1).observation = clean(f.record.completion.readback.observation); rejects(f);
  }
  const stale = fixture('update'); stale.record.completion.submittedAt = at(100); stale.record.completion.completedAt = at(102);
  stale.record.completion.journalCompletedAt = at(103); reseal(stale); rejects(stale, 'INVALID_OPERATION_TIME');
});

test('malformed containers, non-JSON values, accessors, unsupported versions and legacy envelopes never throw', () => {
  const f = fixture('update'), cyclic = {}; cyclic.self = cyclic;
  let accessed = false; const accessor = { get version() { accessed = true; throw Error('getter'); } };
  for (const supplied of [null, undefined, [], {}, cyclic, accessor, { version: NaN }, { version: 2, value: 1n },
    { ...clean(f.record), version: 1 }, { ...clean(f.record), version: 3 },
    { version: 1, mutationId: 'legacy', original: {}, execution: {}, journal: {} },
    { journalSchemaVersion: 1, phase: 'classified' }]) {
    assert.doesNotThrow(() => { const r = validate(supplied, f.context); assert.equal(r.status, 'rejected'); noAuthority(r); });
  }
  assert.equal(accessed, false);
  for (const context of [null, undefined, {}, [], { ...clean(f.context), ownershipBefore: { version: 2 } }])
    assert.doesNotThrow(() => rejects({ record: f.record, context }));
});

test('legacy V2 ownership cannot be upgraded or used as successor evidence', () => {
  const f = fixture('update'), s = f.context.ownershipBefore;
  const legacy = { version: 2, generation: s.generation, evidence: s.evidence,
    checksum: hash({ generation: s.generation, evidence: s.evidence }), historyDigest: s.historyDigest };
  f.context.ownershipBefore = legacy; rejects(f, 'INVALID_V3_OWNERSHIP');
  const forged = fixture('update'); forged.record.initial.intent.ownershipBefore = legacy;
  reseal(forged); rejects(forged, 'OWNERSHIP_PREDECESSOR_CONFLICT');
});

test('unsupported linked-record versions, altered outcome and additional authority fields reject', () => {
  for (const location of ['initial', 'completion']) for (const version of [1, 3, null]) {
    const f = fixture('update'); f.record[location].journalSchemaVersion = version;
    reseal(f); rejects(f);
  }
  const outcome = fixture('update'); outcome.record.completion.outcome = 'restored'; reseal(outcome); rejects(outcome, 'OPERATION_COMPLETION_CONFLICT');
  for (const location of ['initial', 'completion']) {
    const f = fixture('update'); f.record[location].executionReady = true; reseal(f); rejects(f);
  }
});

test('ambiguous approval or authenticated acquisition identities and external current-state changes reject', () => {
  const approval = fixture('update'); approval.context.approvals.push(clean(approval.context.approvals[1]));
  rejects(approval, 'INVALID_APPROVAL_EVIDENCE');
  const observation = fixture('update'); observation.context.authenticatedObservations.push(clean(observation.context.authenticatedObservations[0]));
  rejects(observation, 'INVALID_AUTHENTICATED_OBSERVATION');
  const external = fixture('update'); external.record.initial.intent.before.observation.tariff = tariff(.09);
  reseal(external); external.context.approvals[1] = clean(external.record.initial.approval);
  external.context.authenticatedObservations[2].observation = clean(external.record.initial.intent.before.observation);
  rejects(external, 'CURRENT_TARIFF_OWNERSHIP_CONFLICT');
});

test('validation exports no capability, persistence, approval issuer or successor claim; recovery alone is insufficient', () => {
  assert.deepEqual(Object.keys(api), ['validateOperationInitialRecord', 'validateOperationCompletionRecord', 'validateConfirmedOperationEvidence']);
  const f = fixture('update'); f.context.approvals = []; f.context.authenticatedObservations = []; f.context.durableJournal = [];
  rejects(f);
  const good = fixture('update'), result = validate(good.record, good.context);
  assert.equal(result.status, 'validated');
  const exports = {};
  const source = fs.readFileSync('src/lib/tesla-tariff/supervised-journal.ts', 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require(name) {
      if (name === './linked-experiment-records') return load('src/lib/tesla-tariff/linked-experiment-records.ts');
      if (name === 'node:path') return path;
      assert.equal(name, 'node:fs/promises');
      return { mkdir() { assert.fail('No journal writes'); }, open() { assert.fail('No journal writes'); } };
    } });
  for (const value of [result, result.evidence, clean(result), clean(result.evidence)])
    assert.equal(exports.journalCompletionForRecords(value, good.record.initial, good.record.completion), null);
});
