import { getKrakenToken } from "../../../lib/kraken/client";

export async function GET() {
  try {
    await getKrakenToken();

    return Response.json({
      success: true,
      message: "Kraken authentication successful",
    });
  } catch (error) {
    console.error("Kraken authentication test failed:", error);

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