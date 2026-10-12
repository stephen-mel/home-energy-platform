import { reconcileTeslaTariff, type ReconciliationInput, type ReconciliationResult } from "./reconciliation";

export type SynchronizationAction = "apply" | "update" | "restore";

export type SingleSiteSynchronization = {
    status: "in-sync" | "proposal-ready" | "blocked" | "indeterminate";
    action: SynchronizationAction | null;
    executionReady: false;
    approvalRequired: boolean;
    diagnostic: string | null;
    reconciliation: ReconciliationResult;
};

/**
 * Pure single-site orchestration over the existing Confirm-mode reconciler.
 *
 * This classifies the next managed SMART lifecycle action. It grants no write
 * authority, performs no I/O and deliberately leaves all production blockers,
 * exact approval and journal-before-write requirements to the trusted executor.
 */
export function planSingleSiteSynchronization(input: ReconciliationInput): SingleSiteSynchronization {
    const reconciliation = reconcileTeslaTariff(input);
    const common = { executionReady: false as const, reconciliation };

    if (reconciliation.status === "indeterminate") return {
        ...common, status: "indeterminate", action: null, approvalRequired: false,
        diagnostic: reconciliation.diagnostic,
    };
    if (reconciliation.status === "blocked") return {
        ...common, status: "blocked", action: null, approvalRequired: false,
        diagnostic: "diagnostic" in reconciliation ? reconciliation.diagnostic : reconciliation.blockers.join(","),
    };
    if (reconciliation.status === "in-sync") return {
        ...common, status: "in-sync", action: null, approvalRequired: false, diagnostic: null,
    };

    const hasCurrentSmart = reconciliation.managed.ownership.some(period => period.basis === "current-smart");
    const hasRelevantPriorOwnership = input.managedImport?.intervals.some(period =>
        Date.parse(period.end) > Date.parse(reconciliation.domain.start)) ?? false;
    const action: SynchronizationAction = hasCurrentSmart
        ? hasRelevantPriorOwnership ? "update" : "apply"
        : "restore";

    return {
        ...common,
        status: "proposal-ready",
        action,
        approvalRequired: true,
        diagnostic: null,
    };
}
