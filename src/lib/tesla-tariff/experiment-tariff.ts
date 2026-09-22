import type { TeslaTariffFragment } from "./dry-run";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const secret = (value: string) => /token|secret|password|authorization|private.?key|oauth|bearer|-----BEGIN/i.test(value);
const text = (value: unknown) => typeof value === "string" && value.length <= 160 && !secret(value);
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);

/** Allowlisted capture, never a raw API/auth envelope. Unknown fields are omitted
 * and make reconstruction inexact. Accepted tariff fields retain original values.
 */
export function inspectTariff(value: unknown) {
    let exact = true;
    const copy = (raw: unknown, schema: string): unknown => {
        if (!object(raw)) { exact = false; return null; }
        const out: ObjectValue = {};
        const fields: Record<string, string> = schema === "tariff" ? {
            version: "number", currency: "text", name: "text", utility: "text", energy_charges: "charges", seasons: "seasons", sell_tariff: "side",
        } : schema === "side" ? { version: "number", currency: "text", name: "text", utility: "text", energy_charges: "charges", seasons: "seasons" }
            : schema === "charge" ? { rates: "rates" }
                : schema === "season" ? { fromMonth: "number", fromDay: "number", toMonth: "number", toDay: "number", tou_periods: "tous" }
                    : schema === "tou" ? { periods: "periods" }
                        : schema === "period" ? { fromDayOfWeek: "number", toDayOfWeek: "number", fromHour: "number", fromMinute: "number", toHour: "number", toMinute: "number" } : {};
        const dictionary = ({ charges: "charge", seasons: "season", rates: "number", tous: "tou" } as Record<string, string>)[schema];
        for (const key of Object.keys(raw).sort()) {
            const kind = dictionary ?? fields[key];
            if (!kind || !text(key) || ["__proto__", "constructor", "prototype"].includes(key)) { exact = false; continue; }
            const v = raw[key];
            if (kind === "number" || kind === "text") {
                if ((kind === "number" ? number(v) : text(v))) out[key] = v;
                else exact = false;
            } else if (kind === "periods") {
                if (Array.isArray(v)) out[key] = v.map(p => copy(p, "period"));
                else { out[key] = null; exact = false; }
            } else out[key] = copy(v, kind);
        }
        return out;
    };
    const snapshot = copy(value, "tariff");
    const validSide = (side: unknown) => {
        if (!object(side) || side.version !== 1 || side.currency !== "GBP" || !text(side.name) || !text(side.utility)
            || !object(side.seasons) || !object(side.energy_charges)) return false;
        const seasonNames = Object.keys(side.seasons);
        if (!seasonNames.length || JSON.stringify(seasonNames.sort()) !== JSON.stringify(Object.keys(side.energy_charges).sort())) return false;
        // Enumerate leap-year calendar dates: every possible recurring date must
        // belong to exactly one season. Every weekday must have full minute cover.
        const coverage = Array(366).fill(0);
        const ordinal = (month: unknown, day: unknown) => {
            if (!Number.isInteger(month) || !Number.isInteger(day)) return -1;
            const date = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
            return date.getUTCMonth() + 1 === month && date.getUTCDate() === day
                ? (date.getTime() - Date.UTC(2000, 0, 1)) / 86400000 : -1;
        };
        for (const name of seasonNames) {
            const season = side.seasons[name], charge = side.energy_charges[name];
            if (!object(season) || !object(charge) || !object(charge.rates) || !object(season.tou_periods)) return false;
            const from = ordinal(season.fromMonth, season.fromDay), to = ordinal(season.toMonth, season.toDay);
            if (from < 0 || to < 0) return false;
            for (let day = 0; day < 366; day++) if (from <= to ? day >= from && day <= to : day >= from || day <= to) coverage[day]++;
            const labels = Object.keys(season.tou_periods);
            if (!labels.length || JSON.stringify(labels.sort()) !== JSON.stringify(Object.keys(charge.rates).sort())) return false;
            const week: Array<Array<[number, number]>> = Array.from({ length: 7 }, () => []);
            for (const label of labels) {
                if (!number(charge.rates[label]) || Number(charge.rates[label]) < 0) return false;
                const tou = season.tou_periods[label];
                if (!object(tou) || !Array.isArray(tou.periods) || !tou.periods.length) return false;
                for (const p of tou.periods) {
                    if (!object(p) || Object.values(p).some(n => !Number.isInteger(n))) return false;
                    const { fromDayOfWeek: fd, toDayOfWeek: td, fromHour: fh, toHour: th, fromMinute: fm, toMinute: tm } = p as Record<string, number>;
                    if (![fd, td, fh, th, fm, tm].every(Number.isInteger) || fd < 0 || td > 6 || td < fd
                        || fh < 0 || fh > 23 || th < 0 || th > 23 || fm < 0 || fm > 59 || tm < 0 || tm > 59) return false;
                    const start = fh * 60 + fm, end = th === 0 && tm === 0 ? 1440 : th * 60 + tm;
                    if (end <= start) return false; // Overnight runs must be split explicitly.
                    for (let day = fd; day <= td; day++) week[day].push([start, end]);
                }
            }
            for (const ranges of week) {
                let end = 0;
                for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) { if (from !== end) return false; end = to; }
                if (end !== 1440) return false;
            }
        }
        return coverage.every(n => n === 1);
    };
    const valid = object(snapshot) && validSide(snapshot) && validSide(snapshot.sell_tariff);
    return { snapshot, exact: exact && valid, tariff: exact && valid ? snapshot as TeslaTariffFragment : null };
}

/** Synthetic full-year flat test, not a HEP production forecast or request body. */
export function experimentTariff(): TeslaTariffFragment {
    const side = (rate: number) => ({ version: 1 as const, currency: "GBP", name: "HEP pricing constraint experiment", utility: "HEP experiment only",
        energy_charges: { Annual: { rates: { TEST: rate } } },
        seasons: { Annual: { fromMonth: 1, fromDay: 1, toMonth: 12, toDay: 31,
            tou_periods: { TEST: { periods: [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 0, toMinute: 0 }] } } } },
    });
    return { ...side(0.0299), sell_tariff: side(0.175) };
}
