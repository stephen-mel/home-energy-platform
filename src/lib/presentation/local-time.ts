// Use Intl only for numeric timezone conversion. Assemble text ourselves so ICU
// punctuation, month abbreviations and timezone-name variants cannot affect SSR.
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number) => String(value).padStart(2, "0");

function localParts(timestamp: string, timeZone: string) {
    const date = new Date(timestamp);
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)!.value);
    return { date, year: value("year"), month: value("month"), day: value("day"),
        hour: value("hour"), minute: value("minute"), second: value("second") };
}

export function formatLocalDateTime(timestamp: string, timeZone: string, exact = false): string {
    const p = localParts(timestamp, timeZone);
    const offsetMinutes = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
        - Math.floor(p.date.getTime() / 1000) * 1000) / 60_000);
    const offset = Math.abs(offsetMinutes);
    // Numeric offset is deterministic even where runtimes disagree on short names.
    const zone = `UTC${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
    return `${pad(p.day)} ${months[p.month - 1]}${exact ? ` ${p.year}` : ""}, ${pad(p.hour)}:${pad(p.minute)}${exact ? `:${pad(p.second)}${p.date.getUTCMilliseconds() ? `.${String(p.date.getUTCMilliseconds()).padStart(3, "0")}` : ""}` : ""} ${zone}`;
}

export function isNextLocalMidnight(timestamp: string, asOf: string, timeZone: string): boolean {
    const target = localParts(timestamp, timeZone);
    const current = localParts(asOf, timeZone);
    // Calendar arithmetic, not +24 elapsed hours: DST days can have 23 or 25 hours.
    const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    return target.date.getTime() > current.date.getTime()
        && target.hour === 0 && target.minute === 0 && target.second === 0 && target.date.getUTCMilliseconds() === 0
        && target.year === nextDay.getUTCFullYear() && target.month === nextDay.getUTCMonth() + 1
        && target.day === nextDay.getUTCDate();
}

export function formatLocalTime(timestamp: string, timeZone: string): string {
    const p = localParts(timestamp, timeZone);
    return `${pad(p.hour)}:${pad(p.minute)}`;
}
