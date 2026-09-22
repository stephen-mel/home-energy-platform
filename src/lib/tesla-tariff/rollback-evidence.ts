/** Canonical representation identity, not a cryptographic trust credential. */
export function representationKey(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(representationKey).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${representationKey((value as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(value);
}
export type TrustedRollbackObservation = {
    id: string; energySiteId: string; representationKey: string; observedAt: string; validUntil: string;
    basis: "verified-write-read-back" | "authoritative-setting-capture";
};
/** trustedObservations must come from a future authenticated server evidence ledger,
 * NEVER from a submitted experiment/approval record. No such ledger is wired in v1.
 * Candidate shape or caller provenance labels alone establish no trust.
 */
export function assessRollbackEvidence(input: {
    observationId?: string; energySiteId: string; representation: unknown; now: string;
    maxAgeMs: number;
}, trustedObservations: readonly TrustedRollbackObservation[] = []) {
    const matches = trustedObservations.filter(o => o.id === input.observationId);
    const observation = matches.length === 1 ? matches[0] : undefined;
    const now = Date.parse(input.now);
    const proven = !!observation && Number.isFinite(now) && Number.isFinite(input.maxAgeMs) && input.maxAgeMs >= 0
        && input.representation !== null && input.representation !== undefined
        && ["verified-write-read-back", "authoritative-setting-capture"].includes(observation.basis)
        && observation.energySiteId === input.energySiteId && observation.representationKey === representationKey(input.representation)
        && Date.parse(observation.observedAt) <= now && now < Date.parse(observation.validUntil)
        && now - Date.parse(observation.observedAt) <= input.maxAgeMs;
    return { proven, blockers: proven ? [] : ["ROLLBACK_UNPROVEN"] };
}
