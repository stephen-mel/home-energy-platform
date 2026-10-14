import "server-only";
import type { EnergyIntervalReading } from "./electricity-overview";
import { getHomeAssistantCounterHistory, getHomeAssistantFiveMinuteStatistics, getHomeAssistantState } from "../home-assistant/client";

const FIVE_MINUTES = 300_000, HALF_HOUR = 1_800_000, EPSILON = 1e-7;
type Ports = { state(id: string): Promise<unknown>; statistics(ids: string[], start: string, end: string): Promise<unknown>;
    history(ids: string[], start: string, end: string): Promise<unknown> };
export type MeasuredEnergyResult = { readings: EnergyIntervalReading[]; diagnostics: string[] };
const production: Ports = { state: getHomeAssistantState, statistics: getHomeAssistantFiveMinuteStatistics,
    history: getHomeAssistantCounterHistory };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const instant = (value: unknown) => typeof value === "number" && Number.isFinite(value)
    && Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000 ? value
    : typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const close = (a: number, b: number) => Math.abs(a - b) <= EPSILON;

function validateMetadata(raw: unknown, expected: string) {
    if (!plain(raw) || raw.entity_id !== expected || !plain(raw.attributes)
        || raw.attributes.unit_of_measurement !== "kWh" || raw.attributes.device_class !== "energy"
        || raw.attributes.state_class !== "total_increasing") throw new Error("INVALID_ENERGY_SENSOR_METADATA");
}

function validateChannel(raw: unknown, rawHistory: unknown, id: string, start: number, end: number) {
    if (!plain(raw) || !Array.isArray(raw[id]) || !Array.isArray(rawHistory)) throw new Error("INVALID_ENERGY_STATISTICS");
    const rows = raw[id].map((item: unknown) => {
        if (!plain(item)) throw new Error("INVALID_ENERGY_STATISTICS");
        const bucketStart = instant(item.start), bucketEnd = instant(item.end), change = number(item.change), sum = number(item.sum), state = number(item.state);
        if (bucketStart === null || bucketEnd === null || change === null || sum === null || state === null
            || bucketEnd - bucketStart !== FIVE_MINUTES || bucketStart % FIVE_MINUTES !== 0 || change < 0)
            throw new Error("INVALID_ENERGY_STATISTICS");
        return { start: bucketStart, end: bucketEnd, change, sum, state };
    }).sort((a, b) => a.start - b.start);
    if (rows.some((row, index) => index && row.start <= rows[index - 1].start)) throw new Error("DUPLICATE_ENERGY_BUCKET");
    for (let index = 1; index < rows.length; index++) {
        if (rows[index].start < rows[index - 1].end || rows[index].state < rows[index - 1].state
            || rows[index].start === rows[index - 1].end
            && !close(rows[index].sum - rows[index - 1].sum, rows[index].change)) throw new Error("INCONSISTENT_CUMULATIVE_STATISTICS");
    }
    const series = rawHistory.find((entry: unknown) => Array.isArray(entry) && entry.some(item => plain(item) && item.entity_id === id));
    if (!Array.isArray(series) || series.length === 0) throw new Error("MISSING_COUNTER_HISTORY");
    let previous: number | null = null, first: number | null = null;
    for (const sample of series) {
        if (!plain(sample) || sample.entity_id !== id || typeof sample.state !== "string") throw new Error("INVALID_COUNTER_HISTORY");
        const value = Number(sample.state);
        if (!Number.isFinite(value) || value < 0 || previous !== null && value < previous) throw new Error("COUNTER_RESET_OR_INVALID");
        first ??= value; previous = value;
    }
    const statisticsBaseline = rows.length ? rows[0].sum - rows[0].change : null;
    if (first === null || previous === null || statisticsBaseline === null
        || !close(previous, rows[rows.length - 1].state)
        || !close(previous - first, rows[rows.length - 1].sum - statisticsBaseline))
        throw new Error("COUNTER_STATISTICS_MISMATCH");
    return new Map(rows.filter(row => row.start >= start && row.end <= end).map(row => [row.start, row.change]));
}

export async function getMeasuredGridEnergy(input: { importEntityId: string; exportEntityId: string;
    period: { start: string; end: string } }, ports: Ports = production): Promise<MeasuredEnergyResult> {
    const start = Date.parse(input.period.start), end = Date.parse(input.period.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start % HALF_HOUR || end % HALF_HOUR
        || !input.importEntityId || !input.exportEntityId || input.importEntityId === input.exportEntityId)
        return { readings: [], diagnostics: ["INVALID_MEASURED_ENERGY_REQUEST"] };
    const ids = [input.importEntityId, input.exportEntityId], guard = new Date(start - FIVE_MINUTES).toISOString();
    try {
        const [importState, exportState, statisticsResult, historyResult] = await Promise.allSettled([
            ports.state(ids[0]), ports.state(ids[1]), ports.statistics(ids, guard, input.period.end),
            ports.history(ids, guard, input.period.end),
        ]);
        if (statisticsResult.status === "rejected" || historyResult.status === "rejected")
            throw new Error("MEASURED_ENERGY_RETRIEVAL_FAILED");
        const statistics = statisticsResult.value, history = historyResult.value;
        const channel = (state: PromiseSettledResult<unknown>, id: string) => {
            if (state.status === "rejected") return { values: new Map<number, number>(), error: "ENERGY_SENSOR_UNAVAILABLE" };
            try { validateMetadata(state.value, id); return { values: validateChannel(statistics, history, id, start, end), error: null }; }
            catch (error) { return { values: new Map<number, number>(), error: error instanceof Error ? error.message : "MEASURED_ENERGY_UNAVAILABLE" }; }
        };
        const imported = channel(importState, ids[0]), exported = channel(exportState, ids[1]);
        const readings: EnergyIntervalReading[] = [];
        for (let cursor = start; cursor < end; cursor += HALF_HOUR) {
            const importValues = Array.from({ length: 6 }, (_, i) => imported.values.get(cursor + i * FIVE_MINUTES));
            const exportValues = Array.from({ length: 6 }, (_, i) => exported.values.get(cursor + i * FIVE_MINUTES));
            const completeImport = importValues.every(value => value !== undefined), completeExport = exportValues.every(value => value !== undefined);
            if (completeImport || completeExport) readings.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + HALF_HOUR).toISOString(),
                importKwh: completeImport ? importValues.reduce((sum, value) => sum + value!, 0) : null,
                exportKwh: completeExport ? exportValues.reduce((sum, value) => sum + value!, 0) : null, quality: "measured" });
        }
        return { readings: structuredClone(readings), diagnostics: [
            imported.error && `IMPORT_${imported.error}`, exported.error && `EXPORT_${exported.error}`,
        ].filter((value): value is string => value !== null) };
    } catch (error) {
        return { readings: [], diagnostics: [error instanceof Error ? error.message : "MEASURED_ENERGY_UNAVAILABLE"] };
    }
}
