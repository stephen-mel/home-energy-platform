# Stage 2D2B2B — Kraken refresh persistence integration

`getSiteState(site)` now supplies the site to the production Kraken refresh. A
scope-keyed coordinator derives the opaque account scope independently of credentials,
then captures one account/authentication session and retrieval start before upstream
work. This allows authentication failures to recover only matching last-known state.
The coordinator validates the complete device/dispatch response, records
one `ScheduleRead` in the Stage 2D2B2A store, then publishes the existing dashboard
and JSON compatibility state. There is no scheduler, retry or additional query.

SQLite is authoritative for durable schedule observations. The dashboard remains
available after `busy`, `invalid`, `store-failed`, capacity rejection or an
indeterminate commit, but the separate `scheduleRecording` result retains that
failure or uncertainty. Ordering, scope and malformed-read rejection fail closed:
the candidate cannot overwrite accepted compatibility data. Explicit empty arrays
remain supplied absence only, never proof of cancellation, tariff entitlement or
billing.

The coordinator provides single-flight behavior only within one HEP server process.
SQLite serializes and orders cross-process writers; the legacy single-file JSON
cache has no cross-process publication ordering. A crash after SQLite commit and
before JSON publication can therefore leave the stale compatibility file behind the
durable ledger. Restart recovery never feeds JSON or SQLite disk state back as a
new authenticated read, and neither source is presented as fresh live evidence.
The 60-second live freshness window starts at authenticated retrieval completion;
slow or failed JSON compatibility publication cannot renew it.

The store path defaults to
`.cache/home-energy-platform/kraken-observations.sqlite`. An absolute
`HEP_KRAKEN_OBSERVATION_DB` value selects a local persistent server path. Home
Assistant can later point this at private `/data`; deployment, migration and
multi-process cache replacement are outside this stage.

This integration observes planned sessions. It performs no Kraken mutation, Tesla
operation, EV scheduling action or tariff/billing qualification.
