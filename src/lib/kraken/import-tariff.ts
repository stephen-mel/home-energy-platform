import type { TariffVersion } from "../tariff/types";

export const KRAKEN_IMPORT_TARIFF_MAX_AGE_MS = 60_000;

export type KrakenImportTariffEvidence = {
    status: "available";
    accountRef: string;
    observedAt: string;
    agreement: { validFrom: string; validTo: string; productCode: string; tariffCode: string; meterPointRef: string };
    version: TariffVersion;
    exportStatus: "unknown";
};

export type KrakenImportTariffResult = KrakenImportTariffEvidence | {
    status: "unavailable";
    code: string;
};

const money = (amount: number) => ({ amount, currency: "GBP", unit: "kWh" as const });
const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("MALFORMED_TARIFF_RESPONSE");
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!(prototype === null || Object.getPrototypeOf(prototype) === null && constructor
        && "value" in constructor && typeof constructor.value === "function" && constructor.value.name === "Object"))
        throw Error("MALFORMED_TARIFF_RESPONSE");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw Error("MALFORMED_TARIFF_RESPONSE");
    return descriptor.value;
};
const text = (value: unknown) => {
    if (typeof value !== "string" || !value) throw Error("MALFORMED_TARIFF_RESPONSE");
    return value;
};
const timestamp = (value: unknown) => {
    const result = text(value);
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/.exec(result);
    if (!match) throw Error("MALFORMED_TARIFF_RESPONSE");
    const [, year, month, day, hour, minute, second, fraction = "", zone, sign, offsetHour = "0", offsetMinute = "0"] = match;
    const values = [year, month, day, hour, minute, second].map(Number);
    const local = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5], Number(fraction.padEnd(3, "0")));
    const check = new Date(local);
    if (check.getUTCFullYear() !== values[0] || check.getUTCMonth() !== values[1] - 1 || check.getUTCDate() !== values[2]
        || check.getUTCHours() !== values[3] || check.getUTCMinutes() !== values[4] || check.getUTCSeconds() !== values[5]
        || Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw Error("MALFORMED_TARIFF_RESPONSE");
    const offset = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
    return new Date(local - offset * 60_000).toISOString();
};
const array = (value: unknown) => {
    if (!Array.isArray(value)) throw Error("MALFORMED_TARIFF_RESPONSE");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isInteger(length.value)) throw Error("MALFORMED_TARIFF_RESPONSE");
    return Array.from({ length: length.value }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw Error("MALFORMED_TARIFF_RESPONSE");
        return descriptor.value;
    });
};
const decimal = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error("MALFORMED_TARIFF_RESPONSE");
    return value;
};
const penceToPounds = (value: number) => Number((value / 100).toPrecision(15));

function localParts(instant: string, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === type)?.value);
    return { date: `${part("year")}-${String(part("month")).padStart(2, "0")}-${String(part("day")).padStart(2, "0")}`,
        minute: part("hour") * 60 + part("minute"), second: part("second") };
}
function nextDate(date: string) {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** Converts one authenticated, account-bound Kraken agreement response into a
 * bounded import-only tariff. Export remains explicitly unknown. */
export function validateKrakenImportTariff(input: unknown, expected: {
    accountRef: string; observedAt: string; timeZone: string;
    tariffCode?: string; meterPointRef?: string;
}): KrakenImportTariffResult {
    try {
        if (!expected.tariffCode || !expected.meterPointRef) throw Error("SITE_TARIFF_IDENTITY_UNCONFIGURED");
        if (text(own(input, "accountRef")) !== expected.accountRef) throw Error("ACCOUNT_MISMATCH");
        const agreements = array(own(input, "electricityAgreements"));
        if (agreements.length !== 1) throw Error("AGREEMENT_NOT_UNIQUE");
        const agreement = agreements[0];
        const validFrom = timestamp(own(agreement, "validFrom"));
        const validTo = timestamp(own(agreement, "validTo"));
        const observedAt = timestamp(expected.observedAt);
        if (Date.parse(validTo) <= Date.parse(validFrom) || Date.parse(observedAt) < Date.parse(validFrom)
            || Date.parse(observedAt) >= Date.parse(validTo) || own(agreement, "isRevoked") !== false) {
            throw Error("AGREEMENT_INACTIVE");
        }
        const meterPoint = own(agreement, "meterPoint");
        if (own(meterPoint, "direction") !== "IMPORT") throw Error("NOT_IMPORT_AGREEMENT");
        const meterPointRef = text(own(meterPoint, "meterPointRef"));
        if (meterPointRef !== expected.meterPointRef) throw Error("METER_POINT_MISMATCH");
        const tariff = own(agreement, "tariff");
        if (own(tariff, "__typename") !== "HalfHourlyTariff" || own(tariff, "isExport") !== false)
            throw Error("NOT_IMPORT_TARIFF");
        const productCode = text(own(tariff, "productCode"));
        const tariffCode = text(own(tariff, "tariffCode"));
        if (productCode !== "NEXT_DRIVE_SMART_V5_2" || tariffCode !== expected.tariffCode)
            throw Error("TARIFF_IDENTITY_MISMATCH");
        const rawRates = array(own(tariff, "unitRates"));
        if (rawRates.length < 2) throw Error("RATE_COVERAGE_INCOMPLETE");
        let cheap: number | null = null, peak: number | null = null, previousEnd: number | null = null;
        let first = "", last = "";
        for (const raw of rawRates) {
            const start = timestamp(own(raw, "validFrom")), end = timestamp(own(raw, "validTo"));
            const startMs = Date.parse(start), endMs = Date.parse(end);
            if (new Date(startMs).getUTCMilliseconds() !== 0 || new Date(endMs).getUTCMilliseconds() !== 0)
                throw Error("RATE_BOUNDARY_NOT_MINUTE_ALIGNED");
            if (endMs <= startMs || (previousEnd !== null && startMs !== previousEnd) || own(raw, "rateType") !== "STANDARD")
                throw Error("RATE_COVERAGE_INCOMPLETE");
            const value = decimal(own(raw, "value"));
            decimal(own(raw, "preVatValue"));
            const from = localParts(start, expected.timeZone), to = localParts(end, expected.timeZone);
            if (from.second !== 0 || to.second !== 0) throw Error("RATE_SCHEDULE_UNSUPPORTED");
            if (from.minute === 0 && to.minute === 360 && from.date === to.date)
                cheap = cheap === null ? value : cheap === value ? cheap : (() => { throw Error("RATE_CONFLICT"); })();
            else if (from.minute === 360 && to.minute === 0 && nextDate(from.date) === to.date)
                peak = peak === null ? value : peak === value ? peak : (() => { throw Error("RATE_CONFLICT"); })();
            else throw Error("RATE_SCHEDULE_UNSUPPORTED");
            first ||= start; last = end; previousEnd = endMs;
        }
        if (cheap === null || peak === null)
            throw Error("RATE_COVERAGE_INCOMPLETE");
        decimal(own(tariff, "standingCharge"));
        decimal(own(tariff, "preVatStandingCharge"));
        const effectiveFrom = Math.max(Date.parse(first), Date.parse(validFrom));
        const effectiveTo = Math.min(Date.parse(last), Date.parse(validTo));
        if (effectiveTo <= effectiveFrom) throw Error("RATE_COVERAGE_OUTSIDE_AGREEMENT");
        const version: TariffVersion = {
            id: productCode.toLowerCase(), name: text(own(tariff, "displayName")), provider: "eon-next-kraken",
            // Economic coverage is bounded by returned rates, not the wider
            // supplier agreement. A later refresh must extend it with evidence.
            effectiveFrom: new Date(effectiveFrom).toISOString(), effectiveTo: new Date(effectiveTo).toISOString(), pricesIncludeVat: true,
            normalImport: money(penceToPounds(peak)), export: null,
            scheduledChargingImport: money(penceToPounds(cheap)),
            // Standing-charge economics are outside this verified import-rate
            // integration and remain unavailable to the canonical plan.
            standingCharge: null,
            dailyImportWindows: [{ start: "00:00", end: "06:00", kind: "guaranteed-off-peak", price: money(penceToPounds(cheap)) }],
        };
        return structuredClone(Object.freeze({ status: "available", accountRef: expected.accountRef, observedAt,
            agreement: { validFrom, validTo, productCode, tariffCode, meterPointRef }, version, exportStatus: "unknown" })) as KrakenImportTariffEvidence;
    } catch (error) {
        return { status: "unavailable", code: error instanceof Error ? error.message : "MALFORMED_TARIFF_RESPONSE" };
    }
}
