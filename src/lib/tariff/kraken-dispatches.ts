import type { KrakenState } from "../site/kraken-state";
import type { EnergyPrice, PriceInputWindow } from "./types";
import { instant, validPrice } from "./price-signal";

// Read-only adapter: a planned EV schedule is evidence of a potential tariff
// opportunity, not proof that charging happened or that the rate was awarded.
export function krakenDispatchPriceWindows(
    state: KrakenState, importPrice: EnergyPrice | null,
): PriceInputWindow[] {
    return state.vehicles.flatMap(vehicle => vehicle.plannedDispatches.flatMap(dispatch => {
        if (dispatch.type !== "SMART") return [];
        const start = instant(dispatch.start), end = instant(dispatch.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
        return [{
            start: new Date(start).toISOString(), end: new Date(end).toISOString(),
            price: validPrice(importPrice), kind: "cheap-opportunity" as const,
            condition: "scheduled-ev-charging" as const,
            // A fresh or stale plan cannot establish actual charging or billed rates.
            eligibility: { state: "planned-conditional" as const, intervalMinutes: 30 },
            sources: [{
                provider: "kraken", description: "Kraken planned EV dispatch",
                observedAt: state.lastSuccessfulUpdate, stale: state.stale,
                cause: {
                    kind: "ev-dispatch" as const, assetId: vehicle.id, assetName: vehicle.name,
                    start: dispatch.start, end: dispatch.end, dispatchType: dispatch.type,
                },
            }],
        }];
    }));
}
