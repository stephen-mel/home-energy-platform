import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as harness from './helpers/closed-offline-v2.mjs';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';
import { hash, key } from './helpers/ownership-lifecycle.mjs';
async function sandbox(scenario, fn) {
  const h=await harness.closedOfflineV2(scenario);
  try { await fn(h); } finally { await h.close(); }
}
function offlineOnly(value) {
  assert.equal(value.mode,'offline-test-only'); assert.equal(value.authentication,'fixtures-only');
  for(const flag of ['writeReady','executionReady','grantsAdmissionAuthority','grantsSuccessorAuthority','grantsRepeatAuthority','grantsRestorationAuthority','runtimeConfirmationVerified']) assert.equal(value[flag],false,flag);
}
test('exact issued receipt derives a frozen V2 projection using existing pure interval and lineage rules',()=>sandbox('valid',async h=>{
  const prepared=await h.prepare(), receipt=(await h.rehearse()).offlineReceipt, before=await h.inspect();
  const result=await h.projectOwnership(), p=result.projection, e=receipt.operation, i=e.initial.intent, c=e.completion;
  offlineOnly(result); offlineOnly(p); assert.equal(result.status,'ownership-projected-offline');
  assert.equal(p.version,2); assert.equal(p.kind,'offline-v2-ownership-projection');
  assert.equal(p.provenance,'private-offline-receipt-not-committed-ownership');
  assert.equal(result.offlineReceipt,receipt,'The exact issued object is consumed, not a reconstruction');
  assert.deepEqual(p.generation,{expectedBefore:null,expectedAfter:i.ownershipAfterGeneration});
  assert.equal(p.payloadFingerprint,i.payloadFingerprint); assert.equal(p.approvalId,e.initial.approval.approvalId);
  assert.equal(p.attributionId,i.ownershipAttribution.attributionId); assert.equal(p.preparedFingerprint,prepared.prepared.fingerprint);
  assert.equal(p.operationId,i.operationId); assert.equal(p.mutationId,i.mutationId); assert.equal(p.energySiteId,i.energySiteId); assert.equal(p.timeZone,i.timeZone);
  assert.deepEqual(p.offlineReceipt,{receiptKey:receipt.receiptKey,issuanceKey:receipt.issuanceKey,offlineIssuanceId:receipt.offlineIssuanceId});
  assert.deepEqual(p.journal,{version:2,initialRecordId:e.initial.initialRecordId,completionRecordId:c.completionRecordId,evidenceId:e.evidenceId});
  const modules=loadStore(), retained=modules.load('src/lib/tesla-tariff/retained-original.ts');
  const ledger=modules.load('src/lib/tesla-tariff/ownership-evidence.ts');
  const intervals=modules.load('src/lib/tesla-tariff/ownership-attribution.ts').projectAttributedIntervals(i,c.submittedAt);
  assert.equal(key(p.ownershipEvidence.intervals),key(intervals)); assert.equal(ledger.validOwnership(p.ownershipEvidence),true);
  assert.equal(retained.validRetainedOriginal(p.retainedOriginal),true); assert.equal(p.retainedOriginKey,retained.retainedOriginKey(p.retainedOriginal));
  assert.equal(p.state,'active'); assert.equal(p.restorationObligation,'required'); assert.equal(p.retainedOriginal.restorationObligation,'required');
  assert.equal(p.retainedOriginal.origin.receiptKey,e.evidenceId,'Documentary origin is not rewritten as offline receipt identity');
  assert.notEqual(p.retainedOriginal.origin.receiptKey,receipt.receiptKey);
  assert.equal(key(p.retainedOriginal.original),key(i.original)); assert.equal(p.retainedOriginal.originalFingerprint,prepared.baselineFingerprint);
  assert.equal(key(p.comparisonBaseline),key(i.before)); assert.equal(p.comparisonBaselineFingerprint,hash(i.before.observation));
  assert.notEqual(p.retainedOriginal.original,p.comparisonBaseline.observation,'Separate values even when first-apply content is equal');
  assert.equal(key(p.retainedOriginal.original),key(p.comparisonBaseline.observation));
  assert.equal(key(p.approvedValidity),key(prepared.approvedValidity)); assert.equal(p.ownershipEvidence.validUntil,p.approvedValidity.end);
  assert.equal(p.ownershipEvidence.createdAt,c.completedAt); assert.equal(p.ownershipEvidence.updatedAt,c.completedAt);
  assert.notEqual(p.approvedValidity.start,p.ownershipEvidence.createdAt,'Ledger creation is not substituted for approved validity start');
  const {projectionKey,...body}=p; assert.equal(projectionKey,hash({purpose:'offline-c4-ownership-projection-v2',...body}));
  assert.equal(p.historyDigest,undefined); assert.equal(p.runtimeIdentity,undefined); assert.equal(p.checksum,undefined);
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.retainedOriginal.original.tariff)); assert.ok(Object.isFrozen(p.comparisonBaseline.observation));
  assert.throws(()=>{p.approvedValidity.end='2099-01-01T00:00:00Z';},TypeError);
  assert.equal(result.storage.databaseFingerprint,before.databaseFingerprint); assert.equal(result.storage.ownershipRows,0); assert.equal(result.storage.applicationRows,0); assert.equal(result.storage.simulatedWrites,1);
  const recovered=await h.reopen(); assert.equal(recovered.projection,undefined); offlineOnly(recovered);
  assert.equal(key(p.retainedOriginal),key(recovered.history.history.contexts[0].retainedOriginal));
}));
test('approved validity beyond comparison domain is preserved without expanding owned intervals',()=>sandbox('projection-validity-beyond-domain',async h=>{
  const p=(await h.projectOwnership()).projection;
  assert.equal(p.comparisonDomain.end,'2026-10-24T16:00:00Z'); assert.equal(p.approvedValidity.end,'2026-10-24T17:00:00Z');
  assert.equal(p.ownershipEvidence.validUntil,'2026-10-24T17:00:00Z'); assert.equal(p.approvedValidity.start,'2026-10-24T12:00:00Z');
  assert.equal(p.ownershipEvidence.intervals.at(-1).end,'2026-10-24T15:00:00.000Z');
  assert.ok(p.ownershipEvidence.intervals.every(w=>w.restoreBaselineFingerprint===p.retainedOriginal.originalFingerprint));
  offlineOnly(p);
}));
test('caller receipts, projections and callback objects cannot enter a public finaliser',()=>sandbox('valid',async h=>{
  assert.deepEqual(Object.keys(harness),['closedOfflineV2']);
  const receipt=(await h.rehearse()).offlineReceipt; let invoked=false;
  const bad={get finalise(){invoked=true;return ()=>{};},authenticated:true};
  for(const value of [receipt,JSON.parse(JSON.stringify(receipt)),bad,{kind:'restore'},{receiptKey:receipt.receiptKey}])
    await assert.rejects(()=>h.projectOwnership(value),/C1_INPUT_SUBSTITUTION_REJECTED/);
  assert.equal(invoked,false);
  for(const name of ['projectIssuedReceipt','registerProjection','hydrate','finaliseConfirmedSmartOwnership','commit']) assert.equal(h[name],undefined);
  assert.equal((await h.projectOwnership()).offlineReceipt,receipt);
}));
test('concurrent projection and replay consume one receipt and produce one non-authoritative result',()=>sandbox('valid',async h=>{
  const attempts=await Promise.allSettled(Array.from({length:4},()=>h.projectOwnership()));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  for(const r of attempts.filter(r=>r.status==='rejected')) assert.match(r.reason.message,/C4_PROJECTION_ALREADY_CONSUMED/);
  const state=key(await h.inspect()); await assert.rejects(h.projectOwnership,/C4_PROJECTION_ALREADY_CONSUMED/);
  await assert.rejects(h.prepare,/C1_FIRST_APPLY_HISTORY_NOT_EMPTY/); assert.equal(key(await h.inspect()),state);
}));
for(const scenario of ['projection-copy','projection-payload','projection-generation','projection-validity','projection-original','projection-terminal','projection-conflict','projection-replay'])
  test(`private receipt consumption rejects substituted/replayed input: ${scenario}`,()=>sandbox(scenario,async h=>{
    const before=await h.inspect(); await assert.rejects(h.projectOwnership,/C4_ISSUED_RECEIPT_REQUIRED/);
    const after=await h.inspect(); assert.equal(after.databaseFingerprint,before.databaseFingerprint); assert.equal(after.ownershipRows,0); assert.equal(after.applicationRows,0);
    await assert.rejects(h.projectOwnership,/C4_PROJECTION_ALREADY_CONSUMED/);
    const recovered=await h.reopen(); assert.equal(recovered.history.status,'available'); assert.equal(recovered.projection,undefined); offlineOnly(recovered);
  }));
for(const [scenario,error] of [['missing-coverage',/KRAKEN_ATTRIBUTION_COVERAGE_INVALID/],['missing-validity',/INVALID_ATTRIBUTION_ADMISSION/],
  ['ambiguous-write',/C2_SIMULATED_WRITE_AMBIGUOUS/],['existing-ownership',/C1_FIRST_APPLY_OWNERSHIP_NOT_EMPTY/]])
  test(`projection cannot bypass earlier confirmation/ownership gate: ${scenario}`,()=>sandbox(scenario,async h=>{
    const before=await h.inspect(); await assert.rejects(h.projectOwnership,error);
    const after=await h.inspect(); assert.equal(after.databaseFingerprint,before.databaseFingerprint);
    assert.equal(after.ownershipRows,before.ownershipRows); assert.equal(after.applicationRows,before.applicationRows);
    await assert.rejects(h.projectOwnership,/C4_PROJECTION_ALREADY_CONSUMED/);
  }));
test('recovered confirmation and a copied projection never grant runtime or persistence authority',()=>sandbox('valid',async h=>{
  const result=await h.projectOwnership(), recovered=await h.reopen(); assert.equal(recovered.projection,undefined);
  await assert.rejects(h.projectOwnership,/C4_PROJECTION_ALREADY_CONSUMED/);
  const modules=loadStore(), registry=modules.load('src/lib/tesla-tariff/supervised-journal.ts');
  const issuer=modules.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
  const finaliser=modules.load('src/lib/tesla-tariff/ownership-finalisation.ts');
  const operation=result.offlineReceipt.operation;
  for(const candidate of [result,result.projection,JSON.parse(JSON.stringify(result.projection)),result.offlineReceipt,recovered]) {
    assert.equal(registry.journalCompletionForRecords(candidate,operation.initial,operation.completion),null);
    assert.equal(issuer.issueConfirmedSmartReceipt(candidate,operation.initial,operation.completion).code,'JOURNAL_COMPLETION_NOT_BOUND');
    assert.equal(finaliser.validateConfirmedSmartReceipt(candidate).status,'rejected');
    assert.equal(finaliser.finaliseConfirmedSmartOwnership(candidate).status,'rejected');
    await assert.rejects(()=>h.projectOwnership(candidate),/C1_INPUT_SUBSTITUTION_REJECTED/);
  }
  assert.equal((await h.inspect()).ownershipRows,0);
}));
test('restart before projection discards the receipt identity rather than hydrating journal JSON',()=>sandbox('valid',async h=>{
  await h.rehearse(); const recovered=await h.reopen(); assert.equal(recovered.history.status,'available');
  await assert.rejects(h.projectOwnership,/C4_PROJECTION_ALREADY_CONSUMED/); assert.equal((await h.inspect()).ownershipRows,0);
}));
