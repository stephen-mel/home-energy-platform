import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
const now='2026-09-26T12:00:00+01:00';
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return Date.parse(now);} }
function load(file,deps,globals={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
    fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText,{exports,Error,Date:Clock,structuredClone,...globals,require(name){
    if(deps && name in deps)return deps[name];
    assert.ok(name.startsWith('.'),`No native/network/executor dependency: ${name}`);
    assert.doesNotMatch(name,/supervised-local|supervised-journal|tesla\/client|kraken\/client/);
    return load(path.resolve(path.dirname(file),name+'.ts'));
  }});return exports;
}
const domain=load('src/lib/tesla-tariff/reconciliation.ts');
const site=load('src/lib/site/current-site.ts').currentSite;
const {captureObservedTariff}=load('src/lib/tesla-tariff/observed-tariff.ts');
function side(sell=false){return {name:'Test tariff',utility:'Test',currency:'GBP',
  seasons:{Annual:{fromMonth:1,fromDay:1,toMonth:12,toDay:31,tou_periods:{night:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:0,toHour:6,fromMinute:0,toMinute:0}]},day:{periods:[{fromDayOfWeek:0,toDayOfWeek:6,fromHour:6,toHour:0,fromMinute:0,toMinute:0}]}}}},
  energy_charges:{Annual:{rates:{night:sell?0.17:0.02993,day:sell?0.17:0.25177}}}};}
const raw=()=>({response:{energy_site_id:Number(site.integrations.tesla.energySiteId),installation_time_zone:'Europe/London',tariff_content_v2:{...side(),sell_tariff:side(true)}}});
const observation=()=>captureObservedTariff(raw(),site.integrations.tesla.energySiteId,now);
const kraken=()=>({stale:false,lastSuccessfulUpdate:now,vehicles:[{id:'q7',name:'Q7',plannedDispatches:[]}]});
const state=k=>({site,updatedAt:now,integrations:{kraken:{enabled:true,data:k,error:null},homeAssistant:{enabled:false,data:null,error:null},tesla:{enabled:true,data:null,error:null}}});
function loader(k=kraken(),read=async()=>observation()) {
  const calls={kraken:0,tesla:0};
  const loaded=load('src/lib/site/get-home-dashboard-state.ts',{
    './get-site-state':{getSiteState:async()=>{calls.kraken++;return state(k);}},
    './tesla-observation':{getSiteTeslaObservation:async()=>{calls.tesla++;return read();}},
    '../tesla-tariff/reconciliation':domain,
  });return {run:()=>loaded.getHomeDashboardState(site),calls};
}
const local=load('src/lib/presentation/local-time.ts');
const view=load('src/components/energy-optimisation-view.ts',{'../lib/presentation/local-time':local});
const {default:Card}=load('src/components/EnergyOptimisation.tsx',{'react/jsx-runtime':jsx,'./energy-optimisation-view':view});

test('one fresh snapshot reaches component; base/export differences remain unmanaged with no duplicate rendering reads',async()=>{
  const x=loader();const result=await x.run();
  assert.equal(result.reconciliation.status,'in-sync');
  assert.equal(result.reconciliation.exactComparison.state,'changed');
  assert.ok(result.reconciliation.unmanaged.differences.some(p=>p.channels.includes('export')));
  const markup=renderToStaticMarkup(React.createElement(Card,{result:result.reconciliation,timeZone:'Europe/London'}));
  assert.match(markup,/No managed SMART update identified/);assert.match(markup,/17p\/kWh/);
  assert.deepEqual(x.calls,{kraken:1,tesla:1});
});
test('fresh daytime SMART produces non-executable proposal preserving observed export and no manufactured ownership',async()=>{
  const k=kraken();k.vehicles[0].plannedDispatches=[{start:'2026-09-26T12:30:00+01:00',end:'2026-09-26T14:00:00+01:00',type:'SMART',energyAddedKwh:null}];
  const r=(await loader(k).run()).reconciliation;
  assert.equal(r.status,'update-required');assert.equal(r.writeReady,false);assert.equal(r.rollbackProven,false);assert.equal(r.writePayload,null);
  assert.equal(r.proposal.input.observedReplacement.managedScope.previous,undefined);
  assert.deepEqual(structuredClone(r.proposal.bound.representation.sell_tariff),structuredClone(observation().tariff.sell_tariff));
  for(const b of ['BUY_BELOW_SELL','ROLLBACK_UNPROVEN','RESTORATION_REQUIRED','BOUNDED_FORECAST'])assert.ok(r.blockers.includes(b));
  assert.match(renderToStaticMarkup(React.createElement(Card,{result:r,timeZone:'Europe/London'})),/Charging schedule changed/);
});
test('unavailable Tesla and unknown errors fail indeterminate without reflecting upstream content',async()=>{
  for(const message of ['TESLA_AUTH_UNAVAILABLE','secret-token raw upstream credentials']){
    const r=(await loader(kraken(),async()=>{throw Error(message);}).run()).reconciliation;
    assert.equal(r.status,'indeterminate');assert.equal(r.proposal,null);assert.equal(r.rollbackProven,false);
    assert.doesNotMatch(JSON.stringify(r),/secret-token|credentials/);
  }
});
test('missing, persisted stale and expired Kraken retain safe semantics without refetch',async()=>{
  for(const k of [null,{...kraken(),stale:true},{...kraken(),lastSuccessfulUpdate:'2026-09-26T10:58:59Z'}]){
    const x=loader(k),r=(await x.run()).reconciliation;
    assert.equal(r.status,'indeterminate');assert.equal(r.proposal,null);assert.equal(x.calls.kraken,1);
  }
});
test('incomplete or stale Tesla observations remain indeterminate',async()=>{
  for(const change of [o=>{o.tariff=null;},o=>{o.source.observedAt='2026-09-26T10:57:00Z';}]){
    const o=observation();change(o);assert.equal((await loader(kraken(),async()=>o).run()).reconciliation.status,'indeterminate');
  }
});
test('Tesla boundary uses one configured site GET; no discovery, raw response, wrong-site acceptance or token refresh',async()=>{
  let calls=0;
  const read=load('src/lib/site/tesla-observation.ts',{'../tesla/client':{getTeslaSiteInfo:async id=>{calls++;assert.equal(String(id),site.integrations.tesla.energySiteId);return {...raw(),secret:'must-not-leak'};}},'../tesla-tariff/observed-tariff':{captureObservedTariff}});
  const observed=await read.getSiteTeslaObservation(site);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(observed),/must-not-leak/);
  for(const value of [Error('Tesla Fleet API site info HTTP error 401'),Error('secret upstream'),{response:{energy_site_id:1}}]){
    const boundary=load('src/lib/site/tesla-observation.ts',{'../tesla/client':{getTeslaSiteInfo:async()=>{if(value instanceof Error)throw value;return value;}},'../tesla-tariff/observed-tariff':{captureObservedTariff}});
    await assert.rejects(()=>boundary.getSiteTeslaObservation(site),/TESLA_(AUTH_UNAVAILABLE|READ_UNAVAILABLE|SITE_MISMATCH)/);
  }
  const disabled=structuredClone(site);disabled.integrations.tesla.enabled=false;
  await assert.rejects(()=>read.getSiteTeslaObservation(disabled),/TESLA_DISABLED/);assert.equal(calls,1);
});
test('server wiring has no write, executor, journal, timer or duplicate Kraken call',()=>{
  for(const file of ['src/lib/site/get-home-dashboard-state.ts','src/lib/site/tesla-observation.ts']){
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),/runSupervised|supervised-local|claimExperiment|setInterval|setTimeout|writeFile|refreshToken|time_of_use_settings|getKrakenState/);
  }
  const page=fs.readFileSync('src/app/page.tsx','utf8');assert.equal((page.match(/await getHomeDashboardState\(site\)/g)||[]).length,1);
  assert.doesNotMatch(page,/await getSiteState|await getTesla|await getKraken/);
});


for (const stall of ['headers','body']) test(`Tesla ${stall} stall aborts at the full-operation deadline; dashboard resolves without retry`,async()=>{
  let deadline, milliseconds, signal, attempts=0, cleared=0, bodyReads=0;
  const client=load('src/lib/tesla/client.ts',{
    './tokens':{readTeslaTokens:async()=>({access_token:'secret-test-token'}),tokenNeedsRefresh:()=>false,refreshTeslaTokens:async()=>assert.fail('Unexpected refresh')},
  },{
    process:{cwd:()=>'/mock'},AbortController,
    setTimeout(fn,ms){deadline=fn;milliseconds=ms;return 1;},
    clearTimeout(id){assert.equal(id,1);cleared++;},
    async fetch(url,options){
      attempts++;signal=options.signal;
      assert.match(url,/\/site_info$/);assert.equal(options.method??'GET','GET');
      if(stall==='headers')return new Promise(()=>{});
      return {ok:true,json(){bodyReads++;return new Promise(()=>{});}};
    },
  });
  const boundary=load('src/lib/site/tesla-observation.ts',{'../tesla/client':client,'../tesla-tariff/observed-tariff':{captureObservedTariff}});
  const k=kraken(),x=loader(k,()=>boundary.getSiteTeslaObservation(site));
  let resolved=false;
  const pending=x.run().then(value=>{resolved=true;return value;});
  // Flush promise continuations without waiting for a real production timer.
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(resolved,false);assert.equal(attempts,1);assert.equal(signal.aborted,false);
  assert.equal(milliseconds,5000);assert.equal(client.TESLA_SITE_INFO_TIMEOUT_MS,5000);
  assert.equal(bodyReads,stall==='body'?1:0);
  deadline();
  const result=await pending;
  assert.equal(signal.aborted,true);assert.equal(cleared,1);
  assert.equal(result.integrations.kraken.data,k);assert.equal(result.integrations.homeAssistant.enabled,false);
  assert.equal(result.reconciliation.status,'indeterminate');assert.equal(result.reconciliation.diagnostic,'TESLA_READ_UNAVAILABLE');
  assert.equal(result.integrations.tesla.data,null);assert.equal(result.reconciliation.proposal,null);
  assert.equal(result.reconciliation.writeReady,false);assert.equal(result.reconciliation.rollbackProven,false);
  assert.deepEqual(x.calls,{kraken:1,tesla:1});assert.equal(attempts,1);
  assert.doesNotMatch(JSON.stringify(result),/secret-test-token|secret-refresh/);
});

test('successful Tesla body consumption clears its deadline without aborting',async()=>{
  let cleared=0,signal;
  const client=load('src/lib/tesla/client.ts',{
    './tokens':{readTeslaTokens:async()=>({access_token:'secret-test-token'}),tokenNeedsRefresh:()=>false,refreshTeslaTokens:async()=>assert.fail('Unexpected refresh')},
  },{process:{cwd:()=>'/mock'},AbortController,setTimeout(){return 1;},clearTimeout(){cleared++;},
    async fetch(url,options){signal=options.signal;return {ok:true,json:async()=>({response:{ready:true}})};}});
  assert.equal((await client.getTeslaSiteInfo(123)).response.ready,true);
  assert.equal(cleared,1);assert.equal(signal.aborted,false);
});

test('503 with an open unread body aborts transport before timer cleanup and preserves dashboard state',async()=>{
  let signal,attempts=0,bodyOpen=false,bodyCleaned=false;
  const events=[];
  const client=load('src/lib/tesla/client.ts',{
    './tokens':{readTeslaTokens:async()=>({access_token:'secret-test-token'}),tokenNeedsRefresh:()=>false,refreshTeslaTokens:async()=>assert.fail('Unexpected refresh')},
  },{
    process:{cwd:()=>'/mock'},AbortController,
    setTimeout(fn,ms){assert.equal(ms,5000);return 1;},
    clearTimeout(id){assert.equal(id,1);assert.equal(bodyOpen,false);events.push('timer-cleared');},
    async fetch(url,options){
      attempts++;signal=options.signal;
      assert.match(url,/\/site_info$/);assert.equal(options.method??'GET','GET');
      // Controlled transport: the body stays open indefinitely until aborted.
      const body=new ReadableStream({start(controller){
        bodyOpen=true;
        signal.addEventListener('abort',()=>{
          bodyOpen=false;bodyCleaned=true;events.push('body-aborted');
          controller.error(signal.reason);
        },{once:true});
      }});
      return {ok:false,status:503,body,
        json(){assert.fail('Error body must not be consumed or exposed');},
        text(){assert.fail('Error body must not be consumed or exposed');}};
    },
  });
  const boundary=load('src/lib/site/tesla-observation.ts',{'../tesla/client':client,'../tesla-tariff/observed-tariff':{captureObservedTariff}});
  const k=kraken(),x=loader(k,()=>boundary.getSiteTeslaObservation(site));
  const result=await x.run();
  assert.equal(signal.aborted,true);assert.equal(bodyCleaned,true);
  assert.deepEqual(events,['body-aborted','timer-cleared']);
  assert.equal(result.integrations.kraken.data,k);assert.equal(result.site,site);
  assert.equal(result.integrations.tesla.data,null);assert.equal(result.integrations.tesla.error,'TESLA_READ_UNAVAILABLE');
  assert.equal(result.reconciliation.status,'indeterminate');assert.equal(result.reconciliation.proposal,null);
  assert.equal(result.reconciliation.writeReady,false);assert.equal(result.reconciliation.rollbackProven,false);
  assert.equal(attempts,1);assert.deepEqual(x.calls,{kraken:1,tesla:1});
  assert.doesNotMatch(JSON.stringify(result),/secret-test-token|secret-refresh/);
});

test('proactive refresh failure remains indeterminate while Kraken/site data survives, without a Fleet read',async()=>{
  let refreshes=0;
  const client=load('src/lib/tesla/client.ts',{
    './tokens':{readTeslaTokens:async()=>({access_token:'private-old-token'}),tokenNeedsRefresh:()=>true,
      refreshTeslaTokens:async()=>{refreshes++;throw Error('private OAuth response');}},
  },{process:{cwd:()=>'/mock'},AbortController,setTimeout(){return 1;},clearTimeout(){},
    async fetch(){assert.fail('Failed refresh must not proceed to Fleet API');}});
  const boundary=load('src/lib/site/tesla-observation.ts',{'../tesla/client':client,'../tesla-tariff/observed-tariff':{captureObservedTariff}});
  const k=kraken(),x=loader(k,()=>boundary.getSiteTeslaObservation(site));
  const result=await x.run();
  assert.equal(refreshes,1);assert.equal(result.integrations.kraken.data,k);assert.equal(result.site,site);
  assert.equal(result.reconciliation.status,'indeterminate');assert.equal(result.reconciliation.diagnostic,'TESLA_READ_UNAVAILABLE');
  assert.equal(result.reconciliation.writeReady,false);assert.equal(result.reconciliation.rollbackProven,false);
  assert.doesNotMatch(JSON.stringify(result),/private-old-token|private OAuth response/);
});
