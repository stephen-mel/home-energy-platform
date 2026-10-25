import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import assert from 'node:assert/strict';

const cache = new Map();
export function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, structuredClone, Date, Intl, Error, require(name) {
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
    assert.equal(name, 'node:crypto', `Contract must have no I/O, SQLite, journal or executor imports: ${name}`); return crypto;
  } }); return exports;
}
export const hash = load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
export const key = load('src/lib/tesla-tariff/rollback-evidence.ts').representationKey;
const attribution = load('src/lib/tesla-tariff/ownership-attribution.ts');
const projection = load('src/lib/tesla-tariff/observed-economic.ts').observedEconomicSignal;
const replacement = load('src/lib/tesla-tariff/observed-replacement.ts').prepareObservedReplacement;
const generation = load('src/lib/tesla-tariff/prepared-mutation-context.ts').expectedOperationGeneration;
const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
export const at = seconds => new Date(Date.parse('2026-10-24T12:00:00Z') + seconds * 1000).toISOString();
const observation = (tariff, time) => ({ source: { kind: 'tesla-site-info', energySiteId: '12345', timeZone: 'Europe/London', observedAt: time },
  tariff: structuredClone(tariff), diagnostics: [], rollbackProven: false });
function capture(tariff, time, n) {
  const date = time.slice(0, 10);
  return { teslaObservationId: `tesla-${n}`, krakenObservationId: `kraken-${n}`, observation: observation(tariff, time),
    kraken: { stale: false, lastSuccessfulUpdate: time, vehicles: [{ id: 'offline-asset', name: 'Offline', plannedDispatches: n === 3 ? [] : [
      { start: '2026-10-24T14:00:00Z', end: '2026-10-24T16:00:00Z', type: 'SMART', energyAddedKwh: null }] }],
    importTariff: { status: 'available', accountRef: 'offline-account', observedAt: time, exportStatus: 'unknown',
      agreement: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', productCode: 'offline-product', tariffCode: 'offline-tariff', meterPointRef: 'offline-meter' },
      version: { id: 'offline-pricing', name: 'Offline pricing', provider: 'eon-next-kraken', effectiveFrom: `${date}T00:00:00Z`,
        effectiveTo: `${date}T23:59:00Z`, pricesIncludeVat: true, normalImport: price(.30), scheduledChargingImport: price(.08),
        standingCharge: null, export: null, dailyImportWindows: [{ start: '00:00', end: '06:00', kind: 'guaranteed-off-peak', price: price(.08) }] } } } };
}
function payload(before, domain, changes, preparedAt) {
  const signal = structuredClone(projection(before, domain).signal);
  signal.import = signal.import.flatMap(w => {
    const points = [...new Set([Date.parse(w.start), Date.parse(w.end), ...changes.flatMap(c => [Date.parse(c.start), Date.parse(c.end)])]
      .filter(p => p >= Date.parse(w.start) && p <= Date.parse(w.end)))].sort((a, b) => a - b);
    return points.slice(0, -1).map((p, n) => ({ ...w, start: new Date(p).toISOString(), end: new Date(points[n + 1]).toISOString(),
      price: changes.find(c => Date.parse(c.start) <= p && Date.parse(c.end) >= points[n + 1])?.price ?? w.price }));
  });
  const result = replacement({ observation: before, generatedAt: preparedAt, comparisonDomain: domain, dispatchEvidenceKey: hash('schedule') }, signal, '12345', 'Europe/London');
  assert.equal(result.structurallyValid, true); return key({ tou_settings: { tariff_content_v2: result.representation } });
}
export function mapIdentity(record, runtime, originKey, previous) {
  const i = record.initial.intent;
  const body = { version: 2, operationId: i.operationId, mutationId: i.mutationId, kind: i.kind, energySiteId: i.energySiteId, timeZone: i.timeZone,
    documentary: { version: 2, evidenceId: record.evidenceId }, runtime,
    journal: { version: 2, initialRecordId: record.initial.initialRecordId, completionRecordId: record.completion.completionRecordId }, retainedOriginKey: originKey,
    ownership: { beforeGeneration: i.ownershipBefore?.generation ?? null, afterGeneration: i.ownershipAfterGeneration, priorHistoryDigest: i.ownershipBefore?.historyDigest ?? null },
    predecessorApplicationId: previous?.applicationId ?? null };
  return { ...body, applicationId: hash({ purpose: 'smart-ownership-application-v2', ...body }) };
}
export function document(snapshot, applications, restore = null) {
  const last = applications.at(-1), readback = restore?.completion.readback;
  const body = { version: 2, kind: 'ownership-lifecycle-document', energySiteId: '12345', timeZone: 'Europe/London',
    generation: restore?.initial.intent.ownershipAfterGeneration ?? snapshot.generation, historicalOwnership: structuredClone(snapshot), applications: structuredClone(applications),
    historyId: hash({ version: 2, purpose: 'smart-ownership-history-v2', applications: applications.map(a => a.applicationId) }),
    state: restore ? 'restored' : 'active', restorationObligation: restore ? 'retired' : 'required',
    restoration: restore ? { version: 1, operation: structuredClone(restore), applicationId: last.applicationId, predecessorApplicationId: last.predecessorApplicationId,
      retainedOriginKey: last.retainedOriginKey, terminalGeneration: restore.initial.intent.ownershipAfterGeneration,
      readback: { observationId: readback.observationId, observationFingerprint: hash(readback.observation), tariffFingerprint: restore.completion.finalTariffFingerprint, observedAt: readback.observation.source.observedAt } } : null };
  return { ...body, lifecycleId: hash({ purpose: 'smart-ownership-lifecycle-v2', ...body }) };
}
let cached;
export function fixture(state = 'restored') {
  if (!cached) {
    const tariff = structuredClone(load('src/lib/tesla-tariff/experiment-tariff.ts').experimentTariff()); tariff.energy_charges.Annual.rates.TEST = .30;
    const original = observation(tariff, at(0)), originReference = hash('opaque-origin-reference-no-runtime-issuance');
    const validity = { basis: 'explicit-ownership-policy', start: '2026-10-24T12:00:00Z', end: '2026-10-24T16:00:00Z',
      policyId: hash('offline-explicit-policy'), evidenceId: hash('offline-policy-admission') };
    let snapshot = null, root, previousDocument = null;
    const operations = [], runtimes = [], applications = [], cases = {};
    for (const [n, kind, t] of [[1, 'apply', 0], [2, 'update', 10], [3, 'restore', 86400]]) {
      const before = snapshot, prior = operations.at(-1)?.evidence, op = `operation-${n}`, mutation = `mutation-${n}`;
      const c = capture(prior?.completion.readback.observation.tariff ?? tariff, at(t), n), date = at(t).slice(0, 10);
      const domain = { start: `${date}T13:00:00Z`, end: `${date}T16:00:00Z` };
      const changes = kind === 'restore' ? [] : [{ start: `2026-10-24T${n === 1 ? '14' : '15'}:00:00Z`, end: `2026-10-24T${n === 1 ? '15' : '16'}:00:00Z`, price: price(.08) }];
      const admission = { version: 1, operationId: op, mutationId: mutation, domain, newlyAuthorised: changes,
        schedule: { evidenceId: hash(`schedule-${n}`), coverage: structuredClone(domain), observationId: c.krakenObservationId, fingerprint: hash(c.kraken.vehicles) },
        pricing: { evidenceId: hash(`pricing-${n}`), coverage: structuredClone(domain), fingerprint: hash(c.kraken.importTariff) }, validity: structuredClone(validity) };
      const intent = { kind, operationId: op, mutationId: mutation, energySiteId: '12345', timeZone: 'Europe/London',
        predecessor: prior ? { operationId: prior.initial.intent.operationId, mutationId: prior.initial.intent.mutationId, evidenceId: prior.evidenceId, completionRecordId: prior.completion.completionRecordId } : null,
        ownershipBefore: structuredClone(before), ownershipAfterGeneration: generation('12345', op, mutation, before ? { status: 'available', snapshot: before } : { status: 'missing' }),
        original: structuredClone(original), originalFingerprint: hash(tariff), origin: structuredClone(before?.lifecycle.origin ?? null),
        before: { observationId: attribution.operationCaptureIdentity(c, originReference), observation: c.observation },
        payloadJson: kind === 'restore' ? key({ tou_settings: { tariff_content_v2: tariff } }) : payload(c.observation, domain, changes, at(t + 1)),
        preparedAt: at(t + 1), validFrom: at(t + 1), expiresAt: at(t + 120) };
      intent.payloadFingerprint = hash(JSON.parse(intent.payloadJson));
      intent.ownershipAttribution = attribution.buildOwnershipAttribution(intent, c, admission, originReference);
      const approved = { version: 2, operationId: op, mutationId: mutation, fingerprint: key(intent), approvedAt: at(t + 2) };
      const initialBody = { journalSchemaVersion: 2, phase: 'approved-operation', intent, approval: { ...approved, approvalId: hash(approved) } };
      const initial = { ...initialBody, initialRecordId: hash(initialBody) };
      const after = observation(JSON.parse(intent.payloadJson).tou_settings.tariff_content_v2, at(t + 4));
      const completionBody = { journalSchemaVersion: 2, phase: 'confirmed-operation', operationId: op, mutationId: mutation, energySiteId: '12345', timeZone: 'Europe/London', initialRecordId: initial.initialRecordId,
        ownershipAfterGeneration: intent.ownershipAfterGeneration, submittedAt: at(t + 3), completedAt: at(t + 5), journalCompletedAt: at(t + 6), apiWrite: { status: 'accepted', httpStatus: 200 },
        readback: { observationId: `readback-${n}`, observation: after }, finalTariffFingerprint: hash(after.tariff), outcome: { apply: 'applied', update: 'updated', restore: 'restored' }[kind] };
      const completion = { ...completionBody, completionRecordId: hash(completionBody) }, envelope = { version: 2, initial, completion }, record = { ...envelope, evidenceId: hash(envelope) };
      root ??= { version: 1, energySiteId: '12345', timeZone: 'Europe/London', original: structuredClone(original), originalFingerprint: hash(tariff),
        origin: { mutationId: mutation, initialRecordId: initial.initialRecordId, classifiedRecordId: completion.completionRecordId, receiptKey: record.evidenceId, issuanceKey: originReference, journal: 'attempt' },
        restorationObligation: 'required', currentGeneration: intent.ownershipAfterGeneration, latestReadback: { mutationId: mutation, receiptKey: record.evidenceId, fingerprint: completion.finalTariffFingerprint } };
      const lastContext = operations.at(-1)?.context;
      const context = { energySiteId: '12345', timeZone: 'Europe/London', ownershipBefore: structuredClone(before), ownershipAfterGeneration: intent.ownershipAfterGeneration,
        retainedOriginal: structuredClone(before?.lifecycle ?? root), confirmedHistory: operations.map(o => structuredClone(o.evidence)), approvals: [...(lastContext?.approvals ?? []), initial.approval],
        authenticatedObservations: [...(lastContext?.authenticatedObservations ?? []), ...[['before', intent.before], ['readback', completion.readback]].map(([phase, o]) => ({ ...o, operationId: op, mutationId: mutation, phase }))],
        durableJournal: [...(lastContext?.durableJournal ?? []), { initialRecordId: initial.initialRecordId, completionRecordId: completion.completionRecordId }],
        ownershipAttributions: [...(lastContext?.ownershipAttributions ?? []), { operationId: op, capture: c, admission, originIssuanceReference: originReference }] };
      operations.push({ evidence: record, context });
      // Explicit fixture references, NOT receipts, registry members or issuance.
      const runtime = { version: 1, namespace: 'runtime-confirmed-operation', receiptVersion: 2, operationId: op, mutationId: mutation,
        receiptKey: hash(`offline-runtime-receipt-reference-${n}`), issuanceKey: hash(`offline-runtime-issuance-reference-${n}`) };
      runtimes.push(runtime); applications.push(mapIdentity(record, runtime, load('src/lib/tesla-tariff/retained-original.ts').retainedOriginKey(root), applications.at(-1)));
      if (kind !== 'restore') {
        const lifecycle = { ...structuredClone(root), currentGeneration: intent.ownershipAfterGeneration,
          latestReadback: { mutationId: mutation, receiptKey: record.evidenceId, fingerprint: completion.finalTariffFingerprint } };
        const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: at(5), updatedAt: completion.completedAt, validUntil: validity.end,
          basis: 'confirmed-write-readback', baselineFingerprint: hash(tariff), readbackFingerprint: completion.finalTariffFingerprint,
          proposalFingerprint: hash(intent), smartEvidenceFingerprint: hash(c.kraken), intervals: attribution.projectAttributedIntervals(intent, completion.submittedAt) };
        const bound = { version: 3, generation: intent.ownershipAfterGeneration, evidence, lifecycle };
        snapshot = { ...bound, checksum: hash(bound), historyDigest: hash({ fixtureOnly: n, evidenceId: record.evidenceId }) };
      }
      const value = document(snapshot, applications, kind === 'restore' ? record : null);
      cases[kind === 'restore' ? 'restored' : kind] = structuredClone({ value, context: { version: 1, energySiteId: '12345', timeZone: 'Europe/London',
        historicalOwnership: snapshot, operations, runtimeIdentities: runtimes, previousLifecycle: previousDocument } });
      previousDocument = value;
    }
    cached = cases;
  }
  return structuredClone(cached[state]);
}
