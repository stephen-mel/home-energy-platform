import type { ConditionalInterval, EconomicModel, EconomicEvidence, EvidenceClaim, EvidenceRole, SupplyAgreement, Period, ResolvedEconomicPeriod, SourcePrice } from "./economic-model";
import type { PriceSignal, PriceWindow } from "./types";
import { decimalParts, deriveConsumerAmount } from "./economic-decimal";

// Only plain data is admitted: Object.freeze does not immobilize Map/Set/Date
// internals or typed-array storage. Walk iteratively and track identity so shared
// references (and cycles in supplied extra metadata) are safe and visited once.
function visitDataGraph(root: unknown, freeze: boolean): void {
    const seen = new WeakSet<object>(), pending: unknown[] = [root];
    while (pending.length) {
        const value = pending.pop();
        if (value === null || typeof value !== "object") {
            if (typeof value === "function") throw new Error("INVALID_ECONOMIC_MODEL");
            continue;
        }
        if (seen.has(value)) continue;
        seen.add(value);
        const proto = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && !(proto === null ||
            (Object.getPrototypeOf(proto) === null && Object.prototype.toString.call(value) === "[object Object]")))
            throw new Error("INVALID_ECONOMIC_MODEL");
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!("value" in descriptor)) throw new Error("INVALID_ECONOMIC_MODEL");
            pending.push(descriptor.value);
        }
        if (freeze) Object.freeze(value);
    }
}
function freezeResolution(result: EconomicResolution): EconomicResolution {
    visitDataGraph(result, true);
    return result;
}

export function economicInstant(value: unknown): number {
    if (typeof value !== "string") return NaN;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!m) return NaN;
    const [, y, month, day, h, min, s, offset] = m;
    const year = Number(y), mo = Number(month), d = Number(day);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || Number(h) > 23 || Number(min) > 59 || Number(s) > 59
        || (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) return NaN;
    return Date.parse(value);
}
const validPeriod = (p: Period) => p && Number.isFinite(economicInstant(p.start)) && economicInstant(p.end) > economicInstant(p.start);
const contains = (p: Period, a: number, b: number) => economicInstant(p.start) <= a && economicInstant(p.end) >= b;
const minute = (s: string, end = false) => end && s === "24:00" ? 1440
    : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const requireValid = (ok: unknown, code: string) => { if (!ok) throw new Error(code); };

const economicRoles: EvidenceRole[] = ["economic-version", "schedule-definition", "energy-rate", "standing-charge", "tax-treatment", "conditional-rule-definition"];
const rolePolicy: Record<EconomicEvidence["kind"], readonly EvidenceRole[]> = {
    "supplier-agreement": ["agreement-identity", "agreement-validity"],
    "supplier-rates": economicRoles,
    "supplier-bill": ["energy-rate", "standing-charge", "tax-treatment"],
    manual: ["agreement-identity", "agreement-validity", ...economicRoles],
    "authenticated-dispatch": ["conditional-dispatch-occurrence"],
    "tesla-observation": [],
};
const claimFields: Record<EvidenceRole, readonly string[]> = {
    "agreement-identity": [], "agreement-validity": [],
    "economic-version": ["versionId"], "schedule-definition": ["versionId"],
    "energy-rate": ["versionId", "rateId"], "standing-charge": ["versionId", "rateId"],
    "tax-treatment": ["taxId"], "conditional-rule-definition": ["versionId", "ruleId"],
    "conditional-dispatch-occurrence": ["ruleId", "assetId", "dispatchType", "start", "end"],
};
const subjectOf = (a: SupplyAgreement) => ({ agreementId: a.id, supplyRef: a.supplyRef, supplier: a.supplier,
    direction: a.direction, productCode: a.productCode, tariffCode: a.tariffCode });
const subjectMatches = (e: EconomicEvidence, a: SupplyAgreement) => e.subject &&
    Object.entries(subjectOf(a)).every(([key, value]) => e.subject[key as keyof typeof e.subject] === value);
function claimKey(c: EvidenceClaim): string {
    return JSON.stringify([c.role, ...claimFields[c.role].map(key => {
        const value = (c as unknown as Record<string, unknown>)[key];
        return key === "start" || key === "end" ? economicInstant(value) : value;
    })]);
}
function requireClaims(model: EconomicModel, ids: string[], agreement: SupplyAgreement, needs: EvidenceClaim[]) {
    requireValid(ids.length > 0, "EVIDENCE_CLAIM_MISSING");
    const records = ids.map(id => model.evidence.find(e => e.id === id)!);
    for (const e of records) {
        requireValid(subjectMatches(e, agreement), "EVIDENCE_SUBJECT_MISMATCH");
        requireValid(e.claims.some(c => needs.some(n => claimKey(n) === claimKey(c))), "EVIDENCE_TARGET_MISMATCH");
    }
    requireValid(needs.every(n => records.some(e => e.claims.some(c => claimKey(c) === claimKey(n)))), "EVIDENCE_CLAIM_MISSING");
}
const occurrenceClaim = (d: ConditionalInterval): EvidenceClaim => ({ role: "conditional-dispatch-occurrence",
    ruleId: d.ruleId, assetId: d.cause.assetId, dispatchType: d.cause.dispatchType, start: d.start, end: d.end });

function validateEvidenceAuthority(model: EconomicModel, intervals: ConditionalInterval[]) {
    for (const e of model.evidence) {
        const agreement = model.agreements.find(a => a.id === e.subject?.agreementId);
        requireValid(agreement && subjectMatches(e, agreement)
            && Object.keys(e.subject).length === 6, "EVIDENCE_SUBJECT_MISMATCH");
        requireValid(Array.isArray(e.claims) && (e.claims.length > 0 || e.kind === "tesla-observation"), "EVIDENCE_CLAIM_MISSING");
        if (["supplier-agreement", "supplier-rates", "supplier-bill"].includes(e.kind))
            requireValid(e.provider === e.subject.supplier, "EVIDENCE_ATTESTOR_MISMATCH");
        const seen = new Set<string>();
        for (const c of e.claims) {
            requireValid(c && Object.hasOwn(claimFields, c.role) && rolePolicy[e.kind].includes(c.role), "EVIDENCE_ROLE_NOT_PERMITTED");
            const fields = claimFields[c.role];
            requireValid(Object.keys(c).length === fields.length + 1 && Object.keys(c).every(k => k === "role" || fields.includes(k))
                && fields.every(k => nonempty((c as unknown as Record<string, unknown>)[k])), "EVIDENCE_TARGET_MISMATCH");
            const version = "versionId" in c ? model.versions.find(v => v.id === c.versionId && v.agreementId === agreement!.id) : null;
            if ("versionId" in c) requireValid(version, "EVIDENCE_TARGET_MISMATCH");
            if (c.role === "energy-rate" || c.role === "standing-charge")
                requireValid(version!.rates.some(r => r.id === c.rateId && r.price.unit === (c.role === "energy-rate" ? "kWh" : "day")), "EVIDENCE_TARGET_MISMATCH");
            if (c.role === "tax-treatment") requireValid(model.taxes.some(t => t.id === c.taxId), "EVIDENCE_TARGET_MISMATCH");
            if (c.role === "conditional-rule-definition") requireValid(version!.conditionalRules.some(r => r.id === c.ruleId), "EVIDENCE_TARGET_MISMATCH");
            if (c.role === "conditional-dispatch-occurrence") {
                requireValid(validPeriod(c), "EVIDENCE_TARGET_MISMATCH");
                requireValid(model.versions.some(v => v.agreementId === agreement!.id && v.conditionalRules.some(r =>
                    r.id === c.ruleId && r.provider === e.provider && r.dispatchType === c.dispatchType)), "EVIDENCE_ATTESTOR_MISMATCH");
            }
            const key = claimKey(c); requireValid(!seen.has(key), "EVIDENCE_CLAIM_DUPLICATE"); seen.add(key);
        }
    }
    for (const a of model.agreements) requireClaims(model, a.evidenceIds, a, [{ role: "agreement-identity" }, { role: "agreement-validity" }]);
    for (const v of model.versions) {
        const a = model.agreements.find(a => a.id === v.agreementId)!;
        requireClaims(model, v.evidenceIds, a, [{ role: "economic-version", versionId: v.id }, { role: "schedule-definition", versionId: v.id }]);
        for (const r of v.rates) requireClaims(model, r.evidenceIds, a, [{ role: r.price.unit === "day" ? "standing-charge" : "energy-rate", versionId: v.id, rateId: r.id }]);
        for (const r of v.conditionalRules) requireClaims(model, r.evidenceIds, a, [{ role: "conditional-rule-definition", versionId: v.id, ruleId: r.id }]);
    }
    // Shared tax definitions may carry separate subject-bound records. Every
    // listed record must prove that tax for its own subject; selection below
    // requires evidence for the actual consuming agreement, never another one.
    for (const t of model.taxes) for (const id of t.evidenceIds) {
        const e = model.evidence.find(e => e.id === id)!;
        requireClaims(model, [id], model.agreements.find(a => a.id === e.subject.agreementId)!, [{ role: "tax-treatment", taxId: t.id }]);
    }
    for (const d of intervals) requireClaims(model, [d.evidenceId], model.agreements.find(a => a.id === d.agreementId)!, [occurrenceClaim(d)]);
}

function validate(model: EconomicModel, intervals: ConditionalInterval[]) {
    new Intl.DateTimeFormat("en-GB", { timeZone: model.timeZone });
    const unique = (ids: string[]) => ids.every(nonempty) && new Set(ids).size === ids.length;
    requireValid(unique(model.evidence.map(e => e.id)) && unique(model.agreements.map(a => a.id)) && unique(model.versions.map(v => v.id)), "DUPLICATE_OR_INVALID_ID");
    const evidenceIds = new Set(model.evidence.map(e => e.id));
    const refs = (ids: string[]) => Array.isArray(ids) && ids.length > 0 && unique(ids) && ids.every(id => evidenceIds.has(id));
    for (const e of model.evidence) requireValid(nonempty(e.provider) && ["supplier-agreement", "supplier-rates", "supplier-bill", "manual", "tesla-observation", "authenticated-dispatch"].includes(e.kind)
        && ["fresh", "stale", "unknown"].includes(e.freshness) && Number.isFinite(economicInstant(e.observedAt))
        && Array.isArray(e.coverage) && e.coverage.every(validPeriod), "INVALID_EVIDENCE");
    for (const a of model.agreements) requireValid(nonempty(a.supplyRef) && nonempty(a.supplier) && nonempty(a.productCode) && nonempty(a.tariffCode)
        && ["import", "export"].includes(a.direction) && ["active", "future", "revoked", "terminated", "replaced"].includes(a.status)
        && [a.validFrom, a.validTo, a.invalidatedAt].every(t => t === null || Number.isFinite(economicInstant(t)))
        && (a.validFrom === null || a.validTo === null || economicInstant(a.validTo) > economicInstant(a.validFrom)) && refs(a.evidenceIds), "INVALID_AGREEMENT");
    for (const t of model.taxes) requireValid(nonempty(t.id) && validPeriod(t.validity) && decimalParts(t.fraction)
        && decimalParts(t.fraction)!.coefficient >= BigInt(0) && refs(t.evidenceIds), "INVALID_TAX");
    for (const v of model.versions) {
        requireValid(model.agreements.some(a => a.id === v.agreementId) && validPeriod(v.validity) && refs(v.evidenceIds), "INVALID_VERSION");
        for (const r of v.rates) requireValid(nonempty(r.id) && validPeriod(r.validity) && refs(r.evidenceIds)
            && decimalParts(r.price.amount) && /^[A-Z]{3}$/.test(r.price.currency) && ["kWh", "day"].includes(r.price.unit)
            && ["tax-inclusive", "tax-exclusive", "observed-external"].includes(r.price.basis)
            && (r.price.basis !== "tax-exclusive" || nonempty(r.price.taxId)), "INVALID_RATE");
        requireValid(v.standingRateId === null || nonempty(v.standingRateId), "INVALID_STANDING_RATE");
        for (const s of v.schedule) requireValid(nonempty(s.rateId) && ["preserve", "replace"].includes(s.overlayPolicy)
            && (s.compatibility === undefined || (s.compatibility === "guaranteed-off-peak" && s.overlayPolicy === "preserve")) &&
            (s.local.kind === "all-day" || (s.local.kind === "daily" && Number.isFinite(minute(s.local.start))
                && Number.isFinite(minute(s.local.end, true)) && minute(s.local.start) !== minute(s.local.end, true))), "INVALID_SCHEDULE");
        requireValid(unique(v.conditionalRules.map(r => r.id)), "DUPLICATE_RULE");
        for (const r of v.conditionalRules) requireValid(nonempty(r.rateId) && validPeriod(r.validity) && refs(r.evidenceIds)
            && nonempty(r.provider) && nonempty(r.dispatchType) && ["provider-defined", "physical-charging-required"].includes(r.qualification)
            && (r.compatibility === null || (r.compatibility === "drive-smart" && r.provider === "kraken" && r.dispatchType === "SMART"
                && r.qualification === "physical-charging-required")), "INVALID_RULE");
    }
    for (const d of intervals) {
        const e = model.evidence.find(e => e.id === d.evidenceId);
        requireValid(e?.kind === "authenticated-dispatch", "EVIDENCE_ROLE_NOT_PERMITTED");
        requireValid(validPeriod(d) && nonempty(d.ruleId) && model.agreements.some(a => a.id === d.agreementId)
            && e?.kind === "authenticated-dispatch" && d.cause.kind === "ev-dispatch" && nonempty(d.cause.assetId)
            && nonempty(d.cause.dispatchType) && economicInstant(d.cause.start) === economicInstant(d.start)
            && economicInstant(d.cause.end) === economicInstant(d.end), "INVALID_CONDITIONAL_EVIDENCE");
        requireValid(model.versions.some(v => v.agreementId === d.agreementId && v.conditionalRules.some(r => r.id === d.ruleId
            && r.provider === e?.provider && r.dispatchType === d.cause.dispatchType)), "UNRESOLVED_CONDITIONAL_RULE");
    }
}

export type EconomicResolution = {
    status: "resolved" | "invalid"; diagnostics: string[];
    periods: ResolvedEconomicPeriod[]; standingCharges: ResolvedEconomicPeriod[];
    signal: PriceSignal;
};

/** Pure supplied-evidence resolution. No clock, fetch, persistence, or execution authority.
 * Detailed canonical conditional evidence is retained even if legacy projection is unsupported.
 */
export function resolveEconomicModel(input: EconomicModel, horizon: Period, generatedAt: string,
    conditionalIntervals: ConditionalInterval[] = []): EconomicResolution {
    const signal: PriceSignal = { scope: "whole-home", generatedAt: typeof generatedAt === "string" ? generatedAt : "",
        horizon: { start: typeof horizon?.start === "string" ? horizon.start : "", end: typeof horizon?.end === "string" ? horizon.end : "" }, import: [], export: [] };
    const result: EconomicResolution = { status: "resolved", diagnostics: [], periods: [], standingCharges: [], signal };
    if (!validPeriod(horizon) || !Number.isFinite(economicInstant(generatedAt))) {
        result.status = "invalid"; result.diagnostics.push("INVALID_HORIZON_OR_GENERATION"); return freezeResolution(result);
    }
    const begin = economicInstant(horizon.start), finish = economicInstant(horizon.end);
    const iso = (t: number) => new Date(t).toISOString();
    const blank = (a: number, b: number, direction: "import" | "export", code: string): ResolvedEconomicPeriod => ({
        start: iso(a), end: iso(b), direction, versionId: null, rateId: null, priceStatus: "unknown", consumerPrice: null,
        sourcePrice: null, tax: null, sources: [], diagnostics: [code], conditional: null, protected: false, compatibilityKind: "standard",
    });
    try {
        // Limit resolution work rather than extrapolating an unbounded recurrence.
        requireValid(finish - begin <= 366 * 86400000, "HORIZON_TOO_LARGE");
        const model: EconomicModel = structuredClone(input), intervals: ConditionalInterval[] = structuredClone(conditionalIntervals);
        visitDataGraph(model, false);
        visitDataGraph(intervals, false);
        validate(model, intervals);
        validateEvidenceAuthority(model, intervals);
        requireValid(model.evidence.every(e => economicInstant(e.observedAt) <= economicInstant(generatedAt)), "FUTURE_OBSERVATION");
        const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: model.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
        const boundaries = new Set([begin, finish]);
        const add = (t: string | null) => { const n = economicInstant(t); if (n > begin && n < finish) boundaries.add(n); };
        for (let t = (Math.floor(begin / 60000) + 1) * 60000; t < finish; t += 60000) boundaries.add(t);
        for (const d of intervals) { add(d.start); add(d.end); }
        for (const e of model.evidence) for (const p of e.coverage) { add(p.start); add(p.end); }
        for (const a of model.agreements) { add(a.validFrom); add(a.validTo); add(a.invalidatedAt); }
        for (const p of [...model.versions.map(v => v.validity), ...model.versions.flatMap(v => [...v.rates, ...v.conditionalRules].map(r => r.validity)), ...model.taxes.map(t => t.validity)]) { add(p.start); add(p.end); }
        const points = [...boundaries].sort((a, b) => a - b);
        const covered = (ids: string[], a: number, b: number) => ids.every(id => model.evidence.find(e => e.id === id)!.coverage.some(p => contains(p, a, b)));
        const sources = (ids: string[]) => [...new Set(ids)].sort().map(id => {
            const e = model.evidence.find(e => e.id === id)!;
            return { provider: e.provider, description: `${e.kind}:${e.id}`, observedAt: e.observedAt, stale: e.freshness !== "fresh" };
        });
        for (let i = 0; i < points.length - 1; i++) for (const direction of ["import", "export"] as const) {
            const a = points[i], b = points[i + 1];
            const unknown = (code: string, conflict = false) => { const p = blank(a, b, direction, code); if (conflict) p.priceStatus = "conflicting"; result.periods.push(p); };
            const agreements = model.agreements.filter(g => g.direction === direction && g.validFrom !== null && economicInstant(g.validFrom) <= a
                && (g.validTo === null || economicInstant(g.validTo) >= b) && (g.invalidatedAt === null || economicInstant(g.invalidatedAt) >= b)
                && (["active", "future"].includes(g.status) || (g.invalidatedAt !== null && economicInstant(g.invalidatedAt) >= b)));
            if (agreements.length !== 1) { unknown(agreements.length ? "AGREEMENT_CONFLICT" : "AGREEMENT_UNAVAILABLE", agreements.length > 1); continue; }
            const agreement = agreements[0];
            if (agreement.validTo === null || !covered(agreement.evidenceIds, a, b)) { unknown("AGREEMENT_COVERAGE_UNKNOWN"); continue; }
            const versions = model.versions.filter(v => v.agreementId === agreement.id && contains(v.validity, a, b));
            if (versions.length !== 1) { unknown(versions.length ? "VERSION_CONFLICT" : "ECONOMICS_UNKNOWN", versions.length > 1); continue; }
            const version = versions[0];
            if (!covered(version.evidenceIds, a, b)) { unknown("ECONOMIC_EVIDENCE_GAP"); continue; }
            const parts = formatter.formatToParts(a);
            const m = Number(parts.find(p => p.type === "hour")!.value) * 60 + Number(parts.find(p => p.type === "minute")!.value);
            const schedules = version.schedule.filter(s => {
                if (s.local.kind === "all-day") return true;
                const from = minute(s.local.start), to = minute(s.local.end, true);
                return from < to ? m >= from && m < to : m >= from || m < to;
            });
            const resolveRate = (rateId: string, unit: SourcePrice["unit"]): ResolvedEconomicPeriod => {
                const p = blank(a, b, direction, "RATE_UNKNOWN"); p.versionId = version.id; p.rateId = rateId;
                const rates = version.rates.filter(r => r.id === rateId && contains(r.validity, a, b));
                if (rates.length !== 1) { if (rates.length) { p.priceStatus = "conflicting"; p.diagnostics = ["RATE_CONFLICT"]; } return p; }
                const rate = rates[0]; p.sourcePrice = rate.price;
                const ids = [...agreement.evidenceIds, ...version.evidenceIds, ...rate.evidenceIds];
                if (rate.price.unit !== unit || !covered(ids, a, b)) { p.diagnostics = ["RATE_EVIDENCE_OR_UNIT_INVALID"]; return p; }
                if (rate.price.basis === "tax-exclusive") {
                    const taxes = model.taxes.filter(t => t.id === rate.price.taxId && contains(t.validity, a, b));
                    if (taxes.length !== 1) { p.diagnostics = ["TAX_UNKNOWN_OR_CONFLICTING"]; p.priceStatus = taxes.length ? "conflicting" : "unknown"; return p; }
                    p.tax = taxes[0];
                    const taxIds = p.tax.evidenceIds.filter(id => subjectMatches(model.evidence.find(e => e.id === id)!, agreement));
                    requireClaims(model, taxIds, agreement, [{ role: "tax-treatment", taxId: p.tax.id }]);
                    ids.push(...taxIds);
                    if (!covered(taxIds, a, b)) { p.diagnostics = ["TAX_EVIDENCE_GAP"]; return p; }
                }
                const amount = deriveConsumerAmount(rate.price, p.tax?.fraction);
                if (amount === null) return p;
                p.consumerPrice = { amount, currency: rate.price.currency, unit }; p.priceStatus = "known";
                p.sources = sources(ids).map(s => ({ ...s, tariffVersion: version.id })); p.diagnostics = []; return p;
            };
            if (version.standingRateId !== null) result.standingCharges.push(resolveRate(version.standingRateId, "day"));
            if (schedules.length !== 1) { unknown(schedules.length ? "SCHEDULE_CONFLICT" : "SCHEDULE_GAP", schedules.length > 1); continue; }
            let p = resolveRate(schedules[0].rateId, "kWh"); p.protected = schedules[0].overlayPolicy === "preserve";
            p.compatibilityKind = schedules[0].compatibility ?? "standard";
            const active = intervals.filter(d => d.agreementId === agreement.id && contains(d, a, b));
            // Missing base knowledge must never be hidden by an overlay.
            if (active.length && !p.protected && p.priceStatus === "known") {
                const rules = active.map(d => version.conditionalRules.find(r => r.id === d.ruleId && contains(r.validity, a, b)));
                if (rules.some(r => !r) || new Set(rules.map(r => r?.id)).size !== 1) { unknown("CONDITIONAL_RULE_CONFLICT", true); continue; }
                const rule = rules[0]!;
                if (active.some(d => !covered([d.evidenceId], a, b) || model.evidence.find(e => e.id === d.evidenceId)!.provider !== rule.provider
                    || d.cause.dispatchType !== rule.dispatchType) || !covered(rule.evidenceIds, a, b)) { unknown("CONDITIONAL_EVIDENCE_GAP"); continue; }
                const baseCurrency = p.consumerPrice!.currency;
                p = resolveRate(rule.rateId, "kWh");
                if (p.consumerPrice && p.consumerPrice.currency !== baseCurrency) { unknown("CONDITIONAL_CURRENCY_CONFLICT", true); continue; }
                p.conditional = { rule, intervals: active, state: "planned-conditional" };
                p.sources.push(...sources(rule.evidenceIds), ...active.map(d => ({ ...sources([d.evidenceId])[0], cause: d.cause })));
            }
            result.periods.push(p);
        }
    } catch (error) {
        const code = error instanceof Error && ["EVIDENCE_ROLE_NOT_PERMITTED", "EVIDENCE_CLAIM_MISSING", "EVIDENCE_SUBJECT_MISMATCH",
            "EVIDENCE_ATTESTOR_MISMATCH", "EVIDENCE_TARGET_MISMATCH", "EVIDENCE_CLAIM_DUPLICATE"].includes(error.message) ? error.message : "INVALID_ECONOMIC_MODEL";
        result.status = "invalid"; result.diagnostics = [code];
        result.periods = [blank(begin, finish, "import", code), blank(begin, finish, "export", code)];
        result.standingCharges = [];
    }
    for (const p of result.periods) {
        const unsupported = p.conditional && (p.direction !== "import" || p.conditional.rule.compatibility !== "drive-smart");
        const amount = p.consumerPrice ? Number(p.consumerPrice.amount) : NaN;
        const lossy = p.consumerPrice && (!Number.isFinite(amount) || String(amount) !== p.consumerPrice.amount);
        const diagnostics = [...p.diagnostics, ...(unsupported ? ["CONDITION_NOT_REPRESENTABLE"] : []), ...(lossy ? ["PRICE_NOT_REPRESENTABLE"] : [])];
        result.diagnostics.push(...diagnostics);
        const known = p.priceStatus === "known" && !unsupported && !lossy;
        const w: PriceWindow = { start: p.start, end: p.end,
            price: known ? { amount, currency: p.consumerPrice!.currency, unit: "kWh" } : null,
            priceStatus: p.priceStatus === "conflicting" ? "conflicting" : known ? "known" : "unknown",
            kind: known && p.conditional ? "cheap-opportunity" : p.compatibilityKind,
            condition: known && p.conditional ? "scheduled-ev-charging" : "none",
            stale: p.sources.some(s => s.stale), sources: p.sources, eligibilityPeriods: known && p.conditional ? [{
                start: p.start, end: p.end, assessmentPeriod: { start: iso(Math.floor(economicInstant(p.start) / 1800000) * 1800000), end: iso((Math.floor(economicInstant(p.start) / 1800000) + 1) * 1800000) },
                state: "planned-conditional", sources: p.sources,
            }] : [] };
        const curve = signal[p.direction], previous = curve.at(-1);
        if (previous && previous.end === w.start && JSON.stringify({ ...previous, start: null, end: null, eligibilityPeriods: null }) === JSON.stringify({ ...w, start: null, end: null, eligibilityPeriods: null })) {
            previous.end = w.end; previous.eligibilityPeriods.push(...w.eligibilityPeriods);
        } else curve.push(w);
    }
    result.diagnostics.push(...result.standingCharges.flatMap(p => p.diagnostics));
    result.diagnostics = [...new Set(result.diagnostics)].sort();
    return freezeResolution(result);
}
