import { getTeslaProducts } from "../../../lib/tesla/client";

export async function GET() {
    try {
        const products = await getTeslaProducts();

        return Response.json({
            success: true,
            message: "Tesla Fleet API connection successful",
            products,
        });
    } catch (error) {
        console.error("Tesla Fleet API test failed:", error);

        return Response.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown Tesla Fleet API error",
            },
            { status: 500 }
        );
    }
}