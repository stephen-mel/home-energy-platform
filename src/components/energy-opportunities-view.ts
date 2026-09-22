import { formatLocalDateTime, isNextLocalMidnight } from "../lib/presentation/local-time";
import type { Insight, OpportunityResult } from "../lib/opportunity/types";
import type { EnergyPrice } from "../lib/tariff/types";

export type OpportunityCard = { insight: Insight; title: string; summary: string; label: string; warning: string | null };
const priority: Record<Insight["type"], number> = {
    "smart-opportunity": 0, "cheap-import-ahead": 1, "export-value": 2,
    "stored-energy-context": 3, "gross-import-spread": 4, "gross-export-spread": 5,
    "expensive-import-exposure": 6, "no-additional-opportunity": 7,
};
const price = (value: EnergyPrice | null | undefined) => !value ? "unknown" : value.currency === "GBP"
    ? `${Number((value.amount * 100).toFixed(4))}p/kWh` : `${value.amount} ${value.currency}/kWh`;

export function opportunityCards(result: OpportunityResult, timeZone: string): OpportunityCard[] {
    const sorted = [...result.insights].sort((a, b) => priority[a.type] - priority[b.type] || a.window.start.localeCompare(b.window.start) || a.id.localeCompare(b.id));
    const chosen: Insight[] = [];
    const seen = new Set<string>();
    for (const insight of sorted) {
        if (chosen.length === 3) break;
        if (seen.has(insight.type)) continue; // Nearest instance of each homeowner message.
        const hasCheap = chosen.some(i => i.type === "cheap-import-ahead" || i.type === "smart-opportunity");
        if (hasCheap && ["expensive-import-exposure", "gross-import-spread", "gross-export-spread"].includes(insight.type)) continue;
        if (insight.type === "expensive-import-exposure" && chosen.some(i => i.type === "gross-import-spread")) continue;
        if (insight.type === "no-additional-opportunity" && chosen.length) continue;
        seen.add(insight.type); chosen.push(insight);
    }
    const time = (date: string) => formatLocalDateTime(date, timeZone);
    return chosen.map(insight => {
        const lower = insight.evidence.prices.find(p => p.role === "lower-import")?.window;
        const current = insight.evidence.prices.find(p => p.role === "current-import")?.window;
        const states = lower?.eligibilityPeriods.map(p => p.state) ?? [];
        const label = insight.type === "stored-energy-context" ? "Battery context" : lower?.condition === "scheduled-ev-charging"
            ? !states.length || states.includes("planned-conditional") ? "Conditional"
                : states.every(s => s === "billed-verified") ? "Verified" : "Observed · not bill-verified"
            : lower?.kind === "guaranteed-off-peak" ? "Guaranteed"
                : insight.type === "export-value" ? "Observed" : "Economic context";
        let title = "Price-spread context", summary = insight.explanation;
        if (insight.type === "cheap-import-ahead" && lower && current) {
            title = "Cheaper electricity ahead";
            const starts = lower.kind === "guaranteed-off-peak" && isNextLocalMidnight(lower.start, result.asOf, timeZone)
                ? "midnight" : time(lower.start);
            summary = `Electricity falls from ${price(current.price)} to ${price(lower.price)} at ${starts} — a gross difference of ${price({ amount: insight.financial.grossSpreadPerKwh!, currency: insight.financial.currency!, unit: "kWh" })}.`;
        } else if (insight.type === "smart-opportunity" && lower) {
            title = "Smart Charge opportunity";
            const names = [...new Set(lower.sources.flatMap(s => s.cause?.assetName?.trim() ? [s.cause.assetName.trim()] : []))];
            summary = `${names.length ? names.join(", ") : "An EV"} ${names.length > 1 ? "have" : "has"} a Smart Charge period from ${time(lower.start)} to ${time(lower.end)}. Whole-home electricity may cost ${price(lower.price)} if EV charging qualifies.`;
            const causes = lower.sources.filter(s => s.cause);
            if (causes.length > 1) summary = `Planned Smart Charge opportunities for ${names.length ? names.join(", ") : "the scheduled vehicles"} are grouped from ${time(lower.start)} to ${time(lower.end)}. Whole-home electricity may cost ${price(lower.price)} where EV charging qualifies; individual dispatches are in Details.`;
            if (label === "Verified") summary = `The supplied bill evidence verifies ${price(lower.price)} for ${time(lower.start)} to ${time(lower.end)}.`;
            else if (label.startsWith("Observed")) summary = `Qualifying charging was observed for ${time(lower.start)} to ${time(lower.end)} at ${price(lower.price)}; billing is not verified.`;
        } else if (insight.type === "export-value") {
            title = "Solar export value";
            const grid = insight.evidence.telemetry.find(r => r.role === "grid-flow")?.reading.value;
            const value = insight.financial.instantaneousValuePerHour;
            summary = value !== null && grid !== null && grid !== undefined
                ? `Solar exceeds household use, with ${Math.abs(grid)} kW flowing to the grid. Its instantaneous economic value is ${insight.financial.currency === "GBP" ? "£" : `${insight.financial.currency} `}${Number(value.toFixed(3))}/hour — not confirmed revenue or a forecast.`
                : "Solar exceeds household use and energy is flowing to the grid. No positive known export value is assigned; revenue is not inferred.";
        } else if (insight.type === "stored-energy-context") {
            title = "Stored energy context";
            const soc = insight.evidence.telemetry.find(t => t.role === "soc")?.reading.value;
            summary = `Battery level is ${soc === null || soc === undefined ? "unknown" : `${Number(soc.toFixed(1))}%`}. ${lower ? "A lower-rate period is ahead. " : ""}Usable duration and sufficiency remain unknown without future load and solar information.`;
        } else if (insight.type === "no-additional-opportunity") {
            title = "No additional opportunity identified";
            summary = "The available data does not show an additional price-spread opportunity. This is not a claim of optimal operation.";
        }
        const warning = insight.evidence.freshness === "stale" ? "Last-known evidence · may have changed"
            : insight.evidence.freshness === "unknown" ? "Some readings or their freshness are unknown" : null;
        return { insight, title, summary, label, warning };
    });
}
