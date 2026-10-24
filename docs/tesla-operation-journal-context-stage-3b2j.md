# Stage 3B2-J: offline trusted journal/context integration

This increment adds V2 operation preparation and documentary journal admission to
the existing `prepared-mutation-context`, linked-record and repeat-attempt journal
modules. It has no executor, provider client, runtime receipt issuer, successor
claim or ownership writer. All returned authority/proof flags remain false.

## Preparation and trusted provenance

`prepareOperationMutationContext` receives an operation request and independently
invokes trusted composition ports for ownership, confirmed history, Tesla/Kraken
acquisition, operation approval and an opaque original issuance reference. There
are no default production adapters. The offline tests supply fixture ports; they
do not authenticate against Tesla or Kraken. Port functions must be configured by
trusted server code, never constructed from browser JSON.

The V2 context retains the exact Stage 3B2-E initial record and independent capture
metadata. The initial observation ID hashes the complete acquisition bundle,
including both source observation IDs, Kraken content and the opaque original
issuance reference, so the existing intent
approval fingerprint also binds that evidence. No new dispatch or tariff evidence
interpretation is introduced: capture validation reuses Tesla/Kraken inspection
and the Kraken dispatch parser, including validation of BOOST dispatch values.
Ownership and evidence are rechecked after approval and again under exclusive
journal admission. A changed ownership/history anchor, tariff, SMART schedule or
import evidence rejects. Capture, import evidence and approval freshness are
checked; recorded submission must also satisfy Kraken freshness.

`validPreparedOperationContext` is a structural validator, not an authentication
verifier. A raw context, copied object, provenance string or correct hash cannot
be supplied as admission authority. The offline journal API creates preparation
itself by calling the independent ports; it never accepts a submitted prepared
context or completion envelope as proof of acquisition/approval.

The root's issuance reference remains an opaque documentary reference supplied
by a trusted port. Computing a retained-original reference for evidence validation
does not issue a receipt or construct a V3 ownership snapshot.

## Deterministic generation and future CAS contract

`expectedOperationGeneration` hashes a versioned domain, site, operation/mutation
IDs and the entire trusted ownership read, including its history anchor. Its
deterministic UUIDv8 is bound into the initial intent, approval and completion.
Preparation reserves nothing and changes no ownership. The request's expected
ownership fingerprint must match the freshly read precondition.

`operationCommitPreconditionMatches` is a pure predicate. A future trusted SQLite
commit must invoke equivalent checks **inside the existing CAS transaction**:
the actual full precondition must match the approved capture, and the resulting
generation must equal the approved deterministic identity. It must preserve
existing uniqueness, history, baseline and transaction verification. This
increment does not modify SQLite or expose a raw writer. The legacy commit still
allocates its own random generation and must not be used as a V2 commit adapter.

## Versioned records and existing filesystem

The linked-record module exposes the Stage 3B2-E initial/completion validators.
Initial validation needs no invented execution result. Completion requires an
accepted result and exact matching readback. Full-envelope validation retains
the original history/context checks and also invokes both phase validators.
The existing JSON-safety validator is moved unchanged into a shared pure module.

`offlineOperationJournal` explicitly requires offline mode and trusted physical
directory/root configuration. It reuses the existing per-site `.active` marker,
per-mutation `.jsonl` files, `.complete` markers, exclusive creation, physical-path
checks, file/directory sync and close mechanics. Predecessor files are never
overwritten, reopened for appending, reset or removed.

The V2 completion marker retains independent preparation and completion admission
metadata. The writer obtains completion evidence through a read-only fixture port;
there is no command/write transport. It records the Stage 3B2-E pair exactly and
returns documentary evidence after durable completion and reader revalidation.
No completion capability is registered. Calling this offline writer is not a
supervised permission grant and cannot be used by the production executor.

Restart reads only the configured physical server-owned directory. It validates
marker/record checksums, exact admission copies, deterministic generations, every
phase, one complete predecessor chain, immutable original identity and the full
Stage 3B2-E context. It reconstructs historical approval/acquisition context from
those previously admitted metadata copies, never from the submitted pair alone.
This uses the existing local-filesystem trust boundary, not a new cryptographic
authentication ledger: an actor controlling every journal file and the trusted
server configuration is outside its integrity guarantee.

An active marker, missing/truncated file, orphan or duplicate marker, conflicting
history, invalid admission or uncertain result blocks restart. Completion failure
does not reopen the attempt. A final directory-sync error retains/recreates a
consumed marker; storage that cannot retain it requires manual recovery. Readers
do not repair files or retry operations. A read can return validated documentary
history but never freshness, execution, retry or continuation permission.

Legacy V1 journals remain readable as legacy data and cannot become a V2 root.
V2 markers deliberately remain invalid to existing production V1 attempt readers.
The old eligibility, claim and completion-capability behaviour is unchanged.
The historical September report, payload, fixtures and latch semantics are intact.

## Remaining dependencies

Production acquisition/approval adapters and policy-bound trusted operation
creation, runtime receipt issuance, V3 finalisation/CAS integration, version-aware
Stage 3B1 original-journal persistence, successor authority and restoration
retirement remain deferred. An explicit V2 apply root is required; no legacy
ownership/receipt migration is inferred. Fixed-export policy, `BUY_BELOW_SELL` and
all existing execution gates remain unchanged and gain no waiver from preparation
or journal validation.
