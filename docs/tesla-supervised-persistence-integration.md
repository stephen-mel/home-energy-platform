# Supervised execution → trusted ownership persistence

The local supervised adapter now calls `persistConfirmedSmart` after the executor
returns a durably completed B2 result, and only when its classification is
`submitted-representation-preserved`. The executor returns its original initial
B1 record as `initialRecord`, alongside `record` and the original in-process
`journalCompletion` capability. It neither reconstructs evidence nor persists it.

The classification filter is only an orchestration optimisation. The existing
trusted boundary independently validates the capability, both records, receipt,
transition and complete original Stage A ownership snapshot, including
`historyDigest`. It never refreshes or rebases the captured precondition.

The CLI retains `classification` and `apiWrite` and adds a separate
`ownershipPersistence` summary: status, stage, confirmation, safe diagnostic code
when present, and false write-ready/rollback flags. It does not print the ledger,
records or runtime capability. Non-qualifying execution outcomes report ownership
`not-attempted`. Receipt rejection can report confirmation `not-established`;
finalisation/binding rejection and persistence failures retain `confirmed` once
issuance established it. A conflict, store failure or indeterminate commit does
not replace the Tesla execution classification.

Initial journal failure prevents execution. Classified journal completion failure
prevents persistence even if Tesla changed. The existing exception/latch behaviour
is unchanged. Persistence is outside the execution failure path: no retry, second
POST, latch reset, restoration or restart recovery is added. Exact evidence replay
remains an existing store property, not an automatic orchestration action.

All existing production blockers remain. This is local supervised orchestration,
not dashboard, background or automatic execution. Tests mock all transport and
use genuine local B1/B2/SQLite paths; selected injected persistence results test
reporting without granting substitute authority.
