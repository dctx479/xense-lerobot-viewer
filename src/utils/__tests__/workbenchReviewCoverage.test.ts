import { describe, expect, test } from "bun:test";
import type { ReviewCollectionFile } from "@/types/episode-review.types";
import {
  computeWorkbenchReviewStatistics,
  workbenchReviewStatisticsCsv,
  type ReviewDatasetMetrics,
} from "@/utils/workbenchReviewStatistics";

function metadata(
  ids: string[],
  total: number | null = ids.length,
  verified = true,
): ReviewDatasetMetrics {
  return {
    episodeManifestComplete: verified,
    totalEpisodes: total,
    totalFrames: total === null ? null : total * 300,
    totalDurationSeconds: total === null ? null : total * 10,
    totalSizeBytes: null,
    episodes: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          frames: 300,
          durationSeconds: 10,
          sizeBytes: null,
          sizeEstimated: false,
        },
      ]),
    ),
  };
}

function collection(rows: [string, string, string?][]): ReviewCollectionFile {
  const episodes: ReviewCollectionFile["datasets"][string]["episodes"] =
    Object.create(null);
  for (const [episode, reviewer, day = "2026-11-01"] of rows) {
    episodes[episode] ??= [];
    episodes[episode].push({
      reviewer,
      source: "episodes",
      reviewed_at: day + "T12:00:00+08:00",
    });
  }
  return { version: 1, datasets: { dataset: { version: 1, episodes } } };
}

describe("verified dataset inspection coverage", () => {
  test("one check out of a large dataset is partial and contributes no complete dataset duration", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([["7", "Alice"]]),
      {},
      { dataset: metadata(["7"], 1000, false) },
    );
    expect(stats.workload.durationSeconds).toBe(10);
    expect(stats.datasetCoverage.totalDurationSeconds).toBe(10000);
    for (const coverage of [
      stats.datasetCoverage,
      stats.people[0].datasetCoverage,
      stats.personDaily[0].datasetCoverage,
    ]) {
      expect(coverage).toMatchObject({
        fullyInspectedDatasets: 0,
        partialDatasets: 1,
        unknownDatasets: 0,
        fullyInspectedDurationSeconds: 0,
      });
      expect(coverage.progress).toMatchObject([
        {
          dataset: "dataset",
          checkedEpisodes: 1,
          totalEpisodes: 1000,
          episodeRatio: 0.001,
          status: "partial",
        },
      ]);
    }
    const csv = workbenchReviewStatisticsCsv(stats);
    const personal = csv.split('"Inspector totals"')[1];
    const inspectorSection = personal.trim().split("\r\n");
    const cells = (line: string) =>
      Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (match) =>
        match[1].replace(/""/g, '"'),
      );
    const durationIndex = cells(inspectorSection[0]).indexOf(
      "Fully marked dataset content seconds (deduplicated; verified episode manifest)",
    );
    expect(cells(inspectorSection[1])[durationIndex]).toBe("0");
    expect(personal).toContain('"0","0","0","0","1","0"');
    expect(personal).toContain('""status"":""partial""');
  });

  test("a genuine one-episode dataset can be complete when that exact episode is checked", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([["7", "Alice"]]),
      {},
      { dataset: metadata(["7"]) },
    );
    expect(stats.people[0].datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 1,
      partialDatasets: 0,
      unknownDatasets: 0,
      fullyInspectedDurationSeconds: 10,
      fullyInspectedDurationKnownDatasets: 1,
    });
    expect(stats.people[0].datasetCoverage.progress[0].episodeRatio).toBe(1);
  });

  test("matches noncontiguous episode identities instead of assuming a zero-based range", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([
        ["7", "Alice"],
        ["19", "Alice"],
      ]),
      {},
      { dataset: metadata(["7", "19"]) },
    );
    expect(stats.people[0].datasetCoverage.fullyInspectedDatasets).toBe(1);
    expect(stats.people[0].datasetCoverage.fullyInspectedDurationSeconds).toBe(
      20,
    );
  });

  test("duplicate marks and cross-reviews never fill missing episode identities", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([
        ["0", "Alice"],
        ["0", "Alice"],
        ["0", "Bob"],
      ]),
      {},
      { dataset: metadata(["0", "1"]) },
    );
    expect(stats.summary.records).toBe(2);
    expect(stats.datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 0,
      partialDatasets: 1,
    });
    expect(stats.datasetCoverage.progress[0].episodeRatio).toBe(0.5);
    expect(
      stats.people.every(
        (person) => person.datasetCoverage.fullyInspectedDatasets === 0,
      ),
    ).toBe(true);
  });

  test("collective completion does not credit either inspector with another inspector's checks", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([
        ["0", "Alice"],
        ["1", "Bob"],
      ]),
      {},
      { dataset: metadata(["0", "1"]) },
    );
    expect(stats.datasetCoverage.fullyInspectedDatasets).toBe(1);
    for (const person of stats.people)
      expect(person.datasetCoverage).toMatchObject({
        fullyInspectedDatasets: 0,
        partialDatasets: 1,
        fullyInspectedDurationSeconds: 0,
      });
    const selected = computeWorkbenchReviewStatistics(
      collection([
        ["0", "Alice"],
        ["1", "Bob"],
      ]),
      { reviewer: "Alice" },
      { dataset: metadata(["0", "1"]) },
    );
    expect(selected.datasetCoverage.fullyInspectedDatasets).toBe(0);
  });

  test("combines an inspector's days once but requires all episodes within each day's scope", () => {
    const input = collection([
      ["0", "Alice", "2026-10-31"],
      ["1", "Alice", "2026-11-01"],
    ]);
    const metrics = { dataset: metadata(["0", "1"]) };
    const stats = computeWorkbenchReviewStatistics(input, {}, metrics);
    expect(stats.people[0].datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 1,
      fullyInspectedDurationSeconds: 20,
    });
    expect(stats.personDaily).toHaveLength(2);
    expect(
      stats.personDaily.every(
        (day) =>
          day.datasetCoverage.fullyInspectedDurationSeconds === 0 &&
          day.datasetCoverage.partialDatasets === 1,
      ),
    ).toBe(true);
    const filtered = computeWorkbenchReviewStatistics(
      input,
      { startDate: "2026-11-01", endDate: "2026-11-02" },
      metrics,
    );
    expect(filtered.people[0].datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 0,
      partialDatasets: 1,
    });
  });

  test("equal counts without a verified complete manifest never imply full coverage", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([
        ["0", "Alice"],
        ["1", "Alice"],
      ]),
      {},
      { dataset: metadata(["0", "1"], 2, false) },
    );
    expect(stats.datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 0,
      unknownDatasets: 1,
      fullyInspectedDurationSeconds: 0,
    });
    expect(stats.datasetCoverage.progress[0]).toMatchObject({
      episodeRatio: null,
      status: "unknown",
    });
  });

  for (const [label, ids, total, marks] of [
    ["unmatched saved episode", ["0"], 1, ["99"]],
    ["only unmatched saved episodes", ["0"], 1, ["1", "2"]],
    ["manifest conflicts with declared total", ["0", "1"], 1, ["0"]],
    ["zero total", [], 0, ["0"]],
    ["unknown total", ["0"], null, ["0"]],
    ["noncanonical saved identity", ["0"], 1, ["00"]],
  ] as const) {
    test(label + " remains unverified, without a fabricated percentage", () => {
      const stats = computeWorkbenchReviewStatistics(
        collection(marks.map((id) => [id, "Alice"])),
        {},
        { dataset: metadata([...ids], total) },
      );
      expect(stats.datasetCoverage).toMatchObject({
        fullyInspectedDatasets: 0,
        partialDatasets: 0,
        unknownDatasets: 1,
        fullyInspectedDurationSeconds: 0,
      });
      expect(stats.datasetCoverage.progress[0].episodeRatio).toBeNull();
    });
  }

  test("complete episode coverage with missing duration keeps duration unknown", () => {
    const metrics = metadata(["0"]);
    metrics.totalDurationSeconds = null;
    metrics.episodes["0"].durationSeconds = null;
    const stats = computeWorkbenchReviewStatistics(
      collection([["0", "Alice"]]),
      {},
      { dataset: metrics },
    );
    expect(stats.people[0].datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 1,
      fullyInspectedDurationSeconds: null,
      fullyInspectedDurationKnownDatasets: 0,
    });
  });

  test("a selection with no marks has no complete datasets or invented progress", () => {
    const stats = computeWorkbenchReviewStatistics(
      collection([["0", "Alice"]]),
      { query: "unmatched" },
      { dataset: metadata(["0"]) },
    );
    expect(stats.datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 0,
      partialDatasets: 0,
      unknownDatasets: 0,
      fullyInspectedDurationSeconds: 0,
      progress: [],
    });
  });
});
