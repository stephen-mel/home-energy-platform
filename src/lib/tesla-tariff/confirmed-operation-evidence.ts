import type { ObservedTariff } from "./observed-tariff";
import type { LifecycleOwnershipSnapshot } from "./ownership-store";
import type { RetainedOriginal } from "./retained-original";
import { validLifecycleOwnershipSnapshot, validRetainedOriginal, retainedOriginKey, retentionDigest } from "./retained-original";
import { validJournalEvidenceJson } from "./linked-experiment-records";
import { validOwnershipTimestamp } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { compareObservedTariffReadBack } from "./restoration-review";
import { APPROVAL_TTL_MS, CAPTURE_TTL_MS, type WriteResult } from "./supervised-experiment";

export type SmartOperationKind = "apply" | "update" | "restore";
type ObservationEvidence = { observationId: string; observation: ObservedTariff };
type Predecessor = { operationId: string; mutationId: string; evidenceId: string; completionRecordId: string };
export type SmartOperationIntent = {
    kind: SmartOperationKind; operationId: string; mutationId: string; energySiteId: string; timeZone: string;
    predecessor: Predecessor | null;
    ownershipBefore: LifecycleOwnershipSnapshot | null; ownershipAfterGeneration: string;
    original: ObservedTariff; originalFingerprint: string; origin: RetainedOriginal["origin"] | null;
    before: ObservationEvidence; payloadJson: string; payloadFingerprint: string;
    preparedAt: string; validFrom: string; expiresAt: string;
};
/** Versioned operation-specific approval evidence. Uses the existing canonical
 * fingerprint/approvedAt convention, but cannot be passed off as a v1 proposal
 * approval or a runtime approval capability. No approval issuer is provided. */
export type SmartOperationApprovalEvidence = {
    version: 2; operationId: string; mutationId: string; fingerprint: string; approvedAt: string; approvalId: string;
};
export type SmartOperationInitialRecord = {
    journalSchemaVersion: 2; phase: "approved-operation"; intent: SmartOperationIntent;
    approval: SmartOperationApprovalEvidence; initialRecordId: string;
};
export type SmartOperationCompletionRecord = {
    journalSchemaVersion: 2; phase: "confirmed-operation";
    operationId: string; mutationId: string; energySiteId: string; timeZone: string;
    initialRecordId: string; ownershipAfterGeneration: string;
    submittedAt: string; completedAt: string; journalCompletedAt: string; apiWrite: WriteResult;
    readback: ObservationEvidence; finalTariffFingerprint: string;
    outcome: "applied" | "updated" | "restored"; completionRecordId: string;
};
/** Separate v2 evidence envelope. Existing v1 receipts and linked records are
 * neither accepted nor upgraded by this contract. Hashes are content identities. */
export type ConfirmedOperationEvidence = {
    version: 2; initial: SmartOperationInitialRecord; completion: SmartOperationCompletionRecord; evidenceId: string;
};
export type ConfirmedOperationValidationContext = {
    energySiteId: string; timeZone: string;
    ownershipBefore: LifecycleOwnershipSnapshot | null; ownershipAfterGeneration: string;
    retainedOriginal: RetainedOriginal;
    confirmedHistory: readonly ConfirmedOperationEvidence[];
    approvals: readonly SmartOperationApprovalEvidence[];
    authenticatedObservations: readonly (ObservationEvidence & {
        operationId: string; mutationId: string; phase: "before" | "readback";
    })[];
    durableJournal: readonly { initialRecordId: string; completionRecordId: string }[];
};

const hash = ownershipFingerprint, same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
const keys = (v: object, names: string) => Object.keys(v).sort().join() === names;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.exec(v)?.[0] === v;
const generation = (v: unknown): v is string => typeof v === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.exec(v)?.[0] === v;
function freeze<T>(v: T): T {
    if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
}
const noAuthority = { executionReady: false, writeReady: false, rollbackProven: false, restorationProven: false,
    grantsRepeatAuthority: false, grantsSuccessorAuthority: false, resolvesHistoricalJournal: false } as const;

/** Pure documentary validation, never an authentication, durability, approval or
 * capability issuer. Context MUST come independently from trusted server readers
 * and authenticated acquisition, never from the submitted envelope/recovery alone.
 * No such production integration is installed by this module. A fabricated trust
 * context cannot be authenticated by a pure function. Revalidate at integration.
 *
 * afterGeneration is an expected identity, not an ownership transition. UUIDs are
 * opaque: progression means exact expected predecessor plus a fresh unique result.
 * Even a restored outcome leaves the retained restoration obligation untouched. */
export function validateConfirmedOperationEvidence(supplied: unknown, trusted: ConfirmedOperationValidationContext) {
    const reject = (code: string) => freeze({ status: "rejected" as const, code, ...noAuthority });
    try {
        if (!validJournalEvidenceJson(supplied) || !validJournalEvidenceJson(trusted)) return reject("MALFORMED_OPERATION_EVIDENCE");
        const evidence = structuredClone(supplied) as ConfirmedOperationEvidence;
        const context = structuredClone(trusted);
        if (!keys(context, "approvals,authenticatedObservations,confirmedHistory,durableJournal,energySiteId,ownershipAfterGeneration,ownershipBefore,retainedOriginal,timeZone")
            || typeof context.energySiteId !== "string" || !/^\d+$/.test(context.energySiteId)
            || typeof context.timeZone !== "string" || !generation(context.ownershipAfterGeneration)
            || !validRetainedOriginal(context.retainedOriginal)
            || context.retainedOriginal.energySiteId !== context.energySiteId || context.retainedOriginal.timeZone !== context.timeZone
            || !Array.isArray(context.confirmedHistory) || !Array.isArray(context.approvals)
            || !Array.isArray(context.authenticatedObservations) || !Array.isArray(context.durableJournal)) return reject("INVALID_OPERATION_CONTEXT");
        if (context.ownershipBefore !== null && (!validLifecycleOwnershipSnapshot(context.ownershipBefore, context.energySiteId)
            || !same(context.ownershipBefore.lifecycle, context.retainedOriginal))) return reject("INVALID_V3_OWNERSHIP");
        const all: readonly ConfirmedOperationEvidence[] = [...context.confirmedHistory, evidence];
        if (context.durableJournal.length !== all.length) return reject("DURABLE_JOURNAL_HISTORY_CONFLICT");
        const seen = new Map<string, Set<string>>();
        const unique = (domain: string, value: string) => {
            const set = seen.get(domain) ?? new Set<string>();
            if (set.has(value)) return false;
            set.add(value); seen.set(domain, set); return true;
        };
        for (const a of context.approvals) {
            if (!keys(a, "approvalId,approvedAt,fingerprint,mutationId,operationId,version") || a.version !== 2
                || !retentionDigest(a.approvalId) || !unique("trusted-approval", a.approvalId)) return reject("INVALID_APPROVAL_EVIDENCE");
        }
        for (const o of context.authenticatedObservations) {
            if (!keys(o, "mutationId,observation,observationId,operationId,phase") || !id(o.observationId)
                || !unique("trusted-observation", o.observationId)) return reject("INVALID_AUTHENTICATED_OBSERVATION");
        }
        for (const j of context.durableJournal) {
            if (!keys(j, "completionRecordId,initialRecordId") || !retentionDigest(j.initialRecordId) || !retentionDigest(j.completionRecordId)
                || !unique("durable-record", j.initialRecordId) || !unique("durable-record", j.completionRecordId)) return reject("INVALID_DURABLE_JOURNAL_EVIDENCE");
        }
        let previous: ConfirmedOperationEvidence | null = null;
        for (const record of all) {
            if (!keys(record, "completion,evidenceId,initial,version") || record.version !== 2
                || !record.initial || !record.completion) return reject("UNSUPPORTED_OPERATION_EVIDENCE");
            const { initial, completion } = record, { intent, approval } = initial;
            if (!keys(initial, "approval,initialRecordId,intent,journalSchemaVersion,phase")
                || initial.journalSchemaVersion !== 2 || initial.phase !== "approved-operation"
                || !intent || !keys(intent, "before,energySiteId,expiresAt,kind,mutationId,operationId,origin,original,originalFingerprint,ownershipAfterGeneration,ownershipBefore,payloadFingerprint,payloadJson,predecessor,preparedAt,timeZone,validFrom")
                || !id(intent.operationId) || !id(intent.mutationId) || !["apply", "update", "restore"].includes(intent.kind)
                || !generation(intent.ownershipAfterGeneration) || intent.energySiteId !== context.energySiteId
                || intent.timeZone !== context.timeZone) return reject("INVALID_INITIAL_OPERATION_RECORD");
            const { initialRecordId, ...initialBody } = initial;
            const { completionRecordId, ...completionBody } = completion;
            if (!retentionDigest(initialRecordId) || initialRecordId !== hash(initialBody)
                || !retentionDigest(completionRecordId) || completionRecordId !== hash(completionBody)
                || !retentionDigest(record.evidenceId) || record.evidenceId !== hash({ version: 2, initial, completion })) return reject("OPERATION_CHECKSUM_MISMATCH");
            if (!unique("operation", intent.operationId) || !unique("mutation", intent.mutationId)
                || !unique("journal-record", initialRecordId) || !unique("journal-record", completionRecordId)
                || !unique("generation", intent.ownershipAfterGeneration)) return reject("DUPLICATE_OPERATION_IDENTITY");
            if (!keys(completion, "apiWrite,completedAt,completionRecordId,energySiteId,finalTariffFingerprint,initialRecordId,journalCompletedAt,journalSchemaVersion,mutationId,operationId,outcome,ownershipAfterGeneration,phase,readback,submittedAt,timeZone")
                || completion.journalSchemaVersion !== 2 || completion.phase !== "confirmed-operation"
                || completion.operationId !== intent.operationId || completion.mutationId !== intent.mutationId
                || completion.energySiteId !== intent.energySiteId || completion.timeZone !== intent.timeZone
                || completion.initialRecordId !== initialRecordId || completion.ownershipAfterGeneration !== intent.ownershipAfterGeneration
                || completion.outcome !== ({ apply: "applied", update: "updated", restore: "restored" } as const)[intent.kind]) return reject("OPERATION_COMPLETION_CONFLICT");
            if (!context.durableJournal.some(j => j.initialRecordId === initialRecordId && j.completionRecordId === completionRecordId))
                return reject("DURABLE_JOURNAL_EVIDENCE_MISSING");
            if (!same(intent.original, context.retainedOriginal.original) || intent.originalFingerprint !== context.retainedOriginal.originalFingerprint)
                return reject("ORIGINAL_BASELINE_CONFLICT");
            if (!previous) {
                if (intent.kind !== "apply" || intent.predecessor !== null || intent.ownershipBefore !== null || intent.origin !== null)
                    return reject("CONFIRMED_APPLY_ROOT_REQUIRED");
                const origin = context.retainedOriginal.origin;
                if (origin.mutationId !== intent.mutationId || origin.initialRecordId !== initialRecordId
                    || origin.classifiedRecordId !== completionRecordId || origin.receiptKey !== record.evidenceId)
                    return reject("ORIGIN_JOURNAL_CONFLICT");
            } else {
                const before = intent.ownershipBefore;
                if (intent.kind === "apply" || previous.initial.intent.kind === "restore"
                    || !same(intent.predecessor, { operationId: previous.initial.intent.operationId, mutationId: previous.initial.intent.mutationId,
                        evidenceId: previous.evidenceId, completionRecordId: previous.completion.completionRecordId })) return reject("PREDECESSOR_CONFLICT");
                if (!validLifecycleOwnershipSnapshot(before, context.energySiteId) || !generation(before.generation)
                    || before.generation !== previous.initial.intent.ownershipAfterGeneration
                    || before.lifecycle.latestReadback.mutationId !== previous.initial.intent.mutationId
                    || before.lifecycle.latestReadback.receiptKey !== previous.evidenceId
                    || before.lifecycle.latestReadback.fingerprint !== previous.completion.finalTariffFingerprint
                    || retainedOriginKey(before.lifecycle) !== retainedOriginKey(context.retainedOriginal)
                    || !same(intent.origin, before.lifecycle.origin)
                    || Date.parse(before.evidence.updatedAt) !== Date.parse(previous.completion.completedAt)
                    || Date.parse(intent.preparedAt) < Date.parse(previous.completion.journalCompletedAt)) return reject("OWNERSHIP_PREDECESSOR_CONFLICT");
            }
            if (!approval || !keys(approval, "approvalId,approvedAt,fingerprint,mutationId,operationId,version")) return reject("INVALID_APPROVAL_EVIDENCE");
            const { approvalId, ...approvalBody } = approval;
            if (approval.version !== 2 || approval.operationId !== intent.operationId || approval.mutationId !== intent.mutationId
                || approval.fingerprint !== representationKey(intent) || approvalId !== hash(approvalBody)
                || !unique("approval", approvalId) || !context.approvals.some(a => same(a, approval))) return reject("APPROVAL_NOT_BOUND");
            const observations = [["before", intent.before], ["readback", completion.readback]] as const;
            for (const [phase, o] of observations) {
                if (!o || !keys(o, "observation,observationId") || !id(o.observationId) || !unique("observation", o.observationId)
                    || !same(validateTeslaInspectionEvidence(o.observation), o.observation)
                    || !validOwnershipTimestamp(o.observation.source.observedAt)
                    || o.observation.source.energySiteId !== intent.energySiteId || o.observation.source.timeZone !== intent.timeZone
                    || !context.authenticatedObservations.some(a => a.phase === phase && a.operationId === intent.operationId
                        && a.mutationId === intent.mutationId && a.observationId === o.observationId && same(a.observation, o.observation)))
                    return reject("AUTHENTICATED_OBSERVATION_NOT_BOUND");
            }
            const before = intent.before.observation, readback = completion.readback.observation;
            if (hash(before.tariff) !== (intent.ownershipBefore?.evidence.readbackFingerprint ?? intent.originalFingerprint))
                return reject("CURRENT_TARIFF_OWNERSHIP_CONFLICT");
            if (intent.kind === "apply" && !same(before, intent.original)) return reject("ORIGINAL_BASELINE_CONFLICT");
            const timestamps = [intent.preparedAt, intent.validFrom, intent.expiresAt, approval.approvedAt,
                completion.submittedAt, completion.completedAt, completion.journalCompletedAt];
            if (!timestamps.every(validOwnershipTimestamp)) return reject("INVALID_OPERATION_TIME");
            const submitted = Date.parse(completion.submittedAt), completed = Date.parse(completion.completedAt), approved = Date.parse(approval.approvedAt);
            if (Date.parse(before.source.observedAt) > Date.parse(intent.preparedAt) || Date.parse(intent.preparedAt) > approved
                || Date.parse(intent.validFrom) < Date.parse(intent.preparedAt)
                || approved < Date.parse(intent.validFrom) || approved >= Date.parse(intent.expiresAt)
                || approved > submitted || submitted - approved > APPROVAL_TTL_MS
                || submitted < Date.parse(intent.validFrom) || submitted >= Date.parse(intent.expiresAt)
                || submitted - Date.parse(before.source.observedAt) > CAPTURE_TTL_MS
                || Date.parse(readback.source.observedAt) > completed || completed - Date.parse(readback.source.observedAt) > CAPTURE_TTL_MS
                || completed > Date.parse(completion.journalCompletedAt)) return reject("INVALID_OPERATION_TIME");
            const api = completion.apiWrite;
            if (!api || !keys(api, "httpStatus,status") || api.status !== "accepted" || !Number.isInteger(api.httpStatus)
                || api.httpStatus! < 200 || api.httpStatus! > 299) return reject("EXECUTION_NOT_ACCEPTED");
            const payload = JSON.parse(intent.payloadJson);
            if (!payload || !keys(payload, "tou_settings") || !payload.tou_settings || !keys(payload.tou_settings, "tariff_content_v2")
                || intent.payloadJson !== representationKey(payload) || intent.payloadFingerprint !== hash(payload)) return reject("PAYLOAD_NOT_BOUND");
            const intended = { ...before, tariff: payload.tou_settings.tariff_content_v2 };
            if (!same(validateTeslaInspectionEvidence(intended), intended)
                || intent.kind === "restore" && !same(intended.tariff, intent.original.tariff)) return reject("INVALID_OPERATION_PAYLOAD");
            const date = new Intl.DateTimeFormat("en-CA", { timeZone: intent.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
                .format(new Date(completion.submittedAt));
            const match = compareObservedTariffReadBack({ intended, readBack: readback, after: completion.submittedAt, dates: [date] });
            if (match.outcome !== "exact-observed-match" || !match.timelineScope.complete
                || completion.finalTariffFingerprint !== hash(readback.tariff)) return reject("READBACK_NOT_EXACT");
            previous = record;
        }
        const intent = evidence.initial.intent;
        if (!same(intent.ownershipBefore, context.ownershipBefore) || intent.ownershipAfterGeneration !== context.ownershipAfterGeneration)
            return reject("STALE_OWNERSHIP_GENERATION");
        if (context.ownershipBefore === null && (context.retainedOriginal.currentGeneration !== intent.ownershipAfterGeneration
            || !same(context.retainedOriginal.latestReadback, { mutationId: intent.mutationId, receiptKey: evidence.evidenceId,
                fingerprint: evidence.completion.finalTariffFingerprint }))) return reject("OWNERSHIP_RESULT_CONFLICT");
        return freeze({ status: "validated" as const, evidence, ...noAuthority });
    } catch { return reject("MALFORMED_OPERATION_EVIDENCE"); }
}
