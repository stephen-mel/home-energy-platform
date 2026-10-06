# Isolated local SQLite ownership persistence

This is a **local supervised-experiment store**, not Vercel/cloud persistence.
No executor, receipt orchestration, dashboard reader, recovery or restoration is
connected. Production access is read-only. All production blockers remain;
`rollbackProven` and `writeReady` are not promoted by storage.

**Next-stage integration constraint:** Future trusted persistence orchestration
must use the complete B2-bound Stage A ownership snapshot—including
`historyDigest`—as the persistence precondition. The pure finaliser's generation
alone is insufficient. B2→persistence orchestration is not connected here.

## Runtime and isolation

The local persistence and its tests require exactly **Node 26.8.2**. The adapter
checks `process.versions.node` before loading built-in `node:sqlite` or touching the
filesystem; other versions return `OWNERSHIP_NODE_26_8_2_REQUIRED`. Node 26 types
are pinned in the lockfile. There is no SQLite npm driver and no root `engines`
constraint changing Vercel deployment assumptions. Do not import the local adapter
into a dashboard/server route. The existing local reader facade loads it lazily.
Runtime upgrades require deliberate revalidation, not silently accepting a new ABI.

Run the local tests with that executable:

`node --test tests/tesla-ownership-sqlite.test.mjs tests/tesla-ownership-store.test.mjs`

## Store and authority

Default location:
`.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite`.
Tests inject isolated database paths. Use a persistent **local filesystem**, never
a network share, synced folder or separate per-process copies of the database.
The existing cache Git ignore covers the database and SQLite journal files.
New directories/files use owner-only permissions (0700/0600).

`ownershipStore().read` is the only facade operation. `readOwnership` is the only
SQLite module export. `commitOwnership` is module-private, with no environment
switch or factory exposing it. Tests append an export in a VM-loaded copy of source;
that seam exists only in `tests/helpers`. It is not runtime authority.

Legacy `recordConfirmed` is removed. Its useful replacement derivation is pure and
remains regression tested. It does not create write authority. The future trusted
entry must accept genuine B2 capability + exact initial/classified records, issue
and finalise internally, then call the private commit. No such entry is added here.

## Transaction and identity

Two STRICT tables hold:

- `ownership`: site primary key and exact version-2 snapshot (generation, validated
  bounded evidence, content checksum and complete ordered-history digest).
- `applied`: site/mutation primary key, per-site unique issuance key, and a checked
  record binding receipt key, expected prior identity and resulting identity.
  Historical mutation identities are retained, not replaced by just the latest ID.
  They must form one complete, unambiguous chain from the original missing-state
  root to current ownership. Missing links, disconnected records, forks, cycles,
  duplicate results/generations or cross-site links invalidate the state; no history
  is inferred or repaired. Valid-empty/nonempty snapshots remain normal chain nodes.

The exact v2 table definitions and primary/unique indexes are checked on every
open transaction; unexpected triggers or altered schema fail closed without repair.
Database schema version is 2; old SQLite state is rejected without migration. Evidence remains version 1. The result identity binds
version, site, generation, ownership-content checksum and evidence fingerprint; applied
records have a content checksum. No credentials, raw Tesla payload or export
ownership is stored. Checksums establish consistency, not authentication.

The private commit clones/validates its input, opens the local database, then uses
`BEGIN IMMEDIATE` before examining applied identities and current ownership.
Within that one write transaction it checks replay/conflict, validates the exact
captured precondition, updates ownership, inserts applied identity, and commits.
Immediately before COMMIT, it independently rereads and validates the exact intended
ownership and applied-identity pair, including all bindings and their mutual linkage.
Missing, transformed or inconsistent rows cause rollback even if SQL statements
reported success. The complete chain is also reread: it must equal the exact
pre-transaction history plus the intended append (or the unchanged history for
idempotent replay), terminating at the intended ownership. This detects removal
or validly checksummed alteration of historical records during the transaction. This invariant does not depend on recognising schema alterations.
No network, journal, confirmation or tariff work occurs inside the transaction.

- Missing means genuinely absent state, never corrupt/unavailable or legacy JSON.
- Valid-empty is an available snapshot with generation/checksum, not missing.
- Available state must match the captured version/site/generation/checksum/evidence/history-digest
  identity. No reread-and-rebase is permitted.
- An unseen mutation with the exact precondition persists one new opaque UUID
  generation, preserving the existing generation meaning.
- Exact issuance + receipt + prior identity + unchanged recorded result returns
  `already-persisted` with that same generation.
- Different issuance for the same mutation, changed receipt, reused issuance under
  another mutation, or historical replay after advancement fails closed.
- Equality of economics is never replay identity. Mismatched metadata fails closed.

Readers use a consistent read transaction and validate ownership together with its
applied-result linkage. There is no automatic repair. Any legacy JSON ledger for
the site blocks both reads and commits with `OWNERSHIP_LEGACY_UNRESOLVED`, even if
SQLite contains state. Legacy files are neither removed nor migrated.

## Durability, contention and failures

SQLite uses rollback-journal (`DELETE`) mode and explicit `synchronous=EXTRA`.
Existing databases in another journal mode are rejected, not silently converted.
Busy timeout is zero: contention returns a safe store-busy failure without retry.
The process-global JSON queue is retired; SQLite serializes separate processes.

Results distinguish `persisted`, `already-persisted`, `conflict`, `store-failed` and
`indeterminate`. Failure before attempting COMMIT rolls back where possible. Once
COMMIT is attempted, or rollback/close fails, the outcome is conservatively
indeterminate; an acknowledgement/close error may follow a durable commit.
Reopening may reveal installed identity, but no automatic application recovery is
implemented. An interrupted initial database setup may leave an uninitialised
file; reads fail closed until separately reviewed rather than treating it as absent.

SQLite crash recovery is not B2 recovery: persisted identity cannot recreate the
runtime capability after restart. A future trusted caller may resolve exact
idempotency only after satisfying its authority boundary. No receipt JSON can
invoke the private commit in production.

This transaction does **not** encompass Tesla or the experiment journal. A
confirmed Tesla mutation followed by persistence failure remains “tariff confirmed;
ownership recording failed/indeterminate”. Nothing resets a latch, retries a POST,
automatically restores, proves billing qualification or proves rollback.

## Complete history anchor and trust boundary

`historyDigest` is SHA-256 of the existing canonical `representationKey` encoding
of `{version: 1, site, applications: orderedRecords}`. Records are ordered by the
validated missing-root → prior/result chain, never SQL row order or mutation-name
sorting. Each entire application is included: site, mutation ID, issuance key,
receipt key, prior/result ownership identities (including their version fields),
prior history digest and application checksum. Object keys are canonical; array
order is significant.

The anchor lives in the current version-2 ownership snapshot. Its existing
`checksum` remains a checksum of generation/evidence (ownership *content*), as do
prior/result identities: including the resulting history digest in its own result
identity would create a circular hash. Instead, available persistence preconditions
compare the **entire snapshot**, including `historyDigest`. Preparation and linked
context fingerprints also bind this field; their validators require the new snapshot
shape. No journal orchestration, B2 evidence or execution is added to the adapter.

An application's `priorHistoryDigest` records the exact captured prefix commitment
(null only for genuinely missing state). Every prefix and the terminal snapshot
anchor are recomputed when reading. Before append, the complete current chain and
anchor must validate and match the captured precondition. The next application and
snapshot anchor are written atomically. Pre-COMMIT verification independently rereads
all history, validates the recomputed anchor, and checks the exact intended pair and
unchanged prior records. Any discrepancy rolls back. Exact replay must match the
original prior anchor as well as all other identity; it changes neither generation
nor digest. Historical replay after advancement remains a conflict.

**This is consistency protection, not authenticity.** A digest anchored in the same
mutable SQLite database detects alteration unless an attacker rewrites both history
and its anchor consistently (including prefix commitments/checksums). It cannot
protect against arbitrary consistent database replacement. A pre-existing captured
snapshot still detects the changed anchor; a fresh read of a fully rewritten valid
database cannot. Tests explicitly demonstrate that limit, rather than claiming local
hashes provide a trusted external audit record. No secret, external trust root,
recovery, migration or new authority is introduced.
