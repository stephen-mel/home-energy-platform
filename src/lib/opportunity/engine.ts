import type { EnergyPrice, PriceWindow } from "../tariff/types";
import type { Insight, OpportunityInput, OpportunityResult, Reading } from "./types";

const amount = (value: number) => Number(value.toFixed(10));
const priceKnown = (w: PriceWindow): boolean => w.priceStatus === "known" && w.price !== null &&
    Number.isFinite(w.price.amount) && w.price.unit === "kWh";
const spread = (low: PriceWindow, high: PriceWindow): number | null => priceKnown(low) && priceKnown(high) &&
    low.price!.currency === high.price!.currency ? amount(high.price!.amount - low.price!.amount) : null;
const finite = (r: Reading | undefined): r is Reading & { value: number } => !!r && r.value !== null && Number.isFinite(r.value);
const live = (r: Reading | undefined): r is Reading & { value: number } => finite(r) && r.freshness === "fresh";
const rateText = (price: EnergyPrice) => price.currency === "GBP" ? `${amount(price.amount * 100)}p/kWh` : `${price.amount} ${price.currency}/kWh`;

function tariffStates(w: PriceWindow): Insight["evidence"]["tariffStates"] {
    if (!priceKnown(w)) return ["unknown"];
    if (w.condition === "scheduled-ev-charging") {
        const states = [...new Set(w.eligibilityPeriods.map(p => p.state))];
        return states.length ? states : ["planned-conditional"];
    }
    return [w.kind === "guaranteed-off-peak" ? "guaranteed" : "configured"];
}
function conditionText(w: PriceWindow): string {
    if (w.condition !== "scheduled-ev-charging") return w.kind === "guaranteed-off-peak" ? "Guaranteed by the configured tariff." : "Based on the configured tariff.";
    const states = tariffStates(w);
    if (states.includes("planned-conditional")) return "Planned and conditional on qualifying EV charging; not a confirmed billed rate.";
    if (states.every(s => s === "billed-verified")) return "The supplied evidence marks this period as billed/verified.";
    return "The supplied evidence includes observed qualification; no additional billing verification is inferred.";
}

/** Pure economic context. No integration calls, Tesla adapter dependency, actions,
 * forecasts, efficiency assumptions or optimiser decisions. */
export function getOpportunities(input: OpportunityInput): OpportunityResult {
    const { signal, telemetry = {}, exportContext = {} } = input;
    const now = Date.parse(input.now), horizonEnd = Date.parse(signal.horizon.end);
    const insights: Insight[] = [], limitations: string[] = [];
    const result = (): OpportunityResult => ({ asOf: input.now, objective: "household-energy-cost-value", insights, limitations });
    if (!Number.isFinite(now) || now < Date.parse(signal.horizon.start) || now >= horizonEnd) {
        limitations.push("The requested time is outside the available price horizon or invalid."); return result();
    }
    const minimum = input.minimumSpreadPerKwh ?? 0;
    if (!Number.isFinite(minimum) || minimum < 0) {
        limitations.push("A finite non-negative materiality threshold is required."); return result();
    }
    const positive = (value: number | null): value is number => value !== null && value > 0 && value >= minimum;
    const imports = [...signal.import].filter(w => Date.parse(w.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const exports = [...signal.export].filter(w => Date.parse(w.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const current = imports.find(w => Date.parse(w.start) <= now);
    const effectiveExports = exports.map(w => exportContext.economicValue?.kind === "override"
        ? { ...w, price: exportContext.economicValue.price, priceStatus: exportContext.economicValue.price ? "known" as const : "unknown" as const,
            sources: [{ provider: "opportunity-input", description: "Explicit export economic value", observedAt: null, stale: false }] }
        : w);
    const currentExport = effectiveExports.find(w => Date.parse(w.start) <= now);
    if (!current || !priceKnown(current)) limitations.push("Current import price is unknown; current-to-future savings are not inferred.");
    if (!currentExport || !priceKnown(currentExport)) limitations.push("Current export economic value is unknown.");
    if (!Object.keys(telemetry).length) limitations.push("Live telemetry is not supplied; no current physical behaviour is inferred.");

    const emit = (type: Insight["type"], window: Insight["window"], prices: Insight["evidence"]["prices"],
        explanation: string, gross: number | null = null, readings: Insight["evidence"]["telemetry"] = [],
        assetId?: string, hourly: number | null = null) => {
        const stale = prices.some(p => p.window.stale || p.window.sources.some(s => s.stale)) || readings.some(r => r.reading.freshness === "stale");
        const unknown = (!prices.length && !readings.length) || prices.some(p => !priceKnown(p.window)) || readings.some(r => !finite(r.reading) || r.reading.freshness === "unknown");
        const restrictions: string[] = [];
        if (gross !== null) restrictions.push("Gross spread only, not guaranteed profit; no energy volume, losses, degradation costs or operating permissions assumed.");
        if (stale) restrictions.push("Includes stale evidence; current conditions may differ.");
        if (unknown) restrictions.push("Some evidence or its freshness is unknown.");
        if (prices.some(p => p.window.condition === "scheduled-ev-charging")) restrictions.push("Eligibility varies by source half-hour period; no evidence is promoted.");
        const planned = prices.some(p => tariffStates(p.window).includes("planned-conditional"));
        const conditionalNote = planned && !explanation.includes("Planned and conditional")
            ? " Planned rates depend on qualifying EV charging and are not confirmed billing rates." : "";
        const currency = prices.find(p => p.window.price)?.window.price?.currency ?? null;
        // Stable economic identity excludes timestamps/freshness/provenance and names.
        const id = JSON.stringify([type, window.start, window.end, assetId ?? null,
            prices.map(p => [p.role, p.window.start, p.window.end, p.window.price?.amount ?? null, p.window.price?.currency ?? null])]);
        insights.push({ id, type, window, ...(assetId ? { assetId } : {}),
            financial: { basis: gross !== null ? "gross-price-spread" : hourly !== null ? "instantaneous-export-economic-value" : "context-only",
                currency, grossSpreadPerKwh: gross, instantaneousValuePerHour: hourly },
            evidence: { prices, telemetry: readings, tariffStates: [...new Set(prices.flatMap(p => tariffStates(p.window)))].sort(),
                freshness: stale ? "stale" : unknown ? "unknown" : "fresh",
                exportContext: prices.some(p => p.role === "export-value") ? exportContext : null, limitations: restrictions },
            explanation: `${explanation}${conditionalNote}${stale ? " Evidence is stale; conditions may have changed." : unknown ? " Some evidence or its freshness is unknown." : ""}` });
    };
    const futureCheaper: PriceWindow[] = [];
    if (current && priceKnown(current)) {
        for (const lower of imports.filter(w => Date.parse(w.start) > now)) {
            const gross = spread(lower, current);
            if (!positive(gross)) continue;
            futureCheaper.push(lower);
            const type = lower.kind === "cheap-opportunity" ? "smart-opportunity" : "cheap-import-ahead";
            emit(type, { start: lower.start, end: lower.end }, [{ role: "current-import", window: current }, { role: "lower-import", window: lower }],
                `Import at ${rateText(lower.price!)} has a gross ${rateText({ ...lower.price!, amount: gross })} spread below the current ${rateText(current.price!)} rate. ${conditionText(lower)}`, gross);
        }
        if (futureCheaper.length) {
            const lower = futureCheaper[0], gross = spread(lower, current)!;
            emit("expensive-import-exposure", { start: input.now, end: current.end },
                [{ role: "current-import", window: current }, { role: "lower-import", window: lower }],
                `Any energy imported at the current rate costs ${rateText({ ...current.price!, amount: gross })} more per kWh than the upcoming lower rate. Actual household cost depends on imported energy. ${conditionText(lower)}`, gross);
        }
    }
    for (const low of imports.filter(priceKnown)) {
        const later = imports.find(w => Date.parse(w.start) >= Date.parse(low.end) && positive(spread(low, w)));
        if (later) emit("gross-import-spread", { start: low.start, end: later.end },
            [{ role: "lower-import", window: low }, { role: "later-import", window: later }],
            `The earlier ${rateText(low.price!)} and later ${rateText(later.price!)} import rates have a gross spread of ${rateText({ ...low.price!, amount: spread(low, later)! })}. This is not guaranteed profit. ${conditionText(low)}`, spread(low, later));
        for (const exp of effectiveExports) {
            const from = Math.max(now, Date.parse(low.start), Date.parse(exp.start));
            const to = Math.min(Date.parse(low.end), Date.parse(exp.end));
            const gross = spread(low, exp);
            if (from >= to || !positive(gross)) continue;
            emit("gross-export-spread", { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
                [{ role: "lower-import", window: low }, { role: "export-value", window: exp }],
                `Configured export economic value of ${rateText(exp.price!)} exceeds ${rateText(low.price!)} import by a gross ${rateText({ ...low.price!, amount: gross })}. This is not guaranteed profit or confirmed export revenue; battery export permission and losses are not assumed. ${conditionText(low)}`, gross);
        }
    }
    const { solarKw: solar, houseLoadKw: load, gridImportKw: grid } = telemetry;
    if (solar || load || grid) {
        if (live(solar) && live(load) && live(grid) && solar.value >= 0 && load.value >= 0 && solar.value > load.value && grid.value < 0) {
            const exportKw = -grid.value;
            const valued = currentExport && priceKnown(currentExport) && currentExport.price!.amount > 0;
            if (exportContext.capability === "unavailable") limitations.push("Grid readings indicate export despite capability being marked unavailable; inputs need reconciliation.");
            emit("export-value", { start: input.now, end: input.now }, currentExport ? [{ role: "export-value", window: currentExport }] : [],
                `Observed solar (${solar.value} kW) exceeds household load (${load.value} kW), while the grid reading shows ${exportKw} kW outward. ` +
                (valued ? `At the configured ${rateText(currentExport.price!)} export economic value this corresponds to ${amount(exportKw * currentExport.price!.amount)} ${currentExport.price!.currency}/hour at this instant, not confirmed revenue or a forecast.` : "No positive known export economic value is assigned; export revenue is not inferred.") +
                " The source of all exported energy is not established.", null,
                [{ role: "solar", reading: solar }, { role: "house-load", reading: load }, { role: "grid-flow", reading: grid }], undefined,
                valued ? amount(exportKw * currentExport.price!.amount) : null);
        } else limitations.push("Fresh, valid solar/load/grid readings do not jointly establish surplus export; no current export-value observation is inferred.");
    }
    for (const battery of [...(telemetry.batteries ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
        const soc = battery.socPercent;
        if (!finite(soc) || soc.value < 0 || soc.value > 100) { limitations.push(`Battery ${battery.id}: usable SOC evidence is unavailable.`); continue; }
        const readings: Insight["evidence"]["telemetry"] = [{ role: "soc", reading: soc }];
        const power = battery.powerToHomeKw;
        if (power) readings.push({ role: "battery-power", reading: power });
        const lower = futureCheaper[0];
        const prices: Insight["evidence"]["prices"] = current ? [{ role: "current-import", window: current }] : [];
        if (lower) prices.push({ role: "lower-import", window: lower });
        emit("stored-energy-context", { start: input.now, end: input.now }, prices,
            `${soc.freshness === "fresh" ? "Reported" : "Last supplied"} stored-energy level is ${soc.value}%. ` +
            (lower ? "A lower import rate is ahead. " : "This is context for the available import rates. ") +
            (live(power) ? `Battery power is ${Math.abs(power.value)} kW ${power.value > 0 ? "toward the home" : power.value < 0 ? "into storage" : "with no net flow"}. ` : "") +
            (lower && soc.freshness === "fresh" && soc.value > 0 ? "This is consistent with a stored-energy buffer before the lower-rate period; sufficiency is unknown. " : "") +
            "Usable energy, duration and Tesla's motive are not inferred; future load, solar and storage losses are unknown.", null, readings, battery.id);
    }
    if (!insights.some(i => i.financial.grossSpreadPerKwh !== null || i.financial.instantaneousValuePerHour !== null)) {
        emit("no-additional-opportunity", { start: input.now, end: signal.horizon.end }, current ? [{ role: "current-import", window: current }] : [],
            "No additional positive price-spread opportunity is identified in the available data under the selected threshold. This is not a claim of optimal operation; missing data may limit the assessment.");
    }
    return result();
}
