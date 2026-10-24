import fs from 'node:fs';
import io from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import assert from 'node:assert/strict';

export function operationModules(native = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText, { exports, structuredClone, Date, Intl, Error, require(name) {
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      const allowed = { 'node:fs/promises': io, 'node:path': path, 'node:crypto': crypto, ...native };
      assert.ok(name in allowed, `No network, credentials, SQLite or executor clients: ${name}`); return allowed[name];
    } }); return exports;
  }
  return load;
}
const load = operationModules();
export const hash = load('src/lib/tesla-tariff/ownership-transition.ts').ownershipFingerprint;
export const key = load('src/lib/tesla-tariff/rollback-evidence.ts').representationKey;
export const at = seconds => new Date(Date.parse('2026-10-24T12:00:00Z') + seconds * 1000).toISOString();
export function tariff(buy = .30) {
  const t = structuredClone(load('src/lib/tesla-tariff/experiment-tariff.ts').experimentTariff());
  t.energy_charges.Annual.rates.TEST = buy; return t;
}
const price = amount => ({ amount, currency: 'GBP', unit: 'kWh' });
function kraken(time) {
  return { stale: false, lastSuccessfulUpdate: time, vehicles: [{ id: 'offline-asset', name: 'Offline asset', plannedDispatches: [
    { start: '2026-10-24T14:00:00Z', end: '2026-10-24T15:00:00Z', type: 'SMART', energyAddedKwh: '2' }],
  }], importTariff: { status: 'available', accountRef: 'offline-account', observedAt: time, exportStatus: 'unknown',
    agreement: { validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', productCode: 'offline-product', tariffCode: 'offline-tariff', meterPointRef: 'offline-meter' },
    version: { id: 'offline-version', name: 'Offline import', provider: 'eon-next-kraken', effectiveFrom: '2026-10-24T00:00:00Z', effectiveTo: '2026-10-25T00:00:00Z',
      pricesIncludeVat: true, normalImport: price(.30), scheduledChargingImport: price(.08), standingCharge: null, export: null,
      dailyImportWindows: [{ start: '00:00', end: '06:00', kind: 'guaranteed-off-peak', price: price(.08) }] } } };
}
export function fixturePorts() {
  const state = { sequence: 1, clock: 1, ownership: { status: 'missing' }, current: tariff(), captureChanges: null, approvalChanges: null, completionChanges: null };
  function observation(content, time) {
    return { source: { kind: 'tesla-site-info', energySiteId: '12345', timeZone: 'Europe/London', observedAt: at(time) },
      tariff: structuredClone(content), diagnostics: [], rollbackProven: false };
  }
  const ports = {
    now: () => at(state.clock),
    readOwnership: async () => structuredClone(state.ownership),
    readOriginIssuanceReference: async () => hash('offline-origin-reference-no-runtime-issuance'),
    capture: async () => {
      const time = (state.sequence - 1) * 10;
      const capture = { teslaObservationId: `tesla-source-${state.sequence}`, krakenObservationId: `kraken-source-${state.sequence}`,
        observation: observation(state.current, time), kraken: kraken(at(time)) };
      state.captureChanges?.(capture); return capture;
    },
    approve: async intent => {
      state.clock = (state.sequence - 1) * 10 + 2;
      const approved = { version: 2, operationId: intent.operationId, mutationId: intent.mutationId, fingerprint: key(intent), approvedAt: at(state.clock) };
      const result = { ...approved, approvalId: hash(approved) }; state.approvalChanges?.(result); return result;
    },
    readCompletionEvidence: async initial => {
      const t = (state.sequence - 1) * 10; state.clock = t + 6;
      const result = { apiWrite: { status: 'accepted', httpStatus: 200 }, submittedAt: at(t + 3), completedAt: at(t + 5),
        readback: { observationId: `readback-source-${state.sequence}`,
          observation: observation(JSON.parse(initial.intent.payloadJson).tou_settings.tariff_content_v2, t + 4) } };
      state.completionChanges?.(result); return result;
    },
  };
  const request = kind => ({ kind, energySiteId: '12345', timeZone: 'Europe/London', operationId: `operation-${state.sequence}`, mutationId: `mutation-${state.sequence}`,
    expectedOwnershipKey: hash(state.ownership), validFrom: at((state.sequence - 1) * 10 + 1), expiresAt: at((state.sequence - 1) * 10 + 120),
    payloadJson: key({ tou_settings: { tariff_content_v2: kind === 'restore' ? state.ownership.snapshot.lifecycle.original.tariff : tariff(state.sequence === 1 ? .08 : .06) } }) });
  // Simulated V3 fixture state only. The implementation never creates/persists
  // ownership, reserves a generation or grants authority from this snapshot.
  function advance(record, retainedOriginal) {
    const lifecycle = { ...structuredClone(retainedOriginal), currentGeneration: record.initial.intent.ownershipAfterGeneration,
      latestReadback: { mutationId: record.initial.intent.mutationId, receiptKey: record.evidenceId, fingerprint: record.completion.finalTariffFingerprint } };
    const evidence = { version: 1, energySiteId: '12345', timeZone: 'Europe/London', createdAt: at(5), updatedAt: record.completion.completedAt,
      validUntil: '2026-10-25T23:00:00Z', basis: 'confirmed-write-readback', baselineFingerprint: lifecycle.originalFingerprint,
      readbackFingerprint: record.completion.finalTariffFingerprint, proposalFingerprint: hash(record.initial.intent), smartEvidenceFingerprint: hash('offline'), intervals: [] };
    const bound = { version: 3, generation: lifecycle.currentGeneration, evidence, lifecycle };
    state.ownership = { status: 'available', snapshot: { ...bound, checksum: hash(bound), historyDigest: hash(record.evidenceId) } };
    state.current = structuredClone(record.completion.readback.observation.tariff); state.sequence++; state.clock = (state.sequence - 1) * 10 + 1;
  }
  return { state, ports, request, advance };
}
