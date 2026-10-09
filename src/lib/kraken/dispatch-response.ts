import { economicInstant } from "../tariff/resolve-economic-model";

export type KrakenPlannedDispatch = {
    start: string; end: string; type: string; energyAddedKwh: string | null;
};
export type DispatchResponse =
    | { status: "complete"; dispatches: KrakenPlannedDispatch[]; explicitlyEmpty: boolean }
    | { status: "incomplete"; code: "DISPATCH_FIELD_MISSING" | "DISPATCH_FIELD_NULL" | "DISPATCH_RESPONSE_MALFORMED" }
    | { status: "failed"; code: "DISPATCH_RETRIEVAL_FAILED" };

// Inspect own data properties only. Network JSON is plain data; never invoke an
// accessor or convert a malformed response/record into an empty schedule.
function field(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d)) throw Error();
    return d.value;
}
export function parseDispatchResponse(data: unknown): DispatchResponse {
    try {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
        if (!Object.hasOwn(data, "flexPlannedDispatches")) return { status: "incomplete", code: "DISPATCH_FIELD_MISSING" };
        const raw = field(data, "flexPlannedDispatches");
        if (raw === null) return { status: "incomplete", code: "DISPATCH_FIELD_NULL" };
        if (!Array.isArray(raw)) throw Error();
        const descriptor = Object.getOwnPropertyDescriptor(raw, "length");
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== false
            || descriptor.configurable !== false || typeof descriptor.value !== "number"
            || !Number.isInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 0xffffffff) throw Error();
        const length = descriptor.value;
        const keys = Reflect.ownKeys(raw);
        if (keys.length !== length + 1 || keys.some(k => k !== "length"
            && (typeof k !== "string" || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= length))) throw Error();
        const dispatches: KrakenPlannedDispatch[] = [];
        for (let i = 0; i < length; i++) {
            const entry = Object.getOwnPropertyDescriptor(raw, String(i));
            if (!entry || !("value" in entry) || entry.enumerable !== true) throw Error();
            const d = entry.value;
            const start = field(d, "start"), end = field(d, "end"), type = field(d, "type"), energy = field(d, "energyAddedKwh");
            if (typeof start !== "string" || typeof end !== "string" || !Number.isFinite(economicInstant(start))
                || !(economicInstant(end) > economicInstant(start)) || typeof type !== "string" || !type.trim()
                || !(energy === null || (typeof energy === "string" && /^-?\d+(?:\.\d+)?$/.test(energy)))) throw Error();
            dispatches.push({ start, end, type, energyAddedKwh: energy });
        }
        return { status: "complete", explicitlyEmpty: dispatches.length === 0, dispatches };
    } catch { return { status: "incomplete", code: "DISPATCH_RESPONSE_MALFORMED" }; }
}
/** Compatibility projection: never substitutes [] for incomplete/failed data. */
export function requireCompleteDispatches(result: DispatchResponse): KrakenPlannedDispatch[] {
    if (result.status !== "complete") throw new Error(result.code);
    return result.dispatches;
}
