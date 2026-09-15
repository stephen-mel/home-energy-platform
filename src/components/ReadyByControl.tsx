"use client";

import { useState } from "react";

type ReadyByControlProps = {
    deviceId: string;
    value: string;
    timeFrom: string;
    timeTo: string;
    timeStep: number;
};

function timeToMinutes(time: string) {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
}

function minutesToTime(totalMinutes: number) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
        2,
        "0"
    )}`;
}

export default function ReadyByControl({
    deviceId,
    value,
    timeFrom,
    timeTo,
    timeStep,
}: ReadyByControlProps) {
    const [selectedTime, setSelectedTime] = useState(value);
    const [isSaving, setIsSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const start = timeToMinutes(timeFrom);
    const end = timeToMinutes(timeTo);

    const options: string[] = [];

    for (let minutes = start; minutes <= end; minutes += timeStep) {
        options.push(minutesToTime(minutes));
    }

    async function handleChange(newTime: string) {
        const previousTime = selectedTime;

        setSelectedTime(newTime);
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
                    readyBy: newTime,
                }),
            });

            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message ?? "Unable to update Ready By");
            }

            setMessage("Saved");
        } catch (error) {
            setSelectedTime(previousTime);

            setMessage(
                error instanceof Error ? error.message : "Unable to update Ready By"
            );
        } finally {
            setIsSaving(false);
        }
    }

    return (
        <div className="mt-2">
            <select
                value={selectedTime}
                disabled={isSaving}
                onChange={(event) => {
                    void handleChange(event.target.value);
                }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-medium text-white disabled:opacity-50"
            >
                {options.map((time) => (
                    <option key={time} value={time}>
                        {time}
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