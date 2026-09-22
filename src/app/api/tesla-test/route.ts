import { captureObservedTariff } from "../../../lib/tesla-tariff/observed-tariff";
import {
    getTeslaProducts,
    getTeslaSiteInfo,
} from "../../../lib/tesla/client";

export async function GET() {
    try {
        const products = await getTeslaProducts();

        const energyProduct = products.response?.find(
            (product: { energy_site_id?: number }) =>
                product.energy_site_id
        );

        if (!energyProduct?.energy_site_id) {
            return Response.json(
                {
                    success: false,
                    message: "No Tesla energy site found",
                },
                { status: 404 }
            );
        }

        const siteInfo = await getTeslaSiteInfo(
            energyProduct.energy_site_id
        );

        return Response.json({
            success: true,
            message: "Tesla Fleet API site info retrieved",
            energySiteId: energyProduct.energy_site_id,
            siteInfo,
            observedTariff: captureObservedTariff(siteInfo, String(energyProduct.energy_site_id), new Date().toISOString()),
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