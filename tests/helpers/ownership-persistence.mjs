// TEST ONLY: seed documentary fixtures directly with SQLite. There is NO
// application V3 writer or runtime receipt issuance behind these fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, hash } from './ownership-lifecycle.mjs';
export { hash };
export function rehash(record) {
  const body = { ...record }; delete body.recordId;
  record.recordId = hash({ purpose: 'smart-ownership-persistence-v1', ...body }); return record;
}
export function persistenceFixture(state = 'restored') {
  const states = ['apply', 'update', 'restored'].slice(0, { apply: 1, update: 2, restored: 3 }[state]);
  const records = [];
  for (const state of states) {
    const f = fixture(state), last = f.context.operations.at(-1).evidence;
    records.push(rehash({ version: 1, kind: 'v3-ownership-persistence', lifecycle: f.value,
      approvedValidity: last.initial.intent.ownershipAttribution.admission.validity,
      previousRecordId: records.at(-1)?.recordId ?? null }));
  }
  const f = fixture(state);
  return { records, current: structuredClone(records.at(-1)),
    journal: { records: f.context.operations.map(o => o.evidence), contexts: f.context.operations.map(o => o.context) } };
}
export function seedDatabase(file, f) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
    CREATE TABLE ownership(site TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
    CREATE TABLE applied(site TEXT NOT NULL REFERENCES ownership(site), mutation TEXT NOT NULL, issuance TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(site,mutation), UNIQUE(site,issuance)) STRICT;
    PRAGMA user_version=2;`);
  db.prepare('INSERT INTO ownership VALUES(?,?)').run('12345', JSON.stringify(f.current));
  for (const r of f.records) {
    const a = r.lifecycle.applications.at(-1);
    db.prepare('INSERT INTO applied VALUES(?,?,?,?)').run('12345', a.mutationId, a.runtime.issuanceKey, JSON.stringify(r));
  }
  db.exec('COMMIT'); db.close();
}
export async function seedJournal(directory, f) {
  await fs.mkdir(directory, { recursive: true });
  const admissions = new Map();
  for (const [n, record] of f.journal.records.entries()) {
    const context = f.journal.contexts[n], i = record.initial.intent, t = context.ownershipAttributions.at(-1);
    admissions.set(i.operationId, structuredClone(t.admission));
    const body = { version: 2, provenance: 'offline-trusted-ports', initial: record.initial,
      ownershipKey: hash(i.ownershipBefore ? { status: 'available', snapshot: i.ownershipBefore } : { status: 'missing' }),
      capture: t.capture, originIssuanceReference: t.originIssuanceReference, writeReady: false, executionReady: false,
      grantsSuccessorAuthority: false, grantsRepeatAuthority: false, rollbackProven: false, restorationProven: false, resolvesHistoricalJournal: false };
    const marker = { version: 2, mode: 'offline-context', site: '12345', prepared: { ...body, fingerprint: hash(body) },
      admission: { apiWrite: record.completion.apiWrite, readback: record.completion.readback,
        submittedAt: record.completion.submittedAt, completedAt: record.completion.completedAt },
      completionRecordId: record.completion.completionRecordId, evidenceId: record.evidenceId };
    const base = path.join(directory, `site-12345-attempt-${i.mutationId}`);
    await fs.writeFile(base + '.jsonl', JSON.stringify(record.initial) + '\n' + JSON.stringify(record.completion) + '\n');
    await fs.writeFile(base + '.complete', JSON.stringify({ ...marker, checksum: hash(marker) }) + '\n');
  }
  return async (site, operation, mutation) => {
    const a = admissions.get(operation);
    if (site !== '12345' || a?.mutationId !== mutation) throw Error('INDEPENDENT_ADMISSION_MISSING');
    return structuredClone(a);
  };
}
