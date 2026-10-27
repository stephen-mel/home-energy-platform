import type { LifecycleOwnershipSnapshot } from "./ownership-store";
import { retainedOriginKey, retentionDigest, validLifecycleOwnershipSnapshot } from "./retained-original";
import { validateConfirmedOperationEvidence, type ConfirmedOperationEvidence, type ConfirmedOperationValidationContext } from "./confirmed-operation-evidence";
import { projectAttributedIntervals } from "./ownership-attribution";
import { validJournalEvidenceJson } from "./journal-evidence-json";
import { ownershipFingerprint as hash } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";

/** References ONLY. F1 neither defines/creates a runtime receipt nor verifies
 * registry membership. A future issuer must independently authenticate these
 * references; matching JSON and content hashes supply no runtime authority. */
export type RuntimeReceiptIdentityReference = {
    version: 1; namespace: "runtime-confirmed-operation"; receiptVersion: 2;
    operationId: string; mutationId: string; receiptKey: string; issuanceKey: string;
};
/** Simulation references only. Accepted exclusively by the private test path;
 * never runtime registry membership, receipt issuance or committed ownership. */
type OfflineReceiptIdentityReference = {
    version: 1; namespace: "offline-simulated-operation"; receiptVersion: 1;
    operationId: string; mutationId: string; receiptKey: string; issuanceKey: string;
    admissionKey: string; simulatedCompletionKey: string;
};
type ReceiptIdentityReference = RuntimeReceiptIdentityReference | OfflineReceiptIdentityReference;
export type OwnershipApplicationIdentity = {
    version: 2; operationId: string; mutationId: string; kind: "apply" | "update" | "restore";
    energySiteId: string; timeZone: string;
    documentary: { version: 2; evidenceId: string };
    runtime: ReceiptIdentityReference;
    journal: { version: 2; initialRecordId: string; completionRecordId: string };
    retainedOriginKey: string;
    ownership: { beforeGeneration: string | null; afterGeneration: string; priorHistoryDigest: string | null };
    predecessorApplicationId: string | null;
    applicationId: string;
};
export type RestorationConfirmationDocument = {
    version: 1; operation: ConfirmedOperationEvidence;
    applicationId: string; predecessorApplicationId: string; retainedOriginKey: string;
    terminalGeneration: string;
    readback: { observationId: string; observationFingerprint: string; tariffFingerprint: string; observedAt: string };
};
type LifecycleDocumentBase = {
    version: 2; kind: "ownership-lifecycle-document";
    energySiteId: string; timeZone: string; generation: string;
    /** Complete historical V3 state, including its original validity and history
     * digest. Terminal confirmation never stamps this ledger with a later time. */
    historicalOwnership: LifecycleOwnershipSnapshot;
    applications: OwnershipApplicationIdentity[];
    /** F1 mapping-history identity, NOT the existing SQLite historyDigest. */
    historyId: string; lifecycleId: string;
};
export type OwnershipLifecycleDocument = LifecycleDocumentBase & (
    { state: "active"; restorationObligation: "required"; restoration: null }
    | { state: "restored"; restorationObligation: "retired"; restoration: RestorationConfirmationDocument }
);
/** Independent documentary admissions, never a browser request or an authority
 * producer. The historical snapshot must come from a trusted reader, operations
 * from their existing E/J/D validation context and runtime references separately
 * from the future runtime issuer. No such production integration is installed. */
export type OwnershipLifecycleValidationContext = {
    version: 1; energySiteId: string; timeZone: string;
    historicalOwnership: LifecycleOwnershipSnapshot;
    operations: readonly { evidence: ConfirmedOperationEvidence; context: ConfirmedOperationValidationContext }[];
    runtimeIdentities: readonly ReceiptIdentityReference[];
    previousLifecycle: OwnershipLifecycleDocument | null;
};
const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
const keys = (v: object, names: string) => Object.keys(v).sort().join() === names;
const flags = { executionReady: false, writeReady: false, rollbackProven: false, restorationProven: false,
    grantsRestorationAuthority: false, grantsRepeatAuthority: false, grantsSuccessorAuthority: false, resolvesHistoricalJournal: false } as const;
function freeze<T>(v: T): T {
    if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
}
function application(record: ConfirmedOperationEvidence, runtime: ReceiptIdentityReference, origin: string,
    previous: OwnershipApplicationIdentity | null): OwnershipApplicationIdentity {
    const i = record.initial.intent;
    const body = { version: 2 as const, operationId: i.operationId, mutationId: i.mutationId, kind: i.kind,
        energySiteId: i.energySiteId, timeZone: i.timeZone, documentary: { version: 2 as const, evidenceId: record.evidenceId }, runtime,
        journal: { version: 2 as const, initialRecordId: record.initial.initialRecordId, completionRecordId: record.completion.completionRecordId },
        retainedOriginKey: origin, ownership: { beforeGeneration: i.ownershipBefore?.generation ?? null,
            afterGeneration: i.ownershipAfterGeneration, priorHistoryDigest: i.ownershipBefore?.historyDigest ?? null },
        predecessorApplicationId: previous?.applicationId ?? null };
    return { ...body, applicationId: hash({ purpose: "smart-ownership-application-v2", ...body }) };
}
function document(snapshot: LifecycleOwnershipSnapshot, applications: OwnershipApplicationIdentity[], restore: ConfirmedOperationEvidence | null): OwnershipLifecycleDocument {
    const last = applications.at(-1)!;
    const base = { version: 2 as const, kind: "ownership-lifecycle-document" as const,
        energySiteId: snapshot.lifecycle.energySiteId, timeZone: snapshot.lifecycle.timeZone,
        generation: restore?.initial.intent.ownershipAfterGeneration ?? snapshot.generation, historicalOwnership: snapshot, applications,
        historyId: hash({ version: 2, purpose: "smart-ownership-history-v2", applications: applications.map(a => a.applicationId) }) };
    const readback = restore?.completion.readback;
    const body = restore && readback ? { ...base, state: "restored" as const, restorationObligation: "retired" as const,
        restoration: { version: 1 as const, operation: restore, applicationId: last.applicationId,
            predecessorApplicationId: last.predecessorApplicationId!, retainedOriginKey: last.retainedOriginKey,
            terminalGeneration: restore.initial.intent.ownershipAfterGeneration,
            readback: { observationId: readback.observationId, observationFingerprint: hash(readback.observation),
                tariffFingerprint: restore.completion.finalTariffFingerprint, observedAt: readback.observation.source.observedAt } } }
        : { ...base, state: "active" as const, restorationObligation: "required" as const, restoration: null };
    return { ...body, lifecycleId: hash({ purpose: "smart-ownership-lifecycle-v2", ...body }) };
}

/** Pure, strict documentary validation. A "retired" document describes the
 * proposed terminal representation, not a committed retirement or permission.
 * Revalidation is idempotent; actual replay prevention needs the future atomic
 * store. Here duplicates/history conflicts and any transition after a supplied
 * terminal predecessor fail closed. No persistence or capability code is called. */
export function validateOwnershipLifecycleDocument(value: unknown, suppliedContext: OwnershipLifecycleValidationContext) {
    return validateLifecycleDocument(value, suppliedContext, "production");
}
// Private test seam only. No application export/caller can select offline mode.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function validateOfflineOwnershipLifecycleDocument(value: unknown, suppliedContext: OwnershipLifecycleValidationContext) {
    return validateLifecycleDocument(value, suppliedContext, "offline-test-only");
}
function validateLifecycleDocument(value: unknown, suppliedContext: OwnershipLifecycleValidationContext,
    mode: "production" | "offline-test-only") {
    const validationFlags = mode === "offline-test-only" ? { ...flags, mode: "offline-test-only" as const,
        authentication: "fixtures-only" as const, runtimeConfirmationVerified: false as const, grantsAdmissionAuthority: false as const } : flags;
    const reject = (code: string) => freeze({ status: "rejected" as const, code, ...validationFlags });
    try {
        if (!validJournalEvidenceJson(value) || !validJournalEvidenceJson(suppliedContext)) return reject("MALFORMED_OWNERSHIP_LIFECYCLE");
        const candidate = structuredClone(value) as OwnershipLifecycleDocument, c = structuredClone(suppliedContext);
        if (!keys(c, "energySiteId,historicalOwnership,operations,previousLifecycle,runtimeIdentities,timeZone,version") || c.version !== 1
            || !validLifecycleOwnershipSnapshot(c.historicalOwnership, c.energySiteId) || c.historicalOwnership.lifecycle.timeZone !== c.timeZone
            || !Array.isArray(c.operations) || c.operations.length < 1 || !Array.isArray(c.runtimeIdentities)
            || c.runtimeIdentities.length !== c.operations.length) return reject("INVALID_LIFECYCLE_CONTEXT");
        if (!candidate || !keys(candidate, "applications,energySiteId,generation,historicalOwnership,historyId,kind,lifecycleId,restoration,restorationObligation,state,timeZone,version")
            || candidate.version !== 2 || candidate.kind !== "ownership-lifecycle-document" || !["active", "restored"].includes(candidate.state))
            return reject("UNSUPPORTED_OWNERSHIP_LIFECYCLE");
        if (mode === "offline-test-only" && (c.operations.length !== 1 || c.previousLifecycle !== null
            || candidate.state !== "active" || c.operations[0]?.evidence?.initial?.intent?.kind !== "apply"))
            return reject("OFFLINE_FIRST_APPLY_ONLY");
        if (c.previousLifecycle?.state === "restored") return reject("LIFECYCLE_ALREADY_TERMINAL");
        const records: ConfirmedOperationEvidence[] = [], applications: OwnershipApplicationIdentity[] = [];
        const retained = c.historicalOwnership.lifecycle, origin = retainedOriginKey(retained);
        // History references intentionally repeat across snapshots and mappings.
        // Reserve their role without imposing uniqueness on those references.
        const historyIds = new Set([
            c.historicalOwnership.historyDigest, candidate.historyId,
            c.previousLifecycle?.historyId, c.previousLifecycle?.historicalOwnership?.historyDigest,
            ...c.operations.flatMap(entry => [entry?.evidence?.initial?.intent?.ownershipBefore?.historyDigest,
                entry?.context?.ownershipBefore?.historyDigest]),
        ].filter(retentionDigest));
        const uniqueIds = new Set<string>();
        const unique = (value: string) => retentionDigest(value) && !uniqueIds.has(value) && !!uniqueIds.add(value);
        // Origin issuance is an opaque documentary reference, NOT a runtime
        // issuance. Its other IDs intentionally alias the root evidence/journal.
        if (!unique(origin) || !unique(retained.origin.issuanceKey)) return reject("RETAINED_ORIGIN_IDENTITY_CONFLICT");
        for (let n = 0; n < c.operations.length; n++) {
            const entry = c.operations[n], runtime = c.runtimeIdentities[n];
            if (!entry || !keys(entry, "context,evidence") || !same(entry.context.confirmedHistory, records)
                || entry.context.energySiteId !== c.energySiteId || entry.context.timeZone !== c.timeZone
                || !same(entry.context.retainedOriginal.original, retained.original)
                || retainedOriginKey(entry.context.retainedOriginal) !== origin
                || !entry.evidence.initial.intent.ownershipAttribution) return reject("LIFECYCLE_HISTORY_INCOMPLETE");
            const checked = validateConfirmedOperationEvidence(entry.evidence, entry.context);
            if (checked.status !== "validated") return reject(checked.code);
            const record = checked.evidence, i = record.initial.intent;
            if (i.kind === "restore" && n !== c.operations.length - 1) return reject("LIFECYCLE_ALREADY_TERMINAL");
            const offline = mode === "offline-test-only";
            if (!runtime || !keys(runtime, offline
                ? "admissionKey,issuanceKey,mutationId,namespace,operationId,receiptKey,receiptVersion,simulatedCompletionKey,version"
                : "issuanceKey,mutationId,namespace,operationId,receiptKey,receiptVersion,version")
                || runtime.version !== 1 || runtime.receiptVersion !== (offline ? 1 : 2)
                || runtime.namespace !== (offline ? "offline-simulated-operation" : "runtime-confirmed-operation")
                || runtime.operationId !== i.operationId || runtime.mutationId !== i.mutationId) return reject("RUNTIME_IDENTITY_REFERENCE_INVALID");
            const simulationIds = runtime.namespace === "offline-simulated-operation"
                ? [runtime.admissionKey, runtime.simulatedCompletionKey] : [];
            // Cross-role uniqueness prevents documentary or journal identifiers
            // from masquerading as runtime receipt/issuance or application IDs.
            if ([runtime.receiptKey, runtime.issuanceKey, ...simulationIds].some(value => historyIds.has(value))
                || ![record.evidenceId, record.initial.initialRecordId, record.completion.completionRecordId,
                    runtime.receiptKey, runtime.issuanceKey, ...simulationIds].every(unique)) return reject("OPERATION_IDENTITY_ALIAS_OR_REPLAY");
            const mapped = application(record, runtime, origin, applications.at(-1) ?? null);
            if (!unique(mapped.applicationId)) return reject("APPLICATION_IDENTITY_CONFLICT");
            applications.push(mapped); records.push(record);
        }
        const last = records.at(-1)!, i = last.initial.intent, restoring = i.kind === "restore";
        // Active documents validate an ALREADY supplied ledger; they never
        // derive/create one. Terminal documents preserve that ledger verbatim.
        if (restoring) {
            if (!same(i.ownershipBefore, c.historicalOwnership) || !same(i.original, retained.original)
                || last.completion.finalTariffFingerprint !== retained.originalFingerprint) return reject("RESTORATION_HISTORY_CONFLICT");
        } else if (c.historicalOwnership.generation !== i.ownershipAfterGeneration
            || retained.latestReadback.mutationId !== i.mutationId || retained.latestReadback.receiptKey !== last.evidenceId
            || retained.latestReadback.fingerprint !== last.completion.finalTariffFingerprint
            || c.historicalOwnership.evidence.updatedAt !== last.completion.completedAt
            || c.historicalOwnership.evidence.validUntil !== i.ownershipAttribution!.admission.validity.end
            || !same(c.historicalOwnership.evidence.intervals, projectAttributedIntervals(i, last.completion.submittedAt)))
            return reject("ACTIVE_OWNERSHIP_HISTORY_CONFLICT");
        const prior = i.ownershipBefore;
        if (prior === null ? c.previousLifecycle !== null : !same(c.previousLifecycle, document(prior, applications.slice(0, -1), null)))
            return reject("LIFECYCLE_PREDECESSOR_CONFLICT");
        const expected = document(c.historicalOwnership, applications, restoring ? last : null);
        if (!same(candidate, expected)) return reject("OWNERSHIP_LIFECYCLE_CONFLICT");
        return freeze({ status: "validated" as const, document: candidate, ...validationFlags });
    } catch { return reject("MALFORMED_OWNERSHIP_LIFECYCLE"); }
}
