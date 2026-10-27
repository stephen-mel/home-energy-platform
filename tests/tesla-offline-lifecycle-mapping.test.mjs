import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedDatabase, seedJournal } from './helpers/ownership-persistence.mjs';
import { closedOfflineV2 } from './helpers/closed-offline-v2.mjs';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';
import { hash, key, mapIdentity, document, fixture } from './helpers/ownership-lifecycle.mjs';
const modules=loadStore(), lifecycle=modules.load('src/lib/tesla-tariff/ownership-lifecycle.ts');
const persistence=modules.load('src/lib/tesla-tariff/ownership-persistence.ts');
const h=await closedOfflineV2();
let original;
try { original=await h.mapLifecycle(); } finally { await h.close(); }
const check=f=>lifecycle.testValidateOfflineLifecycle(f.lifecycle,f.context);
const stored=f=>persistence.testValidateOfflinePersistence(f.record,[f.record],'12345','Europe/London',f.journal,f.context);
function rehash(f){
 const e=f.journal.records[0],a=f.lifecycle.applications[0];
 f.lifecycle=document(f.lifecycle.historicalOwnership,[mapIdentity(e,a.runtime,a.retainedOriginKey,null)]);
 const body={version:1,kind:'offline-v2-ownership-persistence',lifecycle:f.lifecycle,
  approvedValidity:f.record.approvedValidity,previousRecordId:null};
 f.record={...body,recordId:hash({purpose:'smart-ownership-persistence-v1',...body})};
}
function noAuthority(result){for(const name of ['executionReady','writeReady','grantsSuccessorAuthority','grantsRepeatAuthority','grantsRestorationAuthority'])assert.equal(result[name],false,name);}
test('closed exact receipt maps versioned offline identities; no SQLite writes or production acceptance',()=>{
 assert.equal(original.status,'lifecycle-mapped-offline');
 const runtime=original.lifecycle.applications[0].runtime;
 assert.equal(runtime.namespace,'offline-simulated-operation');assert.equal(runtime.version,1);assert.equal(runtime.receiptVersion,1);
 assert.equal(runtime.receiptKey,original.projection.offlineReceipt.receiptKey);
 assert.equal(runtime.issuanceKey,original.projection.offlineReceipt.issuanceKey);
 assert.equal(original.record.kind,'offline-v2-ownership-persistence');
 assert.equal(original.storage.ownershipRows,0);assert.equal(original.storage.applicationRows,0);
 assert.equal(key(original.lifecycle.historicalOwnership.lifecycle.original),key(original.projection.retainedOriginal.original));
 assert.equal(key(original.record.approvedValidity),key(original.projection.approvedValidity));
 assert.equal(check(original).status,'validated');assert.equal(stored(original).status,'validated');
 noAuthority(check(original));noAuthority(stored(original));
 assert.equal(lifecycle.validateOwnershipLifecycleDocument(original.lifecycle,original.context).status,'rejected');
 assert.equal(persistence.validatePersistedOwnershipHistory(original.record,[original.record],'12345','Europe/London',original.journal).status,'rejected');
 assert.ok(Object.isFrozen(original.lifecycle));
});
test('round-trip is documentary consistency only; relabelled outer record remains rejected in production',()=>{
 const f=JSON.parse(JSON.stringify(original));assert.equal(stored(f).status,'validated');noAuthority(stored(f));
 f.record.kind='v3-ownership-persistence';const {recordId,...body}=f.record;void recordId;
 f.record.recordId=hash({purpose:'smart-ownership-persistence-v1',...body});
 assert.equal(persistence.validatePersistedOwnershipHistory(f.record,[f.record],'12345','Europe/London',f.journal).status,'rejected');
});
for(const field of ['receiptKey','issuanceKey','admissionKey','simulatedCompletionKey']) {
 for(const role of ['history','journal','evidence','origin','completion'])test(`fully rehashed ${field} alias to ${role} rejects`,()=>{
  const f=structuredClone(original),ref=f.lifecycle.applications[0].runtime;
  const aliases={history:f.context.historicalOwnership.historyDigest,journal:f.journal.records[0].initial.initialRecordId,
   evidence:f.journal.records[0].evidenceId,origin:f.projection.retainedOriginKey,completion:f.journal.records[0].completion.completionRecordId};
  ref[field]=aliases[role];f.context.runtimeIdentities[0]=structuredClone(ref);rehash(f);
  assert.equal(check(f).status,'rejected');assert.equal(stored(f).status,'rejected');
 });
 test(`rehashed ${field} substitution cannot replace independently supplied identity`,()=>{
  const f=structuredClone(original);f.lifecycle.applications[0].runtime[field]=hash('replacement-'+field);rehash(f);
  assert.equal(check(f).status,'rejected');assert.equal(stored(f).status,'rejected');
 });
}
for(const [name,change] of [
 ['generation',f=>{f.lifecycle.historicalOwnership.generation='00000000-0000-8000-8000-000000000000';}],
 ['missing completion',f=>{delete f.journal.records[0].completion;delete f.context.operations[0].evidence.completion;}],
 ['journal identity',f=>{f.lifecycle.applications[0].journal.completionRecordId=hash('wrong completion');}],
 ['retained origin',f=>{f.lifecycle.historicalOwnership.lifecycle.origin.issuanceKey=hash('wrong origin');}],
 ['history reference',f=>{f.record.previousRecordId=hash('nonexistent predecessor');}],
 ['version',f=>{f.lifecycle.applications[0].runtime.version=99;}],
 ['runtime namespace',f=>{f.lifecycle.applications[0].runtime.namespace='runtime-confirmed-operation';}],
 ['missing independent offline context',f=>{f.context={};}],
])test(`${name} rejects offline mapping`,()=>{
 const f=structuredClone(original);change(f);assert.equal(stored(f).status,'rejected');
});
test('offline acceptance cannot extend to update or terminal restoration',()=>{
 for(const state of ['update','restored']){const f=fixture(state);assert.equal(lifecycle.testValidateOfflineLifecycle(f.value,f.context).code,'OFFLINE_FIRST_APPLY_ONLY');}
});
for(const scenario of ['projection-copy','receipt-recovered','interrupted-after-write'])test(`closed mapping refuses ${scenario}`,async()=>{
 const harness=await closedOfflineV2(scenario);try{await assert.rejects(harness.mapLifecycle());}finally{await harness.close();}
});
test('mapping rejects supplied documents, replay, concurrent mapping and restart hydration',async()=>{
 const harness=await closedOfflineV2();try{
  await assert.rejects(harness.mapLifecycle(original),/INPUT_SUBSTITUTION/);
  const results=await Promise.allSettled([harness.mapLifecycle(),harness.mapLifecycle()]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(harness.mapLifecycle(),/ALREADY_CONSUMED/);
  await harness.reopen();await assert.rejects(harness.mapLifecycle(),/ALREADY_CONSUMED/);
 }finally{await harness.close();}
});
test('offline validation entry points are absent from application exports',async()=>{
 for(const file of ['ownership-lifecycle.ts','ownership-persistence.ts']){
  const source=await fs.readFile('src/lib/tesla-tariff/'+file,'utf8');
  assert.doesNotMatch(source,/export\s+(?:async\s+)?function\s+(?:validateOfflineOwnershipLifecycleDocument|validateLifecycleDocument|validatePersistenceHistory|testValidateOffline\w*)/);
 }
});

test('extra arguments cannot switch production validators to offline acceptance',()=>{
 assert.equal(lifecycle.validateOwnershipLifecycleDocument(original.lifecycle,original.context,'offline-test-only').status,'rejected');
 assert.equal(persistence.validatePersistedOwnershipHistory(original.record,[original.record],'12345','Europe/London',original.journal,
  lifecycle.testValidateOfflineLifecycle,original.context).status,'rejected');
 assert.equal(check(original).mode,'offline-test-only');assert.equal(check(original).runtimeConfirmationVerified,false);
});
for(const [left,right] of [['receiptKey','issuanceKey'],['receiptKey','admissionKey'],['receiptKey','simulatedCompletionKey'],
 ['issuanceKey','admissionKey'],['issuanceKey','simulatedCompletionKey'],['admissionKey','simulatedCompletionKey']])test(`offline roles ${left}/${right} cannot alias after rehash`,()=>{
 const f=structuredClone(original),ref=f.lifecycle.applications[0].runtime;
 ref[left]=ref[right];f.context.runtimeIdentities[0]=structuredClone(ref);rehash(f);
 assert.equal(check(f).status,'rejected');assert.equal(stored(f).status,'rejected');
});
test('self-checksummed generation substitution still conflicts with approved journal generation',()=>{
 const f=structuredClone(original),s=f.lifecycle.historicalOwnership;
 s.generation='00000000-0000-8000-8000-000000000000';s.lifecycle.currentGeneration=s.generation;
 const {checksum,historyDigest,...body}=s;void checksum;void historyDigest;s.checksum=hash(body);
 f.context.historicalOwnership=structuredClone(s);rehash(f);
 assert.equal(stored(f).code,'V3_PERSISTENCE_GENERATION_OR_PREDECESSOR_CONFLICT');
 assert.equal(check(f).code,'ACTIVE_OWNERSHIP_HISTORY_CONFLICT');
});

// Astra's exact combined attack: relabel ALL discriminants and repair every
// dependent hash, while leaving independently retained offline journals intact.
test('Astra combined namespace/version/kind relabelling cannot gain production provenance through SQLite recovery',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'c5a-relabel-')));
 const file=path.join(root,'ownership','ownership.sqlite'),directory=path.join(root,'tesla-experiments');
 try {
  await fs.mkdir(path.dirname(file));
  const f=structuredClone(original);
  const originalStorage={current:f.record,records:[f.record],journal:f.journal};
  seedDatabase(file,originalStorage);
  const admission=await seedJournal(directory,originalStorage);
  const journalBefore=await Promise.all((await fs.readdir(directory)).sort().map(async name=>[name,await fs.readFile(path.join(directory,name),'utf8')]));
  const reference=f.lifecycle.applications[0].runtime;
  delete reference.admissionKey;delete reference.simulatedCompletionKey;
  reference.namespace='runtime-confirmed-operation';reference.receiptVersion=2;
  rehash(f);f.record.kind='v3-ownership-persistence';
  const {recordId,...body}=f.record;void recordId;
  f.record.recordId=hash({purpose:'smart-ownership-persistence-v1',...body});
  // Unchanged independent offline identity context cannot authenticate the
  // substituted references, even though every candidate checksum is repaired.
  assert.equal(lifecycle.validateOwnershipLifecycleDocument(f.lifecycle,original.context).status,'rejected');
  const checked=persistence.validatePersistedOwnershipHistory(f.record,[f.record],'12345','Europe/London',f.journal);
  assert.equal(checked.status,'consistent-only');assert.equal(checked.identityProvenance,'unverified');noAuthority(checked);
  assert.equal(stored(f).status,'rejected');
  const db=new DatabaseSync(file);try{
   db.exec('BEGIN IMMEDIATE');
   db.prepare('UPDATE ownership SET snapshot=? WHERE site=?').run(JSON.stringify(f.record),'12345');
   db.prepare('UPDATE applied SET record=? WHERE site=?').run(JSON.stringify(f.record),'12345');
   db.exec('COMMIT');
  }finally{db.close();}
  const before=await fs.readFile(file);
  for(let n=0;n<2;n++){
   const store=loadStore(),recovered=await store.readPersistedOwnershipLifecycle(file,'12345','Europe/London',admission);
   assert.equal(recovered.status,'consistent-storage',recovered.code);
   assert.equal(recovered.identityProvenance,'unverified');assert.equal(recovered.runtimeConfirmationVerified,false);noAuthority(recovered);
   const registry=store.load('src/lib/tesla-tariff/supervised-journal.ts');
   const issuer=store.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
   const e=f.journal.records[0];
   for(const claimed of [checked,recovered,f.record,reference]){
    assert.equal(registry.journalCompletionForRecords(claimed,e.initial,e.completion),null);
    assert.equal(issuer.issueConfirmedSmartReceipt(claimed,e.initial,e.completion).status,'rejected');
   }
  }
  assert.deepEqual(await fs.readFile(file),before);
  const journalAfter=await Promise.all((await fs.readdir(directory)).sort().map(async name=>[name,await fs.readFile(path.join(directory,name),'utf8')]));
  assert.deepEqual(journalAfter,journalBefore,'Offline journal evidence was not rewritten to match the relabelled SQL');
  assert.equal(stored(original).status,'validated','Legitimate private offline mapping remains valid');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
