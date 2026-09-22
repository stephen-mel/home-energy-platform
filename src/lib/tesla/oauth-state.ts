import { randomBytes, createHash } from "node:crypto";

export const TESLA_STATE_COOKIE = "hep-tesla-oauth-binding";
const TTL_MS = 5 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Shared by route modules/HMR on this local single-process prototype. Restart
// invalidates all pending flows. No tokens or raw state are persisted.
const root = globalThis as typeof globalThis & { hepTeslaOAuthPending?: Map<string, { binding: string; expires: number }> };
const pending = root.hepTeslaOAuthPending ??= new Map();
export function issueTeslaOAuthState(now = Date.now()) {
    for (const [key, item] of pending) if (item.expires <= now) pending.delete(key);
    while (pending.size >= 128) pending.delete(pending.keys().next().value!);
    const state = randomBytes(32).toString("hex"), binding = randomBytes(32).toString("hex");
    pending.set(digest(state), { binding: digest(binding), expires: now + TTL_MS });
    return { state, binding, maxAge: TTL_MS / 1000 };
}
export function consumeTeslaOAuthState(state: string | null | undefined, binding: string | null | undefined, now = Date.now()) {
    if (!state || !binding || !/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(binding)) return false;
    const key = digest(state), item = pending.get(key);
    if (!item || item.binding !== digest(binding)) return false;
    pending.delete(key); // Consume synchronously before any async exchange, including errors.
    return Number.isFinite(now) && item.expires > now;
}
