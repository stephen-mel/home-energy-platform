# Stage 3B2-C5: closed offline first-apply persistence and recovery

`closedOfflineV2().persistAndRecover()` completes one private TEST-ONLY first-apply rehearsal. It accepts no documents, callbacks, paths or provider overrides. Existing C1–C4 preparation, safety gates, simulated execution/readback and single-use receipt projection run unchanged. C5a maps the exact private receipt into the explicit offline lifecycle namespace. C5b performs the exact-generation SQLite commit with physical V2 journal verification and atomic ownership/history insertion.

## Commit, discard and fresh recovery

The C5b writer closes its database connection before returning. The harness deletes the simulated admission/completion WeakMap entries and clears live admission, completion, receipt, pending-operation and execution-evidence references. No token is serialized or hydrated. Recovery uses a fresh module loader/registry and a fresh read-only SQLite connection.

The test-only reader reuses F4a connection/schema/column checks, the existing physical V2 history reader, and C5a lifecycle/persistence validation. Both tables are read in one SQLite read transaction. A second physical journal read must match the first. The reader rolls back/closes on failure and never repairs evidence.

An immutable **documentary JSON checkpoint** is retained separately from SQLite, containing the expected mapping references, historical snapshot and journal validation context. It supplies independent expected references rather than deriving those expectations from candidate rows. It contains no live capability or receipt object and is never treated as authentication. This stage rehearses recovery in the same harness process after discarding execution identities; it does not claim independent-process restoration of that external checkpoint or production crash-recovery authority.

Successful recovery returns `consistent-offline-storage`, fixture-only authentication, unverified identity provenance and false execution/write/admission/runtime-confirmation/repeat/successor/restoration flags. It retains the original tariff/lineage, approved validity and exact committed generation. The historical outstanding restoration obligation is documentary state, not permission to restore. Production validation rejects the explicitly offline record.

## Failure and replay behaviour

The orchestration is latched before any asynchronous work. Failed or interrupted persistence does not automatically retry. `recoverOwnership()` performs repeatable read-only consistency inspection after identities have been discarded; it accepts no recovered documents as inputs and cannot issue another operation, receipt or write.

Fixed internal test faults cover missing/substituted journals, ambiguous claims, rehashed original/generation/receipt/production-namespace corruption, missing history, stale generations, predecessor conflicts, duplicate commits and rollback between ownership/history statements. Deliberate SQL UPDATE/DELETE fault injection occurs only after a successful guarded commit. Successful persistence never inserts rows directly from the harness or seeds a replacement ownership record.

No production source changes, V3 writer, successor/update/restore implementation, new storage engine or authority mechanism is added. V1 behaviour, fixed-export/BUY_BELOW_SELL gates, Flatpeak and September evidence remain unchanged. No Tesla/Kraken calls or credentials are used.
