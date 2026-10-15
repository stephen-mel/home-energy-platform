import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,structuredClone,Error,Intl,require(name){if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));if(name==='node:crypto')return crypto;throw Error(name);}});return exports;}
const api=load('src/lib/tesla-tariff/baseline-assessment.ts');
const key=load('src/lib/tesla-tariff/rollback-evidence.ts').representationKey;
const compare=load('src/lib/tesla-tariff/restoration-review.ts').compareObservedTariffReadBack;
const classify=load('src/lib/tesla-tariff/supervised-experiment.ts').classifyExperimentResult;
const run=load('src/lib/tesla-tariff/supervised-experiment.ts').runSupervisedExperiment;
const linkedRecords=load('src/lib/tesla-tariff/linked-experiment-records.ts');
const prepare=load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareMutationContext;
const hash=load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
const site='1689589307992591',beforeAt='2026-09-25T11:21:35.142Z',afterAt='2026-10-15T10:00:00.000Z';
function side(sell=false){return {code:'FLATPEAK',name:sell?'Premium export':'Next Drive Smart V5.2',utility:'Eon Next',currency:'GBP',version:1,
 seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,toHour:6,fromMinute:0,toMinute:0}]},peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,toHour:0,fromMinute:0,toMinute:0}]}}}},
 energy_charges:{Annual:{rates:sell?{cheap:.17,peak:.17}:{cheap:.02993,peak:.25177}}},demand_charges:{Annual:{rates:{ALL:0}}}};}
function observation(tariff={...side(),sell_tariff:side(true)},at=afterAt){return {source:{kind:'tesla-site-info',energySiteId:site,observedAt:at,timeZone:'Europe/London'},tariff,diagnostics:[],rollbackProven:false};}
function legacy(){const baseline=observation(undefined,beforeAt),temporary=structuredClone(baseline.tariff);temporary.energy_charges.Annual.rates.peak=.0299;
 const review={before:baseline,date:'2026-09-25',proposal:{bound:{energySiteId:site,representation:temporary}}};
 const exception={kind:'supervised-manual-recovery'},intended={...structuredClone(baseline),source:{...baseline.source,kind:'simulation'},tariff:temporary};
 const apiWrite={status:'unknown',httpStatus:200},comparison=compare({intended,readBack:null,after:'2026-09-25T11:22:00.000Z',dates:[review.date]});
 return [{phase:'approval-consumed-before-write',review,exception,preWriteRecheck:{tariffKey:key(baseline.tariff)}},
  {phase:'classified',attemptedAt:'2026-09-25T11:22:00.000Z',completedAt:'2026-09-25T11:23:00.000Z',exception,
   apiWrite,apiTariffReadBack:{observation:null,comparison},classification:classify(apiWrite,intended,null,comparison),
   laterTeslaAppObservation:null,laterPowerwallOpticasterObservation:null,rollbackProven:false,productionWriteReady:false,automaticRestoreAttempted:false}];}
const assess=(current=observation(),journal=legacy(),ownership={status:'missing'},context={})=>api.assessTeslaBaseline({energySiteId:site,timeZone:'Europe/London',assessedAt:afterAt,maxObservationAgeMs:60_000,current,historicalJournal:journal,ownership,...context});
function legacyWithReadback(observedAt){const records=legacy(),initial=records[0],classified=records[1];
 const readBack=observation(structuredClone(initial.review.before.tariff),observedAt);
 const intended={...structuredClone(initial.review.before),source:{...initial.review.before.source,kind:'simulation'},tariff:structuredClone(initial.review.proposal.bound.representation)};
 const comparison=compare({intended,readBack,after:classified.attemptedAt,dates:[initial.review.date]});
 classified.apiTariffReadBack={observation:readBack,comparison};classified.classification=classify(classified.apiWrite,intended,readBack,comparison);return records;}
const without=(value,...fields)=>Object.fromEntries(Object.entries(value).filter(([field])=>!fields.includes(field)));
async function linked(){const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8'));
 const configured=structuredClone(load('src/lib/site/current-site.ts').currentSite);configured.integrations.tesla.energySiteId='12345';
 const selection={energySiteId:'12345',assetId:'q7-fixture',dispatchStart:'2026-09-23T08:00:00+00:00'};
 let clock=Date.parse('2026-09-23T08:12:00Z'),review,initial,classified,context;
 const now=()=>new Date(clock).toISOString(),ports={now,journalRecords:linkedRecords,
  async capture(){const c=structuredClone(fixture);c.before.source.observedAt=now();c.kraken.lastSuccessfulUpdate=now();return c;},
  async prepareContext(capture){context=await prepare({site:configured,selection,capture},{now,readOwnership:async()=>({status:'missing'}),newMutationId:()=> 'baseline-linked'});return context;},
  challenge:value=>hash(value),async confirm(r,challenge){review=r;clock+=1000;return {challenge,automaticRollbackUnproven:true,manualAppRecoveryMayBeRequired:true};},
  async claim(_site,record){initial=record;return {async finish(result){classified=result;}};},
  async write(){clock+=1000;return {status:'accepted',httpStatus:200};},
  async readBack(){clock+=1000;return {...structuredClone(fixture.before),source:{...fixture.before.source,observedAt:now()},tariff:structuredClone(review.proposal.bound.representation)};}};
 await run({site:configured,selection,mode:'execute-supervised',authority:'supervised-experiment'},ports);return [initial,classified];}
const linkedBase=await linked();
function linkedWithReadback(observedAt){const [initial,classified]=structuredClone(linkedBase),readBack=observedAt===null?null:{...structuredClone(classified.apiTariffReadBack.observation),source:{...classified.apiTariffReadBack.observation.source,observedAt}};
 const intended={...structuredClone(initial.review.before),source:{...initial.review.before.source,kind:'simulation'},tariff:structuredClone(initial.review.proposal.bound.representation)};
 const comparison=compare({intended,readBack,after:classified.attemptedAt,dates:[initial.review.date]});
 classified.apiTariffReadBack={observation:readBack,comparison};classified.classification=classify(classified.apiWrite,intended,readBack,comparison);
 classified.classifiedRecordId=hash(without(classified,'classifiedRecordId'));return [initial,classified];}

test('exact current representation is verified against legacy baseline without closing restoration',()=>{
 const r=assess();assert.equal(r.status,'current-exactly-matches-historical-baseline');assert.equal(r.current.status,'verified-current-authenticated-readback');
 assert.equal(r.historical.status,'legacy-unlinked');assert.equal(r.historical.storedClassification,'write-outcome-unknown');
 assert.ok(r.unresolved.includes('SEPTEMBER_WRITE_OUTCOME_UNKNOWN'));assert.ok(r.unresolved.includes('ROLLBACK_UNPROVEN'));
 assert.equal(r.writeReady,false);assert.equal(r.closesHistoricalAttempt,false);assert.equal(r.grantsRepeatAuthority,false);
});

test('different current representation remains explicit and never inferred restored',()=>{
 const changed=observation();changed.tariff.energy_charges.Annual.rates.peak=.3;const r=assess(changed);
 assert.equal(r.status,'current-differs-from-historical-baseline');assert.equal(r.comparisons.baseline.outcome,'different-observed-representation');
 assert.ok(r.comparisons.baseline.differences.length>0);assert.equal(r.closesHistoricalAttempt,false);
});

test('temporary representation is identified without promoting the ambiguous write outcome',()=>{
 const records=legacy(),current=observation(structuredClone(records[0].review.proposal.bound.representation));const r=assess(current,records);
 assert.equal(r.status,'current-exactly-matches-historical-temporary');assert.equal(r.historical.storedClassification,'write-outcome-unknown');
 assert.ok(r.unresolved.includes('RESTORATION_REQUIRED'));
});

test('incomplete and unavailable current captures fail closed with retained historical evidence',()=>{
 const incomplete=observation();incomplete.tariff=null;incomplete.diagnostics=['TARIFF_UNREADABLE'];
 const malformed=observation();delete malformed.tariff.seasons;
 for(const current of [null,incomplete,malformed]){const r=assess(current);assert.equal(r.status,'current-unavailable');assert.equal(r.comparisons.baseline,null);assert.ok(r.unresolved.includes('CURRENT_TESLA_TARIFF_UNAVAILABLE'));}
});

test('invalid or ambiguous historical evidence and ownership remain separate blockers',()=>{
 const broken=legacy();broken[1].classification='submitted-representation-preserved';
 const invalid=assess(observation(),broken,{status:'invalid',code:'OWNERSHIP_STORE_INVALID'});
 assert.equal(invalid.status,'historical-evidence-invalid');assert.equal(invalid.historical,null);assert.ok(invalid.unresolved.includes('HISTORICAL_JOURNAL_INVALID'));assert.ok(invalid.unresolved.includes('OWNERSHIP_UNRESOLVED'));
 const unavailable=assess(observation(),legacy(),{status:'unavailable',code:'OWNERSHIP_STORE_UNAVAILABLE'});assert.ok(unavailable.unresolved.includes('OWNERSHIP_UNRESOLVED'));
});

test('freshness is explicit: boundary age passes while stale, future and malformed assessment times fail closed',()=>{
 const boundary=observation(undefined,'2026-10-15T09:59:00.000Z');
 assert.equal(assess(boundary).status,'current-exactly-matches-historical-baseline');
 const stale=observation(undefined,'2026-10-15T09:58:59.999Z'),future=observation(undefined,'2026-10-15T10:00:00.001Z');
 const a=assess(stale),b=assess(future),c=assess(observation(),legacy(),{status:'missing'},{assessedAt:'2026-02-30T00:00:00Z'});
 assert.equal(a.current.status,'authenticated-observation-not-current');assert.ok(a.unresolved.includes('OBSERVATION_STALE'));
 assert.equal(b.current.status,'authenticated-observation-not-current');assert.ok(b.unresolved.includes('OBSERVATION_FUTURE'));
 assert.equal(c.status,'current-unavailable');assert.ok(c.unresolved.includes('ASSESSMENT_TIME_INVALID'));
 for(const maxObservationAgeMs of [-1,Number.NaN])assert.ok(assess(observation(),legacy(),{status:'missing'},{maxObservationAgeMs}).unresolved.includes('OBSERVATION_MAX_AGE_INVALID'));
});

test('timezone mismatch cannot be labelled current or compared',()=>{
 const current=observation();current.source.timeZone='UTC';const r=assess(current);
 assert.equal(r.current.status,'authenticated-observation-not-current');assert.equal(r.comparisons.baseline,null);assert.ok(r.unresolved.includes('OBSERVATION_TIMEZONE_MISMATCH'));
});

test('contradictory legacy classification or readback fails closed without changing restoration obligations',()=>{
 const classification=legacy();classification[1].classification='submitted-representation-preserved';
 const a=assess(observation(),classification);assert.equal(a.historical,null);assert.ok(a.unresolved.includes('HISTORICAL_JOURNAL_INVALID'));
 const readback=legacy();readback[1].apiTariffReadBack.observation=observation();
 const b=assess(observation(),readback);assert.equal(b.historical,null);assert.ok(b.unresolved.includes('RESTORATION_REQUIRED'));assert.equal(b.grantsRepeatAuthority,false);
});

test('every retained post-write readback must be strictly after attempt and no later than completion',()=>{
 for(const observedAt of ['2026-09-25T11:21:59.000Z','2026-09-25T11:22:00.000Z']){
  const r=assess(observation(),legacyWithReadback(observedAt));assert.equal(r.historical,null);assert.ok(r.unresolved.includes('HISTORICAL_JOURNAL_INVALID'));
 }
 for(const observedAt of ['2026-09-25T11:22:00.001Z','2026-09-25T11:23:00.000Z']){
  const r=assess(observation(),legacyWithReadback(observedAt));assert.equal(r.historical.status,'legacy-unlinked');assert.equal(r.historical.storedClassification,'write-outcome-unknown');
 }
});

test('linked records cannot bypass assessment-level post-write readback chronology',()=>{
 const attempted=Date.parse(linkedBase[1].attemptedAt),completed=Date.parse(linkedBase[1].completedAt);
 for(const [index,observedAt] of [new Date(attempted-1000).toISOString(),new Date(attempted).toISOString(),new Date(completed+1).toISOString()].entries()){
  const journal=linkedWithReadback(observedAt),r=assess(observation(),journal,{status:'missing'},{energySiteId:'12345'});
  if(index===0){assert.equal(journal[1].apiTariffReadBack.comparison.outcome,'insufficient-evidence');assert.equal(linkedRecords.validLinkedClassifiedRecord(journal[1],journal[0]),true);}
  assert.equal(r.historical,null);assert.ok(r.unresolved.includes('HISTORICAL_JOURNAL_INVALID'));
 }
 for(const observedAt of [new Date(attempted+1).toISOString(),new Date(completed).toISOString()]){
  const r=assess(observation(),linkedWithReadback(observedAt),{status:'missing'},{energySiteId:'12345'});
  assert.equal(r.historical.status,'linked-validated');
 }
 const missing=assess(observation(),linkedWithReadback(null),{status:'missing'},{energySiteId:'12345'});
 assert.equal(missing.historical.status,'linked-validated');assert.equal(missing.historical.storedClassification,'read-back-unavailable-or-insufficient');
});

test('wrong-site capture cannot be verified and outputs are detached and immutable',()=>{
 const current=observation();current.source.energySiteId='999';const r=assess(current);assert.equal(r.status,'current-unavailable');
 const good=observation(),result=assess(good);good.tariff.name='mutated';assert.equal(result.current.representation.name,'Next Drive Smart V5.2');
 assert.throws(()=>{result.current.representation.energy_charges.Annual.rates.peak=.9;},TypeError);assert.equal(result.current.representation.energy_charges.Annual.rates.peak,.25177);
});
