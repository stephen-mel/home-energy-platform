# Stage 3B2-E: confirmed-operation evidence

This increment defines a pure version-2 evidence envelope for apply, update and
restore. It does not install a journal writer/reader, approve an operation, create
V3 ownership, issue a runtime capability or connect an executor. Existing linked
v1 records, v1 receipts, V2 ownership, SQLite transactions, repeat-attempt rules
and the September latch retain their existing interpretation.

## Record and identity bindings

An envelope contains an initial record, a completion record and an `evidenceId`.
Both records explicitly use `journalSchemaVersion: 2`, in a separate contract;
existing journal writers and validators continue accepting only their v1 records.

The initial intent binds operation kind, operation/mutation IDs, site/timezone,
the exact captured V3 ownership snapshot (or null for a new apply), expected next
generation, predecessor identity, complete original observation and fingerprint,
origin identities for successors, authenticated pre-write observation reference,
exact payload and its fingerprint, preparation time and validity window.

The operation approval is separately versioned. Its `fingerprint` is the canonical
representation of the entire intent, following the existing exact-fingerprint and
`approvedAt` convention. Its `approvalId` hashes the approval body. This is an
operation approval evidence representation, not an alternative approval service;
there is no issuer in this increment. It is deliberately incompatible with a v1
proposal approval. Copying an approval from a predecessor cannot approve a new
intent, generation or operation kind. The validator requires an exact independent
match in the trusted approval evidence supplied by its caller.

The completion binds the initial ID, operation/mutation/site/timezone, expected
next generation, accepted execution result, submission/completion/journal times,
authenticated readback reference, final tariff fingerprint and operation-specific
outcome (`applied`, `updated` or `restored`). An HTTP acknowledgement alone fails.
Before/readback observations must pass the existing Tesla evidence validator and
match independently supplied authenticated acquisition evidence. Accepted HTTP
status, approval/capture freshness and timestamp ordering follow the existing
receipt conventions and constants. The existing exact-readback comparator must
confirm the full proposed representation and a complete local-day comparison.
Restoration must match the complete original tariff, including its export side.

All hashes use `ownershipFingerprint`, which uses `representationKey`. Initial
and completion IDs hash their bodies with only their own ID omitted. `evidenceId`
hashes `{ version: 2, initial, completion }`. The payload fingerprint hashes the
canonical `{ tou_settings: { tariff_content_v2: ... } }` envelope; `payloadJson`
must equal its canonical representation. JSON safety is shared with existing
linked-record validation, including rejection of accessors, cycles, sparse arrays
and non-finite/unsupported values before cloning or fingerprinting.

## History, baseline and generation

Validation requires the complete ordered confirmed prefix starting with an
explicit v2 apply. Apply has no predecessor, before-ownership snapshot or origin
reference. This avoids a circular self-reference in the initial record hash.
The independently supplied retained original must bind that root's mutation,
initial/completion IDs and `evidenceId` as its documentary `receiptKey`.
`issuanceKey` remains an opaque retained origin reference: this validator does not
mint, authenticate or reinterpret runtime receipt issuance.

Each update/restore binds the immediately preceding operation, completion and
evidence IDs. Its validated V3 snapshot must match the predecessor's result
generation, verified tariff fingerprint, mutation/receipt identity and completion
time. The complete retained original and all origin identities must stay
immutable under the existing `retainedOriginKey`. Operation, mutation, approval,
observation, journal and resulting generation identities cannot be reused in the
chain. No successor is accepted after a confirmed restore.

Generations are opaque UUIDs, not counters. Progression means matching the exact
confirmed predecessor and the independently expected before snapshot/after
generation, with a distinct resulting generation. No snapshot or generation is
manufactured by validation. A `restored` result records exact observed evidence;
it does not retire ownership or discharge the retained `required` obligation.

## Trust boundary and remaining integration

`validateConfirmedOperationEvidence` takes a separate trusted context: exact
expected before ownership/after generation, retained original, confirmed history,
operation approvals, authenticated observations, and durable initial/completion
identity pairs. The durable pairs must cover exactly the supplied chain; missing,
duplicate, conflicting or additional unlinked journal evidence fails closed.
Malformed/unsupported evidence returns an explicit rejection without throwing.

The context is a server-side precondition, never browser JSON or a value derived
only from the submitted envelope or recovered ownership. A pure content validator
cannot authenticate a fabricated context or prove filesystem durability. Future
integration must obtain these inputs independently through trusted acquisition,
approval and durable journal/ownership readers. Tests supply synthetic trusted
inputs; no live provider authentication is claimed.

Both success and rejection return false for execution, writes, rollback proof,
restoration proof, repeat authority, successor authority and resolution of
historical journals. Even a valid envelope, its copy or its serialized form has
no membership in the existing completion-capability registry. There is no public
approval issuer, journal claim, ownership writer or receipt-capability adapter.

Remaining work includes trusted production creation/approval, version-aware
durable journal I/O and history loading, runtime receipt issuance, complete
operation finalisation and atomic V3 persistence, successor claims, and separately
authorised restoration retirement. The Stage 3B1 journal reader still validates
only the original v1 linked pair; it cannot store/recover this v2 root yet. There
is no automatic conversion from legacy journal/receipt identities into a v2 root.
Policy suitability, fixed-export validation, `BUY_BELOW_SELL`, all execution safety
gates and the September attempt latch remain the responsibility of their existing
unchanged contracts. Validating an observed result does not waive any of them.

## Offline tests

`tests/tesla-confirmed-operation-evidence.test.mjs` uses synthetic tariff data and
V3 snapshots, with a source loader that rejects filesystem/network/executor
dependencies in the evidence module graph. It exercises apply/update/restore,
tampering with recomputed checksums, independent approval/readback evidence,
generation/history/baseline conflicts, malformed/legacy data and absent runtime
capability membership. Synthetic snapshots are never persisted or promoted into
production authority.
