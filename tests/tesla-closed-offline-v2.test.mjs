import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as closedModule from './helpers/closed-offline-v2.mjs';
const { closedOfflineV2 } = closedModule;
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';
import { hash, key } from './helpers/ownership-lifecycle.mjs';

async function sandbox(scenario, fn) {
  const h = await closedOfflineV2(scenario);
  try { await fn(h); } finally { await h.close(); }
}
function noAuthority(r) {
  assert.equal(r.mode, 'offline-test-only'); assert.equal(r.authentication, 'fixtures-only');
  for (const flag of ['writeReady', 'executionReady', 'grantsAdmissionAuthority', 'grantsSuccessorAuthority',
    'grantsRepeatAuthority', 'grantsRestorationAuthority', 'runtimeConfirmationVerified']) assert.equal(r[flag], false, flag);
  for (const name of ['write', 'execute', 'recordCompletion', 'finish', 'admit', 'commit', 'register', 'hydrate', 'providers', 'ports'])
    assert.equal(r[name], undefined, name);
}
test('closed first apply uses explicit policy, exact approval, deterministic generation and immutable baseline', () => sandbox('valid', async h => {
  noAuthority(h);
  const before = await h.inspect(); assert.equal(before.ownershipRows, 0); assert.equal(before.applicationRows, 0); assert.deepEqual(before.files, []);
  const result = await h.prepare(); noAuthority(result); assert.equal(result.status, 'prepared-offline');
  const p = result.prepared, i = p.initial.intent;
  assert.equal(i.kind, 'apply'); assert.equal(i.predecessor, null); assert.equal(i.ownershipBefore, null); assert.equal(i.origin, null);
  assert.equal(i.payloadFingerprint, hash(JSON.parse(i.payloadJson))); assert.equal(p.initial.approval.fingerprint, key(i));
  assert.equal(i.originalFingerprint, result.baselineFingerprint); assert.equal(key(i.original), key(p.capture.observation));
  assert.equal(key(result.approvedValidity), key(i.ownershipAttribution.admission.validity));
  assert.notEqual(result.approvedValidity.start, i.ownershipAttribution.admission.domain.start, 'Policy is independent of comparison domain');
  assert.notEqual(result.approvedValidity.end, i.expiresAt, 'Policy is independent of approval TTL');
  const api = loadStore().load('src/lib/tesla-tariff/prepared-mutation-context.ts');
  assert.equal(i.ownershipAfterGeneration, api.expectedOperationGeneration(i.energySiteId, i.operationId, i.mutationId, { status: 'missing' }));
  assert.equal(api.validPreparedOperationContext(p), true);
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(i.original.tariff));
  const after = await h.inspect(); assert.equal(after.databaseFingerprint, before.databaseFingerprint);
  assert.equal(after.ownershipRows, 0); assert.equal(after.applicationRows, 0);
  assert.deepEqual(after.files.map(f => f.name).sort(), ['site-12345-attempt-mutation-1.jsonl', 'site-12345-attempt.active']);
}));
test('provider selection rejects callbacks, JSON, getters, authentication flags and extra arguments', async () => {
  let invoked = false;
  const forged = { get capture() { invoked = true; return () => {}; }, trusted: true };
  for (const value of [forged, {}, () => {}, { scenario: 'valid', authenticated: true }, 'unknown', null])
    await assert.rejects(() => closedOfflineV2(value), /C1_PROVIDER_SUBSTITUTION_REJECTED/);
  await assert.rejects(() => closedOfflineV2('valid', forged), /C1_PROVIDER_SUBSTITUTION_REJECTED/);
  assert.equal(invoked, false);
  await sandbox('valid', async h => {
    for (const input of [forged, { kind: 'update' }, { kind: 'restore' }, { payloadJson: '{}' }, { providers: forged }])
      await assert.rejects(() => h.prepare(input), /C1_INPUT_SUBSTITUTION_REJECTED/);
    await assert.rejects(() => h.reopen(forged), /C1_INPUT_SUBSTITUTION_REJECTED/);
    assert.deepEqual((await h.inspect()).files, []); assert.equal(invoked, false);
    assert.throws(() => { h.providers = forged; }, TypeError);
  });
});
for (const scenario of ['stale-tesla', 'stale-kraken', 'conflicting-observation', 'missing-observation', 'missing-coverage',
  'missing-validity', 'approval-mismatch', 'payload-mismatch', 'generation-substitution', 'validity-substitution', 'attribution-substitution'])
  test(`fixed negative fixture rejects: ${scenario}`, () => sandbox(scenario, async h => {
    const diagnostics = {
      'stale-tesla': /OPERATION_CAPTURE_INVALID/, 'stale-kraken': /OPERATION_CAPTURE_INVALID/,
      'conflicting-observation': /OPERATION_EVIDENCE_CHANGED_OR_STALE/, 'missing-observation': /C1_OBSERVATION_FIXTURE_MISSING/,
      'missing-coverage': /KRAKEN_ATTRIBUTION_COVERAGE_INVALID/, 'missing-validity': /INVALID_ATTRIBUTION_ADMISSION/,
      'approval-mismatch': /OPERATION_APPROVAL_OR_INITIAL_INVALID/, 'payload-mismatch': /OPERATION_APPROVAL_OR_INITIAL_INVALID/,
      'generation-substitution': /OPERATION_APPROVAL_OR_INITIAL_INVALID/, 'validity-substitution': /OWNERSHIP_ATTRIBUTION_CHANGED/,
      'attribution-substitution': /OWNERSHIP_ATTRIBUTION_CHANGED/,
    };
    const before = await h.inspect(); await assert.rejects(() => h.prepare(), diagnostics[scenario]);
    const after = await h.inspect(); noAuthority(after);
    assert.equal(after.databaseFingerprint, before.databaseFingerprint); assert.equal(after.ownershipRows, 0); assert.equal(after.applicationRows, 0);
    // Reopening never repairs an incomplete fixture or grants runtime authority.
    noAuthority(await h.reopen());
  }));
for (const scenario of ['existing-ownership', 'prior-history', 'pending', 'ambiguous', 'historical-latch'])
  test(`pre-existing state rejects without overwriting evidence: ${scenario}`, () => sandbox(scenario, async h => {
    const before = key(await h.inspect()); await assert.rejects(() => h.prepare(), /C1_FIRST_APPLY_(OWNERSHIP|HISTORY)_NOT_EMPTY/);
    assert.equal(key(await h.inspect()), before);
    const reopened = await h.reopen(); noAuthority(reopened);
    if (scenario === 'prior-history') assert.equal(reopened.history.status, 'available', 'A valid prior journal also blocks first apply');
  }));
for (const [scenario, error] of [['export-mismatch', /C1_FIXED_EXPORT_BLOCKED/], ['buy-below-sell', /BUY_BELOW_SELL/]])
  test(`existing pricing safety gate remains blocking: ${scenario}`, () => sandbox(scenario, async h => {
    await assert.rejects(() => h.prepare(), error); assert.deepEqual((await h.inspect()).files, []);
  }));
test('concurrent requests create one pending documentary claim, never two admissions', () => sandbox('valid', async h => {
  const results = await Promise.allSettled([h.prepare(), h.prepare()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  noAuthority(results.find(r => r.status === 'fulfilled').value);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const read = await h.reopen(); noAuthority(read); assert.equal(read.history.status, 'blocked');
  assert.equal(read.history.code, 'ATTEMPT_IN_PROGRESS');
  await assert.rejects(() => h.prepare(), /C1_FIRST_APPLY_HISTORY_NOT_EMPTY/);
}));
test('restart, copied approval and fully rehashed documentary context never obtain runtime authority', () => sandbox('valid', async h => {
  const r = await h.prepare(), before = key(await h.inspect()), restarted = await h.reopen();
  assert.equal(restarted.history.status, 'blocked'); assert.equal(restarted.history.code, 'ATTEMPT_IN_PROGRESS');
  assert.equal(key(await h.inspect()), before); noAuthority(restarted);
  const store = loadStore(), prepare = store.load('src/lib/tesla-tariff/prepared-mutation-context.ts');
  const registry = store.load('src/lib/tesla-tariff/supervised-journal.ts');
  const issuer = store.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
  const copy = JSON.parse(JSON.stringify(r.prepared));
  copy.initial.approval.approvedAt = '2026-10-24T12:00:02.001Z';
  const { approvalId: _a, ...approvalBody } = copy.initial.approval; void _a;
  copy.initial.approval.approvalId = hash(approvalBody);
  const { initialRecordId: _i, ...initialBody } = copy.initial; void _i;
  copy.initial.initialRecordId = hash(initialBody);
  const { fingerprint: _p, ...preparedBody } = copy; void _p;
  copy.fingerprint = hash(preparedBody);
  assert.equal(prepare.validPreparedOperationContext(copy), true, 'Rehashed documentary fixture is internally consistent');
  for (const candidate of [r, r.prepared, JSON.parse(JSON.stringify(r)), copy, copy.initial.approval, JSON.parse(JSON.stringify(r.prepared.capture)), { authenticated: true }]) {
    assert.equal(registry.journalCompletionForRecords(candidate, copy.initial, {}), null);
    assert.equal(issuer.issueConfirmedSmartReceipt(candidate, copy.initial, {}).status, 'rejected');
    await assert.rejects(() => h.prepare(candidate), /C1_INPUT_SUBSTITUTION_REJECTED/);
    await assert.rejects(() => h.reopen(candidate), /C1_INPUT_SUBSTITUTION_REJECTED/);
  }
  assert.equal(key(await h.inspect()), before); assert.equal((await h.inspect()).ownershipRows, 0);
}));
test('test harness has no production adapter or application import wiring', () => {
  const source = fs.readFileSync('tests/helpers/closed-offline-v2.mjs', 'utf8');
  assert.match(source, /TEST ONLY \/ OFFLINE/);
  assert.doesNotMatch(source, /supervised-local|kraken\/client|tesla-tokens|process\.env|fetch\(/);
  assert.deepEqual(Object.keys(closedModule).sort(), ['closedOfflineV2']);
});
