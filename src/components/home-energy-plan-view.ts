import type { PriceSignal, PriceWindow } from "../lib/tariff/types";

export function rateLabel(window: PriceWindow | null): string {
    if (!window || window.price === null) return "Rate unknown";
    if (window.kind === "guaranteed-off-peak") return "Cheap rate · Guaranteed";
    if (window.kind === "cheap-opportunity") return "Smart charge · Conditional";
    return "Standard rate";
}

export function vehicleNames(window: PriceWindow): string[] {
    return [...new Set(window.sources.flatMap(source => {
        const name = source.cause?.assetName?.trim();
        return name ? [name] : [];
    }))];
}

// Presentation only: read the existing curve, clip it to 24 elapsed hours and
// expose proportional widths. Never reconstruct tariff or eligibility rules.
export function homeEnergyPlanView(signal: PriceSignal, now = signal.generatedAt) {
    const start = Date.parse(now), end = start + 24 * 60 * 60 * 1000;
    const current = (curve: PriceWindow[]) => curve.find(w => Date.parse(w.start) <= start && Date.parse(w.end) > start) ?? null;
    const currentImport = current(signal.import);
    const cheap = signal.import.find(w => w.kind !== "standard" && Date.parse(w.end) > start) ?? null;
    const segments: Array<{ start: string; end: string; percent: number; window: PriceWindow | null }> = [];
    const append = (from: number, to: number, window: PriceWindow | null) => {
        if (to > from) segments.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString(), percent: (to - from) / (end - start) * 100, window });
    };
    let cursor = start;
    for (const window of signal.import) {
        const from = Math.max(start, Date.parse(window.start)), to = Math.min(end, Date.parse(window.end));
        if (to <= from) continue;
        append(cursor, from, null);
        append(from, to, window);
        cursor = to;
    }
    append(cursor, end, null);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        currentImport, currentExport: current(signal.export), cheap,
        cheapNow: cheap !== null && Date.parse(cheap.start) <= start, segments };
}
