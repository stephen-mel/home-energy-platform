import type { PreparedMutationContext } from "./prepared-mutation-context";
import type { PreparedExperiment, Consent, WriteResult } from "./supervised-experiment";
import { classifyExperimentResult, APPROVAL_TTL_MS, MIN_WRITE_REMAINING_MS } from "./supervised-experiment";
import type { ProposalApproval } from "./proposal-approval";
import { createTariffProposal } from "./proposal-approval";
import type { ObservedTariff } from "./observed-tariff";
import { compareObservedTariffReadBack } from "./restoration-review";
import { representationKey } from "./rollback-evidence";
import { checkOwnershipDomain, ownershipFingerprint } from "./ownership-transition";
import { validOwnership, validOwnershipTimestamp, assertOwnership, type ManagedImportEvidence } from "./ownership-evidence";

export const EXPERIMENT_JOURNAL_SCHEMA = 1;
export type ExperimentException = {
    kind: "supervised-manual-recovery"; consent: Consent; approvedAt: string; approval: ProposalApproval;
    exactExperimentFingerprint: string; productionBlockers: string[];
    automaticRollbackProven: false; manualRecovery: string;
};
export type InitialExperimentEvidence = {
    phase: "approval-consumed-before-write"; review: PreparedExperiment; exception: ExperimentException;
    preWriteRecheck: { teslaSource: ObservedTariff["source"]; tariffKey: string; krakenObservedAt: string; smartEvidenceKey: string };
};
export type ClassifiedExperimentEvidence = {
    phase: "classified"; attemptedAt: string; completedAt: string; exception: ExperimentException;
    apiWrite: WriteResult;
    apiTariffReadBack: { observation: ObservedTariff | null; comparison: ReturnType<typeof compareObservedTariffReadBack> };
    classification: "request-rejected" | "write-outcome-unknown" | "read-back-unavailable-or-insufficient" |
        "submitted-representation-preserved" | "buy-raised-to-sell" | "accepted-but-transformed-differently";
    laterTeslaAppObservation: null; laterPowerwallOpticasterObservation: null;
    rollbackProven: false; productionWriteReady: false; automaticRestoreAttempted: false;
};
export type LinkedInitialRecord = InitialExperimentEvidence & {
    journalSchemaVersion: 1; mutationId: string;
    preparedContext: Pick<PreparedMutationContext, "version" | "ownership" | "fingerprint">;
    initialRecordId: string;
};
export type LinkedClassifiedRecord = ClassifiedExperimentEvidence & {
    journalSchemaVersion: 1; mutationId: string; energySiteId: string;
    initialRecordId: string; classifiedRecordId: string;
};
const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.exec(value)?.[0] === value;
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join() === expected.sort().join();
// Validate before cloning/canonicalisation: JSON.stringify otherwise maps NaN to
// null and drops unsupported values. Cross-realm plain objects remain supported.
function jsonSafe(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) && (!proto || Function.prototype.toString.call(proto.constructor) !== Function.prototype.toString.call(Array))) return false;
    if (!Array.isArray(value) && proto !== null && !(Object.getPrototypeOf(proto) === null
        && Object.getOwnPropertyDescriptor(proto, "constructor")?.value
        && Function.prototype.toString.call(proto.constructor) === Function.prototype.toString.call(Object))) return false;
    const own = Reflect.ownKeys(value);
    if (Array.isArray(value) && (own.length !== value.length + 1
        || Array.from({ length: value.length }, (_, i) => String(i)).some(k => !Object.hasOwn(value, k)))) return false;
    ancestors.add(value);
    const valid = own.every(k => {
        if (Array.isArray(value) && k === "length") return true;
        const d = Object.getOwnPropertyDescriptor(value, k)!;
        return typeof k === "string" && d.enumerable && "value" in d && jsonSafe(d.value, ancestors);
    });
    ancestors.delete(value);
    return valid;
}
function validSource(source: ObservedTariff["source"]) {
    return keys(source, ["kind", "energySiteId", "observedAt", "timeZone"])
        && ["tesla-site-info", "simulation"].includes(source.kind)
        && typeof source.energySiteId === "string" && /^\d+$/.test(source.energySiteId)
        && validOwnershipTimestamp(source.observedAt)
        && (source.timeZone === null || typeof source.timeZone === "string");
}

/** Structural/content checks only. No authenticity, durability, coverage preflight
 * or execution authority is established by these hashes or caller-supplied objects.
 */
export function validPreparedJournalContext(context: PreparedMutationContext): boolean {
    try {
        if (!jsonSafe(context)) return false;
        const { fingerprint, writeReady, rollbackProven, ...bound } = context;
        if (!keys(context, ["version","mutationId","original","ownership","energySiteId","timeZone","selectedDispatch","comparisonDomain",
            "experimentFingerprint","proposalFingerprint","payloadKey","smartEvidenceKey","selectedEvidenceKey","ownershipKey","fingerprint","writeReady","rollbackProven"])
            || context.version !== 1 || !id(context.mutationId) || writeReady !== false || rollbackProven !== false
            || fingerprint !== ownershipFingerprint(bound)) return false;
        const r = structuredClone(context.original) as PreparedExperiment, p = r.proposal, smart = p.input.observedSmart, o = context.ownership;
        if (!validSource(r.before.source) || !smart || p.input.observedReplacement || !p.structurallyValid || !same(createTariffProposal(p.input), p)
            || !same(r.before, smart.observation) || r.fingerprint !== representationKey(r.binding)
            || r.payloadJson !== representationKey({ tou_settings: { tariff_content_v2: p.bound.representation } })
            || context.experimentFingerprint !== r.fingerprint || context.proposalFingerprint !== p.fingerprint
            || context.payloadKey !== r.payloadJson || context.smartEvidenceKey !== r.binding.smartEvidenceKey
            || context.selectedEvidenceKey !== p.bound.dispatchEvidenceKey || !same(context.selectedDispatch, smart.dispatch)
            || !same(context.comparisonDomain, smart.comparisonDomain) || context.energySiteId !== p.bound.energySiteId
            || context.timeZone !== p.bound.timeZone || o.energySiteId !== context.energySiteId
            || r.binding.authority !== "supervised-experiment" || r.binding.proposalFingerprint !== p.fingerprint
            || r.binding.payloadKey !== r.payloadJson || r.binding.generatedAt !== smart.generatedAt
            || !same(r.binding.selection, { energySiteId: context.energySiteId, assetId: smart.dispatch.assetId, dispatchStart: smart.dispatch.start })
            || context.ownershipKey !== ownershipFingerprint(o) || !validOwnershipTimestamp(o.capturedAt)
            || !validOwnershipTimestamp(smart.generatedAt) || !validOwnershipTimestamp(r.evidenceCapturedAt)
            || Date.parse(o.capturedAt) > Date.parse(smart.generatedAt)
            || !keys(o, ["capturedAt","energySiteId","status","snapshot"])) return false;
        if (o.status === "missing") return o.snapshot === null;
        if (o.status !== "available") return false;
        const s = o.snapshot;
        if (!keys(s, ["version","generation","evidence","checksum"]) || s.version !== 1
            || typeof s.generation !== "string" || !/^[a-f0-9-]{36}$/.test(s.generation)
            || !validOwnership(s.evidence) || Date.parse(s.evidence.updatedAt) > Date.parse(o.capturedAt)
            || s.checksum !== ownershipFingerprint({ generation: s.generation, evidence: s.evidence })) return false;
        assertOwnership(structuredClone(s.evidence) as ManagedImportEvidence, r.before, smart.generatedAt);
        return true;
    } catch { return false; }
}
function validException(e: ExperimentException, r: PreparedExperiment) {
    return keys(e, ["kind","consent","approvedAt","approval","exactExperimentFingerprint","productionBlockers","automaticRollbackProven","manualRecovery"])
        && e.kind === "supervised-manual-recovery" && e.exactExperimentFingerprint === r.fingerprint
        && keys(e.approval, ["fingerprint","approvedAt"]) && keys(e.consent, ["challenge","automaticRollbackUnproven","manualAppRecoveryMayBeRequired"])
        && e.approval.fingerprint === r.proposal.fingerprint && e.approval.approvedAt === e.approvedAt
        && validOwnershipTimestamp(e.approvedAt) && Date.parse(e.approvedAt) >= Date.parse(r.proposal.bound.validFrom)
        && Date.parse(e.approvedAt) < Date.parse(r.proposal.bound.expiresAt)
        && typeof e.consent.challenge === "string" && e.consent.challenge.length > 0
        && e.consent.automaticRollbackUnproven === true && e.consent.manualAppRecoveryMayBeRequired === true
        && e.automaticRollbackProven === false && typeof e.manualRecovery === "string"
        && Array.isArray(e.productionBlockers) && e.productionBlockers.every(c => typeof c === "string");
}
// Everything else in Stage A is already present in the original review. Rebuild
// those references for fingerprint validation instead of storing duplicate payloads.
function contextFromInitial(r: LinkedInitialRecord): PreparedMutationContext {
    const review = r.review, smart = review.proposal.input.observedSmart!;
    return { ...r.preparedContext, mutationId: r.mutationId, original: review,
        energySiteId: review.proposal.bound.energySiteId, timeZone: review.proposal.bound.timeZone,
        selectedDispatch: smart.dispatch, comparisonDomain: smart.comparisonDomain,
        experimentFingerprint: review.fingerprint, proposalFingerprint: review.proposal.fingerprint,
        payloadKey: review.payloadJson, smartEvidenceKey: review.binding.smartEvidenceKey,
        selectedEvidenceKey: review.proposal.bound.dispatchEvidenceKey,
        ownershipKey: ownershipFingerprint(r.preparedContext.ownership), writeReady: false, rollbackProven: false };
}
export function validLinkedInitialRecord(value: unknown, site: string): value is LinkedInitialRecord {
    try {
        if (!jsonSafe(value)) return false;
        const r = value as LinkedInitialRecord;
        if (!keys(r, ["journalSchemaVersion","mutationId","preparedContext","initialRecordId","phase","review","exception","preWriteRecheck"])
            || r.journalSchemaVersion !== 1 || !id(r.mutationId) || r.phase !== "approval-consumed-before-write"
            || typeof site !== "string" || !/^\d+$/.test(site) || r.review.proposal.bound.energySiteId !== site
            || !keys(r.preparedContext, ["version","ownership","fingerprint"])) return false;
        const { initialRecordId, ...body } = r;
        if (initialRecordId !== ownershipFingerprint(body) || !validPreparedJournalContext(contextFromInitial(r))) return false;
        const check = r.preWriteRecheck;
        return validException(r.exception, r.review) && keys(check, ["teslaSource","tariffKey","krakenObservedAt","smartEvidenceKey"])
            && validSource(check.teslaSource) && check.teslaSource.kind === "tesla-site-info" && check.teslaSource.energySiteId === site
            && check.teslaSource.timeZone === r.review.proposal.bound.timeZone && validOwnershipTimestamp(check.teslaSource.observedAt)
            && validOwnershipTimestamp(check.krakenObservedAt) && check.tariffKey === representationKey(r.review.before.tariff)
            && check.smartEvidenceKey === r.review.binding.smartEvidenceKey;
    } catch { return false; }
}
export function createLinkedInitialRecord(context: PreparedMutationContext, evidence: InitialExperimentEvidence): LinkedInitialRecord {
    if (!jsonSafe(context) || !jsonSafe(evidence)) throw Error("JOURNAL_INITIAL_INVALID");
    const { original, version, ownership, fingerprint } = structuredClone(context);
    const preparedContext = { version, ownership, fingerprint };
    if (!validPreparedJournalContext(context) || !same(original, evidence.review)) throw Error("JOURNAL_INITIAL_INVALID");
    const body = { ...structuredClone(evidence), journalSchemaVersion: EXPERIMENT_JOURNAL_SCHEMA,
        mutationId: context.mutationId, preparedContext };
    const record = { ...body, initialRecordId: ownershipFingerprint(body) };
    if (!validLinkedInitialRecord(record, context.energySiteId)) throw Error("JOURNAL_INITIAL_INVALID");
    return record;
}
export function validLinkedClassifiedRecord(value: unknown, initial: LinkedInitialRecord): value is LinkedClassifiedRecord {
    try {
        if (!jsonSafe(value)) return false;
        const r = value as LinkedClassifiedRecord;
        if (!validLinkedInitialRecord(initial, initial.review.proposal.bound.energySiteId)
            || !keys(r, ["journalSchemaVersion","mutationId","energySiteId","initialRecordId","classifiedRecordId","phase","attemptedAt","completedAt","exception",
                "apiWrite","apiTariffReadBack","classification","laterTeslaAppObservation","laterPowerwallOpticasterObservation","rollbackProven","productionWriteReady","automaticRestoreAttempted"])
            || r.journalSchemaVersion !== 1 || !id(r.mutationId) || r.mutationId !== initial.mutationId
            || r.energySiteId !== initial.review.proposal.bound.energySiteId || r.initialRecordId !== initial.initialRecordId
            || r.phase !== "classified" || !same(r.exception, initial.exception)) return false;
        const { classifiedRecordId, ...body } = r;
        if (classifiedRecordId !== ownershipFingerprint(body) || !validOwnershipTimestamp(r.attemptedAt)
            || !validOwnershipTimestamp(r.completedAt) || Date.parse(r.completedAt) < Date.parse(r.attemptedAt)
            || !keys(r.apiWrite, ["status","httpStatus"]) || !keys(r.apiTariffReadBack, ["observation","comparison"])
            || !["accepted","rejected","unknown"].includes(r.apiWrite.status)
            || !(r.apiWrite.httpStatus === null || typeof r.apiWrite.httpStatus === "number" && Number.isInteger(r.apiWrite.httpStatus)
                && r.apiWrite.httpStatus >= 100 && r.apiWrite.httpStatus <= 599)
            || r.rollbackProven !== false || r.productionWriteReady !== false || r.automaticRestoreAttempted !== false
            || r.laterTeslaAppObservation !== null || r.laterPowerwallOpticasterObservation !== null
            || !["request-rejected","write-outcome-unknown","read-back-unavailable-or-insufficient","submitted-representation-preserved","buy-raised-to-sell","accepted-but-transformed-differently"].includes(r.classification)) return false;
        const attempt = Date.parse(r.attemptedAt), approval = Date.parse(r.exception.approvedAt);
        if (attempt < approval || attempt - approval > APPROVAL_TTL_MS
            || attempt < Date.parse(initial.review.proposal.bound.validFrom)
            || attempt + MIN_WRITE_REMAINING_MS >= Date.parse(initial.review.proposal.bound.expiresAt)) return false;
        if (r.apiWrite.status === "accepted" && !(typeof r.apiWrite.httpStatus === "number"
            && Number.isFinite(r.apiWrite.httpStatus) && Number.isInteger(r.apiWrite.httpStatus)
            && r.apiWrite.httpStatus >= 200 && r.apiWrite.httpStatus <= 299)) return false;
        const observation = r.apiTariffReadBack.observation;
        if (observation && (!validSource(observation.source) || observation.source.energySiteId !== r.energySiteId || observation.source.timeZone !== initial.review.proposal.bound.timeZone)) return false;
        const intended: ObservedTariff = { ...initial.review.before,
            source: { ...initial.review.before.source, kind: "simulation" }, tariff: initial.review.proposal.bound.representation };
        const comparison = compareObservedTariffReadBack({ intended,
            readBack: observation, after: r.attemptedAt, dates: [initial.review.date] });
        if (comparison.outcome !== "insufficient-evidence" && (!observation
            || !(attempt < Date.parse(observation.source.observedAt)
                && Date.parse(observation.source.observedAt) <= Date.parse(r.completedAt)))) return false;
        return same(r.apiTariffReadBack.comparison, comparison)
            && r.classification === classifyExperimentResult(r.apiWrite, intended, observation, comparison);
    } catch { return false; }
}
export function createLinkedClassifiedRecord(initial: LinkedInitialRecord, evidence: ClassifiedExperimentEvidence): LinkedClassifiedRecord {
    if (!jsonSafe(initial) || !jsonSafe(evidence)) throw Error("JOURNAL_CLASSIFIED_INVALID");
    const body = { ...structuredClone(evidence), journalSchemaVersion: EXPERIMENT_JOURNAL_SCHEMA,
        mutationId: initial.mutationId, energySiteId: initial.review.proposal.bound.energySiteId, initialRecordId: initial.initialRecordId };
    const record = { ...body, classifiedRecordId: ownershipFingerprint(body) };
    if (!validLinkedClassifiedRecord(record, initial)) throw Error("JOURNAL_CLASSIFIED_INVALID");
    return record;
}

/** Inspect the original context only. Passing is containment, not finalisation or
 * authority. Actual readback coverage and generation conflicts remain unchecked. */
export function preflightOwnershipDomain(context: PreparedMutationContext, preflightAt: string) {
    if (!validPreparedJournalContext(context))
        return { status: "rejected" as const, code: "JOURNAL_INITIAL_INVALID" as const };
    if (!validOwnershipTimestamp(preflightAt) || Date.parse(preflightAt) < Date.parse(context.original.binding.generatedAt))
        return { status: "rejected" as const, code: "INVALID_TRANSITION" as const };
    return checkOwnershipDomain({
        previous: context.ownership.status === "available" ? context.ownership.snapshot.evidence : null,
        domain: context.comparisonDomain, asOf: preflightAt,
    });
}
