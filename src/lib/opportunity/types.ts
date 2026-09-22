import type { EnergyPrice, PriceSignal, PriceWindow } from "../tariff/types";

export type Freshness = "fresh" | "stale" | "unknown";
export type Reading = {
    value: number | null;
    freshness: Freshness;
    source: string;
    observedAt: string | null;
};
export type OpportunityTelemetry = {
    solarKw?: Reading;
    houseLoadKw?: Reading;
    // Positive imports, negative exports. Input adapters must declare polarity.
    gridImportKw?: Reading;
    batteries?: Array<{
        id: string;
        name: string;
        socPercent?: Reading;
        // Positive supplies the home; negative flows into storage.
        powerToHomeKw?: Reading;
    }>;
};
export type ExportContext = {
    capability?: "available" | "unavailable" | "unknown";
    actualTariff?: { status: "active" | "pending" | "none" | "unknown"; price: EnergyPrice | null };
    // Default is the HEP export curve's economic value, NOT a claim of payment.
    economicValue?: { kind: "signal" } | { kind: "override"; price: EnergyPrice | null };
};
export type OpportunityInput = {
    signal: PriceSignal;
    now: string;
    telemetry?: OpportunityTelemetry;
    exportContext?: ExportContext;
    // Policy in major currency/kWh; default 0 means any strictly positive spread.
    minimumSpreadPerKwh?: number;
};
export type InsightType = "cheap-import-ahead" | "smart-opportunity" | "expensive-import-exposure"
    | "gross-import-spread" | "gross-export-spread" | "export-value" | "stored-energy-context"
    | "no-additional-opportunity";
export type Insight = {
    id: string;
    type: InsightType;
    window: { start: string; end: string };
    financial: {
        basis: "gross-price-spread" | "instantaneous-export-economic-value" | "context-only";
        currency: string | null;
        grossSpreadPerKwh: number | null;
        // Instantaneous power × configured economic value, not a revenue forecast.
        instantaneousValuePerHour: number | null;
    };
    evidence: {
        prices: Array<{ role: "current-import" | "lower-import" | "later-import" | "export-value"; window: PriceWindow }>;
        telemetry: Array<{ role: string; reading: Reading }>;
        tariffStates: Array<"configured" | "guaranteed" | "unknown" | "planned-conditional" | "observed-qualified" | "billed-verified">;
        freshness: Freshness;
        exportContext: ExportContext | null;
        limitations: string[];
    };
    assetId?: string;
    explanation: string;
};
export type OpportunityResult = {
    asOf: string;
    objective: "household-energy-cost-value";
    insights: Insight[];
    limitations: string[];
};
