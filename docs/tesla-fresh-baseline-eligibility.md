# Fresh-baseline eligibility policy

`assessFreshBaselineEligibility` separates the immutable September audit result
from preparation of a new operation. The historical journal identity, digest and
classification remain attached as unresolved audit context, but classification
alone is not an operational blocker.

The policy requires a new, fresh, complete authenticated `tesla-site-info`
observation with exact site and timezone binding; resolved or empty ownership;
an exact structurally valid proposal and human approval; and a restoration
candidate matching the fresh baseline. The approval binds a canonical baseline
identity containing the complete observed import/export tariff representation,
Tesla site identity and timezone. A changed baseline therefore requires a new
assessment and approval, including for complete pricing-experiment proposals.

Historical journal, attempt and mutation identities are modeled separately from
the new attempt and mutation identities. September's legacy record has no separate
attempt or mutation identity, so both are represented as `null`; they are neither
invented nor treated as a permanent blocker. Every identity that is actually
known is reserved, while durable storage must still enforce uniqueness before
execution. Import and export representations remain inseparable in the baseline.

This module is pure preparation policy. It cannot prove that a caller actually
performed an authenticated GET, cannot create a durable journal, and cannot grant
Tesla authority. Its five authority fields remain false. A production stage must
keep authenticated acquisition and this assessment inside one trusted server
path, then atomically create an independent durable claim before exposing any
executor. The pure function accepts restoration-ledger records only as injected
test/policy inputs; their labels are not authentication proof. Only a future
trusted server adapter may supply verified restoration evidence. That adapter
must recapture Tesla state after approval and retain every existing proposal,
ownership and restoration check. The trusted restoration ledger is not wired in
production, so operational use remains blocked by `ROLLBACK_UNPROVEN`.

Policy eligibility is not write authority. Even an eligible result explicitly
returns `writeReady`, `rollbackProven`, `restorationProven`,
`resolvesHistoricalJournal` and `grantsRepeatAuthority` as `false`.

September's journal is neither edited nor reclassified. Its API restoration and
causal history remain unresolved even when a new operation becomes independently
eligible for claim preparation.
