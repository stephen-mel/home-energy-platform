import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';

const root=await io.mkdtemp(path.join(os.tmpdir(),'hep-trusted-persistence-'));
after(()=>io.rm(root,{recursive:true,force:true}));
let cwd=root, hook=()=>{}, execHook=()=>{}, closeHook=()=>{};
const store=loadStore({get cwd(){return cwd;},beforeStatement(...a){hook(...a);},beforeExec(...a){execHook(...a);},afterClose(){closeHook();}});
const load=store.load;
const records=load('src/lib/tesla-tariff/linked-experiment-records.ts');
const journal=load('src/lib/tesla-tariff/supervised-journal.ts');
const {runSupervisedExperiment}=load('src/lib/tesla-tariff/supervised-experiment.ts');
const {prepareMutationContext}=load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const {ownershipFingerprint:hash}=load('src/lib/tesla-tariff/ownership-transition.ts');
const {representationKey:key}=load('src/lib/tesla-tariff/rollback-evidence.ts');
const issuer=load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
const finaliser=load('src/lib/tesla-tariff/ownership-finalisation.ts');
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8'));
const site=load('src/lib/site/current-site.ts').currentSite;
const clean=x=>JSON.parse(JSON.stringify(x));
const without=(r,...fields)=>Object.fromEntries(Object.entries(r).filter(([k])=>!fields.includes(k)));
const dbFile=()=>path.join(cwd,'.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite');
async function sandbox(fn){cwd=await io.mkdtemp(path.join(root,'case-'));hook=()=>{};execHook=()=>{};closeHook=()=>{};try{await fn();}finally{hook=()=>{};execHook=()=>{};closeHook=()=>{};}}

// Same real Stage A → B1 → durable B2 path used by issuer tests. Only transport,
// clock and human interaction are mocks; no registry or issuer authority shortcut.
async function confirmed({id='mutation-A',ownership={status:'missing'},capture=fixture,time='2026-09-23T08:12:00Z',dispatchStart=capture.kraken.vehicles[0].plannedDispatches[0].start}={}){
  const directory=await io.mkdtemp(path.join(root,'journal-'));
  const selection={energySiteId:'12345',assetId:'q7-fixture',dispatchStart};
  let clock=Date.parse(time),review,initial,classified;
  const now=()=>new Date(clock).toISOString();
  const result=await runSupervisedExperiment({site,selection,mode:'execute-supervised',authority:'supervised-experiment'}, {
    now,journalRecords:records,
    async capture(){const c=structuredClone(capture);c.before.source.observedAt=now();c.kraken.lastSuccessfulUpdate=now();return c;},
    prepareContext: c=>prepareMutationContext({site,selection,capture:c},{now,readOwnership:async()=>ownership,newMutationId:()=>id}),
    challenge:hash,
    async confirm(r,challenge){review=r;clock+=1000;return{challenge,automaticRollbackUnproven:true,manualAppRecoveryMayBeRequired:true};},
    async claim(s,r){initial=r;const j=await journal.claimExperimentJournal(directory,s,r);return{async finish(r){classified=r;return j.finish(r);}};},
    async write(){clock+=1000;return{status:'accepted',httpStatus:200};},
    async readBack(){clock+=1000;return{...structuredClone(capture.before),source:{...capture.before.source,observedAt:now()},tariff:structuredClone(review.proposal.bound.representation)};},
  });
  return {initial,classified,capability:result.journalCompletion,directory};
}
async function complete(initial,classified){
  const directory=await io.mkdtemp(path.join(root,'journal-'));
  const j=await journal.claimExperimentJournal(directory,'12345',initial);
  return{initial,classified,capability:await j.finish(classified),directory};
}
const base=await confirmed();
const persist=b=>store.persistConfirmedSmart(b.capability,b.initial,b.classified);
function successful(b=base){const r=persist(b);assert.equal(r.status,'persisted',JSON.stringify(r));return clean(r);}
function initialWithOwnership(snapshot){
  const i=structuredClone(base.initial),o=i.preparedContext.ownership;
  o.status='available';o.snapshot=snapshot;
  const p=i.review.proposal,s=p.input.observedSmart;
  i.preparedContext.fingerprint=hash({version:1,mutationId:i.mutationId,original:i.review,ownership:o,
    energySiteId:'12345',timeZone:p.bound.timeZone,selectedDispatch:s.dispatch,comparisonDomain:s.comparisonDomain,
    experimentFingerprint:i.review.fingerprint,proposalFingerprint:p.fingerprint,payloadKey:i.review.payloadJson,
    smartEvidenceKey:i.review.binding.smartEvidenceKey,selectedEvidenceKey:p.bound.dispatchEvidenceKey,ownershipKey:hash(o)});
  i.initialRecordId=hash(without(i,'initialRecordId'));return i;
}
function paired(i){return records.createLinkedClassifiedRecord(i,without(base.classified,'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId'));}

test('genuine B2 missing-state persistence derives exact identities, preserves export and production blockers, without journal/latch changes',()=>sandbox(async()=>{
  const journalFile=path.join(base.directory,'site-12345.jsonl'),journalBefore=await io.readFile(journalFile,'utf8');
  const issued=issuer.issueConfirmedSmartReceipt(base.capability,base.initial,base.classified);
  const finalised=finaliser.finaliseConfirmedSmartOwnership(issued.receipt);
  const r=successful();assert.equal(r.stage,'persistence');assert.equal(r.confirmation,'confirmed');
  assert.deepEqual(r.snapshot.evidence,clean(finalised.evidence));assert.equal(r.snapshot.evidence.export,undefined);
  assert.equal(r.rollbackProven,false);assert.equal(r.writeReady,false);assert.ok(r.productionBlockers.includes('ROLLBACK_UNPROVEN'));
  assert.equal(key(base.initial.review.before.tariff.sell_tariff),key(base.classified.apiTariffReadBack.observation.tariff.sell_tariff));
  assert.equal(await io.readFile(journalFile,'utf8'),journalBefore);
  assert.deepEqual(clean(store.readOwnership(dbFile(),'12345').snapshot),r.snapshot);
  assert.deepEqual(await io.readdir(path.dirname(dbFile())),['ownership.sqlite']);
}));
for(const [label,capability] of [['forged',{}],['copied',{...base.capability}],['serialized',JSON.parse(JSON.stringify(base.capability))],['completion evidence',journal.journalCompletionForRecords(base.capability,base.initial,base.classified)]])
  test(`${label} capability cannot reach SQLite`,()=>sandbox(()=>{
    const r=store.persistConfirmedSmart(capability,base.initial,base.classified);
    assert.equal(r.status,'rejected');assert.equal(r.stage,'issuance');assert.equal(r.confirmation,'not-established');
    assert.equal(r.code,'JOURNAL_COMPLETION_NOT_BOUND');assert.equal(fs.existsSync(dbFile()),false);
  }));
test('changed or mismatched B1 records reject even with recomputed record hashes',()=>sandbox(()=>{
  const i=structuredClone(base.initial);i.preWriteRecheck.krakenObservedAt='2026-09-23T08:12:00.000Z';i.initialRecordId=hash(without(i,'initialRecordId'));
  assert.ok(records.validLinkedInitialRecord(i,'12345'));const c=paired(i);
  for(const [a,b] of [[i,base.classified],[base.initial,c],[i,c]]){
    const r=store.persistConfirmedSmart(base.capability,a,b);assert.equal(r.code,'JOURNAL_COMPLETION_NOT_BOUND');
  }assert.equal(fs.existsSync(dbFile()),false);
}));
test('swapped Stage A ownership and recomputed snapshot/context/record hashes cannot substitute for bound history',()=>sandbox(()=>{
  const e={version:1,energySiteId:'12345',timeZone:'Europe/London',createdAt:'2026-09-23T07:00:00Z',updatedAt:'2026-09-23T07:00:00Z',validUntil:'2026-09-24T00:00:00Z',basis:'confirmed-write-readback',baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[]};
  const generation='11111111-1111-1111-1111-111111111111';
  for(const historyDigest of ['a'.repeat(64),'b'.repeat(64)]){
    const i=initialWithOwnership({version:2,generation,evidence:e,checksum:hash({generation,evidence:e}),historyDigest});
    assert.ok(records.validLinkedInitialRecord(i,'12345'));
    assert.equal(store.persistConfirmedSmart(base.capability,i,paired(i)).code,'JOURNAL_COMPLETION_NOT_BOUND');
  }assert.equal(fs.existsSync(dbFile()),false);
}));
test('caller mutation after entry detachment cannot change selected evidence or precondition',()=>sandbox(()=>{
  const i=structuredClone(base.initial),c=structuredClone(base.classified),original=key([i,c]);
  let mutated=false;
  hook=()=>{if(!mutated){mutated=true;i.mutationId='other';i.preparedContext.ownership={status:'missing',snapshot:null};c.apiWrite.status='rejected';}};
  const r=store.persistConfirmedSmart(base.capability,i,c);
  assert.equal(r.status,'persisted');assert.equal(mutated,true);assert.notEqual(key([i,c]),original);
  assert.equal(r.snapshot.evidence.smartEvidenceFingerprint,hash(base.initial.review.proposal.bound.dispatchEvidenceKey));
}));
test('exact replay preserves generation, historyDigest and complete snapshot',()=>sandbox(()=>{
  const a=successful(),b=persist(base);assert.equal(b.status,'already-persisted');
  assert.deepEqual(clean(b.snapshot),a.snapshot);
  assert.throws(()=>{b.snapshot.historyDigest='changed';});
  assert.throws(()=>{b.snapshot.evidence.intervals[0].restore.amount=999;});
  assert.deepEqual(clean(store.readOwnership(dbFile(),'12345').snapshot),a.snapshot);
}));
test('different genuine journal chain with same receipt projection is not false replay',()=>sandbox(async()=>{
  const i=structuredClone(base.initial);i.preWriteRecheck.krakenObservedAt='2026-09-23T08:12:00.000Z';i.initialRecordId=hash(without(i,'initialRecordId'));
  const other=await complete(i,paired(i));
  const a=issuer.issueConfirmedSmartReceipt(base.capability,base.initial,base.classified),b=issuer.issueConfirmedSmartReceipt(other.capability,i,other.classified);
  assert.equal(a.receiptKey,b.receiptKey);assert.notEqual(a.issuanceKey,b.issuanceKey);
  const saved=successful();const r=persist(other);assert.equal(r.status,'conflict');assert.equal(r.confirmation,'confirmed');assert.equal(r.code,'OWNERSHIP_MUTATION_CONFLICT');
  assert.deepEqual(clean(store.readOwnership(dbFile(),'12345').snapshot),saved.snapshot);
}));
for(const failure of ['store-failed','indeterminate'])test(`verified Tesla success stays confirmed after ${failure}`,()=>sandbox(()=>{
  if(failure==='store-failed')execHook=sql=>{if(sql==='BEGIN IMMEDIATE')throw Error('SECRET filesystem detail');};
  else closeHook=()=>{throw Error('SECRET close detail');};
  const r=persist(base);assert.equal(r.status,failure);assert.equal(r.confirmation,'confirmed');assert.equal(r.stage,'persistence');
  assert.doesNotMatch(JSON.stringify(r),/SECRET/);assert.equal(r.writeReady,false);assert.equal(r.rollbackProven,false);
  closeHook=()=>{};execHook=()=>{};
  if(failure==='indeterminate')assert.equal(persist(base).status,'already-persisted'); // explicit caller replay, never automatic
}));
test('restart/journal JSON and an old module capability cannot manufacture new runtime authority',()=>sandbox(()=>{
  const restarted=loadStore({cwd});const r=restarted.persistConfirmedSmart(base.capability,clean(base.initial),clean(base.classified));
  assert.equal(r.code,'JOURNAL_COMPLETION_NOT_BOUND');assert.equal(fs.existsSync(dbFile()),false);
}));
test('public API has only three mutation inputs; raw commit stays private; facade remains read-only',()=>{
  const production=loadStore().load('src/lib/tesla-tariff/ownership-sqlite.ts');
  assert.equal(production.persistConfirmedSmart.length,3);assert.equal(production.commitOwnership,undefined);
  const source=fs.readFileSync('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
  assert.deepEqual([...source.matchAll(/export function (\w+)/g)].map(m=>m[1]),['readOwnership','persistConfirmedSmart']);
  assert.deepEqual(Object.keys(load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore()),['read']);
});
test('issuable genuine B2 receipt can still fail finalisation coverage; zero SQLite effects',()=>sandbox(async()=>{
  const evidence={version:1,energySiteId:'12345',timeZone:'Europe/London',createdAt:'2026-09-23T07:00:00Z',updatedAt:'2026-09-23T07:00:00Z',validUntil:'2026-09-25T00:00:00Z',basis:'confirmed-write-readback',baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-09-24T08:00:00Z',end:'2026-09-24T10:00:00Z',restoreBaselineFingerprint:'e'.repeat(64),applied:{amount:0.25177,currency:'GBP',unit:'kWh'},restore:{amount:0.3,currency:'GBP',unit:'kWh'}}]};
  const generation='11111111-1111-1111-1111-111111111111';
  const i=initialWithOwnership({version:2,generation,evidence,checksum:hash({generation,evidence}),historyDigest:hash('captured history')});
  const b=await complete(i,paired(i));assert.equal(issuer.issueConfirmedSmartReceipt(b.capability,i,b.classified).status,'issued');
  const r=persist(b);assert.equal(r.status,'rejected');assert.equal(r.stage,'finalisation');assert.equal(r.confirmation,'confirmed');
  assert.equal(r.code,'OWNERSHIP_DOMAIN_INCOMPLETE');assert.equal(fs.existsSync(dbFile()),false);
}));
test('valid-empty ownership is captured and persisted distinctly from missing with the exact anchor',()=>sandbox(async()=>{
  const capture=structuredClone(fixture);
  for(const charges of Object.values(capture.before.tariff.energy_charges))if(charges.rates?.hour_6_minute_0!==undefined)charges.rates.hour_6_minute_0=0.0299;
  const empty=await confirmed({id:'empty',capture});const first=successful(empty);
  assert.deepEqual(first.snapshot.evidence.intervals,[]);
  const next=await confirmed({id:'after-empty',ownership:{status:'available',snapshot:first.snapshot},time:'2026-09-23T08:13:00Z'});
  assert.equal(next.initial.preparedContext.ownership.snapshot.historyDigest,first.snapshot.historyDigest);
  const second=successful(next);assert.notEqual(second.snapshot.generation,first.snapshot.generation);
  assert.notEqual(second.snapshot.historyDigest,first.snapshot.historyDigest);assert.ok(second.snapshot.evidence.intervals.length);
}));
test('non-empty capture preserves full precondition and original lineage; competing append and historical replay conflict',()=>sandbox(async()=>{
  const first=successful();
  const capture=structuredClone(fixture);capture.before=structuredClone(base.classified.apiTariffReadBack.observation);
  capture.kraken.vehicles[0].plannedDispatches=[{...capture.kraken.vehicles[0].plannedDispatches[0],start:'2026-09-23T12:00:00+00:00',end:'2026-09-23T13:00:00+00:00'}];
  const args={capture,ownership:{status:'available',snapshot:first.snapshot},time:'2026-09-23T08:13:00Z'};
  const next=await confirmed({...args,id:'next'}),stale=await confirmed({...args,id:'competing'});
  assert.deepEqual(clean(next.initial.preparedContext.ownership.snapshot),first.snapshot);
  const second=successful(next);
  for(const prior of first.snapshot.evidence.intervals)assert.ok(second.snapshot.evidence.intervals.some(i=>key(i)===key(prior)));
  assert.ok(second.snapshot.evidence.intervals.some(i=>i.start==='2026-09-23T12:00:00.000Z'&&i.end==='2026-09-23T13:00:00.000Z'));
  assert.equal(second.snapshot.evidence.export,undefined);
  const conflict=persist(stale);assert.equal(conflict.status,'conflict');assert.equal(conflict.code,'OWNERSHIP_GENERATION_CHANGED');assert.equal(conflict.confirmation,'confirmed');
  assert.equal(persist(base).status,'conflict');assert.deepEqual(clean(store.readOwnership(dbFile(),'12345').snapshot),second.snapshot);
  const replay=persist(next);assert.equal(replay.status,'already-persisted');assert.deepEqual(clean(replay.snapshot),second.snapshot);
}));
test('same generation and evidence but different valid history anchor conflicts with original B2-bound snapshot',()=>sandbox(async()=>{
  const first=successful(),capture=structuredClone(fixture);
  capture.before=structuredClone(base.classified.apiTariffReadBack.observation);
  capture.kraken.vehicles[0].plannedDispatches=[{...capture.kraken.vehicles[0].plannedDispatches[0],start:'2026-09-23T12:00:00+00:00',end:'2026-09-23T13:00:00+00:00'}];
  const next=await confirmed({id:'anchor-check',capture,ownership:{status:'available',snapshot:first.snapshot},time:'2026-09-23T08:13:00Z'});
  // Exercise the documented full-database-tamper limit: a consistent local rewrite
  // is readable, but MUST NOT match an earlier, B2-bound captured precondition.
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(dbFile());
  try{
    const a=JSON.parse(db.prepare('SELECT record FROM applied').get().record);a.receiptKey=hash('rewritten history');a.checksum=hash(without(a,'checksum'));
    db.prepare('UPDATE applied SET record=?').run(JSON.stringify(a));
    const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);s.historyDigest=hash({version:1,site:'12345',applications:[a]});
    db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
  }finally{db.close();}
  const current=clean(store.readOwnership(dbFile(),'12345'));assert.equal(current.status,'available');
  assert.equal(current.snapshot.generation,first.snapshot.generation);assert.deepEqual(current.snapshot.evidence,first.snapshot.evidence);
  assert.notEqual(current.snapshot.historyDigest,first.snapshot.historyDigest);
  const r=persist(next);assert.equal(r.status,'conflict');assert.equal(r.code,'OWNERSHIP_GENERATION_CHANGED');
  assert.deepEqual(clean(store.readOwnership(dbFile(),'12345')),current);
}));
test('genuine completed ambiguous Tesla outcome remains unconfirmed and cannot persist',()=>sandbox(async()=>{
  const e=without(base.classified,'journalSchemaVersion','mutationId','energySiteId','initialRecordId','classifiedRecordId');
  e.apiWrite={status:'unknown',httpStatus:200};e.classification='write-outcome-unknown';
  const classified=records.createLinkedClassifiedRecord(base.initial,e),b=await complete(base.initial,classified);
  const r=persist(b);assert.equal(r.status,'rejected');assert.equal(r.stage,'issuance');assert.equal(r.confirmation,'not-established');
  assert.equal(r.code,'MUTATION_NOT_CONFIRMED');assert.equal(fs.existsSync(dbFile()),false);
}));
test('internal generation, mutation, receipt and payload contradictions reject before SQLite',()=>sandbox(()=>{
  const real=finaliser.finaliseConfirmedSmartOwnership;
  try{
    for(const patch of [{expectedGeneration:'11111111-1111-1111-1111-111111111111'},{mutationId:'other'},{receiptKey:'f'.repeat(64)},{originalPayloadKey:'other'}]){
      finaliser.finaliseConfirmedSmartOwnership=r=>({...real(r),...patch});
      const result=persist(base);assert.equal(result.status,'rejected');assert.equal(result.stage,'binding');assert.equal(result.confirmation,'confirmed');
      assert.equal(result.code,'OWNERSHIP_BINDING_INVALID');assert.equal(fs.existsSync(dbFile()),false);
    }
  }finally{finaliser.finaliseConfirmedSmartOwnership=real;}
}));

test('deleted actual working directory returns confirmed definite store failure before any SQLite operation',()=>sandbox(()=>{
  const issued=issuer.issueConfirmedSmartReceipt(base.capability,base.initial,base.classified);
  assert.equal(issued.status,'issued');
  assert.equal(finaliser.finaliseConfirmedSmartOwnership(issued.receipt).status,'derived');
  const originalCwd=process.cwd(),configuredCwd=cwd;
  const removed=fs.mkdtempSync(path.join(root,'removed-cwd-'));
  let sqliteOperations=0;
  execHook=()=>{sqliteOperations++;};hook=()=>{sqliteOperations++;};
  try{
    cwd=undefined; // Use the harness's real process.cwd() fallback, not a thrown mock.
    process.chdir(removed);fs.rmdirSync(removed);
    assert.throws(()=>process.cwd(),{code:'ENOENT'});
    let result;
    assert.doesNotThrow(()=>{result=persist(base);});
    assert.equal(result.status,'store-failed');assert.equal(result.stage,'persistence');
    assert.equal(result.code,'OWNERSHIP_DESTINATION_UNAVAILABLE');
    assert.equal(result.confirmation,'confirmed');assert.equal(result.writeReady,false);assert.equal(result.rollbackProven,false);
    assert.equal(sqliteOperations,0);assert.ok(result.productionBlockers.includes('ROLLBACK_UNPROVEN'));
    assert.doesNotMatch(JSON.stringify(result),/ENOENT|removed-cwd-|syscall|SECRET/);
  }finally{process.chdir(originalCwd);cwd=configuredCwd;}
  assert.equal(fs.existsSync(dbFile()),false);
}));
