import type { OwnershipRead } from "./ownership-store";
import { validOwnershipTimestamp, validOwnership } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import type { TeslaCurrentState } from "./current-baseline";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { assessProposalCurrentUse, createTariffProposal, type Proposal, type ProposalApproval } from "./proposal-approval";
import { representationKey, type TrustedRollbackObservation } from "./rollback-evidence";

type HistoricalReference = {
    format: "legacy" | "linked";
    journalIdentity: string;
    attemptIdentity: string | null;
    mutationIdentity: string | null;
    journalDigest: string;
    classification: string;
};
type NewAttempt = { attemptId: string; mutationId: string };
type BaselineApproval = ProposalApproval & { baselineIdentity: string };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
    Object.keys(value).sort().join() === [...expected].sort().join();
const identifier = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timeZone = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { new Intl.DateTimeFormat("en-GB", { timeZone: value }); return true; } catch { return false; }
};
const freeze = <T>(value: T, seen = new Set<object>()): T => {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value);
    }
    return value;
};

function currentBaseline(value: unknown, site: string, zone: string, assessedAt: string, maxAgeMs: number) {
    if (!object(value) || !keys(value, ["source", "tariff", "operatingMode", "diagnostics"]) || !object(value.source)
        || !keys(value.source, ["kind", "energySiteId", "observedAt", "timeZone"]) || value.source.kind !== "tesla-site-info"
        || value.source.energySiteId !== site || value.source.timeZone !== zone || !validOwnershipTimestamp(value.source.observedAt)
        || !object(value.tariff) || !object(value.tariff.source) || value.tariff.source.kind !== "tesla-site-info"
        || value.tariff.source.energySiteId !== site || value.tariff.source.timeZone !== zone
        || representationKey(value.source) !== representationKey(value.tariff.source)
        || !Array.isArray(value.diagnostics) || !value.diagnostics.every(item => typeof item === "string")
        || !Array.isArray(value.tariff.diagnostics) || !value.tariff.diagnostics.every(item => typeof item === "string")
        || value.tariff.rollbackProven !== false || !object(value.tariff.tariff)) return null;
    let exact = false;
    try { exact = inspectObservedProposalTariff(value.tariff.tariff).exact; } catch { return null; }
    const age = Date.parse(assessedAt) - Date.parse(value.source.observedAt);
    if (!exact || value.tariff.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED") || age < 0 || age > maxAgeMs) return null;
    return value as TeslaCurrentState & { tariff: TeslaCurrentState["tariff"] & { tariff: Record<string, unknown> } };
}

function ownershipReady(value: unknown, site: string) {
    if (!object(value) || typeof value.status !== "string") return false;
    if (value.status === "missing") return true;
    if (value.status !== "available" || !object(value.snapshot)) return false;
    const snapshot = value.snapshot;
    return snapshot.version === 2 && typeof snapshot.generation === "string" && typeof snapshot.checksum === "string"
        && typeof snapshot.historyDigest === "string" && validOwnership(snapshot.evidence) && snapshot.evidence.energySiteId === site
        && snapshot.evidence.intervals.length === 0
        && snapshot.checksum === ownershipFingerprint({ generation: snapshot.generation, evidence: snapshot.evidence })
        && /^[a-f0-9]{64}$/.test(snapshot.historyDigest);
}

function proposalEvidence(value: unknown): value is Proposal {
    if (!(object(value) && object(value.input) && object(value.bound)
        && typeof value.fingerprint === "string" && typeof value.structurallyValid === "boolean"
        && Array.isArray(value.compatibilityBlockers) && value.compatibilityBlockers.every(item => typeof item === "string")
        && typeof value.bound.energySiteId === "string" && typeof value.bound.timeZone === "string"
        && typeof value.bound.purpose === "string" && typeof value.bound.validFrom === "string"
        && typeof value.bound.expiresAt === "string" && object(value.bound.representation)
        && object(value.input.signal) && object(value.input.signal.horizon)
        && Array.isArray(value.input.signal.import) && Array.isArray(value.input.signal.export))) return false;
    try { return representationKey(createTariffProposal(value.input as Proposal["input"])) === representationKey(value); }
    catch { return false; }
}
function rollbackEvidence(value: unknown): value is { observationId?: string; representation: unknown; maxAgeMs: number } {
    return object(value) && Object.hasOwn(value, "representation")
        && (value.observationId === undefined || typeof value.observationId === "string")
        && typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs) && value.maxAgeMs >= 0;
}
function rollbackObservations(value: unknown): value is TrustedRollbackObservation[] {
    return Array.isArray(value) && value.every(item => object(item) && typeof item.id === "string"
        && typeof item.energySiteId === "string" && typeof item.representationKey === "string"
        && validOwnershipTimestamp(item.observedAt) && validOwnershipTimestamp(item.validUntil)
        && ["verified-write-read-back", "authoritative-setting-capture"].includes(item.basis as string));
}

/** Policy-only preparation gate. Historical classification is retained for audit
 * but is deliberately not execution authority and is not a blocker by itself.
 * The caller must still use a trusted server path to acquire evidence and create
 * a new durable journal claim; this function performs no I/O and grants no write.
 */
export function assessFreshBaselineEligibility(input: {
    energySiteId: string; timeZone: string; assessedAt: string; maxObservationAgeMs: number;
    current: TeslaCurrentState | null; ownership: OwnershipRead;
    proposal: Proposal; approval: BaselineApproval | null;
    rollback: { observationId?: string; representation: unknown; maxAgeMs: number };
    trustedRollbackObservations: readonly TrustedRollbackObservation[];
    historical: HistoricalReference; nextAttempt: NewAttempt;
}) {
    let value: typeof input | null = null;
    try { value = structuredClone(input); } catch { /* invalid below */ }
    const blockers = new Set<string>();
    const site = value?.energySiteId;
    const zone = value?.timeZone;
    const assessedAt = value?.assessedAt;
    const maxAge = value?.maxObservationAgeMs;
    const requestValid = typeof site === "string" && /^\d+$/.test(site) && timeZone(zone)
        && validOwnershipTimestamp(assessedAt) && typeof maxAge === "number" && Number.isFinite(maxAge) && maxAge >= 0;
    if (!requestValid) blockers.add("FRESH_BASELINE_REQUEST_INVALID");
    const current = requestValid ? currentBaseline(value!.current, site!, zone!, assessedAt!, maxAge!) : null;
    if (!current) blockers.add("FRESH_BASELINE_UNAVAILABLE");

    const historical = value?.historical;
    const historicalValid = object(historical) && keys(historical,
        ["format", "journalIdentity", "attemptIdentity", "mutationIdentity", "journalDigest", "classification"])
        && ["legacy", "linked"].includes(historical.format as string) && identifier(historical.journalIdentity)
        && (historical.attemptIdentity === null || identifier(historical.attemptIdentity))
        && (historical.mutationIdentity === null || identifier(historical.mutationIdentity))
        && (historical.format === "legacy" || historical.attemptIdentity !== null && historical.mutationIdentity !== null)
        && new Set([historical.journalIdentity, historical.attemptIdentity, historical.mutationIdentity].filter(Boolean)).size
            === [historical.journalIdentity, historical.attemptIdentity, historical.mutationIdentity].filter(Boolean).length
        && typeof historical.journalDigest === "string"
        && /^[a-f0-9]{64}$/.test(historical.journalDigest) && typeof historical.classification === "string"
        && historical.classification.length > 0;
    if (!historicalValid) blockers.add("HISTORICAL_REFERENCE_INVALID");
    const attempt = value?.nextAttempt;
    const historicalIdentities = historicalValid ? new Set<string>(
        [historical.journalIdentity, historical.attemptIdentity, historical.mutationIdentity].filter((item): item is string => item !== null))
        : new Set<string>();
    const attemptValid = historicalValid && object(attempt) && keys(attempt, ["attemptId", "mutationId"])
        && identifier(attempt.attemptId) && identifier(attempt.mutationId) && attempt.attemptId !== attempt.mutationId
        && !historicalIdentities.has(attempt.attemptId) && !historicalIdentities.has(attempt.mutationId);
    if (!attemptValid) blockers.add("INDEPENDENT_AUDIT_IDENTITY_INVALID");

    const ownershipValid = !!value && ownershipReady(value.ownership, site ?? "");
    if (!object(value?.ownership)) blockers.add("OWNERSHIP_EVIDENCE_MALFORMED");
    if (!ownershipValid) blockers.add("OWNERSHIP_UNRESOLVED");
    const proposal = proposalEvidence(value?.proposal) ? value.proposal : null;
    if (!proposal) blockers.add("PROPOSAL_EVIDENCE_MALFORMED");
    const rollback = rollbackEvidence(value?.rollback) ? value.rollback : null;
    const trustedObservations = rollbackObservations(value?.trustedRollbackObservations) ? value.trustedRollbackObservations : null;
    if (!rollback || !trustedObservations) blockers.add("RESTORATION_EVIDENCE_MALFORMED");
    if (current && value && proposal && rollback && trustedObservations) {
        const baselineIdentity = representationKey({ source: current.source, tariff: current.tariff.tariff });
        const approval = object(value.approval) && keys(value.approval, ["fingerprint", "approvedAt", "baselineIdentity"])
            && typeof value.approval.fingerprint === "string" && typeof value.approval.approvedAt === "string"
            && typeof value.approval.baselineIdentity === "string" ? value.approval as BaselineApproval : null;
        if (!approval || approval.baselineIdentity !== baselineIdentity || approval.fingerprint !== proposal.fingerprint)
            blockers.add("EXACT_BASELINE_APPROVAL_REQUIRED");
        if (proposal.bound.energySiteId !== site || proposal.bound.timeZone !== zone
            || ("observationKey" in proposal.bound && proposal.bound.observationKey !== representationKey(current.tariff)))
            blockers.add("PROPOSAL_BASELINE_MISMATCH");
        if (representationKey(rollback.representation) !== representationKey(current.tariff.tariff))
            blockers.add("RESTORATION_BASELINE_MISMATCH");
        const safety = assessProposalCurrentUse({ approvedProposal: proposal, currentProposal: proposal,
            approval, now: assessedAt!, targetEnergySiteId: site!, authority: "confirm", rollback },
        trustedObservations);
        for (const blocker of safety.blockers) blockers.add(blocker);
    } else blockers.add("NEW_OPERATION_SAFETY_UNAVAILABLE");

    return freeze({
        status: blockers.size === 0 ? "eligible-for-durable-claim-preparation" as const : "blocked" as const,
        blockers: [...blockers].sort(),
        historical: historicalValid ? { ...historical, operationalBlocker: false as const, remainsUnresolved: true as const } : null,
        freshBaselineFingerprint: current ? representationKey(current.tariff.tariff) : null,
        approvalBaselineIdentity: current ? representationKey({ source: current.source, tariff: current.tariff.tariff }) : null,
        nextAttempt: attemptValid ? { ...attempt } : null,
        requiresDurableJournalBeforeWrite: true as const,
        requiresFreshPreWriteRecapture: true as const,
        requiresExplicitHumanApproval: true as const,
        legacyLatchUnaffected: true as const,
        assessmentOnly: true as const,
        writeReady: false as const,
        rollbackProven: false as const,
        restorationProven: false as const,
        resolvesHistoricalJournal: false as const,
        grantsRepeatAuthority: false as const,
    });
}
