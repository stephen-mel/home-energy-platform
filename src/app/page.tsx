import HomeEnergyPlan from "../components/HomeEnergyPlan";
import { getSitePriceSignal } from "../lib/site/get-site-price-signal";
import HomeEnergyTelemetry from "../components/HomeEnergyTelemetry";
import { getCurrentSite } from "../lib/site/repository";
import { getSiteState } from "../lib/site/get-site-state";

import ReadyByControl from "../components/ReadyByControl";
import TargetSocControl from "../components/TargetSocControl";
import { getSmartControlSetting } from "../lib/site/kraken-state";

export const dynamic = "force-dynamic";



function formatSmartControl(state: string | null) {
  switch (state) {
    case "SMART_CONTROL_CAPABLE":
      return "Smart Control ready";
    case "SMART_CONTROL_IN_PROGRESS":
      return "Smart Control active";
    case "SMART_CONTROL_NOT_AVAILABLE":
      return "Smart Control unavailable";
    case "BOOSTING":
      return "Boost charging";
    default:
      return state ?? "Unknown";
  }
}

export default async function Home() {
  const site = await getCurrentSite();
  const siteState = await getSiteState(site);

  const kraken = siteState.integrations.kraken.data;
  const vehicles = kraken?.vehicles ?? [];
  const krakenError = siteState.integrations.kraken.error;
  const homeAssistant = siteState.integrations.homeAssistant;

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-white">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-emerald-400">
            Home Energy Platform
          </p>

          <h1 className="text-4xl font-semibold tracking-tight">
            Electric Vehicles
          </h1>

          <p className="mt-3 text-zinc-400">
            {kraken?.stale ? "Last known vehicle data from Kraken Flex" : "Live vehicle data from Kraken Flex"}
          </p>
        </div>

        {homeAssistant.enabled && site.integrations.homeAssistant.assets?.some(asset => asset.metrics.length > 0) && (
          <HomeEnergyTelemetry initial={homeAssistant.data ?? {
            assets: (site.integrations.homeAssistant.assets ?? []).map(asset => ({
              ...asset, metrics: asset.metrics.map(metric => ({ ...metric, rawValue: null, value: null })),
            })),
          }} />
        )}
        <HomeEnergyPlan plan={getSitePriceSignal(site, kraken, siteState.updatedAt)} />
        {kraken?.stale && (
          <p role="status" className="mb-6 text-sm text-amber-400">
            Kraken vehicle data is stale. Showing last known readings. Last successful update:{" "}
            <time dateTime={kraken.lastSuccessfulUpdate}>
              {new Date(kraken.lastSuccessfulUpdate).toLocaleString("en-GB", {
                timeZone: "Europe/London",
                timeZoneName: "short",
              })}
            </time>.
          </p>
        )}
        {krakenError && (
          <p className="mb-6 text-sm text-zinc-400">Vehicle data is currently unavailable.</p>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          {vehicles.map((vehicle) => {
            const soc = Number(vehicle.status.stateOfCharge?.value ?? 0);
            const activePower = Number(vehicle.status.activePower?.value ?? 0);
            const schedule = vehicle.preferences?.schedules?.[0];
            const readyBy = schedule?.time?.slice(0, 5) ?? "Not set";
            const targetSoc = schedule?.max ?? null;
            const scheduleSetting =
              vehicle.preferenceSetting?.scheduleSettings?.[0] ?? null;

            const readyByFrom = scheduleSetting?.timeFrom?.slice(0, 5) ?? null;
            const readyByTo = scheduleSetting?.timeTo?.slice(0, 5) ?? null;
            const readyByStep = scheduleSetting?.timeStep ?? null;

            const targetMin =
              scheduleSetting?.min !== null && scheduleSetting?.min !== undefined
                ? Number(scheduleSetting.min)
                : null;

            const targetMax =
              scheduleSetting?.max !== null && scheduleSetting?.max !== undefined
                ? Number(scheduleSetting.max)
                : null;

            const targetStep = scheduleSetting?.step
              ? Number(scheduleSetting.step)
              : null;

            const plannedDispatches = vehicle.plannedDispatches ?? [];

            const plannedEnergy = plannedDispatches.reduce(
              (total, dispatch) =>
                total + Math.abs(Number(dispatch.energyAddedKwh ?? 0)),
              0
            );

            const firstDispatch = plannedDispatches[0] ?? null;
            const lastDispatch =
              plannedDispatches[plannedDispatches.length - 1] ?? null;
            return (
              <section
                key={vehicle.id}
                className="rounded-3xl border border-zinc-800 bg-zinc-900 p-7"
              >
                <div className="mb-8">
                  <p className="text-sm text-zinc-500">{vehicle.provider}</p>
                  <h2 className="mt-1 text-2xl font-semibold">
                    {vehicle.name}
                  </h2>
                </div>

                <div className="mb-3 flex items-end justify-between">
                  <span className="text-sm text-zinc-400">Battery</span>
                  <span className="text-4xl font-semibold">{soc}%</span>
                </div>

                <div className="mb-8 h-3 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-emerald-400"
                    style={{ width: `${Math.min(soc, 100)}%` }}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Battery Capacity
                    </p>
                    <p className="mt-2 font-medium">
                      {Number(vehicle.vehicleBatterySize).toFixed(1)} kWh
                    </p>
                  </div>
                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Charger Power
                    </p>
                    <p className="mt-2 font-medium">
                      {Number(vehicle.chargePointPowerOutput).toFixed(1)} kW
                    </p>
                  </div>
                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Ready By
                    </p>
                    {readyByFrom && readyByTo && readyByStep ? (
                      <ReadyByControl
                        deviceId={vehicle.id}
                        value={readyBy}
                        timeFrom={readyByFrom}
                        timeTo={readyByTo}
                        timeStep={readyByStep}
                      />
                    ) : (
                      <p className="mt-2 font-medium">{readyBy}</p>
                    )}

                    {readyByFrom && readyByTo && readyByStep && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {readyByFrom}–{readyByTo} · {readyByStep} min steps
                      </p>
                    )}
                  </div>

                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Target
                    </p>
                    {targetSoc !== null &&
                      targetMin !== null &&
                      targetMax !== null &&
                      targetStep !== null ? (
                      <TargetSocControl
                        deviceId={vehicle.id}
                        value={targetSoc}
                        min={targetMin}
                        max={targetMax}
                        step={targetStep}
                      />
                    ) : (
                      <p className="mt-2 font-medium">
                        {targetSoc !== null ? `${targetSoc}%` : "Not set"}
                      </p>
                    )}

                    {targetMin !== null && targetMax !== null && targetStep !== null && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {targetMin}–{targetMax}% · {targetStep}% steps
                      </p>
                    )}
                  </div>

                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Smart Control
                    </p>
                    <p className="mt-2 font-medium">
                      {getSmartControlSetting(vehicle.status.isSuspended)}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500">
                      Operational state: {formatSmartControl(vehicle.status.currentState)}
                    </p>
                  </div>

                  <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">
                      Charging
                    </p>
                    <p className="mt-2 font-medium">
                      {activePower > 0
                        ? `${activePower.toFixed(1)} kW`
                        : "Not charging"}
                    </p>
                  </div>
                </div>
                <div className="mt-6 border-t border-zinc-800 pt-6">
                  <p className="text-xs uppercase tracking-wide text-zinc-500">
                    Kraken Plan
                  </p>

                  {firstDispatch && lastDispatch ? (
                    <div className="mt-3">
                      <p className="text-lg font-medium">
                        {plannedEnergy.toFixed(2)} kWh planned
                      </p>

                      <div className="mt-3 space-y-2">
                        {plannedDispatches.map((dispatch, index) => {
                          const start = new Date(dispatch.start).toLocaleTimeString(
                            "en-GB",
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: "Europe/London",
                            }
                          );

                          const end = new Date(dispatch.end).toLocaleTimeString(
                            "en-GB",
                            {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZone: "Europe/London",
                            }
                          );

                          const energy = Math.abs(
                            Number(dispatch.energyAddedKwh ?? 0)
                          );

                          return (
                            <div
                              key={`${dispatch.start}-${index}`}
                              className="flex items-center justify-between text-sm"
                            >
                              <span className="text-zinc-400">
                                {start} → {end}
                              </span>

                              <span className="font-medium">
                                {energy.toFixed(2)} kWh
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-zinc-400">
                      No charging plan currently available
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}