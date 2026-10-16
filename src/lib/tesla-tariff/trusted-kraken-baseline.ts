import "server-only";
import type { Site } from "../site/types";
import { getKrakenState, type KrakenState } from "../site/kraken-state";
import { getSitePriceSignalForPeriod } from "../site/get-site-price-signal";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { representationKey } from "./rollback-evidence";
import { monetarySignal, observedEconomicSignal } from "./observed-economic";
import { assessTrustedCurrentBaseline, type TeslaCurrentState } from "./current-baseline";
import { validOwnershipTimestamp } from "./ownership-evidence";

type Input = {
    site: Site;
    tesla: TeslaCurrentState | null;
    domain: { start: string; end: string };
    assessedAt: string;
    maxEvidenceAgeMs: number;
};

const opaqueReference = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validDomain = (value: unknown): value is { start: string; end: string } => object(value)
    && validOwnershipTimestamp(value.start) && validOwnershipTimestamp(value.end)
    && Date.parse(value.start) < Date.parse(value.end);
const withoutBindingBlocker = (blockers: string[]) => blockers.filter(code => code !== "EXPECTED_EON_ACCOUNT_BINDING_UNAVAILABLE");
const withBlockers = <T extends { blockers: string[] }>(result: T, extra: string[]) => Object.freeze(structuredClone({
    ...result, status: "insufficient-evidence" as const, comparison: null,
    blockers: [...new Set([...result.blockers, ...extra])].sort(),
}));
const invalidResult = (codes: string[]) => Object.freeze({ status: "insufficient-evidence" as const,
    siteBinding: { siteId: null, energySiteId: null, timeZone: null }, tesla: null, expected: null,
    comparison: null, blockers: [...new Set(codes)].sort(), evidenceOnly: true as const, assessmentOnly: true as const,
    resolvesHistoricalJournal: false as const, writeReady: false as const, rollbackProven: false as const,
    restorationProven: false as const, grantsRepeatAuthority: false as const });

function identityBlockers(site: Site, state: KrakenState): string[] {
    const blockers: string[] = [];
    const importIdentity = site.integrations.kraken.importTariffIdentity;
    if (!importIdentity || !opaqueReference(importIdentity.accountRef)) blockers.push("EXPECTED_EON_IMPORT_ACCOUNT_IDENTITY_UNCONFIGURED");
    if (!importIdentity || !opaqueReference(importIdentity.meterPointRef)) blockers.push("EXPECTED_EON_IMPORT_METER_POINT_IDENTITY_INVALID");
    if (!state.importTariff || state.importTariff.status !== "available") blockers.push("EXPECTED_EON_IMPORT_EVIDENCE_UNAVAILABLE");
    else if (state.importTariff.accountRef !== importIdentity?.accountRef
        || state.importTariff.agreement.meterPointRef !== importIdentity?.meterPointRef
        || state.importTariff.agreement.tariffCode !== importIdentity?.tariffCode)
        blockers.push("EXPECTED_EON_IMPORT_IDENTITY_MISMATCH");

    const exportIdentity = site.integrations.kraken.exportTariffIdentity;
    if (!exportIdentity || !opaqueReference(exportIdentity.accountRef)) blockers.push("EXPECTED_EON_EXPORT_ACCOUNT_IDENTITY_UNCONFIGURED");
    if (!exportIdentity || !opaqueReference(exportIdentity.meterPointRef)) blockers.push("EXPECTED_EON_EXPORT_METER_POINT_IDENTITY_UNVERIFIED");
    if (!state.exportTariff || state.exportTariff.status !== "available") blockers.push("EXPECTED_EON_EXPORT_EVIDENCE_UNAVAILABLE");
    else {
        const agreement = state.exportTariff.agreement as typeof state.exportTariff.agreement & { meterPointRef?: string };
        if (state.exportTariff.accountRef !== exportIdentity?.accountRef
            || agreement.meterPointRef !== exportIdentity?.meterPointRef
            || agreement.productCode !== exportIdentity?.productCode
            || agreement.tariffCode !== exportIdentity?.tariffCode)
            blockers.push("EXPECTED_EON_EXPORT_IDENTITY_MISMATCH");
    }
    if (state.stale) blockers.push("EXPECTED_EON_AUTHENTICATED_EVIDENCE_STALE");
    return blockers;
}

// This function remains module-private: account-bound comparison cannot be
// invoked with caller-supplied Kraken state or a caller-constructed signal.
function compareAccountBound(input: Input, state: KrakenState) {
    const acquisitionTimestamp = state.lastSuccessfulUpdate;
    if (!validOwnershipTimestamp(acquisitionTimestamp)) return invalidResult(["EXPECTED_EON_EVIDENCE_MALFORMED"]);
    const acquisitionAge = Date.parse(input.assessedAt) - Date.parse(acquisitionTimestamp);
    if (acquisitionAge < 0) return invalidResult(["EXPECTED_EON_EVIDENCE_FUTURE"]);
    if (acquisitionAge > input.maxEvidenceAgeMs) return invalidResult(["EXPECTED_EON_EVIDENCE_STALE"]);
    const plan = getSitePriceSignalForPeriod(input.site, state, input.assessedAt, input.domain, true);
    const acquiredSignal = { ...plan.signal, generatedAt: acquisitionTimestamp };
    const expected = { source: { kind: "kraken-account-tariff" as const, siteId: input.site.id,
        observedAt: acquisitionTimestamp, timeZone: plan.timeZone }, signal: acquiredSignal, diagnostics: [] };
    const structural = assessTrustedCurrentBaseline({ siteId: input.site.id,
        energySiteId: input.site.integrations.tesla.energySiteId ?? "", timeZone: plan.timeZone,
        assessedAt: input.assessedAt, maxEvidenceAgeMs: input.maxEvidenceAgeMs,
        domain: input.domain, tesla: input.tesla, expected });
    const blockers = [...identityBlockers(input.site, state), ...withoutBindingBlocker(structural.blockers)];
    if (blockers.length || !input.tesla) return withBlockers(structural, blockers);
    try {
        const comparison = comparePriceSignalsInDomain(
            monetarySignal(observedEconomicSignal(input.tesla.tariff, input.domain).signal),
            monetarySignal(acquiredSignal), input.domain);
        if (comparison.status === "indeterminate") return withBlockers(structural, ["EXPECTED_EON_COMPARISON_INDETERMINATE"]);
        return Object.freeze(structuredClone({ ...structural,
            status: comparison.status === "unchanged" ? "matches-expected-economics" as const
                : "differs-from-expected-economics" as const,
            blockers: [], comparison,
            expected: structural.expected ? { ...structural.expected,
                economicFingerprint: representationKey(acquiredSignal) } : null,
        }));
    } catch {
        return withBlockers(structural, ["EXPECTED_EON_COMPARISON_INDETERMINATE"]);
    }
}

/** Trusted server path. Callers cannot supply Kraken state, signals or identity claims. */
export async function assessTrustedCurrentBaselineFromKraken(input: Input) {
    if (!object(input) || !object(input.site) || typeof input.site.id !== "string" || !input.site.id
        || !object(input.site.integrations) || !object(input.site.integrations.tesla)
        || typeof input.site.integrations.tesla.energySiteId !== "string"
        || !validOwnershipTimestamp(input.assessedAt) || typeof input.maxEvidenceAgeMs !== "number"
        || !Number.isFinite(input.maxEvidenceAgeMs) || input.maxEvidenceAgeMs < 0)
        return invalidResult(["ASSESSMENT_REQUEST_INVALID"]);
    if (!validDomain(input.domain)) return invalidResult(["COMPARISON_DOMAIN_INVALID"]);
    const state = await getKrakenState(input.site, input.domain);
    return compareAccountBound(input, state);
}
