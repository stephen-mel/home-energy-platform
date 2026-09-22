import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { effectivePriceCurveKey } from "../tariff/compare-price-signal";
import type { PriceSignal, PriceWindow } from "../tariff/types";
import { dryRunTeslaTariff, type Diagnostic } from "./dry-run";

type Translation = ReturnType<typeof dryRunTeslaTariff>;
export type SyncStatus = "no-update" | "update-required" | "blocked";
export type EconomicChange = "unchanged" | "changed" | "unestablished" | "indeterminate";
export type ChangedPeriod = {
    start: string;
    end: string;
    channels: Array<"import" | "export">;
};
export type SyncPlan = {
    status: SyncStatus;
    comparison: {
        state: EconomicChange;
        domain: { start: string; end: string };
        diagnostic: { code: string; source?: "previous" | "current" } | null;
        baselineEconomicKey: string | null;
        economicKey: string | null;
        // null means comparison unavailable, [] means no changed intervals.
        changedPeriods: ChangedPeriod[] | null;
    };
    reasons: Array<{
        code: "ECONOMICS_UNCHANGED" | "ECONOMICS_CHANGED" | "BASELINE_MISSING" | "BASELINE_INVALID"
            | "COMMON_DOMAIN_UNAVAILABLE" | "CURRENT_CURVE_INVALID" | "REPRESENTATION_BLOCKED" | "REPRESENTATION_AVAILABLE";
        diagnosticCodes?: string[];
    }>;
    hep: PriceSignal;
    candidate: Translation["candidate"];
    compatibility: {
        // Pricing alone never establishes representability or write readiness.
        pricingCompatible: boolean;
        representable: boolean;
        blockers: Diagnostic[];
        warnings: Diagnostic[];
    };
    limitations: Array<{ code: string; message: string }>;
    inspectionOnly: true;
    writeReady: false;
    writePayload: null;
};

/** Decision rule kept separate so the future blocker-free case is testable.
 * No-update describes HEP change only; it does not certify a stored Tesla tariff.
 */
export function decideSyncStatus(change: EconomicChange, blockers: readonly Diagnostic[]): SyncStatus {
    if (change === "indeterminate") return "blocked";
    if (change === "unchanged") return "no-update";
    return blockers.length ? "blocked" : "update-required";
}

function clip(curve: PriceWindow[], start: string, end: string): PriceWindow[] {
    return curve.filter(w => Date.parse(w.start) < Date.parse(end) && Date.parse(w.end) > Date.parse(start))
        .map(w => ({ ...w,
            start: new Date(Math.max(Date.parse(start), Date.parse(w.start))).toISOString(),
            end: new Date(Math.min(Date.parse(end), Date.parse(w.end))).toISOString(),
            eligibilityPeriods: w.eligibilityPeriods
                .filter(p => Date.parse(p.start) < Date.parse(end) && Date.parse(p.end) > Date.parse(start))
                .map(p => ({ ...p,
                    start: new Date(Math.max(Date.parse(start), Date.parse(p.start))).toISOString(),
                    end: new Date(Math.min(Date.parse(end), Date.parse(p.end))).toISOString(),
                })),
        }));
}

// Locate the changed intervals using the existing canonical economic comparison
// on each boundary slice. Do not define a second set of economic equality rules.
function changedPeriods(before: PriceSignal, after: PriceSignal): ChangedPeriod[] {
    const boundaries = new Set<number>();
    for (const signal of [before, after]) {
        boundaries.add(Date.parse(signal.horizon.start)); boundaries.add(Date.parse(signal.horizon.end));
        for (const w of [...signal.import, ...signal.export]) {
            for (const date of [w.start, w.end, ...w.eligibilityPeriods.flatMap(p => [p.start, p.end])]) {
                const t = Date.parse(date);
                if (t >= Date.parse(signal.horizon.start) && t <= Date.parse(signal.horizon.end)) boundaries.add(t);
            }
        }
    }
    const points = [...boundaries].sort((a, b) => a - b);
    const changes: ChangedPeriod[] = [];
    for (let i = 0; i < points.length - 1; i++) {
        const start = new Date(points[i]).toISOString(), end = new Date(points[i + 1]).toISOString();
        const channels = (["import", "export"] as const).filter(channel => {
            const key = (signal: PriceSignal) => effectivePriceCurveKey({ ...signal, horizon: { start, end },
                import: [], export: [], [channel]: clip(clip(signal[channel], signal.horizon.start, signal.horizon.end), start, end) });
            return key(before) !== key(after);
        });
        if (!channels.length) continue;
        const last = changes.at(-1);
        if (last && last.end === start && last.channels.join() === channels.join()) last.end = end;
        else changes.push({ start, end, channels });
    }
    return changes;
}

/** Pure, read-only planning against a caller-supplied HEP baseline, never Tesla state.
 * An explicit fixed comparison domain is required. Rolling horizon movement is
 * not compared; unavailable/unsafe comparison coverage blocks the decision.
 */
export function planTeslaTariffSync(input: {
    signal: PriceSignal;
    previousSignal?: PriceSignal;
    timeZone: string;
    comparisonDomain: { start: string; end: string };
}): SyncPlan {
    const comparison = input.previousSignal
        ? comparePriceSignalsInDomain(input.previousSignal, input.signal, input.comparisonDomain) : null;
    const state: EconomicChange = comparison?.status ?? "indeterminate";
    const baselineEconomicKey = comparison && comparison.status !== "indeterminate" ? comparison.previousKey : null;
    const economicKey = comparison && comparison.status !== "indeterminate" ? comparison.currentKey : null;
    const diagnostic = !comparison ? { code: "BASELINE_MISSING" }
        : comparison.status === "indeterminate" ? comparison.diagnostic : null;
    // Retain full proposed-curve Tesla diagnostics; never translate a clipped
    // comparison interval as though it were the complete intended tariff.
    let translation: Translation;
    try { translation = dryRunTeslaTariff(input.signal, { timeZone: input.timeZone }); }
    catch {
        translation = { dryRun: true, hep: input.signal, comparison: { economicKey: null, economicChanged: null },
            candidate: { timeZone: input.timeZone, horizon: input.signal.horizon, periods: [], tariffContentV2Fragment: null },
            diagnostics: [{ code: "INVALID_COVERAGE", severity: "error", message: "Malformed current signal cannot be translated safely." }],
            pricingCompatible: false, writeReady: false, writePayload: null };
    }
    const blockers = translation.diagnostics.filter(d => d.severity === "error");
    if (!translation.candidate.tariffContentV2Fragment && !blockers.length) {
        blockers.push({ code: "CANDIDATE_UNAVAILABLE", severity: "error", message: "No Tesla inspection representation is available." });
    }
    const reasons: SyncPlan["reasons"] = [];
    if (state === "changed" || state === "unchanged") reasons.push({ code: state === "unchanged" ? "ECONOMICS_UNCHANGED" : "ECONOMICS_CHANGED" });
    if (!input.previousSignal) reasons.push({ code: "BASELINE_MISSING" });
    if (diagnostic) reasons.push({ code: "COMMON_DOMAIN_UNAVAILABLE", diagnosticCodes: [diagnostic.code] });
    if (diagnostic && "source" in diagnostic && diagnostic.source === "previous") reasons.push({ code: "BASELINE_INVALID" });
    if (translation.comparison.economicKey === null) reasons.push({ code: "CURRENT_CURVE_INVALID" });
    reasons.push(blockers.length ? { code: "REPRESENTATION_BLOCKED", diagnosticCodes: [...new Set(blockers.map(d => d.code))] }
        : { code: "REPRESENTATION_AVAILABLE" });
    const limitations = [
        { code: "HEP_BASELINE_ONLY", message: "Comparison is against the supplied HEP baseline, not confirmation of Tesla's stored tariff or a previous successful write." },
        { code: "INSPECTION_ONLY", message: "A candidate is an inspection-only draft, including when blocked. No command or write-ready payload is produced." },
    ];
    limitations.push({ code: "EXPLICIT_COMPARISON_DOMAIN", message: "Economic change and changed periods describe only the requested comparison domain; full candidate compatibility is assessed separately." });
    return {
        status: decideSyncStatus(state, blockers),
        comparison: { state, domain: comparison?.domain ?? input.comparisonDomain, diagnostic, baselineEconomicKey, economicKey,
            changedPeriods: comparison?.status === "unchanged" ? [] : comparison?.status === "changed"
                ? changedPeriods(comparison.projected.previous, comparison.projected.current) : null },
        reasons, hep: translation.hep, candidate: translation.candidate,
        compatibility: { pricingCompatible: translation.pricingCompatible, representable: !blockers.length,
            blockers, warnings: translation.diagnostics.filter(d => d.severity === "warning") },
        limitations, inspectionOnly: true, writeReady: false, writePayload: null,
    };
}
