import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
 {exports,structuredClone,Date,Intl,Error,require(name){
  if(name==='node:crypto')return crypto;
  if(name==='node:fs/promises')return io;
  if(name==='node:path')return path;
  assert.ok(name.startsWith('.'),`No network/runtime dependency: ${name}`);
  assert.doesNotMatch(name,/supervised-local|\/client|ownership-sqlite|receipt-issuer/);
  return load(path.resolve(path.dirname(file),name+'.ts'));
 }});return exports;}
const api=load('src/lib/tesla-tariff/smart-lifecycle-rehearsal.ts');
const journalAPI=load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
const {ownershipFingerprint:key}=load('src/lib/tesla-tariff/ownership-transition.ts');
const siteTemplate=load('src/lib/site/current-site.ts').currentSite;
const time='2026-10-21T19:54:12.000Z';
const price=amount=>({amount,currency:'GBP',unit:'kWh'});
function side(sell=false){return {version:1,name:sell?'Synthetic export':'Synthetic import',utility:'E.ON',currency:'GBP',code:sell?'EXPORT':'IMPORT',
 demand_charges:{ALL:{rates:{ALL:0}}},seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{
 cheap:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,fromMinute:0,toHour:6,toMinute:0}]},
 peak:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,fromMinute:0,toHour:0,toMinute:0}]}}}},
 energy_charges:{Annual:{rates:{cheap:sell?.175:.0285,peak:sell?.175:.23978}}}};}
function fixture(){
 const site=structuredClone(siteTemplate);site.integrations.tesla.energySiteId='123';
 site.integrations.kraken.importTariffIdentity={tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'synthetic-meter'};
 delete site.integrations.kraken.exportTariffIdentity;
 const baseline={source:{kind:'tesla-site-info',energySiteId:'123',observedAt:time,timeZone:'Europe/London'},
 tariff:{...side(),sell_tariff:side(true)},diagnostics:[],rollbackProven:false};
 const kraken={stale:false,lastSuccessfulUpdate:time,vehicles:[{id:'q7',name:'Synthetic Q7',plannedDispatches:[
 {start:'2026-10-21T20:30:00Z',end:'2026-10-22T03:00:00Z',type:'SMART',energyAddedKwh:'1'}]}],
 importTariff:{status:'available',accountRef:'synthetic-household',observedAt:time,exportStatus:'unknown',
 agreement:{validFrom:'2026-01-01T00:00:00Z',validTo:'2027-01-01T00:00:00Z',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'synthetic-meter'},
 version:{id:'v5.2',name:'Synthetic Drive Smart',provider:'eon-next-kraken',effectiveFrom:'2026-10-20T23:00:00Z',effectiveTo:'2026-10-22T23:00:00Z',pricesIncludeVat:true,
 normalImport:price(.23978),export:null,scheduledChargingImport:price(.0285),standingCharge:null,
 dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(.0285)}]}}};
 return {mode:'offline-rehearsal',attemptId:'synthetic-attempt',ownership:{status:'missing'},evidence:{restorationBaseline:baseline,
 current:{site,energySiteId:'123',kraken,observation:structuredClone(baseline),now:time,comparisonDomain:{start:'2026-10-21T19:55:00Z',end:'2026-10-22T23:00:00Z'}}}};
}
const approve=(review,at)=>({fingerprint:review.fingerprint,baselineKey:key(review.before.tariff),payloadKey:key(review.payloadJson),
 approvedAt:at,acknowledgedBlockers:[...review.productionBlockers],manualRecoveryAcknowledged:true});
async function harness(t,options={}){
 const root=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'hep-offline-lifecycle-')));t.after(()=>io.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'journals');let journal=journalAPI.smartLifecycleRehearsalJournal(directory,'123',root);
 const input=fixture();let clock=Date.parse(time),tariff=structuredClone(input.evidence.restorationBaseline.tariff),review;
 const counts={captures:0,posts:0,claims:0,approvals:0,readbacks:0};
 const ports={now:()=>new Date(clock).toISOString(),
 async capture(){counts.captures++;const value=structuredClone(input);value.evidence.current.observation.tariff=structuredClone(tariff);
  value.evidence.current.observation.source.observedAt=ports.now();value.evidence.current.kraken.lastSuccessfulUpdate=ports.now();
  value.evidence.current.kraken.importTariff.observedAt=ports.now();value.evidence.current.now=ports.now();
  options.capture?.(value,counts);return {evidence:value.evidence,ownership:value.ownership};},
 async confirm(r){review=r;counts.approvals++;clock+=1000;const a=approve(r,ports.now());options.approval?.(a,r);return a;},
 async simulatePost(site,body){assert.equal(site,'123');counts.posts++;assert.equal(body,review.payloadJson);clock+=1000;
  const parsed=JSON.parse(body).tou_settings.tariff_content_v2;assert.deepEqual(parsed.sell_tariff,input.evidence.restorationBaseline.tariff.sell_tariff);
  tariff=parsed;if(options.throwPost?.(counts.posts))throw Error('synthetic-private-marker');
  return options.write?.(counts.posts)??{status:'accepted',httpStatus:200};},
 async readBack(){counts.readbacks++;clock+=1000;const b=structuredClone(input.evidence.restorationBaseline);b.source.observedAt=ports.now();b.tariff=structuredClone(tariff);options.readback?.(b,counts.posts);return b;},
 claim:async(r,a)=>{counts.claims++;return journal.claim(r,a)},claimRestore:async(r,a)=>{counts.claims++;return journal.claimRestore(r,a)}};
 return {ports,counts,input,root,directory,apply:()=>api.rehearseSmartApply(input.attemptId,ports),
  read:()=>journal.read(),restore:async()=>api.rehearseSmartRestore((await journal.read()).records,ports),
  restart:()=>{journal=journalAPI.smartLifecycleRehearsalJournal(directory,'123',root)},
 change:fn=>fn(tariff),setDispatches:value=>{input.evidence.current.kraken.vehicles[0].plannedDispatches=structuredClone(value)},
  setTime:value=>{clock=Date.parse(value)},advance:ms=>{clock+=ms}};
}

test('durable offline apply and separately approved exact restore survive restart without authority',async t=>{
 const h=await harness(t);const apply=await h.apply();assert.equal(apply.status,'simulated-confirmed');assert.equal(apply.policy.status,'blocked');
 assert.equal(apply.restorationObligation,true);assert.equal(apply.executionReady,false);
 let saved=await h.read();assert.equal(saved.status,'restoration-review-required');
 assert.ok(saved.records.review.productionBlockers.includes('BUY_BELOW_SELL'));
 assert.ok(saved.records.review.productionBlockers.includes('AUTHENTICATED_EXPORT_MPAN_REQUIRED'));
 assert.deepEqual(structuredClone(saved.records.review.baseline.tariff),h.input.evidence.restorationBaseline.tariff);
 h.restart();assert.equal((await h.read()).status,'restoration-review-required');
 h.setDispatches([]);
 const restore=await h.restore();assert.equal(restore.status,'simulated-confirmed');assert.equal(restore.restorationObligation,false);
 saved=await h.read();assert.equal(saved.status,'simulated-restored');
 assert.deepEqual(structuredClone(saved.records.restore.readBack.tariff),h.input.evidence.restorationBaseline.tariff);
 assert.equal(h.counts.posts,2);assert.equal(h.counts.approvals,2);assert.equal(h.counts.claims,2);
 await assert.rejects(h.restore(),/RESTORATION_NOT_AVAILABLE/);assert.equal(h.counts.posts,2);
 const eligibility=await journalAPI.repeatAttemptEligibility(h.directory,'123',{status:'missing'});
 assert.equal(eligibility.code,'ATTEMPT_IN_PROGRESS'); // No automatic lifecycle unlock.
});

test('schedule change and approval substitution fail before claim or simulated POST',async t=>{
 for(const options of [
  {capture(value,c){if(c.captures===2)value.evidence.current.kraken.vehicles[0].plannedDispatches[0].start='2026-10-21T21:30:00Z'}},
  {approval(a){a.payloadKey='f'.repeat(64)}},
  {capture(value){value.evidence.current.kraken.stale=true}},
 ]){const h=await harness(t,options);await assert.rejects(h.apply());assert.equal(h.counts.posts,0);assert.equal(h.counts.claims,0)}
});

test('unknown apply remains blocked even when readback matches; no retries after restart',async t=>{
 const h=await harness(t,{throwPost:()=>true});const r=await h.apply();assert.equal(r.result.classification,'write-outcome-unknown');
 assert.equal(r.status,'manual-intervention-required');assert.equal(h.counts.posts,1);h.restart();
 assert.equal((await h.read()).status,'manual-intervention-required');await assert.rejects(h.restore());
 await assert.rejects(h.apply());assert.equal(h.counts.posts,1);
});

test('external Tesla changes block restoration before durable claim and POST',async t=>{
 const h=await harness(t);await h.apply();h.setDispatches([]);h.change(tariff=>{tariff.sell_tariff.name='External edit'});
 await assert.rejects(h.restore(),/CURRENT_TARIFF_OWNERSHIP_CONFLICT/);assert.equal(h.counts.posts,1);assert.equal(h.counts.claims,1);
 assert.equal((await h.read()).status,'restoration-review-required');
});

test('failed restoration preserves obligation and permanently blocks another attempt',async t=>{
 const h=await harness(t,{write:n=>n===2?{status:'rejected',httpStatus:400}:undefined});await h.apply();h.setDispatches([]);
 const r=await h.restore();assert.equal(r.result.classification,'request-rejected');assert.equal(r.restorationObligation,true);
 h.restart();assert.equal((await h.read()).status,'manual-intervention-required');await assert.rejects(h.restore());assert.equal(h.counts.posts,2);
});

test('active, re-optimised, changed-after-approval and stale schedules cannot trigger blind restoration',async t=>{
 const active=await harness(t);await active.apply();await assert.rejects(active.restore(),/RESTORATION_NOT_REQUIRED/);
 assert.equal(active.counts.posts,1);assert.equal(active.counts.claims,1);

 const revised=await harness(t);await revised.apply();revised.setDispatches([{start:'2026-10-21T22:00:00Z',end:'2026-10-22T04:30:00Z',type:'SMART',energyAddedKwh:'1'}]);
 await assert.rejects(revised.restore(),/SMART_TARIFF_UPDATE_REQUIRED/);assert.equal(revised.counts.posts,1);assert.equal(revised.counts.claims,1);

 const changed=await harness(t,{capture(value,c){if(c.captures===4)value.evidence.current.kraken.vehicles[0].plannedDispatches=[{start:'2026-10-21T22:00:00Z',end:'2026-10-22T04:30:00Z',type:'SMART',energyAddedKwh:'1'}]}});
 await changed.apply();changed.setDispatches([]);await assert.rejects(changed.restore(),/SMART_TARIFF_UPDATE_REQUIRED/);
 assert.equal(changed.counts.posts,1);assert.equal(changed.counts.claims,1);

 const stale=await harness(t,{capture(value,c){if(c.captures>=3)value.evidence.current.kraken.stale=true}});
 await stale.apply();stale.setDispatches([]);await assert.rejects(stale.restore(),/RESTORATION_EVIDENCE_UNAVAILABLE/);
 assert.equal(stale.counts.posts,1);assert.equal(stale.counts.claims,1);
});

test('elapsed Q7 exception requires and verifies exact restoration without dropping retained schedule evidence',async t=>{
 const h=await harness(t);await h.apply();h.setTime('2026-10-22T06:00:00.000Z');
 const restored=await h.restore();assert.equal(restored.status,'simulated-confirmed');assert.equal(restored.restorationObligation,false);
 assert.equal(h.counts.posts,2);assert.equal(h.counts.claims,2);
 const saved=await h.read();assert.equal(saved.status,'simulated-restored');
 assert.deepEqual(structuredClone(saved.records.restore.readBack.tariff),h.input.evidence.restorationBaseline.tariff);
 assert.equal(saved.records.restoreReview.input.current.kraken.vehicles[0].plannedDispatches.length,1);
});

test('late caller domain cannot hide the upcoming Q7 exception and authorize restoration',async t=>{
 const h=await harness(t);await h.apply();
 h.input.evidence.current.comparisonDomain={start:'2026-10-22T06:00:00.000Z',end:'2026-10-22T23:00:00.000Z'};
 await assert.rejects(h.restore(),/RESTORATION_SCHEDULE_COVERAGE_INCOMPLETE/);
 assert.equal(h.counts.posts,1);assert.equal(h.counts.claims,1);assert.equal((await h.read()).status,'restoration-review-required');
});

test('exclusive claim, interrupted claim and partial journal all remain fail closed',async t=>{
 const h=await harness(t);const review=api.prepareSmartLifecycleRehearsal(h.input),approval=approve(review,time);
 const j=journalAPI.smartLifecycleRehearsalJournal(h.directory,'123',h.root);
 const outcomes=await Promise.allSettled([j.claim(review,approval),j.claim(review,approval)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);h.restart();
 assert.equal((await h.read()).status,'manual-intervention-required');await assert.rejects(j.claim(review,approval));
 await io.appendFile(path.join(h.directory,'site-123-attempt.active'),'{');
 assert.equal((await h.read()).status,'manual-intervention-required');assert.equal(h.counts.posts,0);
});
