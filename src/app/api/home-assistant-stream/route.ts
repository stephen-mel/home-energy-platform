import { getCurrentSite } from "../../../lib/site/repository";
import { createHomeAssistantStream } from "../../../lib/home-assistant/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if ((origin && origin !== new URL(request.url).origin) ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
        return new Response(null, { status: 403 });
    }
    const site = await getCurrentSite();
    if (!site.integrations.homeAssistant.enabled ||
        !site.integrations.homeAssistant.assets?.some(asset => asset.metrics.length)) {
        return new Response(null, { status: 204 });
    }
    return new Response(createHomeAssistantStream(site.integrations.homeAssistant, request.signal), {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
