import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { updateScheduleObservation, type ScheduleObservation, type ScheduleRead, type ScheduleRevision } from "./schedule-observation";

export type ScheduleScope = { siteId: string; accountRef: string };
type Revision = { before: ScheduleObservation; after: ScheduleObservation; change: ScheduleRevision; emptiedVehicles: string[] };
type Ledger = { version: 1; latest: ScheduleObservation; revisions: Revision[] };
export type ScheduleStoreRead =
    | { status: "available"; origin: "disk"; lastKnown: true; ledger: Ledger }
    | { status: "missing" | "invalid" | "unavailable" };
export type ScheduleStoreWrite =
    | { status: "persisted"; change: "initial" | "unchanged" | "changed"; ledger: Ledger }
    | { status: "already-recorded"; ledger: Ledger }
    | { status: "rejected"; code: string }
    | { status: "busy" | "invalid" | "store-failed" | "indeterminate" };
export const SCHEDULE_HISTORY_LIMIT = 100;
export const SCHEDULE_SCOPE_BYTES = 1024 * 1024;
export const SCHEDULE_TOTAL_BYTES = 8 * 1024 * 1024;
const DDL = "CREATE TABLE scopes(site TEXT NOT NULL, account TEXT NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(site,account)) STRICT";
const encode = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(v);
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function frozen<T>(v: T): T {
    if (v && typeof v === "object") { Object.values(v).forEach(frozen); Object.freeze(v); }
    return v;
}
export function scheduleScopeId(scope: ScheduleScope): string {
    const site = scope && Object.getOwnPropertyDescriptor(scope, "siteId");
    const account = scope && Object.getOwnPropertyDescriptor(scope, "accountRef");
    if (!site || !("value" in site) || !account || !("value" in account)
        || typeof site.value !== "string" || !site.value.trim() || site.value.length > 256
        || typeof account.value !== "string" || !account.value.trim() || account.value.length > 256) throw Error("INVALID_SCOPE");
    return JSON.stringify([site.value, account.value]);
}
function capturedScope(scopeId: string): ScheduleScope {
    const [siteId, accountRef] = JSON.parse(scopeId);
    return { siteId, accountRef };
}
function fromObservation(o: ScheduleObservation): ScheduleRead {
    return { scopeId: o.scopeId, startedAt: o.startedAt, retrievedAt: o.retrievedAt,
        status: "complete", provenance: o.provenance,
        vehicles: o.vehicles.map(v => ({ id: v.id, name: v.name, plannedDispatches: v.sessions.map(s => ({
            start: s.start, end: s.end, type: s.type, energyAddedKwh: s.energyAddedKwh })) })) };
}
function validObservation(o: ScheduleObservation, scopeId: string) {
    const result = updateScheduleObservation(null, fromObservation(o));
    if (o.scopeId !== scopeId || result.status !== "initial" || encode(o) !== encode(result.current)) throw Error("INVALID_STATE");
}
function revision(before: ScheduleObservation, after: ScheduleObservation): Revision {
    const result = updateScheduleObservation(before, fromObservation(after));
    if (result.status !== "changed" || !result.revision) throw Error("INVALID_STATE");
    return { before, after, change: result.revision, emptiedVehicles: after.vehicles.filter(v => !v.sessions.length
        && before.vehicles.some(p => p.id === v.id && p.sessions.length > 0)).map(v => v.id) };
}
function unchangedAdvance(before: ScheduleObservation, after: ScheduleObservation) {
    return encode(before) === encode(after) || updateScheduleObservation(before, fromObservation(after)).status === "unchanged";
}
function validate(ledger: Ledger, scopeId: string): Ledger {
    if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.revisions) || ledger.revisions.length > SCHEDULE_HISTORY_LIMIT
        || Object.keys(ledger).sort().join() !== "latest,revisions,version") throw Error("INVALID_STATE");
    validObservation(ledger.latest, scopeId);
    let previous: ScheduleObservation | null = null;
    for (const entry of ledger.revisions) {
        validObservation(entry.before, scopeId); validObservation(entry.after, scopeId);
        if (encode(entry) !== encode(revision(entry.before, entry.after))) throw Error("INVALID_STATE");
        if (previous && !unchangedAdvance(previous, entry.before)) throw Error("INVALID_STATE");
        previous = entry.after;
    }
    if (previous && !unchangedAdvance(previous, ledger.latest)) throw Error("INVALID_STATE");
    return ledger;
}
function schema(db: DatabaseSync, initialise: boolean) {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version === 0 && initialise && !db.prepare("SELECT name FROM sqlite_master").all().length)
        db.exec(`${DDL}; PRAGMA user_version=1`);
    else if (version !== 1) throw Error("INVALID_STATE");
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    if (encode(objects) !== encode([
        { type: "table", name: "scopes", tbl_name: "scopes", sql: DDL },
        { type: "index", name: "sqlite_autoindex_scopes_1", tbl_name: "scopes", sql: null },
    ])) throw Error("INVALID_STATE");
    const indexes = db.prepare("PRAGMA index_list(scopes)").all();
    const keys = db.prepare("PRAGMA index_xinfo(sqlite_autoindex_scopes_1)").all().filter(k => k.key === 1);
    if (indexes.length !== 1 || indexes[0].unique !== 1 || indexes[0].origin !== "pk" || indexes[0].partial !== 0
        || encode(keys.map(k => [k.name, k.coll, k.desc])) !== encode([["site", "BINARY", 0], ["account", "BINARY", 0]])) throw Error("INVALID_STATE");
}
function row(db: DatabaseSync, scope: ScheduleScope): Ledger | null {
    const record = db.prepare("SELECT payload,checksum FROM scopes WHERE site=? AND account=?").get(scope.siteId, scope.accountRef);
    if (!record) return null;
    if (typeof record.payload !== "string" || bytes(record.payload) > SCHEDULE_SCOPE_BYTES || hash(record.payload) !== record.checksum) throw Error("INVALID_STATE");
    try { return validate(JSON.parse(record.payload), scheduleScopeId(scope)); } catch { throw Error("INVALID_STATE"); }
}
function connect(file: string, create: boolean): DatabaseSync {
    if (process.versions.node !== "26.8.2") throw Error("RUNTIME_UNSUPPORTED");
    if (create) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try { const fd = openSync(file, "wx", 0o600); closeSync(fd); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Error("INVALID_STATE");
    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    // mode=rw permits native hot-journal recovery but never creates a missing file.
    const db = new sqlite.DatabaseSync(create ? file : `${pathToFileURL(file).href}?mode=rw`, { timeout: 0 });
    try {
        if (!create) db.exec("PRAGMA query_only=ON"); // Forbid application writes; native recovery remains permitted.
        if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete"
            || db.prepare("PRAGMA page_size").get()?.page_size !== 4096
            || Number(db.prepare("PRAGMA page_count").get()?.page_count) > 4096) throw Error("INVALID_STATE");
        db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=EXTRA; PRAGMA trusted_schema=OFF");
        if (create) {
            db.exec("PRAGMA max_page_count=4096"); // 16 MiB database pages; rollback journal is additional.
            if (Number(db.prepare("PRAGMA page_count").get()?.page_count) > 4096) throw Error("INVALID_STATE");
        }
        return db;
    } catch (e) { db.close(); throw e; }
}
function failure(e: unknown): "busy" | "invalid" | "store-failed" {
    if ((e as { errcode?: number })?.errcode === 5 || (e as { errcode?: number })?.errcode === 6) return "busy";
    return e instanceof Error && e.message === "INVALID_STATE" ? "invalid" : "store-failed";
}
/** Local-only, no ingestion caller. No automatic retries, polling or authority. */
export function scheduleObservationStore(file = join(process.cwd(), ".cache/home-energy-platform/kraken-observations.sqlite")) {
    return {
        read(scope: ScheduleScope): ScheduleStoreRead {
            let db: DatabaseSync | undefined;
            try {
                scope = capturedScope(scheduleScopeId(scope)); db = connect(file, false); db.exec("BEGIN"); schema(db, false);
                const ledger = row(db, scope); db.exec("COMMIT"); db.close(); db = undefined;
                return ledger ? frozen({ status: "available", origin: "disk", lastKnown: true, ledger }) : { status: "missing" };
            } catch (e) {
                return { status: (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : failure(e) === "invalid" ? "invalid" : "unavailable" };
            } finally { try { db?.close(); } catch { /* No success was reported. */ } }
        },
        record(scope: ScheduleScope, supplied: ScheduleRead): ScheduleStoreWrite {
            let db: DatabaseSync | undefined, inTransaction = false, commitAttempted = false;
            try {
                const scopeId = scheduleScopeId(scope);
                scope = capturedScope(scopeId);
                const initial = updateScheduleObservation(null, supplied);
                if (!initial.current || initial.status !== "initial") return { status: "rejected", code: initial.code };
                const observation = initial.current;
                if (observation.scopeId !== scopeId) return { status: "rejected", code: "SCOPE_MISMATCH" };
                db = connect(file, true); db.exec("BEGIN IMMEDIATE"); inTransaction = true; schema(db, true);
                const prior = row(db, scope);
                if (prior && encode(prior.latest) === encode(observation)) {
                    db.exec("ROLLBACK"); inTransaction = false; db.close(); db = undefined;
                    return frozen({ status: "already-recorded", ledger: prior });
                }
                const result = updateScheduleObservation(prior?.latest ?? null, fromObservation(observation));
                if (!result.current || result.status === "unknown") {
                    db.exec("ROLLBACK"); inTransaction = false; db.close(); db = undefined;
                    return { status: "rejected", code: result.code };
                }
                const history = prior?.revisions ?? [];
                if (prior && result.status === "changed") history.push(revision(prior.latest, result.current));
                const ledger: Ledger = { version: 1, latest: result.current, revisions: history.slice(-SCHEDULE_HISTORY_LIMIT) };
                let payload = encode(ledger);
                const others = Number(db.prepare("SELECT coalesce(sum(length(CAST(payload AS BLOB))),0) AS size FROM scopes WHERE NOT(site=? AND account=?)").get(scope.siteId, scope.accountRef)?.size);
                while ((bytes(payload) > SCHEDULE_SCOPE_BYTES || bytes(payload) + others > SCHEDULE_TOTAL_BYTES) && ledger.revisions.length) {
                    ledger.revisions.shift(); payload = encode(ledger);
                }
                if (bytes(payload) > SCHEDULE_SCOPE_BYTES || bytes(payload) + others > SCHEDULE_TOTAL_BYTES) {
                    db.exec("ROLLBACK"); inTransaction = false; db.close(); db = undefined;
                    return { status: "rejected", code: "CAPACITY_EXCEEDED" };
                }
                db.prepare("INSERT INTO scopes(site,account,payload,checksum) VALUES(?,?,?,?) ON CONFLICT(site,account) DO UPDATE SET payload=excluded.payload,checksum=excluded.checksum")
                    .run(scope.siteId, scope.accountRef, payload, hash(payload));
                // Independently reread/validate exact intended state before COMMIT.
                schema(db, false);
                if (encode(row(db, scope)) !== payload) throw Error("INVALID_STATE");
                commitAttempted = true; db.exec("COMMIT"); inTransaction = false;
                db.close(); db = undefined;
                return frozen({ status: "persisted", change: result.status, ledger });
            } catch (e) {
                return { status: commitAttempted ? "indeterminate" : failure(e) };
            } finally {
                if (inTransaction) { try { db?.exec("ROLLBACK"); } catch { /* Retain failure/uncertainty. */ } }
                try { db?.close(); } catch { /* No second attempt. */ }
            }
        },
    };
}
