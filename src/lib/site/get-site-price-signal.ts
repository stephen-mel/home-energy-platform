import { resolveEffectiveTariff, applyDispatchRates } from "../tariff/effective-tariff";
import type { Site } from "./types";
import type { KrakenState } from "./kraken-state";
import type { PriceSignal } from "../tariff/types";
import { buildPriceCurve } from "../tariff/price-signal";
import { krakenDispatchPriceWindows } from "../tariff/kraken-dispatches";
import type { KrakenExportTariffEvidence } from "../kraken/export-tariff";

const KRAKEN_IMPORT_TARIFF_MAX_AGE_MS = 60_000;
const COMMERCIAL_ASSUMPTION_DIAGNOSTICS = new Set(["EXPORT_TARIFF_RETRIEVAL_FAILED",
    "EXPORT_ACCOUNT_IDENTITY_UNAVAILABLE", "SITE_EXPORT_TARIFF_IDENTITY_UNCONFIGURED"]);

export type SitePricePlan = {
    signal: PriceSignal;
    timeZone: string;
    kraken: {
        status: "disabled" | "unavailable" | "available" | "stale";
        lastSuccessfulUpdate: string | null;
        exportPricing: "authenticated" | "user-confirmed-assumption" | "unavailable" | "rejected";
        exportDiagnostic: string | null;
    };
};

export function verifiedKrakenExportTariff(site: Site, kraken: KrakenState | null, now: string): KrakenExportTariffEvidence | null {
    const identity = site.integrations.kraken.exportTariffIdentity;
    const evidence = kraken?.exportTariff, agreement = evidence && typeof evidence.agreement === "object"
        && evidence.agreement !== null && !Array.isArray(evidence.agreement) ? evidence.agreement : null;
    const age = Date.parse(now) - Date.parse(typeof evidence?.observedAt === "string" ? evidence.observedAt : "");
    return kraken?.stale === false && evidence?.status === "available" && agreement
        && identity !== undefined && typeof evidence.accountRef === "string" && evidence.accountRef.length > 0
        && evidence.accountRef === identity.accountRef
        && agreement.productCode === identity.productCode
        && agreement.tariffCode === identity.tariffCode
        && Number.isFinite(age) && age >= 0 && age <= KRAKEN_IMPORT_TARIFF_MAX_AGE_MS
        && typeof agreement.validFrom === "string" && typeof agreement.validTo === "string"
        && Date.parse(now) >= Date.parse(agreement.validFrom)
        && Date.parse(now) < Date.parse(agreement.validTo)
        ? evidence : null;
}

type ExportEvidenceDecision =
    | { kind: "authenticated"; evidence: KrakenExportTariffEvidence; diagnostic: null }
    | { kind: "assumption-eligible"; diagnostic: string | null }
    | { kind: "rejected"; diagnostic: string };

function exportEvidenceDecision(site: Site, kraken: KrakenState | null, now: string): ExportEvidenceDecision {
    if (!kraken) return { kind: "assumption-eligible", diagnostic: null };
    const hasEvidence = Object.hasOwn(kraken, "exportTariff");
    const hasDiagnostic = Object.hasOwn(kraken, "exportTariffDiagnostic");
    const rawDiagnostic: unknown = hasDiagnostic ? kraken.exportTariffDiagnostic : undefined;
    let diagnostic: { status: "unavailable"; code: string } | null = null;
    if (hasDiagnostic) {
        if (!rawDiagnostic || typeof rawDiagnostic !== "object" || Array.isArray(rawDiagnostic)
            || Object.keys(rawDiagnostic).length !== 2 || !Object.hasOwn(rawDiagnostic, "status")
            || !Object.hasOwn(rawDiagnostic, "code"))
            return { kind: "rejected", diagnostic: "EXPORT_TARIFF_DIAGNOSTIC_MALFORMED" };
        const candidate = rawDiagnostic as Record<string, unknown>;
        if (candidate.status !== "unavailable" || typeof candidate.code !== "string" || candidate.code.length === 0)
            return { kind: "rejected", diagnostic: "EXPORT_TARIFF_DIAGNOSTIC_MALFORMED" };
        diagnostic = candidate as { status: "unavailable"; code: string };
    }
    if (hasEvidence && hasDiagnostic)
        return { kind: "rejected", diagnostic: "EXPORT_TARIFF_EVIDENCE_DIAGNOSTIC_CONTRADICTION" };
    if (kraken.stale && (hasEvidence || hasDiagnostic))
        return { kind: "rejected", diagnostic: "EXPORT_EVIDENCE_STALE" };
    if (hasEvidence) {
        const evidence = verifiedKrakenExportTariff(site, kraken, now);
        return evidence ? { kind: "authenticated", evidence, diagnostic: null }
            : { kind: "rejected", diagnostic: "EXPORT_EVIDENCE_REJECTED" };
    }
    if (!diagnostic) return { kind: "assumption-eligible", diagnostic: null };
    return COMMERCIAL_ASSUMPTION_DIAGNOSTICS.has(diagnostic.code)
        ? { kind: "assumption-eligible", diagnostic: diagnostic.code }
        : { kind: "rejected", diagnostic: diagnostic.code };
}

const authenticatedExportWindows = (evidence: KrakenExportTariffEvidence) => [{
    start: evidence.agreement.validFrom, end: evidence.agreement.validTo, price: evidence.price,
    kind: "standard" as const, condition: "none" as const,
    sources: [{ provider: "eon-next-kraken", description: evidence.agreement.productCode,
        tariffVersion: evidence.agreement.tariffCode, observedAt: evidence.observedAt, stale: false }],
}];

function siteWithKrakenImportTariffDecision(site: Site, kraken: KrakenState | null, now: string,
    requireVerifiedEvidence: boolean, exportDecision: ExportEvidenceDecision): Site {
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
    const exportWindows = exportDecision.kind === "authenticated" ? authenticatedExportWindows(exportDecision.evidence) : [];
    return { ...site, tariff: { ...site.tariff, normalImport: null, export: null, exportWindows,
        versions: [{ ...verified.version, export: null }] } };
}

export function siteWithKrakenImportTariff(site: Site, kraken: KrakenState | null, now: string,
    requireVerifiedEvidence = false): Site {
    return siteWithKrakenImportTariffDecision(site, kraken, now, requireVerifiedEvidence,
        exportEvidenceDecision(site, kraken, now));
}

// Uses the already loaded site snapshot. No fetching, refresh or control actions.
export function getSitePriceSignalForPeriod(site: Site, kraken: KrakenState | null, now: string,
    horizon: { start: string; end: string }, requireVerifiedEvidence = false): SitePricePlan {
    const exportDecision = exportEvidenceDecision(site, kraken, now);
    const tariff = siteWithKrakenImportTariffDecision(site, kraken, now, requireVerifiedEvidence, exportDecision).tariff;
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
    const fixedExport = site.integrations.kraken.fixedExportAssumption;
    const assumedExport = requireVerifiedEvidence && exportDecision.kind === "assumption-eligible" && fixedExport
        && Number.isFinite(fixedExport.price.amount) && fixedExport.price.amount === 0.175
        && fixedExport.price.currency === "GBP" && fixedExport.price.unit === "kWh"
        ? [{ start: horizon.start, end: horizon.end, price: fixedExport.price, kind: "standard" as const,
            condition: "none" as const, sources: [{ provider: "user-confirmed-commercial-assumption",
                description: `${fixedExport.provider} ${fixedExport.tariff}; contractual expiry not established`,
                observedAt: null, stale: false }] }] : [];
    const rejectedExport = exportDecision.kind === "rejected" ? [{ start: horizon.start, end: horizon.end,
        price: null, kind: "standard" as const, condition: "none" as const,
        sources: [{ provider: "kraken-export-evidence-rejected", description: exportDecision.diagnostic,
            observedAt: kraken?.lastSuccessfulUpdate ?? null, stale: true }] }] : [];
    const authenticatedExport = exportDecision.kind === "authenticated"
        ? authenticatedExportWindows(exportDecision.evidence) : [];
    const importCurve = buildPriceCurve(horizon, historical || effective ? null : tariff?.normalImport ?? null,
        [...(historical?.windows ?? effective?.import ?? tariff?.importWindows ?? []), ...opportunities]);
    const authenticatedImportObservedAt = kraken?.importTariff?.status === "available" ? kraken.importTariff.observedAt : null;
    const boundImportCurve = authenticatedImportObservedAt ? importCurve.map(window => ({ ...window,
        sources: window.sources.map(source => source.provider === "eon-next-kraken" && source.observedAt === null
            ? { ...source, observedAt: authenticatedImportObservedAt } : source) })) : importCurve;
    return {
        timeZone: tariff?.timeZone ?? "UTC",
        kraken: {
            status: !enabled ? "disabled" : !kraken ? "unavailable" : kraken.stale ? "stale" : "available",
            lastSuccessfulUpdate: enabled ? kraken?.lastSuccessfulUpdate ?? null : null,
            exportPricing: authenticatedExport.length ? "authenticated" : assumedExport.length
                ? "user-confirmed-assumption" : exportDecision.kind === "rejected" ? "rejected" : "unavailable",
            exportDiagnostic: exportDecision.diagnostic,
        },
        signal: {
            scope: "whole-home", generatedAt: now, horizon,
            import: boundImportCurve,
            export: buildPriceCurve(horizon,
                exportDecision.kind === "assumption-eligible" && !requireVerifiedEvidence ? effective ? null : tariff?.export ?? null : null,
                exportDecision.kind === "rejected" ? rejectedExport : authenticatedExport.length ? authenticatedExport
                    : assumedExport.length ? assumedExport : tariff?.exportWindows ?? effective?.export ?? []),
        },
    };
}

export function getSitePriceSignal(site: Site, kraken: KrakenState | null, now: string): SitePricePlan {
    return getSitePriceSignalForPeriod(site, kraken, now,
        { start: now, end: new Date(Date.parse(now) + 48 * 60 * 60 * 1000).toISOString() });
}
