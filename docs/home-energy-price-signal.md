# Whole-home price signal

This read-only model keeps guaranteed base-tariff rates separate from conditional
Kraken SMART dispatch opportunities. It does not detect charging, verify bills,
recommend battery operation or control any device.

## Current configured tariff

`src/lib/site/current-site.ts` configures E.ON Next Drive Smart V5.2 using the
user-supplied VAT-inclusive consumer rates, stored in GBP major units:

- Standard import: £0.2518/kWh (25.18p).
- Guaranteed off-peak: £0.0299/kWh (2.99p), 00:00–06:00 Europe/London daily.
- SMART scheduled-charging opportunities: £0.0299/kWh (2.99p), conditional.
- Export: £0.175/kWh (17.5p) throughout. This is the configured prototype rate;
  it does not assert that the pending export contract has been activated.
- Standing charge: £0.60/day, retained only in version configuration. It never
  enters the marginal import/export price curves or their comparison key.

The agreed prototype validity interval is **22 September 2026 00:00 inclusive to
1 October 2026 00:00 exclusive**, Europe/London. This is a conservative interval
for known configured rates, not a claim about the contract's original start date.
No October rates are configured or extrapolated. Add a new effective-dated version
when verified rates are supplied; gaps and overlapping versions resolve to unknown.
A horizon spanning a version boundary selects rates per instant, not once per page.

## Model and calculation

`src/lib/tariff/types.ts` defines independent whole-home import/export curves with
UTC half-open `[start, end)` windows, explicit price status, conditions, source
provenance, stale flags and per-source eligibility periods. Unknown is `null`, not
zero. Zero/negative configured rates remain valid. The schema supports multiple
versions and multiple dated/daily bands; it is not limited to cheap/peak pricing.

`effective-tariff.ts` resolves version validity and recurring local-time windows.
It evaluates minute-resolution civil-time rules on UTC instants using the configured
IANA timezone. This handles repeated/skipped hours without guessing ambiguous local
instants: midnight–06:00 spans five elapsed hours on London's spring transition and
seven on its autumn transition. Version/horizon/dispatch boundaries are not rounded.
The 48-hour dashboard horizon requires about 2,880 inexpensive samples, collapsed
into contiguous rate runs before composing the price signal.

`kraken-dispatches.ts` accepts only exact type `SMART`. BOOST, missing and other types
produce no tariff overlay. The existing EV plan remains unchanged and can still show
them. The adapter retains original vehicle IDs/names, start/end and dispatch type.
`get-site-price-signal.ts` applies effective-dated dispatch prices using the already
loaded Kraken snapshot; there are no new requests or automatic page refreshes.

`price-signal.ts` gives guaranteed off-peak windows priority over Kraken opportunities.
A SMART dispatch from 22:30–04:00 therefore gives a conditional 22:30–00:00 opportunity,
guaranteed 00:00–06:00, then standard pricing. A dispatch wholly overnight does not
change tariff conditions, eligibility or freshness of the guaranteed base rate.
Export is resolved independently and never receives Kraken import overlays.
Outside configured version coverage, SMART still supplies a planned opportunity but
its price remains unknown; it does not extend an expired cheap rate.

Adjacent/overlapping opportunities merge for presentation while retaining original
causing dispatches and finer eligibility periods. Conflicting prices within the same
priority layer remain explicitly unknown/conflicting. Legacy undated defaults/dated
curves remain supported for other prototype configurations; if `versions` is present,
it is authoritative and those defaults are ignored.

## Evidence and freshness

- `planned-conditional`: a schedule indicates a possible rate; qualifying charging
  has not been established. All current Kraken periods have this state.
- `observed-qualified`: evidence establishes the required condition occurred.
- `billed-verified`: billing evidence confirms that the tariff actually applied.

Only the latter two states' representation exists; no detection, billing ingestion or
promotion logic is implemented. Source `observedAt` is a snapshot timestamp, not a
charging observation. Fresh/stale is independent of eligibility. Guaranteed base
rates have condition `none` and no EV eligibility evidence; contractual guarantee
must not be confused with a claim that a bill has been verified.

Kraken supplies a 30-minute assessment cadence. Each per-source eligibility slice
retains its exact coverage and full half-hour assessment bounds. Partial charging
coverage does not automatically qualify an entire half-hour. Overlapping EV causes
remain independently represented. The UI labels HEP groupings as planned, shows the
original dispatches, and explains that early completion/schedule changes can shorten
qualifying duration. A five-hour plan does not guarantee five hours of cheap billing.

## Deterministic comparison and future adapters

`compare-price-signal.ts` exports `effectivePriceCurveKey(signal)`, a canonical string
for comparison over the **same horizon**. It includes normalized interval bounds,
import/export prices, guarantee/condition distinctions and supplied evidence states.
It collapses equivalent segmentation and ignores source order, generation/snapshot
timestamps, freshness and standing charges. Freshness/provenance remain available on
the full model for independent safety decisions. A shifted horizon is a different
comparison domain; future callers should compare a common horizon rather than treating
page-load timestamps as changes in the underlying tariff.

This is HEP's truthful economic representation, not a Tesla encoding. No prices are
modified to meet optimiser/API constraints. Tesla translation, fallback-rate strategies,
price-curve delivery and polling are not implemented.

Tests use synthetic data and mock integrations. DST tests extend validity only in
synthetic test fixtures; production October rates remain unknown. No live service
requests or external writes are needed for validation.
