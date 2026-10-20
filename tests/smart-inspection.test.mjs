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
const {observedEconomicSignal}=load('src/lib/tesla-tariff/observed-economic.ts');
const {comparePriceSignalsInDomain}=load('src/lib/tariff/comparison-domain.ts');
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
 assert.equal(r.smartOpportunity.status,'tariff-change-proposed');
 assert.equal(r.freshBaselineEligibility.status,'blocked');
 for(const code of ['EXACT_BASELINE_APPROVAL_REQUIRED','ROLLBACK_UNPROVEN','OWNERSHIP_UNRESOLVED'])
  assert.ok(r.freshBaselineEligibility.blockers.includes(code),code);
 assert.equal(r.financialImplications.conditionalImportSavingPerKwh.amount,0.21128);
 assert.equal(r.financialImplications.billingStatus,'estimated-not-billing-confirmed');
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])
  assert.equal(r.freshBaselineEligibility[key],false);
});
test('no SMART windows is a successful not-applicable inspection with no proposal or attempt identity',()=>{
 const f=fixture();f.kraken.vehicles.push({id:'second-vehicle',name:'Second vehicle',plannedDispatches:[]});
 for(const vehicle of f.kraken.vehicles)vehicle.plannedDispatches=[];
 const r=inspectSmartTariff(f);
 assert.equal(r.smartOpportunity.status,'no-smart-windows');assert.equal(r.smartOpportunity.activeOrUpcomingCount,0);
 assert.equal(r.payload,null);assert.equal(r.proposalFingerprint,null);assert.equal(r.status,'in-sync');
 assert.equal(r.freshBaselineEligibility.status,'not-applicable');assert.equal(r.freshBaselineEligibility.reason,'no-smart-windows');
 assert.equal(r.freshBaselineEligibility.nextAttempt,null);assert.equal(r.financialImplications.conditionalImportSavingPerKwh,null);
 assert.equal(r.teslaBaseline.source.energySiteId,'123');assert.equal(r.teslaBaseline.source.timeZone,'Europe/London');
 assert.equal(r.krakenTariff.scheduledChargingImport.amount,0.0285);assert.equal(r.vehicles.length,2);
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority']){
  assert.equal(r[key],false);assert.equal(r.freshBaselineEligibility[key],false);
 }
});
test('empty schedules require accepted fresh account-bound Kraken evidence',()=>{
 const empty=()=>{const f=fixture();for(const vehicle of f.kraken.vehicles)vehicle.plannedDispatches=[];return f;};
 const cases=[
  ['stale cached',f=>{f.kraken.stale=true;},'STALE_KRAKEN_EVIDENCE'],
  ['expired retrieval',f=>{f.kraken.lastSuccessfulUpdate='2026-10-11T11:58:00Z';},'STALE_KRAKEN_EVIDENCE'],
  ['wrong account',f=>{f.kraken.importTariff.accountRef='wrong-account';},'VERIFIED_IMPORT_TARIFF_REQUIRED'],
  ['missing snapshot',f=>{f.kraken=null;},'KRAKEN_UNAVAILABLE'],
 ];
 for(const [name,change,blocker] of cases){
  const f=empty();change(f);const r=inspectSmartTariff(f),formatted=formatSmartInspection(r);
  assert.equal(r.smartOpportunity.status,'incomplete-evidence',name);
  assert.equal(r.freshBaselineEligibility.status,'not-assessable',name);
  assert.equal(r.payload,null,name);assert.equal(r.writeReady,false,name);
  assert.ok(r.blockers.includes(blocker),`${name}: ${JSON.stringify(r.blockers)}`);
  assert.match(formatted,/"status": "incomplete-evidence"/,name);
  assert.match(formatted,new RegExp(blocker),name);
  assert.doesNotMatch(formatted,/"status": "no-smart-windows"/,name);
  for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority']){
   assert.equal(r[key],false,name);assert.equal(r.freshBaselineEligibility[key],false,name);
  }
 }
});
test('stale authenticated import pricing cannot fall back to configured prices for an actionable schedule',()=>{
 const f=fixture();
 f.kraken.importTariff.observedAt='2026-10-11T11:58:00.000Z';
 assert.ok(f.site.tariff?.versions?.length,'fixture must retain otherwise usable configured prices');
 const r=inspectSmartTariff(f),formatted=formatSmartInspection(r);
 assert.equal(r.payload,null);assert.equal(r.proposalFingerprint,null);
 assert.equal(r.payloadUnavailableReason,'VERIFIED_IMPORT_TARIFF_REQUIRED');
 assert.equal(r.smartOpportunity.status,'incomplete-evidence');
 assert.equal(r.freshBaselineEligibility.status,'not-assessable');
 assert.equal(r.krakenTariff,null);assert.equal(r.importRate,null);
 assert.ok(r.blockers.includes('VERIFIED_IMPORT_TARIFF_REQUIRED'));
 assert.match(formatted,/"status": "incomplete-evidence"/);
 assert.match(formatted,/VERIFIED_IMPORT_TARIFF_REQUIRED/);
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority']){
  assert.equal(r[key],false);assert.equal(r.freshBaselineEligibility[key],false);
 }
});
test('two independently scheduled vehicles produce one bounded daytime SMART change with exact provenance',()=>{
 const f=fixture();
 f.now='2026-10-19T12:00:00.000Z';f.kraken.lastSuccessfulUpdate=f.now;f.kraken.importTariff.observedAt=f.now;
 f.kraken.importTariff.version.effectiveFrom='2026-10-18T23:00:00.000Z';f.kraken.importTariff.version.effectiveTo='2026-10-20T23:00:00.000Z';
 f.observation.source.observedAt=f.now;
 f.kraken.vehicles=[
  {id:'vehicle-a',name:'Vehicle A',plannedDispatches:[{start:'2026-10-19T14:00:00Z',end:'2026-10-19T15:00:00Z',type:'SMART',energyAddedKwh:'2.0'}]},
  {id:'vehicle-b',name:'Vehicle B',plannedDispatches:[{start:'2026-10-19T14:30:00Z',end:'2026-10-19T15:30:00Z',type:'SMART',energyAddedKwh:'3.0'}]},
 ];
 const before=JSON.stringify(f),r=inspectSmartTariff(f);
 assert.equal(r.status,'update-required');assert.ok(r.payload);assert.notEqual(r.payloadUnavailableReason,'NO_MANAGED_ECONOMIC_CHANGE');
 assert.equal(r.smartOpportunity.status,'tariff-change-proposed');assert.equal(r.vehicles.length,2);
 assert.deepEqual(r.vehicles.map(v=>[v.vehicleId,v.dispatches[0].start]),[
  ['vehicle-a','2026-10-19T14:00:00Z'],['vehicle-b','2026-10-19T14:30:00Z']]);
 assert.deepEqual(structuredClone(r.slots),[
  {start:'2026-10-19T14:00:00.000Z',end:'2026-10-19T15:00:00.000Z',vehicle:'Vehicle A',eligibility:'planned-conditional',price:{amount:0.0285,currency:'GBP',unit:'kWh'}},
  {start:'2026-10-19T14:30:00.000Z',end:'2026-10-19T15:30:00.000Z',vehicle:'Vehicle B',eligibility:'planned-conditional',price:{amount:0.0285,currency:'GBP',unit:'kWh'}},
 ]);
 assert.deepEqual(structuredClone(r.differences),[
  {start:'2026-10-19T14:00:00.000Z',end:'2026-10-19T15:30:00.000Z',channels:['import']},
 ]);
 const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'
  ?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
 const evidenceDigest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
 const expectedDispatches=[
  {id:'vehicle-a',name:'Vehicle A',dispatches:[{start:'2026-10-19T14:00:00Z',end:'2026-10-19T15:00:00Z',type:'SMART',energyAddedKwh:'2.0'}]},
  {id:'vehicle-b',name:'Vehicle B',dispatches:[{start:'2026-10-19T14:30:00Z',end:'2026-10-19T15:30:00Z',type:'SMART',energyAddedKwh:'3.0'}]},
 ];
 const expectedScheduleKey=canonical(expectedDispatches),session=s=>JSON.stringify([Date.parse(s.start),Date.parse(s.end),s.type,s.energyAddedKwh]);
 const expectedObservationKey=JSON.stringify([f.site.id,expectedDispatches.map(v=>[v.id,v.dispatches.map(session)])]);
 const assertEvidence=report=>{
  assert.equal(report.scheduleEvidenceIdentity,evidenceDigest(expectedScheduleKey));
  assert.equal(report.observationContentIdentity,evidenceDigest(expectedObservationKey));
 };
 assertEvidence(r);
 const decodePayload=payload=>{
  const observed=captureObservedTariff({response:{energy_site_id:123,installation_time_zone:'Europe/London',
   tariff_content_v2:payload.tou_settings.tariff_content_v2}},'123',f.now);
  assert.ok(observed.tariff);return observedEconomicSignal(observed,r.domain);
 };
 const payloadCurve=payload=>decodePayload(payload).signal.import;
 const expectedCurve=[
 {start:'2026-10-19T12:00:00.000Z',end:'2026-10-19T14:00:00.000Z',amount:0.23978},
 {start:'2026-10-19T14:00:00.000Z',end:'2026-10-19T15:30:00.000Z',amount:0.0285},
 {start:'2026-10-19T15:30:00.000Z',end:'2026-10-19T23:00:00.000Z',amount:0.23978},
  {start:'2026-10-19T23:00:00.000Z',end:'2026-10-20T23:00:00.000Z',amount:0.23978},
 ];
 const assertPrices=payload=>{
  const curve=payloadCurve(payload).map(w=>({start:w.start,end:w.end,amount:w.price?.amount}));
  assert.deepEqual(structuredClone(curve),expectedCurve);
 };
 assertPrices(r.payload);
 const london=time=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time));
 assert.equal(london('2026-10-19T14:00:00.000Z'),'15:00');assert.equal(london('2026-10-19T15:30:00.000Z'),'16:30');
 assert.equal(r.exportPreserved,true);
 assert.deepEqual(structuredClone(r.payload.tou_settings.tariff_content_v2.sell_tariff),structuredClone(f.observation.tariff.sell_tariff));
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(r[key],false);
 const tampered=structuredClone(r.payload);
 for(const charges of Object.values(tampered.tou_settings.tariff_content_v2.energy_charges))
  for(const key of Object.keys(charges.rates))if(charges.rates[key]===0.0285)charges.rates[key]=0.99;
 assert.throws(()=>assertPrices(tampered),assert.AssertionError);
 const gap=structuredClone(r.payload),tariff=gap.tou_settings.tariff_content_v2;
 const season=Object.keys(tariff.energy_charges).find(key=>Object.values(tariff.energy_charges[key].rates).includes(0.0285));
 assert.ok(season);const rates=tariff.energy_charges[season].rates;
 const periods=key=>tariff.seasons[season].tou_periods[key].periods;
 const appliesOnMonday=period=>period.fromDayOfWeek<=1&&period.toDayOfWeek>=1;
 const cheap=Object.keys(rates).find(key=>rates[key]===0.0285&&periods(key).some(period=>appliesOnMonday(period)
  &&period.fromHour*60+period.fromMinute<=15*60+10&&period.toHour*60+period.toMinute>=15*60+20));
 const peak=Object.keys(rates).find(key=>rates[key]===0.23978&&periods(key).some(appliesOnMonday));
 assert.ok(cheap&&peak);const cheapPeriods=tariff.seasons[season].tou_periods[cheap].periods;
 const original=cheapPeriods.find(period=>period.fromHour*60+period.fromMinute<=15*60+10
  &&period.toHour*60+period.toMinute>=15*60+20);
 assert.ok(original);tariff.seasons[season].tou_periods[cheap].periods=cheapPeriods.flatMap(period=>period===original?[
  {...period,toHour:15,toMinute:10},
  {...period,fromHour:15,fromMinute:20},
 ]:[period]);
 tariff.seasons[season].tou_periods[peak].periods.push(
  {...original,fromHour:15,fromMinute:10,toHour:15,toMinute:20});
 const decodedGap=decodePayload(gap),gapAtQuarterPast=decodedGap.signal.import.find(window=>
  Date.parse(window.start)<=Date.parse('2026-10-19T14:15:00.000Z')&&Date.parse(window.end)>Date.parse('2026-10-19T14:15:00.000Z'));
 assert.equal(gapAtQuarterPast?.start,'2026-10-19T14:10:00.000Z');
 assert.equal(gapAtQuarterPast?.end,'2026-10-19T14:20:00.000Z');
 assert.equal(gapAtQuarterPast?.priceStatus,'known');assert.equal(gapAtQuarterPast?.price?.amount,0.23978);
 assert.throws(()=>assertPrices(gap),assert.AssertionError);
 const unrelated={...r,scheduleEvidenceIdentity:evidenceDigest(canonical([{id:'unrelated',name:'Unrelated',dispatches:[]}])),
  observationContentIdentity:evidenceDigest('unrelated-observation')};
 assert.throws(()=>assertEvidence(unrelated),assert.AssertionError);
 assert.equal(r.importRate.amount,0.0285);assert.deepEqual(structuredClone(r.differences),[
  {start:'2026-10-19T14:00:00.000Z',end:'2026-10-19T15:30:00.000Z',channels:['import']},
 ]);
 assert.equal(JSON.stringify(f),before);
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
 f.kraken.lastSuccessfulUpdate=f.kraken.importTariff.observedAt=f.observation.source.observedAt=f.now;
 f.kraken.importTariff.version.effectiveFrom='2026-10-24T23:00:00.000Z';f.kraken.importTariff.version.effectiveTo='2026-10-26T00:00:00.000Z';
 const r=inspectSmartTariff(f);assert.equal(r.slots[0].start,'2026-10-25T00:00:00.000Z');assert.equal(r.slots[0].end,'2026-10-25T01:30:00.000Z');assert.equal(r.payload,null);
});
test('inspection domain is minute-aligned and bounded by authenticated tariff coverage',()=>{
 const f=fixture();f.now='2026-10-19T08:18:29.438Z';f.kraken.lastSuccessfulUpdate=f.kraken.importTariff.observedAt=f.observation.source.observedAt=f.now;
 f.kraken.importTariff.version.effectiveFrom='2026-10-18T23:00:00.000Z';f.kraken.importTariff.version.effectiveTo='2026-10-19T23:00:00.000Z';
 f.kraken.vehicles[0].plannedDispatches=[{start:'2026-10-19T08:08:00Z',end:'2026-10-19T10:00:00Z',type:'SMART',energyAddedKwh:'2'}];
 const r=inspectSmartTariff(f);assert.ok(r.payload,JSON.stringify(r));assert.equal(r.status,'update-required');
 assert.deepEqual(structuredClone(r.domain),{start:'2026-10-19T08:19:00.000Z',end:'2026-10-19T23:00:00.000Z'});
 assert.deepEqual(structuredClone(r.differences),[{start:'2026-10-19T08:19:00.000Z',end:'2026-10-19T10:00:00.000Z',channels:['import']}]);
 const proposed=captureObservedTariff({response:{energy_site_id:123,installation_time_zone:'Europe/London',
  tariff_content_v2:r.payload.tou_settings.tariff_content_v2}},'123',f.now);
 assert.ok(proposed.tariff);
 for(const outside of [{start:'2026-10-18T23:00:00.000Z',end:r.domain.start},{start:'2026-10-19T10:00:00.000Z',end:r.domain.end}]){
  const before=observedEconomicSignal(f.observation,outside).signal,after=observedEconomicSignal(proposed,outside).signal;
  assert.equal(comparePriceSignalsInDomain(before,after,outside).status,'unchanged');
 }
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(r[key],false);
});
test('SMART dispatch coverage accepts the exact tariff boundary and rejects every uncovered future portion',()=>{
 const prepare=dispatch=>{const f=fixture();f.now='2026-10-19T21:00:00.000Z';
  f.kraken.lastSuccessfulUpdate=f.kraken.importTariff.observedAt=f.observation.source.observedAt=f.now;
  f.kraken.importTariff.version.effectiveFrom='2026-10-18T23:00:00.000Z';f.kraken.importTariff.version.effectiveTo='2026-10-19T23:00:00.000Z';
  f.kraken.vehicles[0].plannedDispatches=[dispatch];return f;};
 const exact=inspectSmartTariff(prepare({start:'2026-10-19T22:00:00Z',end:'2026-10-19T23:00:00Z',type:'SMART',energyAddedKwh:null}));
 assert.notEqual(exact.payloadUnavailableReason,'SMART_DISPATCH_OUTSIDE_VERIFIED_TARIFF_COVERAGE');assert.ok(exact.payload);
 for(const dispatch of [
  {start:'2026-10-19T22:30:00Z',end:'2026-10-19T23:30:00Z',type:'SMART',energyAddedKwh:null},
  {start:'2026-10-19T23:00:00Z',end:'2026-10-19T23:30:00Z',type:'SMART',energyAddedKwh:null},
 ]){const r=inspectSmartTariff(prepare(dispatch));assert.equal(r.payload,null);
  assert.equal(r.payloadUnavailableReason,'SMART_DISPATCH_OUTSIDE_VERIFIED_TARIFF_COVERAGE');
  assert.equal(r.smartOpportunity.status,'dispatch-outside-verified-coverage');
  assert.equal(r.freshBaselineEligibility.status,'not-assessable');
  assert.ok(r.blockers.includes('SMART_DISPATCH_OUTSIDE_VERIFIED_TARIFF_COVERAGE'));
 }
});
test('long authenticated coverage is capped at the supported 48-hour comparison horizon',()=>{
 const prepare=dispatch=>{const f=fixture();f.now='2026-10-19T08:18:29.438Z';
  f.kraken.lastSuccessfulUpdate=f.kraken.importTariff.observedAt=f.observation.source.observedAt=f.now;
  f.kraken.importTariff.version.effectiveFrom='2026-10-18T23:00:00.000Z';f.kraken.importTariff.version.effectiveTo='2026-10-25T23:00:00.000Z';
  f.kraken.vehicles[0].plannedDispatches=[dispatch];return f;};
 const end='2026-10-21T08:19:00.000Z';
 const sameDay=inspectSmartTariff(prepare({start:'2026-10-19T14:00:00Z',end:'2026-10-19T15:00:00Z',type:'SMART',energyAddedKwh:null}));
 assert.deepEqual(structuredClone(sameDay.domain),{start:'2026-10-19T08:19:00.000Z',end});
 assert.ok(sameDay.payload,JSON.stringify(sameDay));assert.equal(sameDay.status,'update-required');
 const exact=inspectSmartTariff(prepare({start:'2026-10-21T07:19:00Z',end,type:'SMART',energyAddedKwh:null}));
 assert.ok(exact.payload,JSON.stringify(exact));assert.notEqual(exact.payloadUnavailableReason,'SMART_DISPATCH_OUTSIDE_SUPPORTED_COMPARISON_HORIZON');
 for(const dispatch of [
  {start:'2026-10-21T08:19:00Z',end:'2026-10-21T08:49:00Z',type:'SMART',energyAddedKwh:null},
  {start:'2026-10-21T07:49:00Z',end:'2026-10-21T08:49:00Z',type:'SMART',energyAddedKwh:null},
 ]){const r=inspectSmartTariff(prepare(dispatch));assert.equal(r.payload,null);
  assert.equal(r.payloadUnavailableReason,'SMART_DISPATCH_OUTSIDE_SUPPORTED_COMPARISON_HORIZON');
  assert.ok(r.blockers.includes('SMART_DISPATCH_OUTSIDE_SUPPORTED_COMPARISON_HORIZON'));
 }
});
test('server entry acquires each production adapter once and sanitizes failures',async()=>{
 let k=0,t=0;const f=fixture();
 const api=load('src/lib/site/inspect-smart-charge.ts',{'server-only':{},'./kraken-refresh':{
  getRecordedKrakenStateForInspection:async()=>{k++;return {state:{...f.kraken,stale:true},acquisition:{attempted:true,
   freshEvidenceObtained:false,staleFallbackUsed:true,code:'KRAKEN_AUTHENTICATION_FAILED'}};}},
 './tesla-observation':{teslaObservationConfigurationDiagnostic:()=>null,
  getSiteTeslaObservation:async()=>{t++;throw Error('TESLA_REFRESH_UNAVAILABLE');}}});
 const r=await api.inspectSmartCharge(f.site);assert.equal(k,1);assert.equal(t,1);assert.equal(r.report.payload,null);
 assert.deepEqual(structuredClone(r.report.acquisitionDiagnostics),{
  kraken:{attempted:true,freshEvidenceObtained:false,staleFallbackUsed:true,code:'KRAKEN_AUTHENTICATION_FAILED'},
  tesla:{attempted:true,freshEvidenceObtained:false,staleFallbackUsed:false,code:'TESLA_REFRESH_UNAVAILABLE'},
 });
 assert.doesNotMatch(r.text,/secret|token|JWT/i);
});
test('server entry reports successful fresh acquisition without a false diagnostic',async()=>{
 let k=0,t=0;const f=fixture();
 const api=load('src/lib/site/inspect-smart-charge.ts',{'server-only':{},'./kraken-refresh':{
  getRecordedKrakenStateForInspection:async()=>{k++;return {state:f.kraken,acquisition:{attempted:true,
   freshEvidenceObtained:true,staleFallbackUsed:false,code:null}};}},
 './tesla-observation':{teslaObservationConfigurationDiagnostic:()=>null,
  getSiteTeslaObservation:async()=>{t++;return f.observation;}}});
 const r=await api.inspectSmartCharge(f.site);assert.equal(k,1);assert.equal(t,1);assert.ok(r.report.teslaBaseline);
 assert.deepEqual(structuredClone(r.report.acquisitionDiagnostics),{
  kraken:{attempted:true,freshEvidenceObtained:true,staleFallbackUsed:false,code:null},
  tesla:{attempted:true,freshEvidenceObtained:true,staleFallbackUsed:false,code:null},
 });
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])
  assert.equal(r.report[key],false);
});
test('invalid Tesla capture reports response invalid instead of fresh evidence',async()=>{
 let calls=0;const f=fixture();
 const api=load('src/lib/site/inspect-smart-charge.ts',{'server-only':{},'./kraken-refresh':{
  getRecordedKrakenStateForInspection:async()=>({state:f.kraken,acquisition:{attempted:true,
   freshEvidenceObtained:true,staleFallbackUsed:false,code:null}})},
 './tesla-observation':{teslaObservationConfigurationDiagnostic:()=>null,
  getSiteTeslaObservation:async()=>{calls++;return {};}}});
 const r=await api.inspectSmartCharge(f.site);assert.equal(calls,1);assert.equal(r.report.teslaBaseline,null);
 assert.deepEqual(structuredClone(r.report.acquisitionDiagnostics.tesla),{attempted:true,
  freshEvidenceObtained:false,staleFallbackUsed:false,code:'TESLA_RESPONSE_INVALID'});
 assert.equal(r.report.payload,null);assert.equal(r.report.smartOpportunity.status,'incomplete-evidence');
 for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])
  assert.equal(r.report[key],false);
});
test('Tesla pre-acquisition configuration failures report not attempted and make no client call',async()=>{
 for(const [code,change] of [['TESLA_DISABLED',site=>{site.integrations.tesla.enabled=false;}],
  ['TESLA_SITE_NOT_CONFIGURED',site=>{delete site.integrations.tesla.energySiteId;}]]){
  let calls=0;const f=fixture();change(f.site);
  const api=load('src/lib/site/inspect-smart-charge.ts',{'server-only':{},'./kraken-refresh':{
   getRecordedKrakenStateForInspection:async()=>({state:f.kraken,acquisition:{attempted:true,
    freshEvidenceObtained:true,staleFallbackUsed:false,code:null}})},
  './tesla-observation':{teslaObservationConfigurationDiagnostic:()=>code,
   getSiteTeslaObservation:async()=>{calls++;throw Error('must-not-run');}}});
  const r=await api.inspectSmartCharge(f.site);assert.equal(calls,0);
  assert.deepEqual(structuredClone(r.report.acquisitionDiagnostics.tesla),{attempted:false,
   freshEvidenceObtained:false,staleFallbackUsed:false,code});
 }
});
test('incomplete lists and duplicate vehicles fail before reconciliation, not as empty schedules',()=>{
 for(const change of [f=>f.kraken.vehicles[0].plannedDispatches=null,f=>delete f.kraken.vehicles[0].plannedDispatches,f=>f.kraken.vehicles.push(structuredClone(f.kraken.vehicles[0]))]){
 const f=fixture();change(f);const r=inspectSmartTariff(f);assert.equal(r.payload,null);assert.equal(r.payloadUnavailableReason,'INCOMPLETE_KRAKEN_OBSERVATION');
 assert.equal(r.smartOpportunity.status,'incomplete-evidence');assert.equal(r.freshBaselineEligibility.status,'not-assessable');
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
 assert.equal(r.payload,null);assert.equal(r.importRate,null);assert.equal(r.payloadUnavailableReason,'STALE_KRAKEN_EVIDENCE');
 assert.equal(r.smartOpportunity.status,'incomplete-evidence');assert.equal(r.freshBaselineEligibility.status,'not-assessable');
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
