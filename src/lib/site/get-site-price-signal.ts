import { resolveEffectiveTariff, applyDispatchRates } from "../tariff/effective-tariff";
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
    const effective = tariff?.versions ? resolveEffectiveTariff(tariff, horizon) : null;
    const dispatches = enabled && kraken ? krakenDispatchPriceWindows(kraken, rule.importPrice) : [];
    const opportunities = effective ? applyDispatchRates(dispatches, effective.dispatchRates) : dispatches;
    return {
        timeZone: tariff?.timeZone ?? "UTC",
        kraken: {
            status: !enabled ? "disabled" : !kraken ? "unavailable" : kraken.stale ? "stale" : "available",
            lastSuccessfulUpdate: enabled ? kraken?.lastSuccessfulUpdate ?? null : null,
        },
        signal: {
            scope: "whole-home", generatedAt: now, horizon,
            import: buildPriceCurve(horizon, effective ? null : tariff?.normalImport ?? null, [...(effective?.import ?? tariff?.importWindows ?? []), ...opportunities]),
            export: buildPriceCurve(horizon, effective ? null : tariff?.export ?? null, effective?.export ?? tariff?.exportWindows ?? []),
        },
    };
}
