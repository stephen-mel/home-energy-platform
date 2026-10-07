import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rehearsal, dispatch, copy, SITE, databaseRelative, journalRelative } from './helpers/smart-lifecycle-rehearsal.mjs';

const root=await io.mkdtemp(path.join(os.tmpdir(),'hep-smart-rehearsal-'));
after(()=>io.rm(root,{recursive:true,force:true}));
// Seed through the same real local lifecycle, in a separate fixture workspace.
// Its latch is retained. Only the closed database and resulting tariff are copied.
const seed=await rehearsal(path.join(root,'seed'),{at:'2026-09-23T07:20:00Z',
  dispatch:dispatch('2026-09-23T12:00:00Z','2026-09-23T13:00:00Z')});
await seed.run();
assert.equal(seed.summary.ownershipPersistence.status,'persisted');
const initialSnapshot=copy(seed.snapshot().snapshot), initialTariff=seed.tariff;
const seedJournal=await io.readFile(path.join(seed.root,journalRelative),'utf8');

async function installSeed(directory){
  await io.mkdir(path.dirname(path.join(directory,databaseRelative)),{recursive:true,mode:0o700});
  await io.copyFile(path.join(seed.root,databaseRelative),path.join(directory,databaseRelative));
  assert.equal(fs.existsSync(path.join(directory,journalRelative)),false);
}
async function setup(options={}){
  const directory=await io.mkdtemp(path.join(root,'case-'));
  await installSeed(directory);
  const h=await rehearsal(directory,{tariff:initialTariff,...options});
  assert.deepEqual(copy(h.snapshot().snapshot),initialSnapshot);
  return h;
}
async function journal(h){return (await io.readFile(path.join(h.root,journalRelative),'utf8')).trim().split('\n').map(JSON.parse);}
function assertOneAttempt(h){
  assert.equal(h.trace.runs,1);assert.equal(h.trace.posts.length,1);assert.equal(h.trace.ownershipReads,1);
  assert.equal(h.trace.events.filter(e=>e==='journal:claim').length,1);
  assert.equal(h.trace.requests.filter(r=>r.method==='POST').length,1);
  assert.equal(h.trace.requests.filter(r=>r.method==='GET').length,3);
  assert.equal(h.trace.prompts.length,3);assert.deepEqual(h.trace.violations,[]);
}
function assertConfirmed(h,status){
  assertOneAttempt(h);
  assert.equal(h.summary.classification,'submitted-representation-preserved');
  assert.deepEqual(h.summary.apiWrite,{status:'accepted',httpStatus:200});
  assert.equal(h.summary.ownershipPersistence.status,status);
  assert.equal(h.summary.ownershipPersistence.confirmation,'confirmed');
  assert.equal(h.summary.ownershipPersistence.writeReady,false);assert.equal(h.summary.ownershipPersistence.rollbackProven,false);
  assert.equal(h.summary.writeReady,false);assert.equal(h.summary.rollbackProven,false);
  assert.equal(h.trace.persistenceCalls,1);
}

test('golden unchanged local lifecycle: real prompts, capture, B1/B2, receipt, finalisation and anchored SQLite append',async()=>{
  const h=await setup();await h.run();assertConfirmed(h,'persisted');
  const [initial,classified]=await journal(h);assert.equal((await journal(h)).length,2);
  const result=h.trace.results[0],context=h.trace.contexts[0];
  assert.strictEqual(result.initialRecord,h.trace.initial[0]);assert.strictEqual(result.record,h.trace.classified[0]);
  assert.strictEqual(result.journalCompletion,h.trace.capabilities[0]);assert.ok(h.completion());
  assert.equal(h.trace.capabilities.length,1);assert.equal(h.trace.issuances.length,1);assert.equal(h.trace.finalisations.length,1);
  const issued=h.trace.issuances[0],finalised=h.trace.finalisations[0];
  assert.equal(issued.status,'issued');assert.equal(finalised.status,'derived');
  assert.equal(h.trace.posts[0],h.trace.approvals[0].payloadJson);assert.equal(h.trace.posts[0],initial.review.payloadJson);
  assert.deepEqual(copy(context.ownership.snapshot),initialSnapshot);
  assert.equal(issued.receipt.original.prior.generation,initialSnapshot.generation);
  assert.equal(finalised.expectedGeneration,initialSnapshot.generation);
  assert.equal(classified.initialRecordId,initial.initialRecordId);
  assert.equal(classified.apiTariffReadBack.observation.source.kind,'tesla-site-info');
  assert.equal(classified.apiTariffReadBack.comparison.outcome,'exact-observed-match');
  assert.ok(Date.parse(classified.attemptedAt)<Date.parse(classified.apiTariffReadBack.observation.source.observedAt));
  assert.ok(Date.parse(classified.apiTariffReadBack.observation.source.observedAt)<=Date.parse(classified.completedAt));
  const events=h.trace.events;
  for(const [before,afterEvent] of [['preflight:complete','initial:open'],['initial:sync','tesla:post'],['directory:sync','tesla:post'],
    ['initial:close','tesla:post'],['tesla:post','tesla:readback'],['classified:sync','classified:close'],
    ['classified:close','b2:complete'],['b2:complete','persistence:enter']]){
    assert.ok(events.includes(before)&&events.includes(afterEvent));
    assert.ok(events.indexOf(before)<events.indexOf(afterEvent),`${before} before ${afterEvent}`);
  }
  assert.equal(events.filter(e=>e==='kraken:devices').length,2);assert.equal(events.filter(e=>e==='kraken:dispatches').length,2);
  const opportunities=issued.receipt.original.proposal.input.signal.import.flatMap(w=>w.eligibilityPeriods)
    .filter(p=>p.sources.some(s=>s.provider==='kraken'));
  assert.ok(opportunities.length);assert.ok(opportunities.every(p=>p.state==='planned-conditional'));
  const current=copy(h.snapshot().snapshot);
  assert.notEqual(current.generation,initialSnapshot.generation);assert.notEqual(current.historyDigest,initialSnapshot.historyDigest);
  assert.deepEqual(current.evidence,copy(finalised.evidence));
  assert.deepEqual(current.evidence.intervals.filter(p=>p.start==='2026-09-23T12:00:00.000Z'),initialSnapshot.evidence.intervals);
  const added=current.evidence.intervals.filter(p=>p.start!=='2026-09-23T12:00:00.000Z');assert.equal(added.length,1);
  assert.equal(added[0].start,'2026-09-23T08:00:00.000Z');assert.equal(added[0].end,'2026-09-23T10:00:00.000Z');
  assert.deepEqual(added[0].applied,{amount:0.0299,currency:'GBP',unit:'kWh'});
  assert.deepEqual(added[0].restore,{amount:0.25177,currency:'GBP',unit:'kWh'});
  assert.equal(added[0].restoreBaselineFingerprint,finalised.evidence.baselineFingerprint);
  assert.equal(current.evidence.validUntil,initialSnapshot.evidence.validUntil);
  assert.ok(current.evidence.intervals.every(p=>p.start.startsWith('2026-09-23')&&p.end.startsWith('2026-09-23')));
  assert.equal(current.evidence.export,undefined);assert.deepEqual(h.tariff.sell_tariff,initialTariff.sell_tariff);
  for(const charges of Object.values(h.tariff.energy_charges)){
    assert.equal(charges.rates.hour_0_minute_0,0.02993);assert.equal(charges.rates.hour_6_minute_0,0.25177);
  }
  const db=new DatabaseSync(path.join(h.root,databaseRelative),{readOnly:true});
  try{
    const rows=db.prepare('SELECT record FROM applied WHERE site=?').all(SITE).map(r=>JSON.parse(r.record));
    assert.equal(rows.length,2);const application=rows.find(r=>r.mutationId===initial.mutationId);
    assert.equal(application.issuanceKey,issued.issuanceKey);assert.equal(application.receiptKey,issued.receiptKey);
    assert.equal(application.prior.generation,initialSnapshot.generation);assert.equal(application.priorHistoryDigest,initialSnapshot.historyDigest);
    assert.equal(application.result.generation,current.generation);
  }finally{db.close();}
  assert.ok(finalised.productionBlockers.includes('ROLLBACK_UNPROVEN'));
  assert.ok(finalised.productionBlockers.includes('BUY_BELOW_SELL'));
  assert.equal(await io.readFile(path.join(seed.root,journalRelative),'utf8'),seedJournal);
  assert.equal(h.summary.initialRecord,undefined);assert.equal(h.summary.journalCompletion,undefined);
});

for(const [outcome,classification] of [['rejected','request-rejected'],['unknown','write-outcome-unknown'],
  ['insufficient','read-back-unavailable-or-insufficient'],['transformed','accepted-but-transformed-differently']])
  test(`${outcome}: real response interpretation/readback cannot create ownership or repeat execution`,async()=>{
    const h=await setup({outcome});await h.run();assertOneAttempt(h);
    assert.equal(h.summary.classification,classification);assert.equal(h.summary.ownershipPersistence.status,'not-attempted');
    assert.equal(h.trace.persistenceCalls,0);assert.equal(h.trace.issuances.length,0);assert.equal(h.trace.finalisations.length,0);
    assert.equal(h.trace.capabilities.length,1);assert.ok(h.completion());
    assert.deepEqual(copy(h.snapshot().snapshot),initialSnapshot);assert.equal((await journal(h)).length,2);
    if(outcome==='unknown'){
      assert.equal(h.trace.classified[0].apiTariffReadBack.comparison.outcome,'exact-observed-match');
      assert.deepEqual(h.summary.apiWrite,{status:'unknown',httpStatus:200});
    }
  });

test('classified close failure after POST leaves consumed durable journal but no B2 or persistence',async()=>{
  const h=await setup({journalCloseFailure:true});await assert.rejects(h.run(),/INJECTED_CLASSIFIED_CLOSE/);assertOneAttempt(h);
  assert.equal(h.trace.capabilities.length,0);assert.equal(h.trace.persistenceCalls,0);assert.equal(h.trace.results.length,0);
  assert.equal(h.trace.issuances.length,0);assert.equal(h.trace.finalisations.length,0);
  assert.equal((await journal(h)).length,2);assert.equal(h.summary,null);
  assert.deepEqual(copy(h.snapshot().snapshot),initialSnapshot);
  assert.deepEqual(h.tariff,JSON.parse(h.trace.posts[0]).tou_settings.tariff_content_v2);
});

test('genuine competing append makes captured generation/history stale, without rebase',async()=>{
  let rival,advanced;
  const h=await setup({beforePersistence(){
    const committed=rival.replay(h.root);assert.equal(committed.status,'persisted');advanced=copy(committed.snapshot);
  }});
  // The competitor has genuine B2 evidence from the same seed. Replaying that
  // evidence into this isolated case's target creates a real competing CAS append.
  await installSeed(path.join(h.root,'competitor'));
  rival=await rehearsal(h.root,{subdirectory:'competitor',tariff:initialTariff,at:'2026-09-23T07:29:00Z',
    dispatch:dispatch('2026-09-23T14:00:00Z','2026-09-23T15:00:00Z')});
  await rival.run();assertConfirmed(rival,'persisted');
  await h.run();assertConfirmed(h,'conflict');
  assert.equal(h.summary.ownershipPersistence.code,'OWNERSHIP_GENERATION_CHANGED');
  assert.deepEqual(copy(h.trace.contexts[0].ownership.snapshot),initialSnapshot);
  assert.deepEqual(copy(h.snapshot().snapshot),advanced);assert.notEqual(advanced.generation,initialSnapshot.generation);
  assert.notEqual(advanced.historyDigest,initialSnapshot.historyDigest);
});

for(const timing of ['before','after'])test(`unexpected ${timing}-commit exception stays indeterminate, never feeds back to execution`,async()=>{
  const h=await setup({persistenceThrow:timing});await h.run();assertConfirmed(h,'indeterminate');
  assert.equal(h.summary.ownershipPersistence.code,'OWNERSHIP_ORCHESTRATION_EXCEPTION');
  assert.doesNotMatch(JSON.stringify(h.summary),/INJECTED|SECRET|stack|already-persisted|"persisted"/);
  if(timing==='before'){assert.equal(h.trace.persistence.length,0);assert.deepEqual(copy(h.snapshot().snapshot),initialSnapshot);}
  else{assert.equal(h.trace.persistence[0].status,'persisted');assert.notEqual(h.snapshot().snapshot.generation,initialSnapshot.generation);}
});

test('explicit evidence-only replay is idempotent and never re-enters local execution',async()=>{
  const h=await setup();await h.run();const current=copy(h.snapshot().snapshot);
  const journalBefore=await io.readFile(path.join(h.root,journalRelative),'utf8');
  const replay=h.replay();assert.equal(replay.status,'already-persisted');assert.deepEqual(copy(replay.snapshot),current);
  assertConfirmed(h,'persisted');assert.equal(h.trace.capabilities.length,1);
  assert.deepEqual(copy(h.snapshot().snapshot),current);assert.equal(await io.readFile(path.join(h.root,journalRelative),'utf8'),journalBefore);
});

test('a fresh second proposal still cannot execute against the consumed site latch',async()=>{
  const h=await setup();await h.run();const current=copy(h.snapshot().snapshot);
  const journalBefore=await io.readFile(path.join(h.root,journalRelative),'utf8');
  h.setDispatch(dispatch('2026-09-23T14:00:00Z','2026-09-23T15:00:00Z'));
  await assert.rejects(h.run(),error=>error.code==='EEXIST');
  assert.equal(h.trace.runs,2);assert.equal(h.trace.posts.length,1);assert.equal(h.trace.persistenceCalls,1);
  assert.equal(h.trace.requests.filter(r=>r.method==='POST').length,1);
  assert.equal(h.trace.capabilities.length,1);assert.equal(h.trace.events.filter(e=>e==='journal:claim').length,2);
  assert.deepEqual(copy(h.snapshot().snapshot),current);assert.equal(await io.readFile(path.join(h.root,journalRelative),'utf8'),journalBefore);
});

test('network kill-switch rejects unknown hosts, sites, methods and command routes without fallback',async()=>{
  const h=await setup();
  for(const [url,request] of [['https://example.invalid/',{method:'GET'}],
    [`https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/999/site_info`,{method:'GET'}],
    [`https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/${SITE}/site_info`,{method:'POST',body:'{}'}],
    [`https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/${SITE}/backup`,{method:'POST',body:'{}'}]])
    await assert.rejects(h.simulatedFetch(url,request),/REHEARSAL_NETWORK_DENIED/);
  assert.equal(h.trace.requests.length,0);assert.equal(h.trace.posts.length,0);
});
