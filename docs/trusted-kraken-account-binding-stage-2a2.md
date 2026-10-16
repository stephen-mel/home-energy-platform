# Trusted Kraken account binding — Stage 2A.2

This foundation keeps ordinary Kraken refresh and financial presentation separate
from trusted current-baseline authority.

An import tariff identity may now contain an independently provisioned opaque
`accountRef`. The production refresh derives the account used by its authenticated
session from `EON_ACCOUNT`, but it accepts that session for the configured trusted
identity only when the two opaque references match. The expected reference must be
provisioned independently; deriving both values from the current environment would
not establish the intended household account. A mismatch is rejected before cache
lookup, recovery or an upstream request.

Export identity has optional configuration space for a future independently
verified `meterPointRef`. The current export query does not retrieve an MPAN, so no
reference is inferred, copied from import or provisioned here. Trusted complete
import/export comparison remains blocked while it is absent.

`assessTrustedCurrentBaselineFromKraken` is a server-only entry point. It accepts a
site, Tesla observation, comparison domain and assessment timing policy. It accepts
no Kraken state, price signal, account reference or trust flag. It acquires Kraken
state through `getKrakenState`, validates configured identities, constructs the
exact-domain signal internally and invokes a module-private comparison. Direct use
of the Stage 1 structural assessment remains blocked by
`EXPECTED_EON_ACCOUNT_BINDING_UNAVAILABLE`.

The user-confirmed E.ON Next Export Premium v3 price is retained as one configured
commercial assumption: GBP 0.175/kWh. It has no invented contractual expiry and is
labelled `user-confirmed-commercial-assumption` in projected provenance. It may be
used for financial calculations and forecasts only when authenticated export
evidence is genuinely absent or its retrieval is explicitly unavailable. Rejected,
stale, malformed, expired or contradictory authenticated evidence fails closed and
cannot fall back to the assumption. Financial values using the assumption remain
labelled estimates, including measured export energy. The assumption cannot
establish account, meter-point or agreement identity and the trusted adapter never
treats it as authenticated export evidence.

An export diagnostic is classified by its code. A diagnostic reporting an
integrity, identity, freshness, agreement or context failure suppresses both
authenticated pricing and the commercial assumption. Any snapshot that contains
both export evidence and an unavailable diagnostic is contradictory and is rejected,
even when that diagnostic would permit the assumption if the evidence were absent.
One export-evidence decision is made before price windows are constructed. It is the
only source of authenticated, assumed or rejected export windows, so rejected raw
evidence cannot re-enter through tariff configuration or an authenticated base-price
fallback. Rejected curves contain unknown pricing with explicit rejection provenance.
Diagnostics are runtime-validated: null, primitive, partial, extra-field, unknown or
otherwise malformed shapes are rejection rather than absence. Only the explicit
retrieval-unavailability allowlist can make genuinely absent evidence eligible for
the commercial assumption.

The server-only assessment validates its request and comparison domain before
starting authenticated Kraken acquisition. Malformed domains therefore return a
deterministic insufficient-evidence result without network or cache activity.
The expected evidence envelope and generated price signal retain the authenticated
Kraken retrieval-completion timestamp. Assessment time is used only for freshness
and comparison timing; it is never substituted for acquisition provenance. Invalid,
future or over-age acquisition timestamps fail closed.

This stage performs no live read, Tesla write, historical-journal resolution,
rollback, restoration or repeat-attempt grant. Every assessment result retains
`writeReady`, `rollbackProven`, `restorationProven`,
`resolvesHistoricalJournal` and `grantsRepeatAuthority` as false.

Before an authenticated complete economic match can be used, provision the opaque
intended import account reference from independently reviewed account evidence and
obtain separately authorised read-only evidence that the export agreement exposes a
usable meter-point identifier. The latter must then be hashed at the client boundary
and validated against independently provisioned configuration.
