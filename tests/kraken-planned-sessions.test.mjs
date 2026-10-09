import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
function load(path,deps={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports,require(name){assert.ok(Object.hasOwn(deps,name),`Forbidden dependency ${name}`);return deps[name];}});
  return exports;
}
const local=load('src/lib/presentation/local-time.ts');
let clock;
const {default:Sessions}=load('src/components/KrakenPlannedSessions.tsx',{'react/jsx-runtime':jsx,'./use-dashboard-time':{useDashboardTime:seed=>clock??seed},'../lib/presentation/local-time':local});
const now='2026-09-25T12:15:00Z';
const dispatch=(type='SMART')=>({start:'2026-09-25T12:00:00+00:00',end:'2026-09-25T13:30:00+00:00',type,energyAddedKwh:'-3.1250'});
const vehicle=(name='Q7')=>({id:name,name,plannedDispatches:[dispatch()],status:{activePower:{value:7}}});
const props=()=>({vehicle:vehicle(),snapshot:{lastSuccessfulUpdate:now,stale:false},asOf:now,timeZone:'Europe/London'});
const render=p=>renderToStaticMarkup(Sessions(p));

test('SMART and BOOST keep supplied boundaries, type and exact planned energy without entitlement',()=>{
  clock=undefined;const p=props();p.vehicle.plannedDispatches.push(dispatch('BOOST'));const before=JSON.stringify(p),html=render(p);
  assert.match(html,/SMART · Planned session/);assert.match(html,/BOOST · Planned session/);
  assert.match(html,/BOOST is not evidence of cheap-rate entitlement/);
  assert.match(html,/13:00:00 UTC\+01:00/);assert.match(html,/14:30:00 UTC\+01:00/);
  assert.match(html,/dateTime="2026-09-25T12:00:00\+00:00"/);assert.match(html,/-3.1250 kWh \(as supplied\)/);
  assert.match(html,/not actual charging, verified whole-house tariff eligibility or Tesla instructions/);
  assert.equal(JSON.stringify(p),before);
});
test('partial intervals are neither rounded nor shortened by clock/power changes',()=>{
  clock=undefined;const p=props();p.vehicle.plannedDispatches[0]={...dispatch(),start:'2026-09-25T12:14:12.345Z',end:'2026-09-25T12:29:47Z'};
  const initial=render(p);assert.match(initial,/13:14:12.345 UTC\+01:00/);assert.match(initial,/13:29:47 UTC\+01:00/);
  p.vehicle.status.activePower.value=0;assert.equal(render(p),initial);
  clock='2026-09-25T13:00:00Z';const later=render(p);
  assert.match(later,/dateTime="2026-09-25T12:14:12.345Z"/);assert.match(later,/dateTime="2026-09-25T12:29:47Z"/);
});
test('local clock ages successful snapshot at 60 seconds without changing supplied stale flag',()=>{
  clock=undefined;const p=props();assert.match(render(p),/Recently retrieved/);
  clock='2026-09-25T12:15:59Z';assert.match(render(p),/Retrieved 59 seconds ago/);
  clock='2026-09-25T12:16:00Z';assert.match(render(p),/at least 60 seconds old/);assert.doesNotMatch(render(p),/Recently retrieved/);
  clock='2026-09-26T12:15:00Z';assert.match(render(p),/86400 seconds ago/);assert.equal(p.snapshot.stale,false);
  p.snapshot.stale=true;assert.match(render(p),/Stale \/ last-known snapshot/);assert.match(render(p),/SMART · Planned session/);
});
test('unavailable, invalid/future timestamp and ambiguous empty states never claim authoritative absence',()=>{
  clock=undefined;const p=props();p.snapshot=null;assert.match(render(p),/planned sessions unavailable/);assert.doesNotMatch(render(p),/SMART · Planned session/);
  for(const stamp of ['invalid','2026-09-26T12:15:00Z']){p.snapshot={lastSuccessfulUpdate:stamp,stale:false};assert.match(render(p),/Snapshot freshness unknown/);}
  p.snapshot=props().snapshot;
  for(const empty of [[],undefined,null]){p.vehicle.plannedDispatches=empty;const html=render(p);assert.match(html,/cannot distinguish an empty schedule from missing dispatch data/);assert.match(html,/does not confirm cancellation or withdrawal/);}
  p.vehicle=null;assert.match(render(p),/No vehicle sessions can be displayed/);
});
test('missing energy remains unknown; malformed intervals do not crash or become rounded sessions',()=>{
  clock=undefined;const p=props();p.vehicle.plannedDispatches=[{...dispatch(),start:'invalid',energyAddedKwh:null}];
  const html=render(p);assert.match(html,/Time unavailable/);assert.match(html,/interval is invalid/);assert.match(html,/energy not supplied \/ unknown/);assert.doesNotMatch(html,/0 kWh/);
});
test('London DST fold preserves distinct offset instants; spring gap uses correct offsets',()=>{
  clock=undefined;const p=props();p.vehicle.plannedDispatches=[{...dispatch(),start:'2026-10-25T01:00:00+01:00',end:'2026-10-25T01:30:00+00:00'}];
  const fold=render(p);assert.match(fold,/01:00:00 UTC\+01:00/);assert.match(fold,/01:30:00 UTC\+00:00/);
  p.vehicle.plannedDispatches=[{...dispatch(),start:'2026-03-29T00:30:00Z',end:'2026-03-29T01:30:00Z'}];
  const gap=render(p);assert.match(gap,/00:30:00 UTC\+00:00/);assert.match(gap,/02:30:00 UTC\+01:00/);
  p.vehicle.plannedDispatches=[{...dispatch(),start:'2026-12-01T13:00:00Z',end:'2026-12-01T14:00:00Z'}];assert.match(render(p),/13:00:00 UTC\+00:00/);
});
test('multiple vehicles have independent attributed sessions and SSR uses supplied seed',()=>{
  clock=undefined;const a=props(),b={...props(),vehicle:vehicle('A3')};b.vehicle.plannedDispatches=[dispatch('BOOST')];
  assert.match(render(a),/Planned vehicle sessions for Q7/);assert.doesNotMatch(render(a),/BOOST · Planned/);
  assert.match(render(b),/Planned vehicle sessions for A3/);assert.doesNotMatch(render(b),/SMART · Planned/);
  assert.equal(render(a),render(a));assert.match(render(a),/Retrieved 0 seconds ago/);
});
test('page passes existing snapshot and clock only; tariff and charging consumers remain separate',()=>{
  const page=fs.readFileSync('src/app/page.tsx','utf8');
  assert.match(page,/<KrakenPlannedSessions vehicle=\{vehicle\} snapshot=\{kraken\} asOf=\{siteState.updatedAt\} timeZone="Europe\/London"/);
  assert.match(page,/<VehicleActivity vehicle=\{vehicle\} asOf=\{siteState.updatedAt\}/);
  assert.match(page,/<HomeEnergyPlan plan=\{pricePlan\}/);
  assert.match(page,/<EnergyOptimisation result=\{siteState.reconciliation\}/);
});
