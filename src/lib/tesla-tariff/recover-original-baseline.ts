import { readOwnership } from "./ownership-sqlite";

const authority = { executionReady: false, writeReady: false, rollbackProven: false,
    restorationProven: false, grantsRepeatAuthority: false, resolvesHistoricalJournal: false } as const;

/** Read-only local recovery. The store validates snapshot checksum, every history
 * link, immutable original identity, and the corresponding durable journal pair.
 * No receipt, completion capability, latch change, migration or freshness claim. */
export function recoverOriginalBaseline(databasePath: string, energySiteId: string, timeZone: string) {
    const fail = (code: string) => ({ status: "blocked" as const, code, baseline: null, ...authority });
    const read = readOwnership(databasePath, energySiteId);
    if (read.status === "missing") return fail("OWNERSHIP_ORIGINAL_MISSING");
    if (read.status !== "available") return fail(read.code ?? "OWNERSHIP_ORIGINAL_UNAVAILABLE");
    if (read.snapshot.version !== 3) return fail("RESTORATION_BASELINE_UNAVAILABLE");
    const { lifecycle } = read.snapshot;
    if (lifecycle.energySiteId !== energySiteId || lifecycle.timeZone !== timeZone)
        return fail("OWNERSHIP_ORIGINAL_IDENTITY_MISMATCH");
    return { status: "recovered" as const, baseline: structuredClone(lifecycle.original),
        originalFingerprint: lifecycle.originalFingerprint, origin: structuredClone(lifecycle.origin),
        generation: read.snapshot.generation, historyDigest: read.snapshot.historyDigest,
        latestReadback: structuredClone(lifecycle.latestReadback), restorationObligation: lifecycle.restorationObligation,
        ...authority };
}
