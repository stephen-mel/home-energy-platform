# Opportunity Engine v1

A pure, read-only, household-cost/value context layer. `getOpportunities` consumes
HEP's existing `PriceSignal`, an explicit observation time and optional telemetry.
It has no runtime imports, clock, network access, Tesla adapter dependency, polling,
UI, integration mutations or actions. It does not replace Tesla Opticaster.

## Entry points

- `src/lib/opportunity/types.ts`: input, insight and evidence contracts.
- `src/lib/opportunity/engine.ts`: deterministic financial calculations/templates.
- `src/lib/opportunity/home-assistant-input.ts`: optional pure bridge from already
  loaded HA state. Callers provide explicit asset/entity bindings and power polarity.
  It uses normalized metric `value` (including existing Powerwall SOC normalization),
  never guesses from labels, and converts W/kW only when units are recognized.

```ts
const result = getOpportunities({
    signal: existingPricePlan.signal,
    now: observationTime,
    telemetry: optionalTelemetry,
    exportContext: {
        capability: "unknown",
        actualTariff: { status: "pending", price: null },
        economicValue: { kind: "signal" },
    },
});
```

No entry point is wired into the page or integrations in this chunk. No configuration,
including the current 17.5p export economic value, is changed.

## Insight contract

Each insight has a stable economic ID, type, time interval, financial context,
structured evidence and a concise fixed-template explanation. Financial amounts use
major currency units: GBP 0.2219/kWh means 22.19p/kWh. Results include:

- Cheap import ahead / conditional SMART opportunity versus the current rate.
- Expensive-import exposure: per-kWh context, not predicted household expenditure.
- Gross earlier/later import spread and import/export economic-value spread.
- Observed surplus/export context when fresh solar exceeds load and grid flow is outward.
- Stored-energy context from SOC and optional current battery power.
- No additional opportunity when available data does not support a positive spread
  or current export-value observation. This does not assert optimal operation.

The optional materiality threshold is in currency/kWh. Default zero means any strictly
positive spread, with no invented financial significance threshold. Calculations only
compare known, finite prices in the same currency. No energy volume or future household
cost is inferred. Separate insight types can describe the same price relationship;
their per-kWh spreads must never be summed as independent household savings.

Price evidence retains the original periods, source provenance, freshness and
half-hour eligibility slices. It distinguishes configured/guaranteed, planned-conditional,
observed-qualified, billed-verified and unknown evidence without promoting anything.
Existing HEP precedence/filtering supplies SMART-only additional windows; this engine
does not recreate the Kraken rules. Overnight SMART and BOOST create no extra price
opportunities when the effective signal is unchanged.

Stable IDs exclude source timestamps/freshness and asset names. Metadata-only changes
may change qualifications/explanations but do not create new economic identities for
the same prices/time periods. The explicit `now` and horizon must be held constant when
comparing outputs; a different analysis time legitimately changes the context.

## Telemetry and export semantics

The engine's grid sign convention is positive import / negative export; battery power
is positive toward the home / negative into storage. Bindings must explicitly translate
source polarity. No real-home sign conventions are presumed by this implementation.

The existing HA snapshot lacks per-reading freshness/time guarantees. The bridge
therefore defaults to unknown freshness. Callers may only supply fresh status when
supported by their data path, and must ensure readings are contemporaneous. The engine
does not invent an age cutoff. Stale/unknown solar, load or grid data cannot establish a
current export observation. Stale SOC remains last-supplied context with a qualification;
missing/invalid SOC produces a limitation instead of a made-up battery state.

Export capability, actual tariff status/price, and economic value are separate inputs.
The effective HEP export curve is the default economic value, never proof of payment.
An explicit economic-value override of zero or null suppresses positive export-value
claims, regardless of capability. Export-value observations use observed outward grid
power, not all solar surplus; they do not establish the source of all exported energy.
The instantaneous power × value figure is an economic value rate, not earned revenue
or a forecast. No battery-export permission is inferred.

## Examples using the current prototype rates

- 25.18p now versus 2.99p guaranteed overnight: **22.19p/kWh gross spread**.
- SMART 22:30–00:00: a separate planned/conditional opportunity before guaranteed
  midnight–06:00, retaining its original causing dispatch and eligibility evidence.
- 2.99p import versus 17.5p export economic value: **14.51p/kWh gross spread**,
  explicitly not guaranteed profit or confirmed export revenue.
- Synthetic simultaneous 4kW solar, 1kW load, 3kW outward grid flow at 17.5p:
  **£0.525/hour instantaneous economic value**, not a prediction or bill claim.
- Fresh 90% SOC ahead of cheaper import: reported stored-energy buffer context;
  sufficiency, usable energy/duration and Tesla's motive remain unknown.

No solar/load forecasts, efficiency, degradation cost, capacity, reserve, future energy
requirement or operating permission are invented. The engine emits neither control
instructions nor recommendations. It does not claim to know why Tesla is operating
in a particular way. Self-consumption/carbon do not override the financial context.

## Checks

`node --test tests/opportunity.test.mjs`, `node --test tests/*.test.mjs`,
`npx tsc --noEmit`, `npm run lint`. Tests use synthetic inputs and include explicit
control-language exclusions. No real-home connections or external writes are required.

## Live homepage integration

`page.tsx` loads site state once and derives one effective price plan from that
snapshot. `LiveHomeEnergy` owns the existing HA EventSource subscription and
passes the same normalized readings to the telemetry display and
`liveSiteOpportunities`. The engine and its economic rules remain unchanged.
There are no extra integration calls, timers, polling, controls or refreshes.
Existing stream metrics/status events trigger recomputation; a normal dashboard
reload supplies any new Kraken plan through the existing cache. Without HA,
tariff-only insights render on the server and remain available.

`Site.opportunities` declares optional metric bindings and export context. The
current site's HA Powerwall grid/battery measurements use the integration's
positive-import / positive-toward-home conventions explicitly (multiplier +1).
SOC is the shared normalized display measurement, with raw SOC retained. Export
value uses the configured economic curve; payment/capability remain unknown.
Other sites can omit these bindings or supply different assets and polarities.

Freshness describes the connection's last-known state, not independently verified
sensor sampling age: initial REST readings have unknown freshness; after the
complete stream snapshot and live status they are usable as observations;
disconnection marks retained readings stale. HA does not currently forward sensor
measurement timestamps, so an upstream sensor stuck on an old numeric value
cannot be detected here. Missing/null values never establish live export.
Existing stream status/heartbeat events advance the observation time without new
polling. The price horizon is finite; after it expires a normal dashboard reload
is needed. HA events do not refresh Kraken or reclassify its snapshot freshness.

`energy-opportunities-view.ts` selects at most three cards in order: additional
SMART opportunity, cheaper import ahead, live export, stored energy, other gross
spread context. It selects the nearest instance per message type. The cheap-rate
summary suppresses secondary import/exposure/export-spread cards to avoid repeated
economics; independent live export observations remain eligible. No-additional
context is shown only when there are no other selected insights. This deliberately
conservative summary is not an exhaustive opportunity list.

Cards distinguish guaranteed prices, conditional plans, observed qualification
(not bill verification), and verified billing only when supplied as evidence.
Current Kraken data stays conditional. Native Details disclosures preserve
source, evidence, limitations, grouped dispatch attribution and original times.
Export is instantaneous economic value, not confirmed revenue or a forecast;
battery context does not claim sufficiency or recommend an action. Stale/unknown
qualifications remain visible without opening Details.
