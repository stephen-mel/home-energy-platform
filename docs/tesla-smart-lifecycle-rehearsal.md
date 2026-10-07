# Full simulated SMART creation lifecycle

The rehearsal calls unchanged `runLocalExperiment()` code. Its real capture,
confirmation, request construction, response interpretation and reporting closures
call the real executor, preparation, domain preflight, B1 journal, B2 completion,
receipt issuer, pure finaliser and SQLite persistence. One cached production
module instance per environment preserves the private B2 registry. Observation
wrappers pass through the real arguments/results; they do not issue authority.
The helper never exports or invokes the private SQLite commit primitive.

Only external/environmental boundaries are substituted: Kraken device/dispatch
functions, Tesla fetch, synthetic credentials/site, environment loading, readline,
console, process context and clock. Scripted readline responses inspect the actual
saved/displayed review, compare proposal/payload hashes and representation, and
answer the exact generated challenge after both recovery acknowledgements. This
exercises approval binding, not human consent. No production approval flag or bypass
is introduced; the test-only process view supplies TTYs without changing host guards.

The Tesla simulator stores the representation parsed from the actual POST bytes.
GET responses wrap this state in raw `site_info` envelopes and pass through real
`captureObservedTariff`. Only the synthetic site's expected GET and tariff POST
are recognized. Unexpected network/dependency access throws, has no network
fallback, and records a violation checked even if production catches that error.

Every case has a fresh temporary workspace. Runtime filesystem paths are checked
against that root and symlinks are rejected. Journals, latches, review files,
synthetic token and SQLite use their normal relative paths beneath it. No real
environment, credentials, site configuration or operational state is read. Real
filesystem sync/close and SQLite transactions run under Node 26.8.2. Source files
are only read for test compilation. The controlled clock advances at simulated
terminal/network boundaries; there are no sleeps or CPU-time assumptions. Native
request timeout signals remain present but immediate fake responses do not prove
their live behaviour. Random IDs are checked relationally, not pinned to constants.

## Golden scenario

A separate fixture workspace first runs the genuine trusted lifecycle to establish
13:00–14:00 BST ownership on 23 September 2026. Its consumed latch is retained.
Only the closed valid database and matching simulated tariff are copied into each
case; no journal, capability or saved approval is imported.

At approximately 08:30 BST, the main scenario selects the upcoming 09:00–11:00 BST
SMART interval. Buy prices remain 0.02993 overnight and 0.25177 during ordinary
daytime; selected SMART import is 0.0299 and observed export stays 0.17 GBP/kWh.
HEP's separate 0.175 export economic value is not applied to Tesla. Planned SMART
evidence remains planned/conditional. The test checks exact submitted bytes,
chronology/durability, receipt and finalisation, captured generation/historyDigest,
one valid history append, preserved restoration lineage and export, new bounded
ownership only, and separate persisted reporting with both safety flags false.

## Compact negative scenarios

Rejection, ambiguous HTTP 200 with matching GET, insufficient readback and transformed
representation must skip persistence. A classified close failure must prevent B2
and persistence after a single POST. A competing genuine mutation must cause CAS
conflict without rebasing. To stage that race, a second isolated environment creates
real confirmation evidence from the same seed; its evidence-only persistence is
then invoked with a test process cwd inside the main case. This creates a genuine
SQLite append, not a fabricated conflict or new authority. Its separate latch is
retained. Neither setup nor replay touches a production path.

Before-commit and after-genuine-commit exceptions must both report indeterminate
ownership while retaining confirmed Tesla execution. Explicit evidence-only replay
must be idempotent without executor re-entry. A fresh second proposal against the
consumed main latch must fail before another POST. No case resets a latch, retries,
restores, refreshes a persistence precondition or manufactures capability authority.
Detailed schema, forgery, timestamp and I/O permutations remain in lower-level suites.

Passing demonstrates software composition and tested safety invariants. It does
not prove real Tesla endpoint/authenticated-readback behaviour, Opticaster response,
billing qualification, restoration/rollback, live network/human timing or operational
reliability. Fixture provenance is simulated, not evidence of a real Tesla read.
Runtime B2 authority remains local; journal JSON cannot recover it after restart.

The configured tariff version ends at London midnight on **1 October 2026**.
This September rehearsal must not justify an October live experiment or invent
October prices. Live authorization, current configuration/evidence, latch eligibility,
human approval and all existing blockers remain separate prerequisites.
