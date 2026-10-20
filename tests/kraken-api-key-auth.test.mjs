import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';

const source=ts.transpileModule(fs.readFileSync('src/lib/kraken/client.ts','utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const parser={parseDispatchResponse:value=>({status:'complete',dispatches:value.flexPlannedDispatches,explicitlyEmpty:!value.flexPlannedDispatches.length}),
 requireCompleteDispatches:value=>value.dispatches};
const response=data=>({ok:true,status:200,text:async()=>'',json:async()=>({data})});
const validJwt='eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.c2ln';
function failureResponse(kind){
 if(kind==='http')return {ok:false,status:401,text:async()=> 'PRIVATE_RESPONSE_MARKER'};
 if(kind==='graphql')return {ok:true,status:200,json:async()=>({errors:[{message:'PRIVATE_RESPONSE_MARKER'}]})};
 if(kind==='json')return {ok:true,status:200,json:async()=>{throw Error('PRIVATE_RESPONSE_MARKER')}};
 return null;
}
function harness(env,auth='success',read='success'){
 const calls=[];const exports={};
 const fetch=async(_url,init)=>{const query=JSON.parse(init.body).query,authorization=init.headers.Authorization??null;
  calls.push({query,authorization});
  if(query.includes('obtainKrakenToken')){
   if(auth==='transport')throw Error('PRIVATE_RESPONSE_MARKER');
   if(auth.startsWith('unsafe:'))return {ok:true,status:200,json:async()=>{
    const unsafe=Error('placeholder');
    if(auth==='unsafe:getter')Object.defineProperty(unsafe,'message',{get(){throw Error('PRIVATE_GETTER_MARKER')}});
    if(auth==='unsafe:object')Object.defineProperty(unsafe,'message',{value:{toString(){throw Error('PRIVATE_COERCION_MARKER')}}});
    if(auth==='unsafe:changing'){let reads=0;Object.defineProperty(unsafe,'message',{
     get(){return reads++===0?'KRAKEN_HTTP_FAILURE':'constructor'}})}
    return Object.defineProperty({},'data',{get(){throw unsafe}});
   }};
   if(auth.startsWith('unexpected:'))return {ok:true,status:200,json:async()=>Object.defineProperty({},'data',{
    get(){throw Error(auth.slice('unexpected:'.length))}})};
   if(auth==='unknown')return {ok:true,status:200,json:async()=>Object.defineProperty({},'data',{
    get(){throw Error('PRIVATE_RESPONSE_MARKER')}})};
   const failed=failureResponse(auth);if(failed)return failed;
   if(auth==='missing')return response({obtainKrakenToken:{}});
   if(auth==='equal')return response({obtainKrakenToken:{token:env.EON_KRAKEN_API_KEY}});
   if(auth==='malformed')return response({obtainKrakenToken:{token:'not-a-jwt'}});
   return response({obtainKrakenToken:{token:validJwt}});
  }
  if(read==='transport')throw Error('PRIVATE_RESPONSE_MARKER');
  const failed=failureResponse(read);if(failed)return failed;
  if(query.includes('flexPlannedDispatches'))return response({flexPlannedDispatches:[]});
  if(query.includes('status'))return response({devices:[{status:{currentState:null,isSuspended:null,stateOfCharge:null,activePower:null}}]});
  if(query.includes('electricityAgreements'))return response({account:{electricityAgreements:[]}});
  return response({devices:[]});
 };
 vm.runInNewContext(source,{exports,fetch,process:{env},JSON,Object,Array,Number,String,Boolean,Date,Error,Set,Promise,
  structuredClone,require(name){if(name==='node:crypto')return crypto;if(name==='./dispatch-response')return parser;throw Error(name)}});
 return {api:exports,calls};
}

test('configured API key is exchanged once and only the returned JWT authenticates reads',async()=>{
 const env={EON_KRAKEN_API_KEY:'synthetic-api-key',EON_EMAIL:'legacy@example.invalid',EON_PASSWORD:'legacy-secret',
  EON_ACCOUNT:'import-account',EON_EXPORT_ACCOUNT:'export-account'};
 const {api,calls}=harness(env),session=api.createKrakenReadSession();
 await Promise.all([session.getDevices(),session.getImportTariff(),session.getExportTariff(),session.getVehicleStatus('ev'),session.getPlannedDispatchResponse('ev')]);
 const auth=calls.filter(call=>call.query.includes('obtainKrakenToken'));
 assert.equal(auth.length,1);assert.equal(auth[0].authorization,null);
 assert.match(auth[0].query,/APIKey:\s*"synthetic-api-key"/);
 assert.doesNotMatch(auth[0].query,/email:|password:|legacy@example|legacy-secret/);
 const reads=calls.filter(call=>!call.query.includes('obtainKrakenToken'));
 assert.ok(reads.length>=5);assert.ok(reads.every(call=>call.authorization===`JWT ${validJwt}`));
 assert.ok(reads.every(call=>!call.authorization.includes('synthetic-api-key')));
 assert.ok(reads.some(call=>call.query.includes('import-account')));
 assert.ok(reads.some(call=>call.query.includes('export-account')));
 assert.equal(JSON.stringify(session).includes('synthetic-api-key'),false);
 assert.equal('setKrakenVehiclePreferences' in session,false);
});

test('malformed configured API keys fail before transport without legacy fallback',()=>{
 for(const apiKey of ['', ' padded-key ', 'line\nbreak']){
  const {api,calls}=harness({EON_KRAKEN_API_KEY:apiKey,EON_EMAIL:'legacy@example.invalid',EON_PASSWORD:'legacy-secret',EON_ACCOUNT:'account'});
  assert.throws(()=>api.createKrakenReadSession(),/^Error: KRAKEN_API_KEY_INVALID$/);assert.equal(calls.length,0);
 }
});

test('API-key exchange failures retain fixed stages without fallback, retry or private content',async()=>{
 const expected={transport:'KRAKEN_AUTH_TRANSPORT_FAILURE',http:'KRAKEN_AUTH_HTTP_FAILURE',
  graphql:'KRAKEN_AUTH_GRAPHQL_REJECTED',json:'KRAKEN_AUTH_RESPONSE_INVALID',
  missing:'KRAKEN_AUTH_RESPONSE_INVALID',malformed:'KRAKEN_AUTH_TOKEN_INVALID',
  unknown:'KRAKEN_AUTHENTICATION_FAILED'};
 for(const [failure,code] of Object.entries(expected)){const {api,calls}=harness({EON_KRAKEN_API_KEY:'private-api-key',
  EON_EMAIL:'legacy@example.invalid',EON_PASSWORD:'legacy-secret',EON_ACCOUNT:'account'},failure);
  const session=api.createKrakenReadSession();
  await assert.rejects(session.getDevices(),error=>error.message===code
   && !error.message.includes('private-api-key')&&!error.message.includes('PRIVATE'));
  assert.equal(calls.length,1);assert.match(calls[0].query,/APIKey:/);assert.doesNotMatch(calls[0].query,/email:|password:/);
 }
});

test('inherited and unknown exception messages cannot select outward authentication codes',async()=>{
 const permitted=new Set(['KRAKEN_AUTH_TRANSPORT_FAILURE','KRAKEN_AUTH_HTTP_FAILURE',
  'KRAKEN_AUTH_GRAPHQL_REJECTED','KRAKEN_AUTH_RESPONSE_INVALID','KRAKEN_AUTH_TOKEN_INVALID',
  'KRAKEN_AUTHENTICATION_FAILED']);
 for(const message of ['constructor','toString','__proto__','private-marker']){
  const {api,calls}=harness({EON_KRAKEN_API_KEY:'private-api-key',EON_ACCOUNT:'account'},`unexpected:${message}`);
  await assert.rejects(api.createKrakenReadSession().getDevices(),error=>
   typeof error.message==='string'&&error.message==='KRAKEN_AUTHENTICATION_FAILED'
   &&permitted.has(error.message)&&!error.message.includes(message));
  assert.equal(calls.length,1);
 }
});

test('unsafe exception message metadata always becomes the primitive generic authentication code',async()=>{
 for(const scenario of ['getter','object','changing']){
  const {api,calls}=harness({EON_KRAKEN_API_KEY:'private-api-key',EON_ACCOUNT:'account'},`unsafe:${scenario}`);
  await assert.rejects(api.createKrakenReadSession().getDevices(),error=>
   typeof error.message==='string'&&error.message==='KRAKEN_AUTHENTICATION_FAILED'
   &&!error.message.includes('PRIVATE')&&!error.message.includes('constructor'));
  assert.equal(calls.length,1);
 }
});

test('a valid-shaped returned token identical to the configured API key is rejected',async()=>{
 const {api,calls}=harness({EON_KRAKEN_API_KEY:validJwt,EON_EMAIL:'legacy@example.invalid',
  EON_PASSWORD:'legacy-secret',EON_ACCOUNT:'account'},'equal');
 await assert.rejects(api.createKrakenReadSession().getDevices(),/^Error: KRAKEN_AUTH_TOKEN_INVALID$/);
 assert.equal(calls.length,1);assert.match(calls[0].query,/APIKey:/);assert.doesNotMatch(calls[0].query,/email:|password:/);
});

test('shared transport exposes fixed categories without upstream private content',async()=>{
 const expected={transport:'KRAKEN_TRANSPORT_FAILURE',http:'KRAKEN_HTTP_FAILURE',
  graphql:'KRAKEN_GRAPHQL_REJECTED',json:'KRAKEN_RESPONSE_INVALID'};
 for(const [failure,code] of Object.entries(expected)){
  const {api,calls}=harness({EON_KRAKEN_API_KEY:'private-api-key',EON_ACCOUNT:'account'},'success',failure);
  await assert.rejects(api.createKrakenReadSession().getDevices(),error=>error.message===code
   && !error.message.includes('PRIVATE_RESPONSE_MARKER')&&!error.message.includes('private-api-key'));
  assert.equal(calls.length,2);assert.equal(calls.filter(call=>call.query.includes('obtainKrakenToken')).length,1);
 }
});

test('absent API key preserves the legacy exchange during migration',async()=>{
 const {api,calls}=harness({EON_EMAIL:'legacy@example.invalid',EON_PASSWORD:'legacy-secret',EON_ACCOUNT:'account'});
 await api.createKrakenReadSession().getDevices();assert.equal(calls.length,2);
 assert.match(calls[0].query,/email:\s*"legacy@example.invalid"/);assert.match(calls[0].query,/password:\s*"legacy-secret"/);
 assert.doesNotMatch(calls[0].query,/APIKey:/);assert.equal(calls[1].authorization,`JWT ${validJwt}`);
});
