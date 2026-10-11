# Stage HA1 — Home Assistant Green hardware evidence

## Purpose and boundary

Stage HA1 used the isolated `hep_ha1_probe_v2` Home Assistant app to test the
specific runtime and storage assumptions needed by HEP's local SQLite stores. The
probe contained no HEP application code, credentials, network integrations or
energy-control capability.

This evidence supports continued work on a Home Assistant deployment, but it is
not proof that the complete HEP application is deployable or production-ready.

## Verified on hardware

The following results were observed on Home Assistant Green running Linux ARM64:

- Node.js `v26.8.2` started successfully.
- With the app manifest configured as `init: true`, Node ran as PID 7 or 8 with
  parent PID 1.
- Built-in `node:sqlite` opened a local database and committed the initial
  transaction successfully.
- The committed database persisted across a manual Home Assistant app restart.
- The explicitly armed test issued `SIGKILL` while an SQLite transaction was
  uncommitted. A hot rollback journal of exactly 18,944 bytes existed immediately
  before termination.
- After a manual app restart, SQLite recovered the hot journal and the probe
  reported `PASS HOT_JOURNAL_RECOVERY`.
- The original committed value remained intact with SHA-256
  `26db0a22b2b5414d6ecdf8ab04c19c7f6544a00c6f17ed756400edc5cbf8643f`.
- The uncommitted interrupted value was absent after recovery.
- Observed runtime memory was approximately 51–52 MiB.
- Observed idle CPU use was approximately 0.08% of one core.

These results verify Node 26.8.2 execution on this ARM64 device, app-private
persistent storage across a manual restart, ordinary SQLite transactions and
rollback-journal recovery after abrupt process termination.

## Probe correction

The original `hep_ha1_probe` version 0.1.0 did not terminate when it attempted to
signal itself. Node was likely container PID 1, although that version did not log
its PID and therefore did not prove the cause directly. Its failure path rolled
back the test transaction, so it did not establish crash recovery.

The separate `hep_ha1_probe_v2` version 0.2.0 enabled `init: true`, logged the
process identity and refused to run the crash phase as PID 1. On the tested Green,
Node ran below the init process and the same intentional `SIGKILL` mechanism
terminated it. The subsequent manual restart completed hot-journal recovery.

## Intended future `/data` approach

A future HEP Home Assistant app should place its local durable state beneath that
app's private persistent `/data` mount. The Tesla SMART ownership database and the
Kraken schedule-observation database should use separate, explicitly configured
paths beneath `/data`; they should not share a database or reuse probe files.
Their existing schema validation, transactions, permissions, rollback-journal
behaviour and fail-closed recovery semantics remain authoritative.

Packaging must inject or select these `/data` paths at the deployment boundary.
It must not treat the repository's current relative `.cache` defaults as durable
Home Assistant storage. Any existing local HEP state requires a separately
designed, reviewed and tested migration; this hardware proof authorises no copy,
conversion or automatic database creation policy.

## Remaining assumptions and exclusions

The following remain unverified:

- building and running the full Next.js HEP application in a Home Assistant app;
- sustained CPU, memory, storage and thermal behaviour under real dashboard load;
- Home Assistant ingress, authentication, upgrades, backup and restore behaviour;
- concurrent HEP processes and both production SQLite stores operating together;
- background scheduling, lifecycle management and long-running stream behaviour;
- Tesla controls or tariff writes, Kraken/E.ON integrations and Home Assistant
  telemetry access;
- migration of any production or prototype database into `/data`;
- recovery from storage exhaustion, filesystem damage, device power loss or app
  upgrade during a transaction.

The measured CPU and memory figures describe only the isolated probe. They must
not be used as resource estimates for the full HEP application.
