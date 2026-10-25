import type { SmartOperationIntent } from "./confirmed-operation-evidence";
import type { OfflineOperationCapture } from "./prepared-mutation-context";
import type { OwnedImportInterval } from "./ownership-evidence";
import { validOwnershipTimestamp } from "./ownership-evidence";
import { deriveOwnershipTransition, ownershipFingerprint as hash, type AuthorisedImportChange } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";
import { validLifecycleOwnershipSnapshot, retainedOriginKey, retentionDigest } from "./retained-original";
import { validJournalEvidenceJson } from "./journal-evidence-json";
import { observedEconomicSignal } from "./observed-economic";
import { prepareObservedReplacement } from "./observed-replacement";
import { CAPTURE_TTL_MS, EVIDENCE_TTL_MS } from "./smart-evidence";
import { validateTeslaInspectionEvidence, validateKrakenInspectionEvidence } from "./smart-inspection";
import { parseDispatchResponse } from "../kraken/dispatch-response";

type Interval = { start: string; end: string };
/** Independent, server-owned admission. Coverage is an explicit acquisition
 * guarantee, not the extent of the dispatches returned. Validity is a separately
 * established policy bound, never an approval TTL, dispatch or annual season.
 * No production adapter or default policy is installed by this offline contract. */
export type OwnershipAttributionAdmission = {
    version: 1; operationId: string; mutationId: string;
    domain: Interval; newlyAuthorised: AuthorisedImportChange[];
    schedule: { evidenceId: string; coverage: Interval; observationId: string; fingerprint: string };
    pricing: { evidenceId: string; coverage: Interval; fingerprint: string };
    validity: { basis: "explicit-ownership-policy"; policyId: string; evidenceId: string; start: string; end: string };
};
export type OwnershipAttribution = {
    version: 1; operationKind: SmartOperationIntent["kind"]; operationId: string; mutationId: string;
    energySiteId: string; timeZone: string; predecessor: SmartOperationIntent["predecessor"];
    beforeGeneration: string | null; expectedAfterGeneration: string;
    originalFingerprint: string; originalObservationFingerprint: string; retainedOriginKey: string | null;
    originIssuanceReference: string; payloadFingerprint: string;
    admission: OwnershipAttributionAdmission;
    retainedUnchanged: OwnedImportInterval[]; restorationAuthorised: AuthorisedImportChange[];
    projectedIntervals: OwnedImportInterval[]; attributionId: string;
};
const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
const keys = (v: object, s: string) => Object.keys(v).sort().join() === s;
const range = (v: Interval) => v && keys(v, "end,start") && validOwnershipTimestamp(v.start) && validOwnershipTimestamp(v.end)
    && Date.parse(v.end) > Date.parse(v.start);
const interval = (v: Interval) => range(v) && Date.parse(v.start) % 60000 === 0 && Date.parse(v.end) % 60000 === 0;
const contains = (a: Interval, b: Interval) => Date.parse(a.start) <= Date.parse(b.start) && Date.parse(a.end) >= Date.parse(b.end);
const overlap = (a: Interval, b: Interval) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
const stamp = (n: number) => new Date(n).toISOString();
function freeze<T>(v: T): T { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
const noAuthority = { executionReady: false, writeReady: false, grantsRepeatAuthority: false, grantsSuccessorAuthority: false,
    rollbackProven: false, restorationProven: false, resolvesHistoricalJournal: false } as const;

/** Representation checks for an initial phase that has no acquisition context.
 * Full economic/provenance validation still requires the independent admission. */
export function validOwnershipAttributionShape(value: unknown): value is OwnershipAttribution {
    try {
        if (!validJournalEvidenceJson(value)) return false;
        const t = value as OwnershipAttribution, a = t.admission;
        const money = (p: AuthorisedImportChange["price"]) => p && keys(p, "amount,currency,unit") && Number.isFinite(p.amount)
            && p.amount >= 0 && p.currency === "GBP" && p.unit === "kWh";
        const change = (p: AuthorisedImportChange) => p && keys(p, "end,price,start")
            && interval({ start: p.start, end: p.end }) && money(p.price);
        const owned = (p: OwnedImportInterval) => p && keys(p, "applied,end,restore,restoreBaselineFingerprint,start")
            && range({ start: p.start, end: p.end }) && money(p.applied) && money(p.restore)
            && !same(p.applied, p.restore) && p.restoreBaselineFingerprint === t.originalFingerprint;
        const list = <T>(items: T[], valid: (item: T) => unknown) => Array.isArray(items) && items.length <= 512 && items.every(valid);
        if (!keys(t, "admission,attributionId,beforeGeneration,energySiteId,expectedAfterGeneration,mutationId,operationId,operationKind,originIssuanceReference,originalFingerprint,originalObservationFingerprint,payloadFingerprint,predecessor,projectedIntervals,restorationAuthorised,retainedOriginKey,retainedUnchanged,timeZone,version")
            || t.version !== 1 || !a || !keys(a, "domain,mutationId,newlyAuthorised,operationId,pricing,schedule,validity,version") || a.version !== 1
            || a.operationId !== t.operationId || a.mutationId !== t.mutationId || !interval(a.domain)
            || !keys(a.schedule, "coverage,evidenceId,fingerprint,observationId") || !interval(a.schedule.coverage)
            || !keys(a.pricing, "coverage,evidenceId,fingerprint") || !interval(a.pricing.coverage)
            || !keys(a.validity, "basis,end,evidenceId,policyId,start") || a.validity.basis !== "explicit-ownership-policy"
            || !interval({ start: a.validity.start, end: a.validity.end })
            || ![a.schedule.evidenceId, a.schedule.fingerprint, a.pricing.evidenceId, a.pricing.fingerprint, a.validity.policyId,
                a.validity.evidenceId, t.originIssuanceReference, t.originalFingerprint, t.originalObservationFingerprint, t.payloadFingerprint].every(retentionDigest)
            || !list(a.newlyAuthorised, change) || !list(t.restorationAuthorised, p => p && keys(p, "end,price,start")
                && range({ start: p.start, end: p.end }) && money(p.price))
            || !list(t.retainedUnchanged, owned) || !list(t.projectedIntervals, owned)) return false;
        const { attributionId, ...body } = t;
        return attributionId === hash(body);
    } catch { return false; }
}

/** Existing J capture identity, shared rather than reinterpreted by attribution. */
export function operationCaptureIdentity(capture: OfflineOperationCapture, originIssuanceReference: string) {
    return hash({ version: 2, purpose: "operation-capture", capture, originIssuanceReference });
}

/** Strict content validation. A matching admission obtained from JSON is still
 * documentary; only independent trusted ports can establish its provenance. */
export function validateOwnershipAttribution(value: unknown, intent: SmartOperationIntent,
    capture: OfflineOperationCapture, trusted: OwnershipAttributionAdmission, originIssuanceReference: string) {
    const reject = (code: string) => freeze({ status: "rejected" as const, code, ...noAuthority });
    try {
        const expected = buildOwnershipAttribution(intent, capture, trusted, originIssuanceReference);
        if (!validJournalEvidenceJson(value) || !same(value, expected)) return reject("OWNERSHIP_ATTRIBUTION_CONFLICT");
        return freeze({ status: "validated" as const, attribution: expected, ...noAuthority });
    } catch (e) { return reject(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : "INVALID_OWNERSHIP_ATTRIBUTION"); }
}

/** Pure derivation using the existing ownership interval kernel. This produces
 * an approved projection, never confirmed ownership or a runtime capability. */
export function buildOwnershipAttribution(intent: SmartOperationIntent, observation: OfflineOperationCapture,
    supplied: OwnershipAttributionAdmission, originIssuanceReference: string): OwnershipAttribution {
    if (!validJournalEvidenceJson({ intent, observation, supplied, originIssuanceReference })) throw Error("INVALID_ATTRIBUTION_ADMISSION");
    const i = structuredClone(intent), capture = structuredClone(observation), a = structuredClone(supplied);
    const previous = i.ownershipBefore?.evidence ?? null;
    const fresh = (time: string, ttl: number) => validOwnershipTimestamp(time)
        && Date.parse(time) <= Date.parse(i.preparedAt) && Date.parse(i.preparedAt) - Date.parse(time) <= ttl;
    if (!["apply", "update", "restore"].includes(i.kind) || !/^\d+$/.test(i.energySiteId)
        || ![i.operationId, i.mutationId].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.exec(v)?.[0] === v)
        || !same(validateTeslaInspectionEvidence(capture.observation), capture.observation)
        || i.before.observationId !== operationCaptureIdentity(capture, originIssuanceReference)
        || !fresh(capture.observation.source.observedAt, CAPTURE_TTL_MS)
        || !validateKrakenInspectionEvidence(capture.kraken) || !fresh(capture.kraken.lastSuccessfulUpdate, EVIDENCE_TTL_MS)
        || !capture.kraken.importTariff || !fresh(capture.kraken.importTariff.observedAt, EVIDENCE_TTL_MS)
        || !validOwnershipTimestamp(i.preparedAt) || i.before.observation.source.energySiteId !== i.energySiteId
        || i.before.observation.source.timeZone !== i.timeZone || i.original.source.energySiteId !== i.energySiteId
        || i.original.source.timeZone !== i.timeZone || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(i.ownershipAfterGeneration)
        || (i.kind === "apply" ? i.ownershipBefore !== null || i.predecessor !== null || i.origin !== null || !same(i.original, i.before.observation)
            : !validLifecycleOwnershipSnapshot(i.ownershipBefore, i.energySiteId))
        || hash(i.before.observation.tariff) !== (previous?.readbackFingerprint ?? i.originalFingerprint))
        throw Error("INVALID_ATTRIBUTION_PRECONDITION");
    if (!keys(a, "domain,mutationId,newlyAuthorised,operationId,pricing,schedule,validity,version") || a.version !== 1
        || a.operationId !== i.operationId || a.mutationId !== i.mutationId || !interval(a.domain)
        || i.kind !== "restore" && Date.parse(a.domain.start) < Date.parse(i.preparedAt) || Date.parse(a.domain.end) - Date.parse(a.domain.start) > 7 * 86400000
        || !retentionDigest(originIssuanceReference) || !Array.isArray(a.newlyAuthorised) || a.newlyAuthorised.length > 512
        || !same(capture.observation, i.before.observation)) throw Error("INVALID_ATTRIBUTION_ADMISSION");
    const { schedule: s, pricing: p, validity: v } = a;
    if (!s || !keys(s, "coverage,evidenceId,fingerprint,observationId") || !retentionDigest(s.evidenceId) || !interval(s.coverage)
        || !contains(s.coverage, a.domain) || s.observationId !== capture.krakenObservationId || s.fingerprint !== hash(capture.kraken.vehicles)
        || !p || !keys(p, "coverage,evidenceId,fingerprint") || !retentionDigest(p.evidenceId) || !interval(p.coverage)
        || !contains(p.coverage, a.domain) || p.fingerprint !== hash(capture.kraken.importTariff)) throw Error("KRAKEN_ATTRIBUTION_COVERAGE_INVALID");
    const tariff = capture.kraken.importTariff;
    if (!tariff || tariff.status !== "available" || capture.kraken.stale !== false
        || ![tariff.agreement.validFrom, tariff.agreement.validTo, tariff.version.effectiveFrom, tariff.version.effectiveTo].every(validOwnershipTimestamp)
        || !contains({ start: tariff.agreement.validFrom, end: tariff.agreement.validTo }, p.coverage)
        || !tariff.version.effectiveTo || !contains({ start: tariff.version.effectiveFrom, end: tariff.version.effectiveTo }, p.coverage))
        throw Error("KRAKEN_ATTRIBUTION_COVERAGE_INVALID");
    if (!v || !keys(v, "basis,end,evidenceId,policyId,start") || v.basis !== "explicit-ownership-policy"
        || !retentionDigest(v.policyId) || !retentionDigest(v.evidenceId) || !interval({ start: v.start, end: v.end })
        || (i.kind !== "restore" && (!contains(v, a.domain) || Date.parse(v.start) > Date.parse(i.preparedAt) || Date.parse(v.end) <= Date.parse(i.preparedAt)))
        || previous && (Date.parse(v.end) > Date.parse(previous.validUntil) || Date.parse(v.start) > Date.parse(previous.createdAt))
        || i.kind === "restore" && v.end !== previous?.validUntil)
        throw Error("OWNERSHIP_VALIDITY_UNSUPPORTED");
    const dispatches: Interval[] = [];
    for (const vehicle of capture.kraken.vehicles) {
        const parsed = parseDispatchResponse({ flexPlannedDispatches: vehicle.plannedDispatches });
        if (parsed.status !== "complete") throw Error("KRAKEN_ATTRIBUTION_SCHEDULE_INVALID");
        for (const d of vehicle.plannedDispatches) if (d.type === "SMART") dispatches.push(d);
    }
    dispatches.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    let last = Date.parse(a.domain.start);
    for (const change of a.newlyAuthorised) {
        if (!change || !keys(change, "end,price,start") || !interval({ start: change.start, end: change.end })
            || !contains(a.domain, change) || Date.parse(change.start) < last || !same(change.price, tariff.version.scheduledChargingImport)
            || !change.price || !keys(change.price, "amount,currency,unit") || !Number.isFinite(change.price.amount)
            || change.price.amount < 0 || change.price.currency !== "GBP" || change.price.unit !== "kWh") throw Error("INVALID_AUTHORISED_SCOPE");
        if (observedEconomicSignal(i.before.observation, change).signal.import.some(w => same(w.price, change.price)))
            throw Error("AUTHORISATION_NOT_NEW_CHANGE");
        last = Date.parse(change.end);
        let covered = Date.parse(change.start);
        for (const d of dispatches) if (Date.parse(d.start) <= covered && Date.parse(d.end) > covered) covered = Date.parse(d.end);
        if (covered < Date.parse(change.end)) throw Error("SMART_AUTHORISATION_UNCOVERED");
    }
    if (i.kind === "restore" && a.newlyAuthorised.length) throw Error("RESTORE_CANNOT_AUTHORISE_SMART");
    if (i.kind !== "apply" && (!i.ownershipBefore || i.ownershipBefore.evidence.timeZone !== i.timeZone
        || !same(i.original, i.ownershipBefore.lifecycle.original) || i.originalFingerprint !== i.ownershipBefore.lifecycle.originalFingerprint
        || !same(i.origin, i.ownershipBefore.lifecycle.origin) || i.origin?.issuanceKey !== originIssuanceReference || i.predecessor?.evidenceId !== i.ownershipBefore.lifecycle.latestReadback.receiptKey
        || i.ownershipAfterGeneration === i.ownershipBefore.generation)) throw Error("ATTRIBUTION_PREDECESSOR_CONFLICT");
    const payload = JSON.parse(i.payloadJson);
    if (!keys(payload, "tou_settings") || !keys(payload.tou_settings, "tariff_content_v2") || i.payloadJson !== representationKey(payload))
        throw Error("ATTRIBUTION_PAYLOAD_CONFLICT");
    const after = { ...i.before.observation, tariff: payload.tou_settings.tariff_content_v2 };
    if (!same(validateTeslaInspectionEvidence(after), after)) throw Error("ATTRIBUTION_PAYLOAD_CONFLICT");
    if (i.payloadFingerprint !== hash(JSON.parse(i.payloadJson)) || i.originalFingerprint !== hash(i.original.tariff)) throw Error("ATTRIBUTION_PAYLOAD_CONFLICT");
    const restorationAuthorised: AuthorisedImportChange[] = [];
    for (const old of previous?.intervals ?? []) {
        const start = Math.max(Date.parse(old.start), Date.parse(a.domain.start)), end = Math.min(Date.parse(old.end), Date.parse(a.domain.end));
        if (start >= end) continue;
        for (const w of observedEconomicSignal(after, { start: stamp(start), end: stamp(end) }).signal.import)
            if (same(w.price, old.restore)) restorationAuthorised.push({ start: w.start, end: w.end, price: old.restore });
    }
    if (i.kind === "restore" && !same(after.tariff, i.original.tariff)) throw Error("RESTORE_NOT_ORIGINAL");
    const authorised = [...a.newlyAuthorised, ...restorationAuthorised].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const transition = deriveOwnershipTransition({ before: i.before.observation, after, previous, domain: a.domain, authorised, submittedAt: i.preparedAt });
    if (transition.status !== "derived") throw Error(transition.code);
    if (i.kind !== "restore") {
        // Reuse the existing bounded replacement builder to reject changes outside
        // the comparison domain, including the other occurrence of a DST fold.
        const rebuilt = prepareObservedReplacement({ observation: i.before.observation, generatedAt: i.preparedAt,
            comparisonDomain: a.domain, dispatchEvidenceKey: s.evidenceId }, observedEconomicSignal(after, a.domain).signal, i.energySiteId, i.timeZone);
        if (!rebuilt.structurallyValid || !same(rebuilt.representation, after.tariff)) throw Error("ATTRIBUTION_PAYLOAD_OUTSIDE_SCOPE");
    }
    // New intervals must restore the retained original's economics, not an
    // intervening SMART payload. Verify before assigning the immutable lineage.
    for (const w of transition.intervals) {
        const original = observedEconomicSignal(i.original, w).signal.import;
        if (!original.length || original.some(p => !same(p.price, w.restore))) throw Error("ORIGINAL_RESTORATION_CONFLICT");
    }
    const retainedUnchanged: OwnedImportInterval[] = [];
    for (const old of previous?.intervals ?? []) {
        const points = [...new Set([Date.parse(old.start), Date.parse(old.end), ...authorised.filter(w => overlap(w, old))
            .flatMap(w => [Math.max(Date.parse(old.start), Date.parse(w.start)), Math.min(Date.parse(old.end), Date.parse(w.end))])])].sort((x, y) => x - y);
        for (let n = 0; n < points.length - 1; n++) {
            const piece = { ...old, start: stamp(points[n]), end: stamp(points[n + 1]) };
            if (!authorised.some(w => overlap(w, piece))) retainedUnchanged.push(piece);
        }
    }
    const body = { version: 1 as const, operationKind: i.kind, operationId: i.operationId, mutationId: i.mutationId,
        energySiteId: i.energySiteId, timeZone: i.timeZone, predecessor: i.predecessor,
        beforeGeneration: i.ownershipBefore?.generation ?? null, expectedAfterGeneration: i.ownershipAfterGeneration,
        originalFingerprint: i.originalFingerprint, originalObservationFingerprint: hash(i.original),
        retainedOriginKey: i.ownershipBefore ? retainedOriginKey(i.ownershipBefore.lifecycle) : null,
        originIssuanceReference, payloadFingerprint: i.payloadFingerprint, admission: a, retainedUnchanged, restorationAuthorised,
        projectedIntervals: transition.intervals.map(w => ({ ...w, restoreBaselineFingerprint: i.originalFingerprint })) };
    const result = { ...body, attributionId: hash(body) };
    if (!validOwnershipAttributionShape(result)) throw Error("INVALID_OWNERSHIP_ATTRIBUTION");
    return freeze(result);
}

/** Documentary projection at a known submission instant, using the SAME kernel.
 * No receipt, confirmed ownership ledger or persistence capability is created.
 * This keeps elapsed prefixes truthful; preparation time is not execution time. */
export function projectAttributedIntervals(intent: SmartOperationIntent, at: string) {
    const a = intent.ownershipAttribution;
    if (!validOwnershipAttributionShape(a) || !validOwnershipTimestamp(at) || Date.parse(at) < Date.parse(intent.preparedAt))
        throw Error("INVALID_ATTRIBUTION_PROJECTION");
    if (intent.kind !== "restore" && Date.parse(at) >= Date.parse(a.admission.validity.end)) throw Error("OWNERSHIP_VALIDITY_UNSUPPORTED");
    const projected = deriveOwnershipTransition({ before: intent.before.observation,
        after: { ...intent.before.observation, tariff: JSON.parse(intent.payloadJson).tou_settings.tariff_content_v2 },
        previous: intent.ownershipBefore?.evidence ?? null, domain: a.admission.domain,
        authorised: [...a.admission.newlyAuthorised, ...a.restorationAuthorised].sort((x, y) => Date.parse(x.start) - Date.parse(y.start)), submittedAt: at });
    if (projected.status !== "derived") throw Error(projected.code);
    return projected.intervals.map(w => ({ ...w, restoreBaselineFingerprint: intent.originalFingerprint }));
}
