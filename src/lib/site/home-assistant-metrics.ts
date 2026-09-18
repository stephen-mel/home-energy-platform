import type { HomeEnergyAssetConfig } from "./config";
import type { HomeAssistantState } from "./home-assistant-state";

type MetricConfig = HomeEnergyAssetConfig["metrics"][number];

// Shared HA asset normalization boundary for REST snapshots and raw SSE updates.
export function normalizeHomeAssistantMetric(metric: MetricConfig, raw: unknown) {
    const parsed = typeof raw === "number" ? raw
        : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    const rawValue = Number.isFinite(parsed) ? parsed : null;
    // Powerwall's local SOC includes a 5% bottom buffer. This is unrelated to
    // user-configured Backup Reserve; reserve must not be deducted here.
    const value = rawValue !== null && metric.normalization === "powerwall-display-soc"
        ? Math.min(100, Math.max(0, (rawValue - 5) / 0.95))
        : rawValue;
    return { ...metric, rawValue, value };
}

export function applyHomeAssistantMetricUpdates(
    initial: HomeAssistantState, rawUpdates: Record<string, number | null>,
): HomeAssistantState {
    return { assets: initial.assets.map(asset => ({
        ...asset,
        metrics: asset.metrics.map(metric => Object.hasOwn(rawUpdates, metric.entityId)
            ? normalizeHomeAssistantMetric(metric, rawUpdates[metric.entityId]) : metric),
    })) };
}
