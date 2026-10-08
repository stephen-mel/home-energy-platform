import type { SourcePrice } from "./economic-model";

// Bounded exact base-ten arithmetic. BigInt constructors support the project's
// existing TS target; no binary multiplication and no monetary rounding.
export function decimalParts(value: unknown): { coefficient: bigint; scale: number } | null {
    if (typeof value !== "string" || value.length > 40 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
    const scale = value.split(".")[1]?.length ?? 0;
    return scale <= 18 ? { coefficient: BigInt(value.replace(".", "")), scale } : null;
}
function format(coefficient: bigint, scale: number): string {
    const sign = coefficient < BigInt(0) ? "-" : "";
    let digits = (coefficient < BigInt(0) ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
    if (scale) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
    return coefficient === BigInt(0) ? "0" : sign + digits;
}
export function deriveConsumerAmount(price: SourcePrice, taxFraction?: string): string | null {
    const value = decimalParts(price.amount);
    if (!value || !/^[A-Z]{3}$/.test(price.currency) || !["kWh", "day"].includes(price.unit)) return null;
    if (price.basis === "tax-inclusive" || price.basis === "observed-external") return format(value.coefficient, value.scale);
    if (price.basis !== "tax-exclusive") return null;
    const tax = decimalParts(taxFraction);
    if (!tax || tax.coefficient < BigInt(0)) return null;
    return format(value.coefficient * (BigInt(10) ** BigInt(tax.scale) + tax.coefficient), value.scale + tax.scale);
}
