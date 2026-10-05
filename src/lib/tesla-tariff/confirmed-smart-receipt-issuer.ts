import { journalCompletionForRecords } from "./supervised-journal";
import type { LinkedInitialRecord, LinkedClassifiedRecord } from "./linked-experiment-records";
import { validateConfirmedSmartReceipt, type ConfirmedSmartReceipt } from "./ownership-finalisation";
import { ownershipFingerprint } from "./ownership-transition";

function freeze<T>(value: T): Readonly<T> {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

/** Evidence projection only. No receipt runtime authority, I/O or ownership
 * derivation. Future production persistence must revalidate B2-authorised issuance;
 * a copied/serialized envelope or a bare receipt is not persistence authority. */
export function issueConfirmedSmartReceipt(capability: unknown, initialRecord: LinkedInitialRecord,
    classifiedRecord: LinkedClassifiedRecord) {
    const reject = (code: string) => freeze({ status: "rejected" as const, code,
        writeReady: false as const, rollbackProven: false as const });
    try {
        // Establish authority before projecting anything. The existing verifier
        // checks B1 content, canonical classification and exact completion linkage.
        const completion = journalCompletionForRecords(capability, initialRecord, classifiedRecord);
        if (!completion) return reject("JOURNAL_COMPLETION_NOT_BOUND");
        const initial = structuredClone(initialRecord), classified = structuredClone(classifiedRecord);
        if (classified.classification !== "submitted-representation-preserved" || !classified.apiTariffReadBack.observation)
            return reject("MUTATION_NOT_CONFIRMED");
        const captured = initial.preparedContext.ownership;
        const original: ConfirmedSmartReceipt["original"] = {
            proposal: initial.review.proposal, payloadJson: initial.review.payloadJson, approval: initial.exception.approval,
            prior: { capturedAt: captured.capturedAt, generation: captured.snapshot?.generation ?? null,
                evidence: structuredClone(captured.snapshot?.evidence ?? null) as ConfirmedSmartReceipt["original"]["prior"]["evidence"] },
        };
        const execution: ConfirmedSmartReceipt["execution"] = {
            submittedAt: classified.attemptedAt, completedAt: classified.completedAt, apiWrite: classified.apiWrite,
            readback: classified.apiTariffReadBack.observation, classification: classified.classification,
        };
        const mutationId = initial.mutationId;
        const checked = validateConfirmedSmartReceipt({ version: 1, mutationId, original, execution,
            journal: { originalKey: ownershipFingerprint({ mutationId, original }),
                classifiedKey: ownershipFingerprint({ mutationId, execution }), completedAt: completion.completedAt } });
        if (checked.status === "rejected") return checked;
        const receipt = checked.receipt, receiptKey = ownershipFingerprint(receipt);
        return freeze({ status: "issued" as const, receipt, completion, receiptKey,
            issuanceKey: ownershipFingerprint({ version: 1, completion, receiptKey }),
            writeReady: false as const, rollbackProven: false as const });
    } catch { return reject("INVALID_CONFIRMATION"); }
}
