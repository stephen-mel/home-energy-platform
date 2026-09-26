import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(file, deps={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText,{exports,require(name){assert.ok(name in deps,`Unexpected runtime dependency: ${name}`);return deps[name];}});
  return exports;
}
const local=load('src/lib/presentation/local-time.ts');
const view=load('src/components/energy-optimisation-view.ts',{'../lib/presentation/local-time':local});
const {default:Card}=load('src/components/EnergyOptimisation.tsx',{'react/jsx-runtime':jsx,'./energy-optimisation-view':view});
const date=t=>`2026-09-25T${t}:00+01:00`;
const period={start:date('13:00'),end:date('14:00')};
const window=amount=>({...period,price:{amount,currency:'GBP',unit:'kWh'},priceStatus:'known'});
const signal=amount=>({import:[window(amount)],export:[window(0.17)]});
function fixture(status='in-sync') {
  return {status,writeReady:false,rollbackProven:false,proposal:null,
    freshness:{generatedAt:date('12:59'),krakenObservedAt:date('12:58'),teslaObservedAt:date('12:58'),
      expiresAt:date('13:00'),evidenceAgeSeconds:60,evidenceTtlSeconds:60,captureAgeSeconds:60,captureTtlSeconds:120},
    domain:period,observed:{signal:signal(0.25177)},hep:{...signal(0.0299),export:[window(0.175)]},
    managed:{target:signal(0.0299),ownership:[{...period,basis:'current-smart'}]},
    comparison:{changedPeriods:status==='in-sync'?[]:[{...period,channels:['import']}]},
    unmanaged:{differences:[]},evidence:{currentDispatches:[{...period,assetId:'q7',assetName:'Q7',type:'SMART'}]},
    blockers:['ROLLBACK_UNPROVEN','BUY_BELOW_SELL','BOUNDED_FORECAST']};
}
const html=result=>renderToStaticMarkup(React.createElement(Card,{result,timeZone:'Europe/London'}));
const model=result=>view.energyOptimisationView(result,'Europe/London');

test('in-sync is a dated managed review snapshot, never a write permission',()=>{
  const rendered=html(fixture());
  assert.match(rendered,/Kraken and Powerwall are in sync/);
  assert.match(rendered,/Snapshot checked: 25 Sep 2026, 12:59:00 UTC\+01:00/);
  assert.match(rendered,/not a live status/);
  assert.doesNotMatch(rendered,/<button|<form|Current Powerwall signal/);
});
test('update-required presents exact Current to Proposed intervals and retains safety restrictions',()=>{
  const input=fixture('update-required');input.proposal={fingerprint:'exact-test-fingerprint'};
  const before=JSON.stringify(input),rendered=html(input);
  assert.match(rendered,/Charging schedule changed/);
  assert.match(rendered,/Current Powerwall signal/);assert.match(rendered,/Proposed signal · review only/);
  assert.match(rendered,/13:00:00 UTC\+01:00 → 25 Sep 2026, 14:00:00 UTC\+01:00 · 25.177p\/kWh/);
  assert.match(rendered,/2.99p\/kWh/);assert.match(rendered,/Automatic rollback remains unproven/);
  assert.match(rendered,/BUY_BELOW_SELL/);assert.match(rendered,/exact-test-fingerprint/);
  assert.match(rendered,/No change has been made to Tesla by this review/);
  assert.doesNotMatch(rendered,/<button|<form/);assert.equal(JSON.stringify(input),before);
});
test('indeterminate and unwired states wait honestly without pretending to have checked live Tesla',()=>{
  for(const input of [null,{status:'indeterminate',blockers:['STALE_KRAKEN_EVIDENCE'],proposal:null}]) {
    const rendered=html(input);assert.match(rendered,/Waiting for fresh information/);
    assert.doesNotMatch(rendered,/Snapshot checked|Proposed signal|role="alert"/);
  }
  assert.match(html(null),/not yet connected to this dashboard/);
});
test('blocked cannot be mistaken for a validated proposed replacement',()=>{
  const rendered=html(fixture('blocked'));
  assert.match(rendered,/Price signal needs review/);assert.match(rendered,/Required signal · not validated/);
  assert.doesNotMatch(rendered,/Proposed signal · review only|<button/);
});
test('export mismatch stays secondary and never promotes in-sync to update required',()=>{
  const input=fixture();input.unmanaged.differences=[{...period,channels:['export']}];
  const rendered=html(input);
  assert.match(rendered,/Kraken and Powerwall are in sync/);assert.doesNotMatch(rendered,/Charging schedule changed/);
  assert.match(rendered,/Other observed tariff differences/);
  assert.match(rendered,/17p\/kWh/);assert.match(rendered,/17.5p\/kWh/);
  assert.match(rendered,/manually configured in Tesla/);
  assert.ok(rendered.indexOf('Other observed tariff differences')>rendered.indexOf('<details'));
});
test('unattributed import differences do not claim all economics align or readiness to confirm',()=>{
  const input=fixture();input.managed.ownership=[];input.unmanaged.differences=[{...period,channels:['import']}];
  const rendered=html(input);
  assert.match(rendered,/No managed SMART update identified/);assert.match(rendered,/Without retained evidence/);
  assert.match(rendered,/not ready for confirmation/);assert.doesNotMatch(rendered,/Kraken and Powerwall are in sync/);
});
test('changed interval presentation clips independently and preserves gaps and unknown prices',()=>{
  const input=fixture('update-required');
  input.comparison.changedPeriods=[{start:date('13:10'),end:date('13:20'),channels:['import']},{start:date('13:40'),end:date('13:50'),channels:['import']}];
  input.managed.target.import[0].price=null;
  const m=model(input);assert.equal(m.current.length,2);assert.equal(m.proposed.length,2);
  assert.match(m.current[0],/13:10:00.*13:20:00/);assert.match(m.current[1],/13:40:00.*13:50:00/);
  assert.match(m.proposed[0],/Rate unknown/);assert.equal(JSON.stringify(model(input)),JSON.stringify(m));
});
test('London DST repeated hour is distinguished with explicit offsets',()=>{
  const input=fixture('update-required');
  const fold={start:'2026-10-25T00:30:00Z',end:'2026-10-25T01:30:00Z'};
  input.comparison.changedPeriods=[{...fold,channels:['import']}];
  input.observed.signal.import=[{...window(0.25177),...fold}];input.managed.target.import=[{...window(0.0299),...fold}];
  assert.match(model(input).current[0],/01:30:00 UTC\+01:00 → 25 Oct 2026, 01:30:00 UTC\+00:00/);
});
test('dashboard renders the section without reads, executor, refresh, timers or raw result serialization',()=>{
  const page=fs.readFileSync('src/app/page.tsx','utf8');
  assert.match(page,/<EnergyOptimisation result=\{null\}/);
  assert.ok(page.indexOf('<EnergyOptimisation')<page.indexOf('>Electric Vehicles</h2>'));
  for(const file of ['src/components/EnergyOptimisation.tsx','src/components/energy-optimisation-view.ts']) {
    const source=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(source,/fetch\(|setInterval|setTimeout|router\.refresh|useEffect|executeSupervised|JSON\.stringify/);
  }
});
