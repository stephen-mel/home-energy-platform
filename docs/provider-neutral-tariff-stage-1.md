# Provider-neutral tariff model — Stage 1

This is an additive, pure library. It is not connected to current-site configuration,
the dashboard, Kraken retrieval, Tesla execution, or ownership persistence.

## Entry points

- `economic-model.ts`: agreements, economic versions, referenced rates/schedules,
  tax, evidence, conditional rules and separate physical-delivery evidence.
- `resolveEconomicModel(model, horizon, generatedAt, intervals)`: supplied-data
  validation, canonical resolution and existing bounded `PriceSignal` projection.
- `deriveConsumerAmount(price, fraction)`: exact decimal tax derivation.
- `resolveLegacySiteEconomics(site, kraken, now)`: explicit compatibility facade
  delegating to the unchanged historical resolver. It does not reinterpret prices
  or back-calculate tax. Historical inputs need not be converted to the new model.

No entry point fetches, reads a clock, writes, issues authority, or changes ownership.
Evidence source declarations are supplied assertions, not cryptographic proof of
provider authentication. A future trusted adapter must establish that provenance.

## Validity, freshness and genericity

Agreement, economic version, rate, tax and evidence coverage are independent.
All date ranges are half-open. Known agreement end caps economics but cannot
extend evidence. Null agreement start/end is insufficient for a known curve;
product availability is not used as a substitute. An early effective invalidation
clips applicability. A revoked/terminated/replaced record without an explicit
cutoff is not usable. Status never supplies an inferred effective timestamp.
Future agreements are selectable only inside their supported intervals.

Freshness is explicit and separately mapped to `stale`; unknown freshness maps
conservatively to stale. It does not change the price or create an artificial
contract expiry. Observations after the supplied generation time reject.

Rate IDs have no cheap/standard meaning. Daily periods may reference a rate more
than once, cross midnight, end at 24:00, or explicitly cover all day. Equal daily
start/end is invalid. Import/export use separate agreement/version records. A
standing rate resolves separately and never enters the marginal price signal.

The same model covers Drive Smart's two import bands and flat export, and three
rates over 23:30–05:30, 05:30–16:00, 16:00–19:00, 19:00–23:30. It grants no supplier
or HEP device-control authority. UTC instant sampling with London civil-time
matching preserves spring gaps and distinct autumn-fold instants. The bounded
resolver accepts at most 366 elapsed days and retains minute-resolution canonical
periods plus exact non-minute validity/evidence boundaries; consumers should use
short planning horizons. Projected equal periods are coalesced.

## Tax and precision

Amounts are bounded decimal strings in major currency units. Exact base-ten
integer arithmetic computes tax-exclusive amount × (1 + tax fraction). Inclusive
and observed-external amounts pass through without a second tax application or
inferred decomposition. Decimal syntax and precision are validated; no display
rounding or comparison tolerance is used.

September examples: 0.0285 × 1.05 = 0.029925; 0.23978 × 1.05 = 0.251769;
0.57143 × 1.05 = 0.6000015. Zero tax gives the original amounts. These do not
rewrite 0.02993/0.25177 Tesla observations or 0.0299/0.2518 historical HEP prices.
Bill-total rounding and bill ingestion are outside this layer.

The canonical decimal remains in the result. Legacy numeric projection requires
finite conversion with the same decimal string on round-trip; unsupported numeric
precision/notation projects unknown with `PRICE_NOT_REPRESENTABLE`. This is
conservative, not a claim that JavaScript numbers store all decimals exactly.

## Conditional rules and physical evidence

An interval requires a matching rule, agreement, authenticated-dispatch evidence,
provider/type and exact original cause boundaries. Rule and rate evidence must
cover it. A rule references the applicable dated rate. It cannot hide unknown base
economics. A schedule can explicitly preserve its base economics; otherwise the
rule may replace them. Competing rules and currency changes fail closed.

Generic qualification is provider-defined and need not require physical charging.
PhysicalDeliveryEvidence is deliberately not a resolver input. Command failures
cannot erase dispatch intent; measured power cannot create an economic interval;
planned energy is never converted into delivered energy. No automatic promotion
to observed-qualified or billed-verified occurs in Stage 1.

Canonical conditional results retain their rule and planned status. The existing
PriceSignal has only one conditional vocabulary: scheduled EV charging. Only an
explicit `drive-smart` compatibility rule (Kraken SMART with the conservative
physical-charging-required condition) projects into it. Other conditional results
remain available canonically but project unknown with CONDITION_NOT_REPRESENTABLE.
This prevents generic eligibility from acquiring existing SMART execution meaning.

A schedule's preserve policy alone does not imply cheap pricing. Only explicit
`guaranteed-off-peak` compatibility metadata emits that existing legacy kind.
Other base bands project as standard, irrespective of price or manufacturer.

## Failure and trust boundaries

Malformed input rejects the model with INVALID_ECONOMIC_MODEL and an unknown
bounded signal. A malformed horizon returns an invalid result with empty curves.
Missing coverage/references produce unknown; ambiguous schedules, agreements,
versions, rates or taxes produce conflicting/unknown economics. Diagnostic codes
carry no credential or raw provider-response data. No precedence by freshness,
lowest price, or array ordering resolves contradictory knowledge.

Supplier-bill provenance is representable as bounded evidence, but this module
does not ingest bills or assert that a historical bill proves future recurring
rates. It also does not resolve OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED: that blocker
concerns Tesla representation assumptions. All existing blockers remain untouched.

## Deferred

Trusted live agreement/rate adapters, evidence storage, reconciliation cadence,
customer invalidation UI, qualification observation/promotion and supplier billing
integration remain separate work. Current October configuration is not updated.
No journal, B2, receipt, finaliser, SQLite, restoration or approval migration is
required or performed. Legacy configuration is deliberately preserved on its
original resolver until a separately reviewed production integration.

## Evidence subject and claim authority amendment

Canonical evidence now separates `provider` (attestor), one explicit `subject`
(agreement ID, supply reference, supplier, direction, product code and tariff code),
and `claims`. All six subject fields must exactly match the consuming agreement;
none are inferred from the object referencing the evidence.

Claims use a closed role/target union:

| Role | Target in addition to subject |
| --- | --- |
| agreement-identity, agreement-validity | none |
| economic-version, schedule-definition | versionId |
| energy-rate, standing-charge | versionId + rateId |
| tax-treatment | taxId |
| conditional-rule-definition | versionId + ruleId |
| conditional-dispatch-occurrence | ruleId + assetId + dispatchType + original start/end |

The permitted kind/role matrix is closed:

| Kind | Permitted roles |
| --- | --- |
| supplier-agreement | agreement-identity, agreement-validity |
| supplier-rates | economic-version, schedule-definition, energy-rate, standing-charge, tax-treatment, conditional-rule-definition |
| supplier-bill | energy-rate, standing-charge, tax-treatment within explicit coverage |
| manual | all supplier-economic roles above; never conditional-dispatch-occurrence |
| authenticated-dispatch | conditional-dispatch-occurrence only |
| tesla-observation | none; empty claims permitted for provenance only |

Supplier-owned kinds require provider == subject.supplier. A transport such as
Kraken is not substituted for the asserting supplier. Manual/third-party attestors
may differ from that supplier but must explicitly identify the same subject and
permitted targets. Dispatch attestors must match the rule's dispatch provider.
Physical/control/delivery records remain outside economic authority entirely.

Validation requires declared AND kind-permitted claims, exact subjects and
existing targets. Missing, unknown, malformed, duplicate or prohibited claims
reject, including prohibited claims that no consumer uses. Occurrence timestamps
are normalized to instants when comparing identities and detecting duplicates.
There is no wildcard subject, target or role. An unused occurrence assertion can
remain evidence but cannot manufacture a ConditionalInterval.

Agreement references collectively require identity and validity; version
references collectively require economic-version and schedule-definition. Every
referenced record must contribute. Rate/rule references require their own exact
role and target. Tax definitions may list distinct records for multiple subjects;
each listed record must support that tax for its own subject. At use, only records
matching the consuming agreement can support its tax; absence rejects. Records
for another agreement never contribute coverage, freshness or provenance to it.

A rule definition and a dispatch occurrence are separate authorities. Dispatch
occurrence never establishes rule, money, tax, standing charge or agreement
truth. The target monetary rate and tax require independent economic evidence.
Existing temporal checks still apply; claims never extend evidence coverage.

Binding errors invalidate the resolution and return only unknown curves with
sanitized EVIDENCE_ROLE_NOT_PERMITTED, EVIDENCE_CLAIM_MISSING,
EVIDENCE_SUBJECT_MISMATCH, EVIDENCE_ATTESTOR_MISMATCH, EVIDENCE_TARGET_MISMATCH or
EVIDENCE_CLAIM_DUPLICATE diagnostics. Malformed basic model data retains the
existing INVALID_ECONOMIC_MODEL diagnostic. This semantic policy is not
cryptographic authentication of caller-supplied facts.

The legacy facade is unchanged and synthesizes no claims. Frozen proposals,
observations, receipts, ownership and historical configuration are neither
converted nor granted canonical evidence authority by that facade.

## Immutable resolution contract

Every `resolveEconomicModel` return is deeply frozen, including successful,
unknown, conflicting and invalid results and the early invalid-horizon return.
Freezing happens only after resolution, coalescing and projection have completed.
An iterative local traversal uses a WeakSet to visit shared objects once and to
handle cyclic plain metadata safely. Source-price, tax and rule aliases may be
shared for efficiency but are never returned as mutable state. The projected
PriceSignal, standing charges, provenance, nested metadata and all arrays are
covered. Mutation may throw in strict mode; it cannot alter a returned value.

Model and interval inputs are detached with the existing structuredClone before
validation. The result horizon is constructed from string fields only, including
invalid-input returns; no caller-owned nested horizon object is retained/frozen.
Caller inputs remain mutable and subsequent edits do not affect results. The
legacy adapter and its historical output contract are unchanged.

Plain records, arrays and immutable primitives are the supported result data.
Map, Set, Date, typed arrays and other mutable internal-slot objects cannot be
made immutable by Object.freeze. A local graph check rejects these in detached
model/interval data with the existing invalid-model result rather than returning
a misleadingly frozen wrapper. This also covers otherwise-unused extra metadata.
No evidence authority, temporal, decimal, compatibility or execution policy is
changed by this immutability boundary.
