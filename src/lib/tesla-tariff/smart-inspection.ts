import { updateScheduleObservation } from "../kraken/schedule-observation";
import { createHash } from "node:crypto";
import type { Site } from "../site/types";
import type { KrakenState } from "../site/kraken-state";
import type { KrakenImportTariffEvidence } from "../kraken/import-tariff";
import type { ObservedTariff } from "./observed-tariff";
import { reconcileTeslaTariff, unavailableReconciliation } from "./reconciliation";
import { siteWithKrakenImportTariff } from "../site/get-site-price-signal";
import { krakenDispatchPriceWindows } from "../tariff/kraken-dispatches";
import { economicInstant } from "../tariff/resolve-economic-model";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { smartEvidenceKey } from "./smart-evidence";
import { representationKey } from "./rollback-evidence";
import { assessFreshBaselineEligibility } from "./fresh-baseline-eligibility";

const digest = (value: unknown) => createHash("sha256").update(representationKey(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(economicInstant(value));

/** Copy fixed external evidence without invoking accessors or retaining aliases.
 * This is local to inspection; it is not an authentication or generic schema layer. */
function snapshotEvidence(value: unknown, seen = new Set<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean"
        || typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || seen.has(value)) throw Error("INVALID_EVIDENCE");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor");
    const namedConstructor = constructor && "value" in constructor && typeof constructor.value === "function"
        ? constructor.value.name : null;
    const plain = array ? namedConstructor === "Array"
        : prototype === null || Object.getPrototypeOf(prototype) === null && namedConstructor === "Object";
    if (!plain) throw Error("INVALID_EVIDENCE");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string")) throw Error("INVALID_EVIDENCE");
    if (array) {
        const length = descriptors.length;
        if (!length || !("value" in length) || !Number.isInteger(length.value)
            || Object.keys(descriptors).length !== length.value + 1) throw Error("INVALID_EVIDENCE");
    }
    seen.add(value);
    const result: unknown[] | Record<string, unknown> = array ? [] : {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === "length") continue;
        if (!("value" in descriptor) || !descriptor.enumerable || ["__proto__", "constructor", "prototype"].includes(key))
            throw Error("INVALID_EVIDENCE");
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (descriptors.length as PropertyDescriptor & { value: number }).value))
            throw Error("INVALID_EVIDENCE");
        // Cache reconstruction represents absent optional object fields as own
        // properties with undefined values. Preserve absence without inventing a
        // value; fixed-shape validators still reject required fields so omitted.
        if (!array && descriptor.value === undefined) continue;
        const copied = snapshotEvidence(descriptor.value, seen);
        if (array) (result as unknown[])[Number(key)] = copied;
        else (result as Record<string, unknown>)[key] = copied;
    }
    return result;
}

const price = (value: unknown, unit: "kWh" | "day") => object(value)
    && exact(value, ["amount", "currency", "unit"])
    && typeof value.amount === "number" && Number.isFinite(value.amount)
    && value.currency === "GBP" && value.unit === unit;

function validatedImportTariff(value: unknown): KrakenImportTariffEvidence | null {
    if (!object(value) || !exact(value, ["status", "accountRef", "observedAt", "agreement", "version", "exportStatus"])
        || value.status !== "available" || !text(value.accountRef) || !timestamp(value.observedAt)
        || value.exportStatus !== "unknown" || !object(value.agreement) || !object(value.version)) return null;
    const agreement = value.agreement, version = value.version;
    if (!exact(agreement, ["validFrom", "validTo", "productCode", "tariffCode", "meterPointRef"])
        || !timestamp(agreement.validFrom) || !timestamp(agreement.validTo) || !text(agreement.productCode)
        || !text(agreement.tariffCode) || !text(agreement.meterPointRef)
        || Date.parse(agreement.validFrom) >= Date.parse(agreement.validTo)
        || Date.parse(value.observedAt) < Date.parse(agreement.validFrom) || Date.parse(value.observedAt) >= Date.parse(agreement.validTo)
        || !exact(version, ["id", "name", "provider", "effectiveFrom", "effectiveTo", "pricesIncludeVat", "normalImport",
            "export", "scheduledChargingImport", "standingCharge", "dailyImportWindows"])
        || !text(version.id) || !text(version.name) || version.provider !== "eon-next-kraken"
        || !timestamp(version.effectiveFrom) || !timestamp(version.effectiveTo)
        || Date.parse(version.effectiveFrom) < Date.parse(agreement.validFrom)
        || Date.parse(version.effectiveTo) > Date.parse(agreement.validTo)
        || Date.parse(version.effectiveFrom) >= Date.parse(version.effectiveTo)
        || version.pricesIncludeVat !== true || !price(version.normalImport, "kWh")
        || version.export !== null || !price(version.scheduledChargingImport, "kWh") || version.standingCharge !== null
        || !Array.isArray(version.dailyImportWindows) || version.dailyImportWindows.length !== 1) return null;
    const window = version.dailyImportWindows[0];
    if (!object(window) || !exact(window, ["start", "end", "price", "kind"])
        || window.start !== "00:00" || window.end !== "06:00" || window.kind !== "guaranteed-off-peak"
        || !price(window.price, "kWh")
        || representationKey(window.price) !== representationKey(version.scheduledChargingImport)) return null;
    return value as unknown as KrakenImportTariffEvidence;
}

function validatedTeslaObservation(value: unknown): ObservedTariff | null {
    if (!object(value) || !exact(value, ["source", "tariff", "diagnostics", "rollbackProven"])
        || !object(value.source) || !exact(value.source, ["kind", "energySiteId", "observedAt", "timeZone"])
        || value.source.kind !== "tesla-site-info" || !text(value.source.energySiteId)
        || !timestamp(value.source.observedAt) || !text(value.source.timeZone)
        || !Array.isArray(value.diagnostics) || value.diagnostics.some(item => typeof item !== "string")
        || value.rollbackProven !== false) return null;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: value.source.timeZone }); } catch { return null; }
    const inspected = inspectObservedProposalTariff(value.tariff);
    if (!inspected.exact || !inspected.tariff || value.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")) return null;
    return { source: value.source as ObservedTariff["source"], tariff: inspected.tariff,
        diagnostics: [...value.diagnostics] as string[], rollbackProven: false };
}

/** Pure inspection of production-acquired snapshots, never an authentication or
 * approval boundary. No ownership is inferred, loaded or created here. */
export function inspectSmartTariff(input: {
    site: Site; kraken: KrakenState | null; observation: ObservedTariff | null; now: string;
}) {
    const { site, now } = input;
    let detachedKraken: KrakenState | null = null, detachedObservation: ObservedTariff | null = null;
    let krakenInvalid = false, teslaInvalid = false;
    if (input.kraken) {
        try {
            detachedKraken = snapshotEvidence(input.kraken) as KrakenState;
            const evidence = validatedImportTariff(detachedKraken.importTariff);
            if (!evidence) { detachedKraken = null; krakenInvalid = true; }
            else detachedKraken.importTariff = evidence;
        } catch { krakenInvalid = true; }
    }
    if (input.observation) {
        try {
            const snapshot = snapshotEvidence(input.observation);
            detachedObservation = validatedTeslaObservation(snapshot);
            teslaInvalid = detachedObservation === null;
        } catch { teslaInvalid = true; }
    }
    const observation = detachedObservation;
    // Reuse the observation validator for completeness/shape, not as proof of
    // authentication. Only the server acquisition entry point supplies provenance.
    const schedule = detachedKraken ? updateScheduleObservation(null, { scopeId: site.id,
        startedAt: detachedKraken.lastSuccessfulUpdate, retrievedAt: detachedKraken.lastSuccessfulUpdate,
        provenance: "authenticated-query", status: "complete", vehicles: detachedKraken.vehicles }) : null;
    const kraken = schedule?.current ? detachedKraken : null;
    const time = Date.parse(now);
    const comparisonStart = Number.isFinite(time) ? Math.ceil(time / 60_000) * 60_000 : NaN;
    const identity = site.integrations.kraken.importTariffIdentity;
    const economicSite = siteWithKrakenImportTariff(site, kraken, now, true);
    const version = economicSite.tariff?.versions?.[0];
    const bound = !!identity && !!kraken?.importTariff?.accountRef
        && (!identity.accountRef || identity.accountRef === kraken.importTariff.accountRef);
    const verified = bound && !!version && !kraken?.importTariffDiagnostic;
    // A structurally validated, account-bound tariff may define the requested
    // domain even when freshness projection rejects it. Reconciliation remains
    // authoritative for freshness; rejected prices are never exposed as verified.
    const domainVersion = bound && !kraken?.importTariffDiagnostic ? kraken?.importTariff?.version : null;
    const coverageStart = Date.parse(domainVersion?.effectiveFrom ?? ""), coverageEnd = Date.parse(domainVersion?.effectiveTo ?? "");
    const supportedEnd = comparisonStart + 48 * 3_600_000;
    const comparisonEnd = Math.min(coverageEnd, supportedEnd);
    const domain = { start: Number.isFinite(comparisonStart) ? new Date(comparisonStart).toISOString() : now,
        end: Number.isFinite(comparisonEnd) ? new Date(comparisonEnd).toISOString() : now };
    const relevantSmart = kraken?.vehicles.flatMap(vehicle => vehicle.plannedDispatches
        .filter(dispatch => dispatch.type === "SMART" && Date.parse(dispatch.end) > time)) ?? [];
    const tariffDomainUnavailable = !Number.isFinite(comparisonStart) || !Number.isFinite(coverageStart)
        || !Number.isFinite(coverageEnd) || comparisonStart >= coverageEnd || comparisonStart < coverageStart;
    const dispatchOutsideCoverage = relevantSmart.some(dispatch => {
        const start = Date.parse(dispatch.start), end = Date.parse(dispatch.end);
        return !Number.isFinite(start) || !Number.isFinite(end) || end <= start
            || Math.max(start, comparisonStart) < coverageStart || end > coverageEnd;
    });
    const dispatchOutsideSupportedHorizon = relevantSmart.some(dispatch => Date.parse(dispatch.end) > comparisonEnd);
    const reconciliation = krakenInvalid ? unavailableReconciliation("INSPECTION_KRAKEN_TARIFF_EVIDENCE_INVALID", domain)
        : teslaInvalid ? unavailableReconciliation("INSPECTION_TESLA_EVIDENCE_INVALID", domain)
        : !kraken ? unavailableReconciliation(input.kraken ? "INCOMPLETE_KRAKEN_OBSERVATION" : "KRAKEN_UNAVAILABLE", domain)
        : !bound || !domainVersion || !!kraken.importTariffDiagnostic
            ? unavailableReconciliation("VERIFIED_IMPORT_TARIFF_REQUIRED", domain)
        : tariffDomainUnavailable ? unavailableReconciliation("VERIFIED_IMPORT_TARIFF_DOMAIN_UNAVAILABLE", domain)
        : dispatchOutsideCoverage ? unavailableReconciliation("SMART_DISPATCH_OUTSIDE_VERIFIED_TARIFF_COVERAGE", domain)
        : dispatchOutsideSupportedHorizon ? unavailableReconciliation("SMART_DISPATCH_OUTSIDE_SUPPORTED_COMPARISON_HORIZON", domain)
        : !observation ? unavailableReconciliation("TESLA_OBSERVATION_UNAVAILABLE", domain)
        : reconcileTeslaTariff({ site, kraken, observation, now, comparisonDomain: domain,
            energySiteId: site.integrations.tesla.energySiteId ?? "" });
    // Reconciliation owns schedule freshness diagnostics. Authenticated tariff
    // projection is an additional prerequisite: configured site prices must
    // never make an otherwise usable result proposal-capable.
    const reachedReconciliation = !krakenInvalid && !teslaInvalid && !!kraken && bound && !!domainVersion
        && !kraken.importTariffDiagnostic && !tariffDomainUnavailable && !dispatchOutsideCoverage
        && !dispatchOutsideSupportedHorizon && !!observation;
    const result = reachedReconciliation && !verified && (!("diagnostic" in reconciliation)
        || reconciliation.diagnostic !== "STALE_KRAKEN_EVIDENCE")
        ? unavailableReconciliation("VERIFIED_IMPORT_TARIFF_REQUIRED", domain) : reconciliation;
    const proposal = result.proposal;
    const representation = proposal?.structurallyValid ? proposal.bound.representation : null;
    const payload = representation ? { tou_settings: { tariff_content_v2: representation } } : null;
    const rate = verified && version && time >= Date.parse(version.effectiveFrom)
        && time < Date.parse(version.effectiveTo) ? version.scheduledChargingImport ?? null : null;
    // Keep the exact supplier slots; do not manufacture a single continuous slot.
    const slots = kraken ? krakenDispatchPriceWindows(kraken, rate).filter(w =>
        Date.parse(w.end) > time && Date.parse(w.start) < Date.parse(domain.end)).map(w => ({
        start: w.start, end: w.end, vehicle: w.sources[0]?.cause?.assetName ?? "Unnamed vehicle",
        eligibility: "planned-conditional", price: version && Date.parse(w.start) >= Date.parse(version.effectiveFrom)
            && Date.parse(w.end) <= Date.parse(version.effectiveTo) ? w.price : null,
    })) : [];
    const restoration = "restoration" in result ? result.restoration.documentedEnvelopeCandidate : null;
    const exportPreserved = !!representation && !!observation?.tariff
        && representationKey(representation.sell_tariff) === representationKey(observation.tariff.sell_tariff);
    const actionStatus = !kraken || !observation ? "incomplete-evidence"
        : dispatchOutsideCoverage ? "dispatch-outside-verified-coverage"
            : dispatchOutsideSupportedHorizon ? "dispatch-outside-supported-horizon"
                : result.status === "indeterminate" || result.status === "blocked" ? "incomplete-evidence"
                    : relevantSmart.length === 0 ? "no-smart-windows"
                    : result.status === "in-sync" ? "no-managed-economic-change"
                        : payload ? "tariff-change-proposed" : "proposal-unavailable";
    const authority = { writeReady: false as const, rollbackProven: false as const,
        restorationProven: false as const, resolvesHistoricalJournal: false as const,
        grantsRepeatAuthority: false as const };
    const eligibility = payload && proposal && observation ? assessFreshBaselineEligibility({
        energySiteId: observation.source.energySiteId, timeZone: observation.source.timeZone!, assessedAt: now,
        maxObservationAgeMs: 60_000,
        current: { source: { kind: "tesla-site-info", energySiteId: observation.source.energySiteId,
            observedAt: observation.source.observedAt, timeZone: observation.source.timeZone },
        tariff: observation, operatingMode: null, diagnostics: ["OPERATING_MODE_UNAVAILABLE"] },
        ownership: { status: "unavailable", code: "OWNERSHIP_NOT_ASSESSED" }, proposal, approval: null,
        rollback: { representation: observation.tariff, maxAgeMs: 60_000 }, trustedRollbackObservations: [],
        historical: null, nextAttempt: null,
    }) : {
        status: actionStatus === "no-smart-windows" || actionStatus === "no-managed-economic-change"
            ? "not-applicable" as const : "not-assessable" as const,
        reason: actionStatus, blockers: [] as string[], nextAttempt: null,
        ...authority,
    };
    const normalImport = verified && version ? version.normalImport : null;
    const saving = payload && normalImport && rate && normalImport.currency === rate.currency && normalImport.unit === rate.unit
        ? { amount: normalImport.amount - rate.amount, currency: rate.currency, unit: rate.unit,
            status: "planned-conditional-estimate" as const } : null;
    const report = {
        mode: "inspection-only", status: result.status, generatedAt: now, domain,
        smartOpportunity: { status: actionStatus, activeOrUpcomingCount: relevantSmart.length },
        teslaBaseline: observation ? { source: observation.source, representation: observation.tariff,
            fingerprint: digest(observation.tariff) } : null,
        krakenTariff: verified && version ? { observedAt: kraken!.importTariff!.observedAt,
            effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo,
            normalImport: version.normalImport, scheduledChargingImport: version.scheduledChargingImport,
            pricesIncludeVat: version.pricesIncludeVat } : null,
        vehicles: kraken ? kraken.vehicles.map(vehicle => ({ vehicleId: vehicle.id, name: vehicle.name,
            dispatches: vehicle.plannedDispatches.map(dispatch => ({ ...dispatch })) })) : [],
        slots, importRate: rate, krakenObservedAt: kraken?.lastSuccessfulUpdate ?? null,
        evidenceAgeSeconds: kraken ? (time - Date.parse(kraken.lastSuccessfulUpdate)) / 1000 : null,
        scheduleEvidenceIdentity: kraken ? digest(smartEvidenceKey(kraken)) : null,
        scheduleRecording: kraken?.scheduleRecording ?? null,
        observationContentIdentity: schedule?.current ? digest(schedule.current.contentKey) : null,
        currentTeslaFingerprint: observation ? digest(observation.tariff) : null,
        proposalFingerprint: proposal?.fingerprint ? digest(proposal.fingerprint) : null,
        payload, payloadUnavailableReason: payload ? null : "diagnostic" in result ? result.diagnostic
            : result.status === "in-sync" ? "NO_MANAGED_ECONOMIC_CHANGE" : "REPRESENTATION_UNAVAILABLE",
        differences: "comparison" in result ? result.comparison.changedPeriods : [],
        exportPreserved, restorationCandidate: restoration,
        restorationFingerprint: restoration ? digest(restoration) : null,
        expiresAt: "freshness" in result ? result.freshness.expiresAt : null,
        blockers: [...new Set([...result.blockers, "EXECUTION_DISABLED", "OWNERSHIP_NOT_ASSESSED",
            "HISTORICAL_JOURNAL_UNRESOLVED", "TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE"])],
        financialImplications: { conditionalImportSavingPerKwh: saving,
            billingStatus: saving ? "estimated-not-billing-confirmed" as const : "unavailable" as const },
        freshBaselineEligibility: eligibility,
        limitations: ["Supplier SMART slots are conditional opportunities, not confirmed charging or billed discounts.",
            "Configured account binding is not independent CRM identity activation.",
            "Export MPAN evidence is unavailable; commercial export assumptions establish no authority.",
            "Restoration is a candidate only; inverse write mapping and acceptance are unproven.",
            "No journal was read: this report cannot resolve September or establish live-write eligibility."],
        ...authority,
    };
    return structuredClone(report);
}

export function formatSmartInspection(report: ReturnType<typeof inspectSmartTariff>): string {
    return ["HEP SMART tariff inspection — never write-ready",
        "A. Evidence and exact proposed change", JSON.stringify(report, null, 2),
        "B. Supplier scheduling: planned-conditional; not guaranteed billing.",
        "C. Assumptions/unavailable evidence: " + report.limitations.join(" "),
        "D. Execution blockers: " + report.blockers.join(", ")].join("\n");
}
