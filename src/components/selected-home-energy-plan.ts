import type { ResolvedEconomicPeriod } from "../lib/tariff/economic-model";
import type { EconomicResolution } from "../lib/tariff/resolve-economic-model";
import { economicInstant } from "../lib/tariff/resolve-economic-model";
import type { EonOfflineResult } from "../lib/tariff/eon-offline-evidence";
import { decimalParts } from "../lib/tariff/economic-decimal";
import type { PriceWindow, PriceSignal } from "../lib/tariff/types";
import { homeEnergyPlanView } from "./home-energy-plan-view";

/** Explicit inspection source, never a fallback list or an execution authority.
 * Canonical sources may include manual evidence: selecting canonical does not
 * upgrade their attestor/kind. The original resolution/provenance stays attached.
 */
export type HomeEnergyPlanSource =
    | { kind: "canonical"; resolution: EconomicResolution }
    | { kind: "eon-offline"; result: EonOfflineResult }
    | { kind: "manual-assumption"; label: string; signal: PriceSignal };
export type SelectedHomeEnergyPlan = {
    purpose: "read-only-inspection";
    status: "selected" | "unavailable";
    sourceLabel: string;
    source: HomeEnergyPlanSource | null;
    diagnostics: string[];
    signal: PriceSignal | null;
    presentationSignal: PriceSignal | null;
    view: ReturnType<typeof homeEnergyPlanView> | null;
};

// Plain detached data only; do not pretend Object.freeze secures Map/Set/Date.
function checkData(value: unknown, seen = new WeakSet<object>()): void {
    if (value === null || ["string", "boolean", "undefined"].includes(typeof value)) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || seen.has(value)) throw Error("INVALID_SOURCE");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && !(proto === null || (Object.getPrototypeOf(proto) === null
        && Object.prototype.toString.call(value) === "[object Object]"))) throw Error("INVALID_SOURCE");
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!("value" in descriptor)) throw Error("INVALID_SOURCE");
        checkData(descriptor.value, seen);
    }
    seen.delete(value);
}
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        for (const child of Object.values(value)) freeze(child, seen);
        Object.freeze(value);
    }
    return value;
}

// Validate the existing Stage 1 projection contract, not a new cheapness rule.
// Conditional economics override compatibilityKind; they can never be guaranteed.
function matchingEligibility(window: PriceWindow, parts: ResolvedEconomicPeriod[]): boolean {
    if (window.kind === "standard") return window.condition === "none" && window.eligibilityPeriods.length === 0
        && parts.every(p => p.conditional === null && p.compatibilityKind === "standard");
    if (window.kind === "guaranteed-off-peak") return window.condition === "none"
        && window.eligibilityPeriods.length === 0 && parts.every(p => p.conditional === null
            && p.protected === true && p.compatibilityKind === "guaranteed-off-peak");
    if (window.kind !== "cheap-opportunity" || window.condition !== "scheduled-ev-charging"
        || window.eligibilityPeriods.length !== parts.length) return false;
    return parts.every(p => {
        const conditional = p.conditional;
        if (!conditional || conditional.state !== "planned-conditional"
            || conditional.rule.compatibility !== "drive-smart" || conditional.rule.provider !== "kraken"
            || conditional.rule.dispatchType !== "SMART" || conditional.rule.qualification !== "physical-charging-required"
            || !conditional.intervals.length || !conditional.intervals.every(d => economicInstant(d.start) <= economicInstant(p.start)
                && economicInstant(d.end) >= economicInstant(p.end))) return false;
        // Stage 1 emits one assessment per canonical part, retaining its sources;
        // coalescing appends these assessments rather than promoting their state.
        const matches = window.eligibilityPeriods.filter(e => economicInstant(e.start) === economicInstant(p.start)
            && economicInstant(e.end) === economicInstant(p.end));
        const assessmentStart = Math.floor(economicInstant(p.start) / 1800000) * 1800000;
        return matches.length === 1 && matches[0].state === "planned-conditional"
            && economicInstant(matches[0].assessmentPeriod.start) === assessmentStart
            && economicInstant(matches[0].assessmentPeriod.end) === assessmentStart + 1800000
            && JSON.stringify(matches[0].sources) === JSON.stringify(p.sources);
    });
}

// The projection may coalesce multiple canonical periods. Require an exact,
// unambiguous half-open partition of the candidate, not an array-index match.
function validatedWindow(window: PriceWindow, resolution: EconomicResolution, direction: "import" | "export"): boolean {
    const start = economicInstant(window.start), end = economicInstant(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
    const periods = resolution.periods.filter(p => p.direction === direction);
    if (periods.some(p => !Number.isFinite(economicInstant(p.start)) || !Number.isFinite(economicInstant(p.end))
        || economicInstant(p.end) <= economicInstant(p.start))) return false;
    const parts = periods.filter(p => economicInstant(p.start) < end && economicInstant(p.end) > start)
        .sort((a, b) => economicInstant(a.start) - economicInstant(b.start));
    let cursor = start;
    for (const part of parts) {
        if (economicInstant(part.start) !== cursor || economicInstant(part.end) > end) return false;
        cursor = economicInstant(part.end);
    }
    if (cursor !== end || !parts.length || !parts.every(p => JSON.stringify(window.sources) === JSON.stringify(p.sources)
        && window.stale === p.sources.some(source => source.stale))) return false;
    if (window.priceStatus !== "known") {
        // Null standard windows can express genuinely unknown/conflicting
        // economics without the legacy kind-based cheap indicator becoming true.
        // Never relabel an unknown off-peak window: reject it instead.
        return window.price === null && window.kind === "standard" && window.condition === "none"
            && window.eligibilityPeriods.length === 0 && parts.every(p => {
                if (window.priceStatus === "conflicting") return p.priceStatus === "conflicting";
                if (window.priceStatus !== "unknown" || p.priceStatus === "conflicting") return false;
                const amount = p.consumerPrice?.amount;
                const supported = !p.conditional || (direction === "import" && p.conditional.rule.compatibility === "drive-smart");
                return p.priceStatus === "unknown" || (p.priceStatus === "known" && (!supported || amount === undefined
                    || !Number.isFinite(Number(amount)) || String(Number(amount)) !== amount));
            });
    }
    const price = window.price;
    return !!price && Number.isFinite(price.amount) && price.unit === "kWh" && /^[A-Z]{3}$/.test(price.currency)
        && parts.every(p => p.priceStatus === "known" && p.consumerPrice !== null && decimalParts(p.consumerPrice.amount)
            && p.consumerPrice.unit === "kWh" && p.consumerPrice.currency === price.currency
            && p.consumerPrice.amount === String(price.amount)
            && (direction === "import" || p.conditional === null)) && matchingEligibility(window, parts);
}

function presentationCurve(signal: PriceSignal, canonical: EconomicResolution, diagnostics: string[]): PriceSignal | null {
    const begin = economicInstant(signal.horizon.start), end = economicInstant(signal.horizon.end);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) {
        diagnostics.push("PRESENTATION_HORIZON_INVALID"); return null;
    }
    const presentation = structuredClone(signal);
    for (const direction of ["import", "export"] as const) {
        let cursor = begin;
        // The legacy view assumes sorted, non-overlapping windows. Reject the
        // entire presentation if that contract is broken, never pick a winner.
        for (const w of signal[direction]) {
            const from = economicInstant(w.start), to = economicInstant(w.end);
            if (!Number.isFinite(from) || !Number.isFinite(to) || from < cursor || to <= from || to > end) {
                diagnostics.push(`PRESENTATION_${direction.toUpperCase()}_ORDER_OR_COVERAGE_INVALID`); return null;
            }
            cursor = to;
        }
        presentation[direction] = presentation[direction].filter(w => {
            if (validatedWindow(w, canonical, direction)) return true;
            diagnostics.push(`PRESENTATION_${direction.toUpperCase()}_WINDOW_REJECTED`); return false;
        });
    }
    return presentation; // Gaps are deliberately left as gaps, never new prices/kinds.
}

/** Feed the existing pure presentation consumer, not the live dashboard source.
 * Retains the projection for inspection; only validated windows reach the view.
 * No repricing, tax arithmetic, source merging or conditional promotion.
 */
export function selectedHomeEnergyPlan(selection: HomeEnergyPlanSource, now: string): SelectedHomeEnergyPlan {
    const result: SelectedHomeEnergyPlan = { purpose: "read-only-inspection", status: "unavailable",
        sourceLabel: "No source selected", source: null, diagnostics: [], signal: null, presentationSignal: null, view: null };
    try {
        checkData(selection);
        const source: HomeEnergyPlanSource = structuredClone(selection);
        if (!Number.isFinite(economicInstant(now))) throw Error("INVALID_SOURCE");
        let signal: PriceSignal;
        let canonical: EconomicResolution | null = null;
        switch (source.kind) {
            case "canonical":
                result.sourceLabel = "Canonical evidence — source attestations retained";
                result.source = source;
                result.diagnostics = [...source.resolution.diagnostics];
                if (source.resolution.status !== "resolved") {
                    result.diagnostics.push("CANONICAL_RESOLUTION_UNAVAILABLE");
                    return freeze(result);
                }
                canonical = source.resolution;
                signal = source.resolution.signal;
                break;
            case "eon-offline":
                result.sourceLabel = "Offline E.ON evidence — supplied coverage only";
                result.source = source;
                result.diagnostics = [...source.result.diagnostics, ...(source.result.resolution?.diagnostics ?? [])];
                if (!["resolved", "partial"].includes(source.result.status) || source.result.resolution?.status !== "resolved") {
                    result.diagnostics.push("OFFLINE_RESOLUTION_UNAVAILABLE");
                    return freeze(result);
                }
                canonical = source.result.resolution;
                signal = source.result.resolution.signal;
                break;
            case "manual-assumption":
                if (typeof source.label !== "string" || !source.label.trim()) throw Error("INVALID_SOURCE");
                result.sourceLabel = `Manual tariff assumption: ${source.label}`;
                result.source = source;
                signal = source.signal;
                break;
            default:
                throw Error("INVALID_SOURCE");
        }
        result.signal = signal;
        const presentation = canonical ? presentationCurve(signal, canonical, result.diagnostics) : structuredClone(signal);
        if (!presentation) return freeze(result);
        result.presentationSignal = presentation;
        result.view = homeEnergyPlanView(presentation, now);
        result.status = "selected"; // Describes selection, NOT completeness or eligibility.
        return freeze(result);
    } catch {
        return freeze({ purpose: "read-only-inspection", status: "unavailable", sourceLabel: "Source unavailable",
            source: null, diagnostics: ["INVALID_SOURCE_SELECTION"], signal: null, presentationSignal: null, view: null });
    }
}
