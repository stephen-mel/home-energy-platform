import type { LifecycleOwnershipSnapshot } from "./ownership-store";
import { validOwnership } from "./ownership-evidence";
import type { ObservedTariff } from "./observed-tariff";
import { validateTeslaInspectionEvidence } from "./smart-inspection";
import { ownershipFingerprint } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";

/** Documentary retention only. This is not an execution receipt or capability.
 * B1 deliberately cannot discharge an obligation or replace its original. */
export type RetainedOriginal = {
    version: 1;
    energySiteId: string;
    timeZone: string;
    original: ObservedTariff;
    originalFingerprint: string;
    origin: {
        mutationId: string;
        initialRecordId: string;
        classifiedRecordId: string;
        issuanceKey: string;
        receiptKey: string;
        journal: "legacy" | "attempt";
    };
    restorationObligation: "required";
    currentGeneration: string;
    latestReadback: { mutationId: string; receiptKey: string; fingerprint: string };
};
export type RetentionInput = Pick<RetainedOriginal, "original" | "origin">;
export const retentionDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const keys = (v: object, names: string) => Object.keys(v).sort().join() === names;

export function validRetainedOriginal(value: unknown): value is RetainedOriginal {
    try {
        const v = value as RetainedOriginal;
        if (!v || !keys(v, "currentGeneration,energySiteId,latestReadback,origin,original,originalFingerprint,restorationObligation,timeZone,version")
            || v.version !== 1 || v.restorationObligation !== "required"
            || typeof v.energySiteId !== "string" || !/^\d+$/.test(v.energySiteId)
            || typeof v.currentGeneration !== "string" || !/^[a-f0-9-]{36}$/.test(v.currentGeneration)
            || !v.origin || !keys(v.origin, "classifiedRecordId,initialRecordId,issuanceKey,journal,mutationId,receiptKey")
            || !id(v.origin.mutationId) || !["legacy", "attempt"].includes(v.origin.journal)
            || ![v.origin.initialRecordId,v.origin.classifiedRecordId,v.origin.issuanceKey,v.origin.receiptKey].every(retentionDigest)
            || !v.latestReadback || !keys(v.latestReadback, "fingerprint,mutationId,receiptKey")
            || !id(v.latestReadback.mutationId) || !retentionDigest(v.latestReadback.receiptKey)
            || !retentionDigest(v.latestReadback.fingerprint)) return false;
        const original = validateTeslaInspectionEvidence(v.original);
        return !!original && original.source.energySiteId === v.energySiteId && original.source.timeZone === v.timeZone
            // The validator must not normalise away any retained representation.
            && representationKey(original) === representationKey(v.original)
            && v.originalFingerprint === ownershipFingerprint(original.tariff);
    } catch { return false; }
}

/** Immutable across generations, including source metadata and both journal IDs. */
export function retainedOriginKey(v: RetainedOriginal) {
    return ownershipFingerprint({ original: v.original, originalFingerprint: v.originalFingerprint,
        origin: v.origin, energySiteId: v.energySiteId, timeZone: v.timeZone });
}

/** Structural check only; durable history and journal checks belong to the store. */
export function validLifecycleOwnershipSnapshot(value: unknown, site: string): value is LifecycleOwnershipSnapshot {
    try {
        const s = value as LifecycleOwnershipSnapshot;
        return !!s && keys(s, "checksum,evidence,generation,historyDigest,lifecycle,version") && s.version === 3
            && retentionDigest(s.historyDigest) && typeof s.generation === "string" && /^[a-f0-9-]{36}$/.test(s.generation)
            && validOwnership(s.evidence) && s.evidence.energySiteId === site
            && validRetainedOriginal(s.lifecycle) && s.lifecycle.energySiteId === site
            && s.lifecycle.timeZone === s.evidence.timeZone && s.lifecycle.currentGeneration === s.generation
            && s.lifecycle.originalFingerprint === s.evidence.baselineFingerprint
            && s.lifecycle.latestReadback.fingerprint === s.evidence.readbackFingerprint
            && s.evidence.intervals.every(i => i.restoreBaselineFingerprint === s.lifecycle.originalFingerprint)
            && s.checksum === ownershipFingerprint({ version: 3, generation: s.generation, evidence: s.evidence, lifecycle: s.lifecycle });
    } catch { return false; }
}
