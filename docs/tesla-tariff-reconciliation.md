# Kraken → Tesla reconciliation: Confirm preparation

`reconcileTeslaTariff` is a pure read/compare/propose function. It consumes a site
configuration, normalized Kraken snapshot, observed Tesla tariff, exact Tesla site
ID, explicit comparison domain and caller-supplied clock. An optional previous
Kraken snapshot explains schedule changes. It derives the current HEP PriceSignal
through `getSitePriceSignal`; Tesla observations never replace HEP economic truth.

There is no UI, API route, transport, polling, retry, approval storage, executor,
rollback, journal access or site-latch reset. Existing dashboard and Experiment #1
close-out work are independent of this addition. The implementation imports only
pure domain modules, including the existing supervision constants/evidence-key
helper; it never calls the supervised execution orchestrator.

## Results

- `in-sync`: the managed SMART import signal matches over the remaining common
  domain. Other exact tariff differences may still exist. This is not proof of billing, optimiser behaviour or write compatibility.
- `update-required`: managed SMART import economics differ and an exact, structurally valid replacement
  representation is prepared for inspection. It is **not write permission**. The
  result and proposal retain all production blockers, including BUY_BELOW_SELL.
- `indeterminate`: stale/future/malformed evidence, mismatched site/timezone, unknown
  prices, invalid/incomplete coverage or an invalid/expired domain prevents a safe
  comparison. No replacement is offered.
- `blocked`: comparison established divergence but the exact representation cannot
  be constructed safely, or insufficient proposal validity remains.

Every result has `writeReady: false`, `rollbackProven: false`,
`humanApproved: false`, `inspectionOnly: true` and no executable write payload.
Successful comparisons expose HEP truth, expanded observed Tesla prices, exact
comparison fingerprints, changed periods/channels, SMART source evidence, snapshot
ages/expiry inputs and blockers. Without a previous Kraken snapshot, the historical
schedule change is unknown; the current Tesla economic difference is still known.

## Economic equivalence and domain

The existing observed analyser expands calendar-date seasons (including wrapping
seasons) into UTC intervals using the site's timezone. Both sides are represented
as the existing PriceSignal type. Comparison-only copies remove eligibility/kind
annotations because Tesla cannot encode them. `comparePriceSignalsInDomain` and
`planTeslaTariffSync` then supply the existing canonical comparison and changed
period reporting. No new equality algorithm or price tolerance is introduced.

Full HEP truth, source attribution and per-period `planned-conditional` evidence
remain alongside those monetary views and in the strict proposal. A stored Tesla
price is not a guarantee that E.ON awarded it. Raw JSON/labels, source timestamps,
SMART splits/merges and provenance alone do not constitute economic changes.
BOOST does not affect the HEP tariff. SMART movement inside a guaranteed overnight
band creates no managed increment; any baseline price difference remains unmanaged.

The requested domain is explicit. Elapsed time is excluded by advancing its start
to `max(requested start, now)`, recorded as `ignoredPastUntil`. Both curves must
cover the remaining domain with known prices. The comparison does not silently
shrink to the intersection of available data; domains outside the existing 48-hour
HEP horizon are indeterminate. An entirely elapsed domain is indeterminate, not a
claim of indefinite equivalence. Expired SMART differences outside the remaining
domain do not trigger replacement.

## Managed SMART scope and exact unmanaged differences

Kraken reconciliation owns only incremental import prices caused by effective
SMART opportunities. `managedSmartTarget` starts with observed Tesla prices and
changes only those import intervals. It compares current HEP SMART prices against
the HEP base signal without Kraken; an opportunity that does not change the base
price is not a managed increment. Guaranteed overnight pricing is preserved.

`comparison` drives the decision using the managed target. `exactComparison` still
reports every HEP-versus-Tesla monetary difference, with no tolerance.
`unmanaged.comparison` and `unmanaged.differences` report exact residual differences
between the managed target and HEP truth. Export is always unmanaged. Underlying
import differences outside managed increments are also unmanaged. Neither alone
produces `update-required`. HEP truth is never changed to match Tesla.

For example, Tesla 0.17 export versus HEP 0.175 remains visible but cannot cause a
SMART update. Tesla 0.25177 daytime base versus HEP 0.2518 is likewise preserved.
When a new daytime SMART interval needs 0.0299, only that increment is proposed;
export and unrelated base prices remain as observed. No rounding is introduced.

Removing/moving a previously represented SMART interval requires optional
`managedImport` historical context: the underlying observed Tesla `baseline` and
HEP `representedSignal` actually represented by the managed operation. This must
come from retained, site-bound operation evidence, not inference from a cheap
price or a prior Kraken schedule. The pure caller supplies it; this task adds no
persistence, trust ledger or inferred successful write. It is not rollback proof.

In removed intervals, the current price must still match either that previous
managed price or its recorded baseline. A third price is an ownership conflict
and returns `indeterminate`. Removal restores the recorded Tesla baseline, never
HEP's unrelated base price. Without historical ownership context, unattributed
cheap periods remain observable and unmanaged rather than guessed away. This is
an intentional limit until a future caller supplies the appropriate operation
record. Baseline identity, coverage and exact structure are validated; a historical
capture is not subjected to the current live-capture TTL, nor used to satisfy it.

## Replacement and safety binding

The existing `createTariffProposal` accepts an additional observed-replacement
preparation input. It reconstructs, rather than trusts, the representation from the
observed before-state, HEP signal and bound managed scope. `prepareObservedReplacement` reuses
`simulateObservedSmartDate` for each changed price interval and independent tariff
side. This allows additions, removals, boundary movements and multiple periods;
obsolete owned cheap intervals are restored to the recorded Tesla baseline.

Unaffected prices are retained. The existing strict observed representation
validator checks complete recurring-season coverage. The result is re-expanded and
compared with the managed target over the domain. The full HEP signal remains separate. The portions of touched local dates outside the
domain are checked separately to prevent a DST fold from changing excluded/past
instants. Unrepresentable sub-minute intervals, conflicting repeated-hour prices,
unsupported captures/currencies and nonzero demand charges fail closed.

The proposal binds exact representation, site/timezone, HEP economic/evidence key,
SMART evidence key, managed scope (including historical baseline and represented signal), observed before-state (including capture provenance), common
domain, generation and expiry. Existing approval consistency reconstruction detects
representation tampering; changed dispatch evidence produces a new binding even if
an earlier proposal was approved. Existing `reviewObservedRestoration` supplies the
restoration review, with rollback still unproven. No new approval mechanism exists.

Freshness uses the unchanged capture 120s and Kraken evidence 60s limits. Invalid
and future source times fail. Proposal expiry is capped by those source deadlines,
60s from generation, the domain end and the next unexpired SMART end. At most 30s
remaining produces `blocked`, consistent with the existing minimum remaining
submission requirement. These are preparation deadlines, not a relaxation of the
executor's separate 60s approval gate or permission to skip fresh revalidation.

The complete observed representation still encodes recurring month/day seasons,
not year-specific automatic expiry. BOUNDED_FORECAST, RESTORATION_REQUIRED,
OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED, BUY_BELOW_SELL where applicable, and the existing
rollback/restoration blockers remain. A structurally valid candidate does not make
production execution safe. Compatibility diagnostics for the full HEP forecast
remain attached even when comparison uses a smaller explicit domain.

## Next bounded UI task

Expose this result through a read-only Confirm review view: explicitly requested
fresh reads, a visible common domain/as-of time, current-versus-proposed rates,
changed SMART attribution, exact representation/fingerprint, expiry and blockers.
Require a new reconciliation on stale/changed inputs. Human review/approval must
use the existing exact proposal model, with no executor wiring, polling policy,
automatic replacement or latch reset in that UI task. Write integration remains
separate and subject to every existing blocker and explicit authorisation.
