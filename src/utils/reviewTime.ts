import {
  CALENDAR_TIME_ZONE,
  calendarTimestamp,
  calendarDateRange,
  calendarDayBounds,
} from "@/utils/calendarTime";

/** Compatibility names; all calendar rules live in calendarTime. */
export const REVIEW_TIME_ZONE = CALENDAR_TIME_ZONE;

export function reviewTimestamp(input: string | Date = new Date()): string {
  try {
    return calendarTimestamp(input);
  } catch {
    throw new Error("Invalid review timestamp");
  }
}

/** Calendar-day filters use the same UTC+8 boundary as the inspection records. */
export function reviewDateRange(
  preset: "today" | "last7days" | "all" = "today",
  now: Date = new Date(),
) {
  return calendarDateRange(preset, now);
}

/** An inspection day is [00:00, next day 00:00) in fixed UTC+8. */
export function reviewDayBounds(day: string) {
  try {
    return calendarDayBounds(day);
  } catch {
    throw new Error("Invalid review date");
  }
}
