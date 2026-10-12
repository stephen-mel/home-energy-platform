import type { EnergyPrice } from "../tariff/types";

export const KRAKEN_EXPORT_TARIFF_MAX_AGE_MS = 60_000;

export type KrakenExportTariffEvidence = {
    status: "available";
    accountRef: string;
    observedAt: string;
    agreement: {
        validFrom: string;
        validTo: string;
        productCode: string;
        tariffCode: string;
    };
    price: EnergyPrice;
};

export type KrakenExportTariffResult = KrakenExportTariffEvidence | {
    status: "unavailable";
    code: string;
};

const own = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!(prototype === null || Object.getPrototypeOf(prototype) === null && constructor
        && "value" in constructor && typeof constructor.value === "function" && constructor.value.name === "Object"))
        throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    return descriptor.value;
};
const text = (value: unknown) => {
    if (typeof value !== "string" || !value) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    return value;
};
const timestamp = (value: unknown) => {
    const result = text(value);
    const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?(Z|([+-])(\d\d):(\d\d))$/.exec(result);
    if (!match) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    const [, year, month, day, hour, minute, second, fraction = "", zone, sign, offsetHour = "0", offsetMinute = "0"] = match;
    const values = [year, month, day, hour, minute, second].map(Number);
    const local = Date.UTC(values[0], values[1] - 1, values[2], values[3], values[4], values[5], Number(fraction.padEnd(3, "0")));
    const check = new Date(local);
    if (check.getUTCFullYear() !== values[0] || check.getUTCMonth() !== values[1] - 1 || check.getUTCDate() !== values[2]
        || check.getUTCHours() !== values[3] || check.getUTCMinutes() !== values[4] || check.getUTCSeconds() !== values[5]
        || Number(offsetHour) > 23 || Number(offsetMinute) > 59) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    const offset = zone === "Z" ? 0 : (sign === "+" ? 1 : -1) * (Number(offsetHour) * 60 + Number(offsetMinute));
    return new Date(local - offset * 60_000).toISOString();
};
const array = (value: unknown) => {
    if (!Array.isArray(value)) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isInteger(length.value)) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
    return Array.from({ length: length.value }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw Error("MALFORMED_EXPORT_TARIFF_RESPONSE");
        return descriptor.value;
    });
};

/** Validates one authenticated response from the explicitly configured export account.
 * Kraken StandardTariff monetary fields are p/kWh; HEP stores GBP/kWh. */
export function validateKrakenExportTariff(input: unknown, expected: {
    accountRef: string;
    importAccountRef?: string;
    observedAt: string;
    productCode?: string;
    tariffCode?: string;
}): KrakenExportTariffResult {
    try {
        if (!expected.productCode || !expected.tariffCode) throw Error("SITE_EXPORT_TARIFF_IDENTITY_UNCONFIGURED");
        if (expected.importAccountRef === expected.accountRef) throw Error("EXPORT_ACCOUNT_NOT_DISTINCT");
        if (own(input, "rateUnit") !== "p/kWh") throw Error("EXPORT_RATE_UNIT_UNSUPPORTED");
        if (text(own(input, "accountRef")) !== expected.accountRef) throw Error("EXPORT_ACCOUNT_MISMATCH");
        const agreements = array(own(input, "electricityAgreements"));
        if (agreements.length !== 1) throw Error("EXPORT_AGREEMENT_NOT_UNIQUE");
        const agreement = agreements[0];
        const validFrom = timestamp(own(agreement, "validFrom"));
        const validTo = timestamp(own(agreement, "validTo"));
        const observedAt = timestamp(expected.observedAt);
        if (Date.parse(validTo) <= Date.parse(validFrom) || Date.parse(observedAt) < Date.parse(validFrom)
            || Date.parse(observedAt) >= Date.parse(validTo) || own(agreement, "isRevoked") !== false)
            throw Error("EXPORT_AGREEMENT_INACTIVE");
        const meterPoint = own(agreement, "meterPoint");
        if (own(meterPoint, "direction") !== "EXPORT") throw Error("NOT_EXPORT_AGREEMENT");
        const tariff = own(agreement, "tariff");
        if (own(tariff, "__typename") !== "StandardTariff" || own(tariff, "isExport") !== true)
            throw Error("NOT_EXPORT_TARIFF");
        const productCode = text(own(tariff, "productCode"));
        const tariffCode = text(own(tariff, "tariffCode"));
        if (productCode !== expected.productCode || tariffCode !== expected.tariffCode)
            throw Error("EXPORT_TARIFF_IDENTITY_MISMATCH");
        const unitRate = own(tariff, "unitRate"), preVatUnitRate = own(tariff, "preVatUnitRate");
        if (typeof unitRate !== "number" || !Number.isFinite(unitRate) || unitRate < 0
            || typeof preVatUnitRate !== "number" || !Number.isFinite(preVatUnitRate) || preVatUnitRate < 0)
            throw Error("EXPORT_RATE_INVALID");
        const result: KrakenExportTariffEvidence = { status: "available", accountRef: expected.accountRef, observedAt,
            agreement: { validFrom, validTo, productCode, tariffCode },
            price: { amount: Number((unitRate / 100).toPrecision(15)), currency: "GBP", unit: "kWh" } };
        return structuredClone(Object.freeze(result));
    } catch (error) {
        return { status: "unavailable", code: error instanceof Error ? error.message : "MALFORMED_EXPORT_TARIFF_RESPONSE" };
    }
}
