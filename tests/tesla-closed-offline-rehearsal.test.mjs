import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedOfflineV2 } from './helpers/closed-offline-v2.mjs';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';
import { hash, key } from './helpers/ownership-lifecycle.mjs';
async function sandbox(scenario, fn) {
  const h = await closedOfflineV2(scenario);
  try { await fn(h); } finally { await h.close(); }
}
function documentary(r) {
  assert.equal(r.mode, 'offline-test-only'); assert.equal(r.authentication, 'fixtures-only');
  for (const name of ['executionReady','writeReady','grantsAdmissionAuthority','grantsSuccessorAuthority',
    'grantsRepeatAuthority','grantsRestorationAuthority','runtimeConfirmationVerified']) assert.equal(r[name], false, name);
}
function noHandles(v) {
  if (v && typeof v === 'object') for (const child of Object.values(v)) {
    assert.notEqual(typeof child, 'function'); noHandles(child);
  }
}
test('closed rehearsal durably confirms one simulated first apply, then stops at the real receipt boundary', () => sandbox('valid', async h => {
  const before = await h.inspect(), result = await h.rehearse(); documentary(result); noHandles(result);
  assert.equal(result.status, 'rehearsed-offline'); assert.equal(result.furthestCompletedStep, 5);
  assert.equal(result.evidenceProvenance, 'simulated-offline-tesla-state-not-authenticated');
  assert.deepEqual(result.receiptBoundary, { status: 'blocked', code: 'JOURNAL_COMPLETION_NOT_BOUND', required: 'trusted-V2-runtime-completion-capability' });
  assert.equal(result.ownershipFinalisation, 'not-attempted');
  const e = result.evidence, i = e.initial.intent, c = e.completion;
  assert.equal(i.kind, 'apply'); assert.equal(i.ownershipBefore, null); assert.equal(i.predecessor, null);
  assert.equal(i.originalFingerprint, hash(i.original.tariff));
  assert.equal(i.payloadFingerprint, hash(JSON.parse(i.payloadJson)));
  assert.equal(c.initialRecordId, e.initial.initialRecordId); assert.equal(c.ownershipAfterGeneration, i.ownershipAfterGeneration);
  assert.equal(c.apiWrite.status, 'accepted'); assert.equal(c.apiWrite.httpStatus, 200);
  assert.match(c.readback.observationId, /^simulated-c2-/);
  assert.equal(key(c.readback.observation.tariff), key(JSON.parse(i.payloadJson).tou_settings.tariff_content_v2));
  assert.ok(Date.parse(c.readback.observation.source.observedAt) > Date.parse(c.submittedAt));
  assert.equal(result.storage.simulatedWrites, 1); assert.equal(result.storage.simulatedTariffFingerprint, c.finalTariffFingerprint);
  assert.equal(result.storage.ownershipRows, 0); assert.equal(result.storage.applicationRows, 0);
  assert.equal(result.storage.databaseFingerprint, before.databaseFingerprint);
  assert.deepEqual(result.storage.files.map(f => f.name).sort(), ['site-12345-attempt-mutation-1.complete', 'site-12345-attempt-mutation-1.jsonl']);
  const recovered = await h.reopen(); documentary(recovered); assert.equal(recovered.history.status, 'available');
  assert.equal(key(recovered.history.history.records), key([e]));
  const checked = loadStore().load('src/lib/tesla-tariff/confirmed-operation-evidence.ts')
    .validateConfirmedOperationEvidence(e, recovered.history.history.contexts[0]);
  assert.equal(checked.status, 'validated'); assert.equal(checked.writeReady, false);
}));
test('preparation durably precedes simulation and private admission binds the exact C1 intent', () => sandbox('valid', async h => {
  const p = await h.prepare(), initial = await h.inspect(); documentary(p);
  assert.equal(initial.simulatedWrites, 0); assert.deepEqual(initial.files.map(f=>f.name).sort(), ['site-12345-attempt-mutation-1.jsonl','site-12345-attempt.active']);
  const r = await h.rehearse(); assert.equal(key(r.evidence.initial), key(p.prepared.initial));
  assert.equal(key(r.evidence.initial.intent.ownershipAttribution.admission.validity), key(p.approvedValidity));
  assert.equal(r.evidence.initial.intent.originalFingerprint, p.baselineFingerprint);
  assert.equal(r.storage.databaseFingerprint, initial.databaseFingerprint);
}));
test('replay, second apply, update and restore are rejected after confirmed rehearsal', () => sandbox('valid', async h => {
  await h.rehearse(); const before = key(await h.inspect());
  await assert.rejects(() => h.rehearse(), /C2_REHEARSAL_ALREADY_CONSUMED/);
  await assert.rejects(() => h.prepare(), /C1_FIRST_APPLY_HISTORY_NOT_EMPTY/);
  for (const kind of ['apply','update','restore']) await assert.rejects(() => h.rehearse({kind}), /C1_INPUT_SUBSTITUTION_REJECTED/);
  assert.equal(key(await h.inspect()), before);
}));
test('concurrent rehearsal consumes one private identity and simulates exactly once', () => sandbox('valid', async h => {
  const r = await Promise.allSettled(Array.from({length:4},()=>h.rehearse()));
  assert.equal(r.filter(r=>r.status==='fulfilled').length, 1);
  assert.equal(r.filter(r=>r.status==='rejected').length, 3);
  for (const rejected of r.filter(r=>r.status==='rejected')) assert.match(rejected.reason.message,/C2_REHEARSAL_ALREADY_CONSUMED/);
  assert.equal((await h.inspect()).simulatedWrites,1);
}));
test('copied/rehashed admission, approval, fixtures and forged callbacks cannot drive simulation', () => sandbox('valid', async h => {
  const p = await h.prepare(), copy = JSON.parse(JSON.stringify(p.prepared));
  copy.initial.approval.approvedAt = '2026-10-24T12:00:02.010Z';
  for (const [v, field] of [[copy.initial.approval,'approvalId'],[copy.initial,'initialRecordId'],[copy,'fingerprint']]) {
    const body = {...v}; delete body[field]; v[field] = hash(body);
  }
  assert.equal(loadStore().load('src/lib/tesla-tariff/prepared-mutation-context.ts').validPreparedOperationContext(copy),true);
  let invoked=false; const forged={get readCompletionEvidence(){invoked=true;return ()=>{};},authenticated:true};
  const before=key(await h.inspect());
  for (const doc of [copy, copy.initial.approval, copy.capture, {apiWrite:{status:'accepted',httpStatus:200}}, forged])
    await assert.rejects(()=>h.rehearse(doc),/C1_INPUT_SUBSTITUTION_REJECTED/);
  assert.equal(invoked,false); assert.equal(key(await h.inspect()),before);
  assert.equal((await h.rehearse()).storage.simulatedWrites,1);
}));
for (const [scenario, error, writes] of [
  ['interrupted-before-write', /C2_INTERRUPTED_BEFORE_WRITE/, 0],
  ['interrupted-after-write', /C2_INTERRUPTED_AFTER_WRITE/, 1],
  ['ambiguous-write', /C2_SIMULATED_WRITE_AMBIGUOUS/, 1],
  ['mismatched-readback', /READBACK_NOT_EXACT/, 1],
  ['forged-completion', /C2_COMPLETION_NOT_FROM_SIMULATION/, 0],
  ['stale-before-execution', /OPERATION_EVIDENCE_CHANGED_OR_STALE/, 0],
]) test(`failed rehearsal remains pending, consumed and non-retryable: ${scenario}`, () => sandbox(scenario, async h => {
  const before=await h.inspect(); await assert.rejects(()=>h.rehearse(),error);
  const after=await h.inspect(); assert.equal(after.simulatedWrites,writes);
  assert.equal(after.ownershipRows,0); assert.equal(after.applicationRows,0); assert.equal(after.databaseFingerprint,before.databaseFingerprint);
  assert.deepEqual(after.files.map(f=>f.name).sort(),['site-12345-attempt-mutation-1.jsonl','site-12345-attempt.active']);
  await assert.rejects(()=>h.rehearse(),/C2_REHEARSAL_ALREADY_CONSUMED/);
  const recovered=await h.reopen(); documentary(recovered); assert.equal(recovered.history.status,'blocked'); assert.equal(recovered.history.code,'ATTEMPT_IN_PROGRESS');
  await assert.rejects(()=>h.rehearse(),/C2_REHEARSAL_ALREADY_CONSUMED/);
  await assert.rejects(()=>h.prepare(),/C1_FIRST_APPLY_HISTORY_NOT_EMPTY/);
  assert.equal((await h.inspect()).simulatedWrites,writes);
}));
test('restart before execution discards live simulation admission without hydrating pending evidence', () => sandbox('valid', async h => {
  await h.prepare(); const r=await h.reopen(); documentary(r); assert.equal(r.history.status,'blocked');
  await assert.rejects(()=>h.rehearse(),/C2_REHEARSAL_ALREADY_CONSUMED/);
  assert.equal((await h.inspect()).simulatedWrites,0);
}));
test('recovered confirmed documents cannot acquire production completion, receipt or finalisation authority', () => sandbox('valid', async h => {
  const r=await h.rehearse(), recovered=await h.reopen(), store=loadStore();
  const registry=store.load('src/lib/tesla-tariff/supervised-journal.ts');
  const issuer=store.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
  const validation=store.load('src/lib/tesla-tariff/ownership-finalisation.ts').validateConfirmedSmartReceipt;
  for(const doc of [r, r.evidence, recovered, recovered.history.history.records[0], JSON.parse(JSON.stringify(r.evidence))]) {
    assert.equal(registry.journalCompletionForRecords(doc,r.evidence.initial,r.evidence.completion),null);
    assert.equal(issuer.issueConfirmedSmartReceipt(doc,r.evidence.initial,r.evidence.completion).status,'rejected');
    assert.equal(validation(doc).status,'rejected');
    await assert.rejects(()=>h.rehearse(doc),/C1_INPUT_SUBSTITUTION_REJECTED/);
  }
  assert.equal((await h.inspect()).ownershipRows,0); assert.equal((await h.inspect()).simulatedWrites,1);
}));
for (const [scenario,error] of [['stale-tesla',/OPERATION_CAPTURE_INVALID/],['stale-kraken',/OPERATION_CAPTURE_INVALID/],
  ['export-mismatch',/C1_FIXED_EXPORT_BLOCKED/],['buy-below-sell',/BUY_BELOW_SELL/]])
  test(`rehearsal preserves C1 preflight gate: ${scenario}`,()=>sandbox(scenario,async h=>{
    await assert.rejects(()=>h.rehearse(),error); assert.equal((await h.inspect()).simulatedWrites,0);
    await assert.rejects(()=>h.rehearse(),/C2_REHEARSAL_ALREADY_CONSUMED/);
  }));
