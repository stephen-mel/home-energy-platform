import { applyHomeAssistantMetricUpdates } from "../site/home-assistant-metrics";
import type { HomeAssistantState } from "../site/home-assistant-state";
import type { Site } from "../site/types";
import type { PriceSignal } from "../tariff/types";
import type { LiveStatus } from "../home-assistant/browser-stream";
import { opportunityTelemetryFromHA } from "./home-assistant-input";
import { getOpportunities } from "./engine";

// The same normalized HA snapshot feeds cards and economic observations. No I/O.
export function liveSiteOpportunities(input: {
    initial: HomeAssistantState;
    updates: Record<string, number | null>;
    status: LiveStatus;
    haEnabled: boolean;
    signal: PriceSignal;
    now: string;
    receivedAt: string | null;
    configuration?: Site["opportunities"];
}) {
    const snapshot = applyHomeAssistantMetricUpdates(input.initial, input.updates);
    const completeSnapshot = snapshot.assets.flatMap(a => a.metrics).every(m => Object.hasOwn(input.updates, m.entityId));
    // A successful WS resync precedes 'live'. Initial REST values have no source
    // measurement timestamp, so remain unknown; disconnected values are last-known.
    const freshness = input.status === "live" && completeSnapshot && input.receivedAt ? "fresh"
        : input.status === "disconnected" || input.status === "unavailable" ? "stale" : "unknown";
    const telemetry = input.haEnabled && input.configuration ? opportunityTelemetryFromHA(snapshot, input.configuration.telemetry,
        { freshness, observedAt: input.receivedAt }) : undefined;
    return { snapshot, result: getOpportunities({ signal: input.signal, now: input.now, telemetry,
        exportContext: input.configuration?.exportContext }) };
}
