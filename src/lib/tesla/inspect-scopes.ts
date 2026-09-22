// An allowlist prevents a malformed claim from reflecting arbitrary token/account
// material as a "scope". Unrecognized values fail closed without echoing them.
const scopes = new Set([
    "openid", "offline_access", "user_data", "vehicle_device_data", "vehicle_location",
    "vehicle_cmds", "vehicle_charging_cmds", "energy_device_data", "energy_cmds",
]);
export type ScopeInspection =
    | { success: true; scopes: string[]; hasEnergyCommands: boolean }
    | { success: false; diagnostic: "TOKEN_UNDECODABLE" | "SCOPES_ABSENT_OR_MALFORMED" };

/** Local inspection only. Does not verify signature, expiry or current Tesla grants.
 * Only scp can reach the result; no other decoded claims are retained or returned.
 */
export function inspectTeslaScopes(accessToken: unknown): ScopeInspection {
    try {
        if (typeof accessToken !== "string" || accessToken.length > 131072) throw new Error();
        const parts = accessToken.split(".");
        if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
        const bytes = Buffer.from(parts[1], "base64url");
        if (bytes.toString("base64url") !== parts[1]) throw new Error();
        const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const claim = payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).scp : undefined;
        const values: unknown = typeof claim === "string" && claim.trim() ? claim.trim().split(/\s+/) : claim;
        if (!Array.isArray(values) || !values.every(v => typeof v === "string" && scopes.has(v)))
            return { success: false, diagnostic: "SCOPES_ABSENT_OR_MALFORMED" };
        const result = [...new Set(values as string[])];
        return { success: true, scopes: result, hasEnergyCommands: result.includes("energy_cmds") };
    } catch {
        return { success: false, diagnostic: "TOKEN_UNDECODABLE" };
    }
}
