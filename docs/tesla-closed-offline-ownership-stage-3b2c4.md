# Stage 3B2-C4: closed offline V2 ownership projection

C4 adds `projectOwnership()` to the existing closed test harness. It accepts no
arguments, receipts, paths, callbacks or provider configuration. If necessary it
runs the existing C1–C3 first-apply rehearsal, then privately consumes the exact
C3-issued receipt. Existing `prepare()` and `rehearse()` behaviour is retained.

This is TEST-ONLY glue around existing pure ownership logic, not a second production
finaliser. There are no application changes, production API calls, ownership writes,
update/restore admissions or changes to September evidence or attempt latches.

## Private single-use receipt consumption

The existing private completion entry now retains the exact frozen issued receipt,
its canonical representation and a projection-consumed flag. The receipt reference
is published into the private harness state only after successful rehearsal. A
private consumer requires the exact issued object and its live completion/admission
binding, and consumes before asynchronous validation. A copied, reconstructed or
rehashed receipt is not that object. No issuer, registration, hydration or raw
receipt-consumption function is public.

The consumer independently rereads physical journal history, requires exactly the
same confirmed first apply, and reruns the E/J/D evidence validator using the
existing independently selected fixture providers. It reads the actual SQLite
ownership state and requires it to remain missing. The exact approved generation
is checked by the existing preparation precondition predicate. The receipt must
still match its complete admitted operation, payload, site, generation, approval,
explicit validity, completion and simulated readback.

Both the public projection attempt and the private receipt consumption are
single-use. Concurrency, failure, replay and restart cannot register a new receipt.
`reopen()` discards the private receipt/completion references; recovered journal
JSON remains documentary, even when confirmed. No automatic retry occurs.

## Pure derivation and F1 rules

Intervals come only from `projectAttributedIntervals(intent, submittedAt)`, which
uses the existing `deriveOwnershipTransition()` kernel. C4 does not reimplement
rate comparison, coverage, interval ownership or restoration-price logic.

The projected ledger uses the existing `ManagedImportEvidence` schema and
`validOwnership()` validator. Creation/update timestamps describe confirmation.
Proposal/Kraken fingerprints follow the existing V2 fixture conventions (the
complete intent and captured Kraken content), not a production V1 receipt cast.
Its `validUntil` is copied from the explicitly approved validity policy. The full
approved policy, including its start, end and provenance identities, is separately
preserved. It is never inferred from comparison-domain, dispatch or approval TTL.
The fixed `projection-validity-beyond-domain` scenario approves validity until
17:00 while the comparison domain ends at 16:00, without enlarging owned intervals.

F1's applicable original/active-obligation invariants are checked through
`validRetainedOriginal()`, `retainedOriginKey()` and explicit correspondence with
the validated journal context. The complete retained original, origin identities,
expected generation and latest-readback identities are copied unchanged from that
context. The restoration obligation remains `required`.

C4 does NOT construct an F1 lifecycle document by inventing
`RuntimeReceiptIdentityReference` values, application history or a SQLite
`historyDigest`. F1's full runtime/history mapping requires facts that this offline
projection deliberately lacks. Terminal or conflicting ownership cannot enter the
first-apply path; substituted receipts referencing those states fail identity checks.

## Projection representation

The frozen wrapper is version 2, `kind: offline-v2-ownership-projection`, provenance
`private-offline-receipt-not-committed-ownership`. All production authority flags
are false. Its fields retain:

- Site, timezone, operation/mutation and approved before/expected-after generations.
- Offline receipt references, approved payload/approval/attribution identities,
  prepared-context fingerprint and documentary initial/completion/evidence IDs.
- Separate comparison domain and complete approved validity policy.
- `retainedOriginal`: immutable original Tesla observation, tariff fingerprint and
  originating journal lineage from J. Its origin receipt reference remains the
  documentary E evidence ID; it is NOT rewritten to the C3 offline receipt key.
- `comparisonBaseline`: immediate pre-write observation and acquisition identity,
  with its own observation fingerprint. It is a separate frozen value. First apply
  requires the same content as the original, but the roles are not conflated.
- The validated ownership ledger and a purpose-separated projection fingerprint.

The result also includes the documentary C3 receipt for later offline persistence
rehearsal. Neither the projection nor receipt is a capability or committed ownership.
The `confirmed-write-readback` ledger basis and `tesla-site-info` observation shape
are existing fixture schemas, NOT proof of real Tesla authentication.

## Boundaries and validation

Checkpoint QA: PASS, with 10 independent C4 adversarial probes and no
reproducible blockers. Review-independence qualification: the reviewer contributed
to the earlier C3 foundation, but not to this C4 increment. Offline persistence
mapping remains unavailable, as intended.

Focused tests cover exact private receipt consumption, immutable original lineage,
explicit validity beyond the comparison domain, missing coverage/validity,
ambiguous completion, existing ownership, copied/rehashed receipt substitutions,
changed payload/generation/original, terminal/conflicting predecessor substitution,
concurrency/replay, recovery and rejection by production completion/receipt/finaliser
contracts. SQLite ownership rows/bytes stay unchanged by projection.

There is no missing pure interface for this bounded first-apply projection. A later
persistence rehearsal needs an explicitly offline mapping; this wrapper is not a
production V3 SQLite commit input. Actual runtime identity/history and atomic V3
persistence remain separate unimplemented integrations. No synthetic committed
history or production authority is introduced to bridge that gap.
