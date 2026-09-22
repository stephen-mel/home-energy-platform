# Tariff approval and rollback safety hardening

No executor, tariff write, live call, UI or scope change is introduced.

## Historical review versus current use

`isBaselineHumanVerified` remains a time-independent historical audit question.
`verifyTariffBaseline` now checks approval time against both effective validity
and representation coverage. It rejects delayed approvals outside either.
`assessBaselineCurrentUse(record, { now, currentProposal })` separately checks
current validity, current identity/economics, review integrity and recomputed
compatibility. Historical verification is not cleared on expiry. Baselines still
have no trusted Tesla rollback proof and cannot be used for execution.

`baselineRecordConsistent` reconstructs the adapter candidate, review, diagnostics,
blockers and warnings from bound truth. Separately edited display prices/periods,
deleted diagnostic arrays and inconsistent candidate copies are rejected at
approval and current-use validation. A canonical JSON fingerprint is an equality
key, not an authenticated signature: a future service must own approval storage
and never accept arbitrary client JSON as proof that a person approved it.

## Exact operation-specific proposal approval

`createTariffProposal` binds proposal identity, target energy site, purpose,
timezone, explicit validity/expiry, economic key, exact proposed representation,
tariff-version identity, individual SMART/half-hour evidence and requested
exceptions. `approveTariffProposal` requires the exact fingerprint and explicit
in-validity timestamp. Baseline verification is not a proposal approval.

`assessProposalCurrentUse` recomputes the proposal, rejects mutations, requires
current/approved fingerprints to match, checks current time/site, explicit
confirmation, authority, compatibility and independent rollback evidence.
SMART cancellation, movement, eligibility or economic changes invalidate old
approval. Freshness is not silently treated as eligibility: stale evidence blocks
use without promoting any planned evidence.

Observe disallows action. Confirm requires exact approval. Automatic remains
future intent and also requires explicit approval here. All results remain
`writeReady: false` and `executorAvailable: false`, even if pure assessment
returns eligible for a trusted synthetic fixture. No approval authenticates itself.

For a pricing-constraint experiment only, explicit `BUY_BELOW_SELL` acknowledgement
may accept that specific diagnostic. The exception is fingerprint-bound and does
not change prices. `BOUNDED_FORECAST` is never an accepted exception. A complete
independently validated annual experiment representation is assessed as a separate
object from the bounded HEP forecast; the original forecast diagnostics remain
available with `coverageBasis`. Missing prices, invalid timezone/coverage and
other context blockers still apply. No bounded production candidate is made safe.

## Rollback trust boundary

`captureExperimentTariff` returns a structural restoration candidate, not proven
rollback. A caller's format label or locally generated valid tariff is insufficient.
Existing experiment preparation now always keeps `ROLLBACK_UNPROVEN` for those
inputs. Original structural preservation tests remain, but their prior unsafe
readiness expectations were tightened to require blocked/unproven.

`assessRollbackEvidence` is pure policy over a separately supplied trusted
observation ledger. It matches an unambiguous observation reference, exact
representation, intended Tesla site, authoritative observation basis, capture time,
expiry and an explicit maximum age. No ledger is implemented or wired in v1;
default trust is empty. Submitted captures/approval JSON must NEVER be used as this
trusted ledger. Future provenance authentication, access controls and revocation
belong at that server boundary. There is no invented lossless site_info endpoint.

## Economic comparison domain

`effectivePriceCurveKey` now normalizes window and eligibility boundaries to UTC
before sorting, state selection and serialization. Equivalent ISO offsets and
fractional-second spellings match; distinct milliseconds and DST-fold instants
retain their elapsed-time meaning.

The original whole-horizon comparison still distinguishes horizons.
`comparePriceSignalsInDomain(previous, current, domain)` offers a separate strategy
for future sync: caller selects a fixed meaningful operation interval and both
snapshots must fully cover it with known prices. It compares canonical clipped
curves only on that interval. Missing/gapped/unknown coverage returns explicit
`indeterminate` / `COMMON_DOMAIN_UNAVAILABLE`. It does not choose a convenient
intersection or imply equivalence outside the selected interval. Sync Planner now requires this explicit comparison interval and uses the same
validated projections for decisions and changed-period reporting. Invalid domain,
horizon or monetary input is indeterminate and blocks planning. Full proposed-curve
Tesla diagnostics remain independent of the comparison interval.

## OAuth state binding

Login creates independent cryptographically random state and browser binding.
Only digests enter a bounded process-local pending registry (128 entries, five
minutes). The browser binding is an HttpOnly SameSite=Lax cookie, secure on HTTPS,
scoped to the callback path. Callback validates state plus cookie and consumes the
entry synchronously before any exchange or token-file replacement. Missing,
mismatched, expired, wrong-browser and replayed states fail closed. Failed exchanges
also consume state. Error responses/logging do not echo provider errors or secrets.
Scopes remain `openid offline_access energy_device_data`.

This matches the current local single-process prototype: restart invalidates pending
flows; a multi-worker deployment needs a shared atomic consume store. No actual
OAuth authorization or exchange was performed during implementation/testing.

## Validation and remaining boundary

Regression suites: `tests/tesla-safety.test.mjs`, `tests/tesla-oauth-state.test.mjs`,
and strengthened experiment tests. All integration effects are mocked.
Before any future energy-command scope or write, establish authenticated approval
and rollback storage, a current independently verified restoration point, explicit
human authorization, complete compatible operation coverage and read-back/restore
handling. None of those external capabilities is enabled by this change.
