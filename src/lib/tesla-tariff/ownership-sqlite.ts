import { lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validOwnership, type ManagedImportEvidence } from "./ownership-evidence";
import { representationKey } from "./rollback-evidence";
import type { OwnershipRead, OwnershipSnapshot } from "./ownership-store";
import type { LinkedInitialRecord, LinkedClassifiedRecord } from "./linked-experiment-records";
import { issueConfirmedSmartReceipt } from "./confirmed-smart-receipt-issuer";
import { finaliseConfirmedSmartOwnership } from "./ownership-finalisation";

const hash = (v: unknown) => createHash("sha256").update(representationKey(v)).digest("hex");
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const siteId = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
function guard() {
    if (process.versions.node !== "26.8.2") throw Error("OWNERSHIP_NODE_26_8_2_REQUIRED");
}
function exists(file: string) {
    try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("OWNERSHIP_STORE_INVALID"); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function legacy(file: string, site: string) {
    // Any coexisting legacy ledger requires an explicit future migration decision.
    if (exists(path.join(path.dirname(file), `site-${site}.json`))) throw Error("OWNERSHIP_LEGACY_UNRESOLVED");
}
function validSnapshot(v: unknown, site: string): v is OwnershipSnapshot {
    if (!v || typeof v !== "object") return false;
    const s = v as OwnershipSnapshot;
    return Object.keys(s).sort().join() === "checksum,evidence,generation,historyDigest,version" && s.version === 2
        && digest(s.historyDigest)
        && typeof s.generation === "string" && /^[a-f0-9-]{36}$/.test(s.generation)
        && validOwnership(s.evidence) && s.evidence.energySiteId === site
        && s.checksum === hash({ generation: s.generation, evidence: s.evidence });
}
type Precondition = { status: "missing" } | { status: "available"; snapshot: OwnershipSnapshot };
type Identity = { status: "missing"; site: string } | {
    status: "available"; site: string; version: 1; generation: string; checksum: string; evidenceKey: string;
};
function identity(site: string, expected: Precondition): Identity {
    if (expected.status === "missing" && Object.keys(expected).join() === "status") return { status: "missing", site };
    if (expected.status !== "available" || Object.keys(expected).sort().join() !== "snapshot,status"
        || !validSnapshot(expected.snapshot, site)) throw Error("OWNERSHIP_PRECONDITION_INVALID");
    const s = expected.snapshot;
    return { status: "available", site, version: 1, generation: s.generation, checksum: s.checksum, evidenceKey: hash(s.evidence) };
}
function validIdentity(v: Identity, site: string) {
    return v && v.site === site && (v.status === "missing" ? Object.keys(v).sort().join() === "site,status"
        : v.status === "available" && Object.keys(v).sort().join() === "checksum,evidenceKey,generation,site,status,version"
        && v.version === 1 && typeof v.generation === "string" && /^[a-f0-9-]{36}$/.test(v.generation)
        && digest(v.checksum) && digest(v.evidenceKey));
}
type Application = { site: string; mutationId: string; issuanceKey: string; receiptKey: string;
    prior: Identity; priorHistoryDigest: string | null; result: Identity; checksum: string };
function validApplication(a: Application, site: string) {
    if (!a || Object.keys(a).sort().join() !== "checksum,issuanceKey,mutationId,prior,priorHistoryDigest,receiptKey,result,site") return false;
    const { checksum, ...bound } = a;
    return a.site === site && typeof a.mutationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a.mutationId)
        && digest(a.issuanceKey) && digest(a.receiptKey) && validIdentity(a.prior, site)
        && (a.prior.status === "missing" ? a.priorHistoryDigest === null : digest(a.priorHistoryDigest))
        && validIdentity(a.result, site) && a.result.status === "available" && checksum === hash(bound);
}
function connect(file: string, create: boolean): { db: DatabaseSync; created: boolean } {
    guard();
    let created = false;
    if (create) {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        try { const fd = openSync(file, "wx", 0o600); created = true; closeSync(fd); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!exists(file)) throw Error("OWNERSHIP_STORE_UNAVAILABLE");
    // Load only after the explicit runtime check, including on older Node versions.
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(file, { readOnly: !create, timeout: 0 });
    try {
        // Never select WAL or silently convert an existing database's journal mode.
        if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw Error("OWNERSHIP_STORE_INVALID");
        db.exec("PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
        return { db, created };
    } catch (error) { db.close(); throw error; }
}
const ownershipDDL = "CREATE TABLE ownership(site TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT";
const appliedDDL = `CREATE TABLE applied(site TEXT NOT NULL REFERENCES ownership(site), mutation TEXT NOT NULL,
    issuance TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(site,mutation), UNIQUE(site,issuance)) STRICT`;
function schema(db: DatabaseSync, initialise: boolean) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0 && initialise) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length) throw Error("OWNERSHIP_STORE_INVALID");
        db.exec(`${ownershipDDL}; ${appliedDDL}; PRAGMA user_version=2;`);
    } else if (version !== 2) throw Error("OWNERSHIP_STORE_INVALID");
    // This isolated v2 store accepts only its exact schema, not arbitrary SQL
    // claiming user_version=2. No triggers, views or replacement indexes allowed.
    const normalise = (sql: unknown) => typeof sql === "string" ? sql.replace(/\s+/g, " ").trim() : sql;
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const expected = [
        { type: "table", name: "applied", tbl_name: "applied", sql: normalise(appliedDDL) },
        { type: "table", name: "ownership", tbl_name: "ownership", sql: normalise(ownershipDDL) },
        { type: "index", name: "sqlite_autoindex_applied_1", tbl_name: "applied", sql: null },
        { type: "index", name: "sqlite_autoindex_applied_2", tbl_name: "applied", sql: null },
        { type: "index", name: "sqlite_autoindex_ownership_1", tbl_name: "ownership", sql: null },
    ];
    if (representationKey(objects.map(o => ({ ...o, sql: normalise(o.sql) }))) !== representationKey(expected))
        throw Error("OWNERSHIP_STORE_INVALID");
    for (const [table, indexes] of [
        ["ownership", [["sqlite_autoindex_ownership_1", "pk", ["site"]]]],
        ["applied", [["sqlite_autoindex_applied_1", "pk", ["site", "mutation"]],
            ["sqlite_autoindex_applied_2", "u", ["site", "issuance"]]]],
    ] as const) {
        const actual = db.prepare(`PRAGMA index_list('${table}')`).all();
        if (actual.length !== indexes.length) throw Error("OWNERSHIP_STORE_INVALID");
        for (const [name, origin, columns] of indexes) {
            const index = actual.find(i => i.name === name);
            const keys = db.prepare(`PRAGMA index_xinfo('${name}')`).all().filter(k => k.key === 1);
            if (!index || index.unique !== 1 || index.origin !== origin || index.partial !== 0
                || representationKey(keys.map(k => k.name)) !== representationKey(columns)
                || keys.some(k => k.coll !== "BINARY" || k.desc !== 0)) throw Error("OWNERSHIP_STORE_INVALID");
        }
    }
}
/** Fundamental invariant, independent of schema recognition or run() results.
 * Read the intended pair in the still-open write transaction before COMMIT. */
function verifyIntendedPair(db: DatabaseSync, snapshot: OwnershipSnapshot, application: Application) {
    try {
        const site = application.site;
        const rows = db.prepare("SELECT site,snapshot FROM ownership WHERE site=?").all(site);
        const identities = db.prepare("SELECT site,mutation,issuance,record FROM applied WHERE site=? AND (mutation=? OR issuance=?)")
            .all(site, application.mutationId, application.issuanceKey);
        if (rows.length !== 1 || identities.length !== 1) throw Error();
        const row = rows[0], applied = identities[0];
        const observed = JSON.parse(String(row.snapshot)), observedApplication = JSON.parse(String(applied.record));
        if (row.site !== site || applied.site !== site || applied.mutation !== application.mutationId
            || applied.issuance !== application.issuanceKey || !validSnapshot(observed, site)
            || !validApplication(observedApplication, site)
            || representationKey(observed) !== representationKey(snapshot)
            || representationKey(observedApplication) !== representationKey(application)
            || representationKey(observedApplication.result) !== representationKey(identity(site, { status: "available", snapshot: observed }))) throw Error();
    } catch { throw Error("OWNERSHIP_PAIR_VERIFICATION_FAILED"); }
}
/** Every retained application must belong to the single chain from genuinely
 * missing state to the current snapshot. No inferred/imported roots or repair. */
function validateHistory(site: string, current: Precondition, applications: Application[]) {
    const successors = new Map<string, Application>();
    const results = new Set<string>(), generations = new Set<string>();
    const mutations = new Set<string>(), issuances = new Set<string>();
    for (const a of applications) {
        const prior = representationKey(a.prior), result = representationKey(a.result);
        if (a.site !== site || a.prior.site !== site || a.result.site !== site || a.result.status !== "available"
            || successors.has(prior) || results.has(result) || generations.has(a.result.generation)
            || mutations.has(a.mutationId) || issuances.has(a.issuanceKey)) throw Error("OWNERSHIP_STORE_INVALID");
        successors.set(prior, a); results.add(result); generations.add(a.result.generation);
        mutations.add(a.mutationId); issuances.add(a.issuanceKey);
    }
    let cursor = representationKey(identity(site, { status: "missing" }));
    const visited = new Set<string>();
    const ordered: Application[] = [];
    while (successors.has(cursor)) {
        const next = successors.get(cursor)!;
        if (visited.has(next.mutationId)) throw Error("OWNERSHIP_STORE_INVALID");
        if (next.priorHistoryDigest !== (ordered.length ? historyDigest(site, ordered) : null))
            throw Error("OWNERSHIP_STORE_INVALID");
        ordered.push(next);
        visited.add(next.mutationId); cursor = representationKey(next.result);
    }
    if (visited.size !== applications.length || cursor !== representationKey(identity(site, current)))
        throw Error("OWNERSHIP_STORE_INVALID");
    if (current.status === "available" && current.snapshot.historyDigest !== historyDigest(site, ordered))
        throw Error("OWNERSHIP_STORE_INVALID");
    return ordered;
}
/** Canonical ordered records, including each complete identity and prior anchor.
 * Core ownership identity excludes this digest to avoid a circular result hash. */
function historyDigest(site: string, ordered: Application[]) {
    return hash({ version: 1, site, applications: ordered });
}
function verifyHistoryAppend(db: DatabaseSync, site: string, previous: Application[],
    intended: Application, snapshot: OwnershipSnapshot, appended: boolean) {
    try {
        const after = state(db, site); // Revalidates the entire resulting chain.
        const expected = appended ? [...previous, intended] : previous;
        const records = (values: Application[]) => values.map(v => representationKey(v)).sort();
        if (representationKey(records(after.applications)) !== representationKey(records(expected))
            || representationKey(after.current) !== representationKey({ status: "available", snapshot })) throw Error();
    } catch { throw Error("OWNERSHIP_HISTORY_VERIFICATION_FAILED"); }
}
function state(db: DatabaseSync, site: string) {
    const row = db.prepare("SELECT snapshot FROM ownership WHERE site=?").get(site);
    const records = db.prepare("SELECT mutation,issuance,record FROM applied WHERE site=?").all(site);
    const applications = records.map(row => {
        const a = JSON.parse(String(row.record)) as Application;
        if (!validApplication(a, site) || a.mutationId !== row.mutation || a.issuanceKey !== row.issuance) throw Error("OWNERSHIP_STORE_INVALID");
        return a;
    });
    if (!row) {
        if (applications.length) throw Error("OWNERSHIP_STORE_INVALID");
        return { current: { status: "missing" } as Precondition, applications };
    }
    const snapshot = JSON.parse(String(row.snapshot));
    if (!validSnapshot(snapshot, site)) throw Error("OWNERSHIP_STORE_INVALID");
    const current: Precondition = { status: "available", snapshot };
    const ordered = validateHistory(site, current, applications);
    return { current, applications: ordered };
}
function code(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (/^OWNERSHIP_[A-Z0-9_]+$/.test(message)) return message;
    const sqliteCode = (error as { errcode?: number })?.errcode;
    return sqliteCode === 5 || sqliteCode === 6 ? "OWNERSHIP_STORE_BUSY" : "OWNERSHIP_STORE_FAILED";
}
export function readOwnership(databasePath: string, site: string): OwnershipRead {
    let db: DatabaseSync | undefined;
    try {
        guard(); if (!siteId(site)) throw Error("OWNERSHIP_SITE_INVALID");
        const file = path.resolve(databasePath); legacy(file, site);
        if (!exists(file)) return { status: "missing" };
        db = connect(file, false).db; db.exec("BEGIN"); schema(db, false);
        const { current } = state(db, site);
        db.exec("COMMIT"); db.close(); db = undefined;
        return structuredClone(current);
    } catch (error) {
        try { db?.close(); } catch { /* fail closed */ }
        const reason = code(error);
        return { status: reason === "OWNERSHIP_STORE_INVALID" ? "invalid" : "unavailable", code: reason };
    }
}

/** PRIVATE transaction primitive. Only the trusted three-input orchestration
 * below can call it in production; no raw evidence/precondition write API. */
type CommitInput = { site: string; expected: Precondition; evidence: ManagedImportEvidence;
    mutationId: string; issuanceKey: string; receiptKey: string };
type CommitResult = { status: "persisted" | "already-persisted"; snapshot: OwnershipSnapshot }
    | { status: "conflict" | "store-failed" | "indeterminate"; code: string };
function commitOwnership(databasePath: string, input: CommitInput): CommitResult {
    let db: DatabaseSync | undefined, inTransaction = false, commitAttempted = false;
    try {
        guard();
        const value = structuredClone(input), { site, expected, evidence, mutationId, issuanceKey, receiptKey } = value;
        if (!siteId(site) || typeof mutationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)
            || !digest(issuanceKey) || !digest(receiptKey) || !validOwnership(evidence) || evidence.energySiteId !== site)
            throw Error("OWNERSHIP_INPUT_INVALID");
        const prior = identity(site, expected), file = path.resolve(databasePath);
        const priorHistoryDigest = expected.status === "missing" ? null : expected.snapshot.historyDigest;
        legacy(file, site); const connection = connect(file, true); db = connection.db;
        db.exec("BEGIN IMMEDIATE"); inTransaction = true;
        schema(db, connection.created); legacy(file, site);
        const { current, applications } = state(db, site);
        const applied = applications.find(a => a.mutationId === mutationId);
        let snapshot: OwnershipSnapshot, status: "persisted" | "already-persisted";
        if (applied) {
            if (applied.issuanceKey !== issuanceKey || applied.receiptKey !== receiptKey
                || applied.priorHistoryDigest !== priorHistoryDigest
                || representationKey(applied.prior) !== representationKey(prior)) throw Error("OWNERSHIP_MUTATION_CONFLICT");
            if (current.status !== "available" || representationKey(applied.result) !== representationKey(identity(site, current)))
                throw Error("OWNERSHIP_GENERATION_CHANGED");
            if (representationKey(evidence) !== representationKey(current.snapshot.evidence)) throw Error("OWNERSHIP_MUTATION_CONFLICT");
            snapshot = current.snapshot; status = "already-persisted";
        } else {
            if (applications.some(a => a.issuanceKey === issuanceKey)) throw Error("OWNERSHIP_MUTATION_CONFLICT");
            if (representationKey(current) !== representationKey(expected)) throw Error("OWNERSHIP_GENERATION_CHANGED");
            const generation = randomUUID();
            const result: Identity = { status: "available", site, version: 1, generation,
                checksum: hash({ generation, evidence }), evidenceKey: hash(evidence) };
            const bound = { site, mutationId, issuanceKey, receiptKey, prior, priorHistoryDigest, result };
            const application: Application = { ...bound, checksum: hash(bound) };
            snapshot = { version: 2, generation, evidence, checksum: result.checksum,
                historyDigest: historyDigest(site, [...applications, application]) };
            db.prepare("INSERT INTO ownership(site,snapshot) VALUES(?,?) ON CONFLICT(site) DO UPDATE SET snapshot=excluded.snapshot")
                .run(site, JSON.stringify(snapshot));
            db.prepare("INSERT INTO applied(site,mutation,issuance,record) VALUES(?,?,?,?)")
                .run(site, mutationId, issuanceKey, JSON.stringify(application));
            status = "persisted";
        }
        const intended = { site, mutationId, issuanceKey, receiptKey, prior, priorHistoryDigest, result: identity(site, { status: "available", snapshot }) };
        const intendedApplication = { ...intended, checksum: hash(intended) };
        verifyIntendedPair(db, snapshot, intendedApplication);
        verifyHistoryAppend(db, site, applications, intendedApplication, snapshot, status === "persisted");
        commitAttempted = true; db.exec("COMMIT"); inTransaction = false;
        db.close(); db = undefined;
        return { status, snapshot: structuredClone(snapshot) };
    } catch (error) {
        let uncertain = commitAttempted;
        if (inTransaction) { try { db?.exec("ROLLBACK"); } catch { uncertain = true; } }
        try { db?.close(); } catch { uncertain = true; }
        const reason = code(error);
        return { status: uncertain ? "indeterminate" : ["OWNERSHIP_GENERATION_CHANGED", "OWNERSHIP_MUTATION_CONFLICT"].includes(reason)
            ? "conflict" : "store-failed", code: uncertain ? "OWNERSHIP_PERSISTENCE_INDETERMINATE" : reason };
    }
}
function freeze<T>(value: T): Readonly<T> {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

/** Standalone local boundary; deliberately not connected to any executor.
 * B2 capability identity is retained; only detached, exactly bound B1 records
 * supply evidence and the COMPLETE original ownership precondition. */
export function persistConfirmedSmart(capability: unknown, initialRecord: LinkedInitialRecord,
    classifiedRecord: LinkedClassifiedRecord) {
    const reject = (stage: "issuance" | "finalisation" | "binding", code: string, confirmed: boolean) => freeze({
        status: "rejected" as const, stage, code, confirmation: confirmed ? "confirmed" as const : "not-established" as const,
        writeReady: false as const, rollbackProven: false as const,
    });
    let commit: CommitInput, productionBlockers: string[];
    let stage: "issuance" | "finalisation" | "binding" = "issuance", confirmed = false;
    try {
        const initial = structuredClone(initialRecord), classified = structuredClone(classifiedRecord);
        const issued = issueConfirmedSmartReceipt(capability, initial, classified);
        if (issued.status !== "issued") return reject(stage, issued.code, false);
        confirmed = true; stage = "finalisation";
        const finalised = finaliseConfirmedSmartOwnership(issued.receipt);
        if (finalised.status !== "derived") return reject(stage, finalised.code, true);
        stage = "binding";
        const captured = initial.preparedContext.ownership;
        const expected: Precondition = captured.status === "missing" ? { status: "missing" }
            : { status: "available", snapshot: structuredClone(captured.snapshot) as OwnershipSnapshot };
        const site = issued.completion.energySiteId;
        // Validate the complete snapshot shape/checksum without reading/rebasing
        // current state. The transaction alone checks the captured history anchor.
        identity(site, expected);
        const generation = expected.status === "available" ? expected.snapshot.generation : null;
        const previous = expected.status === "available" ? expected.snapshot.evidence : null;
        const same = (a: unknown, b: unknown) => representationKey(a) === representationKey(b);
        if (captured.energySiteId !== site || initial.review.proposal.bound.energySiteId !== site
            || classified.energySiteId !== site || finalised.evidence.energySiteId !== site
            || !validOwnership(finalised.evidence)
            || finalised.evidence.timeZone !== initial.review.proposal.bound.timeZone
            || issued.completion.mutationId !== initial.mutationId || classified.mutationId !== initial.mutationId
            || issued.receipt.mutationId !== initial.mutationId || finalised.mutationId !== initial.mutationId
            || issued.completion.initialRecordId !== initial.initialRecordId
            || issued.completion.classifiedRecordId !== classified.classifiedRecordId
            || issued.receiptKey !== hash(issued.receipt) || finalised.receiptKey !== issued.receiptKey
            || issued.issuanceKey !== hash({ version: 1, completion: issued.completion, receiptKey: issued.receiptKey })
            || finalised.expectedGeneration !== generation || issued.receipt.original.prior.generation !== generation
            || issued.receipt.original.prior.capturedAt !== captured.capturedAt
            || !same(issued.receipt.original.prior.evidence, previous)
            || finalised.originalProposalFingerprint !== initial.review.proposal.fingerprint
            || finalised.originalPayloadKey !== initial.review.payloadJson
            || finalised.writeReady !== false || finalised.rollbackProven !== false)
            return reject(stage, "OWNERSHIP_BINDING_INVALID", true);
        commit = { site, expected, evidence: finalised.evidence, mutationId: initial.mutationId,
            issuanceKey: issued.issuanceKey, receiptKey: issued.receiptKey };
        productionBlockers = finalised.productionBlockers;
    } catch { return reject(stage, "OWNERSHIP_ORCHESTRATION_INVALID", confirmed); }
    // Trusted local destination, not a per-call caller override. No retry, clock,
    // journal mutation, transport or latch operation exists in this boundary.
    let file: string;
    try { file = path.join(process.cwd(), ".cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite"); }
    catch {
        // Confirmation already succeeded; no transaction has been attempted.
        return freeze({ status: "store-failed" as const, code: "OWNERSHIP_DESTINATION_UNAVAILABLE",
            stage: "persistence" as const, confirmation: "confirmed" as const,
            productionBlockers, writeReady: false as const, rollbackProven: false as const });
    }
    const result = commitOwnership(file, commit);
    return freeze({ ...result, stage: "persistence" as const, confirmation: "confirmed" as const,
        productionBlockers, writeReady: false as const, rollbackProven: false as const });
}
