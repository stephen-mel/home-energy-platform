import "server-only";
import type { Site } from "./types";
import { getRecordedKrakenStateForInspection } from "./kraken-refresh";
import { getSiteTeslaObservation, teslaObservationConfigurationDiagnostic } from "./tesla-observation";
import { inspectSmartTariff, formatSmartInspection, validateTeslaInspectionEvidence } from "../tesla-tariff/smart-inspection";

/** Explicit one-shot server-only entry point. Not a Server Action or route.
 * Uses existing read clients/cache; Kraken may record observations and Tesla may
 * rotate read credentials. Never calls an executor, ownership store or journal. */
export async function inspectSmartCharge(site: Site) {
    const teslaConfigurationDiagnostic = teslaObservationConfigurationDiagnostic(site);
    const [krakenResult, teslaResult] = await Promise.all([
        site.integrations.kraken.enabled ? getRecordedKrakenStateForInspection(site.id,
            site.integrations.kraken.importTariffIdentity, site.integrations.kraken.exportTariffIdentity)
            : Promise.resolve({ state: null, acquisition: { attempted: false, freshEvidenceObtained: false,
                staleFallbackUsed: false, code: "KRAKEN_DISABLED" } }),
        teslaConfigurationDiagnostic ? Promise.resolve({ observation: null, acquisition: { attempted: false,
            freshEvidenceObtained: false, staleFallbackUsed: false, code: teslaConfigurationDiagnostic } })
            : getSiteTeslaObservation(site).then(observation => {
                const validated = validateTeslaInspectionEvidence(observation);
                return validated ? { observation: validated, acquisition: { attempted: true,
                    freshEvidenceObtained: true, staleFallbackUsed: false, code: null } }
                    : { observation: null, acquisition: { attempted: true, freshEvidenceObtained: false,
                        staleFallbackUsed: false, code: "TESLA_RESPONSE_INVALID" } };
            }, error => {
            const message = error instanceof Error ? error.message : "";
            const allowed = new Set(["TESLA_REFRESH_UNAVAILABLE", "TESLA_AUTH_UNAVAILABLE",
                "TESLA_READ_UNAVAILABLE", "TESLA_RESPONSE_INVALID", "TESLA_SITE_MISMATCH",
                "TESLA_DISABLED", "TESLA_SITE_NOT_CONFIGURED"]);
            return { observation: null, acquisition: { attempted: true, freshEvidenceObtained: false,
                staleFallbackUsed: false, code: allowed.has(message) ? message : "TESLA_READ_UNAVAILABLE" } };
            }),
    ]);
    const report = inspectSmartTariff({ site, kraken: krakenResult.state, observation: teslaResult.observation,
        now: new Date().toISOString(), acquisitionDiagnostics: {
            kraken: krakenResult.acquisition, tesla: teslaResult.acquisition } });
    return { report, text: formatSmartInspection(report) };
}
