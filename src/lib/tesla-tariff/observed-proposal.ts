import type { PriceSignal } from "../tariff/types";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { planTeslaTariffSync } from "./sync-planner";
import type { ObservedTariff } from "./observed-tariff";
import { simulateObservedSmartDate } from "./observed-simulation";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { representationKey } from "./rollback-evidence";

export type ObservedSmartInput = {
    observation: ObservedTariff;
    generatedAt: string;
    // Original, exact source boundaries; a changed dispatch must be reselected.
    dispatch: { assetId: string; start: string; end: string };
    previousSignal: PriceSignal;
    comparisonDomain: { start: string; end: string };
};

/** Pure preparation for the existing proposal model, never an approval mechanism.
 * Rebuild from the observation + current signal, not a caller-supplied simulation.
 * v1 deliberately supports one same-local-date SMART interval, with an optional
 * midnight end. Unsupported/ambiguous intervals fail closed rather than rounding.
 */
export function prepareObservedSmart(input: ObservedSmartInput, signal: PriceSignal, energySiteId: string, timeZone: string) {
    const blockers: string[] = [];
    const { observation, dispatch } = input;
    const start = Date.parse(dispatch.start), end = Date.parse(dispatch.end), generated = Date.parse(input.generatedAt);
    const fail = (code: string) => ({ representation: null, simulation: null, syncPlan: null, dispatchEvidenceKey: null,
        localValidity: null, blockers: [...blockers, code], structurallyValid: false });
    if (![start, end, generated, Date.parse(observation.source.observedAt)].every(Number.isFinite)
        || end <= start || generated >= end || generated < Date.parse(observation.source.observedAt)
        || start % 60000 || end % 60000) return fail("INVALID_SMART_VALIDITY");
    if (observation.source.kind !== "tesla-site-info" || observation.source.energySiteId !== energySiteId
        || observation.source.timeZone !== timeZone) return fail("OBSERVATION_TARGET_MISMATCH");
    if (!inspectObservedProposalTariff(observation.tariff).exact || observation.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED"))
        return fail("OBSERVATION_INEXACT");
    const checked = comparePriceSignalsInDomain(signal, signal, { start: dispatch.start, end: dispatch.end });
    if (checked.status === "indeterminate") return fail(checked.diagnostic.code);
    if (Date.parse(input.comparisonDomain.start) > start || Date.parse(input.comparisonDomain.end) < end)
        return fail("COMMON_DOMAIN_UNAVAILABLE");
    const windows = checked.projected.current.import;
    const matches = (cause: { assetId: string; start: string; end: string; dispatchType: string } | undefined) =>
        cause?.assetId === dispatch.assetId && cause.start === dispatch.start && cause.end === dispatch.end && cause.dispatchType === "SMART";
    const evidence = windows.flatMap(w => w.eligibilityPeriods.filter(p => p.sources.some(s => s.provider === "kraken" && matches(s.cause))));
    // Require unbroken per-period planned evidence attributable to this dispatch.
    const ranges = evidence.map(p => [Date.parse(p.start), Date.parse(p.end)]).sort((a, b) => a[0] - b[0]);
    let cursor = start;
    for (const [from, to] of ranges) { if (from > cursor) return fail("SMART_EVIDENCE_UNAVAILABLE"); cursor = Math.max(cursor, to); }
    if (cursor < end || evidence.some(p => p.state !== "planned-conditional") || windows.some(w => w.condition !== "scheduled-ev-charging"))
        return fail("SMART_EVIDENCE_UNAVAILABLE");
    const price = windows[0]?.price;
    if (!price || windows.some(w => representationKey(w.price) !== representationKey(price))) return fail("SMART_PRICE_NOT_UNIFORM");
    if (windows.some(w => w.stale || w.sources.some(s => s.stale))) blockers.push("STALE_EVIDENCE");
    let format: Intl.DateTimeFormat;
    try { format = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
    catch { return fail("INVALID_TIMEZONE"); }
    const local = (time: number) => {
        const parts = format.formatToParts(time), part = (type: string) => parts.find(p => p.type === type)!.value;
        return { date: `${part("year")}-${part("month")}-${part("day")}`, minute: Number(part("hour")) * 60 + Number(part("minute")) };
    };
    const a = local(start), b = local(end), last = local(end - 60000);
    const toMinute = b.date === a.date ? b.minute : b.minute === 0 && last.date === a.date ? 1440 : -1;
    if (toMinute <= a.minute || (toMinute - a.minute) * 60000 !== end - start) return fail("UNSUPPORTED_LOCAL_SMART_INTERVAL");
    const simulation = simulateObservedSmartDate(observation, { date: a.date, fromMinute: a.minute, toMinute,
        buy: price.amount, currency: price.currency, compareDates: [] });
    const inspected = inspectObservedProposalTariff(simulation.simulated?.tariff);
    if (!inspected.exact) return fail("REPRESENTATION_UNAVAILABLE");
    const syncPlan = planTeslaTariffSync({ signal, previousSignal: input.previousSignal, comparisonDomain: input.comparisonDomain, timeZone });
    if (syncPlan.comparison.state === "indeterminate") blockers.push("COMMON_DOMAIN_UNAVAILABLE");
    // Preserve all production blockers. Complete observed season coverage does not
    // turn bounded HEP knowledge into an annual economic truth or guarantee expiry.
    blockers.push(...syncPlan.compatibility.blockers.map(d => d.code), "RESTORATION_REQUIRED", "OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED");
    if (simulation.status === "simulation-only" && simulation.after.diagnostics.includes("BUY_BELOW_SELL")) blockers.push("BUY_BELOW_SELL");
    return { representation: inspected.tariff, simulation, syncPlan, structurallyValid: true,
        dispatchEvidenceKey: representationKey({ dispatch, evidence }),
        localValidity: { timeZone, date: a.date, fromMinute: a.minute, toMinute, start: dispatch.start, end: dispatch.end },
        blockers: [...new Set(blockers)] };
}
