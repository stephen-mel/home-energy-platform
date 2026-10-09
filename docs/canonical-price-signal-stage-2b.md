# Stage 2B — explicit canonical presentation boundary

## Integration seam and isolation

Production signals still originate in `site/get-site-price-signal.ts`, using site
configuration and already-loaded Kraken data. The Home page and opportunity
presentation consume those economics. Tesla reconciliation and supervised preparation
also use that constructor, feeding comparisons, managed scope, exact approvals,
readback, restoration, journal and persistence. Replacing that shared constructor
would change trusted decisions; Stage 2B leaves it and every existing caller intact.

`selectedHomeEnergyPlan(selection, now)` is an additive pure opt-in wrapper around
`homeEnergyPlanView`. It accepts one explicit source: a Stage 1 canonical resolution,
a Stage 2A offline result, or a labelled manual-assumption PriceSignal. No fixture
is production configuration. The wrapper is exercised against the real pure view
in tests, but is not connected to the Home page, React component, opportunity engine,
reconciliation, executor or persistence. It provides no execution authority.

## Complete presentation validation before consumption

The original detached `source` and `signal` remain available **for inspection**.
The separate `presentationSignal` is the only curve passed to the legacy view for
canonical/offline selections. Its windows are not repriced, relabelled or repaired:
only validated windows survive. This protects all output fields together, including
`currentImport`, `currentExport`, `cheap`, `cheapNow`, timeline segments and their
rate labels. There is no post-hoc patching of individual view fields.

Validation checks both directions independently:

- A window must correspond to an exact, contiguous, non-overlapping half-open
  partition of canonical periods of that direction. Coalesced windows can match
  multiple parts; no array-index association is assumed.
- Known money requires every part to have known, valid consumer economics and an
  exactly matching decimal amount, currency and kWh unit. Sources and stale flags
  must agree. Standing charges never enter presentation curves.
- Known standard windows require unconditional canonical standard eligibility.
  Guaranteed off-peak requires protected, unconditional off-peak canonical parts,
  condition `none` and no conditional assessments.
- Supported Drive Smart conditional economics override compatibilityKind and stay
  `cheap-opportunity` / `scheduled-ev-charging`, always planned-conditional. The
  supplier rule must have the existing Kraken SMART / physical-charging-required
  compatibility. Occurrences cover every part, and each appended assessment keeps
  the exact bounds, half-hour assessment period, sources and planned state emitted
  by Stage 1. Unsupported or mixed eligibility cannot be promoted.
- Null standard windows may convey genuinely unknown/conflicting economics, including
  an unsupported/lossy canonical projection. They cannot produce cheap indicators.
  Unknown off-peak windows are rejected because the legacy view would select their
  kind as cheap even without a price. They are never relabelled standard.

These checks validate the existing projection contract. They do not recalculate
rates/tax, define new cheapness thresholds, or replace the canonical resolver.
Canonical exact strings, tax, standing charges and original evidence remain in the
attached resolution. Partial export evidence never fills import gaps or vice versa.

## Rejections, gaps and unavailable results

Inspection of `homeEnergyPlanView` confirmed that ordered, disjoint windows with
holes produce explicit `window: null` timeline segments, never a price spanning the
hole. A rejected window is omitted from the presentation-only curve, with a
`PRESENTATION_IMPORT_WINDOW_REJECTED` or export diagnostic. No part of that rejected
window reaches current-rate or timeline labels. Valid later windows remain visible;
current rate is null when it lies in a rejected gap. Coverage beyond the supplied
horizon remains a null gap in the view's existing 24-elapsed-hour timeline.

Overlapping, unordered, malformed or out-of-horizon projected windows violate the
legacy input contract. The wrapper then returns `status: unavailable`, a structured
presentation diagnostic, and null view/presentationSignal while preserving the
original signal and source for inspection. It never chooses a winning overlap.
Missing or contradictory canonical correspondence rejects the corresponding window
rather than clipping or inventing a replacement period.

`selected` describes source selection, not complete/known/guaranteed economics.
Upstream invalid results remain unavailable. There is no fallback list, cache,
implicit clock or selection state. Unknown supplier evidence never falls back to
manual prices. Explicit manual selection preserves the legacy view unchanged and
is labelled as an assumption; canonical selection does not upgrade any manual
attestations within its source. Transport provenance remains separate from authority.

All result graphs, including the presentation-only graph, are detached and deeply
frozen after validation/presentation. Caller data stays mutable. Exotic mutable data,
cycles and accessors reject. This is not an attestation-authentication mechanism;
caller-fabricated canonical evidence is not made authentic by presentation checks.
Neither curve is a Tesla approval, ownership claim or persistence capability.

## Regression coverage

Dependency-allowlisted tests supply no network, storage or implicit clock. They
reproduce all three QA examples and inspect every affected view field and rateLabel:
unknown guaranteed, standard relabelled guaranteed, and residual current/timeline
claims after cheap-indicator rejection. Additional cases cover future/current gaps,
rejected periods between valid ones, valid successors, overlapping/unsorted curves,
partial/contradictory canonical coverage, mixed/unsupported eligibility, independent
export validation, unknown-to-known promotion, genuine conditional/guaranteed output,
manual behaviour, exact VAT/decimal retention, unchanged original signals and actual
nested mutation attempts. Synthetic evidence fixtures remain explicitly synthetic.
