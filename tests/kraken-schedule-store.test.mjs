import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {loadStore,scope,read} from './helpers/kraken-schedule-store.mjs';
const api=loadStore();
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kraken-observation-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'observations.sqlite');return {file,store:api.scheduleObservationStore(file)};}
const disk=file=>{const db=new DatabaseSync(file);try{return JSON.stringify(db.prepare('SELECT * FROM scopes ORDER BY site,account').all());}finally{db.close();}};
const helper=new URL('./helpers/kraken-schedule-store.mjs',import.meta.url).href;
function child(file,index,hour){const result=spawnSync(process.execPath,['--input-type=module','-e',`import {loadStore,scope,read} from ${JSON.stringify(helper)};const r=loadStore().scheduleObservationStore(${JSON.stringify(file)}).record(scope,read(${index},${hour}));console.log(JSON.stringify({status:r.status,code:r.code}));`],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}

test('first/unchanged/changed/empty, exact values, replay and recovered provenance',t=>{
 const {file,store}=fixture(t);assert.equal(store.read(scope).status,'missing');
 const first=store.record(scope,read());assert.equal(first.status,'persisted');assert.equal(first.change,'initial');assert.equal(first.ledger.revisions.length,0);
 assert.equal(store.record(scope,read()).status,'already-recorded');
 assert.equal(store.record(scope,read(1)).change,'unchanged');assert.equal(store.read(scope).ledger.revisions.length,0);
 assert.equal(store.record(scope,read(2,15)).change,'changed');
 const empty=read(3);empty.vehicles[0].plannedDispatches=[];const result=store.record(scope,empty);
 assert.equal(result.change,'changed');assert.equal(result.ledger.revisions[1].emptiedVehicles[0],'ev-a');
 const recovered=api.scheduleObservationStore(file).read(scope);assert.equal(recovered.origin,'disk');assert.equal(recovered.lastKnown,true);
 assert.equal(recovered.ledger.latest.retrievedAt,empty.retrievedAt);assert.equal(recovered.ledger.revisions[0].before.vehicles[0].sessions[0].energyAddedKwh,'-2.3000');
 assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('incomplete/failed/disk/malformed never overwrite prior history',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);
 for(const mutate of [r=>r.status='failed',r=>r.provenance='disk',r=>r.vehicles[0].plannedDispatches=null,r=>r.vehicles[0].plannedDispatches[0].start='invalid']){const r=read(1);mutate(r);assert.equal(store.record(scope,r).status,'rejected');assert.equal(disk(file),before);}
});
test('scope isolation and binding across sites/accounts',t=>{
 const {store}=fixture(t);store.record(scope,read());
 for(const other of [{...scope,siteId:'other'},{...scope,accountRef:'other'}]){assert.equal(store.read(other).status,'missing');assert.equal(store.record(other,read(1)).code,'SCOPE_MISMATCH');const r=read();r.scopeId=api.scheduleScopeId(other);assert.equal(store.record(other,r).status,'persisted');}
 assert.equal(store.read(scope).ledger.latest.contentKey.includes('synthetic-account'),true);
});
test('ordering rejects overlaps, equal-time conflicting content and old processes; exact replay is no-op',t=>{
 const {file,store}=fixture(t);store.record(scope,read(3));const before=disk(file);
 for(const r of [read(1,15),read(3,15),{...read(4),startedAt:read(3).retrievedAt}])assert.equal(store.record(scope,r).code,'OVERLAPPING_OR_OUT_OF_ORDER');
 assert.equal(child(file,1,15).status,'rejected');assert.equal(disk(file),before);
 assert.equal(child(file,3,14).status,'already-recorded');assert.equal(child(file,4,15).status,'persisted');
});
test('SQLite writer lock excludes a second process; no automatic retry',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const db=new DatabaseSync(file);db.exec('BEGIN IMMEDIATE');
 try{assert.equal(child(file,1,15).status,'busy');}finally{db.exec('ROLLBACK');db.close();}
 assert.equal(store.read(scope).ledger.revisions.length,0);assert.equal(child(file,1,15).status,'persisted');
});
test('structural split versus equal coverage, offsets and ordering retain approved semantics',t=>{
 const {store}=fixture(t);store.record(scope,read());const split=read(1);split.vehicles[0].plannedDispatches=[{...split.vehicles[0].plannedDispatches[0],end:'2026-10-09T13:30:00Z'},{...split.vehicles[0].plannedDispatches[0],start:'2026-10-09T13:30:00Z'}];
 const r=store.record(scope,split);assert.equal(r.change,'changed');assert.equal(r.ledger.revisions[0].change.coverageChanged,false);
 const same=structuredClone(split);Object.assign(same,{startedAt:read(2).startedAt,retrievedAt:read(2).retrievedAt});same.vehicles[0].plannedDispatches.reverse();same.vehicles[0].plannedDispatches[1].start='2026-10-09T14:00:00+01:00';assert.equal(store.record(scope,same).change,'unchanged');
});
test('restart rejects bad checksum, invalid derived identity and altered schema',t=>{
 for(const attack of ['checksum','derived','trigger']){
 const {file,store}=fixture(t);store.record(scope,read());const db=new DatabaseSync(file);
 if(attack==='checksum')db.exec("UPDATE scopes SET checksum='invalid'");
 if(attack==='derived'){const r=db.prepare('SELECT payload FROM scopes').get();const p=JSON.parse(r.payload);p.latest.vehicles[0].sessions[0].startMs++;const text=JSON.stringify(p);db.prepare('UPDATE scopes SET payload=?,checksum=?').run(text,createHash('sha256').update(text).digest('hex'));}
 if(attack==='trigger')db.exec('CREATE TRIGGER ignored BEFORE UPDATE ON scopes BEGIN SELECT RAISE(IGNORE); END');db.close();
 assert.equal(store.read(scope).status,'invalid');assert.equal(store.record(scope,read(1,15)).status,'invalid');
 }
});
test('retention keeps latest plus at most 100 meaningful revisions',t=>{
 const {store}=fixture(t);for(let i=0;i<104;i++)assert.equal(store.record(scope,read(i,14+i%2)).status,'persisted');
 const r=store.read(scope);assert.equal(r.ledger.revisions.length,100);assert.equal(r.ledger.latest.retrievedAt,read(103).retrievedAt);
 assert.equal(store.record(scope,read(104,15)).change,'unchanged');assert.equal(store.read(scope).ledger.revisions.length,100);
});
test('oversized latest rejects atomically; byte retention may drop old revisions but not latest',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);const big=read(1);big.vehicles[0].name='x'.repeat(api.SCHEDULE_SCOPE_BYTES);
 assert.equal(store.record(scope,big).code,'CAPACITY_EXCEEDED');assert.equal(disk(file),before);
 for(let i=1;i<=4;i++){const r=read(i,14+i%2);r.vehicles[0].name='x'.repeat(180000);assert.equal(store.record(scope,r).status,'persisted');}
 assert.ok(store.read(scope).ledger.revisions.length<4);assert.equal(store.read(scope).ledger.latest.retrievedAt,read(4).retrievedAt);
});
test('failure before COMMIT rolls back, and post-COMMIT acknowledgement failure is indeterminate',t=>{
 for(const phase of ['before','after']){
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);
 class FaultDB extends DatabaseSync{exec(sql){if(sql==='COMMIT'){if(phase==='before')throw Error('injected');super.exec(sql);throw Error('ack');}return super.exec(sql);}}
 const result=loadStore({DatabaseSync:FaultDB}).scheduleObservationStore(file).record(scope,read(1,15));
 assert.equal(result.status,'indeterminate');
 if(phase==='before')assert.equal(disk(file),before);else assert.equal(store.read(scope).ledger.latest.retrievedAt,read(1).retrievedAt);
 }
});
test('pre-COMMIT verification detects suppressed writes and rolls back independent of schema gate',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);
 class SuppressDB extends DatabaseSync{prepare(sql){const stmt=super.prepare(sql);if(sql.startsWith('INSERT INTO scopes'))return {...stmt,run(){return {changes:0};}};return stmt;}}
 const result=loadStore({DatabaseSync:SuppressDB}).scheduleObservationStore(file).record(scope,read(1,15));
 assert.equal(result.status,'invalid');assert.equal(disk(file),before);
});
test('process exits with open transaction: SQLite recovery retains committed observation',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)});db.exec("BEGIN IMMEDIATE; UPDATE scopes SET payload='broken'");process.exit(9);`],{encoding:'utf8'});
 assert.equal(child.status,9);assert.equal(disk(file),before);assert.equal(store.read(scope).status,'available');
});

test('total payload cap rejects new scopes without changing any committed latest observation',t=>{
 const {file,store}=fixture(t);
 for(let i=0;i<8;i++){const s={...scope,accountRef:`account-${i}`},r=read();r.scopeId=api.scheduleScopeId(s);r.vehicles[0].name='n'.repeat(1000000);assert.equal(store.record(s,r).status,'persisted');}
 const before=disk(file),s={...scope,accountRef:'overflow'},r=read();r.scopeId=api.scheduleScopeId(s);r.vehicles[0].name='n'.repeat(1000000);
 assert.equal(store.record(s,r).code,'CAPACITY_EXCEEDED');assert.equal(disk(file),before);assert.equal(store.read(s).status,'missing');
});
test('restart rejects chronological inconsistency even with a recomputed checksum',t=>{
 const {file,store}=fixture(t);store.record(scope,read());store.record(scope,read(1,15));store.record(scope,read(2,15));
 const db=new DatabaseSync(file),record=db.prepare('SELECT payload FROM scopes').get(),p=JSON.parse(record.payload);
 p.latest.startedAt=p.revisions[0].after.startedAt;const text=JSON.stringify(p);
 db.prepare('UPDATE scopes SET payload=?,checksum=?').run(text,createHash('sha256').update(text).digest('hex'));db.close();
 assert.equal(store.read(scope).status,'invalid');
});
test('statement failure before commit is definite and preserves previous state; corrupt file fails closed',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);
 class FailedDB extends DatabaseSync{prepare(sql){if(sql.startsWith('INSERT INTO scopes'))throw Error('injected statement failure');return super.prepare(sql);}}
 assert.equal(loadStore({DatabaseSync:FailedDB}).scheduleObservationStore(file).record(scope,read(1,15)).status,'store-failed');assert.equal(disk(file),before);
 const other=fixture(t);fs.writeFileSync(other.file,'not sqlite',{mode:0o600});assert.notEqual(other.store.read(scope).status,'available');assert.notEqual(other.store.record(scope,read()).status,'persisted');
});

// No SQLite connection is opened between SIGKILL and the store read.
function hotJournal(file){
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)});db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE');db.prepare('UPDATE scopes SET payload=?').run('interrupted'.repeat(30000));process.kill(process.pid,'SIGKILL');`],{encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL',child.stderr);
 const journal=fs.readFileSync(file+'-journal');
 assert.equal(journal.subarray(0,8).toString('hex'),'d9d505f920a163d7','forced spill must leave a genuine hot rollback journal');
}
test('first connection after forced-spill SIGKILL recovers through store.read',t=>{
 const {file,store}=fixture(t);const original=read();original.vehicles[0].name='original'.repeat(30000);
 assert.equal(store.record(scope,original).status,'persisted');const before=disk(file);
 hotJournal(file);
 const recovered=store.read(scope);
 assert.equal(recovered.status,'available');assert.equal(recovered.origin,'disk');assert.equal(recovered.lastKnown,true);
 assert.equal(recovered.ledger.latest.vehicles[0].name,original.vehicles[0].name);
 assert.equal(recovered.ledger.latest.retrievedAt,original.retrievedAt);assert.equal(disk(file),before);
});
test('read never creates a missing database or initialises an empty database',t=>{
 const {file,store}=fixture(t);assert.equal(store.read(scope).status,'missing');assert.equal(fs.existsSync(file),false);
 fs.writeFileSync(file,'',{mode:0o600});assert.equal(store.read(scope).status,'invalid');assert.equal(fs.statSync(file).size,0);
});
test('existing-file-only read open rejects disappearance between stat and SQLite open',t=>{
 const {file,store}=fixture(t);store.record(scope,read());
 class RemovedDB extends DatabaseSync{constructor(location,options){fs.unlinkSync(file);super(location,options);}}
 assert.equal(loadStore({DatabaseSync:RemovedDB}).scheduleObservationStore(file).read(scope).status,'unavailable');
 assert.equal(fs.existsSync(file),false);
});
test('read connection forbids application writes while allowing recovery',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);let guarded=false;
 class GuardDB extends DatabaseSync{prepare(sql){if(sql==='PRAGMA journal_mode'){assert.throws(()=>super.exec('DELETE FROM scopes'),/readonly/i);guarded=true;}return super.prepare(sql);}}
 assert.equal(loadStore({DatabaseSync:GuardDB}).scheduleObservationStore(file).read(scope).status,'available');assert.equal(guarded,true);assert.equal(disk(file),before);
});
test('hot-journal recovery fails closed without filesystem write permission',t=>{
 const {file,store}=fixture(t);store.record(scope,read());const before=disk(file);hotJournal(file);
 const dir=path.dirname(file);fs.chmodSync(file,0o400);fs.chmodSync(file+'-journal',0o400);fs.chmodSync(dir,0o500);
 try{assert.equal(store.read(scope).status,'unavailable');assert.equal(fs.existsSync(file+'-journal'),true);}
 finally{fs.chmodSync(dir,0o700);fs.chmodSync(file,0o600);if(fs.existsSync(file+'-journal'))fs.chmodSync(file+'-journal',0o600);}
 assert.equal(store.read(scope).status,'available');assert.equal(disk(file),before);
});
