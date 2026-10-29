import { simulatedTariffObservation, type ObservedContent, type ObservedTariff } from "./observed-tariff";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { validOwnership, validOwnershipTimestamp } from "./ownership-evidence";
import type { OwnershipRead } from "./ownership-store";
import { ownershipFingerprint } from "./ownership-transition";
import { validLinkedClassifiedRecord, validLinkedInitialRecord, type LinkedClassifiedRecord, type LinkedInitialRecord } from "./linked-experiment-records";
import { compareObservedTariffReadBack } from "./restoration-review";
import { representationKey } from "./rollback-evidence";
import { classifyExperimentResult, type WriteResult } from "./supervised-experiment";

type HistoricalPair = {
    integrity: "linked-validated" | "legacy-unlinked";
    initial: LinkedInitialRecord | LegacyInitial;
    classified: LinkedClassifiedRecord | LegacyClassified;
    baseline: ObservedTariff;
    temporary: ObservedTariff;
    date: string;
    site: string;
};
type LegacyInitial = Record<string, unknown> & { review: { before: ObservedTariff; date: string;
    proposal: { bound: { energySiteId: string; representation: ObservedContent } } } };
type LegacyClassified = Record<string, unknown> & { completedAt: string; classification: string; apiWrite: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: object, expected: string[]) => Object.keys(value).sort().join() === expected.sort().join();
const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
function validSource(value: unknown, site: string) {
    if (!object(value) || !keys(value, ["kind", "energySiteId", "observedAt", "timeZone"])) return false;
    if (value.kind !== "tesla-site-info" || value.energySiteId !== site || !validOwnershipTimestamp(value.observedAt)) return false;
    if (typeof value.timeZone !== "string") return false;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: value.timeZone }); return true; } catch { return false; }
}
function validObservation(value: unknown, site: string): value is ObservedTariff {
    return object(value) && keys(value, ["source", "tariff", "diagnostics", "rollbackProven", ...(value.representations !== undefined ? ["representations"] : [])])
        && validSource(value.source, site) && (value.tariff === null || object(value.tariff))
        && Array.isArray(value.diagnostics) && value.diagnostics.every((item: unknown) => typeof item === "string")
        && value.rollbackProven === false;
}
function completeObservation(value: unknown, site: string): value is ObservedTariff & { tariff: ObservedContent } {
    return validObservation(value, site) && value.tariff !== null
        && validateTeslaInspectionEvidence(value) !== null;
}
function validSuppliedReadBackChronology(value: unknown) {
    if (!object(value) || !object(value.apiTariffReadBack)) return false;
    const readBack = value.apiTariffReadBack.observation;
    if (readBack === null) return true;
    if (!object(readBack) || !object(readBack.source) || !validOwnershipTimestamp(readBack.source.observedAt)
        || !validOwnershipTimestamp(value.attemptedAt) || !validOwnershipTimestamp(value.completedAt)) return false;
    const attemptedAt = Date.parse(value.attemptedAt), observedAt = Date.parse(readBack.source.observedAt);
    return attemptedAt < observedAt && observedAt <= Date.parse(value.completedAt);
}
function legacyPair(records: unknown[], site: string): HistoricalPair | null {
    if (records.length !== 2 || !object(records[0]) || !object(records[1])) return null;
    const initial = records[0], classified = records[1];
    const review = object(initial.review) ? initial.review : null;
    const proposal = review && object(review.proposal) ? review.proposal : null;
    const bound = proposal && object(proposal.bound) ? proposal.bound : null;
    const before = review?.before;
    if (!keys(initial, ["phase", "review", "exception", "preWriteRecheck"])
        || !keys(classified, ["phase", "attemptedAt", "completedAt", "exception", "apiWrite", "apiTariffReadBack", "classification",
            "laterTeslaAppObservation", "laterPowerwallOpticasterObservation", "rollbackProven", "productionWriteReady", "automaticRestoreAttempted"])
        || initial.phase !== "approval-consumed-before-write" || classified.phase !== "classified"
        || !review || !proposal || !bound || bound.energySiteId !== site
        || !completeObservation(before, site)
        || typeof review.date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(review.date)
        || !object(initial.preWriteRecheck) || initial.preWriteRecheck.tariffKey !== representationKey(before.tariff)
        || !same(initial.exception, classified.exception) || !validOwnershipTimestamp(classified.attemptedAt)
        || !validOwnershipTimestamp(classified.completedAt) || Date.parse(classified.completedAt) < Date.parse(classified.attemptedAt)
        || !object(classified.apiWrite) || !keys(classified.apiWrite, ["status", "httpStatus"])
        || typeof classified.apiWrite.status !== "string"
        || !["accepted", "rejected", "unknown"].includes(classified.apiWrite.status)
        || !(classified.apiWrite.httpStatus === null || typeof classified.apiWrite.httpStatus === "number"
            && Number.isFinite(classified.apiWrite.httpStatus) && Number.isInteger(classified.apiWrite.httpStatus)
            && classified.apiWrite.httpStatus >= 100 && classified.apiWrite.httpStatus <= 599)
        || classified.apiWrite.status === "accepted" && !(typeof classified.apiWrite.httpStatus === "number"
            && classified.apiWrite.httpStatus >= 200 && classified.apiWrite.httpStatus <= 299)
        || typeof classified.classification !== "string"
        || !["request-rejected", "write-outcome-unknown", "read-back-unavailable-or-insufficient", "submitted-representation-preserved",
            "buy-raised-to-sell", "accepted-but-transformed-differently"].includes(classified.classification)
        || classified.rollbackProven !== false || classified.productionWriteReady !== false || classified.automaticRestoreAttempted !== false
        || !object(bound.representation) || !object(classified.apiTariffReadBack)
        || !keys(classified.apiTariffReadBack, ["observation", "comparison"])) return null;
    const typedInitial = initial as LegacyInitial, typedClassified = classified as LegacyClassified;
    const temporary = simulatedTariffObservation(before, bound.representation as ObservedContent);
    const readBack = classified.apiTariffReadBack.observation;
    if (readBack !== null && !completeObservation(readBack, site)) return null;
    const comparison = compareObservedTariffReadBack({ intended: temporary, readBack: readBack as ObservedTariff | null,
        after: classified.attemptedAt, dates: [review.date] });
    if (!same(classified.apiTariffReadBack.comparison, comparison)
        || classified.classification !== classifyExperimentResult(classified.apiWrite as WriteResult, temporary,
            readBack as ObservedTariff | null, comparison)) return null;
    if (!validSuppliedReadBackChronology(classified)) return null;
    return { integrity: "legacy-unlinked", initial: typedInitial, classified: typedClassified, baseline: before,
        temporary, date: review.date, site };
}
function historicalPair(records: unknown[], site: string): HistoricalPair | null {
    if (records.length === 2 && validLinkedInitialRecord(records[0], site)
        && validLinkedClassifiedRecord(records[1], records[0])) {
        const initial = records[0], classified = records[1];
        if (!validSuppliedReadBackChronology(classified)) return null;
        return { integrity: "linked-validated", initial, classified, baseline: initial.review.before,
            temporary: simulatedTariffObservation(initial.review.before, initial.review.proposal.bound.representation),
            date: initial.review.date, site };
    }
    return legacyPair(records, site);
}
function ownershipState(value: OwnershipRead, site: string) {
    if (value.status === "missing") return { status: "missing" as const, generation: null, intervalCount: null };
    if (value.status !== "available") return { status: value.status, generation: null, intervalCount: null };
    const snapshot = value.snapshot;
    const valid = snapshot.version === 2 && validOwnership(snapshot.evidence) && snapshot.evidence.energySiteId === site
        && snapshot.checksum === ownershipFingerprint({ generation: snapshot.generation, evidence: snapshot.evidence })
        && /^[a-f0-9]{64}$/.test(snapshot.historyDigest);
    return valid ? { status: "available" as const, generation: snapshot.generation, intervalCount: snapshot.evidence.intervals.length }
        : { status: "invalid" as const, generation: null, intervalCount: null };
}
function freeze<T>(value: T, seen = new Set<object>()): T {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value);
    }
    return value;
}

/** Pure inspection only. It neither reads files nor APIs, writes evidence, closes
 * historical obligations, retires ownership, or grants repeat-attempt authority. */
export function assessTeslaBaseline(input: {
    energySiteId: string; timeZone: string; assessedAt: string; maxObservationAgeMs: number;
    current: ObservedTariff | null; historicalJournal: unknown[]; ownership: OwnershipRead;
}) {
    let current: ObservedTariff | null = null, records: unknown[] = [], ownership: OwnershipRead;
    try { current = input.current === null ? null : structuredClone(input.current); records = structuredClone(input.historicalJournal); ownership = structuredClone(input.ownership); }
    catch { current = null; records = []; ownership = { status: "invalid", code: "ASSESSMENT_INPUT_INVALID" }; }
    const site = input.energySiteId, validSite = /^\d+$/.test(site);
    let validTimeZone = false;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone }); validTimeZone = true; } catch { /* fail closed below */ }
    const validAssessmentTime = validOwnershipTimestamp(input.assessedAt);
    const validMaxAge = typeof input.maxObservationAgeMs === "number" && Number.isFinite(input.maxObservationAgeMs)
        && input.maxObservationAgeMs >= 0;
    const historical = validSite ? historicalPair(records, site) : null;
    const completeCurrentObservation = validSite && current !== null && completeObservation(current, site) ? current : null;
    const completeCurrent = completeCurrentObservation !== null;
    const observedMs = completeCurrent ? Date.parse(completeCurrentObservation.source.observedAt) : Number.NaN;
    const assessedMs = validAssessmentTime ? Date.parse(input.assessedAt) : Number.NaN;
    const currentReadable = completeCurrent && validTimeZone && completeCurrentObservation.source.timeZone === input.timeZone
        && validAssessmentTime && validMaxAge && observedMs <= assessedMs && assessedMs - observedMs <= input.maxObservationAgeMs;
    const currentForComparison = currentReadable ? completeCurrentObservation : null;
    const ownershipSummary = validSite ? ownershipState(ownership, site) : { status: "invalid" as const, generation: null, intervalCount: null };
    const baselineComparison = currentForComparison && historical ? compareObservedTariffReadBack({ intended: historical.baseline,
        readBack: currentForComparison, after: historical.classified.completedAt, dates: [historical.date] }) : null;
    const temporaryComparison = currentForComparison && historical ? compareObservedTariffReadBack({ intended: historical.temporary,
        readBack: currentForComparison, after: historical.classified.completedAt, dates: [historical.date] }) : null;
    const exactBaseline = baselineComparison?.outcome === "exact-observed-match";
    const exactTemporary = temporaryComparison?.outcome === "exact-observed-match";
    const status = !currentReadable ? "current-unavailable" : !historical ? "historical-evidence-invalid"
        : exactBaseline ? "current-exactly-matches-historical-baseline"
            : exactTemporary ? "current-exactly-matches-historical-temporary"
                : baselineComparison?.outcome === "different-observed-representation"
                    ? "current-differs-from-historical-baseline" : "comparison-indeterminate";
    const blockers = new Set<string>();
    if (!currentReadable) blockers.add("CURRENT_TESLA_TARIFF_UNAVAILABLE");
    if (!validAssessmentTime) blockers.add("ASSESSMENT_TIME_INVALID");
    if (!validMaxAge) blockers.add("OBSERVATION_MAX_AGE_INVALID");
    if (completeCurrent && observedMs > assessedMs) blockers.add("OBSERVATION_FUTURE");
    if (completeCurrent && validAssessmentTime && validMaxAge && assessedMs - observedMs > input.maxObservationAgeMs)
        blockers.add("OBSERVATION_STALE");
    if (completeCurrent && (!validTimeZone || completeCurrentObservation.source.timeZone !== input.timeZone)) blockers.add("OBSERVATION_TIMEZONE_MISMATCH");
    if (!historical) blockers.add("HISTORICAL_JOURNAL_INVALID");
    if (historical?.integrity === "legacy-unlinked") blockers.add("HISTORICAL_JOURNAL_UNLINKED");
    if (historical?.classified.classification === "write-outcome-unknown") blockers.add("SEPTEMBER_WRITE_OUTCOME_UNKNOWN");
    if (ownershipSummary.status !== "missing" && (ownershipSummary.status !== "available" || ownershipSummary.intervalCount !== 0))
        blockers.add("OWNERSHIP_UNRESOLVED");
    blockers.add("ROLLBACK_UNPROVEN"); blockers.add("RESTORATION_REQUIRED");
    return freeze({
        status,
        siteBinding: validSite ? site : null,
        current: currentForComparison ? { status: "verified-current-authenticated-readback" as const, source: currentForComparison.source,
            representationFingerprint: representationKey(currentForComparison.tariff), representation: currentForComparison.tariff } : {
            status: completeCurrent ? "authenticated-observation-not-current" as const
                : current === null ? "unavailable" as const : "incomplete-or-contradictory" as const,
            source: completeCurrent ? completeCurrentObservation.source : null,
            representationFingerprint: completeCurrent ? representationKey(completeCurrentObservation.tariff) : null,
            representation: completeCurrent ? completeCurrentObservation.tariff : null },
        historical: historical ? { status: historical.integrity, experimentDate: historical.date,
            storedClassification: historical.classified.classification, apiWrite: historical.classified.apiWrite,
            baselineFingerprint: representationKey(historical.baseline.tariff), temporaryFingerprint: representationKey(historical.temporary.tariff),
            baselineRepresentation: historical.baseline.tariff, temporaryRepresentation: historical.temporary.tariff } : null,
        comparisons: { baseline: baselineComparison, temporary: temporaryComparison }, ownership: ownershipSummary,
        unresolved: [...blockers].sort(),
        cannotEstablish: ["API_RESTORATION_ACCEPTANCE", "RESTORATION_CAUSATION", "EXACT_RESTORE_OPERATION_OCCURRED",
            "AUTOMATIC_ROLLBACK_PROVEN", "HISTORICAL_MANUAL_REPORT_AS_MACHINE_AUTHORITY"],
        assessmentOnly: true as const, writeReady: false as const, closesHistoricalAttempt: false as const,
        retiresOwnership: false as const, grantsRepeatAuthority: false as const,
    });
}
