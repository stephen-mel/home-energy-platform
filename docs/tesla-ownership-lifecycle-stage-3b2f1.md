# Stage 3B2-F1: documentary lifecycle retirement and identity mapping

This increment defines and validates a lifecycle document. It does not retire a persisted ownership obligation, issue a receipt, mint a capability, write a journal, execute an operation or change SQLite. Only `validateOwnershipLifecycleDocument` is exported at runtime. All authority/proof flags, including restoration authority, remain false.

## Explicit version and legacy separation

`OwnershipLifecycleDocument` is tagged with `version: 2` and `kind: "ownership-lifecycle-document"`. Its two states are `active` / obligation `required`, and `restored` / obligation `retired`. These are documentary descriptions of a lifecycle candidate, not evidence that an ownership transaction committed.

The type is exported separately from `ownership-store.ts`. It is intentionally **not** included in `OwnershipSnapshot` or `OwnershipRead`. Existing V1 retained-original, V2 snapshot, V3 active snapshot, receipt and SQLite validators retain their existing interpretation. A lifecycle document is not a V2 persisted snapshot despite sharing the numeric version. No legacy records are migrated. The new validator requires complete attributed E/J/D evidence rooted in a confirmed apply; unattributed records cannot silently acquire eligibility.

## Preserve history instead of renewing validity

`historicalOwnership` contains the complete existing V3 snapshot, including its ledger, original tariff/source representation, retained origin, generation, checksum and SQLite `historyDigest`. It is compared exactly with the independent historical snapshot in validation context. A terminal document keeps this entire object unchanged. In particular, the historical ledger's `createdAt`, `updatedAt`, `validUntil` and owned intervals are not rewritten.

Terminal confirmation is separate. `restoration` includes the complete confirmed restore operation, predecessor application, immutable retained-origin key, approved terminal generation and readback observation identity/fingerprint, tariff fingerprint and observation time. Existing Stage 3B2-E validation requires operation-specific approval, accepted execution, independently admitted authenticated exact readback, durable journal linkage and complete predecessor history. Stage 3B2-D validates ownership attribution and its preserved policy horizon. Exact original-tariff restoration is mandatory.

Restore may complete after historical ownership validity expires. No new active ledger is manufactured with that completion time: `validOwnership` still requires `updatedAt < validUntil`. Existing historical prefixes remain in the retained snapshot, while the restore's actual readback/completion times remain in its separate confirmation. The document's terminal generation equals the approved restore result; the nested historical generation remains the last active generation.

## Identity mapping, version 2

Each `OwnershipApplicationIdentity` records distinct relationships:

- `documentary.version: 2` / `evidenceId`: the existing E envelope identity.
- `runtime`: a version-1 reference in namespace `runtime-confirmed-operation`, explicitly referencing future receipt version 2, with operation/mutation IDs and separate opaque `receiptKey` / `issuanceKey`. These are supplied independently in context. F1 neither defines the receipt payload nor authenticates/creates a receipt or registry entry.
- `journal.version: 2`: exact initial and completion record IDs from that operation.
- `retainedOriginKey`: the unchanged existing `retainedOriginKey` over the complete original and originating identities. Existing origin `receiptKey` continues to mean the root documentary evidence ID under E; origin `issuanceKey` remains its opaque documentary reference. Neither is relabelled as a runtime receipt/issuance.
- `ownership`: exact before/approved-after generations and the captured prior SQLite history digest, or null before an initial apply.
- `predecessorApplicationId`: previous mapping identity, or null at the apply root.

The application ID is `ownershipFingerprint({ purpose: "smart-ownership-application-v2", ...applicationBody })`, excluding `applicationId` from the body. This binds the separate runtime reference to the exact documentary/journal/origin/generation relationships without substituting one identity for another.

Mapping `historyId` is `ownershipFingerprint({ version: 2, purpose: "smart-ownership-history-v2", applications: orderedApplicationIds })`. It is a new **documentary mapping identity**, not the existing SQLite history digest. The latter remains unchanged inside the historical snapshot and captured preconditions. Existing SQLite application rows are not converted into these mappings or modified; F1 anchors their history by the supplied snapshot digest, while the future store must independently validate the actual durable rows.

The document ID is `ownershipFingerprint({ purpose: "smart-ownership-lifecycle-v2", ...documentBody })`, excluding `lifecycleId`. Full reconstruction and comparison reject extra/missing fields and rehashed substitutions. Documentary, journal, runtime and application IDs cannot alias or replay across mapped operations; runtime IDs cannot alias the retained-origin key or opaque originating issuance reference. Approval, payload, site/timezone, original lineage and predecessor validation reuse E/D rather than defining competing tariff rules.

## Context and replay limits

Validation context supplies the independently read historical snapshot, the complete ordered E records and their independent validation contexts, separate runtime identity references, and the previous lifecycle document. Root apply requires a null predecessor; update and restore require the exact preceding active document, including its ordered mappings. A supplied terminal predecessor always rejects. Duplicate operations, conflicting histories and subsequent active transitions reject.

The validator clones before inspecting/freezing results and performs no I/O. JSON round-trip preserves the document. Revalidating the same candidate against the same pre-transition context is intentionally idempotent: a pure validator cannot know whether another process has since committed it. Actual one-time retirement and replay protection require the future SQLite CAS/history transaction. Recovery JSON or a self-consistent caller-fabricated context cannot establish authentication, receipt issuance, durability or any permission.

## Remaining integration

Future increments must supply trusted V2 runtime completion/receipt issuance and authenticate the referenced runtime identities, then implement atomic persistence of the approved terminal generation and complete history using the existing store. The existing `Application`, `validateHistory`, `commitOwnership`, retained-journal reader and finaliser are unchanged. No successor claims or production adapters are connected. The document must not be passed to legacy persistence through casts or by weakening its active-ledger validator.

September evidence, attempt latches, fixed-export policy and `BUY_BELOW_SELL` gates are unchanged.
