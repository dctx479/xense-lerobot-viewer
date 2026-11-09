import { describe, expect, test } from "bun:test";
import type {
  EpisodeReview,
  ReviewCollectionFile,
} from "@/types/episode-review.types";
import {
  buildWorkbenchReviewDailyChart,
  computeWorkbenchReviewStatistics,
  ReviewStatisticsFilterError,
  workbenchReviewStatisticsCsv,
  type ReviewMetrics,
} from "@/utils/workbenchReviewStatistics";

const mark = (reviewer: string, reviewed_at: string): EpisodeReview => ({
  reviewer,
  reviewed_at,
  source: "episodes",
});

function collection(): ReviewCollectionFile {
  return {
    version: 1,
    updated_at: "2026-11-01T01:00:00+08:00",
    datasets: {
      "TacVerse/dataset-a": {
        version: 1,
        episodes: {
          "0": [
            mark("Alice", "2026-10-30T23:50:00+08:00"),
            mark("Bob", "2026-10-31T00:15:00+08:00"),
            mark("Carol", "2026-11-01T01:00:00+08:00"),
          ],
          "1": [mark("Alice", "2026-10-31T08:00:00+08:00")],
          "2": [],
        },
      },
      "TacVerse/dataset-b": {
        version: 1,
        episodes: { "0": [mark("Bob", "2026-10-30T16:30:00Z")] },
      },
      "empty-dataset": { version: 1, episodes: {} },
    },
  };
}

describe("Workbench inspection statistics", () => {
  test("dwell snapshots remain separate from content weights and coverage in every aggregate", () => {
    const input: ReviewCollectionFile = {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: {
            "0": [
              {
                ...mark("Alice", "2026-10-31T16:00:00Z"),
                stay_ms: 0,
                episode_duration_ms: 10000,
              },
              {
                ...mark("Bob", "2026-11-01T15:59:59.999Z"),
                stay_ms: 5000,
                episode_duration_ms: 20000,
              },
            ],
            "1": [mark("Alice", "2026-11-01T08:00:00+08:00")],
            "2": [
              {
                ...mark("Charlie", "2026-11-01T16:00:00Z"),
                stay_ms: 10000,
                episode_duration_ms: 30000,
              },
            ],
          },
        },
      },
    };
    const metrics: ReviewMetrics = {
      dataset: {
        totalEpisodes: 3,
        episodeManifestComplete: true,
        totalFrames: 1800,
        totalDurationSeconds: 60,
        totalSizeBytes: 600,
        episodes: Object.fromEntries(
          [10, 20, 30].map((durationSeconds, i) => [
            String(i),
            {
              frames: durationSeconds * 30,
              durationSeconds,
              sizeBytes: durationSeconds * 10,
              sizeEstimated: false,
            },
          ]),
        ),
      },
    };
    const filter = { startDate: "2026-11-01", endDate: "2026-11-02" };
    const selected = computeWorkbenchReviewStatistics(input, filter, metrics);
    const expected = {
      records: 3,
      knownRecords: 2,
      milliseconds: 5000,
      episodeDurationMilliseconds: 30000,
    };
    expect(selected.dwellTime).toEqual(expected);
    expect(selected.datasets[0].dwellTime).toEqual(expected);
    expect(selected.daily[0].dwellTime).toEqual(expected);
    expect(selected.workload.durationSeconds).toBe(40);
    expect(selected.uniqueWorkload.durationSeconds).toBe(30);
    expect(selected.datasetCoverage.measures.durationSeconds.ratio).toBe(0.5);
    const alice = selected.people.find((row) => row.reviewer === "Alice")!;
    expect(alice.dwellTime).toEqual({
      records: 2,
      knownRecords: 1,
      milliseconds: 0,
      episodeDurationMilliseconds: 10000,
    });
    for (const person of selected.people)
      expect(
        selected.personDaily.find((row) => row.reviewer === person.reviewer)!
          .dwellTime,
      ).toEqual(person.dwellTime);
    expect(
      computeWorkbenchReviewStatistics(
        input,
        { ...filter, reviewer: "Bob" },
        metrics,
      ).dwellTime.milliseconds,
    ).toBe(5000);
    expect(
      computeWorkbenchReviewStatistics(input, {}, metrics).dwellTime
        .milliseconds,
    ).toBe(15000);
    const legacy = structuredClone(input);
    for (const records of Object.values(legacy.datasets.dataset.episodes))
      for (const record of records) {
        delete record.stay_ms;
        delete record.episode_duration_ms;
      }
    const before = computeWorkbenchReviewStatistics(legacy, filter, metrics);
    expect(selected.workload).toEqual(before.workload);
    expect(selected.uniqueWorkload).toEqual(before.uniqueWorkload);
    expect(selected.datasetCoverage).toEqual(before.datasetCoverage);
    expect(selected.cumulativeDatasetCoverage).toEqual(
      before.cumulativeDatasetCoverage,
    );
    const chart = buildWorkbenchReviewDailyChart(selected, "dwellSeconds");
    expect(chart.find((row) => row.reviewer === "Alice")!.value).toBeNull();
    expect(chart.find((row) => row.reviewer === "Bob")!.value).toBe(
      5000 / 3_600_000,
    );
    const zero = computeWorkbenchReviewStatistics({
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: { "0": [input.datasets.dataset.episodes["0"][0]] },
        },
      },
    });
    expect(buildWorkbenchReviewDailyChart(zero, "dwellSeconds")[0].value).toBe(
      0,
    );
    expect(workbenchReviewStatisticsCsv(selected)).toContain(
      '"5","30","2","3"',
    );
    expect(workbenchReviewStatisticsCsv(before)).toContain('"","","0","3"');
    const empty = computeWorkbenchReviewStatistics(input, {
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    });
    expect(empty.dwellTime).toEqual({
      records: 0,
      knownRecords: 0,
      milliseconds: null,
      episodeDurationMilliseconds: null,
    });
  });
  test("single-day filtering includes exactly UTC+8 midnight through the last millisecond", () => {
    const input: ReviewCollectionFile = {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: Object.fromEntries(
            [
              "2026-10-31T15:59:59.999Z",
              "2026-10-31T16:00:00.000Z",
              "2026-11-01T15:59:59.999Z",
              "2026-11-01T16:00:00.000Z",
            ].map((timestamp, index) => [
              String(index),
              [mark("Alice", timestamp)],
            ]),
          ),
        },
      },
    };
    const all = computeWorkbenchReviewStatistics(input);
    expect(all.daily.map(({ day, records }) => [day, records])).toEqual([
      ["2026-10-31", 1],
      ["2026-11-01", 2],
      ["2026-11-02", 1],
    ]);
    const selected = computeWorkbenchReviewStatistics(input, {
      startDate: "2026-11-01",
      endDate: "2026-11-02",
    });
    expect(selected.summary.records).toBe(2);
    expect(
      selected.personDaily.map(({ day, records }) => [day, records]),
    ).toEqual([["2026-11-01", 2]]);
    expect(selected.uniqueWorkload.episodes).toBe(2);
  });
  test("selected November 1–2 dates mean their own midnights without shifting the end", () => {
    const input: ReviewCollectionFile = {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: Object.fromEntries(
            [
              "2026-10-31T15:59:59.999Z",
              "2026-10-31T16:00:00.000Z",
              "2026-11-01T15:59:59.999Z",
              "2026-11-01T16:00:00.000Z",
              "2026-11-02T15:59:59.999Z",
              "2026-11-02T16:00:00.000Z",
            ].map((timestamp, index) => [
              String(index),
              [mark("Alice", timestamp)],
            ]),
          ),
        },
      },
    };
    const selected = computeWorkbenchReviewStatistics(input, {
      startDate: "2026-11-01",
      endDate: "2026-11-02",
    });
    expect(selected.filters.startDate).toBe("2026-11-01");
    expect(selected.filters.endDate).toBe("2026-11-02");
    expect(selected.summary.records).toBe(2);
    expect(selected.daily.map(({ day, records }) => [day, records])).toEqual([
      ["2026-11-01", 2],
    ]);
    for (const [filter, expected] of [
      [{ startDate: "2026-11-01" }, 5],
      [{ endDate: "2026-11-02" }, 3],
      [{}, 6],
    ] as const) {
      expect(
        computeWorkbenchReviewStatistics(input, filter).summary.records,
      ).toBe(expected);
    }
  });
  test("daily chart has one category per actual person/day and no inactive roster slots", () => {
    const statistics = computeWorkbenchReviewStatistics(collection());
    const rows = buildWorkbenchReviewDailyChart(statistics, "records");
    expect(
      rows.map(({ day, reviewer, value }) => [day, reviewer, value]),
    ).toEqual([
      ["2026-10-30", "Alice", 1],
      ["2026-10-31", "Bob", 2],
      ["2026-10-31", "Alice", 1],
      ["2026-11-01", "Carol", 1],
    ]);
    expect(new Set(rows.map((row) => row.label)).size).toBe(4);
    expect(
      buildWorkbenchReviewDailyChart(statistics, "records", "Carol").map(
        (row) => row.day,
      ),
    ).toEqual(["2026-11-01"]);
    expect(
      buildWorkbenchReviewDailyChart(statistics, "records", "Nobody"),
    ).toEqual([]);
    expect(
      buildWorkbenchReviewDailyChart(statistics, "durationSeconds").every(
        (row) => row.value === null,
      ),
    ).toBe(true);
    expect(
      buildWorkbenchReviewDailyChart(statistics, "sizeBytes").every(
        (row) => row.value === null,
      ),
    ).toBe(true);
  });

  test("reference dataset scale remains separate from verified complete coverage and checked work", () => {
    const result = computeWorkbenchReviewStatistics(
      collection(),
      {},
      {
        "TacVerse/dataset-a": {
          episodes: {
            "0": {
              frames: 300,
              durationSeconds: 10,
              sizeBytes: 100,
              sizeEstimated: false,
            },
          },
          totalEpisodes: 100,
          totalFrames: 30000,
          totalDurationSeconds: 1000,
          totalSizeBytes: null,
          estimates: {
            totalFrames: { sampleEpisodes: 1, totalEpisodes: 100 },
            totalDurationSeconds: { sampleEpisodes: 1, totalEpisodes: 100 },
          },
        },
      },
    );
    const alice = result.people.find((row) => row.reviewer === "Alice")!;
    expect(alice.workload.durationSeconds).toBe(10);
    expect(alice.workload.durationKnown).toBe(1);
    expect(alice.datasetCoverage).toMatchObject({
      datasets: 1,
      totalDurationSeconds: 1000,
      durationKnownDatasets: 1,
      estimatedDurationDatasets: 1,
      fullyInspectedDatasets: 0,
      fullyInspectedDurationSeconds: 0,
    });
    const aliceDays = result.personDaily.filter(
      (row) => row.reviewer === "Alice",
    );
    expect(aliceDays).toHaveLength(2);
    expect(
      aliceDays.every(
        (row) => row.datasetCoverage.totalDurationSeconds === 1000,
      ),
    ).toBe(true);
    const bob = result.people.find((row) => row.reviewer === "Bob")!;
    expect(bob.datasetCoverage).toMatchObject({
      datasets: 2,
      totalDurationSeconds: 1000,
      durationKnownDatasets: 1,
    });
    expect(result.datasetCoverage.totalDurationSeconds).toBe(1000);
    const durations = buildWorkbenchReviewDailyChart(
      result,
      "durationSeconds",
      "Alice",
    );
    expect(durations.map((row) => row.value)).toEqual([10 / 3600, null]);
    const csv = workbenchReviewStatisticsCsv(result);
    expect(csv).toContain(
      "Fully marked dataset content seconds (deduplicated; verified episode manifest)",
    );
    expect(csv).toContain("totalDurationSeconds sample episodes");
    expect(csv).toContain(
      '"TacVerse/dataset-a","100","30000","1000","","true","1","100","true","1","100","false","",""',
    );
    const inspectorSection = csv
      .split('"Inspector totals"\r\n')[1]
      .split("\r\n");
    const cells = (line: string) =>
      Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (match) =>
        match[1].replace(/""/g, '"'),
      );
    const durationIndex = cells(inspectorSection[0]).indexOf(
      "Fully marked dataset content seconds (deduplicated; verified episode manifest)",
    );
    expect(durationIndex).toBeGreaterThan(0);
    expect(cells(inspectorSection[1])[durationIndex]).toBe("0");
    const json = JSON.parse(JSON.stringify(result));
    expect(json.people[0].datasetCoverage.estimatedDurationDatasets).toBe(1);
    expect(
      json.datasets[0].metadata.estimates.totalDurationSeconds.sampleEpisodes,
    ).toBe(1);
  });

  test("chart points keep initial/recheck counts, metric completeness and estimate provenance", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection(),
      {},
      {
        "TacVerse/dataset-a": {
          totalEpisodes: 3,
          totalFrames: null,
          totalDurationSeconds: null,
          totalSizeBytes: null,
          episodes: {
            "0": {
              frames: 300,
              durationSeconds: 10,
              sizeBytes: 100,
              sizeEstimated: true,
            },
          },
        },
      },
    );
    const counts = buildWorkbenchReviewDailyChart(stats, "records");
    for (const point of counts) {
      expect(point.initialInspections + point.crossReviews).toBe(point.records);
      expect(point.value).toBe(point.records);
      expect(point.knownEpisodes).toBe(point.records);
      expect(point.estimated).toBe(false);
    }
    const bob = buildWorkbenchReviewDailyChart(stats, "sizeBytes", "Bob")[0];
    expect(bob).toMatchObject({
      records: 2,
      initialInspections: 1,
      crossReviews: 1,
      knownEpisodes: 1,
      estimated: true,
      value: null,
    });
    const alice = buildWorkbenchReviewDailyChart(stats, "sizeBytes", "Alice");
    expect(alice[0]).toMatchObject({
      knownEpisodes: 1,
      estimated: true,
      value: 100 / 1024 ** 3,
    });
    expect(alice[1]).toMatchObject({
      knownEpisodes: 0,
      estimated: false,
      value: null,
    });
  });

  test("deduplicates dataset/episode identities and distinguishes marks from independent cross-reviews", () => {
    const input = collection();
    const before = JSON.stringify(input);
    const result = computeWorkbenchReviewStatistics(input);
    expect(result.summary).toEqual({
      datasets: 2,
      inspected: 3,
      pending: 2,
      crossReviewed: 1,
      records: 5,
      reviewers: 3,
    });
    expect(result.datasets.map((row) => [row.dataset, row.records])).toEqual([
      ["TacVerse/dataset-a", 4],
      ["TacVerse/dataset-b", 1],
    ]);
    expect(
      result.people.map((person) => [
        person.reviewer,
        person.records,
        person.datasets,
      ]),
    ).toEqual([
      ["Alice", 2, 1],
      ["Bob", 2, 2],
      ["Carol", 1, 1],
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("groups timestamps in UTC+8 and splits first marks from subsequent independent marks", () => {
    expect(
      computeWorkbenchReviewStatistics(collection()).daily.map(
        ({ day, records, initialInspections, crossReviews }) => ({
          day,
          records,
          initialInspections,
          crossReviews,
        }),
      ),
    ).toEqual([
      { day: "2026-10-30", records: 1, initialInspections: 1, crossReviews: 0 },
      { day: "2026-10-31", records: 3, initialInspections: 2, crossReviews: 1 },
      { day: "2026-11-01", records: 1, initialInspections: 0, crossReviews: 1 },
    ]);
  });

  test("retains a first inspection before the reporting start when computing cross-review status", () => {
    const result = computeWorkbenchReviewStatistics(collection(), {
      startDate: "2026-10-31",
      endDate: "2026-11-01",
    });
    expect(result.summary).toEqual({
      datasets: 2,
      inspected: 3,
      pending: 2,
      crossReviewed: 1,
      records: 3,
      reviewers: 2,
    });
    expect(
      result.daily.map(
        ({ day, records, initialInspections, crossReviews }) => ({
          day,
          records,
          initialInspections,
          crossReviews,
        }),
      ),
    ).toEqual([
      { day: "2026-10-31", records: 3, initialInspections: 2, crossReviews: 1 },
    ]);
    expect(
      result.people.find((person) => person.reviewer === "Bob")?.crossReviews,
    ).toBe(1);
  });

  test("excludes later marks from the status at the reporting end", () => {
    const result = computeWorkbenchReviewStatistics(collection(), {
      endDate: "2026-10-31",
    });
    expect(result.summary).toEqual({
      datasets: 1,
      inspected: 1,
      pending: 1,
      crossReviewed: 0,
      records: 1,
      reviewers: 1,
    });
  });

  test("filters datasets and reviewers without redefining the first inspector", () => {
    const result = computeWorkbenchReviewStatistics(collection(), {
      query: " DATASET-A ",
      reviewer: "Carol",
    });
    expect(result.summary).toEqual({
      datasets: 1,
      inspected: 1,
      pending: 0,
      crossReviewed: 1,
      records: 1,
      reviewers: 1,
    });
    expect(result.people[0].initialInspections).toBe(0);
    expect(result.people[0].crossReviews).toBe(1);
  });

  test("does not count duplicate marks by the same person as independent reviews", () => {
    const input: ReviewCollectionFile = {
      version: 1,
      datasets: {
        a: {
          version: 1,
          episodes: {
            "0": [
              mark("Alice", "2026-10-31T08:00:00+08:00"),
              mark("Alice", "2026-10-31T09:00:00+08:00"),
            ],
          },
        },
      },
    };
    const result = computeWorkbenchReviewStatistics(input);
    expect(result.summary.records).toBe(1);
    expect(result.summary.pending).toBe(1);
    expect(result.summary.crossReviewed).toBe(0);
  });

  test("returns true zero totals for empty or unmatched selections", () => {
    const result = computeWorkbenchReviewStatistics(collection(), {
      query: "not-a-dataset",
    });
    expect(result.summary).toEqual({
      datasets: 0,
      inspected: 0,
      pending: 0,
      crossReviewed: 0,
      records: 0,
      reviewers: 0,
    });
    expect(result.datasets).toEqual([]);
    expect(result.daily).toEqual([]);
    expect(result.people).toEqual([]);
  });

  test("rejects invalid calendar dates and reversed ranges", () => {
    for (const startDate of [
      "2026-02-29",
      "2026-13-01",
      "2026-1-01",
      "tomorrow",
    ]) {
      expect(() =>
        computeWorkbenchReviewStatistics(collection(), { startDate }),
      ).toThrow(ReviewStatisticsFilterError);
    }
    expect(() =>
      computeWorkbenchReviewStatistics(collection(), {
        startDate: "2026-11-02",
        endDate: "2026-11-01",
      }),
    ).toThrow(ReviewStatisticsFilterError);
  });

  test("exports filtered dataset totals with formula-safe UTF-8 CSV", () => {
    const input = collection();
    input.datasets['=SUM(1,2)"'] = input.datasets["TacVerse/dataset-a"];
    const statistics = computeWorkbenchReviewStatistics(input, {
      query: "=SUM",
    });
    const csv = workbenchReviewStatisticsCsv(statistics);
    expect(csv.startsWith("\uFEFF")).toBeTrue();
    expect(csv).toContain('"\'=SUM(1,2)"""');
    expect(csv).not.toContain("TacVerse/dataset-b");
    expect(csv).toContain("Inspector daily workload (UTC+8)");
    expect(csv).toContain("Known content seconds");
    expect(csv).toContain("Inspector totals");
  });

  test("weights each person's daily checks by actual episode length and counts cross-reviews separately from unique coverage", () => {
    const metrics: ReviewMetrics = {
      "TacVerse/dataset-a": {
        episodes: {
          "0": {
            frames: 300,
            durationSeconds: 10,
            sizeBytes: 1000,
            sizeEstimated: true,
          },
          "1": {
            frames: 1800,
            durationSeconds: 60,
            sizeBytes: 6000,
            sizeEstimated: true,
          },
        },
        totalEpisodes: 3,
        totalFrames: 5000,
        totalDurationSeconds: 5000 / 30,
        totalSizeBytes: 10000,
      },
      "TacVerse/dataset-b": {
        episodes: {
          "0": {
            frames: 120,
            durationSeconds: 4,
            sizeBytes: 200,
            sizeEstimated: false,
          },
        },
        totalEpisodes: 1,
        totalFrames: 120,
        totalDurationSeconds: 4,
        totalSizeBytes: 200,
      },
    };
    const result = computeWorkbenchReviewStatistics(collection(), {}, metrics);
    expect(result.personDaily).toHaveLength(4);
    expect(result.workload).toEqual({
      episodes: 5,
      frames: 2820,
      durationSeconds: 94,
      sizeBytes: 9200,
      framesKnown: 5,
      durationKnown: 5,
      sizeKnown: 5,
      estimatedSizeEpisodes: 4,
    });
    expect(result.uniqueWorkload).toEqual({
      episodes: 3,
      frames: 2220,
      durationSeconds: 74,
      sizeBytes: 7200,
      framesKnown: 3,
      durationKnown: 3,
      sizeKnown: 3,
      estimatedSizeEpisodes: 2,
    });
    const bob = result.personDaily.find(
      (row) => row.reviewer === "Bob" && row.day === "2026-10-31",
    )!;
    expect(bob).toMatchObject({
      records: 2,
      datasets: 2,
      initialInspections: 1,
      crossReviews: 1,
    });
    expect(bob.workload).toMatchObject({
      frames: 420,
      durationSeconds: 14,
      sizeBytes: 1200,
    });
    expect(
      result.people.find((row) => row.reviewer === "Alice")!.workload
        .durationSeconds,
    ).toBe(70);
    const selected = computeWorkbenchReviewStatistics(
      collection(),
      { startDate: "2026-10-31", endDate: "2026-11-01", reviewer: "Bob" },
      metrics,
    );
    expect(selected.personDaily).toHaveLength(1);
    expect(selected.workload.durationSeconds).toBe(14);
    expect(
      selected.datasets.find((row) => row.dataset === "TacVerse/dataset-a")!
        .metadata!.totalEpisodes,
    ).toBe(3);
    const csv = workbenchReviewStatisticsCsv(selected);
    expect(csv).toContain(
      '"2026-10-31","Bob","2","1","1","2","420","14","1200"',
    );
    expect(csv).not.toContain("Alice");
  });

  test("retains unknown and partial metric coverage instead of treating missing episode metadata as zero", () => {
    const result = computeWorkbenchReviewStatistics(
      collection(),
      {},
      {
        "TacVerse/dataset-a": {
          episodes: {
            "0": {
              frames: 300,
              durationSeconds: null,
              sizeBytes: Number.NaN,
              sizeEstimated: true,
            },
          },
          totalEpisodes: 3,
          totalFrames: null,
          totalDurationSeconds: null,
          totalSizeBytes: null,
        },
      },
    );
    expect(result.workload).toMatchObject({
      episodes: 5,
      frames: 900,
      framesKnown: 3,
      durationSeconds: null,
      durationKnown: 0,
      sizeBytes: null,
      sizeKnown: 0,
      estimatedSizeEpisodes: 0,
    });
    expect(
      result.personDaily.find(
        (row) => row.reviewer === "Alice" && row.day === "2026-10-31",
      )!.workload.frames,
    ).toBeNull();
    expect(result.uniqueWorkload.frames).toBe(300);
  });

  test("escapes inspector names in the person/day CSV as well as dataset keys", () => {
    const input = collection();
    input.datasets["TacVerse/dataset-a"].episodes["1"][0].reviewer =
      '=HYPERLINK("bad")';
    expect(
      workbenchReviewStatisticsCsv(computeWorkbenchReviewStatistics(input)),
    ).toContain('"\'=HYPERLINK(""bad"")"');
  });

  test("treats prototype-like dataset names as regular dataset identities", () => {
    const input = collection();
    input.datasets.constructor = input.datasets["TacVerse/dataset-a"];
    const result = computeWorkbenchReviewStatistics(input, {
      query: "constructor",
    });
    expect(result.summary.records).toBe(4);
    expect(result.workload.frames).toBeNull();
  });
});
