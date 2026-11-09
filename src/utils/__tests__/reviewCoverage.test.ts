import { describe, expect, test } from "bun:test";
import {
  assessDatasetCoverage,
  aggregateCoverageMeasure,
  coveragePercent,
} from "@/utils/reviewCoverage";
import {
  computeWorkbenchReviewStatistics,
  type ReviewDatasetMetrics,
} from "@/utils/workbenchReviewStatistics";
import type { ReviewCollectionFile } from "@/types/episode-review.types";

function metadata(
  weights: (number | null)[],
  total = weights.reduce<number>((sum, value) => sum + (value ?? 0), 0),
): ReviewDatasetMetrics {
  return {
    episodeManifestComplete: true,
    totalEpisodes: weights.length,
    totalFrames: total * 30,
    totalDurationSeconds: total,
    totalSizeBytes: total * 2,
    episodes: Object.fromEntries(
      weights.map((value, index) => [
        String(index),
        {
          frames: value === null ? null : value * 30,
          durationSeconds: value,
          sizeBytes: value === null ? null : value * 2,
          sizeEstimated: false,
        },
      ]),
    ),
  };
}
const inspect = (
  data: ReviewDatasetMetrics | undefined,
  ids: string[],
  cross: string[] = [],
) => assessDatasetCoverage("dataset", data, new Set(ids), new Set(cross));

describe("evidence-based weighted coverage", () => {
  test("90% of short episodes is not 90% of content duration or payload", () => {
    const result = inspect(
      metadata([...Array(9).fill(1), 991]),
      Array.from({ length: 9 }, (_, index) => String(index)),
    );
    expect(result.episodeRatio).toBe(0.9);
    for (const metric of ["frames", "durationSeconds", "sizeBytes"] as const)
      expect(result.measures[metric].ratio).toBe(0.009);
    expect(result.status).toBe("partial");
    expect(result.evidence).toBe("saved-episode-marks");
    expect(result.acceptance).toBe("not-assessed");
  });

  test("all episode marks and independent rechecks remain separate", () => {
    const result = inspect(metadata([10, 90]), ["0", "1"], ["0"]);
    expect(result.status).toBe("complete");
    expect(result.crossReviewedEpisodes).toBe(1);
    expect(result.crossReviewRatio).toBe(0.5);
    expect(result.crossReviewComplete).toBe(false);
    expect(
      inspect(metadata([10, 90]), ["0", "1"], ["0", "1"]).crossReviewComplete,
    ).toBe(true);
  });

  test("unmatched old records are isolated without destroying current valid coverage", () => {
    const result = inspect(metadata([10]), ["0", "999", "01"]);
    expect(result).toMatchObject({
      status: "complete",
      checkedEpisodes: 3,
      matchedEpisodes: 1,
      unmatchedEpisodes: 1,
      invalidEpisodes: 1,
      episodeRatio: 1,
    });
    expect(result.issues).toContain("unmatched-records");
    expect(result.issues).toContain("invalid-record-ids");
    expect(result.measures.durationSeconds.knownChecked).toBe(10);
  });

  test("missing marked episode lengths yield provable bounds, not a fabricated exact percentage", () => {
    const result = inspect(metadata([10, null, 60, null], 100), ["0", "1"]);
    expect(result.measures.durationSeconds).toMatchObject({
      knownChecked: 10,
      total: 100,
      ratio: null,
      lowerBound: 0.1,
      upperBound: 0.4,
      status: "bounded",
      knownCheckedEpisodes: 1,
      checkedEpisodes: 2,
    });
  });

  test("missing unmarked lengths do not erase exact measured contribution against a declared total", () => {
    expect(
      inspect(metadata([10, null, null], 100), ["0"]).measures.durationSeconds,
    ).toMatchObject({
      ratio: 0.1,
      knownChecked: 10,
      total: 100,
      status: "exact",
      source: "declared",
    });
  });

  test("complete unmarked details recover an exact ratio while preserving only measured checked amounts", () => {
    const result = inspect(metadata([10, null, 60], 100), ["0", "1"]);
    expect(result.measures.durationSeconds).toMatchObject({
      knownChecked: 10,
      total: 100,
      ratio: 0.4,
      lowerBound: 0.4,
      upperBound: 0.4,
      status: "exact",
      knownCheckedEpisodes: 1,
      checkedEpisodes: 2,
    });
    const unverified = metadata([10, null, 60], 100);
    unverified.episodeManifestComplete = false;
    expect(
      inspect(unverified, ["0", "1"]).measures.durationSeconds,
    ).toMatchObject({ ratio: null, status: "bounded" });
    const estimated = metadata([10, null, 60], 100);
    estimated.estimates = {
      totalDurationSeconds: { sampleEpisodes: 2, totalEpisodes: 3 },
    };
    expect(
      inspect(estimated, ["0", "1"]).measures.durationSeconds,
    ).toMatchObject({ ratio: null, status: "estimated" });
  });

  test("all current episodes marked implies full content coverage when the exact total is known", () => {
    const result = inspect(metadata([null, null], 100), ["0", "1"]);
    expect(result.status).toBe("complete");
    expect(result.measures.durationSeconds).toMatchObject({
      ratio: 1,
      knownChecked: 0,
      knownCheckedEpisodes: 0,
      checkedEpisodes: 2,
      total: 100,
      status: "exact",
    });
  });

  test("complete episode detail recalculates conflicting summary weights and reports the discrepancy", () => {
    const data = metadata([10, 90]);
    data.totalDurationSeconds = 1000;
    data.totalFrames = 30000;
    const result = inspect(data, ["0"]);
    expect(result.measures.durationSeconds).toMatchObject({
      total: 100,
      ratio: 0.1,
      source: "manifest",
    });
    expect(result.issues).toContain("durationSeconds-total-mismatch");
    expect(result.issues).toContain("frames-total-mismatch");
  });

  test("partial details exceeding the declared total remain inconsistent, never clamped to 100%", () => {
    const data = metadata([10, 90], 50);
    data.episodeManifestComplete = false;
    const result = inspect(data, ["0", "1"]);
    expect(result.measures.durationSeconds).toMatchObject({
      ratio: null,
      lowerBound: null,
      upperBound: null,
      status: "inconsistent",
    });
    expect(result.issues).toContain("durationSeconds-total-mismatch");
  });

  test("unknown denominators keep known contribution without inventing a percentage", () => {
    const data = metadata([10, null], 100);
    data.totalDurationSeconds = null;
    expect(inspect(data, ["0"]).measures.durationSeconds).toMatchObject({
      knownChecked: 10,
      total: null,
      ratio: null,
      status: "unknown",
    });
  });

  test("sample-extrapolated totals show an estimate and never certify complete coverage", () => {
    const data = metadata([10, 90], 1000);
    data.episodeManifestComplete = false;
    data.totalEpisodes = 100;
    data.estimates = {
      totalDurationSeconds: { sampleEpisodes: 2, totalEpisodes: 100 },
    };
    const result = inspect(data, ["0", "1"]);
    expect(result.status).toBe("partial");
    expect(result.measures.durationSeconds).toMatchObject({
      status: "estimated",
      estimated: true,
      ratio: 0.1,
      lowerBound: null,
      upperBound: null,
    });
  });

  test("shared-file payload fractions retain estimated provenance even with exact file totals", () => {
    const data = metadata([10, 90]);
    data.episodes["0"].sizeEstimated = true;
    data.episodes["1"].sizeEstimated = true;
    const result = inspect(data, ["0"]);
    expect(result.measures.sizeBytes).toMatchObject({
      ratio: 0.1,
      estimated: true,
      status: "estimated",
    });
    expect(result.measures.durationSeconds.status).toBe("exact");
  });

  test("estimated unmarked payloads cannot establish deterministic coverage bounds", () => {
    const data = metadata([10, null, 60, null], 100);
    data.episodes["2"].sizeEstimated = true;
    const result = inspect(data, ["0", "1"]);
    expect(result.measures.sizeBytes).toMatchObject({
      estimated: true,
      status: "estimated",
      ratio: null,
      lowerBound: null,
      upperBound: null,
    });
    expect(result.measures.durationSeconds.status).toBe("bounded");
  });

  test("estimated allocations keep their exact denominator provenance when aggregated", () => {
    const data = metadata([10, 90]);
    data.episodes["0"].sizeEstimated = true;
    const result = aggregateCoverageMeasure(
      [inspect(data, ["0"])],
      "sizeBytes",
    );
    expect(result).toMatchObject({
      total: 200,
      ratio: 0.1,
      estimated: true,
      source: "declared",
      status: "estimated",
    });
  });

  test("a denominator derived solely from estimated allocations retains estimated provenance", () => {
    const data = metadata([10, 90]);
    data.totalSizeBytes = null;
    data.episodes["0"].sizeEstimated = true;
    data.episodes["1"].sizeEstimated = true;
    expect(inspect(data, ["0"]).measures.sizeBytes).toMatchObject({
      source: "estimated",
      estimated: true,
      status: "estimated",
      total: 200,
      ratio: 0.1,
    });
  });

  test("reordered marks and floating point shared allocations do not exceed full coverage", () => {
    const data = metadata([1e16, 1, 1, 1]);
    expect(
      inspect(data, ["3", "2", "1", "0"]).measures.durationSeconds.ratio,
    ).toBe(1);
    const shared = metadata([0.1, 0.2]);
    shared.episodes["0"].sizeEstimated = true;
    shared.episodes["1"].sizeEstimated = true;
    shared.totalSizeBytes = 0.6;
    expect(inspect(shared, ["0", "1"]).measures.sizeBytes).toMatchObject({
      ratio: 1,
      estimated: true,
      status: "estimated",
    });
  });

  test("full identity marking does not credit contradictory duration totals", () => {
    const data = metadata([10, null], 5);
    const stats = computeWorkbenchReviewStatistics(
      {
        version: 1,
        datasets: {
          dataset: {
            version: 1,
            episodes: Object.fromEntries(
              ["0", "1"].map((id) => [
                id,
                [
                  {
                    reviewer: "Alice",
                    source: "episodes",
                    reviewed_at: "2026-11-01T12:00:00+08:00",
                  },
                ],
              ]),
            ),
          },
        },
      },
      {},
      { dataset: data },
    );
    expect(stats.datasetCoverage).toMatchObject({
      fullyInspectedDatasets: 1,
      fullyInspectedDurationSeconds: null,
      fullyInspectedDurationKnownDatasets: 0,
    });
    expect(stats.datasetCoverage.measures.durationSeconds.status).toBe(
      "inconsistent",
    );
  });

  test("empty datasets, uninspected datasets and zero-duration content are distinct", () => {
    const empty = inspect(metadata([]), []);
    expect(empty.status).toBe("empty");
    expect(empty.episodeRatio).toBeNull();
    expect(empty.measures.durationSeconds.status).toBe("not-applicable");
    expect(inspect(metadata([10]), []).status).toBe("uninspected");
    const zero = inspect(metadata([0]), ["0"]);
    expect(zero.status).toBe("complete");
    expect(zero.measures.durationSeconds.ratio).toBeNull();
    expect(zero.measures.durationSeconds.status).toBe("not-applicable");
  });

  test("a zero denominator contradicted by known unmarked content is not not-applicable", () => {
    const data = metadata([10], 0);
    data.episodeManifestComplete = false;
    expect(inspect(data, []).measures.durationSeconds.status).toBe(
      "inconsistent",
    );
  });

  test("manifest read failures and duplicate rows cannot certify complete identity coverage", () => {
    const data = metadata([10]);
    data.manifestAudit = {
      invalidRows: 0,
      readFailures: 1,
      duplicateEpisodes: 0,
      declaredEpisodes: 1,
      discoveredEpisodes: 1,
    };
    expect(inspect(data, ["0"]).status).toBe("unknown");
    expect(inspect(data, ["0"]).issues).toContain("metadata-read-failure");
    data.manifestAudit.readFailures = 0;
    data.manifestAudit.duplicateEpisodes = 1;
    expect(inspect(data, ["0"]).manifestState).toBe("inconsistent");
  });

  test("partial manifests retain episode coverage bounds for unresolved identities", () => {
    const data = metadata([10]);
    data.episodeManifestComplete = false;
    data.totalEpisodes = 10;
    const result = inspect(data, ["0", "7"]);
    expect(result).toMatchObject({
      status: "partial",
      matchedEpisodes: 1,
      unmatchedEpisodes: 1,
      episodeRatio: null,
      episodeLowerBound: 0.1,
      episodeUpperBound: 0.2,
    });
  });

  test("overflowing aggregates are unknown/inconsistent values, never Infinity in exports", () => {
    const result = inspect(metadata([Number.MAX_VALUE, Number.MAX_VALUE]), [
      "0",
      "1",
    ]);
    expect(result.measures.durationSeconds).toMatchObject({
      status: "inconsistent",
      knownChecked: null,
      total: null,
      ratio: null,
    });
    expect(JSON.stringify(result)).not.toContain("Infinity");
  });

  test("coverage aggregates weights rather than averaging dataset percentages", () => {
    const small = assessDatasetCoverage("small", metadata([1]), new Set(["0"]));
    const large = assessDatasetCoverage("large", metadata([999]), new Set());
    expect(
      aggregateCoverageMeasure([small, large], "durationSeconds"),
    ).toMatchObject({ knownChecked: 1, total: 1000, ratio: 0.001 });
  });

  test("aggregate missing denominators never silently excludes an unknown dataset", () => {
    const known = inspect(metadata([10]), ["0"]);
    const unknown = assessDatasetCoverage("unknown", undefined, new Set(["0"]));
    expect(
      aggregateCoverageMeasure([known, unknown], "durationSeconds"),
    ).toMatchObject({
      knownChecked: 10,
      total: null,
      ratio: null,
      status: "unknown",
    });
  });

  test("bounded and exact datasets combine using total content weights", () => {
    const bounded = inspect(metadata([10, null, 60, null], 100), ["0", "1"]);
    const exact = inspect(metadata([100]), ["0"]);
    const combined = aggregateCoverageMeasure(
      [bounded, exact],
      "durationSeconds",
    );
    expect(combined.status).toBe("bounded");
    expect(combined.lowerBound).toBeCloseTo(0.55);
    expect(combined.upperBound).toBeCloseTo(0.7);
  });

  test("all missing-length patterns enclose the true content fraction and never exceed [0,1]", () => {
    const truth = [1, 9, 40, 50];
    for (let missing = 0; missing < 16; missing++) {
      const data = metadata(
        truth.map((value, index) => (missing & (1 << index) ? null : value)),
        100,
      );
      for (let mask = 0; mask < 16; mask++) {
        const checked = truth.flatMap((_, index) =>
          mask & (1 << index) ? [String(index)] : [],
        );
        const trueRatio =
          checked.reduce((sum, id) => sum + truth[Number(id)], 0) / 100;
        const result = inspect(data, checked).measures.durationSeconds;
        if (result.ratio !== null)
          expect(result.ratio).toBeCloseTo(trueRatio, 12);
        if (result.lowerBound !== null) {
          expect(result.lowerBound).toBeGreaterThanOrEqual(0);
          expect(result.lowerBound).toBeLessThanOrEqual(trueRatio + 1e-12);
        }
        if (result.upperBound !== null) {
          expect(result.upperBound).toBeLessThanOrEqual(1);
          expect(result.upperBound).toBeGreaterThanOrEqual(trueRatio - 1e-12);
        }
      }
    }
  });

  test("percentage presentation never rounds partial coverage to complete", () => {
    expect(coveragePercent(0.99999999, "en")).toBe("99.99%");
    expect(coveragePercent(0.0000001, "en")).toBe("<0.01%");
    expect(coveragePercent(0, "en")).toBe("0%");
    expect(coveragePercent(1, "en")).toBe("100%");
    expect(coveragePercent(1 / 3, "en", "up")).toBe("33.34%");
    expect(coveragePercent(0.99999999, "en", "up")).toBe("<100%");
    for (const value of [1.01, -1, NaN, Infinity])
      expect(coveragePercent(value, "en")).toBe("—");
  });
});

describe("period contribution versus cumulative evidence", () => {
  const input: ReviewCollectionFile = {
    version: 1,
    datasets: {
      dataset: {
        version: 1,
        episodes: {
          "0": [
            {
              reviewer: "Alice",
              source: "episodes",
              reviewed_at: "2026-10-30T12:00:00+08:00",
            },
            {
              reviewer: "Bob",
              source: "episodes",
              reviewed_at: "2026-11-01T12:00:00+08:00",
            },
          ],
          "1": [
            {
              reviewer: "Alice",
              source: "episodes",
              reviewed_at: "2026-10-31T12:00:00+08:00",
            },
            {
              reviewer: "Bob",
              source: "episodes",
              reviewed_at: "2026-11-02T12:00:00+08:00",
            },
          ],
        },
      },
    },
  };

  test("prior-period marks contribute to cumulative progress but not today's workload", () => {
    const stats = computeWorkbenchReviewStatistics(
      input,
      { startDate: "2026-10-31", endDate: "2026-11-01", reviewer: "Alice" },
      { dataset: metadata([10, 90]) },
    );
    expect(stats.workload).toMatchObject({ episodes: 1, durationSeconds: 90 });
    expect(stats.people[0].datasetCoverage.fullyInspectedDatasets).toBe(0);
    expect(
      stats.people[0].cumulativeDatasetCoverage.fullyInspectedDatasets,
    ).toBe(1);
    expect(stats.personDaily[0].cumulativeDatasetCoverage).toMatchObject({
      scope: "cumulative",
      asOfDay: "2026-11-01",
      fullyInspectedDurationSeconds: 100,
    });
    expect(stats.datasetCoverage.progress[0].crossReviewedEpisodes).toBe(0);
  });

  test("future independent rechecks cannot complete earlier day's cross coverage", () => {
    const stats = computeWorkbenchReviewStatistics(
      input,
      {},
      { dataset: metadata([10, 90]) },
    );
    const earlier = stats.personDaily.find(
      (row) => row.reviewer === "Alice" && row.day === "2026-10-31",
    )!;
    expect(
      earlier.cumulativeDatasetCoverage.progress[0].crossReviewedEpisodes,
    ).toBe(0);
    expect(
      stats.cumulativeDatasetCoverage.progress[0].crossReviewComplete,
    ).toBe(true);
  });

  test("personal cumulative coverage does not borrow another inspector's earlier marks", () => {
    const stats = computeWorkbenchReviewStatistics(
      input,
      { startDate: "2026-11-01", endDate: "2026-11-02", reviewer: "Bob" },
      { dataset: metadata([10, 90]) },
    );
    expect(stats.people[0].cumulativeDatasetCoverage).toMatchObject({
      fullyInspectedDatasets: 0,
      partialDatasets: 1,
    });
    expect(
      stats.people[0].cumulativeDatasetCoverage.progress[0].matchedEpisodes,
    ).toBe(1);
    expect(
      stats.people[0].datasetCoverage.progress[0].crossReviewedEpisodes,
    ).toBe(1);
    expect(
      stats.people[0].datasetCoverage.progress[0].crossReviewComplete,
    ).toBe(false);
  });
});
