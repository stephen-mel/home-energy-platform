# Offline reconciled experiment admission

`admitOfflineReconciledExperiment()` extends the existing repeat-attempt journal
module for documentary admission only. The CLI can now connect authenticated
acquisition and interactive approval to this preparation boundary. It is not
connected to execution, the private completion registry or the ownership writer. All runtime authority
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
pattern. The closed interactive CLI now supplies the existing authenticated GET
and validated Kraken acquisition paths, and separate foreground approvals, for
preparation only. Stored approvals remain documentary, not runtime credentials.
Calling a callback, producing consistent JSON or recomputing hashes does not prove
Tesla/Kraken authentication. Recovery never grants such provenance. A separately
reviewed runtime execution-authority and durable completion bridge is still
required before live admission can proceed to a write.

The durable root must be owner-only and physically trusted, as required by the
existing journal. Arbitrary replacement of every file by a privileged writer is
outside its integrity boundary. This increment adds neither a second store nor a
production completion capability, and cannot unblock the historical CLI latch.

Tests use temporary synthetic September-shaped evidence, never the real historical
journal, report, captures or credentials. No external calls are made.

## Interactive preparation connection

The existing local CLI supports `--prepare-reconciled --experiment-id NEW_ID`
alongside its existing site, vehicle and dispatch selection. This mode requires a
foreground terminal and is mutually exclusive with `--execute-supervised`.
It is not invoked automatically by a route, scheduler or dashboard.

The CLI runs the existing supervised executor in dry-run mode to obtain its exact
prepared context. It displays and saves the review, obtains exact preparatory
consent, constructs the existing linked initial record, and supplies the admission
module with fixed acquisition and ownership adapters. Reconciliation and new
experiment approvals each require their own nonce-bound confirmation against the
complete admission binding. Reconciliation explicitly acknowledges that historical
API restoration remains unproved. Existing freshness limits can expire during
operator review; they are never extended.

On success it prints `reconciled-preparation-recorded` and returns. The prepared
review retains `CURRENT_EVIDENCE_PREPARATION_ONLY` and every other safety blocker.
The admission has no finish method or runtime completion capability; no write or
ownership-persistence adapter is called. The active claim remains consumed across
restart and blocks legacy execution. Running this mode is therefore not a way to
unlock or subsequently execute the same operation. No live command is authorised
by preparing or recovering its claim.

The production command was not run as part of implementation. Integration tests
use synthetic responses, temporary durable storage and simulated terminal answers;
they reject every attempted HTTP method other than GET. Restoration can reuse the
same exact-review, independent-approval, pre-write recheck and durable-record
pattern, but its live phase transitions and completion authority remain unimplemented.

## Closed mocked admission-to-apply continuation

`mockedReconciledApply()` in the current-supervised-preparation test suite composes
actual reconciled admission with a private, single-use in-memory simulation. It
accepts only fixed internal fault scenarios, not providers, records, capabilities
or paths. Its identity never leaves the composition and is consumed before the
first asynchronous continuation check. Copied documents and recovery results
cannot replace it. This is a test composition, not a production runtime bridge.

The same distinct admitted operation journal receives two explicitly simulated
records: `simulated-apply-intent` (flushed before the simulated transport), then
`simulated-apply-classified`. The latter wraps an existing validated linked
classification; the wrapper explicitly denies runtime confirmation. No second
historical site claim, completion capability, receipt or ownership write is made.
The original admission marker and historical journal remain unchanged.

Existing current-evidence preparation, strict dual observation validation,
readback comparison, response interpretation and classification are reused.
`CURRENT_EVIDENCE_PREPARATION_ONLY` and `BUY_BELOW_SELL` remain present; simulated
execution does not establish that either production gate has passed. Readback
source labels are synthetic fixtures, not authenticated Tesla observations.

The existing recovery reader deliberately does not interpret these extra test
records as a resumable or completed admission. It fails closed, and all uncertain
or interrupted outcomes retain the exclusive claim. Restoration, terminal claim
completion, production continuation authority and recovery phase interpretation
are still absent. Any future versioned reader must preserve these distinctions.

### Mocked restoration and simulation completion

The same private composition now optionally continues a confirmed exact simulated
apply through separate restore approval, `simulated-restore-intent`,
`simulated-restore-classified`, and `simulation-complete`. Each record is appended
and synced to the existing operation journal. Restore intent precedes the second
in-memory transport invocation; terminal simulation completion follows durable
exact restoration evidence only. The active production claim is never changed.

Restore approval has a distinct identity and binds the experiment/site, immutable
original observation, confirmed apply result, fresh pre-restore observation,
exact original V2 payload and admission marker. Private single-use identity and
approval-object membership prevent document substitution. Original V2 and legacy
encodings, including export and metadata, are compared independently; the current
observation is never substituted for the immutable restoration target.

This reuses `reviewObservedRestoration()`, strict Tesla observation validation,
`compareObservedTariffReadBack()`, and existing result classification. Linked
operation validation is reused for apply. Restore records remain explicitly
simulated wrappers: no V1 apply receipt is fabricated for restoration. Interrupted
intent/result/completion, unexpected external changes, failed approvals and
non-exact or ambiguous outcomes cannot reach simulation completion. Matching GET
fixtures never convert unknown execution into confirmed execution.

Successful simulation does not prove production inverse mapping, API acceptance,
rollback authority, ownership retirement or safe claim release. Production recovery
continues rejecting these extra simulation records, with no authority hydration.
No production executor, journal reader, capability registry or persistence path
has been changed. All readbacks and approvals here are fixed offline fixtures.
