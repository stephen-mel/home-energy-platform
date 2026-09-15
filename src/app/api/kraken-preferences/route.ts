import {
    getKrakenDevices,
    setKrakenVehiclePreferences,
} from "../../../lib/kraken/client";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const deviceId = body.deviceId;
        const readyBy = body.readyBy;
        const targetSoc = body.targetSoc;

        if (!deviceId) {
            return Response.json(
                {
                    success: false,
                    message: "deviceId is required",
                },
                { status: 400 }
            );
        }

        if (readyBy === undefined && targetSoc === undefined) {
            return Response.json(
                {
                    success: false,
                    message: "readyBy or targetSoc is required",
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

        let newReadyBy =
            device.preferences.schedules[0].time.slice(0, 5);

        let newTargetSoc =
            device.preferences.schedules[0].max ?? 100;

        if (readyBy !== undefined) {
            const timeFrom = scheduleSetting.timeFrom?.slice(0, 5);
            const timeTo = scheduleSetting.timeTo?.slice(0, 5);
            const timeStep = scheduleSetting.timeStep;

            if (!timeFrom || !timeTo) {
                throw new Error(
                    "Kraken did not provide Ready By constraints"
                );
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

            newReadyBy = readyBy;
        }

        if (targetSoc !== undefined) {
            const targetMin =
                scheduleSetting.min !== null
                    ? Number(scheduleSetting.min)
                    : null;

            const targetMax =
                scheduleSetting.max !== null
                    ? Number(scheduleSetting.max)
                    : null;

            const targetStep = Number(scheduleSetting.step);

            if (targetMin === null || targetMax === null) {
                throw new Error(
                    "Kraken did not provide Target SOC constraints"
                );
            }

            const requestedTarget = Number(targetSoc);

            const isWithinRange =
                requestedTarget >= targetMin &&
                requestedTarget <= targetMax;

            const isValidStep =
                (requestedTarget - targetMin) % targetStep === 0;

            if (
                !Number.isFinite(requestedTarget) ||
                !isWithinRange ||
                !isValidStep
            ) {
                return Response.json(
                    {
                        success: false,
                        message: `Target SOC must be between ${targetMin}% and ${targetMax}% in ${targetStep}% steps`,
                    },
                    { status: 400 }
                );
            }

            newTargetSoc = requestedTarget;
        }

        const krakenTime = `${newReadyBy}:00`;

        const schedules = device.preferences.schedules.map((schedule) => ({
            dayOfWeek: schedule.dayOfWeek,
            time: krakenTime,
            min: schedule.min,
            max: newTargetSoc,
        }));

        const result = await setKrakenVehiclePreferences(
            device.id,
            schedules
        );

        return Response.json({
            success: true,
            message: `${device.name} preferences updated`,
            readyBy: newReadyBy,
            targetSoc: newTargetSoc,
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