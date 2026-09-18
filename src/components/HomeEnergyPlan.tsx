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
    const exactTime = (value: string) => {
        const date = new Date(value);
        return date.toLocaleString("en-GB", {
            timeZone, year: "numeric", month: "short", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            fractionalSecondDigits: date.getUTCMilliseconds() ? 3 : undefined,
            timeZoneName: "short",
        });
    };
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

export default function HomeEnergyPlan({ plan }: { plan: SitePricePlan }) {
    const { signal, timeZone, kraken } = plan;
    const time = (value: string) => new Date(value).toLocaleString("en-GB", {
        timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    });
    const opportunities = signal.import.filter(window => window.kind === "cheap-opportunity");
    const windows = (curve: PriceWindow[]) => (
        <ul className="mt-3 space-y-3">
            {curve.map(window => (
                <li key={window.start} className="rounded-2xl bg-zinc-800/70 p-4">
                    <p className="text-sm text-zinc-300">
                        <time dateTime={window.start}>{time(window.start)}</time>{" → "}
                        <time dateTime={window.end}>{time(window.end)}</time>
                    </p>
                    <p className="mt-1 font-medium">
                        {window.kind === "cheap-opportunity" ? "Whole-home cheap opportunity" : "Standard tariff"}
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
                </li>
            ))}
        </ul>
    );
    return (
        <section aria-label="Home energy price signal" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
            <p className="text-sm font-medium uppercase tracking-widest text-emerald-400">Home Energy Plan</p>
            <h2 className="mt-2 text-2xl font-semibold">Whole-home price signal</h2>
            <p className="mt-3 text-sm text-zinc-400">
                Next 48 hours · {timeZone}. Calculated from the plan available at {time(signal.generatedAt)}.
                Planned cheap windows are opportunities, not confirmed billing rates.
            </p>
            {kraken.status === "stale" && (
                <p role="status" className="mt-3 text-sm text-amber-400">
                    Kraken schedule is stale. Opportunities may have changed. Last successful update:{" "}
                    {kraken.lastSuccessfulUpdate && <time dateTime={kraken.lastSuccessfulUpdate}>{time(kraken.lastSuccessfulUpdate)}</time>}.
                </p>
            )}
            {kraken.status === "unavailable" && (
                <p className="mt-3 text-sm text-zinc-400">Kraken schedule is unavailable; cheap opportunities cannot currently be determined.</p>
            )}
            {opportunities.length === 0 && kraken.status !== "unavailable" && (
                <p className="mt-3 text-sm text-zinc-400">No planned whole-home cheap opportunities in this time range.</p>
            )}
            <h3 className="mt-5 font-medium">Import · electricity used by your home</h3>
            {windows(signal.import)}
            <h3 className="mt-5 font-medium">Export · electricity sent to the grid</h3>
            {windows(signal.export)}
        </section>
    );
}
