import { getSiteState } from "./get-site-state";
import { getSiteTeslaObservation } from "./tesla-observation";
import { reconcileTeslaTariff, unavailableReconciliation } from "../tesla-tariff/reconciliation";
import type { Site } from "./types";

const readFailures = new Set(["TESLA_DISABLED", "TESLA_SITE_NOT_CONFIGURED", "TESLA_SITE_MISMATCH", "TESLA_AUTH_UNAVAILABLE", "TESLA_READ_UNAVAILABLE"]);

/** One request snapshot. Reuses Kraken's existing cache through getSiteState;
 * neither reconciliation nor presentation fetches it again. No background work.
 */
export async function getHomeDashboardState(site: Site) {
    const [state, tesla] = await Promise.all([
        getSiteState(site),
        getSiteTeslaObservation(site).then(data => ({ data, error: null }), error => ({ data: null,
            error: error instanceof Error && readFailures.has(error.message) ? error.message : "TESLA_READ_UNAVAILABLE" })),
    ]);
    const now = new Date().toISOString();
    // Explicit elapsed-time domain; all calendar interpretation remains in the
    // existing London/DST-aware tariff and observed-tariff domain implementations.
    const domain = { start: now, end: new Date(Date.parse(now) + 24 * 3600000).toISOString() };
    const kraken = state.integrations.kraken.data;
    const reconciliation = tesla.error ? unavailableReconciliation(tesla.error, domain)
        : !kraken ? unavailableReconciliation("KRAKEN_UNAVAILABLE", domain)
        : reconcileTeslaTariff({ site, energySiteId: site.integrations.tesla.energySiteId!,
            kraken, observation: tesla.data!, now, comparisonDomain: domain });
    // No synthetic managedImport or previousKraken: retained ownership is absent.
    return { ...state, reconciliation, integrations: { ...state.integrations,
        tesla: { enabled: site.integrations.tesla.enabled, ...tesla } } };
}
