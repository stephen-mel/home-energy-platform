# Tesla access-token refresh for reads

The existing callback stores `.tesla-tokens.json` with `access_token`,
`refresh_token`, `expires_in` (seconds) and `created_at` (milliseconds). Previously
the read client did not use the expiry metadata. OAuth state, scopes and the
supervised experiment executor remain unchanged. The callback now commits through
the same serialized atomic credential writer as refresh.

`getTeslaProducts` and `getTeslaSiteInfo` now share a private GET-only transport.
With finite expiry metadata, they refresh at expiry minus **60 seconds**. This
small margin accommodates clock/transport delay without materially shortening an
8-hour token lifetime. Unknown expiry is not invented: a stored access token can
be tried once, subject to bounded authentication recovery.

The documented [Tesla refresh contract](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)
uses `POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` with
form-encoded `grant_type=refresh_token`, `client_id` and `refresh_token`. No scopes,
client secret, audience or command payload are added to this refresh request.
The existing callback's code-exchange endpoint is not migrated in this task.

A successful refresh is validated and saved before the Fleet read proceeds.
Only the access token, replacement refresh token, expiry metadata and a local
credential-generation identifier are persisted. Every successful refresh response
must include a non-empty replacement `refresh_token`. Missing, null, empty or
malformed replacements fail closed without changing the stored credentials. HEP
does not combine a new access token with the old refresh token or infer any reuse
period from Tesla's recovery allowance.

On a **401 only**, an unrefreshed read may refresh once and retry its GET once.
A generic 403 causes no recovery refresh or retry; its body is not interpreted.
A proactively refreshed read cannot refresh again on rejection. A rejected retry
stops. Other HTTP errors and timeouts are never retried. Unread rejected bodies
are aborted, including authentication failures before a retry. Errors contain
only fixed diagnostics or HTTP status; no upstream bodies or token material are
logged. Existing dashboard unavailable/indeterminate handling remains unchanged.

## Deadlines, concurrency and storage

The **5-second total read deadline** includes token loading, waiting for a refresh,
GET retry and body consumption. It is never reset by a retry. Refresh itself has
a separate bounded 5-second operation; concurrent reads share its promise. A
caller timing out cannot start a late GET. Another caller can still benefit from
a shared refresh that completes within its own deadline; refresh may persist its
result after an earlier caller has timed out. No periodic/background refresh is
scheduled.

The token file is reread before exchange so late rejection of a superseded token
can reuse an already-refreshed token. Refresh and OAuth reconnect both use
`commitTeslaTokens`, with one process-global commit queue (also shared across separate server module
instances). Each committed record
receives a new generation ID. Inside the queue, immediately before rename, a
refresh compares the current record with the generation/credentials it used for
the exchange; if reconnect has replaced that record, refresh returns the current
record without overwriting it. Legacy records without a generation are compared
using their token and expiry fields. Reconnect publishes a new authoritative
generation through the same queue.

The queue tracks the actual write/check/rename/cleanup promise, never the caller's
timeout race. If a rename remains pending after a dashboard timeout, later commits
stay queued until it settles. A queued reconnect then commits after the earlier
operation, making the reconnect generation authoritative. The aborted refresh
cannot initiate a late Fleet GET. Refresh cannot overwrite a reconnect already
committed before it reaches its in-queue generation check.

New records are written to a unique adjacent file with mode 0600 and exclusive
creation, then atomically renamed. Temporary credential files are Git-ignored and
cleaned up before the queue advances. Failure before successful replacement leaves
the previous credential file intact and does not proceed to a Fleet read using
unpersisted credentials.

This remains process-local coordination, not a distributed lock. Multi-worker
processes or external writers require coordinated token storage/locking before
use. A crash, lost OAuth response or storage failure during rotation can still
require reconnection. Live refresh has not been tested against Tesla in this task;
all authentication and filesystem interleaving tests use controlled mocks.

Existing UI copy is intentionally unchanged as requested. Its authentication
failure detail still says that the dashboard does not refresh the token; that
legacy wording needs a separately authorised presentation correction. No safety
blockers, execution authority, reconciliation rules or evidence TTLs are changed.
