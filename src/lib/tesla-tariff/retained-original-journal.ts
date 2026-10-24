import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RetainedOriginal } from "./retained-original";
import { validLinkedInitialRecord, validLinkedClassifiedRecord } from "./linked-experiment-records";
import { ownershipFingerprint } from "./ownership-transition";
import { representationKey } from "./rollback-evidence";

/** Read an existing journal only. Never append, repair, clear a latch, or mint a
 * completion capability. Offline rehearsal frames are not execution evidence. */
export function validateRetainedJournal(databasePath: string, retained: RetainedOriginal) {
    const directory = path.resolve(path.dirname(databasePath), "../tesla-experiments");
    const origin = retained.origin;
    const filename = origin.journal === "legacy" ? `site-${retained.energySiteId}.jsonl`
        : `site-${retained.energySiteId}-attempt-${origin.mutationId}.jsonl`;
    const file = path.join(directory, filename);
    let text: string;
    try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file || stat.size > 8_000_000)
            throw Error("OWNERSHIP_ORIGINAL_JOURNAL_INVALID");
        text = readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error("OWNERSHIP_ORIGINAL_JOURNAL_MISSING");
        throw Error("OWNERSHIP_ORIGINAL_JOURNAL_INVALID");
    }
    try {
        // Existing linked journals contain exactly initial and classified records.
        if (!text.endsWith("\n")) throw Error();
        const lines = text.slice(0, -1).split("\n");
        if (lines.length !== 2) throw Error();
        const [initial, classified] = lines.map(line => JSON.parse(line));
        if (!validLinkedInitialRecord(initial, retained.energySiteId)
            || !validLinkedClassifiedRecord(classified, initial)
            || initial.preparedContext.ownership.status !== "missing"
            || initial.mutationId !== origin.mutationId || initial.initialRecordId !== origin.initialRecordId
            || classified.classifiedRecordId !== origin.classifiedRecordId
            || classified.classification !== "submitted-representation-preserved"
            || classified.apiWrite.status !== "accepted"
            || initial.review.before.source.timeZone !== retained.timeZone
            || representationKey(initial.review.before) !== representationKey(retained.original)
            || ownershipFingerprint(initial.review.before.tariff) !== retained.originalFingerprint)
            throw Error();
        return { initial, classified };
    } catch { throw Error("OWNERSHIP_ORIGINAL_JOURNAL_CONFLICT"); }
}
