import type { PriceInputWindow, TariffConfig, TariffVersion } from "./types";
import { instant, validPrice } from "./price-signal";

type ResolvedTariff = {
    import: PriceInputWindow[];
    export: PriceInputWindow[];
    dispatchRates: PriceInputWindow[];
};

function minuteOfDay(value: string): number {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
}

// Minute-resolution civil-time rules are evaluated on UTC instants, avoiding
// ambiguous/nonexistent local-to-UTC conversions on DST transition days. The
// bounded dashboard horizon has only ~2,880 samples, collapsed into rate runs.
export function resolveEffectiveTariff(
    tariff: TariffConfig, horizon: { start: string; end: string },
): ResolvedTariff {
    const result: ResolvedTariff = { import: [], export: [], dispatchRates: [] };
    const start = instant(horizon.start), end = instant(horizon.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return result;
    const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: tariff.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const versions = (tariff.versions ?? []).flatMap(version => {
        const from = instant(version.effectiveFrom), to = instant(version.effectiveTo);
        return Number.isFinite(from) && Number.isFinite(to) && to > from ? [{ version, from, to }] : [];
    });
    const boundaries = new Set([start, end]);
    for (let t = (Math.floor(start / 60_000) + 1) * 60_000; t < end; t += 60_000) boundaries.add(t);
    for (const v of versions) for (const t of [v.from, v.to]) if (t > start && t < end) boundaries.add(t);
    const points = [...boundaries].sort((a, b) => a - b);
    const append = (list: PriceInputWindow[], window: PriceInputWindow) => {
        const previous = list.at(-1);
        if (previous && previous.end === window.start && previous.kind === window.kind &&
            JSON.stringify(previous.price) === JSON.stringify(window.price) &&
            JSON.stringify(previous.sources) === JSON.stringify(window.sources)) previous.end = window.end;
        else list.push(window);
    };
    for (let i = 0; i < points.length - 1; i++) {
        const from = points[i], to = points[i + 1];
        const matching = versions.filter(v => v.from <= from && v.to >= to);
        // Gaps and ambiguous version overlaps are unknown, never guessed rates.
        const version: TariffVersion | undefined = matching.length === 1 ? matching[0].version : undefined;
        const sources = [{
            provider: version?.provider ?? "site-config",
            description: version?.name ?? (matching.length > 1 ? "Overlapping tariff versions; price unknown" : "No tariff version configured for this period"),
            ...(version ? { tariffVersion: version.id } : {}),
            observedAt: null, stale: false,
        }];
        const parts = formatter.formatToParts(from);
        const localMinute = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
        const daily = (version?.dailyImportWindows ?? []).filter(w => {
            const a = minuteOfDay(w.start), b = minuteOfDay(w.end);
            return Number.isFinite(a) && Number.isFinite(b) && a !== b &&
                (a < b ? localMinute >= a && localMinute < b : localMinute >= a || localMinute < b);
        });
        const common = { start: new Date(from).toISOString(), end: new Date(to).toISOString(), condition: "none" as const, sources };
        append(result.import, {
            ...common,
            price: daily.length > 1 ? null : validPrice(daily.length === 1 ? daily[0].price : version?.normalImport),
            kind: daily.length === 1 ? daily[0].kind : "standard",
        });
        append(result.export, { ...common, price: validPrice(version?.export), kind: "standard" });
        append(result.dispatchRates, { ...common, price: validPrice(version?.scheduledChargingImport), kind: "standard" });
    }
    return result;
}

// Price each dispatch against the version effective at that instant. Original
// dispatch boundaries remain intact in provenance even when its price is split.
export function applyDispatchRates(dispatches: PriceInputWindow[], rates: PriceInputWindow[]): PriceInputWindow[] {
    return dispatches.flatMap(dispatch => rates.flatMap(rate => {
        const start = Math.max(instant(dispatch.start), instant(rate.start));
        const end = Math.min(instant(dispatch.end), instant(rate.end));
        return start < end ? [{ ...dispatch, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
            price: rate.price, sources: [...dispatch.sources, ...rate.sources] }] : [];
    }));
}
