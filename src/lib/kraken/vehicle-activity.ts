import type { KrakenVehicleState } from "../site/kraken-state";

// Compare absolute instants, never formatted clock strings. A scheduled interval
// is not proof of charging, qualification or billed whole-home electricity.
export function vehicleActivity(vehicle: KrakenVehicleState, now: string) {
    const at = Date.parse(now);
    const currentDispatches = vehicle.plannedDispatches.filter(dispatch => {
        const start = Date.parse(dispatch.start), end = Date.parse(dispatch.end);
        return Number.isFinite(at) && start <= at && at < end;
    });
    const power = vehicle.status.activePower?.value;
    const charging = typeof power === "number" && Number.isFinite(power)
        ? power > 0 ? `${power.toFixed(1)} kW` : "No charging power reported"
        : "Charging power unavailable";
    return { currentDispatches, charging };
}
