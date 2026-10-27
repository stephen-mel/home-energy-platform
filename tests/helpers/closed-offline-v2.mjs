// TEST ONLY / OFFLINE. Closed fixture composition, NOT an authentication service.
// No caller-selected paths, providers, ports, documents or authentication flags.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { loadStore } from './ownership-sqlite-harness.mjs';
import { fixture, hash, key } from './ownership-lifecycle.mjs';
import { persistenceFixture, seedDatabase, seedJournal } from './ownership-persistence.mjs';

const scenarios = new Set(['valid', 'stale-tesla', 'stale-kraken', 'conflicting-observation', 'missing-observation',
  'missing-coverage', 'missing-validity', 'approval-mismatch', 'payload-mismatch', 'generation-substitution',
  'validity-substitution', 'attribution-substitution', 'existing-ownership', 'prior-history', 'pending',
  'ambiguous', 'historical-latch', 'export-mismatch', 'buy-below-sell', 'interrupted-before-write',
  'interrupted-after-write', 'ambiguous-write', 'mismatched-readback', 'forged-completion', 'stale-before-execution',
  'receipt-copy', 'receipt-forged', 'receipt-substitution', 'receipt-replay', 'receipt-recovered',
  'receipt-payload', 'receipt-generation', 'receipt-approval', 'receipt-validity', 'receipt-site',
  'projection-copy', 'projection-payload', 'projection-generation', 'projection-validity',
  'projection-original', 'projection-terminal', 'projection-conflict', 'projection-replay', 'projection-validity-beyond-domain']);
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
    if (scenario === 'projection-validity-beyond-domain') admission.validity.end = '2026-10-24T17:00:00Z';
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
    let pendingOperation = null, liveAdmission = null, completionEvidence = null;
    let rehearsalStarted = false, recovered = false, simulatedWrites = 0;
    let liveCompletion = null, issuedReceipt = null, projectionStarted = false;
    let teslaState = structuredClone(source.observation.tariff);
    // TEST-ONLY identity membership. Never exported, persisted, registered in
    // the production completion registry, or restored from a document.
    const simulatedAdmissions = new WeakMap();
    const findSimulatedAdmission = simulatedAdmissions.get.bind(simulatedAdmissions);
    const registerSimulatedAdmission = simulatedAdmissions.set.bind(simulatedAdmissions);
    const offlineCompletions = new WeakMap();
    const completionFor = offlineCompletions.get.bind(offlineCompletions);
    const registerCompletion = offlineCompletions.set.bind(offlineCompletions);
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
      readCompletionEvidence: async initial => {
        if (!completionEvidence || !pendingOperation || !rehearsalStarted
          || key(initial) !== key(pendingOperation.prepared.initial)
          || key(completionEvidence.readback.observation.tariff) !== key(teslaState)
          || simulatedWrites !== 1) throw Error('C2_COMPLETION_NOT_FROM_SIMULATION');
        return structuredClone(completionEvidence);
      },
    };
    const journalApi = load('src/lib/tesla-tariff/repeat-attempt-journal.ts');
    const config = { mode: 'offline', directory, durableRoot: root, site: '12345' };
    const journal = journalApi.offlineOperationJournal(config, ports);
    const ensureOpen = () => { if (closed) throw Error('C1_CLOSED'); };
    const initialFile = path.join(directory, `site-12345-attempt-${i.mutationId}.jsonl`);
    const activeFile = path.join(directory, 'site-12345-attempt.active');
    const durableText = async file => {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw Error('C2_DURABLE_INITIAL_CHANGED');
      return fs.readFile(file, 'utf8');
    };
    const inspect = async () => {
      const names = (await fs.readdir(directory)).sort(), db = new DatabaseSync(file, { readOnly: true });
      let ownershipRows, applicationRows;
      try {
        ownershipRows = db.prepare('SELECT count(*) AS n FROM ownership').get().n;
        applicationRows = db.prepare('SELECT count(*) AS n FROM applied').get().n;
      } finally { db.close(); }
      return freeze({ ...flags, ownershipRows, applicationRows, simulatedWrites,
        simulatedTariffFingerprint: hash(teslaState), databaseFingerprint: hash([...await fs.readFile(file)]),
        files: await Promise.all(names.map(async name => ({ name, fingerprint: hash([...await fs.readFile(path.join(directory, name))]) }))) });
    };
    const prepareFirstApply = async () => {
        ensureOpen();
        const ownership = store.readOwnership(file, '12345'), history = await journal.readHistory();
        if (ownership.status !== 'missing') throw Error('C1_FIRST_APPLY_OWNERSHIP_NOT_EMPTY');
        if (history.status !== 'empty') throw Error('C1_FIRST_APPLY_HISTORY_NOT_EMPTY');
        if (recovered) throw Error('C2_LIVE_ADMISSION_REQUIRED');
        // Preserve existing export validation and BUY_BELOW_SELL diagnostics.
        const exportPolicy = load('src/lib/tesla-tariff/fixed-export-policy.ts').validateFixedExportPolicy({
          observation: source.observation, assessedAt: clock,
          assumption: { provider: 'eon-next', tariff: 'Export Premium v3', price: { amount: .175, currency: 'GBP', unit: 'kWh' },
            validFrom: '2026-01-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z', confirmedAt: '2026-10-24T12:00:00Z' } });
        if (exportPolicy.status !== 'verified' || hash(proposed.sell_tariff) !== exportPolicy.exportFingerprint) throw Error('C1_FIXED_EXPORT_BLOCKED');
        const dryRun = load('src/lib/tesla-tariff/dry-run.ts').dryRunTeslaTariff(economic({ ...source.observation, tariff: proposed }, admission.domain).signal, { timeZone: 'Europe/London' });
        if (dryRun.diagnostics.some(d => d.code === 'BUY_BELOW_SELL')) throw Error('BUY_BELOW_SELL');
        // recordInitial internally invokes preparation, attribution building and
        // fresh rechecks under the existing exclusive durable claim. Keep the
        // handle PRIVATE for C2; prepare still returns only documentary data.
        const pending = await journal.recordInitial(structuredClone(request));
        const initialText = await durableText(initialFile), activeText = await durableText(activeFile);
        if (initialText !== JSON.stringify(pending.prepared.initial) + '\n') throw Error('C2_DURABLE_INITIAL_CHANGED');
        const capability = Object.freeze(Object.create(null));
        registerSimulatedAdmission(capability, { preparedKey: key(pending.prepared), initialText, activeText, used: false });
        pendingOperation = pending; liveAdmission = capability;
        return freeze({ ...flags, status: 'prepared-offline', prepared: structuredClone(pending.prepared),
          baselineFingerprint: hash(source.observation.tariff), approvedValidity: structuredClone(policy) });
    };
    const simulateOnce = async capability => {
      const admitted = capability && findSimulatedAdmission(capability);
      if (!admitted || admitted.used || !pendingOperation || key(pendingOperation.prepared) !== admitted.preparedKey)
        throw Error('C2_LIVE_ADMISSION_REQUIRED');
      admitted.used = true; // Consume before any await, including a failed recheck.
      if (closed || recovered) throw Error('C2_LIVE_ADMISSION_REQUIRED');
      if (await durableText(initialFile) !== admitted.initialText || await durableText(activeFile) !== admitted.activeText)
        throw Error('C2_DURABLE_INITIAL_CHANGED');
      if (scenario === 'stale-before-execution') clock = '2026-10-24T12:20:00Z';
      await preparation.recheckPreparedOperation(pendingOperation.prepared, ports);
      if (closed || recovered) throw Error('C2_LIVE_ADMISSION_REQUIRED');
      if (scenario === 'interrupted-before-write') throw Error('C2_INTERRUPTED_BEFORE_WRITE');
      const submittedAt = new Date(Date.parse(clock) + 1000).toISOString();
      // This is only private in-memory Tesla state, NEVER a transport/POST.
      if (scenario !== 'forged-completion') {
        teslaState = structuredClone(JSON.parse(pendingOperation.prepared.initial.intent.payloadJson).tou_settings.tariff_content_v2);
        simulatedWrites++;
      }
      if (scenario === 'ambiguous-write') throw Error('C2_SIMULATED_WRITE_AMBIGUOUS');
      if (scenario === 'interrupted-after-write') throw Error('C2_INTERRUPTED_AFTER_WRITE');
      if (scenario === 'mismatched-readback') teslaState.name = 'Simulated unexpected external change';
      const readback = { observationId: 'simulated-c2-readback-not-tesla-authentication', observation: {
        ...structuredClone(source.observation), source: { ...source.observation.source,
          observedAt: new Date(Date.parse(submittedAt) + 1000).toISOString() },
        tariff: structuredClone(scenario === 'forged-completion' ? proposed : teslaState),
      } };
      completionEvidence = { apiWrite: { status: 'accepted', httpStatus: 200 }, submittedAt,
        completedAt: new Date(Date.parse(submittedAt) + 2000).toISOString(), readback };
      clock = new Date(Date.parse(submittedAt) + 3000).toISOString();
    };
    // Private C3 test binding only. A document hash is a binding, not membership.
    // No token or issuer escapes this closure, and recovery never registers one.
    const bindOfflineReceipt = (capability, evidence) => {
      const bound = capability && completionFor(capability);
      if (!bound || bound.used) throw Error('C3_LIVE_COMPLETION_REQUIRED');
      bound.used = true; // All issuance outcomes consume before any other work.
      if (closed || recovered || bound.admission !== liveAdmission
        || !findSimulatedAdmission(liveAdmission)?.used || simulatedWrites !== 1
        || key(evidence) !== bound.evidenceKey
        || key(evidence.initial) !== key(pendingOperation.prepared.initial)
        || key(evidence.completion.readback.observation.tariff) !== key(teslaState))
        throw Error('C3_COMPLETION_BINDING_MISMATCH');
      const body = { ...flags, version: 1, kind: 'offline-v2-confirmation-receipt',
        provenance: 'closed-harness-simulation-not-runtime-authentication',
        // An offline reference to this private issuance, not a capability. Even
        // two identical fixture runs have distinct issuance/receipt identities.
        offlineIssuanceId: bound.issuanceId,
        preparedFingerprint: pendingOperation.prepared.fingerprint,
        // Full validated E/J/D evidence retains exact approval, payload, site,
        // generation, explicit validity, initial/completion and readback binding.
        operation: structuredClone(evidence) };
      const receiptKey = hash({ purpose: 'offline-c3-receipt-v1', ...body });
      const receipt = freeze({ ...body, receiptKey,
        issuanceKey: hash({ purpose: 'offline-c3-issuance-v1', receiptKey,
          evidenceId: evidence.evidenceId, preparedFingerprint: body.preparedFingerprint }) });
      bound.receipt = receipt; bound.receiptKey = key(receipt); bound.projected = false;
      return receipt;
    };
    const rehearseOnce = async () => {
        ensureOpen();
        if (rehearsalStarted || recovered) throw Error('C2_REHEARSAL_ALREADY_CONSUMED');
        rehearsalStarted = true; // All outcomes consume this test-only attempt.
        if (!pendingOperation) await prepareFirstApply();
        await simulateOnce(liveAdmission);
        const recorded = await pendingOperation.recordCompletion();
        completionEvidence = null;
        const history = await journal.readHistory();
        if (history.status !== 'available') throw Error('C2_DURABLE_CONFIRMATION_UNAVAILABLE');
        const checked = load('src/lib/tesla-tariff/confirmed-operation-evidence.ts')
          .validateConfirmedOperationEvidence(recorded.evidence, history.history.contexts.at(-1));
        if (checked.status !== 'validated') throw Error(checked.code);
        // STOP at the existing private V1 runtime completion/receipt boundary.
        // This private C2 simulation identity must NOT satisfy that registry.
        const receipt = load('src/lib/tesla-tariff/confirmed-smart-receipt-issuer.ts')
          .issueConfirmedSmartReceipt(liveAdmission, recorded.evidence.initial, recorded.evidence.completion);
        if (receipt.status !== 'rejected' || receipt.code !== 'JOURNAL_COMPLETION_NOT_BOUND')
          throw Error('C2_UNEXPECTED_PRODUCTION_AUTHORITY');
        if (closed || recovered || history.history.records.length !== 1
          || key(history.history.records[0]) !== key(checked.evidence))
          throw Error('C3_LIVE_COMPLETION_REQUIRED');
        const completionIdentity = Object.freeze(Object.create(null));
        registerCompletion(completionIdentity, { admission: liveAdmission, evidenceKey: key(checked.evidence),
          issuanceId: `offline-c3-${randomUUID()}`, used: false });
        const candidate = structuredClone(checked.evidence);
        const alterations = {
          'receipt-substitution': () => { candidate.completion.readback.observationId = 'substituted'; },
          'receipt-payload': () => { candidate.initial.intent.payloadJson = '{}'; },
          'receipt-generation': () => { candidate.initial.intent.ownershipAfterGeneration = '00000000-0000-8000-8000-000000000000'; },
          'receipt-approval': () => { candidate.initial.approval.approvedAt = '2026-10-24T12:00:02.030Z'; },
          'receipt-validity': () => { candidate.initial.intent.ownershipAttribution.admission.validity.end = '2026-10-24T17:00:00Z'; },
          'receipt-site': () => { candidate.initial.intent.energySiteId = '54321'; },
        };
        if (Object.hasOwn(alterations, scenario)) {
          alterations[scenario]();
          // Fully refresh the linked content identities. Binding rejection must
          // come from the live completion membership/snapshot, not old checksums.
          const rehash = (value, field) => { const body = { ...value }; delete body[field]; value[field] = hash(body); };
          const intent = candidate.initial.intent;
          intent.payloadFingerprint = hash(JSON.parse(intent.payloadJson));
          rehash(intent.ownershipAttribution, 'attributionId');
          candidate.initial.approval.fingerprint = key(intent);
          rehash(candidate.initial.approval, 'approvalId');
          rehash(candidate.initial, 'initialRecordId');
          candidate.completion.initialRecordId = candidate.initial.initialRecordId;
          rehash(candidate.completion, 'completionRecordId');
          candidate.evidenceId = hash({ version: 2, initial: candidate.initial, completion: candidate.completion });
        }
        if (scenario === 'receipt-recovered') recovered = true;
        const suppliedCompletion = scenario === 'receipt-copy' ? structuredClone(completionIdentity)
          : scenario === 'receipt-forged' ? { version: 2, evidenceId: candidate.evidenceId, authenticated: true } : completionIdentity;
        const offlineReceipt = bindOfflineReceipt(suppliedCompletion, candidate);
        if (scenario === 'receipt-replay') bindOfflineReceipt(completionIdentity, candidate);
        const storage = await inspect();
        if (closed || recovered) throw Error('C3_LIVE_COMPLETION_REQUIRED');
        liveCompletion = completionIdentity; issuedReceipt = offlineReceipt;
        return freeze({ ...flags, status: 'rehearsed-offline', furthestCompletedStep: 5,
          offlineReceipt,
          evidenceProvenance: 'simulated-offline-tesla-state-not-authenticated', evidence: structuredClone(checked.evidence),
          receiptBoundary: { status: 'blocked', code: receipt.code, required: 'trusted-V2-runtime-completion-capability' },
          ownershipFinalisation: 'not-attempted', storage });
    };
    // Private C4 glue around the EXISTING pure ownership kernel. Exact object
    // identity is required; no caller JSON, registration or production finaliser.
    const projectIssuedReceipt = async (capability, receipt) => {
      const bound = capability && completionFor(capability);
      if (!bound || !bound.used || bound.projected || bound.receipt !== receipt)
        throw Error('C4_ISSUED_RECEIPT_REQUIRED');
      bound.projected = true; // Failed projection attempts also consume once.
      if (closed || recovered || bound.admission !== liveAdmission || key(receipt) !== bound.receiptKey
        || key(receipt.operation) !== bound.evidenceKey || simulatedWrites !== 1)
        throw Error('C4_RECEIPT_BINDING_MISMATCH');
      const history = await journal.readHistory();
      if (closed || recovered || history.status !== 'available' || history.history.records.length !== 1
        || key(history.history.records[0]) !== bound.evidenceKey) throw Error('C4_DURABLE_CONFIRMATION_REQUIRED');
      const e = receipt.operation, intent = e.initial.intent, completion = e.completion;
      const ownership = store.readOwnership(file, intent.energySiteId);
      if (ownership.status !== 'missing' || intent.kind !== 'apply' || intent.ownershipBefore !== null
        || intent.predecessor !== null || intent.origin !== null
        || !preparation.operationCommitPreconditionMatches(pendingOperation.prepared, ownership, intent.ownershipAfterGeneration))
        throw Error('C4_FIRST_APPLY_OWNERSHIP_CONFLICT');
      const context = history.history.contexts[0];
      const checked = load('src/lib/tesla-tariff/confirmed-operation-evidence.ts').validateConfirmedOperationEvidence(e, context);
      if (checked.status !== 'validated') throw Error(checked.code);
      const retained = structuredClone(context.retainedOriginal);
      const retention = load('src/lib/tesla-tariff/retained-original.ts');
      const validity = structuredClone(intent.ownershipAttribution.admission.validity);
      if (!retention.validRetainedOriginal(retained) || key(validity) !== key(policy)
        || key(retained.original) !== key(intent.original) || retained.originalFingerprint !== intent.originalFingerprint
        || retained.origin.initialRecordId !== e.initial.initialRecordId || retained.origin.classifiedRecordId !== completion.completionRecordId
        || retained.origin.receiptKey !== e.evidenceId || retained.origin.issuanceKey !== intent.ownershipAttribution.originIssuanceReference
        || retained.currentGeneration !== intent.ownershipAfterGeneration || retained.latestReadback.mutationId !== intent.mutationId
        || retained.latestReadback.receiptKey !== e.evidenceId || retained.latestReadback.fingerprint !== completion.finalTariffFingerprint)
        throw Error('C4_ORIGINAL_OR_VALIDITY_CONFLICT');
      const intervals = load('src/lib/tesla-tariff/ownership-attribution.ts').projectAttributedIntervals(intent, completion.submittedAt);
      const ledger = { version: 1, energySiteId: intent.energySiteId, timeZone: intent.timeZone,
        createdAt: completion.completedAt, updatedAt: completion.completedAt, validUntil: validity.end,
        basis: 'confirmed-write-readback', baselineFingerprint: retained.originalFingerprint,
        readbackFingerprint: completion.finalTariffFingerprint, proposalFingerprint: hash(intent),
        smartEvidenceFingerprint: hash(pendingOperation.prepared.capture.kraken), intervals };
      if (!load('src/lib/tesla-tariff/ownership-evidence.ts').validOwnership(ledger)
        || intervals.some(w => w.restoreBaselineFingerprint !== retained.originalFingerprint)) throw Error('C4_INVALID_OWNERSHIP_PROJECTION');
      // F1's structural original/active-obligation rules apply. Its complete
      // lifecycle document needs runtime identities and committed history that
      // do not exist here; never fabricate those or relabel offline references.
      const body = { ...flags, version: 2, kind: 'offline-v2-ownership-projection',
        provenance: 'private-offline-receipt-not-committed-ownership', state: 'active', restorationObligation: 'required',
        operationId: intent.operationId, mutationId: intent.mutationId, energySiteId: intent.energySiteId, timeZone: intent.timeZone,
        generation: { expectedBefore: null, expectedAfter: intent.ownershipAfterGeneration },
        offlineReceipt: { receiptKey: receipt.receiptKey, issuanceKey: receipt.issuanceKey, offlineIssuanceId: receipt.offlineIssuanceId },
        journal: { version: 2, initialRecordId: e.initial.initialRecordId, completionRecordId: completion.completionRecordId, evidenceId: e.evidenceId },
        preparedFingerprint: receipt.preparedFingerprint, payloadFingerprint: intent.payloadFingerprint,
        approvalId: e.initial.approval.approvalId, attributionId: intent.ownershipAttribution.attributionId,
        comparisonDomain: structuredClone(intent.ownershipAttribution.admission.domain), approvedValidity: validity,
        retainedOriginal: retained, retainedOriginKey: retention.retainedOriginKey(retained),
        comparisonBaseline: structuredClone(intent.before), comparisonBaselineFingerprint: hash(intent.before.observation),
        ownershipEvidence: ledger };
      return freeze({ ...body, projectionKey: hash({ purpose: 'offline-c4-ownership-projection-v2', ...body }) });
    };
    return Object.freeze({
      ...flags,
      async prepare(...args) { noArguments(args); ensureOpen(); return prepareFirstApply(); },
      async rehearse(...args) { noArguments(args); ensureOpen(); return rehearseOnce(); },
      async projectOwnership(...args) {
        noArguments(args); ensureOpen();
        if (projectionStarted || recovered) throw Error('C4_PROJECTION_ALREADY_CONSUMED');
        projectionStarted = true;
        if (!issuedReceipt) await rehearseOnce();
        let candidate = issuedReceipt;
        if (['projection-copy','projection-payload','projection-generation','projection-validity','projection-original',
          'projection-terminal','projection-conflict'].includes(scenario)) {
          candidate = structuredClone(issuedReceipt);
          const intent = candidate.operation.initial.intent;
          if (scenario === 'projection-payload') intent.payloadJson = '{}';
          if (scenario === 'projection-generation') intent.ownershipAfterGeneration = '00000000-0000-8000-8000-000000000000';
          if (scenario === 'projection-validity') intent.ownershipAttribution.admission.validity.end = 'not-a-date';
          if (scenario === 'projection-original') intent.original.tariff.name = 'Substituted original';
          if (scenario === 'projection-terminal') intent.ownershipBefore = fixture('restored').value;
          if (scenario === 'projection-conflict') intent.ownershipBefore = fixture('apply').value.historicalOwnership;
          const { receiptKey: _r, issuanceKey: _i, ...body } = candidate; void _r; void _i;
          candidate.receiptKey = hash({ purpose: 'offline-c3-receipt-v1', ...body });
          candidate.issuanceKey = hash({ purpose: 'offline-c3-issuance-v1', receiptKey: candidate.receiptKey,
            evidenceId: candidate.operation.evidenceId, preparedFingerprint: candidate.preparedFingerprint });
        }
        const projection = await projectIssuedReceipt(liveCompletion, candidate);
        if (scenario === 'projection-replay') await projectIssuedReceipt(liveCompletion, candidate);
        return freeze({ ...flags, status: 'ownership-projected-offline', projection, offlineReceipt: issuedReceipt, storage: await inspect() });
      },
      async inspect(...args) { noArguments(args); ensureOpen(); return inspect(); },
      async reopen(...args) {
        noArguments(args); ensureOpen();
        recovered = true; liveAdmission = null; completionEvidence = null; liveCompletion = null; issuedReceipt = null;
        const reopened = loadStore().load('src/lib/tesla-tariff/repeat-attempt-journal.ts').offlineOperationJournal(config, ports);
        return freeze({ ...flags, history: structuredClone(await reopened.readHistory()), storage: await inspect() });
      },
      async close(...args) { noArguments(args); if (!closed) {
        closed = true; liveAdmission = null; completionEvidence = null; liveCompletion = null; issuedReceipt = null;
        await fs.rm(root, { recursive: true, force: true });
      } },
    });
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}
