import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { load, key } from './helpers/ownership-lifecycle.mjs';
import { loadStore, input } from './helpers/ownership-sqlite-harness.mjs';
import { persistenceFixture, rehash, seedDatabase, seedJournal } from './helpers/ownership-persistence.mjs';
const contract = load('src/lib/tesla-tariff/ownership-persistence.ts');
const check = f => contract.validatePersistedOwnershipHistory(f.current, f.records, '12345', 'Europe/London', f.journal);
function noAuthority(result) {
  for (const [name, value] of Object.entries(contract.persistenceOnly)) assert.equal(result[name], value, name);
}
async function sandbox(fn, state = 'restored') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hep-v3-readback-')));
  const file = path.join(root, 'ownership', 'ownership.sqlite'), directory = path.join(root, 'tesla-experiments');
  await fs.mkdir(path.dirname(file));
  const f = persistenceFixture(state); seedDatabase(file, f); const admission = await seedJournal(directory, f);
  const store = loadStore(), read = () => store.readPersistedOwnershipLifecycle(file, '12345', 'Europe/London', admission);
  try { await fn({ root, file, directory, f, admission, store, read }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
for (const state of ['apply', 'update', 'restored']) test(`V3 ${state} schema validates exact generations and documentary identities`, () => {
  const f = persistenceFixture(state), result = check(f); assert.equal(result.status, 'consistent-only', result.code); noAuthority(result);
  assert.equal(key(result.current), key(f.current));
});
test('terminal restore preserves expired historical validity and immutable original exactly', () => {
  const f = persistenceFixture(), result = check(f); assert.equal(result.status, 'consistent-only', result.code);
  const before = f.records[1].lifecycle.historicalOwnership, terminal = result.current.lifecycle;
  assert.equal(key(terminal.historicalOwnership), key(before));
  assert.ok(Date.parse(terminal.restoration.readback.observedAt) > Date.parse(before.evidence.validUntil));
  assert.equal(key(terminal.historicalOwnership.lifecycle.original), key(f.records[0].lifecycle.historicalOwnership.lifecycle.original));
  assert.equal(terminal.restorationObligation, 'retired'); noAuthority(result);
});
for (const [name, change] of [
  ['wrong exact approved generation', f => { f.records.at(-1).lifecycle.generation = '00000000-0000-8000-8000-000000000000'; rehash(f.records.at(-1)); f.current = f.records.at(-1); }],
  ['missing predecessor', f => { f.records.splice(1, 1); }],
  ['duplicate operation history', f => { f.records.push(structuredClone(f.records[0])); }],
  ['rehashed altered validity', f => { const r = f.records.at(-1); r.approvedValidity.end = '2027-01-01T00:00:00Z'; rehash(r); f.current = r; }],
  ['rehashed mapping substitution', f => { const r = f.records.at(-1); r.lifecycle.applications[0].runtime.receiptKey = 'a'.repeat(64); rehash(r); f.current = r; }],
  ['altered original', f => { f.current.lifecycle.historicalOwnership.lifecycle.original.tariff.name = 'wrong'; }],
  ['partial terminal restoration', f => { f.current.lifecycle.restoration = null; }],
  ['unsupported version', f => { f.records[0].version = 99; rehash(f.records[0]); }],
  ['incomplete journal', f => { f.journal.records.pop(); f.journal.contexts.pop(); }],
]) test(`fails closed: ${name}`, () => { const f = persistenceFixture(); change(f); const result = check(f); assert.equal(result.status, 'rejected'); noAuthority(result); });
test('real SQLite close/reopen verifies both tables and V2 physical journals without writes', () => sandbox(async f => {
  const before = await fs.readFile(f.file), result = await f.read();
  assert.equal(result.status, 'consistent-storage', result.code); noAuthority(result);
  assert.equal(key(result.current), key(f.f.current)); assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal((await f.read()).status, 'consistent-storage');
  assert.equal(f.store.readOwnership(f.file, '12345').status, 'invalid', 'Legacy reader cannot promote the new representation');
}));
test('separate-process verified readback remains documentary only', () => sandbox(async f => {
  const script = `import { loadStore } from './tests/helpers/ownership-sqlite-harness.mjs';
    const admissions = JSON.parse(process.argv[2]);
    const r = await loadStore().readPersistedOwnershipLifecycle(process.argv[1], '12345', 'Europe/London',
      async (site, op, mutation) => { const a = admissions.find(a => a.operationId === op && a.mutationId === mutation); if (!a || site !== '12345') throw Error(); return a; });
    console.log(JSON.stringify(r));`;
  const admissions = f.f.journal.contexts.map(c => c.ownershipAttributions.at(-1).admission);
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, f.file, JSON.stringify(admissions)], { encoding: 'utf8' }));
  assert.equal(result.status, 'consistent-storage', result.code); noAuthority(result);
}));
for (const [name, change] of [
  ['missing completion', f => fs.unlink(path.join(f.directory, 'site-12345-attempt-mutation-3.complete'))],
  ['truncated journal', f => fs.appendFile(path.join(f.directory, 'site-12345-attempt-mutation-3.jsonl'), '{')],
  ['pending/ambiguous operation', f => fs.writeFile(path.join(f.directory, 'site-12345-attempt.active'), 'pending')],
  ['altered journal', async f => { const file = path.join(f.directory, 'site-12345-attempt-mutation-3.jsonl'); const text = await fs.readFile(file, 'utf8'); await fs.writeFile(file, text.replace('"accepted"', '"rejected"')); }],
  ['SQL/history mismatch', f => { const db = new DatabaseSync(f.file); db.prepare('UPDATE applied SET issuance=? WHERE mutation=?').run('wrong', 'mutation-3'); db.close(); }],
  ['missing SQL history', f => { const db = new DatabaseSync(f.file); db.prepare('DELETE FROM applied WHERE mutation=?').run('mutation-2'); db.close(); }],
]) test(`restart remains blocking: ${name}`, () => sandbox(async f => { await change(f); const r = await f.read(); assert.equal(r.status, 'blocked'); noAuthority(r); }));
test('missing independent admission and wrong site/timezone fail closed', () => sandbox(async f => {
  assert.equal((await f.store.readPersistedOwnershipLifecycle(f.file, '12345', 'Europe/London')).status, 'blocked');
  assert.equal((await f.store.readPersistedOwnershipLifecycle(f.file, '12345', 'UTC', f.admission)).status, 'blocked');
  assert.equal((await f.store.readPersistedOwnershipLifecycle(f.file, '54321', 'Europe/London', f.admission)).status, 'missing');
  assert.equal(contract.validatePersistedOwnershipHistory(f.f.current, f.f.records, '54321', 'Europe/London', f.f.journal).status, 'rejected');
}));
test('read-only failure rolls back/closes SQLite and does not change bytes', () => sandbox(async f => {
  const before = await fs.readFile(f.file);
  const store = loadStore({ beforeStatement(sql) { if (sql.startsWith('SELECT mutation')) throw Error('INJECTED_READ_FAILURE'); } });
  assert.equal((await store.readPersistedOwnershipLifecycle(f.file, '12345', 'Europe/London', f.admission)).status, 'blocked');
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal((await f.read()).status, 'consistent-storage');
}));
test('existing SQLite transaction exclusion/rollback protects records; no V3 CAS writer is exposed', () => sandbox(async f => {
  const before = await fs.readFile(f.file), first = new DatabaseSync(f.file), second = new DatabaseSync(f.file, { timeout: 0 });
  first.exec('BEGIN IMMEDIATE');
  assert.throws(() => second.exec('BEGIN IMMEDIATE'), /locked/);
  first.prepare('UPDATE ownership SET snapshot=? WHERE site=?').run('{}', '12345');
  first.exec('ROLLBACK'); first.close(); second.close();
  assert.deepEqual(await fs.readFile(f.file), before);
  assert.equal((await f.read()).status, 'consistent-storage');
  assert.equal(typeof f.store.commitOwnership, 'undefined');
  assert.equal(typeof f.store.persistOwnershipLifecycle, 'undefined');
}));
test('legacy V2 remains readable without new authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hep-v3-legacy-')), file = path.join(root, 'ownership.sqlite');
  try {
    const store = loadStore(); assert.equal(store.testCommit(file, input()).status, 'persisted');
    const before = await fs.readFile(file), result = await store.readPersistedOwnershipLifecycle(file, '12345', 'Europe/London');
    assert.equal(result.status, 'legacy'); noAuthority(result); assert.equal(result.ownership.snapshot.version, 2);
    assert.deepEqual(await fs.readFile(file), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('validated and recovered documents cannot mint runtime completion or receipts', () => sandbox(async f => {
  const result = await f.read(); assert.equal(result.status, 'consistent-storage', result.code);
  const issuer = f.store.load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts');
  const registry = f.store.load('src/lib/tesla-tariff/supervised-journal.ts');
  const last = f.f.journal.records.at(-1);
  for (const candidate of [result, result.current, structuredClone(result), last, check(f.f), {}]) {
    assert.equal(registry.journalCompletionForRecords(candidate, last.initial, last.completion), null);
    assert.equal(issuer.issueConfirmedSmartReceipt(candidate, last.initial, last.completion).status, 'rejected');
  }
  noAuthority(result);
}));
