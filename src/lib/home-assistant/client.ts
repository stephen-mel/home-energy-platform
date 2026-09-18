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
            signal: AbortSignal.timeout(5_000),
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
            signal: AbortSignal.timeout(5_000),
        }
    );

    if (!response.ok) {
        throw new Error(
            `Home Assistant HTTP error ${response.status} for ${entityId}`
        );
    }

    return response.json();
}
