# SMART charge inspection (read-only)

`inspectSmartCharge(site)` in `src/lib/site/inspect-smart-charge.ts` is the explicit
server-only entry point. It returns `{report, text}` for local server tooling. It is
not a route, Server Action, scheduler or dashboard integration. Nothing runs merely
by importing it. No production reads were performed during implementation.

One invocation reuses `getRecordedKrakenState` (including its existing 60-second
cache, account-bound session, completeness validation and SQLite observation
recording) and the authenticated Tesla observation adapter. No financial-history or
HA request is needed. Existing read credential refresh/cache writes may occur; this
is not a promise of zero filesystem writes. There are no mutation journal,
ownership persistence, approval or executor calls.

The pure `inspectSmartTariff` projection reuses the schedule observation validator,
SMART dispatch adapter, verified tariff selection and real reconciliation. Its
inputs are server-acquired snapshots, not authentication capabilities. Caller-made
fixtures establish no trusted authority. It selects active or upcoming SMART slots
within the continuously verified tariff domain, capped by the reconciler's 48-hour
limit, retaining individual boundaries and vehicle attribution. Offsets/DST
interpretation stays in the existing domain code. BOOST is excluded.

The report includes the authenticated Tesla site/timezone and complete observed
import/export representation, verified Kraken tariff coverage and prices, per-vehicle
dispatches, retrieval age, schedule identity, observation content identity and
existing recording status. SMART identity
uses the existing `smartEvidenceKey`; the broader content identity uses observation
semantics (including BOOST and structural revisions). No new revision is recorded.
Fingerprints are SHA-256 digests of existing canonical identities; account and MPAN
references are not printed. Exact tariff payloads retain observed tariff metadata;
keep these local rather than publishing them.

`acquisitionDiagnostics` is separate from tariff evidence and authority. It reports
whether each read was attempted, whether fresh evidence was obtained, whether Kraken
used its existing stale fallback, and an allowlisted fixed error code. These transient
diagnostics are not written into Kraken snapshots, SQLite observations, ownership or
journals. Provider response text, transport exceptions and credentials are never
included. A diagnostic explains evidence availability; it cannot make evidence valid.
Configuration rejection before a client call reports `attempted: false`. A successful
Kraken retrieval that crosses the freshness deadline before delivery reports
`KRAKEN_EVIDENCE_EXPIRED_BEFORE_DELIVERY`; it is distinct from failure-driven stale
fallback. Tesla evidence is validated by the same fixed-shape boundary used by the
inspection before acquisition can report success.

Reconciliation alone constructs the managed target, proposal and restoration
candidate. It also reports evidence-supported per-kWh savings as a
`planned-conditional-estimate`, never billing-confirmed cost. No missing price falls
back to an example tariff. Missing evidence or
existing blockers are reported, never bypassed. A payload may be inspectable while
BUY_BELOW_SELL, bounded-forecast and restoration blockers remain. A restoration
candidate is not proven executable or accepted by Tesla. Unchanged economics may
legitimately produce no payload. No ownership is loaded, so this slice does not
claim to prepare safe removal of previously owned intervals.

Fresh-baseline policy is evaluated only when reconciliation produces a real tariff
change. The household path supplies no approval, attempt identity or synthetic
restoration-ledger evidence, so it reports those blockers and cannot become eligible.
When there is no SMART window, or all windows cause no managed economic change, the
assessment is `not-applicable`: no proposal, journal claim or mutation identity is
created. Missing evidence and dispatches beyond verified coverage remain separate
`not-assessable` outcomes rather than being described as an empty schedule.

Each invocation produces a new assessment; there is no saved approval. Changed
SMART evidence or rates change the proposal fingerprint. Retrieval timestamps do
not change stable schedule identity; expiry still limits the proposal. Fresh reads
and exact approval would be required by a future execution flow, which is absent.

Export MPAN evidence remains unavailable independently of SMART detection. A
commercial export assumption is not identity evidence. Independent CRM provisioning
is neither loaded nor activated. September is not read, modified or resolved; the
report explicitly leaves historical eligibility unestablished. All five authority
flags remain false. Freshness constants and SMART identity were extracted verbatim
from the supervised module and re-exported there to preserve existing callers;
inspection and reconciliation no longer load the executor module.

Synthetic example (not live household evidence):

- Synthetic EV: 11 October 2026, 13:00–13:30 UTC (14:00–14:30 London).
- Planned-conditional import: £0.0285/kWh; observed daytime import £0.23978/kWh.
- Proposed import change: selected half-hour to £0.0285/kWh.
- Observed export: £0.175/kWh, preserved exactly, not independently authenticated.
- Exact `tou_settings.tariff_content_v2` and restoration candidate appear in report.
- Blockers include BUY_BELOW_SELL, ROLLBACK_UNPROVEN, BOUNDED_FORECAST,
  EXECUTION_DISABLED, OWNERSHIP_NOT_ASSESSED and unresolved historical eligibility.
- `writeReady`, `rollbackProven`, `restorationProven`, `resolvesHistoricalJournal`
  and `grantsRepeatAuthority`: false.
