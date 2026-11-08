/** Local interactive adapter ONLY. Never import from a route, page, sync planner,
 * scheduled task or test transport. No token refresh, new scopes or other commands.
 */
import { readFile, mkdir, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadEnvConfig } from "@next/env";
import { currentSite } from "../site/current-site";
import { getRecordedKrakenStateForInspection } from "../site/kraken-refresh";
import { representationKey as journalKey } from "./rollback-evidence";
import { captureObservedTariff, simulatedTariffObservation, type ObservedTariff } from "./observed-tariff";
import * as journalRecords from "./linked-experiment-records";
import { prepareMutationContext, type PreparedMutationContext } from "./prepared-mutation-context";
import { ownershipStore } from "./ownership-store";
import { persistConfirmedSmart } from "./ownership-sqlite";
import { admitOfflineReconciledExperiment, readOfflineReconciledExperiment, validReconciledApplyRecords, type ReconciledApplyIntent, type ReconciledApplyClassification, type ReconciledAttemptConsumption, type OfflineReconciliationPorts, type OfflineExperimentBinding } from "./repeat-attempt-journal";
import { ownershipFingerprint } from "./ownership-transition";
import { approveTariffProposal } from "./proposal-approval";
import { compareObservedTariffReadBack } from "./restoration-review";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { claimExperimentJournal } from "./supervised-journal";
import { runSupervisedExperiment, interpretWriteResponse, StaleApprovalOrEvidenceError, validateCurrentSupervisedCapture, prepareSupervisedExperiment, classifyExperimentResult, CAPTURE_TTL_MS, EVIDENCE_TTL_MS, APPROVAL_TTL_MS, MIN_WRITE_REMAINING_MS, type ExperimentPorts } from "./supervised-experiment";

const ROOT = "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/";
// Only these fixed identifiers may cross the CLI boundary. Never emit an
// upstream message, cause, response body or stack (including authentication errors).
const SAFE_FAILURE_CODES = new Set([
    "RECONCILIATION_APPROVAL_REQUIRED", "OFFLINE_RECONCILIATION_INVALID", "INDEPENDENT_EVIDENCE_INVALID",
    "OFFLINE_EXPERIMENT_REQUIRED", "OWNERSHIP_UNRESOLVED", "ATTEMPT_IN_PROGRESS", "HISTORICAL_JOURNAL_INVALID", "DUPLICATE_MUTATION_ID",
    "CURRENT_TESLA_EVIDENCE_INVALID", "CURRENT_KRAKEN_EVIDENCE_REQUIRED", "CURRENT_KRAKEN_PRICING_REQUIRED",
    "CURRENT_PRICING_COVERAGE_INCOMPLETE", "CURRENT_KRAKEN_ACQUISITION_FAILED",
    "INTERACTIVE_SUPERVISION_REQUIRED", "EXACT_SELECTION_REQUIRED", "INVALID_ARGUMENTS",
    "FRESH_CAPTURE_AND_EVIDENCE_REQUIRED", "CURRENT_SMART_DISPATCH_REQUIRED", "TARGET_MISMATCH",
    "STRUCTURALLY_VALID_BOUND_PROPOSAL_REQUIRED", "EXACT_HUMAN_APPROVAL_REQUIRED", "STALE_APPROVAL_OR_EVIDENCE",
    "TESLA_BEFORE_STATE_CHANGED", "SMART_EVIDENCE_CHANGED", "CURRENT_PROPOSAL_CHANGED", "CURRENT_SAFETY_GATE_BLOCKED",
    "APPROVAL_EXPIRED", "APPROVAL_EXPIRED_AFTER_CLAIM", "SUPERVISED_EXPERIMENT_GATE_BLOCKED", "COMMON_DOMAIN_UNAVAILABLE",
    "DAY_COVERAGE_REQUIRED", "SUPERVISED_AUTHORITY_REQUIRED", "READ_ACCESS_REQUIRED", "WRITE_DISABLED",
    "TESLA_TOKEN_READ_FAILED", "TESLA_READ_FAILED", "TESLA_READ_DECODE_FAILED", "SITE_MISMATCH",
    "TESLA_CAPTURE_FAILED", "KRAKEN_DEVICE_READ_FAILED", "KRAKEN_PLANNED_DISPATCH_READ_FAILED",
    "CAPTURE_PREPARATION_FAILED", "PREPARATION_FAILED", "JOURNAL_INITIAL_INVALID", "JOURNAL_CLASSIFIED_INVALID",
    "PREPARATION_SITE_INVALID", "PREPARATION_TIME_INVALID", "PREPARATION_OWNERSHIP_INVALID", "PREPARATION_OWNERSHIP_UNAVAILABLE",
    "PREPARATION_MUTATION_ID_INVALID", "MANAGED_OWNERSHIP_INVALID", "MANAGED_OWNERSHIP_STALE", "MANAGED_IMPORT_OWNERSHIP_CONFLICT",
]);
export function safeExperimentFailureCode(error: unknown): string {
    if (typeof error !== "object" || error === null) return "READ_OR_EXECUTION_FAILED";
    if ("code" in error && error.code === "EEXIST") return "SITE_ATTEMPT_ALREADY_RECORDED";
    if ("message" in error && typeof error.message === "string" && SAFE_FAILURE_CODES.has(error.message)) return error.message;
    return "READ_OR_EXECUTION_FAILED";
}

/** Render only fixed labels and primitive, allowlisted diagnostic fields. */
export function safeExperimentFreshnessDetails(error: unknown): string[] {
    if (!(error instanceof StaleApprovalOrEvidenceError)) return [];
    const d = error.diagnostics;
    const checks = [
        ["Approval", d.approval], ["Original Tesla capture", d.originalTeslaCapture],
        ["Current Tesla capture", d.currentTeslaCapture], ["Current Kraken evidence", d.currentKrakenEvidence],
    ] as const;
    const reasons = new Set(["fresh", "expired", "future-timestamp", "invalid-timestamp"]);
    const seconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value}s` : "unavailable";
    return [...checks.map(([label, check]) =>
        `${label}: ${check.pass === true ? "PASS" : "FAIL"}; age=${seconds(check.ageSeconds)}; TTL=${seconds(check.ttlSeconds)}; ${reasons.has(check.reason) ? check.reason : "unavailable"}`),
        `Kraken stale flag: ${d.krakenStale.pass === true ? "PASS" : "FAIL"}; stale=${d.krakenStale.value === true ? "true" : d.krakenStale.value === false ? "false" : "unavailable"}`];
}

async function readBoundary<T>(code: string, read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch { throw new Error(code); }
}

// Process-local single issuance for a claimed journal; no hydration/reset API.
// These slots confer journal access only, never execution or receipt authority.
const continuationClaims = new Set<string>();
const continuationClaimed = continuationClaims.has.bind(continuationClaims);
const rememberContinuation = continuationClaims.add.bind(continuationClaims);

/** PRIVATE journal-only continuation. The closed CLI is its only production
 * caller. No transport, receipt, ownership writer or recovery constructor exists.
 * Its lexical identity is lost when preparation returns; persisted documents
 * cannot resume it. Reports remain explicitly unverified even when exact. */
async function createReconciledApplyContinuation(initialRecord: journalRecords.LinkedInitialRecord,
    config: Parameters<typeof readOfflineReconciledExperiment>[0],
    ports: Pick<ExperimentPorts, "now" | "capture"> & { readOwnership: ReturnType<typeof ownershipStore>["read"] }) {
    config = structuredClone(config);
    const claimKey = path.resolve(config.directory, `site-${config.site}-attempt-${initialRecord.mutationId}.jsonl`);
    if (continuationClaimed(claimKey)) throw Error("CONTINUATION_ALREADY_CREATED");
    rememberContinuation(claimKey); // reserve synchronously; uncertainty is never retried
    const initial = structuredClone(initialRecord);
    const recovered = await readOfflineReconciledExperiment(config);
    if (recovered.status !== "consistent-offline-admission") throw Error("CONTINUATION_ADMISSION_INVALID");
    const markerFile = path.join(config.directory, `site-${config.site}-attempt.active`);
    const file = path.join(config.directory, `site-${config.site}-attempt-${initial.mutationId}.jsonl`);
    const markerText = await readFile(markerFile, "utf8"), marker = JSON.parse(markerText);
    let expectedText = JSON.stringify(initial) + "\n";
    if (await readFile(file, "utf8") !== expectedText || marker.binding.initialRecordId !== initial.initialRecordId
        || marker.binding.mutationId !== initial.mutationId || marker.binding.site !== config.site)
        throw Error("CONTINUATION_BINDING_INVALID");
    const records: (ReconciledApplyIntent | ReconciledAttemptConsumption | ReconciledApplyClassification)[] = [];
    let state: "ready" | "intent-pending" | "intent" | "result-pending" | "attempt-pending" | "consumed" = "ready";
    const unchanged = async () => {
        if (await readFile(markerFile, "utf8") !== markerText || await readFile(file, "utf8") !== expectedText)
            throw Error("CONTINUATION_JOURNAL_CHANGED");
        const consumed = records.find(r => r.phase === "attempt-consumed");
        if (consumed && await readFile(file + ".execution", "utf8") !== JSON.stringify(consumed) + "\n")
            throw Error("CONTINUATION_ATTEMPT_CHANGED");
        for (const prior of marker.prior) {
            if (path.basename(prior.name) !== prior.name || ownershipFingerprint(await readFile(path.join(config.directory, prior.name), "utf8")) !== prior.digest)
                throw Error("CONTINUATION_HISTORY_CHANGED");
        }
    };
    const fresh = (at: string, now: string, ttl: number) => Number.isFinite(Date.parse(at)) && Number.isFinite(Date.parse(now))
        && Date.parse(at) <= Date.parse(now) && Date.parse(now) - Date.parse(at) <= ttl;
    const deadlines = (capture: Awaited<ReturnType<ExperimentPorts["capture"]>>, at: string) => {
        if (!fresh(initial.exception.approvedAt, at, APPROVAL_TTL_MS)
            || !fresh(initial.review.before.source.observedAt, at, CAPTURE_TTL_MS)
            || !fresh(capture.before.source.observedAt, at, CAPTURE_TTL_MS)
            || !fresh(capture.kraken.lastSuccessfulUpdate!, at, EVIDENCE_TTL_MS)
            || !fresh(capture.kraken.importTariff!.observedAt, at, EVIDENCE_TTL_MS)
            || ![marker.approval, marker.reconciliation].every(a => fresh(a.approvedAt, at, APPROVAL_TTL_MS))
            || Date.parse(at) + MIN_WRITE_REMAINING_MS >= Date.parse(initial.review.proposal.bound.expiresAt))
            throw Error("CONTINUATION_EVIDENCE_EXPIRED");
    };
    const append = async (record: ReconciledApplyIntent | ReconciledApplyClassification) => {
        await unchanged();
        const next = [...records, record];
        if (!validReconciledApplyRecords(initial, ownershipFingerprint(markerText), next, marker.binding.experimentId)) throw Error("CONTINUATION_RECORD_INVALID");
        const handle = await open(file, "a");
        try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        expectedText += JSON.stringify(record) + "\n"; records.push(record);
    };
    const continuation = Object.freeze({
        async recordApplyIntent() {
            if (this !== continuation || state !== "ready") throw Error("CONTINUATION_NOT_LIVE");
            state = "intent-pending"; // failures/concurrent invocations cannot retry
            const capture = validateCurrentSupervisedCapture(currentSite, await ports.capture(), ports.now());
            const ownership = await ports.readOwnership(config.site), at = ports.now();
            const before = initial.preparedContext.ownership;
            const expectedOwnership = before.status === "missing" ? { status: "missing" } : { status: "available", snapshot: before.snapshot };
            const review = prepareSupervisedExperiment(currentSite, initial.review.binding.selection, capture, at);
            const pricingKey = ownershipFingerprint({ account: capture.kraken.importTariff!.accountRef,
                agreement: capture.kraken.importTariff!.agreement, version: capture.kraken.importTariff!.version });
            if (pricingKey !== marker.binding.pricingKey || journalKey(ownership) !== journalKey(expectedOwnership) || review.payloadJson !== initial.review.payloadJson
                || journalKey(capture.before.tariff) !== journalKey(initial.review.before.tariff)
                || journalKey(capture.before.representations ?? null) !== journalKey(initial.review.before.representations ?? null)
                || review.binding.smartEvidenceKey !== initial.review.binding.smartEvidenceKey
                || review.proposal.bound.economicKey !== initial.review.proposal.bound.economicKey)
                throw Error("CONTINUATION_EVIDENCE_CHANGED");
            await unchanged();
            const attemptedAt = ports.now(); deadlines(capture, attemptedAt);
            const body = { version: 1 as const, mode: "disabled-supervised-lifecycle" as const, phase: "apply-intent" as const,
                admissionKey: ownershipFingerprint(markerText), initialRecordId: initial.initialRecordId, mutationId: initial.mutationId,
                site: config.site, attemptedAt, writeReady: false as const, runtimeConfirmationVerified: false as const };
            await append({ ...body, recordId: ownershipFingerprint(body) });
            // A slow durable append never grants a late execution opportunity.
            deadlines(capture, ports.now()); state = "intent";
        },
        async runSimulatedApply(adapter: SimulatedAttemptAdapter) {
            if (this !== continuation || state !== "ready") throw Error("CONTINUATION_NOT_LIVE");
            await continuation.recordApplyIntent();
            // Recheck after the await; another method must not consume this phase.
            if ((state as string) !== "intent") throw Error("CONTINUATION_NOT_LIVE");
            state = "attempt-pending";
            const producer = await createPrivateAttemptProducer(initial, config, () => ports.now(), adapter);
            const result = await producer.run();
            if (result.provenance !== "simulated-injected-transport" || !result.completedAt) throw Error("ATTEMPT_RESULT_INCOMPLETE");
            const attemptText = await readFile(file, "utf8"), parts = attemptText.trimEnd().split("\n");
            const attempt = JSON.parse(parts[2]) as ReconciledAttemptConsumption;
            if (parts.length !== 3 || attemptText !== expectedText + JSON.stringify(attempt) + "\n"
                || attempt.attemptId !== result.attemptId || attempt.recordId !== result.attemptRecordId
                || !validReconciledApplyRecords(initial, ownershipFingerprint(markerText), [...records, attempt], marker.binding.experimentId))
                throw Error("ATTEMPT_RESULT_BINDING_INVALID");
            expectedText = attemptText; records.push(attempt);
            const classified = journalRecords.createLinkedClassifiedRecord(initial, { phase: "classified", attemptedAt: result.attemptedAt,
                completedAt: result.completedAt, exception: initial.exception, apiWrite: result.apiWrite,
                apiTariffReadBack: { observation: result.observation, comparison: result.comparison }, classification: result.classification,
                laterTeslaAppObservation: null, laterPowerwallOpticasterObservation: null,
                rollbackProven: false, productionWriteReady: false, automaticRestoreAttempted: false });
            state = "result-pending";
            const body = { version: 1 as const, mode: "disabled-supervised-lifecycle" as const, phase: "apply-classification" as const,
                intentRecordId: records[0].recordId, attemptRecordId: attempt.recordId, classified,
                executionProvenance: "simulated-injected-transport" as const, writeReady: false as const, runtimeConfirmationVerified: false as const };
            await append({ ...body, recordId: ownershipFingerprint(body) }); state = "consumed";
            return result;
        },
        async recordApplyClassification(report: journalRecords.LinkedClassifiedRecord) {
            if (this !== continuation || state !== "intent") throw Error("CONTINUATION_NOT_LIVE");
            state = "result-pending";
            if (!Number.isFinite(Date.parse(ports.now())) || Date.parse(report.completedAt) > Date.parse(ports.now()))
                throw Error("CONTINUATION_REPORT_TIME_INVALID");
            const body = { version: 1 as const, mode: "disabled-supervised-lifecycle" as const, phase: "apply-classification" as const,
                intentRecordId: records[0].recordId, classified: structuredClone(report), executionProvenance: "unverified-report" as const,
                writeReady: false as const, runtimeConfirmationVerified: false as const };
            await append({ ...body, recordId: ownershipFingerprint(body) }); state = "consumed";
        },
    });
    return continuation;
}

// No production transport is accepted as authenticated through this interface.
// Any injected adapter is ALWAYS simulated. A future authenticated producer needs
// separately reviewed closed transport wiring, not a caller-controlled flag.
type SimulatedAttemptAdapter = {
    post(site: string, payload: string): Promise<{ httpStatus: number; body: unknown }>;
    readBack(site: string): Promise<ObservedTariff>;
};
const attemptedIntents = new Set<string>();
const intentAttempted = attemptedIntents.has.bind(attemptedIntents);
const rememberAttempt = attemptedIntents.add.bind(attemptedIntents);

/** Private producer used only by the non-public simulated continuation.
 * Supplied adapters can exercise causal capture only in the simulated namespace.
 * No transport means no execution, journal completion, or confirmation authority.
 */
async function createPrivateAttemptProducer(initialRecord: journalRecords.LinkedInitialRecord,
    config: Parameters<typeof readOfflineReconciledExperiment>[0], now: () => string, adapter?: SimulatedAttemptAdapter) {
    config = structuredClone(config);
    const initial = structuredClone(initialRecord);
    const site = config.site, file = path.join(config.directory, `site-${site}-attempt-${initial.mutationId}.jsonl`);
    const markerFile = path.join(config.directory, `site-${site}-attempt.active`);
    const markerText = await readFile(markerFile, "utf8"), marker = JSON.parse(markerText);
    const text = await readFile(file, "utf8"), rows = text.trimEnd().split("\n").map(line => JSON.parse(line));
    const intent = rows[1] as ReconciledApplyIntent;
    const { checksum, ...markerBody } = marker;
    if (rows.length !== 2 || journalKey(rows[0]) !== journalKey(initial)
        || !validReconciledApplyRecords(initial, ownershipFingerprint(markerText), [intent])
        || marker.version !== 3 || marker.mode !== "offline-reconciled-experiment"
        || checksum !== ownershipFingerprint(markerBody) || marker.binding.site !== site
        || marker.binding.initialRecordId !== initial.initialRecordId || marker.binding.mutationId !== initial.mutationId)
        throw Error("ATTEMPT_INTENT_INVALID");
    const binding = Object.freeze({ site, mutationId: initial.mutationId, experimentId: marker.binding.experimentId,
        initialRecordId: initial.initialRecordId, intentRecordId: intent.recordId, admissionKey: intent.admissionKey,
        payloadKey: ownershipFingerprint(initial.review.payloadJson), ownershipKey: ownershipFingerprint(initial.preparedContext.ownership),
        originalObservationKey: ownershipFingerprint(initial.review.before) });
    // Capture methods once. Replacing an adapter after construction cannot change
    // the transport paired with this attempt. No results/flags are accepted by run.
    const post = adapter?.post.bind(adapter), read = adapter?.readBack.bind(adapter);
    let used = false;
    const freeze = <T>(value: T): T => {
        if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    const producer = Object.freeze({ async run(...args: unknown[]) {
        if (this !== producer || used) throw Error("ATTEMPT_NOT_LIVE");
        used = true;
        if (args.length) throw Error("ATTEMPT_EXTERNAL_EVIDENCE_REJECTED");
        const denied = { productionConfirmation: false as const, runtimeConfirmationVerified: false as const,
            writeReady: false as const, executionReady: false as const, grantsCompletionAuthority: false as const };
        if (!post || !read) return freeze({ ...denied, provenance: "disabled-production" as const,
            outcome: "not-attempted" as const, attemptId: null, binding });
        const claim = path.resolve(file) + ":" + intent.recordId;
        if (intentAttempted(claim)) throw Error("ATTEMPT_ALREADY_CONSUMED");
        rememberAttempt(claim); // consume before durability checks or transport
        if (await readFile(markerFile, "utf8") !== markerText || await readFile(file, "utf8") !== text)
            throw Error("ATTEMPT_JOURNAL_CHANGED");
        // Independently flush the existing intent and directory before invoking
        // even a simulated transport. Failure never reaches post and cannot retry.
        const handle = await open(file, "r");
        try { await handle.sync(); } finally { await handle.close(); }
        const parent = await open(config.directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
        const assertFresh = (at: string) => {
            const age = (capturedAt: string) => Date.parse(at) - Date.parse(capturedAt);
            if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(intent.attemptedAt)
                || age(initial.exception.approvedAt) < 0 || age(initial.exception.approvedAt) > APPROVAL_TTL_MS
                || age(initial.review.before.source.observedAt) < 0 || age(initial.review.before.source.observedAt) > CAPTURE_TTL_MS
                || age(initial.preWriteRecheck.krakenObservedAt) < 0 || age(initial.preWriteRecheck.krakenObservedAt) > EVIDENCE_TTL_MS
                || ![marker.approval, marker.reconciliation].every(a => age(a.approvedAt) >= 0 && age(a.approvedAt) <= APPROVAL_TTL_MS)
                || Date.parse(at) + MIN_WRITE_REMAINING_MS >= Date.parse(initial.review.proposal.bound.expiresAt))
                throw Error("ATTEMPT_EVIDENCE_EXPIRED");
        };
        const attemptedAt = now(); assertFresh(attemptedAt);
        if (await readFile(markerFile, "utf8") !== markerText || await readFile(file, "utf8") !== text)
            throw Error("ATTEMPT_JOURNAL_CHANGED");
        const attemptId = randomUUID();
        const attemptBody = { version: 1 as const, mode: "disabled-supervised-lifecycle" as const, phase: "attempt-consumed" as const,
            attemptId, attemptedAt, binding, provenance: "simulated-injected-transport" as const,
            writeReady: false as const, runtimeConfirmationVerified: false as const };
        const attempt: ReconciledAttemptConsumption = { ...attemptBody, recordId: ownershipFingerprint(attemptBody) };
        if (!validReconciledApplyRecords(initial, intent.admissionKey, [intent, attempt], marker.binding.experimentId)) throw Error("ATTEMPT_RECORD_INVALID");
        // Subordinate permanent consumption marker for this operation, NOT another
        // site admission. wx gives cross-process exclusion, including empty or
        // partially written markers after a crash. Never removed or reopened.
        const consumedFile = file + ".execution";
        const consumed = await open(consumedFile, "wx", 0o600);
        try { await consumed.writeFile(JSON.stringify(attempt) + "\n", "utf8"); await consumed.sync(); }
        finally { await consumed.close(); }
        const directory = await open(config.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
        if (await readFile(file, "utf8") !== text || await readFile(markerFile, "utf8") !== markerText) throw Error("ATTEMPT_JOURNAL_CHANGED");
        const append = await open(file, "a");
        try { await append.writeFile(JSON.stringify(attempt) + "\n", "utf8"); await append.sync(); }
        finally { await append.close(); }
        const readyAt = now(); assertFresh(readyAt);
        if (Date.parse(readyAt) < Date.parse(attemptedAt)) throw Error("ATTEMPT_EVIDENCE_EXPIRED");
        if (await readFile(file, "utf8") !== text + JSON.stringify(attempt) + "\n"
            || await readFile(markerFile, "utf8") !== markerText || await readFile(consumedFile, "utf8") !== JSON.stringify(attempt) + "\n")
            throw Error("ATTEMPT_JOURNAL_CHANGED");
        // Final clock check follows every asynchronous durability/read check.
        const dispatchedAt = now(); assertFresh(dispatchedAt);
        if (Date.parse(dispatchedAt) < Date.parse(readyAt)) throw Error("ATTEMPT_EVIDENCE_EXPIRED");
        let apiWrite: ReturnType<typeof interpretWriteResponse> = { status: "unknown", httpStatus: null };
        try {
            const response = await post(site, initial.review.payloadJson);
            if (Number.isInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599)
                apiWrite = interpretWriteResponse(response.httpStatus, response.body);
        } catch { /* Invocation may have mutated state; never retry or infer acceptance from GET. */ }
        let observation: ObservedTariff | null = null;
        try { observation = validateTeslaInspectionEvidence(await read(site)); } catch { /* Unverified readback below. */ }
        let completedAt: string | null = null;
        try {
            const at = now();
            if (Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(dispatchedAt)) completedAt = at;
        } catch { /* A failed clock after invocation must not erase the attempted write. */ }
        if (observation && (!completedAt || observation.source.kind !== "tesla-site-info" || observation.source.energySiteId !== site
            || observation.source.timeZone !== initial.review.before.source.timeZone
            || !Number.isFinite(Date.parse(completedAt)) || Date.parse(completedAt) < Date.parse(dispatchedAt)
            || Date.parse(observation.source.observedAt) > Date.parse(completedAt)
            || Date.parse(completedAt) - Date.parse(observation.source.observedAt) > CAPTURE_TTL_MS)) observation = null;
        const intended = simulatedTariffObservation(initial.review.before, initial.review.proposal.bound.representation);
        const comparison = compareObservedTariffReadBack({ intended, readBack: observation, after: dispatchedAt, dates: [initial.review.date] });
        const classification = classifyExperimentResult(apiWrite, intended, observation, comparison);
        const outcome = apiWrite.status === "unknown" ? "write-outcome-unknown" : apiWrite.status === "rejected" ? "write-rejected"
            : comparison.outcome === "exact-observed-match" && comparison.timelineScope.complete ? "accepted-exact-readback" : "accepted-readback-unverified";
        return freeze({ ...denied, provenance: "simulated-injected-transport" as const, attemptId, attemptRecordId: attempt.recordId, binding,
            attemptedAt: dispatchedAt, completedAt, apiWrite, observation, comparison, classification: classification as journalRecords.LinkedClassifiedRecord["classification"], outcome });
    } });
    return producer;
}

/** Closed composition connection; callers retain live closures only. No record
 * recovery, JSON approval loading or public execution entry point is provided. */
async function admitReconciledContinuation(initial: journalRecords.LinkedInitialRecord,
    config: Parameters<typeof readOfflineReconciledExperiment>[0], experimentId: string, ports: OfflineReconciliationPorts) {
    const admission = await admitOfflineReconciledExperiment(config, experimentId, initial, ports);
    const continuation = await createReconciledApplyContinuation(initial, config, { now: () => ports.now(),
        capture: () => ports.capture(config.site), readOwnership: site => ports.readOwnership(site) });
    return Object.freeze({ admission, continuation });
}

export async function runLocalExperiment(args: string[]) {
    if (args.includes("--help")) {
        console.log("Local Tesla tariff experiment (default: dry-run).\nUsage: node scripts/tesla-tariff-experiment.mjs --site SITE_ID --vehicle KRAKEN_DEVICE_ID --dispatch-start EXACT_ISO [--execute-supervised | --prepare-reconciled --experiment-id NEW_ID]\nReconciled preparation records a permanent offline claim and cannot execute.\nNo saved approval can be loaded. Execution requires an interactive foreground terminal and three exact confirmations. No automatic restore or retry.");
        return;
    }
    const allowed = new Set(["--site", "--vehicle", "--dispatch-start", "--execute-supervised", "--prepare-reconciled", "--experiment-id"]);
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!allowed.has(arg) || options.has(arg)) throw new Error("INVALID_ARGUMENTS");
        options.set(arg, ["--execute-supervised", "--prepare-reconciled"].includes(arg) ? "yes" : args[++i] ?? "");
    }
    const execute = options.has("--execute-supervised"), prepareAdmission = options.has("--prepare-reconciled");
    const experimentId = options.get("--experiment-id");
    if (prepareAdmission && execute || prepareAdmission !== options.has("--experiment-id")
        || prepareAdmission && !/^[A-Za-z0-9_-]{1,128}$/.test(experimentId ?? "")) throw Error("INVALID_ARGUMENTS");
    // No test runner, CI, redirected stdin/stdout, or noninteractive execution.
    if ((execute || prepareAdmission) && (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY
        || process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT || process.env.CI)) throw new Error("INTERACTIVE_SUPERVISION_REQUIRED");
    const selection = { energySiteId: options.get("--site") ?? "", assetId: options.get("--vehicle") ?? "", dispatchStart: options.get("--dispatch-start") ?? "" };
    if (!/^\d+$/.test(selection.energySiteId) || !selection.assetId || !Number.isFinite(Date.parse(selection.dispatchStart))) throw new Error("EXACT_SELECTION_REQUIRED");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
    const now = () => new Date().toISOString();
    const directory = path.join(process.cwd(), ".cache/home-energy-platform/tesla-experiments");
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    // The body and endpoint are fixed to tariff settings. Token never enters any record.
    const request = async (suffix: "site_info" | "time_of_use_settings", body?: string) => {
        const tokens = await readBoundary("TESLA_TOKEN_READ_FAILED", async () =>
            JSON.parse(await readFile(path.join(process.cwd(), ".tesla-tokens.json"), "utf8")));
        if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("READ_ACCESS_REQUIRED");
        const send = () => fetch(`${ROOT}${selection.energySiteId}/${suffix}`, {
            method: body === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
            headers: { Authorization: `Bearer ${tokens.access_token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body, signal: AbortSignal.timeout(15_000),
        });
        return body === undefined ? readBoundary("TESLA_READ_FAILED", send) : send();
    };
    const readBefore = async () => {
        const response = await request("site_info");
        if (!response.ok) throw new Error("TESLA_READ_FAILED");
        const raw = await readBoundary("TESLA_READ_DECODE_FAILED", () => response.json());
        const id = raw?.response?.energy_site_id;
        if (id !== undefined && String(id) !== selection.energySiteId) throw new Error("SITE_MISMATCH");
        return readBoundary("TESLA_CAPTURE_FAILED", async () => captureObservedTariff(raw, selection.energySiteId, now()));
    };
    // Read-only queries through the existing integration; auth session acquisition
    // is its existing obtainKrakenToken flow. Never invoke a preference mutation.
    const capture = async () => {
        try {
            const result = await readBoundary("CURRENT_KRAKEN_ACQUISITION_FAILED", () => getRecordedKrakenStateForInspection(
                currentSite.id, currentSite.integrations.kraken.importTariffIdentity, currentSite.integrations.kraken.exportTariffIdentity));
            if (!result.state || !result.acquisition.freshEvidenceObtained || result.acquisition.staleFallbackUsed)
                throw Error("CURRENT_KRAKEN_ACQUISITION_FAILED");
            return validateCurrentSupervisedCapture(currentSite, { before: await readBefore(), kraken: result.state }, now());
        } catch (error) {
            if (safeExperimentFailureCode(error) === "READ_OR_EXECUTION_FAILED") throw new Error("CAPTURE_PREPARATION_FAILED");
            throw error;
        }
    };
    let writeAttempted = false;
    let beforeConfirmation = true;
    let preparedContext: PreparedMutationContext | null = null;
    const ports: ExperimentPorts = {
        now, capture, readBack: readBefore, journalRecords,
        prepareContext: async capture => {
            const context = await prepareMutationContext({ site: currentSite, selection, capture },
                { readOwnership: ownershipStore().read, now, newMutationId: randomUUID });
            preparedContext = context;
            return context;
        },
        challenge: binding => `EXECUTE ${selection.energySiteId} ${digest(binding + randomUUID())}`,
        async confirm(review, challenge) {
            beforeConfirmation = false;
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const file = path.join(directory, `review-${randomUUID()}.json`);
            await writeFile(file, JSON.stringify(review, null, 2), { mode: 0o600 });
            console.log(`Exact review saved: ${file}\nPayload SHA-256: ${digest(review.payloadJson)}\nProposal SHA-256: ${digest(review.proposal.fingerprint)}\nExact payload:\n${review.payloadJson}\nProduction blockers remain:\n${review.restoration.blockers.join(", ")}\nExpires: ${review.proposal.bound.expiresAt}\nNo automatic restoration or expiry in Tesla. The month/day exception can recur annually. You must supervise and manually recover at the interval end or earlier if needed, including after an ambiguous response.`);
            const prompt = createInterface({ input: process.stdin, output: process.stdout });
            try {
                const a = await prompt.question("Type AUTOMATIC ROLLBACK IS UNPROVEN: ");
                const b = await prompt.question("Type MANUAL TESLA APP RECOVERY MAY BE REQUIRED: ");
                const typed = await prompt.question(`Approve this exact payload by typing:\n${challenge}\n> `);
                return { challenge: typed, automaticRollbackUnproven: a === "AUTOMATIC ROLLBACK IS UNPROVEN",
                    manualAppRecoveryMayBeRequired: b === "MANUAL TESLA APP RECOVERY MAY BE REQUIRED" };
            } finally { prompt.close(); }
        },
        claim: (site, record) => claimExperimentJournal(directory, site, record),
        async write(site, exactPayload) {
            if (!execute || writeAttempted || site !== selection.energySiteId || !process.stdin.isTTY || !process.stdout.isTTY
                || process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT || process.env.CI) throw new Error("WRITE_DISABLED");
            writeAttempted = true;
            const response = await request("time_of_use_settings", exactPayload);
            let body: unknown = null;
            try { body = await response.json(); } catch { /* unknown response must not cause retry */ }
            return interpretWriteResponse(response.status, body);
        },
    };
    if (prepareAdmission) {
        // The existing executor is invoked ONLY in its non-executing dry-run mode.
        // No supplied/recovered admission is accepted as an execution credential.
        const prepared = await runSupervisedExperiment({ site: currentSite, selection, mode: "dry-run", authority: "observe" }, ports);
        const context = preparedContext as PreparedMutationContext | null;
        if (prepared.status !== "dry-run" || !context || !prepared.review.hardBlockers.includes("CURRENT_EVIDENCE_PREPARATION_ONLY"))
            throw Error("OFFLINE_EXPERIMENT_REQUIRED");
        const review = prepared.review;
        const challenge = `REVIEW ONLY ${selection.energySiteId} ${digest(review.fingerprint + randomUUID())}`;
        const consent = await ports.confirm(review, challenge), approvedAt = now();
        if (consent.challenge !== challenge || !consent.automaticRollbackUnproven || !consent.manualAppRecoveryMayBeRequired)
            throw Error("EXACT_HUMAN_APPROVAL_REQUIRED");
        const approval = approveTariffProposal(review.proposal, { fingerprint: review.proposal.fingerprint, approvedAt });
        const initial = journalRecords.createLinkedInitialRecord(context, {
            phase: "approval-consumed-before-write", review,
            exception: { kind: "supervised-manual-recovery", consent, approvedAt: approval.approvedAt, approval,
                exactExperimentFingerprint: review.fingerprint, productionBlockers: review.restoration.blockers,
                automaticRollbackProven: false, manualRecovery: "Preparation only; no Tesla command authorised" },
            preWriteRecheck: { teslaSource: review.before.source, tariffKey: journalKey(review.before.tariff),
                krakenObservedAt: review.evidenceCapturedAt, smartEvidenceKey: review.binding.smartEvidenceKey },
        });
        const separateApproval = async (kind: "RECONCILE" | "PREPARE", binding: OfflineExperimentBinding) => {
            const bindingKey = ownershipFingerprint(binding), approvalId = randomUUID();
            console.log(`Preparation only. Historical API restoration remains unproved.\nExact admission binding:\n${JSON.stringify(binding, null, 2)}\nThis claim remains blocking after restart; it cannot execute or be automatically released.`);
            const expected = `${kind} ${bindingKey} ${approvalId}`;
            const prompt = createInterface({ input: process.stdin, output: process.stdout });
            try {
                const typed = await prompt.question(kind === "RECONCILE"
                    ? `Independently review the retained prior journal and fresh baseline/ownership. Approve reconciliation for this new experiment only:\n${expected}\n> `
                    : `Separately approve this exact new experiment for preparation only:\n${expected}\n> `);
                if (typed !== expected) throw Error("RECONCILIATION_APPROVAL_REQUIRED");
                return { approvalId, bindingKey, approvedAt: now() };
            } finally { prompt.close(); }
        };
        const { admission } = await admitReconciledContinuation(initial, { mode: "offline", directory,
            durableRoot: path.join(process.cwd(), ".cache/home-energy-platform"), site: selection.energySiteId }, experimentId!, {
            now, capture: async site => { if (site !== selection.energySiteId) throw Error("TARGET_MISMATCH"); return capture(); },
            readOwnership: site => ownershipStore().read(site),
            approveReconciliation: async binding => ({ ...await separateApproval("RECONCILE", binding),
                disposition: "prior-conflict-reconciled-for-new-experiment", historicalApiRestoration: "not-proved" }),
            approveExperiment: binding => separateApproval("PREPARE", binding),
        });
        // The private continuation is deliberately discarded here. No CLI flag
        // or transport binding can execute it; CURRENT_EVIDENCE_PREPARATION_ONLY remains.
        console.log(JSON.stringify({ status: "reconciled-preparation-recorded", admission,
            blockers: [...new Set([...review.hardBlockers, ...review.restoration.blockers])],
            writeReady: false, executionReady: false, restorationProven: false }, null, 2));
        return;
    }
    const result = await runSupervisedExperiment({ site: currentSite, selection,
        mode: execute ? "execute-supervised" : "dry-run", authority: execute ? "supervised-experiment" : "observe" }, ports).catch(error => {
        if (beforeConfirmation && safeExperimentFailureCode(error) === "READ_OR_EXECUTION_FAILED") throw new Error("PREPARATION_FAILED");
        throw error;
    });
    if (result.status === "dry-run") {
        console.log(JSON.stringify({ status: result.status, site: selection.energySiteId,
            payloadSHA256: digest(result.review.payloadJson), proposalSHA256: digest(result.review.proposal.fingerprint),
            exactPayload: JSON.parse(result.review.payloadJson), productionBlockers: result.review.restoration.blockers,
            experimentalBlockers: result.review.hardBlockers, writeReady: false }, null, 2));
    } else {
        // Only completed B2 results reach this point. This filter saves unnecessary
        // issuance attempts; persistConfirmedSmart independently verifies authority.
        // Keep persistence outside execution: no retry, rebase or latch operation.
        let ownership: ReturnType<typeof persistConfirmedSmart> | null = null;
        if (result.record.classification === "submitted-representation-preserved") {
            try {
                ownership = persistConfirmedSmart(result.journalCompletion, result.initialRecord, result.record);
            } catch {
                // An unexpected exception may occur after commit. Preserve the
                // completed execution without inferring either persistence outcome.
                ownership = { status: "indeterminate", stage: "persistence", confirmation: "confirmed",
                    code: "OWNERSHIP_ORCHESTRATION_EXCEPTION", productionBlockers: result.review.restoration.blockers,
                    writeReady: false, rollbackProven: false };
            }
        }
        console.log(JSON.stringify({ status: result.status, classification: result.record.classification,
        apiWrite: result.record.apiWrite, journal: path.join(directory, `site-${selection.energySiteId}.jsonl`),
        ownershipPersistence: ownership === null ? { status: "not-attempted", reason: "MUTATION_NOT_CONFIRMED" }
            : { status: ownership.status, stage: ownership.stage, confirmation: ownership.confirmation,
                ...("code" in ownership ? { code: ownership.code } : {}),
                writeReady: ownership.writeReady, rollbackProven: ownership.rollbackProven },
        manualRecoveryMayBeRequired: true, rollbackProven: false, writeReady: false }, null, 2));
    }
}
