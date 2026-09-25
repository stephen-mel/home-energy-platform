import type { PriceSignal } from "../tariff/types";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import type { ObservedTariff } from "./observed-tariff";
import { monetarySignal, observedEconomicSignal } from "./observed-economic";
import { simulateObservedSmartDate } from "./observed-simulation";
import { dryRunTeslaTariff } from "./dry-run";
import { inspectObservedProposalTariff } from "./experiment-tariff";

export type ObservedReplacementInput = {
    observation: ObservedTariff;
    generatedAt: string;
    comparisonDomain: { start: string; end: string };
    dispatchEvidenceKey: string;
};

/** Multi-interval replacement using the existing date-season simulation. No
 * approval/transport path: this is a reconstruction step in the strict proposal.
 * Outside the explicit domain economics stay as observed, not extrapolated HEP.
 */
export function prepareObservedReplacement(input: ObservedReplacementInput, signal: PriceSignal, energySiteId: string, timeZone: string) {
    const blockers = ["BOUNDED_FORECAST", "RESTORATION_REQUIRED", "OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED"];
    const fail = (code: string) => ({ representation: null, structurallyValid: false, blockers: [...new Set([...blockers, code])] });
    try {
        const observation = input.observation;
        const generated = Date.parse(input.generatedAt), captured = Date.parse(observation.source.observedAt);
        if (![generated, captured].every(Number.isFinite) || generated < captured
            || Date.parse(input.comparisonDomain.start) < generated || !input.dispatchEvidenceKey)
            return fail("INVALID_REPLACEMENT_EVIDENCE");
        if (observation.source.kind !== "tesla-site-info" || observation.source.energySiteId !== energySiteId || observation.source.timeZone !== timeZone)
            return fail("OBSERVATION_TARGET_MISMATCH");
        if (!inspectObservedProposalTariff(observation.tariff).exact || observation.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")) return fail("OBSERVATION_INEXACT");
        const check = comparePriceSignalsInDomain(signal, signal, input.comparisonDomain);
        if (check.status === "indeterminate") return fail(check.diagnostic.code);
        const translation = dryRunTeslaTariff(check.projected.current, { timeZone });
        blockers.push(...translation.diagnostics.filter(d => d.severity === "error").map(d => d.code));
        // The existing simulator cannot faithfully encode offset-distinct prices
        // for repeated wall minutes. No rounding or guessed interval is permitted.
        if (translation.diagnostics.some(d => ["SUB_MINUTE_BOUNDARY", "DST_FOLD_CONFLICT", "UNKNOWN_PRICE", "NEGATIVE_PRICE", "UNSUPPORTED_CURRENCY", "MIXED_CURRENCY"].includes(d.code)))
            return fail("REPLACEMENT_UNREPRESENTABLE");
        let current = structuredClone(observation);
        for (const p of translation.candidate.periods) {
            for (const side of ["import", "export"] as const) {
                const price = side === "import" ? p.buy! : p.sell!;
                const represented = observedEconomicSignal(current, { start: p.start, end: p.end }).signal;
                if (represented[side].every(w => w.price?.amount === price.amount && w.price.currency === price.currency)) continue;
                // Same existing simulator for each independent tariff side. Swapping
                // a copy here does not conflate or overwrite the other side's prices.
                const swapped = side === "export" ? { ...current, tariff: { ...current.tariff!.sell_tariff, sell_tariff: current.tariff! } } : current;
                const simulated = simulateObservedSmartDate(swapped, { date: p.localDate, fromMinute: p.fromMinute,
                    toMinute: p.toMinute, buy: price.amount, currency: price.currency, compareDates: [] });
                if (!simulated.simulated) return fail(simulated.blockers[0] ?? "REPRESENTATION_UNAVAILABLE");
                if (side === "import") current = simulated.simulated;
                else {
                    const { sell_tariff: ignored, ...sell } = simulated.simulated.tariff!;
                    void ignored;
                    current = { ...current, source: { ...current.source, kind: "simulation" }, tariff: { ...current.tariff!, sell_tariff: sell } };
                }
            }
        }
        // Repeated DST wall minutes must not change an excluded/past instant.
        // Check both edges of every touched local day using the same comparator.
        const wholeDays = observedEconomicSignal(observation, input.comparisonDomain).analysis.days;
        for (const day of wholeDays) {
            const whole = { start: day.periods[0].start, end: day.periods.at(-1)!.end };
            const before = observedEconomicSignal(observation, whole).signal;
            const after = observedEconomicSignal(current, whole).signal;
            for (const outside of [
                { start: whole.start, end: input.comparisonDomain.start },
                { start: input.comparisonDomain.end, end: whole.end },
            ]) {
                const from = Math.max(Date.parse(whole.start), Date.parse(outside.start));
                const to = Math.min(Date.parse(whole.end), Date.parse(outside.end));
                if (from < to && comparePriceSignalsInDomain(before, after, { start: new Date(from).toISOString(), end: new Date(to).toISOString() }).status !== "unchanged")
                    return fail("OUTSIDE_DOMAIN_CHANGE");
            }
        }
        const inspected = inspectObservedProposalTariff(current.tariff);
        if (!inspected.exact) return fail("REPRESENTATION_UNAVAILABLE");
        const after = observedEconomicSignal(current, input.comparisonDomain).signal;
        const match = comparePriceSignalsInDomain(monetarySignal(check.projected.current), after, input.comparisonDomain);
        if (match.status !== "unchanged") return fail("REPLACEMENT_ECONOMICS_MISMATCH");
        return { representation: inspected.tariff, structurallyValid: true, blockers: [...new Set(blockers)] };
    } catch { return fail("REPLACEMENT_UNAVAILABLE"); }
}
