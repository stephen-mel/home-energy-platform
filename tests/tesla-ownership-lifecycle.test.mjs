import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, fixture, hash, key, mapIdentity, document } from './helpers/ownership-lifecycle.mjs';
const api = load('src/lib/tesla-tariff/ownership-lifecycle.ts');
const legacy = load('src/lib/tesla-tariff/retained-original.ts');
const ownership = load('src/lib/tesla-tariff/ownership-evidence.ts');
const validate = api.validateOwnershipLifecycleDocument;
const noAuthority = r => {
  for (const name of ['executionReady', 'writeReady', 'rollbackProven', 'restorationProven', 'grantsRestorationAuthority', 'grantsRepeatAuthority', 'grantsSuccessorAuthority', 'resolvesHistoricalJournal']) assert.equal(r[name], false, name);
};
function rejects(f, code) {
  const result = validate(f.value, f.context); assert.equal(result.status, 'rejected', JSON.stringify(result));
  if (code) assert.equal(result.code, code); noAuthority(result); return result;
}
function rehash(value) {
  const { lifecycleId, ...body } = value; void lifecycleId;
  value.lifecycleId = hash({ purpose: 'smart-ownership-lifecycle-v2', ...body }); return value;
}
for (const state of ['apply', 'update', 'restored']) test(`${state} lifecycle document validates with complete independent evidence and no authority`, () => {
  const f = fixture(state), before = key(f), result = validate(f.value, f.context);
  assert.equal(result.status, 'validated', result.code); noAuthority(result); assert.equal(key(f), before);
  assert.equal(Object.isFrozen(f.context.historicalOwnership.evidence), false);
  assert.ok(Object.isFrozen(result.document.historicalOwnership.evidence));
  assert.equal(result.document.restorationObligation, state === 'restored' ? 'retired' : 'required');
});

test('expired validity and complete historical V3 state remain byte-for-byte unchanged after exact terminal restore', () => {
  const active = fixture('update'), terminal = fixture(), original = key(active.value.historicalOwnership);
  const result = validate(terminal.value, terminal.context); assert.equal(result.status, 'validated', result.code);
  assert.equal(key(result.document.historicalOwnership), original);
  assert.equal(validate(terminal.value, terminal.context).status, 'validated', 'pure revalidation does not claim to consume an operation');
  const h = result.document.historicalOwnership, r = result.document.restoration;
  assert.ok(Date.parse(r.operation.completion.completedAt) > Date.parse(h.evidence.validUntil));
  assert.equal(r.readback.tariffFingerprint, h.lifecycle.originalFingerprint);
  assert.notEqual(result.document.generation, h.generation);
  assert.equal(ownership.validOwnership(h.evidence), true);
  const invented = structuredClone(h.evidence); invented.updatedAt = r.operation.completion.completedAt;
  assert.equal(ownership.validOwnership(invented), false, 'the shared legacy invariant must remain intact');
});

test('JSON round-trip preserves documentary, runtime, journal, origin, application and historical identities', () => {
  const f = JSON.parse(JSON.stringify(fixture())), result = validate(f.value, f.context);
  assert.equal(result.status, 'validated', result.code); assert.equal(key(result.document), key(f.value));
  for (const a of result.document.applications) {
    assert.notEqual(a.documentary.evidenceId, a.runtime.receiptKey); assert.notEqual(a.runtime.issuanceKey, a.runtime.receiptKey);
    assert.notEqual(a.applicationId, a.documentary.evidenceId); assert.notEqual(a.applicationId, a.journal.completionRecordId);
    assert.equal(a.retainedOriginKey, result.document.applications[0].retainedOriginKey);
  }
  assert.notEqual(result.document.historyId, result.document.historicalOwnership.historyDigest);
});

for (const [name, mutate] of [
  ['legacy runtime receipt version', f => { f.context.runtimeIdentities.at(-1).receiptVersion = 1; }],
  ['rewritten mapping history', f => { f.value.historyId = hash('substituted-history'); }],
  ['missing terminal confirmation', f => { f.value.restoration = null; }],
  ['unattributed legacy operation', f => { delete f.context.operations[0].evidence.initial.intent.ownershipAttribution; }],
  ['missing restore', f => { f.context.operations.pop(); f.context.runtimeIdentities.pop(); }],
  ['missing approval', f => { f.context.operations.at(-1).context.approvals.pop(); }],
  ['missing authenticated readback', f => { f.context.operations.at(-1).context.authenticatedObservations.pop(); }],
  ['missing journal evidence', f => { f.context.operations.at(-1).context.durableJournal.pop(); }],
  ['HTTP-only confirmation', f => { f.context.operations.at(-1).evidence.completion.readback = null; }],
  ['ambiguous execution', f => { f.context.operations.at(-1).evidence.completion.apiWrite.status = 'unknown'; }],
  ['changed original tariff', f => { f.value.historicalOwnership.lifecycle.original.tariff.name = 'changed'; }],
  ['rewritten historical validity', f => { f.value.historicalOwnership.evidence.validUntil = '2026-10-26T16:00:00Z'; }],
  ['wrong terminal generation', f => { f.value.generation = f.value.historicalOwnership.generation; }],
  ['wrong predecessor application', f => { f.value.restoration.predecessorApplicationId = hash('other'); }],
  ['wrong readback identity', f => { f.value.restoration.readback.observationId = 'unadmitted-readback'; }],
  ['changed restore evidence', f => { f.value.restoration.operation.evidenceId = hash('other'); }],
]) test(`${name} rejects, including a rehashed lifecycle envelope`, () => {
  const f = fixture(); mutate(f); rehash(f.value); rejects(f);
});

test('documentary and journal IDs cannot masquerade as runtime identities even when both copies are substituted and rehashed', () => {
  for (const role of ['receiptKey', 'issuanceKey']) for (const source of ['evidence', 'initial', 'completion', 'origin', 'originKey']) {
    const f = fixture(), entry = f.context.operations.at(-1).evidence;
    const substituted = { evidence: entry.evidenceId, initial: entry.initial.initialRecordId,
      completion: entry.completion.completionRecordId, origin: f.context.historicalOwnership.lifecycle.origin.issuanceKey, originKey: f.value.applications[0].retainedOriginKey }[source];
    f.context.runtimeIdentities.at(-1)[role] = substituted; f.value.applications.at(-1).runtime[role] = substituted; rehash(f.value);
    rejects(f, 'OPERATION_IDENTITY_ALIAS_OR_REPLAY');
  }
});

for (const role of ['receiptKey', 'issuanceKey']) {
  for (const history of ['SQLite ownership historyDigest', 'previous lifecycle mapping historyId']) {
    test(`Astra regression: terminal ${role} cannot alias ${history} after all affected hashes are recomputed`, () => {
      const f = fixture(), record = f.context.operations.at(-1).evidence;
      const reference = f.context.runtimeIdentities.at(-1);
      reference[role] = history === 'SQLite ownership historyDigest'
        ? f.context.historicalOwnership.historyDigest : f.context.previousLifecycle.historyId;
      const applications = f.value.applications;
      applications[applications.length - 1] = mapIdentity(record, reference, applications[0].retainedOriginKey, applications.at(-2));
      // Rebuild the application, mapping-history, confirmation linkage and lifecycle
      // identities so rejection cannot be explained by an obsolete checksum.
      f.value = document(f.context.historicalOwnership, applications, record);
      assert.equal(f.value.applications.at(-1).runtime[role], reference[role]);
      rejects(f, 'OPERATION_IDENTITY_ALIAS_OR_REPLAY');
    });
  }
}

test('intentionally repeated historical references remain valid and unchanged', () => {
  const f = fixture(), digest = f.context.historicalOwnership.historyDigest, before = key(f);
  assert.equal(f.context.previousLifecycle.historicalOwnership.historyDigest, digest);
  assert.equal(f.value.historicalOwnership.historyDigest, digest);
  assert.equal(f.value.applications.at(-1).ownership.priorHistoryDigest, digest);
  const result = validate(f.value, f.context);
  assert.equal(result.status, 'validated', result.code); noAuthority(result); assert.equal(key(f), before);
});

test('rehashed runtime reference substitution cannot override the independent runtime reference admission', () => {
  const f = fixture(), a = f.value.applications.at(-1); a.runtime.receiptKey = hash('substituted-reference');
  const { applicationId, ...body } = a; void applicationId; a.applicationId = hash({ purpose: 'smart-ownership-application-v2', ...body });
  f.value.historyId = hash({ version: 2, purpose: 'smart-ownership-history-v2', applications: f.value.applications.map(a => a.applicationId) });
  f.value.restoration.applicationId = a.applicationId; rehash(f.value); rejects(f, 'OWNERSHIP_LIFECYCLE_CONFLICT');
});

test('duplicate terminal operation and subsequent update after a terminal predecessor reject', () => {
  const f = fixture(); f.context.operations.push(structuredClone(f.context.operations.at(-1))); f.context.runtimeIdentities.push(structuredClone(f.context.runtimeIdentities.at(-1))); rejects(f);
  for (const state of ['apply', 'update', 'restored']) {
    const next = fixture(state); next.context.previousLifecycle = fixture().value; rejects(next, 'LIFECYCLE_ALREADY_TERMINAL');
  }
  const duplicateIdentity = fixture(); duplicateIdentity.context.runtimeIdentities[2].receiptKey = duplicateIdentity.context.runtimeIdentities[0].receiptKey;
  rejects(duplicateIdentity, 'OPERATION_IDENTITY_ALIAS_OR_REPLAY');
});

test('legacy V1 retained original and V2/V3 snapshots keep their interpretation without terminal eligibility', () => {
  const f = fixture(), historical = f.context.historicalOwnership;
  assert.equal(legacy.validRetainedOriginal(historical.lifecycle), true); assert.equal(legacy.validLifecycleOwnershipSnapshot(historical, '12345'), true);
  const v2 = { ...historical, version: 2 }; delete v2.lifecycle;
  v2.checksum = hash({ generation: v2.generation, evidence: v2.evidence });
  assert.equal(ownership.validOwnership(v2.evidence), true);
  for (const value of [historical, v2, historical.lifecycle]) {
    const result = validate(value, f.context); assert.equal(result.status, 'rejected'); noAuthority(result);
  }
  const retiredLegacy = structuredClone(historical.lifecycle); retiredLegacy.restorationObligation = 'retired';
  assert.equal(legacy.validRetainedOriginal(retiredLegacy), false);
  assert.equal(legacy.validLifecycleOwnershipSnapshot(f.value, '12345'), false, 'document is not a persisted V3 snapshot');
});

test('malformed containers, unsupported versions and capability-shaped fields never throw or gain authority', () => {
  const f = fixture();
  for (const value of [null, [], {}, { version: 99 }, { ...f.value, version: 1 }, { ...f.value, executionReady: true },
    { get version() { throw Error('getter must not run'); } }]) {
    assert.doesNotThrow(() => validate(value, f.context)); assert.equal(validate(value, f.context).status, 'rejected'); noAuthority(validate(value, f.context));
  }
  for (const context of [null, {}, { ...f.context, previousLifecycle: undefined }, { ...f.context, runtimeIdentities: [] }]) {
    assert.doesNotThrow(() => validate(f.value, context)); assert.equal(validate(f.value, context).status, 'rejected');
  }
  assert.deepEqual(Object.keys(api), ['validateOwnershipLifecycleDocument'], 'no issuer, store, capability, finaliser or transition API');
});
