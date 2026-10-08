import { getSitePriceSignal } from "../site/get-site-price-signal";
import type { Site } from "../site/types";
import type { KrakenState } from "../site/kraken-state";

/** Explicit legacy boundary: historical numeric prices are already consumer
 * economics. Never reverse-engineer tax or reinterpret old observations. Uses
 * the existing pure resolver, preserving exact sources, conditions and keys.
 * Not wired into production; callers can migrate configuration independently.
 */
export function resolveLegacySiteEconomics(site: Site, kraken: KrakenState | null, now: string) {
    return getSitePriceSignal(site, kraken, now);
}
