import { analyseObservedDates, calendarDate, ordinal, priceAt, seasonContains, type ObservedTariff, type ObservedSide, type ObservedSeason } from "./observed-tariff";

/** Exhaustive calendar-date/weekday structural coverage, sampling every time boundary. */
export function observedCoverage(side: ObservedSide): string[] {
    const issues = new Set<string>();
    const points = new Set([0, 1440]);
    for (const [label, season] of Object.entries(side.seasons)) {
        if (ordinal(season.fromMonth, season.fromDay) < 0 || ordinal(season.toMonth, season.toDay) < 0) issues.add("INVALID_SEASON_DATE");
        const rateKeys = Object.keys(side.energy_charges[label]?.rates ?? {}).sort();
        if (JSON.stringify(rateKeys) !== JSON.stringify(Object.keys(season.tou_periods).sort())) issues.add("UNMATCHED_RATE_LABELS");
        for (const tou of Object.values(season.tou_periods)) for (const p of tou.periods) {
            points.add((p.fromHour ?? 0) * 60 + (p.fromMinute ?? 0));
            points.add((p.toHour ?? 0) * 60 + (p.toMinute ?? 0) || 1440);
        }
    }
    if (Object.keys(side.energy_charges).some(k => !side.seasons[k])) issues.add("UNSUPPORTED_FLAT_OR_ORPHAN_RATES");
    for (let day = 0; day < 366; day++) {
        const date = new Date(Date.UTC(2000, 0, day + 1));
        for (let weekday = 0; weekday < 7; weekday++) for (const minute of points) {
            if (minute < 0 || minute >= 1440) continue;
            const p = priceAt(side, date.getUTCMonth() + 1, date.getUTCDate(), weekday, minute);
            if (p.issue) issues.add(p.issue);
            if (p.amount !== null && p.amount < 0) issues.add("NEGATIVE_PRICE");
        }
    }
    return [...issues].sort();
}

export function simulateObservedSmartDate(observed: ObservedTariff, input: {
    date: string; fromMinute: number; toMinute: number; buy: number; currency: string; compareDates: string[]; preserveLabels?: boolean;
}) {
    const blockers: string[] = [];
    const parsed = calendarDate(input.date), original = observed.tariff;
    if (!parsed || !Number.isInteger(input.fromMinute) || !Number.isInteger(input.toMinute) || input.fromMinute < 0
        || input.toMinute > 1440 || input.toMinute <= input.fromMinute || !Number.isFinite(input.buy) || input.buy < 0) blockers.push("INVALID_SIMULATION");
    if (!original || !observed.source.timeZone || original.currency !== input.currency) blockers.push("OBSERVATION_UNAVAILABLE_OR_CURRENCY_MISMATCH");
    if (observed.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")) blockers.push("INCOMPLETE_CAPTURE");
    if (original) {
        blockers.push(...observedCoverage(original), ...observedCoverage(original.sell_tariff));
        if ([original, original.sell_tariff].some(side => Object.values(side.demand_charges ?? {}).some(c =>
            Object.values(c.rates ?? {}).some(rate => rate !== 0)))) blockers.push("NONZERO_DEMAND_CHARGES_UNSUPPORTED");
    }
    const failure = () => ({ status: "blocked" as const, blockers: [...new Set(blockers)], simulated: null, differences: [], writeReady: false as const });
    if (blockers.length || !parsed || !original) return failure();
    const tariff = structuredClone(original);
    const m = parsed.getUTCMonth() + 1, d = parsed.getUTCDate(), target = ordinal(m, d);
    const [label, season] = Object.entries(tariff.seasons).find(([, s]) => seasonContains(s, m, d))!;
    const oldRates = tariff.energy_charges[label], oldDemand = tariff.demand_charges?.[label];
    if (input.preserveLabels) {
        // Small supervised v1: only an already isolated calendar-date season.
        // Do not rename the captured seasons or silently repartition a wrapping one.
        if (season.fromMonth !== m || season.toMonth !== m || season.fromDay !== d || season.toDay !== d) {
            blockers.push("LABEL_PRESERVATION_REQUIRES_DATE_SEASON"); return failure();
        }
        const smartLabel = `hour_${Math.floor(input.fromMinute / 60)}_minute_${input.fromMinute % 60}`;
        if (season.tou_periods[smartLabel] || oldRates.rates?.[smartLabel] !== undefined) {
            blockers.push("SMART_LABEL_COLLISION"); return failure();
        }
        const added: ObservedSeason["tou_periods"][string]["periods"] = [];
        for (const [rateLabel, tou] of Object.entries(season.tou_periods)) {
            const kept: typeof added = [];
            for (const p of tou.periods) {
                const from = (p.fromHour ?? 0) * 60 + (p.fromMinute ?? 0);
                const to = (p.toHour ?? 0) * 60 + (p.toMinute ?? 0) || 1440;
                const a = Math.max(from, input.fromMinute), b = Math.min(to, input.toMinute);
                if (a >= b) { kept.push(p); continue; }
                const bound = (minute: number, end: boolean) => end
                    ? { toHour: Math.floor(minute / 60) % 24, toMinute: minute % 60 }
                    : { fromHour: Math.floor(minute / 60), fromMinute: minute % 60 };
                if (from < a) kept.push({ ...p, ...bound(a, true) });
                added.push({ ...p, ...bound(a, false), ...bound(b, true) });
                if (b < to) kept.push({ ...p, ...bound(b, false) });
            }
            if (kept.length) tou.periods = kept;
            else { delete season.tou_periods[rateLabel]; delete oldRates.rates![rateLabel]; }
        }
        season.tou_periods[smartLabel] = { periods: added };
        oldRates.rates![smartLabel] = input.buy;
    } else {
        delete tariff.seasons[label]; delete tariff.energy_charges[label]; if (tariff.demand_charges) delete tariff.demand_charges[label];
        let counter = 0;
        const name = () => { let key; do { key = `HEP_simulation_${counter++}`; } while (tariff.seasons[key] || tariff.energy_charges[key]); return key; };
        const addSeason = (from: number, to: number) => {
            const a = new Date(Date.UTC(2000, 0, from + 1)), b = new Date(Date.UTC(2000, 0, to + 1)), key = name();
            tariff.seasons[key] = { ...structuredClone(season), fromMonth: a.getUTCMonth() + 1, fromDay: a.getUTCDate(), toMonth: b.getUTCMonth() + 1, toDay: b.getUTCDate() };
            tariff.energy_charges[key] = structuredClone(oldRates);
            if (oldDemand && tariff.demand_charges) tariff.demand_charges[key] = structuredClone(oldDemand);
        };
        let start: number | null = null;
        for (let day = 0; day <= 366; day++) {
            const date = new Date(Date.UTC(2000, 0, day + 1));
            const keep = day < 366 && day !== target && seasonContains(season, date.getUTCMonth() + 1, date.getUTCDate());
            if (keep && start === null) start = day;
            if (!keep && start !== null) { addSeason(start, day - 1); start = null; }
        }
        const key = name();
        const tou: ObservedSeason["tou_periods"] = {}, rates: Record<string, number> = {};
        for (let weekday = 0; weekday < 7; weekday++) {
            let from = 0;
            const at = (minute: number) => minute >= input.fromMinute && minute < input.toMinute ? input.buy : priceAt(original, m, d, weekday, minute).amount!;
            for (let minute = 1; minute <= 1440; minute++) {
                if (minute < 1440 && at(minute) === at(from)) continue;
                const rateLabel = `rate_${Object.keys(rates).length}`; rates[rateLabel] = at(from);
                tou[rateLabel] = { periods: [{ fromDayOfWeek: weekday, toDayOfWeek: weekday,
                    fromHour: Math.floor(from / 60), fromMinute: from % 60, toHour: Math.floor(minute / 60) % 24, toMinute: minute % 60 }] };
                from = minute;
            }
        }
        tariff.seasons[key] = { fromMonth: m, fromDay: d, toMonth: m, toDay: d, tou_periods: tou };
        tariff.energy_charges[key] = { rates };
        if (oldDemand && tariff.demand_charges) tariff.demand_charges[key] = structuredClone(oldDemand);
    }
    blockers.push(...observedCoverage(tariff), ...observedCoverage(tariff.sell_tariff));
    if (blockers.length) return failure();
    const simulated: ObservedTariff = { ...observed, source: { ...observed.source, kind: "simulation" }, tariff };
    const dates = [...new Set([input.date, ...input.compareDates])];
    const before = analyseObservedDates(observed, dates), after = analyseObservedDates(simulated, dates);
    const differences: Array<{ date: string; start: string; end: string; fromMinute: number; toMinute: number; offsetMinutes: number;
        oldBuy: number | null; newBuy: number | null; oldSell: number | null; newSell: number | null; buyCurrency: string; sellCurrency: string }> = [];
    for (const day of before.days) {
        const changed = after.days.find(d => d.date === day.date)!;
        for (const a of day.periods) for (const b of changed.periods) {
            const start = Math.max(Date.parse(a.start), Date.parse(b.start)), end = Math.min(Date.parse(a.end), Date.parse(b.end));
            if (start >= end || a.buy === b.buy && a.sell === b.sell) continue;
            differences.push({ date: day.date, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
                fromMinute: a.fromMinute + (start - Date.parse(a.start)) / 60000, toMinute: a.fromMinute + (end - Date.parse(a.start)) / 60000,
                offsetMinutes: a.offsetMinutes, oldBuy: a.buy, newBuy: b.buy, oldSell: a.sell, newSell: b.sell,
                buyCurrency: a.buyCurrency, sellCurrency: a.sellCurrency });
        }
    }
    return { status: "simulation-only" as const, blockers, simulated, differences, before, after,
        scope: { requestedDate: input.date, recurringMonth: m, recurringDay: d, comparedDates: dates },
        limitations: ["Month/day encoding repeats annually; it is not a one-off year-specific schedule.",
            "Sparse-zero and weekday-number assumptions are explicit, not verified Tesla execution behaviour.",
            "Complete structural coverage is not Tesla acceptance or rollback proof."], writeReady: false as const };
}
