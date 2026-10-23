# Stage 2 offline supervised SMART lifecycle slice

This increment is an **offline rehearsal**, not an executable household command.
No route, CLI, timer, provider adapter or production enablement setting calls it.
Its injected `simulatePost` port must only be supplied by a synthetic transport.
It is not a security sandbox for arbitrary code: a caller capable of supplying
arbitrary functions could supply network I/O. No such caller is included here.

## Reused boundaries

- Stage 1 `deriveSmartTariffDesiredState` constructs the complete tariff.
- `inspectSmartTariff` rejects incomplete schedules and unverified import pricing.
- Existing proposal approval validates the apply proposal. Both operations also
  bind consent to the exact payload, current baseline, expiry and displayed risks.
- The existing supervised executor's classifier and restoration readback
  comparison distinguish preserved, rejected, transformed and unknown outcomes.
- The repeat-attempt journal's directory containment, exclusive creation and
  file/directory sync mechanics retain the exact baseline before simulation.
- The ownership snapshot is read through an injected adapter and must remain
  missing or valid-empty and identical through the pre-write recapture.
- Fresh-baseline policy is evaluated and reported without fabricating trusted
  rollback observations, historical identities or production account provisioning.

The old single-selected-dispatch executor, its linked B1/B2 records, receipt
issuer and ownership SQLite writer are unchanged. They cannot currently consume
a complete replacement/restoration transaction. This rehearsal neither pretends
those contracts accept one nor issues substitute capabilities. No ownership is
persisted from a simulated readback.

## Lifecycle

1. Capture detached fixture Tesla/Kraken evidence and ownership. Require an exact
   original baseline, validated SMART proposal and unchanged export representation.
2. Present the complete apply payload, baseline and production blockers. Require
   separate explicit consent, including every displayed blocker and manual recovery.
3. Capture again. Reject changed Tesla representation, ownership, site, schedule
   or desired payload. Retain existing expiry and freshness limits.
4. Exclusively create and sync the active journal containing baseline, evidence,
   exact payload and approval. Recheck expiry after the durable claim. Simulate
   exactly one POST, then one readback. A matching GET cannot rescue an unknown
   POST outcome. Readback must occur strictly after the attempt and no later than
   completion. Append and sync the classified result.
5. A new invocation may review restoration only after a preserved apply result.
   It recaptures the complete household Kraken schedule and current tariff, derives
   rehearsal ownership from the confirmed apply/readback, and requires the Stage 1
   desired state to say `restore`. `in-sync`, `apply`, `update`, stale or incomplete
   evidence cannot produce a restoration review. The review binds the schedule and
   complete desired-state identity as well as the retained original payload.
6. Recapture both sources again and recompute the desired state. Any schedule or
   desired-state change invalidates approval before the exclusive journal claim.
   Exact authenticated-shaped readback is required for simulated restoration
   success. No approximate reconstruction or automatic restore occurs.

Every result retains `executionReady`, `writeReady`, `rollbackProven`,
`restorationProven`, `resolvesHistoricalJournal` and `grantsRepeatAuthority` as
false. Fixture provenance is not proof of real authentication.

## Durable obligation and recovery

The rehearsal extension uses `site-<site>-attempt.active`, the existing exclusive
site marker. It never removes or renames that marker, even after simulated exact
restoration. Ordinary repeat-attempt eligibility therefore remains blocked.
Any existing legacy journal or attempt artifacts reject the initial claim.
September's journal is never opened for writing or treated as restored.

The append-only active journal has at most four cumulative, linked records:
apply approval, apply result, restoration approval, restoration result. Replay
validates immutable prefixes and recomputes content keys and classifications.
The retained original tariff remains in every cumulative record. A separate
exclusive restoration-claim marker prevents a second restoration after a crash.
Partial files, failed writes/syncs, invalid history and interrupted attempts fail
closed. Failure acknowledging a classified append is reported as indeterminate;
there is no retry or inference of success from later state.

Checksums are integrity checks, not authentication against someone able to rewrite
the whole private directory. The existing journal's durable-root, owner-only
directory and local filesystem/fsync assumptions still apply. Tests use temporary
directories exclusively. Do not point this API at household journals.

## Before a separately approved live experiment

This slice does **not** make live execution ready. Required follow-up includes:

- A reviewed trusted local adapter supplying actual account/site-bound acquisition,
  ownership snapshots and human consent, with no client-submitted trust labels.
- Explicit approved policy for the missing authenticated export MPAN and
  `BUY_BELOW_SELL` risks. Neither is silently waived here; 17.5p assumptions confer
  no identity or execution authority.
- Extending the existing linked-journal/B2/receipt contracts to complete SMART
  replacements and exact restoration, rather than treating these rehearsal records
  as completion authority. Trusted ownership persistence and retirement must use
  their existing CAS/history safeguards.
- Reviewed separation of a new operation from the unresolved September attempt.
  Do not evade its latch by selecting another directory or resetting history.
- Verified inverse tariff-write mapping, restoration acceptance, a supervised
  manual-recovery procedure and independently authorised production enablement.

There is no scheduler, automatic retry, ledger unlock or unattended restoration.
