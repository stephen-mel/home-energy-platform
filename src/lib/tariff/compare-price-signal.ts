import type { PriceSignal, PriceWindow } from "./types";

// Canonical economic/evidence representation for the SAME horizon. Excludes
// generation/snapshot timestamps, freshness, provenance ordering and standing
// charges. Those remain available on the full signal/config, independently.
// This is not a Tesla-specific representation or a hash of presentation metadata.
export function effectivePriceCurveKey(signal: PriceSignal): string {
    const canonical = (curve: PriceWindow[]) => {
        const result: Array<{ start: string; end: string; terms: string }> = [];
        const normalized = curve.map(w => ({ ...w, start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(),
            eligibilityPeriods: w.eligibilityPeriods.map(p => ({ ...p, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() })) }));
        for (const window of normalized.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
            const points = [...new Set([window.start, window.end,
                ...window.eligibilityPeriods.flatMap(p => [p.start, p.end])])].sort();
            for (let i = 0; i < points.length - 1; i++) {
                const start = points[i], end = points[i + 1];
                const states = [...new Set(window.eligibilityPeriods.filter(p => p.start <= start && p.end >= end).map(p => p.state))].sort();
                const terms = JSON.stringify({
                    price: window.price ? { amount: window.price.amount, currency: window.price.currency, unit: window.price.unit } : null,
                    priceStatus: window.priceStatus, kind: window.kind, condition: window.condition, states,
                });
                const previous = result.at(-1);
                if (previous && previous.end === start && previous.terms === terms) previous.end = end;
                else result.push({ start, end, terms });
            }
        }
        return result;
    };
    return JSON.stringify({ scope: signal.scope, horizon: {
        start: new Date(signal.horizon.start).toISOString(), end: new Date(signal.horizon.end).toISOString(),
    },
        import: canonical(signal.import), export: canonical(signal.export) });
}
