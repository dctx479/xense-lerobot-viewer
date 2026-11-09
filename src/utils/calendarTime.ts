/**
 * Project calendar: fixed UTC+8, independent of server/browser timezone.
 * All internal ranges are [startInclusive, endExclusive). A date-only value
 * denotes its UTC+8 midnight; a timezone-less datetime is also UTC+8.
 * Explicit offsets describe instants and are converted before grouping.
 */
export const CALENDAR_TIME_ZONE = "Asia/Shanghai";
export const CALENDAR_OFFSET = "+08:00";
export const CALENDAR_DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 60 * 60 * 1000;

export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const time = Date.parse(value + "T00:00:00Z");
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

export function calendarDayStart(day: string): number | null {
  return isCalendarDay(day)
    ? Date.parse(day + "T00:00:00" + CALENDAR_OFFSET)
    : null;
}

export function parseCalendarTimestamp(
  input: string | Date | number,
): number | null {
  if (input instanceof Date || typeof input === "number") {
    const time = input instanceof Date ? input.getTime() : input;
    return Number.isFinite(new Date(time).getTime()) ? time : null;
  }
  const value = input
    .trim()
    .replace(/\s*T\s*/iu, "T")
    .replace(/\s*Z$/iu, "Z");
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/iu.exec(
      value,
    );
  if (!match || !isCalendarDay(match[1])) return null;
  if (
    match[2] &&
    (Number(match[2]) > 23 ||
      Number(match[3]) > 59 ||
      Number(match[4] ?? 0) > 59)
  )
    return null;
  const normalized = match[2]
    ? value.replace(" ", "T") + (match[6] ? "" : CALENDAR_OFFSET)
    : value + "T00:00:00" + CALENDAR_OFFSET;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

export function calendarTimestamp(
  input: string | Date | number = new Date(),
): string {
  const time = parseCalendarTimestamp(input);
  if (time === null) throw new Error("Invalid calendar timestamp");
  return new Date(time + OFFSET_MS)
    .toISOString()
    .replace(/Z$/u, CALENDAR_OFFSET);
}

export function calendarDayKey(
  input: string | Date | number = new Date(),
): string {
  return calendarTimestamp(input).split("T")[0];
}

export function tryCalendarDayKey(input: unknown): string | null {
  if (
    !(input instanceof Date) &&
    typeof input !== "string" &&
    typeof input !== "number"
  )
    return null;
  const time = parseCalendarTimestamp(input);
  return time === null ? null : calendarDayKey(time);
}

/** Value for datetime-local inputs; its timezone is always CALENDAR_TIME_ZONE. */
export function calendarDateTime(input: string | Date | number): string {
  return calendarTimestamp(input).slice(0, 16);
}

export function formatCalendarDateTime(
  input: string | Date | number | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  },
): string {
  const time =
    input === null || input === undefined
      ? null
      : parseCalendarTimestamp(input);
  return time === null
    ? "—"
    : new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: CALENDAR_TIME_ZONE,
        hour12: false,
      }).format(time);
}

export function shiftCalendarDay(day: string, days: number): string {
  const time = calendarDayStart(day);
  if (time === null || !Number.isInteger(days))
    throw new Error("Invalid calendar date");
  return calendarDayKey(time + days * CALENDAR_DAY_MS);
}

export function calendarDayBounds(day: string) {
  const start = calendarDayStart(day);
  if (start === null) throw new Error("Invalid calendar date");
  return {
    startInclusive: calendarTimestamp(start),
    endExclusive: calendarTimestamp(start + CALENDAR_DAY_MS),
  };
}

export function calendarDayDifference(from: string, to: string): number | null {
  const start = calendarDayStart(from);
  const end = calendarDayStart(to);
  return start === null || end === null
    ? null
    : (end - start) / CALENDAR_DAY_MS;
}

export function calendarDays(start: string, endExclusive: string): string[] {
  const from = calendarDayStart(start);
  const to = calendarDayStart(endExclusive);
  if (from === null || to === null) return [];
  const result: string[] = [];
  for (let time = from; time < to; time += CALENDAR_DAY_MS)
    result.push(calendarDayKey(time));
  return result;
}

export function calendarDayInRange(
  day: string,
  start: string | null,
  endExclusive: string | null,
): boolean {
  return (
    isCalendarDay(day) &&
    (!start || day >= start) &&
    (!endExclusive || day < endExclusive)
  );
}

type CalendarRange = {
  startDate?: string | null;
  endDate?: string | null;
};

/** Every selected date denotes that day's UTC+8 midnight, without end-day shifts. */
export function calendarDateInputRange({ startDate, endDate }: CalendarRange) {
  for (const day of [startDate, endDate])
    if (day && !isCalendarDay(day)) throw new Error("Invalid calendar date");
  return { startDate: startDate || "", endDate: endDate || "" };
}

/** A dataset's first/last capture days overlap the selected half-open range. */
export function calendarDaySpanOverlaps(
  from: string,
  to: string,
  range: CalendarRange,
): boolean {
  const { startDate, endDate } = calendarDateInputRange(range);
  return (
    isCalendarDay(from) &&
    isCalendarDay(to) &&
    from <= to &&
    (!startDate || !endDate || startDate < endDate) &&
    (!startDate || to >= startDate) &&
    (!endDate || from < endDate)
  );
}

export function calendarDateRange(
  preset:
    | "today"
    | "yesterday"
    | "last7days"
    | "thisWeek"
    | "lastWeek"
    | "all" = "today",
  now: Date = new Date(),
) {
  if (preset === "all") return { startDate: "", endDate: "" };
  const today = calendarDayKey(now);
  let startDate = today;
  let endDate = shiftCalendarDay(today, 1);
  if (preset === "yesterday") {
    startDate = shiftCalendarDay(today, -1);
    endDate = today;
  } else if (preset === "last7days") startDate = shiftCalendarDay(today, -6);
  else if (preset === "thisWeek" || preset === "lastWeek") {
    // A date-only UTC construction is calendar arithmetic, never instant grouping.
    const weekday = new Date(today + "T00:00:00Z").getUTCDay();
    startDate = shiftCalendarDay(today, -((weekday + 6) % 7));
    if (preset === "lastWeek") {
      endDate = startDate;
      startDate = shiftCalendarDay(startDate, -7);
    }
  }
  return { startDate, endDate };
}
