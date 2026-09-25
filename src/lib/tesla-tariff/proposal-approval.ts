import type { PriceSignal } from "../tariff/types";
import { effectivePriceCurveKey } from "../tariff/compare-price-signal";
import { dryRunTeslaTariff, type TeslaTariffFragment } from "./dry-run";
import { inspectTariff } from "./experiment-tariff";
import { representationKey, assessRollbackEvidence, type TrustedRollbackObservation } from "./rollback-evidence";
import { prepareObservedSmart, type ObservedSmartInput } from "./observed-proposal";
import { prepareObservedReplacement, type ObservedReplacementInput } from "./observed-replacement";
import type { AuthorityMode } from "./baseline";

export type ProposalInput = {
    proposalId: string; energySiteId: string; purpose: "tariff-sync" | "pricing-constraint-experiment";
    timeZone: string; validFrom: string; expiresAt: string; signal: PriceSignal;
    // An explicit complete experiment representation; never derived by clamping HEP.
    experimentRepresentation?: TeslaTariffFragment;
    exceptions?: Array<"BUY_BELOW_SELL">;
    observedSmart?: ObservedSmartInput;
    observedReplacement?: ObservedReplacementInput;
};
export type Proposal = ReturnType<typeof createTariffProposal>;
export function createTariffProposal(input: ProposalInput) {
    const translation = dryRunTeslaTariff(input.signal, { timeZone: input.timeZone });
    const observed = input.observedSmart ? prepareObservedSmart(input.observedSmart, input.signal, input.energySiteId, input.timeZone) : null;
    const replacement = input.observedReplacement ? prepareObservedReplacement(input.observedReplacement, input.signal, input.energySiteId, input.timeZone) : null;
    const experiment = !observed && !replacement && input.purpose === "pricing-constraint-experiment";
    const inspected = experiment ? inspectTariff(input.experimentRepresentation) : null;
    const representation = observed ? observed.representation : replacement ? replacement.representation : experiment ? inspected?.tariff ?? null : translation.candidate.tariffContentV2Fragment;
    const blockers = translation.diagnostics.filter(d => d.severity === "error").map(d => d.code);
    // A complete, independently validated annual experiment is NOT the bounded
    // forecast fragment. Record this distinction; never waive bounded sync coverage.
    const compatibilityBlockers = experiment && inspected?.exact
        ? blockers.filter(code => !["BOUNDED_FORECAST", "BUY_BELOW_SELL", "INCOMPLETE_LOCAL_DAY", "SUB_MINUTE_BOUNDARY", "DST_FOLD_CONFLICT"].includes(code))
        : [...blockers];
    if (observed) {
        compatibilityBlockers.push(...observed.blockers);
        if (input.purpose !== "tariff-sync") compatibilityBlockers.push("OBSERVED_PRODUCTION_ONLY");
        const generation = Date.parse(input.observedSmart!.generatedAt);
        if (!Number.isFinite(Date.parse(input.validFrom)) || !Number.isFinite(Date.parse(input.expiresAt))
            || Date.parse(input.validFrom) < generation || Date.parse(input.validFrom) >= Date.parse(input.expiresAt)
            || Date.parse(input.expiresAt) > Date.parse(input.observedSmart!.dispatch.end)) compatibilityBlockers.push("INVALID_SMART_VALIDITY");
    }
    if (replacement) {
        compatibilityBlockers.push(...replacement.blockers);
        if (input.purpose !== "tariff-sync" || input.observedSmart) compatibilityBlockers.push("INVALID_REPLACEMENT_PURPOSE");
        const generated = Date.parse(input.observedReplacement!.generatedAt), start = Date.parse(input.validFrom), end = Date.parse(input.expiresAt);
        if (![generated, start, end].every(Number.isFinite) || start < generated || end <= start
            || end > Date.parse(input.observedReplacement!.comparisonDomain.end)) compatibilityBlockers.push("INVALID_REPLACEMENT_VALIDITY");
    }
    if (!representation) compatibilityBlockers.push("REPRESENTATION_UNAVAILABLE");
    if (experiment && inspected?.exact) {
        // Conservative cross-rate test; varying tariffs are not inferred safe.
        const buys = Object.values(representation!.energy_charges).flatMap(c => Object.values(c.rates ?? {}));
        const sells = Object.values(representation!.sell_tariff.energy_charges).flatMap(c => Object.values(c.rates ?? {}));
        if (Math.min(...buys) < Math.max(...sells)) compatibilityBlockers.push("BUY_BELOW_SELL");
    }
    const evidence = input.signal.import.flatMap(w => w.eligibilityPeriods).map(p => ({
        start: p.start, end: p.end, assessmentPeriod: p.assessmentPeriod, state: p.state,
        causes: p.sources.filter(s => s.cause).map(s => ({ ...s.cause })),
    }));
    const bound = { proposalId: input.proposalId, energySiteId: input.energySiteId, purpose: input.purpose,
        timeZone: input.timeZone, validFrom: input.validFrom, expiresAt: input.expiresAt,
        economicKey: effectivePriceCurveKey(input.signal), representation, evidence,
        ...(observed ? { generatedAt: input.observedSmart!.generatedAt, localValidity: observed.localValidity,
            dispatchEvidenceKey: observed.dispatchEvidenceKey, observationKey: representationKey(input.observedSmart!.observation),
            comparisonDomain: input.observedSmart!.comparisonDomain } : {}),
        ...(replacement ? { generatedAt: input.observedReplacement!.generatedAt,
            dispatchEvidenceKey: input.observedReplacement!.dispatchEvidenceKey,
            observationKey: representationKey(input.observedReplacement!.observation),
            comparisonDomain: input.observedReplacement!.comparisonDomain,
            ...(input.observedReplacement!.managedScope ? { managedScopeKey: representationKey(input.observedReplacement!.managedScope) } : {}) } : {}),
        tariffIdentities: [...new Set([...input.signal.import, ...input.signal.export].flatMap(w =>
            w.sources.filter(s => s.tariffVersion).map(s => representationKey({ provider: s.provider, version: s.tariffVersion }))))].sort(),
        exceptions: [...new Set(input.exceptions ?? [])].sort() };
    return { input, bound, fingerprint: representationKey(bound), compatibilityBlockers: [...new Set(compatibilityBlockers)],
        structurallyValid: observed ? observed.structurallyValid && input.purpose === "tariff-sync"
            && !compatibilityBlockers.includes("INVALID_SMART_VALIDITY") && !replacement
            : replacement ? replacement.structurallyValid && !compatibilityBlockers.includes("INVALID_REPLACEMENT_PURPOSE")
                && !compatibilityBlockers.includes("INVALID_REPLACEMENT_VALIDITY") : !!representation,
        observedPreparation: observed,
        ...(replacement ? { replacementPreparation: replacement } : {}),
        sourceDiagnostics: translation.diagnostics, coverageBasis: experiment && inspected?.exact ? "complete-experiment" : "bounded-hep-forecast",
        inspectionOnly: true as const, writeReady: false as const };
}
function consistent(proposal: Proposal) {
    try { return representationKey(proposal) === representationKey(createTariffProposal(proposal.input)); }
    catch { return false; }
}
export type ProposalApproval = { fingerprint: string; approvedAt: string };
export function approveTariffProposal(proposal: Proposal, confirmation: ProposalApproval): ProposalApproval {
    const now = Date.parse(confirmation.approvedAt);
    if (!consistent(proposal) || ((proposal.input.observedSmart || proposal.input.observedReplacement) && !proposal.structurallyValid) || proposal.fingerprint !== confirmation.fingerprint || !Number.isFinite(now)
        || now < Date.parse(proposal.bound.validFrom) || now >= Date.parse(proposal.bound.expiresAt)
        || !Number.isFinite(Date.parse(proposal.bound.validFrom)) || !Number.isFinite(Date.parse(proposal.bound.expiresAt)))
        throw new Error("Exact current proposal and in-validity explicit confirmation required");
    return { fingerprint: confirmation.fingerprint, approvedAt: new Date(now).toISOString() };
}
/** No executor. Trust-ledger and authority inputs must eventually be supplied by
 * server policy, never taken from client submitted approval JSON.
 */
export function assessProposalCurrentUse(input: {
    approvedProposal: Proposal; currentProposal: Proposal; approval: ProposalApproval | null;
    now: string; targetEnergySiteId: string; authority: AuthorityMode;
    rollback: { observationId?: string; representation: unknown; maxAgeMs: number };
}, trustedObservations: readonly TrustedRollbackObservation[] = []) {
    const { approvedProposal: old, currentProposal: current, approval } = input;
    const blockers: string[] = [];
    if (!consistent(old) || !consistent(current)) blockers.push("RECORD_INCONSISTENT");
    if (old.fingerprint !== current.fingerprint) blockers.push("CURRENT_PROPOSAL_CHANGED");
    if (!approval || approval.fingerprint !== current.fingerprint) blockers.push("EXACT_PROPOSAL_APPROVAL_REQUIRED");
    const now = Date.parse(input.now), start = Date.parse(current.bound.validFrom), end = Date.parse(current.bound.expiresAt);
    if (![now, start, end].every(Number.isFinite) || now < start || now >= end || !approval
        || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) < start
        || Date.parse(approval.approvedAt) >= end || Date.parse(approval.approvedAt) > now
        || now < Date.parse(current.input.signal.horizon.start) || now >= Date.parse(current.input.signal.horizon.end)) blockers.push("OUTSIDE_CURRENT_VALIDITY");
    if (current.bound.energySiteId !== input.targetEnergySiteId) blockers.push("TARGET_SITE_MISMATCH");
    if (!["confirm", "automatic"].includes(input.authority)) blockers.push("AUTHORITY_OBSERVE_ONLY");
    const rebuilt = createTariffProposal(current.input);
    const acceptedExceptions = !rebuilt.input.observedSmart && !rebuilt.input.observedReplacement && rebuilt.bound.purpose === "pricing-constraint-experiment" && rebuilt.bound.exceptions.includes("BUY_BELOW_SELL") ? ["BUY_BELOW_SELL"] : [];
    blockers.push(...rebuilt.compatibilityBlockers.filter(code => !acceptedExceptions.includes(code)));
    if ([...current.input.signal.import, ...current.input.signal.export].some(w => w.stale || w.sources.some(s => s.stale))) blockers.push("STALE_EVIDENCE");
    const rollback = assessRollbackEvidence({ ...input.rollback, now: input.now, energySiteId: input.targetEnergySiteId }, trustedObservations);
    blockers.push(...rollback.blockers);
    return { structurallyValid: consistent(current) && rebuilt.structurallyValid,
        humanApproved: consistent(current) && !!approval && approval.fingerprint === current.fingerprint
            && Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) >= start
            && Date.parse(approval.approvedAt) < end && Date.parse(approval.approvedAt) <= now,
        writeCompatible: rebuilt.compatibilityBlockers.length === 0,
        rollbackProven: rollback.proven,
        eligible: blockers.length === 0, blockers: [...new Set(blockers)], acceptedExceptions,
        explicitConfirmationRequired: true as const, writeReady: false as const, executorAvailable: false as const };
}
