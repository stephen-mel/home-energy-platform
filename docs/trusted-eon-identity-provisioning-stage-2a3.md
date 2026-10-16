# Trusted E.ON identity provisioning — Stage 2A.3

HEP uses the existing opaque-reference algorithms without modification:

- account: SHA-256 of `eon-account`, a zero byte, and the exact account identifier;
- meter point: SHA-256 of `eon-meter-point`, a zero byte, and the exact MPAN.

The operational `.env.local` remains ignored and untracked. It is not a trusted
identity store. Provisioning is an explicit operator ceremony: the implementation
accepts one operational capture and a separately entered set of identifiers checked
against the supplier CRM. All four values must match exactly before HEP creates a
record. The stored record contains only opaque references, the site, timestamp and
confirmation method. It is written once with mode 0600 into an existing,
operator-controlled local directory; replacement is refused. Temporary cleanup is
ownership-aware: an invocation removes a temporary path only after its own exclusive
create succeeded, so a pre-existing or concurrent file is never deleted.

Account identifiers must be exact, unpadded alphanumeric components separated by
single hyphens. This is the narrow syntax evidenced by the current Kraken client
fixtures and GraphQL string usage; the repository contains no authoritative E.ON
prefix or length specification, so provisioning does not claim to validate a
supplier-specific prefix. MPANs must be exactly 13 decimal digits. The checksum
multiplies the first 12 digits by `3, 5, 7, 13, 17, 19, 23, 29, 31, 37, 41, 43`;
the final digit must equal the weighted sum modulo 11, then modulo 10. This is the
published UK MPAN-core calculation described by
[Validating MPAN Numbers](https://www.amcrou.ch/validating-mpan-numbers). No
trimming or normalisation occurs, and leading zeros are preserved.

This stage deliberately does not load the record during application startup and does
not modify `currentSite`. A future activation step must name the provision file
explicitly, validate it with `readTrustedEonIdentityProvision`, and pass its references
only through the server-side authenticated acquisition/assessment boundary. Runtime
changes to `EON_ACCOUNT` or `EON_EXPORT_ACCOUNT` do not rewrite the record. A future
account merger therefore blocks until the operator independently verifies and
re-provisions the new identities.

The current authenticated import query returns an MPAN and converts it at the client
boundary into `eon-meter-point` evidence. The export query requests only
`meterPoint { direction }`; `KrakenExportTariffEvidence` consequently has no
`meterPointRef`. The independently provisioned export MPAN is an expectation, not
proof about the authenticated agreement. Trusted positive matching must remain
blocked with `TRUSTED_EON_EXPORT_METER_POINT_EVIDENCE_UNAVAILABLE`.

The smallest next evidence-acquisition step requires separate read-only approval:
extend the existing export agreement query to request `meterPoint { mpan direction }`,
hash the returned MPAN inside the Kraken client with the existing
`eon-meter-point\0` domain, and require the export validator to bind that reference to
the provisioned export identity. No query or production activation is performed in
this stage.

Deployment requires a deliberately approved private root outside every Git repository
and worktree. The root and every descendant directory leading to the record must be
owned by the current operating-system user and have mode 0700. HEP verifies these
conditions on every read and write and fails closed when ownership cannot be checked;
it never repairs insecure permissions. The operator places a current-user-owned,
mode-0600 marker named `.hep-trusted-eon-identity-root` containing exactly
`HEP_TRUSTED_EON_IDENTITY_ROOT_V1` followed by a newline. Both reads and writes require
the root and record path explicitly, reject non-canonical or symlinked parents, verify
physical containment, and reject any `.git` directory or worktree file found from the
record parent to the filesystem root. Stored records must also remain owned by the
current user with mode 0600. `.gitignore` is not a storage control. Malformed JSON
returns a fixed content-free diagnostic.

The filesystem remains an operator-controlled trust boundary. The checks do not claim
protection against a privileged actor able to substitute path components concurrently
or rewrite the private root. A production provisioning record is not created or loaded
by this stage.

This boundary grants no Tesla authority. It does not resolve September, validate the
fixed export price as identity evidence, or prove export meter-point ownership. All
write, rollback, restoration, historical-resolution and repeat-attempt authority
remains false.
