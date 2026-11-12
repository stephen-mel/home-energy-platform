# Trusted ownership store

HEP's ownership database is private storage for one Home Assistant Green
installation. Remote access is through a private VPN; the application is not
directly exposed to the public internet.

The deployment contract is:

- one HEP process is the only ownership writer;
- the canonical database directory is owned by that process user with mode
  `0700`, and the regular database file is owned by the same user with mode
  `0600` and one hard link;
- the process uses umask `0077` when creating private storage;
- SQLite remains in `DELETE` journal mode with the existing `EXTRA`
  synchronous, foreign-key and zero busy-timeout settings;
- WAL/SHM storage is unsupported;
- an active database is never copied, renamed, replaced or restored in place;
- HEP is stopped before database restore or migration; and
- a hot rollback journal is preserved for SQLite recovery, not deleted by
  backup or deployment tooling.

Unexpected ownership, permissions, canonical paths, schema or journal mode
fail closed. Path, device and inode checks detect configuration errors and
accidental replacement. They are not claimed to resist a hostile process with
equivalent filesystem privileges; that actor is outside this personal
deployment's threat model.

Transactional retirement remains private and capability-bound. It does not
release a site claim, close an operation, admit a successor or grant Tesla
execution authority.
