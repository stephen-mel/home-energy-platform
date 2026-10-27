# Stage 3B2-C5b: private offline SQLite transaction compatibility

## Boundary

This increment shares the existing ownership database transaction mechanics between the unchanged guarded V1 caller and a TEST-ONLY version-aware row profile. No production offline or V3 writer is exported or connected. There is no new database, schema, journal, capability registry or persistence framework.

`ownershipDatabaseTransaction()` owns the existing connection setup, `BEGIN IMMEDIATE`, strict schema checks, commit, rollback, uncertain-outcome handling and close. Synchronous V1 work still returns synchronously. Test-only asynchronous V2 journal verification holds the same transaction until verification completes. `validateExactOwnershipGeneration()` and `writeOwnershipPair()` are private shared helpers; neither confers authority.

The offline row profile is JavaScript source under `tests/helpers/`, appended only inside the existing test VM instrumentation. It is absent from application exports and has no application caller. It accepts only version 1 `offline-v2-ownership-persistence` with one first-apply operation, genuinely absent ownership/history, null predecessor and exact approved before/after generations. Update, restore and production-disguised records are rejected.

## Guarded transaction checks

All offline profile checks occur while the existing SQLite transaction is held. It reads the physical V2 journal using `readOfflineOperationHistory()`, requires the exact confirmed operation, and invokes the existing private C5a persistence/lifecycle validators with a separately supplied fixture identity context. The complete original tariff, retained-origin identity, approved validity, approval, payload, operation, evidence, journal IDs and generation are cross-checked by those validators. Fixture attribution admissions remain documentary test inputs; no callback is treated as runtime authentication.

Only after validation does the shared row inserter write the ownership and application rows. Both stored JSON records and SQL identity columns are read back and checked before commit. A second physical journal read must match the first; late loss, ambiguity or tampering rolls back both rows.

The V1 path still constructs its original row format, chooses random generations, preserves idempotent replay and calls the existing V1 retained-original journal guard. The test-only profile does not bypass that guard; it uses a separate explicitly versioned V2 consistency check for its distinct offline record format.

## Authority and limitations

A successful test commit reports `persisted-offline`, fixture-only authentication, unverified identity provenance and false admission/execution/write/repeat/successor/restoration/runtime-confirmation flags. It cannot register a completion or issue a production receipt. Relabelling and rehashing offline identities does not grant production provenance or access this offline writer.

Focused tests permit real temporary SQLite commits, raw row inspection, generation conflicts, concurrency and rollback injection. Complete C5 commit/reopen/recovery orchestration is not added to the closed harness. Successful offline persistence is storage consistency only and creates no successor, restoration or production commit authority.

September evidence, V1 runtime receipt guards and production call wiring remain unchanged. No Tesla/Kraken calls or credentials are involved.
