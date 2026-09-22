import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectTeslaScopes } from "../../../../lib/tesla/inspect-scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
    try {
        const stored: unknown = JSON.parse(await readFile(path.join(process.cwd(), ".tesla-tokens.json"), "utf8"));
        const accessToken = stored && typeof stored === "object" && !Array.isArray(stored)
            ? (stored as Record<string, unknown>).access_token : undefined;
        const result = inspectTeslaScopes(accessToken);
        return Response.json(result, { status: result.success ? 200 : 422, headers });
    } catch {
        return Response.json({ success: false, diagnostic: "STORED_TOKEN_UNAVAILABLE" }, { status: 503, headers });
    }
}
