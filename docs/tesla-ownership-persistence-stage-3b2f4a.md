# Stage 3B2-F4a: versioned ownership persistence representation and readback

F4a implements the explicitly permitted **read-only fallback**. F2 cannot yet
produce a trusted V2 confirmation capability. Consequently this increment installs
**no V3 writer**, no receipt issuer, no admission and no ownership finaliser.
It cannot unblock production successor admission on its own.

## Representation

`PersistedOwnershipLifecycle` version 1 (`kind: v3-ownership-persistence`) fits
in the existing strict SQLite schema's `ownership.snapshot` and `applied.record`
JSON columns. The SQL schema/version is unchanged; no migration or silent upgrade
occurs. Existing readers/writers continue to reject this new representation.

Each record contains the full F1 lifecycle document, the separately approved D
validity policy (including provenance identities), a preceding persistence-record
identity, and a canonical content fingerprint. The F1 application mapping binds
operation kind/site/timezone, operation and documentary evidence identities,
separate runtime receipt/issuance references, journal initial/completion identities,
original lineage, before/after generations and preceding application identity.
Persistence-record identity, F1 mapping-history identity and historical SQLite
history digest remain distinct. Runtime references cannot alias persistence IDs.

All prefixes must match the physically recovered E/J/D journal chain. Every
approved next generation must equal J's deterministic allocation from the exact
preceding historical snapshot; every F1 mapping already in history is immutable.
The approved validity policy is preserved explicitly, never derived from the
comparison domain. Terminal restoration uses F1 unchanged: it preserves the
historical ledger and expired validity, records exact restoration separately,
and prevents later transitions. It does not commit retirement or authenticate a
runtime reference.

## Readback and trust limits

`readPersistedOwnershipLifecycle` uses the existing SQLite connection/schema
checks and a read-only transaction to read both tables consistently. SQL mutation
and issuance columns must match the last application in each record. The current
row must exactly equal the unique complete history tail. There must be no missing,
extra, forked or replayed operations.

The reader derives the existing sibling `tesla-experiments` directory from the
database path. It reuses J's physical, version-aware marker/journal verification,
including pending/ambiguous attempt blocking and independent historical attribution
admission. It reads this history again before returning to reject observed journal
changes. V1 retained journals still use the existing verification path. Legacy
ownership is returned with a `legacy` tag, never converted into the new format.

`verified-storage` means only that actual SQLite records and available physical
journal history agree under these validations. It is **not** a trusted predecessor
capability, proof of F2 receipt registry membership, execution permission, a lease,
or evidence that the state will remain current. Runtime receipt provenance remains
explicitly unverified. Independently supplied historical D admissions are required;
stored JSON cannot supply its own authentication. Controlling all files and
independent admissions is outside this local consistency boundary.

Pure validation accepts documentary objects but has no I/O or capability effects.
Neither pure validation nor database recovery produces admission, completion,
retry, successor or restoration authority. No production adapter is installed.

## Deferred integration

F2 must first establish the private runtime confirmation capability. F3 must bind
that capability to the exact proposed ledger/terminal representation. A future F4
writer must then enforce the approved BEFORE snapshot/generation and exact AFTER
generation **inside BEGIN IMMEDIATE**, verify journals and both persisted rows,
append history and atomically commit or roll back. It must not allocate a random
replacement generation or reopen an attempt latch. None of that write boundary is
exposed here, even behind a documentary callback or test switch.

Tests seed documents with direct SQLite SQL in test-only helpers. They exercise
real close/reopen and separate-process readback, journal/history corruption,
expired terminal restoration, read-only failure cleanup and existing SQLite
transaction exclusion/rollback. Transaction exclusion tests do not claim to test
an implemented V3 CAS writer: V3 atomic commit, crash-after-write and trusted
predecessor capability tests remain dependent on F2/F3/the future writer.
