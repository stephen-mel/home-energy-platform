import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';
function load(file,deps={},globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,console:{error(){}},require:n=>{assert.ok(Object.hasOwn(deps,n),n);return deps[n];},...globals});return exports;}
const decimal=load('src/lib/tariff/economic-decimal.ts');
const resolver=load('src/lib/tariff/resolve-economic-model.ts',{'./economic-decimal':decimal});
const parser=load('src/lib/kraken/dispatch-response.ts',{'../tariff/resolve-economic-model':resolver});
const slot=()=>({start:'2026-10-25T01:00:00+01:00',end:'2026-10-25T01:30:00+00:00',type:'SMART',energyAddedKwh:'-2.3000'});
function client(response,authFailure=false){const calls=[];const c=load('src/lib/kraken/client.ts',{'./dispatch-response':parser,'node:crypto':crypto},{process:{env:{EON_EMAIL:'synthetic',EON_PASSWORD:'synthetic'}},fetch:async(url,init)=>{
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
test('authentication failure is sanitized, attributed and does not attempt the dispatch query',async()=>{
 const {c,calls}=client({},true);const r=await c.getKrakenPlannedDispatchResponse('ev-a');
 assert.equal(r.status,'failed');assert.equal(r.code,'DISPATCH_RETRIEVAL_FAILED');assert.equal(r.deviceId,'ev-a');
 assert.equal(calls.length,1);assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('missing credentials return the typed dispatch failure without rejecting',async()=>{
 const calls=[];const c=load('src/lib/kraken/client.ts',{'./dispatch-response':parser,'node:crypto':crypto},{
   process:{env:{EON_ACCOUNT:'synthetic-account'}},fetch:async()=>{calls.push('unexpected');throw Error('must not fetch');}
 });
 const result=await c.getKrakenPlannedDispatchResponse('ev-missing-auth');
 assert.deepEqual(JSON.parse(JSON.stringify(result)),{
   status:'failed',code:'DISPATCH_RETRIEVAL_FAILED',deviceId:'ev-missing-auth',
 });
 assert.equal(calls.length,0);
});

test('one read session captures account and authentication configuration without exposing raw identity',async()=>{
 const env={EON_EMAIL:'first@example.invalid',EON_PASSWORD:'first-secret',EON_ACCOUNT:'account-first'},calls=[];
 const c=load('src/lib/kraken/client.ts',{'./dispatch-response':parser,'node:crypto':crypto},{process:{env},fetch:async(_url,init)=>{
   const q=JSON.parse(init.body).query;calls.push(q);
   if(q.includes('obtainKrakenToken'))return {ok:true,json:async()=>({data:{obtainKrakenToken:{token:'token'}}})};
   if(q.includes('flexPlannedDispatches'))return {ok:true,json:async()=>({data:{flexPlannedDispatches:[]}})};
   if(q.includes('status'))return {ok:true,json:async()=>({data:{devices:[{status:{currentState:null,isSuspended:null,stateOfCharge:null,activePower:null}}]}})};
   return {ok:true,json:async()=>({data:{devices:[]}})};
 }});
 const session=c.createKrakenReadSession();env.EON_EMAIL='second@example.invalid';env.EON_PASSWORD='second-secret';env.EON_ACCOUNT='account-second';
 await session.getDevices();await session.getVehicleStatus('ev-a');await session.getPlannedDispatchResponse('ev-a');
 assert.equal(JSON.stringify(session).includes('account-first'),false);assert.equal(JSON.stringify(session).includes('first-secret'),false);
 assert.ok(calls.filter(q=>q.includes('obtainKrakenToken')).every(q=>q.includes('first@example.invalid')&&q.includes('first-secret')));
 assert.ok(calls.filter(q=>q.includes('accountNumber')).every(q=>q.includes('account-first')&&!q.includes('account-second')));
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
