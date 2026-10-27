// Private transaction mechanics only: source instrumentation is not an application API.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadStore,input} from './helpers/ownership-sqlite-harness.mjs';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
const policy=(before=null,after=a)=>({version:1,expectedBefore:before,expectedAfter:after});
const available=snapshot=>({status:'available',snapshot});
async function fixture(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'exact-generation-'));try{await fn(path.join(dir,'ownership.sqlite'));}finally{await fs.rm(dir,{recursive:true,force:true});}}
test('explicit generations survive reopen; missing and stale preconditions fail',()=>fixture(file=>{
 const store=loadStore(),first=store.testCommitExact(file,input(),policy());
 assert.equal(first.status,'persisted');assert.equal(first.snapshot.generation,a);
 assert.equal(loadStore().readOwnership(file,'12345').snapshot.generation,a);
 assert.equal(store.testCommitExact(file,input('second'),policy()).status,'conflict');
 const next=input('next',available(first.snapshot));
 assert.equal(store.testCommitExact(file,next,policy(null,b)).status,'conflict');
 const saved=store.testCommitExact(file,next,policy(a,b));assert.equal(saved.status,'persisted');assert.equal(saved.snapshot.generation,b);
 assert.equal(store.testCommitExact(file,input('stale',available(first.snapshot)),policy(a,b)).status,'conflict');
 assert.equal(store.testCommitExact(file,input('duplicate-generation',available(saved.snapshot)),policy(b,a)).status,'conflict');
}));
test('exact replay rejects while V1 retains idempotence and random generation',()=>fixture(file=>{
 const store=loadStore(),i=input();assert.equal(store.testCommitExact(file,i,policy()).status,'persisted');
 assert.equal(store.testCommitExact(file,i,policy()).status,'conflict');
 return fixture(other=>{const saved=store.testCommit(other,i);assert.equal(saved.status,'persisted');assert.notEqual(saved.snapshot.generation,a);assert.equal(store.testCommit(other,i).status,'already-persisted');});
}));
test('history substitution and malformed generation policy reject',()=>fixture(file=>{
 const store=loadStore(),saved=store.testCommitExact(file,input(),policy()).snapshot;
 const changed=structuredClone(saved);changed.historyDigest='f'.repeat(64);
 assert.equal(store.testCommitExact(file,input('next',available(changed)),policy(a,b)).status,'conflict');
 for(const p of [null,undefined,policy(a,a),policy(a,'invalid'),{...policy(a,b),version:2},{...policy(a,b),extra:true}])
 assert.notEqual(store.testCommitExact(file,input('next',available(saved)),p).status,'persisted');
}));
test('competing connection cannot enter BEGIN IMMEDIATE',()=>fixture(file=>{
 const ordinary=loadStore();const saved=ordinary.testCommitExact(file,input(),policy()).snapshot;
 let competing;
 const store=loadStore({afterExec(sql){if(sql==='BEGIN IMMEDIATE')competing=ordinary.testCommitExact(file,input('competing',available(saved)),policy(a,b));}});
 assert.equal(store.testCommitExact(file,input('winner',available(saved)),policy(a,b)).status,'persisted');
 assert.equal(competing.code,'OWNERSHIP_STORE_BUSY');
}));
test('history insertion failure rolls back ownership and history together',()=>fixture(file=>{
 const ordinary=loadStore(),saved=ordinary.testCommitExact(file,input(),policy()).snapshot;
 const store=loadStore({beforeStatement(sql,key){if(sql.startsWith('INSERT INTO applied')&&key==='run')throw Error('injected failure');}});
 assert.equal(store.testCommitExact(file,input('next',available(saved)),policy(a,b)).status,'store-failed');
 assert.equal(ordinary.readOwnership(file,'12345').snapshot.generation,a);
 const db=new DatabaseSync(file);try{assert.equal(db.prepare('SELECT count(*) AS n FROM applied').get().n,1);}finally{db.close();}
}));
test('production source exposes neither transaction primitive nor policy selection',async()=>{
 const source=await fs.readFile('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
 assert.doesNotMatch(source,/export\s+(?:async\s+)?function\s+(?:commitOwnershipExact|ownershipTransaction|commitOwnership)\b/);
 const guarded=source.slice(source.indexOf('export async function persistConfirmedSmart'));
 assert.doesNotMatch(guarded,/commitOwnershipExact|ownershipTransaction/);
 assert.match(source,/return ownershipTransaction\(databasePath, input\);/);
});
