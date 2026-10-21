import { inspectObservedProposalTariff } from "./experiment-tariff";
import type { ObservedTariff } from "./observed-tariff";
import { representationKey } from "./rollback-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { planSingleSiteSynchronization, type SynchronizationAction } from "./single-site-synchronizer";
import type { ReconciliationInput } from "./reconciliation";
import { validateTeslaInspectionEvidence } from "./smart-inspection";

export type SmartDesiredStateInput = {
    current: ReconciliationInput;
    /** Immutable authenticated representation captured before this owner first applies SMART pricing. */
    restorationBaseline: ObservedTariff;
};

const unavailable = (status: "blocked" | "indeterminate", diagnostic: string) => ({
    status,
    action: null,
    diagnostic,
    desiredTariff: null,
    desiredFingerprint: null,
    restorationCandidate: null,
    restorationFingerprint: null,
    requiresExplicitRestoration: true as const,
    recurringSemantics: "month-day-and-weekday-rules-repeat-until-replaced" as const,
    executionReady: false as const,
});

/**
 * Pure desired-state projection for one household site.
 *
 * The existing reconciler remains the evidence, ownership and Tesla-shape trust
 * boundary. This function adds lifecycle meaning: it binds the immutable original
 * representation, exposes the complete replacement, and restores that exact
 * representation once no managed SMART exception remains. It performs no I/O and
 * grants no execution authority.
 */
export function deriveSmartTariffDesiredState(input: SmartDesiredStateInput) {
    // Validate and detach both caller-supplied observations before any recursive
    // canonicalisation or fingerprinting. The shared inspection boundary rejects
    // cycles, accessors, unknown fields and incomplete tariff representations.
    const baselineObservation = validateTeslaInspectionEvidence(input.restorationBaseline);
    if (!baselineObservation?.tariff
        || baselineObservation.source.energySiteId !== input.current.energySiteId
        || baselineObservation.source.timeZone !== input.current.site.tariff?.timeZone)
        return unavailable("indeterminate", "RESTORATION_BASELINE_INVALID");
    const currentObservation = validateTeslaInspectionEvidence(input.current.observation);
    if (!currentObservation?.tariff)
        return unavailable("indeterminate", "CURRENT_TARIFF_INVALID");

    const restoration = structuredClone(baselineObservation.tariff);
    const restorationFingerprint = ownershipFingerprint(restoration);
    const ownership = input.current.managedImport;
    if (ownership && ownership.baselineFingerprint !== restorationFingerprint)
        return unavailable("blocked", "RESTORATION_BASELINE_OWNERSHIP_MISMATCH");
    // Ownership covers the whole representation, not only the managed import
    // intervals. A subsequent Tesla/user/Flatpeak change to export, metadata or
    // any unrelated import period must be reconciled by a fresh baseline rather
    // than overwritten by an old restoration candidate.
    if (ownership && ownership.readbackFingerprint !== ownershipFingerprint(currentObservation.tariff))
        return unavailable("blocked", "CURRENT_TARIFF_OWNERSHIP_CONFLICT");

    const planned = planSingleSiteSynchronization({ ...input.current, observation: currentObservation });
    if (planned.status === "blocked" || planned.status === "indeterminate")
        return { ...unavailable(planned.status, planned.diagnostic ?? "DESIRED_STATE_UNAVAILABLE"), reconciliation: planned.reconciliation };
    if (!("managed" in planned.reconciliation) || !("evidence" in planned.reconciliation))
        return { ...unavailable("indeterminate", "DESIRED_STATE_UNAVAILABLE"), reconciliation: planned.reconciliation };

    if (planned.status === "in-sync") {
        const current = inspectObservedProposalTariff(currentObservation.tariff);
        if (!current.exact || !current.tariff)
            return { ...unavailable("indeterminate", "CURRENT_TARIFF_INVALID"), reconciliation: planned.reconciliation };
        return {
            status: "in-sync" as const,
            action: null,
            diagnostic: null,
            desiredTariff: structuredClone(current.tariff),
            desiredFingerprint: representationKey(current.tariff),
            restorationCandidate: restoration,
            restorationFingerprint,
            managedIntervals: planned.reconciliation.managed.ownership,
            dispatchEvidence: planned.reconciliation.evidence.currentDispatches,
            requiresExplicitRestoration: true as const,
            recurringSemantics: "month-day-and-weekday-rules-repeat-until-replaced" as const,
            executionReady: false as const,
            reconciliation: planned.reconciliation,
        };
    }

    const action = planned.action as SynchronizationAction;
    const proposed = action === "restore" ? restoration : planned.reconciliation.proposal?.bound.representation;
    const inspected = inspectObservedProposalTariff(proposed);
    if (!inspected.exact || !inspected.tariff)
        return { ...unavailable("blocked", "COMPLETE_TESLA_REPRESENTATION_UNAVAILABLE"), reconciliation: planned.reconciliation };

    return {
        status: "desired-state-ready" as const,
        action,
        diagnostic: null,
        desiredTariff: structuredClone(inspected.tariff),
        desiredFingerprint: representationKey(inspected.tariff),
        restorationCandidate: restoration,
        restorationFingerprint,
        managedIntervals: planned.reconciliation.managed.ownership,
        dispatchEvidence: planned.reconciliation.evidence.currentDispatches,
        requiresExplicitRestoration: true as const,
        recurringSemantics: "month-day-and-weekday-rules-repeat-until-replaced" as const,
        executionReady: false as const,
        reconciliation: planned.reconciliation,
    };
}
