export type LiveStatus = "connecting" | "live" | "disconnected" | "unavailable";

export function watchHomeAssistant(
    onMetrics: (values: Record<string, number | null>) => void,
    onStatus: (status: LiveStatus) => void,
) {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let attempts = 0;
    let connectedAt = 0;
    const disconnect = () => {
        source?.close();
        clearTimeout(watchdog);
        if (stopped || retry) return;
        onStatus("disconnected");
        // Reset only after a stable minute, not after briefly opening a socket.
        if (connectedAt && Date.now() - connectedAt >= 60_000) attempts = 0;
        connectedAt = 0;
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempts++, 5));
        retry = setTimeout(() => { retry = undefined; connect(); }, delay + Math.random() * 1_000);
    };
    const touch = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(disconnect, 50_000);
    };
    const connect = () => {
        if (stopped) return;
        try {
            source = new EventSource("/api/home-assistant-stream");
            touch();
            source.addEventListener("metrics", event => {
                try {
                    const values = JSON.parse((event as MessageEvent).data);
                    if (!values || Array.isArray(values) || typeof values !== "object") return;
                    if (!Object.values(values).every(v => v === null || (typeof v === "number" && Number.isFinite(v)))) return;
                    onMetrics(values);
                    touch();
                } catch { disconnect(); }
            });
            source.addEventListener("status", event => {
                try {
                    const { state } = JSON.parse((event as MessageEvent).data);
                    if (state === "unavailable") {
                        stopped = true;
                        source?.close();
                        clearTimeout(watchdog);
                        onStatus("unavailable");
                    } else if (state === "disconnected") disconnect();
                    else if (state === "live") {
                        if (!connectedAt) connectedAt = Date.now();
                        onStatus("live");
                        touch();
                    }
                } catch { disconnect(); }
            });
            source.onerror = disconnect;
        } catch { disconnect(); }
    };
    connect();
    return () => { stopped = true; source?.close(); clearTimeout(retry); clearTimeout(watchdog); };
}
