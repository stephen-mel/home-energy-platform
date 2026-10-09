"use client";
import type { KrakenState, KrakenVehicleState } from "../lib/site/kraken-state";
import { formatLocalDateTime } from "../lib/presentation/local-time";
import { useDashboardTime } from "./use-dashboard-time";

type Snapshot = Pick<KrakenState, "lastSuccessfulUpdate" | "stale">;

/** Presentation only. No dispatch comparison, tariff inference or retrieval. */
export default function KrakenPlannedSessions({ vehicle, snapshot, asOf, timeZone }: {
    vehicle: KrakenVehicleState | null;
    snapshot: Snapshot | null;
    asOf: string;
    timeZone: string;
}) {
    const now = useDashboardTime(asOf);
    const retrieved = Date.parse(snapshot?.lastSuccessfulUpdate ?? "");
    const age = Date.parse(now) - retrieved;
    const validAge = Number.isFinite(age) && age >= 0;
    const ageSeconds = validAge ? Math.floor(age / 1000) : null;
    const exactTime = (value: string) => Number.isFinite(Date.parse(value))
        ? <time dateTime={value}>{formatLocalDateTime(value, timeZone, true)}</time>
        : <span>Time unavailable</span>;
    return <section aria-label={vehicle ? `Planned vehicle sessions for ${vehicle.name}` : "Planned vehicle sessions"}
        className="mt-6 border-t border-zinc-800 pt-6">
        <h3 className="text-sm font-medium">Planned vehicle sessions{vehicle ? ` · ${vehicle.name}` : ""}</h3>
        {!snapshot ? <p role="status" className="mt-2 text-sm text-zinc-400">Kraken planned sessions unavailable. No current snapshot is supplied.</p> : <>
            <p className="mt-2 text-xs text-zinc-400">Last successful retrieval: {exactTime(snapshot.lastSuccessfulUpdate)} · {timeZone}</p>
            <p role="status" className="mt-1 text-xs text-zinc-400">
                {ageSeconds === null ? "Retrieval age unknown."
                    : `Retrieved ${ageSeconds} seconds ago.`}{" "}
                {snapshot.stale ? "Stale / last-known snapshot; latest retrieval failed."
                    : !validAge ? "Snapshot freshness unknown."
                    : age >= 60_000 ? "Snapshot is at least 60 seconds old; the schedule may have changed."
                    : "Recently retrieved snapshot; Kraken may revise it."}
                {" "}This display does not refresh the schedule.
            </p>
            {!vehicle ? <p className="mt-3 text-sm text-zinc-400">No vehicle sessions can be displayed from this snapshot.</p>
                : !vehicle.plannedDispatches?.length ? <p className="mt-3 text-sm text-zinc-400">No sessions supplied for this vehicle. The current integration cannot distinguish an empty schedule from missing dispatch data; this does not confirm cancellation or withdrawal.</p>
                : <ul className="mt-3 space-y-3">
                    {vehicle.plannedDispatches.map((dispatch, index) => <li key={`${dispatch.start}-${index}`} className="rounded-xl bg-zinc-950/40 p-3 text-sm">
                        <p className="font-medium">{dispatch.type || "Type not supplied"} · Planned session</p>
                        <p className="mt-1 text-zinc-300">{exactTime(dispatch.start)}{" → "}{exactTime(dispatch.end)}</p>
                        {!(Date.parse(dispatch.end) > Date.parse(dispatch.start)) && <p>Session interval is invalid or unavailable.</p>}
                        <p className="mt-1 text-zinc-400">{dispatch.energyAddedKwh !== null && dispatch.energyAddedKwh?.trim()
                            && Number.isFinite(Number(dispatch.energyAddedKwh))
                            ? `Planned energy: ${dispatch.energyAddedKwh} kWh (as supplied)` : "Planned energy not supplied / unknown"}</p>
                        {dispatch.type === "BOOST" && <p className="mt-1 text-xs text-zinc-400">BOOST is not evidence of cheap-rate entitlement.</p>}
                    </li>)}
                </ul>}
        </>}
        <p className="mt-3 text-xs text-zinc-400">Source: Kraken planned dispatch snapshot. Scheduled intervals are not actual charging, verified whole-house tariff eligibility or Tesla instructions. Charging duration does not shorten the displayed plan.</p>
    </section>;
}
