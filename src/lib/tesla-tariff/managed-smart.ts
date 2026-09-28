import type { PriceSignal, PriceWindow } from "../tariff/types";
import type { ObservedTariff } from "./observed-tariff";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { monetarySignal, observedEconomicSignal } from "./observed-economic";
import { assertOwnership, type ManagedImportEvidence } from "./ownership-evidence";
export type { ManagedImportEvidence } from "./ownership-evidence";
import { representationKey } from "./rollback-evidence";

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
    if (scope.previous) assertOwnership(scope.previous, observed, hep.generatedAt);
    const owned = scope.previous?.intervals ?? [];
    const points = [...new Set([...[current, base, seen].flatMap(s => s.import.flatMap(w => [w.start, w.end])),
        ...owned.flatMap(p => [p.start,p.end]).filter(t => Date.parse(t) > Date.parse(domain.start) && Date.parse(t) < Date.parse(domain.end))]
        .map(t => new Date(Date.parse(t)).toISOString()))].sort((a,b) => Date.parse(a) - Date.parse(b));
    const at = (s: PriceSignal, time: string) => s.import.find(w => Date.parse(w.start) <= Date.parse(time) && Date.parse(w.end) > Date.parse(time))!;
    const target: PriceSignal = { ...seen, import: [], export: seen.export };
    const ownership: Array<{ start: string; end: string; basis: "current-smart" | "previously-managed-smart" | "unmanaged" }> = [];
    for (let i=0; i<points.length-1; i++) {
        const start = points[i], end = points[i+1], desired = at(current,start), observedWindow = at(seen,start);
        let selected = observedWindow, basis: typeof ownership[number]["basis"] = "unmanaged";
        if (smart(desired) && !equal(desired, at(base,start))) {
            selected = desired; basis = "current-smart";
        } else {
            const previous = owned.find(p => Date.parse(p.start) <= Date.parse(start) && Date.parse(p.end) >= Date.parse(end));
            if (previous) {
                selected = { ...observedWindow, price: previous.restore, priceStatus: "known" };
                basis = "previously-managed-smart";
            }
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
