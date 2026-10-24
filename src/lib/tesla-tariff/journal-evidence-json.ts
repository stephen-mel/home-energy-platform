// Validate before cloning/canonicalisation: JSON.stringify otherwise maps NaN to
// null and drops unsupported values. Cross-realm plain objects remain supported.
export function validJournalEvidenceJson(value: unknown, ancestors = new Set<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value) && (!proto || Function.prototype.toString.call(proto.constructor) !== Function.prototype.toString.call(Array))) return false;
    if (!Array.isArray(value) && proto !== null && !(Object.getPrototypeOf(proto) === null
        && Object.getOwnPropertyDescriptor(proto, "constructor")?.value
        && Function.prototype.toString.call(proto.constructor) === Function.prototype.toString.call(Object))) return false;
    const own = Reflect.ownKeys(value);
    if (Array.isArray(value) && (own.length !== value.length + 1
        || Array.from({ length: value.length }, (_, i) => String(i)).some(k => !Object.hasOwn(value, k)))) return false;
    ancestors.add(value);
    const valid = own.every(k => {
        if (Array.isArray(value) && k === "length") return true;
        const d = Object.getOwnPropertyDescriptor(value, k)!;
        return typeof k === "string" && d.enumerable && "value" in d && validJournalEvidenceJson(d.value, ancestors);
    });
    ancestors.delete(value);
    return valid;
}
