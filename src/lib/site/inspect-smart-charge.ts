import "server-only";
import type { Site } from "./types";
import { getRecordedKrakenState } from "./kraken-refresh";
import { getSiteTeslaObservation } from "./tesla-observation";
import { inspectSmartTariff, formatSmartInspection } from "../tesla-tariff/smart-inspection";

/** Explicit one-shot server-only entry point. Not a Server Action or route.
 * Uses existing read clients/cache; Kraken may record observations and Tesla may
 * rotate read credentials. Never calls an executor, ownership store or journal. */
export async function inspectSmartCharge(site: Site) {
    const [kraken, observation] = await Promise.all([
        site.integrations.kraken.enabled ? getRecordedKrakenState(site.id,
            site.integrations.kraken.importTariffIdentity, site.integrations.kraken.exportTariffIdentity)
            .catch(() => null) : null,
        getSiteTeslaObservation(site).catch(() => null),
    ]);
    const report = inspectSmartTariff({ site, kraken, observation, now: new Date().toISOString() });
    return { report, text: formatSmartInspection(report) };
}
