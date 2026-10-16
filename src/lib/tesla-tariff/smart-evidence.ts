import type { KrakenState } from "../site/kraken-state";
import { representationKey } from "./rollback-evidence";

export const CAPTURE_TTL_MS = 120_000;
export const EVIDENCE_TTL_MS = 60_000;
export const APPROVAL_TTL_MS = 60_000;
export const MIN_WRITE_REMAINING_MS = 30_000;

/** Compare actual SMART data independently of freshness timestamps. Includes
 * original boundaries, vehicle identity, type and energy; BOOST is not a price event.
 */
export function smartEvidenceKey(state: KrakenState) {
    return representationKey(state.vehicles.map(v => ({ id: v.id, name: v.name,
        dispatches: v.plannedDispatches.filter(d => d.type === "SMART").map(d => ({ start: d.start, end: d.end,
            type: d.type, energyAddedKwh: d.energyAddedKwh })).sort((a, b) => representationKey(a).localeCompare(representationKey(b)))
    })).sort((a, b) => a.id.localeCompare(b.id)));
}
