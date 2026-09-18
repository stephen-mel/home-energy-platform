// Monetary amounts use major currency units per kWh (e.g. GBP 0.10/kWh).
// null means unknown, never free. Zero and negative prices remain valid prices.
export type EnergyPrice = { amount: number; currency: string; unit: "kWh" };

export type PriceSource = {
    provider: string;
    description: string;
    // Source snapshot timestamp, not evidence that EV charging occurred.
    observedAt: string | null;
    stale: boolean;
    // Retain the causing schedule separately from the resulting tariff window.
    cause?: {
        kind: "ev-dispatch";
        assetId: string;
        assetName?: string;
        start: string;
        end: string;
        dispatchType: string;
    };
};

// Evidence of tariff eligibility is independent of source freshness and price knowledge.
// Only future evidence adapters may supply observed-qualified or billed-verified.
export type EligibilityState =
    | "planned-conditional" // A schedule indicates a possible rate; the condition is unproven.
    | "observed-qualified" // Evidence establishes that the required condition occurred.
    | "billed-verified"; // Billing evidence confirms that the tariff actually applied.
export type EligibilityPeriod = {
    // Coverage within the assessment period, clipped to the original dispatch/horizon.
    // Partial coverage does NOT qualify the entire assessment period.
    start: string;
    end: string;
    assessmentPeriod: { start: string; end: string };
    state: EligibilityState;
    sources: PriceSource[];
};

export type PriceWindow = {
    start: string;
    end: string;
    price: EnergyPrice | null;
    priceStatus: "known" | "unknown" | "conflicting";
    kind: "standard" | "cheap-opportunity";
    condition: "none" | "scheduled-ev-charging";
    stale: boolean;
    sources: PriceSource[];
    // Per-source assessments may overlap (e.g. two EVs). A grouped forecast has no
    // blanket eligibility state; these periods retain each cause independently.
    eligibilityPeriods: EligibilityPeriod[];
};

// Providers can supply arbitrary dated curves, not just cheap/peak bands.
export type PriceInputWindow = Omit<PriceWindow, "priceStatus" | "stale" | "eligibilityPeriods"> & {
    // Omission means no eligibility evidence, not qualification. Provider-specific
    // assessment cadence; the generic curve does not assume all tariffs are half-hourly.
    eligibility?: { state: EligibilityState; intervalMinutes: number };
};
export type TariffConfig = {
    timeZone: string;
    normalImport: EnergyPrice | null;
    export: EnergyPrice | null;
    importWindows?: PriceInputWindow[];
    exportWindows?: PriceInputWindow[];
};

export type PriceSignal = {
    scope: "whole-home";
    generatedAt: string;
    horizon: { start: string; end: string };
    import: PriceWindow[];
    export: PriceWindow[];
};
