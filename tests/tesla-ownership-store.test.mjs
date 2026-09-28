import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';
const now='2026-09-25T11:00:00Z';
const at=t=>`2026-09-25T${t}:00+01:00`;
function loader(shared={}, filesystem=io) {
  const modules=new Map();
  function load(file) {
    file=path.resolve(file);if(modules.has(file))return modules.get(file);
    const exports={};modules.set(file,exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
      {exports,globalThis:shared,structuredClone,Date,process:{cwd:()=>'/unused'},require(name){
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));
        assert.ok(['node:fs/promises','node:path','node:crypto'].includes(name),`No transport/executor: ${name}`);
        return name==='node:fs/promises'?filesystem:name==='node:path'?{default:path}:crypto;
      }});return exports;
  }return load;
}
function side(sell=false){return {version:1,name:'Synthetic tariff',utility:'Test',currency:'GBP',
  seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{night:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,fromMinute:0,toHour:6,toMinute:0}]},day:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,fromMinute:0,toHour:0,toMinute:0}]}}}},
  energy_charges:{Annual:{rates:{night:sell?0.17:0.02993,day:sell?0.17:0.25177}}}};}
function receipt(load){
  const site=structuredClone(load('src/lib/site/current-site.ts').currentSite);
  const before={source:{kind:'tesla-site-info',energySiteId:'12345',observedAt:now,timeZone:'Europe/London'},tariff:{...side(),sell_tariff:side(true)},diagnostics:[],rollbackProven:false};
  const result=load('src/lib/tesla-tariff/reconciliation.ts').reconcileTeslaTariff({site,energySiteId:'12345',now,comparisonDomain:{start:now,end:at('18:00')},observation:before,
    kraken:{stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'q7',name:'Q7',plannedDispatches:[{start:at('14:00'),end:at('17:00'),type:'SMART'}]}]}});
  assert.equal(result.status,'update-required');
  return {proposal:result.proposal,before,readback:{...structuredClone(before),tariff:structuredClone(result.proposal.bound.representation)},
    writeOutcome:'submitted-representation-preserved',submittedAt:now,recordedAt:now,expectedGeneration:null};
}
async function sandbox(fn){const dir=await io.mkdtemp(path.join(os.tmpdir(),'hep-ownership-'));try{await fn(dir);}finally{await io.rm(dir,{recursive:true,force:true});}}

// Synthetic confirmed readback only; no production ownership writer is connected.
function followup(load, saved, observation, time, dispatches, domain={start:time,end:at('18:00')}) {
  const before={...structuredClone(observation),source:{...observation.source,observedAt:time}};
  const result=load('src/lib/tesla-tariff/reconciliation.ts').reconcileTeslaTariff({
    site:structuredClone(load('src/lib/site/current-site.ts').currentSite),energySiteId:'12345',now:time,
    comparisonDomain:domain,observation:before,managedImport:saved.evidence,
    kraken:{stale:false,lastSuccessfulUpdate:time,vehicles:[{id:'reoptimised-ev',name:'EV',plannedDispatches:dispatches}]},
  });
  assert.equal(result.status,'update-required');assert.ok(result.proposal.structurallyValid);
  assert.equal(result.writeReady,false);assert.equal(result.rollbackProven,false);assert.equal(result.writePayload,null);
  assert.ok(result.blockers.includes('ROLLBACK_UNPROVEN'));assert.ok(result.blockers.includes('BOUNDED_FORECAST'));
  return {proposal:result.proposal,before,readback:{...structuredClone(before),tariff:structuredClone(result.proposal.bound.representation)},
    writeOutcome:'submitted-representation-preserved',submittedAt:time,recordedAt:time,expectedGeneration:saved.generation};
}

test('record survives independent module reload, stores only bounded economics/digests with owner-only permissions',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),r=receipt(load);
  assert.equal((await store.read('12345')).status,'missing');
  const saved=await store.recordConfirmed(r);
  const reloaded=loader()('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir);
  assert.equal(JSON.stringify((await reloaded.read('12345')).snapshot),JSON.stringify(saved));
  assert.equal(saved.evidence.intervals[0].restore.amount,0.25177);assert.equal(saved.evidence.intervals[0].applied.amount,0.0299);
  assert.equal(saved.evidence.intervals[0].start,'2026-09-25T13:00:00.000Z');assert.equal(saved.evidence.intervals.at(-1).end,'2026-09-25T16:00:00.000Z');
  const contents=await io.readFile(path.join(dir,'site-12345.json'),'utf8');
  assert.doesNotMatch(contents,/access_token|refresh_token|Authorization|raw|seasons|energy_charges|Synthetic tariff/);
  assert.equal((await io.stat(path.join(dir,'site-12345.json'))).mode&0o777,0o600);
}));
test('missing, corrupt, partial, incompatible and tampered ownership fail closed without overwriting',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),r=receipt(load);
  const valid=await store.recordConfirmed(r);
  for(const text of ['{','null',JSON.stringify({...valid,version:2}),JSON.stringify({...valid,evidence:{...valid.evidence,version:2}}),JSON.stringify({...valid,evidence:{...valid.evidence,intervals:[]}})]){
    await io.writeFile(path.join(dir,'site-12345.json'),text);
    assert.notEqual((await store.read('12345')).status,'available');
    await assert.rejects(store.recordConfirmed(r),/OWNERSHIP_STORE_UNAVAILABLE/);
    assert.equal(await io.readFile(path.join(dir,'site-12345.json'),'utf8'),text);
  }
}));
test('proposal alone, ambiguous write or mismatched readback cannot create ownership; generation remains absent',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),r=receipt(load);
  assert.equal((await store.read('12345')).status,'missing'); // pure proposal made no file
  for(const mutate of [x=>{x.writeOutcome='write-outcome-unknown';},x=>{x.readback=undefined;},x=>{x.readback.tariff.name='manual change';},x=>{x.readback.source.kind='simulation';},x=>{x.expectedGeneration='old';}]){
    const x=structuredClone(r);mutate(x);await assert.rejects(store.recordConfirmed(x),/OWNERSHIP_/);
    assert.equal((await store.read('12345')).status,'missing');
  }
}));
test('shared queue across module instances holds delayed rename; stale generation cannot overwrite a committed record',()=>sandbox(async dir=>{
  let release,entered,renameCount=0;
  const enteredPromise=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;}),shared={};
  const filesystem={...io,rename:async(...args)=>{renameCount++;entered();await hold;return io.rename(...args);}};
  const a=loader(shared,filesystem),b=loader(shared,filesystem);
  const one=a('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),two=b('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir);
  const r=receipt(a),first=one.recordConfirmed(r);await enteredPromise;
  // A caller may abandon waiting, but the actual commit still owns serialization.
  let finished=false;const second=two.recordConfirmed(r).then(()=>{finished=true;},e=>{finished=true;throw e;});
  await Promise.resolve();assert.equal(finished,false);assert.equal(renameCount,1);
  release();const saved=await first;await assert.rejects(second,/OWNERSHIP_GENERATION_CHANGED/);
  assert.equal((await two.read('12345')).snapshot.generation,saved.generation);assert.equal(renameCount,1);
}));
test('failed atomic replacement preserves prior generation and removes temporary file',()=>sandbox(async dir=>{
  const load=loader(),r=receipt(load),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir);
  const failing=loader({}, {...io,rename:async()=>{throw Error('private filesystem failure');}})('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir);
  await assert.rejects(failing.recordConfirmed(r),/^Error: OWNERSHIP_PERSISTENCE_FAILED$/);
  assert.equal((await store.read('12345')).status,'missing');assert.deepEqual(await io.readdir(dir),[]);
}));

test('later confirmed extension preserves original restoration lineage and commits a new generation',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),first=receipt(load);
  const saved=await store.recordConfirmed(first);
  const proposal=load('src/lib/tesla-tariff/reconciliation.ts').reconcileTeslaTariff({
    site:structuredClone(load('src/lib/site/current-site.ts').currentSite),energySiteId:'12345',now,
    comparisonDomain:{start:now,end:at('18:00')},observation:first.readback,managedImport:saved.evidence,
    kraken:{stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'q7',name:'Q7',plannedDispatches:[{start:at('14:00'),end:at('18:00'),type:'SMART'}]}]},
  }).proposal;
  assert.ok(proposal.structurallyValid);
  const next={...first,proposal,before:first.readback,readback:{...first.readback,tariff:proposal.bound.representation},expectedGeneration:saved.generation};
  const failing=loader({}, {...io,rename:async()=>{throw Error('private failed replacement');}})('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir);
  await assert.rejects(failing.recordConfirmed(next),/^Error: OWNERSHIP_PERSISTENCE_FAILED$/);
  assert.equal((await store.read('12345')).snapshot.generation,saved.generation);
  assert.deepEqual(await io.readdir(dir),['site-12345.json']);
  const updated=await store.recordConfirmed(next);
  assert.notEqual(updated.generation,saved.generation);
  assert.ok(updated.evidence.intervals.every(p=>p.restore.amount===0.25177));
  const retained=updated.evidence.intervals.find(p=>p.start==='2026-09-25T13:00:00.000Z');
  assert.equal(retained.restoreBaselineFingerprint,saved.evidence.intervals[0].restoreBaselineFingerprint);
  assert.equal(updated.evidence.intervals.at(-1).end,'2026-09-25T17:00:00.000Z');
  // A stale writer cannot restore its earlier generation.
  await assert.rejects(store.recordConfirmed(first),/OWNERSHIP_GENERATION_CHANGED/);
  assert.equal((await store.read('12345')).snapshot.generation,updated.generation);
}));

test('advancing clock permits shortening then retirement without losing original restoration lineage',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),first=receipt(load);
  const saved=await store.recordConfirmed(first),original=saved.evidence.intervals[0];
  const short=followup(load,saved,first.readback,at('14:30'),[{start:at('15:00'),end:at('17:00'),type:'SMART'}]);
  const prices=(observation,start,end)=>load('src/lib/tesla-tariff/observed-economic.ts')
    .observedEconomicSignal(observation,{start:at(start),end:at(end)}).signal.import.map(w=>w.price.amount);
  assert.ok(prices(short.readback,'14:00','14:30').every(p=>p===original.applied.amount));
  assert.ok(prices(short.readback,'14:30','15:00').every(p=>p===original.restore.amount));
  assert.ok(prices(short.readback,'15:00','17:00').every(p=>p===original.applied.amount));
  const shortened=await store.recordConfirmed(short);
  assert.equal(shortened.evidence.intervals.length,1);
  const retained=shortened.evidence.intervals[0];
  assert.equal(retained.start,new Date(at('15:00')).toISOString());assert.equal(retained.end,new Date(at('17:00')).toISOString());
  assert.equal(JSON.stringify(retained.restore),JSON.stringify(original.restore));
  assert.equal(retained.restoreBaselineFingerprint,original.restoreBaselineFingerprint);
  assert.equal(shortened.evidence.createdAt,saved.evidence.createdAt);
  // Reload the durable ledger before the next advancing-clock reconciliation.
  const reloaded=(await store.read('12345')).snapshot;
  const removal=followup(load,reloaded,short.readback,at('15:30'),[]);
  assert.ok(prices(removal.readback,'15:00','15:30').every(p=>p===original.applied.amount));
  assert.ok(prices(removal.readback,'15:30','17:00').every(p=>p===original.restore.amount));
  const retired=await store.recordConfirmed(removal);
  assert.equal(retired.evidence.intervals.length,0);
  assert.equal((await store.read('12345')).snapshot.generation,retired.generation);
}));

test('omitting a still-relevant prefix or future tail rejects confirmation and preserves the ledger',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),first=receipt(load);
  const saved=await store.recordConfirmed(first);
  for(const [domain,dispatches] of [
    [{start:at('15:00'),end:at('18:00')},[{start:at('15:30'),end:at('17:00'),type:'SMART'}]],
    [{start:at('14:30'),end:at('16:00')},[{start:at('15:00'),end:at('16:00'),type:'SMART'}]],
  ]) {
    const next=followup(load,saved,first.readback,at('14:30'),dispatches,domain);
    await assert.rejects(store.recordConfirmed(next),/OWNERSHIP_DOMAIN_INCOMPLETE/);
    assert.equal(JSON.stringify((await store.read('12345')).snapshot),JSON.stringify(saved));
    assert.deepEqual(await io.readdir(dir),['site-12345.json']);
  }
}));

test('ownership timestamps strictly validate calendar, clock and offset components without normalization',()=>{
  const {validOwnershipTimestamp:valid}=loader()('src/lib/tesla-tariff/ownership-evidence.ts');
  for(const value of ['2024-02-29T23:59:59Z','2000-02-29T00:00:00Z','2026-09-25T12:00:00.1+01:00',
    '2026-09-25T12:00:00.123-05:30','2026-10-25T01:30:00+01:00','2026-10-25T01:30:00+00:00']) assert.equal(valid(value),true,value);
  for(const value of ['2026-02-30T00:00:00Z','2026-02-29T00:00:00Z','1900-02-29T00:00:00Z',
    '2100-02-29T00:00:00Z','2026-04-31T00:00:00Z','2026-00-01T00:00:00Z','2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z','2026-01-32T00:00:00Z','2026-09-25T24:00:00Z','2026-09-25T23:60:00Z',
    '2026-09-25T23:59:60Z','2026-09-25T12:00:00+24:00','2026-09-25T12:00:00-01:60',
    '2026-09-25T12:00:00','2026-09-25T12:00:00Z\n','2026-09-25T12:00:00.1234Z',null,0]) assert.equal(valid(value),false,String(value));
  assert.equal(Date.parse('2026-10-25T01:30:00+00:00')-Date.parse('2026-10-25T01:30:00+01:00'),3600000);
});

test('every ownership time field rejects impossible dates even when Date.parse would preserve its ordering',()=>{
  const {validOwnership,assertOwnership}=loader()('src/lib/tesla-tariff/ownership-evidence.ts');
  // Explicitly test-seeded evidence: no production ownership creation implied.
  const evidence={version:1,energySiteId:'12345',timeZone:'Europe/London',createdAt:'2026-10-01T00:00:00Z',
    updatedAt:'2026-10-01T01:00:00Z',validUntil:'2026-10-01T03:00:00Z',basis:'confirmed-write-readback',
    baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),
    intervals:[{start:'2026-10-01T01:00:00Z',end:'2026-10-01T02:00:00Z',applied:{amount:0.0299,currency:'GBP',unit:'kWh'},
      restore:{amount:0.2518,currency:'GBP',unit:'kWh'},restoreBaselineFingerprint:'a'.repeat(64)}]};
  assert.equal(validOwnership(evidence),true);
  for(const field of ['createdAt','updatedAt','validUntil','start','end']) {
    const bad=structuredClone(evidence),target=['start','end'].includes(field)?bad.intervals[0]:bad;
    target[field]=target[field].replace('2026-10-01','2026-09-31');
    assert.equal(validOwnership(bad),false,field);
  }
  const observed={source:{energySiteId:'12345',timeZone:'Europe/London',observedAt:'2026-09-31T01:00:00Z'}};
  assert.throws(()=>assertOwnership(evidence,observed,'2026-10-01T01:00:00Z'),/MANAGED_OWNERSHIP_INVALID/);
});

test('invalid receipt timestamps cannot persist ownership',()=>sandbox(async dir=>{
  const load=loader(),store=load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore(dir),r=receipt(load);
  for(const mutate of [
    x=>{x.submittedAt='2026-02-30T00:00:00Z';},x=>{x.recordedAt='2026-02-30T00:00:00Z';},
    x=>{x.before.source.observedAt='2026-02-30T00:00:00Z';},x=>{x.readback.source.observedAt='2026-02-30T00:00:00Z';},
    // These match the original instants under Date.parse, but have no explicit offset.
    x=>{x.submittedAt=now.slice(0,-1);},x=>{x.recordedAt=now.slice(0,-1);},
    x=>{x.readback.source.observedAt=now.slice(0,-1);},
  ]) {
    const bad=structuredClone(r);mutate(bad);
    await assert.rejects(store.recordConfirmed(bad),/OWNERSHIP_CONFIRMATION_INVALID/);
    assert.equal((await store.read('12345')).status,'missing');assert.deepEqual(await io.readdir(dir),[]);
  }
}));
