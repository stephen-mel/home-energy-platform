import type { ReconciliationResult } from "../lib/tesla-tariff/reconciliation";
import type { PriceWindow } from "../lib/tariff/types";
import { formatLocalDateTime } from "../lib/presentation/local-time";

const copy = {
    "in-sync": ["Kraken and Powerwall are in sync", "No change to the managed SMART price signal is needed within this review period."],
    "update-required": ["Charging schedule changed", "Kraken’s latest smart charging schedule changes the cheap-energy periods your Powerwall should see."],
    indeterminate: ["Waiting for fresh information", "HEP is waiting for the latest charging schedule and Tesla tariff information before checking whether your Powerwall price signal needs updating."],
    blocked: ["Price signal needs review", "HEP can see an economic change but cannot safely construct or validate the required Powerwall price signal."],
} as const;
const blockers: Record<string, string> = {
    BUY_BELOW_SELL: "Tesla may raise an import price that is lower than the export price.",
    ROLLBACK_UNPROVEN: "Automatic restoration has not been proven.",
    BOUNDED_FORECAST: "This forecast covers a limited period, not an enduring tariff.",
    RESTORATION_REQUIRED: "A safe restoration plan is still required.",
    OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED: "Tesla’s observed tariff representation still has unverified assumptions.",
    EXACT_PROPOSAL_APPROVAL_REQUIRED: "An exact proposal would require separate human approval.",
    INSUFFICIENT_VALIDITY_REMAINING: "There is too little time left to use this proposal safely.",
};
function price(w: PriceWindow): string {
    if (w.priceStatus !== "known" || !w.price) return "Rate unknown";
    const { amount, currency, unit } = w.price;
    // Shift the supplied decimal text, avoiding binary multiplication artefacts
    // or rounding away observed precision (e.g. 25.177p versus 25.18p).
    const match = String(amount).match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (currency === "GBP" && match) {
        const fraction = match[3] ?? "";
        const minor = BigInt(match[2] + fraction.padEnd(2, "0").slice(0, 2));
        const rest = fraction.slice(2);
        return `${match[1]}${minor}${rest ? `.${rest}` : ""}p/${unit}`;
    }
    return `${amount} ${currency}/${unit}`;
}

/** Presentation only: statuses and changed intervals come from reconciliation.
 * No fetch, clock, reconciliation, approval or executable representation here.
 */
export function energyOptimisationView(result: ReconciliationResult | null, timeZone: string) {
    const status = result?.status ?? "indeterminate";
    const complete = result && "freshness" in result ? result : null;
    const time = (value: string) => formatLocalDateTime(value, timeZone, true);
    const range = (start: string, end: string) => `${time(start)} → ${time(end)}`;
    const rows = (windows: PriceWindow[], periods: Array<{ start: string; end: string }>) =>
        windows.flatMap(w => periods.flatMap(p => {
            const start = Math.max(Date.parse(w.start), Date.parse(p.start));
            const end = Math.min(Date.parse(w.end), Date.parse(p.end));
            return start < end ? [`${range(new Date(start).toISOString(), new Date(end).toISOString())} · ${price(w)}`] : [];
        }));
    const changed = complete?.comparison.changedPeriods?.filter(p => p.channels.includes("import")) ?? [];
    const unmanaged = complete?.unmanaged.differences ?? [];
    const unmanagedImport = unmanaged.some(p => p.channels.includes("import"));
    const [title, summary] = copy[status];
    return {
        status, title: status === "in-sync" && unmanagedImport ? "No managed SMART update identified" : title, summary,
        checked: complete ? time(complete.freshness.generatedAt) : null,
        availability: !result ? "Tesla tariff observations and a reconciliation result are not yet connected to this dashboard. This section does not fetch or refresh them automatically." : null,
        current: complete ? rows(complete.observed.signal.import, changed) : [],
        proposed: complete ? rows(complete.managed.target.import, changed) : [],
        comparisonNote: "Only intervals with a managed import-price change are shown. Other base and export prices are preserved.",
        ownershipNote: unmanagedImport ? "Other import differences are preserved. Without retained evidence of a previously represented SMART period and its underlying Tesla tariff, HEP cannot safely remove or restore that period. This review is not ready for confirmation." : null,
        evidence: complete ? [
            `Review period: ${range(complete.domain.start, complete.domain.end)}`,
            `Kraken snapshot: ${time(complete.freshness.krakenObservedAt)} · age at review ${complete.freshness.evidenceAgeSeconds}s (limit ${complete.freshness.evidenceTtlSeconds}s).`,
            `Tesla observation: ${time(complete.freshness.teslaObservedAt)} · age at review ${complete.freshness.captureAgeSeconds}s (limit ${complete.freshness.captureTtlSeconds}s).`,
            `Review expires: ${time(complete.freshness.expiresAt)}. A new review is required after expiry; this snapshot does not refresh itself.`,
            ...complete.evidence.currentDispatches.map(d => `${d.assetName || d.assetId} · ${d.type} · ${range(d.start, d.end)} · planned/conditional`),
        ] : [],
        managed: complete ? complete.managed.ownership.filter(p => p.basis !== "unmanaged")
            .map(p => `${range(p.start, p.end)} · ${p.basis === "current-smart" ? "Current SMART opportunity" : "Previously represented SMART period"}`) : [],
        unmanaged: complete ? unmanaged.flatMap(p => p.channels.map(channel => ({
            channel,
            observed: rows(complete.observed.signal[channel], [p]),
            hep: rows(complete.hep[channel], [p]),
        }))) : [],
        fingerprint: complete?.proposal?.fingerprint ?? null,
        diagnostics: (result?.blockers ?? []).map(code => ({ code, description: blockers[code] ?? "This safety requirement remains unresolved." })),
    };
}
