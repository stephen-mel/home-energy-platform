import { effectivePriceCurveKey } from "../tariff/compare-price-signal";
import type { PriceSignal } from "../tariff/types";
import { experimentTariff, inspectTariff } from "./experiment-tariff";
import type { TeslaTariffFragment } from "./dry-run";

export type TariffCaptureInput = {
    energySiteId: string;
    capturedAt: string;
    // Exact content must already be captured in the setting-content schema.
    // This tag is a caller assertion of provenance, not a site_info conversion.
    format: "site-info" | "tariff-content-v2";
    value: unknown;
};
export type ExperimentDiagnostic = { code: string; severity: "error" | "warning"; message: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const safeText = (v: unknown): v is string => typeof v === "string" && !/token|secret|password|authorization|private.?key|oauth|bearer|-----BEGIN/i.test(v);
const instant = (v: unknown) => safeText(v) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
const reference = (v: unknown) => safeText(v) && /^[A-Za-z0-9_-]{1,80}$/.test(v);

/** Deliberately excludes arbitrary response envelopes, auth material and settings
 * unrelated to tariffs. The admitted original tariff is retained, not normalized.
 */
export function captureExperimentTariff(input: TariffCaptureInput) {
    const body = object(input.value) && object(input.value.response) ? input.value.response : input.value;
    const siteInfo = input.format === "site-info" && object(body) ? body : null;
    const reportedSiteId = siteInfo?.energy_site_id;
    const siteIdentityMatches = reportedSiteId === undefined ||
        (typeof reportedSiteId === "string" || typeof reportedSiteId === "number") && String(reportedSiteId) === input.energySiteId;
    const ambiguous = !!siteInfo && siteInfo.tariff_content !== undefined && siteInfo.tariff_content_v2 !== undefined;
    const inspected = inspectTariff(siteInfo ? siteInfo.tariff_content_v2 ?? siteInfo.tariff_content : input.value);
    return {
        energySiteId: reference(input.energySiteId) ? input.energySiteId : null,
        capturedAt: instant(input.capturedAt) ? input.capturedAt : null,
        format: input.format === "tariff-content-v2" ? "tariff-content-v2" as const : "site-info" as const,
        originalTariffSnapshot: inspected.snapshot,
        snapshotComplete: inspected.exact,
        ambiguous, siteIdentityMatches,
        noPricingConstraintFlag: typeof siteInfo?.rate_plan_manager_no_pricing_constraint === "boolean"
            ? siteInfo.rate_plan_manager_no_pricing_constraint : null,
        // Structural read-back interpretation is not proof of inverse write mapping.
        interpretedTariff: !ambiguous && siteIdentityMatches ? inspected.tariff : null,
        structuralRestorationCandidate: input.format === "tariff-content-v2" ? inspected.tariff : null,
        exactRollbackTariff: null, // Format and shape never establish authoritative observation.
    };
}

const contextFields = new Set([
    "scope", "generatedAt", "horizon", "start", "end", "import", "export", "price", "amount", "currency", "unit",
    "priceStatus", "kind", "condition", "stale", "sources", "provider", "description", "tariffVersion", "observedAt",
    "cause", "assetId", "assetName", "dispatchType", "eligibilityPeriods", "assessmentPeriod", "state",
]);
function captureContext(signal: PriceSignal) {
    let omitted = false;
    const copy = (value: unknown): unknown => {
        if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") { if (safeText(value)) return value; omitted = true; return null; }
        if (Array.isArray(value)) return value.map(copy);
        if (object(value)) return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
            if (!contextFields.has(key)) { omitted = true; return []; }
            return [[key, copy(value[key])]];
        }));
        omitted = true; return null;
    };
    const snapshot = copy(signal) as PriceSignal;
    return { snapshot, omitted };
}

export type ExperimentRecord = ReturnType<typeof prepareTariffExperiment>;
export function prepareTariffExperiment(input: {
    experimentId: string;
    asOf: string;
    timeZone: string;
    before: TariffCaptureInput;
    signal: PriceSignal;
}) {
    const before = captureExperimentTariff(input.before);
    const context = captureContext(input.signal);
    const diagnostics: ExperimentDiagnostic[] = [];
    const add = (code: string, severity: ExperimentDiagnostic["severity"], message: string) => diagnostics.push({ code, severity, message });
    if (!reference(input.experimentId) || !instant(input.asOf) || !before.energySiteId || !before.capturedAt
        || Date.parse(input.before.capturedAt) > Date.parse(input.asOf)) add("INVALID_CAPTURE_IDENTITY", "error", "Explicit valid identity and capture/as-of times are required; capture cannot be in the future.");
    let timeZone: string | null = null;
    try { if (!safeText(input.timeZone)) throw new Error(); new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone }); timeZone = input.timeZone; }
    catch { add("INVALID_TIMEZONE", "error", "An explicit valid tariff timezone is required."); }
    if (!before.siteIdentityMatches) add("SITE_IDENTITY_MISMATCH", "error", "Captured site identity differs from the supplied experiment site.");
    if (!before.exactRollbackTariff) add("ROLLBACK_UNPROVEN", "error", "No lossless complete setting-content capture is available. Site-info alone does not prove an inverse write mapping.");
    if (!before.snapshotComplete || before.ambiguous) add("SNAPSHOT_INCOMPLETE", "error", "Tariff capture contains unsupported, missing, ambiguous or omitted fields; no structure is invented.");
    if (context.omitted) add("CONTEXT_FIELDS_OMITTED", "warning", "Only allowlisted economic context was captured; extra or sensitive fields were omitted.");
    let economicKey: string | null = null;
    try { economicKey = effectivePriceCurveKey(context.snapshot); }
    catch { add("INVALID_HEP_CONTEXT", "error", "The supplied economic context could not be compared."); }
    add("BUY_BELOW_SELL_EXPERIMENT", "warning", "The intended 0.0299 buy / 0.175 sell relationship may be normalized or rejected. This is the test subject, not a safe production tariff.");
    add("FLAG_NOT_INTERPRETED", "warning", "The observed no-pricing-constraint flag establishes neither permission nor causation.");
    add("MANUAL_RESTORE_REQUIRED", "warning", "The synthetic flat tariff has no automatic expiry. Future execution requires explicit approval, read-back and restoration; none is implemented here.");
    const blockers = diagnostics.filter(d => d.severity === "error");
    return {
        version: 1 as const,
        experimentId: reference(input.experimentId) ? input.experimentId : null,
        asOf: instant(input.asOf) ? input.asOf : null,
        energySiteId: before.energySiteId, timeZone,
        state: blockers.length ? "blocked" as const : "ready-for-human-approval" as const,
        before,
        intended: { purpose: "temporary-pricing-constraint-experiment" as const,
            buy: { amount: 0.0299, currency: "GBP", unit: "kWh" }, sell: { amount: 0.175, currency: "GBP", unit: "kWh" },
            tariffContentV2: experimentTariff() },
        rollback: { proof: before.exactRollbackTariff ? "validated-exact-setting-content" as const : "unproven" as const,
            tariffContentV2: before.exactRollbackTariff },
        hepContext: { signal: context.snapshot, economicKey,
            // Preserve windows/individual causes and half-hour evidence independently.
            guaranteedPeriods: context.snapshot.import.filter(w => w.kind === "guaranteed-off-peak"),
            smartPeriods: context.snapshot.import.filter(w => w.condition === "scheduled-ev-charging") },
        diagnostics, blockers, warnings: diagnostics.filter(d => d.severity === "warning"),
        later: { readBack: null, comparison: null, rollbackReadBack: null, rollbackVerification: null },
        inspectionOnly: true as const, writeReady: false as const, writePayload: null,
    };
}

function flatPrices(tariff: TeslaTariffFragment) {
    const rates = (side: TeslaTariffFragment | TeslaTariffFragment["sell_tariff"]) =>
        [...new Set(Object.values(side.energy_charges).flatMap(c => Object.values(c.rates)))];
    const buy = rates(tariff), sell = rates(tariff.sell_tariff);
    return buy.length === 1 && sell.length === 1 ? { buy: buy[0], sell: sell[0], currency: tariff.currency } : null;
}

/** Observation classification only. It proves neither a write nor billing nor
 * the cause of Tesla behaviour. A failed write cannot be inferred from read-back.
 */
export function compareTariffExperiment(input: {
    before: TariffCaptureInput;
    intended: unknown;
    readBack: TariffCaptureInput | null;
}) {
    const before = captureExperimentTariff(input.before);
    const after = input.readBack ? captureExperimentTariff(input.readBack) : null;
    const intended = inspectTariff(input.intended);
    const target = intended.tariff ? flatPrices(intended.tariff) : null;
    const actual = after?.interpretedTariff ? flatPrices(after.interpretedTariff) : null;
    const prior = before.interpretedTariff ? flatPrices(before.interpretedTariff) : null;
    const sufficient = target && before.interpretedTariff && before.capturedAt && after?.capturedAt
        && before.energySiteId && before.energySiteId === after.energySiteId
        && Date.parse(after.capturedAt) > Date.parse(before.capturedAt) && after.interpretedTariff;
    const outcome = !sufficient ? "unreadable/insufficient" as const
        : actual && actual.buy === target.buy && actual.sell === target.sell ? "preserved" as const
            : actual && target.buy < target.sell && actual.buy === target.sell && actual.sell === target.sell ? "buy-raised-to-sell" as const
                : "different" as const;
    return { outcome, before, intendedSnapshot: intended.snapshot, readBack: after,
        evidence: { intendedPrices: target, observedPrices: actual, previousPrices: prior,
            baselineAlreadyMatches: target && prior ? target.buy === prior.buy && target.sell === prior.sell : null },
        writeAcceptance: "not-established" as const, causation: "not-inferred" as const,
        inspectionOnly: true as const, writeReady: false as const };
}
