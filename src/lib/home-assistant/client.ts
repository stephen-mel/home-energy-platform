const HOME_ASSISTANT_URL = process.env.HOME_ASSISTANT_URL;
const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

export async function getHomeAssistantStates() {
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
        throw new Error("Home Assistant is not configured");
    }

    const response = await fetch(
        `${HOME_ASSISTANT_URL}/api/states`,
        {
            headers: {
                Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
                "Content-Type": "application/json",
            },
            cache: "no-store",
        }
    );

    if (!response.ok) {
        throw new Error(
            `Home Assistant HTTP error ${response.status}`
        );
    }

    return response.json();
}
export async function getHomeAssistantState(entityId: string) {
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
        throw new Error("Home Assistant is not configured");
    }

    const response = await fetch(
        `${HOME_ASSISTANT_URL}/api/states/${entityId}`,
        {
            headers: {
                Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
                "Content-Type": "application/json",
            },
            cache: "no-store",
        }
    );

    if (!response.ok) {
        throw new Error(
            `Home Assistant HTTP error ${response.status} for ${entityId}`
        );
    }

    return response.json();
}
export type PowerwallStatus = {
    batterySoc: number;
    solarPower: number;
    housePower: number;
    batteryPower: number;
    gridPower: number;
};

export async function getPowerwallStatus(): Promise<PowerwallStatus> {
    const [
        batterySoc,
        solarPower,
        housePower,
        batteryPower,
        gridPower,
    ] = await Promise.all([
        getHomeAssistantState(
            "sensor.powerwall_192_168_68_74_charge"
        ),
        getHomeAssistantState(
            "sensor.powerwall_192_168_68_74_solar_power"
        ),
        getHomeAssistantState(
            "sensor.powerwall_192_168_68_74_load_power"
        ),
        getHomeAssistantState(
            "sensor.powerwall_192_168_68_74_battery_power"
        ),
        getHomeAssistantState(
            "sensor.powerwall_192_168_68_74_site_power"
        ),
    ]);

    return {
        batterySoc: Number(batterySoc.state),
        solarPower: Number(solarPower.state),
        housePower: Number(housePower.state),
        batteryPower: Number(batteryPower.state),
        gridPower: Number(gridPower.state),
    };
}