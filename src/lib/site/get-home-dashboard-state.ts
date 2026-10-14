import { getSiteState } from "./get-site-state";
import { getSiteTeslaObservation } from "./tesla-observation";
import { reconcileTeslaTariff, unavailableReconciliation } from "../tesla-tariff/reconciliation";
import { ownershipStore, type OwnershipRead } from "../tesla-tariff/ownership-store";
import type { Site } from "./types";

const readFailures = new Set(["TESLA_DISABLED", "TESLA_SITE_NOT_CONFIGURED", "TESLA_SITE_MISMATCH", "TESLA_AUTH_UNAVAILABLE", "TESLA_READ_UNAVAILABLE"]);

/** One request snapshot. Reuses Kraken's existing cache through getSiteState;
 * neither reconciliation nor presentation fetches it again. No background work.
 */
export async function getHomeDashboardState(site: Site, historicalPeriod?: { start: string; end: string }) {
    const financialEnd = Math.floor(Date.now() / (30 * 60 * 1000)) * 30 * 60 * 1000;
    const requestedHistoricalPeriod = historicalPeriod ?? {
        start: new Date(financialEnd - 24 * 60 * 60 * 1000).toISOString(), end: new Date(financialEnd).toISOString(),
    };
    const energySiteId = site.integrations.tesla.energySiteId;
    const ownershipRead: Promise<OwnershipRead> = energySiteId
        ? ownershipStore().read(energySiteId).catch(() => ({ status: "unavailable", code: "OWNERSHIP_STORE_UNAVAILABLE" }))
        : Promise.resolve({ status: "missing" });
    const [state, tesla, ownership] = await Promise.all([
        getSiteState(site, requestedHistoricalPeriod),
        getSiteTeslaObservation(site).then(data => ({ data, error: null }), error => ({ data: null,
            error: error instanceof Error && readFailures.has(error.message) ? error.message : "TESLA_READ_UNAVAILABLE" })),
        ownershipRead,
    ]);
    const now = new Date().toISOString();
    // Explicit elapsed-time domain; all calendar interpretation remains in the
    // existing London/DST-aware tariff and observed-tariff domain implementations.
    const domain = { start: now, end: new Date(Date.parse(now) + 24 * 3600000).toISOString() };
    const kraken = state.integrations.kraken.data;
    const reconciliation = tesla.error ? unavailableReconciliation(tesla.error, domain)
        : !kraken ? unavailableReconciliation("KRAKEN_UNAVAILABLE", domain)
        : ownership.status === "invalid" || ownership.status === "unavailable"
            ? unavailableReconciliation(ownership.code ?? "OWNERSHIP_STORE_UNAVAILABLE", domain)
        : reconcileTeslaTariff({ site, energySiteId: site.integrations.tesla.energySiteId!,
            kraken, observation: tesla.data!, now, comparisonDomain: domain,
            managedImport: ownership.status === "available" ? ownership.snapshot.evidence : undefined });
    // Only durable, validated ownership may authorise update/restoration scope.
    // Missing remains distinct from an unreadable or invalid ledger.
    return { ...state, financialPeriod: requestedHistoricalPeriod, reconciliation, integrations: { ...state.integrations,
        tesla: { enabled: site.integrations.tesla.enabled, ...tesla } } };
}
