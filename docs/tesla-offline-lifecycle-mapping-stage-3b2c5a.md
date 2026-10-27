# Stage 3B2-C5a: offline lifecycle identity mapping

This increment maps one closed C1–C4 first-apply rehearsal into documentary lifecycle and persistence representations. It does not persist ownership or authenticate Tesla/Kraken evidence.

## Versioned identities

The application mapping retains its F1 version 2 envelope and hashes. Its receipt reference is explicitly version 1, namespace `offline-simulated-operation`, receiptVersion 1. It contains operation/mutation IDs, the exact C3 receipt and issuance keys, a private simulated-admission reference and a distinct simulated-completion reference. These are documentary identifiers, not exported capabilities.

Journal initial/completion IDs and confirmed-operation evidence ID remain separate from those simulation references. The immutable retained original and origin identity remain unchanged. A proposed ownership-history digest is domain-labelled `offline-proposed-ownership-history-v1`; it does not claim committed SQLite history. The proposed persistence envelope is version 1, kind `offline-v2-ownership-persistence`. No runtime-confirmed receipt reference is fabricated.

## Validation and isolation

The existing lifecycle and persistence algorithms share private structural validation functions. Public application entry points always select production validation. The offline lifecycle entry point is unexported, has no application caller, accepts only first apply with no predecessor, and retains all false authority flags. Test VM source instrumentation exposes that private path only inside the test realm, as with the existing private SQLite primitive tests.

The offline persistence test path requires a separate complete identity context linked to the supplied journal evidence and contexts. It does not use the candidate record itself as the source of expected receipt identities. Cross-role alias and rehashed substitution checks cover the additional admission/completion identities, as well as receipt/issuance references. Production lifecycle validation rejects offline namespace references; production persistence validation rejects the offline envelope, including when its outer kind alone is relabelled.

`closedOfflineV2().mapLifecycle()` accepts no arguments. It consumes C4's exact private C3 receipt once, rechecks durable journal completion, maps and validates the documents, and confirms production rejection. Copies, caller documents, restart recovery and concurrent/repeated calls cannot enter private mapping. The result is frozen. Existing preparation, fixed-export and BUY_BELOW_SELL gates are retained.

## Limitations

Pure validation of JSON copies establishes documentary consistency only. It does not establish live membership or mint admission, execution, completion, commit, successor or restoration authority. Independent identity context supplied directly to the instrumented pure test validator is still test evidence, not authentication.

No SQLite ownership writes, new writer, production adapter, receipt issuer or finaliser is added. Atomic offline persistence and SQLite reopen verification remain subsequent work; production V3 commit integration remains blocked on its trusted runtime boundaries. Update and restore are excluded from the offline path. September evidence and V1 behaviour are unchanged.

## Astra isolation correction

There is no independently trusted runtime receipt-identity source at the F4a reader. Candidate fields and content hashes cannot supply one. The production persistence validator therefore returns `consistent-only` for structurally consistent records, with `identityProvenance: unverified` and all authority flags false. SQLite recovery returns `consistent-storage`, never `verified-storage`. This preserves schema/history/journal consistency inspection without claiming production identity validation. The private offline path still requires its separate complete identity context.

A regression performs Astra's combined attack: remove simulation admission/completion keys, relabel namespace and receipt version, relabel the persistence kind, and recompute application/lifecycle/persistence hashes. It seeds real temporary SQLite alongside unchanged offline V2 journals, closes/reopens recovery twice, and verifies that only unverified consistency can result. The original independent offline identity context rejects the substitution; neither consistency nor recovered documents can mint a runtime completion or receipt. Successful production provenance verification remains unavailable pending an independently trusted runtime boundary; this increment adds no such authority or callback.
