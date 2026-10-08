import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fixture, historicalFixture, horizon, generatedAt } from './fixtures/eon-offline-evidence.mjs';
function load(path,deps={}) {
  const exports={};
  class ExplicitDate extends Date { constructor(...args){assert.ok(args.length);super(...args);} static now(){throw Error('No clock');} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,Object,structuredClone,Date:ExplicitDate,require(name){assert.ok(Object.hasOwn(deps,name),`No I/O dependency: ${name}`);return deps[name];}});
  return exports;
}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const {adaptEonOfflineEvidence:adapt}=load('src/lib/tariff/eon-offline-evidence.ts',{'./economic-decimal':decimal,'./resolve-economic-model':resolver});
const run=(d=fixture(),h=horizon)=>adapt(d,h,generatedAt);
const at=(r,t,direction='import')=>r.resolution.periods.find(p=>p.direction===direction&&Date.parse(p.start)<=Date.parse(t)&&Date.parse(t)<Date.parse(p.end));
const plain=v=>JSON.parse(JSON.stringify(v));
test('bounded supplied rates resolve exactly, STANDARD is not a price classification',()=>{
  const r=run();assert.equal(r.status,'partial');assert.equal(at(r,horizon.start).consumerPrice.amount,'0.0285');
  assert.equal(at(r,'2026-10-07T05:00:00Z').consumerPrice.amount,'0.23978');
  assert.ok(r.provenance.rateTypes.every(t=>t.rateType==='STANDARD'));
  const d=fixture();d.windows.forEach(w=>w.rateType='IGNORED');assert.deepEqual(plain(run(d).resolution),plain(r.resolution));
});
test('agreement identity and exclusive end do not extend economic coverage',()=>{
  const d=fixture(),r=run(),a=r.model.agreements[0];assert.equal(a.validTo,'2027-01-17T00:00:00Z');assert.equal(a.validFrom,'2026-01-17T00:00:00Z');
  assert.equal(a.productCode,'NEXT_DRIVE_SMART_V5_2');assert.equal(a.tariffCode,'E-TOU-NEXT_DRIVE_SMART_V5_2-G');assert.equal(a.status,'active');assert.equal(r.provenance.agreementMetadata[0].ratesAgreedAt,null);
  assert.equal(at(r,'2026-10-07T00:00:00Z').priceStatus,'unknown');
  const future=run(d,{start:'2027-01-16T23:30:00Z',end:'2027-01-17T00:30:00Z'});assert.ok(future.resolution.periods.every(p=>p.priceStatus==='unknown'));
  // Synthetic window straddling the contractual end: the exact end is excluded.
  const w=d.windows[0];w.period={start:'2027-01-16T23:30:00Z',end:'2027-01-17T00:30:00Z'};w.energy.validity=w.period;d.evidence[1].coverage=[w.period];
  const edge=run(d,w.period);assert.equal(at(edge,w.period.start).priceStatus,'known');assert.equal(at(edge,a.validTo).priceStatus,'unknown');
});
for(const [fraction,cheap,standing] of [['0.05','0.029925','0.6000015'],['0','0.0285','0.57143']]) test(`exact VAT ${fraction}, standing separate from energy`,()=>{
  const d=historicalFixture(fraction),r=run(d,d.windows[0].period);assert.equal(r.status,'partial');assert.equal(r.resolution.periods[0].consumerPrice.amount,cheap);
  assert.equal(r.resolution.standingCharges[0].consumerPrice.amount,standing);assert.ok(!JSON.stringify(r.resolution.signal).includes(standing));
  d.windows[0].energy.price.amount='0.23978';assert.equal(run(d,d.windows[0].period).resolution.periods[0].consumerPrice.amount,fraction==='0.05'?'0.251769':'0.23978');
});
test('inclusive prices are not taxed twice',()=>{const d=historicalFixture('0.05',true);assert.equal(run(d,d.windows[0].period).resolution.periods[0].consumerPrice.amount,'0.0285');});
test('incomplete export and bill cannot manufacture agreement, recurrence, rule or dispatch',()=>{
  const r=run();assert.equal(r.model.agreements.length,1);assert.equal(at(r,horizon.start,'export').priceStatus,'unknown');
  assert.ok(r.diagnostics.includes('EXPORT_AGREEMENT_UNRESOLVED'));assert.ok(r.diagnostics.includes('BILL_NOT_DISPATCH_OR_SCHEDULE_EVIDENCE'));
  assert.ok(r.model.versions.every(v=>v.conditionalRules.length===0&&v.schedule[0].local.kind==='all-day'));
  assert.ok(r.model.evidence.every(e=>e.kind!=='authenticated-dispatch'));assert.ok(r.resolution.periods.every(p=>p.conditional===null));
  assert.equal(r.provenance.observations[0].amount,'0.175');
});
for(const [label,change] of [
  ['wrong supplier',d=>d.agreements[0].supplier='Other'],['transport cannot attest',d=>d.evidence[1].provider='kraken'],
  ['wrong subject',d=>d.evidence[1].subject.supplyRef='different'],['wrong role',d=>d.evidence[1].kind='authenticated-dispatch'],
  ['bill cannot define schedule',d=>d.evidence[1].kind='supplier-bill'],['Tesla cannot define rates',d=>d.evidence[1].kind='tesla-observation'],
  ['missing evidence',d=>d.evidence.splice(1,1)],['invalid calendar',d=>d.windows[0].period.start='2026-02-30T00:00:00Z'],
  ['invalid decimal',d=>d.windows[0].energy.price.amount='NaN'],['missing agreement evidence',d=>d.agreements[0].evidenceIds=[]],
]) test(`${label} fails closed`,()=>{const d=fixture();change(d);const r=run(d);assert.equal(r.status,'invalid');assert.equal(r.model,null);assert.ok(!r.resolution||r.resolution.periods.every(p=>p.priceStatus!=='known'));});
test('overlapping contradictory observations stay conflicting',()=>{const d=fixture();d.windows[1].period=d.windows[0].period;d.windows[1].energy.validity=d.windows[0].period;d.evidence[2].coverage=[d.windows[0].period];const r=run(d);assert.equal(at(r,horizon.start).priceStatus,'conflicting');});
test('bounded tax/bill coverage cannot prove rates outside its interval',()=>{const d=historicalFixture('0.05');d.evidence.find(e=>e.id==='bill').coverage=[];const r=run(d,d.windows[0].period);assert.equal(r.resolution.periods[0].priceStatus,'unknown');});
test('supplier and transport remain distinct, stale evidence does not expand coverage',()=>{const d=fixture();d.evidence[1].freshness='stale';const r=run(d);assert.equal(r.model.evidence[1].provider,'E.ON Next');assert.equal(r.provenance.transport[1].via,'kraken');assert.ok(r.resolution.signal.import[0].sources.some(s=>s.stale));});
test('results are detached and deeply immutable including partial/invalid results',()=>{
  const d=fixture(),r=run(d),before=JSON.stringify(r);d.windows[0].energy.price.amount='999';d.evidence[0].subject.supplier='Changed';assert.equal(JSON.stringify(r),before);assert.ok(!Object.isFrozen(d));
  for(const mutate of [()=>r.model.versions[0].rates[0].price.amount='999',()=>r.model.evidence[0].subject.supplier='Changed',()=>r.provenance.transport.push({}),()=>r.resolution.periods.reverse(),()=>r.diagnostics.push('x')]){assert.throws(mutate,{name:"TypeError"});assert.equal(JSON.stringify(r),before);}
  const invalid=run(null);assert.throws(()=>invalid.diagnostics.push('x'),{name:'TypeError'});
});
test('malformed/cyclic/non-data inputs safely reject without exposing values',()=>{
  for(const d of [undefined,{},new Map(),{...fixture(),extra:'secret'}])assert.equal(adapt(d,horizon,generatedAt).status,'invalid');
  const d=fixture();d.windows[0].energy.price.bad=d;assert.equal(run(d).status,'invalid');
});
