import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';

class InputDate extends Date { constructor(...args){assert.ok(args.length);super(...args);} static now(){throw Error('No wall clock');} }
const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,structuredClone,Date:InputDate,Intl,Error,require(name){if(name==='node:crypto')return {createHash};assert.ok(name.startsWith('.'));return load(path.resolve(path.dirname(file),name+'.ts'));}});return exports;}
const {deriveSmartTariffDesiredState}=load('src/lib/tesla-tariff/smart-desired-state.ts');
const {ownershipFingerprint}=load('src/lib/tesla-tariff/ownership-transition.ts');
const {analyseObservedDates}=load('src/lib/tesla-tariff/observed-tariff.ts');
const siteTemplate=load('src/lib/site/current-site.ts').currentSite;
const price=amount=>({amount,currency:'GBP',unit:'kWh'});
const now='2026-10-21T19:54:12.000Z';
const normal=0.23978,cheap=0.0285;

function side(sell=false){return {version:1,name:sell?'Observed export':'Observed import',utility:'E.ON',currency:'GBP',code:sell?'EXPORT':'IMPORT',
 demand_charges:{ALL:{rates:{ALL:0}}},seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{
  cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,fromMinute:0,toHour:6,toMinute:0}]},
  peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,fromMinute:0,toHour:0,toMinute:0}]}}}},
 energy_charges:{Annual:{rates:{cheap:sell?0.175:cheap,peak:sell?0.175:normal}}}};}
function observation(tariff={...side(),sell_tariff:side(true)}){return {source:{kind:'tesla-site-info',energySiteId:'123',observedAt:now,timeZone:'Europe/London'},tariff,diagnostics:[],rollbackProven:false};}
function dispatch(id,start,end){return {id,name:id,plannedDispatches:[{start,end,type:'SMART',energyAddedKwh:'1'}]};}
function fixture(vehicles,options={}){
 const site=structuredClone(siteTemplate);site.integrations.tesla.energySiteId='123';
 site.integrations.kraken.importTariffIdentity={tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'import-meter'};
 delete site.integrations.kraken.exportTariffIdentity;
 const kraken={stale:false,lastSuccessfulUpdate:now,vehicles,
  importTariff:{status:'available',accountRef:'household',observedAt:now,exportStatus:'unknown',agreement:{validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'import-meter'},
   version:{id:'v5.2',name:'Drive Smart',provider:'eon-next-kraken',effectiveFrom:'2026-10-20T23:00:00Z',effectiveTo:'2026-10-22T23:00:00Z',pricesIncludeVat:true,normalImport:price(normal),export:null,scheduledChargingImport:price(cheap),standingCharge:null,dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(cheap)}]}}};
 const baseline=observation(),current=options.current??baseline;
 const input={site,energySiteId:'123',kraken,observation:current,now,comparisonDomain:{start:'2026-10-21T19:55:00.000Z',end:'2026-10-22T23:00:00.000Z'}};
 if(options.ownership)input.managedImport=options.ownership;
 return {current:input,restorationBaseline:baseline};
}
const minuteRate=(tariff,date,minute)=>{const a=analyseObservedDates(observation(tariff),[date]);const p=a.days[0].periods.find(x=>x.fromMinute<=minute&&x.toMinute>minute);return p?.buy;};
const noAuthority=r=>assert.equal(r.executionReady,false);
const localBoundary=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));

test('Q7 and A3 union yields the complete 21 October household tariff without losing 22:00-midnight',()=>{
 const f=fixture([
  dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z'),
  dispatch('a3','2026-10-20T23:30:00Z','2026-10-21T02:00:00Z')]);
 const r=deriveSmartTariffDesiredState(f);assert.equal(r.status,'desired-state-ready');assert.equal(r.action,'apply');noAuthority(r);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',0),cheap);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',359),cheap);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',360),normal);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',1289),normal);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',1290),cheap);
 assert.equal(minuteRate(r.desiredTariff,'2026-10-21',1439),cheap);
 assert.deepEqual(structuredClone(r.desiredTariff.sell_tariff),structuredClone(f.restorationBaseline.tariff.sell_tariff));
 assert.equal(r.dispatchEvidence.length,2);assert.equal(new Set(r.dispatchEvidence.map(x=>x.assetId)).size,2);
 assert.equal(r.recurringSemantics,'month-day-and-weekday-rules-repeat-until-replaced');
});

test('overlapping vehicle intervals form one economic union while provenance retains both vehicles',()=>{
 const r=deriveSmartTariffDesiredState(fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-21T21:30:00Z'),dispatch('a3','2026-10-21T21:00:00Z','2026-10-21T22:00:00Z')]));
 assert.equal(r.action,'apply');const owned=r.managedIntervals.filter(x=>x.basis==='current-smart');
 assert.equal(owned[0].start,'2026-10-21T20:30:00.000Z');assert.equal(owned.at(-1).end,'2026-10-21T22:00:00.000Z');
 assert.deepEqual(new Set(r.dispatchEvidence.map(x=>x.assetId)),new Set(['q7','a3']));noAuthority(r);
});

test('empty schedule restores the exact immutable baseline and changed schedule classifies update',()=>{
 const initial=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z')]);
 const applied=deriveSmartTariffDesiredState(initial);assert.equal(applied.action,'apply');
 const fingerprint=ownershipFingerprint(initial.restorationBaseline.tariff);
 const ownership={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-22T23:00:00.000Z',basis:'confirmed-write-readback',baselineFingerprint:fingerprint,readbackFingerprint:ownershipFingerprint(applied.desiredTariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-10-21T20:30:00.000Z',end:'2026-10-21T23:00:00.000Z',restoreBaselineFingerprint:fingerprint,applied:price(cheap),restore:price(normal)}]};
 // Re-optimised Q7: 23:00-05:30 local. The obsolete 21:30-23:00 local
 // prefix is restored while the remaining 23:00-midnight exception stays cheap.
 const revisedStart='2026-10-21T22:00:00Z',revisedEnd='2026-10-22T04:30:00Z';
 assert.equal(localBoundary(revisedStart),'21/10/2026, 23:00');assert.equal(localBoundary(revisedEnd),'22/10/2026, 05:30');
 const changed=fixture([dispatch('q7',revisedStart,revisedEnd)],{current:observation(applied.desiredTariff),ownership});
 const updated=deriveSmartTariffDesiredState(changed);assert.equal(updated.action,'update');
 assert.equal(minuteRate(updated.desiredTariff,'2026-10-21',1290),normal);
 assert.equal(minuteRate(updated.desiredTariff,'2026-10-21',1379),normal);
 assert.equal(minuteRate(updated.desiredTariff,'2026-10-21',1380),cheap);
 assert.equal(minuteRate(updated.desiredTariff,'2026-10-21',1439),cheap);
 const restored=deriveSmartTariffDesiredState(fixture([],{current:observation(applied.desiredTariff),ownership}));
 assert.equal(restored.action,'restore');assert.equal(ownershipFingerprint(restored.desiredTariff),fingerprint);
 assert.equal(ownershipFingerprint(restored.restorationCandidate),fingerprint);noAuthority(restored);
});

test('elapsed SMART exception restores the recurring representation despite future economic agreement',()=>{
 const initial=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z')]);
 const applied=deriveSmartTariffDesiredState(initial);assert.equal(applied.action,'apply');
 const baselineFingerprint=ownershipFingerprint(initial.restorationBaseline.tariff);
 const ownership={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-22T23:00:00.000Z',basis:'confirmed-write-readback',baselineFingerprint,readbackFingerprint:ownershipFingerprint(applied.desiredTariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-10-21T20:30:00.000Z',end:'2026-10-21T23:00:00.000Z',restoreBaselineFingerprint:baselineFingerprint,applied:price(cheap),restore:price(normal)}]};
 const expired=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z')],{current:observation(applied.desiredTariff),ownership});
 expired.current.now='2026-10-22T06:00:00.000Z';expired.current.comparisonDomain={start:'2026-10-22T06:00:00.000Z',end:'2026-10-22T23:00:00.000Z'};
 expired.current.observation.source.observedAt=expired.current.now;expired.current.kraken.lastSuccessfulUpdate=expired.current.now;expired.current.kraken.importTariff.observedAt=expired.current.now;
 const restored=deriveSmartTariffDesiredState(expired);assert.equal(restored.status,'desired-state-ready');assert.equal(restored.action,'restore');
 assert.equal(ownershipFingerprint(restored.desiredTariff),baselineFingerprint);assert.deepEqual(structuredClone(restored.desiredTariff),structuredClone(initial.restorationBaseline.tariff));noAuthority(restored);
});

test('restoration requires coverage of every active or upcoming economic exception',()=>{
 const original=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z')]),applied=deriveSmartTariffDesiredState(original);
 const baselineFingerprint=ownershipFingerprint(original.restorationBaseline.tariff),ownership={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-22T23:00:00.000Z',basis:'confirmed-write-readback',baselineFingerprint,readbackFingerprint:ownershipFingerprint(applied.desiredTariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-10-21T20:30:00.000Z',end:'2026-10-21T23:00:00.000Z',restoreBaselineFingerprint:baselineFingerprint,applied:price(cheap),restore:price(normal)}]};
 const result=(vehicles,start,end,at=now)=>{const f=fixture(vehicles,{current:observation(applied.desiredTariff),ownership});f.current.now=at;f.current.observation.source.observedAt=at;f.current.kraken.lastSuccessfulUpdate=at;f.current.kraken.importTariff.observedAt=at;f.current.comparisonDomain={start,end};return deriveSmartTariffDesiredState(f)};
 for(const r of [
  result([dispatch('q7','2026-10-21T20:30:00Z','2026-10-22T03:00:00Z')],'2026-10-22T06:00:00Z','2026-10-22T23:00:00Z'),
  result([dispatch('q7','2026-10-21T19:30:00Z','2026-10-21T21:00:00Z')],'2026-10-21T20:00:00Z','2026-10-22T23:00:00Z'),
  result([dispatch('q7','2026-10-21T20:30:00Z','2026-10-21T22:00:00Z')],'2026-10-21T19:55:00Z','2026-10-21T21:30:00Z'),
  result([dispatch('a3','2026-10-21T20:30:00Z','2026-10-21T22:00:00Z')],'2026-10-22T06:00:00Z','2026-10-22T23:00:00Z'),
 ]){assert.equal(r.status,'blocked');assert.equal(r.diagnostic,'RESTORATION_SCHEDULE_COVERAGE_INCOMPLETE');assert.equal(r.action,null);noAuthority(r)}
 const overnight=result([dispatch('a3','2026-10-21T23:30:00Z','2026-10-22T02:00:00Z')],'2026-10-21T19:55:00Z','2026-10-22T23:00:00Z');
 assert.equal(overnight.action,'restore');noAuthority(overnight);
});

test('restoration refuses to overwrite external export, import or metadata changes',()=>{
 const initial=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-21T22:00:00Z')]);
 const applied=deriveSmartTariffDesiredState(initial),baselineFingerprint=ownershipFingerprint(initial.restorationBaseline.tariff);
 const ownership={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-22T23:00:00.000Z',basis:'confirmed-write-readback',baselineFingerprint,readbackFingerprint:ownershipFingerprint(applied.desiredTariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-10-21T20:30:00.000Z',end:'2026-10-21T22:00:00.000Z',restoreBaselineFingerprint:baselineFingerprint,applied:price(cheap),restore:price(normal)}]};
 const changes=[
  tariff=>{for(const charge of Object.values(tariff.sell_tariff.energy_charges))for(const key of Object.keys(charge.rates))charge.rates[key]=0.20;},
  tariff=>{for(const charge of Object.values(tariff.energy_charges))for(const key of Object.keys(charge.rates))if(charge.rates[key]===normal)charge.rates[key]=0.41;},
  tariff=>{tariff.name='Externally changed tariff';},
 ];
 for(const change of changes){const current=structuredClone(applied.desiredTariff);change(current);const r=deriveSmartTariffDesiredState(fixture([],{current:observation(current),ownership}));assert.equal(r.status,'blocked');assert.equal(r.diagnostic,'CURRENT_TARIFF_OWNERSHIP_CONFLICT');assert.equal(r.action,null);assert.equal(r.desiredTariff,null);assert.equal(r.restorationCandidate,null);noAuthority(r);}
});

test('missing and cyclic current tariff evidence fails closed before ownership fingerprinting',()=>{
 const initial=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-21T22:00:00Z')]),applied=deriveSmartTariffDesiredState(initial);
 const baselineFingerprint=ownershipFingerprint(initial.restorationBaseline.tariff),ownership={version:1,energySiteId:'123',timeZone:'Europe/London',createdAt:now,updatedAt:now,validUntil:'2026-10-22T23:00:00.000Z',basis:'confirmed-write-readback',baselineFingerprint,readbackFingerprint:ownershipFingerprint(applied.desiredTariff),proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:[{start:'2026-10-21T20:30:00.000Z',end:'2026-10-21T22:00:00.000Z',restoreBaselineFingerprint:baselineFingerprint,applied:price(cheap),restore:price(normal)}]};
 const missing=fixture([],{current:observation(),ownership});missing.current.observation.tariff=null;
 const cyclicTariff=structuredClone(applied.desiredTariff);cyclicTariff.extra=cyclicTariff;
 const cyclic=fixture([],{current:observation(cyclicTariff),ownership});
 for(const f of [missing,cyclic]){const r=deriveSmartTariffDesiredState(f);assert.equal(r.status,'indeterminate');assert.equal(r.diagnostic,'CURRENT_TARIFF_INVALID');assert.equal(r.action,null);assert.equal(r.desiredTariff,null);assert.equal(r.restorationCandidate,null);noAuthority(r);}
});

test('invalid, incomplete, stale, unsupported and ownership-mismatched evidence fails closed',()=>{
 const mutations=[
  f=>{f.current.kraken.importTariff.version.scheduledChargingImport.amount=-1;},
  f=>{f.current.kraken.importTariff.version.effectiveTo='2026-10-21T21:00:00Z';},
  f=>{f.current.kraken.stale=true;},
  f=>{f.restorationBaseline.tariff.extra='unsupported';},
  f=>{f.current.managedImport={baselineFingerprint:'f'.repeat(64)};},
 ];
 for(const mutate of mutations){const f=fixture([dispatch('q7','2026-10-21T20:30:00Z','2026-10-21T22:00:00Z')]);mutate(f);const r=deriveSmartTariffDesiredState(f);assert.ok(['blocked','indeterminate'].includes(r.status));assert.equal(r.desiredTariff,null);noAuthority(r);}
});

test('midnight and London DST transitions have exact local/UTC coverage and ambiguous evidence fails closed',()=>{
 const midnight=deriveSmartTariffDesiredState(fixture([dispatch('q7','2026-10-21T22:30:00Z','2026-10-22T00:30:00Z')]));
 assert.equal(midnight.status,'desired-state-ready');assert.equal(minuteRate(midnight.desiredTariff,'2026-10-21',1439),cheap);assert.equal(minuteRate(midnight.desiredTariff,'2026-10-22',0),cheap);
 const spring=fixture([dispatch('q7','2026-03-29T00:30:00Z','2026-03-29T02:30:00Z')]);spring.current.now='2026-03-28T23:54:12.000Z';spring.current.kraken.lastSuccessfulUpdate=spring.current.now;spring.current.kraken.importTariff.observedAt=spring.current.now;spring.current.observation.source.observedAt=spring.current.now;spring.restorationBaseline.source.observedAt=spring.current.now;spring.current.comparisonDomain={start:'2026-03-28T23:55:00.000Z',end:'2026-03-29T23:00:00.000Z'};spring.current.kraken.importTariff.version.effectiveFrom='2026-03-28T00:00:00Z';spring.current.kraken.importTariff.version.effectiveTo='2026-03-29T23:00:00Z';
 const springResult=deriveSmartTariffDesiredState(spring);assert.equal(springResult.status,'in-sync');noAuthority(springResult);
 const springDay=analyseObservedDates(observation(springResult.desiredTariff),['2026-03-29']).days[0];
 assert.equal(springDay.elapsedMinutes,1380);assert.equal(springDay.periods[0].start,'2026-03-29T00:00:00.000Z');assert.equal(springDay.periods.at(-1).end,'2026-03-29T23:00:00.000Z');
 assert.equal(springDay.periods.reduce((n,p)=>n+(Date.parse(p.end)-Date.parse(p.start))/60000,0),1380);
 assert.ok(springDay.periods.every((p,i)=>i===0||springDay.periods[i-1].end===p.start));

 const autumn=fixture([dispatch('q7','2026-10-25T00:30:00Z','2026-10-25T02:30:00Z')]);autumn.current.now='2026-10-24T22:54:12.000Z';autumn.current.kraken.lastSuccessfulUpdate=autumn.current.now;autumn.current.kraken.importTariff.observedAt=autumn.current.now;autumn.current.observation.source.observedAt=autumn.current.now;autumn.restorationBaseline.source.observedAt=autumn.current.now;autumn.current.comparisonDomain={start:'2026-10-24T22:55:00.000Z',end:'2026-10-26T00:00:00.000Z'};autumn.current.kraken.importTariff.version.effectiveFrom='2026-10-24T00:00:00Z';autumn.current.kraken.importTariff.version.effectiveTo='2026-10-26T00:00:00Z';
 const autumnResult=deriveSmartTariffDesiredState(autumn);assert.equal(autumnResult.status,'in-sync');noAuthority(autumnResult);
 const autumnDay=analyseObservedDates(observation(autumnResult.desiredTariff),['2026-10-25']).days[0];
 assert.equal(autumnDay.elapsedMinutes,1500);assert.equal(autumnDay.periods[0].start,'2026-10-24T23:00:00.000Z');assert.equal(autumnDay.periods.at(-1).end,'2026-10-26T00:00:00.000Z');
 assert.equal(autumnDay.periods.reduce((n,p)=>n+(Date.parse(p.end)-Date.parse(p.start))/60000,0),1500);
 assert.ok(autumnDay.periods.every((p,i)=>i===0||autumnDay.periods[i-1].end===p.start));
 const repeated=autumnDay.periods.filter(p=>p.fromMinute<=60&&p.toMinute>60);
 assert.deepEqual(new Set(repeated.map(p=>p.offsetMinutes)),new Set([60,0]));assert.ok(repeated.every(p=>p.buy===cheap));

 const ambiguous=fixture([]),overlap=ambiguous.restorationBaseline.tariff.seasons.Annual.tou_periods;
 overlap.ambiguous={periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:1,fromMinute:0,toHour:2,toMinute:0}]};
 ambiguous.restorationBaseline.tariff.energy_charges.Annual.rates.ambiguous=normal;
 const rejected=deriveSmartTariffDesiredState(ambiguous);assert.equal(rejected.status,'indeterminate');assert.equal(rejected.diagnostic,'RESTORATION_BASELINE_INVALID');assert.equal(rejected.desiredTariff,null);noAuthority(rejected);
});
