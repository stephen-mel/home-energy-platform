# Stage 2D2B2A — isolated local Kraken observation persistence

## Boundary and runtime

`src/lib/kraken/schedule-store.ts` exports `scheduleObservationStore(path?)` and
`scheduleScopeId({siteId, accountRef})`. There is **no production ingestion caller**,
network access, scheduler, dashboard change or Tesla dependency. Account references
should be opaque local identifiers; never supply credentials. The caller must
establish complete authenticated retrieval, including full vehicle enumeration.
An `authenticated-query` field is an assertion of provenance, not an authentication
capability. Stage 2D2B1's typed completeness results must be honoured by any future
caller. Cached/stale state cannot be submitted as a newly authenticated read.

The default separate database is
`<cwd>/.cache/home-energy-platform/kraken-observations.sqlite`, already covered by
Git's local cache ignore. No file is created merely by importing the module.
Local Node **26.8.2** is required, matching the available tested built-in SQLite
runtime. No npm dependency or package configuration change is needed. This is
not a Vercel/cloud/multi-host persistence design. Never share the file over a
network filesystem. Multiple local processes must use the same durable filesystem
with working SQLite file locks; correct local clocks and honest read timestamps
remain caller prerequisites.

## Schema and validation

Schema version 1 contains one STRICT `scopes` table with `site`, `account`,
`payload`, `checksum` and binary composite primary key `(site, account)`.
Payload version 1 holds the latest complete observation and retained revisions.
Each revision includes exact before/after observations, the approved pure
comparison result and `emptiedVehicles` (explicitly supplied absence, not a
supplier cancellation or tariff determination). Scope binding uses an unambiguous
JSON tuple. Original offsets/timestamps, names, dispatch types and decimal energy
strings survive; milliseconds and comparison identities are validated on load.

Opening validates exact schema/version/index definitions; unexpected tables,
views, triggers or schema changes fail closed without repair/migration. Every
loaded observation is reconstructed through Stage 2D2A and checked for exact
agreement. Every revision is recomputed; chronological/unchanged transitions
between retained revisions and the latest snapshot must validate too. Checksums
catch corruption but do not authenticate evidence against someone able to rewrite
both SQLite data and checksums consistently. Retention means this is not a complete
immutable historical audit log.

## Transaction and ordering

`record(scope, read)` first validates/detaches the supplied observation using the
unchanged Stage 2D2A module. Only complete authenticated-query input can proceed.
Then `BEGIN IMMEDIATE` covers schema/prior-state validation, ordering, comparison,
append, retention and replacement. Immediately before COMMIT, the exact intended
payload is reread and independently validated. Statement success alone is not
accepted as proof. Suppressed/transformed writes roll back.

The next read must start **strictly after** the last accepted completion timestamp.
Overlapping reads, equal-boundary reads and older late completions reject. Exact
replay of the latest full observation returns `already-recorded`, with no change.
Equal timestamps with different evidence reject even if economic coverage would
be equivalent. Later identical schedules update retrieval metadata but append no
revision. Vehicle label/offset spelling/order changes alone likewise add no
revision under Stage 2D2A. Split/combined intervals can append a structural revision
while `coverageChanged` remains false. No physical charging data changes coverage.

Busy timeout is zero: lock contention returns `busy`, without waiting/retrying.
Whichever writer obtains the lock first is checked against committed state; a
later writer must revalidate inside its own transaction. This does not invent
Kraken revision order or guarantee the most recently published supplier schedule.
A rejected overlap needs a genuinely new future read, not rebasing or timestamp
rewriting. No such retry is implemented here.

## Retention and capacity

Keep the latest observation plus at most **100 meaningful revisions per scope**.
Canonical UTF-8 payload limits are **1 MiB per scope** and **8 MiB across scopes**.
Oldest revisions of the updated scope are removed first, possibly all of them.
Other scopes are never evicted. If the intended latest observation still cannot
fit, return `rejected / CAPACITY_EXCEEDED` and roll back: the prior latest and its
history remain intact. No success or new retrieval timestamp is reported.

The database uses 4 KiB pages, a 4,096-page (16 MiB) ceiling, DELETE rollback
journalling and synchronous EXTRA. The rollback journal can temporarily require
additional disk space; the 16 MiB limit is not a total filesystem quota. Free pages
are reused and the database does not automatically shrink or vacuum. Disk-full
and filesystem failures fail the transaction; callers must inspect the result.
New files use mode 0600 and new directories mode 0700; non-private files and
symlink database files reject. Use a private, trusted parent directory.

## Outcomes and restart

- `persisted`: initial, unchanged or changed, with the resulting immutable ledger.
- `already-recorded`: exact latest replay, no generation/freshness advancement.
- `rejected`: incomplete/invalid read, wrong scope, overlap/order or capacity issue.
- `busy`: another transaction holds the required lock; no automatic retry.
- `invalid`: unexpected schema or invalid persisted evidence; no repair.
- `store-failed`: definite failure before attempting COMMIT.
- `indeterminate`: COMMIT/acknowledgement/close may have succeeded; do not claim
  absence or automatically repeat the operation.

`read(scope)` returns missing, invalid, unavailable, or validated data explicitly
marked `origin: disk, lastKnown: true`. Original retrieval time is never renewed.
An unavailable/corrupt file is not treated as empty history during an append.
An empty uninitialised database left by interrupted initial creation can initialise
transactionally; nonempty/unknown schemas cannot. Interrupted SQLite transactions
recover through rollback journalling. Exact replay supports callers checking the
same supplied observation after uncertainty, but no recovery orchestration exists.
The existing Kraken JSON cache and all live consumers remain unchanged.

## Tests

Tests use temporary databases, synthetic evidence, independent child processes,
and test-only SQLite wrappers. They exercise real transactions, lock contention,
late/equal reads, restart validation, scope binding, malformed state/schema,
statement suppression, failures before/after COMMIT, process exit with uncommitted
writes, retained revisions and both capacity caps. They make no external calls.

### Native rollback recovery during reads

A logically read-only `read()` opens an existing database with SQLite URI
`mode=rw` so SQLite can recover a hot rollback journal. `mode=rw` cannot create
an absent database, including if the file disappears between inspection and
opening. The read connection enables `query_only` before inspecting database
contents: application writes and schema initialisation remain prohibited.
SQLite's native recovery is permitted and is not a new authenticated observation.

Recovery can require write permission on both the database and its directory /
rollback journal, even for a logically read-only operation. Inaccessible or
unrecoverable files return `unavailable`; malformed state remains fail-closed.
Missing files return `missing` without creation, and empty existing files are
not initialised by reads. There are no recovery retries or application repairs.

The crash regression forces dirty-page spill, verifies the hot-journal header,
then SIGKILLs the writer. The first subsequent SQLite connection is `read()`;
it must recover the original committed observation without exposing the
interrupted update. Additional tests cover missing/empty files, disappearance
at open, query-only enforcement and actual filesystem permission denial.
