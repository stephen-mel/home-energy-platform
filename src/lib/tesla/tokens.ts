import { readFile, writeFile, rename, unlink } from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

export type TeslaTokens = {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    created_at?: number;
    generation?: string;
};
export const TESLA_REFRESH_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 5_000;
const file = () => path.join(process.cwd(), ".tesla-tokens.json");
const credential = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export async function readTeslaTokens(): Promise<TeslaTokens> {
    try {
        const value = JSON.parse(await readFile(file(), "utf8"));
        if (!value || !credential(value.access_token)) throw new Error();
        return value;
    } catch { throw new Error("TESLA_TOKEN_UNAVAILABLE"); }
}
export function tokenNeedsRefresh(token: TeslaTokens): boolean {
    return typeof token.created_at === "number" && Number.isFinite(token.created_at)
        && typeof token.expires_in === "number" && Number.isFinite(token.expires_in) && token.expires_in > 0
        && Date.now() >= token.created_at + token.expires_in * 1000 - TESLA_REFRESH_MARGIN_MS;
}

// Shared by refresh and OAuth reconnect. The queue follows the actual filesystem
// operation, never a caller's timeout race; a pending rename retains ownership.
// Next server entry points can load separate copies of this module. Keep the
// coordinator on the process global so callback and dashboard still serialize.
const processState = globalThis as typeof globalThis & {
    __hepTeslaCredentials?: { commits: Promise<void>; refreshing: Promise<TeslaTokens> | null };
};
const coordination = processState.__hepTeslaCredentials ??= { commits: Promise.resolve(), refreshing: null };
const sameGeneration = (a: TeslaTokens, b: TeslaTokens) =>
    a.generation === b.generation && a.access_token === b.access_token
    && a.refresh_token === b.refresh_token && a.created_at === b.created_at && a.expires_in === b.expires_in;

export function commitTeslaTokens(next: TeslaTokens, expected?: TeslaTokens, signal?: AbortSignal): Promise<TeslaTokens> {
    const commit = coordination.commits.then(async () => {
        if (!credential(next.access_token) || !credential(next.refresh_token)
            || !Number.isFinite(next.created_at) || !Number.isFinite(next.expires_in) || next.expires_in! <= 0)
            throw new Error("TESLA_CREDENTIAL_COMMIT_FAILED");
        const replacement: TeslaTokens = { access_token: next.access_token, refresh_token: next.refresh_token,
            created_at: next.created_at, expires_in: next.expires_in, generation: randomUUID() };
        const temporary = `${file()}.${randomUUID()}.tmp`;
        try {
            signal?.throwIfAborted();
            await writeFile(temporary, JSON.stringify(replacement), { mode: 0o600, flag: "wx" });
            // Check inside serialization immediately before the atomic commit.
            // Legacy records without a generation are compared by their contents.
            if (expected) {
                const latest = await readTeslaTokens();
                if (!sameGeneration(latest, expected)) return latest;
            }
            signal?.throwIfAborted();
            await rename(temporary, file());
            return replacement;
        } finally { await unlink(temporary).catch(() => {}); }
    }).catch(() => { throw new Error("TESLA_CREDENTIAL_COMMIT_FAILED"); });
    coordination.commits = commit.then(() => {}, () => {});
    return commit;
}

/** Single process/single token file. A refresh belongs to the shared token store,
 * not one caller: callers retain their own read deadline while waiting for it.
 */
export function refreshTeslaTokens(previous: TeslaTokens): Promise<TeslaTokens> {
    if (coordination.refreshing) return coordination.refreshing;
    coordination.refreshing = exchange(previous).finally(() => { coordination.refreshing = null; });
    return coordination.refreshing;
}
async function exchange(previous: TeslaTokens): Promise<TeslaTokens> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("TESLA_REFRESH_UNAVAILABLE")); }, REFRESH_TIMEOUT_MS);
    });
    try {
        return await Promise.race([(async () => {
            const current = await readTeslaTokens();
            // A concurrent read may already have rotated the rejected token.
            if (current.access_token !== previous.access_token && !tokenNeedsRefresh(current)) return current;
            const startedAt = Date.now();
            if (!credential(current.refresh_token) || !credential(process.env.TESLA_CLIENT_ID)) throw new Error();
            controller.signal.throwIfAborted();
            const response = await fetch("https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token", {
                method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ grant_type: "refresh_token", client_id: process.env.TESLA_CLIENT_ID!, refresh_token: current.refresh_token }),
            });
            if (!response.ok) { controller.abort(); throw new Error(); }
            const value = await response.json();
            controller.signal.throwIfAborted();
            if (!value || !credential(value.access_token) || typeof value.expires_in !== "number"
                || !Number.isFinite(value.expires_in) || value.expires_in <= 0
                || (value.token_type !== undefined && value.token_type.toLowerCase?.() !== "bearer")
                || !credential(value.refresh_token)) throw new Error();
            return await commitTeslaTokens({
                access_token: value.access_token, refresh_token: value.refresh_token,
                expires_in: value.expires_in, created_at: startedAt,
            }, current, controller.signal);
        })(), deadline]);
    } catch { controller.abort(); throw new Error("TESLA_REFRESH_UNAVAILABLE"); }
    finally { clearTimeout(timer); }
}
