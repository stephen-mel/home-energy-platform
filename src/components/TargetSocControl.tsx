"use client";

import { useState } from "react";

type TargetSocControlProps = {
    deviceId: string;
    value: number;
    min: number;
    max: number;
    step: number;
};

export default function TargetSocControl({
    deviceId,
    value,
    min,
    max,
    step,
}: TargetSocControlProps) {
    const [selectedTarget, setSelectedTarget] = useState(value);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const options: number[] = [];

    for (let target = min; target <= max; target += step) {
        options.push(target);
    }

    async function handleChange(newTarget: number) {
        const previousTarget = selectedTarget;

        setSelectedTarget(newTarget);
        setIsSaving(true);
        setMessage(null);

        try {
            const response = await fetch("/api/kraken-preferences", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    deviceId,
                    targetSoc: newTarget,
                }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(
                    result.message ?? "Unable to update Target SOC"
                );
            }

            setMessage("Saved");
        } catch (error) {
            setSelectedTarget(previousTarget);

            setMessage(
                error instanceof Error
                    ? error.message
                    : "Unable to update Target SOC"
            );
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <div className="mt-2">
            <select
                value={selectedTarget}
                disabled={isSaving}
                onChange={(event) => {
                    void handleChange(Number(event.target.value));
                }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
                {options.map((target) => (
                    <option key={target} value={target}>
                        {target}%
                    </option>
                ))}
            </select>

            {isSaving && (
                <p className="mt-1 text-xs text-zinc-500">Saving…</p>
            )}

            {!isSaving && message && (
                <p className="mt-1 text-xs text-zinc-500">{message}</p>
            )}
        </div>
    );
}