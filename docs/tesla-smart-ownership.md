# Persistent SMART ownership evidence

The ownership ledger attributes bounded import changes to HEP; it is not a tariff
source, approval, proof of E.ON charging qualification, or proof of API rollback.
Existing production blockers and the consumed supervised-experiment latch remain
unchanged. No executor, dashboard, polling or Confirm button is connected here.

Lifecycle:

**observed baseline → proposed SMART change → future confirmed Tesla write/readback
→ ownership recorded → later reconciliation → safe retention/restoration**

This feature implements storage and consumption of evidence only. It does not
perform the confirmed write/readback step. Nothing about generating a proposal,
an HTTP 200, human approval or observed Powerwall behaviour alone records ownership.
Experiment #1's ambiguous write/manual restoration is not retrospectively entered.

## Record and trust boundary

`ownership-evidence.ts` defines version 1 records with Tesla site ID, IANA timezone,
creation/update times, explicit validity end, SHA-256 fingerprints of the baseline,
exact readback representation, proposal binding and SMART evidence, and disjoint
bounded intervals. Every interval stores its inclusive start/exclusive end,
applied import price, original restoration price and restoration-baseline digest.
Prices use the existing major-currency/kWh model, without tolerance or rounding.
Instants require an explicit UTC/offset suffix, valid Gregorian calendar and clock
components, and at most millisecond fractional precision. Impossible dates are
rejected before conversion, including in confirmation receipts. Stored interval timestamps use UTC; the IANA
zone remains attached, retaining the distinction between repeated London hours.

The restoration digest stays with an interval when later SMART changes extend or
move it. Its restoration price must not become the previously applied cheap price.
Record fingerprints identify evidence; they are not signatures or an authentication
mechanism. The local store and its caller are trusted server components. It must
never accept a browser-supplied claim that a write/readback succeeded.

The future integration calls `recordConfirmed` with a consistent strict replacement
proposal, its exact authenticated before-state, a submitted-representation-preserved
outcome, exact authenticated readback, timestamps and expected store generation.
It rejects simulated/changed readback, ambiguous write outcomes, mismatched prior
ownership and expired submission approval intervals. Capture freshness uses the
existing capture TTL. The currently unconnected API does not authenticate Tesla
itself: a future supervised lifecycle must establish that provenance and retain all
existing approval, SMART freshness and executor safety checks before calling it.

## Local persistence

`ownershipStore()` defaults to:

`.cache/home-energy-platform/tesla-smart-ownership/site-<Tesla site ID>.json`

The existing `/.cache/home-energy-platform/` Git ignore rule covers the records and
adjacent temporary files. Records contain only prices, bounded instants, provenance
digests and version/generation metadata; no credentials, raw API payloads or tokens.
Writes use exclusive owner-only temporary files, file sync, atomic rename and parent
directory sync. Readers see either the complete previous or next record. Missing,
malformed, incompatible, checksum-mismatched or unreadable data establishes no
ownership. A corrupt file cannot be overwritten through the recording API.

A process-global queue per absolute site-file path coordinates separate server
module instances. The expected-generation check occurs inside that queue. The
queue follows the actual filesystem operation, including cleanup, so abandonment
or timeout of a caller does not release a pending rename. Stale writers fail;
a later valid confirmed receipt must name the latest generation. A failure before
rename preserves the previous file. A directory-sync error after rename reports
failure although the new file may exist; reload and review before any retry.
There is no retry loop or distributed lock. Multi-process deployments need a
replacement transactional store; filesystem rollback/tampering is outside this
local trust model. There is no automatic repair/delete/latch-reset path.

## Reconciliation

The pure reconciliation input retains `managedImport`, now a validated durable
record instead of arbitrary baseline/signal context. A future server caller must
load an available record and pass its evidence; it must surface invalid/unavailable
store results rather than treating them as confirmed ownership. This task does not
wire store reads into dashboard polling or execution.

Before constructing any replacement, all still-relevant owned intervals must match
current observed Tesla import prices exactly. Changed manual prices, unknown
coverage, wrong site/timezone, expired validity, future evidence or overlapping
records fail closed. This applies even if Kraken still requests the same SMART
interval. Already-restored prices are a contradiction, not permission to overwrite.
Differences elsewhere, including Tesla's export/base tariff values, stay unmanaged.

A current conditional SMART requirement selects HEP's SMART import value. When
that requirement ends, only an attributed interval may select its recorded original
price. Missing ownership preserves observed state as unmanaged; previous Kraken
schedules and resemblance to a cheap rate never establish ownership. Splits and
merges compare economic intervals, not dispatch IDs. Elapsed portions are excluded
from the reconciliation domain; record age alone is not proof of a manual change,
but explicit validity and a fresh matching Tesla observation are required.

The recording API requires coverage of every still-relevant owned portion:
`[max(interval.start, recordedAt), interval.end)` for intervals ending after
`recordedAt`. Elapsed prefixes may fall outside the receipt domain; current/future
prefixes and tails may not. Retained portions keep their original restoration
price and baseline digest through shortening and later removal. Exact confirmed
restoration can retire the remaining ownership without retaining elapsed claims.

## Remaining safety boundary

Ownership does not make proposals executable and does not set `rollbackProven`.
BUY_BELOW_SELL, ROLLBACK_UNPROVEN, BOUNDED_FORECAST, RESTORATION_REQUIRED,
OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED and all other existing blockers remain. Planned
SMART conditions remain planned-conditional. A future bounded task must connect a
fresh, exactly approved supervised write and independently verified readback to
this store, reload/check generation at that boundary, and explicitly handle
transformed/ambiguous Tesla responses. No automatic execution or rollback is added.
