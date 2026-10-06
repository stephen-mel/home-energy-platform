import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {loadStore,evidence,input,hash} from './helpers/ownership-sqlite-harness.mjs';
const {DatabaseSync}=await import('node:sqlite');
const clean=x=>JSON.parse(JSON.stringify(x));
async function sandbox(fn){const dir=await io.mkdtemp(path.join(os.tmpdir(),'hep-sqlite-'));try{await fn(path.join(dir,'ownership.sqlite'),dir);}finally{await io.rm(dir,{recursive:true,force:true});}}
function inspect(file,fn){const db=new DatabaseSync(file);try{return fn(db);}finally{db.close();}}
const store=loadStore();
function persist(file,i=input()){const r=store.testCommit(file,i);assert.equal(r.status,'persisted',JSON.stringify(r));return clean(r.snapshot);}
const available=snapshot=>({status:'available',snapshot});

test('runtime is exactly pinned; public modules expose no commit/recordConfirmed authority',()=>{
  for(const version of ['20.19.0','22.13.0','26.8.1','26.8.3']){
    const wrong=loadStore({},version);assert.equal(wrong.readOwnership('/unused','12345').code,'OWNERSHIP_NODE_26_8_2_REQUIRED');
    assert.equal(wrong.testCommit('/unused',input()).code,'OWNERSHIP_NODE_26_8_2_REQUIRED');
  }
  const source=fs.readFileSync('src/lib/tesla-tariff/ownership-sqlite.ts','utf8');
  assert.deepEqual([...source.matchAll(/export function (\w+)/g)].map(m=>m[1]),['readOwnership']);
  const facade=store.load('src/lib/tesla-tariff/ownership-store.ts').ownershipStore('/unused');
  assert.deepEqual(Object.keys(facade),['read']);
});
test('missing read has no filesystem side effects; first commit stores bounded evidence and exact lineage',()=>sandbox(async(file,dir)=>{
  assert.equal(store.readOwnership(file,'12345').status,'missing');assert.deepEqual(await io.readdir(dir),[]);
  const original=evidence(),saved=persist(file,input('one',{status:'missing'},original));
  assert.deepEqual(saved.evidence,original);assert.deepEqual(clean(store.readOwnership(file,'12345')),available(saved));
  assert.equal((await io.stat(file)).mode&0o777,0o600);
  inspect(file,db=>{assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');assert.equal(db.prepare('SELECT count(*) AS n FROM applied').get().n,1);});
  original.intervals[0].restore.amount=999;assert.equal(store.readOwnership(file,'12345').snapshot.evidence.intervals[0].restore.amount,0.25177);
  assert.doesNotMatch(JSON.stringify(saved),/sell|export|access_token|refresh_token|seasons|energy_charges/);
}));
test('valid-empty is available and can advance only with its exact identity',()=>sandbox(file=>{
  const saved=persist(file,input('empty',{status:'missing'},evidence(true)));
  assert.equal(store.readOwnership(file,'12345').status,'available');assert.equal(saved.evidence.intervals.length,0);
  assert.equal(store.testCommit(file,input('missing')).status,'conflict');
  persist(file,input('next',available(saved)));
}));
test('available precondition cannot substitute for genuine missing',()=>sandbox(file=>{
  const fake={version:2,generation:'a'.repeat(36),evidence:evidence(true),checksum:'',historyDigest:hash('fake history')};
  const key=store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
  fake.checksum=key({generation:fake.generation,evidence:fake.evidence});
  assert.equal(store.testCommit(file,input('x',available(fake))).status,'conflict');
}));
test('exact nonempty snapshot succeeds; stale generation and same-generation changed evidence reject',()=>sandbox(file=>{
  const saved=persist(file),key=store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
  const changed=structuredClone(saved);changed.evidence.intervals[0].restore.amount=0.30;
  assert.equal(store.testCommit(file,input('bad',available(changed))).code,'OWNERSHIP_PRECONDITION_INVALID');
  changed.checksum=key({generation:changed.generation,evidence:changed.evidence});
  assert.equal(store.testCommit(file,input('bad',available(changed))).status,'conflict');
  const next=persist(file,input('next',available(saved)));assert.notEqual(next.generation,saved.generation);
  assert.equal(store.testCommit(file,input('stale',available(saved))).status,'conflict');
  assert.deepEqual(clean(store.readOwnership(file,'12345').snapshot),next);
}));
test('exact replay is already-persisted without another generation or row',()=>sandbox(file=>{
  const i=input(),saved=persist(file,i),repeat=store.testCommit(file,i);
  assert.equal(repeat.status,'already-persisted');assert.deepEqual(clean(repeat.snapshot),saved);
  assert.equal(inspect(file,db=>db.prepare('SELECT count(*) AS n FROM applied').get().n),1);
}));
test('mutation/issuance/receipt substitution and historical replay fail closed',()=>sandbox(file=>{
  const i=input(),saved=persist(file,i);
  for(const patch of [{issuanceKey:hash('different chain')},{receiptKey:hash('different receipt')},{mutationId:'different-mutation'}])
    assert.equal(store.testCommit(file,{...i,...patch}).status,'conflict');
  const next=persist(file,input('next',available(saved)));
  assert.equal(store.testCommit(file,i).status,'conflict');
  assert.equal(store.testCommit(file,{...i,issuanceKey:hash('reused old id'),expected:available(next)}).status,'conflict');
  assert.equal(inspect(file,db=>db.prepare('SELECT count(*) AS n FROM applied').get().n),2);
}));
test('legacy JSON blocks both missing SQLite and coexistence; unreadable paths fail closed',()=>sandbox(async(file,dir)=>{
  const legacy=path.join(dir,'site-12345.json');await io.writeFile(legacy,'{}');
  assert.equal(store.readOwnership(file,'12345').code,'OWNERSHIP_LEGACY_UNRESOLVED');
  assert.equal(store.testCommit(file,input()).code,'OWNERSHIP_LEGACY_UNRESOLVED');assert.equal(fs.existsSync(file),false);
  await io.unlink(legacy);persist(file);await io.writeFile(legacy,'{}');
  assert.equal(store.readOwnership(file,'12345').code,'OWNERSHIP_LEGACY_UNRESOLVED');
  assert.equal(store.readOwnership(path.join(file,'child'),'12345').status,'unavailable');
}));
for(const corruption of ['database','empty-database','null-snapshot','partial-snapshot','checksum','evidence','snapshot-version','evidence-version','applied','missing-applied','result'])test(`corrupt ${corruption} fails closed without overwrite`,()=>sandbox(async file=>{
  persist(file);
  if(corruption==='database'||corruption==='empty-database')await io.writeFile(file,corruption==='database'?'not sqlite':'');
  else inspect(file,db=>{
    if(corruption==='missing-applied'){db.exec('DELETE FROM applied');return;}
    if(corruption==='null-snapshot'||corruption==='partial-snapshot'){db.prepare('UPDATE ownership SET snapshot=?').run(corruption==='null-snapshot'?'null':'{');return;}
    if(['checksum','evidence','snapshot-version','evidence-version'].includes(corruption)){
      const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);
      if(corruption==='checksum')s.checksum='0'.repeat(64);
      else if(corruption==='snapshot-version')s.version=1;
      else if(corruption==='evidence-version')s.evidence.version=2;
      else s.evidence.intervals[0].start='2026-02-30T00:00:00Z';
      db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
    }else{
      const a=JSON.parse(db.prepare('SELECT record FROM applied').get().record);a.result.generation='b'.repeat(36);
      if(corruption==='result'){const {checksum,...bound}=a;void checksum;a.checksum=store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint(bound);}
      db.prepare('UPDATE applied SET record=?').run(JSON.stringify(a));
    }
  });
  const bytes=await io.readFile(file);assert.notEqual(store.readOwnership(file,'12345').status,'available');
  assert.equal(store.testCommit(file,input()).status,'store-failed');assert.deepEqual(await io.readFile(file),bytes);
}));
for(const phase of ['before-ownership','between-statements','before-commit'])test(`failure ${phase} rolls back both records`,()=>sandbox(file=>{
  const saved=persist(file),i=input('next',available(saved));
  const broken=loadStore({beforeStatement(sql,method){if(method==='run'&&((phase==='before-ownership'&&sql.startsWith('INSERT INTO ownership'))||(phase==='between-statements'&&sql.startsWith('INSERT INTO applied'))))throw Error('secret failure');},
    afterStatement(sql,method){if(phase==='before-commit'&&method==='run'&&sql.startsWith('INSERT INTO applied'))throw Error('secret failure');}});
  const result=broken.testCommit(file,i);assert.equal(result.status,'store-failed');
  assert.doesNotMatch(JSON.stringify(result),/secret/);assert.deepEqual(clean(store.readOwnership(file,'12345').snapshot),saved);
  assert.equal(inspect(file,db=>db.prepare('SELECT count(*) AS n FROM applied').get().n),1);
}));
for(const phase of ['commit-rejected','commit-ack','close'])test(`${phase} failure reports indeterminate; exact installed identity remains coherent`,()=>sandbox(file=>{
  const i=input(),broken=loadStore({beforeExec(sql){if(phase==='commit-rejected'&&sql==='COMMIT')throw Error('private commit');},afterExec(sql){if(phase==='commit-ack'&&sql==='COMMIT')throw Error('private ack');},afterClose(){if(phase==='close')throw Error('private close');}});
  assert.equal(broken.testCommit(file,i).status,'indeterminate');
  const saved=store.readOwnership(file,'12345');
  if(phase==='commit-rejected'){assert.notEqual(saved.status,'available');return;}
  assert.equal(saved.status,'available');assert.equal(store.testCommit(file,i).status,'already-persisted');
  assert.equal(inspect(file,db=>db.prepare('SELECT count(*) AS n FROM applied').get().n),1);
}));
async function worker(mode='normal') {
  const child=fork('tests/helpers/ownership-sqlite-worker.mjs',[mode],{stdio:['ignore','ignore','pipe','ipc']});
  await once(child,'message');return child;
}
test('separate processes cannot both replace G7; ownership and applied identity remain atomic',()=>sandbox(async file=>{
  const saved=persist(file),a=await worker(),b=await worker();
  try{
    const waits=[once(a,'message'),once(b,'message')],exits=[once(a,'exit'),once(b,'exit')];
    a.send({file,input:input('process-a',available(saved),evidence(true))});b.send({file,input:input('process-b',available(saved))});
    const results=(await Promise.all(waits)).map(([r])=>r);await Promise.all(exits);
    assert.equal(results.filter(r=>r.status==='persisted').length,1);
    const loser=results.find(r=>r.status!=='persisted');assert.ok(loser.status==='conflict'||loser.code==='OWNERSHIP_STORE_BUSY');
    const winner=results.find(r=>r.status==='persisted');assert.deepEqual(clean(store.readOwnership(file,'12345').snapshot),winner.snapshot);
    inspect(file,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM applied').get().n,2);const rows=db.prepare('SELECT record FROM applied').all().map(r=>JSON.parse(r.record));assert.equal(rows.filter(r=>r.result.generation===winner.snapshot.generation).length,1);});
  }finally{a.kill();b.kill();}
}));
test('process killed before commit leaves previous ownership and applied identities intact',()=>sandbox(async file=>{
  const saved=persist(file),child=await worker('crash'),exit=once(child,'exit');
  child.send({file,input:input('crashed',available(saved),evidence(true))});const [,signal]=await exit;assert.equal(signal,'SIGKILL');
  assert.deepEqual(clean(store.readOwnership(file,'12345').snapshot),saved);
  assert.equal(inspect(file,db=>db.prepare('SELECT count(*) AS n FROM applied').get().n),1);
}));

test('local persistence cannot reach integrations and leaves journal/latch files unchanged',()=>sandbox(async(file,dir)=>{
  // The VM loader rejects every integration/network import and provides no fetch.
  const journal=path.join(dir,'site-12345.jsonl'),latch=path.join(dir,'consumed-latch');
  await io.writeFile(journal,'original journal');await io.writeFile(latch,'consumed');
  persist(file);
  assert.equal(await io.readFile(journal,'utf8'),'original journal');
  assert.equal(await io.readFile(latch,'utf8'),'consumed');
  assert.deepEqual((await io.readdir(dir)).sort(),['consumed-latch','ownership.sqlite','site-12345.jsonl']);
}));

const triggerCases = {
  'applied insert ignored': "CREATE TRIGGER qa BEFORE INSERT ON applied BEGIN SELECT RAISE(IGNORE); END",
  'applied identity transformed': "CREATE TRIGGER qa AFTER INSERT ON applied BEGIN UPDATE applied SET issuance='unexpected' WHERE site=NEW.site AND mutation=NEW.mutation; END",
  'ownership upsert ignored': "CREATE TRIGGER qa BEFORE INSERT ON ownership BEGIN SELECT RAISE(IGNORE); END",
  'ownership transformed': "CREATE TRIGGER qa AFTER UPDATE ON ownership BEGIN UPDATE ownership SET snapshot=json_set(NEW.snapshot,'$.evidence.intervals[0].restore.amount',0.99) WHERE site=NEW.site; END",
  'inactive trigger': "CREATE TRIGGER qa BEFORE INSERT ON applied WHEN NEW.mutation='never-used' BEGIN SELECT RAISE(IGNORE); END",
};
function storedRows(file) {
  return inspect(file,db=>({ownership:clean(db.prepare('SELECT * FROM ownership ORDER BY site').all()),
    applied:clean(db.prepare('SELECT * FROM applied ORDER BY site,mutation').all())}));
}
for(const [name,sql] of Object.entries(triggerCases))test(`schema rejects ${name} before mutation, including inactive triggers`,()=>sandbox(file=>{
  const saved=persist(file),previous=storedRows(file);inspect(file,db=>db.exec(sql));
  let writes=0;
  const guarded=loadStore({beforeStatement(sql,method){if(method==='run'&&sql.startsWith('INSERT INTO'))writes++;}});
  const result=guarded.testCommit(file,input('next',available(saved)));
  assert.equal(result.status,'store-failed');assert.equal(result.code,'OWNERSHIP_STORE_INVALID');assert.equal(writes,0);
  assert.equal(store.readOwnership(file,'12345').status,'invalid');assert.deepEqual(storedRows(file),previous);
}));
for(const constraint of ['unique','primary key','foreign key','not null','extra column'])test(`schema rejects changed ${constraint} without repair`,()=>sandbox(file=>{
  const saved=persist(file),previous=storedRows(file);
  inspect(file,db=>db.exec(`ALTER TABLE applied RENAME TO old_applied;
    CREATE TABLE applied(site TEXT NOT NULL ${constraint==='foreign key'?'':'REFERENCES ownership(site)'}, mutation TEXT NOT NULL,
      issuance TEXT ${constraint==='not null'?'':'NOT NULL'}, record TEXT NOT NULL
      ${constraint==='extra column'?', extra TEXT':''}
      ${constraint==='primary key'?'':', PRIMARY KEY(site,mutation)'}
      ${constraint==='unique'?'':', UNIQUE(site,issuance)'}) STRICT;
    INSERT INTO applied(site,mutation,issuance,record) SELECT site,mutation,issuance,record FROM old_applied;
    DROP TABLE old_applied;`));
  const altered=storedRows(file),result=store.testCommit(file,input('next',available(saved)));
  assert.equal(result.code,'OWNERSHIP_STORE_INVALID');assert.equal(result.status,'store-failed');
  assert.deepEqual(storedRows(file),altered);assert.deepEqual(altered.ownership,previous.ownership);
  assert.equal(store.readOwnership(file,'12345').status,'invalid');
}));
// Introduce real SQL triggers only AFTER the schema check on the same connection.
// This intentionally bypasses defence-in-depth in tests, never in production.
for(const [name,sql] of Object.entries(triggerCases).filter(([name])=>name!=='inactive trigger'))test(`independent pre-COMMIT verification rolls back ${name}`,()=>sandbox(file=>{
  const saved=persist(file),previous=storedRows(file);let installed=false,commits=0,rollbacks=0;
  const guarded=loadStore({beforeStatement(statement,method,db){
    if(!installed&&method==='run'&&statement.startsWith('INSERT INTO ownership')){installed=true;db.exec(sql);}
  },beforeExec(sql){if(sql==='COMMIT')commits++;if(sql==='ROLLBACK')rollbacks++;}});
  const result=guarded.testCommit(file,input('next',available(saved)));
  assert.equal(installed,true);assert.equal(result.status,'store-failed');assert.equal(result.code,'OWNERSHIP_PAIR_VERIFICATION_FAILED');
  assert.equal(commits,0);assert.equal(rollbacks,1);assert.deepEqual(storedRows(file),previous);
  assert.deepEqual(clean(store.readOwnership(file,'12345')),available(saved));
}));
for(const alteration of ['prior','receipt','result','coherent-but-unintended-pair'])test(`pre-COMMIT exact binding rejects validly checksummed ${alteration}`,()=>sandbox(file=>{
  const saved=persist(file),previous=storedRows(file);let changed=false,commits=0;
  const key=store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
  const guarded=loadStore({afterStatement(sql,method,db){
    if(changed||method!=='run'||!sql.startsWith('INSERT INTO applied'))return;changed=true;
    const row=db.prepare("SELECT record FROM applied WHERE mutation='next'").get(),a=JSON.parse(row.record);
    if(alteration==='prior')a.prior={status:'missing',site:'12345'};
    if(alteration==='receipt')a.receiptKey='f'.repeat(64);
    if(alteration==='result')a.result={status:'available',site:'12345',version:1,generation:saved.generation,checksum:saved.checksum,evidenceKey:key(saved.evidence)};
    if(alteration==='coherent-but-unintended-pair'){
      const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);s.evidence.intervals[0].restore.amount=0.30;
      s.checksum=key({generation:s.generation,evidence:s.evidence});
      a.result.checksum=s.checksum;a.result.evidenceKey=key(s.evidence);
      db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
    }
    const {checksum,...bound}=a;void checksum;a.checksum=key(bound);
    db.prepare("UPDATE applied SET record=? WHERE mutation='next'").run(JSON.stringify(a));
  },beforeExec(sql){if(sql==='COMMIT')commits++;}});
  const result=guarded.testCommit(file,input('next',available(saved)));
  assert.equal(changed,true);assert.equal(result.code,'OWNERSHIP_PAIR_VERIFICATION_FAILED');assert.equal(result.status,'store-failed');
  assert.equal(commits,0);assert.deepEqual(storedRows(file),previous);assert.deepEqual(clean(store.readOwnership(file,'12345')),available(saved));
}));

const identityHash=store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
function updateApplication(db,id,change) {
  const a=JSON.parse(db.prepare('SELECT record FROM applied WHERE mutation=?').get(id).record);
  change(a);const {checksum,...bound}=a;void checksum;a.checksum=identityHash(bound);
  db.prepare('UPDATE applied SET record=? WHERE mutation=?').run(JSON.stringify(a),id);
}
function sequence(file,empty=false) {
  const ia=input('A',{status:'missing'},evidence(empty)),a=persist(file,ia);
  const ib=input('B',available(a)),b=persist(file,ib);
  const ic=input('C',available(b)),c=persist(file,ic);
  return {a,b,c,ia,ib,ic};
}
for(const empty of [false,true])test(`missing root then captured ${empty?'valid-empty':'nonempty'} state supports A→B→C and exact replay`,()=>sandbox(file=>{
  const {a,c,ia,ic}=sequence(file,empty);assert.equal(a.evidence.intervals.length,empty?0:1);
  assert.deepEqual(clean(store.readOwnership(file,'12345')),available(c));
  const before=storedRows(file),replay=store.testCommit(file,ic);
  assert.equal(replay.status,'already-persisted');assert.equal(replay.snapshot.generation,c.generation);
  assert.equal(store.testCommit(file,ia).status,'conflict');assert.deepEqual(storedRows(file),before);
}));
test('QA reproducer: deleted A after A→B cannot become unseen or be reused with a different issuance',()=>sandbox(file=>{
  const a=persist(file,input('A')),b=persist(file,input('B',available(a)));
  inspect(file,db=>db.prepare('DELETE FROM applied WHERE mutation=?').run('A'));
  const damaged=storedRows(file);assert.equal(store.readOwnership(file,'12345').status,'invalid');
  const reuse=input('A',available(b));reuse.issuanceKey='f'.repeat(64);
  const result=store.testCommit(file,reuse);assert.equal(result.status,'store-failed');assert.equal(result.code,'OWNERSHIP_STORE_INVALID');
  assert.deepEqual(storedRows(file),damaged); // no repair, new generation or lost remaining evidence
}));
for(const damage of ['older predecessor','immediate predecessor','disconnected record','fork','cycle','duplicate result','conflicting result generation','cross-site prior','nonterminal ownership'])
  test(`complete history rejects ${damage} and refuses ordinary commits without changing durable state`,()=>sandbox(file=>{
    const {a,c}=sequence(file);
    inspect(file,db=>{
      const app=id=>JSON.parse(db.prepare('SELECT record FROM applied WHERE mutation=?').get(id).record);
      if(damage==='older predecessor')db.prepare('DELETE FROM applied WHERE mutation=?').run('A');
      if(damage==='immediate predecessor')db.prepare('DELETE FROM applied WHERE mutation=?').run('B');
      if(damage==='fork')updateApplication(db,'C',v=>{v.prior=app('A').result;});
      if(damage==='cycle')updateApplication(db,'A',v=>{v.prior=app('C').result;});
      if(damage==='duplicate result')updateApplication(db,'B',v=>{v.result=app('A').result;});
      if(damage==='conflicting result generation')updateApplication(db,'B',v=>{v.result.generation=app('A').result.generation;});
      if(damage==='cross-site prior')updateApplication(db,'B',v=>{v.prior.site='99999';});
      if(damage==='nonterminal ownership')db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(a));
      if(damage==='disconnected record'){
        const extra=app('B');extra.mutationId='D';extra.issuanceKey='e'.repeat(64);
        extra.prior.generation='1'.repeat(36);extra.result.generation='2'.repeat(36);
        const {checksum,...bound}=extra;void checksum;extra.checksum=identityHash(bound);
        db.prepare('INSERT INTO applied(site,mutation,issuance,record) VALUES(?,?,?,?)').run('12345','D',extra.issuanceKey,JSON.stringify(extra));
      }
    });
    const damaged=storedRows(file);assert.equal(store.readOwnership(file,'12345').status,'invalid');
    const result=store.testCommit(file,input('next',available(c)));
    assert.equal(result.code,'OWNERSHIP_STORE_INVALID');assert.equal(result.status,'store-failed');assert.deepEqual(storedRows(file),damaged);
  }));
for(const change of ['delete historical row','transform checksummed historical row'])test(`pre-COMMIT preserves exact retained history: ${change}`,()=>sandbox(file=>{
  const a=persist(file,input('A')),b=persist(file,input('B',available(a))),before=storedRows(file);
  let touched=false,commits=0,rollbacks=0;
  const guarded=loadStore({beforeStatement(sql,method,db){
    if(change==='delete historical row'&&!touched&&method==='run'&&sql.startsWith('INSERT INTO ownership')){
      touched=true;db.exec("CREATE TRIGGER delete_history AFTER INSERT ON applied BEGIN DELETE FROM applied WHERE mutation='A'; END");
    }
  },afterStatement(sql,method,db){
    if(change==='transform checksummed historical row'&&!touched&&method==='run'&&sql.startsWith('INSERT INTO applied')){
      touched=true;updateApplication(db,'A',v=>{v.receiptKey='f'.repeat(64);});
    }
  },beforeExec(sql){if(sql==='COMMIT')commits++;if(sql==='ROLLBACK')rollbacks++;}});
  const result=guarded.testCommit(file,input('C',available(b)));
  assert.equal(touched,true);assert.equal(result.status,'store-failed');assert.equal(result.code,'OWNERSHIP_HISTORY_VERIFICATION_FAILED');
  assert.equal(commits,0);assert.equal(rollbacks,1);assert.deepEqual(storedRows(file),before);
  assert.deepEqual(clean(store.readOwnership(file,'12345')),available(b));
}));

// Independent test construction of the documented ordered-history commitment.
const anchorFor=records=>identityHash({version:1,site:'12345',applications:records});
function applicationRows(db) {
  return db.prepare('SELECT record FROM applied ORDER BY mutation').all().map(r=>JSON.parse(r.record));
}
function replaceHistory(db,records,{prefixes=false,anchor=false}={}) {
  db.exec('DELETE FROM applied');
  const prefix=[];
  for(const a of records){
    if(prefixes)a.priorHistoryDigest=prefix.length?anchorFor(prefix):null;
    const {checksum,...bound}=a;void checksum;a.checksum=identityHash(bound);
    db.prepare('INSERT INTO applied(site,mutation,issuance,record) VALUES(?,?,?,?)').run(a.site,a.mutationId,a.issuanceKey,JSON.stringify(a));
    prefix.push(a);
  }
  if(anchor){
    const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);
    s.historyDigest=anchorFor(prefix);
    db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
  }
}
for(const damage of ['mutationId','issuanceKey','receiptKey','multiple identities','valid alternative chain','logical order','anchor alone','history with repaired prefix digests'])
  test(`history anchor rejects ${damage} despite recomputed application checksums`,()=>sandbox(file=>{
    const a=persist(file,input('A')),b=persist(file,input('B',available(a)));
    inspect(file,db=>{
      const records=applicationRows(db);
      if(damage==='mutationId')records[0].mutationId='renamed-A';
      if(damage==='issuanceKey')records[0].issuanceKey=hash('rewritten issuance');
      if(damage==='receiptKey')records[0].receiptKey=hash('rewritten receipt');
      if(damage==='multiple identities')for(const r of records){r.mutationId='renamed-'+r.mutationId;r.issuanceKey=hash(r.mutationId);r.receiptKey=hash('receipt '+r.mutationId);}
      if(damage==='valid alternative chain'){
        records[0].result.generation='f'.repeat(36);records[1].prior=clean(records[0].result);
      }
      if(damage==='logical order'){
        // Same terminal result, valid root, but identities now occur in the opposite order.
        const [first,last]=records;records.reverse();
        last.prior=first.prior;last.result=first.result;first.prior=clean(last.result);
        first.result={status:'available',site:'12345',version:1,generation:b.generation,checksum:b.checksum,evidenceKey:identityHash(b.evidence)};
      }
      if(damage==='history with repaired prefix digests')records[0].mutationId='renamed-A';
      if(damage==='anchor alone'){
        const changed=clean(b);changed.historyDigest='0'.repeat(64);
        db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(changed));
      }else replaceHistory(db,records,{prefixes:true}); // even repair every intermediate anchor, but not the terminal commitment
    });
    const damaged=storedRows(file);
    assert.equal(store.readOwnership(file,'12345').status,'invalid');
    const reuse=input('A',available(b));reuse.issuanceKey=hash('different issuance');
    assert.equal(store.testCommit(file,reuse).code,'OWNERSHIP_STORE_INVALID');
    assert.deepEqual(storedRows(file),damaged); // reopen: no advance or implicit repair
  }));
test('QA exact rename-A + row checksum reproducer fails before ownership advances',()=>sandbox(file=>{
  const a=persist(file,input('A')),b=persist(file,input('B',available(a)));
  inspect(file,db=>{const rows=applicationRows(db);rows[0].mutationId='renamed-A';replaceHistory(db,rows);});
  const before=storedRows(file),reuse=input('A',available(b));reuse.issuanceKey=hash('new issuance for A');
  assert.equal(store.readOwnership(file,'12345').status,'invalid');
  assert.equal(store.testCommit(file,reuse).status,'store-failed');assert.deepEqual(storedRows(file),before);
}));
test('physical row order is irrelevant; digest commits logical predecessor order; replay does not advance it',()=>sandbox(file=>{
  const {a,b,c,ic}=sequence(file);
  const ordered=inspect(file,applicationRows);
  assert.equal(c.historyDigest,anchorFor(ordered));
  assert.notEqual(c.historyDigest,anchorFor([...ordered].reverse()));
  assert.notEqual(a.historyDigest,b.historyDigest);assert.notEqual(b.historyDigest,c.historyDigest);
  inspect(file,db=>replaceHistory(db,[...ordered].reverse()));
  assert.deepEqual(clean(store.readOwnership(file,'12345')),available(c));
  const before=storedRows(file);assert.deepEqual(clean(store.testCommit(file,ic)),{status:'already-persisted',snapshot:c});
  assert.deepEqual(storedRows(file),before);
}));
test('captured anchor is mandatory for append and replay even with identical generation/economics',()=>sandbox(file=>{
  const a=persist(file,input('A')),bad=clean(a);bad.historyDigest=hash('different captured history');
  assert.equal(store.testCommit(file,input('B',available(bad))).code,'OWNERSHIP_GENERATION_CHANGED');
  const ib=input('B',available(a)),b=persist(file,ib),before=storedRows(file);
  assert.equal(store.testCommit(file,{...ib,expected:available(bad)}).code,'OWNERSHIP_MUTATION_CONFLICT');
  const missing=clean(b);delete missing.historyDigest;
  assert.equal(store.testCommit(file,input('C',available(missing))).code,'OWNERSHIP_PRECONDITION_INVALID');
  assert.deepEqual(storedRows(file),before);
}));
test('trust boundary: consistent full database rewrite is not authenticated, but original captured anchor conflicts',()=>sandbox(file=>{
  const {c}=sequence(file);
  inspect(file,db=>{const rows=applicationRows(db);rows[0].mutationId='renamed-A';replaceHistory(db,rows,{prefixes:true,anchor:true});});
  const rewritten=clean(store.readOwnership(file,'12345'));
  assert.equal(rewritten.status,'available'); // deliberate limit: no external trust root
  assert.equal(rewritten.snapshot.generation,c.generation);
  assert.notEqual(rewritten.snapshot.historyDigest,c.historyDigest);
  const before=storedRows(file),reuse=input('A',available(c));reuse.issuanceKey=hash('different issuance');
  assert.equal(store.testCommit(file,reuse).code,'OWNERSHIP_GENERATION_CHANGED');assert.deepEqual(storedRows(file),before);
  // If a caller trusts a newly captured fully rewritten database, a local digest cannot detect its provenance.
  assert.equal(store.testCommit(file,{...reuse,expected:rewritten}).status,'persisted');
}));
test('consistent history plus anchor transformation during transaction rolls back exact intended state',()=>sandbox(file=>{
  const a=persist(file,input('A')),b=persist(file,input('B',available(a))),before=storedRows(file);
  let changed=false,commits=0,rollbacks=0;
  const guarded=loadStore({afterStatement(sql,method,db){
    if(!changed&&method==='run'&&sql.startsWith('INSERT INTO applied')){
      changed=true;const rows=applicationRows(db);rows[0].mutationId='renamed-A';replaceHistory(db,rows,{prefixes:true,anchor:true});
    }
  },beforeExec(sql){if(sql==='COMMIT')commits++;if(sql==='ROLLBACK')rollbacks++;}});
  const result=guarded.testCommit(file,input('C',available(b)));
  assert.equal(changed,true);assert.equal(result.status,'store-failed');assert.equal(commits,0);assert.equal(rollbacks,1);
  assert.deepEqual(storedRows(file),before);assert.deepEqual(clean(store.readOwnership(file,'12345')),available(b));
}));
test('old SQLite schema version is rejected without migration',()=>sandbox(file=>{
  const a=persist(file);inspect(file,db=>db.exec('PRAGMA user_version=1'));
  const before=storedRows(file);assert.equal(store.readOwnership(file,'12345').status,'invalid');
  assert.equal(store.testCommit(file,input('next',available(a))).code,'OWNERSHIP_STORE_INVALID');
  assert.deepEqual(storedRows(file),before);assert.equal(inspect(file,db=>db.prepare('PRAGMA user_version').get().user_version),1);
}));
test('separate process append invalidates the previously captured history precondition',()=>sandbox(async file=>{
  const a=persist(file,input('A')),child=await worker();
  try{
    const message=once(child,'message'),exit=once(child,'exit');child.send({file,input:input('B',available(a))});
    const [result]=await message;await exit;assert.equal(result.status,'persisted');
    assert.notEqual(result.snapshot.historyDigest,a.historyDigest);
    const before=storedRows(file);assert.equal(store.testCommit(file,input('C',available(a))).code,'OWNERSHIP_GENERATION_CHANGED');
    assert.deepEqual(storedRows(file),before);
    assert.deepEqual(clean(store.readOwnership(file,'12345')),available(result.snapshot));
  }finally{child.kill();}
}));
