import type { PriceSource } from "./types";

export type Period = { start: string; end: string };
export type Direction = "import" | "export";
// Canonical decimal strings in major currency units; never presentation-rounded.
export type SourcePrice = {
    amount: string; currency: string; unit: "kWh" | "day";
    basis: "tax-exclusive" | "tax-inclusive" | "observed-external";
    taxId?: string;
};
export type EvidenceSubject = {
    agreementId: string; supplyRef: string; supplier: string;
    direction: Direction; productCode: string; tariffCode: string;
};
export type EvidenceClaim =
    | { role: "agreement-identity" | "agreement-validity" }
    | { role: "economic-version" | "schedule-definition"; versionId: string }
    | { role: "energy-rate" | "standing-charge"; versionId: string; rateId: string }
    | { role: "tax-treatment"; taxId: string }
    | { role: "conditional-rule-definition"; versionId: string; ruleId: string }
    | { role: "conditional-dispatch-occurrence"; ruleId: string; assetId: string; dispatchType: string; start: string; end: string };
export type EvidenceRole = EvidenceClaim["role"];
export type EconomicEvidence = {
    id: string; provider: string;
    subject: EvidenceSubject; claims: EvidenceClaim[];
    kind: "supplier-agreement" | "supplier-rates" | "supplier-bill" | "manual" | "tesla-observation" | "authenticated-dispatch";
    observedAt: string; freshness: "fresh" | "stale" | "unknown";
    coverage: Period[];
};
export type SupplyAgreement = {
    id: string; supplyRef: string; direction: Direction;
    supplier: string; productCode: string; tariffCode: string;
    validFrom: string | null; validTo: string | null;
    status: "active" | "future" | "revoked" | "terminated" | "replaced";
    // Explicit effective early cutoff; status alone is not a guessed timestamp.
    invalidatedAt: string | null; evidenceIds: string[];
};
export type RateDefinition = {
    id: string; validity: Period; price: SourcePrice; evidenceIds: string[];
};
export type TaxTreatment = {
    id: string; validity: Period; fraction: string; evidenceIds: string[];
};
export type SchedulePeriod = {
    rateId: string;
    local: { kind: "all-day" } | { kind: "daily"; start: string; end: string };
    overlayPolicy: "preserve" | "replace";
    compatibility?: "guaranteed-off-peak";
};
export type ConditionalPriceRule = {
    id: string; rateId: string; validity: Period; evidenceIds: string[];
    dispatchType: string; provider: string;
    qualification: "provider-defined" | "physical-charging-required";
    // Only the existing conservative Drive Smart condition has a lossless legacy projection.
    compatibility: "drive-smart" | null;
};
export type EconomicVersion = {
    id: string; agreementId: string; validity: Period; evidenceIds: string[];
    rates: RateDefinition[]; schedule: SchedulePeriod[];
    standingRateId: string | null; conditionalRules: ConditionalPriceRule[];
};
export type ConditionalInterval = Period & {
    ruleId: string; agreementId: string; evidenceId: string;
    cause: NonNullable<PriceSource["cause"]>;
};
// Deliberately not an input to economic resolution. Neither commands nor power
// observations manufacture dispatches, qualification, or delivered energy.
export type PhysicalDeliveryEvidence = {
    observedAt: string; assetId: string;
    observation: { kind: "command"; outcome: "succeeded" | "failed" }
        | { kind: "power"; kw: number }
        | { kind: "delivered-energy"; kwh: number; period: Period }
        | { kind: "site-grid-energy"; kwh: number; period: Period };
};
export type EconomicModel = {
    timeZone: string; agreements: SupplyAgreement[]; versions: EconomicVersion[];
    taxes: TaxTreatment[]; evidence: EconomicEvidence[];
};
export type ResolvedEconomicPeriod = Period & {
    direction: Direction; versionId: string | null; rateId: string | null;
    priceStatus: "known" | "unknown" | "conflicting";
    consumerPrice: { amount: string; currency: string; unit: "kWh" | "day" } | null;
    sourcePrice: SourcePrice | null;
    tax: TaxTreatment | null;
    sources: PriceSource[]; diagnostics: string[];
    conditional: { rule: ConditionalPriceRule; intervals: ConditionalInterval[]; state: "planned-conditional" } | null;
    protected: boolean;
    compatibilityKind: "standard" | "guaranteed-off-peak";
};
