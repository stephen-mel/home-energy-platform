import { getTeslaSiteInfo } from "../tesla/client";
import { captureObservedTariff } from "../tesla-tariff/observed-tariff";
import type { Site } from "./types";

/** Existing authenticated read client; no discovery or command execution. */
export async function getSiteTeslaObservation(site: Site) {
    const id = site.integrations.tesla.energySiteId;
    if (!site.integrations.tesla.enabled) throw new Error("TESLA_DISABLED");
    if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("TESLA_SITE_NOT_CONFIGURED");
    let raw;
    try { raw = await getTeslaSiteInfo(Number(id)); }
    catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new Error(/^Tesla Fleet API site info HTTP error (401|403)$/.test(message)
            ? "TESLA_AUTH_UNAVAILABLE" : "TESLA_READ_UNAVAILABLE");
    }
    // Capture provenance is bound to the configured GET target. If Tesla also
    // returns a site identity, it must agree; never pick the first account site.
    if (raw?.response?.energy_site_id !== undefined && String(raw.response.energy_site_id) !== id)
        throw new Error("TESLA_SITE_MISMATCH");
    return captureObservedTariff(raw, id, new Date().toISOString());
}
