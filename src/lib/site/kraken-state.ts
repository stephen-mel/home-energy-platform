import { getRecordedKrakenState } from "./kraken-refresh";
import type { KrakenImportTariffEvidence } from "../kraken/import-tariff";
import type { KrakenExportTariffEvidence } from "../kraken/export-tariff";
import type { KrakenHistoricalImportRates } from "../kraken/historical-import-rates";

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

    // Complete-list compatibility projection. Failed/incomplete retrieval rejects
    // the entire refresh; stale snapshots retain the original successful lists.
    plannedDispatches: KrakenPlannedDispatch[];
    status: KrakenVehicleStatus;
};

export type KrakenState = {
    vehicles: KrakenVehicleState[];
    lastSuccessfulUpdate: string;
    stale: boolean;
    scheduleRecording?: KrakenScheduleRecording;
    importTariff?: KrakenImportTariffEvidence;
    importTariffDiagnostic?: { status: "unavailable"; code: string };
    exportTariff?: KrakenExportTariffEvidence;
    exportTariffDiagnostic?: { status: "unavailable"; code: string };
    historicalImportRates?: KrakenHistoricalImportRates;
    historicalImportRatesDiagnostic?: { status: "unavailable"; code: string };
};

export type KrakenScheduleRecording = {
    status: "persisted" | "already-recorded" | "rejected" | "busy" | "invalid" | "store-failed" | "indeterminate";
    change: "initial" | "unchanged" | "changed" | null;
    code: string | null;
};

// Suspension is a user setting; currentState describes operation independently.
export function getSmartControlSetting(isSuspended: boolean | null): string {
    if (isSuspended === false) return "Enabled";
    if (isSuspended === true) return "Suspended";
    return "Unknown";
}

export async function getKrakenState(site: { id: string; integrations?: { kraken: {
    importTariffIdentity?: { tariffCode: string; meterPointRef: string };
    exportTariffIdentity?: { accountRef: string; productCode: string; tariffCode: string };
} } }, historicalPeriod?: { start: string; end: string }): Promise<KrakenState> {
    return getRecordedKrakenState(site.id, site.integrations?.kraken.importTariffIdentity,
        site.integrations?.kraken.exportTariffIdentity, historicalPeriod);
}
