# Stage 3B2-C3: private offline completion-to-receipt binding

C3 extends C2 inside the existing closed **test-only** helper. No application
receipt issuer, completion registry, executor, ownership store or V1 path changes.
There are no production calls, ownership commits or update/restore operations.

## Live binding, not documentary promotion

The unchanged C2 path requires its private single-use admission, fixed internal
providers, exact operation-specific approval, coverage/validity, safe export/import
pricing, a durable initial record, one simulated state change, and exact simulated
readback. The existing journal then persists and validates the V2 completion.

Only after physical journal recovery and complete E/J/D validation succeed does
C3 create a private completion object. A closure-local WeakMap binds that object
to the live C2 admission and exact confirmed evidence. Its get/set operations are
captured like the existing private completion-registry pattern. No registration,
issuer, constructor, lookup or hydration method is exported.

The private binder requires actual membership, unused status, a still-live harness
that has not recovered, the consumed matching C2 admission, exactly one simulated
write, the entire exact evidence snapshot, the original pending initial record and
readback equal to internally controlled Tesla state. It consumes membership before
other issuance checks, so any issuance attempt is single-use. Public rehearsal
also consumes its attempt before awaiting, excluding concurrent/repeated issuance.

Receipt construction is synchronous inside the closed successful rehearsal. JSON,
approval, copied capability objects and even fully rehashed evidence cannot register
membership. Reopening the harness invalidates live state and never registers a
completion. Confirmed-but-unfinalised journal history stays documentary and blocks
a second first apply.

## Offline representation

The returned `offlineReceipt` is frozen and explicitly versioned:

- `version: 1`, `kind: offline-v2-confirmation-receipt`.
- `mode: offline-test-only`, `authentication: fixtures-only` and provenance
  `closed-harness-simulation-not-runtime-authentication`; production authority
  flags remain false.
- `operation`: full validated V2 confirmed-operation evidence. This binds site,
  timezone, operation/mutation, approved exact payload, approval identity, explicit
  D validity and attribution, before/expected-after generation, original baseline,
  initial/completion journal identities, accepted simulated execution and exact
  simulated readback. First apply has no predecessor or existing ownership.
- `preparedFingerprint`: the exact live prepared-context identity.
- `offlineIssuanceId`: a fresh `offline-c3-` UUID reference allocated privately
  with the completion identity. Identical isolated fixture runs therefore have
  distinct issuance references.
- `receiptKey` and `issuanceKey`: canonical, purpose-separated content fingerprints
  binding the above evidence and reference. These are NOT runtime capabilities or
  evidence of production registry membership. Copying/recomputing them grants nothing.

No receipt is persisted into ownership or journal storage. Journals retain their
existing offline-mode schema and simulated readback identity. Recovered journals
cannot be converted into a new offline receipt through a public API.

## Production and downstream boundary

`issueConfirmedSmartReceipt()` still returns `JOURNAL_COMPLETION_NOT_BOUND` for
the C2 identity and V2 records. Neither C3 identity nor receipt is registered in the
production WeakMap. The receipt also fails the existing V1 receipt validator and
finaliser; it is deliberately NOT a `ConfirmedSmartReceipt`.

The existing pure `projectAttributedIntervals(intent, submittedAt)` kernel can read
the embedded V2 intent without gaining authority. A complete downstream V2 finaliser
cannot currently consume this receipt: `ConfirmedSmartReceipt`,
`validateConfirmedSmartReceipt()` and `finaliseConfirmedSmartOwnership()` only
support the V1 proposal/prior/execution contract. F1 validates supplied lifecycle
documents but does not derive ownership from this offline receipt.

The next missing offline interface is an explicitly versioned test-only finalisation
consumer for this representation and independently checked E/J/D context, preserving
explicit D validity and immutable original lineage. C3 does not implement that
consumer, cast this wrapper to V1, create runtime identity references or commit V3
ownership. Production V2 confirmation/receipt authority remains a separate missing
trusted-runtime integration.

## Validation scope

Focused tests cover exact binding and immutability, issuance uniqueness, concurrent
issuance/replay, no public issuer/provider hooks, copied/rehashed receipts, forged
or copied completion identities, rehashed substitutions of readback identity,
payload, generation, approval, validity and site, and recovery without issuance.
C1/C2 focused tests retain mismatched-readback, interruption, ambiguity, stale
inputs, fixed-export and BUY_BELOW_SELL cases. Every failure stays non-authoritative;
durable confirmation alone never becomes committed ownership.

As in C1/C2, mutation of test source/loaders/prototypes is outside this fixture API
boundary. This helper must never be installed as a production trust anchor.

## Checkpoint QA qualification

QA outcome: qualified PASS. The review reported 8 additional adversarial probes
and 16 focused tests passing, with no reproducible blockers. The reviewer
contributed to an earlier draft, so review independence is limited; this outcome
must not be described as fully independent QA.
