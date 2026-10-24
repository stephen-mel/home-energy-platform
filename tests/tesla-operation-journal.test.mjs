import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { operationModules, fixturePorts, hash, key, at } from './helpers/operation-journal.mjs';

const load = operationModules();
const journalApi = load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
const preparation = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const evidenceApi = load('src/lib/tesla-tariff/confirmed-operation-evidence.ts');
const noAuthority = result => {
  for (const flag of ['writeReady', 'executionReady', 'rollbackProven', 'restorationProven', 'grantsRepeatAuthority', 'grantsSuccessorAuthority', 'resolvesHistoricalJournal'])
    assert.equal(result[flag], false, flag);
};
async function sandbox(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hep-operation-journal-')));
  const config = { mode: 'offline', directory: path.join(root, 'tesla-experiments'), site: '12345', durableRoot: root };
  const f = fixturePorts(), journal = journalApi.offlineOperationJournal(config, f.ports);
  try { await fn({ ...f, config, journal }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const bytes = async directory => {
  const names = (await fs.readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(names.map(async n => [n, await fs.readFile(path.join(directory, n), 'utf8')])));
};
const reopened = f => operationModules()('src/lib/tesla-tariff/repeat-attempt-journal.ts').offlineOperationJournal(f.config, {});
async function apply(f) {
  const pending = await f.journal.recordInitial(f.request('apply')), result = await pending.recordCompletion();
  assert.equal(result.status, 'recorded'); return { pending, result, read: await f.journal.readHistory() };
}

test('V2 apply/update/restore prepare, persist and reopen exact Stage 3B2-E evidence without ownership mutation', () => sandbox(async f => {
  const first = await apply(f); noAuthority(first.pending); noAuthority(first.result); noAuthority(first.read);
  assert.deepEqual(f.state.ownership, { status: 'missing' });
  let record = first.result.evidence, read = first.read;
  for (const kind of ['update', 'restore']) {
    f.advance(record, read.history.contexts[0].retainedOriginal);
    const ownership = key(f.state.ownership), predecessors = await bytes(f.config.directory);
    const pending = await f.journal.recordInitial(f.request(kind));
    assert.equal(pending.prepared.initial.intent.kind, kind);
    assert.equal(pending.prepared.initial.intent.predecessor.evidenceId, record.evidenceId);
    assert.equal(pending.prepared.initial.intent.ownershipAfterGeneration,
      preparation.expectedOperationGeneration('12345', `operation-${f.state.sequence}`, `mutation-${f.state.sequence}`, f.state.ownership));
    assert.equal(evidenceApi.validateOperationInitialRecord(pending.prepared.initial).status, 'validated');
    const result = await pending.recordCompletion(); noAuthority(result);
    assert.equal(key(f.state.ownership), ownership, 'No finalisation, reservation or CAS write');
    const current = await bytes(f.config.directory);
    for (const [name, before] of Object.entries(predecessors)) assert.equal(current[name], before);
    read = await reopened(f).readHistory(); assert.equal(read.status, 'available'); noAuthority(read);
    record = result.evidence;
    assert.equal(key(read.history.records.at(-1)), key(record));
    assert.equal(evidenceApi.validateConfirmedOperationEvidence(record, read.history.contexts.at(-1)).status, 'validated');
  }
  assert.equal(read.history.records.length, 3);
  assert.equal(f.state.ownership.snapshot.lifecycle.restorationObligation, 'required');
  await assert.rejects(() => f.journal.recordInitial(f.request('restore')), /OPERATION_PREDECESSOR_CONFLICT/);
}));

test('separate-process recovery validates the physical journal without invoking acquisition or approval ports', () => sandbox(async f => {
  const { result } = await apply(f), before = await bytes(f.config.directory);
  const script = `import { operationModules } from './tests/helpers/operation-journal.mjs';
    const api = operationModules()('src/lib/tesla-tariff/repeat-attempt-journal.ts');
    const result = await api.offlineOperationJournal(JSON.parse(process.argv[1]), {}).readHistory();
    console.log(JSON.stringify(result));`;
  const resultRead = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.config)], { encoding: 'utf8' }));
  assert.equal(resultRead.status, 'available'); noAuthority(resultRead);
  assert.equal(resultRead.history.records[0].evidenceId, result.evidence.evidenceId);
  assert.deepEqual(await bytes(f.config.directory), before);
}));

test('generation allocation is deterministic, operation-specific and bound to the whole trusted precondition', () => sandbox(async f => {
  const ports = { ...f.ports, readConfirmedHistory: async () => ({ records: [], contexts: [] }) };
  const request = f.request('apply'), before = key(f.state.ownership);
  const a = await preparation.prepareOperationMutationContext(request, ports);
  f.state.clock = 1;
  const b = await preparation.prepareOperationMutationContext(request, ports);
  assert.equal(a.initial.intent.ownershipAfterGeneration, b.initial.intent.ownershipAfterGeneration);
  assert.match(a.initial.intent.ownershipAfterGeneration, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  f.state.clock = 1;
  const changed = await preparation.prepareOperationMutationContext({ ...request, operationId: 'distinct-operation' }, ports);
  assert.notEqual(changed.initial.intent.ownershipAfterGeneration, a.initial.intent.ownershipAfterGeneration);
  assert.equal(preparation.operationCommitPreconditionMatches(a, f.state.ownership, a.initial.intent.ownershipAfterGeneration), true);
  assert.equal(preparation.operationCommitPreconditionMatches(a, f.state.ownership, changed.initial.intent.ownershipAfterGeneration), false);
  assert.equal(key(f.state.ownership), before);
  await assert.rejects(() => fs.stat(f.config.directory), { code: 'ENOENT' });
}));

test('stale ownership at preparation and a state change after approval fail before journal admission', () => sandbox(async f => {
  const stale = { ...f.request('apply'), expectedOwnershipKey: hash('stale') };
  await assert.rejects(() => f.journal.recordInitial(stale), /OPERATION_OWNERSHIP_STALE/);
  assert.deepEqual(await fs.readdir(f.config.directory), []);
  const original = f.ports.readOwnership; let reads = 0;
  f.ports.readOwnership = async () => ++reads === 1 ? original() : { status: 'invalid', code: 'CHANGED' };
  await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /OPERATION_OWNERSHIP_STALE/);
  assert.deepEqual(await fs.readdir(f.config.directory), []);
}));

test('a same-generation ownership change or altered baseline is not accepted as a new precondition', () => sandbox(async f => {
  const { result, read } = await apply(f); f.advance(result.evidence, read.history.contexts[0].retainedOriginal);
  const original = structuredClone(f.state.ownership), v3 = f.state.ownership.snapshot;
  f.state.ownership = { status: 'available', snapshot: { version: 2, generation: v3.generation, evidence: v3.evidence,
    historyDigest: v3.historyDigest, checksum: hash({ generation: v3.generation, evidence: v3.evidence }) } };
  await assert.rejects(() => f.journal.recordInitial(f.request('update')), /OPERATION_OWNERSHIP_INVALID/);
  f.state.ownership = original;
  const staleRequest = f.request('update'); f.state.ownership.snapshot.historyDigest = hash('changed-history');
  await assert.rejects(() => f.journal.recordInitial(staleRequest), /OPERATION_OWNERSHIP_STALE/);
  const s = f.state.ownership.snapshot;
  s.lifecycle.original.tariff.name = 'Substituted original';
  s.lifecycle.originalFingerprint = hash(s.lifecycle.original.tariff); s.evidence.baselineFingerprint = s.lifecycle.originalFingerprint;
  s.checksum = hash({ version: 3, generation: s.generation, evidence: s.evidence, lifecycle: s.lifecycle });
  await assert.rejects(() => f.journal.recordInitial(f.request('update')), /OPERATION_PREDECESSOR_CONFLICT/);
}));

test('ownership changing under the exclusive admission leaves a blocking marker rather than recording stale approval', () => sandbox(async f => {
  const original = f.ports.readOwnership; let reads = 0;
  f.ports.readOwnership = async () => ++reads >= 3 ? { status: 'invalid', code: 'CHANGED_UNDER_LOCK' } : original();
  await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /OPERATION_OWNERSHIP_STALE/);
  const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); assert.equal(read.code, 'ATTEMPT_IN_PROGRESS');
}));

test('approval and authenticated capture ports are required; caller JSON and content hashes are insufficient', () => sandbox(async f => {
  const forged = journalApi.offlineOperationJournal(f.config, {});
  await assert.rejects(() => forged.recordInitial(f.request('apply')));
  f.state.approvalChanges = a => { a.fingerprint = 'not-the-intent'; };
  await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /OPERATION_APPROVAL_OR_INITIAL_INVALID/);
  f.state.approvalChanges = null;
  for (const change of [c => { c.observation.source.kind = 'simulation'; }, c => { c.kraken.stale = true; },
    c => { c.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh = 'not-a-number'; },
    c => { c.kraken.vehicles[0].plannedDispatches.push({ start: 'bad', end: 'bad', type: 'BOOST', energyAddedKwh: null }); }]) {
    f.state.captureChanges = change;
    await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /OPERATION_CAPTURE_INVALID/);
  }
  assert.deepEqual(await fs.readdir(f.config.directory), []);
}));

test('Kraken acquisition identity and content are bound into the approved initial observation reference', () => sandbox(async f => {
  const a = await preparation.prepareOperationMutationContext(f.request('apply'), { ...f.ports, readConfirmedHistory: async () => ({ records: [], contexts: [] }) });
  f.state.captureChanges = c => { c.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh = '3'; };
  f.state.clock = 1;
  const b = await preparation.prepareOperationMutationContext(f.request('apply'), { ...f.ports, readConfirmedHistory: async () => ({ records: [], contexts: [] }) });
  assert.notEqual(a.initial.intent.before.observationId, b.initial.intent.before.observationId);
  assert.notEqual(a.initial.approval.approvalId, b.initial.approval.approvalId);
  const tampered = structuredClone(a); tampered.capture.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh = '3';
  const { fingerprint, ...body } = tampered; void fingerprint; tampered.fingerprint = hash(body);
  assert.equal(preparation.validPreparedOperationContext(tampered), false);
}));

test('fresh reacquisition may advance timestamps while changed schedule/rates after approval rejects', async () => {
  await sandbox(async f => {
    let captures = 0;
    f.state.captureChanges = c => {
      if (++captures > 1) {
        c.observation.source.observedAt = at(1);
        c.kraken.lastSuccessfulUpdate = at(1); c.kraken.importTariff.observedAt = at(1);
      }
    };
    const pending = await f.journal.recordInitial(f.request('apply'));
    assert.equal(pending.status, 'pending'); noAuthority(pending);
  });
  for (const mutate of [c => { c.kraken.vehicles[0].plannedDispatches[0].energyAddedKwh = '3'; },
    c => { c.kraken.importTariff.version.normalImport.amount = .31; }]) await sandbox(async f => {
    let captures = 0;
    f.state.captureChanges = c => { if (++captures > 1) mutate(c); };
    await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /OPERATION_EVIDENCE_CHANGED_OR_STALE/);
  });
});

test('a recorded submission cannot outlive its bound Kraken evidence even while approval and Tesla capture are fresh', () => sandbox(async f => {
  f.state.completionChanges = r => {
    r.submittedAt = at(61); r.completedAt = at(63); r.readback.observation.source.observedAt = at(62); f.state.clock = 64;
  };
  const pending = await f.journal.recordInitial(f.request('apply'));
  await assert.rejects(() => pending.recordCompletion(), /STALE_KRAKEN_EVIDENCE/);
  const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); assert.equal(read.code, 'ATTEMPT_IN_PROGRESS');
}));

test('pending, HTTP-only and ambiguous results remain blocking after restart without replay or repair', async () => {
  for (const change of [null, r => { r.apiWrite = { status: 'unknown', httpStatus: null }; },
    r => { r.readback = null; }, r => { r.readback.observation.tariff.name = 'Transformed'; }]) await sandbox(async f => {
    f.state.completionChanges = change;
    const pending = await f.journal.recordInitial(f.request('apply'));
    if (change) await assert.rejects(() => pending.recordCompletion());
    const before = await bytes(f.config.directory), read = await reopened(f).readHistory();
    assert.equal(read.status, 'blocked'); assert.equal(read.code, 'ATTEMPT_IN_PROGRESS'); noAuthority(read);
    await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /ATTEMPT_IN_PROGRESS/);
    assert.deepEqual(await bytes(f.config.directory), before);
  });
});

test('missing, truncated, duplicated, conflicting or symlinked durable evidence fails closed without modification', async () => {
  for (const change of [
    async f => fs.unlink(path.join(f.config.directory, 'site-12345-attempt-mutation-1.jsonl')),
    async f => fs.appendFile(path.join(f.config.directory, 'site-12345-attempt-mutation-1.jsonl'), 'partial'),
    async f => fs.unlink(path.join(f.config.directory, 'site-12345-attempt-mutation-1.complete')),
    async f => fs.copyFile(path.join(f.config.directory, 'site-12345-attempt-mutation-1.complete'), path.join(f.config.directory, 'site-12345-attempt-duplicate.complete')),
    async f => { const target = path.join(f.config.directory, 'site-12345-attempt-mutation-1.jsonl'); await fs.rename(target, path.join(f.config.durableRoot, 'outside')); await fs.symlink(path.join(f.config.durableRoot, 'outside'), target); },
  ]) await sandbox(async f => {
    await apply(f); await change(f);
    const before = await bytes(f.config.directory), read = await reopened(f).readHistory();
    assert.equal(read.status, 'blocked'); noAuthority(read); assert.deepEqual(await bytes(f.config.directory), before);
  });
});

test('rehashed record tampering cannot override independent admitted approval, payload or readback bindings', async () => {
  for (const mutate of [
    pair => { pair[0].intent.payloadFingerprint = hash('different-payload'); },
    pair => { pair[0].approval.approvedAt = at(2.5); },
    pair => { pair[1].readback.observation.tariff.name = 'Altered readback'; },
    pair => { pair[1].ownershipAfterGeneration = 'ffffffff-ffff-8fff-8fff-ffffffffffff'; },
  ]) await sandbox(async f => {
    await apply(f); const file = path.join(f.config.directory, 'site-12345-attempt-mutation-1.jsonl');
    const pair = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); mutate(pair);
    const { initialRecordId, ...initial } = pair[0]; void initialRecordId; pair[0].initialRecordId = hash(initial);
    pair[1].initialRecordId = pair[0].initialRecordId;
    const { completionRecordId, ...completion } = pair[1]; void completionRecordId; pair[1].completionRecordId = hash(completion);
    await fs.writeFile(file, pair.map(JSON.stringify).join('\n') + '\n');
    const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); noAuthority(read);
  });
});

test('rehashing only admission metadata cannot replace the approved root issuance reference', () => sandbox(async f => {
  await apply(f); const file = path.join(f.config.directory, 'site-12345-attempt-mutation-1.complete');
  const marker = JSON.parse(await fs.readFile(file, 'utf8'));
  marker.prepared.originIssuanceReference = hash('substituted-origin-reference');
  const { fingerprint, ...prepared } = marker.prepared; void fingerprint; marker.prepared.fingerprint = hash(prepared);
  const { checksum, ...body } = marker; void checksum; marker.checksum = hash(body);
  await fs.writeFile(file, JSON.stringify(marker) + '\n');
  const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); noAuthority(read);
}));

test('exclusive initial creation rejects concurrent recordings and consumes the attempt until completion', () => sandbox(async f => {
  const requests = [f.request('apply'), { ...f.request('apply'), operationId: 'other-operation', mutationId: 'other-mutation' }];
  const results = await Promise.allSettled(requests.map(r => f.journal.recordInitial(r)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); assert.equal(read.code, 'ATTEMPT_IN_PROGRESS');
}));

test('results, contexts and disk recovery never mint a runtime completion or successor capability', () => sandbox(async f => {
  const { result, read, pending } = await apply(f);
  const completion = load('src/lib/tesla-tariff/supervised-journal.ts').journalCompletionForRecords;
  for (const value of [result, result.evidence, read, read.history.contexts[0], pending.prepared, structuredClone(result)])
    assert.equal(completion(value, result.evidence.initial, result.evidence.completion), null);
  const legacy = await journalApi.repeatAttemptEligibility(f.config.directory, '12345', { status: 'missing' });
  assert.equal(legacy.status, 'blocked'); assert.equal(legacy.code, 'HISTORICAL_JOURNAL_INVALID');
  await assert.rejects(() => journalApi.claimRepeatAttempt(f.config.directory, '12345', result.evidence.initial, { status: 'missing' }, f.config.durableRoot));
  noAuthority(await reopened(f).readHistory());
}));

test('legacy V1 history remains readable without conversion or changes to its permanent site latch', () => sandbox(async f => {
  let clock = Date.parse('2026-09-23T08:12:00Z'), initial, classified;
  const fixture = JSON.parse(await fs.readFile('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
  const records = load('src/lib/tesla-tariff/linked-experiment-records.ts');
  const run = load('src/lib/tesla-tariff/supervised-experiment.ts').runSupervisedExperiment;
  const site = load('src/lib/site/current-site.ts').currentSite;
  const selection = { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' };
  const now = () => new Date(clock).toISOString();
  await run({ site, selection, mode: 'execute-supervised', authority: 'supervised-experiment' }, {
    now, journalRecords: records,
    async capture() { const c = structuredClone(fixture); c.before.source.observedAt = now(); c.kraken.lastSuccessfulUpdate = now(); return c; },
    prepareContext: capture => preparation.prepareMutationContext({ site, selection, capture }, { now, readOwnership: async () => ({ status: 'missing' }), newMutationId: () => 'legacy-attempt' }),
    challenge: hash, async confirm(_r, challenge) { clock += 1000; return { challenge, automaticRollbackUnproven: true, manualAppRecoveryMayBeRequired: true }; },
    async claim(_s, record) { initial = record; return { async finish(record) { classified = record; return {}; } }; },
    async write() { clock += 1000; return { status: 'unknown', httpStatus: null }; },
    async readBack() { clock += 1000; throw Error('Offline unavailable'); },
  });
  await fs.mkdir(f.config.directory);
  const file = path.join(f.config.directory, 'site-12345.jsonl');
  await fs.writeFile(file, JSON.stringify(initial) + '\n' + JSON.stringify(classified) + '\n');
  const before = await fs.readFile(file), read = await f.journal.readHistory();
  assert.equal(read.status, 'legacy'); assert.equal(read.records[0].initial.journalSchemaVersion, 1); noAuthority(read);
  await assert.rejects(() => f.journal.recordInitial(f.request('apply')), /LEGACY_OPERATION_HISTORY/);
  const eligibility = await journalApi.repeatAttemptEligibility(f.config.directory, '12345', { status: 'missing' });
  assert.equal(eligibility.status, 'blocked'); assert.equal(eligibility.code, 'PRIOR_OUTCOME_AMBIGUOUS');
  assert.deepEqual(await fs.readFile(file), before);
}));

test('file/close and final directory-sync failures leave a blocking consumed marker on reopen', async () => {
  for (const fault of ['initial-close', 'completion-close', 'final-directory-sync']) await sandbox(async f => {
    let fired = false, renamed = false;
    const controlled = { ...fs, async rename(...args) { const result = await fs.rename(...args); renamed = true; return result; },
      async open(file, flags, ...args) {
        const handle = await fs.open(file, flags, ...args);
        return { ...handle, writeFile: handle.writeFile.bind(handle),
          async sync() {
            if (!fired && fault === 'final-directory-sync' && renamed && file === f.config.directory) { fired = true; throw Error('INJECTED_SYNC'); }
            return handle.sync();
          },
          async close() {
            await handle.close();
            if (!fired && (fault === 'initial-close' && flags === 'wx' && String(file).endsWith('.jsonl')
              || fault === 'completion-close' && flags === 'a')) { fired = true; throw Error('INJECTED_CLOSE'); }
          } };
      } };
    const api = operationModules({ 'node:fs/promises': controlled })('src/lib/tesla-tariff/repeat-attempt-journal.ts');
    const journal = api.offlineOperationJournal(f.config, f.ports);
    if (fault === 'initial-close') await assert.rejects(() => journal.recordInitial(f.request('apply')), /INJECTED_CLOSE/);
    else { const pending = await journal.recordInitial(f.request('apply')); await assert.rejects(() => pending.recordCompletion(), /INJECTED_/); }
    assert.equal(fired, true);
    const read = await reopened(f).readHistory(); assert.equal(read.status, 'blocked'); assert.equal(read.code, 'ATTEMPT_IN_PROGRESS'); noAuthority(read);
  });
});
