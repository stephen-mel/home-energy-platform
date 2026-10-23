/** Offline orchestration only. No provider adapter, process configuration, timer,
 * receipt issuer or ownership writer is imported here. Simulation results never
 * constitute trusted execution or restoration evidence. */
import type { SmartDesiredStateInput } from "./smart-desired-state";
import { deriveSmartTariffDesiredState } from "./smart-desired-state";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { inspectSmartTariff } from "./smart-inspection";
import { representationKey } from "./rollback-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { validOwnership, validOwnershipTimestamp } from "./ownership-evidence";
import { deriveReplacementOwnership } from "./ownership-replacement-transition";
import type { OwnershipRead } from "./ownership-store";
import type { ObservedTariff } from "./observed-tariff";
import { approveTariffProposal, createTariffProposal } from "./proposal-approval";
import { assessFreshBaselineEligibility } from "./fresh-baseline-eligibility";
import { compareObservedTariffReadBack } from "./restoration-review";
import { classifyExperimentResult, type WriteResult } from "./supervised-experiment";
import { APPROVAL_TTL_MS, CAPTURE_TTL_MS, MIN_WRITE_REMAINING_MS, smartEvidenceKey } from "./smart-evidence";

const safety = { offlineOnly: true, executionReady: false, writeReady: false, rollbackProven: false,
    restorationProven: false, resolvesHistoricalJournal: false, grantsRepeatAuthority: false } as const;
const key = ownershipFingerprint;
const payload = (tariff: unknown) => representationKey({ tou_settings: { tariff_content_v2: tariff } });
const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};
const fresh = (at: string, now: string, ttl: number) => validOwnershipTimestamp(at) && validOwnershipTimestamp(now)
    && Date.parse(at) <= Date.parse(now) && Date.parse(now) - Date.parse(at) <= ttl;

// Canonical journal inputs must survive a real JSON round trip. Optional absent
// object fields are omitted; no array holes, coercion, getters or lossy values.
function journalInput<T>(value: T): T {
    const seen = new Set<object>();
    let nodes = 0;
    function copy(v: unknown, depth: number): unknown {
        if (++nodes > 100_000 || depth > 64) throw Error("INVALID_REHEARSAL_INPUT");
        if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)) return v;
        if (!v || typeof v !== "object" || seen.has(v)) throw Error("INVALID_REHEARSAL_INPUT");
        const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
        if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) throw Error("INVALID_REHEARSAL_INPUT");
        const descriptors = Object.getOwnPropertyDescriptors(v);
        if (Reflect.ownKeys(v).some(k => typeof k !== "string")) throw Error("INVALID_REHEARSAL_INPUT");
        seen.add(v);
        const result: Record<string, unknown> | unknown[] = array ? [] : {};
        for (const [k, d] of Object.entries(descriptors)) {
            if (array && k === "length") continue;
            if (!("value" in d) || !d.enumerable || ["__proto__", "constructor", "prototype"].includes(k)) throw Error("INVALID_REHEARSAL_INPUT");
            if (d.value === undefined && !array) continue;
            if (array && !/^(0|[1-9]\d*)$/.test(k)) throw Error("INVALID_REHEARSAL_INPUT");
            (result as Record<string, unknown>)[k] = copy(d.value, depth + 1);
        }
        if (array && (Object.keys(result).length !== descriptors.length.value || (result as unknown[]).length !== descriptors.length.value))
            throw Error("INVALID_REHEARSAL_INPUT");
        seen.delete(v); return result;
    }
    return copy(value, 0) as T;
}

function emptyOwnership(read: OwnershipRead, site: string) {
    if (read.status === "missing") return Object.keys(read).join() === "status";
    if (read.status !== "available") return false;
    const s = read.snapshot;
    return s.version === 2 && /^[a-f0-9-]{36}$/.test(s.generation) && /^[a-f0-9]{64}$/.test(s.historyDigest)
        && validOwnership(s.evidence) && s.evidence.energySiteId === site && s.evidence.intervals.length === 0
        && s.checksum === key({ generation: s.generation, evidence: s.evidence });
}

export type RehearsalInput = {
    mode: "offline-rehearsal";
    attemptId: string;
    evidence: SmartDesiredStateInput;
    ownership: OwnershipRead;
};

/** All caller evidence is fixture evidence. Do not expose this as a live command. */
export function prepareSmartLifecycleRehearsal(raw: RehearsalInput) {
    const input = journalInput(raw);
    if (input.mode !== "offline-rehearsal" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId))
        throw Error("OFFLINE_REHEARSAL_REQUIRED");
    const { current, restorationBaseline } = input.evidence;
    if (!emptyOwnership(input.ownership, current.energySiteId) || current.managedImport)
        throw Error("OWNERSHIP_UNRESOLVED");
    const before = validateTeslaInspectionEvidence(current.observation);
    if (!before || representationKey(before.tariff) !== representationKey(restorationBaseline.tariff))
        throw Error("BASELINE_MISMATCH");
    // The inspection boundary rejects incomplete schedules and configured-price
    // fallback before the desired-state kernel can be used.
    const inspection = inspectSmartTariff({ site: current.site, kraken: current.kraken,
        observation: before, now: current.now });
    if (!inspection.payload) throw Error("VERIFIED_SMART_INSPECTION_REQUIRED");
    const desired = deriveSmartTariffDesiredState(input.evidence);
    if (desired.status !== "desired-state-ready" || desired.action !== "apply"
        || !("reconciliation" in desired) || !desired.reconciliation.proposal
        || !desired.desiredTariff || !desired.restorationCandidate) throw Error("APPLY_PROPOSAL_REQUIRED");
    // Rebuild with absent optional fields omitted BEFORE approval/fingerprinting;
    // JSON persistence must not change the approved proposal's identity.
    const proposal = createTariffProposal(journalInput(desired.reconciliation.proposal.input));
    if (representationKey(proposal.bound.representation) !== representationKey(desired.desiredTariff)
        || representationKey(desired.desiredTariff.sell_tariff) !== representationKey(before.tariff!.sell_tariff))
        throw Error("PAYLOAD_BINDING_INVALID");
    const bound = { phase: "apply" as const, attemptId: input.attemptId, energySiteId: current.energySiteId,
        timeZone: before.source.timeZone!, before, baseline: structuredClone(restorationBaseline),
        payloadJson: payload(desired.desiredTariff), proposal, ownership: input.ownership,
        scheduleKey: smartEvidenceKey(current.kraken), preparedAt: current.now,
        expiresAt: proposal.bound.expiresAt, input,
        // Missing authenticated export MPAN provenance remains an explicit LIVE
        // blocker. Rehearsal consent never waives production policy.
        productionBlockers: [...new Set([...desired.reconciliation.blockers,
            "OFFLINE_REHEARSAL_ONLY", "TRUSTED_LIFECYCLE_ADAPTER_REQUIRED", "AUTHENTICATED_EXPORT_MPAN_REQUIRED"])].sort(),
    };
    return freeze({ ...bound, fingerprint: key(bound), ...safety });
}
export type ApplyReview = ReturnType<typeof prepareSmartLifecycleRehearsal>;
export type RehearsalApproval = {
    fingerprint: string; baselineKey: string; payloadKey: string; approvedAt: string;
    acknowledgedBlockers: string[]; manualRecoveryAcknowledged: true;
};
export type RestoreReview = {
    phase: "restore"; attemptId: string; energySiteId: string; timeZone: string;
    before: ObservedTariff; baseline: ObservedTariff; payloadJson: string;
    preparedAt: string; expiresAt: string; applyResultKey: string;
    input: SmartDesiredStateInput; ownership: OwnershipRead;
    scheduleKey: string; desiredStateKey: string;
    productionBlockers: string[]; fingerprint: string;
} & typeof safety;
export type LifecycleReview = ApplyReview | RestoreReview;

function approve(review: LifecycleReview, approval: RehearsalApproval, now: string) {
    if (!fresh(approval.approvedAt, now, APPROVAL_TTL_MS) || Date.parse(approval.approvedAt) < Date.parse(review.preparedAt)
        || Date.parse(now) + MIN_WRITE_REMAINING_MS >= Date.parse(review.expiresAt)
        || approval.fingerprint !== review.fingerprint || approval.baselineKey !== key(review.before.tariff)
        || approval.payloadKey !== key(review.payloadJson) || approval.manualRecoveryAcknowledged !== true
        || representationKey([...new Set(approval.acknowledgedBlockers)].sort()) !== representationKey(review.productionBlockers))
        throw Error("EXACT_REHEARSAL_APPROVAL_REQUIRED");
    if (review.phase === "apply") approveTariffProposal(review.proposal, {
        fingerprint: review.proposal.fingerprint, approvedAt: approval.approvedAt });
}

export type AttemptResult = {
    attemptedAt: string; completedAt: string; apiWrite: WriteResult;
    readBack: ObservedTariff | null;
    classification: ReturnType<typeof classifyExperimentResult>;
} & typeof safety;

function classify(review: LifecycleReview, result: Omit<AttemptResult, "classification">): AttemptResult["classification"] {
    const read = validateTeslaInspectionEvidence(result.readBack);
    const validRead = read && validOwnershipTimestamp(result.attemptedAt) && validOwnershipTimestamp(result.completedAt)
        && Date.parse(result.attemptedAt) < Date.parse(read.source.observedAt)
        && Date.parse(read.source.observedAt) <= Date.parse(result.completedAt) ? read : null;
    const intended = { ...review.before, tariff: JSON.parse(review.payloadJson).tou_settings.tariff_content_v2 };
    const comparison = compareObservedTariffReadBack({ intended, readBack: validRead,
        after: result.attemptedAt, dates: [new Intl.DateTimeFormat("en-CA", { timeZone: review.timeZone,
            year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(result.attemptedAt))] });
    return classifyExperimentResult(result.apiWrite, intended, validRead, comparison);
}

export type LifecycleRecords = {
    schema: "smart-offline-lifecycle-v1"; review: ApplyReview; approval: RehearsalApproval;
    apply?: AttemptResult; restoreReview?: RestoreReview; restoreApproval?: RehearsalApproval; restore?: AttemptResult;
};

/** Structural journal validation, not authentication or a B2 capability. */
export function validSmartRehearsalRecords(records: LifecycleRecords) {
    try {
        if (records.schema !== "smart-offline-lifecycle-v1"
            || representationKey(prepareSmartLifecycleRehearsal(records.review.input)) !== representationKey(records.review)) return false;
        approve(records.review, records.approval, records.approval.approvedAt);
        for (const [review, result] of [[records.review, records.apply], [records.restoreReview, records.restore]] as const) {
            if (!result) continue;
            if (!review || !validOwnershipTimestamp(result.attemptedAt) || !validOwnershipTimestamp(result.completedAt)
                || Object.entries(safety).some(([k, v]) => result[k as keyof AttemptResult] !== v)
                || Date.parse(result.completedAt) < Date.parse(result.attemptedAt)
                || result.apiWrite.status === "accepted" && (!Number.isInteger(result.apiWrite.httpStatus)
                    || result.apiWrite.httpStatus! < 200 || result.apiWrite.httpStatus! > 299)
                || !["accepted", "rejected", "unknown"].includes(result.apiWrite.status)
                || result.classification !== classify(review, result)) return false;
            approve(review, review.phase === "apply" ? records.approval : records.restoreApproval!, result.attemptedAt);
        }
        if (records.restoreReview) {
            if (!records.apply || records.apply.classification !== "submitted-representation-preserved" || !records.restoreApproval) return false;
            const rebuilt = prepareSmartRestorationRehearsal(records, {
                evidence: records.restoreReview.input, ownership: records.restoreReview.ownership,
            }, records.restoreReview.preparedAt);
            if (representationKey(rebuilt) !== representationKey(records.restoreReview)) return false;
            approve(rebuilt, records.restoreApproval, records.restoreApproval.approvedAt);
        } else if (records.restore || records.restoreApproval) return false;
        return true;
    } catch { return false; }
}

export function prepareSmartRestorationRehearsal(records: LifecycleRecords,
    raw: { evidence: SmartDesiredStateInput; ownership: OwnershipRead }, now: string): RestoreReview {
    if (records.apply?.classification !== "submitted-representation-preserved" || !records.apply.readBack
        || records.apply.classification !== classify(records.review, records.apply)) throw Error("MANUAL_INTERVENTION_REQUIRED");
    const captured = journalInput(raw);
    if (key(captured.ownership) !== key(records.review.ownership)) throw Error("OWNERSHIP_UNRESOLVED");
    const input = captured.evidence, before = validateTeslaInspectionEvidence(input.current.observation);
    if (!before || !fresh(before.source.observedAt, now, CAPTURE_TTL_MS)
        || Date.parse(now) < Date.parse(records.apply.completedAt)
        || before.source.energySiteId !== records.review.energySiteId || before.source.timeZone !== records.review.timeZone
        || key(before.tariff) !== key(records.apply.readBack.tariff)
        || payload(before.tariff) !== records.review.payloadJson) throw Error("CURRENT_TARIFF_OWNERSHIP_CONFLICT");
    const rehearsalOwnership = deriveReplacementOwnership({ proposal: records.review.proposal,
        before: records.review.before, readback: records.apply.readBack,
        writeOutcome: "submitted-representation-preserved", submittedAt: records.apply.attemptedAt,
        recordedAt: records.apply.completedAt, expectedGeneration: null }, null);
    input.current = { ...input.current, now, observation: before, managedImport: rehearsalOwnership };
    input.restorationBaseline = structuredClone(records.review.baseline);
    const desired = deriveSmartTariffDesiredState(input);
    if (desired.status === "in-sync") throw Error("RESTORATION_NOT_REQUIRED");
    if (desired.status === "desired-state-ready" && (desired.action === "apply" || desired.action === "update"))
        throw Error("SMART_TARIFF_UPDATE_REQUIRED");
    if (desired.diagnostic === "RESTORATION_SCHEDULE_COVERAGE_INCOMPLETE"
        || desired.diagnostic === "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE") throw Error(desired.diagnostic);
    if (desired.status !== "desired-state-ready" || desired.action !== "restore" || !desired.desiredTariff
        || key(desired.desiredTariff) !== key(records.review.baseline.tariff)) throw Error("RESTORATION_EVIDENCE_UNAVAILABLE");
    const scheduleKey = smartEvidenceKey(input.current.kraken);
    const desiredStateKey = key({ action: desired.action, desiredFingerprint: desired.desiredFingerprint,
        restorationFingerprint: desired.restorationFingerprint, scheduleKey });
    const bound = { phase: "restore" as const, attemptId: records.review.attemptId, energySiteId: records.review.energySiteId,
        timeZone: records.review.timeZone, before, baseline: structuredClone(records.review.baseline),
        payloadJson: payload(records.review.baseline.tariff), preparedAt: now,
        expiresAt: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(),
        applyResultKey: key(records.apply), input, ownership: captured.ownership, scheduleKey, desiredStateKey,
        productionBlockers: records.review.productionBlockers };
    return freeze({ ...bound, fingerprint: key(bound), ...safety });
}

export type RehearsalPorts = {
    now(): string;
    capture(): Promise<{ evidence: SmartDesiredStateInput; ownership: OwnershipRead }>;
    confirm(review: LifecycleReview): Promise<RehearsalApproval>;
    /** Synthetic transport only. Never supply a provider client. */
    simulatePost(site: string, exactPayload: string): Promise<WriteResult>;
    readBack(): Promise<ObservedTariff>;
    claim(review: ApplyReview, approval: RehearsalApproval): Promise<{ finish(result: AttemptResult): Promise<void> }>;
    claimRestore(review: RestoreReview, approval: RehearsalApproval): Promise<{ finish(result: AttemptResult): Promise<void> }>;
};

async function attempt(review: LifecycleReview, approval: RehearsalApproval, ports: RehearsalPorts,
    claim: () => Promise<{ finish(result: AttemptResult): Promise<void> }>) {
    const journal = await claim(); // durable exact approval and baseline BEFORE simulation
    const attemptedAt = ports.now();
    approve(review, approval, attemptedAt);
    if (!fresh(review.before.source.observedAt, attemptedAt, CAPTURE_TTL_MS)) throw Error("STALE_TESLA_CAPTURE");
    let apiWrite: WriteResult = { status: "unknown", httpStatus: null };
    try {
        const response = await ports.simulatePost(review.energySiteId, review.payloadJson);
        if (["accepted", "rejected", "unknown"].includes(response.status)
            && (response.httpStatus === null || Number.isInteger(response.httpStatus))
            && (response.status !== "accepted" || response.httpStatus !== null && response.httpStatus >= 200 && response.httpStatus < 300))
            apiWrite = { status: response.status, httpStatus: response.httpStatus };
    } catch { /* Outcome unknown: never resend, even if a later GET matches. */ }
    let readBack: ObservedTariff | null = null;
    try { readBack = validateTeslaInspectionEvidence(await ports.readBack()); } catch { /* Classified below. */ }
    let completedAt = "";
    try { completedAt = ports.now(); } catch { /* Do not erase a completed simulated attempt. */ }
    const body = { attemptedAt, completedAt, apiWrite, readBack, ...safety };
    const result = freeze<AttemptResult>({ ...body, classification: classify(review, body) });
    try { await journal.finish(result); }
    catch { return { ...safety, status: "manual-intervention-required" as const, result,
        journalStatus: "indeterminate" as const, restorationObligation: true }; }
    return { ...safety, status: result.classification === "submitted-representation-preserved"
        ? "simulated-confirmed" as const : "manual-intervention-required" as const, result,
        journalStatus: "recorded" as const, restorationObligation: review.phase !== "restore"
            || result.classification !== "submitted-representation-preserved" };
}

export async function rehearseSmartApply(attemptId: string, ports: RehearsalPorts) {
    const first = structuredClone(await ports.capture());
    const review = prepareSmartLifecycleRehearsal({ mode: "offline-rehearsal", attemptId, ...first });
    const approval = structuredClone(await ports.confirm(structuredClone(review)));
    approve(review, approval, ports.now());
    const current = structuredClone(await ports.capture());
    current.evidence.current.now = ports.now();
    const rechecked = prepareSmartLifecycleRehearsal({ mode: "offline-rehearsal", attemptId, ...current });
    if (review.payloadJson !== rechecked.payloadJson || key(review.before.tariff) !== key(rechecked.before.tariff)
        || key(review.ownership) !== key(rechecked.ownership) || review.scheduleKey !== rechecked.scheduleKey
        || review.proposal.bound.economicKey !== rechecked.proposal.bound.economicKey
        || review.input.evidence.current.kraken.importTariff?.accountRef !== rechecked.input.evidence.current.kraken.importTariff?.accountRef
        || review.input.evidence.current.kraken.exportTariff?.accountRef !== rechecked.input.evidence.current.kraken.exportTariff?.accountRef
        || key(review.input.evidence.current.site) !== key(rechecked.input.evidence.current.site)) throw Error("PREWRITE_EVIDENCE_CHANGED");
    // Report genuine policy blockers; do not fabricate trusted rollback evidence,
    // historical closure or account provisioning to make rehearsal look eligible.
    const policy = assessFreshBaselineEligibility({ energySiteId: review.energySiteId, timeZone: review.timeZone,
        assessedAt: ports.now(), maxObservationAgeMs: CAPTURE_TTL_MS,
        current: { source: { ...review.before.source, kind: "tesla-site-info" }, tariff: review.before, operatingMode: null, diagnostics: [] },
        ownership: review.ownership, proposal: review.proposal,
        approval: { fingerprint: review.proposal.fingerprint, approvedAt: approval.approvedAt,
            baselineIdentity: representationKey({ source: review.before.source, tariff: review.before.tariff }) },
        rollback: { representation: review.baseline.tariff, maxAgeMs: CAPTURE_TTL_MS },
        trustedRollbackObservations: [], historical: null, nextAttempt: null });
    return { ...await attempt(review, approval, ports, () => ports.claim(review, approval)), policy };
}

export async function rehearseSmartRestore(raw: LifecycleRecords, ports: RehearsalPorts) {
    const records = structuredClone(raw);
    if (!validSmartRehearsalRecords(records) || records.restoreReview) throw Error("RESTORATION_NOT_AVAILABLE");
    const capture = structuredClone(await ports.capture());
    const review = prepareSmartRestorationRehearsal(records, capture, ports.now());
    const approval = structuredClone(await ports.confirm(structuredClone(review)));
    approve(review, approval, ports.now());
    const freshCapture = structuredClone(await ports.capture());
    const checked = prepareSmartRestorationRehearsal(records, freshCapture, ports.now());
    if (key(checked.before.tariff) !== key(review.before.tariff) || checked.payloadJson !== review.payloadJson
        || checked.scheduleKey !== review.scheduleKey || checked.desiredStateKey !== review.desiredStateKey)
        throw Error("PREWRITE_EVIDENCE_CHANGED");
    return attempt(review, approval, ports, () => ports.claimRestore(review, approval));
}
