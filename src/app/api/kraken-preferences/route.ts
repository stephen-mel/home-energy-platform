import {
    getKrakenDevices,
    setKrakenVehiclePreferences,
} from "../../../lib/kraken/client";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const deviceId = body.deviceId;
        const readyBy = body.readyBy;

        if (!deviceId || !readyBy) {
            return Response.json(
                {
                    success: false,
                    message: "deviceId and readyBy are required",
                },
                { status: 400 }
            );
        }

        const devices = await getKrakenDevices();

        const device = devices.find((item) => item.id === deviceId);

        if (!device) {
            throw new Error("Vehicle not found");
        }

        if (!device.preferences?.schedules?.length) {
            throw new Error(`${device.name} has no preference schedules`);
        }

        const scheduleSetting =
            device.preferenceSetting?.scheduleSettings?.[0];

        if (!scheduleSetting) {
            throw new Error(`${device.name} has no preference settings`);
        }

        const timeFrom = scheduleSetting.timeFrom?.slice(0, 5);
        const timeTo = scheduleSetting.timeTo?.slice(0, 5);
        const timeStep = scheduleSetting.timeStep;

        if (!timeFrom || !timeTo) {
            throw new Error("Kraken did not provide Ready By constraints");
        }

        const timeToMinutes = (time: string) => {
            const [hours, minutes] = time.split(":").map(Number);
            return hours * 60 + minutes;
        };

        const requestedMinutes = timeToMinutes(readyBy);
        const fromMinutes = timeToMinutes(timeFrom);
        const toMinutes = timeToMinutes(timeTo);

        const isWithinRange =
            requestedMinutes >= fromMinutes &&
            requestedMinutes <= toMinutes;

        const isValidStep =
            (requestedMinutes - fromMinutes) % timeStep === 0;

        if (!isWithinRange || !isValidStep) {
            return Response.json(
                {
                    success: false,
                    message: `Ready By must be between ${timeFrom} and ${timeTo} in ${timeStep}-minute steps`,
                },
                { status: 400 }
            );
        }

        const krakenTime = `${readyBy}:00`;

        const schedules = device.preferences.schedules.map((schedule) => ({
            dayOfWeek: schedule.dayOfWeek,
            time: krakenTime,
            min: schedule.min,
            max: schedule.max ?? 100,
        }));

        const result = await setKrakenVehiclePreferences(
            device.id,
            schedules
        );

        return Response.json({
            success: true,
            message: `${device.name} Ready By changed to ${readyBy}`,
            readyBy,
            result,
        });
    } catch (error) {
        console.error("Kraken preference update failed:", error);

        return Response.json(
            {
                success: false,
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown Kraken error",
            },
            { status: 500 }
        );
    }
}