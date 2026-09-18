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
