"use client";
import { useMemo, useState } from "react";
import { selectedHomeEnergyPlan, type HomeEnergyPlanSource } from "./selected-home-energy-plan";
import { useDashboardTime } from "./use-dashboard-time";
import { formatLocalDateTime } from "../lib/presentation/local-time";
import { homeEnergyPlanView, rateLabel, vehicleNames } from "./home-energy-plan-view";
import type { SitePricePlan } from "../lib/site/get-site-price-signal";
import type { EnergyPrice, PriceSource, PriceWindow } from "../lib/tariff/types";

function formatPrice(price: EnergyPrice | null) {
    if (!price) return "Price not configured / unknown";
    if (price.currency === "GBP") return `${Number((price.amount * 100).toFixed(4))}p/kWh`;
    return `${price.amount} ${price.currency}/kWh`;
}

function KrakenDispatches({ sources, timeZone }: { sources: PriceSource[]; timeZone: string }) {
    const dispatches = sources.flatMap(source =>
        source.provider === "kraken" && source.cause?.kind === "ev-dispatch" ? [source.cause] : []
    ).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.assetId.localeCompare(b.assetId));
    if (!dispatches.length) return null;
    const exactTime = (value: string) => formatLocalDateTime(value, timeZone, true);
    return (
        <div className="mt-3 border-t border-zinc-700 pt-3">
            <p className="text-sm font-medium">HEP grouping of planned Kraken opportunities</p>
            <p className="mt-1 text-xs text-zinc-400">
                This grouped range does not confirm a continuous E.ON discounted billing period.
                E.ON bills using half-hourly meter readings. Each opportunity depends on the identified vehicle
                actually charging during the qualifying period. If charging finishes early or the schedule changes,
                the cheap-rate duration may be shorter than this planned range.
                Dispatch types are shown as supplied; billing eligibility has not been verified.
            </p>
            <ul aria-label="Original Kraken dispatches" className="mt-2 space-y-2 text-sm">
                {dispatches.map(dispatch => (
                    <li key={JSON.stringify(dispatch)}>
                        <p className="font-medium">
                            {dispatch.assetName?.trim() ? `${dispatch.assetName} (${dispatch.assetId})` : dispatch.assetId}
                        </p>
                        <p className="text-zinc-300">
                            <time dateTime={dispatch.start}>{exactTime(dispatch.start)}</time>{" → "}
                            <time dateTime={dispatch.end}>{exactTime(dispatch.end)}</time>
                        </p>
                        <p className="text-xs text-zinc-400">Dispatch type: {dispatch.dispatchType?.trim() || "Not supplied"}</p>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export type HomeEnergyPlanAlternative = {
    id: string;
    label: string;
    timeZone: string;
    source: Exclude<HomeEnergyPlanSource, { kind: "manual-assumption" }>;
};

function resolvePreview(alternatives: readonly HomeEnergyPlanAlternative[], selectedId: string | undefined, now: string) {
    const selected = selectedId ? alternatives.filter(item => item.id === selectedId) : [];
    if (selected.length !== 1) return null;
    const { source, timeZone } = selected[0];
    try {
        // A standalone resolution needs an explicit presentation timezone.
        if (!timeZone) return null;
        new Intl.DateTimeFormat("en-GB", { timeZone });
        if (source.kind === "eon-offline" && source.result.model
            && source.result.model.timeZone !== timeZone) return null;
        return selectedHomeEnergyPlan(source, now);
    } catch { return null; }
}

export default function HomeEnergyPlan({ plan, alternatives = [] }: {
    plan: SitePricePlan;
    alternatives?: readonly HomeEnergyPlanAlternative[];
}) {
    const [selection, setSelection] = useState<{ id: string; label: string } | null>(null);
    // The existing server timestamp seeds SSR/hydration for every selection.
    const now = useDashboardTime(plan.signal.generatedAt);
    const options = alternatives.filter(option => option.id && option.label.trim()
        && alternatives.filter(other => other.id === option.id).length === 1
        && ((option.source.kind === "canonical" && option.source.resolution)
            || (option.source.kind === "eon-offline" && option.source.result)));
    const option = selection ? options.find(item => item.id === selection.id) : undefined;
    const previewZone = option?.timeZone;
    const preview = useMemo(() => resolvePreview(alternatives, selection?.id, now), [alternatives, selection?.id, now]);
    const controls = options.length > 0 ? <label className="mt-3 block text-sm text-zinc-300">
        View source
        <select aria-label="Home Energy Plan source" className="ml-3 rounded bg-zinc-800 p-2"
            value={selection?.id ?? ""} onChange={event => {
                if (event.target.value === "") { setSelection(null); return; }
                const next = options.find(item => item.id === event.target.value);
                if (next) setSelection({ id: next.id, label: next.label });
            }}>
            <option value="">Current configured plan</option>
            {selection && !option && <option value={selection.id} disabled>{selection.label} · unavailable</option>}
            {options.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
    </label> : selection ? <button className="mt-3 text-sm underline" onClick={() => setSelection(null)}>Return to configured plan</button> : null;
    const previewNotice = selection && <div className="mt-3 text-sm text-zinc-300">
        <p>Home Energy Plan preview only; other dashboard insights retain their current source.</p>
        <p className="mt-1">Source: {option?.label ?? selection.label}{preview ? ` · ${preview.sourceLabel}` : ""}</p>
    </div>;
    const signal = selection ? preview?.presentationSignal : plan.signal;
    const view = selection ? preview?.view : homeEnergyPlanView(plan.signal, now);
    // Never fall back to configured prices, including when a selected option is removed.
    if (selection && (!option || preview?.status !== "selected" || !signal || !view)) return (
        <section aria-label="Home energy price signal" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-2xl font-semibold">Home Energy Plan</h2>
            {controls}{previewNotice}
            <p role="status" className="mt-4 text-sm text-amber-300">Price presentation unavailable for the selected source.</p>
            <p className="mt-2 text-sm text-zinc-400">{!option ? "The selected source is no longer supplied. Choose a source explicitly to continue."
                : "The supplied source could not be safely presented. No prices or timeline are shown; the configured plan has not been substituted."}</p>
        </section>
    );
    if (!signal || !view) return null;
    const timeZone = selection ? previewZone! : plan.timeZone;
    const kraken = selection ? null : plan.kraken;
    const time = (value: string) => formatLocalDateTime(value, timeZone);
    const shortTime = time;
    const tone = (window: PriceWindow | null) => !window || window.price === null
        ? "bg-zinc-700" : window.kind === "guaranteed-off-peak" ? "bg-emerald-400"
        : window.kind === "cheap-opportunity" ? "bg-amber-400" : "bg-sky-600";
    const windows = (curve: PriceWindow[]) => (
        <ul className="mt-3 space-y-3">
            {curve.map(window => (
                <li key={window.start} className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-sm text-zinc-300">
                        <time dateTime={window.start}>{time(window.start)}</time>{" → "}
                        <time dateTime={window.end}>{time(window.end)}</time>
                    </p>
                    <p className="mt-1 font-medium">
                        {window.kind === "cheap-opportunity" ? "Whole-home cheap opportunity" : window.kind === "guaranteed-off-peak" ? "Guaranteed off-peak tariff" : "Standard tariff"}
                        {" · "}{formatPrice(window.price)}
                    </p>
                    {window.priceStatus === "conflicting" && (
                        <p className="mt-1 text-sm text-amber-400">Sources disagree on the price; no rate assumed.</p>
                    )}
                    <p className="mt-1 text-xs text-zinc-400">
                        Source: {[...new Set(window.sources.map(source => `${source.description} (${source.provider})`))].join("; ")}
                        {window.stale ? " · Last-known schedule (stale)" : ""}
                    </p>
                    {window.condition === "scheduled-ev-charging" && (
                        <p className="mt-1 text-xs text-zinc-400">Planned / conditional. Conditional on scheduled vehicle charging; these are planned opportunities, not confirmed billed rates.</p>
                    )}
                    {window.kind === "cheap-opportunity" && <KrakenDispatches sources={window.sources} timeZone={timeZone} />}
                    {window.eligibilityPeriods.length > 0 && (
                        <p className="mt-2 text-xs text-zinc-400">Evidence: {[...new Set(window.eligibilityPeriods.map(period => period.state))].join(", ")}</p>
                    )}
                </li>
            ))}
        </ul>
    );
    return (
        <section aria-label="Home energy price signal" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-2xl font-semibold">Home Energy Plan</h2>
            {controls}{previewNotice}
            {selection && !!preview?.diagnostics.length && <p role="status" className="mt-2 text-sm text-zinc-400">Some supplied evidence is unknown, conflicting or not safe to present. Gaps remain unknown; no replacement rate is assumed.</p>}
            <p className="mt-2 text-xs text-zinc-400">Plan calculated {shortTime(signal.generatedAt)} · {timeZone}</p>
            {kraken?.lastSuccessfulUpdate && <p className="mt-1 text-xs text-zinc-400">
                Kraken schedule snapshot: {shortTime(kraken.lastSuccessfulUpdate)}. Reload to retrieve schedule changes.
            </p>}
            <div className="mt-5 grid gap-3 sm:grid-cols-3" aria-label="Electricity price summary">
                <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-400">Now</h3>
                    <p className="mt-2 text-2xl font-semibold">{formatPrice(view.currentImport?.price ?? null)}</p>
                    <p className="mt-1 text-sm text-zinc-300">{rateLabel(view.currentImport)}</p>
                    {view.currentImport?.condition === "scheduled-ev-charging" && <p className="mt-1 text-xs text-amber-300">Possible rate if scheduled charging qualifies.</p>}
                </div>
                <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-400">{view.cheapNow ? "Cheap period now" : "Next cheap period"}</h3>
                    {view.cheap ? <>
                        <p className="mt-2 text-lg font-semibold">{formatPrice(view.cheap.price)}</p>
                        <p className="mt-1 text-sm text-zinc-300">{view.cheapNow ? "Until " : `${shortTime(view.cheap.start)} → `}{shortTime(view.cheap.end)}</p>
                        <p className="mt-1 text-sm text-zinc-300">{view.cheap.kind === "guaranteed-off-peak" ? "Guaranteed" : "Smart charge · Conditional"}</p>
                        {view.cheap.kind === "cheap-opportunity" && <p className="mt-1 text-xs text-zinc-400">{vehicleNames(view.cheap).join(", ") || "Scheduled vehicle charging"}</p>}
                    </> : <p className="mt-2 text-sm text-zinc-300">No cheap period is shown in the available plan.</p>}
                </div>
                <div className="rounded-2xl bg-zinc-800/70 p-4">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-400">Export</h3>
                    <p className="mt-2 text-2xl font-semibold">{formatPrice(view.currentExport?.price ?? null)}</p>
                    <p className="mt-1 text-sm text-zinc-300">Electricity sent to the grid</p>
                </div>
            </div>
            <div className="mt-6">
                <h3 className="font-medium">Next 24 hours</h3>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-300">
                    <span>● Standard</span><span className="text-emerald-300">● Guaranteed cheap</span>
                    <span className="text-amber-300">● Smart charge · Conditional</span><span className="text-zinc-400">● Unknown</span>
                </div>
                <div className="mt-3 flex h-8 overflow-hidden rounded-lg" aria-hidden="true">
                    {view.segments.map(segment => <div key={segment.start} className={`${tone(segment.window)} border-r border-zinc-950/50 last:border-0`} style={{ width: `${segment.percent}%` }} />)}
                </div>
                <div className="mt-2 flex justify-between gap-4 text-xs text-zinc-400"><span>{shortTime(view.start)}</span><span>{shortTime(view.end)}</span></div>
                <ol aria-label="24-hour import prices" className="mt-4 grid gap-2 sm:grid-cols-2">
                    {view.segments.map(segment => <li key={segment.start} className="flex gap-3 rounded-xl bg-zinc-950/40 p-3 text-sm">
                        <span aria-hidden="true" className={`mt-1 h-3 w-3 shrink-0 rounded-full ${tone(segment.window)}`} />
                        <div><p className="text-zinc-300"><time dateTime={segment.start}>{shortTime(segment.start)}</time>{" → "}<time dateTime={segment.end}>{shortTime(segment.end)}</time></p>
                            <p className="mt-1">{rateLabel(segment.window)} · {formatPrice(segment.window?.price ?? null)}</p></div>
                    </li>)}
                </ol>
            </div>
            <details className="mt-6 border-t border-zinc-800 pt-4">
                <summary className="cursor-pointer rounded text-sm font-medium text-zinc-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-400">Details</summary>
                <h3 className="mt-4 font-medium">Whole-home price signal</h3>
            <p className="mt-3 text-sm text-zinc-400">
                {selection ? <>Supplied coverage: {time(signal.horizon.start)} → {time(signal.horizon.end)} · {timeZone}. Calculated from the supplied evidence at {time(signal.generatedAt)}.</>
                    : <>Next 48 hours · {timeZone}. Calculated from the plan available at {time(signal.generatedAt)}.</>}
                {" "}Planned cheap windows are opportunities, not confirmed billing rates.
            </p>
            {kraken?.status === "stale" && (
                <p role="status" className="mt-3 text-sm text-amber-400">
                    Kraken schedule is stale. Opportunities may have changed. Last successful update:{" "}
                    {kraken?.lastSuccessfulUpdate && <time dateTime={kraken.lastSuccessfulUpdate}>{time(kraken.lastSuccessfulUpdate)}</time>}.
                </p>
            )}
            {kraken?.status === "unavailable" && (
                <p className="mt-3 text-sm text-zinc-400">Kraken schedule is unavailable; cheap opportunities cannot currently be determined.</p>
            )}
            <h3 className="mt-5 font-medium">Import · electricity used by your home</h3>
            {windows(signal.import)}
            <h3 className="mt-5 font-medium">Export · electricity sent to the grid</h3>
            {windows(signal.export)}
            </details>
        </section>
    );
}
