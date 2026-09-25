import type { PriceSignal, PriceWindow } from "../tariff/types";
import { analyseObservedDates, type ObservedTariff } from "./observed-tariff";

// Tesla cannot encode HEP eligibility. This comparison-only projection strips
// those annotations, never mutating HEP truth or upgrading its evidence.
export function monetarySignal(signal: PriceSignal): PriceSignal {
    const project = (windows: PriceWindow[]): PriceWindow[] => windows.map(w => ({ ...w,
        kind: "standard", condition: "none", eligibilityPeriods: [] }));
    return { ...signal, import: project(signal.import), export: project(signal.export) };
}

export function observedEconomicSignal(observation: ObservedTariff, domain: { start: string; end: string }) {
    const start = Date.parse(domain.start), end = Date.parse(domain.end);
    if (![start, end].every(Number.isFinite) || end <= start || end - start > 7 * 86400000 || !observation.source.timeZone)
        throw new Error("INVALID_OBSERVED_DOMAIN");
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: observation.source.timeZone,
        year: "numeric", month: "2-digit", day: "2-digit" });
    const date = (t: number) => {
        const parts = formatter.formatToParts(t), p = (name: string) => parts.find(v => v.type === name)!.value;
        return `${p("year")}-${p("month")}-${p("day")}`;
    };
    const dates = new Set([date(start), date(end - 1)]);
    // Enumerate local dates by UTC samples, not by adding 24 hours to local midnight.
    for (let t = start; t < end; t += 12 * 3600000) dates.add(date(t));
    const analysis = analyseObservedDates(observation, [...dates]);
    const signal: PriceSignal = { scope: "whole-home", generatedAt: observation.source.observedAt, horizon: domain, import: [], export: [] };
    for (const p of analysis.days.flatMap(d => d.periods)) {
        const from = Math.max(start, Date.parse(p.start)), to = Math.min(end, Date.parse(p.end));
        if (from >= to) continue;
        for (const side of ["import", "export"] as const) {
            const amount = side === "import" ? p.buy : p.sell;
            signal[side].push({ start: new Date(from).toISOString(), end: new Date(to).toISOString(),
                price: amount === null ? null : { amount, currency: side === "import" ? p.buyCurrency : p.sellCurrency, unit: "kWh" },
                priceStatus: amount === null ? "unknown" : "known", kind: "standard", condition: "none", eligibilityPeriods: [], stale: false,
                sources: [{ provider: "tesla-observed", description: "Observed Tesla tariff; not HEP truth or billing evidence",
                    observedAt: observation.source.observedAt, stale: false }] });
        }
    }
    return { signal, analysis };
}
