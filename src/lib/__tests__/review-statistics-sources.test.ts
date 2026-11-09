import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverReviewStatisticsSources,
  loadDiscoveredReviewMetrics,
} from "@/lib/review-statistics-sources";
import { computeWorkbenchReviewStatistics } from "@/utils/workbenchReviewStatistics";
import type { EpisodeReview } from "@/types/episode-review.types";

let temporary: string;
let first: string;
let second: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "review-sources-"));
  first = path.join(temporary, "first");
  second = path.join(temporary, "second");
  await fs.mkdir(first);
  await fs.mkdir(second);
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

const mark = (reviewer = "Alice", day = "2026-11-01"): EpisodeReview => ({
  reviewer,
  source: "episodes",
  reviewed_at: day + "T09:00:00+08:00",
});
const dataset = (...records: EpisodeReview[]) => ({
  version: 1 as const,
  episodes: { "0": records },
});
async function source(directory: string, input: unknown, bare = false) {
  const filename = path.join(
    directory,
    bare ? "episode-reviews.json" : ".xense-viewer/episode-reviews.json",
  );
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(input));
  return filename;
}
async function metadata(
  directory: string,
  length: number,
  fps: number,
  totalFrames: number,
) {
  await fs.mkdir(path.join(directory, "meta"), { recursive: true });
  await fs.mkdir(path.join(directory, "data"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "meta/info.json"),
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 2,
      total_frames: totalFrames,
      fps,
      data_path: "data/{episode_index:06d}.parquet",
    }),
  );
  await fs.writeFile(
    path.join(directory, "meta/episodes.jsonl"),
    [
      JSON.stringify({ episode_index: 0, length }),
      JSON.stringify({ episode_index: 1, length: totalFrames - length }),
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(directory, "data/000000.parquet"),
    Buffer.alloc(length),
  );
  await fs.writeFile(
    path.join(directory, "data/000001.parquet"),
    Buffer.alloc(totalFrames - length),
  );
}

test("recurses across roots, resolves single-dataset sidecars, deduplicates copies and keeps different physical datasets separate", async () => {
  const a = path.join(first, "group/dataset");
  const b = path.join(second, "group/dataset");
  await source(first, {
    version: 1,
    datasets: { "group/dataset": dataset(mark()) },
  });
  await source(a, dataset(mark(), mark("Bob")));
  await source(second, {
    version: 1,
    datasets: { "group/dataset": dataset(mark()) },
  });
  await metadata(a, 300, 30, 3000);
  await metadata(b, 400, 20, 4000);
  const found = await discoverReviewStatisticsSources([first, second]);
  expect(found.scan.sources).toHaveLength(3);
  expect(found.scan.duplicateMarks).toBe(1);
  expect(found.scan.conflictingMarks).toBe(0);
  expect(found.scan.warnings).toEqual([]);
  expect(Object.keys(found.collection.datasets).sort()).toEqual([a, b].sort());
  const metrics = await loadDiscoveredReviewMetrics(found, [a, b]);
  const statistics = computeWorkbenchReviewStatistics(
    found.collection,
    {},
    metrics,
  );
  expect(statistics.summary).toMatchObject({
    datasets: 2,
    inspected: 2,
    records: 3,
    crossReviewed: 1,
  });
  expect(statistics.workload.durationSeconds).toBe(40);
  expect(statistics.uniqueWorkload.durationSeconds).toBe(30);
  expect(statistics.datasetCoverage.totalDurationSeconds).toBe(300);
  expect(statistics.datasetCoverage.totalEpisodes).toBe(4);
  expect(
    statistics.people.find((row) => row.reviewer === "Alice")!.workload
      .durationSeconds,
  ).toBe(30);
  expect(
    statistics.people.find((row) => row.reviewer === "Bob")!.workload
      .durationSeconds,
  ).toBe(10);
  const selected = computeWorkbenchReviewStatistics(
    found.collection,
    { reviewer: "Bob" },
    metrics,
  );
  expect(selected.workload.durationSeconds).toBe(10);
  expect(selected.personDaily[0].workload.durationSeconds).toBe(10);
  expect(selected.datasetCoverage.totalDurationSeconds).toBe(100);
  expect(found.locations.get(a)!.sources.size).toBe(2);
});

for (const snapshotAtRoot of [false, true]) {
  test(`same-mark backfills survive legacy copies in either traversal order (${snapshotAtRoot})`, async () => {
    const target = path.join(first, "dataset");
    const legacy = {
      ...dataset(mark()),
      updated_at: "2026-11-03T00:00:00+08:00",
    };
    const filled = {
      ...dataset({ ...mark(), stay_ms: 1500, episode_duration_ms: 10000 }),
      updated_at: "2026-11-02T00:00:00+08:00",
    };
    await source(first, {
      version: 1,
      datasets: { dataset: snapshotAtRoot ? filled : legacy },
    });
    await source(target, snapshotAtRoot ? legacy : filled);
    const found = await discoverReviewStatisticsSources([first]);
    const result = computeWorkbenchReviewStatistics(found.collection, {
      startDate: "2026-11-01",
      endDate: "2026-11-02",
    });
    expect(result.dwellTime).toEqual({
      records: 1,
      knownRecords: 1,
      milliseconds: 1500,
      episodeDurationMilliseconds: 10000,
    });
    expect(result.personDaily.map((row) => row.day)).toEqual(["2026-11-01"]);
    expect(found.scan.duplicateMarks).toBe(1);
    expect(found.scan.conflictingMarks).toBe(1);
  });

  test(`same-mark conflicting snapshots use file freshness rather than maximum dwell (${snapshotAtRoot})`, async () => {
    const target = path.join(first, "dataset");
    const old = {
      ...dataset({ ...mark(), stay_ms: 3000, episode_duration_ms: 10000 }),
      updated_at: "2026-11-02T00:00:00+08:00",
    };
    const recent = {
      ...dataset({ ...mark(), stay_ms: 1000, episode_duration_ms: 20000 }),
      updated_at: "2026-11-03T00:00:00+08:00",
    };
    // The collection can change for unrelated datasets; file.updated_at is more specific.
    await source(first, {
      version: 1,
      updated_at: "2026-11-30T00:00:00+08:00",
      datasets: { dataset: snapshotAtRoot ? recent : old },
    });
    await source(target, snapshotAtRoot ? old : recent);
    const found = await discoverReviewStatisticsSources([first]);
    expect(
      computeWorkbenchReviewStatistics(found.collection).dwellTime,
    ).toMatchObject({
      records: 1,
      knownRecords: 1,
      milliseconds: 1000,
      episodeDurationMilliseconds: 20000,
    });
    expect(found.scan.conflictingMarks).toBe(1);
  });
}

test("a newer mark never borrows a dwell snapshot from an older inspection version", async () => {
  const target = path.join(first, "dataset");
  await source(first, {
    version: 1,
    datasets: {
      dataset: dataset({
        ...mark(),
        stay_ms: 5000,
        episode_duration_ms: 10000,
      }),
    },
  });
  await source(target, dataset(mark("Alice", "2026-11-02")));
  const found = await discoverReviewStatisticsSources([first]);
  const result = computeWorkbenchReviewStatistics(found.collection);
  expect(result.dwellTime).toMatchObject({
    records: 1,
    knownRecords: 0,
    milliseconds: null,
  });
  expect(result.personDaily[0].day).toBe("2026-11-02");
});

test("overlapping search roots and repeated selections read each physical record file only once", async () => {
  await source(first, {
    version: 1,
    datasets: { "nested/dataset": dataset(mark()) },
  });
  await source(path.join(first, "nested/dataset"), dataset(mark()));
  const found = await discoverReviewStatisticsSources([
    first,
    path.join(first, "nested"),
    first,
  ]);
  expect(found.scan.sources).toHaveLength(2);
  expect(found.scan.duplicateMarks).toBe(1);
  expect(
    computeWorkbenchReviewStatistics(found.collection).summary.records,
  ).toBe(1);
});

test("non-recursive mode reads root sidecars but excludes all descendant record directories", async () => {
  await source(first, { version: 1, datasets: { root: dataset(mark()) } });
  await source(path.join(first, "nested"), dataset(mark("Bob")));
  const found = await discoverReviewStatisticsSources([first], false);
  expect(found.scan.sources).toHaveLength(1);
  expect(
    computeWorkbenchReviewStatistics(found.collection).people[0].reviewer,
  ).toBe("Alice");
});

test("supports a directly stored episode-reviews.json without a sidecar folder", async () => {
  await source(path.join(first, "group/dataset"), dataset(mark()), true);
  const found = await discoverReviewStatisticsSources([first]);
  expect(Object.keys(found.collection.datasets)).toEqual([
    path.join(first, "group/dataset"),
  ]);
  expect(found.scan.sources).toHaveLength(1);
});

test("conflicting snapshots retain the latest mark without inflating per-person daily counts", async () => {
  await source(first, {
    version: 1,
    datasets: { nested: dataset(mark("Alice", "2026-10-30")) },
  });
  await source(
    path.join(first, "nested"),
    dataset(mark("Alice", "2026-11-01")),
  );
  const found = await discoverReviewStatisticsSources([first]);
  expect(found.scan.conflictingMarks).toBe(1);
  expect(found.scan.duplicateMarks).toBe(1);
  const statistics = computeWorkbenchReviewStatistics(found.collection);
  expect(statistics.personDaily).toHaveLength(1);
  expect(statistics.personDaily[0].day).toBe("2026-11-01");
  expect(statistics.summary.records).toBe(1);
});

test("reports corrupt files while retaining valid sources and never rewrites records", async () => {
  const valid = await source(first, {
    version: 1,
    datasets: { ds: dataset(mark()) },
  });
  const broken = await source(second, {
    version: 1,
    datasets: { "../outside": dataset(mark()) },
  });
  const before = await fs.readFile(valid, "utf8");
  const found = await discoverReviewStatisticsSources([first, second]);
  expect(found.scan.sources).toHaveLength(1);
  expect(found.scan.warnings).toHaveLength(1);
  expect(found.scan.warnings[0].path).toBe(broken);
  expect(
    computeWorkbenchReviewStatistics(found.collection).summary.records,
  ).toBe(1);
  expect(await fs.readFile(valid, "utf8")).toBe(before);
});

test("does not follow symlink directories, files, or dataset paths that escape a source", async () => {
  const outsideFile = await source(second, {
    version: 1,
    datasets: { ds: dataset(mark()) },
  });
  await fs.symlink(second, path.join(first, "link"));
  await fs.symlink(outsideFile, path.join(first, "episode-reviews.json"));
  await source(first, { version: 1, datasets: { link: dataset(mark()) } });
  const found = await discoverReviewStatisticsSources([first]);
  expect(found.scan.sources).toHaveLength(1);
  expect(found.scan.warnings).toHaveLength(1);
  expect(Object.keys(found.collection.datasets)).toHaveLength(0);
});

test("missing roots and cancelled scans are explicit instead of successful silent zeros", async () => {
  const found = await discoverReviewStatisticsSources([
    path.join(first, "missing"),
  ]);
  expect(found.scan.warnings).toHaveLength(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    discoverReviewStatisticsSources([first], true, controller.signal),
  ).rejects.toThrow();
});
