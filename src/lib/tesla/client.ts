import { readTeslaTokens, refreshTeslaTokens, tokenNeedsRefresh } from "./tokens";

// Total interactive read budget: token loading, refresh, retry and JSON body.
export const TESLA_SITE_INFO_TIMEOUT_MS = 5_000;
const ROOT = "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1";

/** Private GET-only transport. No command/write URL or body can be supplied. */
async function authenticatedRead(resource: "products" | `energy_sites/${number}/site_info`) {
    const controller = new AbortController();
    let activeRequest: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort(); activeRequest?.abort();
            reject(new Error("TESLA_READ_TIMEOUT"));
        }, TESLA_SITE_INFO_TIMEOUT_MS);
    });
    try {
        return await Promise.race([(async () => {
            let tokens = await readTeslaTokens();
            let refreshed = false;
            if (tokenNeedsRefresh(tokens)) {
                controller.signal.throwIfAborted();
                tokens = await refreshTeslaTokens(tokens); refreshed = true;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                controller.signal.throwIfAborted();
                activeRequest = new AbortController();
                const response = await fetch(`${ROOT}/${resource}`, {
                    method: "GET", redirect: "error", cache: "no-store", signal: activeRequest.signal,
                    headers: { Authorization: `Bearer ${tokens.access_token}` },
                });
                controller.signal.throwIfAborted();
                if (!response.ok) {
                    // Clean unread bodies before refreshing or clearing timers.
                    activeRequest.abort();
                    if (response.status === 401 && !refreshed && attempt === 0) {
                        tokens = await refreshTeslaTokens(tokens); refreshed = true;
                        continue;
                    }
                    throw new Error(`Tesla Fleet API ${resource === "products" ? "products" : "site info"} HTTP error ${response.status}`);
                }
                return await response.json();
            }
            throw new Error("TESLA_READ_UNAVAILABLE");
        })(), deadline]);
    } catch (error) {
        controller.abort(); activeRequest?.abort();
        // Never propagate token-file, transport, JSON or OAuth response contents.
        const message = error instanceof Error ? error.message : "";
        if (/^Tesla Fleet API (products|site info) HTTP error \d{3}$/.test(message)) throw new Error(message);
        throw new Error("TESLA_READ_UNAVAILABLE");
    } finally {
        clearTimeout(timer);
    }
}

export function getTeslaProducts() { return authenticatedRead("products"); }
export function getTeslaSiteInfo(energySiteId: number) {
    return authenticatedRead(`energy_sites/${energySiteId}/site_info`);
}
