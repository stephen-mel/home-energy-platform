import type { EnergyPrice, PriceInputWindow, PriceSource, PriceWindow } from "./types";

export function validPrice(price: EnergyPrice | null | undefined): EnergyPrice | null {
    return price && Number.isFinite(price.amount) && /^[A-Z]{3}$/.test(price.currency) && price.unit === "kWh"
        ? { amount: price.amount, currency: price.currency, unit: "kWh" } : null;
}

// Require an explicit timezone so the server's local zone cannot shift a tariff.
export function instant(value: string): number {
    return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

function uniqueSources(sources: PriceSource[]): PriceSource[] {
    return [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
}

// Produces a complete, ordered, non-overlapping half-open [start, end) curve.
// Guaranteed off-peak windows take precedence over conditional opportunities;
// opportunities otherwise override the standard baseline. Neither implies billing verification.
// Conflicting prices in the same layer become unknown instead of picking a winner.
export function buildPriceCurve(
    horizon: { start: string; end: string },
    baseline: EnergyPrice | null,
    windows: PriceInputWindow[],
): PriceWindow[] {
    const start = instant(horizon.start), end = instant(horizon.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const inputs = windows.flatMap(window => {
        const from = instant(window.start), to = instant(window.end);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to <= start || from >= end) return [];
        return [{ ...window, price: validPrice(window.price), from: Math.max(start, from), to: Math.min(end, to) }];
    });
    // Add assessment boundaries without changing the grouped price union. UTC
    // instants keep half-hours distinct across local clock/DST changes.
    const assessmentPoints = inputs.flatMap(w => {
        const step = (w.eligibility?.intervalMinutes ?? 0) * 60_000;
        if (!Number.isFinite(step) || step < 60_000) return [];
        const points: number[] = [];
        for (let point = (Math.floor(w.from / step) + 1) * step; point < w.to; point += step) points.push(point);
        return points;
    });
    const points = [...new Set([start, end, ...inputs.flatMap(w => [w.from, w.to]), ...assessmentPoints])].sort((a, b) => a - b);
    const result: PriceWindow[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const from = points[i], to = points[i + 1];
        const active = inputs.filter(w => w.from <= from && w.to >= to);
        const opportunities = active.filter(w => w.kind === "cheap-opportunity");
        const guaranteed = active.filter(w => w.kind === "guaranteed-off-peak");
        const selected = guaranteed.length ? guaranteed : opportunities.length ? opportunities : active;
        const prices = selected.length ? selected.map(w => w.price) : [validPrice(baseline)];
        const conflicting = new Set(prices.map(price => JSON.stringify(price))).size > 1;
        const price = conflicting ? null : prices[0];
        const sources = selected.length ? uniqueSources(selected.flatMap(w => w.sources)) : [{
            provider: "site-config", description: price ? "Configured tariff" : "Price not configured",
            observedAt: null, stale: false,
        }];
        const window: PriceWindow = {
            start: new Date(from).toISOString(), end: new Date(to).toISOString(), price,
            priceStatus: conflicting ? "conflicting" : price === null ? "unknown" : "known",
            kind: guaranteed.length ? "guaranteed-off-peak" : opportunities.length ? "cheap-opportunity" : "standard",
            condition: selected.some(w => w.condition === "scheduled-ev-charging") ? "scheduled-ev-charging" : "none",
            stale: sources.some(source => source.stale), sources,
            eligibilityPeriods: selected.flatMap(input => {
                const step = (input.eligibility?.intervalMinutes ?? 0) * 60_000;
                if (!input.eligibility || !Number.isFinite(step) || step < 60_000) return [];
                const assessmentStart = Math.floor(from / step) * step;
                return [{
                    start: new Date(from).toISOString(), end: new Date(to).toISOString(),
                    assessmentPeriod: {
                        start: new Date(assessmentStart).toISOString(),
                        end: new Date(assessmentStart + step).toISOString(),
                    },
                    state: input.eligibility.state, sources: input.sources,
                }];
            }),
        };
        const previous = result.at(-1);
        if (previous && previous.kind === window.kind && previous.condition === window.condition &&
            previous.stale === window.stale && previous.priceStatus === window.priceStatus &&
            JSON.stringify(previous.price) === JSON.stringify(window.price)) {
            previous.end = window.end;
            previous.eligibilityPeriods.push(...window.eligibilityPeriods);
            previous.sources = uniqueSources([...previous.sources, ...window.sources]);
        } else result.push(window);
    }
    return result;
}
