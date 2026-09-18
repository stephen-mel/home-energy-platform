# Whole-home price signal

This read-only model interprets configured Kraken planned EV dispatches as potential
whole-home cheap import opportunities. It does not confirm actual charging, awarded
rates or billing, and does not recommend or control battery operation.

## Model and boundaries

- `src/lib/tariff/types.ts` defines a provider-neutral `PriceSignal` with independent
  import and export curves, an explicit horizon and generation timestamp. Windows
  are UTC ISO instants with half-open bounds `[start, end)`.
- Each window carries a price, price status, standard/opportunity kind, condition,
  stale flag and provenance. Prices use major currency units per kWh (e.g.
  `{ amount: 0.10, currency: "GBP", unit: "kWh" }`). This example is not a configured
  rate. Unknown is `null`, distinct from genuine zero or negative prices.
- `price-signal.ts` builds ordered non-overlapping curves. It supports multiple dated
  prices, independent export windows, and baseline rates between windows. It does not
  assume every tariff has two price bands. Conflicting rates within the same priority
  layer produce an explicitly conflicting/unknown price, not an arbitrary winner.
- `kraken-dispatches.ts` is the provider adapter. It retains each source EV asset ID,
  original start/end and dispatch type separately from the resulting tariff window.
  It preserves the Kraken snapshot's stale flag and last-successful-update timestamp.
- `get-site-price-signal.ts` resolves configuration through the existing site architecture
  and uses the already fetched Kraken state. The current UI horizon is the next 48
  elapsed hours. Ongoing windows are clipped to now; expired, out-of-horizon and invalid
  intervals are omitted. Explicit timezone offsets are required on dispatch timestamps.
- Cheap opportunities take precedence over the configured import baseline/dated normal
  rates. Adjacent and overlapping opportunities at the same price and stale status merge,
  keeping all causing schedules in provenance. Separated opportunities remain separate.
  Export is calculated independently and is never changed by Kraken EV dispatches.

A future provider or a read-only tariff comparison adapter can emit the same normalized
curves. Optimiser delivery and Tesla tariff comparison are intentionally not implemented.

## Eligibility evidence, separate from freshness

Each grouped price window has `eligibilityPeriods`; there is deliberately no single
eligibility state for the entire group. Terminology:

- `planned-conditional`: a schedule creates a possible rate, conditional on actual
  qualifying charging. Every current Kraken-derived period has only this state.
- `observed-qualified`: evidence establishes that the required condition occurred.
  The type can represent this; no charging detection or promotion logic is implemented.
- `billed-verified`: billing evidence confirms the rate actually applied. The type
  can represent this; no billing ingestion or promotion logic is implemented.

Fresh/stale describes source freshness, not eligibility. The source `observedAt`
field is a snapshot timestamp, not an observation of actual EV charging. No dispatch
means no cheap eligibility periods; configured baseline prices alone are not evidence.

For the validated E.ON rule, the Kraken adapter specifies a 30-minute assessment
cadence. The generic builder carries per-source coverage slices at these boundaries,
retaining original vehicle names/IDs, dispatch types and exact dispatch boundaries.
Each slice also identifies its full `assessmentPeriod`. Partial coverage must not be
read as qualifying the entire half-hour. Overlapping EV causes remain independent;
future evidence can differ inside the same grouped forecast. Other providers can
supply their own assessment cadence and dated inputs without changing this model.

The current UI continues to group planned ranges and show constituent dispatches. It
now explicitly labels them planned/conditional and explains half-hourly billing and
that early charging completion or a schedule change can shorten the cheap duration.
A fresh five-hour plan remains five hours of *potential* opportunity even if the EV
finishes in two hours; no current code verifies or awards either duration. Charging
and settlement evidence are necessary before these forecasts can be treated as
qualified or billed rates. No prices have been configured.

## Configuration and presentation

`Site.tariff` holds the display timezone, normal import and export defaults, plus optional
arrays of dated import/export windows. The Kraken integration has an explicit optional
`wholeHomeDispatchRate` opt-in with its cheap import price. Sites without this opt-in,
without Kraken, without EVs or without dispatches get no invented Kraken opportunities.
Smart Control status and plugged-in state do not create windows.

For the current site the whole-home rule is enabled; all three monetary prices remain
null because no verified rates exist in configuration. The new dashboard section shows
unknown rates explicitly, time ranges with local dates/timezone, sources, conditional
charging wording, and a stale-schedule warning with the original successful timestamp.
EV cards remain independent of this whole-home interpretation.

There is no new polling or automatic page refresh. This price plan is a snapshot of the
schedule available at page load (its calculation time is displayed); it does not track
subsequent cancellations until another page load. Existing Kraken 60-second caching,
persistent fallback and stale behaviour are unchanged. HA streaming is unchanged.

## Validate against the real tariff

The whole-home interpretation follows the product rule supplied for this feature;
it has not been independently verified against the user's contract or billing data.
Before treating this curve as a confirmed price or sending it to an optimiser, verify:

- The actual Drive Smart cheap import rate, normal import rate and export rate,
  including currency, VAT and effective dates. No values have been assumed.
- Which planned dispatch types qualify; this first version treats every valid planned
  dispatch returned by Kraken as a *potential* opportunity and preserves its type.
- Detailed partial-period eligibility, cancelled dispatches and any settlement-period
  rounding or grace rules. Actual EV charging is required; a remaining planned interval
  after charging finishes does not by itself qualify.
  This implementation uses the exact supplied start/end without rounding or padding.
- Whether overlapping schedules from multiple paired EVs have the same household
  eligibility and cheap rate. The present opt-in applies one configured cheap rate to
  all planned EV dispatches from this site's Kraken snapshot.
- Any fixed cheap periods outside EV dispatches. None are inferred from a tariff name;
  verified dated windows can be represented independently in site tariff configuration.

Tests use synthetic snapshots and do not contact services or perform external writes.
