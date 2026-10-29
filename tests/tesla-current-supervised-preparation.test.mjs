import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
 {exports,structuredClone,Date,Intl,Error,require(n){if(n.startsWith('.'))return load(path.resolve(path.dirname(file),n+'.ts'));if(n==='node:crypto')return crypto;throw Error('OFFLINE_ONLY');}});return exports;}
const api=load('src/lib/tesla-tariff/supervised-experiment.ts');
const {captureObservedTariff}=load('src/lib/tesla-tariff/observed-tariff.ts');
const {representationKey:key}=load('src/lib/tesla-tariff/rollback-evidence.ts');
const now='2026-10-27T12:00:00Z';
function legacy(v){const o=structuredClone(v);delete o.version;
 for(const f of ['energy_charges','demand_charges'])o[f]=Object.fromEntries(Object.entries(v[f]).map(([k,c])=>[k,c.rates??{}]));
 for(const s of Object.values(o.seasons))for(const [k,t]of Object.entries(s.tou_periods))s.tou_periods[k]=t.periods;
 if(v.sell_tariff)o.sell_tariff=legacy(v.sell_tariff);return structuredClone(o);}
function fixture(){
 const site=structuredClone(load('src/lib/site/current-site.ts').currentSite);
 site.integrations.tesla.energySiteId='12345';
 site.integrations.kraken.importTariffIdentity={accountRef:'fixture-account',tariffCode:'fixture-tariff',meterPointRef:'fixture-meter'};
 delete site.integrations.kraken.exportTariffIdentity;
 const ranges={Yesterday:[26,26],Today:[27,27],Tomorrow:[28,28],TwoDays:[29,29],ThreeDays:[30,25]};
 const side=sell=>({code:'SYNTHETIC',name:sell?'Export':'Import',utility:'Fixture',currency:'GBP',
  seasons:Object.fromEntries(Object.entries(ranges).map(([k,[fromDay,toDay]])=>[k,{fromMonth:10,fromDay,toMonth:10,toDay,tou_periods:sell?{all:{periods:[{toDayOfWeek:6}]}}:{cheap:{periods:[{toDayOfWeek:6,toHour:6}]},peak:{periods:[{toDayOfWeek:6,fromHour:6}]}}}])),
  energy_charges:Object.fromEntries(Object.keys(ranges).map(k=>[k,{rates:sell?{all:.175}:{cheap:.0285,peak:.23978}}])),
  demand_charges:{ALL:{rates:{ALL:0}},...Object.fromEntries(Object.keys(ranges).map(k=>[k,{}]))}});
 const v={...side(false),version:1,sell_tariff:side(true)};
 const before=captureObservedTariff({installation_time_zone:'Europe/London',tariff_content_v2:v,tariff_content:legacy(v)},'12345',now);
 const kraken={stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'fixture-ev',name:'Fixture EV',plannedDispatches:[
  {type:'SMART',start:'2026-10-27T13:00:00Z',end:'2026-10-27T13:30:00Z',energyAddedKwh:'2.0'},
  {type:'SMART',start:'2026-10-27T15:00:00Z',end:'2026-10-27T15:30:00Z',energyAddedKwh:'2.0'}]}],
 importTariff:{status:'available',accountRef:'fixture-account',observedAt:now,exportStatus:'unknown',
  agreement:{validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',productCode:'fixture-product',tariffCode:'fixture-tariff',meterPointRef:'fixture-meter'},
  version:{id:'fixture-tariff',name:'Fixture rates',provider:'eon-next-kraken',effectiveFrom:'2026-10-27T00:00:00Z',effectiveTo:'2026-10-28T00:00:00Z',pricesIncludeVat:true,
   normalImport:{amount:.23978,currency:'GBP',unit:'kWh'},scheduledChargingImport:{amount:.0285,currency:'GBP',unit:'kWh'},export:null,standingCharge:null,
   dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:{amount:.0285,currency:'GBP',unit:'kWh'}}]}}};
 return {site,capture:{before,kraken},selection:{energySiteId:'12345',assetId:'fixture-ev',dispatchStart:kraken.vehicles[0].plannedDispatches[0].start}};
}
function prepare(f,at=now){const capture=api.validateCurrentSupervisedCapture(f.site,f.capture,at);return api.prepareSupervisedExperiment(f.site,f.selection,capture,at);}
test('current validated pricing prepares despite expired September config, retaining exact restoration and export',()=>{
 const f=fixture(),original=key(f.capture.before);assert.ok(Date.parse(f.site.tariff.versions[0].effectiveTo)<Date.parse(now));
 const r=prepare(f);
 assert.equal(r.proposal.structurallyValid,true);
 assert.equal(key(r.before),original);
 assert.equal(key(r.restoration.documentedEnvelopeCandidate.tou_settings.tariff_content_v2),key(f.capture.before.tariff));
 assert.equal(key(r.proposal.bound.representation.sell_tariff),key(f.capture.before.tariff.sell_tariff));
 assert.equal(r.before.representations.relationship,'consistent');
 assert.ok(r.hardBlockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));
 assert.ok(r.restoration.blockers.includes('BUY_BELOW_SELL'));assert.equal(r.productionWriteReady,false);
 const analysis=load('src/lib/tesla-tariff/observed-tariff.ts').analyseObservedDates({...r.before,tariff:r.proposal.bound.representation},['2026-10-27']);
 const atHour=h=>analysis.days[0].periods.find(p=>p.fromMinute<=h*60&&p.toMinute>h*60).buy;
 assert.equal(atHour(13),.0285);assert.equal(atHour(14),.23978);assert.equal(atHour(15),.23978); // The existing one-dispatch experiment does not merge separate windows.
 assert.equal(r.before.representations.legacy.sell_tariff.name,f.capture.before.representations.legacy.sell_tariff.name);
});
test('missing, incomplete, stale or wrong-identity pricing fails closed',()=>{
 for(const edit of [f=>{delete f.capture.kraken.importTariff;},f=>{f.capture.kraken.importTariffDiagnostic={status:'unavailable',code:'INCOMPLETE'};},
 f=>{f.capture.kraken.importTariff.version.effectiveTo='2026-10-27T14:00:00Z';},f=>{f.capture.kraken.importTariff.observedAt='2026-10-27T11:58:00Z';},
 f=>{f.capture.kraken.importTariff.accountRef='other';},f=>{f.capture.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh='not-a-number';}]){
  const f=fixture();edit(f);assert.throws(()=>prepare(f),/CURRENT_/);
 }
});
test('missing timezone, target substitution and contradictory dual evidence fail closed',()=>{
 for(const edit of [f=>{f.capture.before.source.timeZone=null;},f=>{f.capture.before.source.energySiteId='999';},
 f=>{f.capture.before.representations.v2.sell_tariff.name+=' changed';},f=>{f.capture.before.representations.legacy.sell_tariff.name+=' changed';}]){
  const f=fixture();edit(f);assert.throws(()=>prepare(f),/CURRENT_TESLA_/);
 }
});
test('freshness and approval deadlines remain unchanged; output cannot reach execution',async()=>{
 assert.equal(api.CAPTURE_TTL_MS,120000);assert.equal(api.EVIDENCE_TTL_MS,60000);assert.equal(api.APPROVAL_TTL_MS,60000);assert.equal(api.MIN_WRITE_REMAINING_MS,30000);
 const f=fixture();f.capture.kraken.lastSuccessfulUpdate='2026-10-27T11:58:59Z';assert.throws(()=>prepare(f),/CURRENT_KRAKEN/);
 const good=fixture(),ports={now:()=>now,readOwnership:async()=>({status:'missing'}),newMutationId:()=> 'current-fixture'};
 const context=await load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareMutationContext(good,ports);
 let io=0;
 await assert.rejects(api.runSupervisedExperiment({site:good.site,selection:good.selection,mode:'execute-supervised',authority:'supervised-experiment'},
 {now:()=>now,capture:async()=>good.capture,prepareContext:async()=>context,journalRecords:load('src/lib/tesla-tariff/linked-experiment-records.ts'),confirm:async()=>{io++;},write:async()=>{io++;},claim:async()=>{io++;}}),/GATE_BLOCKED/);
 assert.equal(io,0);
});

test('interactive dry-run uses validated acquisition and never invokes a write transport',async()=>{
 for(const fresh of [true,false]){
  const f=fixture(),exports={},calls={get:0,acquisition:0,output:[]};
  const blocked=()=>{throw Error('SIDE_EFFECT_FORBIDDEN');};
  const dependencies={
   'node:fs/promises':{readFile:async()=>JSON.stringify({access_token:'offline-fixture'}),mkdir:blocked,writeFile:blocked},
   'node:path':path,'node:crypto':{...crypto,randomUUID:()=> 'fixture-mutation'},'node:readline/promises':{createInterface:blocked},
   '@next/env':{loadEnvConfig(){}},'../site/current-site':{currentSite:f.site},
   '../site/kraken-refresh':{async getRecordedKrakenStateForInspection(id,identity){calls.acquisition++;assert.equal(id,f.site.id);assert.equal(identity,f.site.integrations.kraken.importTariffIdentity);return {state:f.capture.kraken,acquisition:{freshEvidenceObtained:fresh,staleFallbackUsed:!fresh}};}},
   './observed-tariff':load('src/lib/tesla-tariff/observed-tariff.ts'),
   './linked-experiment-records':load('src/lib/tesla-tariff/linked-experiment-records.ts'),
   './prepared-mutation-context':load('src/lib/tesla-tariff/prepared-mutation-context.ts'),
   './ownership-store':{ownershipStore:()=>({read:async()=>({status:'missing'})})},
   './ownership-sqlite':{persistConfirmedSmart:blocked},'./supervised-journal':{claimExperimentJournal:blocked},'./supervised-experiment':api,
  };
  class FixedDate extends Date{constructor(...a){super(...(a.length?a:[now]));}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
   {exports,Date:FixedDate,AbortSignal,process:{cwd:()=>'/offline',env:{},stdin:{isTTY:false},stdout:{isTTY:false},stderr:{isTTY:false}},console:{log:v=>calls.output.push(v)},
    fetch:async(_url,options)=>{assert.equal(options.method,'GET');calls.get++;return {ok:true,json:async()=>({response:{energy_site_id:'12345',installation_time_zone:'Europe/London',tariff_content_v2:f.capture.before.representations.v2,tariff_content:f.capture.before.representations.legacy}})};},
    require:n=>{assert.ok(n in dependencies,n);return dependencies[n];}});
  const run=()=>exports.runLocalExperiment(['--site','12345','--vehicle','fixture-ev','--dispatch-start',f.selection.dispatchStart]);
  if(fresh){await run();const result=JSON.parse(calls.output[0]);assert.equal(result.status,'dry-run');assert.ok(result.experimentalBlockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));assert.equal(calls.get,1);}
  else{await assert.rejects(run(),/CURRENT_KRAKEN_ACQUISITION_FAILED/);assert.equal(calls.get,0);}
  assert.equal(calls.acquisition,1);
 }
});
