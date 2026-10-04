import { createHash } from "node:crypto";
import type { EnergyPrice } from "../tariff/types";
import { comparePriceSignalsInDomain } from "../tariff/comparison-domain";
import { observedEconomicSignal } from "./observed-economic";
import type { ObservedTariff } from "./observed-tariff";
import { assertOwnership, validOwnership, validOwnershipTimestamp, type ManagedImportEvidence, type OwnedImportInterval } from "./ownership-evidence";
import { representationKey } from "./rollback-evidence";

export const ownershipFingerprint = (value: unknown) => createHash("sha256").update(representationKey(value)).digest("hex");
export type AuthorisedImportChange = { start: string; end: string; price: EnergyPrice };
export type OwnershipTransitionInput = {
    before: ObservedTariff; after: ObservedTariff; previous: ManagedImportEvidence | null;
    domain: { start: string; end: string }; authorised: AuthorisedImportChange[];
    submittedAt: string;
};

/** Containment only: no confirmation, economic coverage or persistence authority. */
export function checkOwnershipDomain(input: {
    previous: Readonly<Omit<ManagedImportEvidence, "intervals">> & { readonly intervals: readonly OwnedImportInterval[] } | null;
    domain: { start: string; end: string }; asOf: string;
}) {
    try {
        const { previous, domain, asOf } = input;
        if (![domain.start, domain.end, asOf].every(validOwnershipTimestamp)
            || Date.parse(domain.end) <= Date.parse(domain.start) || (previous !== null && !validOwnership(previous)))
            return { status: "rejected" as const, code: "INVALID_TRANSITION" as const };
        const start = Date.parse(domain.start), end = Date.parse(domain.end), now = Date.parse(asOf);
        if (previous?.intervals.some(p => Date.parse(p.end) > now &&
            (Math.max(now, Date.parse(p.start)) < start || Date.parse(p.end) > end)))
            return { status: "rejected" as const, code: "OWNERSHIP_DOMAIN_INCOMPLETE" as const };
        return { status: "complete" as const };
    } catch { return { status: "rejected" as const, code: "INVALID_TRANSITION" as const }; }
}

/** Pure interval kernel. Callers must independently establish confirmation and
 * authorisation; this is not an ownership receipt or a persistence entry point.
 * Replacement and selected-SMART callers can supply their own truthful scopes.
 */
export function deriveOwnershipTransition(input: OwnershipTransitionInput) {
    try {
        const { before, after, previous, domain, authorised, submittedAt } = structuredClone(input);
        if (![domain.start, domain.end, submittedAt, ...authorised.flatMap(p => [p.start, p.end])].every(validOwnershipTimestamp)
            || Date.parse(domain.end) <= Date.parse(domain.start)
            || before.source.energySiteId !== after.source.energySiteId || before.source.timeZone !== after.source.timeZone)
            throw Error("INVALID_TRANSITION");
        if (previous) assertOwnership(previous, before, submittedAt);
        const start = Date.parse(domain.start), end = Date.parse(domain.end), now = Date.parse(submittedAt);
        const containment = checkOwnershipDomain({ previous, domain, asOf: submittedAt });
        if (containment.status === "rejected") throw Error(containment.code);
        let last = start;
        for (const p of authorised) {
            const a = Date.parse(p.start), b = Date.parse(p.end);
            if (a < last || b <= a || b > end || !p.price || !Number.isFinite(p.price.amount)
                || !/^[A-Z]{3}$/.test(p.price.currency) || p.price.unit !== "kWh") throw Error("INVALID_AUTHORISED_SCOPE");
            last = b;
        }
        const comparison = comparePriceSignalsInDomain(observedEconomicSignal(before, domain).signal,
            observedEconomicSignal(after, domain).signal, domain);
        if (comparison.status === "indeterminate") throw Error("OWNERSHIP_DOMAIN_INCOMPLETE");
        const a = comparison.projected.previous, b = comparison.projected.current;
        const points = [...new Set([start, end, now, ...[...a.import, ...b.import, ...a.export, ...b.export,
            ...authorised, ...(previous?.intervals ?? [])].flatMap(p => [Date.parse(p.start), Date.parse(p.end)])]
            .filter(t => t >= start && t <= end))].sort((x, y) => x - y);
        const intervals: OwnedImportInterval[] = [];
        // Historical prefixes are retained as history only, never extended.
        for (const old of previous?.intervals ?? []) {
            if (Date.parse(old.start) < start) intervals.push({ ...old, end: new Date(Math.min(start, Date.parse(old.end))).toISOString() });
            if (Date.parse(old.start) >= end) intervals.push(old);
        }
        for (let i = 0; i < points.length - 1; i++) {
            const from = points[i], to = points[i + 1];
            const at = <T extends {start: string; end: string}>(ws: T[]) => ws.find(w => Date.parse(w.start) <= from && Date.parse(w.end) >= to);
            const beforePrice = at(a.import)!.price!, afterPrice = at(b.import)!.price!;
            const allowed = at(authorised), old = at(previous?.intervals ?? []);
            if (representationKey(at(a.export)!.price) !== representationKey(at(b.export)!.price)) throw Error("UNMANAGED_EXPORT_CHANGED");
            const changed = representationKey(beforePrice) !== representationKey(afterPrice);
            if (allowed ? representationKey(allowed.price) !== representationKey(afterPrice) : changed) throw Error("UNAUTHORISED_IMPORT_CHANGE");
            if (old && to > now && representationKey(old.applied) !== representationKey(beforePrice)) throw Error("MANAGED_IMPORT_OWNERSHIP_CONFLICT");
            if (old && (!allowed || to <= now)) {
                intervals.push({ ...old, start: new Date(from).toISOString(), end: new Date(to).toISOString() });
                continue;
            }
            const restore = old?.restore ?? beforePrice;
            if (!old && (!allowed || !changed || to <= now)) continue;
            if (representationKey(afterPrice) === representationKey(restore)) continue;
            // Never attribute an already elapsed unowned prefix to a later write.
            const ownedStart = old ? from : Math.max(from, now);
            intervals.push({ start: new Date(ownedStart).toISOString(), end: new Date(to).toISOString(), applied: afterPrice,
                restore, restoreBaselineFingerprint: old?.restoreBaselineFingerprint ?? ownershipFingerprint(before.tariff) });
        }
        intervals.sort((a,b) => Date.parse(a.start) - Date.parse(b.start));
        // Coalesce only identical lineage and economics. No rounding or time expansion.
        const merged: OwnedImportInterval[] = [];
        for (const p of intervals) {
            const prev = merged.at(-1);
            if (prev && Date.parse(prev.end) === Date.parse(p.start) && prev.restoreBaselineFingerprint === p.restoreBaselineFingerprint
                && representationKey(prev.applied) === representationKey(p.applied) && representationKey(prev.restore) === representationKey(p.restore)) prev.end = p.end;
            else merged.push(p);
        }
        return { status: "derived" as const, intervals: merged };
    } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "INVALID_TRANSITION";
        return { status: "rejected" as const, code };
    }
}
