import { resolveEffectiveTariff, applyDispatchRates } from "../tariff/effective-tariff";
import type { Site } from "./types";
import type { KrakenState } from "./kraken-state";
import type { PriceSignal } from "../tariff/types";
import { buildPriceCurve } from "../tariff/price-signal";
import { krakenDispatchPriceWindows } from "../tariff/kraken-dispatches";
import type { KrakenExportTariffEvidence } from "../kraken/export-tariff";

const KRAKEN_IMPORT_TARIFF_MAX_AGE_MS = 60_000;

export type SitePricePlan = {
    signal: PriceSignal;
    timeZone: string;
    kraken: {
        status: "disabled" | "unavailable" | "available" | "stale";
        lastSuccessfulUpdate: string | null;
    };
};

export function verifiedKrakenExportTariff(site: Site, kraken: KrakenState | null, now: string): KrakenExportTariffEvidence | null {
    const identity = site.integrations.kraken.exportTariffIdentity;
    const age = Date.parse(now) - Date.parse(kraken?.exportTariff?.observedAt ?? "");
    return kraken?.stale === false && kraken.exportTariff?.status === "available"
        && identity !== undefined && kraken.exportTariff.accountRef.length > 0
        && kraken.exportTariff.accountRef === identity.accountRef
        && kraken.exportTariff.agreement.productCode === identity.productCode
        && kraken.exportTariff.agreement.tariffCode === identity.tariffCode
        && Number.isFinite(age) && age >= 0 && age <= KRAKEN_IMPORT_TARIFF_MAX_AGE_MS
        && Date.parse(now) >= Date.parse(kraken.exportTariff.agreement.validFrom)
        && Date.parse(now) < Date.parse(kraken.exportTariff.agreement.validTo)
        ? kraken.exportTariff : null;
}

export function siteWithKrakenImportTariff(site: Site, kraken: KrakenState | null, now: string,
    requireVerifiedEvidence = false): Site {
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
    if (!verified || !site.tariff) return requireVerifiedEvidence && site.tariff
        ? { ...site, tariff: { ...site.tariff, normalImport: null, export: null, importWindows: [], exportWindows: [], versions: [] } }
        : site;
    const verifiedExport = verifiedKrakenExportTariff(site, kraken, now);
    const exportWindows = verifiedExport ? [{ start: verifiedExport.agreement.validFrom, end: verifiedExport.agreement.validTo,
        price: verifiedExport.price, kind: "standard" as const, condition: "none" as const,
        sources: [{ provider: "eon-next-kraken", description: verifiedExport.agreement.productCode,
            tariffVersion: verifiedExport.agreement.tariffCode, observedAt: verifiedExport.observedAt, stale: false }] }] : [];
    return { ...site, tariff: { ...site.tariff, normalImport: null, export: null, exportWindows,
        versions: [{ ...verified.version, export: null }] } };
}

// Uses the already loaded site snapshot. No fetching, refresh or control actions.
export function getSitePriceSignalForPeriod(site: Site, kraken: KrakenState | null, now: string,
    horizon: { start: string; end: string }, requireVerifiedEvidence = false): SitePricePlan {
    const tariff = siteWithKrakenImportTariff(site, kraken, now, requireVerifiedEvidence).tariff;
    const rule = site.integrations.kraken.wholeHomeDispatchRate;
    const enabled = site.integrations.kraken.enabled && rule?.enabled === true;
    const effective = tariff?.versions ? resolveEffectiveTariff(tariff, horizon) : null;
    const historical = requireVerifiedEvidence && !kraken?.stale && kraken?.historicalImportRates?.status === "available"
        && kraken.historicalImportRates.period.start === horizon.start && kraken.historicalImportRates.period.end === horizon.end
        && kraken.historicalImportRates.accountRef === kraken.importTariff?.accountRef
        && kraken.historicalImportRates.meterPointRef === kraken.importTariff?.agreement.meterPointRef
        ? kraken.historicalImportRates : null;
    const historicalDispatchRates = historical && kraken?.importTariff?.version.scheduledChargingImport
        && Date.parse(kraken.importTariff.agreement.validFrom) <= Date.parse(horizon.start)
        && Date.parse(kraken.importTariff.agreement.validTo) >= Date.parse(horizon.end)
        ? [{ start: horizon.start, end: horizon.end, price: kraken.importTariff.version.scheduledChargingImport,
            kind: "standard" as const, condition: "none" as const, sources: [{ provider: "eon-next-kraken",
                description: "Current agreement SMART rate; planned qualification remains estimated",
                observedAt: kraken.importTariff.observedAt, stale: false }] }] : [];
    const dispatches = enabled && kraken ? krakenDispatchPriceWindows(kraken, requireVerifiedEvidence ? null : rule.importPrice) : [];
    const opportunities = historical ? applyDispatchRates(dispatches, historicalDispatchRates)
        : effective ? applyDispatchRates(dispatches, effective.dispatchRates) : dispatches;
    return {
        timeZone: tariff?.timeZone ?? "UTC",
        kraken: {
            status: !enabled ? "disabled" : !kraken ? "unavailable" : kraken.stale ? "stale" : "available",
            lastSuccessfulUpdate: enabled ? kraken?.lastSuccessfulUpdate ?? null : null,
        },
        signal: {
            scope: "whole-home", generatedAt: now, horizon,
            import: buildPriceCurve(horizon, historical || effective ? null : tariff?.normalImport ?? null,
                [...(historical?.windows ?? effective?.import ?? tariff?.importWindows ?? []), ...opportunities]),
            export: buildPriceCurve(horizon, effective ? null : tariff?.export ?? null,
                tariff?.exportWindows ?? effective?.export ?? []),
        },
    };
}

export function getSitePriceSignal(site: Site, kraken: KrakenState | null, now: string): SitePricePlan {
    return getSitePriceSignalForPeriod(site, kraken, now,
        { start: now, end: new Date(Date.parse(now) + 48 * 60 * 60 * 1000).toISOString() });
}
