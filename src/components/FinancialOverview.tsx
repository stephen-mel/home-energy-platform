import type { ElectricityFinancialOverview, FinancialValue } from "../lib/financial/electricity-overview";
import { formatLocalDateTime } from "../lib/presentation/local-time";

function money(value: FinancialValue) {
    if (value.amount === null || !value.currency) return "Unavailable";
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: value.currency,
        minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value.amount);
}
const label = (value: FinancialValue) => value.status === "calculated" ? "Calculated from measured energy"
    : value.status === "estimated" && value.pricingBasis === "user-confirmed-assumption" ? "Estimate using a user-confirmed tariff assumption"
    : value.status === "estimated" && value.pricingBasis === "mixed" ? "Estimate using mixed verified and assumed pricing"
    : value.status === "estimated" ? "Estimate" : value.status === "partial" ? "Calculated for covered data only" : "No interval energy data";
const rate = (amount: number, currency: string) => currency === "GBP" ? `${Number((amount * 100).toFixed(5))}p/kWh` : `${amount} ${currency}/kWh`;

export default function FinancialOverview({ overview, timeZone }: { overview: ElectricityFinancialOverview; timeZone: string }) {
    const cards: Array<[string, FinancialValue]> = [["Grid import cost", overview.importCost], ["Export earnings", overview.exportEarnings], ["Net electricity cost", overview.netCost]];
    return <section aria-labelledby="financial-overview-heading" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 id="financial-overview-heading" className="text-2xl font-semibold">Financial overview</h2>
        <p className="mt-2 text-sm text-zinc-400">Selected period: {formatLocalDateTime(overview.period.start, timeZone)} → {formatLocalDateTime(overview.period.end, timeZone)}</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">{cards.map(([title, value]) => <div key={title} className="rounded-2xl bg-zinc-800/70 p-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">{title}</p><p className="mt-2 text-2xl font-medium">{money(value)}</p>
            <p className={`mt-1 text-xs ${value.status === "estimated" ? "text-amber-300" : "text-zinc-400"}`}>{label(value)}</p>
        </div>)}</div>
        <div className="mt-5 grid gap-3 text-sm md:grid-cols-2">
            <p>Import data coverage: <strong>{overview.coverage.importPercent}%</strong></p>
            <p>Export data coverage: <strong>{overview.coverage.exportPercent}%</strong></p>
        </div>
        {!overview.coverage.complete && <p role="status" className="mt-3 text-sm text-amber-300">Complete interval import and export energy readings are unavailable, so full-period costs are not shown.</p>}
        <details className="mt-4 text-sm text-zinc-400"><summary className="cursor-pointer">Rates and calculation basis</summary>
            <p className="mt-3">Verified import rates in this period: {overview.rates.import.length ? overview.rates.import.map(value => rate(value.amount, value.currency)).join(", ") : "Unavailable"}.</p>
            <p className="mt-2">{overview.exportEarnings.pricingBasis === "verified" ? "Verified export rates"
                : overview.exportEarnings.pricingBasis === "unknown" ? "Export rates"
                : "Export rates including user-confirmed assumptions"} in this period: {overview.rates.export.length ? overview.rates.export.map(value => rate(value.amount, value.currency)).join(", ") : "Unavailable"}.</p>
            <ul className="mt-3 list-disc space-y-1 pl-5">{overview.limitations.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}</ul>
        </details>
    </section>;
}
