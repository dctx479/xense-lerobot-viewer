import { describe, expect, test } from "bun:test";
import {
  reviewTimestamp,
  REVIEW_TIME_ZONE,
  reviewDateRange,
  reviewDayBounds,
} from "../reviewTime";

describe("review UTC+8 timestamps", () => {
  test("day bounds include midnight and exclude the next midnight across calendar boundaries", () => {
    for (const [day, next] of [
      ["2026-10-31", "2026-11-01"],
      ["2026-12-31", "2027-01-01"],
      ["2028-02-28", "2028-02-29"],
      ["2028-02-29", "2028-03-01"],
    ]) {
      const bounds = reviewDayBounds(day);
      expect(bounds).toEqual({
        startInclusive: day + "T00:00:00.000+08:00",
        endExclusive: next + "T00:00:00.000+08:00",
      });
      expect(
        Date.parse(bounds.endExclusive) - Date.parse(bounds.startInclusive),
      ).toBe(86400000);
    }
    for (const invalid of [
      "",
      "2026-02-29",
      "2026-13-01",
      "2026-1-01",
      "tomorrow",
    ]) {
      expect(() => reviewDayBounds(invalid)).toThrow("Invalid review date");
    }
  });
  test("uses the fixed inspection timezone", () => {
    expect(REVIEW_TIME_ZONE).toBe("Asia/Shanghai");
  });
  test("defaults to midnight today through midnight tomorrow across UTC midnight", () => {
    expect(
      reviewDateRange(undefined, new Date("2026-10-31T15:59:59Z")),
    ).toEqual({ startDate: "2026-10-31", endDate: "2026-11-01" });
    expect(
      reviewDateRange(undefined, new Date("2026-10-31T16:00:00Z")),
    ).toEqual({ startDate: "2026-11-01", endDate: "2026-11-02" });
    expect(
      reviewDateRange("last7days", new Date("2026-12-31T20:00:00Z")),
    ).toEqual({ startDate: "2026-12-26", endDate: "2027-01-02" });
    expect(reviewDateRange("all")).toEqual({ startDate: "", endDate: "" });
  });
  test("preserves milliseconds and rolls across calendar boundaries", () => {
    expect(reviewTimestamp("2026-12-31T20:30:00.125Z")).toBe(
      "2027-01-01T04:30:00.125+08:00",
    );
    expect(reviewTimestamp(new Date("2026-10-29T06:00:00Z"))).toBe(
      "2026-10-29T14:00:00.000+08:00",
    );
  });
  test("normalizes offsets without changing the instant or converting twice", () => {
    const input = "2026-10-29T14:00:00.000+08:00";
    expect(reviewTimestamp(input)).toBe(input);
    expect(reviewTimestamp(reviewTimestamp(input))).toBe(input);
    expect(reviewTimestamp("2026-10-29T02:00:00-04:00")).toBe(input);
    expect(Date.parse(reviewTimestamp(input))).toBe(Date.parse(input));
  });
  test("new timestamps use an explicit offset and invalid timestamps fail", () => {
    expect(reviewTimestamp()).toMatch(/\+08:00$/);
    expect(() => reviewTimestamp("invalid")).toThrow(
      "Invalid review timestamp",
    );
  });
});
