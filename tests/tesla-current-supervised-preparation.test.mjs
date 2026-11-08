import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,structuredClone,Date,Intl,Error,require(n){if(n.startsWith('.'))return load(path.resolve(path.dirname(file),n+'.ts'));if(n==='node:crypto')return crypto;if(n==='node:fs/promises')return io;if(n==='node:path')return path;throw Error('OFFLINE_ONLY');}});return exports;}
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
   './rollback-evidence':load('src/lib/tesla-tariff/rollback-evidence.ts'),
   './restoration-review':load('src/lib/tesla-tariff/restoration-review.ts'),
   './smart-inspection':load('src/lib/tesla-tariff/smart-inspection.ts'),
   './proposal-approval':load('src/lib/tesla-tariff/proposal-approval.ts'),
   './ownership-transition':load('src/lib/tesla-tariff/ownership-transition.ts'),
   './repeat-attempt-journal':{admitOfflineReconciledExperiment:blocked},
   './linked-experiment-records':load('src/lib/tesla-tariff/linked-experiment-records.ts'),
   './prepared-mutation-context':load('src/lib/tesla-tariff/prepared-mutation-context.ts'),
   './ownership-store':{ownershipStore:()=>({read:async()=>({status:'missing'})})},
   './ownership-sqlite':{persistConfirmedSmart:blocked},'./supervised-journal':{claimExperimentJournal:blocked},'./supervised-experiment':api,
  };
  class FixedDate extends Date{constructor(...a){super(...(a.length?a:[now]));}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
   {exports,structuredClone,Date:FixedDate,AbortSignal,process:{cwd:()=>'/offline',env:{},stdin:{isTTY:false},stdout:{isTTY:false},stderr:{isTTY:false}},console:{log:v=>calls.output.push(v)},
    fetch:async(_url,options)=>{assert.equal(options.method,'GET');calls.get++;return {ok:true,json:async()=>({response:{energy_site_id:'12345',installation_time_zone:'Europe/London',tariff_content_v2:f.capture.before.representations.v2,tariff_content:f.capture.before.representations.legacy}})};},
    require:n=>{assert.ok(n in dependencies,n);return dependencies[n];}});
  const run=()=>exports.runLocalExperiment(['--site','12345','--vehicle','fixture-ev','--dispatch-start',f.selection.dispatchStart]);
  if(fresh){await run();const result=JSON.parse(calls.output[0]);assert.equal(result.status,'dry-run');assert.ok(result.experimentalBlockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));assert.equal(calls.get,1);}
  else{await assert.rejects(run(),/CURRENT_KRAKEN_ACQUISITION_FAILED/);assert.equal(calls.get,0);}
  assert.equal(calls.acquisition,1);
 }
});

const journals=load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
const linked=load('src/lib/tesla-tariff/linked-experiment-records.ts');
const {ownershipFingerprint:hash}=load('src/lib/tesla-tariff/ownership-transition.ts');
async function admissionFixture(t){
 const directory=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'hep-reconciled-')));
 t.after(()=>io.rm(directory,{recursive:true,force:true}));
 const f=fixture();
 const context=await load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareMutationContext(f,
  {now:()=>now,readOwnership:async()=>({status:'missing'}),newMutationId:()=> 'independent-new-mutation'});
 const review=context.original,approval=load('src/lib/tesla-tariff/proposal-approval.ts').approveTariffProposal(review.proposal,{fingerprint:review.proposal.fingerprint,approvedAt:now});
 const initial=linked.createLinkedInitialRecord(context,{phase:'approval-consumed-before-write',review,
  exception:{kind:'supervised-manual-recovery',consent:{challenge:'offline-fixture',automaticRollbackUnproven:true,manualAppRecoveryMayBeRequired:true},
   approvedAt:approval.approvedAt,approval,exactExperimentFingerprint:review.fingerprint,productionBlockers:review.restoration.blockers,
   automaticRollbackProven:false,manualRecovery:'offline fixture only'},
  preWriteRecheck:{teslaSource:f.capture.before.source,tariffKey:key(f.capture.before.tariff),krakenObservedAt:now,smartEvidenceKey:review.binding.smartEvidenceKey}});
 // Synthetic unlinked September-shaped evidence; never edits the real report or journal.
 const old=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8')).before;
 const priorInitial={phase:'approval-consumed-before-write',review:{before:old,date:'2026-09-23',proposal:{bound:{energySiteId:'12345',representation:old.tariff}}},exception:{kind:'supervised-manual-recovery'},preWriteRecheck:{tariffKey:key(old.tariff)}};
 const attemptedAt='2026-09-23T08:12:00Z',completedAt='2026-09-23T08:13:00Z';
 const comparison=load('src/lib/tesla-tariff/restoration-review.ts').compareObservedTariffReadBack({intended:{...old,source:{...old.source,kind:'simulation'}},readBack:null,after:attemptedAt,dates:['2026-09-23']});
 const priorClassified={phase:'classified',attemptedAt,completedAt,exception:priorInitial.exception,apiWrite:{status:'unknown',httpStatus:200},
  apiTariffReadBack:{observation:null,comparison},classification:'write-outcome-unknown',laterTeslaAppObservation:null,laterPowerwallOpticasterObservation:null,
  rollbackProven:false,productionWriteReady:false,automaticRestoreAttempted:false};
 const priorBytes=JSON.stringify(priorInitial)+'\n'+JSON.stringify(priorClassified)+'\n',root=path.join(directory,'site-12345.jsonl');
 await io.writeFile(root,priorBytes);
 const config={mode:'offline',directory,durableRoot:directory,site:'12345'};
 const ports={now:()=>now,capture:async()=>structuredClone(f.capture),readOwnership:async()=>({status:'missing'}),
  approveReconciliation:async binding=>({approvalId:'separate-reconciliation',bindingKey:hash(binding),approvedAt:now,disposition:'prior-conflict-reconciled-for-new-experiment',historicalApiRestoration:'not-proved'}),
  approveExperiment:async binding=>({approvalId:'separate-experiment',bindingKey:hash(binding),approvedAt:now})};
 return {f,initial,config,ports,root,priorBytes};
}
const noRuntimeAuthority=r=>{for(const k of ['writeReady','executionReady','grantsAdmissionAuthority','grantsRepeatAuthority','grantsSuccessorAuthority','restorationProven','runtimeConfirmationVerified','resolvesHistoricalJournal'])assert.equal(r[k],false,k);};
test('separate reconciliation admits offline without changing unlinked September-shaped evidence',async t=>{
 const x=await admissionFixture(t),result=await journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports);
 assert.equal(result.status,'admitted-offline');noRuntimeAuthority(result);assert.equal('finish' in result,false);
 assert.equal(await io.readFile(x.root,'utf8'),x.priorBytes);
 assert.ok(x.initial.review.hardBlockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));
 modules.delete(path.resolve('src/lib/tesla-tariff/repeat-attempt-journal.ts'));
 const restarted=load('src/lib/tesla-tariff/repeat-attempt-journal.ts');assert.notEqual(restarted,journals);
 const recovered=await restarted.readOfflineReconciledExperiment(x.config);
 assert.equal(recovered.status,'consistent-offline-admission');assert.equal(recovered.blocked,true);noRuntimeAuthority(recovered);
 assert.equal((await journals.repeatAttemptEligibility(x.config.directory,'12345',{status:'missing'})).code,'ATTEMPT_IN_PROGRESS');
 await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports),/ATTEMPT_IN_PROGRESS/);
});
test('missing reconciliation, mismatched site/baseline/ownership/approval and stale evidence cannot acquire a claim',async t=>{
 const cases=[
  x=>{x.ports.approveReconciliation=async()=>null;},
  x=>{x.ports.approveReconciliation=async b=>({approvalId:'r',bindingKey:hash(b),approvedAt:now,disposition:'unresolved',historicalApiRestoration:'not-proved'});},
  x=>{x.ports.approveExperiment=async()=>({approvalId:'e',bindingKey:'a'.repeat(64),approvedAt:now});},
  x=>{x.ports.approveExperiment=async b=>({approvalId:'separate-reconciliation',bindingKey:hash(b),approvedAt:now});},
  x=>{x.f.capture.before.source.energySiteId='999';},
  x=>{x.f.capture.before.representations.legacy.sell_tariff.name='changed';},
  x=>{x.ports.readOwnership=async()=>({status:'invalid'});},
  x=>{x.f.capture.kraken.lastSuccessfulUpdate='2026-10-27T11:58:00Z';},
 ];
 for(const mutate of cases){const x=await admissionFixture(t);mutate(x);await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports));
  assert.equal(await io.readFile(x.root,'utf8'),x.priorBytes);assert.deepEqual((await io.readdir(x.config.directory)).sort(),['site-12345.jsonl']);}
});
test('incomplete prior journal and unfinalised claim remain blocking despite new approvals',async t=>{
 for(const pending of [false,true]){const x=await admissionFixture(t);
  if(pending)await io.writeFile(path.join(x.config.directory,'site-12345-attempt.active'),'pending');else await io.writeFile(x.root,x.priorBytes.split('\n')[0]+'\n');
  await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports));
 }
});
test('concurrent admissions cannot both succeed; recovery cannot grant another claim',async t=>{
 const x=await admissionFixture(t);
 const results=await Promise.allSettled(['one','two'].map(id=>journals.admitOfflineReconciledExperiment(x.config,id,x.initial,x.ports)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const recovered=await journals.readOfflineReconciledExperiment(x.config);noRuntimeAuthority(recovered);
 assert.equal(recovered.status,'consistent-offline-admission');assert.equal(await io.readFile(x.root,'utf8'),x.priorBytes);
 await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'three',x.initial,x.ports),/ATTEMPT_IN_PROGRESS/);
});
test('baseline or prior evidence changed during approval rejects; interrupted locked recheck stays consumed',async t=>{
 for(const kind of ['baseline','history','locked']){const x=await admissionFixture(t),original=x.ports.approveExperiment;let reads=0;
  if(kind==='locked'){const read=x.ports.capture;x.ports.capture=async(...args)=>{if(++reads===3)throw Error('INTERRUPTED');return read(...args);};}
  else x.ports.approveExperiment=async b=>{const a=await original(b);if(kind==='baseline')x.f.capture.before.representations.v2.name='changed';else await io.appendFile(x.root,'\n');return a;};
  await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports));
  if(kind==='locked'){assert.equal((await journals.readOfflineReconciledExperiment(x.config)).status,'blocked');assert.equal((await journals.repeatAttemptEligibility(x.config.directory,'12345',{status:'missing'})).code,'ATTEMPT_IN_PROGRESS');}
 }
});
test('altered recovered approval and missing journal evidence remain blocked',async t=>{
 for(const change of ['approval','missing','historical']){const x=await admissionFixture(t);await journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports);
  if(change==='approval'){const file=path.join(x.config.directory,'site-12345-attempt.active'),marker=JSON.parse(await io.readFile(file,'utf8'));marker.approval.bindingKey='b'.repeat(64);const {checksum:_checksum,...body}=marker;void _checksum;marker.checksum=hash(body);await io.writeFile(file,JSON.stringify(marker)+'\n');}
  if(change==='missing')await io.unlink(path.join(x.config.directory,`site-12345-attempt-${x.initial.mutationId}.jsonl`));
  if(change==='historical')await io.appendFile(x.root,'\n');
  const r=await journals.readOfflineReconciledExperiment(x.config);assert.equal(r.status,'blocked');noRuntimeAuthority(r);
 }
});

test('known mutation replay is blocked without relabelling the linked prior outcome',async t=>{
 const x=await admissionFixture(t),attemptedAt='2026-10-27T12:00:01Z',completedAt='2026-10-27T12:00:02Z';
 const comparison=load('src/lib/tesla-tariff/restoration-review.ts').compareObservedTariffReadBack({intended:x.initial.review.before,readBack:null,after:attemptedAt,dates:['2026-10-27']});
 const classified=linked.createLinkedClassifiedRecord(x.initial,{phase:'classified',attemptedAt,completedAt,exception:x.initial.exception,
  apiWrite:{status:'unknown',httpStatus:200},apiTariffReadBack:{observation:null,comparison},classification:'write-outcome-unknown',
  laterTeslaAppObservation:null,laterPowerwallOpticasterObservation:null,rollbackProven:false,productionWriteReady:false,automaticRestoreAttempted:false});
 const bytes=JSON.stringify(x.initial)+'\n'+JSON.stringify(classified)+'\n';await io.writeFile(x.root,bytes);
 x.ports.now=()=> '2026-10-27T12:00:03Z';
 await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'different-experiment',x.initial,x.ports),/DUPLICATE_MUTATION_ID/);
 assert.equal(await io.readFile(x.root,'utf8'),bytes);
});
test('expired approvals, changed SMART rate and valid but different recaptured baseline block admission',async t=>{
 for(const kind of ['expired','price','baseline']){const x=await admissionFixture(t);
  if(kind==='expired'){const approve=x.ports.approveExperiment;x.ports.approveExperiment=async b=>({...await approve(b),approvedAt:'2026-10-27T11:58:00Z'});}
  if(kind==='price'){x.f.capture.kraken.importTariff.version.scheduledChargingImport.amount=.03;x.f.capture.kraken.importTariff.version.dailyImportWindows[0].price.amount=.03;}
  if(kind==='baseline'){x.f.capture.before.tariff.name+=' changed';x.f.capture.before.representations.v2.name=x.f.capture.before.tariff.name;x.f.capture.before.representations.legacy.name=x.f.capture.before.tariff.name;}
  await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'new-experiment',x.initial,x.ports));
  assert.deepEqual(await io.readdir(x.config.directory),['site-12345.jsonl']);
 }
});

test('admission revalidates 12:00:00 evidence at actual 12:01:01 after final validation at 12:00:59',async t=>{
 const x=await admissionFixture(t);let clockReads=0;
 x.ports.now=()=>++clockReads<=3?'2026-10-27T12:00:59Z':'2026-10-27T12:01:01Z';
 for(const name of ['approveReconciliation','approveExperiment']){const original=x.ports[name];x.ports[name]=async b=>({...await original(b),approvedAt:'2026-10-27T12:00:59Z'});}
 await assert.rejects(journals.admitOfflineReconciledExperiment(x.config,'expiry-transition',x.initial,x.ports),/INDEPENDENT_EVIDENCE_INVALID/);
 assert.equal(clockReads,4);
 assert.equal(await io.readFile(path.join(x.config.directory,'site-12345-attempt.active'),'utf8'),'');
 await assert.rejects(io.access(path.join(x.config.directory,`site-12345-attempt-${x.initial.mutationId}.jsonl`)),{code:'ENOENT'});
 assert.equal((await journals.readOfflineReconciledExperiment(x.config)).status,'blocked');
 assert.equal((await journals.repeatAttemptEligibility(x.config.directory,'12345',{status:'missing'})).code,'ATTEMPT_IN_PROGRESS');
 assert.equal(await io.readFile(x.root,'utf8'),x.priorBytes);
});
test('admission at the inclusive 12:01:00 evidence deadline remains recoverably consistent',async t=>{
 const x=await admissionFixture(t);let clockReads=0;
 x.ports.now=()=>++clockReads<=3?'2026-10-27T12:00:59Z':'2026-10-27T12:01:00Z';
 for(const name of ['approveReconciliation','approveExperiment']){const original=x.ports[name];x.ports[name]=async b=>({...await original(b),approvedAt:'2026-10-27T12:00:59Z'});}
 const r=await journals.admitOfflineReconciledExperiment(x.config,'deadline-control',x.initial,x.ports);
 assert.equal(r.status,'admitted-offline');assert.equal(clockReads,4);noRuntimeAuthority(r);
 const recovered=await journals.readOfflineReconciledExperiment(x.config);
 assert.equal(recovered.status,'consistent-offline-admission');noRuntimeAuthority(recovered);
 assert.equal(await io.readFile(x.root,'utf8'),x.priorBytes);
});

async function reconciledCliHarness(t,fault){
 const x=await admissionFixture(t),cwd=x.config.directory,root=path.join(cwd,'.cache/home-energy-platform'),directory=path.join(root,'tesla-experiments');
 await io.mkdir(directory,{recursive:true,mode:0o700});
 const historical=path.join(directory,'site-12345.jsonl');await io.writeFile(historical,x.priorBytes);
 if(fault==='conflict')await io.writeFile(path.join(directory,'site-12345-attempt.active'),'already-pending');
 const calls={gets:0,posts:0,acquisitions:0,questions:0,output:[]};let uuid=0,lastReconciliation='',continuationAppends=0;
 const blocked=()=>{throw Error('UNEXPECTED_EXECUTION');};
 const dependencies={
  'node:fs/promises':{...io,open:async(file,flags,...args)=>{
   const handle=await io.open(file,flags,...args);
   if(flags==='a'&&['continuation-io-failure','continuation-result-io-failure','continuation-slow-sync'].includes(fault)){
    const number=++continuationAppends;
    return new Proxy(handle,{get(target,k){if(k==='sync')return async()=>{
     if(fault==='continuation-io-failure'||fault==='continuation-result-io-failure'&&number===2)throw Error('SIMULATED_SYNC_FAILURE');
     await target.sync();if(fault==='continuation-slow-sync')x.ports.now=()=> '2026-10-27T12:01:01Z';
    };const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   }
   if(file.endsWith('.restore.execution')&&flags==='wx'&&fault==='restore-marker-crash')return new Proxy(handle,{get(target,k){if(k==='writeFile')return async()=>{throw Error('RESTORE_MARKER_CRASH');};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   if(flags==='a'&&['restore-intent-crash','restore-attempt-crash','restore-result-crash'].includes(fault)){
    const number=++continuationAppends;const target={ 'restore-intent-crash':4,'restore-attempt-crash':5,'restore-result-crash':6 }[fault];
    if(number===target)return new Proxy(handle,{get(target,k){if(k==='sync')return async()=>{throw Error('RESTORE_JOURNAL_CRASH');};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   }
   if(file.endsWith('.execution')&&flags==='wx'&&fault==='integrated-marker-crash')return new Proxy(handle,{get(target,k){if(k==='writeFile')return async()=>{throw Error('SIMULATED_MARKER_CRASH');};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   if(flags==='a'&&['integrated-attempt-crash','integrated-result-crash'].includes(fault)){
    const number=++continuationAppends;
    if(number===(fault==='integrated-attempt-crash'?2:3))return new Proxy(handle,{get(target,k){if(k==='sync')return async()=>{throw Error('SIMULATED_INTEGRATED_CRASH');};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   }
   if(fault==='attempt-sync-failure'&&flags==='r')return new Proxy(handle,{get(target,k){if(k==='sync')return async()=>{throw Error('ATTEMPT_SYNC_FAILURE');};const v=target[k];return typeof v==='function'?v.bind(target):v;}});
   return handle;
  },readFile:async(file,...args)=>{
   if(file===path.join(cwd,'.tesla-tokens.json'))return JSON.stringify({access_token:'offline-only'});
   const text=await io.readFile(file,...args);
   if(fault==='integrated-dispatch-expired'&&file.endsWith('.execution'))x.ports.now=()=> '2026-10-27T12:01:01Z';
   return text;
  }},
  'node:path':path,'node:crypto':{...crypto,randomUUID:()=>`fixture-identity-${++uuid}-${hash(cwd).slice(0,8)}`},
  'node:readline/promises':{createInterface:()=>({close(){},async question(message){calls.questions++;
   if(message==='Type AUTOMATIC ROLLBACK IS UNPROVEN: ')return 'AUTOMATIC ROLLBACK IS UNPROVEN';
   if(message==='Type MANUAL TESLA APP RECOVERY MAY BE REQUIRED: ')return 'MANUAL TESLA APP RECOVERY MAY BE REQUIRED';
   const expected=message.match(/\n([^\n]+)\n> $/)?.[1];assert.ok(expected,message);
   if(expected.startsWith('RECONCILE')){lastReconciliation=expected;if(fault==='approval')return 'wrong';}
   if(expected.startsWith('PREPARE')&&fault==='replay')return lastReconciliation;
   return expected;
  }})},
  '@next/env':{loadEnvConfig(){}},'../site/current-site':{currentSite:x.f.site},
  '../site/kraken-refresh':{async getRecordedKrakenStateForInspection(){calls.acquisitions++;return{state:fault==='missing'?null:structuredClone(x.f.capture.kraken),acquisition:{freshEvidenceObtained:fault!=='stale',staleFallbackUsed:fault==='stale'}};}},
  './observed-tariff':load('src/lib/tesla-tariff/observed-tariff.ts'),'./rollback-evidence':load('src/lib/tesla-tariff/rollback-evidence.ts'),
  './restoration-review':load('src/lib/tesla-tariff/restoration-review.ts'),
   './smart-inspection':load('src/lib/tesla-tariff/smart-inspection.ts'),
   './proposal-approval':load('src/lib/tesla-tariff/proposal-approval.ts'),'./ownership-transition':load('src/lib/tesla-tariff/ownership-transition.ts'),
  './repeat-attempt-journal':journals,'./linked-experiment-records':linked,'./prepared-mutation-context':load('src/lib/tesla-tariff/prepared-mutation-context.ts'),
  './ownership-store':{ownershipStore:()=>({read:async()=>({status:'missing'})})},
  './ownership-sqlite':{persistConfirmedSmart:blocked},'./supervised-journal':{claimExperimentJournal:blocked},'./supervised-experiment':api,
 };
 class FixedDate extends Date{constructor(...a){super(...(a.length?a:[now]));}}
 const evaluatePrivateRealm=()=>{
 const exports={};
 // Test-realm-only instrumentation; no application export or runtime switch.
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts','utf8')+'\nexport { createReconciledApplyContinuation as testPrivateContinuation, createPrivateAttemptProducer as testPrivateAttemptProducer, admitReconciledContinuation as testComposeReconciled };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,structuredClone,Date:FixedDate,AbortSignal,process:{cwd:()=>cwd,env:{},stdin:{isTTY:fault!=='noninteractive'},stdout:{isTTY:true},stderr:{isTTY:true}},
 console:{log:value=>calls.output.push(value)},fetch:async(_url,options)=>{
  if(options.method!=='GET'){calls.posts++;throw Error('POST_FORBIDDEN');}calls.gets++;
  if(fault==='interrupted'&&calls.gets===4)throw Error('INTERRUPTED');
  const v=structuredClone(x.f.capture.before.representations.v2);
  if(fault==='substituted'&&calls.gets>=2)v.name='changed';
  return{ok:true,json:async()=>({response:{energy_site_id:'12345',installation_time_zone:'Europe/London',tariff_content_v2:v,tariff_content:legacy(v)}})};
 },require:n=>{assert.ok(n in dependencies,n);return dependencies[n];}});
 return exports;
 };
 const exports=evaluatePrivateRealm();
 return {x,calls,config:{mode:'offline',directory,durableRoot:root,site:'12345'},historical,
  compose:()=>exports.testComposeReconciled(x.initial,x.config,'integrated-simulation',x.ports),
  restartAttempt:(adapter,kind='apply')=>evaluatePrivateRealm().testPrivateAttemptProducer(x.initial,x.config,()=>x.ports.now(),adapter,kind),
  restartCompose:()=>evaluatePrivateRealm().testComposeReconciled(x.initial,x.config,'recovered',x.ports),
  createPrivate:()=>exports.testPrivateContinuation(x.initial,x.config,x.ports),
  createAttempt:adapter=>exports.testPrivateAttemptProducer(x.initial,x.config,()=>x.ports.now(),adapter),
  run:(extra=[])=>exports.runLocalExperiment(['--site','12345','--vehicle','fixture-ev','--dispatch-start',x.f.selection.dispatchStart,'--prepare-reconciled','--experiment-id','cli-independent',...extra])};
}
test('closed CLI connects acquisition, exact review, separate approvals, durable claim and supervised dry-run only',async t=>{
 const h=await reconciledCliHarness(t);await h.run();
 const result=JSON.parse(h.calls.output.at(-1));assert.equal(result.status,'reconciled-preparation-recorded');
 assert.equal(result.admission.status,'admitted-offline');noRuntimeAuthority(result.admission);
 assert.ok(result.blockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));assert.ok(result.blockers.includes('BUY_BELOW_SELL'));
 assert.equal(h.calls.posts,0);assert.equal(h.calls.gets,4);assert.equal(h.calls.questions,5);
 assert.equal(await io.readFile(h.historical,'utf8'),h.x.priorBytes);
 assert.equal((await journals.readOfflineReconciledExperiment(h.config)).status,'consistent-offline-admission');
 await assert.rejects(h.run(),/ATTEMPT_IN_PROGRESS/);assert.equal(h.calls.posts,0);
});
test('closed preparation rejects missing/stale/substituted evidence and approval mismatch/replay without claims',async t=>{
 for(const fault of ['missing','stale','substituted','approval','replay']){const h=await reconciledCliHarness(t,fault);
  await assert.rejects(h.run());assert.equal(h.calls.posts,0);
  assert.equal(await io.readFile(h.historical,'utf8'),h.x.priorBytes);
  await assert.rejects(io.access(path.join(h.config.directory,'site-12345-attempt.active')),{code:'ENOENT'});
 }
});
test('closed preparation preserves conflicting and interrupted claims after recovery',async t=>{
 for(const fault of ['conflict','interrupted']){const h=await reconciledCliHarness(t,fault);
  await assert.rejects(h.run());assert.equal(h.calls.posts,0);
  assert.equal((await journals.readOfflineReconciledExperiment(h.config)).status,'blocked');
  assert.equal((await journals.repeatAttemptEligibility(h.config.directory,'12345',{status:'missing'})).code,'ATTEMPT_IN_PROGRESS');
  assert.equal(await io.readFile(h.historical,'utf8'),h.x.priorBytes);
 }
});
test('preparation cannot be combined with execute and requires a foreground interactive terminal',async t=>{
 for(const [fault,args,code]of [[undefined,['--execute-supervised'],'INVALID_ARGUMENTS'],['noninteractive',[],'INTERACTIVE_SUPERVISION_REQUIRED']]){
  const h=await reconciledCliHarness(t,fault);await assert.rejects(h.run(args),new RegExp(code));
  assert.equal(h.calls.gets+h.calls.posts+h.calls.acquisitions+h.calls.questions,0);
 }
});
test('offline admission, recovered record and approvals cannot replace the executor prepared context',async t=>{
 const x=await admissionFixture(t),admission=await journals.admitOfflineReconciledExperiment(x.config,'authority-negative',x.initial,x.ports);
 const recovered=await journals.readOfflineReconciledExperiment(x.config);let writes=0;
 for(const candidate of [admission,recovered,x.initial.exception.approval,x.initial]){
  await assert.rejects(api.runSupervisedExperiment({site:x.f.site,selection:x.f.selection,mode:'execute-supervised',authority:'supervised-experiment'},
   {now:()=>now,capture:async()=>x.f.capture,prepareContext:async()=>candidate,journalRecords:linked,write:async()=>{writes++;}}),/JOURNAL_INITIAL_INVALID/);
 }
 assert.equal(writes,0);
});

// Closed, TEST-ONLY continuation. No providers, documents, paths or capability
// are accepted from a caller or exported. The only transport is local state.
async function mockedReconciledApply(t, fault = 'valid', restoreScenario = null) {
 const x = await admissionFixture(t), original = key(x.initial.review.before);
 const admission = await journals.admitOfflineReconciledExperiment(x.config, 'mocked-continuation', x.initial, x.ports);
 noRuntimeAuthority(admission);
 const file = path.join(x.config.directory, `site-12345-attempt-${x.initial.mutationId}.jsonl`);
 const admittedBytes = await io.readFile(file, 'utf8');
 const markerFile = path.join(x.config.directory, 'site-12345-attempt.active');
 const markerBytes = await io.readFile(markerFile, 'utf8');
 const live = Object.freeze({}), identities = new WeakMap([[live, { used: false }]]);
 const events = []; let writes = 0;
 const append = async record => {
  const handle = await io.open(file, 'a');
  try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
 };
 const continueOnce = async identity => {
  const state = identities.get(identity);
  if (!state || state.used) throw Error('MOCK_CONTINUATION_NOT_LIVE');
  state.used = true; // consume before any await, including failed admission checks
  if (await io.readFile(file, 'utf8') !== admittedBytes || await io.readFile(markerFile, 'utf8') !== markerBytes)
   throw Error('MOCK_ADMISSION_CHANGED');
  const capture = structuredClone(x.f.capture);
  if (fault === 'site') capture.before.source.energySiteId = '999';
  if (fault === 'baseline') capture.before.representations.legacy.sell_tariff.name = 'substituted';
  if (fault === 'stale') capture.kraken.lastSuccessfulUpdate = '2026-10-27T11:58:00Z';
  const validated = api.validateCurrentSupervisedCapture(x.f.site, capture, now);
  const review = api.prepareSupervisedExperiment(x.f.site, x.f.selection, validated, now);
  if (key(review) !== key(x.initial.review) || key(capture.before) !== original
    || key(await x.ports.readOwnership('12345')) !== key({ status: 'missing' })) throw Error('MOCK_BINDING_CHANGED');
  // This is NOT removal of a production gate: both gates remain recorded and
  // the only execution below is an internally selected in-memory simulation.
  assert.ok(review.hardBlockers.includes('CURRENT_EVIDENCE_PREPARATION_ONLY'));
  assert.ok(review.restoration.blockers.includes('BUY_BELOW_SELL'));
  const attemptedAt = '2026-10-27T12:00:01Z';
  const intent = { version: 1, mode: 'mocked-reconciled-apply', phase: 'simulated-apply-intent',
   initialRecordId: x.initial.initialRecordId, mutationId: x.initial.mutationId,
   experimentId: admission.experimentId, site: '12345', baselineKey: hash(review.before),
   payloadKey: hash(review.payloadJson), admissionKey: hash(markerBytes), attemptedAt,
   writeReady: false, runtimeConfirmationVerified: false };
  if (fault === 'intent-interruption') { await io.appendFile(file, '{'); throw Error('INTERRUPTED_INTENT'); }
  await append(intent); events.push('durable-intent');
  // Private simulated transport: cannot call fetch or the Fleet API client.
  const simulate = async () => {
   const rows = (await io.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(key(rows.at(-1)), key(intent)); events.push('simulated-post'); writes++;
   if (fault === 'timeout') throw Error('SIMULATED_TIMEOUT');
   return api.interpretWriteResponse(fault === 'rejected' ? 400 : 200, { response: { result: fault !== 'rejected' } });
  };
  let apiWrite;
  try { apiWrite = await simulate(); } catch { apiWrite = { status: 'unknown', httpStatus: null }; }
  if (fault === 'after-write') throw Error('INTERRUPTED_AFTER_WRITE');
  const tariff = structuredClone(review.proposal.bound.representation);
  if (fault === 'transformed') tariff.name = 'Transformed';
  const readBack = fault === 'missing-readback' ? null : captureObservedTariff({ installation_time_zone: 'Europe/London',
   tariff_content_v2: tariff, tariff_content: legacy(tariff) }, '12345', '2026-10-27T12:00:02Z');
  const intended = load('src/lib/tesla-tariff/observed-tariff.ts').simulatedTariffObservation(review.before, review.proposal.bound.representation);
  const comparison = load('src/lib/tesla-tariff/restoration-review.ts').compareObservedTariffReadBack({ intended, readBack, after: attemptedAt, dates: [review.date] });
  const classification = api.classifyExperimentResult(apiWrite, intended, readBack, comparison);
  const classified = linked.createLinkedClassifiedRecord(x.initial, { phase: 'classified', attemptedAt,
   completedAt: '2026-10-27T12:00:03Z', exception: x.initial.exception, apiWrite,
   apiTariffReadBack: { observation: readBack, comparison }, classification,
   laterTeslaAppObservation: null, laterPowerwallOpticasterObservation: null,
   rollbackProven: false, productionWriteReady: false, automaticRestoreAttempted: false });
  assert.equal(linked.validLinkedClassifiedRecord(classified, x.initial), true);
  if (fault === 'result-interruption') { await io.appendFile(file, '{'); throw Error('INTERRUPTED_RESULT'); }
  // Label simulated provenance outside the reusable linked evidence. Never call
  // journal.finish(), the completion registry or an ownership writer.
  await append({ version: 1, mode: 'mocked-reconciled-apply', phase: 'simulated-apply-classified',
   intentKey: hash(intent), classified, runtimeConfirmationVerified: false, writeReady: false });
  events.push('durable-result');
  if (!restoreScenario) return { classification, comparison };
  if (classification !== 'submitted-representation-preserved' || comparison.outcome !== 'exact-observed-match')
   throw Error('SIMULATED_APPLY_NOT_CONFIRMED');
  const restoration = load('src/lib/tesla-tariff/restoration-review.ts');
  const reviewed = restoration.reviewObservedRestoration({ before: review.before, temporaryProposal: review.proposal,
   asOf: '2026-10-27T12:00:04Z', maxCaptureAgeMs: api.CAPTURE_TTL_MS });
  if (!reviewed.structurallyComplete || !reviewed.boundToProposal) throw Error('RESTORE_BASELINE_INVALID');
  const target = structuredClone(review.before);
  assert.equal(key(reviewed.documentedEnvelopeCandidate.tou_settings.tariff_content_v2), key(target.tariff));
  const preRestore = structuredClone(readBack);
  preRestore.source.observedAt = '2026-10-27T12:00:04Z';
  if (restoreScenario === 'external-change') preRestore.representations.legacy.name = 'Flatpeak changed';
  const validateTesla = load('src/lib/tesla-tariff/smart-inspection.ts').validateTeslaInspectionEvidence;
  if (!validateTesla(preRestore) || key(preRestore.tariff) !== key(readBack.tariff)
   || key(preRestore.representations) !== key(readBack.representations)) throw Error('RESTORE_CURRENT_STATE_CHANGED');
  const binding = { experimentId: admission.experimentId, mutationId: x.initial.mutationId, site: '12345',
   initialRecordId: x.initial.initialRecordId, originalObservationKey: hash(target),
   appliedResultKey: hash(classified), currentObservationKey: hash(preRestore),
   payloadJson: JSON.stringify(reviewed.documentedEnvelopeCandidate), admissionKey: hash(markerBytes) };
  // Independent fixture approval: never reuse either admission approval.
  const approved = Object.freeze({ approvalId: 'separate-restore-approval', bindingKey: hash(binding),
   approvedAt: restoreScenario === 'stale-approval' ? '2026-10-27T11:58:00Z' : '2026-10-27T12:00:05Z' });
  let supplied = approved;
  if (restoreScenario === 'missing-approval') supplied = null;
  if (restoreScenario === 'substituted-approval') supplied = { ...approved, bindingKey: hash('other operation') };
  if (restoreScenario === 'copied-approval') supplied = structuredClone(approved);
  if (restoreScenario === 'replayed-approval') supplied = JSON.parse(markerBytes).approval;
  const restoreLive = Object.freeze({}), restoreIdentities = new WeakMap([[restoreLive, { used: false }]]);
  const restoreOnce = async token => {
   const active = restoreIdentities.get(token);
   if (!active || active.used) throw Error('RESTORE_NOT_LIVE');
   active.used = true;
   if (supplied !== approved || supplied.bindingKey !== hash(binding)
    || Date.parse(supplied.approvedAt) < Date.parse(classified.completedAt)
    || Date.parse(supplied.approvedAt) > Date.parse('2026-10-27T12:00:06Z')
    || Date.parse('2026-10-27T12:00:06Z') - Date.parse(supplied.approvedAt) > api.APPROVAL_TTL_MS)
    throw Error('RESTORE_APPROVAL_INVALID');
   if (await io.readFile(markerFile, 'utf8') !== markerBytes) throw Error('RESTORE_CLAIM_CHANGED');
   const rows = (await io.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
   if (key(rows.at(-1).classified) !== key(classified)) throw Error('RESTORE_APPLY_RECORD_CHANGED');
   const restoreIntent = { version: 1, mode: 'mocked-reconciled-apply', phase: 'simulated-restore-intent',
    binding, approval: supplied, attemptedAt: '2026-10-27T12:00:06Z', writeReady: false, runtimeConfirmationVerified: false };
   if (restoreScenario === 'intent-failure') { await io.appendFile(file, '{'); throw Error('RESTORE_INTENT_INTERRUPTED'); }
   await append(restoreIntent); events.push('durable-restore-intent');
   // Fixed in-memory transport; no caller-selected provider or network function.
   assert.equal(key(JSON.parse((await io.readFile(file, 'utf8')).trim().split('\n').at(-1))), key(restoreIntent));
   events.push('simulated-restore-post'); writes++;
   let restoreWrite;
   try {
    if (restoreScenario === 'timeout') throw Error('SIMULATED_RESTORE_TIMEOUT');
    restoreWrite = api.interpretWriteResponse(restoreScenario === 'rejected' ? 400 : restoreScenario === 'ambiguous' ? 503 : 200,
     { response: { result: restoreScenario !== 'rejected' } });
   } catch { restoreWrite = { status: 'unknown', httpStatus: null }; }
   const restoredV2 = structuredClone(target.representations.v2), restoredLegacy = structuredClone(target.representations.legacy);
   if (restoreScenario === 'wrong-v2') restoredV2.name = 'Wrong restored metadata';
   if (restoreScenario === 'wrong-legacy') restoredLegacy.name = 'Wrong legacy';
   if (restoreScenario === 'wrong-export') { restoredV2.sell_tariff.name = 'Wrong export'; restoredLegacy.sell_tariff.name = 'Wrong export'; }
   const restored = captureObservedTariff({ installation_time_zone: 'Europe/London', tariff_content_v2: restoredV2,
    tariff_content: restoredLegacy }, '12345', '2026-10-27T12:00:07Z');
   const restoreComparison = restoration.compareObservedTariffReadBack({ intended: target, readBack: restored,
    after: restoreIntent.attemptedAt, dates: [review.date] });
   const restoreClassification = api.classifyExperimentResult(restoreWrite, target, restored, restoreComparison);
   const result = { version: 1, mode: 'mocked-reconciled-apply', phase: 'simulated-restore-classified',
    intentKey: hash(restoreIntent), restoreWrite, observation: restored, comparison: restoreComparison,
    classification: restoreClassification, completedAt: '2026-10-27T12:00:08Z', writeReady: false, runtimeConfirmationVerified: false };
   if (restoreScenario === 'classification-failure') { await io.appendFile(file, '{'); throw Error('RESTORE_RESULT_INTERRUPTED'); }
   await append(result); events.push('durable-restore-result');
   if (restoreClassification !== 'submitted-representation-preserved' || restoreComparison.outcome !== 'exact-observed-match'
    || !restoreComparison.exportSubtreeMatches || key(restored.representations) !== key(target.representations))
    throw Error('RESTORE_NOT_CONFIRMED');
   const persisted = JSON.parse((await io.readFile(file, 'utf8')).trim().split('\n').at(-1));
   if (key(persisted) !== key(result)) throw Error('RESTORE_RESULT_NOT_DURABLE');
   if (restoreScenario === 'completion-failure') { await io.appendFile(file, '{'); throw Error('SIMULATION_COMPLETION_INTERRUPTED'); }
   await append({ version: 1, mode: 'mocked-reconciled-apply', phase: 'simulation-complete',
    bindingKey: hash(binding), restoreResultKey: hash(result), originalObservationKey: hash(target),
    writeReady: false, runtimeConfirmationVerified: false, productionClaimReleased: false });
   events.push('simulation-complete');
   return { classification, comparison, restored: true, restoreComparison };
  };
  const candidates = restoreScenario === 'concurrent' ? [restoreLive, restoreLive]
   : [restoreScenario === 'restart' ? await journals.readOfflineReconciledExperiment(x.config) : restoreLive];
  const restoredResults = await Promise.allSettled(candidates.map(restoreOnce));
  await assert.rejects(restoreOnce(restoreScenario === 'restart' ? {} : restoreLive), /RESTORE_NOT_LIVE/);
  if (restoreScenario === 'concurrent') assert.equal(restoredResults.filter(r => r.status === 'fulfilled').length, 1);
  if (restoredResults[0].status === 'rejected') throw restoredResults[0].reason;
  return restoredResults[0].value;
 };
 if (fault === 'approval') {
  const marker = JSON.parse(markerBytes); marker.approval.approvalId = 'substituted';
  const { checksum: _checksum, ...body } = marker; void _checksum;
  await io.writeFile(markerFile, JSON.stringify({ ...body, checksum: hash(body) }) + '\n');
 }
 const results = fault === 'concurrent' ? await Promise.allSettled([continueOnce(live), continueOnce(live)])
  : await Promise.allSettled([continueOnce(fault === 'copy' ? structuredClone(live) : fault === 'document' ? admission : live)]);
 await assert.rejects(continueOnce(['copy', 'document'].includes(fault) ? admission : live), /MOCK_CONTINUATION_NOT_LIVE/);
 assert.equal(key(x.initial.review.before), original);
 assert.equal(await io.readFile(x.root, 'utf8'), x.priorBytes);
 const recovered = await journals.readOfflineReconciledExperiment(x.config);
 assert.ok(['blocked', 'consistent-offline-admission'].includes(recovered.status)); noRuntimeAuthority(recovered);
 if (restoreScenario) {
  assert.equal(recovered.status, 'blocked');
  assert.equal(await io.readFile(markerFile, 'utf8'), markerBytes);
 }
 assert.equal((await journals.repeatAttemptEligibility(x.config.directory, '12345', { status: 'missing' })).code, 'ATTEMPT_IN_PROGRESS');
 return { results, events, writes, original: x.initial.review.before, rows: await io.readFile(file, 'utf8') };
}

test('closed mocked continuation durably records intent before one simulated apply and exact dual readback', async t => {
 const r = await mockedReconciledApply(t);
 assert.equal(r.results[0].status, 'fulfilled');
 assert.equal(r.results[0].value.classification, 'submitted-representation-preserved');
 assert.equal(r.results[0].value.comparison.outcome, 'exact-observed-match');
 assert.equal(r.results[0].value.comparison.exportSubtreeMatches, true);
 assert.deepEqual(r.events, ['durable-intent', 'simulated-post', 'durable-result']);
 assert.equal(r.writes, 1); assert.equal(r.original.representations.relationship, 'consistent');
 assert.equal(r.rows.trim().split('\n').length, 3);
});
test('mocked continuation classifies transformed, missing, rejected and ambiguous results without retry', async t => {
 for (const [fault, expected] of [['transformed', 'accepted-but-transformed-differently'], ['missing-readback', 'read-back-unavailable-or-insufficient'],
  ['rejected', 'request-rejected'], ['timeout', 'write-outcome-unknown']]) {
  const r = await mockedReconciledApply(t, fault);
  assert.equal(r.results[0].status, 'fulfilled'); assert.equal(r.results[0].value.classification, expected); assert.equal(r.writes, 1);
 }
});
test('mocked continuation rejects copied authority, changed evidence and rehashed approval substitution', async t => {
 for (const fault of ['copy', 'document', 'site', 'baseline', 'stale', 'approval']) {
  const r = await mockedReconciledApply(t, fault); assert.equal(r.results[0].status, 'rejected', fault); assert.equal(r.writes, 0, fault);
 }
});
test('mocked continuation consumes once under concurrency and retains interrupted claims', async t => {
 const concurrent = await mockedReconciledApply(t, 'concurrent');
 assert.equal(concurrent.results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(concurrent.writes, 1);
 for (const fault of ['intent-interruption', 'after-write', 'result-interruption']) {
  const r = await mockedReconciledApply(t, fault); assert.equal(r.results[0].status, 'rejected');
  assert.equal(r.writes, fault === 'intent-interruption' ? 0 : 1);
 }
});

test('mocked restore completes exact original dual restoration after separate approval without releasing claim', async t => {
 for (const scenario of ['valid', 'concurrent']) {
  const r = await mockedReconciledApply(t, 'valid', scenario);
  assert.equal(r.results[0].status, 'fulfilled'); assert.equal(r.results[0].value.restored, true);
  assert.equal(r.writes, 2); assert.equal(r.results[0].value.restoreComparison.outcome, 'exact-observed-match');
  assert.deepEqual(r.events, ['durable-intent', 'simulated-post', 'durable-result', 'durable-restore-intent',
   'simulated-restore-post', 'durable-restore-result', 'simulation-complete']);
  const rows = r.rows.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 6); assert.equal(rows.at(-1).productionClaimReleased, false);
  assert.equal(key(rows[4].observation.representations), key(r.original.representations));
 }
});
test('mocked restore rejects missing stale copied replayed or substituted approval, external changes and recovered identities', async t => {
 for (const scenario of ['missing-approval', 'stale-approval', 'copied-approval', 'replayed-approval', 'substituted-approval', 'external-change', 'restart']) {
  const r = await mockedReconciledApply(t, 'valid', scenario);
  assert.equal(r.results[0].status, 'rejected', scenario); assert.equal(r.writes, 1, scenario);
  assert.equal(r.events.includes('simulation-complete'), false);
 }
});
test('mocked restore cannot follow rejected ambiguous interrupted or mismatched apply', async t => {
 for (const fault of ['rejected', 'timeout', 'transformed', 'missing-readback', 'after-write']) {
  const r = await mockedReconciledApply(t, fault, 'valid');
  assert.equal(r.results[0].status, 'rejected'); assert.equal(r.writes, 1);
  assert.equal(r.events.includes('durable-restore-intent'), false);
 }
});
test('mocked restore rejects wrong dual/export readback and rejected timed-out or ambiguous restore without completion', async t => {
 for (const scenario of ['wrong-v2', 'wrong-legacy', 'wrong-export', 'rejected', 'timeout', 'ambiguous']) {
  const r = await mockedReconciledApply(t, 'valid', scenario);
  assert.equal(r.results[0].status, 'rejected', scenario); assert.equal(r.writes, 2);
  assert.equal(r.events.includes('durable-restore-result'), true); assert.equal(r.events.includes('simulation-complete'), false);
 }
});
test('mocked restore journal intent classification and terminal failures retain blocking claim', async t => {
 for (const scenario of ['intent-failure', 'classification-failure', 'completion-failure']) {
  const r = await mockedReconciledApply(t, 'valid', scenario);
  assert.equal(r.results[0].status, 'rejected', scenario); assert.equal(r.writes, scenario === 'intent-failure' ? 1 : 2);
  assert.equal(r.events.includes('simulation-complete'), false);
 }
});

async function privateContinuationFixture(t, fault) {
 const h = await reconciledCliHarness(t, fault), x = h.x;
 await journals.admitOfflineReconciledExperiment(x.config, 'private-journal-continuation', x.initial, x.ports);
 const marker = path.join(x.config.directory, 'site-12345-attempt.active');
 const markerBytes = await io.readFile(marker, 'utf8');
 const file = path.join(x.config.directory, `site-12345-attempt-${x.initial.mutationId}.jsonl`);
 const handle = await h.createPrivate();
 return { ...h, handle, marker, markerBytes, file };
}
function privateApplyReport(x, status = 'accepted') {
 const review = x.initial.review, observed = load('src/lib/tesla-tariff/observed-tariff.ts');
 const intended = observed.simulatedTariffObservation(review.before, review.proposal.bound.representation);
 const v = structuredClone(review.proposal.bound.representation);
 const observation = captureObservedTariff({ installation_time_zone: 'Europe/London', tariff_content_v2: v, tariff_content: legacy(v) },
  '12345', '2026-10-27T12:00:01Z');
 const apiWrite = { status, httpStatus: status === 'accepted' ? 200 : null };
 const comparison = load('src/lib/tesla-tariff/restoration-review.ts').compareObservedTariffReadBack({ intended, readBack: observation,
  after: now, dates: [review.date] });
 return linked.createLinkedClassifiedRecord(x.initial, { phase: 'classified', attemptedAt: now, completedAt: '2026-10-27T12:00:02Z',
  exception: x.initial.exception, apiWrite, apiTariffReadBack: { observation, comparison },
  classification: api.classifyExperimentResult(apiWrite, intended, observation, comparison), laterTeslaAppObservation: null,
  laterPowerwallOpticasterObservation: null, rollbackProven: false, productionWriteReady: false, automaticRestoreAttempted: false });
}
test('private production continuation records intent and unverified classification on the original claim without execution authority', async t => {
 const h = await privateContinuationFixture(t);
 assert.deepEqual(Object.keys(h.handle).sort(), ['recordApplyClassification', 'recordApplyIntent', 'runSimulatedApply', 'runSimulatedRestore']);
 await h.handle.recordApplyIntent();
 let rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length, 2); assert.equal(rows[1].phase, 'apply-intent');
 h.x.ports.now = () => '2026-10-27T12:00:02Z';
 const report = privateApplyReport(h.x);
 await h.handle.recordApplyClassification(report);
 rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(journals.validReconciledApplyRecords(h.x.initial, hash(h.markerBytes), rows.slice(1)), true);
 assert.equal(rows[2].executionProvenance, 'unverified-report'); assert.equal(rows[2].runtimeConfirmationVerified, false);
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 assert.equal(await io.readFile(h.x.root, 'utf8'), h.x.priorBytes);
 assert.equal(h.calls.posts + h.calls.gets, 0);
 await assert.rejects(h.handle.recordApplyIntent(), /CONTINUATION_NOT_LIVE/);
 await assert.rejects(h.handle.recordApplyClassification(report), /CONTINUATION_NOT_LIVE/);
 const receipt = load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts').issueConfirmedSmartReceipt(h.handle, h.x.initial, report);
 assert.equal(receipt.code, 'JOURNAL_COMPLETION_NOT_BOUND');
 await assert.rejects(h.createPrivate(), /CONTINUATION_ALREADY_CREATED/);
});
test('private production continuation rejects copied handles and concurrent intent/classification replay', async t => {
 const h = await privateContinuationFixture(t);
 await assert.rejects(h.createPrivate(), /CONTINUATION_ALREADY_CREATED/);
 await assert.rejects(({ ...h.handle }).recordApplyIntent(), /CONTINUATION_NOT_LIVE/);
 const pending = await Promise.allSettled([h.handle.recordApplyIntent(), h.handle.recordApplyIntent()]);
 assert.equal(pending.filter(r => r.status === 'fulfilled').length, 1);
 h.x.ports.now = () => '2026-10-27T12:00:02Z';
 const reports = await Promise.allSettled([h.handle.recordApplyClassification(privateApplyReport(h.x, 'unknown')),
  h.handle.recordApplyClassification(privateApplyReport(h.x, 'unknown'))]);
 assert.equal(reports.filter(r => r.status === 'fulfilled').length, 1);
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows[2].classified.classification, 'write-outcome-unknown');
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
});
test('private production continuation fails closed on stale or changed Tesla Kraken ownership and approval evidence', async t => {
 for (const fault of ['stale', 'baseline', 'site', 'pricing', 'ownership', 'approval']) {
  const h = await privateContinuationFixture(t);
  if (fault === 'stale') h.x.ports.now = () => '2026-10-27T12:01:01Z';
  if (fault === 'baseline') h.x.f.capture.before.representations.legacy.sell_tariff.name = 'changed';
  if (fault === 'site') h.x.f.capture.before.source.energySiteId = '54321';
  if (fault === 'pricing') h.x.f.capture.kraken.importTariff.version.scheduledChargingImport.amount = .03;
  if (fault === 'ownership') h.x.ports.readOwnership = async () => ({ status: 'invalid' });
  if (fault === 'approval') { const m = JSON.parse(h.markerBytes); m.approval.approvalId = 'replacement';
   const { checksum: _checksum, ...body } = m; void _checksum; await io.writeFile(h.marker, JSON.stringify({ ...body, checksum: hash(body) }) + '\n'); }
  await assert.rejects(h.handle.recordApplyIntent(), undefined, fault);
  await assert.rejects(h.handle.recordApplyIntent(), /CONTINUATION_NOT_LIVE/);
  assert.equal((await io.readFile(h.file, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await journals.repeatAttemptEligibility(h.x.config.directory, '12345', { status: 'missing' })).code, 'ATTEMPT_IN_PROGRESS');
 }
});
test('private production continuation retains the claim after durable-write uncertainty and rejects invalid ordering', async t => {
 const h = await privateContinuationFixture(t, 'continuation-io-failure');
 await assert.rejects(h.handle.recordApplyClassification(privateApplyReport(h.x)), /CONTINUATION_NOT_LIVE/);
 await assert.rejects(h.handle.recordApplyIntent(), /SIMULATED_SYNC_FAILURE/);
 await assert.rejects(h.handle.recordApplyIntent(), /CONTINUATION_NOT_LIVE/);
 await assert.rejects(h.handle.recordApplyClassification(privateApplyReport(h.x)), /CONTINUATION_NOT_LIVE/);
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
});
test('pure lifecycle validation rejects rehashed substitutions and never promotes documentary confirmation', async t => {
 const h = await privateContinuationFixture(t); await h.handle.recordApplyIntent();
 h.x.ports.now = () => '2026-10-27T12:00:02Z';
 await h.handle.recordApplyClassification(privateApplyReport(h.x));
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse).slice(1);
 for (const mutate of [r => { r[0].site = '54321'; }, r => { r[0].admissionKey = hash('other'); },
  r => { r[1].intentRecordId = hash('other'); }, r => { r[1].runtimeConfirmationVerified = true; },
  r => { r[1].classified.classification = 'write-outcome-unknown'; }]) {
  const changed = structuredClone(rows); mutate(changed);
  for (const r of changed) { const { recordId: _recordId, ...body } = r; void _recordId; r.recordId = hash(body); }
  assert.equal(journals.validReconciledApplyRecords(h.x.initial, hash(h.markerBytes), changed), false);
 }
 assert.equal(journals.validReconciledApplyRecords(h.x.initial, hash(h.markerBytes), [...rows, rows[1]]), false);
 assert.equal(/export\s+(?:async\s+)?function\s+createReconciledApplyContinuation/.test(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts', 'utf8')), false);
});

test('private production continuation cannot advance after slow intent sync or uncertain classification durability', async t => {
 for (const fault of ['continuation-slow-sync', 'continuation-result-io-failure']) {
  const h = await privateContinuationFixture(t, fault);
  if (fault === 'continuation-slow-sync') {
   await assert.rejects(h.handle.recordApplyIntent(), /CONTINUATION_EVIDENCE_EXPIRED/);
  } else {
   await h.handle.recordApplyIntent(); h.x.ports.now = () => '2026-10-27T12:00:02Z';
   await assert.rejects(h.handle.recordApplyClassification(privateApplyReport(h.x)), /SIMULATED_SYNC_FAILURE/);
  }
  await assert.rejects(h.handle.recordApplyIntent(), /CONTINUATION_NOT_LIVE/);
  await assert.rejects(h.handle.recordApplyClassification(privateApplyReport(h.x)), /CONTINUATION_NOT_LIVE/);
  assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
  assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 }
});

async function attemptProducerFixture(t, fault = 'valid') {
 const h = await privateContinuationFixture(t); await h.handle.recordApplyIntent();
 const calls = [];
 const adapter = {
  async post(site, payload) {
   calls.push('post'); assert.equal(site, '12345'); assert.equal(payload, h.x.initial.review.payloadJson);
   const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(rows[1].phase, 'apply-intent'); assert.equal(rows.length, 3); assert.equal(rows[2].phase, 'attempt-consumed');
   if (fault === 'timeout') throw Error('OFFLINE_TIMEOUT');
   return { httpStatus: fault === 'rejected' ? 400 : fault === 'ambiguous' ? 503 : 200,
    body: { response: { result: fault !== 'rejected' }, secret: 'DO_NOT_RETAIN_RESPONSE_BODY' } };
  },
  async readBack(site) {
   calls.push('readback'); assert.equal(site, '12345');
   h.x.ports.now = () => '2026-10-27T12:00:02Z';
   if (fault === 'missing') throw Error('OFFLINE_READ_FAILURE');
   const observation = privateApplyReport(h.x).apiTariffReadBack.observation;
   if (fault === 'stale') observation.source.observedAt = '2026-10-27T11:59:00Z';
   if (fault === 'future') observation.source.observedAt = '2026-10-27T12:01:00Z';
   if (fault === 'wrong-site') observation.source.energySiteId = '54321';
   if (fault === 'transformed') observation.representations.legacy.sell_tariff.name = 'Changed export';
   if (fault === 'simulation-source') observation.source.kind = 'simulation';
   if (fault === 'clock-failure') h.x.ports.now = () => { throw Error('OFFLINE_CLOCK_FAILURE'); };
   return observation;
  },
 };
 const producer = await h.createAttempt(adapter);
 return { ...h, producer, adapter, calls };
}
test('private attempt producer captures exact simulated response/readback causality and binds durable intent without authority', async t => {
 const h = await attemptProducerFixture(t), result = await h.producer.run();
 assert.deepEqual(h.calls, ['post', 'readback']); assert.equal(result.outcome, 'accepted-exact-readback');
 assert.equal(result.provenance, 'simulated-injected-transport'); assert.ok(result.attemptId);
 assert.equal(result.binding.mutationId, h.x.initial.mutationId); assert.equal(result.binding.payloadKey, hash(h.x.initial.review.payloadJson));
 assert.equal(result.binding.ownershipKey, hash(h.x.initial.preparedContext.ownership));
 assert.equal(result.binding.originalObservationKey, hash(h.x.initial.review.before));
 assert.equal(result.comparison.exportSubtreeMatches, true); assert.equal(result.productionConfirmation, false);
 assert.equal(result.runtimeConfirmationVerified, false); assert.equal(result.grantsCompletionAuthority, false);
 assert.equal(Object.isFrozen(result.binding), true); assert.equal(Object.isFrozen(result.observation.representations), true);
 assert.equal(JSON.stringify(result).includes('DO_NOT_RETAIN_RESPONSE_BODY'), false);
 const issuer = load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
 for (const candidate of [result, result.attemptId, structuredClone(result), h.producer])
  assert.equal(issuer.issueConfirmedSmartReceipt(candidate, h.x.initial, privateApplyReport(h.x)).code, 'JOURNAL_COMPLETION_NOT_BOUND');
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 await assert.rejects(h.producer.run(), /ATTEMPT_NOT_LIVE/);
 const other = await attemptProducerFixture(t); const next = await other.producer.run();
 assert.notEqual(result.attemptId, next.attemptId);
});
test('private attempt producer disabled production path invokes no transport and external evidence never supplies authority', async t => {
 const h = await privateContinuationFixture(t);
 await assert.rejects(h.createAttempt(), /ATTEMPT_INTENT_INVALID/);
 await h.handle.recordApplyIntent();
 const disabled = await h.createAttempt(); const result = await disabled.run();
 assert.equal(result.outcome, 'not-attempted'); assert.equal(result.attemptId, null);
 assert.equal(result.provenance, 'disabled-production'); assert.equal(result.productionConfirmation, false);
 const fake = await h.createAttempt(); await assert.rejects(fake.run({ authenticated: true, attemptId: 'forged', apiWrite: { status: 'accepted', httpStatus: 200 } }), /ATTEMPT_EXTERNAL_EVIDENCE_REJECTED/);
 await assert.rejects(fake.run(), /ATTEMPT_NOT_LIVE/); assert.equal(h.calls.posts + h.calls.gets, 0);
 assert.equal(/export\s+(?:async\s+)?function\s+createPrivateAttemptProducer/.test(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts', 'utf8')), false);
});
test('private attempt producer does not confirm response-only or readback-only and keeps ambiguous attempts unknown', async t => {
 for (const [fault, expected] of [['missing', 'accepted-readback-unverified'], ['timeout', 'write-outcome-unknown'],
  ['ambiguous', 'write-outcome-unknown'], ['rejected', 'write-rejected'], ['stale', 'accepted-readback-unverified'],
  ['future', 'accepted-readback-unverified'], ['wrong-site', 'accepted-readback-unverified'],
  ['transformed', 'accepted-readback-unverified'], ['simulation-source', 'accepted-readback-unverified'], ['clock-failure', 'accepted-readback-unverified']]) {
  const h = await attemptProducerFixture(t, fault), result = await h.producer.run();
  assert.equal(result.outcome, expected, fault); assert.equal(result.productionConfirmation, false);
  assert.deepEqual(h.calls, ['post', 'readback']); await assert.rejects(h.producer.run(), /ATTEMPT_NOT_LIVE/);
 }
});
test('private attempt producer rejects duplicate/concurrent invocation and copied identities; captures adapter methods once', async t => {
 const h = await attemptProducerFixture(t), second = await h.createAttempt(h.adapter);
 h.adapter.post = async () => { throw Error('SUBSTITUTED_TRANSPORT'); };
 await assert.rejects(({ ...h.producer }).run(), /ATTEMPT_NOT_LIVE/);
 const results = await Promise.allSettled([h.producer.run(), h.producer.run(), second.run()]);
 assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
 assert.equal(results[0].value.outcome, 'accepted-exact-readback'); assert.deepEqual(h.calls, ['post', 'readback']);
 assert.equal(typeof JSON.parse(JSON.stringify(results[0].value)).run, 'undefined');
});
test('private attempt producer requires unchanged bound durable intent before invoking any transport', async t => {
 for (const fault of ['missing-intent', 'changed-intent', 'ownership-substitution', 'changed-marker', 'expired']) {
  const h = await attemptProducerFixture(t);
  if (fault === 'missing-intent') await io.writeFile(h.file, JSON.stringify(h.x.initial) + '\n');
  if (fault === 'changed-intent') await io.appendFile(h.file, '{');
  if (fault === 'ownership-substitution') {
   const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse); rows[0].preparedContext.ownership.energySiteId = '999';
   await io.writeFile(h.file, rows.map(JSON.stringify).join('\n') + '\n');
  }
  if (fault === 'changed-marker') await io.appendFile(h.marker, '\n');
  if (fault === 'expired') h.x.ports.now = () => '2026-10-27T12:01:01Z';
  await assert.rejects(h.producer.run()); assert.deepEqual(h.calls, []);
  await assert.rejects(h.producer.run(), /ATTEMPT_NOT_LIVE/);
 }
});

test('private attempt producer cannot invoke transport after intent durability uncertainty', async t => {
 const h = await privateContinuationFixture(t, 'attempt-sync-failure'); await h.handle.recordApplyIntent();
 let calls = 0;
 const producer = await h.createAttempt({ post: async () => { calls++; throw Error('FORBIDDEN'); },
  readBack: async () => { calls++; throw Error('FORBIDDEN'); } });
 await assert.rejects(producer.run(), /ATTEMPT_SYNC_FAILURE/); assert.equal(calls, 0);
 await assert.rejects(producer.run(), /ATTEMPT_NOT_LIVE/);
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
});

async function integratedApplyFixture(t, fault, approveRestoration) {
 const h = await reconciledCliHarness(t, fault), x = h.x;
 const context = await load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareMutationContext(x.f,
  { now: () => now, readOwnership: x.ports.readOwnership, newMutationId: () => x.initial.mutationId });
 const prepared = await api.runSupervisedExperiment({ site: x.f.site, selection: x.f.selection, mode: 'dry-run', authority: 'observe' },
  { capture: x.ports.capture, prepareContext: async () => context, journalRecords: linked,
   claim: async () => { throw Error('SECOND_SITE_CLAIM_FORBIDDEN'); }, write: async () => { throw Error('LIVE_WRITE_FORBIDDEN'); } });
 assert.equal(key(prepared.review), key(x.initial.review));
 if (approveRestoration) x.ports.approveRestoration = approveRestoration;
 const composed = await h.compose(); noRuntimeAuthority(composed.admission);
 const file = path.join(x.config.directory, `site-12345-attempt-${x.initial.mutationId}.jsonl`);
 const marker = path.join(x.config.directory, 'site-12345-attempt.active'), markerBytes = await io.readFile(marker, 'utf8');
 const calls = [], expectedPayload = x.initial.review.payloadJson;
 const adapter = {
  async post(site, payload) {
   calls.push('post'); assert.equal(site, '12345'); assert.equal(payload, expectedPayload);
   const rows = (await io.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(rows.length, 3); assert.equal(rows[2].phase, 'attempt-consumed');
   assert.equal(key(JSON.parse(await io.readFile(file + '.execution', 'utf8'))), key(rows[2]));
   if (fault === 'timeout') throw Error('SIMULATED_TIMEOUT');
   return { httpStatus: fault === 'rejected' ? 400 : fault === 'ambiguous' ? 503 : 200, body: { response: { result: fault !== 'rejected' } } };
  },
  async readBack() {
   calls.push('readback'); x.ports.now = () => '2026-10-27T12:00:02Z';
   const observation = privateApplyReport(x).apiTariffReadBack.observation;
   if (fault === 'mismatch') observation.representations.legacy.sell_tariff.name = 'Changed';
   return observation;
  },
 };
 return { ...h, ...composed, adapter, file, marker, markerBytes, events: calls };
}
test('integrated closed preparation admission intent attempt readback and classification share one durable operation', async t => {
 const h = await integratedApplyFixture(t), original = key(h.x.initial.review.before);
 const result = await h.continuation.runSimulatedApply(h.adapter);
 assert.equal(result.outcome, 'accepted-exact-readback'); assert.equal(result.productionConfirmation, false);
 assert.deepEqual(h.events, ['post', 'readback']);
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.slice(1).map(r => r.phase), ['apply-intent', 'attempt-consumed', 'apply-classification']);
 assert.equal(journals.validReconciledApplyRecords(h.x.initial, hash(h.markerBytes), rows.slice(1), 'integrated-simulation'), true);
 assert.equal(rows[3].attemptRecordId, rows[2].recordId); assert.equal(rows[2].attemptId, result.attemptId);
 assert.equal(rows[3].executionProvenance, 'simulated-injected-transport'); assert.equal(rows[3].runtimeConfirmationVerified, false);
 assert.equal(key(h.x.initial.review.before), original); assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 assert.equal(await io.readFile(h.x.root, 'utf8'), h.x.priorBytes); assert.equal(h.calls.posts + h.calls.gets, 0);
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
 await assert.rejects(h.restartAttempt(h.adapter));
 const issuer = load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
 assert.equal(issuer.issueConfirmedSmartReceipt(result, h.x.initial, rows[3].classified).code, 'JOURNAL_COMPLETION_NOT_BOUND');
});
test('integrated apply cannot replay or concurrently use copied continuation authority', async t => {
 const h = await integratedApplyFixture(t);
 await assert.rejects(({ ...h.continuation }).runSimulatedApply(h.adapter), /CONTINUATION_NOT_LIVE/);
 const outcomes = await Promise.allSettled([h.continuation.runSimulatedApply(h.adapter), h.continuation.runSimulatedApply(h.adapter)]);
 assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(h.events, ['post', 'readback']);
 await assert.rejects(h.continuation.runSimulatedApply(h.adapter), /CONTINUATION_NOT_LIVE/);
 await assert.rejects(h.restartAttempt(h.adapter));
});
test('integrated apply classifies ambiguous rejected and mismatched outcomes without confirmation or retry', async t => {
 for (const [fault, classification] of [['timeout', 'write-outcome-unknown'], ['ambiguous', 'write-outcome-unknown'],
  ['rejected', 'request-rejected'], ['mismatch', 'read-back-unavailable-or-insufficient']]) {
  const h = await integratedApplyFixture(t, fault), result = await h.continuation.runSimulatedApply(h.adapter);
  assert.equal(result.classification, classification); assert.equal(result.productionConfirmation, false);
  const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[3].classified.classification, classification);
  await assert.rejects(h.restartAttempt(h.adapter));
  assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
  assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 }
});
test('integrated attempt consumption survives empty markers interrupted attempt append and uncertain result durability', async t => {
 for (const fault of ['integrated-marker-crash', 'integrated-attempt-crash', 'integrated-result-crash']) {
  const h = await integratedApplyFixture(t, fault);
  await assert.rejects(h.continuation.runSimulatedApply(h.adapter));
  assert.equal(h.events.filter(e => e === 'post').length, fault === 'integrated-result-crash' ? 1 : 0);
  await io.access(h.file + '.execution');
  // A fresh VM has empty private Sets. The durable consumption evidence alone
  // still prevents a second invocation; it never hydrates authority.
  const restarted = await Promise.allSettled([h.restartAttempt(h.adapter)]);
  if (restarted[0].status === 'fulfilled') await assert.rejects(restarted[0].value.run(), /EEXIST|ATTEMPT_/);
  else assert.match(String(restarted[0].reason), /ATTEMPT_INTENT_INVALID/);
  assert.equal(h.events.filter(e => e === 'post').length, fault === 'integrated-result-crash' ? 1 : 0);
  assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
  assert.equal((await journals.repeatAttemptEligibility(h.x.config.directory, '12345', { status: 'missing' })).code, 'ATTEMPT_IN_PROGRESS');
  assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 }
});
test('integrated apply rejects wrong site payload and baseline substitution before transport and rehashed attempt substitution', async t => {
 for (const fault of ['site', 'payload', 'baseline']) {
  const h = await integratedApplyFixture(t);
  if (fault === 'site') h.x.f.capture.before.source.energySiteId = '54321';
  if (fault === 'baseline') h.x.f.capture.before.representations.legacy.sell_tariff.name = 'Altered';
  if (fault === 'payload') { const initial = structuredClone(h.x.initial); initial.review.payloadJson = '{}'; await io.writeFile(h.file, JSON.stringify(initial) + '\n'); }
  await assert.rejects(h.continuation.runSimulatedApply(h.adapter)); assert.deepEqual(h.events, []);
  await assert.rejects(io.access(h.file + '.execution'), { code: 'ENOENT' });
 }
 const h = await integratedApplyFixture(t); await h.continuation.runSimulatedApply(h.adapter);
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse).slice(1);
 for (const change of [r => { r[1].binding.site = '54321'; }, r => { r[1].binding.payloadKey = hash('{}'); },
  r => { r[1].binding.experimentId = 'different'; }, r => { r[2].attemptRecordId = hash('different'); },
  r => { r[1].provenance = 'authenticated'; }]) {
  const altered = structuredClone(rows); change(altered);
  for (const r of altered) { const { recordId: _id, ...body } = r; void _id; r.recordId = hash(body); }
  assert.equal(journals.validReconciledApplyRecords(h.x.initial, hash(h.markerBytes), altered, 'integrated-simulation'), false);
 }
});

test('integrated durable attempt marker excludes concurrent independent runtimes without shared process guards', async t => {
 const h = await attemptProducerFixture(t), independent = await h.restartAttempt(h.adapter);
 const attempts = await Promise.allSettled([h.producer.run(), independent.run()]);
 assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
 assert.deepEqual(h.calls, ['post', 'readback']);
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length, 3); assert.equal(rows[2].phase, 'attempt-consumed');
 assert.equal(key(JSON.parse(await io.readFile(h.file + '.execution', 'utf8'))), key(rows[2]));
 await assert.rejects(h.restartAttempt(h.adapter));
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
});

test('integrated apply revalidates freshness after the final asynchronous consumption check', async t => {
 const h = await integratedApplyFixture(t, 'integrated-dispatch-expired');
 await assert.rejects(h.continuation.runSimulatedApply(h.adapter), /ATTEMPT_EVIDENCE_EXPIRED/);
 assert.deepEqual(h.events, []); await io.access(h.file + '.execution');
 await assert.rejects(h.restartAttempt(h.adapter));
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
});

async function integratedRestoreFixture(t, fault = 'valid', applyFault) {
 let h;
 const approve = async view => {
  h.restoreApprovals.push(structuredClone(view)); h.x.ports.now = () => '2026-10-27T12:00:04Z';
  const approval = { fingerprint: view.fingerprint, baselineKey: view.baselineKey, payloadKey: view.payloadKey,
   approvedAt: '2026-10-27T12:00:04Z', acknowledgedBlockers: view.blockers, manualRecoveryAcknowledged: true };
  if (fault === 'forged-approval') approval.fingerprint = hash('other experiment');
  if (fault === 'stale-approval') approval.approvedAt = '2026-10-27T11:58:00Z';
  if (fault === 'replayed-approval') return h.x.initial.exception.approval;
  if (fault === 'approval-intervention') {
   h.x.f.capture.before.tariff.name = 'External change'; h.x.f.capture.before.representations.v2.name = 'External change';
   h.x.f.capture.before.representations.legacy.name = 'External change';
  }
  return approval;
 };
 h = await integratedApplyFixture(t, applyFault ?? fault, fault === 'missing-approval' ? undefined : approve);
 h.restoreApprovals = [];
 const applied = await h.continuation.runSimulatedApply(h.adapter);
 if (applied.observation) h.x.f.capture.before = structuredClone(applied.observation);
 h.x.f.capture.before.source.observedAt = '2026-10-27T12:00:03Z';
 h.x.ports.now = () => '2026-10-27T12:00:03Z';
 if (fault === 'external-change') {
  h.x.f.capture.before.tariff.name = 'Flatpeak changed'; h.x.f.capture.before.representations.v2.name = 'Flatpeak changed';
  h.x.f.capture.before.representations.legacy.name = 'Flatpeak changed';
 }
 if (fault === 'ownership-change') h.x.ports.readOwnership = async () => ({ status: 'unavailable' });
 const events = [], original = structuredClone(h.x.initial.review.before);
 const adapter = {
  async post(site, payload) {
   events.push('restore-post'); assert.equal(site, '12345');
   assert.equal(payload, key({ tou_settings: { tariff_content_v2: original.tariff } }));
   const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(rows.length, 6); assert.equal(rows[4].phase, 'restore-intent'); assert.equal(rows[5].phase, 'restore-attempt-consumed');
   assert.equal(key(JSON.parse(await io.readFile(h.file + '.restore.execution', 'utf8'))), key(rows[5]));
   if (fault === 'restore-timeout') throw Error('SIMULATED_RESTORE_TIMEOUT');
   return { httpStatus: fault === 'restore-rejected' ? 400 : fault === 'restore-ambiguous' ? 503 : 200,
    body: { response: { result: fault !== 'restore-rejected' } } };
  },
  async readBack() {
   events.push('restore-readback'); h.x.ports.now = () => '2026-10-27T12:00:06Z';
   if (fault === 'missing-readback') throw Error('SIMULATED_READ_FAILURE');
   const v = structuredClone(original.representations.v2), l = structuredClone(original.representations.legacy);
   if (fault === 'wrong-v2') v.name = 'Wrong import metadata';
   if (fault === 'wrong-legacy') l.name = 'Wrong legacy';
   if (fault === 'wrong-export') { v.sell_tariff.name = 'Wrong export'; l.sell_tariff.name = 'Wrong export'; }
   return captureObservedTariff({ installation_time_zone: 'Europe/London', tariff_content_v2: v, tariff_content: l }, '12345', '2026-10-27T12:00:05Z');
  },
 };
 return { ...h, original, restoreEvents: events, restoreAdapter: adapter };
}
test('integrated restore uses separate approval and the exact immutable dual original with no terminal authority', async t => {
 const h = await integratedRestoreFixture(t), result = await h.continuation.runSimulatedRestore(h.restoreAdapter);
 assert.equal(result.outcome, 'accepted-exact-readback'); assert.equal(result.productionConfirmation, false);
 assert.deepEqual(h.restoreEvents, ['restore-post', 'restore-readback']); assert.equal(h.restoreApprovals.length, 1);
 assert.equal(key(result.observation.representations), key(h.original.representations));
 const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
 assert.deepEqual(rows.slice(4).map(r => r.phase), ['restore-intent', 'restore-attempt-consumed', 'restore-classification']);
 assert.notEqual(rows[2].attemptId, rows[5].attemptId);
 assert.equal(journals.validReconciledLifecycleRecords(h.x.initial, hash(h.markerBytes), rows.slice(1), 'integrated-simulation'), true);
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes); assert.equal(await io.readFile(h.x.root, 'utf8'), h.x.priorBytes);
 assert.equal(h.calls.posts + h.calls.gets, 0);
 await assert.rejects(h.continuation.runSimulatedRestore(h.restoreAdapter), /RESTORE_NOT_LIVE/);
 assert.equal((await journals.readOfflineReconciledExperiment(h.x.config)).status, 'blocked');
});
test('integrated restore rejects missing stale forged replayed approvals and external tariff changes', async t => {
 for (const fault of ['missing-approval', 'stale-approval', 'forged-approval', 'replayed-approval', 'external-change', 'approval-intervention', 'ownership-change']) {
  const h = await integratedRestoreFixture(t, fault);
  await assert.rejects(h.continuation.runSimulatedRestore(h.restoreAdapter), undefined, fault);
  assert.deepEqual(h.restoreEvents, []); await assert.rejects(io.access(h.file + '.restore.execution'), { code: 'ENOENT' });
  await assert.rejects(h.continuation.runSimulatedRestore(h.restoreAdapter), /RESTORE_NOT_LIVE/);
 }
});
test('integrated restore is unavailable after ambiguous rejected or mismatched apply and excludes concurrent restoration', async t => {
 for (const fault of ['timeout', 'rejected', 'mismatch']) {
  const h = await integratedRestoreFixture(t, 'valid', fault);
  await assert.rejects(h.continuation.runSimulatedRestore(h.restoreAdapter), /RESTORE_NOT_LIVE/);
  assert.equal(h.restoreApprovals.length, 0); assert.deepEqual(h.restoreEvents, []);
 }
 const h = await integratedRestoreFixture(t);
 const outcomes = await Promise.allSettled([h.continuation.runSimulatedRestore(h.restoreAdapter), h.continuation.runSimulatedRestore(h.restoreAdapter)]);
 assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.deepEqual(h.restoreEvents, ['restore-post', 'restore-readback']);
});
test('integrated restore records wrong original metadata legacy export and uncertain responses without production confirmation', async t => {
 for (const fault of ['wrong-v2', 'wrong-legacy', 'wrong-export', 'restore-timeout', 'restore-rejected', 'restore-ambiguous', 'missing-readback']) {
  const h = await integratedRestoreFixture(t, fault), result = await h.continuation.runSimulatedRestore(h.restoreAdapter);
  assert.notEqual(result.outcome, 'accepted-exact-readback', fault); assert.equal(result.productionConfirmation, false);
  const rows = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).phase, 'restore-classification'); assert.equal(rows.at(-1).runtimeConfirmationVerified, false);
  await assert.rejects(h.restartAttempt(h.restoreAdapter, 'restore'));
 }
});
test('integrated restore preserves blocking through interrupted intent consumption and classification across fresh runtimes', async t => {
 for (const fault of ['restore-intent-crash', 'restore-marker-crash', 'restore-attempt-crash', 'restore-result-crash']) {
  const h = await integratedRestoreFixture(t, fault);
  await assert.rejects(h.continuation.runSimulatedRestore(h.restoreAdapter));
  const posts = fault === 'restore-result-crash' ? 1 : 0; assert.equal(h.restoreEvents.filter(x => x === 'restore-post').length, posts);
  await assert.rejects(h.restartCompose(), /ATTEMPT_IN_PROGRESS|INDEPENDENT_EVIDENCE_INVALID/);
  assert.equal((await journals.repeatAttemptEligibility(h.x.config.directory, '12345', { status: 'missing' })).code, 'ATTEMPT_IN_PROGRESS');
  if (fault !== 'restore-intent-crash') {
   const fresh = await Promise.allSettled([h.restartAttempt(h.restoreAdapter, 'restore')]);
   if (fresh[0].status === 'fulfilled') await assert.rejects(fresh[0].value.run(), /EEXIST|ATTEMPT_/);
   else assert.match(String(fresh[0].reason), /ATTEMPT_INTENT_INVALID/);
  }
  assert.equal(h.restoreEvents.filter(x => x === 'restore-post').length, posts);
  assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
 }
});
test('integrated restore rejects rehashed forged original ownership approval and readback evidence', async t => {
 const h = await integratedRestoreFixture(t); await h.continuation.runSimulatedRestore(h.restoreAdapter);
 const records = (await io.readFile(h.file, 'utf8')).trim().split('\n').map(JSON.parse).slice(1);
 for (const mutate of [r => { r[3].binding.originalObservationKey = hash('other'); }, r => { r[3].binding.ownershipKey = hash('other'); },
  r => { r[3].approval.fingerprint = hash('other'); }, r => { r[4].binding.payloadKey = hash('{}'); },
  r => { r[5].observation.representations.legacy.sell_tariff.name = 'forged'; }, r => { r[5].runtimeConfirmationVerified = true; }]) {
  const changed = structuredClone(records); mutate(changed);
  const approvalTampered = changed[3].approval.fingerprint !== records[3].approval.fingerprint;
  if (!approvalTampered) changed[3].approval.fingerprint = hash(changed[3].binding);
  const rehash = r => { const { recordId: _id, ...body } = r; void _id; r.recordId = hash(body); };
  rehash(changed[3]);
  changed[4].binding.intentRecordId = changed[3].recordId;
  changed[4].binding.originalObservationKey = changed[3].binding.originalObservationKey;
  changed[4].binding.ownershipKey = changed[3].binding.ownershipKey;
  rehash(changed[4]); changed[5].intentRecordId = changed[3].recordId; changed[5].attemptRecordId = changed[4].recordId; rehash(changed[5]);
  assert.equal(journals.validReconciledLifecycleRecords(h.x.initial, hash(h.markerBytes), changed, 'integrated-simulation'), false);
 }
});
test('integrated restore remains blocking in a separate process with no surviving private runtime guards', async t => {
 const h = await integratedRestoreFixture(t); await h.continuation.runSimulatedRestore(h.restoreAdapter);
 const script = `import fs from 'node:fs'; import * as io from 'node:fs/promises'; import path from 'node:path';
 import vm from 'node:vm'; import ts from 'typescript'; import * as crypto from 'node:crypto';
 const modules=new Map();const load=${load.toString()};
 const journals=load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
 const state=await journals.readOfflineReconciledExperiment(JSON.parse(process.argv[1]));
 if(state.status!=='blocked'||state.grantsAdmissionAuthority!==false)process.exit(2);
 try{await io.open(process.argv[2],'wx');process.exit(3);}catch(e){if(e.code!=='EEXIST')throw e;}
 console.log('BLOCKED_NO_AUTHORITY');`;
 const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(h.x.config), h.file + '.restore.execution'], { encoding: 'utf8' });
 assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'BLOCKED_NO_AUTHORITY');
 assert.equal(await io.readFile(h.marker, 'utf8'), h.markerBytes);
});
