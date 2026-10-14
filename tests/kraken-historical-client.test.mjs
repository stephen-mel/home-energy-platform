import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('one read session authenticates once and traverses bounded cursor pages without loss',async()=>{
 const source=ts.transpileModule(fs.readFileSync('src/lib/kraken/client.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};let auth=0;const calls=[];
 const response=data=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({data})});
 const fetch=async(_url,init)=>{const {query}=JSON.parse(init.body);calls.push(query);
  if(query.includes('obtainKrakenToken')){auth++;return response({obtainKrakenToken:{token:'secret'}})}
  if(query.includes('devices(accountNumber'))return response({devices:[]});
  if(query.includes('electricityAgreements(active: true) { meterPoint'))return response({account:{electricityAgreements:[{meterPoint:{mpan:'mpan-a',direction:'IMPORT'}}]}});
  if(query.includes('applicableRates')){const second=query.includes('after:');return response({applicableRates:{
    edges:[{cursor:second?'b':'a',node:{value:second?'23.97800':'2.85000',validFrom:second?'2026-10-14T05:00:00Z':'2026-10-14T04:30:00Z',validTo:second?'2026-10-14T05:30:00Z':'2026-10-14T05:00:00Z'}}],
    pageInfo:{hasNextPage:!second,endCursor:second?'b':'a'},totalCount:2,edgeCount:1}})};
  throw Error('unexpected query');};
 const process={env:{EON_EMAIL:'email',EON_PASSWORD:'password',EON_ACCOUNT:'account'},cwd:()=>'/tmp'};
 vm.runInNewContext(source,{exports,fetch,process,JSON,Object,Array,Number,String,Boolean,Date,Error,Set,Promise,structuredClone,
  AbortSignal,require(name){if(name==='node:crypto')return awaitImportCrypto;if(name==='./dispatch-response')return {parseDispatchResponse(){},requireCompleteDispatches(){}};throw Error(name)}});
 const session=exports.createKrakenReadSession();
 const [devices,rates]=await Promise.all([session.getDevices(),session.getHistoricalImportRates({start:'2026-10-14T04:30:00Z',end:'2026-10-14T05:30:00Z'})]);
 assert.equal(auth,1);assert.equal(devices.length,0);assert.equal(rates.complete,true);assert.equal(rates.edges.length,2);
 assert.ok(calls.filter(q=>q.includes('applicableRates')).length===2);
});

const awaitImportCrypto={createHash(){return {update(){return this},digest(){return 'meter-ref'}}}};
