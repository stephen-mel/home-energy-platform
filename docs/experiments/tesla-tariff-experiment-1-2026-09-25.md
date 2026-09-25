# Tesla Tariff Experiment #1 — 25 Sep 2026

Status: closed after demonstrated manual recovery; production automation remains blocked.
Tesla energy site: `1689589307992591`. All clock times below are Europe/London
(BST, UTC+01:00 on this date).

## Objective and evidence provenance

Exercise a supervised temporary tariff derived from a live Q7 Kraken SMART dispatch,
observe Tesla's stored tariff and Powerwall/Opticaster behaviour independently, and
recover to the normal tariff. This was not an E.ON billing verification experiment.

This close-out records the operator's report supplied on 25 September 2026,
including their subsequent independent Tesla-app observations and read-only Fleet
API `site_info` restoration verification. No new API calls were made for this
close-out. Exact write/verification timestamps, full representations and fingerprints
were not supplied with the report; they are not invented here. This document is
supplemental historical evidence, not authenticated rollback-ledger evidence, a
reconstructed payload, a new approval or permission to repeat the experiment.

## Proposal, write and observations

HEP generated and supervised a temporary tariff based on a live Kraken SMART
opportunity. The proposed daytime buy schedule included:

| Local interval | Import price |
|---|---:|
| Before 13:00 (daytime) | 0.25177 GBP/kWh (25.177p) |
| 13:00–14:30 | Approximately 0.0299 GBP/kWh (2.99p) |
| After 14:30 (daytime) | 0.25177 GBP/kWh (25.177p) |

The SMART interval corresponds to 12:00–13:30 UTC. Existing export representation
was preserved; the reported Tesla export price is 0.17 GBP/kWh. This observed
Tesla value does not replace HEP's separate 0.175 GBP/kWh economic export value.

The write returned HTTP 200 but its immediate classification was
`write-outcome-unknown`. HTTP response received is not the same as an explicit
successful API acknowledgement or an immediate exact read-back match. The original
API outcome must remain unknown; later observations do not rewrite it.

Subsequent independent evidence reported by the operator:

- The Tesla app displayed the temporary 13:00–14:30 cheap-price period, establishing
  that the temporary tariff was subsequently observed/stored. This is not a claim
  of byte-for-byte equality with every field of the submitted representation.
- Around 13:00, Powerwall behaviour changed from using available solar to about
  5 kW of battery charging, including grid import. Q7 was also charging.
- Around 14:30, at the temporary tariff's end, Powerwall grid charging stopped and
  the battery began discharging to support house/vehicle load.
- Kraken re-optimised its SMART schedule several times during the experiment.
  The latest Kraken economic opportunity diverged from the already-written Tesla
  tariff. The exact intermediate dispatch revisions were not supplied here.

The boundary-aligned behaviour is evidence consistent with an optimiser response;
it does not expose Tesla's internal decision process or establish repeatable
causation. Tariff storage and optimiser behaviour are separate observations.
The reported Q7 charging does not promote HEP's dispatch-derived
`planned-conditional` periods to `observed-qualified` or `billed-verified`:
no interval-bound qualifying charging evidence or E.ON settlement evidence has
been ingested by HEP.

## Recovery and verification

The operator manually restored the tariff through the Tesla app by reconnecting /
selecting the normal E.ON Next Drive Smart V5.2 tariff. No HEP automatic/API restore
was performed.

A subsequent read-only Tesla Fleet API `site_info` read, as reported by the operator,
confirmed tariff identity `Next Drive Smart V5.2` and:

| Local interval | Restored buy price | Sell price |
|---|---:|---:|
| 00:00–06:00 | 0.02993 GBP/kWh | 0.17 GBP/kWh |
| 06:00–00:00 | 0.25177 GBP/kWh | 0.17 GBP/kWh |

`Today` no longer contained the temporary 13:00/14:30 boundaries; both observed
tariff representations reflected the restored normal structure. This demonstrates
manual recovery to the normal economic schedule. It does not prove that an API
restoration payload is accepted, that every field exactly equals the pre-write
capture, or that recovery works unattended.

## Evidence and safety disposition

| Evidence axis | Close-out state | Safety meaning |
|---|---|---|
| API request | HTTP 200 received; immediate `write-outcome-unknown` unchanged | No retrospective successful acknowledgement |
| Tariff subsequently observed/stored | Demonstrated by reported Tesla-app observation | Separate from immediate API result and exact representation equality |
| Optimiser behaviour | Operator-observed start/end changes consistent with tariff boundaries | No automatic behavioural inference or guarantee |
| Manual recovery | `manual-recovery-demonstrated`, with reported API verification of normal structure | Historical observation only, not rollback authority |
| Automatic/API rollback | Unproven; `rollbackProven: false` | No trusted rollback observation minted |
| Automatic reconciliation | Unproven and unimplemented | No production or unattended execution permission |

The existing journal's `apiWrite`, classification and immediate `apiTariffReadBack`
remain historical facts. The above app/behaviour reports are supplemental evidence
for the concepts `laterTeslaAppObservation` and
`laterPowerwallOpticasterObservation`; this close-out does not edit journal entries,
append a fabricated machine observation, release the exclusive site latch or
reset approval consumption. Future attempts still require a separate recovery
review and all existing supervision requirements.

Remaining production blockers are unchanged:

- `ROLLBACK_UNPROVEN`, `RESTORE_ACCEPTANCE_UNPROVEN`: no API restore-and-verify proof.
- `INVERSE_WRITE_MAPPING_UNPROVEN`: normal-tariff recovery does not establish an
  exact lossless mapping of captured state to a restoration write.
- `BUY_BELOW_SELL`, `RESTORATION_PRICE_TRANSFORMATION_RISK`: this observation does
  not resolve Tesla's documented buy >= sell constraint or possible price raising
  during another write/restoration. No bypass flag or price clamp is justified.
- `BOUNDED_FORECAST`: a finite Kraken forecast does not establish an indefinite tariff.
- `RESTORATION_REQUIRED`: manual recovery of this experiment does not provide
  automatic expiry/restoration for future temporary settings.
- `OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED`: one observed use does not validate all
  season/label, recurrence, DST or update behaviours.

Exact approval, freshness, site binding, evidence consistency, validity, coverage,
journal-before-write and single-use requirements are unchanged. The 120-second
capture, 60-second evidence, 60-second approval and 30-second minimum remaining
limits are unchanged. This record cannot make any production proposal write-ready.

## Conclusion and next bounded task

A supervised tariff change was subsequently visible in Tesla, with boundary-aligned
Powerwall behaviour, and manual recovery was demonstrated. A one-shot tariff sync
was insufficient because Kraken's SMART schedule continued changing.

**Product requirement:** Kraken SMART schedules are mutable after a Tesla tariff
proposal/write. HEP must reconcile the latest Kraken schedule against the economic
tariff represented in Tesla and detect economically meaningful divergence.

Progression: **Observe → Confirm → Automatic**. The next implementation should be
**Confirm mode**, scoped to read-only divergence detection and construction of an
exact replacement proposal for human approval, reusing the existing observed tariff,
common-domain comparison, economic fingerprint, proposal, restoration and safety
models. It should:

- Compare on an explicit safely covered domain; unknown/insufficient coverage is
  indeterminate, never silently unchanged.
- Ignore provenance/freshness-only differences and SMART movement wholly within
  guaranteed cheap coverage; detect changed, shortened, cancelled or removed
  economically relevant SMART intervals, preserving export independently.
- Present exact changed dates/times/prices, current evidence, restoration implications
  and all remaining blockers. Bind any replacement to fresh state and exact approval;
  never reuse the old approval after schedule changes.
- Keep planned/conditional eligibility separate from charging qualification and billing.

Do not include automatic execution, rollback, retry, latch reset, new polling or
Powerwall control in that task. Automatic mode requires later separately reviewed
work and stronger evidence. No reconciliation feature is implemented by this close-out.
