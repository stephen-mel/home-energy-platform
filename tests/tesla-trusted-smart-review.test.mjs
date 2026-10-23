import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';

const modules=new Map();
function load(file,deps={}){file=path.resolve(file);if(modules.has(file)&&!Object.keys(deps).length)return modules.get(file);const exports={};if(!Object.keys(deps).length)modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,structuredClone,Date,Intl,Error,require(name){if(name in deps)return deps[name];if(name==='server-only')return {};if(name==='node:crypto')return {createHash};assert.ok(name.startsWith('.'),name);return load(path.resolve(path.dirname(file),name+'.ts'));}});return exports;}

const fixed=load('src/lib/tesla-tariff/fixed-export-policy.ts');
const api=load('src/lib/site/trusted-smart-review.ts',{
 './kraken-refresh':{},'./tesla-observation':{},'../tesla-tariff/ownership-store':{},
});
const observed=load('src/lib/tesla-tariff/observed-tariff.ts');
const {ownershipFingerprint}=load('src/lib/tesla-tariff/ownership-transition.ts');
const now='2026-10-23T12:00:00.000Z',normal=.23978,cheap=.0285;
const price=amount=>({amount,currency:'GBP',unit:'kWh'});
function side(sell=false){return {version:1,name:sell?'Export Premium':'Next Drive Smart',utility:'E.ON Next',currency:'GBP',code:sell?'EXPORT':'IMPORT',
 demand_charges:{ALL:{rates:{ALL:0}}},seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{
  cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,fromMinute:0,toHour:6,toMinute:0}]},
  peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,fromMinute:0,toHour:0,toMinute:0}]}}}},
 energy_charges:{Annual:{rates:{cheap:sell?.175:cheap,peak:sell?.175:normal}}}};}
function observation(at=now){return {source:{kind:'tesla-site-info',energySiteId:'123',observedAt:at,timeZone:'Europe/London'},
 tariff:{...side(),sell_tariff:side(true)},diagnostics:[],rollbackProven:false};}
function site(){return {id:'home',name:'Home',integrations:{kraken:{enabled:true,
  wholeHomeDispatchRate:{enabled:true,importPrice:null},
  importTariffIdentity:{accountRef:'account-a',tariffCode:'IMPORT-TARIFF',meterPointRef:'import-meter'},
  exportTariffIdentity:{accountRef:'export-account',productCode:'EXPORT',tariffCode:'EXPORT-TARIFF'},
  fixedExportAssumption:{provider:'eon-next',tariff:'Export Premium v3',price:price(.175),validFrom:'2026-10-23T00:00:00+01:00',validTo:'2027-12-01T00:00:00Z',confirmedAt:'2026-10-23T00:00:00+01:00'}},
  tesla:{enabled:true,energySiteId:'123'},homeAssistant:{enabled:false}},tariff:{timeZone:'Europe/London',normalImport:null,export:null,versions:[]},constraints:{maxImportKw:null,maxExportKw:null}};}
function vehicle(start='2026-10-23T14:00:00Z',end='2026-10-23T15:00:00Z',id='q7'){return {id,name:id,deviceType:'vehicle',provider:'kraken',vehicleBatterySize:null,chargePointPowerOutput:null,preferences:null,preferenceSetting:null,
 plannedDispatches:[{start,end,type:'SMART',energyAddedKwh:'2'}],status:{currentState:null,isSuspended:null,stateOfCharge:null,activePower:null}};}
function kraken(vehicles=[vehicle()],at=now){return {stale:false,lastSuccessfulUpdate:at,vehicles,importTariff:{status:'available',accountRef:'account-a',observedAt:at,exportStatus:'unknown',
 agreement:{validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'IMPORT-TARIFF',meterPointRef:'import-meter'},
 version:{id:'v',name:'Drive Smart',provider:'eon-next-kraken',effectiveFrom:'2026-10-22T23:00:00Z',effectiveTo:'2026-10-23T23:00:00Z',pricesIncludeVat:true,
 normalImport:price(normal),export:null,scheduledChargingImport:price(cheap),standingCharge:null,dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(cheap)}]}}};}
const review=(changes={})=>api.reviewTrustedSmartSync({site:changes.site??site(),kraken:changes.kraken??kraken(),observation:changes.observation??observation(),ownership:changes.ownership??{status:'missing'},assessedAt:changes.assessedAt??now});
const noAuthority=r=>{for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority','executionReady'])assert.equal(r[key],false,key)};

test('fixed export policy accepts complete recurring equal-rate coverage and fingerprints the exact representation',()=>{
 const s=site(),o=observation(),r=fixed.validateFixedExportPolicy({assumption:s.integrations.kraken.fixedExportAssumption,observation:o,assessedAt:now});
 assert.equal(r.status,'verified');assert.equal(r.exportFingerprint.length,64);assert.deepEqual(structuredClone(r.exportRepresentation),structuredClone(o.tariff.sell_tariff));noAuthority({...r,writeReady:false,rollbackProven:false,restorationProven:false,resolvesHistoricalJournal:false,grantsRepeatAuthority:false});
});

test('export policy fails closed for rate mismatch, gaps, unsupported fields and validity boundaries',()=>{
 const cases=[];
 const wrong=observation();wrong.tariff.sell_tariff.energy_charges.Annual.rates.peak=.20;cases.push([wrong,now,'OBSERVED_EXPORT_TARIFF_MISMATCH']);
 const gap=observation();gap.tariff.sell_tariff.seasons.Annual.tou_periods.peak.periods[0].fromHour=7;cases.push([gap,now,'OBSERVED_EXPORT_REPRESENTATION_UNSUPPORTED']);
 const extra=observation();extra.tariff.sell_tariff.extra='unsupported';cases.push([extra,now,'OBSERVED_EXPORT_REPRESENTATION_UNSUPPORTED']);
 for(const [o,at,code] of cases){const r=fixed.validateFixedExportPolicy({assumption:site().integrations.kraken.fixedExportAssumption,observation:o,assessedAt:at});assert.equal(r.status,'blocked');assert.equal(r.code,code)}
 const assumption=site().integrations.kraken.fixedExportAssumption;
 assert.equal(fixed.validateFixedExportPolicy({assumption,observation:observation(),assessedAt:assumption.validFrom}).status,'verified');
 assert.equal(fixed.validateFixedExportPolicy({assumption,observation:observation(),assessedAt:assumption.validTo}).code,'FIXED_EXPORT_EVIDENCE_OUTSIDE_VALIDITY');
});

test('read-only review produces Stage 1 apply decision, exact baseline and unchanged export',()=>{
 const r=review();assert.equal(r.status,'reviewed');assert.equal(r.decision.action,'apply');assert.ok(r.proposedRepresentation);assert.equal(r.exportPreserved,true);
 assert.deepEqual(structuredClone(r.proposedRepresentation.sell_tariff),structuredClone(r.exactBaseline.sell_tariff));assert.equal(r.exportEvidence.status,'verified');
 assert.ok(r.blockers.includes('BUY_BELOW_SELL'));assert.ok(r.blockers.includes('BUY_BELOW_SELL_SUPERVISED_POLICY_REQUIRED'));noAuthority(r);
});

test('changed household schedule changes evidence and desired representation identities',()=>{
 const a=review(),changed=kraken([vehicle('2026-10-23T15:00:00Z','2026-10-23T16:00:00Z')]),b=review({kraken:changed});
 assert.notEqual(a.evidenceIdentities.krakenSchedule,b.evidenceIdentities.krakenSchedule);assert.notEqual(a.proposedFingerprint,b.proposedFingerprint);assert.equal(b.exportPreserved,true);noAuthority(b);
});

test('stale evidence, account mismatch and ownership uncertainty fail closed',()=>{
 const stale=kraken();stale.lastSuccessfulUpdate='2026-10-23T11:58:59Z';stale.importTariff.observedAt=stale.lastSuccessfulUpdate;
 const a=review({kraken:stale});assert.equal(a.status,'blocked');assert.ok(a.blockers.includes('STALE_KRAKEN_EVIDENCE'));noAuthority(a);
 const mismatch=kraken();mismatch.importTariff.accountRef='account-b';const b=review({kraken:mismatch});assert.equal(b.blockers.join(),'IMPORT_ACCOUNT_OR_TARIFF_IDENTITY_MISMATCH');noAuthority(b);
 for(const ownership of [{status:'invalid',code:'OWNERSHIP_INVALID'},{status:'unavailable',code:'OWNERSHIP_UNAVAILABLE'},
  {status:'available',snapshot:{version:2,generation:'generation',evidence:{},checksum:'x',historyDigest:'y'}}]){
  const r=review({ownership});assert.equal(r.status,'blocked');assert.ok(r.blockers.some(x=>x.startsWith('OWNERSHIP_')||x==='RESTORATION_BASELINE_UNAVAILABLE'));noAuthority(r);
 }
});

test('persisted ownership detects an external Tesla change before the missing-baseline blocker',()=>{
 const evidence={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-24T23:00:00Z',basis:'confirmed-write-readback',baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[]};
 const generation='generation-1',ownership={status:'available',snapshot:{version:2,generation,evidence,checksum:ownershipFingerprint({generation,evidence}),historyDigest:'e'.repeat(64)}};
 const conflict=review({ownership});assert.equal(conflict.blockers.join(),'CURRENT_TARIFF_OWNERSHIP_CONFLICT');noAuthority(conflict);
 evidence.readbackFingerprint=ownershipFingerprint(observation().tariff);ownership.snapshot.checksum=ownershipFingerprint({generation,evidence});
 const retained=review({ownership});assert.equal(retained.blockers.join(),'RESTORATION_BASELINE_UNAVAILABLE');noAuthority(retained);
});

test('ownership acquisition is a closed union and malformed values never become missing',()=>{
 for(const ownership of [null,undefined,{}, {status:'unexpected'}, {status:'missing',extra:true},
  {status:'available'}, {status:'available',snapshot:null}, {status:'available',snapshot:{}}]){
  const r=api.reviewTrustedSmartSync({site:site(),kraken:kraken(),observation:observation(),ownership,assessedAt:now});
  assert.equal(r.status,'blocked');assert.equal(r.blockers.join(),'OWNERSHIP_EVIDENCE_MALFORMED');assert.equal(r.exactBaseline,null);noAuthority(r);
 }
 const missing=review({ownership:{status:'missing'}});assert.equal(missing.status,'reviewed');
 const evidence={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-24T23:00:00Z',basis:'confirmed-write-readback',baselineFingerprint:'a'.repeat(64),readbackFingerprint:ownershipFingerprint(observation().tariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[]};
 const generation='generation-2',available={status:'available',snapshot:{version:2,generation,evidence,checksum:ownershipFingerprint({generation,evidence}),historyDigest:'e'.repeat(64)}};
 const retained=review({ownership:available});assert.equal(retained.blockers.join(),'RESTORATION_BASELINE_UNAVAILABLE');noAuthority(retained);
});

test('expired fixed export evidence and Tesla export changes suppress every proposal',()=>{
 const s=site();s.integrations.kraken.fixedExportAssumption.validTo='2026-10-23T12:00:00Z';
 const expired=review({site:s});assert.equal(expired.status,'blocked');assert.equal(expired.proposedRepresentation,null);assert.equal(expired.blockers.join(),'FIXED_EXPORT_EVIDENCE_OUTSIDE_VALIDITY');
 const o=observation();o.tariff.sell_tariff.energy_charges.Annual.rates.cheap=.20;const mismatch=review({observation:o});assert.equal(mismatch.proposedRepresentation,null);assert.equal(mismatch.blockers.join(),'OBSERVED_EXPORT_TARIFF_MISMATCH');noAuthority(mismatch);
});

test('London autumn fold retains complete observed export coverage and exact preservation',()=>{
 const at='2026-10-24T23:30:00Z',k=kraken([vehicle('2026-10-25T14:00:00Z','2026-10-25T15:00:00Z')],at);
 k.importTariff.version.effectiveFrom='2026-10-24T23:00:00Z';k.importTariff.version.effectiveTo='2026-10-26T00:00:00Z';k.importTariff.observedAt=at;
 const r=review({kraken:k,observation:observation(at),assessedAt:at});assert.equal(r.status,'reviewed');assert.equal(r.exportPreserved,true);
 const day=observed.analyseObservedDates({...observation(at),tariff:r.proposedRepresentation},['2026-10-25']).days[0];assert.equal(day.elapsedMinutes,1500);assert.equal(day.periods.reduce((n,p)=>n+(Date.parse(p.end)-Date.parse(p.start))/60000,0),1500);noAuthority(r);
});

test('London spring transition retains the 23-hour local day without export gaps or duplication',()=>{
 const at='2026-03-28T23:30:00Z',k=kraken([vehicle('2026-03-29T13:00:00Z','2026-03-29T14:00:00Z')],at),s=site();
 s.integrations.kraken.fixedExportAssumption.validFrom='2026-03-01T00:00:00Z';s.integrations.kraken.fixedExportAssumption.confirmedAt='2026-03-01T00:00:00Z';
 k.importTariff.version.effectiveFrom='2026-03-28T00:00:00Z';k.importTariff.version.effectiveTo='2026-03-30T00:00:00Z';k.importTariff.observedAt=at;
 const r=review({site:s,kraken:k,observation:observation(at),assessedAt:at});assert.equal(r.status,'reviewed');assert.equal(r.exportPreserved,true);
 const day=observed.analyseObservedDates({...observation(at),tariff:r.proposedRepresentation},['2026-03-29']).days[0];assert.equal(day.elapsedMinutes,1380);assert.equal(day.periods.reduce((n,p)=>n+(Date.parse(p.end)-Date.parse(p.start))/60000,0),1380);noAuthority(r);
});

test('malformed detached Kraken evidence cannot reach desired-state comparison',()=>{
 const k=kraken();k.vehicles[0].plannedDispatches[0].start={toString:null,valueOf:null};
 const r=review({kraken:k});assert.equal(r.status,'blocked');assert.equal(r.decision,null);assert.equal(r.proposedRepresentation,null);assert.ok(r.blockers.includes('KRAKEN_EVIDENCE_MALFORMED'));noAuthority(r);
});

test('malformed vehicle and dispatch containers fail before domain preparation',()=>{
 const malformed=[null,undefined,{},[null]];
 for(const vehicles of malformed){const k=kraken();k.vehicles=vehicles;const r=review({kraken:k});assert.equal(r.status,'blocked');assert.equal(r.blockers.join(),'KRAKEN_EVIDENCE_MALFORMED');assert.equal(r.decision,null);noAuthority(r)}
 for(const dispatches of [null,undefined,{},[null]]){const k=kraken();k.vehicles[0].plannedDispatches=dispatches;const r=review({kraken:k});assert.equal(r.status,'blocked');assert.equal(r.blockers.join(),'KRAKEN_EVIDENCE_MALFORMED');noAuthority(r)}
 assert.equal(review({kraken:kraken([vehicle()])}).status,'reviewed');
});

test('server adapter performs one read of each existing source and exposes no mutation authority',async()=>{
 const calls={kraken:0,tesla:0,ownership:0};const s=site();
 const r=await api.getTrustedSmartSyncReview(s,{now:()=>now,readKraken:async()=>{calls.kraken++;return {state:kraken()}},readTesla:async()=>{calls.tesla++;return observation()},readOwnership:async()=>{calls.ownership++;return {status:'missing'}}});
 assert.deepEqual(calls,{kraken:1,tesla:1,ownership:1});assert.equal(r.status,'reviewed');noAuthority(r);
 const source=fs.readFileSync('src/lib/site/trusted-smart-review.ts','utf8');assert.doesNotMatch(source,/runSupervised|time_of_use_settings|claimExperiment|persistConfirmed|POST|writeFile/);
});

test('server adapter assesses after asynchronous acquisition without rewriting source timestamps',async()=>{
 const order=[],after='2026-10-23T12:00:01.000Z',k=kraken([vehicle()],after),o=observation(after);
 const r=await api.getTrustedSmartSyncReview(site(),{now:()=>{order.push('now');return after},
  readKraken:async()=>{order.push('kraken');await Promise.resolve();return {state:k}},
  readTesla:async()=>{order.push('tesla');await Promise.resolve();return o},
  readOwnership:async()=>{order.push('ownership');await Promise.resolve();return {status:'missing'}}});
 assert.equal(order.at(-1),'now');assert.equal(order.filter(x=>x==='now').length,1);assert.equal(r.status,'reviewed');
 assert.equal(r.assessedAt,after);assert.equal(r.freshness.krakenObservedAt,after);assert.equal(r.freshness.teslaObservedAt,after);noAuthority(r);
});


test('SMART non-decimal energy and BOOST invalid timestamps fail closed (Astra reproductions)',()=>{
 for(const changes of [{energyAddedKwh:'not-a-number'}, {type:'BOOST',start:'not-a-date'}]){
  const k=kraken();Object.assign(k.vehicles[0].plannedDispatches[0],changes);
  const r=review({kraken:k});assert.equal(r.status,'blocked');assert.equal(r.blockers.join(),'KRAKEN_EVIDENCE_MALFORMED');
  assert.equal(r.decision,null);assert.equal(r.proposedRepresentation,null);noAuthority(r);
 }
});

test('all dispatch types enforce strict timestamps, interval ordering and decimal energy',()=>{
 for(const type of ['SMART','BOOST'])for(const changes of [
  {start:'2026-02-30T14:00:00Z'}, {start:'2026-10-23T14:00:00'},
  {end:'not-a-date'}, {end:'2026-10-23T14:00:00Z'}, {end:'2026-10-23T13:00:00Z'},
  {energyAddedKwh:'1e3'}, {energyAddedKwh:' 2 '}, {energyAddedKwh:'Infinity'},
 ]){
  const k=kraken();Object.assign(k.vehicles[0].plannedDispatches[0],{type,...changes});
  // A healthy SMART dispatch must not conceal a malformed sibling.
  k.vehicles.push(vehicle(undefined,undefined,'healthy'));
  const r=review({kraken:k});assert.equal(r.status,'blocked');assert.equal(r.blockers.join(),'KRAKEN_EVIDENCE_MALFORMED');
  assert.equal(r.decision,null);assert.equal(r.proposedRepresentation,null);noAuthority(r);
 }
});

test('valid SMART and BOOST dispatches retain apply and in-sync decisions',()=>{
 for(const [type,energyAddedKwh] of [['SMART','-2.3000'],['SMART',null],['BOOST','2.3000'],['BOOST',null]]){
  const k=kraken();Object.assign(k.vehicles[0].plannedDispatches[0],{type,energyAddedKwh,
   start:'2026-10-23T15:00:00+01:00',end:'2026-10-23T16:00:00+01:00'});
  const r=review({kraken:k});assert.equal(r.status,'reviewed');
  if(type==='SMART')assert.equal(r.decision.action,'apply');else assert.equal(r.decision.status,'in-sync');
  noAuthority(r);
 }
});
