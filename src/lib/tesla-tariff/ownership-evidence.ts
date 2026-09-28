import type { EnergyPrice } from "../tariff/types";
import type { ObservedTariff } from "./observed-tariff";
import { observedEconomicSignal } from "./observed-economic";
import { representationKey } from "./rollback-evidence";

export type OwnedImportInterval = {
    start: string; end: string;
    restoreBaselineFingerprint: string;
    applied: EnergyPrice;
    restore: EnergyPrice;
};
/** Durable attribution, never approval, billing qualification or rollback proof.
 * Supplied to pure reconciliation only by a trusted server-side store/caller.
 */
export type ManagedImportEvidence = {
    version: 1;
    energySiteId: string;
    timeZone: string;
    createdAt: string;
    updatedAt: string;
    validUntil: string;
    basis: "confirmed-write-readback";
    baselineFingerprint: string;
    readbackFingerprint: string;
    proposalFingerprint: string;
    smartEvidenceFingerprint: string;
    intervals: OwnedImportInterval[];
};
/** Explicit-offset instants at JavaScript's millisecond precision. Validate the
 * written calendar first: Date.parse alone normalizes dates such as February 30.
 */
export function validOwnershipTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match || match[0].length !== value.length) return false;
    const [, y, m, d, h, min, sec, , offsetH, offsetM] = match;
    const year = Number(y), month = Number(m), day = Number(d);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
        && Number(h) <= 23 && Number(min) <= 59 && Number(sec) <= 59
        && (offsetH === undefined || (Number(offsetH) <= 23 && Number(offsetM) <= 59))
        && Number.isFinite(Date.parse(value));
}
const timestamp = validOwnershipTimestamp;
const price = (v: EnergyPrice) => v && typeof v.amount === "number" && Number.isFinite(v.amount)
    && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) && v.unit === "kWh" && Object.keys(v).sort().join() === "amount,currency,unit";
const keys = "baselineFingerprint,basis,createdAt,energySiteId,intervals,proposalFingerprint,readbackFingerprint,smartEvidenceFingerprint,timeZone,updatedAt,validUntil,version";
export function validOwnership(value: unknown): value is ManagedImportEvidence {
    try {
        const v = value as ManagedImportEvidence;
        if (!v || Object.keys(v).sort().join() !== keys || v.version !== 1 || v.basis !== "confirmed-write-readback"
            || typeof v.energySiteId !== "string" || !/^\d+$/.test(v.energySiteId) || !timestamp(v.createdAt) || !timestamp(v.updatedAt) || !timestamp(v.validUntil)
            || Date.parse(v.createdAt) > Date.parse(v.updatedAt) || Date.parse(v.updatedAt) >= Date.parse(v.validUntil)
            || ![v.baselineFingerprint,v.readbackFingerprint,v.proposalFingerprint,v.smartEvidenceFingerprint].every(k => typeof k === "string" && /^[a-f0-9]{64}$/.test(k))
            || !Array.isArray(v.intervals) || v.intervals.length > 512) return false;
        new Intl.DateTimeFormat("en-GB", { timeZone: v.timeZone });
        let end = -Infinity;
        for (const p of v.intervals) {
            if (Object.keys(p).sort().join() !== "applied,end,restore,restoreBaselineFingerprint,start" || !timestamp(p.start) || !timestamp(p.end)
                || Date.parse(p.start) < end || Date.parse(p.end) <= Date.parse(p.start)
                || typeof p.restoreBaselineFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(p.restoreBaselineFingerprint) || !price(p.applied) || !price(p.restore)
                || p.applied.currency !== p.restore.currency || representationKey(p.applied) === representationKey(p.restore)) return false;
            end = Date.parse(p.end);
        }
        return typeof v.timeZone === "string" && v.timeZone.length > 0;
    } catch { return false; }
}

/** Verify every still-relevant claimed instant, including before selecting a new
 * SMART target. A manual change even during an unchanged SMART plan is a conflict.
 */
export function assertOwnership(evidence: ManagedImportEvidence, observed: ObservedTariff, now: string) {
    if (!validOwnership(evidence) || evidence.energySiteId !== observed.source.energySiteId
        || evidence.timeZone !== observed.source.timeZone || !timestamp(now) || !timestamp(observed.source.observedAt)
        || Date.parse(evidence.updatedAt) > Date.parse(now)) throw new Error("MANAGED_OWNERSHIP_INVALID");
    const remaining = evidence.intervals.filter(p => Date.parse(p.end) > Date.parse(now));
    if (remaining.length && Date.parse(now) >= Date.parse(evidence.validUntil)) throw new Error("MANAGED_OWNERSHIP_STALE");
    if (Date.parse(observed.source.observedAt) < Date.parse(evidence.updatedAt)) throw new Error("MANAGED_OWNERSHIP_STALE");
    for (const p of remaining) {
        const domain = { start: new Date(Math.max(Date.parse(p.start),Date.parse(now))).toISOString(), end:p.end };
        const windows = observedEconomicSignal(observed, domain).signal.import;
        let covered = Date.parse(domain.start);
        for (const w of windows) {
            if (Date.parse(w.start) !== covered || w.priceStatus !== "known" || representationKey(w.price) !== representationKey(p.applied))
                throw new Error("MANAGED_IMPORT_OWNERSHIP_CONFLICT");
            covered = Date.parse(w.end);
        }
        if (covered !== Date.parse(p.end)) throw new Error("MANAGED_IMPORT_OWNERSHIP_CONFLICT");
    }
}
