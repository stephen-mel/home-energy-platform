import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file,deps={},globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,console:{error(){}},require:n=>{assert.ok(Object.hasOwn(deps,n),n);return deps[n];},...globals});return exports;}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const parser=load('src/lib/kraken/dispatch-response.ts',{'../tariff/resolve-economic-model':resolver});
const slot=()=>({start:'2026-10-25T01:00:00+01:00',end:'2026-10-25T01:30:00+00:00',type:'SMART',energyAddedKwh:'-2.3000'});
function client(response,authFailure=false){const calls=[];const c=load('src/lib/kraken/client.ts',{'./dispatch-response':parser},{process:{env:{EON_EMAIL:'synthetic',EON_PASSWORD:'synthetic'}},fetch:async(url,init)=>{
 const q=JSON.parse(init.body).query;calls.push(q);
 if(q.includes('obtainKrakenToken')&&authFailure)throw Error('SECRET_AUTH');
 if(q.includes('obtainKrakenToken'))return {ok:true,json:async()=>({data:{obtainKrakenToken:{token:'synthetic-token'}}})};
 assert.ok(q.trim().startsWith('query'));return typeof response==='function'?response(q):{ok:true,json:async()=>response};
}});return {c,calls};}
test('explicit empty is complete; missing/null/undefined are distinct incomplete results',()=>{
 const empty=parser.parseDispatchResponse({flexPlannedDispatches:[]});assert.equal(empty.status,'complete');assert.equal(empty.explicitlyEmpty,true);
 for(const [data,code] of [[{},'DISPATCH_FIELD_MISSING'],[{flexPlannedDispatches:null},'DISPATCH_FIELD_NULL'],[{flexPlannedDispatches:undefined},'DISPATCH_RESPONSE_MALFORMED']]){
 const r=parser.parseDispatchResponse(data);assert.equal(r.code,code);assert.throws(()=>parser.requireCompleteDispatches(r),new RegExp(code));}
});
test('all records validate or the whole response is incomplete, retaining exact valid primitives',()=>{
 const d=slot(),r=parser.parseDispatchResponse({flexPlannedDispatches:[d,{...d,type:'BOOST',energyAddedKwh:null}]});
 assert.equal(r.status,'complete');assert.equal(r.explicitlyEmpty,false);assert.equal(JSON.stringify(r.dispatches[0]),JSON.stringify(d));
 d.start='changed';assert.notEqual(r.dispatches[0].start,d.start);
 for(const bad of [null,{}, {...slot(),start:'2026-02-30T00:00:00Z'},{...slot(),end:slot().start},{...slot(),type:''},{...slot(),energyAddedKwh:2.3}]){
 assert.equal(parser.parseDispatchResponse({flexPlannedDispatches:[slot(),bad]}).status,'incomplete');}
});
test('accessors and sparse arrays reject without invoking getter',()=>{
 let called=0;const d=slot();Object.defineProperty(d,'start',{get(){called++;return slot().start;}});
 assert.equal(parser.parseDispatchResponse({flexPlannedDispatches:[d]}).status,'incomplete');assert.equal(called,0);
 assert.equal(parser.parseDispatchResponse({flexPlannedDispatches:new Array(1)}).status,'incomplete');
});
test('real client mapping preserves device attribution and complete array projection without extra calls',async()=>{
 const {c,calls}=client({data:{flexPlannedDispatches:[slot()]}});const r=await c.getKrakenPlannedDispatchResponse('synthetic-vehicle');
 assert.equal(r.deviceId,'synthetic-vehicle');assert.equal(r.status,'complete');assert.equal(r.dispatches[0].energyAddedKwh,'-2.3000');
 assert.equal(calls.length,2);assert.ok(calls[1].includes('synthetic-vehicle'));
 const empty=client({data:{flexPlannedDispatches:[]}});assert.equal((await empty.c.getKrakenPlannedDispatches('ev')).length,0);assert.equal(empty.calls.length,2);
});
test('legacy array consumer throws on incomplete, auth/transport/GraphQL failures; no retries or raw errors',async()=>{
 for(const response of [{data:{}},{data:{flexPlannedDispatches:null}},{data:{flexPlannedDispatches:[{}]}},{data:{flexPlannedDispatches:[]},errors:[{message:'SECRET'}]},()=>{throw Error('SECRET');}]){
 const {c,calls}=client(response);await assert.rejects(c.getKrakenPlannedDispatches('ev'),e=>e.message.startsWith('DISPATCH_')&&!e.message.includes('SECRET'));assert.equal(calls.length,2);}
 const {c}=client({});assert.equal((await c.getKrakenPlannedDispatchResponse('ev')).status,'failed');
});
test('partial multi-vehicle refresh preserves previous schedules, while complete empty replaces them',async()=>{
 let mode='complete',now=Date.parse('2026-10-09T12:00:00Z'),saved=null,writes=0;
 const {c}=client(q=>({ok:true,json:async()=>({data:mode==='incomplete'&&q.includes('ev-b')?{flexPlannedDispatches:null}:{flexPlannedDispatches:mode==='complete'?[slot()]:[]}})}));
 const deps={'../kraken/client':{getKrakenDevices:async()=>[{id:'ev-a',name:'A'},{id:'ev-b',name:'B'}],getKrakenVehicleStatus:async()=>({}),getKrakenPlannedDispatches:c.getKrakenPlannedDispatches},
 './kraken-state-store':{readLastKnownKrakenState:async()=>saved?{...saved,stale:true}:null,writeLastKnownKrakenState:async s=>{saved=structuredClone(s);writes++;}}};
 const boot=()=>load('src/lib/site/kraken-state.ts',deps,{Date:class extends Date{static now(){return now;}}});
 const state=boot(),first=await state.getKrakenState();assert.equal(writes,1);
 mode='incomplete';now+=60000;const stale=await state.getKrakenState();assert.equal(stale.stale,true);assert.equal(stale.lastSuccessfulUpdate,first.lastSuccessfulUpdate);assert.equal(writes,1);
 assert.equal(stale.vehicles[0].plannedDispatches.length,1);assert.equal(stale.vehicles[1].plannedDispatches.length,1);
 const restart=await boot().getKrakenState();assert.equal(restart.stale,true);assert.equal(restart.vehicles[1].id,'ev-b');
 mode='empty';now+=60000;const fresh=await state.getKrakenState();assert.equal(fresh.stale,false);assert.ok(fresh.vehicles.every(v=>v.plannedDispatches.length===0));assert.equal(writes,2);
 await state.getKrakenState();assert.equal(writes,2);
});
test('new incomplete snapshot with no prior evidence is unavailable, never an empty success',async()=>{
 const {c}=client({data:{flexPlannedDispatches:null}});
 const state=load('src/lib/site/kraken-state.ts',{'../kraken/client':{getKrakenDevices:async()=>[{id:'ev-a'}],getKrakenVehicleStatus:async()=>({}),getKrakenPlannedDispatches:c.getKrakenPlannedDispatches},'./kraken-state-store':{readLastKnownKrakenState:async()=>null,writeLastKnownKrakenState:async()=>assert.fail('must not write')}});
 await assert.rejects(state.getKrakenState(),/DISPATCH_FIELD_NULL/);
});

test('authentication failure is sanitized, attributed and does not attempt the dispatch query',async()=>{
 const {c,calls}=client({},true);const r=await c.getKrakenPlannedDispatchResponse('ev-a');
 assert.equal(r.status,'failed');assert.equal(r.code,'DISPATCH_RETRIEVAL_FAILED');assert.equal(r.deviceId,'ev-a');
 assert.equal(calls.length,1);assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('QA Proxy length substitution cannot manufacture a complete empty schedule',()=>{
 const target=[slot()];let lengthReads=0;
 const raw=new Proxy(target,{get(object,key,receiver){if(key==='length'){lengthReads++;return 0;}return Reflect.get(object,key,receiver);}});
 const result=parser.parseDispatchResponse({flexPlannedDispatches:raw});
 assert.equal(result.status,'complete');assert.equal(result.explicitlyEmpty,false);
 const list=parser.requireCompleteDispatches(result);assert.equal(list.length,1);assert.equal(list[0].type,'SMART');assert.equal(lengthReads,0);
 target[0].start='changed';assert.equal(list[0].start,slot().start);assert.equal(Object.isFrozen(target),false);
});
test('inconsistent length descriptors, sparse/accessor elements and extra array shapes fail closed',()=>{
 for(const value of [0,-1,1.5,NaN,'1',undefined]){
   const raw=new Proxy([slot()],{getOwnPropertyDescriptor(target,key){const d=Reflect.getOwnPropertyDescriptor(target,key);return key==='length'?{...d,value}:d;}});
   const r=parser.parseDispatchResponse({flexPlannedDispatches:raw});assert.equal(r.status,'incomplete');assert.throws(()=>parser.requireCompleteDispatches(r));
 }
 const accessor=[slot()];let invoked=0;Object.defineProperty(accessor,'0',{enumerable:true,get(){invoked++;return slot();}});
 const extra=[slot()];extra.other='unsupported';const symbol=[slot()];symbol[Symbol('extra')]=1;
 const hidden=[slot()];Object.defineProperty(hidden,'0',{enumerable:false});
 for(const raw of [accessor,extra,symbol,hidden,new Array(1),{0:slot(),length:1}])assert.equal(parser.parseDispatchResponse({flexPlannedDispatches:raw}).status,'incomplete');
 assert.equal(invoked,0);
});
test('missing or accessor length descriptors from hostile reflection fail closed',()=>{
 for(const descriptor of [undefined,{get(){return 0;},enumerable:false,configurable:false}]){
   const raw=new Proxy([slot()],{getOwnPropertyDescriptor(target,key){return key==='length'?descriptor:Reflect.getOwnPropertyDescriptor(target,key);}});
   assert.equal(parser.parseDispatchResponse({flexPlannedDispatches:raw}).status,'incomplete');
 }
});
