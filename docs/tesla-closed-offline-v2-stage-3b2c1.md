# Stage 3B2-C1: closed offline V2 fixture composition

This is a **test-only integration foundation**, located entirely under `tests/`.
It installs no production composition, authentication provider, admission registry,
executor, completion issuer, ownership finaliser or SQLite ownership writer.
No runtime trust anchor is established by C1.

## Closed interface

`closedOfflineV2()` creates and owns an isolated temporary SQLite database and
journal directory. Its only optional input is an allowlisted scenario name for a
fixed internal fixture or fault. It accepts no provider callbacks, paths, documents,
approval data, policy data, authentication switches or hooks. Methods accept no
arguments. No acquisition, approval, attribution or persistence ports are returned.

The returned methods are `prepare`, `inspect`, `reopen` and `close`. Every result
is explicitly marked `offline-test-only` / `fixtures-only`, with authority flags
false. Prepared documentary snapshots are detached and recursively frozen. They
are not registered as runtime capabilities. Closing deletes only the harness's
own temporary directory.

## Existing contracts exercised

Internally selected Tesla/Kraken fixtures supply content, schedule/pricing coverage,
and a separately stated ownership-validity policy. They simulate authenticated
acquisition; they do not authenticate anything in production. Approval is an exact
operation-specific fixture over the complete intent. The valid fixture uses a
0.20 GBP/kWh scheduled import rate, above the unchanged 0.175 export rate.

The harness invokes `offlineOperationJournal().recordInitial()`, which invokes
`prepareOperationMutationContext()`, `buildOwnershipAttribution()` and fresh
`recheckPreparedOperation()` calls, including the recheck under the exclusive
claim. The schema and read-only ownership checks use the existing SQLite store.
The journal uses existing durable initial-record and exclusive-claim mechanics.
Preparation requires missing ownership and entirely empty site history. Any prior
valid V2 journal, pending/ambiguous claim, legacy latch or ownership row blocks it.

The private completion handle is deliberately discarded. No completion recording,
Tesla write, receipt issuance, generation reservation or ownership commit occurs.
Successful preparation leaves the initial journal and active marker pending. A
freshly loaded journal reader sees that blocking marker; it cannot resume execution
or recover authority. Repeating or concurrently racing preparation cannot create
two successful claims. SQLite rows and database bytes remain unchanged by preparation.
Fixture setup alone may seed pre-existing SQL/journal records for rejection tests.

`validateFixedExportPolicy()` verifies the fixed fixture's commercial export
assumption and exact export preservation. Existing `dryRunTeslaTariff()` diagnostics
block BUY_BELOW_SELL. Neither gate is weakened or waived. Other production readiness
blockers remain; a successful fixture preparation is not a safe-to-execute verdict.

## Tests and limits

Tests exercise valid preparation, provider/document substitution, stale/missing/
conflicting acquisition, missing coverage/validity, altered approval/payload/
generation, changed attribution at recheck, nonempty SQLite/journal state,
concurrent claims, restart blocking and export/pricing gates. Even an internally
consistent, fully rehashed copied preparation cannot pass the private runtime
completion registry or receipt issuer, and cannot be supplied to this harness.

A process controlling test source, module loaders or prototypes is outside this
fixture-interface boundary. Test-only scenario selection is not a trusted-provider
registration service and must never be imported as a production authentication
mechanism. A future runtime increment still needs a separately reviewed closed
production provenance boundary; C1 does not resolve that dependency by relabelling
fixtures or callbacks as trusted.

V1 code, historical September evidence, fixed-export policy and attempt-latch
implementations are unchanged.
