import "server-only";
import { createHash } from "node:crypto";
import type { Site } from "./types";
import type { KrakenState } from "./kraken-state";
import { parseDispatchResponse } from "../kraken/dispatch-response";
import { getRecordedKrakenStateForInspection } from "./kraken-refresh";
import { getSiteTeslaObservation } from "./tesla-observation";
import { ownershipStore, type OwnershipRead } from "../tesla-tariff/ownership-store";
import type { ObservedTariff } from "../tesla-tariff/observed-tariff";
import { validateKrakenInspectionEvidence, validateTeslaInspectionEvidence } from "../tesla-tariff/smart-inspection";
import { validateFixedExportPolicy } from "../tesla-tariff/fixed-export-policy";
import { deriveSmartTariffDesiredState } from "../tesla-tariff/smart-desired-state";
import { representationKey } from "../tesla-tariff/rollback-evidence";
import { smartEvidenceKey } from "../tesla-tariff/smart-evidence";
import { validOwnership } from "../tesla-tariff/ownership-evidence";
import { validLifecycleOwnershipSnapshot } from "../tesla-tariff/retained-original";
import { ownershipFingerprint } from "../tesla-tariff/ownership-transition";

const digest = (value: unknown) => createHash("sha256").update(representationKey(value)).digest("hex");
const authority = { writeReady: false as const, rollbackProven: false as const,
    restorationProven: false as const, resolvesHistoricalJournal: false as const,
    grantsRepeatAuthority: false as const, executionReady: false as const };
const blocked = (code: string, extra: Record<string, unknown> = {}) => ({
    mode: "read-only-stage-3a" as const, status: "blocked" as const, decision: null,
    exactBaseline: null, proposedRepresentation: null, exportEvidence: null,
    blockers: [code], ...extra, ...authority,
});
const object = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).sort().join() === [...keys].sort().join();

function validatedOwnershipRead(value: unknown): OwnershipRead | null {
    let detached: unknown;
    try { detached = structuredClone(value); } catch { return null; }
    if (!object(detached) || typeof detached.status !== "string") return null;
    if (detached.status === "missing") return exact(detached, ["status"])
        ? detached as OwnershipRead : null;
    if (detached.status === "invalid" || detached.status === "unavailable")
        return (exact(detached, ["status"]) || exact(detached, ["status", "code"])
            && typeof detached.code === "string" && detached.code.length > 0) ? detached as OwnershipRead : null;
    if (detached.status !== "available" || !exact(detached, ["status", "snapshot"])
        || !object(detached.snapshot)) return null;
    const snapshot = detached.snapshot;
    if (snapshot.version === 3) return validLifecycleOwnershipSnapshot(snapshot,
        typeof snapshot.evidence === "object" && snapshot.evidence !== null
            ? (snapshot.evidence as { energySiteId: string }).energySiteId : "") ? detached as OwnershipRead : null;
    if (!exact(snapshot, ["version", "generation", "evidence", "checksum", "historyDigest"]) || snapshot.version !== 2 || typeof snapshot.generation !== "string" || !validOwnership(snapshot.evidence)
        || typeof snapshot.checksum !== "string" || typeof snapshot.historyDigest !== "string"
        || snapshot.checksum !== ownershipFingerprint({ generation: snapshot.generation, evidence: snapshot.evidence })
        || !/^[a-f0-9]{64}$/.test(snapshot.historyDigest)) return null;
    return detached as OwnershipRead;
}

function validVehicleEvidence(kraken: KrakenState) {
    return Array.isArray(kraken.vehicles) && kraken.vehicles.every(vehicle => object(vehicle)
        && typeof vehicle.id === "string" && vehicle.id.length > 0
        && typeof vehicle.name === "string" && vehicle.name.length > 0
        // Apply the acquisition contract to every dispatch before SMART filtering.
        && parseDispatchResponse({ flexPlannedDispatches: vehicle.plannedDispatches }).status === "complete");
}

function domainFor(kraken: KrakenState, now: string) {
    const instant = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
    const time = instant(now), start = Math.ceil(time / 60_000) * 60_000;
    const from = instant(kraken.importTariff?.version.effectiveFrom);
    const coverageEnd = instant(kraken.importTariff?.version.effectiveTo);
    const end = Math.min(coverageEnd, start + 48 * 3_600_000);
    if (![time, start, from, coverageEnd, end].every(Number.isFinite) || start < from || end <= start)
        return { status: "blocked" as const, code: "VERIFIED_IMPORT_TARIFF_DOMAIN_UNAVAILABLE" };
    const smart = kraken.vehicles.flatMap(vehicle => vehicle.plannedDispatches)
        .filter(dispatch => dispatch.type === "SMART");
    if (smart.some(dispatch => !Number.isFinite(instant(dispatch.start)) || !Number.isFinite(instant(dispatch.end))
        || instant(dispatch.end) <= instant(dispatch.start)))
        return { status: "blocked" as const, code: "INVALID_SMART_EVIDENCE" };
    const relevant = smart.filter(dispatch => instant(dispatch.end) > time);
    if (relevant.some(dispatch => Math.max(start, instant(dispatch.start)) < from
        || instant(dispatch.end) > end))
        return { status: "blocked" as const, code: "SMART_DISPATCH_OUTSIDE_VERIFIED_REVIEW_DOMAIN" };
    return { status: "available" as const, domain: { start: new Date(start).toISOString(), end: new Date(end).toISOString() } };
}

/** Pure review over evidence supplied by the trusted server adapter below. */
export function reviewTrustedSmartSync(input: {
    site: Site; kraken: KrakenState | null; observation: ObservedTariff | null;
    ownership: OwnershipRead; assessedAt: string;
}) {
    const ownership = validatedOwnershipRead(input.ownership);
    if (!ownership) return blocked("OWNERSHIP_EVIDENCE_MALFORMED");
    const observation = validateTeslaInspectionEvidence(input.observation);
    if (!observation) return blocked("TESLA_BASELINE_UNAVAILABLE");
    if (observation.source.energySiteId !== input.site.integrations.tesla.energySiteId
        || observation.source.timeZone !== input.site.tariff?.timeZone)
        return blocked("TESLA_BASELINE_IDENTITY_MISMATCH");
    const exportPolicy = validateFixedExportPolicy({ assumption: input.site.integrations.kraken.fixedExportAssumption,
        observation, assessedAt: input.assessedAt });
    if (exportPolicy.status !== "verified") return blocked(exportPolicy.code);
    const kraken = validateKrakenInspectionEvidence(input.kraken);
    if (!kraken?.importTariff || kraken.importTariff.status !== "available")
        return blocked(input.kraken ? "KRAKEN_EVIDENCE_MALFORMED" : "VERIFIED_IMPORT_TARIFF_REQUIRED",
            { exportEvidence: exportPolicy });
    if (!validVehicleEvidence(kraken))
        return blocked("KRAKEN_EVIDENCE_MALFORMED", { exportEvidence: exportPolicy });
    const configuredImport = input.site.integrations.kraken.importTariffIdentity;
    if (!configuredImport || configuredImport.tariffCode !== kraken.importTariff.agreement.tariffCode
        || configuredImport.meterPointRef !== kraken.importTariff.agreement.meterPointRef
        || configuredImport.accountRef && configuredImport.accountRef !== kraken.importTariff.accountRef)
        return blocked("IMPORT_ACCOUNT_OR_TARIFF_IDENTITY_MISMATCH", { exportEvidence: exportPolicy });
    if (ownership.status === "invalid" || ownership.status === "unavailable")
        return blocked(ownership.code ?? "OWNERSHIP_STORE_UNAVAILABLE", { exportEvidence: exportPolicy });
    let restorationBaseline = observation;
    // Production acquisition below uses the store, which validates the v3 journal
    // and complete history before exposing this documentary snapshot. Pure caller
    // input is not a substitute for trusted acquisition or execution authority.
    if (ownership.status === "available") {
        const snapshot = ownership.snapshot;
        if (snapshot.evidence.energySiteId !== observation.source.energySiteId
            || snapshot.evidence.timeZone !== observation.source.timeZone)
            return blocked("OWNERSHIP_EVIDENCE_INVALID", { exportEvidence: exportPolicy });
        if (snapshot.evidence.readbackFingerprint !== ownershipFingerprint(observation.tariff))
            return blocked("CURRENT_TARIFF_OWNERSHIP_CONFLICT", { exportEvidence: exportPolicy,
                ownership: { status: "available", generation: snapshot.generation } });
        if (snapshot.version === 2) return blocked("RESTORATION_BASELINE_UNAVAILABLE", { exportEvidence: exportPolicy,
            ownership: { status: "available", generation: snapshot.generation } });
        restorationBaseline = snapshot.lifecycle.original;
    }
    const domain = domainFor(kraken, input.assessedAt);
    if (domain.status !== "available") return blocked(domain.code, { exportEvidence: exportPolicy });
    // Scope the approved fixed-export policy to this adapter only. Global Kraken
    // export identity contracts remain untouched in every other workflow.
    const site = structuredClone(input.site);
    delete site.integrations.kraken.exportTariffIdentity;
    const desired = deriveSmartTariffDesiredState({ restorationBaseline, current: {
        site, energySiteId: observation.source.energySiteId, kraken,
        observation, now: input.assessedAt, comparisonDomain: domain.domain,
        ...(ownership.status === "available" ? { managedImport: ownership.snapshot.evidence } : {}),
    } });
    const desiredExport = desired.desiredTariff?.sell_tariff ?? null;
    const exportPreserved = !!desiredExport
        && digest(desiredExport) === exportPolicy.exportFingerprint;
    const blockers = new Set<string>("reconciliation" in desired ? desired.reconciliation.blockers : []);
    blockers.delete("EXPORT_ECONOMICS_UNVERIFIED");
    if (desired.status === "blocked" || desired.status === "indeterminate") blockers.add(desired.diagnostic);
    if (desired.desiredTariff && !exportPreserved) blockers.add("PROPOSED_EXPORT_REPRESENTATION_CHANGED");
    if (blockers.has("BUY_BELOW_SELL")) blockers.add("BUY_BELOW_SELL_SUPERVISED_POLICY_REQUIRED");
    return structuredClone({
        mode: "read-only-stage-3a" as const,
        status: desired.status === "desired-state-ready" || desired.status === "in-sync" ? "reviewed" as const : "blocked" as const,
        assessedAt: input.assessedAt,
        decision: { status: desired.status, action: desired.action, diagnostic: desired.diagnostic },
        evidenceIdentities: {
            teslaBaseline: digest(observation.tariff),
            krakenSchedule: digest(smartEvidenceKey(kraken)),
            importAccount: kraken.importTariff.accountRef,
            importMeterPoint: kraken.importTariff.agreement.meterPointRef,
            importTariff: kraken.importTariff.agreement.tariffCode,
        },
        freshness: {
            teslaObservedAt: observation.source.observedAt,
            krakenObservedAt: kraken.lastSuccessfulUpdate,
            importTariffObservedAt: kraken.importTariff.observedAt,
            comparisonDomain: domain.domain,
        },
        exactBaseline: structuredClone(observation.tariff),
        baselineFingerprint: digest(observation.tariff),
        proposedRepresentation: desired.action ? structuredClone(desired.desiredTariff) : null,
        proposedFingerprint: desired.action && desired.desiredTariff ? digest(desired.desiredTariff) : null,
        restorationCandidate: structuredClone(desired.restorationCandidate),
        restorationFingerprint: desired.restorationFingerprint,
        exportEvidence: exportPolicy,
        exportPreserved,
        blockers: [...blockers].sort(),
        ownership: ownership.status === "available"
            ? { status: "available" as const, generation: ownership.snapshot.generation }
            : { status: "missing" as const },
        ...authority,
    });
}

/** One-shot trusted acquisition. Reads only; it exposes no executor or journal. */
export async function getTrustedSmartSyncReview(site: Site, ports = {
    now: () => new Date().toISOString(),
    readKraken: () => getRecordedKrakenStateForInspection(site.id,
        site.integrations.kraken.importTariffIdentity, site.integrations.kraken.exportTariffIdentity),
    readTesla: () => getSiteTeslaObservation(site),
    readOwnership: (energySiteId: string) => ownershipStore().read(energySiteId),
}) {
    const energySiteId = site.integrations.tesla.energySiteId;
    if (!energySiteId) return blocked("TESLA_SITE_NOT_CONFIGURED");
    const [kraken, tesla, ownership] = await Promise.all([
        ports.readKraken().catch(() => ({ state: null })),
        ports.readTesla().catch(() => null),
        ports.readOwnership(energySiteId).catch(() => ({ status: "unavailable" as const, code: "OWNERSHIP_STORE_UNAVAILABLE" })),
    ]);
    const assessedAt = ports.now();
    return reviewTrustedSmartSync({ site, kraken: kraken.state, observation: tesla, ownership, assessedAt });
}
