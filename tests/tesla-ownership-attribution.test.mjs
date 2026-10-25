import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { operationModules, fixturePorts, hash, key } from './helpers/operation-journal.mjs';

const load = operationModules();
const api = load('src/lib/tesla-tariff/ownership-attribution.ts');
const evidence = load('src/lib/tesla-tariff/confirmed-operation-evidence.ts');
const journals = load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
const economic = load('src/lib/tesla-tariff/observed-economic.ts').observedEconomicSignal;
const replace = load('src/lib/tesla-tariff/observed-replacement.ts').prepareObservedReplacement;
const day = '2026-10-24';
const instant = h => `${day}T${h}:00:00Z`;
const interval = (start, end) => ({ start: instant(start), end: instant(end) });
const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
const noAuthority = r => {
  for (const flag of ['writeReady', 'executionReady', 'rollbackProven', 'restorationProven', 'grantsRepeatAuthority', 'grantsSuccessorAuthority', 'resolvesHistoricalJournal']) assert.equal(r[flag], false, flag);
};
function payload(observation, domain, changes, at) {
  const signal = structuredClone(economic(observation, domain).signal);
  signal.import = signal.import.flatMap(w => {
    const points = [...new Set([Date.parse(w.start), Date.parse(w.end), ...changes.flatMap(c => [Date.parse(c.start), Date.parse(c.end)])]
      .filter(t => t >= Date.parse(w.start) && t <= Date.parse(w.end)))].sort((a, b) => a - b);
    return points.slice(0, -1).map((t, n) => ({ ...w, start: new Date(t).toISOString(), end: new Date(points[n + 1]).toISOString(),
      price: changes.find(c => Date.parse(c.start) <= t && Date.parse(c.end) >= points[n + 1])?.price ?? w.price }));
  });
  const result = replace({ observation, generatedAt: at, comparisonDomain: domain, dispatchEvidenceKey: hash('offline-schedule') }, signal, '12345', 'Europe/London');
  assert.equal(result.structurallyValid, true, JSON.stringify(result));
  return key({ tou_settings: { tariff_content_v2: result.representation } });
}
function fixture() {
  const f = fixturePorts(), admissions = new Map();
  const capture = f.ports.capture;
  f.ports.capture = async site => {
    const c = await capture(site);
    c.kraken.vehicles[0].plannedDispatches[0].end = instant('16');
    return c;
  };
  // Explicit offline policy evidence. This end is independently supplied, never
  // calculated from dispatch/approval durations or the annual Tesla fixture.
  const policy = { basis: 'explicit-ownership-policy', policyId: hash('approved-offline-validity-policy'),
    evidenceId: hash('independent-policy-admission'), start: instant('12'), end: instant('16') };
  f.ports.readOwnershipAttributionAdmission = async (site, operation, mutation) => {
    assert.equal(site, '12345'); const a = admissions.get(operation); assert.ok(a, 'independent admission required');
    assert.equal(a.mutationId, mutation); return structuredClone(a);
  };
  async function request(kind) {
    const r = f.request(kind), c = await f.ports.capture('12345'), domain = interval('13', '16');
    const changes = kind === 'restore' ? [] : [{ ...interval(f.state.sequence === 1 ? '14' : '15', f.state.sequence === 1 ? '15' : '16'), price: price(.08) }];
    const a = { version: 1, operationId: r.operationId, mutationId: r.mutationId, domain, newlyAuthorised: changes,
      schedule: { evidenceId: hash(`authenticated-schedule-${f.state.sequence}`), coverage: structuredClone(domain), observationId: c.krakenObservationId, fingerprint: hash(c.kraken.vehicles) },
      pricing: { evidenceId: hash(`authenticated-pricing-${f.state.sequence}`), coverage: structuredClone(domain), fingerprint: hash(c.kraken.importTariff) }, validity: policy };
    admissions.set(r.operationId, structuredClone(a));
    if (kind !== 'restore') r.payloadJson = payload(c.observation, domain, changes, r.validFrom);
    return { ...r, ownershipAttributionVersion: 1 };
  }
  function advance(record, root) {
    f.advance(record, root); // Synthetic persisted V3 input only, no finaliser or capability.
    const s = f.state.ownership.snapshot;
    if (!record.initial.intent.ownershipAttribution) return;
    s.evidence.intervals = structuredClone(record.initial.intent.ownershipAttribution.projectedIntervals);
    s.evidence.validUntil = record.initial.intent.ownershipAttribution.admission.validity.end;
    const { checksum, historyDigest, ...bound } = s; void checksum; void historyDigest; s.checksum = hash(bound);
  }
  return { ...f, admissions, request, advance };
}
async function sandbox(fn) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hep-attribution-')));
  const config = { mode: 'offline', directory: path.join(root, 'journal'), site: '12345', durableRoot: root };
  const f = fixture(), journal = journals.offlineOperationJournal(config, f.ports);
  try { await fn({ ...f, journal, config }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function confirmed(f, kind) {
  const request = await f.request(kind), pending = await f.journal.recordInitial(request), completed = await pending.recordCompletion();
  assert.equal(completed.status, 'recorded'); noAuthority(pending); noAuthority(completed);
  const history = await f.journal.readHistory(); assert.equal(history.status, 'available', JSON.stringify(history)); noAuthority(history);
  return { record: completed.evidence, history, pending };
}

test('attributed apply/update/restore survives filesystem reopen, preserves baseline, separates retained intervals and creates no authority', () => sandbox(async f => {
  const first = await confirmed(f, 'apply');
  const a = first.record.initial.intent.ownershipAttribution;
  assert.equal(a.projectedIntervals.length, 1); assert.equal(a.retainedUnchanged.length, 0);
  const root = first.history.history.contexts[0].retainedOriginal;
  const original = key(root.original);
  f.advance(first.record, root);
  const second = await confirmed(f, 'update'), b = second.record.initial.intent.ownershipAttribution;
  assert.equal(b.admission.newlyAuthorised[0].start, instant('15'));
  assert.equal(Date.parse(b.retainedUnchanged[0].start), Date.parse(instant('14'))); assert.equal(Date.parse(b.retainedUnchanged[0].end), Date.parse(instant('15')));
  assert.ok(b.projectedIntervals.every(w => w.restoreBaselineFingerprint === a.originalFingerprint));
  assert.equal(key(f.state.ownership.snapshot.lifecycle.original), original);
  f.advance(second.record, root);
  const third = await confirmed(f, 'restore'), c = third.record.initial.intent.ownershipAttribution;
  assert.equal(c.admission.newlyAuthorised.length, 0); assert.equal(c.projectedIntervals.length, 0);
  assert.ok(c.restorationAuthorised.length > 0); assert.equal(key(f.state.ownership.snapshot.lifecycle.original), original);
  const reopened = operationModules()('src/lib/tesla-tariff/repeat-attempt-journal.ts').offlineOperationJournal(f.config, f.ports);
  const before = key(await fs.readdir(f.config.directory)), read = await reopened.readHistory();
  assert.equal(read.status, 'available'); assert.equal(read.history.records.length, 3); noAuthority(read);
  assert.equal(key(await fs.readdir(f.config.directory)), before);
  // Documentary recovery alone cannot authenticate retained attribution.
  const documentary = await journals.offlineOperationJournal(f.config, {}).readHistory();
  assert.equal(documentary.status, 'blocked'); assert.equal(documentary.code, 'TRUSTED_ATTRIBUTION_ADMISSION_REQUIRED'); noAuthority(documentary);
}));

for (const [name, mutate] of [
  ['partial schedule coverage', a => { a.schedule.coverage.end = instant('15'); }],
  ['partial pricing coverage', a => { a.pricing.coverage.start = instant('14'); }],
  ['unsupported ownership horizon', a => { a.validity.basis = 'approval-duration'; }],
  ['horizon ending before the comparison domain', a => { a.validity.end = instant('15'); }],
  ['missing validity provenance', a => { delete a.validity.evidenceId; }],
  ['changed pricing fingerprint', a => { a.pricing.fingerprint = hash('wrong'); }],
  ['changed schedule fingerprint', a => { a.schedule.fingerprint = hash('wrong'); }],
  ['uncovered SMART authorisation', a => { a.newlyAuthorised[0].start = instant('13'); }],
  ['wrong price', a => { a.newlyAuthorised[0].price.amount = .06; }],
  ['negative rate', a => { a.newlyAuthorised[0].price.amount = -.08; }],
  ['reversed interval', a => { a.newlyAuthorised[0].end = instant('14'); }],
  ['sub-minute scope', a => { a.newlyAuthorised[0].end = '2026-10-24T14:59:59Z'; }],
]) test(`${name} rejects before approval or durable creation`, () => sandbox(async f => {
  const request = await f.request('apply'); mutate(f.admissions.get(request.operationId));
  await assert.rejects(() => f.journal.recordInitial(request));
  assert.deepEqual(await fs.readdir(f.config.directory), []);
}));

test('approval mutation, payload outside scope, stale generation and missing trusted admission reject', () => sandbox(async f => {
  let r = await f.request('apply');
  f.state.approvalChanges = a => { a.fingerprint = 'altered'; };
  await assert.rejects(() => f.journal.recordInitial(r), /APPROVAL/); f.state.approvalChanges = null;
  r.expectedOwnershipKey = hash('stale'); await assert.rejects(() => f.journal.recordInitial(r), /STALE/);
  r = await f.request('apply'); const payloadValue = JSON.parse(r.payloadJson); payloadValue.tou_settings.tariff_content_v2.utility = 'altered'; r.payloadJson = key(payloadValue);
  await assert.rejects(() => f.journal.recordInitial(r), /OUTSIDE_SCOPE/);
  r = await f.request('apply'); delete f.ports.readOwnershipAttributionAdmission;
  await assert.rejects(() => f.journal.recordInitial(r), /TRUSTED_ATTRIBUTION/);
}));

test('generation, baseline, predecessor, pricing and validity remain bound under rehashed documentary tampering', () => sandbox(async f => {
  const { record, history, pending } = await confirmed(f, 'apply'), i = record.initial.intent;
  for (const mutate of [
    a => { a.expectedAfterGeneration = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; },
    a => { a.beforeGeneration = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; },
    a => { a.energySiteId = '54321'; },
    a => { a.timeZone = 'Europe/Paris'; },
    a => { a.originalFingerprint = hash('changed original'); },
    a => { a.originIssuanceReference = hash('changed origin'); },
    a => { a.predecessor = { operationId: 'fake' }; },
    a => { a.admission.pricing.evidenceId = hash('changed independent admission'); },
    a => { a.admission.validity.end = instant('17'); },
  ]) {
    const t = structuredClone(i.ownershipAttribution); mutate(t); const { attributionId, ...body } = t; void attributionId; t.attributionId = hash(body);
    const result = api.validateOwnershipAttribution(t, i, pending.prepared.capture, f.admissions.get(i.operationId), pending.prepared.originIssuanceReference);
    assert.equal(result.status, 'rejected'); noAuthority(result);
  }
  const alteredCapture = structuredClone(pending.prepared.capture); alteredCapture.teslaObservationId = 'unadmitted-source';
  assert.equal(api.validateOwnershipAttribution(i.ownershipAttribution, i, alteredCapture, f.admissions.get(i.operationId), pending.prepared.originIssuanceReference).status, 'rejected');
  const docContext = structuredClone(history.history.contexts[0]); delete docContext.ownershipAttributions;
  assert.equal(evidence.validateConfirmedOperationEvidence(record, docContext).status, 'rejected');
  const paths = (await fs.readdir(f.config.directory)).filter(n => n.endsWith('.complete'));
  const file = path.join(f.config.directory, paths[0]), marker = JSON.parse(await fs.readFile(file, 'utf8'));
  const t = marker.prepared.initial.intent.ownershipAttribution; t.admission.pricing.evidenceId = hash('rehash cannot authenticate');
  const { attributionId, ...attributionBody } = t; void attributionId; t.attributionId = hash(attributionBody);
  const intent = marker.prepared.initial.intent, approval = marker.prepared.initial.approval; approval.fingerprint = key(intent);
  const { approvalId, ...approved } = approval; void approvalId; approval.approvalId = hash(approved);
  const { initialRecordId, ...initialBody } = marker.prepared.initial; void initialRecordId; marker.prepared.initial.initialRecordId = hash(initialBody);
  const { fingerprint, ...preparedBody } = marker.prepared; void fingerprint; marker.prepared.fingerprint = hash(preparedBody);
  const { checksum, ...markerBody } = marker; void checksum; marker.checksum = hash(markerBody);
  const journalFile = path.join(f.config.directory, paths[0].replace('.complete', '.jsonl'));
  const pair = (await fs.readFile(journalFile, 'utf8')).trim().split('\n').map(JSON.parse);
  pair[0] = marker.prepared.initial; pair[1].initialRecordId = pair[0].initialRecordId;
  const { completionRecordId, ...completionBody } = pair[1]; void completionRecordId; pair[1].completionRecordId = hash(completionBody);
  marker.completionRecordId = pair[1].completionRecordId;
  marker.evidenceId = hash({ version: 2, initial: pair[0], completion: pair[1] });
  const { checksum: previousChecksum, ...rehashBody } = marker; void previousChecksum; marker.checksum = hash(rehashBody);
  await fs.writeFile(journalFile, pair.map(key).join('\n') + '\n');
  await fs.writeFile(file, key(marker) + '\n');
  const reopened = await f.journal.readHistory();
  assert.equal(reopened.status, 'blocked'); assert.equal(reopened.code, 'OWNERSHIP_ATTRIBUTION_CONFLICT');
}));

test('attributed updates cannot downgrade, renew validity or change previous interval attribution', () => sandbox(async f => {
  const first = await confirmed(f, 'apply'); f.advance(first.record, first.history.history.contexts[0].retainedOriginal);
  const r = await f.request('update'), legacy = structuredClone(r); delete legacy.ownershipAttributionVersion;
  await assert.rejects(() => f.journal.recordInitial(legacy), /DOWNGRADE/);
  f.admissions.get(r.operationId).validity.end = instant('17'); await assert.rejects(() => f.journal.recordInitial(r), /VALIDITY/);
  const s = f.state.ownership.snapshot; s.evidence.intervals[0].applied.amount = .07;
  const { checksum, historyDigest, ...bound } = s; void checksum; void historyDigest; s.checksum = hash(bound); r.expectedOwnershipKey = hash(f.state.ownership);
  await assert.rejects(() => f.journal.recordInitial(r), /PREDECESSOR/);
}));

test('half-open boundary does not authorise an adjacent minute; malformed evidence rejects without throwing', () => sandbox(async f => {
  const { record, pending } = await confirmed(f, 'apply'), i = record.initial.intent;
  assert.equal(i.ownershipAttribution.projectedIntervals[0].end, '2026-10-24T15:00:00.000Z');
  const a = structuredClone(f.admissions.get(i.operationId)); a.newlyAuthorised[0].end = '2026-10-24T15:01:00Z';
  assert.equal(api.validateOwnershipAttribution(i.ownershipAttribution, i, pending.prepared.capture, a, pending.prepared.originIssuanceReference).status, 'rejected');
  for (const value of [null, {}, { version: 99 }, [], 'invalid', { get version() { throw Error('getter'); } }]) {
    assert.doesNotThrow(() => api.validateOwnershipAttribution(value, i, pending.prepared.capture, f.admissions.get(i.operationId), pending.prepared.originIssuanceReference));
    assert.equal(api.validateOwnershipAttribution(value, i, pending.prepared.capture, f.admissions.get(i.operationId), pending.prepared.originIssuanceReference).status, 'rejected');
  }
}));

for (const [name, date, policyEnd] of [
  ['autumn fold', '2026-10-25', '2026-10-26T00:00:00Z'],
  ['spring gap', '2026-03-29', '2026-03-30T00:00:00Z'],
]) test(`explicit UTC intervals preserve ${name} without inventing wall-clock coverage`, async () => {
  const f = fixture(), r = await f.request('apply');
  const prepared = await load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareOperationMutationContext(r,
    { ...f.ports, readConfirmedHistory: async () => ({ records: [], contexts: [] }) });
  const i = structuredClone(prepared.initial.intent); delete i.ownershipAttribution;
  const c = structuredClone(prepared.capture), a = structuredClone(f.admissions.get(i.operationId));
  i.preparedAt = date === '2026-10-25' ? '2026-10-24T12:00:00Z' : '2026-03-28T12:00:00Z';
  i.validFrom = i.preparedAt; i.expiresAt = new Date(Date.parse(i.preparedAt) + 60000).toISOString();
  i.before.observation.source.observedAt = i.preparedAt; i.original = structuredClone(i.before.observation);
  c.observation = structuredClone(i.before.observation);
  c.kraken.lastSuccessfulUpdate = i.preparedAt; c.kraken.importTariff.observedAt = i.preparedAt;
  c.kraken.importTariff.version.effectiveFrom = `${date}T00:00:00Z`;
  c.kraken.importTariff.version.effectiveTo = policyEnd;
  const domain = { start: `${date}T00:00:00Z`, end: `${date}T03:00:00Z` };
  const change = { start: domain.start, end: `${date}T02:00:00Z`, price: price(.08) };
  c.kraken.vehicles[0].plannedDispatches = [{ start: change.start, end: change.end, type: 'SMART', energyAddedKwh: null }];
  a.domain = domain; a.newlyAuthorised = [change];
  a.schedule.coverage = structuredClone(domain); a.schedule.fingerprint = hash(c.kraken.vehicles);
  a.pricing.coverage = structuredClone(domain); a.pricing.fingerprint = hash(c.kraken.importTariff);
  a.validity = { ...a.validity, start: i.preparedAt, end: policyEnd };
  i.before.observationId = api.operationCaptureIdentity(c, prepared.originIssuanceReference);
  i.payloadJson = payload(c.observation, domain, [change], i.preparedAt); i.payloadFingerprint = hash(JSON.parse(i.payloadJson));
  const attribution = api.buildOwnershipAttribution(i, c, a, prepared.originIssuanceReference);
  assert.equal(attribution.projectedIntervals.reduce((sum, w) => sum + Date.parse(w.end) - Date.parse(w.start), 0), 2 * 3600000);
  const valid = api.validateOwnershipAttribution(attribution, i, c, a, prepared.originIssuanceReference);
  assert.equal(valid.status, 'validated'); noAuthority(valid);
  if (name === 'autumn fold') {
    const oneOccurrence = structuredClone(a); oneOccurrence.domain.end = `${date}T01:00:00Z`; oneOccurrence.newlyAuthorised[0].end = oneOccurrence.domain.end;
    // The proposed tariff affects both occurrences of 01:00 local time. Claiming
    // only the first UTC occurrence must not pass the outside-domain check.
    assert.throws(() => api.buildOwnershipAttribution(i, c, oneOccurrence, prepared.originIssuanceReference), /OUTSIDE_SCOPE/);
  }
});

test('pending attributed evidence remains blocking across restart, with no runtime completion capability', () => sandbox(async f => {
  const pending = await f.journal.recordInitial(await f.request('apply'));
  const before = key(f.state.ownership);
  const recovery = await journals.offlineOperationJournal(f.config, f.ports).readHistory();
  assert.equal(recovery.status, 'blocked'); assert.equal(recovery.code, 'ATTEMPT_IN_PROGRESS'); noAuthority(recovery);
  const runtime = load('src/lib/tesla-tariff/supervised-journal.ts');
  for (const documentary of [pending, pending.prepared, pending.prepared.initial.intent.ownershipAttribution, recovery])
    assert.equal(runtime.journalCompletionForRecords(documentary, pending.prepared.initial, {}), null);
  assert.equal(key(f.state.ownership), before);
}));

test('update can withdraw a previously owned interval without claiming new SMART ownership or retiring the obligation', () => sandbox(async f => {
  const first = await confirmed(f, 'apply'), root = first.history.history.contexts[0].retainedOriginal;
  f.advance(first.record, root);
  const r = await f.request('update'), a = f.admissions.get(r.operationId), c = await f.ports.capture('12345');
  a.newlyAuthorised = [];
  r.payloadJson = payload(c.observation, a.domain, [{ ...interval('14', '15'), price: price(.30) }], r.validFrom);
  const pending = await f.journal.recordInitial(r), result = await pending.recordCompletion();
  assert.equal(result.status, 'recorded');
  const t = result.evidence.initial.intent.ownershipAttribution;
  assert.equal(t.projectedIntervals.length, 0); assert.equal(t.admission.newlyAuthorised.length, 0);
  assert.ok(t.restorationAuthorised.length > 0);
  assert.equal(f.state.ownership.snapshot.lifecycle.restorationObligation, 'required'); noAuthority(result);
}));

test('legacy documentary preparation remains readable and cannot be silently promoted into attributed history', () => sandbox(async f => {
  const r = await f.request('apply'); delete r.ownershipAttributionVersion;
  const pending = await f.journal.recordInitial(r), result = await pending.recordCompletion();
  assert.equal(result.status, 'recorded'); assert.equal(result.evidence.initial.intent.ownershipAttribution, undefined);
  const history = await f.journal.readHistory(); f.advance(result.evidence, history.history.contexts[0].retainedOriginal);
  const update = await f.request('update');
  await assert.rejects(() => f.journal.recordInitial(update), /LEGACY_PREDECESSOR_HAS_NO_ATTRIBUTION/);
  const malformed = structuredClone(result.evidence.initial); malformed.intent.ownershipAttribution = null;
  const { initialRecordId, ...body } = malformed; void initialRecordId; malformed.initialRecordId = hash(body);
  assert.equal(evidence.validateOperationInitialRecord(malformed).status, 'rejected');
}));

test('initial phase rejects malformed attribution even after approval and all content identities are recomputed', () => sandbox(async f => {
  const { record } = await confirmed(f, 'apply');
  for (const mutate of [t => { t.version = 99; }, t => { t.admission.schedule = null; },
    t => { t.projectedIntervals = [null]; }, t => { t.admission.validity.basis = 'dispatch-duration'; }]) {
    const initial = structuredClone(record.initial), t = initial.intent.ownershipAttribution; mutate(t);
    const { attributionId, ...attributionBody } = t; void attributionId; t.attributionId = hash(attributionBody);
    const a = initial.approval; a.fingerprint = key(initial.intent);
    const { approvalId, ...approved } = a; void approvalId; a.approvalId = hash(approved);
    const { initialRecordId, ...body } = initial; void initialRecordId; initial.initialRecordId = hash(body);
    const result = evidence.validateOperationInitialRecord(initial); assert.equal(result.status, 'rejected'); noAuthority(result);
  }
}));

test('restore preserves historical validity after expiry and exact elapsed prefixes during an active interval', () => sandbox(async f => {
  const first = await confirmed(f, 'apply'), root = first.history.history.contexts[0].retainedOriginal;
  f.advance(first.record, root);
  const r = await f.request('restore'), base = await load('src/lib/tesla-tariff/prepared-mutation-context.ts').prepareOperationMutationContext(r,
    { ...f.ports, readConfirmedHistory: async () => (await f.journal.readHistory()).history });
  for (const active of [true, false]) {
    const i = structuredClone(base.initial.intent); delete i.ownershipAttribution;
    const c = structuredClone(base.capture), a = structuredClone(base.initial.intent.ownershipAttribution.admission);
    const at = active ? '2026-10-24T14:30:01Z' : '2026-10-24T17:00:01Z';
    i.preparedAt = at; i.before.observation.source.observedAt = at; c.observation = structuredClone(i.before.observation);
    c.kraken.lastSuccessfulUpdate = at; c.kraken.importTariff.observedAt = at;
    a.domain = active ? interval('14', '16') : interval('17', '18');
    a.schedule.coverage = structuredClone(a.domain); a.pricing.coverage = structuredClone(a.domain);
    a.pricing.fingerprint = hash(c.kraken.importTariff);
    i.before.observationId = api.operationCaptureIdentity(c, base.originIssuanceReference);
    const t = api.buildOwnershipAttribution(i, c, a, base.originIssuanceReference); i.ownershipAttribution = t;
    assert.equal(t.admission.validity.end, instant('16'), 'restore must preserve historical validity, never renew it');
    assert.equal(t.admission.newlyAuthorised.length, 0);
    assert.equal(t.projectedIntervals.length, 1);
    assert.equal(Date.parse(t.projectedIntervals[0].end), active ? Date.parse(at) : Date.parse(instant('15')));
    const submission = new Date(Date.parse(at) + 2000).toISOString(), projected = api.projectAttributedIntervals(i, submission);
    assert.equal(Date.parse(projected[0].end), active ? Date.parse(submission) : Date.parse(instant('15')));
    const checked = api.validateOwnershipAttribution(t, i, c, a, base.originIssuanceReference);
    assert.equal(checked.status, 'validated'); noAuthority(checked);
  }
}));

test('full evidence rejects Kraken that was fresh at preparation but stale at the recorded submission', () => sandbox(async f => {
  const first = await confirmed(f, 'apply'), record = structuredClone(first.record), context = structuredClone(first.history.history.contexts[0]);
  const at = seconds => new Date(Date.parse(instant('12')) + seconds * 1000).toISOString();
  const approval = record.initial.approval; approval.approvedAt = at(55);
  const { approvalId, ...approved } = approval; void approvalId; approval.approvalId = hash(approved);
  const { initialRecordId, ...initialBody } = record.initial; void initialRecordId; record.initial.initialRecordId = hash(initialBody);
  const completion = record.completion;
  completion.initialRecordId = record.initial.initialRecordId; completion.submittedAt = at(65); completion.completedAt = at(67); completion.journalCompletedAt = at(68);
  completion.readback.observation.source.observedAt = at(66);
  const { completionRecordId, ...completionBody } = completion; void completionRecordId; completion.completionRecordId = hash(completionBody);
  const { evidenceId, ...envelope } = record; void evidenceId; record.evidenceId = hash(envelope);
  context.approvals = [approval];
  context.authenticatedObservations.find(o => o.phase === 'readback').observation = structuredClone(completion.readback.observation);
  context.durableJournal = [{ initialRecordId: record.initial.initialRecordId, completionRecordId: completion.completionRecordId }];
  Object.assign(context.retainedOriginal.origin, { initialRecordId: record.initial.initialRecordId, classifiedRecordId: completion.completionRecordId, receiptKey: record.evidenceId });
  context.retainedOriginal.latestReadback.receiptKey = record.evidenceId;
  assert.equal(evidence.validateOperationInitialRecord(record.initial).status, 'validated');
  assert.equal(evidence.validateOperationCompletionRecord(completion, record.initial).status, 'validated');
  const checked = evidence.validateConfirmedOperationEvidence(record, context);
  assert.equal(checked.status, 'rejected'); assert.equal(checked.code, 'STALE_ATTRIBUTION_EVIDENCE'); noAuthority(checked);
}));
