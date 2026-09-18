import "server-only";
import type { SiteIntegrationConfig } from "../site/config";

// One read-only upstream connection per viewing tab. No site-state/Kraken imports.
export function createHomeAssistantStream(
    config: SiteIntegrationConfig["homeAssistant"], signal: AbortSignal,
): ReadableStream<Uint8Array> {
    const allowed = new Set((config.assets ?? []).flatMap(a => a.metrics.map(m => m.entityId)));
    let dispose = () => {};
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            let socket: WebSocket | undefined;
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            let pingId = 2;
            let pendingPing: number | null = null;
            let phase = "auth";
            const changed = new Map<string, number | null>();
            const encoder = new TextEncoder();
            const send = (event: string, data: unknown) => {
                if (closed) return;
                if ((controller.desiredSize ?? 0) <= 0) { dispose(); return; }
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            dispose = () => {
                if (closed) return;
                closed = true;
                clearTimeout(deadline);
                clearInterval(heartbeat);
                signal.removeEventListener("abort", dispose);
                socket?.close();
                if (!cancelled) controller.close();
            };
            const fail = (terminal = false) => { send("status", { state: terminal ? "unavailable" : "disconnected" }); dispose(); };
            const armDeadline = () => {
                clearTimeout(deadline);
                deadline = setTimeout(() => fail(), 15_000);
            };
            signal.addEventListener("abort", dispose, { once: true });
            if (signal.aborted) { dispose(); return; }
            const token = process.env.HOME_ASSISTANT_TOKEN;
            const base = process.env.HOME_ASSISTANT_URL;
            if (!config.enabled || !allowed.size || !token || !base) { fail(true); return; }
            try {
                const url = new URL(`${base.replace(/\/$/, "")}/api/websocket`);
                if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { fail(true); return; }
                url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
                socket = new WebSocket(url);
                const ws = socket;
                armDeadline();
                ws.onerror = () => fail();
                ws.onclose = () => fail();
                ws.onmessage = (event) => {
                    if (closed) return;
                    try {
                        const message = JSON.parse(String(event.data));
                        if (message.type === "auth_invalid") { fail(true); return; }
                        if (message.type === "auth_required" && phase === "auth") {
                            phase = "authenticating";
                            ws.send(JSON.stringify({ type: "auth", access_token: token }));
                        } else if (message.type === "auth_ok" && phase === "authenticating") {
                            phase = "subscribing";
                            ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
                        } else if (message.type === "result" && message.id === 1 && phase === "subscribing") {
                            if (!message.success) { fail(true); return; }
                            phase = "snapshot";
                            // Resync after subscribing so readings missed during disconnect are restored.
                            ws.send(JSON.stringify({ id: 2, type: "get_states" }));
                        } else if (message.type === "result" && message.id === 2 && phase === "snapshot") {
                            if (!message.success || !Array.isArray(message.result)) { fail(); return; }
                            const values: Record<string, number | null> = Object.fromEntries([...allowed].map(id => [id, null]));
                            for (const entity of message.result) {
                                if (allowed.has(entity?.entity_id)) values[entity.entity_id] = numeric(entity.state);
                            }
                            // Events received while the snapshot was in flight take precedence.
                            for (const [id, value] of changed) values[id] = value;
                            changed.clear();
                            send("metrics", values);
                            if (closed) return;
                            phase = "live";
                            clearTimeout(deadline);
                            send("status", { state: "live" });
                            if (closed) return;
                            heartbeat = setInterval(() => {
                                if (pendingPing !== null) { fail(); return; }
                                pendingPing = ++pingId;
                                try { ws.send(JSON.stringify({ id: pendingPing, type: "ping" })); }
                                catch { fail(); }
                            }, 20_000);
                        } else if (message.type === "pong" && pendingPing !== null && message.id === pendingPing) {
                            pendingPing = null;
                            send("status", { state: "live" });
                        } else if (message.type === "event" && message.id === 1 && message.event?.event_type === "state_changed") {
                            const data = message.event.data;
                            if (!allowed.has(data?.entity_id)) return;
                            const value = numeric(data.new_state?.state);
                            if (phase === "snapshot") changed.set(data.entity_id, value);
                            else if (phase === "live") send("metrics", { [data.entity_id]: value });
                        }
                    } catch { fail(); }
                };
            } catch { fail(); }
        },
        cancel() { cancelled = true; dispose(); },
    }, { highWaterMark: 64 });
}

function numeric(raw: unknown): number | null {
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
}
