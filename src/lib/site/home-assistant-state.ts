import { getHomeAssistantState } from "../home-assistant/client";
import type { HomeEnergyAssetConfig, SiteIntegrationConfig } from "./config";

export type HomeAssistantState = {
    assets: Array<{
        id: string;
        name: string;
        metrics: Array<HomeEnergyAssetConfig["metrics"][number] & {
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
                const raw: unknown = entity.state;
                const value = typeof raw === "string" && raw.trim() !== ""
                    ? Number(raw) : NaN;
                return { ...metric, value: Number.isFinite(value) ? value : null };
            } catch {
                // An individual missing or unreachable sensor must not hide healthy readings.
                return { ...metric, value: null };
            }
        })),
    })));

    return { assets };
}
