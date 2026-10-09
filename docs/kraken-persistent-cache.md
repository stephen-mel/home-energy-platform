# Kraken last-known state (local prototype)

The storage adapter is `src/lib/site/kraken-state-store.ts`. It saves a versioned
JSON document at `<process.cwd()>/.cache/home-energy-platform/kraken-state.json`.
When started from this repository, that is:
`/Users/stephenmellish/home-energy-platform/.cache/home-energy-platform/kraken-state.json`.
The directory, including temporary files, is ignored by Git and is outside `public`.

Successful live retrievals save only allowlisted normalized vehicle fields and the
last-successful-update timestamp. Nested fields are validated and reconstructed;
extra upstream fields, credentials and authentication data are not serialized.
Files are created with mode 0600 (owner read/write), using a sibling temporary file
and atomic rename so incomplete writes do not replace the last good snapshot.
The adapter catches filesystem and validation errors; persistence is best-effort.

The existing 60-second in-memory cache is unchanged for successful live responses.
After restart, the first request still attempts live retrieval. Only if that fails
and there is no memory snapshot is the file read. Recovered state is always stale
and retains its original successful timestamp, using the existing dashboard stale
message. It does not start a new freshness window or background polling. Subsequent
requests retain the existing retry-after-failure behaviour. The next successful
retrieval clears stale status and atomically replaces the saved snapshot.

Missing, corrupt, unsupported-version or structurally invalid files are cache misses.
A cache miss with live failure follows the existing unavailable-state behaviour.
There is no age-based expiry: this is explicitly last-known data, potentially old,
not proof of current vehicle status. It contains vehicle identifiers and preferences,
so retain the private filesystem permissions.

This file belongs to the current single-site/account prototype. If changing the
configured Kraken account, remove its cache first. It is not a multi-tenant store;
replace the adapter with storage keyed by site/account before SaaS deployment.
Ephemeral/read-only hosting will not provide durable restart recovery, but live data
will still work. Successful writes require a writable, persistent working directory.

Tests use temporary directories and mocked Kraken calls, never the real cache or
live services: `node --test tests/*.test.mjs`.

## Stage 2D2B1: dispatch completeness

The unchanged dispatch query now has a typed response boundary:
`getKrakenPlannedDispatchResponse(deviceId)` returns the requested device identity
and either `complete` (including `explicitlyEmpty`), `incomplete` with a specific
missing/null/malformed code, or `failed` with a sanitized retrieval-failure code.
All records must have valid explicit-offset calendar timestamps, a positive
half-open interval, non-empty type and nullable decimal-string planned energy.
Original timestamp spelling, dispatch types and energy precision/sign are retained.
No rate, cancellation event, supplier eligibility or revision authority is inferred.
Authentication, transport and GraphQL errors fail the read; there is no retry or
additional query. Required field accessors/sparse arrays cannot masquerade as data.

The existing `getKrakenPlannedDispatches` is explicitly a compatibility projection:
it returns an array ONLY for complete responses and throws for all other outcomes.
It no longer converts null/missing to `[]`. `KrakenState` remains the same consumer
shape. Its existing all-or-nothing refresh means one vehicle's incomplete read
retains the entire prior snapshot as stale, including other vehicles. With no prior
snapshot it is unavailable. A successful explicit empty list replaces that vehicle's
old list but establishes only supplied absence, not cancellation. The Stage 2D1
UI remains conservatively worded; no presentation changes are included.

The cache envelope is now version 2, with the same location, permissions, atomic
replacement and recovery policy. Both reading and writing validate every dispatch.
Version 1 is deliberately a cache miss: it may contain empty arrays produced by
the old ambiguous fallback, so cannot be upgraded as complete evidence. On the
first post-upgrade restart with Kraken unavailable there may therefore be no
recoverable snapshot until a complete live retrieval succeeds. No migration or
cache modification is performed by implementation/testing.

A future Stage 2D2A caller can use the typed result before compatibility projection,
but must still supply complete device enumeration, read-start/retrieval timestamps
and trusted provenance. This stage does not create observations, persist comparisons,
add a scheduler or modify `smartEvidenceKey`/Tesla execution. Existing supervised
reads now fail their existing read boundary on incomplete dispatch responses,
rather than accepting those responses as an empty schedule.

Array completeness uses the captured own `length` data descriptor and own element
keys/descriptors, never an ordinary `array.length` read. Detectable inconsistencies,
sparse/accessor elements and extra array properties fail closed. Accepted output
is reconstructed from validated primitive fields without modifying caller data.
This is not comprehensive Proxy detection: JavaScript reflection can itself be
intercepted, and a Proxy can present a mutually consistent false view of mutable
properties. The production boundary consumes parsed network JSON, not arbitrary
hostile executable objects; descriptor checks do not establish authenticity.
