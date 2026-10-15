# Trusted current Tesla baseline — Stage 1

This stage adds two pure, read-only boundaries. `captureTeslaCurrentState` accepts
one already authenticated Tesla `site_info` response and preserves its exact tariff,
configured energy-site attribution, observation time, timezone, and the recognised
`default_real_mode` value. It performs no authentication or network operation.

`assessTrustedCurrentBaseline` validates Tesla and expected-E.ON evidence envelopes
over one explicit domain. Both must be fresh, site-bound, timezone-bound and
complete. Gaps, unknown prices, stale evidence, identity contradictions, invalid
provenance kinds and malformed inputs produce `insufficient-evidence`.
Every price window and provenance entry is structurally validated before use; null,
undefined, primitive, array, sparse or incomplete provenance cannot be interpreted
as E.ON evidence. Malformed envelopes are reported separately from valid-shaped
evidence that lacks trusted account binding.

Validation is ordered: the request and exact comparison domain first; fixed outer
and nested Tesla source schemas second; expected-E.ON windows, eligibility and
provenance schemas third; then identity, time, freshness, tariff and coverage
checks. Canonicalisation and fingerprinting occur only for those validated fixed
shapes. Unexpected Tesla source fields, including cyclic fields, are rejected
without recursive canonicalisation. Null, array-shaped, incomplete, reversed or
zero-length domains report `COMPARISON_DOMAIN_INVALID`.
All enum fields require primitive strings before membership testing. Operating mode,
price status, window kind and condition, and eligibility state are never coerced;
objects with hostile conversion methods and other non-string values are malformed.

The existing authenticated Kraken refresh does validate its session-derived import
account reference before it creates tariff evidence. That expected import-account
identity is not retained in site configuration, however, and a caller-constructed
price signal cannot prove that it passed through the authenticated refresh. Stage 1
therefore always reports `EXPECTED_EON_ACCOUNT_BINDING_UNAVAILABLE` and performs no
positive economic match. Provider labels, matching tariff strings and caller-added
account fields do not change that result. A later trusted server adapter must carry
the already validated account binding into this boundary without adding a
self-attested trust flag.

The sources remain distinct:

- A `tesla-site-info` envelope describes what a Tesla GET result would contain, but
  this pure function cannot prove that a live GET occurred. Other provenance kinds
  are rejected even when the outer and nested labels agree.
- E.ON/Kraken evidence supplies expected household tariff economics and does not
  prove Tesla representation or operating mode.
- The September journal remains immutable historical evidence and is not an input
  to this current-state comparison.

Operating mode is observational only. Its presence does not prove optimisation is
correct or authorise a mode change. The result is deeply immutable and always has
`writeReady`, `rollbackProven`, `restorationProven`, `resolvesHistoricalJournal` and
`grantsRepeatAuthority` set to false.

A future supervised recovery or execution stage still needs a newly authorised
live capture through the existing GET-only Tesla boundary, a trusted adapter that
preserves fresh authenticated Kraken account binding for the exact comparison
domain, a separate review of unresolved September
history and ownership, and all existing approval, journal-before-write, generation,
readback and restoration controls. This stage supplies none of that authority.
