# Supervised Tesla tariff experiment

This local command is an experimental exception with manual recovery risk. It is
not connected to a web route, page, live stream, scheduler, normal Sync Planner or
production automation. It defaults to dry-run. No real write was performed during
implementation; all execution tests use mocked transports.

## Exact human approval flow

Run from the repository root in an interactive foreground terminal:

```sh
node scripts/tesla-tariff-experiment.mjs --site SITE_ID --vehicle KRAKEN_DEVICE_ID --dispatch-start 'EXACT_KRAKEN_START_ISO'
```

This reads fresh state and prints the exact candidate, fingerprints and blockers.
It does not request approval, create a consumed-attempt latch, POST, or restore.
Use the site ID and vehicle ID returned by the existing authenticated integrations;
`--dispatch-start` must match the original current SMART dispatch string exactly.
There are no hardcoded A3/Q7 IDs, dates, prices or dispatch boundaries in the executor.

When a fresh qualifying daytime SMART interval appears, first review the dry-run.
To initiate a separately supervised attempt, run the same command with
`--execute-supervised`. **That flag is not approval.** The command:

1. Requires an interactive terminal, with no CI or Node test context.
2. Retrieves current Kraken devices/dispatches through the existing read integration
   and captures authenticated Tesla site-info. Normal Kraken authentication is its
   existing session acquisition, not a preference/control mutation. No Tesla token
   refresh or OAuth change is implemented; expired read access aborts safely.
3. Rebuilds the HEP signal, existing observed proposal, comparison and restoration
   review using current configuration and the selected original SMART dispatch.
4. Displays the entire canonical payload and SHA-256 of both payload and proposal,
   writes a private local review file, lists all production blockers, and warns about
   manual restoration and annual recurrence. This final proposal may differ from
   the earlier preview. Read and approve this exact final payload only.
5. Requires these three exact terminal responses:
   - `AUTOMATIC ROLLBACK IS UNPROVEN`
   - `MANUAL TESLA APP RECOVERY MAY BE REQUIRED`
   - `EXECUTE SITE_ID SESSION_CHALLENGE` (the exact string displayed by this run).
6. Uses the existing exact proposal approval function. Re-reads Tesla and Kraken
   after approval. Changed tariff/site/timezone, changed/cancelled/removed/shortened
   SMART data or changed HEP economics abort; it never silently substitutes a new
   candidate. Source freshness timestamps alone may advance.
7. Checks the existing safety assessment. Non-exempt blockers abort. All production
   risk blockers remain recorded. Durably consumes this site attempt **before** POST.
8. Sends the displayed payload string once, immediately GETs site-info once and
   records/classifies both results. There is no automatic retry or restoration.

Approval is at most 60 seconds old at submission. Before-state is at most 120
seconds old; Kraken evidence is at most 60 seconds old. Future timestamps fail.
At least 30 seconds must remain before the SMART end when submitting. Timeouts
are 15 seconds for each Tesla request. Computational work and journal persistence
are followed by deadline checks. Slow review/read checks may require a new preview
and approval; there is no saved-approval loader or noninteractive consent flag.
There remains an unavoidable interval between final observation and submission;
this is not an atomic transaction with Kraken or Tesla.

## Representation and historical example

[Full deterministic example payload](examples/tesla-q7-2026-09-23-payload.json)
uses the captured 23 September 2026 Q7 data, with synthetic IDs/timestamps in its
test fixture. It is historical, cannot authorise a write and is not accepted as
CLI input. The live command always reconstructs from fresh data.

The original `Tomorrow` season covers September 23. Other seasons and the complete
sell tariff remain unchanged. The three buy labels in that season are:

| Label | Local interval | GBP/kWh |
|---|---|---:|
| `hour_0_minute_0` | 00:00–06:00 | 0.02993 |
| `hour_6_minute_0` | 06:00–09:00 and 11:00–24:00 | 0.25177 |
| `hour_9_minute_0` | 09:00–11:00 | 0.0299 |

Export remains the captured GBP 0.17, independent of HEP's GBP 0.175 economic
value. The numeric SMART price comes from HEP configuration; the new label is
derived from its actual London-local start, with no Tesla-defined semantics.
The payload shape is `{"tou_settings":{"tariff_content_v2": <complete representation>}}`.
No `SUPER_OFF_PEAK`, pricing-constraint flag, buy-price clamp or omitted sell tariff
is introduced. Representation, label mapping, price, exact interval, site, generation,
HEP economics and SMART evidence are bound into the reviewed proposal/approval.

The first executor is deliberately narrow: one SMART interval, within a single
local date (midnight end allowed), in an already isolated single-date Tesla season.
It rejects existing-label collisions, wrapping/multi-date seasons, sub-minute or
ambiguous DST intervals, guaranteed/conditional overlap, unknown prices, stale
fallbacks and unsupported captures. Those require separate reviewed work, not an
experimental bypass. Existing general simulation behaviour is unchanged unless
`preserveLabels` is explicitly requested.

## Exception and retained blockers

`supervised-manual-recovery` is a separate record and authority path. It is never
added to production `AuthorityMode`, production proposal exceptions or rollback
trust evidence. Production `writeReady`, `productionWriteReady` and rollback proof
remain false even after a successful experiment. Normal or automatic authority
cannot execute this path.

The acknowledged risks are `ROLLBACK_UNPROVEN`, `BUY_BELOW_SELL`,
`BOUNDED_FORECAST`, `RESTORATION_REQUIRED`, `OBSERVED_TOU_ASSUMPTIONS_UNVERIFIED`,
`INVERSE_WRITE_MAPPING_UNPROVEN`, `RESTORE_ACCEPTANCE_UNPROVEN` and
`RESTORATION_PRICE_TRANSFORMATION_RISK`. Acknowledging them does not resolve them.
Unknown/other blockers are denied by default. Missing approval, wrong site,
staleness, invalid coverage, changed evidence and expiry are never exempted.

The proposal's validity interval limits permission to submit; it does not make
Tesla restore itself. The operator must supervise the end of the SMART interval,
earlier charging completion or schedule change, and manual recovery if needed.
The represented month/day exception repeats annually unless removed. The executor
does not monitor charging, infer E.ON eligibility, or create charging qualification.
Do not assume that resubmitting the old tariff will preserve its buy-below-sell
prices: automatic rollback remains unproven.

## Single-use persistence and results

Private files are inside `.cache/home-energy-platform/tesla-experiments/`, already
ignored by Git. Review files use mode 0600. An exclusive `site-SITE_ID.jsonl` creation,
write and fsync must succeed before POST. It contains the before-state, complete
proposal/payload, exact consent, retained risks and final freshness/evidence checks.
Completion is appended and fsynced. Credentials and raw API response bodies are not
stored. A site latch is not released automatically, even on rejection, timeout,
process termination, expiry after claim or a failed completion write. Concurrent
processes and restarted commands cannot repeat that site's attempt. There is no
reset/unlock command: an existing latch requires a separate manual recovery review.
A journal failure before POST aborts. A failure after POST must not trigger a resend.

Results distinguish:

- request rejected;
- submitted representation preserved exactly;
- pure buy-price raising to the unchanged flat sell price;
- accepted but transformed differently (including changed labels/metadata);
- read-back unavailable/insufficient;
- write outcome unknown (timeout, ambiguous server response or transport failure).

HTTP 2xx alone is not treated as an explicit API acknowledgement. An explicit
result/code acknowledgement is recorded separately from stored tariff comparison.
GET is attempted even after rejection/unknown outcome. A matching GET cannot prove
that an uncertain write succeeded. Pure buy-raising classification requires exact
whole-representation equality after that price-only transformation, not just a
matching price in one sampled period.

The result record keeps `apiWrite`, `apiTariffReadBack`,
`laterTeslaAppObservation` and `laterPowerwallOpticasterObservation` separate. The
latter two remain null until a later human report; there is no automatic behaviour
inference or observation-entry UI in this task. Those later reports must remain
separate evidence, never a rewrite of the original API result. No charge, discharge,
reserve, mode or grid-setting command exists in this executor.

## First fresh A3 or Q7 attempt

Obtain the fresh exact site/device/start identifiers through the existing read-only
integration, preview the command without an execution flag, and review any blockers.
If the date season or price configuration is unsupported, stop. Arrange manual
Tesla-app recovery and supervision through the interval end before beginning.
Only then launch the interactive execution mode and review its newly rebuilt exact
payload. Enter both acknowledgements and its one-use challenge. After the attempt,
inspect the recorded API result, read-back and Tesla app separately. Do not retry
an ambiguous result or remove the site latch simply to run again. This implementation
task itself provides no approval for a real write.
