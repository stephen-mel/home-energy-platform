import type { Site } from "./types";
import type { KrakenState } from "./kraken-state";
import type { PriceSignal } from "../tariff/types";
import { buildPriceCurve } from "../tariff/price-signal";
import { krakenDispatchPriceWindows } from "../tariff/kraken-dispatches";

export type SitePricePlan = {
    signal: PriceSignal;
    timeZone: string;
    kraken: {
        status: "disabled" | "unavailable" | "available" | "stale";
        lastSuccessfulUpdate: string | null;
    };
};

// Uses the already loaded site snapshot. No fetching, refresh or control actions.
export function getSitePriceSignal(site: Site, kraken: KrakenState | null, now: string): SitePricePlan {
    const tariff = site.tariff;
    const rule = site.integrations.kraken.wholeHomeDispatchRate;
    const enabled = site.integrations.kraken.enabled && rule?.enabled === true;
    const horizon = { start: now, end: new Date(Date.parse(now) + 48 * 60 * 60 * 1000).toISOString() };
    const opportunities = enabled && kraken ? krakenDispatchPriceWindows(kraken, rule.importPrice) : [];
    return {
        timeZone: tariff?.timeZone ?? "UTC",
        kraken: {
            status: !enabled ? "disabled" : !kraken ? "unavailable" : kraken.stale ? "stale" : "available",
            lastSuccessfulUpdate: enabled ? kraken?.lastSuccessfulUpdate ?? null : null,
        },
        signal: {
            scope: "whole-home", generatedAt: now, horizon,
            import: buildPriceCurve(horizon, tariff?.normalImport ?? null, [...(tariff?.importWindows ?? []), ...opportunities]),
            export: buildPriceCurve(horizon, tariff?.export ?? null, tariff?.exportWindows ?? []),
        },
    };
}
