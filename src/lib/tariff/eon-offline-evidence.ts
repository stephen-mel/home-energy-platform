import type { EconomicEvidence, EconomicModel, Period, RateDefinition, SupplyAgreement, TaxTreatment } from "./economic-model";
import { economicInstant, resolveEconomicModel, type EconomicResolution } from "./resolve-economic-model";
import { decimalParts } from "./economic-decimal";

/** Sanitised supplier observations, not an API response or an authority capability.
 * Evidence claims already identify their precise canonical targets; this adapter
 * never upgrades an evidence kind or infers claims from transport/provider names.
 */
export type EonOfflineEvidence = {
    agreements: SupplyAgreement[];
    agreementMetadata: { agreementId: string; productName: string; ratesAgreedAt: string | null }[];
    evidence: EconomicEvidence[];
    taxes: TaxTreatment[];
    windows: {
        versionId: string; agreementId: string; period: Period; evidenceIds: string[];
        energy: RateDefinition; standing: RateDefinition | null;
        rateType: string; // Retained provenance only, never used for price/schedule selection.
    }[];
    transport: { evidenceId: string; via: "kraken" | "supplier-document" | "manual-transcription" }[];
    observations: {
        id: string; kind: "incomplete-export" | "historical-smart-bill";
        supplier: "E.ON Next"; productName: string; coverage: Period[];
        observedAt: string; amount: string | null; currency: "GBP"; unit: "kWh";
    }[];
};
export type EonOfflineResult = {
    status: "resolved" | "partial" | "invalid";
    diagnostics: string[];
    model: EconomicModel | null;
    resolution: EconomicResolution | null;
    provenance: Pick<EonOfflineEvidence, "transport" | "observations" | "agreementMetadata"> & {
        rateTypes: { versionId: string; rateType: string }[];
    };
};

// Reject exotic mutable values and cycles before detachment. Output is plain data.
function plainData(value: unknown, path = new Set<object>()): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || path.has(value)) throw Error("INVALID_OFFLINE_INPUT");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw Error("INVALID_OFFLINE_INPUT");
    path.add(value);
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw Error("INVALID_OFFLINE_INPUT");
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (!('value' in descriptor)) throw Error("INVALID_OFFLINE_INPUT");
        plainData(descriptor.value, path);
    }
    path.delete(value);
}
function freeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}
const periodValid = (p: Period) => Number.isFinite(economicInstant(p?.start))
    && economicInstant(p?.end) > economicInstant(p.start);

/** All-day here means constant *inside this finite observed window*, not a
 * recurring tariff promise. No schedule, dispatch or tax evidence is invented.
 */
export function adaptEonOfflineEvidence(input: EonOfflineEvidence, horizon: Period, generatedAt: string): EonOfflineResult {
    const invalid = (): EonOfflineResult => freeze({ status: "invalid", diagnostics: ["INVALID_OFFLINE_INPUT"],
        model: null, resolution: null, provenance: { transport: [], observations: [], agreementMetadata: [], rateTypes: [] } });
    try {
        plainData(input);
        const data: EonOfflineEvidence = structuredClone(input);
        if (Object.keys(data).sort().join() !== ["agreementMetadata", "agreements", "evidence", "observations", "taxes", "transport", "windows"].join()
            || !Object.values(data).every(Array.isArray)) return invalid();
        if (data.agreementMetadata.some(m => !data.agreements.some(a => a.id === m.agreementId) || !m.productName
                || (m.ratesAgreedAt !== null && !Number.isFinite(economicInstant(m.ratesAgreedAt))))
            || data.agreements.some(a => a.supplier !== "E.ON Next")
            || data.windows.some(w => typeof w.rateType !== "string" || !periodValid(w.period)
                || w.energy.price.unit !== "kWh" || w.energy.price.basis === "observed-external"
                || (w.standing !== null && (w.standing.price.unit !== "day" || w.standing.price.basis === "observed-external")))
            || data.transport.some(t => !data.evidence.some(e => e.id === t.evidenceId)
                || !["kraken", "supplier-document", "manual-transcription"].includes(t.via))
            || data.observations.some(o => !["incomplete-export", "historical-smart-bill"].includes(o.kind)
                || o.supplier !== "E.ON Next" || !o.id || !o.productName || o.currency !== "GBP" || o.unit !== "kWh"
                || !Number.isFinite(economicInstant(o.observedAt)) || economicInstant(o.observedAt) > economicInstant(generatedAt)
                || !Array.isArray(o.coverage) || !o.coverage.every(periodValid)
                || (o.amount !== null && !decimalParts(o.amount)))) return invalid();
        const model: EconomicModel = { timeZone: "Europe/London", agreements: data.agreements,
            taxes: data.taxes, evidence: data.evidence, versions: data.windows.map(w => ({
                id: w.versionId, agreementId: w.agreementId, validity: w.period, evidenceIds: w.evidenceIds,
                rates: [w.energy, ...(w.standing === null ? [] : [w.standing])],
                schedule: [{ rateId: w.energy.id, local: { kind: "all-day" }, overlayPolicy: "preserve" }],
                standingRateId: w.standing?.id ?? null, conditionalRules: [],
            })) };
        const resolution = resolveEconomicModel(model, horizon, generatedAt);
        const diagnostics = [...resolution.diagnostics, ...data.observations.map(o =>
            o.kind === "incomplete-export" ? "EXPORT_AGREEMENT_UNRESOLVED" : "BILL_NOT_DISPATCH_OR_SCHEDULE_EVIDENCE")];
        const status = resolution.status === "invalid" ? "invalid" : diagnostics.length
            || resolution.periods.some(p => p.priceStatus !== "known") ? "partial" : "resolved";
        return freeze({ status, diagnostics, model: status === "invalid" ? null : model, resolution,
            provenance: { transport: data.transport, observations: data.observations, agreementMetadata: data.agreementMetadata,
                rateTypes: data.windows.map(w => ({ versionId: w.versionId, rateType: w.rateType })) } });
    } catch {
        return invalid(); // Never return caller data or raw exceptions on malformed input.
    }
}
