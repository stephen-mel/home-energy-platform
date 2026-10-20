import "server-only";
import { isAbsolute, join } from "node:path";
import {
    createKrakenReadSession,
    getKrakenAccountReference,
    getKrakenExportAccountReference,
    type KrakenDevice,
    type KrakenVehicleStatus as ClientVehicleStatus,
} from "../kraken/client";
import { requireCompleteDispatches } from "../kraken/dispatch-response";
import { validateKrakenImportTariff } from "../kraken/import-tariff";
import { validateKrakenExportTariff } from "../kraken/export-tariff";
import { validateHistoricalImportRates } from "../kraken/historical-import-rates";
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
    exportAccountRef?: () => string | null;
    createSession: () => ReadSession;
    record: (scope: ScheduleScope, read: ScheduleRead) => ScheduleStoreWrite;
    readCompatibility: (scopeId: string) => Promise<KrakenState | null>;
    writeCompatibility: (scopeId: string, state: KrakenState) => Promise<void>;
};
type Entry = { state: KrakenState; storedAt: number; requestContextKey: string };
export type KrakenAcquisitionDiagnostic = {
    attempted: boolean;
    freshEvidenceObtained: boolean;
    staleFallbackUsed: boolean;
    code: string | null;
};
type KrakenAcquisitionResult = { state: KrakenState; acquisition: KrakenAcquisitionDiagnostic };
class KrakenPreAcquisitionError extends Error {}
const KRAKEN_ACQUISITION_CODES = new Set([
    "KRAKEN_API_KEY_INVALID", "KRAKEN_AUTHENTICATION_FAILED", "KRAKEN_TRANSPORT_FAILURE",
    "KRAKEN_HTTP_FAILURE", "KRAKEN_RESPONSE_INVALID", "KRAKEN_GRAPHQL_REJECTED",
    "KRAKEN_AUTH_TRANSPORT_FAILURE", "KRAKEN_AUTH_HTTP_FAILURE", "KRAKEN_AUTH_GRAPHQL_REJECTED",
    "KRAKEN_AUTH_RESPONSE_INVALID", "KRAKEN_AUTH_TOKEN_INVALID",
    "KRAKEN_CONFIGURATION_INVALID",
    "KRAKEN_CONFIGURED_IMPORT_ACCOUNT_MISMATCH", "KRAKEN_ACCOUNT_CONTEXT_CHANGED",
    "KRAKEN_EXPORT_ACCOUNT_CONTEXT_CHANGED", "KRAKEN_OBSERVATION_REJECTED",
]);
function acquisitionCode(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("KRAKEN_DEVICE_RESPONSE_INVALID:")) return "KRAKEN_DEVICE_RESPONSE_INVALID";
    return KRAKEN_ACQUISITION_CODES.has(message) ? message : "KRAKEN_REFRESH_UNAVAILABLE";
}

function invalidDevice(path: string): never { throw Error(`KRAKEN_DEVICE_RESPONSE_INVALID:${path}`); }
function data(value: unknown, key: string, path: string): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidDevice(path);
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!(prototype === null || Object.getPrototypeOf(prototype) === null && constructor
        && "value" in constructor && typeof constructor.value === "function" && constructor.value.name === "Object")
        || Reflect.ownKeys(value).some(property => typeof property !== "string")) invalidDevice(path);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!("value" in descriptor) || !descriptor.enumerable) invalidDevice(path);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    return descriptor.value;
}
function list(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) invalidDevice(path);
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0) invalidDevice(path);
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item || !("value" in item) || !item.enumerable) invalidDevice(`${path}[${index}]`);
        result.push(item.value);
    }
    if (Reflect.ownKeys(value).length !== result.length + 1) invalidDevice(path);
    return result;
}
const requiredText = (value: unknown, path: string): string => {
    if (typeof value !== "string" || !value.trim()) invalidDevice(path);
    return value;
};
const nullableText = (value: unknown, path: string): string | null => value === null || value === undefined ? null : requiredText(value, path);
const nullableNumber = (value: unknown, path: string): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) invalidDevice(path);
    return value;
};
function schedules(value: unknown): KrakenVehicleState["preferences"] {
    if (value === null || value === undefined) return null;
    return { schedules: list(data(value, "schedules", "preferences"), "preferences.schedules").map((item, index) => ({
        dayOfWeek: requiredText(data(item, "dayOfWeek", `preferences.schedules[${index}]`), `preferences.schedules[${index}].dayOfWeek`),
        time: requiredText(data(item, "time", `preferences.schedules[${index}]`), `preferences.schedules[${index}].time`),
        min: nullableNumber(data(item, "min", `preferences.schedules[${index}]`), `preferences.schedules[${index}].min`),
        max: nullableNumber(data(item, "max", `preferences.schedules[${index}]`), `preferences.schedules[${index}].max`),
        upperLimit: nullableNumber(data(item, "upperLimit", `preferences.schedules[${index}]`), `preferences.schedules[${index}].upperLimit`),
    })) };
}
function preferenceSetting(value: unknown): KrakenVehicleState["preferenceSetting"] {
    if (value === null || value === undefined) return null;
    return { scheduleSettings: list(data(value, "scheduleSettings", "preferenceSetting"), "preferenceSetting.scheduleSettings").map((item, index) => {
        const path = `preferenceSetting.scheduleSettings[${index}]`, timeStep = data(item, "timeStep", path);
        if (typeof timeStep !== "number" || !Number.isFinite(timeStep)) invalidDevice(`${path}.timeStep`);
        return { timeFrom: nullableText(data(item, "timeFrom", path), `${path}.timeFrom`),
            timeTo: nullableText(data(item, "timeTo", path), `${path}.timeTo`), timeStep,
            min: nullableText(data(item, "min", path), `${path}.min`), max: nullableText(data(item, "max", path), `${path}.max`),
            step: requiredText(data(item, "step", path), `${path}.step`) };
    }) };
}
function metric(value: unknown, path: string): { value: number | null } | null {
    if (value === null || value === undefined) return null;
    const raw = data(value, "value", path);
    if (raw === null || raw === undefined) return { value: null };
    if (typeof raw !== "string" || !/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))
        invalidDevice(`${path}.value`);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) invalidDevice(`${path}.value`);
    return { value: parsed };
}
function status(value: ClientVehicleStatus): KrakenVehicleStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidDevice("status");
    const currentState = data(value, "currentState", "status"), isSuspended = data(value, "isSuspended", "status");
    if (!(currentState === null || currentState === undefined || typeof currentState === "string")
        || !(isSuspended === null || isSuspended === undefined || typeof isSuspended === "boolean")) {
        invalidDevice(typeof currentState !== "string" && currentState !== null && currentState !== undefined
            ? "status.currentState" : "status.isSuspended");
    }
    return { currentState: currentState ?? null, isSuspended: isSuspended ?? null,
        stateOfCharge: metric(data(value, "stateOfCharge", "status"), "status.stateOfCharge"),
        activePower: metric(data(value, "activePower", "status"), "status.activePower") };
}
function devices(value: unknown): KrakenDevice[] {
    const ids = new Set<string>();
    return list(value, "devices").map((raw, index) => {
        const path = `devices[${index}]`, id = requiredText(data(raw, "id", path), `${path}.id`),
            name = requiredText(data(raw, "name", path), `${path}.name`);
        if (ids.has(id)) invalidDevice(`${path}.id`);
        ids.add(id);
        return { id, name, deviceType: requiredText(data(raw, "deviceType", path), `${path}.deviceType`),
            provider: requiredText(data(raw, "provider", path), `${path}.provider`),
            vehicleBatterySize: nullableText(data(raw, "vehicleBatterySize", path), `${path}.vehicleBatterySize`),
            chargePointPowerOutput: nullableText(data(raw, "chargePointPowerOutput", path), `${path}.chargePointPowerOutput`),
            preferences: schedules(data(raw, "preferences", path)),
            preferenceSetting: preferenceSetting(data(raw, "preferenceSetting", path)) };
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
    return { now: Date.now, accountRef: getKrakenAccountReference, exportAccountRef: getKrakenExportAccountReference,
        createSession: createKrakenReadSession,
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
    const flights = new Map<string, Promise<KrakenAcquisitionResult>>();
    function classifyAtDelivery(state: KrakenState): KrakenState {
        if (state.stale) return state;
        const retrievedAt = Date.parse(state.lastSuccessfulUpdate);
        if (!Number.isFinite(retrievedAt) || dependencies.now() - retrievedAt >= CACHE_MS) {
            return { ...state, stale: true };
        }
        return state;
    }
    function classifyResultAtDelivery(result: KrakenAcquisitionResult): KrakenAcquisitionResult {
        const state = classifyAtDelivery(result.state);
        if (!state.stale || result.state.stale || !result.acquisition.freshEvidenceObtained) return { ...result, state };
        return { state, acquisition: { attempted: result.acquisition.attempted, freshEvidenceObtained: false,
            staleFallbackUsed: false, code: "KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY" } };
    }
    const exportContextKey = (identity: { accountRef: string; productCode: string; tariffCode: string } | undefined,
        accountRef: string | null) => JSON.stringify([accountRef, identity?.accountRef ?? null,
            identity?.productCode ?? null, identity?.tariffCode ?? null]);
    function exportEvidenceMatches(state: KrakenState,
        identity: { accountRef: string; productCode: string; tariffCode: string } | undefined, accountRef: string | null) {
        return !identity || accountRef !== null && identity.accountRef === accountRef
            && state.exportTariff?.accountRef === accountRef;
    }
    function staleRecovery(state: KrakenState,
        identity: { accountRef: string; productCode: string; tariffCode: string } | undefined, accountRef: string | null): KrakenState {
        if (exportEvidenceMatches(state, identity, accountRef)) return { ...state, stale: true };
        const { exportTariff: ignored, ...withoutExport } = state;
        void ignored;
        return { ...withoutExport, stale: true,
            exportTariffDiagnostic: { status: "unavailable", code: "EXPORT_ACCOUNT_CONTEXT_CHANGED" } };
    }
    async function refresh(scope: ScheduleScope, scopeId: string,
        tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
        exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
        expectedExportAccountRef: string | null = null,
        historicalPeriod?: { start: string; end: string }): Promise<KrakenAcquisitionResult> {
        const startedAt = new Date(dependencies.now()).toISOString();
        try {
            const session = dependencies.createSession();
            if (requiredText(session.accountRef, "session.accountRef") !== scope.accountRef) throw Error("KRAKEN_ACCOUNT_CONTEXT_CHANGED");
            if (exportTariffIdentity && session.exportAccountRef !== expectedExportAccountRef)
                throw Error("KRAKEN_EXPORT_ACCOUNT_CONTEXT_CHANGED");
            const [deviceResponse, tariffRead, exportTariffRead, historicalRead] = await Promise.all([
                session.getDevices(), session.getImportTariff().then(value => ({ ok: true as const, value }))
                    .catch(() => ({ ok: false as const })),
                exportTariffIdentity ? session.getExportTariff().then(value => ({ ok: true as const, value }))
                    .catch(() => ({ ok: false as const })) : Promise.resolve({ ok: false as const }),
                historicalPeriod ? session.getHistoricalImportRates(historicalPeriod).then(value => ({ ok: true as const, value }))
                    .catch(() => ({ ok: false as const })) : Promise.resolve({ ok: false as const }),
            ]);
            const enumerated = devices(deviceResponse);
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
            const importTariff = tariffRead.ok ? validateKrakenImportTariff(tariffRead.value, {
                accountRef: scope.accountRef, observedAt: retrievedAt, timeZone: "Europe/London",
                tariffCode: tariffIdentity?.tariffCode, meterPointRef: tariffIdentity?.meterPointRef,
            }) : { status: "unavailable" as const, code: "TARIFF_RETRIEVAL_FAILED" };
            const exportTariff = exportTariffIdentity?.accountRef !== expectedExportAccountRef
                ? { status: "unavailable" as const, code: "EXPORT_ACCOUNT_IDENTITY_MISMATCH" }
                : exportTariffRead.ok && expectedExportAccountRef ? validateKrakenExportTariff(exportTariffRead.value, {
                accountRef: expectedExportAccountRef, importAccountRef: scope.accountRef, observedAt: retrievedAt,
                productCode: exportTariffIdentity?.productCode, tariffCode: exportTariffIdentity?.tariffCode,
            }) : { status: "unavailable" as const, code: exportTariffRead.ok
                ? "EXPORT_ACCOUNT_IDENTITY_UNAVAILABLE" : "EXPORT_TARIFF_RETRIEVAL_FAILED" };
            const historicalImportRates = historicalPeriod && historicalRead.ok && importTariff.status === "available"
                ? validateHistoricalImportRates(historicalRead.value, { accountRef: scope.accountRef,
                    meterPointRef: importTariff.agreement.meterPointRef, observedAt: retrievedAt, period: historicalPeriod,
                    agreement: { validFrom: importTariff.agreement.validFrom, validTo: importTariff.agreement.validTo },
                    corroboratingValues: [importTariff.version.normalImport, importTariff.version.scheduledChargingImport]
                        .flatMap(price => price ? [Number((price.amount * 100).toPrecision(15))] : []) })
                : { status: "unavailable" as const, code: historicalPeriod
                    ? historicalRead.ok ? "CURRENT_TARIFF_EVIDENCE_UNAVAILABLE" : "HISTORICAL_RATE_RETRIEVAL_FAILED"
                    : "HISTORICAL_RATE_PERIOD_NOT_REQUESTED" };
            const read: ScheduleRead = { scopeId, startedAt, retrievedAt, status: "complete",
                provenance: "authenticated-query", vehicles: vehicles.map(vehicle => ({ id: vehicle.id,
                    name: vehicle.name, plannedDispatches: vehicle.plannedDispatches.map(dispatch => ({ ...dispatch })) })) };
            const stored = dependencies.record(scope, read);
            if (stored.status === "rejected" && ORDERING_REJECTIONS.has(stored.code)) {
                throw Error("KRAKEN_OBSERVATION_REJECTED");
            }
            const state: KrakenState = { vehicles, lastSuccessfulUpdate: retrievedAt, stale: false,
                scheduleRecording: recording(stored),
                ...(importTariff.status === "available" ? { importTariff }
                    : { importTariffDiagnostic: { status: "unavailable" as const, code: importTariff.code } }),
                ...(exportTariff.status === "available" ? { exportTariff }
                    : { exportTariffDiagnostic: { status: "unavailable" as const, code: exportTariff.code } }),
                ...(historicalImportRates.status === "available" ? { historicalImportRates }
                    : { historicalImportRatesDiagnostic: { status: "unavailable" as const, code: historicalImportRates.code } }) };
            await dependencies.writeCompatibility(scopeId, state);
            // Freshness begins when authenticated retrieval completed, not when
            // best-effort compatibility publication eventually settles.
            memory.set(scopeId, { state, storedAt: retrievedAtMs,
                requestContextKey: JSON.stringify([exportContextKey(exportTariffIdentity, expectedExportAccountRef), historicalPeriod ?? null]) });
            return { state, acquisition: { attempted: true, freshEvidenceObtained: true,
                staleFallbackUsed: false, code: null } };
        } catch (error) {
            const cached = memory.get(scopeId)?.state ?? await dependencies.readCompatibility(scopeId);
            if (cached) return { state: staleRecovery(cached, exportTariffIdentity, expectedExportAccountRef),
                acquisition: { attempted: true, freshEvidenceObtained: false,
                    staleFallbackUsed: true, code: acquisitionCode(error) } };
            throw error;
        }
    }
    async function getWithAcquisition(siteId: string,
        tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
            exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
            historicalPeriod?: { start: string; end: string }): Promise<KrakenAcquisitionResult> {
            let scope: ScheduleScope;
            try { scope = { siteId: requiredText(siteId, "scope.siteId"),
                accountRef: requiredText(dependencies.accountRef(), "scope.accountRef") }; }
            catch { throw new KrakenPreAcquisitionError("KRAKEN_CONFIGURATION_INVALID"); }
            if (tariffIdentity?.accountRef !== undefined
                && (!/^[a-f0-9]{64}$/.test(tariffIdentity.accountRef) || tariffIdentity.accountRef !== scope.accountRef))
                throw new KrakenPreAcquisitionError("KRAKEN_CONFIGURED_IMPORT_ACCOUNT_MISMATCH");
            const scopeId = scheduleScopeId(scope);
            const expectedExportAccountRef = dependencies.exportAccountRef?.() ?? null;
            const currentExportContextKey = exportContextKey(exportTariffIdentity, expectedExportAccountRef);
            const requestContextKey = JSON.stringify([currentExportContextKey, historicalPeriod ?? null]);
            const flightId = JSON.stringify([scopeId, requestContextKey]);
            const running = flights.get(flightId);
            if (running) return classifyResultAtDelivery(await running);
            const cached = memory.get(scopeId);
            if (cached && !cached.state.stale && dependencies.now() - cached.storedAt < CACHE_MS
                && cached.requestContextKey === requestContextKey) {
                return classifyResultAtDelivery({ state: cached.state, acquisition: { attempted: false,
                    freshEvidenceObtained: true, staleFallbackUsed: false, code: null } });
            }
            const promise = refresh(scope, scopeId, tariffIdentity, exportTariffIdentity, expectedExportAccountRef, historicalPeriod);
            flights.set(flightId, promise);
            try { return classifyResultAtDelivery(await promise); }
            finally { if (flights.get(flightId) === promise) flights.delete(flightId); }
    }
    return {
        getWithAcquisition,
        async inspect(siteId: string, tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
            exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
            historicalPeriod?: { start: string; end: string }) {
            try { return await getWithAcquisition(siteId, tariffIdentity, exportTariffIdentity, historicalPeriod); }
            catch (error) { return { state: null, acquisition: { attempted: !(error instanceof KrakenPreAcquisitionError),
                freshEvidenceObtained: false, staleFallbackUsed: false, code: acquisitionCode(error) } }; }
        },
        async get(siteId: string, tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
            exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
            historicalPeriod?: { start: string; end: string }): Promise<KrakenState> {
            return (await getWithAcquisition(siteId, tariffIdentity, exportTariffIdentity, historicalPeriod)).state;
        },
    };
}

const processState = globalThis as typeof globalThis & {
    __hepKrakenRefreshCoordinator?: ReturnType<typeof createKrakenRefreshCoordinator>;
};
const coordinator = processState.__hepKrakenRefreshCoordinator ??=
    createKrakenRefreshCoordinator(productionDependencies());
export const getRecordedKrakenState = (siteId: string,
    tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
    exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
    historicalPeriod?: { start: string; end: string }) =>
    coordinator.get(siteId, tariffIdentity, exportTariffIdentity, historicalPeriod);
export async function getRecordedKrakenStateForInspection(siteId: string,
    tariffIdentity?: { accountRef?: string; tariffCode: string; meterPointRef: string },
    exportTariffIdentity?: { accountRef: string; meterPointRef?: string; productCode: string; tariffCode: string },
    historicalPeriod?: { start: string; end: string }): Promise<KrakenAcquisitionResult | {
        state: null; acquisition: KrakenAcquisitionDiagnostic;
    }> {
    return coordinator.inspect(siteId, tariffIdentity, exportTariffIdentity, historicalPeriod);
}
