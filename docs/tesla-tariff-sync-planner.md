# Tesla tariff sync planner v1

`src/lib/tesla-tariff/sync-planner.ts` exports the pure
`planTeslaTariffSync({ signal, previousSignal?, timeZone })` function.
It accepts the current HEP `PriceSignal` and an optional previous HEP signal.
It does not fetch Tesla state, persist a baseline, load a client, use a clock,
poll, access credentials or execute a command.

```ts
const plan = planTeslaTariffSync({
    signal: currentHepSignal,
    previousSignal: previousHepSignal,
    timeZone: "Europe/London",
});
```

## Decision and evidence

- `no-update`: canonical HEP economics are unchanged. Existing incompatibilities
  remain visible; this is not certification of Tesla's stored tariff.
- `update-required`: new/changed economics need representation and the translation
  has no blocking errors. Still inspection-only, never permission to write.
- `blocked`: new/changed economics need representation, but translation reports
  errors. Every adapter error is retained, including future diagnostic codes.

`comparison` supplies canonical keys, `unchanged` / `changed` / `unestablished`,
and changed UTC intervals with independent import/export channel attribution.
An empty interval list means no change; null means comparison was unavailable.
Missing or invalid baseline means unestablished, not proven change/no-change.
A missing baseline requires representation assessment. An invalid current curve
is blocked by adapter validation.

`reasons` supplies structured decision codes. `compatibility` separates numerical
pricing compatibility, representability, blocking diagnostics and warnings.
`hep` preserves the truthful input independently of the inspection-only
`candidate` (periods plus any fragment the existing adapter can construct).
An available fragment can still be unsafe; always inspect the blockers.
All results have `inspectionOnly: true`, `writeReady: false`, `writePayload: null`.

## Reuse and boundaries

The planner uses `dryRunTeslaTariff` for current/baseline validation, translation
and comparison via the existing `effectivePriceCurveKey`. Changed interval evidence
uses the same canonical comparison on boundary slices, including eligibility
boundaries; it does not define new price equality rules. Metadata, freshness and
provenance changes do not change the key. Evidence-state changes remain relevant
under the existing comparison; nothing promotes planned evidence.

Use the same horizon when comparing snapshots. Changing the horizon also changes
the existing key; the planner reports `HORIZON_CHANGED` and the added/removed
coverage rather than silently treating it as a price change within the overlap.
The baseline is a caller-supplied previous HEP signal, not a claim that Tesla was
successfully updated. v1 accepts signals, not opaque saved keys, so changed-period
evidence can be computed without introducing a key parser or second key format.
The supplied timezone is passed unchanged to the adapter, retaining its DST
splits, warnings and blockers. Timezone-configuration changes are outside the HEP
economic key and require a separate future configuration checkpoint.

## Examples and current limitation

- Move SMART 01:00–02:00 to 03:00–05:00 inside guaranteed overnight: `no-update`.
- Add SMART 22:30–midnight: changed import economics for that exact interval;
  `blocked` with current rates and adapter. Buy remains 0.0299 GBP/kWh and sell
  remains 0.175 GBP/kWh, with `BUY_BELOW_SELL` exposed. No clamping or rate removal.
- A hypothetical changed curve with a blocker-free representation:
  `update-required` under the isolated decision rule `decideSyncStatus`.

The existing adapter **always** emits `BOUNDED_FORECAST`: its finite dated forecast
is not a complete recurring-year Tesla tariff. Therefore even numerically
compatible changed curves currently return `blocked`. The `update-required`
decision branch is tested with synthetic blocker-free evidence only; no real
adapter fixture claims to be write-ready. Resolving annual coverage, conditional
rate policy and future human approval is outside this feature. Existing
`CONDITIONAL_RATE` and `STALE_SOURCE` warnings remain visible without being removed,
promoted or reinterpreted by the planner.

## Tests

`node --test tests/tesla-tariff-sync.test.mjs` exercises change detection,
interval evidence, compatibility preservation, baseline handling and safety.
The module loader allows only the existing pure comparison/adapter dependencies;
network, filesystem, timers and wall-clock reads are not available to the code.
Run the full suite with `node --test tests/*.test.mjs`, then `npx tsc --noEmit`
and `npm run lint`. No live integration is involved.
