import { getHomeAssistantSiteState, type HomeAssistantState } from "./home-assistant-state";
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
        homeAssistant: IntegrationState<HomeAssistantState>;
        tesla: IntegrationState<unknown>;
    };
};

export async function getSiteState(
    site: Site
): Promise<SiteState> {

    const [kraken, homeAssistant] = await Promise.all([
        loadIntegration(site.integrations.kraken.enabled, getKrakenState),
        loadIntegration(site.integrations.homeAssistant.enabled, () =>
            getHomeAssistantSiteState(site.integrations.homeAssistant)),
    ]);
    return {
        site,
        updatedAt: new Date().toISOString(),

        integrations: {
            kraken,
            homeAssistant,

            tesla: {
                enabled: site.integrations.tesla.enabled,
                data: null,
                error: null,
            },
        },
    };
}
async function loadIntegration<T>(
    enabled: boolean,
    load: () => Promise<T>
): Promise<IntegrationState<T>> {
    if (!enabled) return { enabled, data: null, error: null };
    try {
        return { enabled, data: await load(), error: null };
    } catch (error) {
        console.error("Site integration failed:", error);
        return {
            enabled,
            data: null,
            error: error instanceof Error ? error.message : "Integration is currently unavailable",
        };
    }
}
