import "server-only";
import { parseDispatchResponse, requireCompleteDispatches } from "../kraken/dispatch-response";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KrakenState } from "./kraken-state";
import type { KrakenImportTariffEvidence } from "../kraken/import-tariff";
import type { KrakenExportTariffEvidence } from "../kraken/export-tariff";
import type { KrakenHistoricalImportRates } from "../kraken/historical-import-rates";

// Local single-site adapter. Replace these two operations with per-site storage
// before sharing a deployment between accounts. Never use the public directory.
const cacheFile = join(process.cwd(), ".cache", "home-energy-platform", "kraken-state.json");
const MAX_BYTES = 2 * 1024 * 1024;

type Parser<T> = (input: unknown) => T;
const string: Parser<string> = input => {
    if (typeof input !== "string") throw new Error("Invalid string");
    return input;
};
const number: Parser<number> = input => {
    if (typeof input !== "number" || !Number.isFinite(input)) throw new Error("Invalid number");
    return input;
};
const boolean: Parser<boolean> = input => {
    if (typeof input !== "boolean") throw new Error("Invalid boolean");
    return input;
};
const nullable = <T>(parse: Parser<T>): Parser<T | null> => input => input === null ? null : parse(input);
const optional = <T>(parse: Parser<T>): Parser<T | undefined> => input => input === undefined ? undefined : parse(input);
const array = <T>(parse: Parser<T>): Parser<T[]> => input => {
    if (!Array.isArray(input)) throw new Error("Invalid array");
    return input.map(parse);
};
const object = <T>(fields: { [K in keyof T]: Parser<T[K]> }): Parser<T> => input => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid object");
    const source = input as Record<string, unknown>;
    // Reconstruct only allowlisted fields, including nested objects. Never serialize
    // the original object: upstream responses may contain extra sensitive fields.
    return Object.fromEntries(Object.entries(fields).map(([key, parse]) =>
        [key, (parse as Parser<unknown>)(source[key])])) as T;
};
const timestamp: Parser<string> = input => {
    const value = string(input);
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new Error("Invalid timestamp");
    }
    return value;
};
const recordingStatus: Parser<NonNullable<KrakenState["scheduleRecording"]>["status"]> = input => {
    if (!["persisted", "already-recorded", "rejected", "busy", "invalid", "store-failed", "indeterminate"].includes(input as string)) {
        throw new Error("Invalid recording status");
    }
    return input as NonNullable<KrakenState["scheduleRecording"]>["status"];
};
const recordingChange: Parser<NonNullable<KrakenState["scheduleRecording"]>["change"]> = input => {
    if (!(input === null || input === "initial" || input === "unchanged" || input === "changed")) throw new Error("Invalid recording change");
    return input;
};
const energyPrice = object({ amount: number, currency: string, unit: (input => {
    if (input !== "kWh") throw new Error("Invalid unit"); return input;
}) as Parser<"kWh"> });
const importTariff: Parser<KrakenImportTariffEvidence> = object({
    status: (input => { if (input !== "available") throw new Error("Invalid tariff status"); return input; }) as Parser<"available">,
    accountRef: string, observedAt: timestamp, exportStatus: (input => {
        if (input !== "unknown") throw new Error("Invalid export status"); return input;
    }) as Parser<"unknown">,
    agreement: object({ validFrom: timestamp, validTo: timestamp, productCode: string, tariffCode: string, meterPointRef: string }),
    version: object({ id: string, name: string, provider: string, effectiveFrom: timestamp, effectiveTo: timestamp,
        pricesIncludeVat: boolean, normalImport: nullable(energyPrice), export: nullable(energyPrice),
        scheduledChargingImport: nullable(energyPrice),
        standingCharge: nullable(object({ amount: number, currency: string, unit: (input => {
            if (input !== "day") throw new Error("Invalid unit"); return input;
        }) as Parser<"day"> })),
        dailyImportWindows: array(object({ start: string, end: string,
            kind: (input => { if (input !== "standard" && input !== "guaranteed-off-peak") throw new Error("Invalid kind"); return input; }) as Parser<"standard" | "guaranteed-off-peak">,
            price: nullable(energyPrice) })) }),
});
const exportTariff: Parser<KrakenExportTariffEvidence> = object({
    status: (input => { if (input !== "available") throw new Error("Invalid tariff status"); return input; }) as Parser<"available">,
    accountRef: string, observedAt: timestamp,
    agreement: object({ validFrom: timestamp, validTo: timestamp, productCode: string, tariffCode: string }),
    price: energyPrice,
});
const historicalImportRates: Parser<KrakenHistoricalImportRates> = object({
    status: (input => { if (input !== "available") throw new Error("Invalid historical status"); return input; }) as Parser<"available">,
    accountRef: string, meterPointRef: string, observedAt: timestamp,
    period: object({ start: timestamp, end: timestamp }),
    vatBasis: (input => { if (input !== "corroborated-not-independent") throw new Error("Invalid VAT basis"); return input; }) as Parser<"corroborated-not-independent">,
    windows: array(object({ start: timestamp, end: timestamp, price: nullable(energyPrice),
        kind: (input => { if (input !== "standard") throw new Error("Invalid kind"); return input; }) as Parser<"standard">,
        condition: (input => { if (input !== "none") throw new Error("Invalid condition"); return input; }) as Parser<"none">,
        sources: array(object({ provider: string, description: string, tariffVersion: optional(string),
            observedAt: nullable(timestamp), stale: boolean, cause: optional(object({ kind: (input => {
                if (input !== "ev-dispatch") throw new Error("Invalid cause"); return input;
            }) as Parser<"ev-dispatch">, assetId: string, assetName: optional(string), start: timestamp, end: timestamp, dispatchType: string })) })) })),
});
const parseState = object<Omit<KrakenState, "stale">>({
    lastSuccessfulUpdate: timestamp,
    scheduleRecording: optional(object({ status: recordingStatus, change: recordingChange, code: nullable(string) })),
    importTariff: optional(importTariff),
    importTariffDiagnostic: optional(object({
        status: (input => { if (input !== "unavailable") throw new Error("Invalid tariff status"); return input; }) as Parser<"unavailable">,
        code: string,
    })),
    exportTariff: optional(exportTariff),
    exportTariffDiagnostic: optional(object({
        status: (input => { if (input !== "unavailable") throw new Error("Invalid tariff status"); return input; }) as Parser<"unavailable">,
        code: string,
    })),
    historicalImportRates: optional(historicalImportRates),
    historicalImportRatesDiagnostic: optional(object({
        status: (input => { if (input !== "unavailable") throw new Error("Invalid tariff status"); return input; }) as Parser<"unavailable">,
        code: string,
    })),
    vehicles: array(object({
        id: string, name: string, deviceType: string, provider: string,
        vehicleBatterySize: nullable(string), chargePointPowerOutput: nullable(string),
        preferences: nullable(object({ schedules: array(object({
            dayOfWeek: string, time: string, min: nullable(number),
            max: nullable(number), upperLimit: nullable(number),
        })) })),
        preferenceSetting: nullable(object({ scheduleSettings: array(object({
            timeFrom: nullable(string), timeTo: nullable(string), timeStep: number,
            min: nullable(string), max: nullable(string), step: string,
        })) })),
        plannedDispatches: input => requireCompleteDispatches(parseDispatchResponse({ flexPlannedDispatches: input })),
        status: object({
            currentState: nullable(string), isSuspended: nullable(boolean),
            stateOfCharge: nullable(object({ value: nullable(number) })),
            activePower: nullable(object({ value: nullable(number) })),
        }),
    })),
});

export async function readLastKnownKrakenState(scopeId: string): Promise<KrakenState | null> {
    try {
        const raw = await readFile(cacheFile, "utf8");
        if (Buffer.byteLength(raw) > MAX_BYTES) return null;
        const envelope = JSON.parse(raw);
        // Earlier files are not scope-bound and cannot safely cross an account change.
        if (envelope?.version !== 3 || envelope.scopeId !== scopeId) return null;
        return { ...parseState(envelope.state), stale: true };
    } catch {
        // Missing files, invalid data, permissions and disk failures are cache misses.
        return null;
    }
}

export async function writeLastKnownKrakenState(scopeId: string, state: KrakenState): Promise<void> {
    let temporary: string | undefined;
    try {
        if (state.stale) return;
        if (typeof scopeId !== "string" || !scopeId) return;
        const contents = JSON.stringify({ version: 3, scopeId, state: parseState(state) });
        if (Buffer.byteLength(contents) > MAX_BYTES) return;
        await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 });
        temporary = `${cacheFile}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        // Atomic replacement keeps the previous good file intact if a write fails.
        await rename(temporary, cacheFile);
    } catch {
        // Persistence is best-effort and must never hide a successful live response.
    } finally {
        if (temporary) await unlink(temporary).catch(() => {});
    }
}
