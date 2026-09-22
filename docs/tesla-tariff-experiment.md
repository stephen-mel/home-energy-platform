# Tesla tariff experiment harness v1

Preparation and observation only. Nothing calls Tesla, saves a record, requests
approval, changes scopes or executes a command. The existing client, OAuth,
production dry-run adapter, Sync Planner, tariff economics and UI are unchanged.

## Entry points

`prepareTariffExperiment({ experimentId, asOf, timeZone, before, signal })`
returns a deterministic serializable version-1 record. All timestamps and identity
come from the caller. There is no wall clock or generated random identifier.

A capture contains `energySiteId`, `capturedAt`, `format` and `value`:

- `site-info`: an already-read response (enveloped under `response` or plain).
  The harness captures its `tariff_content_v2`, or legacy `tariff_content` if v2
  is absent, plus a direct boolean `rate_plan_manager_no_pricing_constraint` when
  present. Multiple tariff representations are ambiguous. Neither field name nor
  the pricing flag proves a lossless inverse write mapping.
- `tariff-content-v2`: caller-supplied **already captured exact setting content**.
  This format is an explicit provenance contract, not a way to relabel arbitrary
  site-info. No current live client path produces this proven capture. A future
  integration must establish its origin and match it to the real site's current
  state before human approval.

The original admitted tariff structure is retained separately as
`before.originalTariffSnapshot`; it is never overwritten by the experiment or
normalized rates. Raw API/auth envelopes are deliberately not serialized. Capture
uses a field allowlist; extra/unsupported fields are omitted, marks the tariff
incomplete and blocks rollback proof. Recognizable credential material in text
is rejected. The typed HEP context is independently allowlisted too. Callers must
supply economic data, never credentials disguised as tariff names/identifiers.

## Rollback proof and its limit

The setting-content validator supports the existing adapter's version-1 GBP
schema: name/utility, buy/sell `energy_charges` and `seasons`, TOU labels and
weekday/minute ranges. It checks matching rate labels, finite nonnegative rates,
full recurring calendar coverage (including leap day), and exact gap-free,
non-overlapping coverage of every weekday. Midnight ends use `toHour: 0`,
`toMinute: 0`. Overnight periods must be explicitly split. Unknown schema
extensions, non-GBP tariffs, missing fields and incomplete coverage block.

For supported exact setting-content captures, rollback is a lossless structural
copy of every admitted field, including independent sell tariff, names and rates.
The record can be `ready-for-human-approval`; this is **not write readiness or
proof that Tesla will accept restoration**. For site-info-only captures, rollback
is always `unproven`/null and preparation is `blocked`, even if the tariff is
readable. Additional legitimate schema fields require future documented support;
we do not discard them and claim the reduced content is exact.

## Intended experiment

The inspection-only `intended.tariffContentV2` is a synthetic annual flat tariff:
version 1, GBP, one January 1–December 31 season, all seven weekdays, 00:00–24:00,
buy **0.0299 GBP/kWh**, independent sell **0.175 GBP/kWh**. No price is clamped.
It is not the HEP production tariff, not a recurring SMART forecast and not a
request body. The full-year shape avoids inventing rates outside a bounded HEP
forecast by explicitly declaring this separate flat experiment. It has **no
automatic expiry** and must never be left in place after a future experiment.

Buy-below-sell is intentionally a prominent experiment warning, not a claim of
Tesla compatibility. The production Sync Planner's blockers remain unchanged.
The flag `rate_plan_manager_no_pricing_constraint` is observational only and
cannot grant permission, bypass rollback validation or explain an outcome.

## Context and future observations

The record contains the allowlisted HEP signal and its existing deterministic
key. Guaranteed price windows are separate from conditional SMART windows.
Original per-vehicle dispatch boundaries, attribution, half-hour evidence,
provenance and freshness remain in the signal, including pre-midnight SMART
opportunities. Supplied observed-qualified/billed-verified states are preserved;
planned data is never promoted. No context drives a Tesla action.

`later` has null slots for read-back, comparison, rollback read-back and rollback
verification. The record is returned as data only; no logging/storage occurs.
All preparations carry `inspectionOnly: true`, `writeReady: false`,
`writePayload: null`, and structured diagnostics/blockers/warnings.

`compareTariffExperiment({ before, intended, readBack })` returns:

- `preserved`: complete interpretable read-back has the intended flat buy/sell.
- `buy-raised-to-sell`: buy now equals intended sell; sell is unchanged.
- `different`: other known complete tariff economics, including varying rates.
- `unreadable/insufficient`: missing, unsupported, ambiguous, wrong-site or
  out-of-order capture, or an uninterpretable/non-flat intended test.

Comparison validates complete known structure before interpreting rates. Renamed
TOU labels alone do not change flat economics. It records previous, intended and
observed rates, including whether the baseline already matched the experiment.
An unchanged read-back is not proof of rejection or successful execution. Every
comparison says write acceptance is not established and causation is not inferred.
No executed/success preparation state is introduced.

## Before any real experiment

A future separate task must establish a current proven rollback capture, verify
actual Tesla schema support, select a controlled test time, persist evidence
safely, obtain explicit human approval, and separately implement any authorized
write/read-back/restore workflow and restore verification. Scope changes or
re-authorization would also be separate explicit work. None is enabled here.

Tests: `node --test tests/tesla-tariff-experiment.test.mjs`, full
`node --test tests/*.test.mjs`, `npx tsc --noEmit`, `npm run lint`.
Synthetic fixtures only; the pure-module loader allows no network, filesystem,
OAuth/client imports, timers or wall-clock access. No live calls were made.
