import { formatLocalDateTime } from "../lib/presentation/local-time";
import type { OpportunityResult } from "../lib/opportunity/types";
import { opportunityCards } from "./energy-opportunities-view";

export default function EnergyOpportunities({ result, timeZone }: { result: OpportunityResult; timeZone: string }) {
    const cards = opportunityCards(result, timeZone);
    const time = (date: string) => formatLocalDateTime(date, timeZone);
    return <section aria-label="Energy opportunities" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="text-2xl font-semibold">Energy opportunities</h2>
        <p className="mt-2 text-xs text-zinc-400">Economic context as of {time(result.asOf)}. Economic observations only; battery operation remains with its own optimiser.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
            {cards.map(({ insight, title, summary, label, warning }) => <article key={insight.id} className="rounded-2xl bg-zinc-800/70 p-4">
                <p className={`text-xs font-medium ${label === "Conditional" ? "text-amber-300" : label === "Guaranteed" ? "text-emerald-300" : "text-zinc-300"}`}>{label}</p>
                <h3 className="mt-2 font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-zinc-300">{summary}</p>
                {warning && <p className="mt-2 text-xs text-amber-300">{warning}</p>}
                <details className="mt-3 text-xs text-zinc-400">
                    <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-emerald-400">Details</summary>
                    <p className="mt-2">{time(insight.window.start)} → {time(insight.window.end)}</p>
                    <p className="mt-2">{insight.explanation}</p>
                    <p className="mt-2">Evidence: {insight.evidence.tariffStates.join(", ") || "Unknown"}. Freshness: {insight.evidence.freshness}.</p>
                    {insight.evidence.prices.map((p, i) => <p key={i} className="mt-2">{time(p.window.start)} → {time(p.window.end)} · {p.window.sources.map(s => s.description).filter((s, index, all) => all.indexOf(s) === index).join("; ")}</p>)}
                    {insight.evidence.prices.flatMap(p => p.window.sources).filter(s => s.cause).filter((s, i, all) =>
                        all.findIndex(other => JSON.stringify(other.cause) === JSON.stringify(s.cause)) === i
                    ).map((s, i) => <p key={`dispatch-${i}`} className="mt-2">{s.cause!.assetName || "Unnamed EV"}: {time(s.cause!.start)} → {time(s.cause!.end)} · {s.cause!.dispatchType} planned dispatch. Grouped opportunities do not confirm continuous discounted billing.</p>)}
                    {insight.evidence.limitations.map(text => <p key={text} className="mt-2">{text}</p>)}
                </details>
            </article>)}
        </div>
        {!cards.length && <p className="mt-3 text-sm text-zinc-400">No current insight is available from this snapshot. The price plan may need a normal dashboard reload.</p>}
        {result.limitations.length > 0 && <details className="mt-4 text-xs text-zinc-400"><summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-emerald-400">Data availability</summary>
            <p className="mt-2">Some current inputs are missing, unknown or insufficient for a physical observation. Tariff-only insights remain available where prices are known.</p>
        </details>}
    </section>;
}
