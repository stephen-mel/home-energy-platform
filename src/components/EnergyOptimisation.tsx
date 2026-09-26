import type { ReconciliationResult } from "../lib/tesla-tariff/reconciliation";
import { energyOptimisationView } from "./energy-optimisation-view";

export default function EnergyOptimisation({ result, timeZone }: { result: ReconciliationResult | null; timeZone: string }) {
    const view = energyOptimisationView(result, timeZone);
    const list = (values: string[]) => <ul className="mt-2 space-y-2">{values.map((text, i) => <li key={i}>{text}</li>)}</ul>;
    return <section aria-labelledby="energy-optimisation-heading" className="mb-10 rounded-3xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 id="energy-optimisation-heading" className="text-2xl font-semibold">Energy optimisation</h2>
        <p className={`mt-4 font-medium ${view.status === "in-sync" ? "text-emerald-300" : view.status === "indeterminate" ? "text-zinc-200" : "text-amber-300"}`}>{view.title}</p>
        <p className="mt-2 text-sm text-zinc-300">{view.summary}</p>
        {view.checked && <p className="mt-2 text-xs text-zinc-400">Snapshot checked: {view.checked}. This is a review snapshot, not a live status.</p>}
        {(view.status === "update-required" || view.status === "blocked") && view.current.length > 0 && <>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <div className="min-w-0 rounded-2xl bg-zinc-800/70 p-4"><h3 className="font-medium">Current Powerwall signal</h3>{list(view.current)}</div>
                <div className="min-w-0 rounded-2xl bg-zinc-800/70 p-4"><h3 className="font-medium">{view.status === "blocked" ? "Required signal · not validated" : "Proposed signal · review only"}</h3>{list(view.proposed)}</div>
            </div>
            <p className="mt-3 text-sm text-zinc-400">These SMART changes affect import prices beyond the underlying guaranteed tariff. {view.comparisonNote}</p>
        </>}
        {view.ownershipNote && <p className="mt-3 text-sm text-amber-300">{view.ownershipNote}</p>}
        <p className="mt-4 text-sm text-zinc-200">No change has been made to Tesla by this review. No approval or execution is available here.</p>
        <details className="mt-4 text-sm text-zinc-400">
            <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-emerald-400">Why am I seeing this?</summary>
            <p className="mt-3">HEP compares Kraken’s smart charging schedule with the price signal available to the Powerwall. No changes are made without confirmation; this review cannot make changes.</p>
            {view.availability && <p className="mt-2">{view.availability}</p>}
            <p className="mt-3">SMART periods are planned and conditional on qualifying EV charging; they do not confirm discounted billing. Tesla/Opticaster decides Powerwall behaviour from the price signal.</p>
            <p className="mt-2">An update being required does not mean it is safe or ready to write. Automatic rollback remains unproven.</p>
            {list(view.evidence)}
            {view.managed.length > 0 && <><h3 className="mt-4 font-medium text-zinc-200">Managed SMART intervals</h3>{list(view.managed)}</>}
            {view.unmanaged.length > 0 && <>
                <h3 className="mt-4 font-medium text-zinc-200">Other observed tariff differences</h3>
                <p className="mt-2">These base/import or export differences are not part of this SMART optimisation update and are preserved. An observed export value may be manually configured in Tesla; it is not treated as a Tesla error.</p>
                {view.unmanaged.map((difference, i) => <div key={i} className="mt-3 rounded-2xl bg-zinc-800/70 p-3">
                    <p className="font-medium">{difference.channel === "export" ? "Export" : "Base import"}</p>
                    <p className="mt-2">Observed Tesla tariff</p>{list(difference.observed)}
                    <p className="mt-2">HEP tariff value</p>{list(difference.hep)}
                </div>)}
            </>}
            <details className="mt-4">
                <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-emerald-400">Technical evidence and safety requirements</summary>
                {view.fingerprint && <p className="mt-3 break-all">Proposal fingerprint: <code>{view.fingerprint}</code></p>}
                <ul className="mt-3 space-y-2">{view.diagnostics.map(d => <li key={d.code}>{d.description} <code className="break-all text-xs">{d.code}</code></li>)}</ul>
            </details>
        </details>
    </section>;
}
