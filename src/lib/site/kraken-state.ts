import { readLastKnownKrakenState, writeLastKnownKrakenState } from "./kraken-state-store";
import {
    getKrakenDevices,
    getKrakenPlannedDispatches,
    getKrakenVehicleStatus,
} from "../kraken/client";

const KRAKEN_CACHE_MS = 60_000;

let cachedKrakenState: KrakenState | null = null;
let cachedKrakenStateAt = 0;

export type KrakenVehicleStatus = {
    currentState: string | null;
    isSuspended: boolean | null;
    stateOfCharge: {
        value: number | null;
    } | null;
    activePower: {
        value: number | null;
    } | null;
};

export type KrakenPlannedDispatch = {
    start: string;
    end: string;
    type: string;
    energyAddedKwh: string | null;
};

export type KrakenVehicleState = {
    id: string;
    name: string;
    deviceType: string;
    provider: string;
    vehicleBatterySize: string | null;
    chargePointPowerOutput: string | null;

    preferences: {
        schedules: Array<{
            dayOfWeek: string;
            time: string;
            min: number | null;
            max: number | null;
            upperLimit: number | null;
        }>;
    } | null;

    preferenceSetting: {
        scheduleSettings: Array<{
            timeFrom: string | null;
            timeTo: string | null;
            timeStep: number;
            min: string | null;
            max: string | null;
            step: string;
        }>;
    } | null;

    plannedDispatches: KrakenPlannedDispatch[];
    status: KrakenVehicleStatus;
};

export type KrakenState = {
    vehicles: KrakenVehicleState[];
    lastSuccessfulUpdate: string;
    stale: boolean;
};

// Suspension is a user setting; currentState describes operation independently.
export function getSmartControlSetting(isSuspended: boolean | null): string {
    if (isSuspended === false) return "Enabled";
    if (isSuspended === true) return "Suspended";
    return "Unknown";
}

export async function getKrakenState(): Promise<KrakenState> {
    const now = Date.now();
    if (cachedKrakenState && !cachedKrakenState.stale && now - cachedKrakenStateAt < KRAKEN_CACHE_MS) {
        return cachedKrakenState;
    }

    try {
        const devices = await getKrakenDevices();
        const vehicles = await Promise.all(
            devices.map(async (device) => ({
                ...device,
                status: await getKrakenVehicleStatus(device.id),
                plannedDispatches: await getKrakenPlannedDispatches(device.id),
            }))
        );
        cachedKrakenStateAt = Date.now();
        cachedKrakenState = {
            vehicles,
            lastSuccessfulUpdate: new Date(cachedKrakenStateAt).toISOString(),
            stale: false,
        };
        await writeLastKnownKrakenState(cachedKrakenState);
        return cachedKrakenState;
    } catch (error) {
        // Only consult disk after live retrieval fails and memory has no snapshot.
        // A recovered snapshot never starts a fresh 60-second cache window.
        cachedKrakenState ??= await readLastKnownKrakenState();
        // Keep the last successful snapshot and retry on the next request.
        if (cachedKrakenState) {
            console.error("Kraken refresh failed; using cached data:", error);
            return { ...cachedKrakenState, stale: true };
        }
        throw error;
    }
}
