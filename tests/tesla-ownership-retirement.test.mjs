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
 const f=retirementFixture();seedDatabase(file,f.active);
 const rows=()=>{const db=new DatabaseSync(file);try{return{ownership:db.prepare('SELECT * FROM ownership ORDER BY site').all(),
  history:db.prepare('SELECT * FROM applied ORDER BY site,mutation').all()};}finally{db.close();}};
 try{await fn({root,file,f,rows,store:loadStore(hooks)});}finally{await fs.rm(root,{recursive:true,force:true});}
}
function authority(h){return h.store.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);}

test('valid trusted retirement remains unavailable without opened-connection identity',()=>sandbox(async h=>{
 const before=h.rows();
 const result=h.store.retireConfirmedSmartOwnership(h.file,authority(h),h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 for(const flag of ['executionReady','writeReady','restorationProven','grantsAdmissionAuthority','grantsSuccessorAuthority',
  'grantsRepeatAuthority','releasesSiteClaim','closesOperation'])assert.equal(result[flag],false,flag);
 assert.deepEqual(h.rows(),before);
}));

test('stale generation and changed ownership remain unchanged while retirement is unavailable',()=>sandbox(async h=>{
 const capability=authority(h),before=h.rows(),older=h.f.active.records[0];
 const db=new DatabaseSync(h.file);db.exec('BEGIN IMMEDIATE');
 db.prepare('DELETE FROM applied WHERE site=? AND mutation=?').run('12345',h.f.active.records[1].lifecycle.applications.at(-1).mutationId);
 db.prepare('UPDATE ownership SET snapshot=? WHERE site=?').run(JSON.stringify(older),'12345');db.exec('COMMIT');db.close();
 const changed=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 assert.deepEqual(h.rows(),changed);assert.notDeepEqual(changed,before);
}));

test('wrong site mutation predecessor baseline or operation cannot substitute for the authorised request',()=>sandbox(async h=>{
 const before=h.rows();
 for(const [field,value] of [['site','99999'],['mutationId','other-mutation'],['operationId','other-operation'],
  ['expectedPredecessorApplicationId','a'.repeat(64)],['originalFingerprint','b'.repeat(64)]]){
  const capability=authority(h);
  const request=structuredClone(h.f.request);request[field]=value;
  const result=h.store.retireConfirmedSmartOwnership(h.file,capability,request);
  assert.equal(result.status,'rejected',field);assert.equal(result.code,'OWNERSHIP_RETIREMENT_AUTHORITY_MISMATCH',field);
  assert.deepEqual(h.rows(),before,field);
 }
}));

test('retirement capability is single-use across repeated calls and fresh runtimes',()=>sandbox(async h=>{
 const before=h.rows(),once=authority(h),first=h.store.retireConfirmedSmartOwnership(h.file,once,h.f.request);
 assert.equal(first.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,once,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
 const fresh=loadStore(),capability=fresh.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);
 const replay=fresh.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(replay.status,'rejected');assert.equal(replay.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');assert.deepEqual(h.rows(),before);
}));

test('capability is bound to one physical store and consumed by cross-database or alias replay',()=>sandbox(async h=>{
 for(const target of ['second-database','symlink-alias','hard-link','replaced-database']){
  const capability=authority(h),other=path.join(h.root,target+'.sqlite');
  let attempted=other;
  if(target==='second-database')seedDatabase(other,h.f.active);
  else if(target==='symlink-alias')await fs.symlink(h.file,other);
  else if(target==='hard-link')await fs.link(h.file,other);
  else {await fs.rename(h.file,other);seedDatabase(h.file,h.f.active);attempted=h.file;}
  const result=h.store.retireConfirmedSmartOwnership(attempted,capability,h.f.request);
  assert.equal(result.status,'rejected',target);assert.equal(result.code,'OWNERSHIP_RETIREMENT_STORE_MISMATCH',target);
  assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED',target);
 }
 assert.equal(JSON.parse(h.rows().ownership[0].snapshot).lifecycle.state,'active');
}));

test('normalised lexical path to the same physical store is accepted once and then consumed',()=>sandbox(async h=>{
 const capability=authority(h),alias=path.join(h.root,'.','ownership.sqlite');
 assert.equal(h.store.retireConfirmedSmartOwnership(alias,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('request accessors are rejected without invocation before store identity is trusted',()=>sandbox(async h=>{
 const capability=authority(h),request=structuredClone(h.f.request);let invoked=0;
 Object.defineProperty(request,'operationId',{enumerable:true,get(){invoked++;syncFs.renameSync(h.file,h.file+'.original');
  seedDatabase(h.file,h.f.active);return h.f.request.operationId;}});
 const before=h.rows(),result=h.store.retireConfirmedSmartOwnership(h.file,capability,request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_INPUT_INVALID');assert.equal(invoked,0);
 assert.deepEqual(h.rows(),before);assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('proxy filesystem mutation during detachment is detected by the subsequent physical-store check',()=>sandbox(async h=>{
 const capability=authority(h),target=structuredClone(h.f.request),original=h.file+'.original';let replaced=false;
 const request=new Proxy(target,{ownKeys(value){if(!replaced){replaced=true;syncFs.renameSync(h.file,original);seedDatabase(h.file,h.f.active);}return Reflect.ownKeys(value);}});
 const result=h.store.retireConfirmedSmartOwnership(h.file,capability,request);
 assert.equal(replaced,true);assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_STORE_MISMATCH');
 for(const file of [original,h.file]){const db=new DatabaseSync(file);try{
  const current=JSON.parse(db.prepare('SELECT snapshot FROM ownership WHERE site=?').get('12345').snapshot);
  assert.equal(current.lifecycle.state,'active');assert.equal(db.prepare('SELECT * FROM applied WHERE site=?').all('12345').length,h.f.active.records.length);
 }finally{db.close();}}
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('open-boundary substitution cannot run because operational retirement never opens SQLite',()=>sandbox(async h=>{
 const original=h.file+'.original';let opened=false;
 const store=loadStore({beforeDatabaseOpen(){opened=true;syncFs.renameSync(h.file,original);seedDatabase(h.file,h.f.active);
  syncFs.renameSync(h.file,h.file+'.replacement');syncFs.renameSync(original,h.file);}});
 const before=h.rows(),capability=store.testTrustTerminalRestoration(h.file,h.f.request,h.f.context);
 const result=store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');assert.equal(opened,false);
 assert.deepEqual(h.rows(),before);assert.equal(store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
}));

test('retirement blocker prevents transaction entry and preserves both tables',()=>sandbox(async h=>{
 const before=h.rows();
 const capability=authority(h),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');assert.deepEqual(h.rows(),before);
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
},{beforeStatement(sql,method){if(method==='run'&&sql.startsWith('INSERT INTO applied'))throw Error('INJECTED');}}));

test('retirement preserves unrelated ownership rows exactly',()=>sandbox(async h=>{
 const db=new DatabaseSync(h.file),unrelated='{"independent":"unchanged"}';
 db.prepare('INSERT INTO ownership(site,snapshot) VALUES(?,?)').run('99999',unrelated);db.close();
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,authority(h),h.f.request).code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 const row=h.rows().ownership.find(r=>r.site==='99999');assert.equal(row.snapshot,unrelated);
}));

test('unavailable retirement consumes authority before any possible transaction outcome',()=>sandbox(async h=>{
 const capability=authority(h),result=h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request);
 assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE');
 assert.equal(h.store.retireConfirmedSmartOwnership(h.file,capability,h.f.request).code,'OWNERSHIP_RETIREMENT_AUTHORITY_CONSUMED');
},{afterExec(sql){if(sql==='COMMIT')throw Error('COMMIT_ACK_LOST');}}));

test('corrupted persisted history cannot bypass the retirement blocker',()=>sandbox(async h=>{
 for(const damage of ['approved-validity','record-id','previous-record-id','original-fingerprint']){
  const inner=await fs.realpath(await fs.mkdtemp(path.join(h.root,damage+'-'))),file=path.join(inner,'ownership.sqlite');
  seedDatabase(file,h.f.active);const store=loadStore(),capability=store.testTrustTerminalRestoration(file,h.f.request,h.f.context);
  const db=new DatabaseSync(file),rows=db.prepare('SELECT mutation,record FROM applied WHERE site=? ORDER BY rowid').all('12345');
  const records=rows.map(row=>JSON.parse(row.record));
  if(damage==='approved-validity')records.at(-1).approvedValidity.end='2026-10-24T15:59:00Z';
  if(damage==='record-id')records[0].recordId='a'.repeat(64);
  if(damage==='previous-record-id'){records[1].previousRecordId='b'.repeat(64);rehashPersistence(records[1]);}
  if(damage==='original-fingerprint'){
   records[0].lifecycle.historicalOwnership.lifecycle.originalFingerprint='c'.repeat(64);rehashPersistence(records[0]);
   records[1].previousRecordId=records[0].recordId;rehashPersistence(records[1]);
  }
  for(let n=0;n<records.length;n++)db.prepare('UPDATE applied SET record=? WHERE site=? AND mutation=?')
   .run(JSON.stringify(records[n]),'12345',rows[n].mutation);
  if(['approved-validity','previous-record-id','original-fingerprint'].includes(damage))
   db.prepare('UPDATE ownership SET snapshot=? WHERE site=?').run(JSON.stringify(records.at(-1)),'12345');
  db.close();
  const before=(()=>{const inspect=new DatabaseSync(file);try{return inspect.prepare('SELECT * FROM applied ORDER BY rowid').all();}finally{inspect.close();}})();
  const result=store.retireConfirmedSmartOwnership(file,capability,h.f.request);
  assert.equal(result.status,'rejected',damage);assert.equal(result.code,'OWNERSHIP_RETIREMENT_OPEN_CONNECTION_IDENTITY_UNAVAILABLE',damage);
  const inspect=new DatabaseSync(file);try{assert.deepEqual(inspect.prepare('SELECT * FROM applied ORDER BY rowid').all(),before,damage);}
  finally{inspect.close();}
 }
}));

test('documentary completion lifecycle and recovered-looking objects are not retirement authority',()=>sandbox(async h=>{
 const before=h.rows();
 for(const candidate of [h.f.request.terminalRecord,h.f.context,{evidence:h.f.context.operations.at(-1).evidence},{}]){
  const result=h.store.retireConfirmedSmartOwnership(h.file,candidate,h.f.request);
  assert.equal(result.status,'rejected');assert.equal(result.code,'OWNERSHIP_RETIREMENT_AUTHORITY_REQUIRED');
 }
 assert.deepEqual(h.rows(),before);
 const source=await fs.readFile('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
 assert.doesNotMatch(source,/export\s+(?:async\s+)?function\s+trustTerminalRestoration/);
}));
