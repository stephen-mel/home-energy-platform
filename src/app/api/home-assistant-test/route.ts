import { getPowerwallStatus } from "../../../lib/home-assistant/client";

export async function GET() {
    try {
        const powerwall = await getPowerwallStatus();

        return Response.json({
            success: true,
            message: "Powerwall status retrieved successfully",
            powerwall,
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