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
};

 export async function getKrakenState(): Promise<KrakenState> {
        const now = Date.now();

    if (
        cachedKrakenState &&
        now - cachedKrakenStateAt < KRAKEN_CACHE_MS
    ) {
        return cachedKrakenState;
    }

    const devices = await getKrakenDevices();

    const vehicles = await Promise.all(
        devices.map(async (device) => ({
            ...device,
            status: await getKrakenVehicleStatus(device.id),
            plannedDispatches: await getKrakenPlannedDispatches(device.id),
        }))
    );

    const state: KrakenState = {
    vehicles,
};

cachedKrakenState = state;
cachedKrakenStateAt = Date.now();

return state;

}