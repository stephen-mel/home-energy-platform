import { readFile } from "fs/promises";
import path from "path";

type TeslaTokens = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    created_at: number;
};

async function getTeslaTokens(): Promise<TeslaTokens> {
    const tokenFile = path.join(
        process.cwd(),
        ".tesla-tokens.json"
    );

    const contents = await readFile(tokenFile, "utf8");
    return JSON.parse(contents) as TeslaTokens;
}

export async function getTeslaProducts() {
    const tokens = await getTeslaTokens();

    const response = await fetch(
        "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/products",
        {
            headers: {
                Authorization: `Bearer ${tokens.access_token}`,
            },
            cache: "no-store",
        }
    );

    if (!response.ok) {
        const errorText = await response.text();

        console.error(
            "Tesla Fleet API products request failed:",
            response.status,
            errorText
        );

        throw new Error(
            `Tesla Fleet API HTTP error ${response.status}`
        );
    }

    return response.json();
}

// Interactive Home render budget, independent of evidence/approval freshness TTLs.
// Includes token-file read, response headers and complete JSON body consumption.
export const TESLA_SITE_INFO_TIMEOUT_MS = 5_000;

export async function getTeslaSiteInfo(energySiteId: number) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Tesla site info read timed out"));
        }, TESLA_SITE_INFO_TIMEOUT_MS);
    });
    try {
        const operation = (async () => {
            const tokens = await getTeslaTokens();
            // A slow local read must not start a request after its deadline.
            controller.signal.throwIfAborted();
            const response = await fetch(
                `https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/${energySiteId}/site_info`,
                {
                    headers: { Authorization: `Bearer ${tokens.access_token}` },
                    cache: "no-store",
                    signal: controller.signal,
                }
            );
            if (!response.ok) {
                // Release the unread error body before clearing the deadline.
                controller.abort();
                // Never log or propagate raw upstream bodies.
                throw new Error(`Tesla Fleet API site info HTTP error ${response.status}`);
            }
            return await response.json();
        })();
        // Abort the actual transport AND bound the caller even if a transport
        // wrapper fails to reject promptly on abort. No retry or cached fallback.
        return await Promise.race([operation, deadline]);
    } finally {
        clearTimeout(timer);
    }
}
