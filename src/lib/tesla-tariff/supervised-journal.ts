import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { validLinkedInitialRecord, validLinkedClassifiedRecord, type LinkedInitialRecord, type LinkedClassifiedRecord } from "./linked-experiment-records";

declare const completionBrand: unique symbol;
/** Runtime authority is private registry membership, never this type/shape. */
export type JournalCompletionCapability = Readonly<{ [completionBrand]: true }>;
export type JournalCompletionEvidence = Readonly<{
    completionSchemaVersion: 1; journalSchemaVersion: 1; energySiteId: string;
    mutationId: string; initialRecordId: string; classifiedRecordId: string; completedAt: string;
}>;
const completions = new WeakMap<object, JournalCompletionEvidence>();
// Capture the trusted registry operations at initialization. Looking them up on
// a mutable prototype later would let callers forge lookups or intercept minting.
const completionFor = completions.get.bind(completions);
const registerCompletion = completions.set.bind(completions);
const freezeCompletion = Object.freeze;

/** Narrow future receipt-issuer boundary. Reusable, side-effect free, and bound
 * to exact validated records. Copying/serialising either value grants no trust.
 * This proves journal completion only, never successful Tesla mutation.
 */
export function journalCompletionForRecords(capability: unknown, initial: LinkedInitialRecord,
    classified: LinkedClassifiedRecord): JournalCompletionEvidence | null {
    if (!capability || typeof capability !== "object") return null;
    const evidence = completionFor(capability);
    if (!evidence || !validLinkedInitialRecord(initial, evidence.energySiteId)
        || !validLinkedClassifiedRecord(classified, initial)
        || initial.initialRecordId !== evidence.initialRecordId || initial.mutationId !== evidence.mutationId
        || classified.classifiedRecordId !== evidence.classifiedRecordId
        || classified.completedAt !== evidence.completedAt) return null;
    return evidence;
}

/** One outstanding experiment per site, surviving crashes/restarts. No automatic
 * unlock/reset API: subsequent attempts require separate manual recovery review.
 */
export async function claimExperimentJournal(directory: string, site: string, record: unknown) {
    if (!/^\d+$/.test(site)) throw new Error("INVALID_SITE_ID");
    const initial = structuredClone(record);
    if (!validLinkedInitialRecord(initial, site)) throw new Error("JOURNAL_INITIAL_INVALID");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `site-${site}.jsonl`);
    const handle = await open(file, "wx", 0o600);
    try {
        await handle.writeFile(JSON.stringify(initial) + "\n", "utf8");
        await handle.sync();
        const parent = await open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
    } finally { await handle.close(); }
    let finished = false;
    return { async finish(result: unknown) {
        if (finished) throw new Error("RESULT_ALREADY_RECORDED");
        finished = true;
        const classified = structuredClone(result);
        if (!validLinkedClassifiedRecord(classified, initial)) throw new Error("JOURNAL_CLASSIFIED_INVALID");
        const append = await open(file, "a");
        try { await append.writeFile(JSON.stringify(classified) + "\n", "utf8"); await append.sync(); }
        finally { await append.close(); }
        // Mint only after all existing completion I/O, including close, succeeds.
        // No wall-clock timestamp, outcome promotion, recovery or consumption.
        const capability = freezeCompletion({}) as JournalCompletionCapability;
        registerCompletion(capability, freezeCompletion({ completionSchemaVersion: 1, journalSchemaVersion: classified.journalSchemaVersion,
            energySiteId: classified.energySiteId, mutationId: classified.mutationId,
            initialRecordId: classified.initialRecordId, classifiedRecordId: classified.classifiedRecordId,
            completedAt: classified.completedAt }));
        return capability;
    } };
}
