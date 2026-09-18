import type { Site } from "./types";
import {
    getKrakenState,
    type KrakenState,
} from "./kraken-state";

export type IntegrationState<T> = {
    enabled: boolean;
    data: T | null;
    error: string | null;
};

export type SiteState = {
    site: Site;
    updatedAt: string;

    integrations: {
        kraken: IntegrationState<KrakenState>;
        homeAssistant: IntegrationState<unknown>;
        tesla: IntegrationState<unknown>;
    };
};

export async function getSiteState(
    site: Site
): Promise<SiteState> {

    let krakenData: KrakenState | null = null;
    let krakenError: string | null = null;

    if (site.integrations.kraken.enabled) {
        try {
            krakenData = await getKrakenState();
        } catch (error) {
            console.error("Kraken site state failed:", error);

            krakenError =
                error instanceof Error
                    ? error.message
                    : "Kraken is currently unavailable";
        }
    }
    return {
        site,
        updatedAt: new Date().toISOString(),

        integrations: {
            kraken: {
                enabled: site.integrations.kraken.enabled,
                data: krakenData,
                error: krakenError,
            },

            homeAssistant: {
                enabled: site.integrations.homeAssistant.enabled,
                data: null,
                error: null,
            },

            tesla: {
                enabled: site.integrations.tesla.enabled,
                data: null,
                error: null,
            },
        },
    };
}