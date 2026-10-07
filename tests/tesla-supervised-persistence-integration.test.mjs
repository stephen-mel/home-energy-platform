import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { loadStore } from './helpers/ownership-sqlite-harness.mjs';

const root=await io.mkdtemp(path.join(os.tmpdir(),'hep-local-persistence-'));
after(()=>io.rm(root,{recursive:true,force:true}));
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8'));
const source=ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText;

async function harness(options={}) {
  const cwd=await io.mkdtemp(path.join(root,'case-'));
  const store=loadStore({cwd,beforeExec(sql){if(options.storeFailure==='store-failed'&&sql==='BEGIN IMMEDIATE')throw Error('private failure');},
    afterClose(){if(options.storeFailure==='indeterminate')throw Error('private close failure');}});
  const load=store.load, core=load('src/lib/tesla-tariff/supervised-experiment.ts');
  const records=load('src/lib/tesla-tariff/linked-experiment-records.ts');
  const journal=load('src/lib/tesla-tariff/supervised-journal.ts');
  const prepare=load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareMutationContext;
  const site=load('src/lib/site/current-site.ts').currentSite;
  const calls={writes:0,persist:0,runs:0,ownershipReads:0,events:[],output:[]};
  let result, initial, classified, review, clock=Date.parse(options.ownership?'2026-09-23T08:13:00Z':'2026-09-23T08:12:00Z');
  const now=()=>new Date(clock).toISOString();
  const fail=()=>{throw Error('Unexpected live/local I/O');};
  const local={};
  const dependencies={
    'node:fs/promises':{readFile:fail,mkdir:fail,writeFile:fail},'node:path':path,
    'node:crypto':{createHash,randomUUID:fail},'node:readline/promises':{createInterface:fail},
    '@next/env':{loadEnvConfig(){}},'../site/current-site':{currentSite:site},
    '../kraken/client':{getKrakenDevices:fail,getKrakenPlannedDispatches:fail},
    './observed-tariff':load('src/lib/tesla-tariff/observed-tariff.ts'),
    './linked-experiment-records':records,'./prepared-mutation-context':{prepareMutationContext:prepare},
    './ownership-store':{ownershipStore:fail},'./supervised-journal':journal,
    './supervised-experiment':{...core,async runSupervisedExperiment(input){
      calls.runs++;
      if(options.replay)return result;
      result=await core.runSupervisedExperiment(input,{
        now,journalRecords:records,
        async capture(){const c=structuredClone(options.capture??fixture);c.before.source.observedAt=now();c.kraken.lastSuccessfulUpdate=now();return c;},
        prepareContext:c=>prepare({site,selection:input.selection,capture:c},{now,newMutationId:()=> 'integration-mutation',
          async readOwnership(){calls.ownershipReads++;return options.ownership??{status:'missing'};}}),
        challenge:()=> 'exact-challenge',async confirm(r,challenge){review=r;clock+=1000;return{challenge,automaticRollbackUnproven:true,manualAppRecoveryMayBeRequired:true};},
        async claim(s,r){initial=r;calls.events.push('claim');if(options.failure==='initial')throw Error('initial failed');
          const j=await journal.claimExperimentJournal(path.join(cwd,'journal'),s,r);
          return{async finish(r){classified=r;calls.events.push('finish-start');if(options.failure==='classified')throw Error('classified failed');
            const capability=await j.finish(r);
            assert.ok(journal.journalCompletionForRecords(capability,initial,r));
            assert.equal((await io.readFile(path.join(cwd,'journal','site-12345.jsonl'),'utf8')).trim().split('\n').length,2);
            calls.events.push('durable-capability');return capability;}};},
        async write(){calls.writes++;clock+=1000;return options.api??{status:'accepted',httpStatus:200};},
        async readBack(){clock+=1000;if(options.readback==='missing')throw Error('unavailable');
          const observation={...structuredClone(fixture.before),source:{...fixture.before.source,observedAt:now()},tariff:structuredClone(review.proposal.bound.representation)};
          if(options.readback==='transformed')observation.tariff=structuredClone(fixture.before.tariff);
          return observation;},
      });
      if(result.status==='attempt-recorded'){
        assert.strictEqual(result.initialRecord,initial);assert.strictEqual(result.record,classified);
      }
      options.substitute?.(result);
      return result;
    }},
    './ownership-sqlite':{persistConfirmedSmart(...args){
      calls.persist++;calls.events.push('persist');
      assert.ok(calls.events.includes('durable-capability'));
      assert.strictEqual(args[0],result.journalCompletion);assert.strictEqual(args[1],result.initialRecord);assert.strictEqual(args[2],result.record);
      // Outcome injection exercises reporting only; genuine paths below exercise authority and commits.
      if(options.persistenceResult)return options.persistenceResult;
      if(options.persistenceThrow==='before')throw Error('INJECTED_PRE_COMMIT_SECRET');
      const persisted=store.persistConfirmedSmart(...args);
      if(options.persistenceThrow==='after'){
        assert.equal(persisted.status,'persisted');
        throw Error('INJECTED_POST_COMMIT_ACK_FAILURE');
      }
      return persisted;
    }},
  };
  vm.runInNewContext(source,{exports:local,structuredClone,process:{cwd:()=>cwd,env:{},stdin:{isTTY:true},stdout:{isTTY:true},stderr:{isTTY:true}},
    console:{log:s=>calls.output.push(JSON.parse(s))},require(name){assert.ok(name in dependencies,name);return dependencies[name];}});
  return{calls,store,cwd,get result(){return result;},run:()=>local.runLocalExperiment(['--site','12345','--vehicle','q7-fixture','--dispatch-start',(options.capture??fixture).kraken.vehicles[0].plannedDispatches[0].start,...(options.dry?[]:['--execute-supervised'])])};
}
function report(h){return h.calls.output.at(-1);}
function assertPreserved(h,status){
  const r=report(h);assert.equal(r.classification,'submitted-representation-preserved');assert.equal(r.apiWrite.status,'accepted');
  assert.equal(r.ownershipPersistence.status,status);assert.equal(r.writeReady,false);assert.equal(r.rollbackProven,false);
  assert.equal(h.calls.writes,1);assert.equal(h.calls.ownershipReads,1);
  assert.equal(r.ownershipPersistence.writeReady,false);assert.equal(r.ownershipPersistence.rollbackProven,false);
  assert.equal(r.initialRecord,undefined);assert.equal(r.journalCompletion,undefined);assert.equal(r.ownershipPersistence.snapshot,undefined);
}

for(const timing of ['before','after'])test(`unexpected ${timing}-commit throw preserves execution with indeterminate ownership and no retry`,async()=>{
  const h=await harness({persistenceThrow:timing});await h.run();
  assertPreserved(h,'indeterminate');
  const summary=report(h).ownershipPersistence;
  assert.equal(summary.confirmation,'confirmed');
  assert.equal(summary.code,'OWNERSHIP_ORCHESTRATION_EXCEPTION');
  assert.equal(summary.stage,'persistence');
  assert.equal(h.calls.persist,1);assert.equal(h.calls.runs,1);
  assert.equal(h.calls.events.filter(e=>e==='claim').length,1);
  assert.doesNotMatch(JSON.stringify(h.calls.output),/INJECTED|SECRET|stack|persisted|already-persisted/);
  // Inspection is test-only and happens after reporting; orchestration never
  // reads current ownership to infer success or replace its captured precondition.
  const file=path.join(h.cwd,'.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite');
  if(timing==='before')assert.equal(fs.existsSync(file),false);
  else assert.equal(h.store.readOwnership(file,'12345').status,'available');
});

test('real completed B2 result flows once to trusted persistence, then evidence-only replay without another POST',async()=>{
  const options={},h=await harness(options);await h.run();assertPreserved(h,'persisted');assert.equal(h.calls.persist,1);
  assert.ok(h.calls.events.indexOf('durable-capability')<h.calls.events.indexOf('persist'));
  const file=path.join(h.cwd,'.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite');
  const before=JSON.stringify(h.store.readOwnership(file,'12345'));
  options.replay=true;await h.run();assertPreserved(h,'already-persisted');assert.equal(h.calls.persist,2);
  assert.equal(JSON.stringify(h.store.readOwnership(file,'12345')),before);
});
test('complete available Stage A snapshot/historyDigest is returned unchanged, not rebased',async()=>{
  const a=await harness();await a.run();
  const snapshot=a.store.readOwnership(path.join(a.cwd,'.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite'),'12345').snapshot;
  const capture=structuredClone(fixture);
  capture.before=structuredClone(a.result.record.apiTariffReadBack.observation);
  capture.kraken.vehicles[0].plannedDispatches=[{...capture.kraken.vehicles[0].plannedDispatches[0],start:'2026-09-23T12:00:00+00:00',end:'2026-09-23T13:00:00+00:00'}];
  const h=await harness({capture,ownership:{status:'available',snapshot}});await h.run();
  assert.equal(JSON.stringify(h.result.initialRecord.preparedContext.ownership.snapshot),JSON.stringify(snapshot));
  assertPreserved(h,'conflict');assert.equal(report(h).ownershipPersistence.confirmation,'confirmed');
});
for(const [label,options,classification] of [
  ['dry-run',{dry:true},null],['rejected',{api:{status:'rejected',httpStatus:400}},'request-rejected'],
  ['unknown',{api:{status:'unknown',httpStatus:200}},'write-outcome-unknown'],
  ['insufficient',{readback:'missing'},'read-back-unavailable-or-insufficient'],
  ['transformed',{readback:'transformed'},'accepted-but-transformed-differently'],
])test(`${label} never invokes persistence`,async()=>{
  const h=await harness(options);await h.run();assert.equal(h.calls.persist,0);assert.equal(h.calls.writes,options.dry?0:1);
  if(classification){assert.equal(report(h).classification,classification);assert.equal(report(h).ownershipPersistence.status,'not-attempted');}
});
for(const failure of ['initial','classified'])test(`${failure} journal failure cannot reach persistence or repeat POST`,async()=>{
  const h=await harness({failure});await assert.rejects(h.run());assert.equal(h.calls.persist,0);
  assert.equal(h.calls.writes,failure==='initial'?0:1);assert.equal(h.calls.runs,1);assert.deepEqual(h.calls.output,[]);
});
for(const storeFailure of ['store-failed','indeterminate'])test(`real SQLite ${storeFailure} retains confirmation without retry`,async()=>{
  const h=await harness({storeFailure});await h.run();assertPreserved(h,storeFailure);
  assert.equal(report(h).ownershipPersistence.confirmation,'confirmed');assert.equal(h.calls.persist,1);assert.equal(h.calls.runs,1);
});
for(const stage of ['issuance','finalisation','binding'])test(`${stage} rejection cannot replace execution classification`,async()=>{
  const confirmation=stage==='issuance'?'not-established':'confirmed';
  const h=await harness({persistenceResult:{status:'rejected',stage,confirmation,code:'TEST_REJECTION',writeReady:false,rollbackProven:false}});
  await h.run();assertPreserved(h,'rejected');assert.equal(report(h).ownershipPersistence.confirmation,confirmation);assert.equal(h.calls.runs,1);
});
for(const kind of ['capability','record','snapshot'])test(`substituted ${kind} fails genuine issuer authority with no ownership commit`,async()=>{
  const h=await harness({substitute(r){
    if(kind==='capability')r.journalCompletion={};
    if(kind==='record')r.record={...r.record,mutationId:'substitution'};
    if(kind==='snapshot')r.initialRecord={...r.initialRecord,preparedContext:{...r.initialRecord.preparedContext,ownership:{status:'missing',snapshot:null}}};
  }});await h.run();assertPreserved(h,'rejected');assert.equal(report(h).ownershipPersistence.code,'JOURNAL_COMPLETION_NOT_BOUND');
  assert.equal(fs.existsSync(path.join(h.cwd,'.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite')),false);
});
