# Tesla tariff adapter — dry run only

`src/lib/tesla-tariff/dry-run.ts` exports `dryRunTeslaTariff(signal, options)`.
It accepts an existing HEP `PriceSignal`; it never loads integration clients,
credentials, environment variables or a clock, and performs no I/O. Existing Tesla
Fleet code and OAuth scopes remain unchanged. The existing HEP tariff calculation
and comparison function are reused, not modified.

```ts
const result = dryRunTeslaTariff(existingSitePricePlan.signal, {
    timeZone: existingSitePricePlan.timeZone,
    previousEconomicKey: previousDryRun?.comparison.economicKey ?? undefined,
});
```

Inspect these fields:

- `hep`: the complete truthful input economic curve, provenance and evidence.
- `candidate.periods`: contiguous UTC import/export intersections, split at local
  midnight and timezone-offset changes. Includes local date, wall-clock minute
  bounds, UTC offset, exact buy/sell prices, guarantee/condition and eligibility.
- `candidate.tariffContentV2Fragment`: an inspection-only draft using the documented
  `energy_charges`, per-date `seasons`, `tou_periods.periods` and `sell_tariff` shape.
  It is null where unknown prices, sub-minute edges, currency mismatches or DST
  ambiguities prevent faithful wall-clock projection. Numerical pricing violations
  remain visible unchanged in both the periods and draft when otherwise representable.
- `diagnostics`: explicit errors/warnings with affected UTC ranges where applicable.
- `pricingCompatible`: numerical price compatibility only, NOT write readiness.
- `comparison.economicKey` and `economicChanged`: existing HEP comparison over the
  same horizon. The first run has a null changed state (no prior baseline). Source
  timestamps, freshness and ordering alone do not request a change. A changed
  horizon is a different comparison domain. The key is not confirmation of Tesla state.
- `writeReady: false`, `writePayload: null`: no executable write request is produced.

## Documented Tesla constraints

Tesla's [Fleet energy endpoint documentation](https://developer.tesla.com/docs/fleet-api/endpoints/energy)
and [tariff_content_v2 example](https://digitalassets-energy.tesla.com/raw/upload/app/fleet-api/example-tariff/PGE-EV2-A.json)
are the schema references. Tesla documents that buy prices below sell prices are
raised to sell prices, negative values are rounded to zero, and seasons/time periods
must have complete coverage without overlaps. Supported currencies are USD/EUR/GBP;
arbitrary period labels are accepted, but the app displays only four standard labels.

Accordingly, HEP's 25.18p buy / 17.5p sell pair passes the numerical check, while its
2.99p buy / 17.5p sell pair reports `BUY_BELOW_SELL`. The adapter does not change either
price. Custom deterministic `HEP_RATE_n` labels avoid inventing peak-rank mappings.
No standing charge is inserted into this marginal energy-price draft.

## Bounded forecast limitations

A 48-hour forecast cannot truthfully specify Tesla's full recurring-year tariff.
Each draft season covers only a supplied local date; dates retain their year in the
sidecar, while Tesla's season fields have only month/day. The draft is explicitly
incomplete, not a payload to send. Future code must resolve annual coverage, expiry,
conditional-rate policy, site timezone and metadata before enabling any write.
No fallback prices, annual repetition of SMART dispatches or October prices are invented.

A partial local day reports `INCOMPLETE_LOCAL_DAY`. Sub-minute horizon/dispatch edges
report `SUB_MINUTE_BOUNDARY` (common with a page-generated timestamp); use an already
calculated minute-aligned horizon for a wall-clock draft rather than silently rounding.
Tesla's example uses `toHour: 0` for day-end; this adapter follows that convention.
One-date seasons use all weekdays, avoiding assumptions about weekday numbering.

The UTC candidate remains gap-free on 23/25-hour DST days. Equal repeated fall-back
wall minutes can be collapsed in the draft. Different prices for the two occurrences
report `DST_FOLD_CONFLICT` and suppress it. Nonexistent spring wall minutes remain
unfilled and make that day's draft incomplete. No claim is made that Tesla's runtime
DST behaviour has been verified. The site's IANA timezone is a sidecar prerequisite,
not an invented request field.

Conditional evidence remains in HEP and the candidate period sidecar; the Tesla tariff
shape cannot express actual qualifying EV charging. Stale source data is separately
flagged, and no evidence is promoted to observed or billed.

## Validation

Run `node --test tests/tesla-tariff.test.mjs`, `node --test tests/*.test.mjs`,
`npx tsc --noEmit`, and `npm run lint`. Tests use synthetic snapshots, including
explicitly synthetic DST validity ranges. No live API call or tariff write is tested.
