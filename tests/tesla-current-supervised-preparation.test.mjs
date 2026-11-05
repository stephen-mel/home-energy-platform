import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';
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
   {exports,Date:FixedDate,AbortSignal,process:{cwd:()=>'/offline',env:{},stdin:{isTTY:false},stdout:{isTTY:false},stderr:{isTTY:false}},console:{log:v=>calls.output.push(v)},
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
 const calls={gets:0,posts:0,acquisitions:0,questions:0,output:[]};let uuid=0,lastReconciliation='';
 const blocked=()=>{throw Error('UNEXPECTED_EXECUTION');};
 const dependencies={
  'node:fs/promises':{...io,readFile:async(file,...args)=>file===path.join(cwd,'.tesla-tokens.json')?JSON.stringify({access_token:'offline-only'}):io.readFile(file,...args)},
  'node:path':path,'node:crypto':{...crypto,randomUUID:()=>`fixture-identity-${++uuid}`},
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
  './proposal-approval':load('src/lib/tesla-tariff/proposal-approval.ts'),'./ownership-transition':load('src/lib/tesla-tariff/ownership-transition.ts'),
  './repeat-attempt-journal':journals,'./linked-experiment-records':linked,'./prepared-mutation-context':load('src/lib/tesla-tariff/prepared-mutation-context.ts'),
  './ownership-store':{ownershipStore:()=>({read:async()=>({status:'missing'})})},
  './ownership-sqlite':{persistConfirmedSmart:blocked},'./supervised-journal':{claimExperimentJournal:blocked},'./supervised-experiment':api,
 };
 class FixedDate extends Date{constructor(...a){super(...(a.length?a:[now]));}}
 const exports={};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-local.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,Date:FixedDate,AbortSignal,process:{cwd:()=>cwd,env:{},stdin:{isTTY:fault!=='noninteractive'},stdout:{isTTY:true},stderr:{isTTY:true}},
 console:{log:value=>calls.output.push(value)},fetch:async(_url,options)=>{
  if(options.method!=='GET'){calls.posts++;throw Error('POST_FORBIDDEN');}calls.gets++;
  if(fault==='interrupted'&&calls.gets===4)throw Error('INTERRUPTED');
  const v=structuredClone(x.f.capture.before.representations.v2);
  if(fault==='substituted'&&calls.gets>=2)v.name='changed';
  return{ok:true,json:async()=>({response:{energy_site_id:'12345',installation_time_zone:'Europe/London',tariff_content_v2:v,tariff_content:legacy(v)}})};
 },require:n=>{assert.ok(n in dependencies,n);return dependencies[n];}});
 return {x,calls,config:{mode:'offline',directory,durableRoot:root,site:'12345'},historical,
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
async function mockedReconciledApply(t, fault = 'valid') {
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
  return { classification, comparison };
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
