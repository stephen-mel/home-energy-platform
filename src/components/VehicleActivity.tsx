"use client";
import type { KrakenVehicleState } from "../lib/site/kraken-state";
import { vehicleActivity } from "../lib/kraken/vehicle-activity";
import { useDashboardTime } from "./use-dashboard-time";

export default function VehicleActivity({ vehicle, asOf }: { vehicle: KrakenVehicleState; asOf: string }) {
    const activity = vehicleActivity(vehicle, useDashboardTime(asOf));
    return <>
        <p className="mt-2 font-medium">{activity.charging}</p>
        {activity.currentDispatches.some(d => d.type === "SMART") && <p className="mt-1 text-xs text-zinc-400">
            SMART period scheduled now · Conditional on actual charging
        </p>}
    </>;
}
