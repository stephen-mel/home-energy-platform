import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

const modules=new Map();
function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,
    {exports,Error,Date,Intl,structuredClone,require(name){if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name+'.ts'));if(name==='node:crypto')return crypto;throw Error(`Unexpected import ${name}`);}});return exports;}
const {assessFreshBaselineEligibility}=load('src/lib/tesla-tariff/fresh-baseline-eligibility.ts');
const {createTariffProposal,approveTariffProposal}=load('src/lib/tesla-tariff/proposal-approval.ts');
const {prepareSupervisedExperiment}=load('src/lib/tesla-tariff/supervised-experiment.ts');
const {representationKey}=load('src/lib/tesla-tariff/rollback-evidence.ts');
const {experimentTariff}=load('src/lib/tesla-tariff/experiment-tariff.ts');
const currentSite=load('src/lib/site/current-site.ts').currentSite;
const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json','utf8'));
const now='2026-09-23T08:12:00.000Z',site='12345',zone='Europe/London';

function setup(){
  const capture=structuredClone(fixture);capture.before.source={kind:'tesla-site-info',energySiteId:site,observedAt:now,timeZone:zone};capture.kraken.lastSuccessfulUpdate=now;
  const review=prepareSupervisedExperiment(currentSite,{energySiteId:site,assetId:'q7-fixture',dispatchStart:'2026-09-23T08:00:00+00:00'},capture,now);
  const current={source:{kind:'tesla-site-info',energySiteId:site,observedAt:now,timeZone:zone},tariff:structuredClone(capture.before),operatingMode:'autonomous',diagnostics:[]};
  current.tariff.source={...current.source};
  const proposal=createTariffProposal({...review.proposal.input,proposalId:'fresh-baseline-policy',purpose:'pricing-constraint-experiment',
    observedSmart:undefined,experimentRepresentation:experimentTariff(),exceptions:['BUY_BELOW_SELL']});
  const approval={...approveTariffProposal(proposal,{fingerprint:proposal.fingerprint,approvedAt:now}),
    baselineIdentity:representationKey({source:current.source,tariff:current.tariff.tariff})};
  const observation={id:'rollback-observation',energySiteId:site,representationKey:representationKey(current.tariff.tariff),observedAt:now,
    validUntil:'2026-09-23T08:14:00.000Z',basis:'authoritative-setting-capture'};
  return {energySiteId:site,timeZone:zone,assessedAt:now,maxObservationAgeMs:60000,current,ownership:{status:'missing'},proposal,approval,
    rollback:{observationId:observation.id,representation:structuredClone(current.tariff.tariff),maxAgeMs:60000},trustedRollbackObservations:[observation],
    historical:{format:'legacy',journalIdentity:'september-journal',attemptIdentity:null,mutationIdentity:null,
      journalDigest:'a'.repeat(64),classification:'write-outcome-unknown'},
    nextAttempt:{attemptId:'new-attempt',mutationId:'new-mutation'}};
}
function noAuthority(result){for(const key of ['writeReady','rollbackProven','restorationProven','resolvesHistoricalJournal','grantsRepeatAuthority'])assert.equal(result[key],false,key);}

test('complete fresh policy evidence is eligible despite unresolved September and grants no authority',()=>{
  const input=setup(),before=structuredClone(input.historical),ambiguous=assessFreshBaselineEligibility(input);
  const closedInput=setup();closedInput.historical.classification='operator-closed-manual-experiment';
  const closed=assessFreshBaselineEligibility(closedInput);
  assert.equal(ambiguous.status,'eligible-for-durable-claim-preparation',JSON.stringify(ambiguous.blockers));assert.equal(JSON.stringify(ambiguous.blockers),'[]');
  assert.equal(JSON.stringify(ambiguous.blockers),JSON.stringify(closed.blockers));assert.equal(closed.status,'eligible-for-durable-claim-preparation');
  assert.equal(ambiguous.historical.operationalBlocker,false);assert.equal(ambiguous.historical.remainsUnresolved,true);
  assert.equal(ambiguous.historical.attemptIdentity,null);assert.equal(ambiguous.historical.mutationIdentity,null);
  assert.deepEqual(input.historical,before);noAuthority(ambiguous);noAuthority(closed);
});

test('missing, stale, wrong-site and incomplete fresh baselines fail closed',()=>{
  for(const mutate of [
    x=>{x.current=null;},
    x=>{x.assessedAt='2026-09-23T08:13:00.001Z';},
    x=>{x.current.source.energySiteId='99999';x.current.tariff.source.energySiteId='99999';},
    x=>{x.current.tariff.tariff=null;}
  ]){const input=setup();mutate(input);const result=assessFreshBaselineEligibility(input);assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('FRESH_BASELINE_UNAVAILABLE'));noAuthority(result);}
});

test('unproven or mismatched restoration blocks the new operation',()=>{
  const unproven=setup();unproven.trustedRollbackObservations=[];let result=assessFreshBaselineEligibility(unproven);
  assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('ROLLBACK_UNPROVEN'));noAuthority(result);
  const mismatched=setup();mismatched.rollback.representation={different:true};result=assessFreshBaselineEligibility(mismatched);
  assert.ok(result.blockers.includes('RESTORATION_BASELINE_MISMATCH'));assert.ok(result.blockers.includes('ROLLBACK_UNPROVEN'));noAuthority(result);
});

test('ownership conflicts and invalid new audit identities remain blockers',()=>{
  const ownership=setup();ownership.ownership={status:'unavailable',code:'STORE_UNAVAILABLE'};let result=assessFreshBaselineEligibility(ownership);
  assert.ok(result.blockers.includes('OWNERSHIP_UNRESOLVED'));noAuthority(result);
  const replay=setup();replay.nextAttempt.mutationId='september-journal';result=assessFreshBaselineEligibility(replay);
  assert.ok(result.blockers.includes('INDEPENDENT_AUDIT_IDENTITY_INVALID'));noAuthority(result);
});

test('known historical identities are reserved while absent legacy identities do not block',()=>{
  const linked=setup();linked.historical={...linked.historical,format:'linked',attemptIdentity:'september-attempt',mutationIdentity:'september-mutation'};
  for(const old of ['september-journal','september-attempt','september-mutation'])for(const field of ['attemptId','mutationId']){
    const input=structuredClone(linked);input.nextAttempt[field]=old;const result=assessFreshBaselineEligibility(input);
    assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('INDEPENDENT_AUDIT_IDENTITY_INVALID'));noAuthority(result);
  }
  const legacy=setup(),result=assessFreshBaselineEligibility(legacy);assert.equal(result.status,'eligible-for-durable-claim-preparation');noAuthority(result);
});

test('null and partial ownership, proposal and restoration evidence fail deterministically',()=>{
  for(const [field,value,code] of [
    ['ownership',null,'OWNERSHIP_EVIDENCE_MALFORMED'],['ownership',{status:'available'},'OWNERSHIP_UNRESOLVED'],
    ['proposal',null,'PROPOSAL_EVIDENCE_MALFORMED'],['proposal',{bound:{}},'PROPOSAL_EVIDENCE_MALFORMED'],
    ['rollback',null,'RESTORATION_EVIDENCE_MALFORMED'],['rollback',{maxAgeMs:60000},'RESTORATION_EVIDENCE_MALFORMED']
  ]){const input=setup();input[field]=value;let result;assert.doesNotThrow(()=>{result=assessFreshBaselineEligibility(input);});
    assert.equal(result.status,'blocked');assert.ok(result.blockers.includes(code),`${field}: ${result.blockers}`);noAuthority(result);}
});

test('approval and current-state binding remain mandatory',()=>{
  const missing=setup();missing.approval=null;let result=assessFreshBaselineEligibility(missing);
  assert.ok(result.blockers.includes('EXACT_BASELINE_APPROVAL_REQUIRED'));noAuthority(result);
  const noBinding=setup();delete noBinding.approval.baselineIdentity;result=assessFreshBaselineEligibility(noBinding);
  assert.ok(result.blockers.includes('EXACT_BASELINE_APPROVAL_REQUIRED'));noAuthority(result);
  const mismatch=setup();mismatch.approval.baselineIdentity='not-the-baseline';result=assessFreshBaselineEligibility(mismatch);
  assert.ok(result.blockers.includes('EXACT_BASELINE_APPROVAL_REQUIRED'));noAuthority(result);
});

test('£0.41 observed baseline mutation invalidates the retained approval even with matching restoration evidence',()=>{
  const input=setup(),oldApproval=structuredClone(input.approval);
  for(const period of Object.values(input.current.tariff.tariff.energy_charges))period.rates.hour_6_minute_0=0.41;
  input.rollback.representation=structuredClone(input.current.tariff.tariff);
  input.trustedRollbackObservations[0].representationKey=representationKey(input.rollback.representation);
  const result=assessFreshBaselineEligibility(input);
  assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('EXACT_BASELINE_APPROVAL_REQUIRED'));
  assert.deepEqual(input.approval,oldApproval);noAuthority(result);
});

test('pricing-experiment path also requires exact baseline approval binding',()=>{
  const input=setup();delete input.approval.baselineIdentity;const result=assessFreshBaselineEligibility(input);
  assert.equal(input.proposal.bound.purpose,'pricing-constraint-experiment');
  assert.ok(result.blockers.includes('EXACT_BASELINE_APPROVAL_REQUIRED'));noAuthority(result);
});

test('incomplete nested proposal structures fail closed before the existing assessor',()=>{
  for(const mutate of [x=>{delete x.proposal.input.signal;},x=>{delete x.proposal.input.signal.horizon;},
    x=>{x.proposal.input.signal.import=null;},x=>{x.proposal.input.signal.export={};}]){
    const input=setup();mutate(input);let result;assert.doesNotThrow(()=>{result=assessFreshBaselineEligibility(input);});
    assert.equal(result.status,'blocked');assert.ok(result.blockers.includes('PROPOSAL_EVIDENCE_MALFORMED'));noAuthority(result);
  }
});
