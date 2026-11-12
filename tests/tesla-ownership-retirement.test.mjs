import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadStore} from './helpers/ownership-sqlite-harness.mjs';
import {fixture} from './helpers/ownership-lifecycle.mjs';
import {persistenceFixture,seedDatabase,rehash as rehashPersistence} from './helpers/ownership-persistence.mjs';

if(process.versions.node!=='26.8.2')throw Error('OWNERSHIP_NODE_26_8_2_REQUIRED');

function retirementFixture(){
 const active=persistenceFixture('update'),terminal=persistenceFixture('restored'),restored=fixture('restored');
 const record=structuredClone(terminal.current),intent=restored.context.operations.at(-1).evidence.initial.intent;
 const current=active.current,last=current.lifecycle.applications.at(-1);
 return {active,context:structuredClone(restored.context),request:{version:1,site:'12345',operationId:intent.operationId,
  mutationId:intent.mutationId,expectedGeneration:current.lifecycle.generation,expectedCurrentRecordId:current.recordId,
  expectedCurrentLifecycleId:current.lifecycle.lifecycleId,expectedPredecessorApplicationId:last.applicationId,
  originalFingerprint:current.lifecycle.historicalOwnership.lifecycle.originalFingerprint,terminalRecord:record}};
}
async function sandbox(fn,hooks={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'hep-retire-'))),file=path.join(root,'ownership.sqlite');
 await fs.chmod(root,0o700);const f=retirementFixture();seedDatabase(file,f.active);await fs.chmod(file,0o600);
 const rows=(target=file)=>{const db=new DatabaseSync(target);try{return{ownership:db.prepare('SELECT * FROM ownership ORDER BY site').all(),
  history:db.prepare('SELECT * FROM applied ORDER BY site,mutation').all()};}finally{db.close();}};
 try{await fn({root,file,f,rows,store:loadStore(hooks)});}finally{await fs.chmod(root,0o700).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
}
function authority(h){return h.store.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);}
const falseFlags=['executionReady','writeReady','restorationProven','grantsAdmissionAuthority','grantsSuccessorAuthority',
 'grantsRepeatAuthority','releasesSiteClaim','closesOperation'];
function assertNoAuthority(result){for(const flag of falseFlags)assert.equal(result[flag],false,flag);}

test('valid trusted retirement atomically appends exactly one terminal record',()=>sandbox(async h=>{
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,authority(h),h.f.request),after=h.rows();
 assert.equal(result.status,'retired');assert.equal(result.recordId,h.f.request.terminalRecord.recordId);assertNoAuthority(result);
 assert.equal(after.ownership.length,before.ownership.length);assert.equal(after.history.length,before.history.length+1);
 assert.deepEqual(JSON.parse(after.ownership[0].snapshot),h.f.request.terminalRecord);
 const appended=after.history.find(row=>row.mutation===h.f.request.mutationId);
 assert.ok(appended);assert.deepEqual(JSON.parse(appended.record),h.f.request.terminalRecord);
}));

test('stale generation and corrupted predecessor history fail closed',()=>sandbox(async h=>{
 const capability=authority(h),db=new DatabaseSync(h.file),rows=db.prepare('SELECT mutation,record FROM applied WHERE site=? ORDER BY rowid').all('12345');
 const damaged=JSON.parse(rows.at(-1).record);damaged.lifecycle.applications.at(-1).predecessorApplicationId='a'.repeat(64);
 rehashPersistence(damaged);db.prepare('UPDATE applied SET record=? WHERE site=? AND mutation=?')
  .run(JSON.stringify(damaged),'12345',rows.at(-1).mutation);db.prepare('UPDATE ownership SET snapshot=? WHERE site=?')
  .run(JSON.stringify(damaged),'12345');db.close();
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.match(result.code,/^OWNERSHIP_/);assert.deepEqual(h.rows(),before);assertNoAuthority(result);
}));

test('wrong site operation mutation predecessor or original fingerprint cannot use the capability',()=>sandbox(async h=>{
 const before=h.rows();
 for(const [field,value] of [['site','99999'],['operationId','other-operation'],['mutationId','other-mutation'],
  ['expectedPredecessorApplicationId','a'.repeat(64)],['originalFingerprint','b'.repeat(64)]]){
  const request=structuredClone(h.f.request);request[field]=value;
  const result=h.store.retireConfirmedSmartOwnership(h.file,authority(h),request);
  assert.equal(result.status,'rejected',field);assert.equal(result.code,'OWNERSHIP_RETIREMENT_AUTHORITY_MISMATCH',field);
  assert.deepEqual(h.rows(),before,field);assertNoAuthority(result);
 }
}));

test('cross-database replay is rejected and consumes the capability',()=>sandbox(async h=>{
 const other=path.join(h.root,'other.sqlite');seedDatabase(other,h.f.active);await fs.chmod(other,0o600);
 const capability=authority(h),before=h.rows(),otherBefore=h.rows(other);
 const result=h.store.retireConfirmedSmartOwnership(other,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_STORE_MISMATCH');assertNoAuthority(result);
 assert.deepEqual(h.rows(),before);assert.deepEqual(h.rows(other),otherBefore);
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('capability is consumed after success and fresh-runtime replay is stopped by CAS',()=>sandbox(async h=>{
 const capability=authority(h),first=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(first.status,'retired');
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
 const fresh=loadStore(),next=fresh.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);
 const replay=fresh.retireConfirmedSmartOwnership(h.file,next,h.f.request);
 assert.equal(replay.status,'rejected');assert.match(replay.code,/^OWNERSHIP_/);assert.equal(h.rows().history.length,3);
}));

test('request accessors are rejected without invocation and consume authority',()=>sandbox(async h=>{
 const capability=authority(h),request=structuredClone(h.f.request);let invoked=0;
 Object.defineProperty(request,'operationId',{enumerable:true,get(){invoked++;return h.f.request.operationId;}});
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_INPUT_INVALID');assert.equal(invoked,0);
 assert.deepEqual(h.rows(),before);assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('proxy mutation during detachment is detected before transaction entry',()=>sandbox(async h=>{
 const capability=authority(h),target=structuredClone(h.f.request);let changed=false;
 const request=new Proxy(target,{ownKeys(value){if(!changed){changed=true;target.operationId='other-operation';}return Reflect.ownKeys(value);}});
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,request);
 assert.equal(changed,true);assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_AUTHORITY_MISMATCH');
 assert.deepEqual(h.rows(),before);assertNoAuthority(result);
}));

test('complete V3 history corruption is rejected before retirement',()=>sandbox(async h=>{
 const capability=authority(h),db=new DatabaseSync(h.file),rows=db.prepare('SELECT mutation,record FROM applied WHERE site=? ORDER BY rowid').all('12345');
 const damaged=JSON.parse(rows[0].record);damaged.approvedValidity.end='2026-10-24T15:59:00Z';
 db.prepare('UPDATE applied SET record=? WHERE site=? AND mutation=?').run(JSON.stringify(damaged),'12345',rows[0].mutation);db.close();
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.match(result.code,/^OWNERSHIP_/);assert.deepEqual(h.rows(),before);assertNoAuthority(result);
}));

test('failure after ownership update rolls back ownership and history',()=>sandbox(async h=>{
 const before=h.rows(),capability=authority(h),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_STORE_FAILED');assert.deepEqual(h.rows(),before);assertNoAuthority(result);
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
},{beforeStatement(sql,method){if(method==='run'&&sql.startsWith('INSERT INTO applied'))throw Error('INJECTED');}}));

test('lost commit acknowledgement is indeterminate and replay-safe',()=>sandbox(async h=>{
 const capability=authority(h),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'indeterminate');assert.equal(result.code,'OWNERSHIP_PERSISTENCE_INDETERMINATE');assertNoAuthority(result);
 assert.equal(h.rows().history.length,3);assert.equal(JSON.parse(h.rows().ownership[0].snapshot).lifecycle.state,'restored');
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
},{afterExec(sql){if(sql==='COMMIT')throw Error('COMMIT_ACK_LOST');}}));

test('lost close acknowledgement is indeterminate and cannot be replayed',()=>sandbox(async h=>{
 const capability=authority(h),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'indeterminate');assertNoAuthority(result);assert.equal(h.rows().history.length,3);
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
},{afterClose(){throw Error('CLOSE_ACK_LOST');}}));

test('restart sees complete pre-transaction state after rollback and permits separately trusted retry',()=>sandbox(async h=>{
 const before=h.rows(),first=h.store.retireConfirmedSmartOwnership(h.file,authority(h),h.f.request);
 assert.equal(first.status,'rejected');assert.deepEqual(h.rows(),before);
 const fresh=loadStore(),capability=fresh.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);
 const second=fresh.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(second.status,'retired');assert.equal(h.rows().history.length,3);
},{beforeStatement(sql,method,db){if(method==='run'&&sql.startsWith('INSERT INTO applied')&&!db.injected){db.injected=true;throw Error('ONCE');}}}));

test('unrelated site remains byte-for-byte unchanged',()=>sandbox(async h=>{
 const db=new DatabaseSync(h.file),unrelated='{"independent":"unchanged"}';
 db.prepare('INSERT INTO ownership(site,snapshot) VALUES(?,?)').run('99999',unrelated);db.close();
 const result=h.store.retireConfirmedSmartOwnership(h.file,authority(h),h.f.request);
 assert.equal(result.status,'retired');assert.equal(h.rows().ownership.find(row=>row.site==='99999').snapshot,unrelated);
}));

test('private directory file and umask prerequisites fail closed without repair',()=>sandbox(async h=>{
 for(const target of ['directory','file']){
  if(target==='directory')await fs.chmod(h.root,0o755);else await fs.chmod(h.file,0o644);
  assert.throws(()=>authority(h),/OWNERSHIP_RETIREMENT_STORE_INVALID/,target);
  if(target==='directory')await fs.chmod(h.root,0o700);else await fs.chmod(h.file,0o600);
 }
 const unsafe=loadStore({umask:0o022});
 assert.throws(()=>unsafe.testTrustTerminalRestoration(h.file,h.f.request,h.f.context),/OWNERSHIP_RETIREMENT_STORE_INVALID/);
 assert.equal((syncFs.statSync(h.root).mode&0o777),0o700);assert.equal((syncFs.statSync(h.file).mode&0o777),0o600);
}));

test('WAL mode and SHM storage are rejected',()=>sandbox(async h=>{
 const capability=authority(h),db=new DatabaseSync(h.file);assert.equal(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode,'wal');db.close();
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.match(result.code,/^OWNERSHIP_/);assert.deepEqual(h.rows(),before);assertNoAuthority(result);
}));

test('same-privilege substitution is documented outside scope and no production issuer exists',async()=>{
 const source=await fs.readFile('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
 const documentation=await fs.readFile('docs/tesla-ownership-trusted-store.md','utf8');
 assert.match(source,/not a\s+\/\/ defence against a hostile process with equivalent filesystem access/);
 assert.match(documentation,/outside this personal\s+deployment's threat model/);
 assert.doesNotMatch(source,/export\s+(?:async\s+)?function\s+trustTerminalRestoration/);
 assert.match(documentation,/does not\s+release a site claim, close an operation, admit a successor or grant Tesla/);
});
