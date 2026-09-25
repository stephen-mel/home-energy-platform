import type { Site } from "../site/types";
import type { KrakenState } from "../site/kraken-state";
import { getSitePriceSignal } from "../site/get-site-price-signal";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { analyseObservedDates, type ObservedTariff } from "./observed-tariff";
import { createTariffProposal, approveTariffProposal, assessProposalCurrentUse } from "./proposal-approval";
import { representationKey } from "./rollback-evidence";
import { reviewObservedRestoration, compareObservedTariffReadBack } from "./restoration-review";

export const CAPTURE_TTL_MS = 120_000;
export const EVIDENCE_TTL_MS = 60_000;
export const APPROVAL_TTL_MS = 60_000;
export const MIN_WRITE_REMAINING_MS = 30_000;
// An experiment may acknowledge these risks; none is removed from production.
const MANUAL_RECOVERY_RISKS = new Set([
    "ROLLBACK_UNPROVEN", "BUY_BELOW_SELL", "BOUNDED_FORECAST", "RESTORATION_REQUIRED",
    "OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED", "INVERSE_WRITE_MAPPING_UNPROVEN", "RESTORE_ACCEPTANCE_UNPROVEN",
    "RESTORATION_PRICE_TRANSFORMATION_RISK",
]);
export type Capture = { before: ObservedTariff; kraken: KrakenState };
export type Selection = { energySiteId: string; assetId: string; dispatchStart: string };
export type WriteResult = { status: "accepted" | "rejected" | "unknown"; httpStatus: number | null };
const fresh = (at: string, now: string, ttl: number) => Number.isFinite(Date.parse(at)) && Number.isFinite(Date.parse(now))
    && Date.parse(at) <= Date.parse(now) && Date.parse(now) - Date.parse(at) <= ttl;

type FreshnessCheck = {
    pass: boolean;
    ageSeconds: number | null;
    ttlSeconds: number;
    reason: "fresh" | "expired" | "future-timestamp" | "invalid-timestamp";
};
function freshnessCheck(at: string, now: string, ttl: number): FreshnessCheck {
    const age = Date.parse(now) - Date.parse(at);
    return { pass: fresh(at, now, ttl), ageSeconds: Number.isFinite(age) ? age / 1000 : null,
        ttlSeconds: ttl / 1000,
        reason: !Number.isFinite(age) ? "invalid-timestamp" : age < 0 ? "future-timestamp" : age > ttl ? "expired" : "fresh" };
}

/** Diagnostic data only: no source timestamps, captures, responses or credentials.
 * Constructed only AFTER the unchanged freshness gate fails, using its same `now`.
 */
export class StaleApprovalOrEvidenceError extends Error {
    readonly diagnostics;
    constructor(approvedAt: string, originalCaptureAt: string, currentCaptureAt: string,
        evidenceAt: string, stale: boolean, now: string) {
        super("STALE_APPROVAL_OR_EVIDENCE");
        this.diagnostics = {
            approval: freshnessCheck(approvedAt, now, APPROVAL_TTL_MS),
            originalTeslaCapture: freshnessCheck(originalCaptureAt, now, CAPTURE_TTL_MS),
            currentTeslaCapture: freshnessCheck(currentCaptureAt, now, CAPTURE_TTL_MS),
            currentKrakenEvidence: freshnessCheck(evidenceAt, now, EVIDENCE_TTL_MS),
            krakenStale: { pass: !stale, value: typeof stale === "boolean" ? stale : null },
        };
    }
}

/** Compare actual SMART data independently of freshness timestamps. Includes
 * original boundaries, vehicle identity, type and energy; BOOST is not a price event.
 */
export function smartEvidenceKey(state: KrakenState) {
    return representationKey(state.vehicles.map(v => ({ id: v.id, name: v.name,
        dispatches: v.plannedDispatches.filter(d => d.type === "SMART").map(d => ({ start: d.start, end: d.end,
            type: d.type, energyAddedKwh: d.energyAddedKwh })).sort((a, b) => representationKey(a).localeCompare(representationKey(b)))
    })).sort((a, b) => a.id.localeCompare(b.id)));
}

export function prepareSupervisedExperiment(site: Site, selection: Selection, capture: Capture, generatedAt: string) {
    if (!/^\d+$/.test(selection.energySiteId) || !selection.assetId || !fresh(capture.before.source.observedAt, generatedAt, CAPTURE_TTL_MS)
        || !fresh(capture.kraken.lastSuccessfulUpdate, generatedAt, EVIDENCE_TTL_MS) || capture.kraken.stale) throw new Error("FRESH_CAPTURE_AND_EVIDENCE_REQUIRED");
    const vehicle = capture.kraken.vehicles.filter(v => v.id === selection.assetId);
    const dispatches = vehicle.length === 1 ? vehicle[0].plannedDispatches.filter(d => d.type === "SMART" && d.start === selection.dispatchStart) : [];
    if (dispatches.length !== 1 || Date.parse(dispatches[0].end) <= Date.parse(generatedAt)) throw new Error("CURRENT_SMART_DISPATCH_REQUIRED");
    const dispatch = dispatches[0], timeZone = site.tariff?.timeZone;
    if (!timeZone || timeZone !== capture.before.source.timeZone || capture.before.source.energySiteId !== selection.energySiteId) throw new Error("TARGET_MISMATCH");
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(dispatch.start));
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const day = analyseObservedDates(capture.before, [date]).days[0];
    if (!day?.periods.length) throw new Error("DAY_COVERAGE_REQUIRED");
    const domain = { start: day.periods[0].start, end: day.periods.at(-1)!.end };
    const signal = getSitePriceSignal(site, capture.kraken, domain.start).signal;
    const base = getSitePriceSignal(site, null, domain.start).signal;
    const compared = comparePriceSignalsInDomain(base, signal, domain);
    if (compared.status === "indeterminate") throw new Error("COMMON_DOMAIN_UNAVAILABLE");
    const proposal = createTariffProposal({ proposalId: "supervised-smart-inspection", energySiteId: selection.energySiteId,
        purpose: "tariff-sync", timeZone, validFrom: generatedAt, expiresAt: dispatch.end, signal: compared.projected.current,
        observedSmart: { observation: capture.before, generatedAt, preserveLabels: true,
            dispatch: { assetId: selection.assetId, start: dispatch.start, end: dispatch.end },
            previousSignal: compared.projected.previous, comparisonDomain: domain } });
    const restoration = reviewObservedRestoration({ before: capture.before, temporaryProposal: proposal, asOf: generatedAt, maxCaptureAgeMs: CAPTURE_TTL_MS });
    if (!proposal.structurallyValid || !proposal.bound.representation || !restoration.boundToProposal) throw new Error("STRUCTURALLY_VALID_BOUND_PROPOSAL_REQUIRED");
    const payload = { tou_settings: { tariff_content_v2: proposal.bound.representation } };
    // This string is both displayed and transmitted, without reconstruction later.
    const payloadJson = representationKey(payload);
    const binding = { authority: "supervised-experiment" as const, selection, proposalFingerprint: proposal.fingerprint,
        payloadKey: payloadJson, smartEvidenceKey: smartEvidenceKey(capture.kraken), generatedAt };
    const hardBlockers = [...new Set([...proposal.compatibilityBlockers, ...restoration.blockers])].filter(code =>
        !MANUAL_RECOVERY_RISKS.has(code) && !["EXACT_PROPOSAL_APPROVAL_REQUIRED", "OUTSIDE_CURRENT_VALIDITY", "AUTHORITY_OBSERVE_ONLY"].includes(code));
    return { proposal, restoration, binding, fingerprint: representationKey(binding), payloadJson, date, hardBlockers,
        before: capture.before, evidenceCapturedAt: capture.kraken.lastSuccessfulUpdate,
        productionWriteReady: false as const, rollbackProven: false as const };
}
export type PreparedExperiment = ReturnType<typeof prepareSupervisedExperiment>;
export type Consent = { challenge: string; automaticRollbackUnproven: boolean; manualAppRecoveryMayBeRequired: boolean };

/** The only execution orchestrator. Not imported by the app, planner or polling.
 * I/O is supplied by the local interactive entry point; tests supply mocks only.
 */
export type ExperimentPorts = {
    now(): string;
    capture(): Promise<Capture>;
    confirm(review: PreparedExperiment, challenge: string): Promise<Consent>;
    // Exclusive durable site latch + complete before/payload/approval record.
    // Failure MUST throw before any POST. Latch is never automatically released.
    claim(site: string, record: unknown): Promise<{ finish(record: unknown): Promise<void> }>;
    write(site: string, exactPayloadJson: string): Promise<WriteResult>;
    readBack(site: string): Promise<ObservedTariff>;
    challenge(binding: string): string;
};

export async function runSupervisedExperiment(input: {
    site: Site; selection: Selection; mode?: "dry-run" | "execute-supervised"; authority?: "observe" | "supervised-experiment";
}, ports: ExperimentPorts) {
    input = structuredClone(input);
    if (input.mode === "execute-supervised" && input.authority !== "supervised-experiment") throw new Error("SUPERVISED_AUTHORITY_REQUIRED");
    const review = prepareSupervisedExperiment(input.site, input.selection, structuredClone(await ports.capture()), ports.now());
    if (input.mode !== "execute-supervised") return { status: "dry-run" as const, review, writeReady: false as const };
    if (input.authority !== "supervised-experiment" || review.hardBlockers.length) throw new Error("SUPERVISED_EXPERIMENT_GATE_BLOCKED");
    const challenge = ports.challenge(review.fingerprint);
    const consent = await ports.confirm(structuredClone(review), challenge);
    const approvedAt = ports.now();
    if (consent.challenge !== challenge || consent.automaticRollbackUnproven !== true || consent.manualAppRecoveryMayBeRequired !== true)
        throw new Error("EXACT_HUMAN_APPROVAL_REQUIRED");
    const approval = approveTariffProposal(review.proposal, { fingerprint: review.proposal.fingerprint, approvedAt });
    // No reuse of the preparation cache: one fresh, explicit recheck after approval.
    const current = structuredClone(await ports.capture());
    const validate = () => {
        const now = ports.now();
        if (!fresh(approvedAt, now, APPROVAL_TTL_MS) || !fresh(review.before.source.observedAt, now, CAPTURE_TTL_MS)
            || !fresh(current.before.source.observedAt, now, CAPTURE_TTL_MS)
            || !fresh(current.kraken.lastSuccessfulUpdate, now, EVIDENCE_TTL_MS) || current.kraken.stale) throw new StaleApprovalOrEvidenceError(approvedAt, review.before.source.observedAt,
                current.before.source.observedAt, current.kraken.lastSuccessfulUpdate, current.kraken.stale, now);
        if (current.before.source.kind !== "tesla-site-info" || current.before.source.energySiteId !== input.selection.energySiteId
            || current.before.source.timeZone !== review.before.source.timeZone || current.before.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")
            || representationKey(current.before.tariff) !== representationKey(review.before.tariff)) throw new Error("TESLA_BEFORE_STATE_CHANGED");
        if (smartEvidenceKey(current.kraken) !== review.binding.smartEvidenceKey) throw new Error("SMART_EVIDENCE_CHANGED");
        const currentPlan = prepareSupervisedExperiment(input.site, input.selection, current, now);
        if (currentPlan.payloadJson !== review.payloadJson || currentPlan.proposal.bound.economicKey !== review.proposal.bound.economicKey
            || currentPlan.hardBlockers.length) throw new Error("CURRENT_PROPOSAL_CHANGED");
        const safety = assessProposalCurrentUse({ approvedProposal: review.proposal, currentProposal: review.proposal, approval,
            now, targetEnergySiteId: input.selection.energySiteId, authority: "confirm",
            rollback: { representation: review.before.tariff, maxAgeMs: CAPTURE_TTL_MS } });
        if (!safety.humanApproved || safety.blockers.some(code => !MANUAL_RECOVERY_RISKS.has(code))) throw new Error("CURRENT_SAFETY_GATE_BLOCKED");
        // Checks above are computationally nontrivial; recheck expiry after them.
        if (!fresh(approvedAt, ports.now(), APPROVAL_TTL_MS) || Date.parse(ports.now()) + MIN_WRITE_REMAINING_MS >= Date.parse(review.proposal.bound.expiresAt)) throw new Error("APPROVAL_EXPIRED");
        return safety;
    };
    const safety = validate();
    const exception = { kind: "supervised-manual-recovery" as const, consent, approvedAt, approval,
        exactExperimentFingerprint: review.fingerprint, productionBlockers: safety.blockers,
        automaticRollbackProven: false as const, manualRecovery: "Tesla app may be required; no automatic restoration" };
    const journal = await ports.claim(input.selection.energySiteId, structuredClone({ phase: "approval-consumed-before-write", review, exception,
        preWriteRecheck: { teslaSource: current.before.source, tariffKey: representationKey(current.before.tariff),
            krakenObservedAt: current.kraken.lastSuccessfulUpdate, smartEvidenceKey: smartEvidenceKey(current.kraken) } }));
    // A slow/failed persistence operation must not permit a late write.
    const attemptAt = ports.now();
    if (!fresh(approvedAt, attemptAt, APPROVAL_TTL_MS) || !fresh(current.kraken.lastSuccessfulUpdate, attemptAt, EVIDENCE_TTL_MS)
        || !fresh(review.before.source.observedAt, attemptAt, CAPTURE_TTL_MS) || Date.parse(attemptAt) + MIN_WRITE_REMAINING_MS >= Date.parse(review.proposal.bound.expiresAt))
        throw new Error("APPROVAL_EXPIRED_AFTER_CLAIM");
    let apiWrite: WriteResult;
    try { apiWrite = await ports.write(input.selection.energySiteId, review.payloadJson); }
    catch { apiWrite = { status: "unknown", httpStatus: null }; }
    let readBack: ObservedTariff | null = null;
    try { readBack = await ports.readBack(input.selection.energySiteId); } catch { /* recorded independently below */ }
    const intended: ObservedTariff = { ...review.before, source: { ...review.before.source, kind: "simulation" }, tariff: review.proposal.bound.representation };
    const comparison = compareObservedTariffReadBack({ intended, readBack, after: attemptAt, dates: [review.date] });
    const classification = classifyExperimentResult(apiWrite, intended, readBack, comparison);
    const record = { phase: "classified", attemptedAt: attemptAt, completedAt: ports.now(), exception,
        apiWrite, apiTariffReadBack: { observation: readBack, comparison }, classification,
        laterTeslaAppObservation: null, laterPowerwallOpticasterObservation: null,
        rollbackProven: false as const, productionWriteReady: false as const, automaticRestoreAttempted: false as const };
    await journal.finish(record); // Failure leaves consumed latch in place; never resend.
    return { status: "attempt-recorded" as const, review, record, writeReady: false as const };
}

export function classifyExperimentResult(write: WriteResult, intended: ObservedTariff, readBack: ObservedTariff | null,
    comparison: ReturnType<typeof compareObservedTariffReadBack>) {
    if (write.status === "rejected") return "request-rejected";
    if (write.status === "unknown") return "write-outcome-unknown"; // timeout/5xx: never retry or infer acceptance from a matching GET
    if (comparison.outcome === "insufficient-evidence" || !readBack?.tariff) return "read-back-unavailable-or-insufficient";
    if (comparison.representationMatches) return "submitted-representation-preserved";
    // Strict classifier: only pure price raising with everything else unchanged.
    // Varying sell tariffs/other transformations are not guessed from one date.
    const expected = structuredClone(intended.tariff!);
    const sells = [...new Set(Object.values(expected.sell_tariff.energy_charges).flatMap(c => Object.values(c.rates ?? {})))];
    if (sells.length === 1 && expected.currency === expected.sell_tariff.currency) {
        let raised = false;
        for (const [season, c] of Object.entries(expected.energy_charges)) for (const k of Object.keys(c.rates ?? {})) {
            if (c.rates![k] < sells[0] && readBack.tariff.energy_charges[season]?.rates?.[k] === sells[0]) {
                c.rates![k] = sells[0]; raised = true;
            }
        }
        if (raised && representationKey(expected) === representationKey(readBack.tariff)) return "buy-raised-to-sell";
    }
    return "accepted-but-transformed-differently";
}

export function interpretWriteResponse(httpStatus: number, body: unknown): WriteResult {
    const response = body && typeof body === "object" && "response" in body ? body.response : null;
    const r = response && typeof response === "object" ? response as Record<string, unknown> : {};
    if (r.result === false || httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) return { status: "rejected", httpStatus };
    if (httpStatus >= 200 && httpStatus < 300 && (r.result === true || typeof r.code === "number" && r.code >= 200 && r.code < 300))
        return { status: "accepted", httpStatus };
    return { status: "unknown", httpStatus }; // raw messages/body never enter journals or logs
}
