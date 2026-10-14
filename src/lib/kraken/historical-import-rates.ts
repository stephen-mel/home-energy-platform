import type { PriceInputWindow } from "../tariff/types";

export type KrakenHistoricalImportRates = {
    status: "available";
    accountRef: string;
    meterPointRef: string;
    observedAt: string;
    period: { start: string; end: string };
    vatBasis: "corroborated-not-independent";
    windows: PriceInputWindow[];
};
export type KrakenHistoricalImportRatesResult = KrakenHistoricalImportRates | { status: "unavailable"; code: string };

const timestamp = (value: unknown) => {
    if (typeof value !== "string") throw Error("HISTORICAL_RATE_TIMESTAMP_INVALID");
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
    if (!match) throw Error("HISTORICAL_RATE_TIMESTAMP_INVALID");
    const [, year, month, day, hour, minute, second, fraction = "", zone, sign, offsetHour = "0", offsetMinute = "0"] = match;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const milliseconds = Number(fraction.padEnd(3, "0"));
    const local = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], milliseconds);
    const check = new Date(local);
    if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() !== parts[1] - 1 || check.getUTCDate() !== parts[2]
        || check.getUTCHours() !== parts[3] || check.getUTCMinutes() !== parts[4] || check.getUTCSeconds() !== parts[5]
        || parts[3] > 23 || parts[4] > 59 || parts[5] > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59)
        throw Error("HISTORICAL_RATE_TIMESTAMP_INVALID");
    const offset = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
    return new Date(local - offset * 60_000).toISOString();
};
const instant = (value: unknown) => Date.parse(timestamp(value));
const decimal = (value: unknown) => typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    && Number.isFinite(Number(value)) ? Number(value) : NaN;
const record = (value: unknown, keys: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
        throw Error("HISTORICAL_RATE_ROW_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")
        || Object.keys(descriptors).sort().join("\0") !== [...keys].sort().join("\0")
        || Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable))
        throw Error("HISTORICAL_RATE_ROW_INVALID");
    return value as Record<string, unknown>;
};

/** Validates the detached result of a fully traversed applicableRates connection. */
export function validateHistoricalImportRates(input: unknown, expected: { accountRef: string; meterPointRef: string;
    observedAt: string; period: { start: string; end: string }; agreement: { validFrom: string; validTo: string };
    corroboratingValues: number[] }): KrakenHistoricalImportRatesResult {
    try {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("HISTORICAL_RATE_RESPONSE_INVALID");
        const raw = input as Record<string, unknown>;
        if (raw.accountRef !== expected.accountRef || raw.meterPointRef !== expected.meterPointRef)
            throw Error("HISTORICAL_RATE_IDENTITY_MISMATCH");
        const canonicalStart = timestamp(expected.period.start), canonicalEnd = timestamp(expected.period.end),
            canonicalObservedAt = timestamp(expected.observedAt);
        const start = Date.parse(canonicalStart), end = Date.parse(canonicalEnd), observedAt = Date.parse(canonicalObservedAt);
        if (![start, end, observedAt].every(Number.isFinite) || start >= end) throw Error("HISTORICAL_RATE_PERIOD_INVALID");
        const agreementStart = instant(expected.agreement.validFrom), agreementEnd = instant(expected.agreement.validTo);
        if (!Number.isFinite(agreementStart) || !Number.isFinite(agreementEnd) || start < agreementStart || end > agreementEnd)
            throw Error("HISTORICAL_RATE_OUTSIDE_AGREEMENT");
        if (raw.complete !== true || !Array.isArray(raw.edges)) throw Error("HISTORICAL_RATE_PAGINATION_INCOMPLETE");
        const cursors = new Set<string>();
        const rows = raw.edges.map((item, index) => {
            const edge = record(item, ["cursor", "node"]);
            if (typeof edge.cursor !== "string" || !edge.cursor || cursors.has(edge.cursor)
                || !edge.node)
                throw Error("HISTORICAL_RATE_ROW_INVALID");
            cursors.add(edge.cursor);
            const row = record(edge.node, ["value", "validFrom", "validTo"]),
                fromIso = timestamp(row.validFrom), toIso = timestamp(row.validTo),
                from = Date.parse(fromIso), to = Date.parse(toIso), value = decimal(row.value);
            if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(value) || from >= to
                || from % 60_000 !== 0 || to % 60_000 !== 0) throw Error("HISTORICAL_RATE_ROW_INVALID");
            return { index, from, to, value };
        }).sort((a, b) => a.from - b.from || a.to - b.to);
        let cursor = start;
        for (const row of rows) {
            if (row.from !== cursor || row.to > end) throw Error(row.from < cursor ? "HISTORICAL_RATE_OVERLAP" : "HISTORICAL_RATE_GAP");
            if (!expected.corroboratingValues.some(value => value === row.value)) throw Error("HISTORICAL_RATE_VALUE_CONTRADICTION");
            cursor = row.to;
        }
        if (cursor !== end) throw Error("HISTORICAL_RATE_GAP");
        const windows: PriceInputWindow[] = rows.map(row => ({ start: new Date(row.from).toISOString(), end: new Date(row.to).toISOString(),
            price: { amount: Number((row.value / 100).toPrecision(15)), currency: "GBP", unit: "kWh" }, kind: "standard",
            condition: "none", sources: [{ provider: "eon-next-kraken", description: "Historical applicable import rate",
                observedAt: new Date(observedAt).toISOString(), stale: false }] }));
        return structuredClone(Object.freeze({ status: "available", accountRef: expected.accountRef,
            meterPointRef: expected.meterPointRef, observedAt: new Date(observedAt).toISOString(),
            period: { start: canonicalStart, end: canonicalEnd },
            vatBasis: "corroborated-not-independent", windows })) as KrakenHistoricalImportRates;
    } catch (error) {
        return { status: "unavailable", code: error instanceof Error ? error.message : "HISTORICAL_RATE_RESPONSE_INVALID" };
    }
}
