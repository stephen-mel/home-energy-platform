import type { PriceSignal } from "../tariff/types";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { validOwnershipTimestamp } from "./ownership-evidence";
import { captureObservedTariff, type ObservedTariff } from "./observed-tariff";
import { representationKey } from "./rollback-evidence";

type TeslaMode = "self_consumption" | "autonomous" | "backup";
export type TeslaCurrentState = {
    source: { kind: "tesla-site-info"; energySiteId: string; observedAt: string; timeZone: string | null };
    tariff: ObservedTariff;
    operatingMode: TeslaMode | null;
    diagnostics: string[];
};
export type ExpectedEonState = {
    source: { kind: "kraken-account-tariff"; siteId: string; observedAt: string; timeZone: string };
    signal: PriceSignal;
    diagnostics: string[];
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const freeze = <T>(value: T, seen = new Set<object>()): T => {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value);
    }
    return value;
};
const validTimeZone = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: value }); return true; } catch { return false; }
};
const age = (observedAt: string, assessedAt: string, maxAgeMs: number) => {
    if (!validOwnershipTimestamp(observedAt) || !validOwnershipTimestamp(assessedAt)
        || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return "invalid" as const;
    const difference = Date.parse(assessedAt) - Date.parse(observedAt);
    return difference < 0 ? "future" as const : difference > maxAgeMs ? "stale" as const : "fresh" as const;
};
const strings = (value: unknown): value is string[] => Array.isArray(value)
    && Array.from(value).every(item => typeof item === "string");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const enumValue = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
    typeof value === "string" && allowed.includes(value as T);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const domain = (value: unknown): value is { start: string; end: string } => object(value) && keys(value, ["start", "end"])
    && validOwnershipTimestamp(value.start) && validOwnershipTimestamp(value.end) && Date.parse(value.end) > Date.parse(value.start);
const cause = (value: unknown) => object(value) && keys(value, ["kind", "assetId", "start", "end", "dispatchType"], ["assetName"])
    && value.kind === "ev-dispatch" && text(value.assetId) && (value.assetName === undefined || typeof value.assetName === "string")
    && validOwnershipTimestamp(value.start) && validOwnershipTimestamp(value.end) && Date.parse(value.end) > Date.parse(value.start)
    && text(value.dispatchType);
const provenance = (value: unknown) => object(value)
    && keys(value, ["provider", "description", "observedAt", "stale"], ["tariffVersion", "cause"])
    && text(value.provider) && typeof value.description === "string"
    && validOwnershipTimestamp(value.observedAt) && typeof value.stale === "boolean"
    && (value.tariffVersion === undefined || text(value.tariffVersion))
    && (value.cause === undefined || cause(value.cause));
const price = (value: unknown) => value === null || object(value) && keys(value, ["amount", "currency", "unit"])
    && typeof value.amount === "number" && Number.isFinite(value.amount) && text(value.currency) && value.unit === "kWh";
const eligibility = (value: unknown) => object(value) && keys(value, ["start", "end", "assessmentPeriod", "state", "sources"])
    && validOwnershipTimestamp(value.start) && validOwnershipTimestamp(value.end) && Date.parse(value.end) > Date.parse(value.start)
    && domain(value.assessmentPeriod) && enumValue(value.state, ["planned-conditional", "observed-qualified", "billed-verified"])
    && Array.isArray(value.sources) && Array.from(value.sources).every(provenance);
const window = (value: unknown) => object(value)
    && keys(value, ["start", "end", "price", "priceStatus", "kind", "condition", "stale", "sources", "eligibilityPeriods"])
    && validOwnershipTimestamp(value.start)
    && validOwnershipTimestamp(value.end) && Date.parse(value.end) > Date.parse(value.start)
    && price(value.price) && enumValue(value.priceStatus, ["known", "unknown", "conflicting"])
    && enumValue(value.kind, ["standard", "guaranteed-off-peak", "cheap-opportunity"])
    && enumValue(value.condition, ["none", "scheduled-ev-charging"]) && typeof value.stale === "boolean"
    && Array.isArray(value.sources) && Array.from(value.sources).every(provenance)
    && Array.isArray(value.eligibilityPeriods) && Array.from(value.eligibilityPeriods).every(eligibility);
const exactObservedTariff = (value: unknown) => {
    try { return inspectObservedProposalTariff(value).exact; } catch { return false; }
};
function validTeslaEnvelope(value: unknown): value is TeslaCurrentState {
    if (!object(value) || !keys(value, ["source", "tariff", "operatingMode", "diagnostics"])
        || !object(value.source) || !keys(value.source, ["kind", "energySiteId", "observedAt", "timeZone"])
        || !object(value.tariff) || !keys(value.tariff, ["source", "tariff", "diagnostics", "rollbackProven"], ["representations"])
        || !object(value.tariff.source) || !keys(value.tariff.source, ["kind", "energySiteId", "observedAt", "timeZone"])
        || value.source.kind !== "tesla-site-info" || value.tariff.source.kind !== "tesla-site-info"
        || typeof value.source.energySiteId !== "string" || !/^\d+$/.test(value.source.energySiteId)
        || typeof value.tariff.source.energySiteId !== "string" || !/^\d+$/.test(value.tariff.source.energySiteId)
        || !validOwnershipTimestamp(value.source.observedAt) || !validOwnershipTimestamp(value.tariff.source.observedAt)
        || !(value.source.timeZone === null || validTimeZone(value.source.timeZone))
        || !(value.tariff.source.timeZone === null || validTimeZone(value.tariff.source.timeZone))
        || !strings(value.diagnostics) || !strings(value.tariff.diagnostics) || value.tariff.rollbackProven !== false
        || !(value.operatingMode === null || enumValue(value.operatingMode, ["self_consumption", "autonomous", "backup"]))) return false;
    const pair = value.tariff.representations;
    if (pair !== undefined && (!object(pair) || !keys(pair, ["v2", "legacy", "relationship"])
        || !enumValue(pair.relationship, ["consistent", "conflicting", "unverifiable"]))) return false;
    return value.tariff.tariff === null || object(value.tariff.tariff);
}
function validExpectedEnvelope(value: unknown): value is ExpectedEonState {
    if (!object(value) || !keys(value, ["source", "signal", "diagnostics"])
        || !object(value.source) || !keys(value.source, ["kind", "siteId", "observedAt", "timeZone"])
        || !object(value.signal) || !keys(value.signal, ["scope", "generatedAt", "horizon", "import", "export"])
        || value.source.kind !== "kraken-account-tariff" || !text(value.source.siteId)
        || !validOwnershipTimestamp(value.source.observedAt) || !validTimeZone(value.source.timeZone)
        || !strings(value.diagnostics) || value.signal.scope !== "whole-home"
        || !validOwnershipTimestamp(value.signal.generatedAt) || !domain(value.signal.horizon)
        || !Array.isArray(value.signal.import) || !Array.isArray(value.signal.export)) return false;
    return [...value.signal.import, ...value.signal.export].every(window);
}

/** Pure extraction from one already authenticated site_info response. */
export function captureTeslaCurrentState(siteInfo: unknown, energySiteId: string, observedAt: string): TeslaCurrentState {
    const body = object(siteInfo) && object(siteInfo.response) ? siteInfo.response : siteInfo;
    const tariff = captureObservedTariff(siteInfo, energySiteId, observedAt);
    const diagnostics = [...tariff.diagnostics];
    if (object(body) && body.energy_site_id !== undefined) {
        const embedded = typeof body.energy_site_id === "string" ? body.energy_site_id
            : typeof body.energy_site_id === "number" && Number.isSafeInteger(body.energy_site_id)
                ? body.energy_site_id.toString(10) : null;
        if (embedded === null) diagnostics.push("TESLA_SITE_IDENTITY_INVALID");
        else if (embedded !== energySiteId) diagnostics.push("TESLA_SITE_MISMATCH");
    }
    const rawMode = object(body) ? body.default_real_mode : undefined;
    const operatingMode = enumValue(rawMode, ["self_consumption", "autonomous", "backup"] as const) ? rawMode : null;
    if (operatingMode === null) diagnostics.push(rawMode === undefined ? "OPERATING_MODE_UNAVAILABLE" : "OPERATING_MODE_UNRECOGNIZED");
    const source = { kind: "tesla-site-info" as const, energySiteId: tariff.source.energySiteId,
        observedAt: tariff.source.observedAt, timeZone: tariff.source.timeZone };
    return freeze({ source, tariff: structuredClone(tariff), operatingMode,
        diagnostics: [...new Set(diagnostics)].sort() });
}

/** Read-only comparison. This does not consume historical evidence or grant authority. */
export function assessTrustedCurrentBaseline(input: {
    siteId: string; energySiteId: string; timeZone: string; assessedAt: string; maxEvidenceAgeMs: number;
    domain: { start: string; end: string }; tesla: TeslaCurrentState | null; expected: ExpectedEonState | null;
}) {
    const requestValid = object(input);
    const siteId = requestValid && text(input.siteId) ? input.siteId : null;
    const energySiteId = requestValid && typeof input.energySiteId === "string" && /^\d+$/.test(input.energySiteId)
        ? input.energySiteId : null;
    const timeZone = requestValid && validTimeZone(input.timeZone) ? input.timeZone : null;
    const assessedAt = requestValid && validOwnershipTimestamp(input.assessedAt) ? input.assessedAt : null;
    const maxEvidenceAgeMs = requestValid && typeof input.maxEvidenceAgeMs === "number"
        && Number.isFinite(input.maxEvidenceAgeMs) && input.maxEvidenceAgeMs >= 0 ? input.maxEvidenceAgeMs : null;
    const comparisonDomain = requestValid && domain(input.domain) ? structuredClone(input.domain) : null;
    const rawTesla = requestValid ? input.tesla : null, rawExpected = requestValid ? input.expected : null;
    let teslaValue: unknown = null, expectedValue: unknown = null;
    try { teslaValue = rawTesla === null ? null : structuredClone(rawTesla);
        expectedValue = rawExpected === null ? null : structuredClone(rawExpected); } catch { /* fail closed below */ }
    const teslaMalformed = rawTesla !== null && !validTeslaEnvelope(teslaValue);
    const expectedMalformed = rawExpected !== null && !validExpectedEnvelope(expectedValue);
    const tesla = validTeslaEnvelope(teslaValue) ? teslaValue : null;
    const expected = validExpectedEnvelope(expectedValue) ? expectedValue : null;
    const blockers = new Set<string>();
    if (!requestValid || !siteId || !energySiteId || !timeZone || !assessedAt || maxEvidenceAgeMs === null)
        blockers.add("ASSESSMENT_REQUEST_INVALID");
    if (!comparisonDomain) blockers.add("COMPARISON_DOMAIN_INVALID");
    const teslaFreshness = tesla && assessedAt && maxEvidenceAgeMs !== null
        ? age(tesla.source.observedAt, assessedAt, maxEvidenceAgeMs) : "invalid";
    const expectedFreshness = expected && assessedAt && maxEvidenceAgeMs !== null
        ? age(expected.source.observedAt, assessedAt, maxEvidenceAgeMs) : "invalid";
    const teslaBound = !!timeZone && !!energySiteId && !!tesla && tesla.source.kind === "tesla-site-info"
        && tesla.tariff.source.kind === "tesla-site-info" && tesla.source.energySiteId === energySiteId
        && tesla.source.timeZone === timeZone && !tesla.diagnostics.includes("TESLA_SITE_MISMATCH")
        && !tesla.diagnostics.includes("TESLA_SITE_IDENTITY_INVALID")
        && representationKey(tesla.source) === representationKey(tesla.tariff.source);
    const expectedBound = !!timeZone && !!siteId && !!expected && expected.source.siteId === siteId && expected.source.timeZone === timeZone
        && expected.source.kind === "kraken-account-tariff";
    const teslaComplete = !!tesla?.tariff.tariff && exactObservedTariff(tesla.tariff.tariff)
        && !tesla.tariff.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")
        // Envelope shape and completeness remain separate diagnostics. Reuse the
        // shared strict validator for raw/extracted identity and dual coverage.
        && (tesla.tariff.representations === undefined || validateTeslaInspectionEvidence(tesla.tariff) !== null);
    const expectedSourcesValid = !!expected && [...expected.signal.import, ...expected.signal.export].every(window =>
        window.sources.length > 0 && Array.from(window.sources).every(source =>
            source.provider === "eon-next-kraken" && source.observedAt === expected.source.observedAt && source.stale === false));
    let expectedSignalComplete = false;
    try { expectedSignalComplete = !!expected && !!comparisonDomain
        && comparePriceSignalsInDomain(expected.signal, expected.signal, comparisonDomain).status === "unchanged"; } catch { /* invalid */ }
    const expectedComplete = !!expected && expected.diagnostics.length === 0 && expected.signal.scope === "whole-home"
        && expected.signal.generatedAt === expected.source.observedAt && expectedSourcesValid
        && !!comparisonDomain && expected.signal.horizon.start === comparisonDomain.start && expected.signal.horizon.end === comparisonDomain.end
        && expectedSignalComplete;
    if (teslaMalformed) blockers.add("TESLA_EVIDENCE_MALFORMED");
    else if (!tesla) blockers.add("TESLA_OBSERVATION_MISSING");
    else {
        if (!teslaBound) blockers.add("TESLA_IDENTITY_OR_TIMEZONE_MISMATCH");
        if (teslaFreshness !== "fresh") blockers.add(`TESLA_OBSERVATION_${teslaFreshness.toUpperCase()}`);
        if (!teslaComplete) blockers.add("TESLA_TARIFF_INCOMPLETE");
    }
    if (expectedMalformed) blockers.add("EXPECTED_EON_EVIDENCE_MALFORMED");
    else if (!expected) blockers.add("EXPECTED_EON_EVIDENCE_MISSING");
    else {
        if (!expectedBound) blockers.add("EXPECTED_EON_IDENTITY_OR_TIMEZONE_MISMATCH");
        if (expectedFreshness !== "fresh") blockers.add(`EXPECTED_EON_EVIDENCE_${expectedFreshness.toUpperCase()}`);
        if (!expectedComplete) blockers.add("EXPECTED_EON_EVIDENCE_INCOMPLETE");
        // The authenticated Kraken refresh validates a session-derived accountRef,
        // but the configured import identity and this structural price signal do
        // not carry an independently verifiable expected account identity.
        blockers.add("EXPECTED_EON_ACCOUNT_BINDING_UNAVAILABLE");
    }
    const comparison = null;
    const status = "insufficient-evidence" as const;
    return freeze({ status, siteBinding: { siteId, energySiteId, timeZone },
        tesla: tesla ? { source: tesla.source, freshness: teslaFreshness, operatingMode: tesla.operatingMode,
            operatingModeStatus: tesla.operatingMode ? "observed" : "unknown",
            tariffFingerprint: teslaComplete ? representationKey(tesla.tariff.tariff) : null,
            diagnostics: tesla.diagnostics } : null,
        expected: expected ? { source: expected.source, freshness: expectedFreshness,
            economicFingerprint: null,
            diagnostics: expected.diagnostics } : null,
        comparison, blockers: [...blockers].sort(), evidenceOnly: true as const, assessmentOnly: true as const,
        resolvesHistoricalJournal: false as const, writeReady: false as const, rollbackProven: false as const,
        restorationProven: false as const, grantsRepeatAuthority: false as const });
}
