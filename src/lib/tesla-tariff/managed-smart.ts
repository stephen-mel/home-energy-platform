import type { PriceSignal, PriceWindow } from "../tariff/types";
import type { ObservedTariff } from "./observed-tariff";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { monetarySignal, observedEconomicSignal } from "./observed-economic";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { representationKey } from "./rollback-evidence";

// Explicit historical ownership context, not rollback proof. The caller must
// retain the underlying Tesla before-state and the HEP signal actually represented;
// a previous Kraken schedule alone does not establish that Tesla stored it.
export type ManagedImportEvidence = { baseline: ObservedTariff; representedSignal: PriceSignal };
export type ManagedSmartScope = { baseSignal: PriceSignal; previous?: ManagedImportEvidence };
const equal = (a: PriceWindow, b: PriceWindow) => representationKey(a.price) === representationKey(b.price);
const smart = (w: PriceWindow) => w.kind === "cheap-opportunity" && w.condition === "scheduled-ev-charging";

/** Preserve all observed economics except attributable SMART import increments.
 * No tolerances, price-label inference, baseline guessing or export replacement.
 */
export function managedSmartTarget(hep: PriceSignal, observed: ObservedTariff,
    domain: { start: string; end: string }, scope: ManagedSmartScope) {
    const project = (signal: PriceSignal) => {
        const checked = comparePriceSignalsInDomain(signal, signal, domain);
        if (checked.status === "indeterminate") throw new Error("MANAGED_SCOPE_COVERAGE_UNAVAILABLE");
        return checked.projected.current;
    };
    const current = project(hep), base = project(scope.baseSignal);
    const seen = project(observedEconomicSignal(observed, domain).signal);
    let old: PriceSignal | null = null, original: PriceSignal | null = null;
    if (scope.previous) {
        const before = scope.previous.baseline;
        if (before.source.kind !== "tesla-site-info" || before.source.energySiteId !== observed.source.energySiteId
            || before.source.timeZone !== observed.source.timeZone || !Number.isFinite(Date.parse(before.source.observedAt))
            || Date.parse(before.source.observedAt) > Date.parse(observed.source.observedAt)
            || before.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED") || !inspectObservedProposalTariff(before.tariff).exact) throw new Error("MANAGED_BASELINE_INVALID");
        old = project(scope.previous.representedSignal);
        original = project(observedEconomicSignal(before, domain).signal);
    }
    const points = [...new Set([current, base, seen, old, original].flatMap(s => s ? s.import.flatMap(w => [w.start, w.end]) : []))]
        .sort((a,b) => Date.parse(a) - Date.parse(b));
    const at = (s: PriceSignal, time: string) => s.import.find(w => Date.parse(w.start) <= Date.parse(time) && Date.parse(w.end) > Date.parse(time))!;
    const target: PriceSignal = { ...seen, import: [], export: seen.export };
    const ownership: Array<{ start: string; end: string; basis: "current-smart" | "previously-managed-smart" | "unmanaged" }> = [];
    for (let i=0; i<points.length-1; i++) {
        const start = points[i], end = points[i+1], desired = at(current,start), observedWindow = at(seen,start);
        let selected = observedWindow, basis: typeof ownership[number]["basis"] = "unmanaged";
        if (smart(desired) && !equal(desired, at(base,start))) {
            selected = desired; basis = "current-smart";
        } else if (old && original && smart(at(old,start)) && !equal(at(old,start), at(original,start))) {
            // Do not overwrite an intervening unrelated change. Already-restored
            // baseline is harmless; any third price requires a new review.
            if (!equal(observedWindow, at(old,start)) && !equal(observedWindow, at(original,start)))
                throw new Error("MANAGED_IMPORT_OWNERSHIP_CONFLICT");
            selected = at(original,start); basis = "previously-managed-smart";
        }
        target.import.push({ ...selected, start, end, eligibilityPeriods: selected.eligibilityPeriods
            .filter(p => Date.parse(p.start) < Date.parse(end) && Date.parse(p.end) > Date.parse(start))
            .map(p => ({ ...p, start: new Date(Math.max(Date.parse(start), Date.parse(p.start))).toISOString(),
                end: new Date(Math.min(Date.parse(end), Date.parse(p.end))).toISOString() })) });
        ownership.push({ start, end, basis });
    }
    // Exact residual differences between the managed target and HEP truth are
    // precisely those this owner preserves instead of correcting.
    return { target, ownership, unmanaged: comparePriceSignalsInDomain(monetarySignal(target), monetarySignal(current), domain) };
}
