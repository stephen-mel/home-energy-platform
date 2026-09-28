import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validOwnership, validOwnershipTimestamp, assertOwnership, type ManagedImportEvidence } from "./ownership-evidence";
import { representationKey } from "./rollback-evidence";
import { createTariffProposal, type Proposal } from "./proposal-approval";
import type { ObservedTariff } from "./observed-tariff";
import { observedEconomicSignal } from "./observed-economic";
import { CAPTURE_TTL_MS } from "./supervised-experiment";

const digest = (v: unknown) => createHash("sha256").update(representationKey(v)).digest("hex");
type Snapshot = { version: 1; generation: string; evidence: ManagedImportEvidence; checksum: string };
export type OwnershipRead = { status: "available"; snapshot: Snapshot } | { status: "missing" | "invalid" | "unavailable" };
const processState = globalThis as typeof globalThis & { __hepSmartOwnershipCommits?: Map<string, Promise<void>> };
const queues = processState.__hepSmartOwnershipCommits ??= new Map<string, Promise<void>>();

/** Server-local ledger, separate from the consumed experiment latch. No network,
 * executor, write approval or automatic collection. Inject directory for tests.
 */
export function ownershipStore(directory = path.join(process.cwd(), ".cache/home-energy-platform/tesla-smart-ownership")) {
    const file = (site: string) => {
        if (!/^\d+$/.test(site)) throw Error("OWNERSHIP_SITE_INVALID");
        return path.resolve(directory, `site-${site}.json`);
    };
    const read = async (site: string): Promise<OwnershipRead> => {
        try {
            const value = JSON.parse(await readFile(file(site), "utf8"));
            if (Object.keys(value).sort().join() !== "checksum,evidence,generation,version" || value.version !== 1
                || typeof value.generation !== "string" || !/^[a-f0-9-]{36}$/.test(value.generation)
                || !validOwnership(value.evidence) || value.evidence.energySiteId !== site
                || value.checksum !== digest({ generation:value.generation, evidence:value.evidence })) return {status:"invalid"};
            return {status:"available",snapshot:value};
        } catch (e) {
            return {status:(e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : e instanceof SyntaxError ? "invalid" : "unavailable"};
        }
    };
    return { read,
        /** Trusted future lifecycle input ONLY, not a browser-submitted receipt.
         * No caller is wired in this feature. A proposal/HTTP 200 alone is not
         * confirmation. Requires exact authenticated readback of that proposal.
         */
        async recordConfirmed(input: { proposal: Proposal; before: ObservedTariff; readback: ObservedTariff;
            writeOutcome: "submitted-representation-preserved"; submittedAt: string; recordedAt: string;
            expectedGeneration: string | null }): Promise<Snapshot> {
            // Detach caller objects before waiting for the serialization boundary.
            const receipt = structuredClone(input), site = receipt.before.source.energySiteId, location = file(site);
            const operation = (queues.get(location) ?? Promise.resolve()).then(async () => {
                const existing = await read(site);
                if (existing.status !== "missing" && existing.status !== "available") throw Error("OWNERSHIP_STORE_UNAVAILABLE");
                const previous = existing.status === "available" ? existing.snapshot : null;
                if ((previous?.generation ?? null) !== receipt.expectedGeneration) throw Error("OWNERSHIP_GENERATION_CHANGED");
                const { proposal:p, before, readback, submittedAt, recordedAt } = receipt;
                const replacement = p.input.observedReplacement, scope = replacement?.managedScope;
                const submitted = Date.parse(submittedAt), recorded = Date.parse(recordedAt), captured = Date.parse(before.source.observedAt), seen = Date.parse(readback.source.observedAt);
                if (receipt.writeOutcome !== "submitted-representation-preserved" || !p.structurallyValid || !replacement || !scope
                    || ![submittedAt, recordedAt, before.source.observedAt, readback.source.observedAt,
                        p.bound.validFrom, p.bound.expiresAt, replacement.generatedAt,
                        replacement.comparisonDomain.start, replacement.comparisonDomain.end,
                        ...p.input.signal.import.flatMap(w => [w.start, w.end])].every(validOwnershipTimestamp)
                    || representationKey(createTariffProposal(p.input)) !== representationKey(p)
                    || representationKey(replacement.observation) !== representationKey(before)
                    || representationKey(scope.previous ?? null) !== representationKey(previous?.evidence ?? null)
                    || ![submitted,recorded,captured,seen].every(Number.isFinite) || captured > submitted || seen < submitted || recorded < seen
                    || submitted - captured > CAPTURE_TTL_MS || recorded - seen > CAPTURE_TTL_MS
                    || submitted < Date.parse(p.bound.validFrom) || submitted >= Date.parse(p.bound.expiresAt)
                    || before.source.kind !== "tesla-site-info" || readback.source.kind !== "tesla-site-info"
                    || site !== p.bound.energySiteId || readback.source.energySiteId !== site
                    || before.source.timeZone !== p.bound.timeZone || readback.source.timeZone !== p.bound.timeZone
                    || readback.diagnostics.includes("UNSUPPORTED_FIELDS_OMITTED")
                    || representationKey(readback.tariff) !== representationKey(p.bound.representation)) throw Error("OWNERSHIP_CONFIRMATION_INVALID");
                if (previous) assertOwnership(previous.evidence, before, submittedAt);
                const domain = replacement.comparisonDomain;
                const beforeCurve = observedEconomicSignal(before, domain).signal;
                const afterCurve = observedEconomicSignal(readback, domain).signal;
                // Record only conditional SMART economics actually present in the
                // confirmed representation. Preserve original restoration through
                // later shorten/extend/move operations, not the temporary cheap rate.
                const points = [...new Set([domain.start,domain.end,...beforeCurve.import.flatMap(w=>[w.start,w.end]),
                    ...afterCurve.import.flatMap(w=>[w.start,w.end]),...p.input.signal.import.flatMap(w=>[w.start,w.end]),
                    ...(previous?.evidence.intervals ?? []).flatMap(w=>[w.start,w.end])]
                    .map(Date.parse).filter(t=>t>=Date.parse(domain.start)&&t<=Date.parse(domain.end)))].sort((a,b)=>a-b);
                const intervals: ManagedImportEvidence["intervals"] = [];
                for(let n=0;n<points.length-1;n++) {
                    const start=points[n],end=points[n+1];
                    const at = <T extends {start:string;end:string}>(ws:T[])=>ws.find(w=>Date.parse(w.start)<=start&&Date.parse(w.end)>=end);
                    const desired=at(p.input.signal.import), applied=at(afterCurve.import)?.price;
                    const old=at(previous?.evidence.intervals ?? []), restore=old?.restore ?? at(beforeCurve.import)?.price;
                    if(desired?.kind!=="cheap-opportunity" || desired.condition!=="scheduled-ev-charging") continue;
                    if(!applied || !restore || representationKey(applied)!==representationKey(desired.price)) throw Error("OWNERSHIP_CONFIRMATION_INVALID");
                    if(representationKey(applied)===representationKey(restore)) continue;
                    intervals.push({start:new Date(start).toISOString(),end:new Date(end).toISOString(),applied,restore,restoreBaselineFingerprint:old?.restoreBaselineFingerprint ?? digest(before.tariff)});
                }
                // Elapsed prefixes no longer need coverage. Every remaining owned
                // instant must still be assessed; future prefixes/tails cannot vanish.
                if(previous?.evidence.intervals.some(w=>Date.parse(w.end)>recorded && (Math.max(Date.parse(w.start),recorded)<Date.parse(domain.start)||Date.parse(w.end)>Date.parse(domain.end))))
                    throw Error("OWNERSHIP_DOMAIN_INCOMPLETE");
                const evidence: ManagedImportEvidence = {version:1,energySiteId:site,timeZone:p.bound.timeZone,
                    createdAt:previous?.evidence.createdAt ?? recordedAt,updatedAt:recordedAt,validUntil:domain.end,
                    basis:"confirmed-write-readback",baselineFingerprint:digest(before.tariff),readbackFingerprint:digest(readback.tariff),
                    proposalFingerprint:digest(p.bound),smartEvidenceFingerprint:digest(replacement.dispatchEvidenceKey),intervals};
                if(!validOwnership(evidence)) throw Error("OWNERSHIP_CONFIRMATION_INVALID");
                const generation=randomUUID();
                const snapshot: Snapshot={version:1,generation,evidence,checksum:digest({generation,evidence})};
                await mkdir(directory,{recursive:true,mode:0o700});
                const temporary=`${location}.${randomUUID()}.tmp`;
                try {
                    const handle=await open(temporary,"wx",0o600);
                    try {await handle.writeFile(JSON.stringify(snapshot),"utf8");await handle.sync();} finally {await handle.close();}
                    await rename(temporary,location);
                    const parent=await open(directory,"r");try {await parent.sync();} finally {await parent.close();}
                    return snapshot;
                } finally {await unlink(temporary).catch(()=>{});}
            });
            const settled=operation.then(()=>{},()=>{});
            queues.set(location,settled);
            try {return await operation;} catch(e) {
                const code=e instanceof Error && /^OWNERSHIP_[A-Z_]+$/.test(e.message) ? e.message : "OWNERSHIP_PERSISTENCE_FAILED";
                throw Error(code);
            } finally {if(queues.get(location)===settled) queues.delete(location);}
        },
    };
}
