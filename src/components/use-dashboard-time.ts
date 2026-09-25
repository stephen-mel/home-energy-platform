"use client";
import { useEffect, useState } from "react";

// Local clock only: no retrieval, router refresh or additional Kraken polling.
// The initial SSR timestamp also seeds hydration before the clock starts.
export function useDashboardTime(initial: string) {
    const [now, setNow] = useState(initial);
    useEffect(() => {
        const tick = () => setNow(new Date().toISOString());
        tick();
        const timer = setInterval(tick, 30_000);
        return () => clearInterval(timer);
    }, [initial]);
    return now;
}
