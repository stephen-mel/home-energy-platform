import { lstat, mkdir, open, readFile, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { validLinkedInitialRecord, validLinkedClassifiedRecord, type LinkedInitialRecord, type LinkedClassifiedRecord } from "./linked-experiment-records";
import { validOwnership } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import type { OwnershipRead, OwnershipSnapshot } from "./ownership-store";
import { validSmartRehearsalRecords, type ApplyReview, type RestoreReview, type RehearsalApproval,
    type AttemptResult, type LifecycleRecords } from "./smart-lifecycle-rehearsal";

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
