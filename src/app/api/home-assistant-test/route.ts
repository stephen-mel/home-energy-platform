import { getHomeAssistantSiteState } from "../../../lib/site/home-assistant-state";
import { getCurrentSite } from "../../../lib/site/repository";

export async function GET() {
    try {
        const site = await getCurrentSite();
        const homeAssistant = await getHomeAssistantSiteState(site.integrations.homeAssistant);

        return Response.json({
            success: true,
            message: site.integrations.homeAssistant.enabled
                ? "Home Assistant status retrieved successfully"
                : "Home Assistant is disabled",
            homeAssistant,
        });
    } catch (error) {
        console.error("Home Assistant test failed:", error);

        return Response.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown Home Assistant error",
            },
            { status: 500 }
        );
    }
}