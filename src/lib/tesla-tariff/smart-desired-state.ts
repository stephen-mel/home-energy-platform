import { inspectObservedProposalTariff } from "./experiment-tariff";
import type { ObservedTariff } from "./observed-tariff";
import { representationKey } from "./rollback-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { planSingleSiteSynchronization, type SynchronizationAction } from "./single-site-synchronizer";
import type { ReconciliationInput } from "./reconciliation";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { observedEconomicSignal } from "./observed-economic";

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

function restorationCoverageDiagnostic(input: ReconciliationInput, baseline: ObservedTariff) {
    const now = Date.parse(input.now), domainStart = Date.parse(input.comparisonDomain.start), domainEnd = Date.parse(input.comparisonDomain.end);
    const version = input.kraken.importTariff?.version, rate = version?.scheduledChargingImport;
    if (![now, domainStart, domainEnd].every(Number.isFinite) || !version || !rate
        || typeof rate.amount !== "number" || !Number.isFinite(rate.amount) || rate.amount < 0
        || rate.currency !== "GBP" || rate.unit !== "kWh") return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE";
    const covered = (start: number, end: number) => domainStart <= start && domainEnd >= end;
    for (const interval of input.managedImport?.intervals ?? []) {
        const start = Math.max(now, Date.parse(interval.start)), end = Date.parse(interval.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE";
        if (end > now && !covered(start, end)) return "RESTORATION_SCHEDULE_COVERAGE_INCOMPLETE";
    }
    for (const dispatch of input.kraken.vehicles.flatMap(vehicle => vehicle.plannedDispatches)
        .filter(dispatch => dispatch.type === "SMART" && Date.parse(dispatch.end) > now)) {
        const start = Math.max(now, Date.parse(dispatch.start)), end = Date.parse(dispatch.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE";
        let baselineSignal;
        try { baselineSignal = observedEconomicSignal(baseline, {
            start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        }).signal; } catch { return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE"; }
        let cursor = start, relevant = false;
        for (const window of baselineSignal.import.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
            if (Date.parse(window.start) !== cursor || !window.price || window.priceStatus !== "known")
                return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE";
            cursor = Date.parse(window.end);
            if (representationKey(window.price) !== representationKey(rate)) relevant = true;
        }
        if (cursor !== end) return "RESTORATION_SCHEDULE_COVERAGE_UNAVAILABLE";
        if (relevant && (Date.parse(version.effectiveFrom) > start || Date.parse(version.effectiveTo) < end
            || !covered(start, end))) return "RESTORATION_SCHEDULE_COVERAGE_INCOMPLETE";
    }
    return null;
}

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

    const current = inspectObservedProposalTariff(currentObservation.tariff);
    if (!current.exact || !current.tariff)
        return { ...unavailable("indeterminate", "CURRENT_TARIFF_INVALID"), reconciliation: planned.reconciliation };
    const ownerBoundReplacement = ownership
        && ownershipFingerprint(current.tariff) !== restorationFingerprint;
    if (ownerBoundReplacement) {
        const diagnostic = restorationCoverageDiagnostic(input.current, baselineObservation);
        if (diagnostic) return { ...unavailable("blocked", diagnostic), reconciliation: planned.reconciliation };
    }
    // The reconciler compares only the remaining bounded economic domain. Once
    // an owned exception has elapsed, that domain can be economically unchanged
    // even though Tesla still stores the recurring HEP replacement. Restore the
    // exact retained baseline only when fresh reconciliation proves that no
    // current/future interval remains managed and the complete current
    // representation is still the exact owner-bound HEP readback checked above.
    const elapsedOwnedReplacement = planned.status === "in-sync" && ownerBoundReplacement
        && planned.reconciliation.managed.ownership.every(period => period.basis === "unmanaged");
    if (planned.status === "in-sync" && !elapsedOwnedReplacement) {
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

    const action = elapsedOwnedReplacement ? "restore" : planned.action as SynchronizationAction;
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
