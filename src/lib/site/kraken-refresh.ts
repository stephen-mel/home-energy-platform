import "server-only";
import { isAbsolute, join } from "node:path";
import {
    createKrakenReadSession,
    getKrakenAccountReference,
    type KrakenDevice,
    type KrakenVehicleStatus as ClientVehicleStatus,
} from "../kraken/client";
import { requireCompleteDispatches } from "../kraken/dispatch-response";
import {
    scheduleObservationStore,
    scheduleScopeId,
    type ScheduleScope,
    type ScheduleStoreWrite,
} from "../kraken/schedule-store";
import type { ScheduleRead } from "../kraken/schedule-observation";
import {
    readLastKnownKrakenState,
    writeLastKnownKrakenState,
} from "./kraken-state-store";
import type {
    KrakenScheduleRecording,
    KrakenState,
    KrakenVehicleState,
    KrakenVehicleStatus,
} from "./kraken-state";

const CACHE_MS = 60_000;
const DEFAULT_DATABASE = ".cache/home-energy-platform/kraken-observations.sqlite";
const ORDERING_REJECTIONS = new Set([
    "OVERLAPPING_OR_OUT_OF_ORDER", "SCOPE_MISMATCH", "INVALID_READ", "READ_NOT_COMPLETE",
]);

type ReadSession = ReturnType<typeof createKrakenReadSession>;
type Dependencies = {
    now: () => number;
    accountRef: () => string;
    createSession: () => ReadSession;
    record: (scope: ScheduleScope, read: ScheduleRead) => ScheduleStoreWrite;
    readCompatibility: (scopeId: string) => Promise<KrakenState | null>;
    writeCompatibility: (scopeId: string, state: KrakenState) => Promise<void>;
};
type Entry = { state: KrakenState; storedAt: number };

function data(value: unknown, key: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!(prototype === null || Object.getPrototypeOf(prototype) === null && constructor
        && "value" in constructor && typeof constructor.value === "function" && constructor.value.name === "Object")
        || Reflect.ownKeys(value).some(property => typeof property !== "string")) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!("value" in descriptor) || !descriptor.enumerable) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return descriptor.value;
}
function list(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !("value" in item) || !item.enumerable) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
        result.push(item.value);
    }
    if (Reflect.ownKeys(value).length !== result.length + 1) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    return result;
}
const requiredText = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    return value;
};
const nullableText = (value: unknown) => value === null || value === undefined ? null : requiredText(value);
const nullableNumber = (value: unknown) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    return value;
};
function schedules(value: unknown): KrakenVehicleState["preferences"] {
    if (value === null || value === undefined) return null;
    return { schedules: list(data(value, "schedules")).map(item => ({
        dayOfWeek: requiredText(data(item, "dayOfWeek")),
        time: requiredText(data(item, "time")),
        min: nullableNumber(data(item, "min")),
        max: nullableNumber(data(item, "max")),
        upperLimit: nullableNumber(data(item, "upperLimit")),
    })) };
}
function preferenceSetting(value: unknown): KrakenVehicleState["preferenceSetting"] {
    if (value === null || value === undefined) return null;
    return { scheduleSettings: list(data(value, "scheduleSettings")).map(item => {
        const timeStep = data(item, "timeStep");
        if (typeof timeStep !== "number" || !Number.isFinite(timeStep)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
        return { timeFrom: nullableText(data(item, "timeFrom")), timeTo: nullableText(data(item, "timeTo")),
            timeStep, min: nullableText(data(item, "min")), max: nullableText(data(item, "max")),
            step: requiredText(data(item, "step")) };
    }) };
}
function metric(value: unknown): { value: number | null } | null {
    if (value === null || value === undefined) return null;
    return { value: nullableNumber(data(value, "value")) };
}
function status(value: ClientVehicleStatus): KrakenVehicleStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    const currentState = data(value, "currentState"), isSuspended = data(value, "isSuspended");
    if (!(currentState === null || currentState === undefined || typeof currentState === "string")
        || !(isSuspended === null || isSuspended === undefined || typeof isSuspended === "boolean")) {
        throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
    }
    return { currentState: currentState ?? null, isSuspended: isSuspended ?? null,
        stateOfCharge: metric(data(value, "stateOfCharge")), activePower: metric(data(value, "activePower")) };
}
function devices(value: unknown): KrakenDevice[] {
    const ids = new Set<string>();
    return list(value).map(raw => {
        const id = requiredText(data(raw, "id")), name = requiredText(data(raw, "name"));
        if (ids.has(id)) throw Error("KRAKEN_DEVICE_RESPONSE_INVALID");
        ids.add(id);
        return { id, name, deviceType: requiredText(data(raw, "deviceType")),
            provider: requiredText(data(raw, "provider")),
            vehicleBatterySize: nullableText(data(raw, "vehicleBatterySize")),
            chargePointPowerOutput: nullableText(data(raw, "chargePointPowerOutput")),
            preferences: schedules(data(raw, "preferences")),
            preferenceSetting: preferenceSetting(data(raw, "preferenceSetting")) };
    });
}
function recording(result: ScheduleStoreWrite): KrakenScheduleRecording {
    if (result.status === "persisted") return { status: result.status, change: result.change, code: null };
    if (result.status === "rejected") return { status: result.status, change: null, code: result.code };
    return { status: result.status, change: null, code: null };
}
export function krakenObservationDatabasePath(
    configured = process.env.HEP_KRAKEN_OBSERVATION_DB,
    workingDirectory = process.cwd(),
): string {
    if (configured === undefined) return join(workingDirectory, DEFAULT_DATABASE);
    if (!configured.trim() || !isAbsolute(configured)) throw Error("KRAKEN_OBSERVATION_PATH_INVALID");
    return configured;
}
function productionDependencies(): Dependencies {
    return { now: Date.now, accountRef: getKrakenAccountReference, createSession: createKrakenReadSession,
        record: (scope, read) => {
            try { return scheduleObservationStore(krakenObservationDatabasePath()).record(scope, read); }
            catch { return { status: "store-failed" }; }
        },
        readCompatibility: readLastKnownKrakenState,
        writeCompatibility: writeLastKnownKrakenState };
}

/** One process, scope-keyed coordination. SQLite remains the cross-process ordering boundary. */
export function createKrakenRefreshCoordinator(dependencies: Dependencies) {
    const memory = new Map<string, Entry>();
    const flights = new Map<string, Promise<KrakenState>>();
    function classifyAtDelivery(state: KrakenState): KrakenState {
        if (state.stale) return state;
        const retrievedAt = Date.parse(state.lastSuccessfulUpdate);
        if (!Number.isFinite(retrievedAt) || dependencies.now() - retrievedAt >= CACHE_MS) {
            return { ...state, stale: true };
        }
        return state;
    }
    async function refresh(scope: ScheduleScope, scopeId: string): Promise<KrakenState> {
        const startedAt = new Date(dependencies.now()).toISOString();
        try {
            const session = dependencies.createSession();
            if (requiredText(session.accountRef) !== scope.accountRef) throw Error("KRAKEN_ACCOUNT_CONTEXT_CHANGED");
            const enumerated = devices(await session.getDevices());
            const vehicles = await Promise.all(enumerated.map(async device => {
                const [rawStatus, response] = await Promise.all([
                    session.getVehicleStatus(device.id), session.getPlannedDispatchResponse(device.id),
                ]);
                if (response.deviceId !== device.id) throw Error("KRAKEN_DISPATCH_DEVICE_MISMATCH");
                const plannedDispatches = requireCompleteDispatches(response);
                return { ...device, status: status(rawStatus), plannedDispatches };
            }));
            const retrievedAtMs = dependencies.now();
            const retrievedAt = new Date(retrievedAtMs).toISOString();
            const read: ScheduleRead = { scopeId, startedAt, retrievedAt, status: "complete",
                provenance: "authenticated-query", vehicles: vehicles.map(vehicle => ({ id: vehicle.id,
                    name: vehicle.name, plannedDispatches: vehicle.plannedDispatches.map(dispatch => ({ ...dispatch })) })) };
            const stored = dependencies.record(scope, read);
            if (stored.status === "rejected" && ORDERING_REJECTIONS.has(stored.code)) {
                throw Error("KRAKEN_OBSERVATION_REJECTED");
            }
            const state: KrakenState = { vehicles, lastSuccessfulUpdate: retrievedAt, stale: false,
                scheduleRecording: recording(stored) };
            await dependencies.writeCompatibility(scopeId, state);
            // Freshness begins when authenticated retrieval completed, not when
            // best-effort compatibility publication eventually settles.
            memory.set(scopeId, { state, storedAt: retrievedAtMs });
            return state;
        } catch (error) {
            const cached = memory.get(scopeId)?.state ?? await dependencies.readCompatibility(scopeId);
            if (cached) return { ...cached, stale: true };
            throw error;
        }
    }
    return {
        async get(siteId: string): Promise<KrakenState> {
            const scope = { siteId: requiredText(siteId), accountRef: requiredText(dependencies.accountRef()) };
            const scopeId = scheduleScopeId(scope);
            const running = flights.get(scopeId);
            if (running) return classifyAtDelivery(await running);
            const cached = memory.get(scopeId);
            if (cached && !cached.state.stale && dependencies.now() - cached.storedAt < CACHE_MS) {
                return classifyAtDelivery(cached.state);
            }
            const promise = refresh(scope, scopeId);
            flights.set(scopeId, promise);
            try { return classifyAtDelivery(await promise); }
            finally { if (flights.get(scopeId) === promise) flights.delete(scopeId); }
        },
    };
}

const processState = globalThis as typeof globalThis & {
    __hepKrakenRefreshCoordinator?: ReturnType<typeof createKrakenRefreshCoordinator>;
};
const coordinator = processState.__hepKrakenRefreshCoordinator ??=
    createKrakenRefreshCoordinator(productionDependencies());
export const getRecordedKrakenState = (siteId: string) => coordinator.get(siteId);
