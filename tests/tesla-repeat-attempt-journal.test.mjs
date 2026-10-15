import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
    {exports,Error,structuredClone,require(name){if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
      const native={'node:fs/promises':io,'node:path':path,'node:crypto':crypto};assert.ok(name in native,`No external dependency: ${name}`);return native[name];}});return exports;}
function loadWithIo(file,filesystem){const cache=new Map();function isolated(value){value=path.resolve(value);if(cache.has(value))return cache.get(value);const exports={};cache.set(value,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(value,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
    {exports,Error,structuredClone,require(name){if(name.startsWith('.'))return isolated(path.resolve(path.dirname(value),name+'.ts'));
      const native={'node:fs/promises':filesystem,'node:path':path,'node:crypto':crypto};assert.ok(name in native);return native[name];}});return exports;}return isolated(file);}
const records=load('src/lib/tesla-tariff/linked-experiment-records.ts');
const {runSupervisedExperiment}=load('src/lib/tesla-tariff/supervised-experiment.ts');
const {prepareMutationContext}=load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const repeat=load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
const {ownershipFingerprint:hash}=load('src/lib/tesla-tariff/ownership-transition.ts');
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8'));
const site=load('src/lib/site/current-site.ts').currentSite;
const selection={energySiteId:'12345',assetId:'q7-fixture',dispatchStart:'2026-09-23T08:00:00+00:00'};
const missing={status:'missing'};
function emptyOwnership(){const generation='11111111-1111-4111-8111-111111111111',evidence={version:1,energySiteId:'12345',timeZone:'Europe/London',
  createdAt:'2026-09-23T07:00:00Z',updatedAt:'2026-09-23T07:00:00Z',validUntil:'2026-09-24T00:00:00Z',basis:'confirmed-write-readback',
  baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[]};
  return{status:'available',snapshot:{version:2,generation,evidence,checksum:hash({generation,evidence}),historyDigest:'e'.repeat(64)}};}
async function pair(mutationId,write='rejected'){
  let clock=Date.parse('2026-09-23T08:12:00Z'),initial,classified,review;
  const now=()=>new Date(clock).toISOString();
  const ports={now,journalRecords:records,
    async capture(){const c=structuredClone(fixture);c.before.source.observedAt=now();c.kraken.lastSuccessfulUpdate=now();return c;},
    prepareContext:c=>prepareMutationContext({site,selection,capture:c},{now,readOwnership:async()=>missing,newMutationId:()=>mutationId}),
    challenge:value=>hash(value),async confirm(r,challenge){review=r;clock+=1000;return{challenge,automaticRollbackUnproven:true,manualAppRecoveryMayBeRequired:true};},
    async claim(_site,value){initial=value;return{async finish(result){classified=result;return{};}};},
    async write(){clock+=1000;return write==='rejected'?{status:'rejected',httpStatus:403}:write==='unknown'?{status:'unknown',httpStatus:null}:{status:'accepted',httpStatus:200};},
    async readBack(){clock+=1000;if(write!=='accepted')throw Error('UNAVAILABLE');return{...structuredClone(fixture.before),source:{...fixture.before.source,observedAt:now()},tariff:structuredClone(review.proposal.bound.representation)};}};
  await runSupervisedExperiment({site,selection,mode:'execute-supervised',authority:'supervised-experiment'},ports);
  return{initial,classified};
}
async function sandbox(fn){const created=await io.mkdtemp(path.join(os.tmpdir(),'hep-repeat-attempt-')),dir=await io.realpath(created);try{await fn(dir);}finally{await io.rm(dir,{recursive:true,force:true});}}
const bytes=async file=>io.readFile(file);

test('immutable ambiguous legacy journal permanently blocks successor claims',()=>sandbox(async dir=>{
  const p=await pair('legacy-attempt','unknown'),file=path.join(dir,'site-12345.jsonl');
  await io.writeFile(file,JSON.stringify(p.initial)+'\n'+JSON.stringify(p.classified)+'\n');const before=await bytes(file);
  const eligibility=await repeat.repeatAttemptEligibility(dir,'12345',missing);
  assert.equal(eligibility.status,'blocked');assert.equal(eligibility.code,'PRIOR_OUTCOME_AMBIGUOUS');
  const next=await pair('next-attempt');await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',next.initial,missing,dir),/PRIOR_OUTCOME_AMBIGUOUS/);
  assert.deepEqual(await bytes(file),before);assert.deepEqual((await io.readdir(dir)).sort(),['site-12345.jsonl']);
}));

test('rejected legacy mutation identity cannot be reused before a new claim is created',()=>sandbox(async dir=>{
  const legacy=await pair('legacy-rejected'),file=path.join(dir,'site-12345.jsonl');
  await io.writeFile(file,JSON.stringify(legacy.initial)+'\n'+JSON.stringify(legacy.classified)+'\n');const before=await bytes(file);
  assert.equal((await repeat.repeatAttemptEligibility(dir,'12345',missing)).code,'PRIOR_REQUEST_REJECTED');
  await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',legacy.initial,missing,dir),/DUPLICATE_MUTATION_ID/);
  assert.deepEqual(await bytes(file),before);
  assert.deepEqual((await io.readdir(dir)).sort(),['site-12345.jsonl']);
}));

test('retained chain with a legacy/repeat mutation collision is invalid even when links and checksums are rebuilt',()=>sandbox(async dir=>{
  const legacy=await pair('same-mutation'),claim=await repeat.claimRepeatAttempt(dir,'12345',legacy.initial,missing,dir);await claim.finish(legacy.classified);
  await io.writeFile(path.join(dir,'site-12345.jsonl'),JSON.stringify(legacy.initial)+'\n'+JSON.stringify(legacy.classified)+'\n');
  const markerFile=path.join(dir,'site-12345-attempt-same-mutation.complete'),marker=JSON.parse(await io.readFile(markerFile,'utf8'));
  marker.previousAttemptId=`legacy:${legacy.initial.initialRecordId}`;delete marker.checksum;marker.checksum=hash(marker);
  await io.writeFile(markerFile,JSON.stringify(marker)+'\n');
  assert.equal((await repeat.repeatAttemptEligibility(dir,'12345',missing)).code,'HISTORICAL_JOURNAL_INVALID');
}));

test('claim success follows file fsync and directory fsync; directory-sync uncertainty remains consumed',()=>sandbox(async root=>{
  const initial=await pair('durable-attempt'),operations=[];let failClaimDirectorySync=false,target='';
  const filesystem={...io,
    async mkdir(directory,options){operations.push(`mkdir:${path.basename(directory)}`);return io.mkdir(directory,options);},
    async open(file,flags,...args){const name=path.basename(file);operations.push(`open:${flags}:${name}`);const handle=await io.open(file,flags,...args);
      return{writeFile:async(...values)=>{operations.push(`write:${name}`);return handle.writeFile(...values);},
        sync:async()=>{operations.push(`sync:${name}`);if(failClaimDirectorySync&&path.resolve(file)===path.resolve(target))throw Error('INJECTED_DIRECTORY_SYNC');return handle.sync();},
        close:async()=>{operations.push(`close:${name}`);return handle.close();}};}};
  const api=loadWithIo('src/lib/tesla-tariff/repeat-attempt-journal.ts',filesystem);
  target=path.join(root,'successful');await api.claimRepeatAttempt(target,'12345',initial.initial,missing,root);
  const activeSync=operations.indexOf('sync:site-12345-attempt.active');
  const journalSync=operations.indexOf('sync:site-12345-attempt-durable-attempt.jsonl');
  const directorySync=operations.lastIndexOf('sync:successful');
  assert.ok(activeSync>=0&&journalSync>activeSync&&directorySync>journalSync);
  assert.ok(operations.indexOf(`sync:${path.basename(root)}`)<activeSync,'new directory parent entry synced before claim files');
  target=path.join(root,'uncertain');failClaimDirectorySync=true;
  await assert.rejects(api.claimRepeatAttempt(target,'12345',initial.initial,missing,root),/INJECTED_DIRECTORY_SYNC/);
  assert.deepEqual((await io.readdir(target)).sort(),['site-12345-attempt-durable-attempt.jsonl','site-12345-attempt.active']);
  assert.equal((await api.repeatAttemptEligibility(target,'12345',missing)).code,'ATTEMPT_IN_PROGRESS');
}));

test('an EEXIST claimant independently syncs the parent before success when the creator sync fails',()=>sandbox(async root=>{
  const initial=await pair('concurrent-durable-attempt');
  const target=path.join(root,'concurrent');
  let releaseCreatorSync,announceCreatorSync;
  const creatorSyncStarted=new Promise(resolve=>{announceCreatorSync=resolve;});
  const creatorSyncRelease=new Promise((resolve,reject)=>{releaseCreatorSync={resolve,reject};});
  let parentSyncCalls=0,joiningParentSyncCompleted=false;
  const filesystem={...io,
    async open(file,flags,...args){const handle=await io.open(file,flags,...args);
      return{writeFile:(...values)=>handle.writeFile(...values),
        sync:async()=>{
          if(flags==='r'&&path.resolve(file)===path.resolve(root)){
            parentSyncCalls+=1;
            if(parentSyncCalls===2){announceCreatorSync();await creatorSyncRelease;}
            else if(parentSyncCalls===4){await handle.sync();joiningParentSyncCompleted=true;return;}
          }
          return handle.sync();
        },
        close:()=>handle.close()};}};
  const api=loadWithIo('src/lib/tesla-tariff/repeat-attempt-journal.ts',filesystem);

  const creator=api.claimRepeatAttempt(target,'12345',initial.initial,missing,root);
  await creatorSyncStarted;
  const joiningClaim=await api.claimRepeatAttempt(target,'12345',initial.initial,missing,root);
  assert.equal(joiningParentSyncCompleted,true,'EEXIST claimant completed its own parent fsync before returning');
  assert.equal(parentSyncCalls,4);

  releaseCreatorSync.reject(Error('INJECTED_CREATOR_PARENT_SYNC_FAILURE'));
  await assert.rejects(creator,/INJECTED_CREATOR_PARENT_SYNC_FAILURE/);
  assert.equal((await api.repeatAttemptEligibility(target,'12345',missing)).code,'ATTEMPT_IN_PROGRESS');
  assert.ok(joiningClaim);
}));

test('nested claimant independently syncs every ancestor through the durable root',()=>sandbox(async root=>{
  const initial=await pair('nested-durable-attempt');
  const ancestor=path.join(root,'ancestor'),target=path.join(ancestor,'journals');
  let releaseCreatorSync,announceCreatorSync;
  const creatorSyncStarted=new Promise(resolve=>{announceCreatorSync=resolve;});
  const creatorSyncRelease=new Promise((resolve,reject)=>{releaseCreatorSync={resolve,reject};});
  let rootSyncCalls=0,joiningAncestorSync=false,joiningRootSync=false;
  const filesystem={...io,
    async open(file,flags,...args){const handle=await io.open(file,flags,...args);
      return{writeFile:(...values)=>handle.writeFile(...values),
        sync:async()=>{
          if(flags==='r'&&path.resolve(file)===path.resolve(root)){
            rootSyncCalls+=1;
            if(rootSyncCalls===2){announceCreatorSync();await creatorSyncRelease;}
            else if(rootSyncCalls===4){await handle.sync();joiningRootSync=true;return;}
          }
          if(flags==='r'&&path.resolve(file)===path.resolve(ancestor)){
            await handle.sync();joiningAncestorSync=true;return;
          }
          return handle.sync();
        },
        close:()=>handle.close()};}};
  const api=loadWithIo('src/lib/tesla-tariff/repeat-attempt-journal.ts',filesystem);

  const creator=api.claimRepeatAttempt(ancestor,'12345',initial.initial,missing,root);
  await creatorSyncStarted;
  const nestedClaim=await api.claimRepeatAttempt(target,'12345',initial.initial,missing,root);
  assert.equal(joiningAncestorSync,true,'nested claimant synced the existing ancestor');
  assert.equal(joiningRootSync,true,'nested claimant synced the durable root after the ancestor');
  assert.equal(rootSyncCalls,4);

  releaseCreatorSync.reject(Error('INJECTED_CREATOR_ROOT_SYNC_FAILURE'));
  await assert.rejects(creator,/INJECTED_CREATOR_ROOT_SYNC_FAILURE/);
  assert.equal((await api.repeatAttemptEligibility(target,'12345',missing)).code,'ATTEMPT_IN_PROGRESS');
  assert.ok(nestedClaim);
}));

test('physical containment rejects symlinked roots, ancestors and journal directories',()=>sandbox(async root=>{
  const initial=await pair('symlink-escape'),trusted=path.join(root,'trusted'),external=path.join(root,'external');
  await io.mkdir(trusted);await io.mkdir(external);

  const rootLink=path.join(root,'trusted-link');await io.symlink(trusted,rootLink);
  await assert.rejects(repeat.claimRepeatAttempt(path.join(rootLink,'journals'),'12345',initial.initial,missing,rootLink),/UNSAFE_JOURNAL_PATH/);

  const escape=path.join(trusted,'escape');await io.symlink(external,escape);
  await assert.rejects(repeat.claimRepeatAttempt(path.join(escape,'journals'),'12345',initial.initial,missing,trusted),/UNSAFE_JOURNAL_PATH/);
  assert.deepEqual(await io.readdir(external),[],'intermediate symlink created no external artifacts');

  const journalLink=path.join(trusted,'journals-link');await io.symlink(external,journalLink);
  await assert.rejects(repeat.claimRepeatAttempt(journalLink,'12345',initial.initial,missing,trusted),/UNSAFE_JOURNAL_PATH/);
  assert.deepEqual(await io.readdir(external),[],'journal-directory symlink created no external artifacts');
}));

test('symlink substitution during directory preparation fails before claim artifacts',()=>sandbox(async root=>{
  const initial=await pair('substituted-path'),trusted=path.join(root,'trusted'),external=path.join(root,'external');
  await io.mkdir(trusted);await io.mkdir(external);
  const ancestor=path.join(trusted,'ancestor'),target=path.join(ancestor,'journals');
  let substituted=false;
  const filesystem={...io,async mkdir(directory,options){const result=await io.mkdir(directory,options);
    if(path.resolve(directory)===path.resolve(ancestor)&&!substituted){substituted=true;await io.rmdir(directory);await io.symlink(external,directory);}
    return result;}};
  const api=loadWithIo('src/lib/tesla-tariff/repeat-attempt-journal.ts',filesystem);
  await assert.rejects(api.claimRepeatAttempt(target,'12345',initial.initial,missing,trusted),/UNSAFE_JOURNAL_PATH/);
  assert.equal(substituted,true);assert.deepEqual(await io.readdir(external),[]);
}));

test('atomic site claim rejects concurrency; completed rejection permits a distinct successor after restart',()=>sandbox(async dir=>{
  const a=await pair('attempt-A'),b=await pair('attempt-B');
  const claim=await repeat.claimRepeatAttempt(dir,'12345',a.initial,missing,dir);
  assert.equal((await repeat.repeatAttemptEligibility(dir,'12345',missing)).code,'ATTEMPT_IN_PROGRESS');
  await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',b.initial,missing,dir),error=>error?.code==='EEXIST'||error?.message==='ATTEMPT_IN_PROGRESS');
  await claim.finish(a.classified);
  const afterRestart=await repeat.repeatAttemptEligibility(dir,'12345',missing);
  assert.equal(afterRestart.status,'eligible');assert.equal(afterRestart.code,'PRIOR_REQUEST_REJECTED');
  await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',a.initial,missing,dir),/DUPLICATE_MUTATION_ID/);
  assert.equal((await io.readdir(dir)).some(name=>name.endsWith('.active')),false);
  const second=await repeat.claimRepeatAttempt(dir,'12345',b.initial,missing,dir);await second.finish(b.classified);
  assert.equal((await repeat.repeatAttemptEligibility(dir,'12345',missing)).status,'eligible');
  const names=(await io.readdir(dir)).sort();assert.equal(names.filter(n=>n.endsWith('.jsonl')).length,2);assert.equal(names.filter(n=>n.endsWith('.complete')).length,2);
  assert.equal(names.some(n=>n.endsWith('.active')),false);
}));

test('duplicate mutation identity and incomplete journals fail closed without rewriting history',()=>sandbox(async dir=>{
  const a=await pair('attempt-A'),claim=await repeat.claimRepeatAttempt(dir,'12345',a.initial,missing,dir);
  const journal=path.join(dir,'site-12345-attempt-attempt-A.jsonl'),before=await bytes(journal);
  await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',a.initial,missing,dir));
  assert.deepEqual(await bytes(journal),before);
  // Deliberately leave the claim unfinished: a restarted process must not infer an outcome.
  assert.equal((await repeat.repeatAttemptEligibility(dir,'12345',missing)).code,'ATTEMPT_IN_PROGRESS');
  assert.ok(claim);assert.equal((await bytes(journal)).toString().trim().split('\n').length,1);
}));

test('ambiguous and confirmed temporary outcomes block successors; ownership must be resolved',()=>sandbox(async dir=>{
  for(const [write,code] of [['unknown','PRIOR_OUTCOME_AMBIGUOUS'],['accepted','RESTORATION_REQUIRED']]){
    const child=path.join(dir,write);await io.mkdir(child);const a=await pair(`attempt-${write}`,write);
    const claim=await repeat.claimRepeatAttempt(child,'12345',a.initial,missing,child);await claim.finish(a.classified);
    assert.equal((await repeat.repeatAttemptEligibility(child,'12345',missing)).code,code);
  }
  const a=await pair('ownership-blocked');
  for(const ownership of [{status:'invalid',code:'OWNERSHIP_STORE_INVALID'},{status:'unavailable',code:'OWNERSHIP_STORE_UNAVAILABLE'}]){
    assert.equal((await repeat.repeatAttemptEligibility(path.join(dir,'none'), '12345',ownership)).code,'OWNERSHIP_UNRESOLVED');
    await assert.rejects(repeat.claimRepeatAttempt(path.join(dir,'none'),'12345',a.initial,ownership,dir),/OWNERSHIP_UNRESOLVED/);
  }
  // A valid but substituted snapshot cannot replace the Stage A missing-state capture.
  await assert.rejects(repeat.claimRepeatAttempt(path.join(dir,'substitution'),'12345',a.initial,emptyOwnership(),dir),/OWNERSHIP_UNRESOLVED/);
}));

test('tampered, disconnected or partially classified retained history is never repaired',()=>sandbox(async dir=>{
  const a=await pair('attempt-A'),claim=await repeat.claimRepeatAttempt(dir,'12345',a.initial,missing,dir);await claim.finish(a.classified);
  const marker=path.join(dir,'site-12345-attempt-attempt-A.complete'),value=JSON.parse(await io.readFile(marker,'utf8'));
  value.previousAttemptId='mutation:missing';await io.writeFile(marker,JSON.stringify(value)+'\n');
  const before=await bytes(marker),eligibility=await repeat.repeatAttemptEligibility(dir,'12345',missing);
  assert.equal(eligibility.code,'HISTORICAL_JOURNAL_INVALID');assert.deepEqual(await bytes(marker),before);
  const b=await pair('attempt-B');await assert.rejects(repeat.claimRepeatAttempt(dir,'12345',b.initial,missing,dir),/HISTORICAL_JOURNAL_INVALID/);
  assert.deepEqual(await bytes(marker),before);
}));
