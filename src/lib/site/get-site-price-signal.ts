import { resolveEffectiveTariff, applyDispatchRates } from "../tariff/effective-tariff";
import type { Site } from "./types";
import type { KrakenState } from "./kraken-state";
import type { PriceSignal } from "../tariff/types";
import { buildPriceCurve } from "../tariff/price-signal";
import { krakenDispatchPriceWindows } from "../tariff/kraken-dispatches";

const KRAKEN_IMPORT_TARIFF_MAX_AGE_MS = 60_000;

export type SitePricePlan = {
    signal: PriceSignal;
    timeZone: string;
    kraken: {
        status: "disabled" | "unavailable" | "available" | "stale";
        lastSuccessfulUpdate: string | null;
    };
};

export function siteWithKrakenImportTariff(site: Site, kraken: KrakenState | null, now: string): Site {
    const age = Date.parse(now) - Date.parse(kraken?.importTariff?.observedAt ?? "");
    const identity = site.integrations.kraken.importTariffIdentity;
    const verified = kraken?.stale === false && kraken.importTariff?.status === "available"
        && kraken.importTariff.accountRef.length > 0
        && identity !== undefined && kraken.importTariff.agreement.tariffCode === identity.tariffCode
        && kraken.importTariff.agreement.meterPointRef === identity.meterPointRef
        && Number.isFinite(age) && age >= 0 && age <= KRAKEN_IMPORT_TARIFF_MAX_AGE_MS
        && Date.parse(now) >= Date.parse(kraken.importTariff.agreement.validFrom)
        && Date.parse(now) < Date.parse(kraken.importTariff.agreement.validTo)
        ? kraken.importTariff : null;
    if (!verified || !site.tariff) return site;
    return { ...site, tariff: { ...site.tariff, normalImport: null, export: null, versions: [verified.version] } };
}

// Uses the already loaded site snapshot. No fetching, refresh or control actions.
export function getSitePriceSignal(site: Site, kraken: KrakenState | null, now: string): SitePricePlan {
    const tariff = siteWithKrakenImportTariff(site, kraken, now).tariff;
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
