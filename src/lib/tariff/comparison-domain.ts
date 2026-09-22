import type { PriceSignal } from "./types";
import { effectivePriceCurveKey } from "./compare-price-signal";
import { instant, validPrice } from "./price-signal";

/** Caller selects a fixed operation interval. Both snapshots must safely cover it;
 * neither prices nor coverage outside that interval are compared.
 */
export function comparePriceSignalsInDomain(previous: PriceSignal, current: PriceSignal, domain: { start: string; end: string }) {
    const failure = (code: string, source?: "previous" | "current") => ({ status: "indeterminate" as const,
        blocker: "COMMON_DOMAIN_UNAVAILABLE", diagnostic: { code, ...(source ? { source } : {}) }, domain, economicChanged: null });
    const timestamp = (value: unknown) => typeof value === "string" ? instant(value) : NaN;
    const start = timestamp(domain?.start), end = timestamp(domain?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return failure("INVALID_DOMAIN");
    let reason = "COMMON_DOMAIN_UNAVAILABLE";
    const project = (signal: PriceSignal): PriceSignal | null => {
        const fail = (code: string) => { reason = code; return null; };
        const fromHorizon = timestamp(signal?.horizon?.start), toHorizon = timestamp(signal?.horizon?.end);
        if (!Number.isFinite(fromHorizon) || !Number.isFinite(toHorizon) || toHorizon <= fromHorizon) return fail("INVALID_HORIZON");
        if (fromHorizon > start || toHorizon < end) return fail("COMMON_DOMAIN_UNAVAILABLE");
        if (signal.scope !== "whole-home") return fail("INVALID_SIGNAL");
        const result: PriceSignal = { ...signal, horizon: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }, import: [], export: [] };
        for (const side of ["import", "export"] as const) {
            if (!Array.isArray(signal[side])) return fail("INVALID_SIGNAL");
            for (const w of signal[side]) {
                if (!w || !Number.isFinite(timestamp(w.start)) || !Number.isFinite(timestamp(w.end)) || timestamp(w.end) <= timestamp(w.start)) return fail("INVALID_SIGNAL");
            }
            let cursor = start;
            for (const w of [...signal[side]].sort((a, b) => timestamp(a.start) - timestamp(b.start))) {
                const from = Math.max(start, timestamp(w.start)), to = Math.min(end, timestamp(w.end));
                if (to <= from) continue;
                if (from !== cursor || w.priceStatus !== "known") return fail("COMMON_DOMAIN_UNAVAILABLE");
                if (!w.price || typeof w.price.amount !== "number" || typeof w.price.currency !== "string" || !validPrice(w.price)) return fail("INVALID_PRICE");
                if (!Array.isArray(w.eligibilityPeriods) || !["standard", "guaranteed-off-peak", "cheap-opportunity"].includes(w.kind)
                    || !["none", "scheduled-ev-charging"].includes(w.condition)) return fail("INVALID_SIGNAL");
                for (const p of w.eligibilityPeriods) {
                    if (!p || !Number.isFinite(timestamp(p.start)) || !Number.isFinite(timestamp(p.end)) || timestamp(p.end) <= timestamp(p.start)
                        || !["planned-conditional", "observed-qualified", "billed-verified"].includes(p.state)) return fail("INVALID_SIGNAL");
                }
                cursor = to;
                result[side].push({ ...w, start: new Date(from).toISOString(), end: new Date(to).toISOString(),
                    eligibilityPeriods: w.eligibilityPeriods.filter(p => timestamp(p.start) < to && timestamp(p.end) > from)
                        .map(p => ({ ...p, start: new Date(Math.max(from, timestamp(p.start))).toISOString(), end: new Date(Math.min(to, timestamp(p.end))).toISOString() })) });
            }
            if (cursor !== end) return fail("COMMON_DOMAIN_UNAVAILABLE");
        }
        return result;
    };
    // Expected malformed runtime data must fail closed, not escape as an exception.
    let source: "previous" | "current" = "previous";
    try {
        const before = project(previous);
        if (!before) return failure(reason, source);
        source = "current";
        const after = project(current);
        if (!after) return failure(reason, source);
        const previousKey = effectivePriceCurveKey(before), currentKey = effectivePriceCurveKey(after);
        return { status: previousKey === currentKey ? "unchanged" as const : "changed" as const,
            domain: before.horizon, economicChanged: previousKey !== currentKey, previousKey, currentKey,
            // Planner reporting uses precisely these validated, projected inputs.
            projected: { previous: before, current: after } };
    } catch { return failure("INVALID_SIGNAL", source); }
}
