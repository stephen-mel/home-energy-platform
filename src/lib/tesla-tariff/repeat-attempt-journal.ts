import { validateOwnershipAttribution } from "./ownership-attribution";
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { validLinkedInitialRecord, validLinkedClassifiedRecord, type LinkedInitialRecord, type LinkedClassifiedRecord } from "./linked-experiment-records";
import { validOwnership } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import type { OwnershipRead, OwnershipSnapshot } from "./ownership-store";
import { validSmartRehearsalRecords, type ApplyReview, type RestoreReview, type RehearsalApproval,
    type AttemptResult, type LifecycleRecords } from "./smart-lifecycle-rehearsal";
import { prepareOperationMutationContext, recheckPreparedOperation, validPreparedOperationContext,
    operationCommitPreconditionMatches, type OfflineOperationRequest, type OfflineOperationPreparationPorts,
    type PreparedOperationContext, type OfflineOperationHistory } from "./prepared-mutation-context";
import { validateConfirmedOperationEvidence, validateOperationInitialRecord, validateOperationCompletionRecord,
    type SmartOperationInitialRecord, type SmartOperationCompletionRecord, type ConfirmedOperationEvidence,
    type ConfirmedOperationValidationContext } from "./confirmed-operation-evidence";
import { validJournalEvidenceJson } from "./journal-evidence-json";
import { EVIDENCE_TTL_MS } from "./smart-evidence";

type CompletedAttempt = {
    version: 1; site: string; attemptId: string; mutationId: string;
    approvalId: string; ownershipKey: string; initialRecordId: string; classifiedRecordId: string;
    previousAttemptId: string | null; checksum: string;
};
export type RepeatAttemptEligibility = Readonly<{
    status: "eligible" | "blocked";
    code: "NO_PRIOR_ATTEMPT" | "PRIOR_REQUEST_REJECTED" | "ATTEMPT_IN_PROGRESS" | "HISTORICAL_JOURNAL_INVALID"
        | "PRIOR_ATTEMPT_INCOMPLETE" | "PRIOR_OUTCOME_AMBIGUOUS" | "OWNERSHIP_UNRESOLVED" | "RESTORATION_REQUIRED";
    previousAttemptId: string | null;
}>;

const legacyName = (site: string) => `site-${site}.jsonl`;
const activeName = (site: string) => `site-${site}-attempt.active`;
const journalName = (site: string, mutation: string) => `site-${site}-attempt-${mutation}.jsonl`;
const completeName = (site: string, mutation: string) => `site-${site}-attempt-${mutation}.complete`;
const sameKeys = (value: object, expected: string[]) => Object.keys(value).sort().join() === expected.sort().join();
const attemptId = (mutation: string) => `mutation:${mutation}`;
const completedChecksum = (value: Omit<CompletedAttempt, "checksum">) => ownershipFingerprint(value);

function validSnapshot(snapshot: OwnershipSnapshot, site: string) {
    return snapshot && sameKeys(snapshot, ["version", "generation", "evidence", "checksum", "historyDigest"])
        && snapshot.version === 2 && /^[a-f0-9-]{36}$/.test(snapshot.generation)
        && /^[a-f0-9]{64}$/.test(snapshot.historyDigest) && validOwnership(snapshot.evidence)
        && snapshot.evidence.energySiteId === site
        && snapshot.checksum === ownershipFingerprint({ generation: snapshot.generation, evidence: snapshot.evidence });
}
function ownershipSafe(ownership: OwnershipRead, site: string) {
    if (ownership.status === "missing") return sameKeys(ownership, ["status"]);
    return ownership.status === "available" && sameKeys(ownership, ["status", "snapshot"])
        && validSnapshot(ownership.snapshot, site) && ownership.snapshot.evidence.intervals.length === 0;
}
function capturedOwnershipMatches(initial: LinkedInitialRecord, ownership: OwnershipRead) {
    const captured = initial.preparedContext.ownership;
    if (captured.status === "missing") return ownership.status === "missing";
    return ownership.status === "available"
        && ownershipFingerprint(captured.snapshot) === ownershipFingerprint(ownership.snapshot);
}
const approvalId = (initial: LinkedInitialRecord) => ownershipFingerprint({
    approval: initial.exception.approval, consent: initial.exception.consent,
    exactExperimentFingerprint: initial.exception.exactExperimentFingerprint,
});
const ownershipKey = (initial: LinkedInitialRecord) => ownershipFingerprint(initial.preparedContext.ownership);
async function syncDirectory(directory: string) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
}
async function assertPhysicalDirectory(directory: string) {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(directory) !== directory)
        throw Error("UNSAFE_JOURNAL_PATH");
}
async function assertPhysicalChain(directory: string, durableRoot: string) {
    const filesystemRoot = path.parse(durableRoot).root;
    let current = filesystemRoot;
    await assertPhysicalDirectory(current);
    for (const part of path.relative(filesystemRoot, durableRoot).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); await assertPhysicalDirectory(current);
    }
    for (const part of path.relative(durableRoot, directory).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); await assertPhysicalDirectory(current);
    }
}
async function ensureDurableDirectory(directory: string, durableRoot: string): Promise<void> {
    if (!path.isAbsolute(directory) || !path.isAbsolute(durableRoot)) throw Error("INVALID_DURABLE_ROOT");
    const target = path.resolve(directory), root = path.resolve(durableRoot);
    if (target !== directory || root !== durableRoot) throw Error("INVALID_DURABLE_ROOT");
    const relative = path.relative(root, target);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
        throw Error("INVALID_DURABLE_ROOT");

    // The caller supplies an already-created root whose own directory entry is
    // trusted. Opening and syncing it verifies that this claimant can establish
    // durability below it before creating any claim artifacts.
    await assertPhysicalChain(root, root);
    await syncDirectory(root);
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        await assertPhysicalDirectory(current);
    }
    await assertPhysicalChain(target, root);

    // Every claimant independently flushes every entry in the chain. EEXIST at
    // any level may mean another process created that ancestor but has not made
    // its entry durable.
    current = target === root ? root : path.dirname(target);
    while (true) {
        await syncDirectory(current);
        if (current === root) break;
        current = path.dirname(current);
    }
    await assertPhysicalChain(target, root);
}
async function lines(file: string) {
    const text = await readFile(file, "utf8");
    if (!text.endsWith("\n")) throw Error("HISTORICAL_JOURNAL_INVALID");
    return text.trimEnd().split("\n").map(line => JSON.parse(line));
}
async function pair(file: string, site: string) {
    const records = await lines(file);
    if (records.length !== 2 || !validLinkedInitialRecord(records[0], site)
        || !validLinkedClassifiedRecord(records[1], records[0])) throw Error("HISTORICAL_JOURNAL_INVALID");
    return { initial: records[0] as LinkedInitialRecord, classified: records[1] as LinkedClassifiedRecord };
}
function validCompleted(value: unknown, site: string): value is CompletedAttempt {
    if (!value || typeof value !== "object") return false;
    const marker = value as CompletedAttempt;
    const { checksum, ...bound } = marker;
    return sameKeys(marker, ["version", "site", "attemptId", "mutationId", "approvalId", "ownershipKey", "initialRecordId", "classifiedRecordId", "previousAttemptId", "checksum"])
        && marker.version === 1 && marker.site === site && /^[A-Za-z0-9_-]{1,128}$/.test(marker.mutationId)
        && marker.attemptId === attemptId(marker.mutationId)
        && (marker.previousAttemptId === null || /^mutation:[A-Za-z0-9_-]{1,128}$/.test(marker.previousAttemptId)
            || /^legacy:[a-f0-9]{64}$/.test(marker.previousAttemptId))
        && /^[a-f0-9]{64}$/.test(marker.approvalId) && /^[a-f0-9]{64}$/.test(marker.ownershipKey)
        && /^[a-f0-9]{64}$/.test(marker.initialRecordId) && /^[a-f0-9]{64}$/.test(marker.classifiedRecordId)
        && checksum === completedChecksum(bound);
}

async function history(directory: string, site: string, ignoreActive = false) {
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { latest: null as null | { id: string; classified: LinkedClassifiedRecord }, active: false, attemptIds: new Set<string>() }; throw error; }
    if (!ignoreActive && names.includes(activeName(site))) return { latest: null, active: true };
    const legacyFile = legacyName(site), hasLegacy = names.includes(legacyFile);
    let root: string | null = null;
    let legacy: { id: string; classified: LinkedClassifiedRecord } | null = null;
    const attemptIds = new Set<string>();
    if (hasLegacy) {
        const records = await pair(path.join(directory, legacyFile), site);
        legacy = { id: `legacy:${records.initial.initialRecordId}`, classified: records.classified };
        root = legacy.id;
        attemptIds.add(attemptId(records.initial.mutationId));
    }
    const prefix = `site-${site}-attempt-`;
    const markers: Array<{ marker: CompletedAttempt; classified: LinkedClassifiedRecord }> = [];
    for (const name of names.filter(name => name.startsWith(prefix) && name.endsWith(".complete")).sort()) {
        const raw = JSON.parse(await readFile(path.join(directory, name), "utf8"));
        if (!validCompleted(raw, site) || name !== completeName(site, raw.mutationId)) throw Error("HISTORICAL_JOURNAL_INVALID");
        const records = await pair(path.join(directory, journalName(site, raw.mutationId)), site);
        if (records.initial.mutationId !== raw.mutationId || records.initial.initialRecordId !== raw.initialRecordId
            || records.classified.classifiedRecordId !== raw.classifiedRecordId
            || raw.approvalId !== approvalId(records.initial) || raw.ownershipKey !== ownershipKey(records.initial))
            throw Error("HISTORICAL_JOURNAL_INVALID");
        if (attemptIds.has(raw.attemptId)) throw Error("HISTORICAL_JOURNAL_INVALID");
        attemptIds.add(raw.attemptId);
        markers.push({ marker: raw, classified: records.classified });
    }
    const completedJournals = names.filter(name => name.startsWith(prefix) && name.endsWith(".jsonl"));
    if (completedJournals.length !== markers.length) throw Error("HISTORICAL_JOURNAL_INVALID");
    let previous = root, latest = legacy;
    const remaining = new Set(markers);
    while (true) {
        const successors = [...remaining].filter(value => value.marker.previousAttemptId === previous);
        if (!successors.length) break;
        if (successors.length !== 1) throw Error("HISTORICAL_JOURNAL_INVALID");
        const next = successors[0]; remaining.delete(next); previous = next.marker.attemptId;
        latest = { id: next.marker.attemptId, classified: next.classified };
    }
    if (remaining.size) throw Error("HISTORICAL_JOURNAL_INVALID");
    return { latest, active: false, attemptIds };
}

function eligibilityFor(latest: { id: string; classified: LinkedClassifiedRecord } | null,
    ownership: OwnershipRead, site: string): RepeatAttemptEligibility {
    if (!ownershipSafe(ownership, site)) return Object.freeze({ status: "blocked", code: "OWNERSHIP_UNRESOLVED", previousAttemptId: latest?.id ?? null });
    if (!latest) return Object.freeze({ status: "eligible", code: "NO_PRIOR_ATTEMPT", previousAttemptId: null });
    if (latest.classified.classification === "request-rejected")
        return Object.freeze({ status: "eligible", code: "PRIOR_REQUEST_REJECTED", previousAttemptId: latest.id });
    if (latest.classified.classification === "submitted-representation-preserved")
        return Object.freeze({ status: "blocked", code: "RESTORATION_REQUIRED", previousAttemptId: latest.id });
    return Object.freeze({ status: "blocked", code: "PRIOR_OUTCOME_AMBIGUOUS", previousAttemptId: latest.id });
}

export async function repeatAttemptEligibility(directory: string, site: string, ownership: OwnershipRead): Promise<RepeatAttemptEligibility> {
    if (!/^\d+$/.test(site)) throw Error("INVALID_SITE_ID");
    try {
        const state = await history(directory, site);
        if (state.active) return Object.freeze({ status: "blocked", code: "ATTEMPT_IN_PROGRESS", previousAttemptId: null });
        return eligibilityFor(state.latest, structuredClone(ownership), site);
    } catch (error) {
        if (error instanceof Error && error.message === "HISTORICAL_JOURNAL_INVALID")
            return Object.freeze({ status: "blocked", code: "HISTORICAL_JOURNAL_INVALID", previousAttemptId: null });
        throw error;
    }
}

/** Isolated future claim boundary. It is deliberately not wired to the executor.
 * The legacy per-site journal is read as an immutable predecessor, never renamed,
 * reset or removed. The active marker is atomically renamed after classification;
 * crashes leave it in place and therefore block every successor attempt. */
export async function claimRepeatAttempt(directory: string, site: string, record: unknown, ownership: OwnershipRead, durableRoot: string) {
    const initial = structuredClone(record) as LinkedInitialRecord;
    if (!/^\d+$/.test(site) || !validLinkedInitialRecord(initial, site)) throw Error("JOURNAL_INITIAL_INVALID");
    if (!ownershipSafe(structuredClone(ownership), site) || !capturedOwnershipMatches(initial, ownership)) throw Error("OWNERSHIP_UNRESOLVED");
    await ensureDurableDirectory(directory, durableRoot);
    const before = await repeatAttemptEligibility(directory, site, ownership);
    if (before.status !== "eligible") throw Error(before.code);
    const inspected = await history(directory, site);
    if (inspected.attemptIds?.has(attemptId(initial.mutationId))) throw Error("DUPLICATE_MUTATION_ID");
    await assertPhysicalChain(directory, path.resolve(durableRoot));
    const activePath = path.join(directory, activeName(site));
    const lock = await open(activePath, "wx", 0o600);
    try {
        const locked = await history(directory, site, true);
        const current = eligibilityFor(locked.latest, structuredClone(ownership), site);
        if (current.status !== "eligible" || current.previousAttemptId !== before.previousAttemptId) throw Error("ATTEMPT_HISTORY_CHANGED");
        const markerBody = { version: 1 as const, site, attemptId: attemptId(initial.mutationId), mutationId: initial.mutationId,
            approvalId: approvalId(initial), ownershipKey: ownershipKey(initial), initialRecordId: initial.initialRecordId,
            classifiedRecordId: "", previousAttemptId: current.previousAttemptId };
        await lock.writeFile(JSON.stringify(markerBody) + "\n", "utf8"); await lock.sync();
        const journal = await open(path.join(directory, journalName(site, initial.mutationId)), "wx", 0o600);
        try { await journal.writeFile(JSON.stringify(initial) + "\n", "utf8"); await journal.sync(); }
        finally { await journal.close(); }
    } finally { await lock.close(); }
    // File fsync makes contents durable; directory fsync makes both new names
    // durable. Failure is uncertain and deliberately leaves the active claim.
    await syncDirectory(directory);
    let finished = false;
    return { async finish(value: unknown) {
        if (finished) throw Error("RESULT_ALREADY_RECORDED");
        finished = true;
        const classified = structuredClone(value) as LinkedClassifiedRecord;
        if (!validLinkedClassifiedRecord(classified, initial)) throw Error("JOURNAL_CLASSIFIED_INVALID");
        const journal = await open(path.join(directory, journalName(site, initial.mutationId)), "a");
        try { await journal.writeFile(JSON.stringify(classified) + "\n", "utf8"); await journal.sync(); }
        finally { await journal.close(); }
        const body = { version: 1 as const, site, attemptId: attemptId(initial.mutationId), mutationId: initial.mutationId,
            approvalId: approvalId(initial), ownershipKey: ownershipKey(initial), initialRecordId: initial.initialRecordId,
            classifiedRecordId: classified.classifiedRecordId,
            previousAttemptId: before.previousAttemptId };
        const complete: CompletedAttempt = { ...body, checksum: completedChecksum(body) };
        const marker = await open(activePath, "w", 0o600);
        try { await marker.writeFile(JSON.stringify(complete) + "\n", "utf8"); await marker.sync(); }
        finally { await marker.close(); }
        await rename(activePath, path.join(directory, completeName(site, initial.mutationId)));
        const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
        return Object.freeze({ status: "classified" as const, attemptId: complete.attemptId, mutationId: complete.mutationId });
    } };
}

type OfflineCompletionAdmission = Pick<SmartOperationCompletionRecord, "apiWrite" | "readback" | "submittedAt" | "completedAt">;
export type OfflineOperationJournalPorts = Omit<OfflineOperationPreparationPorts, "readConfirmedHistory"> & {
    /** Read already-obtained OFFLINE execution/readback evidence. No command or
     * transport is invoked by the journal, and no production adapter is provided. */
    readCompletionEvidence(initial: SmartOperationInitialRecord): Promise<OfflineCompletionAdmission>;
};
type OfflineOperationMarker = {
    version: 2; mode: "offline-context"; site: string; prepared: PreparedOperationContext;
    admission: OfflineCompletionAdmission | null; completionRecordId: string | null; evidenceId: string | null; checksum: string;
};
const documentaryOnly = { writeReady: false, executionReady: false, rollbackProven: false, restorationProven: false,
    grantsRepeatAuthority: false, grantsSuccessorAuthority: false, resolvesHistoricalJournal: false } as const;
type OperationHistoryRead = ({ status: "empty" } | { status: "available"; history: OfflineOperationHistory }
    | { status: "legacy"; records: Array<{ initial: LinkedInitialRecord; classified: LinkedClassifiedRecord }> }
    | { status: "blocked"; code: string }) & typeof documentaryOnly;
function operationMarker(body: Omit<OfflineOperationMarker, "checksum">): OfflineOperationMarker {
    return { ...body, checksum: ownershipFingerprint(body) };
}
function operationCompletionDiagnostic(prepared: PreparedOperationContext, completion: SmartOperationCompletionRecord): string | null {
    const checked = validateOperationCompletionRecord(completion, prepared.initial);
    if (checked.status === "rejected") return checked.code;
    const submit = Date.parse(completion.submittedAt), k = prepared.capture.kraken;
    return [k.lastSuccessfulUpdate, k.importTariff!.observedAt].every(time => Date.parse(time) <= submit
        && submit - Date.parse(time) <= EVIDENCE_TTL_MS) ? null : "STALE_KRAKEN_EVIDENCE";
}
async function physicalJournalText(file: string) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file || stat.size > 8_000_000) throw Error("OPERATION_JOURNAL_INVALID");
    const text = await readFile(file, "utf8");
    if (!text.endsWith("\n")) throw Error("OPERATION_JOURNAL_INCOMPLETE");
    return text;
}
function operationContext(record: ConfirmedOperationEvidence, prepared: PreparedOperationContext, admission: OfflineCompletionAdmission,
    previous: OfflineOperationHistory): ConfirmedOperationValidationContext {
    const i = record.initial.intent, c = record.completion, last = previous.contexts.at(-1);
    // A documentary retained-original reference for evidence validation, not a V3
    // snapshot, runtime receipt issuance or ownership finalisation. The opaque
    // issuance reference must have come from the independent preparation port.
    const retainedOriginal = i.ownershipBefore?.lifecycle ?? {
        version: 1 as const, energySiteId: i.energySiteId, timeZone: i.timeZone, original: i.original, originalFingerprint: i.originalFingerprint,
        origin: { mutationId: i.mutationId, initialRecordId: record.initial.initialRecordId, classifiedRecordId: c.completionRecordId,
            receiptKey: record.evidenceId, issuanceKey: prepared.originIssuanceReference, journal: "attempt" as const },
        restorationObligation: "required" as const, currentGeneration: i.ownershipAfterGeneration,
        latestReadback: { mutationId: i.mutationId, receiptKey: record.evidenceId, fingerprint: c.finalTariffFingerprint },
    };
    return { energySiteId: i.energySiteId, timeZone: i.timeZone, ownershipBefore: i.ownershipBefore, ownershipAfterGeneration: i.ownershipAfterGeneration,
        retainedOriginal, confirmedHistory: previous.records,
        approvals: [...(last?.approvals ?? []), prepared.initial.approval],
        authenticatedObservations: [...(last?.authenticatedObservations ?? []),
            { ...prepared.initial.intent.before, operationId: i.operationId, mutationId: i.mutationId, phase: "before" as const },
            { ...admission.readback, operationId: i.operationId, mutationId: i.mutationId, phase: "readback" as const }],
        durableJournal: [...(last?.durableJournal ?? []), { initialRecordId: record.initial.initialRecordId, completionRecordId: c.completionRecordId }],
        ...(i.ownershipAttribution ? { ownershipAttributions: [...(last?.ownershipAttributions ?? []), {
            operationId: i.operationId, capture: prepared.capture, admission: i.ownershipAttribution.admission,
            originIssuanceReference: prepared.originIssuanceReference,
        }] } : {}) };
}
async function operationHistory(directory: string, site: string, durableRoot: string, ignoreActive = false,
    readAdmission?: OfflineOperationPreparationPorts["readOwnershipAttributionAdmission"]): Promise<OperationHistoryRead> {
    const blocked = (code: string): OperationHistoryRead => ({ status: "blocked", code, ...documentaryOnly });
    try {
        if (!/^\d+$/.test(site) || !path.isAbsolute(directory) || !path.isAbsolute(durableRoot)
            || path.resolve(directory) !== directory || path.resolve(durableRoot) !== durableRoot
            || path.relative(durableRoot, directory).startsWith("..") || path.isAbsolute(path.relative(durableRoot, directory)))
            return blocked("INVALID_DURABLE_ROOT");
        await assertPhysicalChain(durableRoot, durableRoot);
        let names: string[];
        try { names = await readdir(directory); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "empty", ...documentaryOnly }; throw e; }
        await assertPhysicalChain(directory, durableRoot);
        if (!ignoreActive && names.includes(activeName(site))) return blocked("ATTEMPT_IN_PROGRESS");
        const prefix = `site-${site}-attempt-`, journals = names.filter(n => n.startsWith(prefix) && n.endsWith(".jsonl"));
        const markers = names.filter(n => n.startsWith(prefix) && n.endsWith(".complete"));
        const raw = await Promise.all(markers.map(async name => ({ name, marker: JSON.parse(await physicalJournalText(path.join(directory, name))) as Omit<OfflineOperationMarker, "version"> & { version: number } })));
        if (names.includes(legacyName(site)) || raw.some(r => r.marker.version === 1)) {
            if (raw.some(r => r.marker.version !== 1)) return blocked("MIXED_OPERATION_HISTORY");
            const legacy = await history(directory, site, ignoreActive);
            if (legacy.active) return blocked("ATTEMPT_IN_PROGRESS");
            const files = [...(names.includes(legacyName(site)) ? [legacyName(site)] : []), ...journals];
            for (const name of files) await physicalJournalText(path.join(directory, name));
            return { status: "legacy", records: await Promise.all(files.map(name => pair(path.join(directory, name), site))), ...documentaryOnly };
        }
        if (names.some(n => (n.startsWith(`site-${site}-`) || n.startsWith(`site-${site}.`))
            && n !== activeName(site) && !journals.includes(n) && !markers.includes(n))) return blocked("UNRECOGNISED_OPERATION_EVIDENCE");
        if (journals.length !== markers.length) return blocked("OPERATION_JOURNAL_INCOMPLETE");
        if (!raw.length) return { status: "empty", ...documentaryOnly };
        const remaining = new Set(raw), result: OfflineOperationHistory = { records: [], contexts: [] };
        let previous: string | null = null;
        while (remaining.size) {
            const candidates = [...remaining].filter(r => (r.marker.prepared?.initial?.intent?.predecessor?.evidenceId ?? null) === previous);
            if (candidates.length !== 1) return blocked("OPERATION_HISTORY_CONFLICT");
            const next = candidates[0], m = next.marker;
            if (!validJournalEvidenceJson(m) || !sameKeys(m, ["version", "mode", "site", "prepared", "admission", "completionRecordId", "evidenceId", "checksum"])) return blocked("OPERATION_MARKER_INVALID");
            const { checksum, ...body } = m;
            if (m.version !== 2 || m.mode !== "offline-context" || m.site !== site || checksum !== ownershipFingerprint(body)
                || !validPreparedOperationContext(m.prepared) || !m.admission) return blocked("OPERATION_MARKER_INVALID");
            const i = m.prepared.initial.intent;
            if (i.ownershipAttribution) {
                if (!readAdmission) return blocked("TRUSTED_ATTRIBUTION_ADMISSION_REQUIRED");
                const trusted = await readAdmission(site, i.operationId, i.mutationId);
                if (validateOwnershipAttribution(i.ownershipAttribution, i, m.prepared.capture, trusted,
                    m.prepared.originIssuanceReference).status !== "validated") return blocked("OWNERSHIP_ATTRIBUTION_CONFLICT");
            }
            if (i.energySiteId !== site || next.name !== completeName(site, i.mutationId)) return blocked("OPERATION_MARKER_INVALID");
            const text = await physicalJournalText(path.join(directory, journalName(site, i.mutationId)));
            const records = text.slice(0, -1).split("\n").map(line => JSON.parse(line));
            if (records.length !== 2 || validateOperationInitialRecord(records[0]).status !== "validated"
                || operationCompletionDiagnostic(m.prepared, records[1]) !== null
                || ownershipFingerprint(records[0]) !== ownershipFingerprint(m.prepared.initial)) return blocked("OPERATION_RECORD_CONFLICT");
            const envelope = { version: 2 as const, initial: records[0] as SmartOperationInitialRecord, completion: records[1] as SmartOperationCompletionRecord };
            const record = { ...envelope, evidenceId: ownershipFingerprint(envelope) };
            if (m.evidenceId !== record.evidenceId || m.completionRecordId !== record.completion.completionRecordId
                || !sameKeys(m.admission, ["apiWrite", "readback", "submittedAt", "completedAt"])
                || ownershipFingerprint(m.admission) !== ownershipFingerprint({ apiWrite: record.completion.apiWrite,
                    readback: record.completion.readback, submittedAt: record.completion.submittedAt, completedAt: record.completion.completedAt }))
                return blocked("OPERATION_ADMISSION_CONFLICT");
            const context = operationContext(record, m.prepared, m.admission, structuredClone(result));
            const checked = validateConfirmedOperationEvidence(record, context);
            if (checked.status !== "validated") return blocked(checked.code);
            result.records.push(record); result.contexts.push(context); remaining.delete(next); previous = record.evidenceId;
        }
        return { status: "available", history: result, ...documentaryOnly };
    } catch { return blocked("OPERATION_JOURNAL_INVALID"); }
}

/** Offline documentary admission into the EXISTING per-operation journal layout.
 * No executor, runtime registry registration, eligibility/permission result or
 * successor claim is exposed. Production V1 readers deliberately block on V2
 * markers. Configured paths/ports are trusted server composition, never JSON.
 * Restart trusts only this physical server-owned directory and validated admission
 * markers, not arbitrary envelopes. As with the existing local journal, a party
 * controlling every file is outside this integrity (not cryptographic) boundary. */
export function offlineOperationJournal(config: { mode: "offline"; directory: string; site: string; durableRoot: string }, ports: OfflineOperationJournalPorts) {
    const { directory, site, durableRoot } = config;
    if (config.mode !== "offline" || !/^\d+$/.test(site)) throw Error("OFFLINE_OPERATION_JOURNAL_REQUIRED");
    const readHistory = () => operationHistory(directory, site, durableRoot, false, ports.readOwnershipAttributionAdmission);
    return { readHistory, async recordInitial(request: OfflineOperationRequest) {
        if (request.energySiteId !== site) throw Error("OPERATION_SITE_MISMATCH");
        await ensureDurableDirectory(directory, durableRoot);
        const before = await readHistory();
        if (before.status !== "available" && before.status !== "empty") throw Error(before.status === "blocked" ? before.code : "LEGACY_OPERATION_HISTORY");
        const known = before.status === "available" ? before.history : { records: [], contexts: [] };
        const prepared = await prepareOperationMutationContext(request, { ...ports, readConfirmedHistory: async () => structuredClone(known) });
        await assertPhysicalChain(directory, durableRoot);
        const activePath = path.join(directory, activeName(site)), lock = await open(activePath, "wx", 0o600);
        const pending = operationMarker({ version: 2, mode: "offline-context", site, prepared, admission: null, completionRecordId: null, evidenceId: null });
        try {
            const locked = await operationHistory(directory, site, durableRoot, true, ports.readOwnershipAttributionAdmission);
            const lockedHistory = locked.status === "empty" ? { records: [], contexts: [] } : locked.status === "available" ? locked.history : null;
            if (!lockedHistory || ownershipFingerprint(lockedHistory) !== ownershipFingerprint(known)) throw Error("OPERATION_HISTORY_CHANGED");
            await recheckPreparedOperation(prepared, ports);
            await lock.writeFile(JSON.stringify(pending) + "\n", "utf8"); await lock.sync();
            const journal = await open(path.join(directory, journalName(site, prepared.initial.intent.mutationId)), "wx", 0o600);
            try { await journal.writeFile(JSON.stringify(prepared.initial) + "\n", "utf8"); await journal.sync(); }
            finally { await journal.close(); }
        } finally { await lock.close(); }
        await syncDirectory(directory);
        let finished = false;
        return { status: "pending" as const, prepared: structuredClone(prepared), ...documentaryOnly, async recordCompletion() {
            if (finished) throw Error("RESULT_ALREADY_RECORDED");
            finished = true;
            const current = await ports.readOwnership(site), i = prepared.initial.intent;
            if (!operationCommitPreconditionMatches(prepared, current, i.ownershipAfterGeneration)) throw Error("OPERATION_OWNERSHIP_STALE");
            const admission = structuredClone(await ports.readCompletionEvidence(structuredClone(prepared.initial)));
            if (!validJournalEvidenceJson(admission) || !sameKeys(admission, ["apiWrite", "readback", "submittedAt", "completedAt"])) throw Error("OPERATION_ADMISSION_INVALID");
            const completionBody = { journalSchemaVersion: 2 as const, phase: "confirmed-operation" as const,
                operationId: i.operationId, mutationId: i.mutationId, energySiteId: site, timeZone: i.timeZone,
                initialRecordId: prepared.initial.initialRecordId, ownershipAfterGeneration: i.ownershipAfterGeneration,
                ...admission, journalCompletedAt: ports.now(), finalTariffFingerprint: ownershipFingerprint(admission.readback?.observation?.tariff),
                outcome: ({ apply: "applied", update: "updated", restore: "restored" } as const)[i.kind] };
            const completion = { ...completionBody, completionRecordId: ownershipFingerprint(completionBody) };
            const diagnostic = operationCompletionDiagnostic(prepared, completion);
            if (diagnostic) throw Error(diagnostic); // Active marker stays consumed on uncertainty.
            const initialText = await physicalJournalText(path.join(directory, journalName(site, i.mutationId)));
            if (initialText !== JSON.stringify(prepared.initial) + "\n" || await physicalJournalText(activePath) !== JSON.stringify(pending) + "\n") throw Error("OPERATION_HISTORY_CHANGED");
            const append = await open(path.join(directory, journalName(site, i.mutationId)), "a");
            try { await append.writeFile(JSON.stringify(completion) + "\n", "utf8"); await append.sync(); }
            finally { await append.close(); }
            const envelope = { version: 2 as const, initial: prepared.initial, completion }, evidenceId = ownershipFingerprint(envelope);
            const complete = operationMarker({ version: 2, mode: "offline-context", site, prepared, admission,
                completionRecordId: completion.completionRecordId, evidenceId });
            const marker = await open(activePath, "w", 0o600);
            try { await marker.writeFile(JSON.stringify(complete) + "\n", "utf8"); await marker.sync(); }
            finally { await marker.close(); }
            try {
                await rename(activePath, path.join(directory, completeName(site, i.mutationId))); await syncDirectory(directory);
            } catch (error) {
                // A failed final directory sync must not look like a newly
                // available operation to the next reader. Never erase evidence;
                // retain/recreate the consumed marker on uncertain completion.
                try {
                    const uncertain = await open(activePath, "wx", 0o600);
                    try { await uncertain.writeFile(JSON.stringify(pending) + "\n", "utf8"); await uncertain.sync(); }
                    finally { await uncertain.close(); }
                    await syncDirectory(directory);
                } catch { /* An existing active marker also blocks. Unwritable storage needs manual recovery. */ }
                throw error;
            }
            const read = await readHistory();
            if (read.status !== "available" || read.history.records.at(-1)?.evidenceId !== evidenceId) throw Error("OPERATION_HISTORY_INVALID");
            return { status: "recorded" as const, evidence: { ...envelope, evidenceId }, ...documentaryOnly };
        } };
    } };
}

/** Offline-only extension of the existing journal mechanics. Its permanent
 * active marker also blocks claimRepeatAttempt. No B2 completion or ownership
 * capability is issued; successful rehearsal never unlocks a real site. */
export function smartLifecycleRehearsalJournal(directory: string, site: string, durableRoot: string) {
    if (!/^\d+$/.test(site)) throw Error("INVALID_SITE_ID");
    const file = path.join(directory, activeName(site));
    type Frame = { previousKey: string | null; body: LifecycleRecords; key: string };
    const stages = ["approval,review,schema", "apply,approval,review,schema",
        "apply,approval,restoreApproval,restoreReview,review,schema", "apply,approval,restore,restoreApproval,restoreReview,review,schema"];
    function frame(body: LifecycleRecords, previousKey: string | null): Frame {
        return { body, previousKey, key: ownershipFingerprint({ body, previousKey }) };
    }
    async function load() {
        await assertPhysicalChain(directory, durableRoot);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error("INVALID_REHEARSAL_JOURNAL");
        const raw = await readFile(file, "utf8");
        if (!raw.endsWith("\n")) throw Error("INVALID_REHEARSAL_JOURNAL");
        const frames: Frame[] = raw.trimEnd().split("\n").map(line => JSON.parse(line));
        if (!frames.length || frames.length > 4) throw Error("INVALID_REHEARSAL_JOURNAL");
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i], prior = frames[i - 1];
            if (!sameKeys(f, ["body", "previousKey", "key"]) || Object.keys(f.body).sort().join() !== stages[i]
                || f.previousKey !== (prior?.key ?? null) || frame(f.body, f.previousKey).key !== f.key
                || f.body.review.energySiteId !== site
                || prior && Object.entries(prior.body).some(([k, v]) => ownershipFingerprint(v)
                    !== ownershipFingerprint(f.body[k as keyof LifecycleRecords]))) throw Error("INVALID_REHEARSAL_JOURNAL");
        }
        // Each frame is cumulative and every prefix was checked unchanged above.
        // Validate the complete final evidence once, not once per historical copy.
        if (!validSmartRehearsalRecords(frames.at(-1)!.body)) throw Error("INVALID_REHEARSAL_JOURNAL");
        return { raw, current: frames.at(-1)! };
    }
    async function append(body: LifecycleRecords, prior: Awaited<ReturnType<typeof load>>) {
        if (!validSmartRehearsalRecords(body) || await readFile(file, "utf8") !== prior.raw)
            throw Error("REHEARSAL_HISTORY_CHANGED");
        const handle = await open(file, "a");
        try { await handle.writeFile(JSON.stringify(frame(body, prior.current.key)) + "\n", "utf8"); await handle.sync(); }
        finally { await handle.close(); }
    }
    return {
        async read() {
            try {
                const { current } = await load();
                const body = current.body;
                const restoreClaimed = (await readdir(directory)).includes(`${activeName(site)}.restore-claimed`);
                const status = body.restore?.classification === "submitted-representation-preserved" ? "simulated-restored"
                    : !restoreClaimed && !body.restoreReview && body.apply?.classification === "submitted-representation-preserved"
                        ? "restoration-review-required" : "manual-intervention-required";
                return { status, records: structuredClone(body), executionReady: false as const };
            } catch (error) {
                let missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
                if (missing) {
                    try { missing = !(await readdir(directory)).some(name => name.startsWith(`site-${site}`)); }
                    catch (readError) { missing = (readError as NodeJS.ErrnoException)?.code === "ENOENT"; }
                }
                return { status: missing ? "missing" : "manual-intervention-required",
                    records: null, executionReady: false as const };
            }
        },
        async claim(review: ApplyReview, approval: RehearsalApproval) {
            const body: LifecycleRecords = structuredClone({ schema: "smart-offline-lifecycle-v1", review, approval });
            if (review.energySiteId !== site || !validSmartRehearsalRecords(body)) throw Error("INVALID_REHEARSAL_JOURNAL");
            await ensureDurableDirectory(directory, durableRoot);
            // This rehearsal cannot override ANY retained production history.
            const names = await readdir(directory);
            if (names.some(name => name === legacyName(site) || name.startsWith(`site-${site}-attempt`)))
                throw Error("SITE_ATTEMPT_ALREADY_RECORDED");
            const handle = await open(file, "wx", 0o600);
            try { await handle.writeFile(JSON.stringify(frame(body, null)) + "\n", "utf8"); await handle.sync(); }
            finally { await handle.close(); }
            await syncDirectory(directory);
            const prior = await load();
            let finished = false;
            return { async finish(result: AttemptResult) {
                if (finished) throw Error("RESULT_ALREADY_RECORDED");
                finished = true;
                await append({ ...body, apply: structuredClone(result) }, prior);
            } };
        },
        async claimRestore(review: RestoreReview, approval: RehearsalApproval) {
            const prior = await load();
            if (prior.current.body.restoreReview) throw Error("RESTORATION_ALREADY_CLAIMED");
            const body = { ...prior.current.body, restoreReview: structuredClone(review), restoreApproval: structuredClone(approval) };
            if (!validSmartRehearsalRecords(body)) throw Error("INVALID_REHEARSAL_JOURNAL");
            // Separate exclusive claim survives interruption BEFORE result append.
            const handle = await open(`${file}.restore-claimed`, "wx", 0o600);
            try { await handle.writeFile(ownershipFingerprint(body), "utf8"); await handle.sync(); }
            finally { await handle.close(); }
            await syncDirectory(directory);
            await append(body, prior);
            const approved = await load();
            let finished = false;
            return { async finish(result: AttemptResult) {
                if (finished) throw Error("RESULT_ALREADY_RECORDED");
                finished = true;
                await append({ ...body, restore: structuredClone(result) }, approved);
            } };
        },
    };
}
