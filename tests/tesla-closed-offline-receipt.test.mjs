import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as closed from './helpers/closed-offline-v2.mjs';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';
import { hash, key } from './helpers/ownership-lifecycle.mjs';
async function sandbox(scenario, fn) {
  const h = await closed.closedOfflineV2(scenario);
  try { await fn(h); } finally { await h.close(); }
}
function offlineOnly(r) {
  assert.equal(r.mode, 'offline-test-only'); assert.equal(r.authentication, 'fixtures-only');
  for (const flag of ['writeReady','executionReady','grantsAdmissionAuthority','grantsSuccessorAuthority',
    'grantsRepeatAuthority','grantsRestorationAuthority','runtimeConfirmationVerified']) assert.equal(r[flag],false,flag);
}
function checkReceipt(r, evidence, prepared) {
  offlineOnly(r); assert.equal(r.version,1); assert.equal(r.kind,'offline-v2-confirmation-receipt');
  assert.equal(r.provenance,'closed-harness-simulation-not-runtime-authentication');
  assert.match(r.offlineIssuanceId,/^offline-c3-[a-f0-9-]{36}$/);
  assert.equal(key(r.operation),key(evidence)); assert.equal(r.preparedFingerprint,prepared.fingerprint);
  const {receiptKey,issuanceKey,...body}=r;
  assert.equal(receiptKey,hash({purpose:'offline-c3-receipt-v1',...body}));
  assert.equal(issuanceKey,hash({purpose:'offline-c3-issuance-v1',receiptKey,evidenceId:evidence.evidenceId,preparedFingerprint:r.preparedFingerprint}));
  assert.equal(new Set([receiptKey,issuanceKey,evidence.evidenceId,evidence.initial.initialRecordId,evidence.completion.completionRecordId]).size,5);
}
test('private live completion yields one frozen offline receipt with exact E/J/D bindings',()=>sandbox('valid',async h=>{
  const initial=await h.prepare(), before=await h.inspect(); assert.equal(initial.offlineReceipt,undefined);
  const result=await h.rehearse(), r=result.offlineReceipt; checkReceipt(r,result.evidence,initial.prepared);
  const intent=r.operation.initial.intent, completion=r.operation.completion;
  assert.equal(intent.kind,'apply'); assert.equal(intent.ownershipBefore,null); assert.equal(intent.predecessor,null);
  assert.equal(intent.energySiteId,'12345'); assert.equal(intent.timeZone,'Europe/London');
  assert.equal(intent.payloadFingerprint,hash(JSON.parse(intent.payloadJson)));
  assert.equal(key(intent.ownershipAttribution.admission.validity),key(initial.approvedValidity));
  assert.equal(intent.originalFingerprint,initial.baselineFingerprint);
  assert.equal(key(intent.original),key(initial.prepared.capture.observation));
  assert.equal(completion.ownershipAfterGeneration,intent.ownershipAfterGeneration);
  assert.equal(completion.initialRecordId,r.operation.initial.initialRecordId);
  const projection=loadStore().load('src/lib/tesla-tariff/ownership-attribution.ts').projectAttributedIntervals(intent,completion.submittedAt);
  assert.equal(key(projection),key(intent.ownershipAttribution.projectedIntervals), 'Existing pure interval kernel can read the bound V2 intent');
  assert.equal(completion.finalTariffFingerprint,hash(JSON.parse(intent.payloadJson).tou_settings.tariff_content_v2));
  assert.equal(key(completion.readback.observation.tariff),key(JSON.parse(intent.payloadJson).tou_settings.tariff_content_v2));
  assert.equal(result.receiptBoundary.code,'JOURNAL_COMPLETION_NOT_BOUND'); assert.equal(result.ownershipFinalisation,'not-attempted');
  assert.ok(Object.isFrozen(r)); assert.ok(Object.isFrozen(intent.ownershipAttribution));
  assert.equal(result.storage.databaseFingerprint,before.databaseFingerprint); assert.equal(result.storage.ownershipRows,0); assert.equal(result.storage.applicationRows,0);
  assert.deepEqual(result.storage.files.map(f=>f.name).sort(),['site-12345-attempt-mutation-1.complete','site-12345-attempt-mutation-1.jsonl']);
}));
test('no public issuer, token constructor, provider registration or document-to-receipt interface',()=>sandbox('valid',async h=>{
  assert.deepEqual(Object.keys(closed),['closedOfflineV2']);
  for(const name of ['issueReceipt','bindOfflineReceipt','completionFor','registerCompletion','hydrate','createCapability','offlineCompletions']) assert.equal(h[name],undefined);
  const prepared=await h.prepare(); let invoked=false;
  const forged={get issueReceipt(){invoked=true; return ()=>{};},authenticated:true};
  for(const value of [prepared,prepared.prepared,prepared.prepared.initial.approval,forged,{version:2,completionId:'claimed'}])
    await assert.rejects(()=>h.rehearse(value),/C1_INPUT_SUBSTITUTION_REJECTED/);
  assert.equal(invoked,false); assert.equal((await h.inspect()).simulatedWrites,0);
  assert.ok((await h.rehearse()).offlineReceipt);
}));
test('concurrent/replayed issuance produces exactly one offline receipt and no second apply',()=>sandbox('valid',async h=>{
  const attempts=await Promise.allSettled(Array.from({length:5},()=>h.rehearse()));
  const successes=attempts.filter(r=>r.status==='fulfilled'); assert.equal(successes.length,1);
  for(const failed of attempts.filter(r=>r.status==='rejected')) assert.match(failed.reason.message,/C2_REHEARSAL_ALREADY_CONSUMED/);
  offlineOnly(successes[0].value.offlineReceipt);
  const state=key(await h.inspect()); await assert.rejects(h.rehearse,/C2_REHEARSAL_ALREADY_CONSUMED/);
  await assert.rejects(h.prepare,/C1_FIRST_APPLY_HISTORY_NOT_EMPTY/); assert.equal(key(await h.inspect()),state);
}));
test('copied and rehashed receipts cannot obtain production completion or finalisation authority',()=>sandbox('valid',async h=>{
  const result=await h.rehearse(), receipt=result.offlineReceipt, copy=JSON.parse(JSON.stringify(receipt));
  copy.operation.initial.intent.ownershipAfterGeneration='00000000-0000-8000-8000-000000000000';
  const {receiptKey:_r,issuanceKey:_i,...body}=copy; void _r; void _i;
  copy.receiptKey=hash({purpose:'offline-c3-receipt-v1',...body});
  copy.issuanceKey=hash({purpose:'offline-c3-issuance-v1',receiptKey:copy.receiptKey,evidenceId:copy.operation.evidenceId,preparedFingerprint:copy.preparedFingerprint});
  const modules=loadStore(), registry=modules.load('src/lib/tesla-tariff/supervised-journal.ts');
  const issuer=modules.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
  const finaliser=modules.load('src/lib/tesla-tariff/ownership-finalisation.ts');
  const recovered=await h.reopen(); offlineOnly(recovered); assert.equal(recovered.offlineReceipt,undefined);
  assert.equal(recovered.history.status,'available');
  for(const candidate of [receipt,JSON.parse(JSON.stringify(receipt)),copy,result,recovered,recovered.history.history.records[0]]) {
    assert.equal(registry.journalCompletionForRecords(candidate,result.evidence.initial,result.evidence.completion),null);
    const issued=issuer.issueConfirmedSmartReceipt(candidate,result.evidence.initial,result.evidence.completion);
    assert.equal(issued.status,'rejected'); assert.equal(issued.code,'JOURNAL_COMPLETION_NOT_BOUND');
    assert.equal(finaliser.validateConfirmedSmartReceipt(candidate).status,'rejected');
    assert.equal(finaliser.finaliseConfirmedSmartOwnership(candidate).status,'rejected');
    await assert.rejects(()=>h.rehearse(candidate),/C1_INPUT_SUBSTITUTION_REJECTED/);
  }
  assert.equal((await h.inspect()).ownershipRows,0);
}));
test('identical isolated fixture operations have distinct private issuance references',()=>sandbox('valid',async a=>{
  const p=await a.prepare(), first=(await a.rehearse()).offlineReceipt;
  await sandbox('valid',async b=>{
    await assert.rejects(()=>b.rehearse(JSON.parse(JSON.stringify(first))),/C1_INPUT_SUBSTITUTION_REJECTED/);
    const second=(await b.rehearse()).offlineReceipt;
    assert.equal(key(first.operation),key(second.operation)); assert.equal(first.preparedFingerprint,second.preparedFingerprint);
    assert.notEqual(first.offlineIssuanceId,second.offlineIssuanceId); assert.notEqual(first.receiptKey,second.receiptKey); assert.notEqual(first.issuanceKey,second.issuanceKey);
    checkReceipt(second,first.operation,p.prepared);
  });
}));
for(const [scenario,error] of [
  ['receipt-copy',/C3_LIVE_COMPLETION_REQUIRED/],['receipt-forged',/C3_LIVE_COMPLETION_REQUIRED/],
  ['receipt-substitution',/C3_COMPLETION_BINDING_MISMATCH/],['receipt-payload',/C3_COMPLETION_BINDING_MISMATCH/],
  ['receipt-generation',/C3_COMPLETION_BINDING_MISMATCH/],['receipt-approval',/C3_COMPLETION_BINDING_MISMATCH/],
  ['receipt-validity',/C3_COMPLETION_BINDING_MISMATCH/],['receipt-site',/C3_COMPLETION_BINDING_MISMATCH/],
  ['receipt-recovered',/C3_COMPLETION_BINDING_MISMATCH/],['receipt-replay',/C3_LIVE_COMPLETION_REQUIRED/],
]) test(`private offline issuance rejects: ${scenario}`,()=>sandbox(scenario,async h=>{
  const before=await h.inspect(); await assert.rejects(h.rehearse,error);
  const storage=await h.inspect(); assert.equal(storage.simulatedWrites,1);
  assert.equal(storage.databaseFingerprint,before.databaseFingerprint); assert.equal(storage.ownershipRows,0); assert.equal(storage.applicationRows,0);
  // Durable confirmation may exist; it cannot recreate the consumed private token.
  const recovered=await h.reopen(); assert.equal(recovered.history.status,'available'); offlineOnly(recovered);
  assert.equal(recovered.offlineReceipt,undefined);
  await assert.rejects(h.rehearse,/C2_REHEARSAL_ALREADY_CONSUMED/);
}));
test('pending restart never issues an offline receipt from recovered preparation',()=>sandbox('valid',async h=>{
  const prepared=await h.prepare(); assert.equal(prepared.offlineReceipt,undefined);
  const recovered=await h.reopen(); assert.equal(recovered.history.status,'blocked'); assert.equal(recovered.offlineReceipt,undefined);
  await assert.rejects(h.rehearse,/C2_REHEARSAL_ALREADY_CONSUMED/); assert.equal((await h.inspect()).simulatedWrites,0);
}));
