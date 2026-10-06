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

The legacy `recordConfirmed` production write entry has been retired. Its
replacement-lifecycle checks remain in the pure `deriveReplacementOwnership`
function, which cannot persist anything. The selected-SMART finaliser remains a
separate lifecycle; these derivations are not interchangeable.

## Local persistence

SQLite is now the authoritative local supervised ownership format. See
[SQLite ownership persistence](tesla-ownership-sqlite.md) for its private transaction
boundary, runtime pin, preconditions, idempotency and failure semantics.

`ownershipStore()` exposes only `read`. Its default database is:

`.cache/home-energy-platform/tesla-smart-ownership/ownership.sqlite`

No production write entry is exposed yet. A future separately reviewed operation
must verify genuine B2 completion and exact linked records, issue the receipt and
finalise ownership before invoking the private commit. Arbitrary receipts and
finaliser outputs provide no write authority. No executor connection is added.

Legacy `site-<Tesla site ID>.json` files are never silently migrated or read as
current ownership. Their presence fails closed with `OWNERSHIP_LEGACY_UNRESOLVED`,
including when SQLite also has that site's state. A migration decision is deferred.

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

The retained pure replacement derivation requires coverage of every still-relevant owned portion:
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
