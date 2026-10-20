import { getTeslaSiteInfo } from "../tesla/client";
import { captureObservedTariff } from "../tesla-tariff/observed-tariff";
import type { Site } from "./types";

export function teslaObservationConfigurationDiagnostic(site: Site): "TESLA_DISABLED" | "TESLA_SITE_NOT_CONFIGURED" | null {
    const id = site.integrations.tesla.energySiteId;
    if (!site.integrations.tesla.enabled) return "TESLA_DISABLED";
    return !id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) ? "TESLA_SITE_NOT_CONFIGURED" : null;
}

/** Existing authenticated read client; no discovery or command execution. */
export async function getSiteTeslaObservation(site: Site) {
    const id = site.integrations.tesla.energySiteId;
    const configurationDiagnostic = teslaObservationConfigurationDiagnostic(site);
    if (configurationDiagnostic) throw new Error(configurationDiagnostic);
    let raw;
    try { raw = await getTeslaSiteInfo(Number(id)); }
    catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "TESLA_REFRESH_UNAVAILABLE" || message === "TESLA_RESPONSE_INVALID") throw new Error(message);
        throw new Error(/^Tesla Fleet API site info HTTP error (401|403)$/.test(message)
            ? "TESLA_AUTH_UNAVAILABLE" : "TESLA_READ_UNAVAILABLE");
    }
    // Capture provenance is bound to the configured GET target. If Tesla also
    // returns a site identity, it must agree; never pick the first account site.
    if (raw?.response?.energy_site_id !== undefined && String(raw.response.energy_site_id) !== id)
        throw new Error("TESLA_SITE_MISMATCH");
    return captureObservedTariff(raw, id!, new Date().toISOString());
}
