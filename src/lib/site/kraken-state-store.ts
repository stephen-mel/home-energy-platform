import "server-only";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KrakenState } from "./kraken-state";

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
const parseState = object<Omit<KrakenState, "stale">>({
    lastSuccessfulUpdate: timestamp,
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
        plannedDispatches: array(object({
            start: string, end: string, type: string, energyAddedKwh: nullable(string),
        })),
        status: object({
            currentState: nullable(string), isSuspended: nullable(boolean),
            stateOfCharge: nullable(object({ value: nullable(number) })),
            activePower: nullable(object({ value: nullable(number) })),
        }),
    })),
});

export async function readLastKnownKrakenState(): Promise<KrakenState | null> {
    try {
        const raw = await readFile(cacheFile, "utf8");
        if (Buffer.byteLength(raw) > MAX_BYTES) return null;
        const envelope = JSON.parse(raw);
        if (envelope?.version !== 1) return null;
        return { ...parseState(envelope.state), stale: true };
    } catch {
        // Missing files, invalid data, permissions and disk failures are cache misses.
        return null;
    }
}

export async function writeLastKnownKrakenState(state: KrakenState): Promise<void> {
    let temporary: string | undefined;
    try {
        if (state.stale) return;
        const contents = JSON.stringify({ version: 1, state: parseState(state) });
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
