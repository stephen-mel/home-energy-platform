# HEP-owned Tesla tariff baseline and human verification v1

Pure preparation APIs in `src/lib/tesla-tariff/baseline.ts`:

- `createTariffBaseline({ baselineId, sourceReference, asOf, tariff, horizon, authority? })`
- `verifyTariffBaseline(record, { fingerprint, verifiedAt, verifierReference? })`
- `isBaselineHumanVerified(record)`
- `baselineExperimentContext(record?)`

No UI, live client, network, filesystem, credentials, clock, command or approval
workflow is connected. Inputs supply explicit times. Invalid identities, timestamps,
timezones or horizons throw without persisting anything.

## Source and three separate concepts

Pass `currentSite.tariff` (or another site's effective-dated `TariffConfig`). The
baseline uses `resolveEffectiveTariff` and `buildPriceCurve` to derive a bounded
base `PriceSignal`, then passes it unchanged to `dryRunTeslaTariff`. No tariff
prices are duplicated here. Transient Kraken overlays are deliberately outside
this stable base tariff; later proposals can be separately reviewed.

The record separates:

1. `truth`: HEP import/export curves, including unknown prices.
2. `proposed`: the existing Tesla inspection-only candidate, not a command.
3. `observedTeslaState`: null; no Tesla observation is invented.

For the current V5.2 configuration, the review's structured periods show local
minute ranges 0–360 at 0.0299 GBP/kWh, 360–1440 at 0.2518 GBP/kWh, and independent
export value 0.175 GBP/kWh. The review also contains local dates/UTC offsets,
timezone, tariff identity, effective dates and diagnostics. Consumers may format
these values into homeowner text. Standing charge stays in site configuration
and is not copied into the optimisation curve or representation.

The active tariff identity is selected at explicit `asOf`. Review horizon must
remain within that version's validity to be reviewable; crossing unknown October
prices remains unknown and blocked. No full-year repetition, fallback tariff or
post-expiry behaviour is invented. The supplied horizon is included in the key;
use an identical review horizon when checking metadata-only changes.

## Verification is not compatibility or authorization to write

Initial state is `requires-human-verification` for an inspectable known tariff,
or `blocked` if it cannot be reviewed. There is no automatic verification.

The fingerprint is a versioned deterministic canonical JSON **key**, not a
cryptographic signature or authentication mechanism. It binds tariff identity,
effective period, timezone, the existing canonical economic curve key and the
exact candidate (including its fragment and period sidecar). Object-key order
does not affect it. Generation timestamp, record/source identifiers, standing
charge and authority are intentionally excluded. All economically meaningful
representation changes require fresh explicit confirmation.

`verifyTariffBaseline` recomputes the key and rejects mismatched or changed
representations, blocked records and verification times preceding the snapshot.
It records only the matched fingerprint, explicit verification time and optional
non-sensitive audit reference. It returns a new `human-verified` record. Existing
records are not mutated. `isBaselineHumanVerified` rechecks the exact content;
consumers must use this check rather than trusting a copied state label after edits.
Creating a new record starts unverified; old confirmation is never silently copied.

Human verification means the person reviewed this exact proposed representation,
including its limitations. The existing `BUY_BELOW_SELL` and `BOUNDED_FORECAST`
errors remain compatibility blockers even after review. It is possible to
human-verify this bounded proposal without claiming it is safe or ready to send.
Current 2.99p buy / 17.5p sell values remain unchanged. `writeReady` is always
false, `writePayload` null and `inspectionOnly` true.

## Experiment rollback boundary

`baselineExperimentContext` distinguishes unknown Tesla pre-existing configuration
from a valid HEP human-verified baseline. Both return `rollbackProven: false`,
null rollback representation and `ROLLBACK_UNPROVEN`. Do not relabel a generated
proposal as an exact current-Tesla capture to bypass the existing experiment
harness. That harness and its capture rules are unchanged.

`ExperimentBaselineEvidence` reserves a distinct future proven-written evidence
variant requiring the baseline fingerprint, site identity, exact representation,
write timestamp and recorded verified read-back evidence. No v1 function creates,
accepts as proof or executes this variant. Human review alone cannot create it.
The baseline has no written/active/restored states.

## Authority

Authority is independent of tariff economics and fingerprint:

- `observe`: effective observe mode.
- `confirm`: default effective mode; later actions require human approval.
- `automatic`: future intent only; effective mode remains confirm in v1.

No mode enables execution, adds scopes or bypasses verification/compatibility.
Only allowlisted tariff economic fields are captured; extra config/auth fields
are omitted. Identifiers must be non-sensitive; do not put credentials in semantic
fields such as tariff names or audit references.

## Before a first write

Resolve the adapter's complete-coverage/expiry and pricing-constraint questions,
implement a separately authorized human-controlled write boundary, and record and
verify Tesla read-back against the exact sent representation. Only that future
proof can establish a restoration baseline. None of those steps occurs here.

Validation: `node --test tests/tesla-tariff-baseline.test.mjs`, full
`node --test tests/*.test.mjs`, `npx tsc --noEmit`, `npm run lint`, `git diff --check`.
Tests run synthetic inputs with an import allowlist and no clock/network/I/O globals.
