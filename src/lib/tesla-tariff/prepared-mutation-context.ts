import type { Site } from "../site/types";
import type { OwnershipRead, LifecycleOwnershipSnapshot } from "./ownership-store";
import { assertOwnership, validOwnership, validOwnershipTimestamp } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { prepareSupervisedExperiment, type Capture, type Selection } from "./supervised-experiment";
import type { KrakenState } from "../site/kraken-state";
import { validateTeslaInspectionEvidence, validateKrakenInspectionEvidence } from "./smart-inspection";
import { parseDispatchResponse } from "../kraken/dispatch-response";
import { validJournalEvidenceJson } from "./journal-evidence-json";
import { validLifecycleOwnershipSnapshot, retentionDigest, retainedOriginKey } from "./retained-original";
import { representationKey } from "./rollback-evidence";
import { CAPTURE_TTL_MS, EVIDENCE_TTL_MS, APPROVAL_TTL_MS, smartEvidenceKey } from "./smart-evidence";
import { validateConfirmedOperationEvidence, validateOperationInitialRecord, type ConfirmedOperationEvidence,
    type ConfirmedOperationValidationContext, type SmartOperationIntent, type SmartOperationApprovalEvidence,
    type SmartOperationInitialRecord, type SmartOperationKind } from "./confirmed-operation-evidence";

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
function freeze<T>(value: T): Frozen<T> {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value as Frozen<T>;
}
type Snapshot = Extract<OwnershipRead, { status: "available" }>["snapshot"];
export type CapturedOwnershipContext = Frozen<{
    capturedAt: string; energySiteId: string;
} & ({ status: "missing"; snapshot: null } | { status: "available"; snapshot: Snapshot })>;
export type MutationPreparationPorts = {
    /** Trusted local read adapter, e.g. ownershipStore(...).read. No default I/O. */
    readOwnership(site: string): Promise<OwnershipRead>;
    now(): string;
    newMutationId(): string;
};

/** Preparation only. The local B1 journal path consumes this context; this
 * builder performs no execution, journal mutation, receipt issuance or persistence.
 * Capture precedes initial preparation. Fresh revalidation continues to use the
 * existing prepareSupervisedExperiment, never this original-operation builder.
 * Fingerprints establish content identity, not authenticity or durability.
 */
export async function prepareMutationContext(input: { site: Site; selection: Selection; capture: Capture }, ports: MutationPreparationPorts) {
    const original = structuredClone(input), site = original.selection.energySiteId;
    if (typeof site !== "string" || !/^\d+$/.test(site)) throw Error("PREPARATION_SITE_INVALID");
    let read: OwnershipRead;
    try { read = structuredClone(await ports.readOwnership(site)); }
    catch { throw Error("PREPARATION_OWNERSHIP_UNAVAILABLE"); }
    const capturedAt = ports.now();
    if (!validOwnershipTimestamp(capturedAt)) throw Error("PREPARATION_TIME_INVALID");
    if (read?.status === "unavailable") throw Error("PREPARATION_OWNERSHIP_UNAVAILABLE");
    if (!read || (read.status !== "missing" && read.status !== "available")) throw Error("PREPARATION_OWNERSHIP_INVALID");
    if (Object.keys(read).sort().join() !== (read.status === "missing" ? "status" : "snapshot,status"))
        throw Error("PREPARATION_OWNERSHIP_INVALID");
    if (read.status === "available") {
        const s = read.snapshot;
        if (!s || Object.keys(s).sort().join() !== "checksum,evidence,generation,historyDigest,version" || s.version !== 2
            || typeof s.historyDigest !== "string" || !/^[a-f0-9]{64}$/.test(s.historyDigest)
            || typeof s.generation !== "string" || !/^[a-f0-9-]{36}$/.test(s.generation)
            || !validOwnership(s.evidence) || s.evidence.energySiteId !== site
            || Date.parse(s.evidence.updatedAt) > Date.parse(capturedAt)
            || s.checksum !== ownershipFingerprint({ generation: s.generation, evidence: s.evidence }))
            throw Error("PREPARATION_OWNERSHIP_INVALID");
    }
    const ownership: CapturedOwnershipContext = freeze({ capturedAt, energySiteId: site,
        ...(read.status === "available" ? { status: "available" as const, snapshot: read.snapshot }
            : { status: "missing" as const, snapshot: null }) });
    const generatedAt = ports.now();
    if (!validOwnershipTimestamp(generatedAt) || Date.parse(generatedAt) < Date.parse(capturedAt)) throw Error("PREPARATION_TIME_INVALID");
    const review = prepareSupervisedExperiment(original.site, original.selection, original.capture, generatedAt);
    if (read.status === "available") assertOwnership(read.snapshot.evidence, review.before, generatedAt);
    let mutationId: unknown;
    try { mutationId = ports.newMutationId(); } catch { throw Error("PREPARATION_MUTATION_ID_INVALID"); }
    if (typeof mutationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)) throw Error("PREPARATION_MUTATION_ID_INVALID");
    const smart = review.proposal.input.observedSmart!;
    const bound = { version: 1 as const, mutationId, original: review, ownership,
        energySiteId: site, timeZone: review.proposal.bound.timeZone,
        selectedDispatch: smart.dispatch, comparisonDomain: smart.comparisonDomain,
        experimentFingerprint: review.fingerprint, proposalFingerprint: review.proposal.fingerprint,
        payloadKey: review.payloadJson, smartEvidenceKey: review.binding.smartEvidenceKey,
        selectedEvidenceKey: review.proposal.bound.dispatchEvidenceKey,
        ownershipKey: ownershipFingerprint(ownership) };
    return freeze({ ...bound, fingerprint: ownershipFingerprint(bound), writeReady: false as const, rollbackProven: false as const });
}
export type PreparedMutationContext = Awaited<ReturnType<typeof prepareMutationContext>>;

export type OfflineOperationHistory = { records: ConfirmedOperationEvidence[]; contexts: ConfirmedOperationValidationContext[] };
export type OfflineOperationCapture = {
    teslaObservationId: string; observation: Capture["before"];
    krakenObservationId: string; kraken: KrakenState;
};
export type OfflineOperationRequest = {
    kind: SmartOperationKind; operationId: string; mutationId: string; energySiteId: string; timeZone: string;
    expectedOwnershipKey: string; payloadJson: string; validFrom: string; expiresAt: string;
};
/** Trusted composition boundary, not browser/deserialized data. These ports have
 * no write/execute method and no default production adapters. Tests inject offline
 * authenticated-acquisition/approval fixtures; labels in JSON are never accepted
 * as an alternative to invoking these independent ports. */
export type OfflineOperationPreparationPorts = {
    readOwnership(site: string): Promise<OwnershipRead>;
    readConfirmedHistory(site: string): Promise<OfflineOperationHistory>;
    capture(site: string): Promise<OfflineOperationCapture>;
    approve(intent: SmartOperationIntent): Promise<SmartOperationApprovalEvidence>;
    readOriginIssuanceReference(site: string): Promise<string>;
    now(): string;
};
export type PreparedOperationContext = {
    version: 2; provenance: "offline-trusted-ports"; initial: SmartOperationInitialRecord;
    ownershipKey: string; capture: OfflineOperationCapture; originIssuanceReference: string;
    fingerprint: string; writeReady: false; executionReady: false; grantsSuccessorAuthority: false; grantsRepeatAuthority: false;
    rollbackProven: false; restorationProven: false; resolvesHistoricalJournal: false;
};
/** Explicit opt-in union; legacy executor contracts continue requiring V1. */
export type VersionedPreparedMutationContext = PreparedMutationContext | PreparedOperationContext;
const operationId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.exec(v)?.[0] === v;
const exactOperationKeys = (v: object, names: string) => Object.keys(v).sort().join() === names;
const sameOperationValue = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
function validOperationOwnership(read: OwnershipRead, site: string): read is { status: "missing" } | { status: "available"; snapshot: LifecycleOwnershipSnapshot } {
    return read && (read.status === "missing" ? exactOperationKeys(read, "status")
        : read.status === "available" && exactOperationKeys(read, "snapshot,status") && validLifecycleOwnershipSnapshot(read.snapshot, site));
}
function freshOperationTime(observed: string, at: string, ttl: number) {
    return validOwnershipTimestamp(observed) && validOwnershipTimestamp(at)
        && Date.parse(observed) <= Date.parse(at) && Date.parse(at) - Date.parse(observed) <= ttl;
}
function validOperationCapture(c: OfflineOperationCapture, site: string, timeZone: string, at: string) {
    if (!c || !exactOperationKeys(c, "kraken,krakenObservationId,observation,teslaObservationId")
        || !operationId(c.teslaObservationId) || !operationId(c.krakenObservationId)
        || !sameOperationValue(validateTeslaInspectionEvidence(c.observation), c.observation)
        || c.observation.source.energySiteId !== site || c.observation.source.timeZone !== timeZone
        || !validateKrakenInspectionEvidence(c.kraken) || c.kraken.stale !== false
        || !freshOperationTime(c.observation.source.observedAt, at, CAPTURE_TTL_MS)
        || !freshOperationTime(c.kraken.lastSuccessfulUpdate, at, EVIDENCE_TTL_MS)
        || !c.kraken.importTariff || !freshOperationTime(c.kraken.importTariff.observedAt, at, EVIDENCE_TTL_MS)
        || !Array.isArray(c.kraken.vehicles)) return false;
    const ids = new Set<string>();
    return c.kraken.vehicles.every(v => v && typeof v.id === "string" && v.id.length > 0 && !ids.has(v.id) && !!ids.add(v.id)
        && typeof v.name === "string" && parseDispatchResponse({ flexPlannedDispatches: v.plannedDispatches }).status === "complete");
}
/** Pure identity allocation, never a reservation. The entire trusted precondition
 * (including its history anchor) and operation IDs determine this opaque UUIDv8.
 * A future SQLite CAS MUST verify both the exact captured precondition and this
 * approved value inside its transaction; current legacy persistence is unchanged. */
export function expectedOperationGeneration(site: string, operation: string, mutation: string, ownership: OwnershipRead): string {
    if (typeof site !== "string" || !/^\d+$/.test(site) || !operationId(operation) || !operationId(mutation)
        || !validJournalEvidenceJson(ownership) || !validOperationOwnership(ownership, site)) throw Error("OPERATION_OWNERSHIP_INVALID");
    const h = ownershipFingerprint({ version: 2, purpose: "expected-operation-generation", site, operation, mutation, ownership });
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function captureIdentity(capture: OfflineOperationCapture, originIssuanceReference: string) {
    return ownershipFingerprint({ version: 2, purpose: "operation-capture", capture, originIssuanceReference });
}
function operationImportIdentity(capture: OfflineOperationCapture) {
    // Reacquisition refreshes provenance time, not the underlying agreement/rates.
    const { observedAt, ...facts } = capture.kraken.importTariff!;
    void observedAt;
    return facts;
}

/** Structural revalidation of persisted admission metadata. It does not recreate
 * authentication: only the configured server-owned journal reader may admit it. */
export function validPreparedOperationContext(value: unknown): value is PreparedOperationContext {
    try {
        if (!validJournalEvidenceJson(value)) return false;
        const p = value as PreparedOperationContext;
        if (!exactOperationKeys(p, "capture,executionReady,fingerprint,grantsRepeatAuthority,grantsSuccessorAuthority,initial,originIssuanceReference,ownershipKey,provenance,resolvesHistoricalJournal,restorationProven,rollbackProven,version,writeReady")
            || p.version !== 2 || p.provenance !== "offline-trusted-ports" || p.writeReady !== false || p.executionReady !== false
            || p.rollbackProven !== false || p.restorationProven !== false || p.resolvesHistoricalJournal !== false
            || p.grantsSuccessorAuthority !== false || p.grantsRepeatAuthority !== false || !retentionDigest(p.originIssuanceReference)
            || validateOperationInitialRecord(p.initial).status !== "validated") return false;
        const i = p.initial.intent, ownership: OwnershipRead = i.ownershipBefore ? { status: "available", snapshot: i.ownershipBefore } : { status: "missing" };
        const { fingerprint, ...bound } = p;
        return fingerprint === ownershipFingerprint(bound) && p.ownershipKey === ownershipFingerprint(ownership)
            && i.ownershipAfterGeneration === expectedOperationGeneration(i.energySiteId, i.operationId, i.mutationId, ownership)
            && validOperationCapture(p.capture, i.energySiteId, i.timeZone, i.preparedAt)
            && i.before.observationId === captureIdentity(p.capture, p.originIssuanceReference) && sameOperationValue(i.before.observation, p.capture.observation)
            && (!i.ownershipBefore || p.originIssuanceReference === i.ownershipBefore.lifecycle.origin.issuanceKey);
    } catch { return false; }
}

/** CAS predicate only; success is documentary and grants no commit capability. */
export function operationCommitPreconditionMatches(prepared: PreparedOperationContext, current: OwnershipRead, afterGeneration: string) {
    try { return validPreparedOperationContext(prepared) && validJournalEvidenceJson(current)
        && ownershipFingerprint(current) === prepared.ownershipKey
        && afterGeneration === prepared.initial.intent.ownershipAfterGeneration
        && afterGeneration === expectedOperationGeneration(prepared.initial.intent.energySiteId,
            prepared.initial.intent.operationId, prepared.initial.intent.mutationId, current); }
    catch { return false; }
}

export async function prepareOperationMutationContext(request: OfflineOperationRequest, ports: OfflineOperationPreparationPorts): Promise<PreparedOperationContext> {
    if (!validJournalEvidenceJson(request)) throw Error("OPERATION_REQUEST_INVALID");
    const r = structuredClone(request);
    if (!exactOperationKeys(r, "energySiteId,expectedOwnershipKey,expiresAt,kind,mutationId,operationId,payloadJson,timeZone,validFrom")
        || !["apply", "update", "restore"].includes(r.kind) || !operationId(r.operationId) || !operationId(r.mutationId)
        || typeof r.energySiteId !== "string" || !/^\d+$/.test(r.energySiteId)) throw Error("OPERATION_REQUEST_INVALID");
    const ownership = structuredClone(await ports.readOwnership(r.energySiteId));
    if (!validOperationOwnership(ownership, r.energySiteId)) throw Error("OPERATION_OWNERSHIP_INVALID");
    if (ownershipFingerprint(ownership) !== r.expectedOwnershipKey) throw Error("OPERATION_OWNERSHIP_STALE");
    const history = await ports.readConfirmedHistory(r.energySiteId);
    if (!validJournalEvidenceJson(history) || !Array.isArray(history.records) || !Array.isArray(history.contexts)
        || history.records.length !== history.contexts.length) throw Error("OPERATION_HISTORY_INVALID");
    for (let n = 0; n < history.records.length; n++) {
        if (!sameOperationValue(history.contexts[n].confirmedHistory, history.records.slice(0, n))
            || validateConfirmedOperationEvidence(history.records[n], history.contexts[n]).status !== "validated") throw Error("OPERATION_HISTORY_INVALID");
    }
    const previous = history.records.at(-1), beforeSnapshot = ownership.status === "available" ? ownership.snapshot : null;
    if (r.kind === "apply" ? beforeSnapshot !== null || previous : !beforeSnapshot || !previous) throw Error("OPERATION_PREDECESSOR_REQUIRED");
    if (previous && (previous.initial.intent.kind === "restore" || previous.initial.intent.energySiteId !== r.energySiteId
        || previous.initial.intent.timeZone !== r.timeZone || previous.initial.intent.ownershipAfterGeneration !== beforeSnapshot?.generation
        || previous.evidenceId !== beforeSnapshot?.lifecycle.latestReadback.receiptKey
        || previous.initial.intent.mutationId !== beforeSnapshot?.lifecycle.latestReadback.mutationId
        || previous.completion.finalTariffFingerprint !== beforeSnapshot?.evidence.readbackFingerprint
        || !beforeSnapshot || retainedOriginKey(beforeSnapshot.lifecycle) !== retainedOriginKey(history.contexts.at(-1)!.retainedOriginal))) throw Error("OPERATION_PREDECESSOR_CONFLICT");
    if (history.records.some(h => h.initial.intent.operationId === r.operationId || h.initial.intent.mutationId === r.mutationId)) throw Error("DUPLICATE_OPERATION_IDENTITY");
    const capture = structuredClone(await ports.capture(r.energySiteId)), preparedAt = ports.now();
    if (!validJournalEvidenceJson(capture) || !validOperationCapture(capture, r.energySiteId, r.timeZone, preparedAt)) throw Error("OPERATION_CAPTURE_INVALID");
    const originIssuanceReference = beforeSnapshot?.lifecycle.origin.issuanceKey ?? await ports.readOriginIssuanceReference(r.energySiteId);
    if (!retentionDigest(originIssuanceReference)) throw Error("OPERATION_ORIGIN_REFERENCE_INVALID");
    const intent: SmartOperationIntent = { kind: r.kind, operationId: r.operationId, mutationId: r.mutationId, energySiteId: r.energySiteId, timeZone: r.timeZone,
        predecessor: previous ? { operationId: previous.initial.intent.operationId, mutationId: previous.initial.intent.mutationId,
            evidenceId: previous.evidenceId, completionRecordId: previous.completion.completionRecordId } : null,
        ownershipBefore: beforeSnapshot, ownershipAfterGeneration: expectedOperationGeneration(r.energySiteId, r.operationId, r.mutationId, ownership),
        original: beforeSnapshot?.lifecycle.original ?? capture.observation,
        originalFingerprint: beforeSnapshot?.lifecycle.originalFingerprint ?? ownershipFingerprint(capture.observation.tariff),
        origin: beforeSnapshot?.lifecycle.origin ?? null, before: { observationId: captureIdentity(capture, originIssuanceReference), observation: capture.observation },
        payloadJson: r.payloadJson, payloadFingerprint: ownershipFingerprint(JSON.parse(r.payloadJson)), preparedAt,
        validFrom: r.validFrom, expiresAt: r.expiresAt };
    const approval = structuredClone(await ports.approve(structuredClone(intent)));
    const initialBody = { journalSchemaVersion: 2 as const, phase: "approved-operation" as const, intent, approval };
    const initial = { ...initialBody, initialRecordId: ownershipFingerprint(initialBody) };
    if (validateOperationInitialRecord(initial).status !== "validated") throw Error("OPERATION_APPROVAL_OR_INITIAL_INVALID");
    const bound = { version: 2 as const, provenance: "offline-trusted-ports" as const, initial, ownershipKey: r.expectedOwnershipKey, capture,
        originIssuanceReference, writeReady: false as const, executionReady: false as const, grantsSuccessorAuthority: false as const,
        grantsRepeatAuthority: false as const, rollbackProven: false as const, restorationProven: false as const, resolvesHistoricalJournal: false as const };
    const prepared = { ...bound, fingerprint: ownershipFingerprint(bound) };
    await recheckPreparedOperation(prepared, ports);
    if (!validPreparedOperationContext(prepared)) throw Error("OPERATION_CONTEXT_INVALID");
    return freeze(prepared) as PreparedOperationContext;
}

export async function recheckPreparedOperation(prepared: PreparedOperationContext, ports: Pick<OfflineOperationPreparationPorts, "readOwnership" | "capture" | "now">) {
    if (!validPreparedOperationContext(prepared)) throw Error("OPERATION_CONTEXT_INVALID");
    const i = prepared.initial.intent, current = structuredClone(await ports.readOwnership(i.energySiteId));
    if (!operationCommitPreconditionMatches(prepared, current, i.ownershipAfterGeneration)) throw Error("OPERATION_OWNERSHIP_STALE");
    const capture = structuredClone(await ports.capture(i.energySiteId)), now = ports.now();
    if (!validJournalEvidenceJson(capture) || !validOperationCapture(capture, i.energySiteId, i.timeZone, now)
        || !freshOperationTime(prepared.initial.approval.approvedAt, now, APPROVAL_TTL_MS) || Date.parse(now) >= Date.parse(i.expiresAt)
        || Date.parse(now) < Date.parse(prepared.initial.approval.approvedAt)
        || Date.parse(capture.observation.source.observedAt) < Date.parse(prepared.capture.observation.source.observedAt)
        || Date.parse(capture.kraken.lastSuccessfulUpdate) < Date.parse(prepared.capture.kraken.lastSuccessfulUpdate)
        || Date.parse(capture.kraken.importTariff!.observedAt) < Date.parse(prepared.capture.kraken.importTariff!.observedAt)
        || !sameOperationValue(capture.observation.tariff, prepared.capture.observation.tariff)
        || smartEvidenceKey(capture.kraken) !== smartEvidenceKey(prepared.capture.kraken)
        || !sameOperationValue(operationImportIdentity(capture), operationImportIdentity(prepared.capture))) throw Error("OPERATION_EVIDENCE_CHANGED_OR_STALE");
}
