# Restoration review: observed Tesla tariff

## Finding (23 September 2026 capture)

The 09:10:28 BST authenticated site-info capture can be retained **field-for-field**
and placed inside the documented `tou_settings.tariff_content_v2` envelope as an
inspection candidate. It passes our observed structural validator: annual seasons
and weekday periods have complete coverage under the existing sparse-zero
interpretation. Canonical fingerprinting ignores object-key order; it is not a
claim of byte-identical original JSON.

It is **not proven to be an exact, valid, accepted restoration command**. No
write was performed. The current observation is also historical, not a fresh
capture immediately before a future change. `ROLLBACK_UNPROVEN` remains.

The existing observation contains 0.02993 GBP/kWh overnight import, 0.25177 daytime
import and 0.17 export. Restoring it is itself exposed to BUY_BELOW_SELL. HEP's
independent 0.0299 / 0.2518 import and 0.175 export remain unchanged. Neither a HEP
baseline nor homeowner verification of that baseline is a substitute for the
actual Tesla before-state.

## Mapping audit

Tesla documents the `tou_settings.tariff_content_v2` envelope, season/period
coverage requirements and pricing constraints. It explicitly says buy below sell
will be raised to sell. Its supplied example includes wraparound seasons, tariff
identity/code, zero demand charges and no sell-side version. Sources checked:
[energy endpoint documentation](https://developer.tesla.com/docs/fleet-api/endpoints/energy)
and [official tariff example](https://digitalassets-energy.tesla.com/raw/upload/app/fleet-api/example-tariff/PGE-EV2-A.json).

| Element | Treatment and remaining uncertainty |
|---|---|
| Season names and month/day ranges | Preserved exactly, including the wrapping range. Names have no inferred relative-date semantics; ranges recur annually. |
| TOU fields | Absence remains absence in the candidate. Analysis interprets missing fields as zero and weekdays as Sunday=0. The example does not establish sparse defaults as a write contract. |
| Buy/sell prices | Preserved at captured precision. No rounding, clamping or replacement with HEP prices. Tesla's documented normalization threatens an exact round trip even for the unchanged before-state. |
| Identity, code, currency | Preserved, with independent buy/sell identities. |
| Sell version | Remains absent. The official example also omits it; adding `version: 1` would invent data rather than fix a proven omission. |
| Zero and empty demand charges | Retained; no conversion from `{}` to `{rates:{}}` and no removal of zero charges. |
| Additional example fields | The example contains daily/monthly charges, demand limits and `daily_demand_charges`. They were not in this capture. The example is not an exhaustive required-field schema, so we neither fabricate them nor assert their absence proves invalidity. Their default/update semantics are unknown. |
| Timezone and target | Bound to the observation/site externally; no invented tariff-body timezone field. |
| Allowlist losses | `UNSUPPORTED_FIELDS_OMITTED` or strict validation failure prevents a structural envelope candidate. No loss is silently excused. |
| Read-to-write mapping | Public documentation does not promise that site-info is a complete invertible settings view, or that omitted fields are preserved/defaulted on write. |

The observed structural profile is deliberately more limited than Tesla's full
example: it is not a general implementation of every Tesla billing field. This
review does not broaden the validator or relax any safety gate.

## Existing model integration

`reviewObservedRestoration` is a pure inspection composer. It uses the existing
observed validator, canonical `representationKey`, `assessRollbackEvidence`,
`baselineExperimentContext`, and `assessProposalCurrentUse`. It binds the site,
timezone, exact candidate, capture timestamp/provenance and temporary proposal
fingerprint. A mismatched capture, site, timestamp, simulated source, or tariff
cannot be substituted for the observation bound to that proposal.

There is no second rollback ledger or approval path. A caller-labelled authenticated
capture is not a trusted server evidence entry. This inspection never creates a
`TrustedRollbackObservation` and calls the existing assessor without such evidence.
Even an exact subsequent GET match remains an observation, not proof of acceptance,
causation, or restoration. The existing proposal's blockers are retained in full.
The review adds explicit inverse-mapping/acceptance uncertainty and transformation
risk where applicable, plus a recapture requirement for old/invalid observations.

`compareObservedTariffReadBack` can inspect either the temporary result or the
restored result. It requires a later site/timezone-matched capture, compares exact
canonical representations and reports dated price differences. An economic match
with changed metadata is not an exact match. Buy-raised-to-sell is flagged as an
observed relationship, never asserted to have been caused by a particular write.
Timeline checks are limited to the explicit dates supplied, while representation
comparison covers the whole tariff. It never promotes rollback proof.

## Intended transaction, not an implemented executor

1. **Capture before-state:** immediately before any future change, authenticate a
   site-info read, durably retain exact tariff/provenance and rule out intervening
   changes. Rebind/review the proposal if the observation differs.
2. **Temporary proposal:** bind current SMART evidence, exact prices and expiry;
   obtain exact human approval only through the existing model. Approval is not
   compatibility or rollback proof.
3. **Write:** future separately authorised execution, with site/request/response/time
   evidence. All current gates apply; nothing here permits this stage today.
4. **Read-back:** fresh authenticated capture after acknowledgement. Compare exact
   representation and affected price timelines; detect rejection, partial change,
   normalization and unexpected external changes. A successful HTTP response alone
   is insufficient.
5. **Restore:** submit the immutable captured before-state only through a separately
   authorised and validated restoration path. Restore at expiry or earlier when
   appropriate; reconcile intervening user/provider changes instead of overwriting
   them blindly. A failed temporary write does not prove the state was unchanged.
6. **Read-back/verify:** capture again after restoration and verify identity, fields,
   periods and both prices. If buy has been raised to sell, restoration is **not
   exact**. Preserve failure evidence; do not mark the transaction restored or mint
   trusted rollback evidence. Any future trusted ledger entry requires authenticated
   write/read-back provenance, exact representation/site binding and bounded validity.

All write/read-back transaction stages remain unperformed. The before-state's
cheap price could normalize on restoration even if a temporary price is accepted.
A site flag or a currently stored buy-below-sell relationship does not prove future
write behaviour.

## Safest next step

Do not use the current SMART exception as the first production write. First seek
Tesla clarification on lossless site-info round-tripping, sparse/default fields and
buy-below-sell restoration. Prepare a separately reviewed controlled test with an
independently established recovery method and fresh durable capture. An unchanged
"test write" is not automatically harmless: it could raise the stored overnight
buy price to 17p. If proceeding would require an exception to an existing blocker,
stop for explicit approval and a separate safety review; this task grants none.
A successful controlled write/restore/read-back cycle, bound to the exact site and
representations in the existing trusted evidence model, would be needed to establish
actual restoration capability. No inspection-only result can supply that evidence.
