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

import { validLifecycleOwnershipSnapshot, validRetainedOriginal, retainedOriginKey, type RetainedOriginal, type RetentionInput } from "./retained-original";
import { validateRetainedJournal } from "./retained-original-journal";
import { validatePersistedOwnershipHistory, persistenceOnly } from "./ownership-persistence";
import { readOfflineOperationHistory } from "./repeat-attempt-journal";
import type { OfflineOperationPreparationPorts } from "./prepared-mutation-context";

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
    const common = digest(s.historyDigest)
        && typeof s.generation === "string" && /^[a-f0-9-]{36}$/.test(s.generation)
        && validOwnership(s.evidence) && s.evidence.energySiteId === site;
    if (!common) return false;
    if (s.version === 2) return Object.keys(s).sort().join() === "checksum,evidence,generation,historyDigest,version"
        && s.checksum === hash({ generation: s.generation, evidence: s.evidence });
    return validLifecycleOwnershipSnapshot(s, site);
}
type Precondition = { status: "missing" } | { status: "available"; snapshot: OwnershipSnapshot };
type Identity = { status: "missing"; site: string } | {
    status: "available"; site: string; version: 1 | 2; generation: string; checksum: string; evidenceKey: string; lifecycleKey?: string;
};
function identity(site: string, expected: Precondition): Identity {
    if (expected.status === "missing" && Object.keys(expected).join() === "status") return { status: "missing", site };
    if (expected.status !== "available" || Object.keys(expected).sort().join() !== "snapshot,status"
        || !validSnapshot(expected.snapshot, site)) throw Error("OWNERSHIP_PRECONDITION_INVALID");
    const s = expected.snapshot;
    return { status: "available", site, version: s.version === 3 ? 2 : 1, generation: s.generation,
        checksum: s.checksum, evidenceKey: hash(s.evidence),
        ...(s.version === 3 ? { lifecycleKey: hash(s.lifecycle) } : {}) };
}
function validIdentity(v: Identity, site: string) {
    return v && v.site === site && (v.status === "missing" ? Object.keys(v).sort().join() === "site,status"
        : v.status === "available" && (v.version === 1 ? Object.keys(v).sort().join() === "checksum,evidenceKey,generation,site,status,version"
            : v.version === 2 && Object.keys(v).sort().join() === "checksum,evidenceKey,generation,lifecycleKey,site,status,version"
                && digest(v.lifecycleKey)) && typeof v.generation === "string" && /^[a-f0-9-]{36}$/.test(v.generation)
        && digest(v.checksum) && digest(v.evidenceKey));
}
type Application = { site: string; mutationId: string; issuanceKey: string; receiptKey: string;
    prior: Identity; priorHistoryDigest: string | null; result: Identity; checksum: string; lifecycle?: RetainedOriginal };
function validApplication(a: Application, site: string) {
    if (!a || Object.keys(a).sort().join() !== (a.lifecycle
        ? "checksum,issuanceKey,lifecycle,mutationId,prior,priorHistoryDigest,receiptKey,result,site"
        : "checksum,issuanceKey,mutationId,prior,priorHistoryDigest,receiptKey,result,site")) return false;
    if (a.result?.status === "available" && a.result.version === 2) {
        if (!validRetainedOriginal(a.lifecycle) || a.lifecycle.energySiteId !== site
            || a.lifecycle.currentGeneration !== a.result.generation || hash(a.lifecycle) !== a.result.lifecycleKey
            || a.lifecycle.latestReadback.mutationId !== a.mutationId
            || a.lifecycle.latestReadback.receiptKey !== a.receiptKey) return false;
    } else if (a.lifecycle !== undefined) return false;
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
    // The v2 database schema stores explicit v2/v3 snapshots; accept only its exact schema, not arbitrary SQL
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
    const retained = ordered.filter(a => a.lifecycle !== undefined);
    if (retained.length) {
        // No v2 migration, missing links, obligation discharge, or baseline substitution.
        if (retained.length !== ordered.length || new Set(retained.map(a => a.receiptKey)).size !== retained.length)
            throw Error("OWNERSHIP_RETENTION_HISTORY_CONFLICT");
        const root = ordered[0], original = root.lifecycle!;
        if (original.origin.mutationId !== root.mutationId || original.origin.issuanceKey !== root.issuanceKey
            || original.origin.receiptKey !== root.receiptKey
            || retained.some(a => retainedOriginKey(a.lifecycle!) !== retainedOriginKey(original)))
            throw Error("OWNERSHIP_RETENTION_HISTORY_CONFLICT");
    }
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
function validateRetentionJournal(file: string, retained: RetainedOriginal, applications: Application[]) {
    const { classified } = validateRetainedJournal(file, retained);
    const root = applications[0]?.lifecycle;
    if (!root || root.latestReadback.fingerprint !== hash(classified.apiTariffReadBack.observation?.tariff))
        throw Error("OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT");
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
        const { current, applications } = state(db, site);
        if (current.status === "available" && current.snapshot.version === 3)
            validateRetentionJournal(file, current.snapshot.lifecycle, applications);
        db.exec("COMMIT"); db.close(); db = undefined;
        return structuredClone(current);
    } catch (error) {
        try { db?.close(); } catch { /* fail closed */ }
        const reason = code(error);
        return { status: reason === "OWNERSHIP_STORE_INVALID" ? "invalid" : "unavailable", code: reason };
    }
}

/** F4a storage-consistency readback ONLY. There is intentionally no V3 write
 * boundary before F2 provides an internally verified confirmation capability.
 * A consistent-storage result is not authenticated completion, admission or a
 * trusted predecessor capability. Runtime reference provenance is unverified.
 * Both tables are read in one read-only SQLite transaction; matching V2 journal
 * history is read twice to reject changes during the observation. No files,
 * ownership, journals, latches or runtime registries are created or modified. */
export async function readPersistedOwnershipLifecycle(databasePath: string, site: string, timeZone: string,
    readAdmission?: OfflineOperationPreparationPorts["readOwnershipAttributionAdmission"]) {
    let db: DatabaseSync | undefined;
    const blocked = (code: string) => ({ status: "blocked" as const, code, ...persistenceOnly });
    try {
        guard(); if (!siteId(site)) return blocked("OWNERSHIP_SITE_INVALID");
        const file = path.resolve(databasePath); legacy(file, site);
        if (!exists(file)) return { status: "missing" as const, ...persistenceOnly };
        db = connect(file, false).db; db.exec("BEGIN"); schema(db, false);
        const row = db.prepare("SELECT snapshot FROM ownership WHERE site=?").get(site);
        const rows = db.prepare("SELECT mutation,issuance,record FROM applied WHERE site=?").all(site);
        if (!row) {
            if (rows.length) return blocked("V3_PERSISTENCE_HISTORY_INCOMPLETE");
            return { status: "missing" as const, ...persistenceOnly };
        }
        const current = JSON.parse(row.snapshot as string);
        if (current?.kind !== "v3-ownership-persistence") {
            const legacyState = state(db, site);
            if (legacyState.current.status === "available" && legacyState.current.snapshot.version === 3)
                validateRetentionJournal(file, legacyState.current.snapshot.lifecycle, legacyState.applications);
            return { status: "legacy" as const, ownership: structuredClone(legacyState.current), ...persistenceOnly };
        }
        const records = rows.map(row => {
            const record = JSON.parse(row.record as string), app = record?.lifecycle?.applications?.at(-1);
            if (!app || row.mutation !== app.mutationId || row.issuance !== app.runtime?.issuanceKey)
                throw Error("V3_PERSISTENCE_COLUMN_CONFLICT");
            return record;
        });
        const durableRoot = path.resolve(path.dirname(file), ".."), directory = path.join(durableRoot, "tesla-experiments");
        const config = { directory, durableRoot, site };
        const journal = await readOfflineOperationHistory(config, readAdmission);
        if (journal.status !== "available") return blocked(journal.status === "blocked" ? journal.code : "V3_PERSISTENCE_JOURNAL_MISSING");
        const checked = validatePersistedOwnershipHistory(current, records, site, timeZone, journal.history);
        if (checked.status !== "consistent-only") return blocked("code" in checked ? checked.code : "V3_PERSISTENCE_RUNTIME_PROVENANCE_UNAVAILABLE");
        const again = await readOfflineOperationHistory(config, readAdmission);
        if (representationKey(journal) !== representationKey(again)) return blocked("V3_PERSISTENCE_JOURNAL_CHANGED");
        db.exec("COMMIT");
        db.close(); db = undefined;
        return { ...checked, status: "consistent-storage" as const };
    } catch (error) {
        return blocked(error instanceof Error && /^V3_PERSISTENCE_[A-Z0-9_]+$/.test(error.message) ? error.message : code(error));
    }
    finally { try { db?.close(); } catch { /* No authority, including on close failure. */ } }
}

/** PRIVATE transaction primitive. Only the trusted three-input orchestration
 * below can call it in production; no raw evidence/precondition write API. */
type CommitInput = { site: string; expected: Precondition; evidence: ManagedImportEvidence;
    mutationId: string; issuanceKey: string; receiptKey: string; retention?: RetentionInput };
type CommitResult = { status: "persisted" | "already-persisted"; snapshot: OwnershipSnapshot }
    | { status: "conflict" | "store-failed" | "indeterminate"; code: string };
// Generation policy is private transaction input, never an authority token or
// a field accepted by the public guarded writer. No V3 caller is connected.
type ExactGeneration = { version: 1; expectedBefore: string | null; expectedAfter: string };
function validateExactOwnershipGeneration(approved: ExactGeneration, before: string | null) {
    if (!approved || Object.keys(approved).sort().join() !== "expectedAfter,expectedBefore,version"
        || approved.version !== 1 || typeof approved.expectedAfter !== "string"
        || !/^[a-f0-9-]{36}$/.test(approved.expectedAfter)
        || approved.expectedBefore !== before || approved.expectedAfter === before)
        throw Error("OWNERSHIP_GENERATION_CHANGED");
}
function commitOwnership(databasePath: string, input: CommitInput): CommitResult {
    return ownershipTransaction(databasePath, input);
}
// Deliberately disconnected until a guarded authority-bearing caller exists.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function commitOwnershipExact(databasePath: string, input: CommitInput, generation: ExactGeneration): CommitResult {
    if (!generation || typeof generation !== "object")
        return { status: "conflict", code: "OWNERSHIP_GENERATION_CHANGED" };
    return ownershipTransaction(databasePath, input, generation);
}
type TransactionFailure = Extract<CommitResult, { code: string }>;
function ownershipTransactionFailure(error: unknown, uncertain: boolean): TransactionFailure {
    const reason = code(error);
    return { status: uncertain ? "indeterminate" : ["OWNERSHIP_GENERATION_CHANGED", "OWNERSHIP_MUTATION_CONFLICT"].includes(reason)
        ? "conflict" : "store-failed", code: uncertain ? "OWNERSHIP_PERSISTENCE_INDETERMINATE" : reason };
}
/** Private shared SQLite mechanics. A callback is NOT authority; only internal
 * guarded callers select work. Offline format handling exists in test VM code
 * only, never in application exports or a production caller-selectable profile. */
function ownershipDatabaseTransaction<T>(file: string, site: string, work: (db: DatabaseSync) => Promise<T>): Promise<T | TransactionFailure>;
function ownershipDatabaseTransaction<T>(file: string, site: string, work: (db: DatabaseSync) => T): T | TransactionFailure;
function ownershipDatabaseTransaction<T>(file: string, site: string, work: (db: DatabaseSync) => T | Promise<T>): T | TransactionFailure | Promise<T | TransactionFailure> {
    let db: DatabaseSync | undefined, inTransaction = false, commitAttempted = false;
    const failed = (error: unknown): TransactionFailure => {
        let uncertain = commitAttempted;
        if (inTransaction) { try { db?.exec("ROLLBACK"); inTransaction = false; } catch { uncertain = true; } }
        try { db?.close(); db = undefined; } catch { uncertain = true; }
        return ownershipTransactionFailure(error, uncertain);
    };
    const finished = (result: T): T | TransactionFailure => {
        try {
            commitAttempted = true; db!.exec("COMMIT"); inTransaction = false;
            db!.close(); db = undefined;
            return result;
        } catch (error) { return failed(error); }
    };
    try {
        guard(); legacy(file, site);
        const connection = connect(file, true); db = connection.db;
        db.exec("BEGIN IMMEDIATE"); inTransaction = true;
        schema(db, connection.created); legacy(file, site);
        const result = work(db);
        return result instanceof Promise ? result.then(finished, failed) : finished(result);
    } catch (error) { return failed(error); }
}
function writeOwnershipPair(db: DatabaseSync, site: string, mutation: string, issuance: string, snapshot: unknown, application: unknown) {
    db.prepare("INSERT INTO ownership(site,snapshot) VALUES(?,?) ON CONFLICT(site) DO UPDATE SET snapshot=excluded.snapshot")
        .run(site, JSON.stringify(snapshot));
    db.prepare("INSERT INTO applied(site,mutation,issuance,record) VALUES(?,?,?,?)")
        .run(site, mutation, issuance, JSON.stringify(application));
}
function ownershipTransaction(databasePath: string, input: CommitInput, exact?: ExactGeneration): CommitResult {
    try {
        guard();
        const value = structuredClone(input), { site, expected, evidence, mutationId, issuanceKey, receiptKey, retention } = value;
        if (!siteId(site) || typeof mutationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)
            || !digest(issuanceKey) || !digest(receiptKey) || !validOwnership(evidence) || evidence.energySiteId !== site)
            throw Error("OWNERSHIP_INPUT_INVALID");
        const prior = identity(site, expected), file = path.resolve(databasePath);
        const approved = exact === undefined ? undefined : structuredClone(exact);
        if (approved) validateExactOwnershipGeneration(approved, expected.status === "missing" ? null : expected.snapshot.generation);
        if (expected.status === "available" && ((expected.snapshot.version === 3) !== !!retention))
            throw Error("OWNERSHIP_RETENTION_VERSION_CONFLICT");
        if (retention && Object.keys(retention).sort().join() !== "origin,original") throw Error("OWNERSHIP_RETENTION_INVALID");
        const priorHistoryDigest = expected.status === "missing" ? null : expected.snapshot.historyDigest;
        return ownershipDatabaseTransaction(file, site, db => {
        const { current, applications } = state(db, site);
        const applied = applications.find(a => a.mutationId === mutationId);
        let snapshot: OwnershipSnapshot, status: "persisted" | "already-persisted";
        if (approved) {
            if (representationKey(current) !== representationKey(expected)) throw Error("OWNERSHIP_GENERATION_CHANGED");
            if (applied || applications.some(a => a.result.status === "available"
                && a.result.generation === approved.expectedAfter || a.receiptKey === receiptKey))
                throw Error("OWNERSHIP_MUTATION_CONFLICT");
        }
        if (applied) {
            if (applied.issuanceKey !== issuanceKey || applied.receiptKey !== receiptKey
                || applied.priorHistoryDigest !== priorHistoryDigest
                || representationKey(applied.prior) !== representationKey(prior)) throw Error("OWNERSHIP_MUTATION_CONFLICT");
            if (current.status !== "available" || representationKey(applied.result) !== representationKey(identity(site, current)))
                throw Error("OWNERSHIP_GENERATION_CHANGED");
            if (representationKey(evidence) !== representationKey(current.snapshot.evidence)) throw Error("OWNERSHIP_MUTATION_CONFLICT");
            if (!!retention !== (current.snapshot.version === 3)
                || retention && current.snapshot.version === 3
                    && (hash(retention.original) !== hash(current.snapshot.lifecycle.original)
                        || hash(retention.origin) !== hash(current.snapshot.lifecycle.origin)))
                throw Error("OWNERSHIP_MUTATION_CONFLICT");
            snapshot = current.snapshot; status = "already-persisted";
        } else {
            if (applications.some(a => a.issuanceKey === issuanceKey || retention && a.receiptKey === receiptKey))
                throw Error("OWNERSHIP_MUTATION_CONFLICT");
            if (representationKey(current) !== representationKey(expected)) throw Error("OWNERSHIP_GENERATION_CHANGED");
            const generation = approved ? approved.expectedAfter : randomUUID();
            let lifecycle: RetainedOriginal | undefined;
            if (retention) {
                lifecycle = { version: 1, original: retention.original, origin: retention.origin,
                    originalFingerprint: hash(retention.original.tariff), energySiteId: site, timeZone: evidence.timeZone,
                    restorationObligation: "required", currentGeneration: generation,
                    latestReadback: { mutationId, receiptKey, fingerprint: evidence.readbackFingerprint } };
                if (!validRetainedOriginal(lifecycle)
                    || expected.status === "available" && expected.snapshot.version === 3
                        && retainedOriginKey(lifecycle) !== retainedOriginKey(expected.snapshot.lifecycle))
                    throw Error("OWNERSHIP_RETENTION_INVALID");
            }
            const checksum = lifecycle ? hash({ version: 3, generation, evidence, lifecycle }) : hash({ generation, evidence });
            const result: Identity = { status: "available", site, version: lifecycle ? 2 : 1, generation,
                checksum, evidenceKey: hash(evidence), ...(lifecycle ? { lifecycleKey: hash(lifecycle) } : {}) };
            const bound = { site, mutationId, issuanceKey, receiptKey, prior, priorHistoryDigest, result,
                ...(lifecycle ? { lifecycle } : {}) };
            const application: Application = { ...bound, checksum: hash(bound) };
            const common = { generation, evidence, checksum, historyDigest: historyDigest(site, [...applications, application]) };
            snapshot = lifecycle ? { ...common, version: 3, lifecycle } : { ...common, version: 2 };
            if (!validSnapshot(snapshot, site)) throw Error("OWNERSHIP_RETENTION_INVALID");
            writeOwnershipPair(db, site, mutationId, issuanceKey, snapshot, application);
            status = "persisted";
        }
        const intended = { site, mutationId, issuanceKey, receiptKey, prior, priorHistoryDigest,
            result: identity(site, { status: "available", snapshot }),
            ...(snapshot.version === 3 ? { lifecycle: snapshot.lifecycle } : {}) };
        if (snapshot.version === 3) validateRetentionJournal(file, snapshot.lifecycle,
            status === "persisted" ? [...applications, { ...intended, checksum: hash(intended) }] : applications);
        const intendedApplication = { ...intended, checksum: hash(intended) };
        verifyIntendedPair(db, snapshot, intendedApplication);
        verifyHistoryAppend(db, site, applications, intendedApplication, snapshot, status === "persisted");
        return { status, snapshot: structuredClone(snapshot) };
        });
    } catch (error) { return ownershipTransactionFailure(error, false); }
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
