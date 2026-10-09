import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,structuredClone,require:n=>{assert.ok(Object.hasOwn(deps,n),n);return deps[n];}});return exports;}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const {updateScheduleObservation:update}=load('src/lib/kraken/schedule-observation.ts',{'../tariff/resolve-economic-model':resolver});
const slot=(start='2026-10-09T13:00:00Z',end='2026-10-09T14:00:00Z',type='SMART',energyAddedKwh='-2.3000')=>({start,end,type,energyAddedKwh});
const read=(sessions=[slot()],minute=0)=>({scopeId:'synthetic-site',startedAt:`2026-10-09T12:${String(minute).padStart(2,'0')}:00Z`,retrievedAt:`2026-10-09T12:${String(minute).padStart(2,'0')}:05Z`,status:'complete',provenance:'authenticated-query',vehicles:[{id:'ev-a',name:'EV A',plannedDispatches:sessions}]});
const initial=()=>update(null,read()).current;
for(const [name,sessions] of [
  ['added',[slot(),slot('2026-10-09T15:00:00Z','2026-10-09T16:00:00Z')]],
  ['removed',[]],['shortened',[slot(undefined,'2026-10-09T13:30:00Z')]],
  ['extended',[slot(undefined,'2026-10-09T15:00:00Z')]],['type',[slot(undefined,undefined,'BOOST')]],
])test(`${name} produces exact observed difference, not a cancellation event`,()=>{const r=update(initial(),read(sessions,1));assert.equal(r.status,'changed');assert.equal(r.revision.coverageChanged,true);assert.ok(r.revision.added.length||r.revision.removed.length);});
test('energy precision retained and changes structural identity, not interval coverage',()=>{const r=update(initial(),read([slot(undefined,undefined,undefined,'-2.30')],1));assert.equal(r.status,'changed');assert.equal(r.revision.coverageChanged,false);assert.equal(r.current.vehicles[0].sessions[0].energyAddedKwh,'-2.30');});
test('ordering and equivalent offsets are unchanged; latest original spelling is retained',()=>{
  const a=slot(),b=slot('2026-10-09T15:00:00Z','2026-10-09T16:00:00Z');
  const p=update(null,read([a,b])).current;
  const r=update(p,read([b,{...a,start:'2026-10-09T14:00:00+01:00',end:'2026-10-09T15:00:00+01:00'}],1));
  assert.equal(r.status,'unchanged');assert.equal(r.current.contentKey,p.contentKey);assert.ok(r.current.vehicles[0].sessions.some(s=>s.start.includes('+01:00')));
});
test('split/combined and overlapping slots have equivalent coverage but distinct structure',()=>{
  const r=update(initial(),read([slot(undefined,'2026-10-09T13:30:00Z'),slot('2026-10-09T13:30:00Z')],1));
  assert.equal(r.status,'changed');assert.equal(r.revision.coverageChanged,false);
  const combined=update(r.current,read([slot()],2));assert.equal(combined.revision.coverageChanged,false);
  const overlap=update(initial(),read([slot(),slot('2026-10-09T13:10:00Z','2026-10-09T13:20:00Z')],1));assert.equal(overlap.revision.coverageChanged,false);
});
test('failed, missing, null and disk/manual input retain prior last-known state; explicit empty succeeds',()=>{
  const p=initial();
  for(const mutate of [r=>{r.status='failed';},r=>{r.status='incomplete';},r=>{r.vehicles[0].plannedDispatches=null;},r=>{delete r.vehicles[0].plannedDispatches;},r=>{r.provenance='disk';},r=>{r.provenance='manual';},r=>{r.vehicles=null;}]){
    const r=read([],1);mutate(r);const out=update(p,r);assert.equal(out.status,'unknown');assert.equal(out.lastKnown,true);assert.equal(out.current.contentKey,p.contentKey);assert.equal(out.current.retrievedAt,p.retrievedAt);assert.equal(out.revision,null);
  }
  assert.equal(update(p,read([],1)).status,'changed');assert.equal(update(null,read([])).status,'initial');
});
test('vehicle removal/reassignment is attributed by ID; rename alone is not schedule change',()=>{
  const p=initial(),r=read([slot()],1);r.vehicles[0].id='ev-b';const out=update(p,r);
  assert.equal(out.revision.removedVehicles[0],'ev-a');assert.equal(out.revision.addedVehicles[0],'ev-b');assert.equal(out.revision.coverageChanged,true);
  const renamed=read([slot()],1);renamed.vehicles[0].name='New label';assert.equal(update(p,renamed).status,'unchanged');
  const empty=read([],1);empty.vehicles=[];assert.equal(update(p,empty).revision.removedVehicles[0],'ev-a');
});
test('partial intervals and physical charging changes do not broaden or truncate coverage',()=>{
  const sessions=[slot('2026-10-09T13:04:12Z','2026-10-09T13:24:56Z')],r=read(sessions);r.vehicles[0].activePower=7;
  const p=update(null,r).current;const next=read(sessions,1);next.vehicles[0].activePower=0;
  assert.equal(update(p,next).status,'unchanged');assert.equal(p.vehicles[0].sessions[0].startMs,Date.parse(sessions[0].start));
});
test('DST folds preserve distinct instants and spring gap uses explicit offsets',()=>{
  const fold=[slot('2026-10-25T01:00:00+01:00','2026-10-25T01:30:00+01:00'),slot('2026-10-25T01:00:00+00:00','2026-10-25T01:30:00+00:00')];
  const p=update(null,read(fold)).current;assert.equal(p.vehicles[0].sessions.length,2);assert.notEqual(p.vehicles[0].sessions[0].startMs,p.vehicles[0].sessions[1].startMs);
  const gap=update(null,read([slot('2026-03-29T00:30:00Z','2026-03-29T02:30:00+01:00')])).current.vehicles[0].sessions[0];assert.equal(gap.endMs-gap.startMs,3600000);
});
test('duplicates refresh retrieval without revisions; overlapping/out-of-order reads fail closed',()=>{
  const p=initial(),same=update(p,read([slot()],1));assert.equal(same.status,'unchanged');assert.notEqual(same.current.retrievedAt,p.retrievedAt);
  assert.equal(update(same.current,read()).code,'OVERLAPPING_OR_OUT_OF_ORDER');
  const overlap=read([slot()],1);overlap.startedAt=p.retrievedAt;assert.equal(update(p,overlap).status,'unknown');
  const wrong=read([slot()],1);wrong.scopeId='another-site';assert.equal(update(p,wrong).code,'SCOPE_MISMATCH');
});
test('invalid calendar/time, duplicate IDs/rows, sparse and malformed data fail closed',()=>{
  for(const mutate of [r=>{r.vehicles[0].plannedDispatches[0].start='2026-02-30T00:00:00Z';},r=>{r.vehicles.push(r.vehicles[0]);},r=>{r.vehicles[0].plannedDispatches.push(slot());},r=>{r.vehicles[0].plannedDispatches=new Array(1);},r=>{r.vehicles[0].plannedDispatches[0].energyAddedKwh=NaN;}]){const r=read();mutate(r);assert.equal(update(null,r).status,'unknown');}
});
test('returned graph is detached, immutable and deterministic',()=>{
  const r=read(),a=update(null,r),b=update(null,r);assert.equal(JSON.stringify(a),JSON.stringify(b));const before=JSON.stringify(a);
  r.vehicles[0].plannedDispatches[0].start='changed';assert.equal(JSON.stringify(a),before);
  assert.throws(()=>{a.current.vehicles[0].sessions[0].type='BOOST';},TypeError);assert.equal(JSON.stringify(a),before);
});

test('QA accessor substitution is rejected without invoking getter or freezing later Date',()=>{
  const p=initial(),r=read([slot()],1),date=new Date('2026-10-09T13:00:00Z');let calls=0;
  Object.defineProperty(r.vehicles[0].plannedDispatches[0],'start',{enumerable:true,get(){return ++calls===1?'2026-10-09T13:00:00Z':date;}});
  const out=update(p,r),before=JSON.stringify(out);
  assert.equal(out.status,'unknown');assert.equal(out.code,'INVALID_READ');assert.equal(out.current.contentKey,p.contentKey);
  assert.equal(out.revision,null);assert.equal(calls,0);assert.equal(Object.isFrozen(date),false);
  date.setUTCFullYear(2040);assert.equal(JSON.stringify(out),before);assert.equal(calls,0);
});
test('accessors anywhere are rejected without execution, including status and unused metadata',()=>{
  for(const target of ['status','vehicles','energy','extra']){
    const r=read();let calls=0;const object=target==='energy'?r.vehicles[0].plannedDispatches[0]:r;
    Object.defineProperty(object,target==='energy'?'energyAddedKwh':target,{enumerable:true,get(){calls++;throw Error('must not run');}});
    assert.equal(update(null,r).code,'INVALID_READ');assert.equal(calls,0);
  }
});
test('unsupported built-ins, prototypes, cycles and sparse arrays fail closed without freezing caller objects',()=>{
  class Custom { constructor(){this.value='x';} }
  const cycle={};cycle.self=cycle;
  for(const value of [new Date(),new Map(),new Set(),new Uint8Array([1]),new ArrayBuffer(2),/x/,new String('x'),new Custom(),Object.create({inherited:'x'}),cycle,new Array(1)]){
    const r=read([],1);r.extra=value;const p=initial();const out=update(p,r);
    assert.equal(out.status,'unknown');assert.equal(out.current.contentKey,p.contentKey);assert.equal(out.revision,null);
    assert.equal(Object.isFrozen(value),false);assert.equal(Object.isFrozen(r),false);
  }
});
test('accepted primitives are detached and agree with absolute times/key; caller and prior copies stay mutable',()=>{
  const previous=structuredClone(initial()),r=read([slot('2026-10-09T14:00:00+01:00','2026-10-09T15:30:00+01:00')],1);
  const out=update(previous,r),before=JSON.stringify(out),session=out.current.vehicles[0].sessions[0];
  assert.equal(session.startMs,Date.parse(session.start));assert.equal(session.endMs,Date.parse(session.end));
  assert.ok(out.current.contentKey.includes(String(session.startMs)));
  previous.vehicles[0].sessions[0].type='mutated';r.vehicles[0].plannedDispatches[0].start='mutated';
  assert.equal(Object.isFrozen(previous.vehicles[0].sessions[0]),false);assert.equal(Object.isFrozen(r),false);
  assert.equal(JSON.stringify(out),before);assert.throws(()=>{session.start='mutated';},TypeError);
});
