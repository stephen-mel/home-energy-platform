import { economicInstant } from "../tariff/resolve-economic-model";

/** Supplied read evidence, NOT an authentication capability. A future trusted
 * caller must supply complete account-scoped device enumeration and raw dispatch
 * lists before the legacy client's null-to-empty coercion. */
export type ScheduleRead = {
    scopeId: string;
    startedAt: string;
    retrievedAt: string;
    status: "complete" | "failed" | "incomplete";
    provenance: "authenticated-query" | "disk" | "manual";
    vehicles: unknown;
};
export type ObservedSession = {
    start: string; end: string; startMs: number; endMs: number;
    type: string; energyAddedKwh: string | null;
};
export type ScheduleObservation = {
    scopeId: string; startedAt: string; retrievedAt: string;
    provenance: "authenticated-query";
    vehicles: { id: string; name: string; sessions: ObservedSession[] }[];
    contentKey: string;
};
export type ScheduleRevision = {
    structuralChanged: boolean; coverageChanged: boolean;
    added: { vehicleId: string; session: ObservedSession }[];
    removed: { vehicleId: string; session: ObservedSession }[];
    addedVehicles: string[]; removedVehicles: string[];
};
export type ObservationUpdate = {
    status: "initial" | "unchanged" | "changed" | "unknown";
    code: "ACCEPTED" | "READ_NOT_COMPLETE" | "INVALID_READ" | "SCOPE_MISMATCH" | "OVERLAPPING_OR_OUT_OF_ORDER";
    current: ScheduleObservation | null;
    lastKnown: boolean;
    revision: ScheduleRevision | null;
};
function freeze<T>(v: T): T {
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
        Object.values(v).forEach(freeze); Object.freeze(v);
    }
    return v;
}
// Copy descriptor values once, before validation. Never invoke accessors or copy
// mutable built-ins into a graph that Object.freeze cannot make immutable.
function snapshot(value: unknown, path = new Set<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value !== "object" || path.has(value)) throw Error();
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    const constructor = proto && Object.getOwnPropertyDescriptor(proto, "constructor");
    if (proto !== null && Reflect.ownKeys(proto).map(String).sort().join() !==
        Reflect.ownKeys(array ? Array.prototype : Object.prototype).map(String).sort().join()) throw Error();
    if (array ? !constructor || !("value" in constructor) || constructor.value !== Array
        && !(typeof constructor.value === "function" && constructor.value.name === "Array")
        : proto !== null && (Object.getPrototypeOf(proto) !== null || !constructor
            || !("value" in constructor) || typeof constructor.value !== "function" || constructor.value.name !== "Object")) throw Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(k => typeof k !== "string")) throw Error();
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    path.add(value);
    const keys = Object.keys(descriptors);
    if (array && (keys.length !== descriptors.length.value + 1
        || keys.some(k => k !== "length" && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= descriptors.length.value)))) throw Error();
    for (const key of keys) {
        const d = descriptors[key];
        if (!("value" in d)) throw Error();
        if (array && key === "length") continue;
        if (!d.enumerable) throw Error();
        Object.defineProperty(result, key, { value: snapshot(d.value, path), enumerable: true, writable: true, configurable: true });
    }
    path.delete(value);
    return result;
}
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const key = (s: ObservedSession) => JSON.stringify([s.startMs, s.endMs, s.type, s.energyAddedKwh]);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function observe(read: ScheduleRead): ScheduleObservation {
    const start = economicInstant(read.startedAt), end = economicInstant(read.retrievedAt);
    if (!text(read.scopeId) || !Number.isFinite(start) || !Number.isFinite(end) || end < start
        || !Array.isArray(read.vehicles) || read.vehicles.length > 100) throw Error();
    const ids = new Set<string>();
    const vehicles = Array.from(read.vehicles, v => {
        if (!v || !text(v.id) || !text(v.name) || ids.has(v.id)
            || !Array.isArray(v.plannedDispatches) || v.plannedDispatches.length > 1000) throw Error();
        ids.add(v.id);
        const seen = new Set<string>();
        const sessions = Array.from(v.plannedDispatches, (raw: unknown) => {
            if (!raw || typeof raw !== "object") throw Error();
            const d = raw as Record<string, unknown>;
            const startMs = economicInstant(d.start), endMs = economicInstant(d.end);
            if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text(d.type)
                || !(d.energyAddedKwh === null || (typeof d.energyAddedKwh === "string"
                    && /^-?\d+(?:\.\d+)?$/.test(d.energyAddedKwh)))) throw Error();
            const session = { start: d.start as string, end: d.end as string, startMs, endMs,
                type: d.type, energyAddedKwh: d.energyAddedKwh as string | null };
            if (seen.has(key(session))) throw Error(); // Do not silently discard duplicate evidence.
            seen.add(key(session)); return session;
        }).sort((a, b) => order(key(a), key(b)));
        return { id: v.id as string, name: v.name as string, sessions };
    }).sort((a, b) => order(a.id, b.id));
    // Names and retrieval/offset spelling are provenance, not schedule revisions.
    const contentKey = JSON.stringify([read.scopeId, vehicles.map(v => [v.id, v.sessions.map(key)])]);
    return freeze({ scopeId: read.scopeId, startedAt: read.startedAt, retrievedAt: read.retrievedAt,
        provenance: "authenticated-query", vehicles, contentKey });
}
function coverage(o: ScheduleObservation): string {
    return JSON.stringify(o.vehicles.flatMap(v => [...new Set(v.sessions.map(s => s.type))].sort().map(type => {
        const spans: number[][] = [];
        for (const s of v.sessions.filter(s => s.type === type).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
            const last = spans.at(-1);
            if (last && s.startMs <= last[1]) last[1] = Math.max(last[1], s.endMs);
            else spans.push([s.startMs, s.endMs]);
        }
        return [v.id, type, spans];
    })));
}
function difference(previous: ScheduleObservation, next: ScheduleObservation): ScheduleRevision {
    const rows = (o: ScheduleObservation) => o.vehicles.flatMap(v => v.sessions.map(session => ({ vehicleId: v.id, session })));
    const identity = (r: ReturnType<typeof rows>[number]) => JSON.stringify([r.vehicleId, key(r.session)]);
    const before = rows(previous), after = rows(next);
    const oldKeys = new Set(before.map(identity)), newKeys = new Set(after.map(identity));
    return { structuralChanged: previous.contentKey !== next.contentKey, coverageChanged: coverage(previous) !== coverage(next),
        added: after.filter(r => !oldKeys.has(identity(r))), removed: before.filter(r => !newKeys.has(identity(r))),
        addedVehicles: next.vehicles.filter(v => !previous.vehicles.some(p => p.id === v.id)).map(v => v.id),
        removedVehicles: previous.vehicles.filter(v => !next.vehicles.some(p => p.id === v.id)).map(v => v.id) };
}
/** Pure, bounded latest-observation transition. No I/O/history retention. Changes
 * are observed differences, never cancellation events or economic authority.
 * Previous must be an observation from this layer, not a legacy KrakenState. */
export function updateScheduleObservation(previous: ScheduleObservation | null, read: ScheduleRead): ObservationUpdate {
    // Detach prior output too, so freezing revision rows never freezes a caller's
    // plain-data copy. Previous remains subject to the documented layer contract.
    try { previous = snapshot(previous) as ScheduleObservation | null; }
    catch { return freeze({ status: "unknown", code: "INVALID_READ", current: null, lastKnown: false, revision: null }); }
    const unknown = (code: ObservationUpdate["code"]): ObservationUpdate => freeze({ status: "unknown", code,
        current: previous ? structuredClone(previous) : null, lastKnown: previous !== null, revision: null });
    try { read = snapshot(read) as ScheduleRead; } catch { return unknown("INVALID_READ"); }
    if (read?.status !== "complete" || read.provenance !== "authenticated-query") return unknown("READ_NOT_COMPLETE");
    let next: ScheduleObservation;
    try { next = observe(read); } catch { return unknown("INVALID_READ"); }
    if (previous && previous.scopeId !== next.scopeId) return unknown("SCOPE_MISMATCH");
    if (previous && economicInstant(next.startedAt) <= economicInstant(previous.retrievedAt)) return unknown("OVERLAPPING_OR_OUT_OF_ORDER");
    const revision = previous ? difference(previous, next) : null;
    return freeze({ status: !revision ? "initial" : revision.structuralChanged ? "changed" : "unchanged",
        code: "ACCEPTED", current: next, lastKnown: false, revision });
}
