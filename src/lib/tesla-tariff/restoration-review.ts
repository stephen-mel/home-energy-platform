import { inspectObservedProposalTariff } from "./experiment-tariff";
import { analyseObservedDates, priceAt, type ObservedTariff, type ObservedContent } from "./observed-tariff";
import { representationKey, assessRollbackEvidence } from "./rollback-evidence";
import { baselineExperimentContext, type BaselineRecord } from "./baseline";
import { assessProposalCurrentUse, type Proposal } from "./proposal-approval";

/** Inspect paired buy/sell prices at every recurring date/weekday/time boundary.
 * A witness establishes a constraint risk, not what Tesla will actually do.
 */
function pricingWitness(tariff: ObservedContent) {
    const points = new Set([0, 1440]);
    for (const side of [tariff, tariff.sell_tariff]) for (const season of Object.values(side.seasons))
        for (const tou of Object.values(season.tou_periods)) for (const p of tou.periods) {
            points.add((p.fromHour ?? 0) * 60 + (p.fromMinute ?? 0));
            points.add((p.toHour ?? 0) * 60 + (p.toMinute ?? 0) || 1440);
        }
    const bounds = [...points].sort((a, b) => a - b);
    for (let day = 0; day < 366; day++) {
        const date = new Date(Date.UTC(2000, 0, day + 1)), month = date.getUTCMonth() + 1, d = date.getUTCDate();
        for (let weekday = 0; weekday < 7; weekday++) for (let i = 0; i < bounds.length - 1; i++) {
            const buy = priceAt(tariff, month, d, weekday, bounds[i]).amount;
            const sell = priceAt(tariff.sell_tariff, month, d, weekday, bounds[i]).amount;
            if (tariff.currency === tariff.sell_tariff.currency && buy !== null && sell !== null && buy < sell)
                return { month, day: d, weekday, fromMinute: bounds[i], toMinute: bounds[i + 1], buy, sell, currency: tariff.currency };
        }
    }
    return null;
}

/** Inspection of the existing models only. Does not create trusted rollback
 * observations, approve a proposal, change a baseline, or expose an executor.
 */
export function reviewObservedRestoration(input: {
    before: ObservedTariff; temporaryProposal: Proposal; asOf: string; maxCaptureAgeMs: number; baseline?: BaselineRecord;
}) {
    const { before, temporaryProposal: proposal } = input;
    const inspected = inspectObservedProposalTariff(before.tariff);
    const lossless = inspected.exact && !before.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED");
    const candidate = lossless ? inspected.tariff : null;
    const captured = Date.parse(before.source.observedAt), now = Date.parse(input.asOf);
    const identityValid = before.source.kind === "tesla-site-info" && before.source.energySiteId === proposal.bound.energySiteId
        && before.source.timeZone === proposal.bound.timeZone && Number.isFinite(captured) && Number.isFinite(now) && captured <= now;
    const fresh = identityValid && Number.isFinite(input.maxCaptureAgeMs) && input.maxCaptureAgeMs >= 0 && now - captured <= input.maxCaptureAgeMs;
    const observationMatchesProposal = proposal.bound.observationKey === representationKey(before);
    const mappingFindings: Array<{ code: string; detail: string }> = [];
    if (!lossless) mappingFindings.push({ code: "CAPTURE_INEXACT", detail: "Unsupported, omitted or invalid fields prevent an exact structural candidate." });
    if (candidate) {
        const sides = [candidate, candidate.sell_tariff];
        const sparse = sides.some(side => Object.values(side.seasons).some(s => Object.values(s.tou_periods).some(t => t.periods.some(p =>
            ["fromDayOfWeek", "toDayOfWeek", "fromHour", "toHour", "fromMinute", "toMinute"].some(k => !(k in p))))));
        if (sparse) mappingFindings.push({ code: "SPARSE_DEFAULTS_UNDOCUMENTED", detail: "Coverage analysis infers zero for absent TOU fields. Candidate leaves them absent; the documentation example uses explicit fields and does not establish these defaults." });
        if (candidate.sell_tariff.version === undefined) mappingFindings.push({ code: "SELL_VERSION_ABSENT_PRESERVED", detail: "No sell version is invented. Tesla's example also omits it; absence is not by itself proof of incomplete capture." });
        mappingFindings.push({ code: "EXAMPLE_NOT_EXHAUSTIVE_SCHEMA", detail: "Tesla's example includes additional billing fields (daily/monthly charges and demand limits). Their requiredness/defaults and the completeness of site_info as an inverse settings view are not specified. No absent fields are fabricated." });
        mappingFindings.push({ code: "FIELDS_PRESERVED", detail: "Season labels/dates, sparse periods, code, identities, currency, prices and zero/empty demand charges retain their captured values. Canonical object-key ordering changes no field values; original JSON bytes are not retained." });
    }
    mappingFindings.push({ code: "SITE_TIMEZONE_CONTEXT", detail: "Timezone and site ID are bound outside the tariff body. No timezone write or inference from season labels is performed." });
    const witness = candidate ? pricingWitness(candidate) : null;
    const rollback = assessRollbackEvidence({ energySiteId: before.source.energySiteId, representation: candidate, now: input.asOf, maxAgeMs: input.maxCaptureAgeMs });
    const safety = assessProposalCurrentUse({ approvedProposal: proposal, currentProposal: proposal, approval: null,
        now: input.asOf, targetEnergySiteId: before.source.energySiteId, authority: "observe",
        rollback: { representation: candidate, maxAgeMs: input.maxCaptureAgeMs } });
    const bound = { energySiteId: before.source.energySiteId, timeZone: before.source.timeZone, capturedAt: before.source.observedAt,
        provenance: { source: before.source.kind, observationKey: lossless && identityValid ? representationKey(before) : null,
            authenticationProof: "not-established-by-caller-supplied-record" as const },
        representationKey: candidate ? representationKey(candidate) : null,
        temporaryProposalFingerprint: proposal.fingerprint };
    const blockers = [...rollback.blockers, ...safety.blockers, "INVERSE_WRITE_MAPPING_UNPROVEN", "RESTORE_ACCEPTANCE_UNPROVEN"];
    if (!lossless) blockers.push("CAPTURE_INEXACT");
    if (!identityValid || !observationMatchesProposal) blockers.push("BEFORE_STATE_BINDING_MISMATCH");
    if (!fresh) blockers.push("BEFORE_STATE_RECAPTURE_REQUIRED");
    if (witness) blockers.push("BUY_BELOW_SELL", "RESTORATION_PRICE_TRANSFORMATION_RISK");
    return {
        bound, fingerprint: representationKey(bound), structurallyComplete: lossless,
        boundToProposal: identityValid && observationMatchesProposal, captureFresh: fresh,
        // A documented envelope shape for inspection, not a validated command.
        documentedEnvelopeCandidate: candidate ? { tou_settings: { tariff_content_v2: candidate } } : null,
        mappingFindings, pricingConstraintWitness: witness,
        exactWriteMappingProven: false as const, acceptanceProven: false as const, rollbackProven: rollback.proven,
        baselineContext: baselineExperimentContext(input.baseline), proposalSafety: safety,
        blockers: [...new Set(blockers)],
        lifecycle: [
            { stage: "capture-before", status: "observed-only", requiredEvidence: ["fresh authenticated site-bound capture immediately before any change", "no intervening tariff change", "durable exact representation and provenance binding"] },
            { stage: "temporary-proposal", status: "inspection-only", requiredEvidence: ["current dispatch and exact human approval", "all existing compatibility and rollback gates"] },
            { stage: "temporary-write", status: "not-performed", requiredEvidence: ["separately authorised executor and authenticated acknowledgement bound to site/request/time"] },
            { stage: "temporary-read-back", status: "not-performed", requiredEvidence: ["new authenticated capture after acknowledgement", "exact representation plus local timeline comparison", "detect price normalization; never assume success from acknowledgement"] },
            { stage: "restore-before", status: "not-performed", requiredEvidence: ["same immutable captured representation", "separate restore acknowledgement", "abort/reconcile any intervening external change"] },
            { stage: "restore-read-back-verify", status: "not-performed", requiredEvidence: ["new authenticated capture after restore", "exact fingerprint and timeline verification including buy/sell", "record failure if transformed; trusted server evidence ledger required for future proof"] },
        ],
        inspectionOnly: true as const, writeReady: false as const, writePayload: null, executorAvailable: false as const,
    };
}

/** Shared observation check for either transaction read-back. Never establishes
 * causation, write acknowledgement or trusted rollback evidence from a GET alone.
 */
export function compareObservedTariffReadBack(input: {
    intended: ObservedTariff; readBack: ObservedTariff | null; after: string; dates: string[];
}) {
    const { intended, readBack } = input;
    const a = inspectObservedProposalTariff(intended.tariff), b = inspectObservedProposalTariff(readBack?.tariff);
    let validTimeZone = false;
    try { if (intended.source.timeZone) { new Intl.DateTimeFormat("en-GB", { timeZone: intended.source.timeZone }); validTimeZone = true; } }
    catch { /* A malformed observed timezone is insufficient evidence. */ }
    const sufficient = validTimeZone && a.exact && b.exact && !!readBack && readBack.source.kind === "tesla-site-info"
        && ![...intended.diagnostics, ...readBack.diagnostics].includes("UNSUPPORTED_FIELDS_OMITTED")
        && intended.source.energySiteId === readBack.source.energySiteId && !!intended.source.timeZone
        && intended.source.timeZone === readBack.source.timeZone && Number.isFinite(Date.parse(input.after))
        && Date.parse(input.after) >= Date.parse(intended.source.observedAt) && Date.parse(readBack.source.observedAt) > Date.parse(input.after);
    const before = sufficient ? analyseObservedDates(intended, input.dates) : null;
    const after = sufficient ? analyseObservedDates(readBack!, input.dates) : null;
    const differences: Array<{ date: string; start: string; end: string; expectedBuy: number | null; actualBuy: number | null;
        expectedSell: number | null; actualSell: number | null; buyRaisedToSell: boolean }> = [];
    for (const day of before?.days ?? []) for (const p of day.periods) for (const q of after!.days.find(d => d.date === day.date)!.periods) {
        const start = Math.max(Date.parse(p.start), Date.parse(q.start)), end = Math.min(Date.parse(p.end), Date.parse(q.end));
        if (start >= end || p.buy === q.buy && p.sell === q.sell && p.buyCurrency === q.buyCurrency && p.sellCurrency === q.sellCurrency) continue;
        differences.push({ date: day.date, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
            expectedBuy: p.buy, actualBuy: q.buy, expectedSell: p.sell, actualSell: q.sell,
            buyRaisedToSell: p.buy !== null && p.sell !== null && p.buy < p.sell && q.buy === p.sell && q.sell === p.sell
                && p.buyCurrency === q.buyCurrency && p.sellCurrency === q.sellCurrency });
    }
    const exact = sufficient && representationKey(a.tariff) === representationKey(b.tariff);
    return { outcome: !sufficient ? "insufficient-evidence" : exact ? "exact-observed-match" : "different-observed-representation",
        representationMatches: !!exact, differences,
        timelineScope: { dates: [...input.dates], complete: !!before && !!after && input.dates.length > 0
            && before.days.length === new Set(input.dates).size && !before.diagnostics.includes("INVALID_CALENDAR_DATE") },
        writeAcceptance: "not-established" as const, causation: "not-inferred" as const,
        rollbackProven: false as const, blockers: ["ROLLBACK_UNPROVEN"], writeReady: false as const };
}
