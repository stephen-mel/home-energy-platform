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
  }).outputText, { exports, Error, structuredClone, Date: InputDate, Intl, require(name) {
    assert.ok(name.startsWith('.'), `No native, network, OAuth or filesystem dependency: ${name}`);
    return load(path.resolve(path.dirname(file), name + '.ts'));
  } });
  return exports;
}
const { planSingleSiteSynchronization } = load('src/lib/tesla-tariff/single-site-synchronizer.ts');
const { getSitePriceSignal } = load('src/lib/site/get-site-price-signal.ts');
const { representationKey } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const siteConfig = load('src/lib/site/current-site.ts').currentSite;
const at = value => `2026-09-25T${value}:00+01:00`;
const dispatch = (start, end, type = 'SMART') => ({start:at(start),end:at(end),type,energyAddedKwh:'1.25'});
const price = amount => ({amount,currency:'GBP',unit:'kWh'});

function side(smart = [], sell = false) {
  const points=[...new Set([0,360,1440,...smart.flat()])].sort((a,b)=>a-b), rates={}, tou_periods={};
  for(let i=0;i<points.length-1;i++) {
    const from=points[i],to=points[i+1],key=`period_${i}`;
    rates[key]=sell?0.17:(from<360||smart.some(([a,b])=>a<=from&&b>=to)?0.0299:0.2518);
    tou_periods[key]={periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:Math.floor(from/60),fromMinute:from%60,toHour:Math.floor(to/60)%24,toMinute:to%60}]};
  }
  return {version:1,name:'Observed household tariff',utility:'E.ON',currency:'GBP',
    seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods}},energy_charges:{Annual:{rates}}};
}
function input({dispatches=[], represented=[], now=at('12:00')}={}) {
  const site=structuredClone(siteConfig);
  // Historical/unit scenarios predate configured export evidence. Tests that
  // exercise the current authenticated tariff opt in explicitly below.
  delete site.integrations.kraken.exportTariffIdentity;
  const result={site,energySiteId:'12345',now,comparisonDomain:{start:at('00:00'),end:at('18:00')},
    kraken:{stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'q7',name:'Q7',plannedDispatches:dispatches}]},
    observation:{source:{kind:'tesla-site-info',energySiteId:'12345',observedAt:now,timeZone:'Europe/London'},
      tariff:{...side(represented),sell_tariff:side([],true)},diagnostics:[],rollbackProven:false}};
  if(represented.length) result.managedImport={version:1,energySiteId:'12345',timeZone:'Europe/London',createdAt:now,updatedAt:now,
    validUntil:at('18:00'),basis:'confirmed-write-readback',baselineFingerprint:'a'.repeat(64),readbackFingerprint:'b'.repeat(64),
    proposalFingerprint:'c'.repeat(64),smartEvidenceFingerprint:'d'.repeat(64),intervals:represented.map(([start,end])=>({
      start:at(`${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`),
      end:at(`${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`),
      restoreBaselineFingerprint:'a'.repeat(64),applied:price(0.0299),restore:price(0.2518)}))};
  return result;
}
function assertProposal(result, action) {
  assert.equal(result.status,'proposal-ready');assert.equal(result.action,action);
  assert.equal(result.approvalRequired,true);assert.equal(result.executionReady,false);
  assert.equal(result.reconciliation.status,'update-required');
  assert.equal(result.reconciliation.writeReady,false);assert.equal(result.reconciliation.rollbackProven,false);
  assert.equal(result.reconciliation.proposal.writeReady,false);
  assert.ok(result.reconciliation.blockers.includes('ROLLBACK_UNPROVEN'));
}

test('new daytime SMART interval produces an apply proposal without execution authority',()=>{
  assertProposal(planSingleSiteSynchronization(input({dispatches:[dispatch('13:00','14:00')]})),'apply');
});
test('changed SMART boundaries produce an update preserving observed export and base prices',()=>{
  const i=input({dispatches:[dispatch('13:30','15:00')],represented:[[780,840]]});
  const result=planSingleSiteSynchronization(i);assertProposal(result,'update');
  assert.equal(representationKey(result.reconciliation.proposal.bound.representation.sell_tariff),representationKey(i.observation.tariff.sell_tariff));
  assert.ok(result.reconciliation.managed.target.import.some(window=>window.price.amount===0.2518));
});
test('withdrawn SMART interval produces an exact restoration proposal',()=>{
  const result=planSingleSiteSynchronization(input({represented:[[780,840]]}));assertProposal(result,'restore');
  const restored=result.reconciliation.managed.target.import.filter(window=>Date.parse(window.start)>=Date.parse(at('13:00'))&&Date.parse(window.end)<=Date.parse(at('14:00')));
  assert.ok(restored.length);assert.ok(restored.every(window=>window.price.amount===0.2518));
});
test('expired ownership is ignored and identical economics remain in sync',()=>{
  const result=planSingleSiteSynchronization(input({represented:[[540,600]],now:at('12:00')}));
  assert.equal(result.status,'in-sync');assert.equal(result.action,null);assert.equal(result.approvalRequired,false);
});
test('cross-midnight SMART changes only the economically relevant pre-midnight period',()=>{
  const i=input({now:at('22:00')});i.comparisonDomain.end='2026-09-26T08:00:00+01:00';
  i.kraken.vehicles[0].plannedDispatches=[{start:at('23:30'),end:'2026-09-26T00:00:00+01:00',type:'SMART',energyAddedKwh:'1.25'}];
  const result=planSingleSiteSynchronization(i);assertProposal(result,'apply');
  assert.equal(result.reconciliation.comparison.changedPeriods[0].start,'2026-09-25T22:30:00.000Z');
  assert.equal(result.reconciliation.comparison.changedPeriods[0].end,'2026-09-25T23:00:00.000Z');
});
test('stale or missing Kraken evidence fails closed',()=>{
  for(const mutate of [i=>{i.kraken.stale=true;},i=>{i.kraken.lastSuccessfulUpdate=at('11:58');},i=>{i.kraken.vehicles[0].plannedDispatches=[{start:null,end:at('14:00'),type:'SMART',energyAddedKwh:null}];}]) {
    const i=input({dispatches:[dispatch('13:00','14:00')]});mutate(i);
    const result=planSingleSiteSynchronization(i);assert.equal(result.status,'indeterminate');assert.equal(result.executionReady,false);
    assert.equal(result.reconciliation.proposal,null);
  }
});
test('missing current tariff prices fail closed rather than reusing expired rates',()=>{
  const i=input({dispatches:[dispatch('13:00','14:00')]});i.site.tariff.versions=[];
  const result=planSingleSiteSynchronization(i);assert.equal(result.status,'indeterminate');assert.equal(result.action,null);
  assert.equal(result.reconciliation.proposal,null);assert.match(result.diagnostic,/DOMAIN|COVERAGE|PRICE|UNKNOWN/);
});

test('authenticated tariff identity diagnostic blocks September SMART proposal end to end',()=>{
  const i=input({dispatches:[dispatch('13:00','14:00')]});
  i.kraken.importTariffDiagnostic={status:'unavailable',code:'SITE_TARIFF_IDENTITY_UNCONFIGURED'};
  const result=planSingleSiteSynchronization(i);
  assert.equal(result.status,'blocked');assert.equal(result.action,null);
  assert.equal(result.reconciliation.status,'blocked');assert.equal(result.reconciliation.proposal,null);
  assert.equal(result.diagnostic,'SITE_TARIFF_IDENTITY_UNCONFIGURED');
  assert.equal(result.reconciliation.diagnostic,'SITE_TARIFF_IDENTITY_UNCONFIGURED');
  assert.ok(result.reconciliation.blockers.includes('SITE_TARIFF_IDENTITY_UNCONFIGURED'));
});

test('fractional tariff evidence cannot become cheap PriceSignal coverage or a proposal',()=>{
  const i=input({dispatches:[dispatch('13:00','14:00')]});
  i.kraken.importTariffDiagnostic={status:'unavailable',code:'RATE_BOUNDARY_NOT_MINUTE_ALIGNED'};
  const signal=getSitePriceSignal(i.site,i.kraken,'2026-10-11T12:00:00.000Z').signal;
  assert.ok(signal.import.length);assert.ok(signal.import.every(window=>window.price===null));
  assert.equal(signal.import.some(window=>window.kind==='guaranteed-off-peak'),false);
  const result=planSingleSiteSynchronization(i);
  assert.equal(result.status,'blocked');assert.equal(result.reconciliation.proposal,null);
  assert.equal(result.reconciliation.diagnostic,'RATE_BOUNDARY_NOT_MINUTE_ALIGNED');
});
test('BOOST and overnight SMART do not create managed tariff actions',()=>{
  for(const dispatches of [[dispatch('13:00','14:00','BOOST')],[dispatch('01:00','03:00')]]) {
    const result=planSingleSiteSynchronization(input({dispatches,now:at('00:00')}));
    assert.equal(result.status,'in-sync');assert.equal(result.action,null);
  }
});
test('identical inputs are deterministic and planner never exposes an executable payload',()=>{
  const i=input({dispatches:[dispatch('13:00','14:00')]});
  const a=planSingleSiteSynchronization(i),b=planSingleSiteSynchronization(i);
  assert.equal(JSON.stringify(a),JSON.stringify(b));assert.equal(a.executionReady,false);
  assert.equal(a.reconciliation.writePayload,null);
});

test('verified current Kraken import economics replace expired static rates while preserving observed export',()=>{
  const now='2026-10-11T21:00:00.000Z',start='2026-10-11T21:00:00.000Z',end='2026-10-12T05:00:00.000Z';
  const i=input({now:at('12:00')});i.now=now;i.comparisonDomain={start,end};
  i.site.integrations.kraken.importTariffIdentity={tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'};
  i.site.integrations.kraken.exportTariffIdentity={accountRef:'opaque-export-account',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'};
  i.kraken.lastSuccessfulUpdate=now;
  i.kraken.importTariff={status:'available',accountRef:'opaque-account',observedAt:now,exportStatus:'unknown',
    agreement:{validFrom:'2026-01-17T00:00:00Z',validTo:'2027-01-17T00:00:00Z',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'},
    version:{id:'next_drive_smart_v5_2',name:'Next Drive Smart V5.2',provider:'eon-next-kraken',
      effectiveFrom:'2026-10-10T23:00:00Z',effectiveTo:'2026-10-12T23:00:00Z',pricesIncludeVat:true,
      normalImport:price(0.23978),export:null,scheduledChargingImport:price(0.0285),standingCharge:{amount:0.57143,currency:'GBP',unit:'day'},
      dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(0.0285)}]}};
  i.kraken.exportTariff={status:'available',accountRef:'opaque-export-account',observedAt:now,
    agreement:{validFrom:'2026-10-01T23:00:00Z',validTo:'2027-10-01T23:00:00Z',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'},
    price:price(0.175)};
  i.kraken.vehicles[0].plannedDispatches=[{start:'2026-10-11T22:30:00Z',end:'2026-10-11T23:00:00Z',type:'SMART',energyAddedKwh:'1'}];
  i.observation.source.observedAt=now;
  for(const side of [i.observation.tariff]) for(const rates of Object.values(side.energy_charges))
    for(const key of Object.keys(rates.rates)) rates.rates[key]=rates.rates[key]===0.0299?0.0285:0.23978;
  const result=planSingleSiteSynchronization(i);
  assertProposal(result,'apply');
  assert.ok(result.reconciliation.hep.import.some(window=>window.price?.amount===0.0285));
  assert.ok(result.reconciliation.hep.import.some(window=>window.price?.amount===0.23978));
  assert.ok(result.reconciliation.hep.export.some(window=>window.price?.amount===0.175));
  assert.ok(result.reconciliation.hep.export.every(window=>window.price===null||window.price.amount===0.175));
  assert.ok(result.reconciliation.exactComparison.changedPeriods.some(period=>period.channels.includes('export')));
  assert.ok(result.reconciliation.unmanaged.differences.some(period=>period.channels.includes('export')));
  assert.equal(result.reconciliation.blockers.includes('EXPORT_ECONOMICS_UNVERIFIED'),false);
  assert.ok(result.reconciliation.blockers.includes('BUY_BELOW_SELL'));
  assert.equal(representationKey(result.reconciliation.proposal.bound.representation.sell_tariff),representationKey(i.observation.tariff.sell_tariff));
  i.kraken.importTariff.agreement.validTo='2026-10-11T22:45:00.000Z';
  i.kraken.importTariff.version.effectiveTo='2026-10-11T22:45:00.000Z';
  const expiresInsideProposal=planSingleSiteSynchronization(i);
  assert.equal(expiresInsideProposal.status,'indeterminate');
  assert.equal(expiresInsideProposal.reconciliation.proposal,null);
});

test('configured export evidence fails closed when missing, stale or contradictory',()=>{
  const now='2026-10-11T21:00:00.000Z';
  const base=input({dispatches:[{start:'2026-10-11T22:30:00Z',end:'2026-10-11T23:00:00Z',type:'SMART',energyAddedKwh:'1'}]});
  base.now=now;base.comparisonDomain={start:now,end:'2026-10-12T05:00:00.000Z'};
  base.kraken.lastSuccessfulUpdate=now;base.observation.source.observedAt=now;
  base.site.integrations.kraken.exportTariffIdentity={accountRef:'opaque-export-account',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'};
  assert.equal(planSingleSiteSynchronization(base).reconciliation.diagnostic,'EXPORT_TARIFF_EVIDENCE_MISSING');
  base.kraken.exportTariff={status:'available',accountRef:'opaque-export-account',observedAt:'2026-10-11T20:58:00.000Z',
    agreement:{validFrom:'2026-10-01T23:00:00Z',validTo:'2027-10-01T23:00:00Z',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'},price:price(0.175)};
  assert.equal(planSingleSiteSynchronization(base).reconciliation.diagnostic,'EXPORT_TARIFF_EVIDENCE_INVALID');
  base.kraken.exportTariff.observedAt=now;base.kraken.exportTariff.agreement.tariffCode='OTHER';
  assert.equal(planSingleSiteSynchronization(base).reconciliation.diagnostic,'EXPORT_TARIFF_EVIDENCE_INVALID');
});

test('export agreement ending at 22:00 UTC cannot cover a proposal through 22:45 UTC',()=>{
  const now='2026-10-11T21:00:00.000Z';
  const i=input({dispatches:[{start:'2026-10-11T21:30:00Z',end:'2026-10-11T22:30:00Z',type:'SMART',energyAddedKwh:'1'}]});
  i.now=now;i.comparisonDomain={start:now,end:'2026-10-11T22:45:00.000Z'};
  i.kraken.lastSuccessfulUpdate=now;i.observation.source.observedAt=now;
  i.site.integrations.kraken.exportTariffIdentity={accountRef:'opaque-export-account',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'};
  i.site.integrations.kraken.importTariffIdentity={tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'};
  i.kraken.importTariff={status:'available',accountRef:'opaque-import-account',observedAt:now,exportStatus:'unknown',
    agreement:{validFrom:'2026-01-17T00:00:00Z',validTo:'2027-01-17T00:00:00Z',productCode:'NEXT_DRIVE_SMART_V5_2',tariffCode:'E-TOU-NEXT_DRIVE_SMART_V5_2-G',meterPointRef:'meter-a'},
    version:{id:'next_drive_smart_v5_2',name:'Next Drive Smart V5.2',provider:'eon-next-kraken',effectiveFrom:now,effectiveTo:'2026-10-12T23:00:00Z',pricesIncludeVat:true,
      normalImport:price(0.23978),export:null,scheduledChargingImport:price(0.0285),standingCharge:null,dailyImportWindows:[{start:'00:00',end:'06:00',kind:'guaranteed-off-peak',price:price(0.0285)}]}};
  i.kraken.exportTariff={status:'available',accountRef:'opaque-export-account',observedAt:now,
    agreement:{validFrom:'2026-10-01T23:00:00Z',validTo:'2026-10-11T22:00:00.000Z',productCode:'NEXT_EXPORT_PREMIUM_V3',tariffCode:'E-1R-NEXT_EXPORT_PREMIUM_V3-G'},price:price(0.175)};
  const signal=getSitePriceSignal(i.site,i.kraken,now).signal;
  const afterExpiry=signal.export.filter(window=>Date.parse(window.start)>=Date.parse('2026-10-11T22:00:00.000Z'));
  assert.ok(afterExpiry.length);assert.ok(afterExpiry.every(window=>window.price===null));
  const result=planSingleSiteSynchronization(i);
  assert.equal(result.status,'blocked');assert.equal(result.reconciliation.proposal,null);
  assert.equal(result.reconciliation.diagnostic,'EXPORT_TARIFF_COVERAGE_INCOMPLETE');
});
