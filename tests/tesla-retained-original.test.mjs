import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadStore, input } from './helpers/ownership-sqlite-harness.mjs';
import { rehearsal, databaseRelative, journalRelative } from './helpers/smart-lifecycle-rehearsal.mjs';

// Existing isolated rehearsal supplies a real linked journal and ownership pair.
// No live transport, real credentials, or repository evidence is written.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hep-retained-original-')));
after(() => fs.rm(root, { recursive: true, force: true }));
const seed = await rehearsal(path.join(root, 'seed'));
await seed.run();
assert.equal(seed.summary.ownershipPersistence.status, 'persisted');
const journalText = await fs.readFile(path.join(seed.root, journalRelative), 'utf8');
const [initial, classified] = journalText.trim().split('\n').map(JSON.parse);
const store = loadStore();
const fingerprint = store.load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
const recovery = () => loadStore().load('src/lib/tesla-tariff/recover-original-baseline.ts').recoverOriginalBaseline;
const clean = x => JSON.parse(JSON.stringify(x));
const originalEvidence = clean(seed.snapshot().snapshot.evidence);
const seedDB = new DatabaseSync(path.join(seed.root, databaseRelative), { readOnly: true });
const applied = JSON.parse(seedDB.prepare('SELECT record FROM applied').get().record);
seedDB.close();
const retention = {
  original: initial.review.before,
  origin: { mutationId: initial.mutationId, initialRecordId: initial.initialRecordId,
    classifiedRecordId: classified.classifiedRecordId, issuanceKey: applied.issuanceKey,
    receiptKey: applied.receiptKey, journal: 'legacy' },
};
async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, 'case-'));
  const file = path.join(directory, databaseRelative), journal = path.join(directory, journalRelative);
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, journalText);
  const commit = { ...input(initial.mutationId, { status: 'missing' }, clean(originalEvidence)),
    issuanceKey: applied.issuanceKey, receiptKey: applied.receiptKey, retention: structuredClone(retention) };
  return { directory, file, journal, commit };
}
function persist(f, commit = f.commit) {
  const result = store.testCommit(f.file, commit);
  assert.equal(result.status, 'persisted', JSON.stringify(result));
  assert.equal(result.snapshot.version, 3);
  return clean(result.snapshot);
}
function next(snapshot, id = 'update-2') {
  const evidence = clean(snapshot.evidence);
  evidence.readbackFingerprint = fingerprint(id);
  return { ...input(id, { status: 'available', snapshot }, evidence), retention: structuredClone(retention) };
}
function modify(file, fn) { const db = new DatabaseSync(file); try { fn(db); } finally { db.close(); } }
function noAuthority(result) {
  for (const key of ['writeReady','executionReady','rollbackProven','restorationProven','grantsRepeatAuthority','resolvesHistoricalJournal'])
    assert.equal(result[key], false, key);
}

test('exact original survives durable round-trip and a fresh process; recovery is read-only', async () => {
  const f = await fixture(), saved = persist(f);
  const before = await fs.readFile(f.file), journalBefore = await fs.readFile(f.journal);
  const script = `import {loadStore} from './tests/helpers/ownership-sqlite-harness.mjs';
    const recover=loadStore().load('src/lib/tesla-tariff/recover-original-baseline.ts').recoverOriginalBaseline;
    console.log(JSON.stringify(recover(process.argv[1],'12345','Europe/London')));`;
  const recovered = JSON.parse(execFileSync(process.execPath, ['--input-type=module','-e',script,f.file], { encoding:'utf8' }));
  assert.equal(recovered.status, 'recovered');
  assert.deepEqual(recovered.baseline, retention.original);
  assert.equal(recovered.originalFingerprint, fingerprint(retention.original.tariff));
  assert.equal(recovered.generation, saved.generation);
  assert.equal(recovered.restorationObligation, 'required'); noAuthority(recovered);
  const repeat = store.load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
  const eligibility = await repeat.repeatAttemptEligibility(path.dirname(f.journal), '12345',
    store.readOwnership(f.file, '12345'));
  assert.equal(eligibility.status, 'blocked'); assert.equal(eligibility.code, 'OWNERSHIP_UNRESOLVED');
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await fs.readFile(f.journal), journalBefore);
});

test('original identity and obligation remain immutable while latest readback and generation advance', async () => {
  const f = await fixture(), first = persist(f), second = persist(f, next(first));
  assert.notEqual(first.generation, second.generation);
  assert.notEqual(first.evidence.readbackFingerprint, second.evidence.readbackFingerprint);
  assert.deepEqual(first.lifecycle.original, second.lifecycle.original);
  assert.deepEqual(first.lifecycle.origin, second.lifecycle.origin);
  const result = recovery()(f.file, '12345', 'Europe/London');
  assert.equal(result.status, 'recovered'); assert.deepEqual(clean(result.baseline), retention.original);
  assert.equal(result.latestReadback.fingerprint, second.evidence.readbackFingerprint); noAuthority(result);
  const changed = next(second, 'changed-original'); changed.retention.original.tariff.name = 'Substitution';
  assert.equal(store.testCommit(f.file, changed).code, 'OWNERSHIP_RETENTION_INVALID');
  const discharge = clean(second); discharge.lifecycle.restorationObligation = 'restored';
  assert.equal(store.testCommit(f.file, next(discharge)).code, 'OWNERSHIP_PRECONDITION_INVALID');
});

for (const kind of ['representation','fingerprint','checksum','site','timezone','generation','readback','history'])
  test(`corrupt ${kind} fails closed without repairing storage`, async () => {
    const f = await fixture(); persist(f);
    modify(f.file, db => {
      const s = JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);
      if (kind === 'representation') s.lifecycle.original.tariff.unsupported = true;
      if (kind === 'fingerprint') s.lifecycle.originalFingerprint = '0'.repeat(64);
      if (kind === 'checksum') s.checksum = '0'.repeat(64);
      if (kind === 'site') s.lifecycle.energySiteId = '999';
      if (kind === 'timezone') s.lifecycle.timeZone = 'UTC';
      if (kind === 'generation') s.lifecycle.currentGeneration = '0'.repeat(36);
      if (kind === 'readback') s.lifecycle.latestReadback.fingerprint = '0'.repeat(64);
      if (kind === 'history') s.historyDigest = '0'.repeat(64);
      db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
    });
    const bytes = await fs.readFile(f.file), result = recovery()(f.file, '12345','Europe/London');
    assert.equal(result.status, 'blocked'); assert.equal(result.baseline, null); noAuthority(result);
    assert.deepEqual(await fs.readFile(f.file), bytes);
  });

test('missing, partial, conflicting and duplicated durable journal evidence fail closed', async () => {
  const f = await fixture(); persist(f);
  for (const [contents, code] of [[null,'OWNERSHIP_ORIGINAL_JOURNAL_MISSING'], ['{}\n','OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT'],
    [journalText + journalText,'OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT'], [journalText.trimEnd(),'OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT']]) {
    if (contents === null) await fs.unlink(f.journal); else await fs.writeFile(f.journal, contents);
    const result = recovery()(f.file,'12345','Europe/London'); assert.equal(result.code,code); noAuthority(result);
  }
  const conflict = structuredClone(initial); conflict.initialRecordId = '0'.repeat(64);
  await fs.writeFile(f.journal, JSON.stringify(conflict)+'\n'+JSON.stringify(classified)+'\n');
  assert.equal(recovery()(f.file,'12345','Europe/London').code,'OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT');
});

test('missing journal prevents atomic retention; mismatched originating identities cannot commit', async () => {
  const f = await fixture(); await fs.unlink(f.journal);
  assert.equal(store.testCommit(f.file,f.commit).code,'OWNERSHIP_ORIGINAL_JOURNAL_MISSING');
  // A failed first transaction never installs a snapshot or history root.
  modify(f.file, db => assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ownership'").get().n,0));
  const other = await fixture(); other.commit.retention.origin.classifiedRecordId = '0'.repeat(64);
  assert.equal(store.testCommit(other.file,other.commit).code,'OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT');
});

test('stale CAS, reused identities and v3 downgrade reject; exact replay stays idempotent', async () => {
  const f = await fixture(), first = persist(f);
  assert.equal(store.testCommit(f.file,f.commit).status,'already-persisted');
  const update = next(first); const second = persist(f,update);
  assert.equal(store.testCommit(f.file,next(first,'stale')).code,'OWNERSHIP_GENERATION_CHANGED');
  assert.equal(store.testCommit(f.file,f.commit).code,'OWNERSHIP_GENERATION_CHANGED');
  const duplicate = next(second,'duplicate'); duplicate.issuanceKey = update.issuanceKey;
  assert.equal(store.testCommit(f.file,duplicate).code,'OWNERSHIP_MUTATION_CONFLICT');
  const reusedReceipt = next(second,'reused-receipt'); reusedReceipt.receiptKey = update.receiptKey;
  assert.equal(store.testCommit(f.file,reusedReceipt).code,'OWNERSHIP_MUTATION_CONFLICT');
  const downgrade = next(second); delete downgrade.retention;
  assert.equal(store.testCommit(f.file,downgrade).code,'OWNERSHIP_RETENTION_VERSION_CONFLICT');
});

test('v2 remains readable but cannot recover or silently migrate; wrong requested identity fails closed', async () => {
  const f = await fixture(), legacy = { ...f.commit }; delete legacy.retention;
  const saved = store.testCommit(f.file,legacy).snapshot; assert.equal(saved.version,2);
  assert.equal(store.readOwnership(f.file,'12345').status,'available');
  assert.equal(recovery()(f.file,'12345','Europe/London').code,'RESTORATION_BASELINE_UNAVAILABLE');
  assert.equal(store.testCommit(f.file,next(clean(saved))).code,'OWNERSHIP_RETENTION_VERSION_CONFLICT');
  const v3 = await fixture(); persist(v3);
  assert.equal(recovery()(v3.file,'12345','UTC').code,'OWNERSHIP_ORIGINAL_IDENTITY_MISMATCH');
  assert.equal(recovery()(v3.file,'999','Europe/London').code,'OWNERSHIP_ORIGINAL_MISSING');
});

test('history application deletion and self-checksummed baseline replacement are rejected', async () => {
  const f = await fixture(), first = persist(f); persist(f,next(first));
  modify(f.file,db => db.prepare('DELETE FROM applied WHERE mutation=?').run(initial.mutationId));
  assert.equal(recovery()(f.file,'12345','Europe/London').status,'blocked');
  const g = await fixture(); persist(g);
  modify(g.file,db => {
    const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);
    s.lifecycle.original.tariff.name='Different original';
    s.lifecycle.originalFingerprint=fingerprint(s.lifecycle.original.tariff);
    s.evidence.baselineFingerprint=s.lifecycle.originalFingerprint;
    s.evidence.intervals.forEach(i=>i.restoreBaselineFingerprint=s.lifecycle.originalFingerprint);
    s.checksum=fingerprint({version:3,generation:s.generation,evidence:s.evidence,lifecycle:s.lifecycle});
    db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
  });
  assert.equal(recovery()(g.file,'12345','Europe/London').status,'blocked');
});


test('even a self-consistent rewritten database cannot override the independent journal original', async () => {
  const f=await fixture();persist(f);
  modify(f.file,db=>{
    const s=JSON.parse(db.prepare('SELECT snapshot FROM ownership').get().snapshot);
    const a=JSON.parse(db.prepare('SELECT record FROM applied').get().record);
    s.lifecycle.original.tariff.name='Replaced baseline';
    s.lifecycle.originalFingerprint=fingerprint(s.lifecycle.original.tariff);
    s.evidence.baselineFingerprint=s.lifecycle.originalFingerprint;
    s.evidence.intervals.forEach(i=>i.restoreBaselineFingerprint=s.lifecycle.originalFingerprint);
    s.checksum=fingerprint({version:3,generation:s.generation,evidence:s.evidence,lifecycle:s.lifecycle});
    a.lifecycle=s.lifecycle;a.result.checksum=s.checksum;a.result.evidenceKey=fingerprint(s.evidence);
    a.result.lifecycleKey=fingerprint(s.lifecycle);
    const {checksum,...bound}=a;void checksum;a.checksum=fingerprint(bound);
    s.historyDigest=fingerprint({version:1,site:'12345',applications:[a]});
    db.prepare('UPDATE ownership SET snapshot=?').run(JSON.stringify(s));
    db.prepare('UPDATE applied SET record=?').run(JSON.stringify(a));
  });
  assert.equal(recovery()(f.file,'12345','Europe/London').code,'OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT');
});

for(const phase of ['before-ownership','between-statements','before-commit'])
 test(`v3 ${phase} failure rolls back both snapshot and history without touching the journal`,async()=>{
  const f=await fixture(),first=persist(f),before=await fs.readFile(f.journal);
  const broken=loadStore({beforeStatement(sql,method){
    if(method==='run'&&((phase==='before-ownership'&&sql.startsWith('INSERT INTO ownership'))
      ||(phase==='between-statements'&&sql.startsWith('INSERT INTO applied'))))throw Error('injected');
  },afterStatement(sql,method){if(phase==='before-commit'&&method==='run'&&sql.startsWith('INSERT INTO applied'))throw Error('injected');}});
  assert.equal(broken.testCommit(f.file,next(first)).status,'store-failed');
  assert.equal(recovery()(f.file,'12345','Europe/London').generation,first.generation);
  assert.deepEqual(await fs.readFile(f.journal),before);
 });

test('explicit existing attempt-journal locator recovers without falling back to the legacy copy', async()=>{
 const f=await fixture();f.commit.retention.origin.journal='attempt';
 const attempt=path.join(path.dirname(f.journal),`site-12345-attempt-${initial.mutationId}.jsonl`);
 await fs.rename(f.journal,attempt);persist(f);
 assert.equal(recovery()(f.file,'12345','Europe/London').status,'recovered');
 await fs.rename(attempt,f.journal);
 assert.equal(recovery()(f.file,'12345','Europe/London').code,'OWNERSHIP_ORIGINAL_JOURNAL_MISSING');
});
