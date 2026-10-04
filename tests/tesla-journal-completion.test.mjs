import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
let fault = null, closeGate = null;
const operations = [];
const controlledIO = { ...io, async open(file, mode, ...args) {
  const phase = mode === 'wx' ? 'initial' : mode === 'a' ? 'classified' : 'directory';
  operations.push(phase + '-open');
  if (fault === phase + '-open') throw Error('INJECTED_IO');
  const handle = await io.open(file, mode, ...args);
  return Object.fromEntries(['writeFile', 'sync', 'close'].map(method => [method, async (...values) => {
    const boundary = phase + '-' + method; operations.push(boundary);
    // Close the real fixture descriptor even when simulating close failure.
    if (method === 'close') {
      await handle.close();
      if (phase === 'classified' && closeGate) await closeGate;
    }
    if (fault === boundary) throw Error('INJECTED_IO');
    if (method !== 'close') return handle[method](...values);
  }]));
} };
const modules = new Map();
function load(file) {
  file = path.resolve(file); if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, { exports, Error, structuredClone, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    const natives = { 'node:crypto': crypto, 'node:fs/promises': controlledIO, 'node:path': path };
    assert.ok(name in natives, `No transport dependency: ${name}`); return natives[name];
  } }); return exports;
}
const records = load('src/lib/tesla-tariff/linked-experiment-records.ts');
const { runSupervisedExperiment } = load('src/lib/tesla-tariff/supervised-experiment.ts');
const { prepareMutationContext } = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
const { claimExperimentJournal, journalCompletionForRecords } = load('src/lib/tesla-tariff/supervised-journal.ts');
const { ownershipFingerprint: hash } = load('src/lib/tesla-tariff/ownership-transition.ts');
const { representationKey: key } = load('src/lib/tesla-tariff/rollback-evidence.ts');
const fixture = JSON.parse(fs.readFileSync('tests/fixtures/tesla-q7-sept23.json', 'utf8'));
const site = load('src/lib/site/current-site.ts').currentSite;
const selection = { energySiteId: '12345', assetId: 'q7-fixture', dispatchStart: '2026-09-23T08:00:00+00:00' };
function harness(directory, overrides = {}, ownership = { status: 'missing' }) {
  let clock = Date.parse('2026-09-23T08:12:00Z'), review;
  const calls = { ids: 0, captures: 0, writes: 0, claim: null, result: null, context: null, order: [] };
  const now = () => new Date(clock).toISOString();
  const ports = { now, journalRecords: records,
    async capture() { calls.captures++; calls.order.push('capture'); const c = structuredClone(fixture);
      c.before.source.observedAt = now(); c.kraken.lastSuccessfulUpdate = now(); return c; },
    async prepareContext(capture) { calls.order.push('prepare'); calls.context = await prepareMutationContext({ site, selection, capture },
      { now, readOwnership: async () => ownership, newMutationId: () => { calls.ids++; return 'test-mutation'; } }); return calls.context; },
    challenge: value => hash(value),
    async confirm(r, challenge) { calls.order.push('confirm'); review = r; clock += 1000;
      return { challenge, automaticRollbackUnproven: true, manualAppRecoveryMayBeRequired: true }; },
    async claim(_site, record) { calls.order.push('claim'); calls.claim = record;
      const journal = await claimExperimentJournal(directory, _site, record);
      return { async finish(result) { calls.order.push('finish'); calls.result = result; return journal.finish(result); } }; },
    async write() { calls.order.push('write'); calls.writes++; clock += 1000; return { status: 'accepted', httpStatus: 200 }; },
    async readBack() { calls.order.push('readback'); clock += 1000; return { ...structuredClone(fixture.before),
      source: { ...fixture.before.source, observedAt: now() }, tariff: structuredClone(review.proposal.bound.representation) }; },
    ...overrides };
  return { calls, ports, advance: ms => { clock += ms; }, run: () => runSupervisedExperiment({ site, selection, mode: 'execute-supervised', authority: 'supervised-experiment' }, ports) };
}
async function usingHarness(fn, overrides = {}) {
  const directory = await io.mkdtemp(path.join(os.tmpdir(), 'hep-b2-'));
  fault = null; closeGate = null; operations.length = 0;
  try { await fn(harness(directory, overrides), directory); }
  finally { fault = null; closeGate = null; await io.rm(directory, { recursive: true, force: true }); }
}
const verify = (h, capability) => journalCompletionForRecords(capability, h.calls.claim, h.calls.result);

test('durable finish returns exact immutable reusable authority, without another ID, clock or side effect', async () => {
  await usingHarness(async h => {
    const result = await h.run(), capability = result.journalCompletion;
    const evidence = verify(h, capability);
    assert.equal(key(evidence), key({ completionSchemaVersion: 1, journalSchemaVersion: 1, energySiteId: '12345',
      mutationId: h.calls.context.mutationId, initialRecordId: h.calls.claim.initialRecordId,
      classifiedRecordId: h.calls.result.classifiedRecordId, completedAt: h.calls.result.completedAt }));
    assert.ok(Object.isFrozen(capability)); assert.ok(Object.isFrozen(evidence));
    assert.throws(() => { evidence.completedAt = 'changed'; }, TypeError);
    assert.throws(() => { capability.extra = true; }, TypeError);
    const before = [...operations];
    assert.equal(verify(h, capability), evidence); assert.equal(verify(h, capability), evidence);
    assert.deepEqual(operations, before); assert.equal(h.calls.writes, 1); assert.equal(h.calls.ids, 1);
    assert.deepEqual(h.calls.order, ['capture','prepare','confirm','capture','claim','write','readback','finish']);
    assert.equal(result.record.classification, 'submitted-representation-preserved'); assert.equal(result.writeReady, false);
    h.calls.result.completedAt = 'changed';
    assert.notEqual(evidence.completedAt, 'changed'); assert.equal(verify(h, capability), null);
  });
});

test('plain objects, JSON, copied evidence and reconstructed B1 records have no authority', async () => {
  await usingHarness(async (h, directory) => {
    const { journalCompletion } = await h.run(), evidence = verify(h, journalCompletion);
    for (const fake of [{}, { ...journalCompletion }, JSON.parse(JSON.stringify(journalCompletion)),
      structuredClone(journalCompletion), evidence, { ...evidence }, JSON.parse(JSON.stringify(evidence))])
      assert.equal(verify(h, fake), null);
    const lines = (await io.readFile(path.join(directory, 'site-12345.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.validLinkedClassifiedRecord(lines[1], lines[0]));
    assert.equal(journalCompletionForRecords(lines[1], lines[0], lines[1]), null);
    // The genuine runtime capability may be checked against exact copies only.
    assert.equal(journalCompletionForRecords(journalCompletion, lines[0], lines[1]), evidence);
    const otherInstance = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-journal.ts', 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
      { exports: otherInstance, structuredClone, require: name => name === 'node:fs/promises' ? controlledIO : name === 'node:path' ? path : records });
    assert.equal(otherInstance.journalCompletionForRecords(journalCompletion, lines[0], lines[1]), null);
    assert.deepEqual(Object.keys(otherInstance).sort(), ['claimExperimentJournal', 'journalCompletionForRecords']);
  });
});

test('capability cannot bind a different valid mutation, site or classified identity', async () => {
  await usingHarness(async h => {
    const { journalCompletion } = await h.run();
    await usingHarness(async other => {
      const prepare = other.ports.prepareContext;
      other.ports.prepareContext = async capture => {
        const c = structuredClone(await prepare(capture)); c.mutationId = 'other-mutation';
        const bound = Object.fromEntries(Object.entries(c).filter(([k]) => !['fingerprint', 'writeReady', 'rollbackProven'].includes(k)));
        c.fingerprint = hash(bound); return c;
      };
      await other.run();
      assert.equal(journalCompletionForRecords(journalCompletion, other.calls.claim, other.calls.result), null);
    });
    const modified = structuredClone(h.calls.result); modified.completedAt = '2026-09-23T08:12:04Z';
    const body = Object.fromEntries(Object.entries(modified).filter(([k]) => k !== 'classifiedRecordId'));
    modified.classifiedRecordId = hash(body);
    assert.ok(records.validLinkedClassifiedRecord(modified, h.calls.claim));
    assert.equal(journalCompletionForRecords(journalCompletion, h.calls.claim, modified), null);
    modified.energySiteId = '999'; assert.equal(journalCompletionForRecords(journalCompletion, h.calls.claim, modified), null);
  });
});

test('prototype replacement cannot fabricate registry membership or intercept registration', async () => {
  await usingHarness(async (h, directory) => {
    const { journalCompletion } = await h.run();
    // All records are valid and unchanged: rejection must be the capability
    // membership check, not a digest/record validation failure.
    assert.ok(records.validLinkedInitialRecord(h.calls.claim, '12345'));
    assert.ok(records.validLinkedClassifiedRecord(h.calls.result, h.calls.claim));
    const scope = vm.createContext({ exports: {}, structuredClone,
      forged: verify(h, journalCompletion), intercepted: 0,
      require: name => name === 'node:fs/promises' ? controlledIO : name === 'node:path' ? path : records });
    vm.runInContext(ts.transpileModule(fs.readFileSync('src/lib/tesla-tariff/supervised-journal.ts', 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, scope);
    vm.runInContext(`
      WeakMap.prototype.get = function () { return forged; };
      WeakMap.prototype.set = function () { intercepted++; throw new Error('REGISTRY_INTERCEPTED'); };
      Object.freeze = function () { intercepted++; return forged; };
    `, scope);
    const isolated = scope.exports, before = [...operations];
    for (const fake of [{}, journalCompletion, new Proxy(journalCompletion, {}), Object.create(journalCompletion)])
      assert.equal(isolated.journalCompletionForRecords(fake, h.calls.claim, h.calls.result), null);
    assert.deepEqual(operations, before);
    // Genuine completion still registers through the captured operation after
    // successful real fixture I/O, without invoking the hostile prototype method.
    const journal = await isolated.claimExperimentJournal(path.join(directory, 'isolated'), '12345', h.calls.claim);
    const genuine = await journal.finish(h.calls.result);
    const evidence = isolated.journalCompletionForRecords(genuine, h.calls.claim, h.calls.result);
    assert.ok(evidence); assert.equal(key(evidence), key(scope.forged));
    assert.equal(scope.intercepted, 0);
    assert.equal(isolated.journalCompletionForRecords(scope.forged, h.calls.claim, h.calls.result), null);
    assert.equal(isolated.journalCompletionForRecords(new Proxy(genuine, {}), h.calls.claim, h.calls.result), null);
    assert.equal(isolated.journalCompletionForRecords(Object.create(genuine), h.calls.claim, h.calls.result), null);
    assert.equal(isolated.journalCompletionForRecords(genuine, h.calls.claim, h.calls.result), evidence);
  });
});

for (const [status, httpStatus, classification] of [['rejected', 403, 'request-rejected'], ['unknown', null, 'write-outcome-unknown'],
  ['accepted', 200, 'read-back-unavailable-or-insufficient']]) {
  test('durable diagnostic outcome obtains only journal authority: ' + classification, async () => {
    await usingHarness(async h => {
      h.ports.write = async () => { h.calls.writes++; return { status, httpStatus }; };
      h.ports.readBack = async () => { throw Error('READ_UNAVAILABLE'); };
      const r = await h.run(); assert.ok(verify(h, r.journalCompletion));
      assert.equal(r.record.classification, classification); assert.equal(r.record.rollbackProven, false);
      assert.equal(r.record.productionWriteReady, false); assert.equal(r.writeReady, false); assert.equal(h.calls.writes, 1);
      assert.equal(r.confirmedReceipt, undefined); assert.equal(r.ownershipTransition, undefined);
    });
  });
}

for (const boundary of ['initial-writeFile','initial-sync','directory-sync','directory-close','initial-close',
  'classified-open','classified-writeFile','classified-sync','classified-close']) {
  test('I/O failure yields no capability and preserves consumed latch: ' + boundary, async () => {
    await usingHarness(async (h, directory) => {
      fault = boundary; let result;
      await assert.rejects(async () => { result = await h.run(); }, /INJECTED_IO/);
      assert.equal(result, undefined); assert.equal(h.calls.writes, boundary.startsWith('classified') ? 1 : 0);
      assert.equal(h.calls.ids, 1); fault = null;
      await assert.rejects(claimExperimentJournal(directory, '12345', h.calls.claim), { code: 'EEXIST' });
      assert.equal(h.calls.writes, boundary.startsWith('classified') ? 1 : 0);
    });
  });
}

test('capability is unavailable until classified close resolves', async () => {
  await usingHarness(async h => {
    let release, entered; const atClose = new Promise(resolve => { entered = resolve; });
    closeGate = new Promise(resolve => { release = resolve; });
    const oldPush = operations.push.bind(operations);
    operations.push = (...items) => { if (items.includes('classified-close')) entered(); return oldPush(...items); };
    let result; const run = h.run().then(value => { result = value; });
    try { await atClose; assert.equal(result, undefined); release(); await run; assert.ok(verify(h, result.journalCompletion)); }
    finally { release(); delete operations.push; }
  });
});

test('post-claim expiry leaves consumed latch without POST or capability', async () => {
  await usingHarness(async (h, directory) => {
    const claim = h.ports.claim;
    h.ports.claim = async (...args) => { const journal = await claim(...args); h.advance(61_000); return journal; };
    await assert.rejects(h.run(), /APPROVAL_EXPIRED_AFTER_CLAIM/);
    assert.equal(h.calls.writes, 0); assert.equal(h.calls.result, null);
    await assert.rejects(claimExperimentJournal(directory, '12345', h.calls.claim), { code: 'EEXIST' });
  });
});

function tomorrowLedger() {
  const generation = '11111111-1111-1111-1111-111111111111';
  const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: '2026-09-23T07:00:00Z',
    updatedAt: '2026-09-23T07:00:00Z', validUntil: '2026-09-25T00:00:00Z', basis: 'confirmed-write-readback',
    baselineFingerprint: 'a'.repeat(64), readbackFingerprint: 'b'.repeat(64), proposalFingerprint: 'c'.repeat(64), smartEvidenceFingerprint: 'd'.repeat(64),
    intervals: [{ start: '2026-09-24T08:00:00Z', end: '2026-09-24T10:00:00Z', restoreBaselineFingerprint: 'e'.repeat(64),
      applied: { amount: 0.25177, currency: 'GBP', unit: 'kWh' }, restore: { amount: 0.3, currency: 'GBP', unit: 'kWh' } }] };
  return { status: 'available', snapshot: { version: 1, generation, evidence, checksum: hash({ generation, evidence }) } };
}

test('outside-domain ownership rejects before record creation, claim, POST, readback or completion', async () => {
  await usingHarness(async h => {
    h.ports.prepareContext = async capture => {
      h.calls.order.push('prepare');
      h.calls.context = await prepareMutationContext({ site, selection, capture }, { now: h.ports.now,
        readOwnership: async () => tomorrowLedger(), newMutationId: () => { h.calls.ids++; return 'test-mutation'; } });
      assert.ok(records.validPreparedJournalContext(h.calls.context));
      return h.calls.context;
    };
    h.ports.journalRecords = { ...records, createLinkedInitialRecord() { assert.fail('No initial record'); } };
    await assert.rejects(h.run(), /OWNERSHIP_DOMAIN_INCOMPLETE/);
    assert.equal(h.calls.writes, 0); assert.equal(h.calls.claim, null); assert.equal(h.calls.result, null);
    assert.deepEqual(h.calls.order, ['capture', 'prepare', 'confirm', 'capture']);
    assert.deepEqual(operations, []); assert.equal(h.calls.ids, 1);
  });
});

for (const delta of [-1, 1000]) test(`attempt clock delta ${delta} preserves the preflight time boundary`, async () => {
  await usingHarness(async (h, directory) => {
    const claim = h.ports.claim;
    h.ports.claim = async (...args) => { const result = await claim(...args); h.advance(delta); return result; };
    if (delta < 0) {
      await assert.rejects(h.run(), /INVALID_TRANSITION/);
      assert.equal(h.calls.writes, 0); assert.equal(h.calls.result, null);
      assert.ok(h.calls.claim); assert.ok(!h.calls.order.includes('readback'));
      await assert.rejects(claimExperimentJournal(directory, '12345', h.calls.claim), { code: 'EEXIST' });
    } else {
      const result = await h.run(); assert.equal(h.calls.writes, 1); assert.ok(verify(h, result.journalCompletion));
    }
  });
});

test('transformed tariff still receives completion without promoting Tesla outcome', async () => {
  await usingHarness(async h => {
    const read = h.ports.readBack;
    h.ports.readBack = async () => { const value = await read(); value.tariff.name += ' transformed'; return value; };
    const r = await h.run(); assert.ok(verify(h, r.journalCompletion));
    assert.equal(r.record.classification, 'accepted-but-transformed-differently'); assert.equal(r.writeReady, false);
  });
});

for (const phase of ['initial-construction', 'classified-construction', 'classified-validation']) {
  test('record failure returns no capability and never repeats POST: ' + phase, async () => {
    await usingHarness(async (h, directory) => {
      h.ports.journalRecords = { ...records };
      if (phase === 'initial-construction') h.ports.journalRecords.createLinkedInitialRecord = () => { throw Error('INVALID_RECORD'); };
      else if (phase === 'classified-construction') h.ports.journalRecords.createLinkedClassifiedRecord = () => { throw Error('INVALID_RECORD'); };
      else h.ports.journalRecords.createLinkedClassifiedRecord = (...args) => {
        const r = records.createLinkedClassifiedRecord(...args); r.classifiedRecordId = 'invalid'; return r;
      };
      let result;
      await assert.rejects(async () => { result = await h.run(); }, /INVALID_RECORD|JOURNAL_CLASSIFIED_INVALID/);
      assert.equal(result, undefined); assert.equal(h.calls.writes, phase === 'initial-construction' ? 0 : 1);
      if (phase === 'initial-construction') assert.deepEqual(await io.readdir(directory), []);
      else await assert.rejects(claimExperimentJournal(directory, '12345', h.calls.claim), { code: 'EEXIST' });
    });
  });
}


test('malformed injected preflight cannot reach initial construction or execution', async () => {
  await usingHarness(async h => {
    h.ports.journalRecords = { ...records,
      preflightOwnershipDomain() { return {}; },
      createLinkedInitialRecord() { assert.fail('No initial record'); },
    };
    await assert.rejects(h.run(), /INVALID_TRANSITION/);
    assert.equal(h.calls.writes, 0); assert.equal(h.calls.claim, null); assert.equal(h.calls.result, null);
    assert.deepEqual(h.calls.order, ['capture', 'prepare', 'confirm', 'capture']);
    assert.deepEqual(operations, []);
  });
});
