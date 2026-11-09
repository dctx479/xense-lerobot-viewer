import { describe, expect, test } from "bun:test";
import {
  calendarDateRange,
  calendarDateInputRange,
  calendarDateTime,
  calendarDayBounds,
  calendarDaySpanOverlaps,
  calendarDayDifference,
  calendarDayInRange,
  calendarDayKey,
  calendarDays,
  calendarDayStart,
  calendarTimestamp,
  formatCalendarDateTime,
  isCalendarDay,
  parseCalendarTimestamp,
  shiftCalendarDay,
  tryCalendarDayKey,
} from "../calendarTime";
import {
  workbenchDayKey,
  getWorkbenchDateTimeRangeShortcut,
  workbenchDatasetSuffixDay,
  filterWorkbenchDatasetsByDate,
} from "../workbenchRollup";
import { matchesDate } from "../corpusFilters";
import { computeWorkbenchReviewStatistics } from "../workbenchReviewStatistics";
import type { LocalDatasetSummary } from "@/lib/local-datasets-discovery";
import { dayKey } from "../corpusHistory";
import { reviewDateRange, reviewTimestamp } from "../reviewTime";
import { normalizeWorkbenchScoreDay } from "@/lib/workbench-score-batch";
import {
  parsePublisherAnalytics,
  aggregateAdvancedLogs,
} from "@/lib/tacverse-impact";

describe("shared project calendar", () => {
  test("date selections are their own midnight without advancing either endpoint", () => {
    for (const range of [
      { startDate: "2026-11-01", endDate: "2026-11-02" },
      { startDate: "2026-11-01", endDate: "2026-11-01" },
      { startDate: "2026-12-31", endDate: "2027-01-01" },
      { startDate: "2028-02-29", endDate: "2028-03-01" },
      { startDate: "", endDate: "2026-11-02" },
      { startDate: "2026-11-01", endDate: "" },
    ]) {
      expect(calendarDateInputRange(range)).toEqual(range);
      for (const day of Object.values(range).filter(Boolean))
        expect(calendarDateTime(day)).toBe(day + "T00:00");
    }
    expect(calendarDateInputRange({})).toEqual({ startDate: "", endDate: "" });
    expect(() => calendarDateInputRange({ endDate: "2026-02-29" })).toThrow();
  });

  test("review, Workbench and corpus filters agree on selected midnight endpoints", () => {
    const days = ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"];
    const datasets: LocalDatasetSummary[] = days.map((day) => ({
      relativePath:
        "TacVerse/taccap-g1-fixture-" + day.replaceAll("-", "").slice(2),
      encodedPath: day,
      codebase_version: "v3.0",
      robot_type: "g1",
      total_episodes: 1,
      total_frames: 30,
      fps: 30,
      sizeBytes: 100,
      thumbnailVideoUrl: null,
      integrity: {
        hasData: true,
        hasVideos: true,
        hasEpisodes: true,
        status: "ok",
      },
      tags: { task: null, scene: null, objects: [] },
      facets: {
        bucket: null,
        capturedFrom: day,
        capturedTo: day,
        dateEvidence: "name",
        shapeAnomaly: false,
        stateDim: null,
        videoStreams: 0,
        headStreams: 0,
      },
    }));
    const records = {
      version: 1 as const,
      datasets: {
        fixture: {
          version: 1 as const,
          episodes: Object.fromEntries(
            days.map((day, index) => [
              String(index),
              [
                {
                  reviewer: "Alice",
                  source: "episodes" as const,
                  reviewed_at: day + "T00:00:00+08:00",
                },
              ],
            ]),
          ),
        },
      },
    };
    for (const [startDate, endDate, expected] of [
      ["2026-11-01", "2026-11-02", ["2026-11-01"]],
      ["2026-11-01", "2026-11-03", ["2026-11-01", "2026-11-02"]],
      ["2026-11-01", "2026-11-01", []],
      ["", "2026-11-02", ["2026-10-31", "2026-11-01"]],
      ["2026-11-02", "", ["2026-11-02", "2026-11-03"]],
    ] as const) {
      const range = calendarDateInputRange({ startDate, endDate });
      expect(
        computeWorkbenchReviewStatistics(records, range).daily.map(
          (row) => row.day,
        ),
      ).toEqual([...expected]);
      expect(
        filterWorkbenchDatasetsByDate(datasets, range).map(
          (row) => row.facets!.capturedFrom,
        ),
      ).toEqual([...expected]);
      expect(
        datasets
          .filter((row) =>
            matchesDate(row, { mode: "range", from: startDate, to: endDate }),
          )
          .map((row) => row.facets.capturedFrom),
      ).toEqual([...expected]);
    }
    const now = new Date("2026-11-01T16:00:00Z");
    for (const preset of ["today", "last7days", "all"] as const)
      expect(reviewDateRange(preset, now)).toEqual(
        calendarDateRange(preset, now),
      );
    expect(
      calendarDaySpanOverlaps("2026-10-31", "2026-11-03", {
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      }),
    ).toBe(false);
    expect(
      calendarDaySpanOverlaps("2026-11-02", "2026-11-03", {
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      }),
    ).toBe(false);
  });

  test("publisher downloads and request logs split at the same project midnight", () => {
    const repositories = new Set(["TacVerse/fixture"]);
    const publisher = parsePublisherAnalytics(
      [
        "timestamp,repoType,repoName,downloads,total",
        "2026-11-01T15:59:59Z,dataset,TacVerse/fixture,2,2",
        "2026-11-01T16:00:00Z,dataset,TacVerse/fixture,3,5",
      ].join("\n"),
      repositories,
    );
    expect(publisher.daily).toEqual([
      { date: "2026-11-01", downloads: 2 },
      { date: "2026-11-02", downloads: 3 },
    ]);
    const requests = aggregateAdvancedLogs(
      [
        "timestamp,repoType,repoName,method,status,hashedUserId,country",
        "2026-11-01T15:59:59Z,dataset,TacVerse/fixture,GET,200,person,CN",
        "2026-11-01T16:00:00Z,dataset,TacVerse/fixture,GET,200,person,CN",
      ].join("\n"),
      new Set(),
      repositories,
    );
    expect([...requests.byDate.keys()]).toEqual(["2026-11-01", "2026-11-02"]);
  });

  test("all day consumers agree on both sides of UTC+8 midnight", () => {
    for (const [input, expected] of [
      ["2026-11-01T15:59:59.999Z", "2026-11-01"],
      ["2026-11-01T16:00:00.000Z", "2026-11-02"],
      ["2026-11-02T01:00:00+09:00", "2026-11-02"],
      ["2026-11-01T12:00:00-04:00", "2026-11-02"],
      ["2026-11-02T00:00", "2026-11-02"],
    ]) {
      const time = parseCalendarTimestamp(input)!;
      expect(calendarDayKey(input)).toBe(expected);
      expect(workbenchDayKey(input)).toBe(expected);
      expect(dayKey(new Date(time))).toBe(expected);
      expect(reviewTimestamp(input).slice(0, 10)).toBe(expected);
      expect(normalizeWorkbenchScoreDay(input)).toBe(expected);
    }
  });

  test("date-only values and timezone-less inputs always mean UTC+8", () => {
    expect(calendarDayStart("2026-11-02")).toBe(
      Date.parse("2026-11-01T16:00:00Z"),
    );
    expect(parseCalendarTimestamp("2026-11-02T01:30")).toBe(
      Date.parse("2026-11-01T17:30:00Z"),
    );
    expect(parseCalendarTimestamp("2026-11-02 01:30:15.123")).toBe(
      Date.parse("2026-11-01T17:30:15.123Z"),
    );
    expect(calendarDateTime("2026-11-01T17:30:00Z")).toBe("2026-11-02T01:30");
    expect(calendarTimestamp("2026-11-01T17:30:00.123Z")).toBe(
      "2026-11-02T01:30:00.123+08:00",
    );
    expect(calendarDayKey("2026-11-02")).toBe("2026-11-02");
  });

  test("all presets use the same half-open calendar boundaries", () => {
    const now = new Date("2026-11-01T16:00:00Z");
    for (const [preset, start, end] of [
      ["today", "2026-11-02", "2026-11-03"],
      ["yesterday", "2026-11-01", "2026-11-02"],
      ["last7days", "2026-10-27", "2026-11-03"],
      ["thisWeek", "2026-11-02", "2026-11-03"],
      ["lastWeek", "2026-10-26", "2026-11-02"],
    ] as const)
      expect(calendarDateRange(preset, now)).toEqual({
        startDate: start,
        endDate: end,
      });
    expect(getWorkbenchDateTimeRangeShortcut("today", now)).toEqual({
      startDateTime: "2026-11-02T00:00",
      endDateTime: "2026-11-03T00:00",
    });
    expect(reviewDateRange("today", now)).toEqual({
      startDate: "2026-11-02",
      endDate: "2026-11-03",
    });
    expect(calendarDateRange("all", now)).toEqual({
      startDate: "",
      endDate: "",
    });
  });

  test("calendar arithmetic handles leap days, months, years and exclusive ends", () => {
    expect(shiftCalendarDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftCalendarDay("2028-02-29", 1)).toBe("2028-03-01");
    expect(shiftCalendarDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(calendarDayDifference("2026-12-31", "2027-01-02")).toBe(2);
    expect(calendarDays("2028-02-28", "2028-03-01")).toEqual([
      "2028-02-28",
      "2028-02-29",
    ]);
    expect(calendarDayInRange("2026-11-02", "2026-11-02", "2026-11-03")).toBe(
      true,
    );
    expect(calendarDayInRange("2026-11-03", "2026-11-02", "2026-11-03")).toBe(
      false,
    );
    expect(calendarDayInRange("2026-11-01", "2026-11-02", "2026-11-03")).toBe(
      false,
    );
    expect(calendarDayBounds("2026-12-31")).toEqual({
      startInclusive: "2026-12-31T00:00:00.000+08:00",
      endExclusive: "2027-01-01T00:00:00.000+08:00",
    });
  });

  test("rejects impossible dates and times instead of silently rolling them forward", () => {
    for (const invalid of [
      "2026-02-29",
      "2026-13-01",
      "2026-11-31",
      "2026-1-01",
      "not-a-date",
      "2026-11-02T24:00",
      "2026-11-02T01:60",
    ]) {
      expect(isCalendarDay(invalid)).toBe(false);
      expect(parseCalendarTimestamp(invalid)).toBeNull();
      expect(tryCalendarDayKey(invalid)).toBeNull();
    }
    expect(calendarDays("invalid", "2026-11-02")).toEqual([]);
    expect(calendarDayDifference("invalid", "2026-11-02")).toBeNull();
    expect(() => shiftCalendarDay("2026-11-02", 0.5)).toThrow();
    expect(tryCalendarDayKey(null)).toBeNull();
    expect(tryCalendarDayKey(new Date(NaN))).toBeNull();
  });

  test("catalog year inference and localized formatting use the same calendar", () => {
    expect(
      workbenchDatasetSuffixDay("TacVerse/task-0101", "2026-12-31T16:30:00Z"),
    ).toBe("2027-01-01");
    expect(
      formatCalendarDateTime("2026-11-01T16:00:00Z", "en-GB", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    ).toBe("02/11/2026");
    expect(formatCalendarDateTime("invalid", "en-GB")).toBe("—");
  });

  test("results are identical in UTC, Shanghai and Los Angeles processes", () => {
    const script = [
      "import {calendarDayKey, calendarDateRange, calendarDateTime} from " +
        JSON.stringify(
          new URL("../calendarTime.ts", import.meta.url).pathname,
        ) +
        ";",
      "import {workbenchDayKey, getWorkbenchDateTimeRangeShortcut} from " +
        JSON.stringify(
          new URL("../workbenchRollup.ts", import.meta.url).pathname,
        ) +
        ";",
      'const now=new Date("2026-11-01T16:00:00Z"); console.log(JSON.stringify([calendarDayKey(now),workbenchDayKey(now.toISOString()),calendarDateTime("2026-11-02T00:00"),calendarDateRange("last7days",now),getWorkbenchDateTimeRangeShortcut("today",now)]));',
    ].join("\n");
    const results = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map(
      (TZ) => {
        const child = Bun.spawnSync([process.execPath, "-e", script], {
          env: { ...process.env, TZ },
        });
        expect(child.exitCode).toBe(0);
        return JSON.parse(child.stdout.toString());
      },
    );
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0][0]).toBe("2026-11-02");
  });
});
