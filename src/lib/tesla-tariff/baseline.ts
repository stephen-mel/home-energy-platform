import { resolveEffectiveTariff } from "../tariff/effective-tariff";
import { buildPriceCurve } from "../tariff/price-signal";
import { effectivePriceCurveKey } from "../tariff/compare-price-signal";
import type { EnergyPrice, PriceSignal, TariffConfig } from "../tariff/types";
import { dryRunTeslaTariff, type Diagnostic, type TeslaTariffFragment } from "./dry-run";

export type AuthorityMode = "observe" | "confirm" | "automatic";
export type HumanVerification = { fingerprint: string; verifiedAt: string; verifierReference: string | null };
export type BaselineState = "requires-human-verification" | "human-verified" | "blocked";

// No auth/config envelopes are retained. Audit identifiers are non-sensitive references.
function reference(value: string): string {
    if (!/^[A-Za-z0-9_. /()-]{1,160}$/.test(value) || /token|secret|password|bearer|private.?key|oauth/i.test(value)) throw new Error("A non-sensitive reference is required");
    return value;
}
function instant(value: string): string {
    if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("An explicit timestamp with timezone is required");
    return new Date(value).toISOString();
}
function price(value: EnergyPrice | null): EnergyPrice | null {
    return value && Number.isFinite(value.amount) && /^[A-Z]{3}$/.test(value.currency) && value.unit === "kWh"
        ? { amount: value.amount, currency: value.currency, unit: "kWh" } : null;
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(value);
}

export type BaselineRecord = ReturnType<typeof createTariffBaseline>;
/** A bounded HEP-owned base tariff, without transient Kraken dispatch overlays. */
export function createTariffBaseline(input: {
    baselineId: string;
    sourceReference: string;
    asOf: string;
    tariff: TariffConfig;
    horizon: { start: string; end: string };
    authority?: AuthorityMode;
}) {
    const asOf = instant(input.asOf);
    const horizon = { start: instant(input.horizon.start), end: instant(input.horizon.end) };
    if (Date.parse(horizon.end) <= Date.parse(horizon.start)) throw new Error("A positive bounded review horizon is required");
    const timeZone = reference(input.tariff.timeZone);
    new Intl.DateTimeFormat("en-GB", { timeZone });
    // Copy only tariff fields needed for base economics; never spread site config.
    const tariff: TariffConfig = { timeZone, normalImport: null, export: null,
        versions: input.tariff.versions?.map(v => ({
            id: reference(v.id), name: reference(v.name), provider: reference(v.provider),
            effectiveFrom: instant(v.effectiveFrom), effectiveTo: instant(v.effectiveTo), pricesIncludeVat: v.pricesIncludeVat === true,
            normalImport: price(v.normalImport), export: price(v.export), scheduledChargingImport: price(v.scheduledChargingImport),
            standingCharge: null, // Not part of marginal economics or the representation.
            dailyImportWindows: v.dailyImportWindows.map(w => ({ start: /^\d\d:\d\d$/.test(w.start) ? w.start : "invalid",
                end: /^\d\d:\d\d$/.test(w.end) ? w.end : "invalid", price: price(w.price), kind: w.kind })),
        })) };
    const matching = (tariff.versions ?? []).filter(v => Date.parse(v.effectiveFrom) <= Date.parse(asOf) && Date.parse(v.effectiveTo) > Date.parse(asOf));
    const version = matching.length === 1 ? matching[0] : null;
    const resolved = resolveEffectiveTariff(tariff, horizon);
    const signal: PriceSignal = { scope: "whole-home", generatedAt: asOf, horizon,
        import: buildPriceCurve(horizon, null, resolved.import), export: buildPriceCurve(horizon, null, resolved.export) };
    const translation = dryRunTeslaTariff(signal, { timeZone });
    const tariffIdentity = version ? { id: version.id, name: version.name, provider: version.provider } : null;
    const effectivePeriod = version ? { start: version.effectiveFrom, end: version.effectiveTo } : null;
    const proposed = translation.candidate;
    const binding = { schema: 1, tariffIdentity, effectivePeriod, timeZone,
        economicKey: effectivePriceCurveKey(signal), proposed };
    // Exact deterministic JSON key, not a cryptographic signature or auth proof.
    const fingerprint = canonical(binding);
    const diagnostics: Diagnostic[] = [...translation.diagnostics];
    const review = { tariffIdentity, effectivePeriod, timeZone,
        periods: proposed.periods.map(p => ({ localDate: p.localDate, fromMinute: p.fromMinute, toMinute: p.toMinute,
            utcOffset: p.utcOffset, importPrice: p.buy, exportEconomicValue: p.sell, importKind: p.importKind })),
        diagnostics };
    const reviewable = !!version && !!proposed.tariffContentV2Fragment
        && Date.parse(horizon.start) >= Date.parse(version.effectiveFrom) && Date.parse(horizon.end) <= Date.parse(version.effectiveTo);
    if (!reviewable) diagnostics.push({ code: "BASELINE_NOT_REVIEWABLE", severity: "error",
        message: "A known single effective tariff and an inspectable representation covering the review horizon within its validity are required." });
    const authority = input.authority ?? "confirm";
    if (!["observe", "confirm", "automatic"].includes(authority)) throw new Error("Unknown authority mode");
    return {
        version: 1 as const, baselineId: reference(input.baselineId), sourceReference: reference(input.sourceReference), asOf,
        tariffIdentity, effectivePeriod, timeZone, truth: signal, proposed, fingerprint, review,
        diagnostics,
        compatibilityBlockers: diagnostics.filter(d => d.severity === "error"),
        warnings: diagnostics.filter(d => d.severity === "warning"),
        state: (reviewable ? "requires-human-verification" : "blocked") as BaselineState,
        verification: null as HumanVerification | null,
        authority: { requestedMode: authority, effectiveMode: authority === "observe" ? "observe" as const : "confirm" as const,
            automaticExecutionImplemented: false as const },
        observedTeslaState: null,
        rollbackProven: false as const, inspectionOnly: true as const, writeReady: false as const, writePayload: null,
    };
}

function currentFingerprint(record: BaselineRecord) {
    return canonical({ schema: 1, tariffIdentity: record.tariffIdentity, effectivePeriod: record.effectivePeriod,
        timeZone: record.timeZone, economicKey: effectivePriceCurveKey(record.truth), proposed: record.proposed });
}
export function isBaselineHumanVerified(record: BaselineRecord): boolean {
    return record.state === "human-verified" && record.verification !== null
        && record.verification.fingerprint === record.fingerprint && record.fingerprint === currentFingerprint(record);
}

/** Explicit confirmation binds the exact inspected representation, never a boolean.
 * Compatibility blockers remain intact; this confirms review, not permission to send.
 */
export function verifyTariffBaseline(record: BaselineRecord, confirmation: {
    fingerprint: string; verifiedAt: string; verifierReference?: string;
}): BaselineRecord {
    if (record.state === "blocked" || confirmation.fingerprint !== record.fingerprint || currentFingerprint(record) !== record.fingerprint)
        throw new Error("The exact current reviewable representation must be confirmed");
    const verifiedAt = instant(confirmation.verifiedAt);
    if (Date.parse(verifiedAt) < Date.parse(record.asOf)) throw new Error("Verification cannot predate the review snapshot");
    return { ...record, state: "human-verified", verification: { fingerprint: record.fingerprint, verifiedAt,
        verifierReference: confirmation.verifierReference === undefined ? null : reference(confirmation.verifierReference) } };
}

/** Bridge to experiment preparation: human review is never rollback proof.
 * A future proven-written/read-back evidence variant requires a separate implementation.
 */
export function baselineExperimentContext(record?: BaselineRecord) {
    return {
        kind: record && isBaselineHumanVerified(record) ? "hep-human-verified-baseline" as const : "unknown-tesla-configuration" as const,
        baselineId: record ? reference(record.baselineId) : null,
        fingerprint: record ? currentFingerprint(record) : null,
        rollbackProven: false as const, rollbackRepresentation: null,
        requiredFutureEvidence: ["explicit-write", "tesla-read-back", "verified-recorded-result"] as const,
        blockers: [{ code: "ROLLBACK_UNPROVEN", message: "Human verification is not proof that this baseline was written to Tesla and verified by read-back." }],
    };
}

/** Future experiment evidence contract only: v1 cannot construct or validate the
 * proven-written variant, nor use it to remove a rollback blocker.
 */
export type ExperimentBaselineEvidence =
    | ReturnType<typeof baselineExperimentContext>
    | { kind: "hep-baseline-proven-written"; baselineId: string; fingerprint: string;
        energySiteId: string; writeRecordedAt: string; readBackVerifiedAt: string;
        exactRepresentation: TeslaTariffFragment; readBackEvidenceReference: string };
