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

function configured() {
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) throw new Error("Home Assistant is not configured");
    return { base: HOME_ASSISTANT_URL.replace(/\/$/, ""), token: HOME_ASSISTANT_TOKEN };
}

async function haJson(url: string, init?: RequestInit) {
    const { token } = configured();
    const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`,
        "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Home Assistant HTTP error ${response.status}`);
    return response.json();
}

export async function getHomeAssistantFiveMinuteStatistics(entityIds: string[], start: string, end: string) {
    const { base, token } = configured();
    const url = new URL(`${base}/api/websocket`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Home Assistant URL");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new Promise<unknown>((resolve, reject) => {
        const socket = new WebSocket(url);
        let settled = false;
        const finish = (error: Error | null, value?: unknown) => {
            if (settled) return; settled = true; clearTimeout(timeout); socket.close();
            if (error) reject(error); else resolve(value);
        };
        const timeout = setTimeout(() => finish(new Error("Home Assistant statistics timeout")), 5_000);
        socket.onerror = () => finish(new Error("Home Assistant statistics transport failed"));
        socket.onclose = () => finish(new Error("Home Assistant statistics connection closed"));
        socket.onmessage = event => {
            try {
                const message = JSON.parse(String(event.data));
                if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
                else if (message.type === "auth_invalid") finish(new Error("Home Assistant statistics authentication failed"));
                else if (message.type === "auth_ok") socket.send(JSON.stringify({ id: 1,
                    type: "recorder/statistics_during_period", start_time: start, end_time: end,
                    statistic_ids: entityIds, period: "5minute", types: ["change", "state", "sum"] }));
                else if (message.type === "result" && message.id === 1) {
                    if (message.success) finish(null, message.result);
                    else finish(new Error("Home Assistant statistics request failed"));
                }
            } catch { finish(new Error("Home Assistant statistics response invalid")); }
        };
    });
}

export async function getHomeAssistantCounterHistory(entityIds: string[], start: string, end: string) {
    const { base } = configured();
    const query = new URLSearchParams({ end_time: end, filter_entity_id: entityIds.join(","), no_attributes: "" });
    return haJson(`${base}/api/history/period/${encodeURIComponent(start)}?${query}`);
}
