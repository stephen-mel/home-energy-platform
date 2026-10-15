# Read-only Tesla baseline assessment

`baseline-assessment.ts` is a pure inspection boundary. It accepts an already
captured authenticated Tesla `site_info` tariff observation, retained experiment
journal records and a read-only ownership result. It performs no authentication,
filesystem access, database access, journal mutation or Tesla request.

The caller must also supply an explicit assessment time, maximum observation age,
configured site and configured timezone. Times use the existing strict timestamp
validator. The assessment never reads the machine clock. A future, stale, malformed,
wrong-site or wrong-timezone capture cannot be called current. A complete stale
capture remains distinguishable as an authenticated historical observation, but is
not compared as the verified current baseline.

The assessment exposes the exact captured buy/sell tariff representation and a
fingerprint, bound to the configured energy-site ID, timestamp and timezone. It
compares that representation with both the pre-write September baseline and the
approved temporary representation using the existing observed read-back comparison.
An exact current match is evidence about current state only. It does not prove an
API restoration was accepted, identify the actor that restored it, or convert the
September outcome into proven rollback.

The retained September journal uses the older two-record format without linked
record identities. Its baseline, proposal and stored `write-outcome-unknown`
classification may be reported as `legacy-unlinked` historical evidence, but it
cannot grant authority, close the attempt or release the latch. New linked records
receive the existing full linked-record validation.

At the assessment boundary, both legacy and linked records independently require
every supplied post-write readback to satisfy `attemptedAt < observedAt <=
completedAt`, including comparisons classified as insufficient evidence. A missing
readback remains insufficient evidence and gains no write, rollback or restoration
authority.

Legacy evidence is internally reclassified using the retained API outcome and the
existing immediate-readback comparison rules. The stored comparison and stored
classification must exactly match that recomputation. Wrong-site, malformed,
chronologically impossible or contradictory readback evidence makes the historical
pair invalid rather than promoting it.

Ownership is reported independently as missing, valid empty/non-empty, invalid or
unavailable. Missing or empty ownership does not erase the September restoration
obligation. Invalid, unavailable or non-empty ownership additionally blocks safe
closure.

The next recovery step is a separately authorised read-only capture using the
existing authenticated `getSiteTeslaObservation` boundary, followed by this pure
assessment against an immutable copy of the September records and ownership read.
That review may establish the current representation. Any recovery closure policy,
journal evidence append, ownership retirement or repeat-attempt eligibility remains
a separate design and approval task.
