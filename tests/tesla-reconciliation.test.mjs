import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

class InputDate extends Date {
  constructor(...args) { assert.ok(args.length, 'No wall clock'); super(...args); }
  static now() { throw Error('No wall clock'); }
}
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, structuredClone, Date: InputDate, require(name) {
    assert.ok(name.startsWith('.'), `No native, network, OAuth or filesystem dependency: ${name}`);
    return load(path.resolve(path.dirname(file), name + '.ts'));
  } });
  return exports;
}
const { reconcileTeslaTariff } = load('src/lib/tesla-tariff/reconciliation.ts');
const { observedEconomicSignal, monetarySignal } = load('src/lib/tesla-tariff/observed-economic.ts');
const { comparePriceSignalsInDomain } = load('src/lib/tariff/comparison-domain.ts');
const { createTariffProposal, approveTariffProposal, assessProposalCurrentUse } = load('src/lib/tesla-tariff/proposal-approval.ts');
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts');
const siteConfig = load('src/lib/site/current-site.ts').currentSite;
const at = time => `2026-09-25T${time}:00+01:00`;
const dispatch = (start, end, type = 'SMART') => ({ start: at(start), end: at(end), type, energyAddedKwh: '3' });
function side(smart = [], sell = false) {
  const points = [...new Set([0, 360, 1440, ...smart.flat()])].sort((a,b) => a-b);
  const rates = {}, tou_periods = {};
  for (let i=0;i<points.length-1;i++) {
    const from=points[i],to=points[i+1], label=`arbitrary_${i}`;
    rates[label]=sell ? 0.175 : from<360 || smart.some(([a,b])=>a<=from && b>=to) ? 0.0299 : 0.2518;
    tou_periods[label]={periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:Math.floor(from/60),fromMinute:from%60,toHour:Math.floor(to/60)%24,toMinute:to%60}]};
  }
  return { version:1,name:'Observed test tariff',utility:'Test',currency:'GBP',
    seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods}},energy_charges:{Annual:{rates}} };
}
function input(dispatches=[], represented=[], now=at('12:00')) {
  const result = { site:structuredClone(siteConfig),energySiteId:'12345',now,
    comparisonDomain:{start:at('00:00'),end:at('18:00')},
    kraken:{stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'q7',name:'Q7',plannedDispatches:dispatches}]},
    observation:{source:{kind:'tesla-site-info',energySiteId:'12345',observedAt:now,timeZone:'Europe/London'},
      tariff:{...side(represented),sell_tariff:side([],true)},diagnostics:[],rollbackProven:false} };
  if (represented.length) {
    const old = structuredClone(result.kraken);
    old.vehicles[0].plannedDispatches = represented.map(([a,b]) => dispatch(`${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`, `${String(Math.floor(b/60)).padStart(2,'0')}:${String(b%60).padStart(2,'0')}`));
    result.managedImport = { baseline: { ...structuredClone(result.observation), tariff: { ...side(), sell_tariff:side([],true) } },
      representedSignal: getSitePriceSignal(result.site,old,now).signal };
  }
  return result;
}
function assertReplacement(r) {
  assert.equal(r.status,'update-required', JSON.stringify(r.blockers));
  assert.equal(r.writeReady,false); assert.equal(r.rollbackProven,false); assert.equal(r.humanApproved,false); assert.equal(r.writePayload,null);
  assert.equal(r.proposal.structurallyValid,true); assert.equal(r.proposal.writeReady,false);
  for(const b of ['BUY_BELOW_SELL','ROLLBACK_UNPROVEN','BOUNDED_FORECAST','RESTORATION_REQUIRED','OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED']) assert.ok(r.blockers.includes(b),b);
  const observation={...r.observed,source:{kind:'simulation',energySiteId:'12345',observedAt:r.freshness.generatedAt,timeZone:'Europe/London'},tariff:r.proposal.bound.representation,diagnostics:[],rollbackProven:false};
  const curve=observedEconomicSignal(observation,r.domain).signal;
  assert.equal(comparePriceSignalsInDomain(curve,monetarySignal(r.managed.target),r.domain).status,'unchanged');
  assert.ok(r.hep.import.flatMap(w=>w.eligibilityPeriods).every(p=>p.state==='planned-conditional'));
}

test('identical economics ignore Tesla labels and never certify write compatibility',()=>{
  const r=reconcileTeslaTariff(input()); assert.equal(r.status,'in-sync'); assert.equal(r.proposal,null); assert.equal(r.comparison.changedPeriods.length,0); assert.equal(r.writeReady,false);
});
test('SMART movement wholly inside guaranteed overnight is in-sync; BOOST never affects prices',()=>{
  for(const ds of [[dispatch('01:00','03:00')],[dispatch('02:00','05:00')],[dispatch('13:00','14:00','BOOST')]]) {
    const i=input(ds,[],at('00:00')); i.previousKraken=input([dispatch('03:00','04:00')],[],at('00:00')).kraken;
    const r=reconcileTeslaTariff(i); assert.equal(r.status,'in-sync'); assert.equal(r.evidence.changed,true);
  }
});
test('new daytime SMART gets exact conditional replacement, expiry and immutable bound evidence',()=>{
  const i=input([dispatch('13:00','14:30')]); const before=JSON.stringify(i);
  const r=reconcileTeslaTariff(i); assertReplacement(r); assert.equal(JSON.stringify(i),before);
  assert.equal(r.freshness.expiresAt,'2026-09-25T11:01:00.000Z');
  assert.equal(r.comparison.changedPeriods[0].start,'2026-09-25T12:00:00.000Z');
  assert.equal(r.proposal.bound.dispatchEvidenceKey,r.evidence.currentKey);
  const approval=approveTariffProposal(r.proposal,{fingerprint:r.proposal.fingerprint,approvedAt:i.now});
  const safety=assessProposalCurrentUse({approvedProposal:r.proposal,currentProposal:r.proposal,approval,now:i.now,targetEnergySiteId:'12345',authority:'confirm',rollback:{representation:i.observation.tariff,maxAgeMs:120000}});
  assert.equal(safety.writeReady,false); assert.equal(safety.rollbackProven,false); assert.ok(safety.blockers.includes('BUY_BELOW_SELL'));
});
test('cancelled daytime interval and moved boundaries replace obsolete cheap pricing',()=>{
  for(const ds of [[],[dispatch('13:30','15:00')]]) {
    const r=reconcileTeslaTariff(input(ds,[[780,870]])); assertReplacement(r);
  }
});
test('split/combined/overlapping SMART periods with identical prices are in-sync',()=>{
  for(const ds of [[dispatch('13:00','15:00')],[dispatch('13:00','14:00'),dispatch('14:00','15:00')],[dispatch('13:00','14:30'),dispatch('14:00','15:00')]]) {
    const r=reconcileTeslaTariff(input(ds,[[780,840],[840,900]])); assert.equal(r.status,'in-sync');
  }
});
test('re-optimisation after charging starts preserves elapsed economics, handles multiple remaining intervals',()=>{
  const r=reconcileTeslaTariff(input([dispatch('13:00','14:00'),dispatch('15:00','16:00')],[[780,870]],at('13:15')));
  assertReplacement(r); assert.equal(r.ignoredPastUntil,'2026-09-25T12:15:00.000Z');
  assert.ok(r.comparison.changedPeriods.every(p=>Date.parse(p.start)>=Date.parse(r.domain.start)));
});
test('an elapsed cheap interval is irrelevant within the explicit remaining comparison domain',()=>{
  const r=reconcileTeslaTariff(input([],[[540,600]],at('12:00'))); assert.equal(r.status,'in-sync');
});
test('freshness, future timestamps, malformed evidence and unknown coverage fail closed',()=>{
  const changes=[
    i=>{i.kraken.stale=true;}, i=>{i.kraken.lastSuccessfulUpdate=at('11:58');},i=>{i.kraken.lastSuccessfulUpdate=at('12:01');},
    i=>{i.observation.source.observedAt=at('11:57');},i=>{i.observation.source.energySiteId='wrong';},
    i=>{i.observation.tariff=null;},i=>{i.observation.tariff.seasons.Annual.toMonth=8;},
    i=>{i.site.tariff.versions=[];},i=>{i.kraken.vehicles[0].plannedDispatches=[dispatch('14:00','13:00')];},
    i=>{i.comparisonDomain.end=at('11:00');}, i=>{i.observation.diagnostics=['UNSUPPORTED_FIELDS_OMITTED'];},
  ];
  for(const change of changes){const i=input();change(i);const r=reconcileTeslaTariff(i);assert.equal(r.status,'indeterminate',r.diagnostic);assert.equal(r.proposal,null);assert.equal(r.writeReady,false);}
});
test('exact base/export differences remain visible but unmanaged',()=>{
  const i=input();i.observation.tariff.energy_charges.Annual.rates.arbitrary_1=0.25177;
  Object.keys(i.observation.tariff.sell_tariff.energy_charges.Annual.rates).forEach(k=>{i.observation.tariff.sell_tariff.energy_charges.Annual.rates[k]=0.17;});
  const r=reconcileTeslaTariff(i);assert.equal(r.status,'in-sync');assert.equal(r.exactComparison.state,'changed');assert.ok(r.unmanaged.differences.some(p=>p.channels.includes('export')));assert.equal(r.proposal,null);
});
test('short validity and sub-minute proposals stay blocked; cancellation invalidates earlier proposal approval',()=>{
  const i=input([dispatch('13:00','14:00')]);i.kraken.lastSuccessfulUpdate='2026-09-25T10:59:30Z';
  assert.equal(reconcileTeslaTariff(i).status,'blocked');
  const sub=input([dispatch('13:00','14:00')]);sub.kraken.vehicles[0].plannedDispatches[0].end='2026-09-25T13:00:15Z';
  assert.equal(reconcileTeslaTariff(sub).status,'blocked');
  const old=reconcileTeslaTariff(input([dispatch('13:00','14:00')])).proposal;
  const next=reconcileTeslaTariff(input([],[[780,840]])).proposal;
  const approval=approveTariffProposal(old,{fingerprint:old.fingerprint,approvedAt:old.bound.validFrom});
  const s=assessProposalCurrentUse({approvedProposal:old,currentProposal:next,approval,now:next.bound.validFrom,targetEnergySiteId:'12345',authority:'confirm',rollback:{representation:null,maxAgeMs:120000}});
  assert.ok(s.blockers.includes('CURRENT_PROPOSAL_CHANGED'));assert.equal(s.writeReady,false);
});
test('identical inputs give identical fingerprints and output; metadata changes alone do not create a rate difference',()=>{
  const i=input([dispatch('13:00','14:00')]);assert.equal(JSON.stringify(reconcileTeslaTariff(i)),JSON.stringify(reconcileTeslaTariff(i)));
  const same=input([dispatch('13:00','14:00')],[[780,840]]);same.managedImport.baseline.source.observedAt='2026-09-25T10:59:58Z';same.observation.source.observedAt='2026-09-25T10:59:59Z';
  assert.equal(reconcileTeslaTariff(same).status,'in-sync');
});


function transitionInput(now, end) {
  const i = input([], [], now);
  i.site.tariff.versions[0].effectiveFrom = '2026-01-01T00:00:00Z';
  i.site.tariff.versions[0].effectiveTo = '2027-01-01T00:00:00Z'; // synthetic rates, not invented production October prices
  i.comparisonDomain = { start: now, end };
  return i;
}
test('London GMT, spring-forward and fall-back guaranteed windows compare by actual instants', () => {
  for (const [now,end] of [
    ['2026-12-25T00:00:00Z','2026-12-25T12:00:00Z'],
    ['2026-03-29T00:00:00Z','2026-03-29T12:00:00+01:00'],
    ['2026-10-25T00:00:00+01:00','2026-10-25T12:00:00Z'],
  ]) {
    const i = transitionInput(now,end);
    i.kraken.vehicles[0].plannedDispatches = [{start:now,end:new Date(Date.parse(now)+3600000).toISOString(),type:'SMART',energyAddedKwh:null}];
    const r = reconcileTeslaTariff(i);
    assert.equal(r.status,'in-sync',r.diagnostic);
    assert.equal(r.observed.analysis.days[0].elapsedMinutes, now.startsWith('2026-03') ? 1380 : now.startsWith('2026-10') ? 1500 : 1440);
  }
});
test('cross-midnight SMART replacement keeps guaranteed prices and both local dates complete', () => {
  const i=input([],[],at('22:00'));
  i.comparisonDomain.end='2026-09-26T08:00:00+01:00';
  i.kraken.vehicles[0].plannedDispatches=[{start:at('22:30'),end:'2026-09-26T04:00:00+01:00',type:'SMART',energyAddedKwh:null}];
  const r=reconcileTeslaTariff(i); assertReplacement(r);
  assert.equal(r.comparison.changedPeriods.length,1);
  assert.equal(r.comparison.changedPeriods[0].end,'2026-09-25T23:00:00.000Z');
  assert.ok(r.restoration.boundToProposal);assert.equal(r.restoration.rollbackProven,false);
});
test('DST fold cannot alter excluded past wall-clock occurrences; conflicts are blocked', () => {
  const i=transitionInput('2026-10-25T01:00:00Z','2026-10-25T03:00:00Z');
  // Test tariff with no guaranteed overnight band, to exercise conditional fold pricing.
  i.site.tariff.versions[0].dailyImportWindows=[];
  Object.keys(i.observation.tariff.energy_charges.Annual.rates).forEach(k=>{i.observation.tariff.energy_charges.Annual.rates[k]=0.2518;});
  i.kraken.vehicles[0].plannedDispatches=[{start:'2026-10-25T01:00:00Z',end:'2026-10-25T02:00:00Z',type:'SMART',energyAddedKwh:null}];
  const r=reconcileTeslaTariff(i);
  assert.equal(r.status,'blocked');assert.ok(r.blockers.includes('OUTSIDE_DOMAIN_CHANGE'));assert.equal(r.proposal.bound.representation,null);
});
test('no vehicles is supported; insufficient/ambiguous Tesla prices do not become zero or unchanged', () => {
  const i=input();i.kraken.vehicles=[];assert.equal(reconcileTeslaTariff(i).status,'in-sync');
  for(const mutate of [
    i=>{delete i.observation.tariff.energy_charges.Annual.rates.arbitrary_1;},
    i=>{i.observation.tariff.energy_charges.Annual.rates.arbitrary_1=NaN;},
    i=>{i.observation.tariff.seasons.Duplicate=structuredClone(i.observation.tariff.seasons.Annual);},
    i=>{i.site.tariff.versions[0].export=null;},
  ]) {const j=input();mutate(j);const r=reconcileTeslaTariff(j);assert.equal(r.status,'indeterminate');assert.equal(r.proposal,null);}
});
test('new proposal rejects representation tampering and no approval survives validity expiry', () => {
  const i=input([dispatch('13:00','14:00')]);const r=reconcileTeslaTariff(i);
  const changed=structuredClone(r.proposal);changed.bound.representation.name='Changed after review';
  assert.throws(()=>approveTariffProposal(changed,{fingerprint:changed.fingerprint,approvedAt:i.now}));
  assert.throws(()=>approveTariffProposal(r.proposal,{fingerprint:r.proposal.fingerprint,approvedAt:r.freshness.expiresAt}));
  assert.equal(r.restoration.rollbackProven,false);assert.ok(r.restoration.blockers.includes('ROLLBACK_UNPROVEN'));
});


test('strict replacement preparation rejects invalid generation/capture binding and cannot accept an experiment exception', () => {
  const r = reconcileTeslaTariff(input([dispatch('13:00','14:00')]));
  for (const mutate of [
    p => { p.observedReplacement.observation.source.observedAt = '2026-09-25T12:01:00+01:00'; },
    p => { p.observedReplacement.dispatchEvidenceKey = ''; },
    p => { p.purpose = 'pricing-constraint-experiment'; p.exceptions = ['BUY_BELOW_SELL']; },
  ]) {
    const proposalInput = structuredClone(r.proposal.input); mutate(proposalInput);
    const p = createTariffProposal(proposalInput);
    assert.equal(p.structurallyValid, false);
    assert.throws(() => approveTariffProposal(p, {fingerprint:p.fingerprint,approvedAt:p.bound.validFrom}));
    const assessed = assessProposalCurrentUse({approvedProposal:p,currentProposal:p,approval:null,now:p.bound.validFrom,
      targetEnergySiteId:'12345',authority:'confirm',rollback:{representation:null,maxAgeMs:120000}});
    assert.ok(assessed.blockers.includes('BUY_BELOW_SELL'));
    assert.equal(assessed.acceptedExceptions.length,0);
    assert.equal(assessed.writeReady,false);
  }
});


test('17p Tesla export versus 17.5p HEP is unmanaged even with aligned SMART', () => {
  const i=input([dispatch('13:00','14:00')],[[780,840]]);
  for(const key of Object.keys(i.observation.tariff.sell_tariff.energy_charges.Annual.rates)) i.observation.tariff.sell_tariff.energy_charges.Annual.rates[key]=0.17;
  const r=reconcileTeslaTariff(i);
  assert.equal(r.status,'in-sync');assert.equal(r.exactComparison.state,'changed');
  assert.ok(r.unmanaged.differences.every(p=>p.channels.join()==='export'));
  assert.equal(r.unmanaged.comparison.status,'changed');
});
test('moved SMART restores observed 25.177p base and preserves the complete observed 17p export representation', () => {
  const i=input([dispatch('14:00','15:00')],[[780,840]]);
  for(const side of [i.observation.tariff,i.managedImport.baseline.tariff]) {
    for(const [key,value] of Object.entries(side.energy_charges.Annual.rates)) if(value===0.2518) side.energy_charges.Annual.rates[key]=0.25177;
  }
  for(const key of Object.keys(i.observation.tariff.sell_tariff.energy_charges.Annual.rates)) i.observation.tariff.sell_tariff.energy_charges.Annual.rates[key]=0.17;
  const r=reconcileTeslaTariff(i);assertReplacement(r);
  assert.deepEqual(structuredClone(r.proposal.bound.representation.sell_tariff),i.observation.tariff.sell_tariff);
  const restored=r.managed.target.import.find(w=>Date.parse(w.start)<=Date.parse(at('13:30')) && Date.parse(w.end)>Date.parse(at('13:30')));
  assert.equal(restored.price.amount,0.25177);
  assert.ok(r.unmanaged.differences.some(p=>p.channels.includes('import')));
  assert.ok(r.proposal.bound.managedScopeKey);
});
test('unattributed cheap tariff is preserved; previous Kraken data alone cannot claim ownership', () => {
  const i=input([],[[780,840]]);delete i.managedImport;
  i.previousKraken=input([dispatch('13:00','14:00')]).kraken;
  const r=reconcileTeslaTariff(i);assert.equal(r.status,'in-sync');assert.equal(r.exactComparison.state,'changed');
  assert.equal(r.unmanaged.comparison.status,'changed');assert.equal(r.proposal,null);
});
test('intervening import changes and invalid historical site binding are indeterminate, not silently restored', () => {
  for(const mutate of [
    i=>{ for(const [key,value] of Object.entries(i.observation.tariff.energy_charges.Annual.rates)) if(value===0.0299) i.observation.tariff.energy_charges.Annual.rates[key]=0.08; },
    i=>{i.managedImport.baseline.source.energySiteId='other';},
  ]) {const i=input([],[[780,840]]);mutate(i);const r=reconcileTeslaTariff(i);assert.equal(r.status,'indeterminate');assert.equal(r.proposal,null);assert.equal(r.rollbackProven,false);}
});

test('baseline import precision difference alone is reported without a managed update', () => {
  const i=input();
  for(const [key,value] of Object.entries(i.observation.tariff.energy_charges.Annual.rates)) if(value===0.2518) i.observation.tariff.energy_charges.Annual.rates[key]=0.25177;
  const r=reconcileTeslaTariff(i);
  assert.equal(r.status,'in-sync');assert.equal(r.exactComparison.state,'changed');assert.equal(r.proposal,null);
  assert.ok(r.unmanaged.differences.length>0);
  assert.ok(r.unmanaged.differences.every(p=>p.channels.join()==='import'));
});
