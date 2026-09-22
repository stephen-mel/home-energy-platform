import { effectivePriceCurveKey } from "../tariff/compare-price-signal";
import type { EnergyPrice, PriceSignal, PriceWindow } from "../tariff/types";

export type Diagnostic = {
    code: string;
    severity: "warning" | "error";
    message: string;
    start?: string;
    end?: string;
};
export type CandidatePeriod = {
    start: string;
    end: string;
    localDate: string;
    fromMinute: number;
    toMinute: number;
    utcOffset: string;
    buy: EnergyPrice | null;
    sell: EnergyPrice | null;
    importKind: PriceWindow["kind"];
    condition: PriceWindow["condition"];
    // Sidecar retains HEP evidence; it is never encoded as a Tesla guarantee.
    eligibilityPeriods: PriceWindow["eligibilityPeriods"];
};
type TeslaTimePeriod = {
    fromDayOfWeek: number; toDayOfWeek: number;
    fromHour: number; fromMinute: number; toHour: number; toMinute: number;
};
type TeslaTariffSide = {
    version: 1;
    currency: string;
    name: string;
    utility: string;
    energy_charges: Record<string, { rates: Record<string, number> }>;
    seasons: Record<string, {
        fromMonth: number; fromDay: number; toMonth: number; toDay: number;
        tou_periods: Record<string, { periods: TeslaTimePeriod[] }>;
    }>;
};
export type TeslaTariffFragment = TeslaTariffSide & { sell_tariff: TeslaTariffSide };

function complete(curve: PriceWindow[], start: number, end: number): boolean {
    let cursor = start;
    for (const w of [...curve].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
        const from = Date.parse(w.start), to = Date.parse(w.end);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
        if (to <= start || from >= end) continue;
        if (Math.max(from, start) !== cursor) return false;
        cursor = Math.min(to, end);
    }
    return cursor === end;
}

/** Pure dry-run. No client, credentials, filesystem, clock, fetching or write path.
 * The fragment uses Tesla's documented tariff_content_v2 schema, but is NOT a
 * complete recurring-year tariff or an authorized/ready request body.
 */
export function dryRunTeslaTariff(
    signal: PriceSignal,
    options: { timeZone: string; previousEconomicKey?: string } = { timeZone: "Europe/London" },
) {
    const diagnostics: Diagnostic[] = [];
    const add = (code: string, severity: Diagnostic["severity"], message: string, period?: { start: string; end: string }) => {
        diagnostics.push({ code, severity, message, ...(period ? { start: period.start, end: period.end } : {}) });
    };
    const start = Date.parse(signal.horizon.start), end = Date.parse(signal.horizon.end);
    const valid = Number.isFinite(start) && Number.isFinite(end) && end > start &&
        complete(signal.import, start, end) && complete(signal.export, start, end);
    const economicKey = valid ? effectivePriceCurveKey(signal) : null;
    const periods: CandidatePeriod[] = [];
    let fragment: TeslaTariffFragment | null = null;
    if (!valid) add("INVALID_COVERAGE", "error", "HEP import/export curves must completely cover the horizon without gaps or overlaps.");
    let formatter: Intl.DateTimeFormat | undefined;
    try {
        formatter = new Intl.DateTimeFormat("en-GB", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" });
    } catch { add("INVALID_TIMEZONE", "error", "A valid IANA site timezone is required."); }
    if (valid && formatter) {
        const local = (t: number) => {
            const parts = formatter.formatToParts(t);
            const value = (name: string) => parts.find(p => p.type === name)?.value ?? "";
            return { date: `${value("year")}-${value("month")}-${value("day")}`,
                minute: Number(value("hour")) * 60 + Number(value("minute")), offset: value("timeZoneName") };
        };
        const boundaries = new Set([start, end]);
        for (const w of [...signal.import, ...signal.export]) {
            for (const t of [Date.parse(w.start), Date.parse(w.end)]) if (t > start && t < end) boundaries.add(t);
        }
        // Split on local day/offset transitions as well as economic boundaries.
        let previous = local(start);
        for (let t = (Math.floor(start / 60_000) + 1) * 60_000; t < end; t += 60_000) {
            const current = local(t);
            if (current.date !== previous.date || current.offset !== previous.offset) boundaries.add(t);
            previous = current;
        }
        const points = [...boundaries].sort((a, b) => a - b);
        for (let i = 0; i < points.length - 1; i++) {
            const from = points[i], to = points[i + 1];
            const buyWindow = signal.import.find(w => Date.parse(w.start) <= from && Date.parse(w.end) >= to)!;
            const sellWindow = signal.export.find(w => Date.parse(w.start) <= from && Date.parse(w.end) >= to)!;
            const loc = local(from);
            // End is expressed in the start offset, so a fall-back boundary ends
            // at 02:00 BST before the next period starts at 01:00 GMT.
            const period: CandidatePeriod = {
                start: new Date(from).toISOString(), end: new Date(to).toISOString(), localDate: loc.date,
                fromMinute: loc.minute + (from % 60_000) / 60_000,
                toMinute: loc.minute + (from % 60_000) / 60_000 + (to - from) / 60_000,
                utcOffset: loc.offset, buy: buyWindow.price, sell: sellWindow.price,
                importKind: buyWindow.kind, condition: buyWindow.condition,
                eligibilityPeriods: buyWindow.eligibilityPeriods.filter(p => Date.parse(p.start) < to && Date.parse(p.end) > from)
                    .map(p => ({ ...p, start: new Date(Math.max(from, Date.parse(p.start))).toISOString(), end: new Date(Math.min(to, Date.parse(p.end))).toISOString() })),
            };
            periods.push(period);
            const prices = [period.buy, period.sell];
            if (prices.some(p => !p || !Number.isFinite(p.amount)) || buyWindow.priceStatus !== "known" || sellWindow.priceStatus !== "known")
                add("UNKNOWN_PRICE", "error", "Unknown/conflicting prices cannot be encoded as zero or extrapolated.", period);
            if (prices.some(p => p && p.amount < 0)) add("NEGATIVE_PRICE", "error", "Tesla would round a negative price to zero; HEP values are unchanged.", period);
            if (prices.some(p => p && (!["GBP", "EUR", "USD"].includes(p.currency) || p.unit !== "kWh")) ||
                (period.buy && period.sell && period.buy.currency !== period.sell.currency))
                add("UNSUPPORTED_CURRENCY", "error", "Tesla requires one supported currency; no currency conversion is performed.", period);
            if (period.buy && period.sell && period.buy.currency === period.sell.currency && period.buy.amount < period.sell.amount)
                add("BUY_BELOW_SELL", "error", "Tesla would raise the buy price to the sell price. Candidate prices are preserved unchanged.", period);
            if (from % 60_000 || to % 60_000) add("SUB_MINUTE_BOUNDARY", "error", "Tesla TOU periods use minutes. Exact HEP boundaries are retained, not rounded.", period);
        }
        if (periods.some(p => p.condition !== "none")) add("CONDITIONAL_RATE", "warning", "Tesla TOU cannot encode qualifying EV charging conditions. Conditional HEP periods remain forecasts, not guaranteed rates.");
        if ([...signal.import, ...signal.export].some(w => w.stale)) add("STALE_SOURCE", "warning", "HEP includes stale source data; this is separate from economic change detection.");
        if (new Set(periods.flatMap(p => [p.buy?.currency, p.sell?.currency]).filter(Boolean)).size > 1)
            add("MIXED_CURRENCY", "error", "A single Tesla tariff cannot represent changing currencies.");

        // One draft season per supplied local date; not annualized or repeated by HEP.
        // Project each UTC minute into its local wall minute. Repeated DST minutes
        // must agree economically; missing spring minutes cannot be invented.
        const days = new Map<string, Map<number, { buy: number; sell: number }>>();
        let representable = !diagnostics.some(d => ["UNKNOWN_PRICE", "UNSUPPORTED_CURRENCY", "MIXED_CURRENCY", "SUB_MINUTE_BOUNDARY"].includes(d.code));
        if (representable) {
            for (const p of periods) {
                const minutes = days.get(p.localDate) ?? new Map(); days.set(p.localDate, minutes);
                for (let minute = p.fromMinute; minute < p.toMinute; minute++) {
                    const previous = minutes.get(minute);
                    if (previous && (previous.buy !== p.buy!.amount || previous.sell !== p.sell!.amount)) {
                        representable = false;
                        add("DST_FOLD_CONFLICT", "error", "Repeated local clock minutes have different prices; Tesla wall-clock TOU cannot distinguish their UTC offsets.", p);
                        break;
                    }
                    minutes.set(minute, { buy: p.buy!.amount, sell: p.sell!.amount });
                }
            }
        }
        if (representable) {
            const side = (): TeslaTariffSide => ({ version: 1, currency: periods[0].buy!.currency,
                name: "HEP bounded dry-run", utility: "HEP effective tariff",
                energy_charges: {}, seasons: {} });
            fragment = { ...side(), sell_tariff: side() };
            for (const [date, minutes] of days) {
                const [, month, day] = date.split("-").map(Number);
                const season = `HEP_${date}`;
                if (minutes.size !== 1440) add("INCOMPLETE_LOCAL_DAY", "error", `Local date ${date} does not cover every wall-clock minute. No missing hours/rates are invented.`);
                const buyRates: Record<string, number> = {}, sellRates: Record<string, number> = {};
                const tou: Record<string, { periods: TeslaTimePeriod[] }> = {};
                const sorted = [...minutes].sort(([a], [b]) => a - b);
                const runs: Array<{ from: number; to: number; buy: number; sell: number }> = [];
                for (const [minute, prices] of sorted) {
                    const last = runs.at(-1);
                    if (last && last.to === minute && last.buy === prices.buy && last.sell === prices.sell) last.to++;
                    else runs.push({ from: minute, to: minute + 1, ...prices });
                }
                const rates = [...new Set(runs.map(r => JSON.stringify([r.buy, r.sell])))].sort();
                for (const run of runs) {
                    const label = `HEP_RATE_${rates.indexOf(JSON.stringify([run.buy, run.sell])) + 1}`;
                    buyRates[label] = run.buy; sellRates[label] = run.sell;
                    (tou[label] ??= { periods: [] }).periods.push({
                        fromDayOfWeek: 0, toDayOfWeek: 6,
                        fromHour: Math.floor(run.from / 60), fromMinute: run.from % 60,
                        toHour: Math.floor(run.to / 60) % 24, toMinute: run.to % 60,
                    });
                }
                const seasonValue = { fromMonth: month, fromDay: day, toMonth: month, toDay: day, tou_periods: tou };
                fragment.seasons[season] = seasonValue; fragment.sell_tariff.seasons[season] = seasonValue;
                fragment.energy_charges[season] = { rates: buyRates };
                fragment.sell_tariff.energy_charges[season] = { rates: sellRates };
            }
            add("CUSTOM_LABELS", "warning", "Tesla accepts arbitrary TOU labels, but its app only displays its four standard labels. This draft preserves arbitrary rate pairs.");
        }
    }
    add("BOUNDED_FORECAST", "error", "Tesla requires recurring seasons with complete coverage. This bounded HEP forecast is not a complete annual tariff; no outside-horizon rates or expiry behaviour are invented.");
    return {
        dryRun: true as const,
        hep: signal,
        comparison: { economicKey, economicChanged: economicKey && options.previousEconomicKey !== undefined ? economicKey !== options.previousEconomicKey : null },
        candidate: { timeZone: options.timeZone, horizon: signal.horizon, periods, tariffContentV2Fragment: fragment },
        diagnostics,
        pricingCompatible: !diagnostics.some(d => ["BUY_BELOW_SELL", "NEGATIVE_PRICE", "UNKNOWN_PRICE", "UNSUPPORTED_CURRENCY", "MIXED_CURRENCY", "INVALID_COVERAGE", "INVALID_TIMEZONE"].includes(d.code)),
        writeReady: false as const,
        writePayload: null,
    };
}
