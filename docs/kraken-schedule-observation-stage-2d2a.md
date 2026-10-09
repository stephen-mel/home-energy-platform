# Stage 2D2A — pure schedule observations; integration boundary

## Implemented

`updateScheduleObservation(previous, read)` is a pure, local comparison interface.
It has no production caller, clock, network, persistence, scheduler or Tesla
capability. `previous` must be a validated observation returned by this layer.
This is not a deserializer or durable-state validator.

A future trusted read adapter must supply an explicit account/site scope, complete
vehicle enumeration, read-start and completion timestamps, authenticated-query
provenance and the original dispatch arrays. The provenance field records a
caller assertion; it is not proof of authentication or economic authority.
Manual and disk observations cannot become newly authenticated observations.
Legacy `KrakenState` cannot be passed directly: it already lost missing/null versus
explicit-empty semantics, and does not retain a read-start timestamp.

Missing/null dispatch arrays, failed/incomplete reads and malformed dates/data
return `unknown`, retaining a detached last-known observation with its original
retrieval timestamp. An explicit empty array can establish that no sessions were
supplied in a complete observation. This is never a cancellation event.

Content identity is a deterministic JSON tuple of scope, ordered vehicle IDs and
ordered session tuples (absolute start/end, type, exact supplied energy string).
Original timestamp strings and names remain available. Offset spelling, response
order, names and retrieval timestamps do not create revisions. Energy spelling
and precision are preserved: even `2.30` versus `2.300` is a structural difference,
not a coverage change. The key is a content comparison, not a supplier revision ID
or a cryptographic authority proof. Duplicate exact rows/vehicle IDs reject rather
than being silently deduplicated. Inputs are limited to 100 vehicles and 1,000
sessions per vehicle; output is detached, deeply frozen plain data.

Before reading input fields, a descriptor-based snapshot rejects accessors,
unsupported prototypes/built-ins, cycles, sparse arrays and non-data values.
Validation and construction use that detached snapshot, so emitted timestamp
strings, absolute instants and content identity refer to the same values. Caller
objects are never frozen, including mutable built-ins in rejected input. Prior
layer output is also detached before being included in revision results.

Changes contain exact added/removed rows and vehicle IDs. Shortening, extension,
type/energy changes and apparent reassignment are represented as removals and
additions; there is no dispatch ID with which to prove continuity or reassignment.
Coverage is a separate union per vehicle and dispatch type. Adjacent/overlapping
and split/combined sessions may change structure without changing coverage.
No period is rounded, clipped to now, or shortened by physical charging data.
No elapsed interval is described as cancelled, and no coverage implies a tariff.

Consecutive reads must have the same scope and the next read must start strictly
after the prior completed retrieval. Overlap/out-of-order input returns unknown
without replacing the prior snapshot. Repeated successful equal content updates
retrieval metadata and reports unchanged. This is conservative pure ordering,
NOT cross-process synchronization or atomic persistence. It does not alter
`smartEvidenceKey` or any execution safety binding.

## Infrastructure boundary — not implemented

The existing JSON cache retains only one vehicle snapshot with no observation
history, response completeness or cross-process CAS. Adding a durable revision
ledger and coordinated refresh would change its schema/coordination contract.
No second store, schema migration, history retention policy, recovery or write
path has been introduced. Restart recovery and competing persistence writers
therefore remain outside this stage, rather than being claimed as supported.

Existing queries expose device/status/dispatch data only. They do not request
`smarter-tariff-optimisation-created` events. No supported event subscription,
server scheduler or permanent worker was found. The reported 9 October event
times establish neither changed content nor API publication latency.

Before production integration, approve:

1. A typed completeness-preserving boundary before `flexPlannedDispatches ?? []`,
   with complete device enumeration and read-start metadata. Existing client and
   all its dashboard/executor callers remain unchanged here.
2. Extension of the existing local snapshot store, including atomic overlap/CAS
   handling and bounded retention, rather than a parallel persistence system.
3. An explicitly chosen unattended runner/deployment; Next.js request handling
   alone is not a scheduler. No Vercel Cron, external scheduler, credentials,
   endpoint or dependency was added.

Proposed runner policy, not activated: post-hour observation around HH:01; at most
one confirmation around HH:03 when publication remains uncertain. Neither is a
publication guarantee. With no event feed, consider a 15-minute fallback cadence
between hourly checks, subject to supplier limits and approval. Coalesce overlapping
triggers and do not turn failures into rapid retries. A newly read snapshot before
any future Tesla execution is still mandatory under the unchanged safety chain.

No UI changes: Stage 2D1 remains the existing supplied-state display. A future
adapter can supply observation/revision diagnostics there after the completeness,
storage and runner decisions, without changing tariff consumers or authority.

## Validation

Focused tests cover additions/removals, shortening/extension, type/energy changes,
vehicle identity changes, explicit empty versus incomplete reads, offset/order
normalisation, DST, split/overlap coverage, partial intervals, charging independence,
conservative overlap rejection, deterministic keys and detached immutable results.
Module loading is allowlisted with no network or persistence dependencies. Existing
planned-session, Kraken cache and price-signal tests are run alongside these tests.
