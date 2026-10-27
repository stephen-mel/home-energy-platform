import type { OfflineOperationHistory } from "./prepared-mutation-context";
import { expectedOperationGeneration } from "./prepared-mutation-context";
import type { OwnershipAttributionAdmission } from "./ownership-attribution";
import { validateOwnershipLifecycleDocument, type OwnershipLifecycleDocument, type OwnershipLifecycleValidationContext } from "./ownership-lifecycle";
import { ownershipFingerprint as hash } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";
import { validJournalEvidenceJson } from "./journal-evidence-json";

/** Versioned JSON representation in the EXISTING ownership.snapshot and
 * applied.record columns. No SQL migration or writer is installed by F4a.
 * Runtime identity references remain references, never registry membership. */
export type PersistedOwnershipLifecycle = {
    version: 1; kind: "v3-ownership-persistence";
    lifecycle: OwnershipLifecycleDocument;
    approvedValidity: OwnershipAttributionAdmission["validity"];
    previousRecordId: string | null;
    recordId: string;
};
export const persistenceOnly = Object.freeze({
    executionReady: false, writeReady: false, grantsAdmissionAuthority: false,
    grantsSuccessorAuthority: false, grantsRepeatAuthority: false, grantsRestorationAuthority: false,
    runtimeConfirmationVerified: false, identityProvenance: "unverified", resolvesHistoricalJournal: false,
} as const);
const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);

/** Pure representation validation, NOT a commit/predecessor capability. A caller
 * can validate documents here but cannot turn them into trusted persisted state.
 * No trusted runtime-identity source exists at this layer. Production returns
 * consistent-only, never validated production identity provenance. The SQLite
 * reader separately obtains both tables and physical journal history.
 * Exact approved generations are checked; future F4 CAS must repeat these checks
 * against transaction-local state inside BEGIN IMMEDIATE, never allocate a UUID. */
export function validatePersistedOwnershipHistory(current: unknown, supplied: unknown, site: string, timeZone: string,
    journal: OfflineOperationHistory) {
    return validatePersistenceHistory(current, supplied, site, timeZone, journal, validateOwnershipLifecycleDocument);
}
// Shared structural checks only. The exported reader always selects production
// validation. Tests instrument this private function; no offline writer exists.
function validatePersistenceHistory(current: unknown, supplied: unknown, site: string, timeZone: string,
    journal: OfflineOperationHistory, lifecycleValidator: typeof validateOwnershipLifecycleDocument, offlineContext?: OwnershipLifecycleValidationContext) {
    const offline = offlineContext !== undefined;
    const reject = (code: string) => ({ status: "rejected" as const, code, ...persistenceOnly });
    try {
        if (!validJournalEvidenceJson({ current, supplied, journal }) || !/^\d+$/.test(site)
            || !Array.isArray(supplied) || !supplied.length || !Array.isArray(journal.records)
            || supplied.length !== journal.records.length || supplied.length !== journal.contexts.length)
            return reject("V3_PERSISTENCE_HISTORY_INCOMPLETE");
        if (offline && (supplied.length !== 1 || journal.records[0]?.initial?.intent?.kind !== "apply"))
            return reject("OFFLINE_FIRST_APPLY_ONLY");
        const remaining = new Set(structuredClone(supplied) as PersistedOwnershipLifecycle[]);
        const persistedIds = new Set([...remaining].map(r => r?.recordId));
        const records: PersistedOwnershipLifecycle[] = [];
        let previous: PersistedOwnershipLifecycle | null = null;
        const identities = new Set<string>();
        for (let n = 0; n < journal.records.length; n++) {
            const candidates = [...remaining].filter(r => r?.previousRecordId === (previous?.recordId ?? null));
            if (candidates.length !== 1) return reject("V3_PERSISTENCE_HISTORY_CONFLICT");
            const record = candidates[0];
            if (Object.keys(record).sort().join() !== "approvedValidity,kind,lifecycle,previousRecordId,recordId,version"
                || record.version !== 1 || record.kind !== (offline ? "offline-v2-ownership-persistence" : "v3-ownership-persistence")) return reject("V3_PERSISTENCE_VERSION_INVALID");
            const { recordId, ...body } = record;
            if (recordId !== hash({ purpose: "smart-ownership-persistence-v1", ...body }) || identities.has(recordId))
                return reject("V3_PERSISTENCE_CHECKSUM_CONFLICT");
            const d = record.lifecycle, evidence = journal.records[n], intent = evidence.initial.intent;
            if (d.applications.some(a => persistedIds.has(a.runtime.receiptKey) || persistedIds.has(a.runtime.issuanceKey)
                || a.runtime.namespace === "offline-simulated-operation"
                    && (persistedIds.has(a.runtime.admissionKey) || persistedIds.has(a.runtime.simulatedCompletionKey))))
                return reject("V3_PERSISTENCE_IDENTITY_ALIAS");
            const before = previous?.lifecycle;
            if (before?.state === "restored" || !same(intent.ownershipBefore, before?.historicalOwnership ?? null)
                || intent.ownershipAfterGeneration !== expectedOperationGeneration(site, intent.operationId, intent.mutationId,
                    before ? { status: "available", snapshot: before.historicalOwnership } : { status: "missing" })
                || d.generation !== intent.ownershipAfterGeneration)
                return reject("V3_PERSISTENCE_GENERATION_OR_PREDECESSOR_CONFLICT");
            if (!intent.ownershipAttribution || !same(record.approvedValidity, intent.ownershipAttribution.admission.validity))
                return reject("V3_PERSISTENCE_VALIDITY_CONFLICT");
            if (offlineContext && (offlineContext.energySiteId !== site || offlineContext.timeZone !== timeZone
                || !same(offlineContext.operations, journal.records.map((evidence, p) => ({ evidence, context: journal.contexts[p] })))
                || !same(offlineContext.historicalOwnership, d.historicalOwnership)))
                return reject("OFFLINE_IDENTITY_CONTEXT_CONFLICT");
            // Without independent runtime provenance this checks CLAIMED
            // reference consistency only. Candidate references are never an
            // authenticated expectation; the production result below cannot
            // be "validated" or used as verified predecessor evidence.
            const checked = lifecycleValidator(d, offlineContext ?? {
                version: 1, energySiteId: site, timeZone, historicalOwnership: d.historicalOwnership,
                operations: journal.records.slice(0, n + 1).map((evidence, p) => ({ evidence, context: journal.contexts[p] })),
                runtimeIdentities: d.applications.map(a => a.runtime), previousLifecycle: before ?? null,
            });
            if (checked.status !== "validated") return reject(checked.code);
            // Earlier committed mappings cannot be rewritten by a rehashed tail.
            if (!same(d.applications.slice(0, -1), before?.applications ?? [])) return reject("V3_PERSISTENCE_MAPPING_CONFLICT");
            identities.add(recordId); records.push(record); remaining.delete(record); previous = record;
        }
        if (remaining.size || !same(current, previous)) return reject("V3_PERSISTENCE_CURRENT_CONFLICT");
        return { status: offline ? "validated" as const : "consistent-only" as const,
            current: structuredClone(previous!), records, ...persistenceOnly };
    } catch { return reject("V3_PERSISTENCE_MALFORMED"); }
}
