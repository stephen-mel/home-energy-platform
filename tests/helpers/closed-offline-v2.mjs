// TEST ONLY / OFFLINE. Closed fixture composition, NOT an authentication service.
// No caller-selected paths, providers, ports, documents or authentication flags.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadStore } from './ownership-sqlite-harness.mjs';
import { fixture, hash, key } from './ownership-lifecycle.mjs';
import { persistenceFixture, seedDatabase, seedJournal } from './ownership-persistence.mjs';

const scenarios = new Set(['valid', 'stale-tesla', 'stale-kraken', 'conflicting-observation', 'missing-observation',
  'missing-coverage', 'missing-validity', 'approval-mismatch', 'payload-mismatch', 'generation-substitution',
  'validity-substitution', 'attribution-substitution', 'existing-ownership', 'prior-history', 'pending',
  'ambiguous', 'historical-latch', 'export-mismatch', 'buy-below-sell']);
const flags = Object.freeze({ mode: 'offline-test-only', authentication: 'fixtures-only', writeReady: false,
  executionReady: false, grantsAdmissionAuthority: false, grantsSuccessorAuthority: false,
  grantsRepeatAuthority: false, grantsRestorationAuthority: false, runtimeConfirmationVerified: false });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function noArguments(args) { if (args.length) throw Error('C1_INPUT_SUBSTITUTION_REJECTED'); }

/** The scenario name selects a fixed internal TEST fault, never trusted input.
 * Returned documents have no runtime identity or authority. Temporary fixture
 * setup may seed pre-existing SQL/journal data; preparation never commits ownership.
 * Provider code is owned by this module, not configurable through its interface. */
export async function closedOfflineV2(...args) {
  const scenario = args.length ? args[0] : 'valid';
  if (args.length > 1 || typeof scenario !== 'string' || !scenarios.has(scenario)) throw Error('C1_PROVIDER_SUBSTITUTION_REJECTED');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hep-closed-v2-')));
  const file = path.join(root, 'ownership', 'ownership.sqlite'), directory = path.join(root, 'tesla-experiments');
  try {
    let priorAdmissionReader;
    await fs.mkdir(path.dirname(file));
    if (scenario === 'existing-ownership') seedDatabase(file, persistenceFixture('apply'));
    else {
      const db = new DatabaseSync(file);
      try {
        // Same existing strict schema, empty rows. No ownership finaliser/commit.
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE ownership(site TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
          CREATE TABLE applied(site TEXT NOT NULL REFERENCES ownership(site), mutation TEXT NOT NULL, issuance TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(site,mutation), UNIQUE(site,issuance)) STRICT;
          PRAGMA user_version=2; COMMIT;`);
      } finally { db.close(); }
    }
    await fs.mkdir(directory);
    if (scenario === 'prior-history') priorAdmissionReader = await seedJournal(directory, persistenceFixture('apply'));
    if (['pending', 'ambiguous'].includes(scenario)) await fs.writeFile(path.join(directory, 'site-12345-attempt.active'), scenario + '\n', { flag: 'wx' });
    if (scenario === 'historical-latch') await fs.writeFile(path.join(directory, 'site-12345.jsonl'), 'historical-latch-test-sentinel\n', { flag: 'wx' });

    const base = fixture('apply').context.operations[0], i = base.evidence.initial.intent;
    const source = structuredClone(base.context.ownershipAttributions[0].capture);
    const admission = structuredClone(i.ownershipAttribution.admission);
    // An independently stated, fixed test policy, preserved from the fixture;
    // never calculated from dispatch length, comparison domain or approval TTL.
    const policy = structuredClone(admission.validity);
    const rate = scenario === 'buy-below-sell' ? .08 : .20;
    source.kraken.importTariff.version.scheduledChargingImport.amount = rate;
    source.kraken.importTariff.version.dailyImportWindows[0].price.amount = rate;
    admission.newlyAuthorised[0].price.amount = rate;
    admission.schedule.fingerprint = hash(source.kraken.vehicles);
    admission.pricing.fingerprint = hash(source.kraken.importTariff);
    const origin = base.context.ownershipAttributions[0].originIssuanceReference;
    const store = loadStore(), load = store.load;
    const economic = load('src/lib/tesla-tariff/observed-economic.ts').observedEconomicSignal;
    const replace = load('src/lib/tesla-tariff/observed-replacement.ts').prepareObservedReplacement;
    const signal = structuredClone(economic(source.observation, admission.domain).signal);
    signal.import = signal.import.flatMap(w => {
      const points = [...new Set([Date.parse(w.start), Date.parse(w.end), ...admission.newlyAuthorised.flatMap(c => [Date.parse(c.start), Date.parse(c.end)])]
        .filter(t => t >= Date.parse(w.start) && t <= Date.parse(w.end)))].sort((a, b) => a - b);
      return points.slice(0, -1).map((t, n) => ({ ...w, start: new Date(t).toISOString(), end: new Date(points[n + 1]).toISOString(),
        price: admission.newlyAuthorised.find(c => Date.parse(c.start) <= t && Date.parse(c.end) >= points[n + 1])?.price ?? w.price }));
    });
    const replacement = replace({ observation: source.observation, generatedAt: i.preparedAt, comparisonDomain: admission.domain,
      dispatchEvidenceKey: admission.schedule.evidenceId }, signal, '12345', 'Europe/London');
    if (!replacement.structurallyValid) throw Error('C1_FIXTURE_PAYLOAD_INVALID');
    const proposed = structuredClone(replacement.representation);
    if (scenario === 'export-mismatch') Object.values(proposed.sell_tariff.energy_charges)[0].rates.TEST = .19;
    const payloadJson = key({ tou_settings: { tariff_content_v2: proposed } });
    const request = { kind: 'apply', operationId: i.operationId, mutationId: i.mutationId, energySiteId: '12345', timeZone: 'Europe/London',
      expectedOwnershipKey: hash({ status: 'missing' }), payloadJson, validFrom: i.validFrom, expiresAt: i.expiresAt, ownershipAttributionVersion: 1 };
    let clock = i.preparedAt, captureReads = 0, attributionReads = 0, closed = false;
    const preparation = load('src/lib/tesla-tariff/prepared-mutation-context.ts');
    const ports = {
      now: () => clock,
      readOwnership: async site => store.readOwnership(file, site),
      readOriginIssuanceReference: async () => origin,
      capture: async () => {
        const c = structuredClone(source); captureReads++;
        if (scenario === 'stale-tesla') c.observation.source.observedAt = '2026-10-24T10:00:00Z';
        if (scenario === 'stale-kraken') c.kraken.lastSuccessfulUpdate = '2026-10-24T10:00:00Z';
        if (scenario === 'missing-observation') throw Error('C1_OBSERVATION_FIXTURE_MISSING');
        if (scenario === 'conflicting-observation' && captureReads > 1) c.observation.tariff.name = 'Conflicting external tariff';
        return c;
      },
      readOwnershipAttributionAdmission: async (site, operation, mutation) => {
        if (site !== '12345' || operation !== i.operationId || mutation !== i.mutationId) throw Error('C1_FIXTURE_IDENTITY_CONFLICT');
        if (scenario === 'prior-history') return priorAdmissionReader(site, operation, mutation);
        const a = structuredClone(admission); attributionReads++;
        if (scenario === 'missing-coverage') delete a.schedule.coverage;
        if (scenario === 'missing-validity') delete a.validity;
        if (scenario === 'validity-substitution' && attributionReads > 1) a.validity.end = '2026-10-24T17:00:00Z';
        if (scenario === 'attribution-substitution' && attributionReads > 1) a.pricing.fingerprint = hash('substituted-pricing');
        return a;
      },
      approve: async intent => {
        if (intent.kind !== 'apply' || intent.energySiteId !== '12345' || intent.timeZone !== 'Europe/London'
          || intent.operationId !== i.operationId || intent.mutationId !== i.mutationId || intent.payloadJson !== payloadJson
          || intent.payloadFingerprint !== hash(JSON.parse(payloadJson)) || intent.ownershipBefore !== null || intent.predecessor !== null
          || intent.ownershipAfterGeneration !== preparation.expectedOperationGeneration('12345', i.operationId, i.mutationId, { status: 'missing' })
          || key(intent.ownershipAttribution.admission.validity) !== key(policy) || key(intent.original) !== key(source.observation))
          throw Error('C1_EXACT_APPROVAL_FIXTURE_MISMATCH');
        clock = base.evidence.initial.approval.approvedAt;
        const bound = { version: 2, operationId: intent.operationId, mutationId: intent.mutationId, fingerprint: key(intent), approvedAt: clock };
        if (scenario === 'approval-mismatch') bound.operationId = 'wrong-operation';
        if (scenario === 'payload-mismatch') bound.fingerprint = key({ ...intent, payloadJson: '{}' });
        if (scenario === 'generation-substitution') bound.fingerprint = key({ ...intent, ownershipAfterGeneration: '00000000-0000-8000-8000-000000000000' });
        return { ...bound, approvalId: hash(bound) };
      },
      readCompletionEvidence: async () => { throw Error('C1_COMPLETION_DISABLED'); },
    };
    const journalApi = load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
    const config = { mode: 'offline', directory, durableRoot: root, site: '12345' };
    const journal = journalApi.offlineOperationJournal(config, ports);
    const ensureOpen = () => { if (closed) throw Error('C1_CLOSED'); };
    const inspect = async () => {
      const names = (await fs.readdir(directory)).sort(), db = new DatabaseSync(file, { readOnly: true });
      let ownershipRows, applicationRows;
      try {
        ownershipRows = db.prepare('SELECT count(*) AS n FROM ownership').get().n;
        applicationRows = db.prepare('SELECT count(*) AS n FROM applied').get().n;
      } finally { db.close(); }
      return freeze({ ...flags, ownershipRows, applicationRows, databaseFingerprint: hash([...await fs.readFile(file)]),
        files: await Promise.all(names.map(async name => ({ name, fingerprint: hash([...await fs.readFile(path.join(directory, name))]) }))) });
    };
    return Object.freeze({
      ...flags,
      async prepare(...args) {
        noArguments(args); ensureOpen();
        const ownership = store.readOwnership(file, '12345'), history = await journal.readHistory();
        if (ownership.status !== 'missing') throw Error('C1_FIRST_APPLY_OWNERSHIP_NOT_EMPTY');
        if (history.status !== 'empty') throw Error('C1_FIRST_APPLY_HISTORY_NOT_EMPTY');
        // Preserve existing export validation and BUY_BELOW_SELL diagnostics.
        const exportPolicy = load('src/lib/tesla-tariff/fixed-export-policy.ts').validateFixedExportPolicy({
          observation: source.observation, assessedAt: clock,
          assumption: { provider: 'eon-next', tariff: 'Export Premium v3', price: { amount: .175, currency: 'GBP', unit: 'kWh' },
            validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', confirmedAt: '2026-10-24T12:00:00Z' } });
        if (exportPolicy.status !== 'verified' || hash(proposed.sell_tariff) !== exportPolicy.exportFingerprint) throw Error('C1_FIXED_EXPORT_BLOCKED');
        const dryRun = load('src/lib/tesla-tariff/dry-run.ts').dryRunTeslaTariff(economic({ ...source.observation, tariff: proposed }, admission.domain).signal, { timeZone: 'Europe/London' });
        if (dryRun.diagnostics.some(d => d.code === 'BUY_BELOW_SELL')) throw Error('BUY_BELOW_SELL');
        // recordInitial internally invokes preparation, attribution building and
        // fresh rechecks under the existing exclusive durable claim. Deliberately
        // discard the completion handle; return only detached documentary data.
        const pending = await journal.recordInitial(structuredClone(request));
        return freeze({ ...flags, status: 'prepared-offline', prepared: structuredClone(pending.prepared),
          baselineFingerprint: hash(source.observation.tariff), approvedValidity: structuredClone(policy) });
      },
      async inspect(...args) { noArguments(args); ensureOpen(); return inspect(); },
      async reopen(...args) {
        noArguments(args); ensureOpen();
        const reopened = loadStore().load('src/lib/tesla-tariff/repeat-attempt-journal.ts').offlineOperationJournal(config, ports);
        return freeze({ ...flags, history: structuredClone(await reopened.readHistory()), storage: await inspect() });
      },
      async close(...args) { noArguments(args); if (!closed) { closed = true; await fs.rm(root, { recursive: true, force: true }); } },
    });
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
