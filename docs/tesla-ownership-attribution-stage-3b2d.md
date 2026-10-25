# Stage 3B2-D: offline ownership attribution

This increment adds an explicitly versioned ownership-attribution extension to the existing V2 operation intent. It is documentary preparation and validation only. It does not issue receipts, finalise SQLite ownership, retire obligations, claim successors or register any runtime capability. There are no provider adapters or live calls.

## Contract and trust boundary

An attributed request opts in with `ownershipAttributionVersion: 1`. The configured server composition must provide `readOwnershipAttributionAdmission(site, operationId, mutationId)`. This independent port supplies historical authenticated schedule/pricing acquisition identities, guaranteed coverage, the intended comparison domain, newly authorised import changes, and an explicitly established ownership-validity policy. No default implementation, coverage guarantee or validity policy is supplied. JSON labels and hashes do not establish authentication.

The admission is bound to the captured Kraken vehicles and import evidence, including their acquisition identity and pricing observation time. Coverage must contain the entire comparison domain and pricing must remain within the captured agreement and tariff-version boundaries. SMART changes must have the captured scheduled-charging price and contiguous SMART dispatch coverage. All dispatches are parsed before filtering. BOOST does not authorise SMART ownership. New authorisation intervals and comparison/coverage boundaries are half-open, offset-qualified and minute-aligned; the existing Tesla representation cannot encode arbitrary sub-minute or offset-distinct fold prices.

Validity start/end come from the independent explicit policy admission. They are not calculated from approval lifetime, dispatch duration, tariff annual seasons or fixture values. For apply/update, policy validity must contain the comparison domain and preparation instant; submission must also precede its end. An update cannot renew an existing ledger's `validUntil`. Restore preserves the predecessor's exact historical policy admission, including an already elapsed validity end; it does not create a new SMART validity horizon. Production integration remains blocked until real authenticated coverage and independently supported policy facts can be supplied; the test policy admissions are explicitly offline fixtures.

The attribution binds operation kind/IDs, site/timezone, exact predecessor, ownership before/expected-after generations, original observation and tariff fingerprints, retained origin identity, origin issuance reference and exact payload fingerprint. Root preparation binds its originating operation/mutation and pre-existing opaque issuance reference; the initial/completion IDs do not yet exist and cannot be hashed recursively into themselves. The existing Stage 3B2-E completion context subsequently joins this root to the retained original's exact originating journal identities. Successors bind the complete existing retained-origin key.

## Existing ownership rules reused

The projection uses `deriveOwnershipTransition`, including prior ownership checks, domain containment, rate comparisons and export preservation. The existing bounded replacement builder verifies that an apply/update payload is the exact supported reconstruction, preventing unrelated payload changes and excluded DST-fold occurrences. Exact representation checks intentionally fail closed on alternative encodings.

New SMART authorisations describe actual economic changes. Previously owned pieces that remain unchanged are recorded separately, including split intervals. Withdrawal to an old interval's restoration price is separately attributed from the prior ledger; it cannot create new SMART ownership. Each projected restoration price is checked against the complete immutable original before assigning its retained baseline lineage. Restore requires the exact original tariff and has no new SMART authorisations. Elapsed ledger prefixes remain historical; these records do not discharge an obligation.

The prepared projection is explicitly distinct from execution-time attribution. The same interval kernel can project at the durable completion's actual submission instant, retaining exact historical prefixes (including second-precision boundaries). Predecessor ledger checks use that documentary projection rather than pretending preparation time was execution time. This calculation creates no confirmed ownership object or capability.

Expected generation still comes from Stage 3B2-J's deterministic preparation function, without reserving or committing ownership. Successor preparation and evidence validation compare the prior attribution projection and approved validity to the current V3 ledger. A future finaliser must enforce the exact approved generation with SQLite CAS and separately validate actual execution/readback timing. This contract does not make a prepared projection into confirmed ownership.

## Approval, journal and restart

Operation-specific approval covers the entire attributed intent. Existing journal files, exclusive creation, durability and completion mechanisms are reused. Initial/prepared validation checks binding and complete prepared admission respectively; full Stage 3B2-E validation requires the independent attribution context for each attributed operation and checks Kraken freshness at the recorded submission instant.

Attributed journal recovery must reacquire the historical admission from the independent trusted port and match it exactly. Missing or conflicting admission blocks recovery, even if record checksums have been recomputed. This is an admission check, not fresh execution permission. Pending, incomplete and ambiguous evidence keeps the existing blocking behaviour. The port must be a trusted historical evidence reader, not a function that merely echoes the journal's own admission.

Older V1 journals, legacy V2 ownership and unattributed V2 evidence keep their previous interpretation. They gain no attribution or restoration authority. Attributed histories cannot be downgraded, and an unattributed predecessor cannot be silently promoted into attributed history.

## Deferred integration

Runtime receipt issuance, exact-submission-time finalisation, atomic V3 SQLite transactions, obligation retirement, successor claims and production acquisition/writes remain deferred. Any future integration must revalidate trusted provenance and freshness, enforce the existing fixed-export and `BUY_BELOW_SELL` gates, and preserve runtime capability identity checks and September's attempt latch. Recovery and documentary validation supply none of these authorities.
