import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadReviewWorkloadMetrics } from "@/lib/review-workload-loader";
import { computeWorkbenchReviewStatistics } from "@/utils/workbenchReviewStatistics";

// Two metadata rows: lengths 300/900; cam1 spans 10/30 s, cam2 spans 20/20 s.
// Arrow 25, uncompressed, no statistics. Tests require no Python or video decoder.
const V3_METADATA =
  "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";

let browse: string;
beforeEach(async () => {
  browse = await fs.mkdtemp(path.join(os.tmpdir(), "review-workload-"));
});
afterEach(async () => {
  await fs.rm(browse, { recursive: true, force: true });
});

async function file(relative: string, contents: string | Buffer) {
  const target = path.join(browse, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

async function v3(totalEpisodes = 2) {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({
      codebase_version: "v3.0",
      fps: 30,
      total_episodes: totalEpisodes,
      total_frames: 1200,
      data_files_size_in_mb: 999999,
      video_files_size_in_mb: 999999,
      data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
      features: { cam1: { dtype: "video" }, cam2: { dtype: "video" } },
    }),
  );
  // Sparse metadata shard indices are intentional.
  await file(
    "dataset/meta/episodes/chunk-002/file-007.parquet",
    Buffer.from(V3_METADATA, "base64"),
  );
  await file("dataset/data/chunk-000/file-000.parquet", Buffer.alloc(400));
  await file("dataset/videos/cam1/chunk-000/file-000.mp4", Buffer.alloc(800));
  await file("dataset/videos/cam2/chunk-000/file-000.mp4", Buffer.alloc(200));
}

test("v3 uses all episodes and each stream's segment durations when apportioning measured shared files", async () => {
  await v3();
  const metrics = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  const dataset = metrics.dataset;
  expect(dataset.totalSizeBytes).toBe(1400);
  expect(dataset.totalDurationSeconds).toBe(40);
  expect(dataset.episodes["0"]).toEqual({
    frames: 300,
    durationSeconds: 10,
    sizeBytes: 400,
    sizeEstimated: true,
  });
  expect(dataset.episodes["1"]).toEqual({
    frames: 900,
    durationSeconds: 30,
    sizeBytes: 1000,
    sizeEstimated: true,
  });
  const statistics = computeWorkbenchReviewStatistics(
    {
      version: 1,
      datasets: {
        dataset: {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                reviewed_at: "2026-11-01T12:00:00+08:00",
                source: "episodes",
              },
            ],
          },
        },
      },
    },
    {},
    metrics,
  );
  expect(statistics.workload.sizeBytes).toBe(400);
  expect(statistics.workload.durationSeconds).toBe(10);
});

test("refreshing a growing dataset recalculates its coverage denominator immediately", async () => {
  const info = {
    codebase_version: "v2.1",
    fps: 30,
    total_episodes: 1,
    total_frames: 300,
  };
  await file("dataset/meta/info.json", JSON.stringify(info));
  await file(
    "dataset/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 0, length: 300 }),
  );
  await file("dataset/data/chunk-000/episode_000000.parquet", Buffer.alloc(20));
  const collection = {
    version: 1 as const,
    datasets: {
      dataset: {
        version: 1 as const,
        episodes: {
          "0": [
            {
              reviewer: "Alice",
              source: "episodes" as const,
              reviewed_at: "2026-11-02T00:00:00+08:00",
            },
          ],
        },
      },
    },
  };
  const first = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(
    computeWorkbenchReviewStatistics(collection, {}, first).datasetCoverage
      .fullyInspectedDatasets,
  ).toBe(1);
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ ...info, total_episodes: 2, total_frames: 1200 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    [
      { episode_index: 0, length: 300 },
      { episode_index: 1, length: 900 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  await file("dataset/data/chunk-000/episode_000001.parquet", Buffer.alloc(60));
  const updated = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  const statistics = computeWorkbenchReviewStatistics(collection, {}, updated);
  expect(updated.dataset.totalEpisodes).toBe(2);
  expect(updated.dataset.totalDurationSeconds).toBe(40);
  expect(statistics.uniqueWorkload.durationSeconds).toBe(10);
  expect(statistics.datasetCoverage.fullyInspectedDatasets).toBe(0);
  expect(statistics.datasetCoverage.measures.durationSeconds.ratio).toBe(0.25);
});

test("a refresh observes new payload bytes even when episode metadata has not changed", async () => {
  await v3();
  const first = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(first.dataset.totalSizeBytes).toBe(1400);
  await file("dataset/videos/cam1/chunk-000/file-000.mp4", Buffer.alloc(1600));
  const updated = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(updated.dataset.totalSizeBytes).toBe(2200);
  expect(updated.dataset.episodes["0"].sizeBytes).toBe(600);
});

test("concurrent requests share a metadata snapshot while later refreshes reread it", async () => {
  await v3();
  const [first, second] = await Promise.all([
    loadReviewWorkloadMetrics(browse, ["dataset"]),
    loadReviewWorkloadMetrics(browse, ["dataset"]),
  ]);
  expect(first.dataset).toBe(second.dataset);
  const refreshed = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(refreshed.dataset).not.toBe(first.dataset);
  expect(refreshed.dataset).toEqual(first.dataset);
});

test("missing video files preserve frame/duration metrics but never understate a complete payload size", async () => {
  await v3();
  await fs.unlink(
    path.join(browse, "dataset/videos/cam2/chunk-000/file-000.mp4"),
  );
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalSizeBytes).toBeNull();
  expect(dataset.episodes["0"].sizeBytes).toBeNull();
  expect(dataset.episodes["0"].durationSeconds).toBe(10);
});

test("incomplete metadata cannot allocate a shared file as though unknown episodes did not exist", async () => {
  await v3(3);
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.episodes["0"].frames).toBe(300);
  expect(dataset.episodes["0"].sizeBytes).toBeNull();
  expect(dataset.totalSizeBytes).toBeNull();
});

test("v2 measures episode-owned files exactly and leaves duration unknown without FPS", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 1,
      data_path:
        "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
      video_path:
        "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
      features: { cam: { dtype: "video" } },
    }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 7, length: 100 }) + "\n",
  );
  await file("dataset/data/chunk-000/episode_000007.parquet", Buffer.alloc(11));
  await file(
    "dataset/videos/cam/chunk-000/episode_000007.mp4",
    Buffer.alloc(29),
  );
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.episodes["7"]).toEqual({
    frames: 100,
    durationSeconds: null,
    sizeBytes: 40,
    sizeEstimated: false,
  });
  expect(dataset.totalFrames).toBe(100);
  expect(dataset.totalSizeBytes).toBe(40);
});

test("refuses payload and dataset symlinks that escape their allowed root", async () => {
  await v3();
  await file("outside.mp4", Buffer.alloc(900));
  const payload = path.join(
    browse,
    "dataset/videos/cam2/chunk-000/file-000.mp4",
  );
  await fs.unlink(payload);
  await fs.symlink(path.join(browse, "outside.mp4"), payload);
  await fs.symlink(os.tmpdir(), path.join(browse, "escape"));
  const metrics = await loadReviewWorkloadMetrics(browse, [
    "dataset",
    "escape",
    "../escape",
  ]);
  expect(metrics.dataset.episodes["0"].sizeBytes).toBeNull();
  expect(metrics.escape).toBeUndefined();
  expect(metrics["../escape"]).toBeUndefined();
});

test("complete episode metadata derives exact frame totals even when a declared video stream has no references", async () => {
  await v3();
  const infoPath = path.join(browse, "dataset/meta/info.json");
  const info = JSON.parse(await fs.readFile(infoPath, "utf8"));
  delete info.total_frames;
  info.features.missing = { dtype: "video" };
  await file("dataset/meta/info.json", JSON.stringify(info));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalFrames).toBe(1200);
  expect(dataset.totalDurationSeconds).toBe(40);
  expect(dataset.estimates).toBeUndefined();
  expect(dataset.totalSizeBytes).toBeNull();
  expect(dataset.episodes["0"].sizeBytes).toBeNull();
});

test("partial v2 episode samples estimate reference totals without inventing checked episode metrics", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", fps: 30, total_episodes: 4 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    [
      { episode_index: 0, length: 300 },
      { episode_index: 1, length: 900 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  await file("dataset/data/chunk-000/episode_000000.parquet", Buffer.alloc(10));
  await file("dataset/data/chunk-000/episode_000001.parquet", Buffer.alloc(30));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalFrames).toBe(2400);
  expect(dataset.totalDurationSeconds).toBe(80);
  expect(dataset.totalSizeBytes).toBe(80);
  for (const field of [
    "totalFrames",
    "totalDurationSeconds",
    "totalSizeBytes",
  ] as const)
    expect(dataset.estimates?.[field]).toEqual({
      sampleEpisodes: 2,
      totalEpisodes: 4,
    });
  expect(dataset.episodes["0"].durationSeconds).toBe(10);
  expect(dataset.episodes["2"]).toBeUndefined();
});

test("a single measured v2 payload never extrapolates the whole dataset size", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", fps: 30, total_episodes: 2 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    [
      { episode_index: 0, length: 300 },
      { episode_index: 1, length: 900 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  await file("dataset/data/chunk-000/episode_000000.parquet", Buffer.alloc(20));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalFrames).toBe(1200);
  expect(dataset.estimates?.totalFrames).toBeUndefined();
  expect(dataset.totalSizeBytes).toBeNull();
  expect(dataset.estimates?.totalSizeBytes).toBeUndefined();
  expect(dataset.episodes["1"].sizeBytes).toBeNull();
});

test("partial v3 metadata estimates frame scale but never extrapolates shared file bytes", async () => {
  await v3(4);
  const info = JSON.parse(
    await fs.readFile(path.join(browse, "dataset/meta/info.json"), "utf8"),
  );
  delete info.total_frames;
  await file("dataset/meta/info.json", JSON.stringify(info));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalFrames).toBe(2400);
  expect(dataset.totalDurationSeconds).toBe(80);
  expect(dataset.estimates?.totalDurationSeconds).toEqual({
    sampleEpisodes: 2,
    totalEpisodes: 4,
  });
  expect(dataset.totalSizeBytes).toBeNull();
  expect(dataset.estimates?.totalSizeBytes).toBeUndefined();
});

test("no valid samples or FPS leaves unsupported reference metrics unknown", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 4 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 0, length: 300 }),
  );
  await file(
    "empty/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", fps: 30, total_episodes: 4 }),
  );
  const metrics = await loadReviewWorkloadMetrics(browse, ["dataset", "empty"]);
  expect(metrics.dataset.totalFrames).toBeNull();
  expect(metrics.dataset.totalDurationSeconds).toBeNull();
  expect(metrics.dataset.totalSizeBytes).toBeNull();
  expect(metrics.dataset.estimates?.totalDurationSeconds).toBeUndefined();
  expect(metrics.empty.totalFrames).toBeNull();
  expect(metrics.empty.totalDurationSeconds).toBeNull();
  expect(metrics.empty.totalSizeBytes).toBeNull();
  expect(metrics.empty.estimates).toBeUndefined();
});

test("missing or broken metadata leaves statistics available with unknown metrics", async () => {
  await file("broken/meta/info.json", "{invalid");
  expect(
    Object.keys(await loadReviewWorkloadMetrics(browse, ["missing", "broken"])),
  ).toHaveLength(0);
});

test("a verified one-episode manifest uses exact metrics without sampling", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 1, fps: 30 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 7, length: 300 }),
  );
  await file("dataset/data/chunk-000/episode_000007.parquet", Buffer.alloc(20));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.episodeManifestComplete).toBe(true);
  expect(dataset.totalFrames).toBe(300);
  expect(dataset.totalDurationSeconds).toBe(10);
  expect(dataset.totalSizeBytes).toBe(20);
  expect(dataset.estimates).toBeUndefined();
});

test("two measured independent payloads may estimate reference size, never missing episode workload", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 3, fps: 30 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    [0, 1, 2]
      .map((index) => JSON.stringify({ episode_index: index, length: 300 }))
      .join("\n"),
  );
  await file("dataset/data/chunk-000/episode_000000.parquet", Buffer.alloc(10));
  await file("dataset/data/chunk-000/episode_000001.parquet", Buffer.alloc(30));
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.episodeManifestComplete).toBe(true);
  expect(dataset.totalSizeBytes).toBe(60);
  expect(dataset.estimates?.totalSizeBytes).toEqual({
    sampleEpisodes: 2,
    totalEpisodes: 3,
  });
  expect(dataset.episodes["2"].sizeBytes).toBeNull();
});

test("duplicate metadata, conflicting totals and missing declared totals cannot prove a complete manifest", async () => {
  const cases = [
    { name: "duplicate", total: 1, ids: [0, 0] },
    { name: "conflict", total: 1, ids: [0, 1] },
    { name: "missing-total", total: undefined, ids: [0, 1] },
    { name: "partial", total: 2, ids: [0] },
  ];
  for (const item of cases) {
    await file(
      item.name + "/meta/info.json",
      JSON.stringify({
        codebase_version: "v2.1",
        total_episodes: item.total,
        fps: 30,
      }),
    );
    await file(
      item.name + "/meta/episodes.jsonl",
      item.ids
        .map((index) => JSON.stringify({ episode_index: index, length: 300 }))
        .join("\n"),
    );
  }
  const metrics = await loadReviewWorkloadMetrics(
    browse,
    cases.map((item) => item.name),
  );
  for (const item of cases)
    expect(metrics[item.name].episodeManifestComplete).toBe(false);
});

test("manifest audits preserve invalid, duplicate and unreadable evidence instead of certifying full coverage", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 1, fps: 30 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    [
      JSON.stringify({ episode_index: 0, length: 300 }),
      JSON.stringify({ episode_index: 0, length: 300 }),
      JSON.stringify({ episode_index: -1, length: 300 }),
      "{broken",
    ].join("\n"),
  );
  await file(
    "missing/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 1 }),
  );
  const metrics = await loadReviewWorkloadMetrics(browse, [
    "dataset",
    "missing",
  ]);
  expect(metrics.dataset.episodeManifestComplete).toBe(false);
  expect(metrics.dataset.manifestAudit).toEqual({
    invalidRows: 2,
    duplicateEpisodes: 1,
    readFailures: 0,
    declaredEpisodes: 1,
    discoveredEpisodes: 1,
  });
  expect(metrics.missing.manifestAudit).toMatchObject({
    readFailures: 1,
    discoveredEpisodes: 0,
  });
  expect(metrics.dataset.episodes["0"].durationSeconds).toBe(10);
});

test("a single episode sample with known FPS does not extrapolate dataset frames or duration", async () => {
  await file(
    "dataset/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 1000, fps: 30 }),
  );
  await file(
    "dataset/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 0, length: 300 }),
  );
  const { dataset } = await loadReviewWorkloadMetrics(browse, ["dataset"]);
  expect(dataset.totalFrames).toBeNull();
  expect(dataset.totalDurationSeconds).toBeNull();
  expect(dataset.estimates).toBeUndefined();
  expect(dataset.episodes["0"].durationSeconds).toBe(10);
});

test("zero-only partial samples and overflowing durations stay unknown", async () => {
  await file(
    "zero/meta/info.json",
    JSON.stringify({ codebase_version: "v2.1", total_episodes: 4, fps: 30 }),
  );
  await file(
    "zero/meta/episodes.jsonl",
    [0, 1]
      .map((index) => JSON.stringify({ episode_index: index, length: 0 }))
      .join("\n"),
  );
  for (const index of [0, 1])
    await file(
      "zero/data/chunk-000/episode_00000" + index + ".parquet",
      Buffer.alloc(0),
    );
  await file(
    "overflow/meta/info.json",
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 1,
      total_frames: 300,
      fps: Number.MIN_VALUE,
    }),
  );
  await file(
    "overflow/meta/episodes.jsonl",
    JSON.stringify({ episode_index: 0, length: 300 }),
  );
  const metrics = await loadReviewWorkloadMetrics(browse, ["zero", "overflow"]);
  expect(metrics.zero.totalFrames).toBeNull();
  expect(metrics.zero.totalDurationSeconds).toBeNull();
  expect(metrics.zero.totalSizeBytes).toBeNull();
  expect(metrics.zero.estimates).toBeUndefined();
  expect(metrics.overflow.totalDurationSeconds).toBeNull();
  expect(metrics.overflow.episodes["0"].durationSeconds).toBeNull();
});
