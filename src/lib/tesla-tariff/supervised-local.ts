/** Local interactive adapter ONLY. Never import from a route, page, sync planner,
 * scheduled task or test transport. No token refresh, new scopes or other commands.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadEnvConfig } from "@next/env";
import { currentSite } from "../site/current-site";
import { getKrakenDevices, getKrakenPlannedDispatches } from "../kraken/client";
import type { KrakenState } from "../site/kraken-state";
import { captureObservedTariff } from "./observed-tariff";
import { claimExperimentJournal } from "./supervised-journal";
import { runSupervisedExperiment, interpretWriteResponse } from "./supervised-experiment";

const ROOT = "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/energy_sites/";
export async function runLocalExperiment(args: string[]) {
    if (args.includes("--help")) {
        console.log("Local Tesla tariff experiment (default: dry-run).\nUsage: node scripts/tesla-tariff-experiment.mjs --site SITE_ID --vehicle KRAKEN_DEVICE_ID --dispatch-start EXACT_ISO [--execute-supervised]\nNo saved approval can be loaded. Execution requires an interactive foreground terminal and three exact confirmations. No automatic restore or retry.");
        return;
    }
    const allowed = new Set(["--site", "--vehicle", "--dispatch-start", "--execute-supervised"]);
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!allowed.has(arg) || options.has(arg)) throw new Error("INVALID_ARGUMENTS");
        options.set(arg, arg === "--execute-supervised" ? "yes" : args[++i] ?? "");
    }
    const execute = options.has("--execute-supervised");
    // No test runner, CI, redirected stdin/stdout, or noninteractive execution.
    if (execute && (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY
        || process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT || process.env.CI)) throw new Error("INTERACTIVE_SUPERVISION_REQUIRED");
    const selection = { energySiteId: options.get("--site") ?? "", assetId: options.get("--vehicle") ?? "", dispatchStart: options.get("--dispatch-start") ?? "" };
    if (!/^\d+$/.test(selection.energySiteId) || !selection.assetId || !Number.isFinite(Date.parse(selection.dispatchStart))) throw new Error("EXACT_SELECTION_REQUIRED");
    loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
    const now = () => new Date().toISOString();
    const directory = path.join(process.cwd(), ".cache/home-energy-platform/tesla-experiments");
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    // The body and endpoint are fixed to tariff settings. Token never enters any record.
    const request = async (suffix: "site_info" | "time_of_use_settings", body?: string) => {
        const tokens = JSON.parse(await readFile(path.join(process.cwd(), ".tesla-tokens.json"), "utf8"));
        if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("READ_ACCESS_REQUIRED");
        return fetch(`${ROOT}${selection.energySiteId}/${suffix}`, {
            method: body === undefined ? "GET" : "POST", redirect: "manual", cache: "no-store",
            headers: { Authorization: `Bearer ${tokens.access_token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body, signal: AbortSignal.timeout(15_000),
        });
    };
    const readBefore = async () => {
        const response = await request("site_info");
        if (!response.ok) throw new Error("TESLA_READ_FAILED");
        const raw = await response.json();
        const id = raw?.response?.energy_site_id;
        if (id !== undefined && String(id) !== selection.energySiteId) throw new Error("SITE_MISMATCH");
        return captureObservedTariff(raw, selection.energySiteId, now());
    };
    // Read-only queries through the existing integration; auth session acquisition
    // is its existing obtainKrakenToken flow. Never invoke a preference mutation.
    const capture = async () => {
        const readStartedAt = now();
        const devices = await getKrakenDevices();
        const vehicles = [];
        for (const device of devices) {
            vehicles.push({ ...device, plannedDispatches: await getKrakenPlannedDispatches(device.id),
                status: { currentState: null, isSuspended: null, stateOfCharge: null, activePower: null } });
        }
        const kraken: KrakenState = { vehicles, stale: false, lastSuccessfulUpdate: readStartedAt };
        return { before: await readBefore(), kraken };
    };
    let writeAttempted = false;
    const result = await runSupervisedExperiment({ site: currentSite, selection,
        mode: execute ? "execute-supervised" : "dry-run", authority: execute ? "supervised-experiment" : "observe" }, {
        now, capture, readBack: readBefore,
        challenge: binding => `EXECUTE ${selection.energySiteId} ${digest(binding + randomUUID())}`,
        async confirm(review, challenge) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const file = path.join(directory, `review-${randomUUID()}.json`);
            await writeFile(file, JSON.stringify(review, null, 2), { mode: 0o600 });
            console.log(`Exact review saved: ${file}\nPayload SHA-256: ${digest(review.payloadJson)}\nProposal SHA-256: ${digest(review.proposal.fingerprint)}\nExact payload:\n${review.payloadJson}\nProduction blockers remain:\n${review.restoration.blockers.join(", ")}\nExpires: ${review.proposal.bound.expiresAt}\nNo automatic restoration or expiry in Tesla. The month/day exception can recur annually. You must supervise and manually recover at the interval end or earlier if needed, including after an ambiguous response.`);
            const prompt = createInterface({ input: process.stdin, output: process.stdout });
            try {
                const a = await prompt.question("Type AUTOMATIC ROLLBACK IS UNPROVEN: ");
                const b = await prompt.question("Type MANUAL TESLA APP RECOVERY MAY BE REQUIRED: ");
                const typed = await prompt.question(`Approve this exact payload by typing:\n${challenge}\n> `);
                return { challenge: typed, automaticRollbackUnproven: a === "AUTOMATIC ROLLBACK IS UNPROVEN",
                    manualAppRecoveryMayBeRequired: b === "MANUAL TESLA APP RECOVERY MAY BE REQUIRED" };
            } finally { prompt.close(); }
        },
        claim: (site, record) => claimExperimentJournal(directory, site, record),
        async write(site, exactPayload) {
            if (!execute || writeAttempted || site !== selection.energySiteId || !process.stdin.isTTY || !process.stdout.isTTY
                || process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT || process.env.CI) throw new Error("WRITE_DISABLED");
            writeAttempted = true;
            const response = await request("time_of_use_settings", exactPayload);
            let body: unknown = null;
            try { body = await response.json(); } catch { /* unknown response must not cause retry */ }
            return interpretWriteResponse(response.status, body);
        },
    });
    if (result.status === "dry-run") {
        console.log(JSON.stringify({ status: result.status, site: selection.energySiteId,
            payloadSHA256: digest(result.review.payloadJson), proposalSHA256: digest(result.review.proposal.fingerprint),
            exactPayload: JSON.parse(result.review.payloadJson), productionBlockers: result.review.restoration.blockers,
            experimentalBlockers: result.review.hardBlockers, writeReady: false }, null, 2));
    } else console.log(JSON.stringify({ status: result.status, classification: result.record.classification,
        apiWrite: result.record.apiWrite, journal: path.join(directory, `site-${selection.energySiteId}.jsonl`),
        manualRecoveryMayBeRequired: true, rollbackProven: false, writeReady: false }, null, 2));
}
