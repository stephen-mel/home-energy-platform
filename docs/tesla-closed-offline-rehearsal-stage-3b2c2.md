# Stage 3B2-C2: closed offline first-apply rehearsal

C2 extends the existing C1 test helper only. It is NOT runtime admission, a
production executor, an authentication adapter, a production completion issuer or an ownership
writer. No application source, V1 operational path or September evidence changes.

## Sequence and private identity

`closedOfflineV2().rehearse()` prepares through C1 or consumes the live preparation
from `prepare()`. It accepts no arguments, documents, callbacks, paths or provider
selection. Only allowlisted internal fixture scenarios are selectable at creation.
C1 approval, explicit validity, coverage, fixed-export and BUY_BELOW_SELL gates remain.

After the existing offline journal durably records its initial phase, the helper
privately retains its pending completion handle and creates an opaque object bound
in a local test-only WeakMap to the exact prepared context and initial/active journal
bytes. The context binds site, operation/mutation, original baseline, payload,
approval, attribution/validity, evidence and expected generations. No token, map,
registration function or hydration function is returned or persisted.

The private simulated execution port requires that live identity, consumes it before
any await, verifies the durable files, and reruns the existing fresh preparation
recheck. It changes only the helper's in-memory Tesla fixture state, at most once.
Its readback is independently constructed from that controlled state. The journal's
completion port accepts only that private result for the exact initial record and
checks state equality and the simulation count. It accepts no caller-supplied result.

The existing `pending.recordCompletion()` performs V2 completion validation, exact
readback comparison, durable append/sync/close, completion-marker persistence and
history verification. C2 then explicitly exercises `validateConfirmedOperationEvidence`
against the physically recovered journal context. Ownership SQLite rows/bytes stay
unchanged. The initial original tariff is never replaced by the simulated applied one.

## Furthest boundary

A successful result reports `furthestCompletedStep: 5`, documentary V2 evidence and
`evidenceProvenance: simulated-offline-tesla-state-not-authenticated`. The readback ID
also explicitly starts `simulated-c2-`; journal markers retain J's `offline-context`
mode. The observation uses the existing `tesla-site-info` fixture shape solely to
exercise current validation. That string is NOT authentication. All production
admission/execution/completion authority flags remain false.

C2 calls the existing receipt issuer with the private TEST identity and exact V2
records. The production registry correctly rejects it with
`JOURNAL_COMPLETION_NOT_BOUND`: `JournalCompletionEvidence`,
`journalCompletionForRecords()` and `issueConfirmedSmartReceipt()` currently support
V1 completion, not trusted V2 completion. This is the first missing boundary.
No V1 receipt is manufactured. C3 adds a separate private, explicitly offline
receipt binding (see `tesla-closed-offline-receipt-stage-3b2c3.md`); this does not
change the production rejection. Ownership finalisation is not attempted. The existing
`ConfirmedSmartReceipt` / `finaliseConfirmedSmartOwnership()` paths also remain V1;
a future versioned integration must explicitly preserve D validity and F1 lineage.
No SQLite V3 ownership commit is attempted.

## Fail-closed behaviour and recovery

Concurrent or replayed rehearsal calls cannot simulate twice. Any rehearsal outcome
consumes the test attempt, including failed preparation, interrupted simulation,
ambiguous write, stale recheck, mismatched readback or forged internal completion.
Uncertain outcomes keep the existing durable initial/active journal blocking;
no confirmed completion is invented and no automatic retry occurs.

`reopen()` loads a fresh journal reader and invalidates the current test admission.
Pending state stays blocked; confirmed history is readable but cannot rehydrate
admission, completion or receipt authority. A confirmed-but-unfinalised first apply
also blocks a second apply. There is no update/restore path.

The C2 tests include exact simulated confirmation, replay/concurrency, internally
consistent rehashed copies, callback/result injection, forced interruption before
and after the in-memory change, ambiguous outcome, stale evidence, forged completion,
mismatched readback, restart and the receipt boundary. C1 focused tests are rerun
because its helper is extended; application regressions need not be broadly rerun.

As in C1, these are fixed offline fixtures in temporary storage. Controlling test
source, module loaders or prototypes lies outside this interface boundary. This
helper must never be imported as a production authority mechanism.
