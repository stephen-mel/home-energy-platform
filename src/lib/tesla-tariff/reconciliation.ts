import { managedSmartTarget, type ManagedImportEvidence } from "./managed-smart";
import type { Site } from "../site/types";
import type { KrakenState } from "../site/kraken-state";
import { getSitePriceSignal } from "../site/get-site-price-signal";
import { instant } from "../tariff/price-signal";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import type { ObservedTariff } from "./observed-tariff";
import { monetarySignal, observedEconomicSignal } from "./observed-economic";
import { planTeslaTariffSync } from "./sync-planner";
import { createTariffProposal } from "./proposal-approval";
import { reviewObservedRestoration } from "./restoration-review";
import { inspectObservedProposalTariff } from "./experiment-tariff";
import { CAPTURE_TTL_MS, EVIDENCE_TTL_MS, APPROVAL_TTL_MS, MIN_WRITE_REMAINING_MS, smartEvidenceKey } from "./supervised-experiment";

export type ReconciliationInput = {
    site: Site;
    energySiteId: string;
    kraken: KrakenState;
    previousKraken?: KrakenState;
    managedImport?: ManagedImportEvidence;
    observation: ObservedTariff;
    now: string;
    comparisonDomain: { start: string; end: string };
};
const productionBlockers = ["ROLLBACK_UNPROVEN", "BOUNDED_FORECAST", "RESTORATION_REQUIRED", "OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED",
    "INVERSE_WRITE_MAPPING_UNPROVEN", "RESTORE_ACCEPTANCE_UNPROVEN", "RESTORATION_PRICE_TRANSFORMATION_RISK", "EXACT_PROPOSAL_APPROVAL_REQUIRED"];

/** Confirm preparation only. Supplied snapshots/configuration, no I/O or approval.
 * `update-required` means an economic replacement is proposed, NOT permission to
 * submit it. Production blockers (including BUY_BELOW_SELL) are never waived.
 */
export function reconcileTeslaTariff(input: ReconciliationInput) {
    const safety = { authority: "confirm" as const, inspectionOnly: true as const, writeReady: false as const,
        rollbackProven: false as const, humanApproved: false as const, writePayload: null };
    const fail = (code: string) => ({ ...safety, status: "indeterminate" as const, diagnostic: code,
        requestedDomain: input.comparisonDomain, blockers: [...productionBlockers, code], proposal: null });
    try {
        const now = instant(input.now), start = instant(input.comparisonDomain.start), end = instant(input.comparisonDomain.end);
        if (![now, start, end].every(Number.isFinite) || end <= start || end <= now || end - Math.max(now, start) > 48 * 3600000)
            return fail("INVALID_OR_EXPIRED_DOMAIN");
        if (!/^\d+$/.test(input.energySiteId) || input.observation.source.kind !== "tesla-site-info"
            || input.observation.source.energySiteId !== input.energySiteId || !input.site.tariff
            || input.site.tariff.timeZone !== input.observation.source.timeZone) return fail("OBSERVATION_TARGET_MISMATCH");
        const krakenAt = instant(input.kraken.lastSuccessfulUpdate), captureAt = instant(input.observation.source.observedAt);
        if (!Number.isFinite(krakenAt) || krakenAt > now || now - krakenAt > EVIDENCE_TTL_MS || input.kraken.stale !== false) return fail("STALE_KRAKEN_EVIDENCE");
        if (!Number.isFinite(captureAt) || captureAt > now || now - captureAt > CAPTURE_TTL_MS) return fail("STALE_TESLA_CAPTURE");
        if (!inspectObservedProposalTariff(input.observation.tariff).exact || input.observation.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")) return fail("OBSERVATION_INEXACT");
        const domain = { start: new Date(Math.max(start, now)).toISOString(), end: new Date(end).toISOString() };
        const scheduled = (state: KrakenState) => state.vehicles.flatMap(v => v.plannedDispatches.filter(d => d.type === "SMART")
            .map(d => ({ assetId: v.id, assetName: v.name, ...d })));
        const dispatches = scheduled(input.kraken);
        if (dispatches.some(d => !Number.isFinite(instant(d.start)) || !Number.isFinite(instant(d.end)) || instant(d.end) <= instant(d.start)))
            return fail("INVALID_SMART_EVIDENCE");
        const hep = getSitePriceSignal(input.site, input.kraken, input.now).signal;
        const validated = comparePriceSignalsInDomain(hep, hep, domain);
        if (validated.status === "indeterminate") return fail(validated.diagnostic.code);
        if ([...validated.projected.current.import, ...validated.projected.current.export].some(w => w.stale || w.sources.some(s => s.stale))) return fail("STALE_EVIDENCE");
        const observed = observedEconomicSignal(input.observation, domain);
        const comparison = comparePriceSignalsInDomain(observed.signal, monetarySignal(validated.projected.current), domain);
        if (comparison.status === "indeterminate") return fail(comparison.diagnostic.code);
        const managedScope = { baseSignal: getSitePriceSignal(input.site, null, input.now).signal, previous: input.managedImport };
        let managed;
        try { managed = managedSmartTarget(hep, input.observation, domain, managedScope); }
        catch (error) { return fail(error instanceof Error ? error.message : "MANAGED_SCOPE_UNAVAILABLE"); }
        const exactPlanner = planTeslaTariffSync({ previousSignal: observed.signal, signal: monetarySignal(validated.projected.current),
            comparisonDomain: domain, timeZone: input.site.tariff.timeZone });
        const planner = planTeslaTariffSync({ previousSignal: observed.signal, signal: monetarySignal(managed.target),
            comparisonDomain: domain, timeZone: input.site.tariff.timeZone });
        const currentKey = smartEvidenceKey(input.kraken);
        const previousKey = input.previousKraken ? smartEvidenceKey(input.previousKraken) : null;
        const expiry = Math.min(now + APPROVAL_TTL_MS, captureAt + CAPTURE_TTL_MS, krakenAt + EVIDENCE_TTL_MS, end,
            ...dispatches.map(d => instant(d.end)).filter(t => t > now));
        const common = { ...safety, requestedDomain: input.comparisonDomain, domain,
            ignoredPastUntil: start < now ? domain.start : null, hep, observed,
            comparison: planner.comparison, exactComparison: exactPlanner.comparison,
            managed: { ownership: managed.ownership, target: managed.target },
            unmanaged: { comparison: managed.unmanaged, differences: planTeslaTariffSync({ previousSignal: monetarySignal(managed.target),
                signal: monetarySignal(validated.projected.current), comparisonDomain: domain, timeZone: input.site.tariff.timeZone }).comparison.changedPeriods },
            evidence: { previousKey, currentKey, changed: previousKey === null ? null : previousKey !== currentKey,
                currentDispatches: dispatches, previousDispatches: input.previousKraken ? scheduled(input.previousKraken) : null, state: "planned-conditional" as const },
            freshness: { generatedAt: input.now, krakenObservedAt: input.kraken.lastSuccessfulUpdate,
                teslaObservedAt: input.observation.source.observedAt, expiresAt: new Date(expiry).toISOString(),
                captureAgeSeconds: (now - captureAt) / 1000, evidenceAgeSeconds: (now - krakenAt) / 1000,
                captureTtlSeconds: CAPTURE_TTL_MS / 1000, evidenceTtlSeconds: EVIDENCE_TTL_MS / 1000 },
            limitations: ["Exact comparison includes export; only managed SMART import divergence triggers replacement.",
                "Comparison-only monetary views do not promote planned charging or establish billing eligibility.",
                "Removing old SMART periods requires explicit represented-signal and underlying observed-baseline evidence; price resemblance alone establishes no ownership.",
                "Proposals require new exact approval and fresh validation; this result grants no execution authority."] };
        const blockers = [...new Set([...productionBlockers, ...planner.compatibility.blockers.map(d => d.code), ...exactPlanner.compatibility.blockers.map(d => d.code)])];
        if (planner.comparison.state === "unchanged") return { ...common, status: "in-sync" as const, proposal: null, blockers };
        const proposal = createTariffProposal({ proposalId: "confirm-tariff-reconciliation", energySiteId: input.energySiteId,
            purpose: "tariff-sync", timeZone: input.site.tariff.timeZone, validFrom: input.now, expiresAt: new Date(expiry).toISOString(),
            signal: hep, observedReplacement: { observation: input.observation, generatedAt: input.now,
                comparisonDomain: domain, dispatchEvidenceKey: currentKey, managedScope } });
        const restoration = reviewObservedRestoration({ before: input.observation, temporaryProposal: proposal,
            asOf: input.now, maxCaptureAgeMs: CAPTURE_TTL_MS });
        blockers.push(...proposal.compatibilityBlockers, ...restoration.blockers);
        if (expiry - now <= MIN_WRITE_REMAINING_MS) blockers.push("INSUFFICIENT_VALIDITY_REMAINING");
        return { ...common, status: proposal.structurallyValid && expiry - now > MIN_WRITE_REMAINING_MS ? "update-required" as const : "blocked" as const,
            proposal, restoration, blockers: [...new Set(blockers)], warnings: proposal.sourceDiagnostics.filter(d => d.severity === "warning") };
    } catch { return fail("INVALID_RECONCILIATION_INPUT"); }
}

export type ReconciliationResult = ReturnType<typeof reconcileTeslaTariff>;
