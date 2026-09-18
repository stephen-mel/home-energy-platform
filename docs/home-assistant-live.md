# Live Home Assistant telemetry

The initial dashboard still uses `getHomeAssistantSiteState`. `HomeEnergyTelemetry`
progressively enhances those server-rendered cards using an EventSource connected
to `/api/home-assistant-stream`. This endpoint resolves the current site itself;
clients cannot select an upstream URL, entity set or send HA commands.

The Node server uses HA's WebSocket authentication, `subscribe_events` for
`state_changed`, a read-only `get_states` resync on each connection, and `ping`.
Only configured entity IDs and finite numeric values (or null for unavailable or
removed entities) cross the browser boundary. Attributes, tokens, upstream errors
and other entities are never forwarded. The module is marked `server-only`.
Neither the route nor the browser watcher imports the site-state loader or Kraken,
and neither refreshes the page. Existing Kraken behaviour and controls are unchanged.

A subscription is established before resync; events arriving during resync override
the snapshot. The existing SSR readings remain visible while connecting or offline.
A status line identifies last-known readings when disconnected. A connected stream
does not imply every configured sensor is available or recently changed.

Connection/authentication/resync has a 15-second deadline. HA gets a ping every
20 seconds; a missing pong closes the connection on the following interval. The
browser also has a 50-second stream watchdog. It closes EventSource's native retry
and uses delays of 2, 4, 8, 16, 32, then 60 seconds, plus up to 1 second of jitter.
Retries continue at the capped rate while the component is mounted. Backoff resets
only after a minute of healthy streaming. Missing credentials, invalid authentication
or rejected subscriptions stop automatic retries until remount/reload. Closing the
tab/unmounting cancels timers and the upstream socket. Slow consumers are disconnected
rather than accumulating an unbounded stream queue.

## Deployment and real-home checks

- Use a Node runtime with native WebSocket support (Node 22.4+ recommended). A runtime
  without it safely leaves the SSR snapshot visible, but cannot stream.
- Each viewing tab owns one upstream connection. This intentionally avoids a global
  singleton and cross-site state, but is intended for the existing small dashboard;
  a larger deployment should share subscriptions with authenticated site isolation.
- Hosting and reverse proxies must support long-lived streaming responses and disable
  buffering. Function duration limits may cause reconnects. `X-Accel-Buffering: no`
  and `Cache-Control: no-store, no-transform` are sent.
- The app currently has no user authentication layer. This read-only endpoint has the
  dashboard's existing access boundary, checks Origin/Fetch Metadata and enables no
  cross-origin access. Those checks are not user authentication. Keep the dashboard
  on a trusted network or behind authenticated access; apply that same access control
  to this endpoint before exposing it publicly.
- Check a configured sensor change, HA restart, unavailable sensor, and browser network
  interruption at home. The HA card should recover without any Kraken request or page
  refresh. Do not operate vehicle controls as part of this read-only check.

Local regression tests use fake WebSockets, EventSources and clocks; they do not
contact Home Assistant, Kraken or Tesla. Run `node --test tests/*.test.mjs`,
`npx tsc --noEmit`, `npm run lint`, and `npm run build`.
