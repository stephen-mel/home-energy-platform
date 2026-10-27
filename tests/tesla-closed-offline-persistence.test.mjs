import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {closedOfflineV2} from './helpers/closed-offline-v2.mjs';
import {loadStore} from './helpers/ownership-sqlite-harness.mjs';
import {key} from './helpers/ownership-lifecycle.mjs';
async function sandbox(scenario,fn){const h=await closedOfflineV2(scenario);try{await fn(h);}finally{await h.close();}}
function noAuthority(value){
 assert.equal(value.mode,'offline-test-only');assert.equal(value.authentication,'fixtures-only');
 for(const flag of ['executionReady','writeReady','grantsAdmissionAuthority','grantsSuccessorAuthority','grantsRepeatAuthority','grantsRestorationAuthority','runtimeConfirmationVerified'])assert.equal(value[flag],false,flag);
}
test('closed first apply commits, discards live identities and recovers through a fresh read-only connection',()=>sandbox('valid',async h=>{
 await assert.rejects(h.recoverOwnership(),/RECOVERY_NOT_PREPARED/);
 for(const value of [{}, {capture:()=>{}}, {record:{kind:'offline-v2-ownership-persistence'}}])await assert.rejects(h.persistAndRecover(value),/INPUT_SUBSTITUTION/);
 const r=await h.persistAndRecover(),p=r.projection,s=r.recovery.current;
 assert.equal(r.status,'persistence-rehearsed-offline');assert.equal(r.commit.status,'persisted-offline');
 assert.equal(r.executionIdentitiesDiscarded,true);assert.equal(r.recovery.status,'consistent-offline-storage');
 noAuthority(r);noAuthority(r.recovery);assert.equal(r.recovery.identityProvenance,'unverified');
 assert.equal(s.kind,'offline-v2-ownership-persistence');assert.equal(s.lifecycle.applications[0].runtime.namespace,'offline-simulated-operation');
 assert.equal(r.commit.generation,p.generation.expectedAfter);assert.equal(s.lifecycle.generation,p.generation.expectedAfter);
 assert.equal(key(s.lifecycle.historicalOwnership.lifecycle),key(p.retainedOriginal));
 assert.equal(key(s.lifecycle.historicalOwnership.evidence),key(p.ownershipEvidence));
 assert.equal(key(s.approvedValidity),key(p.approvedValidity));
 assert.equal(key(s.lifecycle.historicalOwnership.lifecycle.original),key(p.retainedOriginal.original));
 assert.equal(key(p.comparisonBaseline.observation),key(p.retainedOriginal.original));
 assert.equal(s.lifecycle.restorationObligation,'required');assert.equal(r.storage.ownershipRows,1);assert.equal(r.storage.applicationRows,1);assert.equal(r.storage.simulatedWrites,1);
 const before=await h.inspect(),again=await h.recoverOwnership();
 assert.equal(key(again),key(r.recovery));await h.reopen();assert.equal(key(await h.recoverOwnership()),key(again));
 const after=await h.inspect();assert.equal(before.databaseFingerprint,after.databaseFingerprint);assert.equal(key(before.files),key(after.files));
 const modules=loadStore(),issuer=modules.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts'),registry=modules.load('src/lib/tesla-tariff/supervised-journal.ts');
 const journal=(await h.reopen()).history.history.records[0];
 for(const candidate of [r,again,again.current,structuredClone(again),again.current.lifecycle.applications[0].runtime,p.offlineReceipt]){
  assert.equal(registry.journalCompletionForRecords(candidate,journal.initial,journal.completion),null);
  assert.equal(issuer.issueConfirmedSmartReceipt(candidate,journal.initial,journal.completion).status,'rejected');
 }
 await assert.rejects(h.persistAndRecover(),/ALREADY_CONSUMED/);await assert.rejects(h.mapLifecycle(),/ALREADY_CONSUMED/);
 await assert.rejects(h.rehearse(),/ALREADY_CONSUMED/);await assert.rejects(h.recoverOwnership(again),/INPUT_SUBSTITUTION/);
 assert.ok(Object.isFrozen(r.recovery.current.lifecycle.historicalOwnership.lifecycle.original));
}));
test('approved validity beyond comparison domain survives commit and recovery unchanged',()=>sandbox('projection-validity-beyond-domain',async h=>{
 const r=await h.persistAndRecover();assert.equal(r.recovery.status,'consistent-offline-storage');
 assert.ok(Date.parse(r.projection.approvedValidity.end)>Date.parse(r.projection.comparisonDomain.end));
 assert.equal(key(r.recovery.current.approvedValidity),key(r.projection.approvedValidity));
 assert.equal(r.recovery.current.lifecycle.historicalOwnership.evidence.validUntil,r.projection.approvedValidity.end);
 noAuthority(r.recovery);
}));
for(const scenario of ['recover-missing-journal','recover-substituted-journal','recover-original','recover-generation',
 'recover-production-relabel','recover-offline-receipt','recover-missing-history','recover-pending'])test(`reopen blocks ${scenario} without repair or authority`,()=>sandbox(scenario,async h=>{
 const r=await h.persistAndRecover();assert.equal(r.commit.status,'persisted-offline');assert.equal(r.executionIdentitiesDiscarded,true);
 assert.equal(r.recovery.status,'blocked',JSON.stringify(r.recovery));noAuthority(r.recovery);
 const before=await h.inspect(),again=await h.recoverOwnership(),after=await h.inspect();
 assert.equal(again.status,'blocked');assert.equal(before.databaseFingerprint,after.databaseFingerprint);assert.equal(key(before.files),key(after.files));
 assert.equal(after.simulatedWrites,1);assert.equal(after.ownershipRows,1);assert.equal(after.applicationRows,scenario==='recover-missing-history'?0:1);
 await assert.rejects(h.persistAndRecover(),/ALREADY_CONSUMED/);
}));
for(const scenario of ['persist-stale-generation','persist-predecessor','persist-partial-failure'])test(`${scenario} leaves no partial ownership/history and cannot retry`,()=>sandbox(scenario,async h=>{
 await assert.rejects(h.persistAndRecover(),/OWNERSHIP_/);
 const storage=await h.inspect();assert.equal(storage.ownershipRows,0);assert.equal(storage.applicationRows,0);
 const r=await h.recoverOwnership();assert.equal(r.status,'blocked');noAuthority(r);
 await assert.rejects(h.persistAndRecover(),/ALREADY_CONSUMED/);assert.equal((await h.inspect()).simulatedWrites,1);
}));
test('duplicate exact-generation commit rejects while original committed ownership recovers',()=>sandbox('persist-duplicate',async h=>{
 const r=await h.persistAndRecover();assert.equal(r.commit.status,'persisted-offline');assert.equal(r.repeatAttempt.status,'conflict');
 assert.equal(r.recovery.status,'consistent-offline-storage');assert.equal(r.storage.ownershipRows,1);assert.equal(r.storage.applicationRows,1);
 assert.equal(r.recovery.current.lifecycle.generation,r.commit.generation);noAuthority(r.recovery);
}));
test('concurrent orchestration admits one operation and one atomic commit',()=>sandbox('valid',async h=>{
 const settled=await Promise.allSettled([h.persistAndRecover(),h.persistAndRecover()]);
 assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(settled.filter(r=>r.status==='rejected').length,1);
 const r=settled.find(r=>r.status==='fulfilled').value;assert.equal(r.recovery.status,'consistent-offline-storage');
 assert.equal(r.storage.simulatedWrites,1);assert.equal(r.storage.ownershipRows,1);assert.equal(r.storage.applicationRows,1);
}));
test('new orchestration and read-only recovery exist only in test helpers',async()=>{
 const source=await fs.readFile('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
 assert.doesNotMatch(source,/testReadOfflineOwnership|persistAndRecover|offlineRecoverySource/);
});
