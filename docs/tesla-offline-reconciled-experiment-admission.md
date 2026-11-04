# Offline reconciled experiment admission

`admitOfflineReconciledExperiment()` extends the existing repeat-attempt journal
module for offline documentary admission only. It is not connected to the CLI,
executor, private completion registry or ownership writer. All runtime authority
flags remain false and `CURRENT_EVIDENCE_PREPARATION_ONLY` is mandatory.

## Reconciliation policy

A distinct experiment may receive its own separately approved reconciliation of
prior conflicts. That approval binds the immutable prior physical journal bytes,
new experiment/mutation/initial-record identity, complete original tariff evidence,
site/timezone, current ownership, current SMART evidence and pricing. A separate
experiment approval binds the same intent. Approval identities must differ. Fresh
independent capture/ownership reads are repeated after approval and under the lock.
Missing, malformed, incomplete, changed or expired evidence fails closed.

This records `prior-conflict-reconciled-for-new-experiment` and explicitly
`historicalApiRestoration: not-proved`. It does not change a historical API outcome,
prove causation or API restoration, remove a restoration obligation, or turn an
empty ownership snapshot into restoration proof. Outstanding or invalid ownership
still blocks. Unfinalised claims and incomplete/invalid journal records cannot be
reconciled through this contract. Known mutation identities cannot be reused.

The existing baseline assessor validates unlinked historical records without
upgrading them to linked records. Linked V1 chains use the existing history
validator. No historical files are rewritten, renamed, deleted or supplemented
with inferred attempt identities. Reconciliation is bound to their exact bytes.

## Persistence and recovery

The existing physical-directory, exclusive `wx`, file/directory fsync and journal
naming conventions are reused. The new admission has a version 3,
`offline-reconciled-experiment` active marker and the existing V1 linked initial
journal under its distinct mutation name. The active marker is permanent in this
increment: there is no finish, release, retry, restoration or completion method.
All existing production claimants continue to see an outstanding active claim.
An interrupted write or failed recheck leaves the claim blocking across restart.

`readOfflineReconciledExperiment()` verifies retained initial/evidence/approval
bindings and exact prior-file digests and returns documentary consistency only.
It does not call acquisition ports, renew approvals or resume an operation. Missing,
changed or extra operation evidence fails closed. Valid recovery remains blocked
and every runtime authority flag is false.

## Trust limitations and future integration

The independent acquisition and two approval ports are supplied by offline trusted
composition (fixtures in tests), following the existing offline operation-journal
pattern. They are not production authentication or a trusted reconciliation issuer.
Calling a callback, producing consistent JSON or recomputing hashes does not prove
Tesla/Kraken authentication. Recovery never grants such provenance. A future closed
production acquisition/approval binding is still required before live admission.

The durable root must be owner-only and physically trusted, as required by the
existing journal. Arbitrary replacement of every file by a privileged writer is
outside its integrity boundary. This increment adds neither a second store nor a
production completion capability, and cannot unblock the historical CLI latch.

Tests use temporary synthetic September-shaped evidence, never the real historical
journal, report, captures or credentials. No external calls are made.
