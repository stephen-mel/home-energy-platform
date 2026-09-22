"use client";

import { useEffect, useState, type ReactNode } from "react";
import { watchHomeAssistant, type LiveStatus } from "../lib/home-assistant/browser-stream";
import type { HomeAssistantState } from "../lib/site/home-assistant-state";
import type { SitePricePlan } from "../lib/site/get-site-price-signal";
import type { Site } from "../lib/site/types";
import { liveSiteOpportunities } from "../lib/opportunity/live-site-input";
import HomeEnergyTelemetry from "./HomeEnergyTelemetry";
import EnergyOpportunities from "./EnergyOpportunities";

// One existing stream supplies both the telemetry cards and economic observations.
export default function LiveHomeEnergy({ initial, plan, haEnabled, configuration, children }: {
    initial: HomeAssistantState;
    plan: SitePricePlan;
    haEnabled: boolean;
    configuration?: Site["opportunities"];
    children?: ReactNode;
}) {
    const enabled = haEnabled && initial.assets.some(a => a.metrics.length > 0);
    const [live, setLive] = useState({ updates: {} as Record<string, number | null>,
        status: "connecting" as LiveStatus, receivedAt: null as string | null, now: plan.signal.generatedAt });
    useEffect(() => {
        if (!enabled) return;
        return watchHomeAssistant(updates => {
            const now = new Date().toISOString();
            setLive(previous => ({ ...previous, updates: { ...previous.updates, ...updates }, receivedAt: now, now }));
        }, status => setLive(previous => ({ ...previous, status, now: new Date().toISOString() })));
    }, [enabled]);
    const { snapshot, result } = liveSiteOpportunities({ initial, ...live, haEnabled: enabled,
        signal: plan.signal, configuration,
        now: Date.parse(live.now) > Date.parse(plan.signal.generatedAt) ? live.now : plan.signal.generatedAt });
    return <>
        {enabled && <HomeEnergyTelemetry initial={snapshot} status={live.status} />}
        {children}
        <EnergyOpportunities result={result} timeZone={plan.timeZone} />
    </>;
}
