import { normalizeHomeAssistantMetric } from "./home-assistant-metrics";
import { getHomeAssistantState } from "../home-assistant/client";
import type { HomeEnergyAssetConfig, SiteIntegrationConfig } from "./config";

export type HomeAssistantState = {
    assets: Array<{
        id: string;
        name: string;
        metrics: Array<HomeEnergyAssetConfig["metrics"][number] & {
            rawValue: number | null;
            value: number | null;
        }>;
    }>;
};

export async function getHomeAssistantSiteState(
    config: SiteIntegrationConfig["homeAssistant"]
): Promise<HomeAssistantState> {
    if (!config.enabled) return { assets: [] };

    const assets = await Promise.all((config.assets ?? []).map(async (asset) => ({
        id: asset.id,
        name: asset.name,
        metrics: await Promise.all(asset.metrics.map(async (metric) => {
            try {
                const entity = await getHomeAssistantState(metric.entityId);
                return normalizeHomeAssistantMetric(metric, entity.state);
            } catch {
                // An individual missing or unreachable sensor must not hide healthy readings.
                return normalizeHomeAssistantMetric(metric, null);
            }
        })),
    })));

    return { assets };
}
