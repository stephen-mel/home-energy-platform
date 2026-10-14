import type { EnergyPrice, PriceSignal, PriceWindow } from "../tariff/types";

export type EnergyIntervalReading = {
    start: string;
    end: string;
    importKwh: number | null;
    exportKwh: number | null;
    quality: "measured" | "estimated";
};

export type FinancialValue = {
    status: "unavailable" | "partial" | "calculated" | "estimated";
    amount: number | null;
    currency: string | null;
    basis: "no-energy-data" | "calculated-from-measured-energy" | "contains-estimates" | "partial-coverage";
};

export type ElectricityFinancialOverview = {
    period: { start: string; end: string };
    importCost: FinancialValue;
    exportEarnings: FinancialValue;
    netCost: FinancialValue;
    coverage: { importPercent: number; exportPercent: number; measured: boolean; complete: boolean };
    rates: { import: EnergyPrice[]; export: EnergyPrice[] };
    future: { solarSavings: null; batterySavings: null; investmentPayback: null };
    limitations: string[];
};

const unavailable = (): FinancialValue => ({ status: "unavailable", amount: null, currency: null, basis: "no-energy-data" });
const time = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const validPrice = (price: EnergyPrice | null): price is EnergyPrice => !!price && Number.isFinite(price.amount)
    && /^[A-Z]{3}$/.test(price.currency) && price.unit === "kWh";
const key = (price: EnergyPrice) => `${price.amount}\0${price.currency}\0${price.unit}`;
const rounded = (value: number) => Number(value.toFixed(12));

function qualifying(window: PriceWindow, start: number, end: number) {
    if (window.condition === "none") return { usable: true, estimated: false };
    const periods = window.eligibilityPeriods.filter(period => time(period.start)! <= start && time(period.end)! >= end);
    if (periods.some(period => period.state === "billed-verified" || period.state === "observed-qualified"))
        return { usable: true, estimated: false };
    if (periods.some(period => period.state === "planned-conditional")) return { usable: true, estimated: true };
    return { usable: false, estimated: false };
}

function rateFor(windows: PriceWindow[], start: number, end: number) {
    const overlaps = windows.filter(window => time(window.start)! < end && time(window.end)! > start)
        .sort((a, b) => time(a.start)! - time(b.start)!);
    let cursor = start, price: EnergyPrice | null = null, estimated = false;
    for (const window of overlaps) {
        const from = Math.max(start, time(window.start)!), to = Math.min(end, time(window.end)!);
        if (from !== cursor || to <= from || window.stale || window.priceStatus !== "known" || !validPrice(window.price)) return null;
        const eligibility = qualifying(window, from, to);
        if (!eligibility.usable || price && key(price) !== key(window.price)) return null;
        price ??= window.price; estimated ||= eligibility.estimated; cursor = to;
    }
    return cursor === end && price ? { price: { ...price }, estimated } : null;
}

function channel(readings: EnergyIntervalReading[], windows: PriceWindow[], period: { start: number; end: number }, field: "importKwh" | "exportKwh") {
    let amount = 0, covered = 0, estimated = false, currency: string | null = null, previousEnd = period.start;
    const relevant = readings.flatMap(reading => {
        const start = time(reading.start), end = time(reading.end), energy = reading[field];
        return start !== null && end !== null && start >= period.start && end <= period.end && end > start
            && energy !== null && Number.isFinite(energy) && energy >= 0 ? [{ reading, start, end, energy }] : [];
    }).sort((a, b) => a.start - b.start);
    for (const item of relevant) {
        if (item.start < previousEnd) return { value: unavailable(), covered: 0 };
        const rate = rateFor(windows, item.start, item.end);
        if (!rate || currency && currency !== rate.price.currency) continue;
        amount += item.energy * rate.price.amount;
        covered += item.end - item.start;
        currency ??= rate.price.currency;
        estimated ||= item.reading.quality === "estimated" || rate.estimated;
        previousEnd = item.end;
    }
    if (!covered || !currency) return { value: unavailable(), covered: 0 };
    const complete = covered === period.end - period.start;
    return { covered, value: {
        status: estimated ? "estimated" as const : complete ? "calculated" as const : "partial" as const,
        amount: rounded(amount), currency,
        basis: estimated ? "contains-estimates" as const : complete
            ? "calculated-from-measured-energy" as const : "partial-coverage" as const,
    } };
}

function distinctRates(windows: PriceWindow[], start: number, end: number) {
    const values = new Map<string, EnergyPrice>();
    for (const window of windows) if (time(window.start)! < end && time(window.end)! > start
        && window.priceStatus === "known" && validPrice(window.price)) values.set(key(window.price), { ...window.price });
    return [...values.values()];
}

function overlappingReadings(readings: EnergyIntervalReading[], period: { start: number; end: number }) {
    const intervals = readings.map(reading => ({ start: time(reading.start), end: time(reading.end) }))
        .filter((reading): reading is { start: number; end: number } => reading.start !== null && reading.end !== null
            && reading.start >= period.start && reading.end <= period.end && reading.end > reading.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    return intervals.some((reading, index) => index > 0 && reading.start < intervals[index - 1].end);
}

/** Pure calculation over supplied interval energy and an already validated price signal. */
export function calculateElectricityFinancialOverview(input: {
    period: { start: string; end: string };
    signal: PriceSignal;
    readings: EnergyIntervalReading[];
    dataLimitations?: string[];
}): ElectricityFinancialOverview {
    const start = time(input.period.start), end = time(input.period.end);
    if (start === null || end === null || end <= start) throw new Error("INVALID_FINANCIAL_PERIOD");
    const readings = structuredClone(input.readings);
    const temporalConflict = overlappingReadings(readings, { start, end });
    const imported = temporalConflict ? { value: unavailable(), covered: 0 }
        : channel(readings, input.signal.import, { start, end }, "importKwh");
    const exported = temporalConflict ? { value: unavailable(), covered: 0 }
        : channel(readings, input.signal.export, { start, end }, "exportKwh");
    const duration = end - start;
    const importPercent = rounded(imported.covered / duration * 100), exportPercent = rounded(exported.covered / duration * 100);
    let netCost = unavailable();
    if (imported.value.amount !== null && exported.value.amount !== null
        && imported.value.currency === exported.value.currency && importPercent === 100 && exportPercent === 100) {
        const estimated = imported.value.status === "estimated" || exported.value.status === "estimated";
        netCost = { status: estimated ? "estimated" : "calculated", amount: rounded(imported.value.amount - exported.value.amount),
            currency: imported.value.currency, basis: estimated ? "contains-estimates" : "calculated-from-measured-energy" };
    }
    const result: ElectricityFinancialOverview = {
        period: { ...input.period }, importCost: imported.value, exportEarnings: exported.value, netCost,
        coverage: { importPercent, exportPercent,
            measured: readings.length > 0 && readings.every(reading => reading.quality === "measured"),
            complete: importPercent === 100 && exportPercent === 100 },
        rates: { import: distinctRates(input.signal.import, start, end), export: distinctRates(input.signal.export, start, end) },
        future: { solarSavings: null, batterySavings: null, investmentPayback: null },
        limitations: [
            "Costs require interval energy readings; instantaneous power is not converted into energy.",
            "Planned conditional SMART pricing is labelled as an estimate until qualification or billing evidence exists.",
            ...(temporalConflict ? ["Overlapping energy readings conflict, so financial totals are unavailable."] : []),
            ...(input.dataLimitations ?? []),
            "Solar savings, battery savings and investment payback are not calculated in this stage.",
        ],
    };
    return Object.freeze(structuredClone(result));
}
