import type { HomeAssistantState } from "../site/home-assistant-state";
import type { Freshness, OpportunityTelemetry, Reading } from "./types";

export type MetricBinding = { assetId: string; entityId: string };
export type PowerBinding = MetricBinding & { multiplier: 1 | -1 };
export type TelemetryBindings = {
    solarKw?: PowerBinding;
    houseLoadKw?: PowerBinding;
    gridImportKw?: PowerBinding;
    batteries?: Array<{ id: string; name: string; socPercent?: MetricBinding; powerToHomeKw?: PowerBinding }>;
};

// Explicit, caller-supplied site bindings: never guess manufacturer/entity names
// or sensor polarity. This reads the existing normalized SOC, not rawValue.
// The current HA snapshot lacks per-reading freshness; unknown is the default.
export function opportunityTelemetryFromHA(
    snapshot: HomeAssistantState | null,
    bindings: TelemetryBindings,
    evidence: { freshness: Freshness; observedAt: string | null } = { freshness: "unknown", observedAt: null },
): OpportunityTelemetry {
    const reading = (binding: MetricBinding, power: boolean): Reading => {
        const metric = snapshot?.assets.find(a => a.id === binding.assetId)?.metrics.find(m => m.entityId === binding.entityId);
        const scale = power ? metric?.unit === "kW" ? 1 : metric?.unit === "W" ? 0.001 : null : metric?.unit === "%" ? 1 : null;
        const value = metric?.value;
        return { value: scale !== null && typeof value === "number" && Number.isFinite(value)
            ? value * scale * (power ? (binding as PowerBinding).multiplier : 1) : null,
        ...evidence, source: `home-assistant:${binding.assetId}:${binding.entityId}` };
    };
    return {
        ...(bindings.solarKw ? { solarKw: reading(bindings.solarKw, true) } : {}),
        ...(bindings.houseLoadKw ? { houseLoadKw: reading(bindings.houseLoadKw, true) } : {}),
        ...(bindings.gridImportKw ? { gridImportKw: reading(bindings.gridImportKw, true) } : {}),
        batteries: (bindings.batteries ?? []).map(b => ({ id: b.id, name: b.name,
            ...(b.socPercent ? { socPercent: reading(b.socPercent, false) } : {}),
            ...(b.powerToHomeKw ? { powerToHomeKw: reading(b.powerToHomeKw, true) } : {}),
        })),
    };
}
