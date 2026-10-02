import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { validLinkedInitialRecord, validLinkedClassifiedRecord } from "./linked-experiment-records";

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
    } };
}
