"use client";

import { useEffect, useState } from "react";
import { applyHomeAssistantMetricUpdates } from "../lib/site/home-assistant-metrics";
import type { HomeAssistantState } from "../lib/site/home-assistant-state";
import { watchHomeAssistant, type LiveStatus } from "../lib/home-assistant/browser-stream";

export default function HomeEnergyTelemetry({ initial }: { initial: HomeAssistantState }) {
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [status, setStatus] = useState<LiveStatus>("connecting");
  useEffect(() => watchHomeAssistant(
    updates => setValues(previous => ({ ...previous, ...updates })), setStatus,
  ), []);
  const { assets } = applyHomeAssistantMetricUpdates(initial, values);
  return <section aria-label="Home energy">
    <p role="status" className="mb-4 text-sm text-zinc-400">
      {status === "live" ? "Home energy updates connected" : status === "connecting"
        ? "Connecting home energy updates · showing initial readings"
        : "Home energy updates unavailable · showing last known readings"}
    </p>
        {assets.map((asset) => (
          <div key={asset.id} className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <div className="mb-6">
              <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">
                Live Home Energy
              </p>
              <h2 className="mt-2 text-2xl font-semibold">{asset.name}</h2>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {asset.metrics.map((metric) => (
                <div key={metric.entityId} className="rounded-2xl bg-zinc-800/70 p-4">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">{metric.label}</p>
                  <p className="mt-2 text-xl font-medium">
                    {metric.value === null ? "Unavailable" :
                      `${metric.value.toFixed(metric.decimals)}${metric.unit === "%" ? "" : " "}${metric.unit}`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
  </section>;
}
