import type { Site } from "../site/types";
import type { OwnershipRead } from "./ownership-store";
import { assertOwnership, validOwnership, validOwnershipTimestamp } from "./ownership-evidence";
import { ownershipFingerprint } from "./ownership-transition";
import { prepareSupervisedExperiment, type Capture, type Selection } from "./supervised-experiment";

type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
function freeze<T>(value: T): Frozen<T> {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value as Frozen<T>;
}
type Snapshot = Extract<OwnershipRead, { status: "available" }>["snapshot"];
export type CapturedOwnershipContext = Frozen<{
    capturedAt: string; energySiteId: string;
} & ({ status: "missing"; snapshot: null } | { status: "available"; snapshot: Snapshot })>;
export type MutationPreparationPorts = {
    /** Trusted local read adapter, e.g. ownershipStore(...).read. No default I/O. */
    readOwnership(site: string): Promise<OwnershipRead>;
    now(): string;
    newMutationId(): string;
};

/** Stage A only. No production caller, execution, journal, receipt or persistence.
 * Capture precedes initial preparation. Fresh revalidation continues to use the
 * existing prepareSupervisedExperiment, never this original-operation builder.
 * Fingerprints establish content identity, not authenticity or durability.
 */
export async function prepareMutationContext(input: { site: Site; selection: Selection; capture: Capture }, ports: MutationPreparationPorts) {
    const original = structuredClone(input), site = original.selection.energySiteId;
    if (typeof site !== "string" || !/^\d+$/.test(site)) throw Error("PREPARATION_SITE_INVALID");
    let read: OwnershipRead;
    try { read = structuredClone(await ports.readOwnership(site)); }
    catch { throw Error("PREPARATION_OWNERSHIP_UNAVAILABLE"); }
    const capturedAt = ports.now();
    if (!validOwnershipTimestamp(capturedAt)) throw Error("PREPARATION_TIME_INVALID");
    if (read?.status === "unavailable") throw Error("PREPARATION_OWNERSHIP_UNAVAILABLE");
    if (!read || (read.status !== "missing" && read.status !== "available")) throw Error("PREPARATION_OWNERSHIP_INVALID");
    if (Object.keys(read).sort().join() !== (read.status === "missing" ? "status" : "snapshot,status"))
        throw Error("PREPARATION_OWNERSHIP_INVALID");
    if (read.status === "available") {
        const s = read.snapshot;
        if (!s || Object.keys(s).sort().join() !== "checksum,evidence,generation,version" || s.version !== 1
            || typeof s.generation !== "string" || !/^[a-f0-9-]{36}$/.test(s.generation)
            || !validOwnership(s.evidence) || s.evidence.energySiteId !== site
            || Date.parse(s.evidence.updatedAt) > Date.parse(capturedAt)
            || s.checksum !== ownershipFingerprint({ generation: s.generation, evidence: s.evidence }))
            throw Error("PREPARATION_OWNERSHIP_INVALID");
    }
    const ownership: CapturedOwnershipContext = freeze({ capturedAt, energySiteId: site,
        ...(read.status === "available" ? { status: "available" as const, snapshot: read.snapshot }
            : { status: "missing" as const, snapshot: null }) });
    const generatedAt = ports.now();
    if (!validOwnershipTimestamp(generatedAt) || Date.parse(generatedAt) < Date.parse(capturedAt)) throw Error("PREPARATION_TIME_INVALID");
    const review = prepareSupervisedExperiment(original.site, original.selection, original.capture, generatedAt);
    if (read.status === "available") assertOwnership(read.snapshot.evidence, review.before, generatedAt);
    let mutationId: unknown;
    try { mutationId = ports.newMutationId(); } catch { throw Error("PREPARATION_MUTATION_ID_INVALID"); }
    if (typeof mutationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)) throw Error("PREPARATION_MUTATION_ID_INVALID");
    const smart = review.proposal.input.observedSmart!;
    const bound = { version: 1 as const, mutationId, original: review, ownership,
        energySiteId: site, timeZone: review.proposal.bound.timeZone,
        selectedDispatch: smart.dispatch, comparisonDomain: smart.comparisonDomain,
        experimentFingerprint: review.fingerprint, proposalFingerprint: review.proposal.fingerprint,
        payloadKey: review.payloadJson, smartEvidenceKey: review.binding.smartEvidenceKey,
        selectedEvidenceKey: review.proposal.bound.dispatchEvidenceKey,
        ownershipKey: ownershipFingerprint(ownership) };
    return freeze({ ...bound, fingerprint: ownershipFingerprint(bound), writeReady: false as const, rollbackProven: false as const });
}
export type PreparedMutationContext = Awaited<ReturnType<typeof prepareMutationContext>>;
