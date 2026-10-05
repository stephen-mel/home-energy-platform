import { createTariffProposal, approveTariffProposal, type Proposal, type ProposalApproval } from "./proposal-approval";
import type { ObservedTariff } from "./observed-tariff";
import { compareObservedTariffReadBack } from "./restoration-review";
import { representationKey } from "./rollback-evidence";
import { CAPTURE_TTL_MS, APPROVAL_TTL_MS, type WriteResult } from "./supervised-experiment";
import { validOwnership, validOwnershipTimestamp, type ManagedImportEvidence } from "./ownership-evidence";
import { deriveOwnershipTransition, ownershipFingerprint } from "./ownership-transition";

/** Frozen confirmation evidence, not standalone persistence authority.
 * The trusted issuer derives these projection keys from B2-bound records; the
 * keys alone do not prove Tesla origin. Never accept this from a browser.
 * Generation/evidence must be captured during preparation, not after execution.
 */
export type ConfirmedSmartReceipt = {
    version: 1; mutationId: string;
    original: {
        proposal: Proposal; payloadJson: string; approval: ProposalApproval;
        prior: { capturedAt: string; generation: string | null; evidence: ManagedImportEvidence | null };
    };
    execution: {
        submittedAt: string; completedAt: string; apiWrite: WriteResult;
        readback: ObservedTariff; classification: "submitted-representation-preserved";
    };
    journal: { originalKey: string; classifiedKey: string; completedAt: string };
};

function freeze<T>(value: T): T {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

/** Canonical pure confirmation checks shared by issuer and finaliser.
 * Content validation is not runtime authority and performs no ownership derivation. */
export function validateConfirmedSmartReceipt(supplied: ConfirmedSmartReceipt) {
    const reject = (code: string) => freeze({ status: "rejected" as const, code, writeReady: false as const, rollbackProven: false as const });
    try {
        const receipt = freeze(structuredClone(supplied)), { original, execution, journal } = receipt;
        const { proposal, prior, approval } = original, smart = proposal.input.observedSmart;
        if (receipt.version !== 1 || typeof receipt.mutationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.mutationId) || !smart || proposal.input.observedReplacement
            || !proposal.structurallyValid || proposal.compatibilityBlockers.includes("STALE_EVIDENCE") || representationKey(createTariffProposal(proposal.input)) !== representationKey(proposal)
            || original.payloadJson !== representationKey({ tou_settings: { tariff_content_v2: proposal.bound.representation } })
            || journal.originalKey !== ownershipFingerprint({ mutationId: receipt.mutationId, original })
            || journal.classifiedKey !== ownershipFingerprint({ mutationId: receipt.mutationId, execution })) return reject("INVALID_CONFIRMATION_BINDING");
        const before = smart.observation, after = execution.readback;
        const timestamps = [prior.capturedAt, smart.generatedAt, before.source.observedAt, approval.approvedAt,
            execution.submittedAt, execution.completedAt, after.source.observedAt, journal.completedAt,
            proposal.bound.validFrom, proposal.bound.expiresAt, smart.dispatch.start, smart.dispatch.end,
            smart.comparisonDomain.start, smart.comparisonDomain.end];
        if (!timestamps.every(validOwnershipTimestamp)) return reject("INVALID_CONFIRMATION_TIME");
        const submitted = Date.parse(execution.submittedAt), completed = Date.parse(execution.completedAt);
        if (Date.parse(prior.capturedAt) > Date.parse(smart.generatedAt)
            || Date.parse(smart.generatedAt) > Date.parse(approval.approvedAt)
            || Date.parse(approval.approvedAt) > submitted || submitted - Date.parse(approval.approvedAt) > APPROVAL_TTL_MS
            || submitted < Date.parse(proposal.bound.validFrom) || submitted >= Date.parse(proposal.bound.expiresAt)
            || submitted < Date.parse(before.source.observedAt) || submitted - Date.parse(before.source.observedAt) > CAPTURE_TTL_MS
            || completed < Date.parse(after.source.observedAt) || completed - Date.parse(after.source.observedAt) > CAPTURE_TTL_MS
            || Date.parse(journal.completedAt) < completed) return reject("INVALID_CONFIRMATION_TIME");
        approveTariffProposal(proposal, approval); // Validate existing approval; never manufacture a replacement proposal.
        if ((prior.generation === null) !== (prior.evidence === null)
            || prior.generation !== null && !/^[a-f0-9-]{36}$/.test(prior.generation)
            || prior.evidence && (!validOwnership(prior.evidence) || Date.parse(prior.evidence.updatedAt) > Date.parse(prior.capturedAt)))
            return reject("INVALID_PRIOR_OWNERSHIP");
        if (execution.classification !== "submitted-representation-preserved" || execution.apiWrite.status !== "accepted"
            || typeof execution.apiWrite.httpStatus !== "number" || !Number.isFinite(execution.apiWrite.httpStatus)
            || !Number.isInteger(execution.apiWrite.httpStatus) || execution.apiWrite.httpStatus < 200 || execution.apiWrite.httpStatus > 299)
            return reject("MUTATION_NOT_CONFIRMED");
        const intended = { ...before, tariff: proposal.bound.representation! };
        const compared = compareObservedTariffReadBack({ intended, readBack: after, after: execution.submittedAt,
            dates: [proposal.observedPreparation!.localValidity!.date] });
        if (compared.outcome !== "exact-observed-match" || !compared.timelineScope.complete) return reject("READBACK_NOT_EXACT");
        return freeze({ status: "validated" as const, receipt });
    } catch { return reject("INVALID_CONFIRMATION"); }
}

/** Pure confirmation validation above establishes no ownership transition or
 * runtime authority. Only this finaliser derives the bounded import transition. */
export function finaliseConfirmedSmartOwnership(supplied: ConfirmedSmartReceipt) {
    const reject = (code: string) => freeze({ status: "rejected" as const, code, writeReady: false as const, rollbackProven: false as const });
    try {
        const checked = validateConfirmedSmartReceipt(supplied);
        if (checked.status === "rejected") return checked;
        const receipt = checked.receipt, { original, execution } = receipt;
        const { proposal, prior } = original, smart = proposal.input.observedSmart!;
        const before = smart.observation, after = execution.readback;
        const price = proposal.input.signal.import.find(p => Date.parse(p.start) <= Date.parse(smart.dispatch.start)
            && Date.parse(p.end) > Date.parse(smart.dispatch.start))?.price;
        if (!price) return reject("SMART_PRICE_UNAVAILABLE");
        const transition = deriveOwnershipTransition({ before, after, previous: prior.evidence,
            domain: smart.comparisonDomain, authorised: [{ ...smart.dispatch, price }], submittedAt: execution.submittedAt });
        if (transition.status === "rejected") return reject(transition.code);
        // A retained ledger's validity is never renewed by this finalisation.
        const validUntil = new Date(Math.min(Date.parse(smart.comparisonDomain.end),
            prior.evidence ? Date.parse(prior.evidence.validUntil) : Infinity)).toISOString();
        const evidence: ManagedImportEvidence = { version: 1, energySiteId: proposal.bound.energySiteId, timeZone: proposal.bound.timeZone,
            createdAt: prior.evidence?.createdAt ?? execution.completedAt, updatedAt: execution.completedAt, validUntil,
            basis: "confirmed-write-readback", baselineFingerprint: ownershipFingerprint(before.tariff), readbackFingerprint: ownershipFingerprint(after.tariff),
            proposalFingerprint: ownershipFingerprint(proposal.bound), smartEvidenceFingerprint: ownershipFingerprint(proposal.bound.dispatchEvidenceKey),
            intervals: transition.intervals };
        if (!validOwnership(evidence)) return reject("INVALID_RESULTING_OWNERSHIP");
        return freeze({ status: "derived" as const, expectedGeneration: prior.generation, evidence,
            receiptKey: ownershipFingerprint(receipt), mutationId: receipt.mutationId,
            originalProposalFingerprint: proposal.fingerprint, originalPayloadKey: original.payloadJson,
            productionBlockers: [...new Set([...proposal.compatibilityBlockers, "ROLLBACK_UNPROVEN"])], writeReady: false as const, rollbackProven: false as const });
    } catch { return reject("INVALID_CONFIRMATION"); }
}
