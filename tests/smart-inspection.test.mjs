import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
const cache=new Map();
function load(file, overrides={}) {
 file=path.resolve(file);if(cache.has(file)&&!Object.keys(overrides).length)return cache.get(file);
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,Date,Error,structuredClone,require(name){
 if(name in overrides)return overrides[name];
 if(name==='node:crypto')return crypto;
 assert.ok(name.startsWith('.'),`No IO dependency ${name}`);
 assert.doesNotMatch(name,/supervised-experiment|supervised-local|journal|ownership-store|ownership-sqlite|client/);
 return load(path.resolve(path.dirname(file),name+'.ts'));
 }});if(!Object.keys(overrides).length)cache.set(file,exports);return exports;
}
const {inspectSmartTariff,formatSmartInspection}=load('src/lib/tesla-tariff/smart-inspection.ts');
const {validateKrakenImportTariff}=load('src/lib/kraken/import-tariff.ts');
const {captureObservedTariff}=load('src/lib/tesla-tariff/observed-tariff.ts');
function fixture(){
 const now='2026-10-11T12:00:00.000Z';
 const site=structuredClone(load('src/lib/site/current-site.ts').currentSite);
 site.id='synthetic';site.integrations.tesla.energySiteId='123';
 site.integrations.kraken.importTariffIdentity={accountRef:'synthetic-account',meterPointRef:'synthetic-meter',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G'};
 delete site.integrations.kraken.exportTariffIdentity;
 const rate=(validFrom,validTo,value)=>({validFrom,validTo,value,preVatValue:value,rateType:'STANDARD'});
 const importTariff=validateKrakenImportTariff({accountRef:'synthetic-account',electricityAgreements:[{
 validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',isRevoked:false,
 meterPoint:{direction:'IMPORT',meterPointRef:'synthetic-meter'},tariff:{__typename:'HalfHourlyTariff',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:site.integrations.kraken.importTariffIdentity.tariffCode,
 displayName:'Synthetic',fullName:'Synthetic',isExport:false,standingCharge:0,preVatStandingCharge:0,
 unitRates:[rate('2026-10-10T23:00:00Z','2026-10-11T05:00:00Z',2.85),rate('2026-10-11T05:00:00Z','2026-10-11T23:00:00Z',23.978),rate('2026-10-11T23:00:00Z','2026-10-12T05:00:00Z',2.85),rate('2026-10-12T05:00:00Z','2026-10-12T23:00:00Z',23.978)]}}]},
 {...site.integrations.kraken.importTariffIdentity,observedAt:now,timeZone:'Europe/London'});
 assert.equal(importTariff.status,'available');
 const side=sell=>({name:'Synthetic',utility:'Synthetic',currency:'GBP',seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{all:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,toHour:0,fromMinute:0,toMinute:0}]}}}},energy_charges:{Annual:{rates:{all:sell?0.175:0.23978}}}});
 const observation=captureObservedTariff({response:{energy_site_id:123,installation_time_zone:'Europe/London',tariff_content_v2:{...side(false),sell_tariff:side(true)}}},'123',now);
 const kraken={stale:false,lastSuccessfulUpdate:now,importTariff,vehicles:[{id:'synthetic-ev',name:'Synthetic EV',plannedDispatches:[{start:'2026-10-11T13:00:00Z',end:'2026-10-11T13:30:00Z',type:'SMART',energyAddedKwh:'2.0001'}]}]};
 return {site,kraken,observation,now};
}
test('real reconciliation creates exact inspection candidate with no executor or storage dependency',()=>{
 const input=fixture(),r=inspectSmartTariff(input);assert.ok(r.payload,JSON.stringify(r));assert.equal(r.exportPreserved,true);assert.ok(r.restorationCandidate);
 assert.equal(r.importRate.amount,0.0285);assert.equal(r.slots.length,1);assert.equal(r.slots[0].eligibility,'planned-conditional');
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(r[key],false);
 for(const b of ['BUY_BELOW_SELL','ROLLBACK_UNPROVEN','BOUNDED_FORECAST','HISTORICAL_JOURNAL_UNRESOLVED','TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE'])assert.ok(r.blockers.includes(b));
 assert.doesNotMatch(formatSmartInspection(r),/synthetic-account|synthetic-meter/);
 assert.deepEqual(structuredClone(r.payload.tou_settings.tariff_content_v2.sell_tariff),structuredClone(input.observation.tariff.sell_tariff));
});
test('interval and rate changes invalidate proposal; unchanged schedule identity survives fresh retrieval',()=>{
 const f=fixture(),a=inspectSmartTariff(f);f.kraken.vehicles[0].plannedDispatches[0].end='2026-10-11T14:00:00Z';const b=inspectSmartTariff(f);
 assert.notEqual(a.scheduleEvidenceIdentity,b.scheduleEvidenceIdentity);assert.notEqual(a.proposalFingerprint,b.proposalFingerprint);
 f.kraken.importTariff.version.scheduledChargingImport.amount=0.03;const c=inspectSmartTariff(f);assert.notEqual(c.proposalFingerprint,b.proposalFingerprint);
 f.kraken.lastSuccessfulUpdate='2026-10-11T12:00:01.000Z';f.now=f.kraken.lastSuccessfulUpdate;assert.equal(inspectSmartTariff(f).scheduleEvidenceIdentity,c.scheduleEvidenceIdentity);
});
test('stale, incomplete, missing and wrong-account evidence cannot create payload',()=>{
 for(const change of [f=>f.kraken.stale=true,f=>f.kraken.lastSuccessfulUpdate='2026-10-11T11:58:00Z',f=>f.kraken=null,f=>delete f.kraken.importTariff,f=>f.kraken.importTariff.accountRef='wrong',f=>f.observation=null]){
 const f=fixture();change(f);assert.equal(inspectSmartTariff(f).payload,null);
 }
});
test('BOOST excluded; original half-hour and explicit DST-fold boundaries survive',()=>{
 const f=fixture();f.kraken.vehicles[0].plannedDispatches[0].type='BOOST';assert.equal(inspectSmartTariff(f).slots.length,0);
 f.now='2026-10-25T00:00:00Z';f.kraken.vehicles[0].plannedDispatches=[{start:'2026-10-25T01:00:00+01:00',end:'2026-10-25T01:30:00+00:00',type:'SMART',energyAddedKwh:null}];
 const r=inspectSmartTariff(f);assert.equal(r.slots[0].start,'2026-10-25T00:00:00.000Z');assert.equal(r.slots[0].end,'2026-10-25T01:30:00.000Z');assert.equal(r.payload,null);
});
test('server entry acquires each production adapter once and sanitizes failures',async()=>{
 let k=0,t=0;const f=fixture();
 const api=load('src/lib/site/inspect-smart-charge.ts',{'server-only':{},'./kraken-refresh':{getRecordedKrakenState:async()=>{k++;return f.kraken;}},'./tesla-observation':{getSiteTeslaObservation:async()=>{t++;throw Error('secret');}}});
 const r=await api.inspectSmartCharge(f.site);assert.equal(k,1);assert.equal(t,1);assert.equal(r.report.payload,null);assert.doesNotMatch(r.text,/secret/);
});
test('incomplete lists and duplicate vehicles fail before reconciliation, not as empty schedules',()=>{
 for(const change of [f=>f.kraken.vehicles[0].plannedDispatches=null,f=>delete f.kraken.vehicles[0].plannedDispatches,f=>f.kraken.vehicles.push(structuredClone(f.kraken.vehicles[0]))]){
 const f=fixture();change(f);const r=inspectSmartTariff(f);assert.equal(r.payload,null);assert.equal(r.payloadUnavailableReason,'INCOMPLETE_KRAKEN_OBSERVATION');
 }
});
test('reordering preserves identities and returned reports do not alias evidence',()=>{
 const f=fixture();f.kraken.vehicles[0].plannedDispatches.push({start:'2026-10-11T15:00:00Z',end:'2026-10-11T15:30:00Z',type:'SMART',energyAddedKwh:'1'});
 const a=inspectSmartTariff(f);f.kraken.vehicles[0].plannedDispatches.reverse();const b=inspectSmartTariff(f);
 assert.equal(a.scheduleEvidenceIdentity,b.scheduleEvidenceIdentity);assert.equal(a.observationContentIdentity,b.observationContentIdentity);
 a.importRate.amount=999;assert.equal(f.kraken.importTariff.version.scheduledChargingImport.amount,0.0285);
});
test('existing export rejection remains blocking and cannot hide behind commercial assumption',()=>{
 const f=fixture();f.site.integrations.kraken.exportTariffIdentity={accountRef:'synthetic-export',tariffCode:'x',productCode:'x'};
 f.kraken.exportTariffDiagnostic={status:'unavailable',code:'EXPORT_ACCOUNT_CONTEXT_CHANGED'};
 const r=inspectSmartTariff(f);assert.equal(r.slots.length,1);assert.equal(r.payload,null);assert.ok(r.blockers.includes('EXPORT_ACCOUNT_CONTEXT_CHANGED'));
});
test('display does not extrapolate known slot prices past verified tariff coverage',()=>{
 const f=fixture();f.kraken.importTariff.version.effectiveTo='2026-10-11T13:15:00Z';
 const r=inspectSmartTariff(f);assert.equal(r.slots[0].price,null);assert.equal(r.payload,null);
});
function recoveredOptionalShape(f){
 f.kraken.importTariffDiagnostic=undefined;f.kraken.exportTariffDiagnostic=undefined;
 f.kraken.historicalImportRates={status:'available',accountRef:'synthetic-account',meterPointRef:'synthetic-meter',observedAt:f.now,
  period:{start:'2026-10-10T00:00:00.000Z',end:'2026-10-10T00:30:00.000Z'},vatBasis:'corroborated-not-independent',
  windows:[{start:'2026-10-10T00:00:00.000Z',end:'2026-10-10T00:30:00.000Z',price:{amount:0.0285,currency:'GBP',unit:'kWh'},
   kind:'standard',condition:'none',sources:[{provider:'eon-next-kraken',description:'Synthetic history',tariffVersion:undefined,
    observedAt:f.now,stale:false,cause:undefined}]}]};
 f.kraken.historicalImportRatesDiagnostic=undefined;
 return f;
}
test('cache-reconstructed optional undefined fields are omitted without changing a valid proposal',()=>{
 const expected=inspectSmartTariff(fixture()),f=recoveredOptionalShape(fixture()),actual=inspectSmartTariff(f);
 assert.deepEqual(structuredClone(actual.payload),structuredClone(expected.payload));
 assert.deepEqual(structuredClone(actual.restorationCandidate),structuredClone(expected.restorationCandidate));
 assert.equal(actual.payloadUnavailableReason,expected.payloadUnavailableReason);
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(actual[key],false);
});
test('stale recovered optional evidence remains unavailable rather than malformed or current',()=>{
 const f=recoveredOptionalShape(fixture());f.kraken.stale=true;const r=inspectSmartTariff(f);
 assert.equal(r.payload,null);assert.equal(r.importRate,null);assert.equal(r.payloadUnavailableReason,'VERIFIED_IMPORT_TARIFF_REQUIRED');
 assert.ok(!r.blockers.includes('INSPECTION_KRAKEN_TARIFF_EVIDENCE_INVALID'));
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(r[key],false);
});
test('incomplete and malformed normalized import tariff evidence fails closed without leaking input',()=>{
 const cases=[
  f=>{f.kraken.importTariff={status:'available',accountRef:'synthetic-account'};},
  f=>{delete f.kraken.importTariff.agreement.tariffCode;},
  f=>{delete f.kraken.importTariff.version.dailyImportWindows;},
  f=>{f.kraken.importTariff.version.normalImport=undefined;},
  f=>{f.kraken.importTariff.version.normalImport={amount:Infinity,currency:'GBP',unit:'kWh'};},
 ];
 for(const change of cases){const f=fixture();change(f);let r;
  assert.doesNotThrow(()=>{r=inspectSmartTariff(f);});assert.equal(r.payload,null);
  assert.equal(r.payloadUnavailableReason,'INSPECTION_KRAKEN_TARIFF_EVIDENCE_INVALID');
  assert.ok(r.blockers.includes('INSPECTION_KRAKEN_TARIFF_EVIDENCE_INVALID'));
  assert.doesNotMatch(formatSmartInspection(r),/synthetic-account|synthetic-meter/);
 }
});
test('undefined and sparse array elements remain invalid evidence',()=>{
 for(const dispatches of [[undefined],new Array(1)]){const f=fixture();f.kraken.vehicles[0].plannedDispatches=dispatches;const r=inspectSmartTariff(f);
  assert.equal(r.payload,null);assert.equal(r.payloadUnavailableReason,'INSPECTION_KRAKEN_TARIFF_EVIDENCE_INVALID');
 }
});
test('cyclic, malformed and unsupported Tesla evidence fails closed before fingerprinting',()=>{
 const cases=[
  f=>{f.observation.tariff.extra=f.observation.tariff;},
  f=>{f.observation={};},
  f=>{delete f.observation.source.observedAt;},
  f=>{f.observation.tariff.sell_tariff.energy_charges.Annual.rates.all=new Map([['private-marker',1]]);},
  f=>{Object.defineProperty(f.observation.source,'energySiteId',{enumerable:true,get(){throw Error('private-marker');}});},
 ];
 for(const change of cases){const f=fixture();change(f);let r;
  assert.doesNotThrow(()=>{r=inspectSmartTariff(f);});assert.equal(r.payload,null);
  assert.equal(r.payloadUnavailableReason,'INSPECTION_TESLA_EVIDENCE_INVALID');
  assert.ok(r.blockers.includes('INSPECTION_TESLA_EVIDENCE_INVALID'));
  assert.doesNotMatch(formatSmartInspection(r),/private-marker/);
  for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(r[key],false);
 }
});
test('validated evidence is detached and valid proposal/restoration bytes remain identical',()=>{
 const f=fixture(),pristine=fixture();const expected=inspectSmartTariff(pristine),actual=inspectSmartTariff(f);
 assert.deepEqual(structuredClone(actual.payload),structuredClone(expected.payload));
 assert.deepEqual(structuredClone(actual.restorationCandidate),structuredClone(expected.restorationCandidate));
 f.kraken.importTariff.version.scheduledChargingImport.amount=999;
 f.observation.tariff.energy_charges.Annual.rates.all=999;
 assert.deepEqual(structuredClone(actual.payload),structuredClone(expected.payload));
 assert.deepEqual(structuredClone(actual.restorationCandidate),structuredClone(expected.restorationCandidate));
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(actual[key],false);
});
