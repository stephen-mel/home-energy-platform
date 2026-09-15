import { getKrakenDevices } from "../../../lib/kraken/client";

export async function GET() {
  try {
    const devices = await getKrakenDevices();

    return Response.json({
      success: true,
      devices,
    });
  } catch (error) {
    console.error("Kraken devices request failed:", error);

    return Response.json(
      {
        success: false,
        message:
          error instanceof Error ? error.message : "Unknown Kraken error",
      },
      { status: 500 }
    );
  }
}