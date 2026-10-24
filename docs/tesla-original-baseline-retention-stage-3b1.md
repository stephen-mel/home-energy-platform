# Stage 3B1: retained original tariff and read-only recovery

This increment is persistence/recovery infrastructure, not an executable SMART
lifecycle. No provider transport, executor, receipt issuer, finalisation contract,
approval, attempt latch or historical evidence is changed.

## Versioned representation

`OwnershipSnapshot` is an explicit union of existing v2 snapshots and v3 lifecycle
snapshots. A v3 snapshot retains a complete, exactly validated `ObservedTariff`,
including its source identity, with the original tariff fingerprint. Its version-1
`lifecycle` binds site/timezone, originating mutation and initial/classified journal
record IDs, issuance/receipt identities, current ownership generation, and the
latest readback fingerprint and operation/receipt identities.

`restorationObligation` is always `required` in this increment. Neither empty
managed intervals nor a successful recovery can discharge it. Original observation,
fingerprint, site/timezone and originating journal identities are immutable across
all retained generations. A later applied tariff's readback identity can change.

## Existing durability mechanisms

The existing SQLite `ownership` and `applied` tables, schema `user_version=2`,
DELETE journal mode, transaction, CAS, uniqueness checks, pair verification and
anchored-history verification are reused. This is a new **snapshot version**, not
a new database or a schema migration. V3 application identities additionally bind
the lifecycle fingerprint, and application records retain the lifecycle copy so
history validation can detect substituted originals or lost obligations.

The private `commitOwnership` primitive accepts optional retention material. Its
v3 branch is exercised through the existing test-only VM harness. It is not
exported and has no production caller: `persistConfirmedSmart` continues issuing
only v2 writes through its unchanged legacy receipt/finalisation contracts. There
is no public raw-evidence writer, feature flag, CLI or route enabling v3 writes.

The corresponding existing linked journal must already be durable. This increment
does not write or modify it. Both legacy `site-<site>.jsonl` and existing
`site-<site>-attempt-<mutation>.jsonl` layouts are recognised, with an explicit
locator enum rather than a supplied filesystem path. The directory is the existing
`tesla-experiments` sibling of the ownership database directory. Exactly one linked
initial/classified pair is required, validated by the existing journal validators.
The pair must describe an accepted, representation-preserved result originating
from missing ownership. Its complete original observation, site/timezone, mutation
and record identities must agree with the retained original, and its readback must
match the root application. Partial, missing, duplicate, unsafe or conflicting
journal evidence blocks retention and recovery; neither copy is a repair source.

The journal and SQLite are not a cross-file transaction. A journal can exist
without a committed snapshot, but cannot supply a missing snapshot or create
restoration authority. Missing/conflicting journal evidence after a commit makes
subsequent recovery fail closed. The journal is read while the SQLite snapshot and
history are held in a read transaction. These integrity checks do not authenticate
arbitrary files supplied by an actor who controls both persistence locations.

## Recovery and trusted review

`recoverOriginalBaseline(databasePath, energySiteId, timeZone)` is read-only. It
uses the existing ownership reader to validate the exact schema, snapshot checksum,
full available history chain, immutable baseline identity and durable origin
journal before returning a detached original. It returns explicit blockers for
missing, corrupt, conflicting, incomplete or legacy evidence. It cannot write,
repair, migrate, mint a capability, clear a latch or infer a baseline.

The six authority/proof flags remain false, including execution, retry and
restoration proof. The original is historical data, not a fresh Tesla observation;
recovery makes no claim about current hardware state or permission to restore it.
The retained latest readback is the identity recorded by ownership persistence,
not a new verification against Tesla.

Stage 3A's trusted adapter can consume a v3 original returned by the ownership
store. It keeps fresh-current-Tesla conflict checks and passes existing managed
ownership to the desired-state calculation. Its pure review function assumes its
caller supplied trusted store output; structural snapshot validation is not a
substitute for the store's durable history/journal validation. All execution and
retry flags remain false. V2 snapshots retain their original interpretation and
continue to return `RESTORATION_BASELINE_UNAVAILABLE`.

## Explicit Stage 3B2 boundary

Deferred: complete apply/update/restore receipt issuance, trusted binding of each
new operation's readback to those receipts, ownership finalisation for complete
operations, production creation of v3 snapshots, new journal formats needed by
those operations, restoration-obligation discharge, and executor integration.
Existing v2 snapshots are never upgraded implicitly, and v3 snapshots cannot be
downgraded or accepted by legacy execution/attempt contracts that require v2.
The journal origin support here covers the existing linked-record contract only;
offline rehearsal frames are not reclassified as production execution evidence.

## Validation

`tests/tesla-retained-original.test.mjs` uses the existing isolated rehearsal to
produce a genuine linked fixture pair, then the existing private SQLite harness
for simulated generations. It checks durable restart recovery without mutations,
exact baseline identity, corruption, cross-copy conflicts, missing journals,
legacy compatibility, CAS/replay/duplicate identities and transaction rollback.
No real credentials, live network or historical report modifications are involved.
