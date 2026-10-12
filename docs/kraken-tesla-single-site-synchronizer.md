# Kraken-to-Tesla single-site synchronizer increment

`planSingleSiteSynchronization()` is a pure, read-only lifecycle layer over the
existing Confirm-mode reconciliation. It classifies a genuine managed SMART
economic difference as `apply`, `update`, or `restore`, while preserving the
existing exact Tesla representation, ownership evidence, compatibility
diagnostics, approval requirements and production blockers.

The planner never writes, approves, journals or returns an executable payload.
It preserves Tesla-observed base import and export economics and only proposes
changes attributable to fresh Kraken SMART import intervals or restoration of
previously confirmed ownership.

Current import economics are read from the authenticated account's active
`HalfHourlyTariff` agreement. The adapter requires the expected Next Drive Smart
V5.2 product/tariff identity, active agreement dates, contiguous returned rate
coverage, and the observed 00:00–06:00 / 06:00–00:00 London schedule. Kraken
values are converted from p/kWh to GBP/kWh. Economic validity is bounded to the
intersection of returned unit-rate intervals and agreement validity; the wider
agreement does not extrapolate price coverage. Local schedule validation accepts
the real 23-hour and 25-hour London DST days but rejects multi-day intervals that
cannot be represented by the daily tariff model.

Production use additionally requires the site to configure the exact tariff code
and an opaque meter-point reference. The latter is SHA-256 over
`eon-meter-point\0<MPAN>`; HEP hashes it at the authenticated client boundary and
does not retain the MPAN. The current site intentionally has no invented value,
so tariff-dependent proposals fail closed with
`SITE_TARIFF_IDENTITY_UNCONFIGURED` until the intended meter point is configured.
Vehicle and dispatch snapshots still refresh when tariff retrieval or validation
is unavailable; they do not thereby gain tariff authority.

Kraken has not supplied an export agreement for this account. HEP keeps
canonical export economics unknown, preserves the complete export side captured
from Tesla in any proposal, and retains `EXPORT_ECONOMICS_UNVERIFIED` alongside
the existing production blockers. Planned SMART dispatches remain separate
conditional evidence and do not prove the billed rate.

The September journal/latch is unchanged. Repeated supervised replacement
execution and verified restoration remain a separate next step.
