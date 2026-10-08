# Stage 2A — offline E.ON evidence adapter

`adaptEonOfflineEvidence(input, horizon, generatedAt)` is a pure, additive adapter.
It has no production caller, clock, I/O, dispatch input, persistence or execution
capability. Stage 1 and all existing configuration remain unchanged.

## Contract and authority

The input is **sanitised evidence**, not a raw Kraken response. It includes Stage 1
agreements, subject-bound evidence records/claims and tax treatments; bounded
supplier rate windows; separate transport provenance; and unresolved observations.
Each window explicitly names its canonical version ID, agreement ID, evidence IDs,
energy RateDefinition and optional daily standing RateDefinition. Evidence must
already claim the exact version/schedule/rate/tax targets it attests to. The adapter
never upgrades a kind or manufactures claims. Stage 1 validates every reference,
role, supplier, subject, target, temporal coverage and decimal value.

A finite rate window becomes one finite EconomicVersion with a constant all-day
selector **clipped to that exact window**. Its supplied supplier-rates evidence must
support economic-version and schedule-definition claims within that same coverage.
This represents only the explicit interval-to-price mapping. It does not establish
an overnight recurrence, guarantee, cheap-rate label, conditional rule or January
rate horizon. `rateType` is preserved only as provenance, never interpreted.

Supplier attestation is `provider: "E.ON Next"`. `transport.via: "kraken"` is
separate, bound by evidence ID, and grants no economic authority. Manual evidence
retains Stage 1's explicit subject/claim requirements; transport does not turn it
into authenticated supplier evidence. Observation freshness remains separate from
coverage and agreement validity; this offline adapter does not invent refresh TTLs.

The result contains a canonical model, a Stage 1 resolution for the supplied
horizon, provenance and diagnostics. `partial` includes unknown/conflicting periods
or unresolved observations; `invalid` returns no usable model. Canonical validation
failures preserve Stage 1 diagnostics; malformed adapter inputs use
`INVALID_OFFLINE_INPUT`. All returned plain data is detached and deeply frozen,
including unsuccessful results. Cyclic/exotic input is rejected before cloning.

## Verified facts and honest limits

The fixture uses synthetic identifiers with the verified import product/tariff
codes, active agreement and exclusive 17 January 2027 end. The product display name
and null `ratesAgreedAt` are retained as metadata, not price authority. Four compact
half-hour samples are clipped from the supplied 7–8 October observations. They
resolve to exact GBP/kWh decimal strings `0.0285` and `0.23978`; both retain
`STANDARD`. Gaps, later dates and unobserved overnight hours remain unknown.

The export observation retains Next Export Premium v3 and `0.175 GBP/kWh`.
Agreement identity/validity and rate coverage are incomplete, so it creates neither
an export agreement nor an export rate. Import resolution remains independent.

Historical whole-meter SMART billing is retained as a bounded observation and
explicitly reported as insufficient dispatch/schedule evidence. It creates no
rule, occurrence, physical charging qualification or future price. The historical
fixture's separate bounded supplier schedule/version attestation is **synthetic**;
it exists only to exercise valid bill-backed rate/tax roles. Bill evidence alone
cannot establish that schedule. Production ingestion of rules, recurring schedules
or authenticated dispatches is intentionally outside this adapter.

Synthetic historical windows demonstrate exact 5% VAT results `0.029925`,
`0.251769` and `0.6000015` for standing; 0% October tax leaves the supplied base
values unchanged. Tax coverage is explicit, never extended from an agreement.
Inclusive source prices are not taxed twice. Standing charges stay outside the
marginal price curve. These fixture assertions are not an amendment of existing
production or legacy tariffs.

## Validation/isolation

Tests load only the adapter, Stage 1 resolver and decimal utility through an
allow-listed module loader with no network/filesystem imports or implicit clock.
Fixtures contain no customer/account/MPAN/address/meter information. Tests exercise
wrong roles/subjects/suppliers, bounded coverage, contradictory observations,
malformed data and actual mutation attempts. This layer provides content validation,
not cryptographic authenticity of caller-supplied attestations.
