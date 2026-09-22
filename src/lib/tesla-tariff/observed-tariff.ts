export type ObservedPeriod = Partial<Record<"fromDayOfWeek" | "toDayOfWeek" | "fromHour" | "toHour" | "fromMinute" | "toMinute", number>>;
export type ObservedSeason = { fromMonth: number; fromDay: number; toMonth: number; toDay: number;
    tou_periods: Record<string, { periods: ObservedPeriod[] }> };
export type ObservedSide = { code?: string; name: string; utility: string; currency: string; version?: number;
    seasons: Record<string, ObservedSeason>; energy_charges: Record<string, { rates?: Record<string, number> }>;
    demand_charges?: Record<string, { rates?: Record<string, number> }> };
export type ObservedContent = ObservedSide & { sell_tariff: ObservedSide };
export type ObservedTariff = { source: { kind: "tesla-site-info" | "simulation"; energySiteId: string; observedAt: string; timeZone: string | null };
    tariff: ObservedContent | null; diagnostics: string[]; rollbackProven: false };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safe = (s: unknown): s is string => typeof s === "string" && s.length <= 180 && !/token|secret|password|private.?key|authorization|bearer|-----BEGIN/i.test(s)
    && !["__proto__", "constructor", "prototype"].includes(s);

/** Extract only tariff fields, never credentials or the raw site-info envelope.
 * Omitted TOU fields remain omitted in the captured representation.
 */
export function captureObservedTariff(siteInfo: unknown, energySiteId: string, observedAt: string): ObservedTariff {
    const diagnostics: string[] = [];
    const body = object(siteInfo) && object(siteInfo.response) ? siteInfo.response : siteInfo;
    let timeZone: string | null = null;
    if (object(body) && safe(body.installation_time_zone)) {
        try { new Intl.DateTimeFormat("en-GB", { timeZone: body.installation_time_zone }); timeZone = body.installation_time_zone; } catch { /* diagnostic below */ }
    }
    if (!timeZone) diagnostics.push("TIMEZONE_UNAVAILABLE");
    if (!safe(energySiteId) || !Number.isFinite(Date.parse(observedAt))) throw new Error("Valid capture identity/time required");
    const fields = (v: Record<string, unknown>, allowed: string[]) => {
        if (Object.keys(v).some(k => !allowed.includes(k))) diagnostics.push("UNSUPPORTED_FIELDS_OMITTED");
    };
    const dict = <T>(v: unknown, parse: (v: unknown) => T): Record<string, T> => {
        if (!object(v)) throw new Error();
        return Object.fromEntries(Object.keys(v).sort().map(k => { if (!safe(k)) throw new Error(); return [k, parse(v[k])]; }));
    };
    const charges = (v: unknown) => dict(v, c => {
        if (!object(c)) throw new Error(); fields(c, ["rates"]);
        return c.rates === undefined ? {} : { rates: dict(c.rates, n => { if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(); return n; }) };
    });
    const side = (v: unknown, root = false): ObservedSide => {
        if (!object(v) || !safe(v.name) || !safe(v.utility) || !safe(v.currency) || !/^[A-Z]{3}$/.test(v.currency)) throw new Error();
        fields(v, ["code", "name", "utility", "currency", "version", "seasons", "energy_charges", "demand_charges", ...(root ? ["sell_tariff"] : [])]);
        const seasons = dict(v.seasons, raw => {
            if (!object(raw)) throw new Error(); fields(raw, ["fromMonth", "fromDay", "toMonth", "toDay", "tou_periods"]);
            for (const k of ["fromMonth", "fromDay", "toMonth", "toDay"]) if (!Number.isInteger(raw[k])) throw new Error();
            return { fromMonth: raw.fromMonth as number, fromDay: raw.fromDay as number, toMonth: raw.toMonth as number, toDay: raw.toDay as number,
                tou_periods: dict(raw.tou_periods, tou => {
                    if (!object(tou) || !Array.isArray(tou.periods)) throw new Error(); fields(tou, ["periods"]);
                    return { periods: tou.periods.map(p => {
                        if (!object(p)) throw new Error();
                        const allowed = ["fromDayOfWeek", "toDayOfWeek", "fromHour", "toHour", "fromMinute", "toMinute"];
                        fields(p, allowed);
                        if (allowed.some(k => p[k] === undefined)) diagnostics.push("SPARSE_TOU_ZERO_DEFAULT_ASSUMPTION");
                        return Object.fromEntries(allowed.filter(k => p[k] !== undefined).map(k => {
                            if (!Number.isInteger(p[k])) throw new Error(); return [k, p[k]];
                        })) as ObservedPeriod;
                    }) };
                }) };
        });
        return { name: v.name, utility: v.utility, currency: v.currency,
            ...(v.code !== undefined ? { code: safe(v.code) ? v.code : (() => { throw new Error(); })() } : {}),
            ...(v.version !== undefined ? { version: typeof v.version === "number" && Number.isFinite(v.version) ? v.version : (() => { throw new Error(); })() } : {}),
            seasons, energy_charges: charges(v.energy_charges), ...(v.demand_charges !== undefined ? { demand_charges: charges(v.demand_charges) } : {}) };
    };
    let tariff: ObservedContent | null = null;
    try {
        const raw = object(body) ? body.tariff_content_v2 : null;
        if (!object(raw)) throw new Error();
        tariff = { ...side(raw, true), sell_tariff: side(raw.sell_tariff) };
    } catch { diagnostics.push("TARIFF_UNREADABLE"); }
    return { source: { kind: "tesla-site-info", energySiteId, observedAt, timeZone }, tariff,
        diagnostics: [...new Set(diagnostics)], rollbackProven: false };
}

export function calendarDate(date: string): Date | null {
    if (!/^\d{4}-\d\d-\d\d$/.test(date)) return null;
    const d = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date ? d : null;
}
export function ordinal(month: number, day: number): number {
    const d = new Date(Date.UTC(2000, month - 1, day));
    return d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? (d.getTime() - Date.UTC(2000, 0, 1)) / 86400000 : -1;
}
export function seasonContains(s: ObservedSeason, month: number, day: number): boolean {
    const a = ordinal(s.fromMonth, s.fromDay), b = ordinal(s.toMonth, s.toDay), n = ordinal(month, day);
    return a >= 0 && b >= 0 && n >= 0 && (a <= b ? n >= a && n <= b : n >= a || n <= b);
}
function minuteBounds(p: ObservedPeriod) {
    const fd = p.fromDayOfWeek ?? 0, td = p.toDayOfWeek ?? 0;
    const fh = p.fromHour ?? 0, th = p.toHour ?? 0, fm = p.fromMinute ?? 0, tm = p.toMinute ?? 0;
    if (![fd, td, fh, th, fm, tm].every(Number.isInteger) || fd < 0 || td > 6 || td < fd || fh < 0 || fh > 23 || th < 0 || th > 23 || fm < 0 || fm > 59 || tm < 0 || tm > 59) return null;
    const start = fh * 60 + fm, end = th === 0 && tm === 0 ? 1440 : th * 60 + tm;
    return end > start ? { fd, td, start, end } : null;
}
export function priceAt(side: ObservedSide, month: number, day: number, weekday: number, minute: number) {
    const matches = Object.entries(side.seasons).filter(([, s]) => seasonContains(s, month, day));
    if (matches.length !== 1) return { amount: null, season: null, issue: matches.length ? "SEASON_OVERLAP" : "SEASON_GAP" };
    const [label, season] = matches[0];
    const rates: number[] = [];
    for (const [name, tou] of Object.entries(season.tou_periods)) for (const p of tou.periods) {
        const bounds = minuteBounds(p);
        if (!bounds) return { amount: null, season: label, issue: "INVALID_TOU_PERIOD" };
        if (weekday >= bounds.fd && weekday <= bounds.td && minute >= bounds.start && minute < bounds.end) {
            const rate = side.energy_charges[label]?.rates?.[name];
            if (typeof rate !== "number" || !Number.isFinite(rate)) return { amount: null, season: label, issue: "PRICE_UNAVAILABLE" };
            rates.push(rate);
        }
    }
    return rates.length === 1 ? { amount: rates[0], season: label, issue: null }
        : { amount: null, season: label, issue: rates.length ? "TOU_OVERLAP" : "TOU_GAP" };
}
export type DailyPeriod = { start: string; end: string; fromMinute: number; toMinute: number; offsetMinutes: number;
    buy: number | null; sell: number | null; buyCurrency: string; sellCurrency: string; buySeason: string | null; sellSeason: string | null; issues: string[] };

/** Expansion uses actual UTC minutes mapped into the supplied local date. Repeated
 * autumn minutes stay distinct; missing spring minutes are not fabricated.
 * Weekday interpretation is explicitly Sunday=0; no label has special semantics.
 */
export function analyseObservedDates(observed: ObservedTariff, dates: string[]) {
    const diagnostics = [...observed.diagnostics, "MONTH_DAY_SEASONS_REPEAT_ANNUALLY", "WEEKDAY_SUNDAY_ZERO_ASSUMPTION"];
    const days: Array<{ date: string; elapsedMinutes: number; periods: DailyPeriod[] }> = [];
    if (!observed.tariff || !observed.source.timeZone) return { days, diagnostics: [...new Set([...diagnostics, "ANALYSIS_UNAVAILABLE"])], writeReady: false as const };
    const tariff = observed.tariff;
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: observed.source.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const date of [...new Set(dates)].sort()) {
        const parsed = calendarDate(date);
        if (!parsed) { diagnostics.push("INVALID_CALENDAR_DATE"); continue; }
        const periods: DailyPeriod[] = []; let elapsedMinutes = 0;
        for (let t = parsed.getTime() - 18 * 3600000; t < parsed.getTime() + 42 * 3600000; t += 60000) {
            const parts = format.formatToParts(t), n = (name: string) => Number(parts.find(p => p.type === name)!.value);
            const y = n("year"), m = n("month"), d = n("day"), h = n("hour"), min = n("minute");
            if (y !== parsed.getUTCFullYear() || m !== parsed.getUTCMonth() + 1 || d !== parsed.getUTCDate()) continue;
            elapsedMinutes++;
            const minute = h * 60 + min;
            const buy = priceAt(tariff, m, d, parsed.getUTCDay(), minute), sell = priceAt(tariff.sell_tariff, m, d, parsed.getUTCDay(), minute);
            const issues = [buy.issue, sell.issue].filter((i): i is string => !!i);
            if (buy.amount !== null && sell.amount !== null && tariff.currency === tariff.sell_tariff.currency && buy.amount < sell.amount) issues.push("BUY_BELOW_SELL");
            const period: DailyPeriod = { start: new Date(t).toISOString(), end: new Date(t + 60000).toISOString(), fromMinute: minute, toMinute: minute + 1,
                offsetMinutes: (Date.UTC(y, m - 1, d, h, min) - t) / 60000, buy: buy.amount, sell: sell.amount,
                buyCurrency: tariff.currency, sellCurrency: tariff.sell_tariff.currency, buySeason: buy.season, sellSeason: sell.season, issues };
            diagnostics.push(...issues);
            const last = periods.at(-1);
            if (last && last.end === period.start && last.toMinute === minute && last.offsetMinutes === period.offsetMinutes
                && last.buy === period.buy && last.sell === period.sell && last.buySeason === period.buySeason && last.sellSeason === period.sellSeason
                && last.issues.join() === issues.join()) { last.end = period.end; last.toMinute++; }
            else periods.push(period);
        }
        days.push({ date, elapsedMinutes, periods });
    }
    return { days, diagnostics: [...new Set(diagnostics)], writeReady: false as const };
}
