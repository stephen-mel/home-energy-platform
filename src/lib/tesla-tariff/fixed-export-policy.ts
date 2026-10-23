import type { SiteIntegrationConfig } from "../site/config";
import type { ObservedTariff } from "./observed-tariff";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { ownershipFingerprint } from "./ownership-transition";
import { validOwnershipTimestamp } from "./ownership-evidence";

export type FixedExportAssumption = NonNullable<SiteIntegrationConfig["kraken"]["fixedExportAssumption"]>;

const blocked = (code: string) => ({ status: "blocked" as const, code, evidence: null,
    exportRepresentation: null, exportFingerprint: null });
const object = (value: unknown): value is Record<string, unknown> => value !== null
    && typeof value === "object" && !Array.isArray(value);

/**
 * Pure SMART-import policy boundary. It validates a user-confirmed commercial
 * export fact against the complete authenticated Tesla representation. It does
 * not establish supplier account/MPAN identity and grants no execution authority.
 */
export function validateFixedExportPolicy(input: {
    assumption: unknown;
    observation: ObservedTariff | null;
    assessedAt: string;
}) {
    let detached: unknown;
    try { detached = structuredClone(input.assumption); } catch { return blocked("FIXED_EXPORT_EVIDENCE_INVALID"); }
    const assumption = detached as FixedExportAssumption | null;
    if (!object(assumption) || Object.keys(assumption).sort().join() !== ["confirmedAt", "price", "provider", "tariff", "validFrom", "validTo"].sort().join()
        || assumption.provider !== "eon-next" || assumption.tariff !== "Export Premium v3"
        || !object(assumption.price) || Object.keys(assumption.price).sort().join() !== "amount,currency,unit"
        || assumption.price.amount !== 0.175 || assumption.price.currency !== "GBP" || assumption.price.unit !== "kWh"
        || !validOwnershipTimestamp(assumption.validFrom) || !validOwnershipTimestamp(assumption.validTo)
        || !validOwnershipTimestamp(assumption.confirmedAt)
        || Date.parse(assumption.validFrom) >= Date.parse(assumption.validTo)
        || Date.parse(assumption.confirmedAt) < Date.parse(assumption.validFrom)
        || Date.parse(assumption.confirmedAt) >= Date.parse(assumption.validTo))
        return blocked("FIXED_EXPORT_EVIDENCE_INVALID");
    if (!validOwnershipTimestamp(input.assessedAt)) return blocked("FIXED_EXPORT_ASSESSMENT_TIME_INVALID");
    const assessedAt = Date.parse(input.assessedAt);
    if (assessedAt < Date.parse(assumption.confirmedAt) || assessedAt < Date.parse(assumption.validFrom)
        || assessedAt >= Date.parse(assumption.validTo)) return blocked("FIXED_EXPORT_EVIDENCE_OUTSIDE_VALIDITY");
    let inspected;
    try { inspected = inspectObservedProposalTariff(input.observation?.tariff); }
    catch { return blocked("OBSERVED_EXPORT_REPRESENTATION_UNSUPPORTED"); }
    if (!input.observation || !inspected.exact || !inspected.tariff
        || input.observation.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED"))
        return blocked("OBSERVED_EXPORT_REPRESENTATION_UNSUPPORTED");
    const sell = inspected.tariff.sell_tariff;
    if (sell.currency !== assumption.price.currency) return blocked("OBSERVED_EXPORT_TARIFF_MISMATCH");
    const rates = Object.values(sell.energy_charges).flatMap(charge => Object.values(charge.rates ?? {}));
    if (!rates.length || rates.some(rate => rate !== assumption.price.amount))
        return blocked("OBSERVED_EXPORT_TARIFF_MISMATCH");
    const exportRepresentation = structuredClone(sell);
    return {
        status: "verified" as const,
        code: null,
        evidence: structuredClone(assumption),
        exportRepresentation,
        exportFingerprint: ownershipFingerprint(exportRepresentation),
        identityScope: "user-confirmed-commercial-export-not-account-or-mpan-proof" as const,
        executionReady: false as const,
    };
}
