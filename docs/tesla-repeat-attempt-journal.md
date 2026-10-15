# Durable supervised Tesla attempt succession

`repeat-attempt-journal.ts` is an isolated, server-only persistence boundary for
future supervised attempts. It is not connected to the executor or dashboard and
cannot perform a Tesla request, mint an approval, restore a tariff or make a
proposal write-ready.

The original `site-<site>.jsonl` experiment journal remains the immutable root of
the site's history. It is never renamed, reset, deleted or rewritten. A successor
uses a distinct immutable `site-<site>-attempt-<mutation>.jsonl` journal and a
completion marker binding the site, mutation, consumed approval, Stage A ownership
capture, initial record, classified record and predecessor attempt. Checksums
detect accidental or partial alteration; they do not authenticate an attacker who
can consistently rewrite the local filesystem.

An exclusive `site-<site>-attempt.active` file is created atomically before the
new initial journal. It prevents concurrent claims across local processes. Durable
completion appends the classified record, syncs it, then atomically renames the
active marker to the attempt's immutable completion marker. Any crash before that
rename leaves the active marker in place and blocks all later claims. There is no
automatic recovery, deletion or unlock path.

Claim durability follows explicit filesystem ordering. A claim requires an
absolute, pre-existing durable root supplied by its future trusted caller. The
module never creates that root, and rejects journal paths outside it. The root's
own directory entry and storage mount are therefore deployment preconditions.
The root must be supplied by its canonical absolute physical path. The root and
every existing or newly created journal-path component are inspected without
following the final component and rejected if they are symbolic links or are not
directories; their resolved physical paths must remain canonical and contained.
Every claimant first verifies that the root can be opened and `fsync`ed, creates
only descendant directories, then independently `fsync`s every parent from the
journal directory back through the root. This applies when any level reports
`EEXIST`; no claimant relies on the process that created an ancestor to complete
its flush. The physical chain is checked again after creation, after directory
syncing and immediately before claim artifacts are opened. Active-marker contents and
initial-journal contents are each written and `fsync`ed, both handles are closed,
and the containing directory is `fsync`ed before claim success returns. Any
failure in that sequence is an error. Once claim artifacts may exist, an uncertain
sync is never retried, removed or released automatically, so a restart continues
to block the site. Completion similarly syncs the classified journal and marker
before rename, then syncs the containing directory.

These guarantees assume the local filesystem and operating system honour file and
directory `fsync` plus atomic same-directory rename. Network filesystems, storage
that lies about durable flushes, arbitrary filesystem writers and loss of the
underlying volume remain outside this boundary. The Home Assistant hardware proof
established local rollback-journal recovery, but did not certify every host
filesystem or power-loss mode for these JSON journals.

Node's path-based filesystem API does not expose the directory-handle-relative
`openat` operations needed to exclude an attacker swapping a checked component
between the last check and a later pathname operation. The durable root and its
descendants must therefore be owner-only and unavailable to arbitrary concurrent
renames or symlink creation. Normal cooperating claimants may concurrently create
directories; detectable substitutions fail closed. Deployments unable to enforce
that ownership boundary must not enable this journal.

Every retained journal must contain exactly one valid linked initial record and
one valid linked classified record. Completion markers must form one unambiguous
predecessor chain. Missing records, forks, disconnected markers, duplicate
mutation identities (including collision with the legacy root), incomplete
attempts and invalid ownership fail closed.

Succession is intentionally narrow. With a missing or valid-empty ownership
snapshot matching the initial record's Stage A capture, no prior attempt is
eligible and a definitively `request-rejected` predecessor is eligible. Unknown,
insufficient-readback, transformed and buy-raised outcomes remain ambiguous.
Confirmed temporary representations remain blocked by `RESTORATION_REQUIRED`;
an empty ledger alone does not turn that write into proven restoration.

The September 2026 journal therefore remains a permanent blocker: its historical
outcome is ambiguous and its supplemental manual recovery report is not trusted
machine restoration evidence. A later stage must design separately approved,
journalled restoration and exact authenticated readback evidence before successful
temporary writes can permit further attempts. This module must not be wired to the
executor until that policy and its authority boundary receive independent review.
