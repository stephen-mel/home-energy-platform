import {
    getKrakenDevices,
    getKrakenPlannedDispatches,
    getKrakenVehicleStatus,
} from "../../../lib/kraken/client";

export async function GET() {
    try {
        const devices = await getKrakenDevices();

        const vehicles = await Promise.all(
            devices.map(async (device) => ({
                ...device,
                status: await getKrakenVehicleStatus(device.id),
                plannedDispatches: await getKrakenPlannedDispatches(device.id),
            }))
        );

        return Response.json({
            success: true,
            vehicles,
        });
    } catch (error) {
        console.error("Kraken status request failed:", error);

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