import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {closedOfflineV2} from './helpers/closed-offline-v2.mjs';
import {loadStore,input} from './helpers/ownership-sqlite-harness.mjs';
import {seedJournal,persistenceFixture} from './helpers/ownership-persistence.mjs';
import {hash,key,mapIdentity,document} from './helpers/ownership-lifecycle.mjs';
const harness=await closedOfflineV2();
let mapped;
try{mapped=await harness.mapLifecycle();}finally{await harness.close();}
const generation=()=>({version:1,expectedBefore:null,expectedAfter:mapped.lifecycle.generation});
async function sandbox(fn){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'c5b-')));
 const file=path.join(root,'ownership','ownership.sqlite'),directory=path.join(root,'tesla-experiments');
 await fs.mkdir(path.dirname(file));
 const db=new DatabaseSync(file);
 db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 CREATE TABLE ownership(site TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
 CREATE TABLE applied(site TEXT NOT NULL REFERENCES ownership(site), mutation TEXT NOT NULL, issuance TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(site,mutation), UNIQUE(site,issuance)) STRICT;
 PRAGMA user_version=2; COMMIT;`);db.close();
 await seedJournal(directory,{journal:mapped.journal});
 const commit=(store=loadStore(),record=structuredClone(mapped.record),context=structuredClone(mapped.context),approved=generation())=>
  store.testCommitOfflineOwnership(file,record,context,approved);
 const rows=()=>{const db=new DatabaseSync(file);try{return{
  ownership:db.prepare('SELECT * FROM ownership').all(),history:db.prepare('SELECT * FROM applied').all()};}finally{db.close();}};
 try{await fn({root,file,directory,commit,rows});}finally{await fs.rm(root,{recursive:true,force:true});}
}
function empty(rows){assert.equal(rows.ownership.length,0);assert.equal(rows.history.length,0);}
function rehash(record){
 const a=record.lifecycle.applications[0],e=mapped.journal.records[0];
 record.lifecycle=document(record.lifecycle.historicalOwnership,[mapIdentity(e,a.runtime,a.retainedOriginKey,null)]);
 const {recordId,...body}=record;void recordId;record.recordId=hash({purpose:'smart-ownership-persistence-v1',...body});
}
test('versioned offline rows and V2 retained journal commit together at the approved exact generation',()=>sandbox(async f=>{
 const store=loadStore(),result=await f.commit(store);assert.equal(result.status,'persisted-offline',result.code);
 assert.equal(result.mode,'offline-test-only');assert.equal(result.identityProvenance,'unverified');
 for(const flag of ['executionReady','writeReady','runtimeConfirmationVerified','grantsAdmissionAuthority','grantsSuccessorAuthority','grantsRestorationAuthority'])assert.equal(result[flag],false);
 const rows=f.rows();assert.equal(rows.ownership.length,1);assert.equal(rows.history.length,1);
 assert.equal(key(JSON.parse(rows.ownership[0].snapshot)),key(mapped.record));assert.equal(key(JSON.parse(rows.history[0].record)),key(mapped.record));
 assert.equal(result.snapshot.lifecycle.generation,generation().expectedAfter);
 assert.equal(key(result.snapshot.lifecycle.historicalOwnership.lifecycle.original),key(mapped.projection.retainedOriginal.original));
 assert.equal(key(result.snapshot.approvedValidity),key(mapped.projection.approvedValidity));
 const c=store.load('src/lib/tesla-tariff/ownership-persistence.ts');
 assert.equal(c.testValidateOfflinePersistence(result.snapshot,[result.snapshot],'12345','Europe/London',mapped.journal,mapped.context).status,'validated');
 assert.equal(c.validatePersistedOwnershipHistory(result.snapshot,[result.snapshot],'12345','Europe/London',mapped.journal).status,'rejected');
 const e=mapped.journal.records[0],issuer=store.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
 assert.equal(issuer.issueConfirmedSmartReceipt(result,e.initial,e.completion).status,'rejected');
}));
for(const [name,edit] of [
 ['missing completion',async f=>{const names=await fs.readdir(f.directory);await fs.unlink(path.join(f.directory,names.find(n=>n.endsWith('.complete'))));}],
 ['missing journal',async f=>{const names=await fs.readdir(f.directory);await fs.unlink(path.join(f.directory,names.find(n=>n.endsWith('.jsonl'))));}],
 ['substituted valid journal',async f=>{await fs.rm(f.directory,{recursive:true});await seedJournal(f.directory,persistenceFixture('apply'));}],
 ['truncated journal',async f=>{const names=await fs.readdir(f.directory);await fs.appendFile(path.join(f.directory,names.find(n=>n.endsWith('.jsonl'))),'{');}],
 ['ambiguous active claim',f=>fs.writeFile(path.join(f.directory,'site-12345-attempt.active'),'pending')],
])test(`${name} blocks atomically`,()=>sandbox(async f=>{await edit(f);assert.notEqual((await f.commit()).status,'persisted-offline');empty(f.rows());}));
for(const [name,edit] of [
 ['wrong after generation',(r,c,g)=>{g.expectedAfter='00000000-0000-8000-8000-000000000000';}],
 ['stale before generation',(r,c,g)=>{g.expectedBefore=g.expectedAfter;}],
 ['conflicting predecessor',(r,c)=>{c.previousLifecycle=mapped.lifecycle;}],
 ['wrong timezone',(r,c)=>{c.timeZone='UTC';}],
 ['altered original lineage',r=>{r.lifecycle.historicalOwnership.lifecycle.original.tariff.name='substituted';rehash(r);}],
 ['rehashed offline receipt substitution',r=>{r.lifecycle.applications[0].runtime.receiptKey=hash('substituted');rehash(r);}],
 ['rehashed production relabelling',r=>{const runtime=r.lifecycle.applications[0].runtime;delete runtime.admissionKey;delete runtime.simulatedCompletionKey;runtime.namespace='runtime-confirmed-operation';runtime.receiptVersion=2;r.kind='v3-ownership-persistence';rehash(r);}],
])test(`${name} rejects without partial rows`,()=>sandbox(async f=>{
 const r=structuredClone(mapped.record),c=structuredClone(mapped.context),g=generation();edit(r,c,g);
 assert.notEqual((await f.commit(loadStore(),r,c,g)).status,'persisted-offline');empty(f.rows());
}));
test('replay, duplicate generation and existing ownership never overwrite committed rows',()=>sandbox(async f=>{
 assert.equal((await f.commit()).status,'persisted-offline');const before=f.rows();
 assert.equal((await f.commit()).status,'conflict');
 const g=generation();g.expectedAfter='00000000-0000-8000-8000-000000000000';
 assert.notEqual((await f.commit(loadStore(),structuredClone(mapped.record),structuredClone(mapped.context),g)).status,'persisted-offline');
 assert.deepEqual(f.rows(),before);
}));
test('existing legacy ownership is not treated as an absent first apply',()=>sandbox(async f=>{
 const store=loadStore();assert.equal(store.testCommit(f.file,input()).status,'persisted');const before=f.rows();
 assert.equal((await f.commit(store)).status,'conflict');assert.deepEqual(f.rows(),before);
}));
for(const phase of ['before-history','before-commit'])test(`${phase} failure rolls back both table writes`,()=>sandbox(async f=>{
 const store=loadStore({beforeStatement(sql,method){if(phase==='before-history'&&sql.startsWith('INSERT INTO applied')&&method==='run')throw Error('INJECTED');},
 beforeExec(sql){if(phase==='before-commit'&&sql==='COMMIT')throw Error('INJECTED');}});
 assert.notEqual((await f.commit(store)).status,'persisted-offline');empty(f.rows());
}));
test('journal loss after both INSERTs rolls back both tables',()=>sandbox(async f=>{
 let removed=false;
 const store=loadStore({afterStatement(sql,method){if(!removed&&sql.startsWith('INSERT INTO applied')&&method==='run'){
  removed=true;const name=syncFs.readdirSync(f.directory).find(n=>n.endsWith('.complete'));syncFs.unlinkSync(path.join(f.directory,name));
 }}});
 assert.equal((await f.commit(store)).code,'OWNERSHIP_OFFLINE_JOURNAL_CHANGED');assert.equal(removed,true);empty(f.rows());
}));
test('concurrent transactions exclude a second first apply while asynchronous V2 verification holds the lock',()=>sandbox(async f=>{
 const results=await Promise.all([f.commit(),f.commit()]);
 assert.equal(results.filter(r=>r.status==='persisted-offline').length,1);
 assert.equal(results.filter(r=>r.code==='OWNERSHIP_STORE_BUSY').length,1);
 assert.equal(f.rows().ownership.length,1);assert.equal(f.rows().history.length,1);
}));
test('application exports expose no offline or raw transaction entry point',async()=>{
 const source=await fs.readFile('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
 assert.doesNotMatch(source,/export\s+(?:async\s+)?function\s+(?:testCommitOfflineOwnership|ownershipDatabaseTransaction|writeOwnershipPair|commitOwnershipExact)/);
 assert.doesNotMatch(source,/testCommitOfflineOwnership|offlineTransactionSource/);
});
