import path from "node:path";
import type { ManagedImportEvidence } from "./ownership-evidence";
export type OwnershipSnapshot = { version: 2; generation: string; evidence: ManagedImportEvidence; checksum: string; historyDigest: string };
export type OwnershipRead = { status: "available"; snapshot: OwnershipSnapshot }
    | { status: "missing" } | { status: "invalid" | "unavailable"; code?: string };

/** Read-only local facade. No production write API exists at this stage.
 * Lazy loading keeps the local SQLite runtime requirement out of type consumers. */
export function ownershipStore(directory = path.join(process.cwd(), ".cache/home-energy-platform/tesla-smart-ownership")) {
    return { async read(site: string): Promise<OwnershipRead> {
        const { readOwnership } = await import("./ownership-sqlite");
        return readOwnership(path.join(directory, "ownership.sqlite"), site);
    } };
}
