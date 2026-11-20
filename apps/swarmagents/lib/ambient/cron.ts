/** Minimal 5-field cron match (minute hour dom month dow). `*` , lists, ranges. */

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    const piece = part.trim();
    if (!piece) return false;
    // Optional /step suffix: `*/n` or `a-b/n`.
    const slash = piece.split("/");
    if (slash.length > 2) return false;
    const base = (slash[0] ?? "").trim();
    const stepPart = slash[1]?.trim();
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return false;
      step = Number(stepPart);
      if (!Number.isInteger(step) || step < 1) return false;
    }
    if (base === "*") {
      if (stepPart === undefined) return true;
    } else {
      const range = base.split("-");
      if (range.length === 1) {
        // A bare value with a step (e.g. `5/2`) is not a supported form.
        if (stepPart !== undefined) return false;
        const n = Number(base);
        if (!Number.isInteger(n) || n < min || n > max) return false;
        if (n === value) return true;
        continue;
      }
      if (range.length !== 2) return false;
      const start = Number(range[0]);
      const end = Number(range[1]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      if (start < min || end > max || start > end) return false;
      if (stepPart === undefined) {
        if (value >= start && value <= end) return true;
        continue;
      }
      if (value < start || value > end) continue;
      if ((value - start) % step === 0) return true;
      continue;
    }
    // `*/n` — step from the field's own minimum.
    const start = min;
    const end = max;
    if (value < start || value > end) continue;
    if ((value - start) % step === 0) return true;
  }
  return false;
}

export interface CronParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** Calendar year in the same zone as the other fields. */
  year: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function cronParts(date: Date, timeZone?: string): CronParts | null {
  if (!timeZone) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
      weekday: date.getUTCDay(),
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    const bag = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
    const weekday = WEEKDAYS.indexOf(bag.weekday as (typeof WEEKDAYS)[number]);
    if (weekday < 0) return null;
    return {
      minute: Number(bag.minute),
      hour: Number(bag.hour),
      day: Number(bag.day),
      month: Number(bag.month),
      year: Number(bag.year),
      weekday,
    };
  } catch {
    return null;
  }
}

/** True when `expr` matches `date`. Invalid expressions and timezones never match. */
export function cronMatches(expr: string, date: Date, timeZone?: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const parts = cronParts(date, timeZone);
  if (!parts) return false;
  const dow = fields[4];
  const dowOk =
    dow === "*"
      ? true
      : fieldMatches(dow, parts.weekday, 0, 7) || (parts.weekday === 0 && fieldMatches(dow, 7, 0, 7));
  return (
    fieldMatches(fields[0], parts.minute, 0, 59) &&
    fieldMatches(fields[1], parts.hour, 0, 23) &&
    fieldMatches(fields[2], parts.day, 1, 31) &&
    fieldMatches(fields[3], parts.month, 1, 12) &&
    dowOk
  );
}

export function cronBucket(date: Date, timeZone?: string): string | null {
  const parts = cronParts(date, timeZone);
  if (!parts) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
