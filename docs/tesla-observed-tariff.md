# Observed Tesla tariff analysis and date simulation

## Read-only investigation

During this task, one successful authenticated products GET identified the single
energy site and one site-info GET returned `installation_time_zone: Europe/London`
and `tariff_content_v2`. No token refresh, POST, command, setting change or automatic
capture persistence occurred. The raw API/auth envelope is not a test fixture.

Relevant live observations, retained exactly in the sanitised synthetic fixture:

| Label | Inclusive month/day range | Buy, GBP/kWh | Sell, GBP/kWh |
|---|---|---|---|
| Yesterday | September 20 only | 00:00–06:00 0.02993; otherwise 0.25177 | 0.17 |
| Today | September 21 only | same | 0.17 |
| Tomorrow | September 22 only | same | 0.17 |
| TwoDays | September 23 only | same | 0.17 |
| ThreeDays | September 24 through September 19, wrapping year-end | same | 0.17 |

Buy identity: `FLATPEAK`, `Next Drive Smart V5.2`, `Eon Next`, GBP, version 1.
Sell identity: `FLATPEAK`, `Premium export`, `EON Next`, GBP; no sell version field
was present. Observed demand charges were zero under ALL with empty per-season
objects. These are observations, not proof of what E.ON will bill.

HEP config remains **0.0299 / 0.2518 import and 0.175 export**. Neither the observed
0.17 export nor the extra import-price precision replaces HEP economics.

## Capture and analysis

`captureObservedTariff(siteInfo, energySiteId, observedAt)` extracts only supported
tariff fields into a typed observation. It retains independent buy/sell identities,
currencies, season date ranges, rate labels/values, TOU period objects, demand
charges and timezone. Missing fields remain absent: this is separate from the
analysis interpretation. Unknown fields are omitted with an explicit diagnostic
and block simulation. Credentials, tokens and unrelated account/site data are not
copied. Provenance records the supplied site reference and timestamp; it is not an
authenticated restoration proof. `rollbackProven` stays false.

The existing `/api/tesla-test` read-only handler adds `observedTariff` from the same
site-info response. It adds no integration call or polling. Existing response
fields are retained. No UI or new write-ready representation is introduced.

`analyseObservedDates(observation, ["YYYY-MM-DD", ...])` expands explicit local
calendar dates into contiguous UTC intervals with local minute bounds, UTC offset,
buy/sell currencies and prices, matching season labels and diagnostics. Null
prices identify gaps/overlaps/unknown rates; no priority rule picks a winner.
Actual UTC minute expansion keeps the repeated autumn hour distinct and omits
nonexistent spring minutes (25/23 elapsed hours in London).

The sparse live TOU representation omits zero-valued fields. Analysis explicitly
assumes omitted fields are zero, midnight end means 24:00, weekday zero is Sunday,
and date endpoints are inclusive. Warnings retain these assumptions: the read
response and documentation do not independently prove all runtime conventions.
The live all-week entries specify `toDayOfWeek: 6`, so weekday numbering does not
affect this fixture's prices. Season names have no inferred special semantics.

## Structural simulation and findings

`simulateObservedSmartDate` accepts a selected local date, minute interval,
hypothetical buy price/currency and comparison dates. It validates every recurring
calendar day, including February 29, and every weekday/time boundary. It isolates
the target month/day by splitting its containing season if needed (including a
wrapping season), overlays the specified buy interval, and leaves the sell tariff
unchanged. Zero demand-charge structure is carried across splits; nonzero demand
charges block this energy-only simulator.

For September 22, 22:00–24:00 at hypothetical 0.0299 GBP/kWh:

- September 21, 23 and 24 retain their original prices.
- September 22, 22:00–24:00 (21:00–23:00 UTC in BST) changes buy from 0.25177 to
  0.0299. Sell stays 0.17. Overnight buy stays exactly 0.02993.
- September 22 in the following year changes as well if that representation is
  retained. This is proven by the simulation fixture, not assumed label behaviour.

A season contains month/day, **not year**. The structure supports different TOU
patterns for one recurring month/day while surrounding dates retain normal rates.
It does **not** establish a permanently safe, non-recurring one-day SMART exception.
A future one-off scheme would need independently designed expiry/restoration and
observed runtime verification. Nothing here performs that lifecycle.

The result reports exact changed local dates/times, UTC intervals/offsets and
before/after import/export prices for the explicitly requested comparison dates.
It states its recurring month/day scope and annual-recurrence limitation; it does
not claim that unrequested years were compared. Input is never mutated, source is
labelled `simulation`, `writeReady` is false, and no endpoint/request wrapper or
execution function is produced. Structural validation is not Tesla acceptance.

## Tesla documented constraints

Tesla's [energy endpoint documentation](https://developer.tesla.com/docs/fleet-api/endpoints/energy)
states that season names are arbitrary, tariff coverage must have no gaps or
overlaps, and buy must be at least sell. Tesla says it sets buy equal to sell when
buy is lower. The live and simulated overnight rates violate that documented
inequality; both are retained unchanged with `BUY_BELOW_SELL` diagnostics. Their
presence in site-info is not proof that a new write would preserve them, nor an
explanation of any undocumented pricing flag.

## Limits and validation

The parser targets the observed seasonal energy schema. Energy ALL/fixed-rate
forms, overnight TOU spans not explicitly split at midnight, unknown extensions,
nonzero demand charges and unsupported/incomplete structures require additional
modelling; simulation blocks instead of inventing their effects. Calendar dates
are explicit, timezone comes from the observation, and there is no tariff-local
fallback to the browser timezone. This is not a lossless inverse of a Tesla GET
into a write payload and does not weaken any approval/rollback safety checks.

Tests cover exact sparse capture, date labels, annual wrapping, season/TOU gaps
and overlaps, DST days, one-date simulation and annual recurrence, wrapping-season
splits, deterministic output, zero extra endpoint reads and safe capture. Only
the initial products/site-info investigation used live GETs; all tests are local
fixtures. Run `node --test tests/tesla-observed-tariff.test.mjs`, full Node suite,
TypeScript, ESLint and whitespace checks.
