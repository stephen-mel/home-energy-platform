import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {fixture,historicalFixture,horizon,generatedAt} from './fixtures/eon-offline-evidence.mjs';

// Only pure economics/presentation dependencies. No clients, authority, storage,
// implicit clock or network globals are provided to any module under test.
function load(path,dependencies={}) {
  const exports={};
  class ExplicitDate extends Date {constructor(...args){assert.ok(args.length,'Explicit clock required');super(...args);} static now(){throw Error('No clock');}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,Object,structuredClone,Date:ExplicitDate,require(name){assert.ok(Object.hasOwn(dependencies,name),`Forbidden dependency: ${name}`);return dependencies[name];}});
  return exports;
}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const offline=load('src/lib/tariff/eon-offline-evidence.ts',{'./economic-decimal':decimal,'./resolve-economic-model':resolver});
const view=load('src/components/home-energy-plan-view.ts');
const {selectedHomeEnergyPlan:select}=load('src/components/selected-home-energy-plan.ts',{'../lib/tariff/resolve-economic-model':resolver,'../lib/tariff/economic-decimal':decimal,'./home-energy-plan-view':view});
const curve=load('src/lib/tariff/price-signal.ts');
const effective=load('src/lib/tariff/effective-tariff.ts',{'./price-signal':curve});
const kraken=load('src/lib/tariff/kraken-dispatches.ts',{'./price-signal':curve});
const legacy=load('src/lib/site/get-site-price-signal.ts',{'../tariff/price-signal':curve,'../tariff/effective-tariff':effective,'../tariff/kraken-dispatches':kraken});
const currentSite=load('src/lib/site/current-site.ts').currentSite;
const plain=v=>JSON.parse(JSON.stringify(v));
const adapt=(data=fixture(),h=horizon)=>offline.adaptEonOfflineEvidence(data,h,generatedAt);
const selectOffline=(data=fixture(),h=horizon)=>select({kind:'eon-offline',result:adapt(data,h)},h.start);

test('offline source feeds the real pure view with its existing projection verbatim',()=>{
  const result=adapt(),r=select({kind:'eon-offline',result},horizon.start);
  assert.equal(r.status,'selected');assert.equal(r.purpose,'read-only-inspection');
  assert.deepEqual(plain(r.signal),plain(result.resolution.signal));
  assert.deepEqual(plain(r.view),plain(view.homeEnergyPlanView(result.resolution.signal,horizon.start)));
  assert.equal(r.view.currentImport.price.amount,0.0285);
  assert.equal(r.signal.import.find(w=>w.start==='2026-10-07T05:00:00.000Z').price.amount,0.23978);
  assert.deepEqual(plain(r.source.result.provenance),plain(result.provenance));
  assert.ok(r.source.result.model.evidence.every(e=>e.provider==='E.ON Next'));
  assert.ok(r.source.result.provenance.transport.every(t=>t.via==='kraken'));
});
test('canonical resolution can be explicitly selected without the provider adapter',()=>{
  const result=adapt().resolution,r=select({kind:'canonical',resolution:result},horizon.start);
  assert.equal(r.status,'selected');assert.deepEqual(plain(r.signal),plain(result.signal));
  assert.deepEqual(plain(r.source.resolution),plain(result));
});
test('future inside January agreement but beyond October observation remains wholly unknown',()=>{
  const h={start:'2026-11-01T00:00:00Z',end:'2026-11-02T00:00:00Z'},r=selectOffline(fixture(),h);
  assert.equal(r.status,'selected');assert.equal(r.source.result.status,'partial');
  assert.equal(r.source.result.model.agreements[0].validTo,'2027-01-17T00:00:00Z');
  assert.ok([...r.signal.import,...r.signal.export].every(w=>w.price===null&&w.priceStatus==='unknown'));
  assert.equal(r.view.currentImport.price,null);assert.equal(r.view.cheap,null);
});
test('incomplete export remains independent and unresolved',()=>{
  const r=selectOffline();assert.equal(r.view.currentImport.price.amount,0.0285);assert.equal(r.view.currentExport.price,null);
  assert.ok(r.diagnostics.includes('EXPORT_AGREEMENT_UNRESOLVED'));
  assert.equal(r.source.result.provenance.observations[0].amount,'0.175');
  assert.ok(r.signal.export.every(w=>w.price===null));
});
for(const [fraction,expected,standing] of [['0.05','0.029925','0.6000015'],['0','0.0285','0.57143']]) test(`VAT ${fraction} exact canonical amounts and tax survive selection`,()=>{
  const data=historicalFixture(fraction),r=selectOffline(data,data.windows[0].period);
  const resolution=r.source.result.resolution;
  assert.equal(resolution.periods[0].consumerPrice.amount,expected);
  assert.equal(resolution.periods[0].sourcePrice.amount,'0.0285');assert.equal(resolution.periods[0].tax.fraction,fraction);
  assert.equal(resolution.standingCharges[0].consumerPrice.amount,standing);
  assert.equal(r.view.currentImport.price.amount,Number(expected));
  assert.ok([...r.signal.import,...r.signal.export].every(w=>w.price===null||w.price.unit==='kWh'));
  assert.ok(!JSON.stringify(r.signal).includes(standing));
});
test('inclusive prices are projected unchanged and never taxed again',()=>{
  const d=historicalFixture('0.05',true),r=selectOffline(d,d.windows[0].period);
  assert.equal(r.view.currentImport.price.amount,0.0285);assert.equal(r.source.result.resolution.periods[0].tax,null);
});
function conditional(compatibility='drive-smart',stale=false) {
  // Synthetic supplier rule and authenticated occurrence, not derived from bill.
  const m=structuredClone(adapt().model),v=m.versions[1],period=v.validity;
  v.schedule[0].overlayPolicy='replace';
  v.rates.push({id:'smart-rate',validity:period,price:{amount:'0.0285',currency:'GBP',unit:'kWh',basis:'tax-inclusive'},evidenceIds:['rule']});
  v.conditionalRules=[{id:'smart',rateId:'smart-rate',validity:period,evidenceIds:['rule'],dispatchType:'SMART',provider:'kraken',qualification:'physical-charging-required',compatibility}];
  const e={...structuredClone(m.evidence[2]),id:'rule',claims:[{role:'energy-rate',versionId:v.id,rateId:'smart-rate'},{role:'conditional-rule-definition',versionId:v.id,ruleId:'smart'}]};
  m.evidence.push(e);
  const start='2026-10-07T05:10:00Z',end='2026-10-07T05:20:00Z';
  m.evidence.push({...structuredClone(e),id:'dispatch',provider:'kraken',kind:'authenticated-dispatch',freshness:stale?'stale':'fresh',coverage:[{start,end}],
    claims:[{role:'conditional-dispatch-occurrence',ruleId:'smart',assetId:'synthetic-ev',dispatchType:'SMART',start,end}]});
  const intervals=[{start,end,ruleId:'smart',agreementId:v.agreementId,evidenceId:'dispatch',cause:{kind:'ev-dispatch',assetId:'synthetic-ev',dispatchType:'SMART',start,end}}];
  const resolution=resolver.resolveEconomicModel(m,period,generatedAt,intervals);
  assert.equal(resolution.status,'resolved');
  return select({kind:'canonical',resolution},start);
}
for(const stale of [false,true]) test(`conditional SMART remains planned-conditional, stale=${stale}`,()=>{
  const r=conditional('drive-smart',stale),w=r.view.currentImport;
  assert.equal(w.price.amount,0.0285);assert.equal(w.kind,'cheap-opportunity');assert.equal(w.condition,'scheduled-ev-charging');assert.equal(w.stale,stale);
  assert.ok(w.eligibilityPeriods.every(p=>p.state==='planned-conditional'));
  assert.equal(w.sources.find(s=>s.cause).cause.assetId,'synthetic-ev');
  assert.deepEqual(plain(r.signal),plain(r.source.resolution.signal));
});
test('canonical condition that lacks compatibility remains unknown in the consumer',()=>{
  const r=conditional(null);assert.equal(r.view.currentImport.price,null);assert.ok(r.diagnostics.includes('CONDITION_NOT_REPRESENTABLE'));
  assert.ok(r.source.resolution.periods.some(p=>p.consumerPrice?.amount==='0.0285'&&p.conditional));
});
function manualSource() {
  const signal=legacy.getSitePriceSignal(currentSite,null,'2026-09-25T12:00:00Z').signal;
  return {kind:'manual-assumption',label:'Existing configured prototype rates',signal};
}
test('manual assumptions are clearly labelled and require explicit selection',()=>{
  const r=select(manualSource(),'2026-09-25T12:00:00Z');assert.equal(r.status,'selected');assert.match(r.sourceLabel,/Manual tariff assumption/);
  assert.equal(r.view.currentImport.price.amount,0.2518);assert.equal(r.source.kind,'manual-assumption');
  assert.notEqual(r.sourceLabel,selectOffline().sourceLabel);
});
test('no automatic fallback, default selection or source-selection state',()=>{
  const h={start:'2026-11-01T00:00:00Z',end:'2026-11-02T00:00:00Z'},source={kind:'eon-offline',result:adapt(fixture(),h)};
  const first=select(source,h.start);select(manualSource(),'2026-09-25T12:00:00Z');const second=select(source,h.start);
  assert.deepEqual(plain(second),plain(first));assert.equal(second.view.currentImport.price,null);
  for(const input of [undefined,null,{}, {kind:'automatic'}, {kind:'manual-assumption',label:'',signal:manualSource().signal}]) {
    const r=select(input,h.start);assert.equal(r.status,'unavailable');assert.equal(r.signal,null);
  }
});
test('invalid canonical/adapter outcomes cannot fall back to configured prices',()=>{
  const d=fixture();d.evidence[1].provider='wrong';const invalid=adapt(d);
  for(const source of [{kind:'eon-offline',result:invalid},{kind:'canonical',resolution:invalid.resolution}]) {
    const r=select(source,horizon.start);assert.equal(r.status,'unavailable');assert.equal(r.signal,null);assert.equal(r.view,null);
    assert.equal(r.source.kind,source.kind);assert.ok(r.diagnostics.includes('EVIDENCE_ATTESTOR_MISMATCH'));
  }
});
test('legacy signal and existing presentation are byte-for-byte unchanged',()=>{
  const site=structuredClone(currentSite),now='2026-09-25T12:00:00Z',before=legacy.getSitePriceSignal(site,null,now);
  const bytes=JSON.stringify(before);const originalView=JSON.stringify(view.homeEnergyPlanView(before.signal,now));
  selectOffline();const selected=select({kind:'manual-assumption',label:'Legacy configured assumptions',signal:before.signal},now);
  assert.equal(JSON.stringify(selected.signal),JSON.stringify(before.signal));assert.equal(JSON.stringify(selected.view),originalView);
  assert.equal(JSON.stringify(legacy.getSitePriceSignal(site,null,now)),bytes);assert.equal(JSON.stringify(before),bytes);
});
test('input remains mutable; result, source, exact tax and view graph are detached/frozen',()=>{
  const d=historicalFixture('0.05'),source={kind:'eon-offline',result:structuredClone(adapt(d,d.windows[0].period))};
  const r=select(source,d.windows[0].period.start),before=JSON.stringify(r);
  source.result.resolution.periods[0].sourcePrice.amount='999';source.result.provenance.transport[0].via='changed';assert.equal(JSON.stringify(r),before);
  assert.equal(Object.isFrozen(source),false);
  for(const change of [()=>r.source.result.resolution.periods[0].tax.fraction='999',()=>r.view.currentImport.price.amount=999,()=>r.signal.import.reverse(),
    ()=>r.source.result.model.evidence[0].subject.supplier='changed',()=>r.view.segments.push({}),()=>r.diagnostics.push('changed')]) {
    try{change();}catch(e){assert.equal(e.name,'TypeError');}assert.equal(JSON.stringify(r),before);
  }
  const invalid=select({},horizon.start);assert.throws(()=>invalid.diagnostics.push('changed'),{name:'TypeError'});
});
test('no authority/capability surface and no mutable exotic objects accepted',()=>{
  const r=selectOffline();assert.deepEqual(Object.keys(r).sort(),['purpose','status','sourceLabel','source','diagnostics','signal','presentationSignal','view'].sort());
  assert.ok(!Object.keys(r).some(k=>/write|ownership|approval|persist|capability/i.test(k)));
  const source={kind:'canonical',resolution:structuredClone(adapt().resolution)};source.resolution.extra=new Map();
  assert.equal(select(source,horizon.start).status,'unavailable');
});
test('non-representable decimal stays exact canonically and unknown in the existing numeric projection',()=>{
  const d=fixture();d.windows[0].energy.price.amount='0.028500000000000001';const r=selectOffline(d);
  assert.equal(r.source.result.resolution.periods[0].consumerPrice.amount,'0.028500000000000001');
  assert.equal(r.view.currentImport.price,null);assert.ok(r.diagnostics.includes('PRICE_NOT_REPRESENTABLE'));
});
test('manual evidence within a canonical result is retained without upgrading its authority',()=>{
  const d=fixture();d.evidence[1].kind='manual';d.evidence[1].provider='synthetic-manual-attestor';
  const resolution=adapt(d).resolution,r=select({kind:'canonical',resolution},horizon.start);
  assert.equal(r.status,'selected');
  assert.ok(r.view.currentImport.sources.some(s=>s.description==='manual:rates-0'&&s.provider==='synthetic-manual-attestor'));
  assert.deepEqual(plain(r.source.resolution),plain(resolution));assert.ok(!r.sourceLabel.includes('Supplier-backed'));
});

function removeEnergyCoverage(model) {
  // Keep the version/schedule attestation covered; only the energy claim lacks
  // coverage, so the real resolver retains its off-peak compatibility kind.
  const version=model.versions[0],evidence=structuredClone(model.evidence.find(e=>e.id==='rates-0'));
  evidence.id='energy-gap';evidence.coverage=[];
  evidence.claims=[{role:'energy-rate',versionId:version.id,rateId:version.rates[0].id}];
  model.evidence.push(evidence);version.rates[0].evidenceIds=[evidence.id];
}
function offPeakResolution({future=false,unknown=true}={}) {
  const model=structuredClone(adapt().model),version=model.versions[0];
  version.schedule[0].compatibility='guaranteed-off-peak';
  if(unknown) removeEnergyCoverage(model);
  const now=future?'2026-10-06T22:30:00Z':horizon.start;
  const resolution=resolver.resolveEconomicModel(model,{start:now,end:'2026-10-07T06:00:00Z'},generatedAt);
  return {resolution,now};
}
test('QA reproduction: unknown guaranteed off-peak at now is not a cheap indication',()=>{
  const {resolution,now}=offPeakResolution();
  assert.equal(resolution.periods[0].priceStatus,'unknown');assert.equal(resolution.periods[0].consumerPrice,null);
  assert.equal(resolution.signal.import[0].price,null);assert.equal(resolution.signal.import[0].kind,'guaranteed-off-peak');
  assert.equal(view.homeEnergyPlanView(resolution.signal,now).cheapNow,true); // Independent legacy reproducer.
  const result=select({kind:'canonical',resolution},now);
  assert.equal(result.view.cheap,null);assert.equal(result.view.cheapNow,false);
});
for(const kind of ['canonical','eon-offline']) test(`${kind}: future unknown off-peak is skipped without changing source`,()=>{
  const {resolution,now}=offPeakResolution({future:true}),source=kind==='canonical'?{kind,resolution}:{kind,result:{...adapt(),resolution}};
  assert.ok(resolution.signal.import.some(w=>w.kind==='guaranteed-off-peak'&&w.price===null));
  const before=JSON.stringify(source),result=select(source,now);
  assert.equal(result.view.cheap,null);assert.equal(result.view.cheapNow,false);
  assert.equal(JSON.stringify(source),before);assert.equal(JSON.stringify(result.source),before);
  assert.deepEqual(plain(result.signal),plain(resolution.signal));
});
test('conflicting off-peak economics from the resolver are not cheap',()=>{
  const model=structuredClone(adapt().model),v=model.versions[0];v.schedule[0].compatibility='guaranteed-off-peak';
  v.rates.push(structuredClone(v.rates[0]));
  const resolution=resolver.resolveEconomicModel(model,horizon,generatedAt);
  assert.equal(resolution.periods[0].priceStatus,'conflicting');assert.equal(resolution.signal.import[0].kind,'guaranteed-off-peak');
  const r=select({kind:'canonical',resolution},horizon.start);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
for(const [name,mutate] of [
  ['null consumer',p=>p.consumerPrice=null],['invalid decimal',p=>p.consumerPrice.amount='bad'],
  ['wrong units',p=>p.consumerPrice.unit='day'],['currency mismatch',p=>p.consumerPrice.currency='USD'],
  ['price mismatch',p=>p.consumerPrice.amount='0.04'],['unknown status',p=>p.priceStatus='unknown'],
  ['conflicting status',p=>p.priceStatus='conflicting'],
]) test(`canonical ${name} cannot qualify despite a known off-peak projection`,()=>{
  const {resolution,now}=offPeakResolution({unknown:false}),copy=structuredClone(resolution);mutate(copy.periods[0]);
  const r=select({kind:'canonical',resolution:copy},now);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
  assert.equal(r.signal.import[0].kind,'guaranteed-off-peak');
});
test('unknown candidate before a known candidate selects the next eligible period',()=>{
  const model=structuredClone(adapt().model);
  for(const v of model.versions.slice(0,2))v.schedule[0].compatibility='guaranteed-off-peak';
  removeEnergyCoverage(model);
  const resolution=resolver.resolveEconomicModel(model,horizon,generatedAt),r=select({kind:'canonical',resolution},horizon.start);
  assert.equal(resolution.signal.import[0].kind,'guaranteed-off-peak');assert.equal(resolution.signal.import[0].price,null);
  assert.equal(r.view.cheap.start,'2026-10-07T05:00:00.000Z');assert.equal(r.view.cheapNow,false);
  assert.equal(r.view.cheap.price.amount,0.23978); // Classification retained; no new cheapness threshold.
});
for(const future of [false,true]) test(`known eligible coalesced interval remains cheap, future=${future}`,()=>{
  const {resolution,now}=offPeakResolution({unknown:false,future}),r=select({kind:'canonical',resolution},now);
  assert.ok(resolution.periods.filter(p=>p.direction==='import'&&p.compatibilityKind==='guaranteed-off-peak').length>1);
  assert.deepEqual(plain(r.view.cheap),plain(view.homeEnergyPlanView(resolution.signal,now).cheap));assert.equal(r.view.cheapNow,!future);
});
for(const [name,change] of [
  ['missing minute',r=>r.periods.splice(0,1)],['overlapping minute',r=>r.periods.push(structuredClone(r.periods[0]))],
  ['misaligned boundary',r=>r.periods[0].start='2026-10-06T22:59:00Z'],
  ['invalid boundary',r=>r.periods[0].end='2026-02-30T00:00:00Z'],
]) test(`ambiguous canonical correspondence (${name}) fails closed`,()=>{
  const {resolution,now}=offPeakResolution({unknown:false}),copy=structuredClone(resolution);change(copy);
  const r=select({kind:'canonical',resolution:copy},now);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
test('SMART projection cannot indicate cheapness when its canonical economics are unresolved',()=>{
  const r=conditional(),source=structuredClone(r.source);
  for(const p of source.resolution.periods)if(p.conditional){p.priceStatus='unknown';p.consumerPrice=null;}
  const guarded=select(source,r.view.start);assert.equal(guarded.view.cheap,null);assert.equal(guarded.view.cheapNow,false);
  assert.ok(guarded.signal.import.some(w=>w.kind==='cheap-opportunity')); // Projection preserved, never edited.
});
test('legacy/manual unknown-kind presentation stays unchanged and explicitly an assumption',()=>{
  const {resolution,now}=offPeakResolution(),signal=structuredClone(resolution.signal);
  const r=select({kind:'manual-assumption',label:'Explicit legacy assumptions',signal},now);
  assert.deepEqual(plain(r.view),plain(view.homeEnergyPlanView(signal,now)));assert.equal(r.view.cheapNow,true);
  assert.match(r.sourceLabel,/Manual tariff assumption/);
  assert.equal(select({kind:'canonical',resolution},now).view.cheapNow,false); // No remembered manual fallback.
});
test('filtered presentation and unchanged source remain deeply immutable and detached',()=>{
  const {resolution,now}=offPeakResolution(),source={kind:'canonical',resolution:structuredClone(resolution)};
  const r=select(source,now),before=JSON.stringify(r);source.resolution.periods[0].priceStatus='known';
  source.resolution.signal.import[0].kind='standard';assert.equal(JSON.stringify(r),before);
  for(const action of [()=>r.view.cheapNow=true,()=>r.source.resolution.periods[0].consumerPrice={},()=>r.signal.import[0].kind='standard']){
    assert.throws(action,{name:'TypeError'});assert.equal(JSON.stringify(r),before);
  }
});

test('QA eligibility exploit: changing only a standard projected kind cannot grant guaranteed eligibility',()=>{
  const resolution=structuredClone(adapt().resolution);
  assert.equal(resolution.periods[0].compatibilityKind,'standard');assert.equal(resolution.periods[0].conditional,null);
  assert.equal(resolution.periods[0].consumerPrice.amount,'0.0285');
  resolution.signal.import[0].kind='guaranteed-off-peak';
  const r=select({kind:'canonical',resolution},horizon.start);
  assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
for(const kind of ['canonical','eon-offline']) test(`${kind}: standard eligibility rejects guaranteed projection without changing evidence`,()=>{
  const result=structuredClone(adapt());result.resolution.signal.import[0].kind='guaranteed-off-peak';
  const source=kind==='canonical'?{kind,resolution:result.resolution}:{kind,result},before=JSON.stringify(source);
  const r=select(source,horizon.start);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
  assert.equal(JSON.stringify(source),before);assert.equal(JSON.stringify(r.source),before);
});
for(const compatibility of ['drive-smart',null]) test(`conditional compatibility ${compatibility} cannot be relabelled guaranteed`,()=>{
  const original=conditional(compatibility),source=structuredClone(original.source),resolution=source.resolution;
  for(const w of resolution.signal.import)if(Date.parse(w.start)<=Date.parse(original.view.start)&&Date.parse(w.end)>Date.parse(original.view.start)){
    w.kind='guaranteed-off-peak';w.condition='none';w.eligibilityPeriods=[];
    // Isolate eligibility even for an unsupported projection: matching known
    // money must not rescue an unsupported conditional rule.
    w.priceStatus='known';w.price={amount:0.0285,currency:'GBP',unit:'kWh'};
  }
  const r=select(source,original.view.start);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
test('guaranteed canonical period cannot be relabelled conditional',()=>{
  const {resolution,now}=offPeakResolution({unknown:false}),copy=structuredClone(resolution);
  copy.signal.import[0].kind='cheap-opportunity';copy.signal.import[0].condition='scheduled-ev-charging';
  const r=select({kind:'canonical',resolution:copy},now);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
for(const [name,change] of [
  ['billed promotion',w=>w.eligibilityPeriods[0].state='billed-verified'],
  ['qualification promotion',w=>w.eligibilityPeriods[0].state='observed-qualified'],
  ['missing assessment',w=>w.eligibilityPeriods.pop()],
  ['condition removed',w=>w.condition='none'],
  ['assessment misbound',w=>w.eligibilityPeriods[0].end=w.end],
]) test(`supported conditional projection rejects ${name}`,()=>{
  const original=conditional(),source=structuredClone(original.source),w=source.resolution.signal.import.find(w=>w.kind==='cheap-opportunity');change(w);
  const r=select(source,original.view.start);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
test('mixed canonical eligibility cannot validate one guaranteed candidate',()=>{
  const {resolution,now}=offPeakResolution({unknown:false}),copy=structuredClone(resolution);
  copy.periods.find(p=>p.direction==='import'&&p.start!==copy.periods[0].start).compatibilityKind='standard';
  const r=select({kind:'canonical',resolution:copy},now);assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
test('a mismatched candidate is skipped in favour of the next known eligible one',()=>{
  const model=structuredClone(adapt().model);model.versions[1].schedule[0].compatibility='guaranteed-off-peak';
  const resolution=structuredClone(resolver.resolveEconomicModel(model,horizon,generatedAt));resolution.signal.import[0].kind='guaranteed-off-peak';
  const r=select({kind:'canonical',resolution},horizon.start);assert.equal(r.view.cheap.start,'2026-10-07T05:00:00.000Z');assert.equal(r.view.cheapNow,false);
});
test('eligibility rejection preserves detachment, immutability and manual selection without fallback',()=>{
  const resolution=structuredClone(adapt().resolution);resolution.signal.import[0].kind='guaranteed-off-peak';
  const source={kind:'canonical',resolution},r=select(source,horizon.start),before=JSON.stringify(r);
  const manual=select({kind:'manual-assumption',label:'Explicit assumptions',signal:resolution.signal},horizon.start);
  assert.equal(manual.view.cheapNow,true);assert.match(manual.sourceLabel,/Manual tariff assumption/);
  assert.equal(select(source,horizon.start).view.cheapNow,false);
  resolution.periods[0].compatibilityKind='guaranteed-off-peak';assert.equal(JSON.stringify(r),before);
  assert.throws(()=>r.view.cheapNow=true,{name:'TypeError'});
  assert.throws(()=>r.source.resolution.periods[0].compatibilityKind='guaranteed-off-peak',{name:'TypeError'});
  assert.equal(JSON.stringify(r),before);
});

function assertRejectedPresentation(r,start,end,now=start) {
  assert.equal(r.status,'selected');
  const overlaps=w=>Date.parse(w.start)<Date.parse(end)&&Date.parse(w.end)>Date.parse(start);
  assert.ok(r.presentationSignal.import.every(w=>!overlaps(w)));
  assert.ok(r.view.segments.filter(overlaps).every(s=>s.window===null));
  assert.ok(r.view.segments.filter(overlaps).every(s=>view.rateLabel(s.window)==='Rate unknown'));
  assert.ok(r.view.cheap===null||!overlaps(r.view.cheap));
  if(Date.parse(now)>=Date.parse(start)&&Date.parse(now)<Date.parse(end)){
    assert.equal(r.view.currentImport,null);assert.equal(r.view.cheapNow,false);
    assert.equal(view.rateLabel(r.view.currentImport),'Rate unknown');
  }
}
for(const kind of ['canonical','eon-offline']) for(const defect of ['unknown-guaranteed','standard-relabelled','conditional-relabelled']) test(`complete ${kind} presentation boundary rejects ${defect}`,()=>{
  let resolution,now;
  if(defect==='unknown-guaranteed')({resolution,now}=offPeakResolution());
  else if(defect==='standard-relabelled'){
    resolution=structuredClone(adapt().resolution);now=horizon.start;resolution.signal.import[0].kind='guaranteed-off-peak';
  }else{
    const c=conditional();resolution=structuredClone(c.source.resolution);now=c.view.start;
    const w=resolution.signal.import.find(w=>w.kind==='cheap-opportunity');w.kind='guaranteed-off-peak';w.condition='none';w.eligibilityPeriods=[];
  }
  const bad=resolution.signal.import.find(w=>Date.parse(w.start)<=Date.parse(now)&&Date.parse(w.end)>Date.parse(now));
  const rawView=view.homeEnergyPlanView(resolution.signal,now);
  assert.equal(rawView.currentImport.kind,'guaranteed-off-peak');assert.equal(rawView.segments[0].window.kind,'guaranteed-off-peak');
  if(defect!=='unknown-guaranteed')assert.equal(view.rateLabel(rawView.currentImport),'Cheap rate · Guaranteed');
  const source=kind==='canonical'?{kind,resolution}:{kind,result:{...adapt(),resolution}},before=JSON.stringify(source);
  const r=select(source,now);assertRejectedPresentation(r,bad.start,bad.end,now);
  assert.equal(JSON.stringify(source),before);assert.equal(JSON.stringify(r.source),before);
  assert.deepEqual(plain(r.signal),plain(resolution.signal));assert.notEqual(r.presentationSignal,r.signal);
});
test('future rejected interval produces only a null timeline gap and no cheap label',()=>{
  const {resolution,now}=offPeakResolution({future:true}),bad=resolution.signal.import.find(w=>w.kind==='guaranteed-off-peak');
  const r=select({kind:'canonical',resolution},now);assertRejectedPresentation(r,bad.start,bad.end,now);
  assert.equal(r.view.cheap,null);assert.equal(r.view.cheapNow,false);
});
function consecutiveResolution() {
  // Synthetic consecutive observations to probe gap rendering, not supplier facts.
  const d=fixture(),start=Date.parse(horizon.start);
  d.windows.forEach((w,i)=>{
    w.period={start:new Date(start+i*1800000).toISOString(),end:new Date(start+(i+1)*1800000).toISOString()};
    w.energy.validity=w.period;d.evidence.find(e=>e.id===`rates-${i}`).coverage=[w.period];
  });
  const h={start:horizon.start,end:d.windows.at(-1).period.end};
  return structuredClone(adapt(d,h).resolution);
}
test('rejected interval between valid periods cannot create invented timeline continuity',()=>{
  const resolution=consecutiveResolution(),bad=resolution.signal.import[1];bad.kind='guaranteed-off-peak';
  const r=select({kind:'canonical',resolution},resolution.signal.horizon.start);
  assertRejectedPresentation(r,bad.start,bad.end,resolution.signal.horizon.start);
  assert.equal(r.view.currentImport.price.amount,0.0285);
  const gap=r.view.segments.find(s=>s.start===bad.start&&s.end===bad.end);assert.equal(gap.window,null);
  assert.ok(r.view.segments.some(s=>s.end===bad.start&&s.window));assert.ok(r.view.segments.some(s=>s.start===bad.end&&s.window));
  assert.equal(r.view.segments[0].start,r.view.start);assert.equal(r.view.segments.at(-1).end,r.view.end);
  for(let i=1;i<r.view.segments.length;i++)assert.equal(r.view.segments[i-1].end,r.view.segments[i].start);
});
test('rejected current interval followed by valid guaranteed interval retains only the valid indication',()=>{
  const model=structuredClone(adapt().model);model.versions[1].schedule[0].compatibility='guaranteed-off-peak';
  const resolution=structuredClone(resolver.resolveEconomicModel(model,horizon,generatedAt));resolution.signal.import[0].kind='guaranteed-off-peak';
  const bad=resolution.signal.import[0],r=select({kind:'canonical',resolution},horizon.start);
  assertRejectedPresentation(r,bad.start,bad.end);assert.equal(r.view.cheap.start,'2026-10-07T05:00:00.000Z');
  assert.equal(view.rateLabel(r.view.cheap),'Cheap rate · Guaranteed');assert.equal(r.view.cheapNow,false);
});
for(const [name,alter] of [
  ['overlap',r=>r.signal.import.splice(1,0,structuredClone(r.signal.import[0]))],
  ['unordered',r=>r.signal.import.reverse()],['invalid boundary',r=>r.signal.import[0].end='bad'],
]) test(`unsafe projected ${name} returns unavailable presentation with original signal retained`,()=>{
  const resolution=consecutiveResolution();alter(resolution);const source={kind:'canonical',resolution},before=JSON.stringify(source);
  const r=select(source,horizon.start);assert.equal(r.status,'unavailable');assert.equal(r.view,null);assert.equal(r.presentationSignal,null);
  assert.equal(JSON.stringify(r.source),before);assert.deepEqual(plain(r.signal),plain(resolution.signal));
  assert.ok(r.diagnostics.some(d=>d.startsWith('PRESENTATION_')));
});
for(const [name,alter] of [
  ['missing projection',r=>r.signal.import.splice(1,1)],
  ['partial canonical coverage',r=>r.periods.splice(r.periods.findIndex(p=>p.direction==='import'&&p.start===r.signal.import[1].start),1)],
  ['canonical overlap',r=>r.periods.push(structuredClone(r.periods.find(p=>p.direction==='import'&&p.start===r.signal.import[1].start)))],
  ['conflicting evidence',r=>{r.periods.find(p=>p.direction==='import'&&p.start===r.signal.import[1].start).priceStatus='conflicting';}],
  ['mixed eligibility',r=>{r.periods.find(p=>p.direction==='import'&&p.start===r.signal.import[1].start).compatibilityKind='guaranteed-off-peak';}],
]) test(`${name} leaves a visible null gap without leaking rejected windows`,()=>{
  const resolution=consecutiveResolution(),bad=structuredClone(resolution.signal.import[1]);alter(resolution);
  const r=select({kind:'canonical',resolution},horizon.start);assertRejectedPresentation(r,bad.start,bad.end,horizon.start);
});
test('unsupported conditional relabel cannot leak through current rate or timeline',()=>{
  const original=conditional(null),source=structuredClone(original.source),bad=source.resolution.signal.import.find(w=>Date.parse(w.start)<=Date.parse(original.view.start)&&Date.parse(w.end)>Date.parse(original.view.start));
  bad.kind='cheap-opportunity';bad.priceStatus='known';bad.price={amount:0.0285,currency:'GBP',unit:'kWh'};bad.condition='scheduled-ev-charging';
  const r=select(source,original.view.start);assertRejectedPresentation(r,bad.start,bad.end,original.view.start);
});
function withExport() {
  const resolution=consecutiveResolution();
  for(const p of resolution.periods.filter(p=>p.direction==='export')){
    p.priceStatus='known';p.consumerPrice={amount:'0.175',currency:'GBP',unit:'kWh'};p.compatibilityKind='standard';
  }
  for(const w of resolution.signal.export){w.priceStatus='known';w.price={amount:0.175,currency:'GBP',unit:'kWh'};}
  return resolution; // Synthetic fully known export to isolate independent validation.
}
test('invalid export price cannot reach currentExport; valid import stays visible',()=>{
  const resolution=withExport();resolution.signal.export[0].price.amount=999;
  const r=select({kind:'canonical',resolution},horizon.start);
  assert.equal(r.view.currentExport,null);assert.equal(view.rateLabel(r.view.currentExport),'Rate unknown');
  assert.equal(r.view.currentImport.price.amount,0.0285);assert.equal(r.signal.export[0].price.amount,999);
  assert.equal(r.presentationSignal.export.length,0);
});
test('export classification validation and import rejection are independent',()=>{
  const resolution=withExport();resolution.signal.import[0].kind='guaranteed-off-peak';
  const r=select({kind:'canonical',resolution},horizon.start);assert.equal(r.view.currentImport,null);assert.equal(r.view.currentExport.price.amount,0.175);
  resolution.signal.export[0].kind='guaranteed-off-peak';const rejected=select({kind:'canonical',resolution},horizon.start);
  assert.equal(rejected.view.currentExport,null);
});
test('no unknown-to-known export promotion',()=>{
  const resolution=structuredClone(adapt().resolution);resolution.signal.export[0].priceStatus='known';resolution.signal.export[0].price={amount:0.175,currency:'GBP',unit:'kWh'};
  const r=select({kind:'canonical',resolution},horizon.start);assert.equal(r.view.currentExport,null);assert.equal(r.view.currentImport.price.amount,0.0285);
});
test('validated presentation retains legitimate conditional/guaranteed semantics and freezes all fields',()=>{
  const c=conditional();assert.equal(view.rateLabel(c.view.currentImport),'Smart charge · Conditional');assert.equal(c.view.cheapNow,true);
  assert.ok(c.view.currentImport.eligibilityPeriods.every(p=>p.state==='planned-conditional'));
  const {resolution,now}=offPeakResolution({unknown:false}),source={kind:'canonical',resolution:structuredClone(resolution)},r=select(source,now),before=JSON.stringify(r);
  assert.equal(view.rateLabel(r.view.currentImport),'Cheap rate · Guaranteed');assert.equal(r.view.segments[0].window.kind,'guaranteed-off-peak');
  source.resolution.signal.import[0].price.amount=999;assert.equal(JSON.stringify(r),before);
  for(const action of [()=>r.presentationSignal.import.push({}),()=>r.view.currentImport.kind='standard',()=>r.view.segments[0].window.price.amount=999])assert.throws(action,{name:'TypeError'});
  assert.equal(JSON.stringify(r),before);
});
