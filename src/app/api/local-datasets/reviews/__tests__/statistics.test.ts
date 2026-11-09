import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/local-datasets/reviews/route";
import { writeLocations } from "@/lib/dataset-locations-store";
import { reviewsFilePath } from "@/lib/episode-reviews-store";

let directory: string;
let root: string;
let browsePath: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "workbench-review-statistics-"),
  );
  root = path.join(directory, "default");
  browsePath = path.join(directory, "selected");
  await fs.mkdir(path.join(browsePath, ".xense-viewer"), { recursive: true });
  await writeLocations(root, [
    { path: browsePath, addedAt: "2026-11-01T00:00:00Z" },
  ]);
  previousRoot = process.env.LOCAL_DATASET_ROOT;
  process.env.LOCAL_DATASET_ROOT = root;
  await fs.writeFile(
    reviewsFilePath(browsePath),
    JSON.stringify({
      version: 1,
      datasets: {
        "dataset-a": {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-10-30T09:00:00+08:00",
              },
              {
                reviewer: "Bob",
                source: "urdf",
                reviewed_at: "2026-10-31T09:00:00+08:00",
              },
            ],
          },
        },
        "dataset-b": {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Alice",
                source: "episodes",
                reviewed_at: "2026-11-01T09:00:00+08:00",
              },
            ],
          },
        },
      },
    }),
  );
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.LOCAL_DATASET_ROOT;
  else process.env.LOCAL_DATASET_ROOT = previousRoot;
  await fs.rm(directory, { recursive: true, force: true });
});

function request(extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    view: "statistics",
    browsePath,
    ...extra,
  });
  return new NextRequest(
    "http://localhost/api/local-datasets/reviews?" + params,
    {
      headers: { cookie: "xense-browse-path=" + encodeURIComponent(root) },
    },
  );
}

test("recursive homepage statistics and exports preserve backfilled dwell without changing mark dates", async () => {
  const original = JSON.parse(
    await fs.readFile(reviewsFilePath(browsePath), "utf8"),
  );
  const rootMarks = original.datasets["dataset-a"].episodes["0"];
  rootMarks[1] = { ...rootMarks[1], stay_ms: 0, episode_duration_ms: 30000 };
  await fs.writeFile(reviewsFilePath(browsePath), JSON.stringify(original));
  const nested = path.join(browsePath, "dataset-a");
  await fs.mkdir(path.join(nested, ".xense-viewer"), { recursive: true });
  const filled = {
    version: 1,
    updated_at: "2026-11-03T00:00:00+08:00",
    episodes: {
      "0": [{ ...rootMarks[0], stay_ms: 1500, episode_duration_ms: 30000 }],
    },
  };
  await fs.writeFile(reviewsFilePath(nested), JSON.stringify(filled));
  const homepage = await (
    await GET(request({ view: "", recursive: "true" }))
  ).json();
  const statistics = (await (await GET(request())).json()).statistics;
  expect(homepage.dwell_time.total).toEqual({
    records: 3,
    knownRecords: 2,
    milliseconds: 1500,
    episodeDurationMilliseconds: 60000,
  });
  expect(statistics.dwellTime).toEqual(homepage.dwell_time.total);
  for (const person of statistics.people)
    expect(homepage.dwell_time.people[person.reviewer]).toEqual(
      person.dwellTime,
    );
  expect(statistics.workload.durationSeconds).toBeNull();
  const filter = {
    startDate: "2026-10-30",
    endDate: "2026-10-31",
    reviewer: "Alice",
  };
  const filtered = (await (await GET(request(filter))).json()).statistics;
  expect(filtered.dwellTime.milliseconds).toBe(1500);
  expect(filtered.personDaily[0].day).toBe("2026-10-30");
  const exported = await (
    await GET(request({ ...filter, format: "json" }))
  ).json();
  expect(exported.statistics).toEqual(filtered);
  const csv = await (await GET(request({ ...filter, format: "csv" }))).text();
  expect(csv).toContain("Recorded foreground dwell seconds");
  expect(csv).toContain('"1.5","30","1","1"');
  const raw = await (
    await GET(request({ view: "", recursive: "true", format: "json" }))
  ).json();
  expect(raw.datasets["dataset-a"].episodes["0"][0].stay_ms).toBe(1500);
  const rawCsv = await (
    await GET(request({ view: "", recursive: "true", format: "csv" }))
  ).text();
  expect(rawCsv).toContain("停留时间（秒）");
  expect(rawCsv).toContain("1.5");
  filled.episodes["0"][0].stay_ms = 2000;
  await fs.writeFile(reviewsFilePath(nested), JSON.stringify(filled));
  expect(
    (await (await GET(request())).json()).statistics.dwellTime.milliseconds,
  ).toBe(2000);
});

test("reads the explicitly selected record directory without needing dataset media", async () => {
  const response = await GET(request());
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(result.browse_path).toBe(browsePath);
  expect(result.statistics.summary).toEqual({
    datasets: 2,
    inspected: 2,
    pending: 1,
    crossReviewed: 1,
    records: 3,
    reviewers: 2,
  });
  expect(result.file).toBeUndefined();
  expect(result.statistics.workload.durationSeconds).toBeNull();
  expect(result.statistics.workload.durationKnown).toBe(0);
  expect(result.statistics.personDaily).toHaveLength(3);
});

test("enriches each person's daily work from metadata and preserves it in filtered exports", async () => {
  const dataset = path.join(browsePath, "dataset-a");
  await fs.mkdir(path.join(dataset, "meta"), { recursive: true });
  await fs.mkdir(path.join(dataset, "data"), { recursive: true });
  await fs.writeFile(
    path.join(dataset, "meta/info.json"),
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 1,
      total_frames: 900,
      fps: 30,
      data_path: "data/{episode_index:06d}.parquet",
    }),
  );
  await fs.writeFile(
    path.join(dataset, "meta/episodes.jsonl"),
    JSON.stringify({ episode_index: 0, length: 900 }) + "\n",
  );
  await fs.writeFile(
    path.join(dataset, "data/000000.parquet"),
    Buffer.alloc(1234),
  );
  const filter = {
    startDate: "2026-10-31",
    endDate: "2026-11-01",
    reviewer: "Bob",
    q: "dataset-a",
  };
  const result = await (await GET(request(filter))).json();
  expect(result.statistics.personDaily).toHaveLength(1);
  expect(result.statistics.personDaily[0]).toMatchObject({
    reviewer: "Bob",
    day: "2026-10-31",
    crossReviews: 1,
    workload: {
      frames: 900,
      durationSeconds: 30,
      sizeBytes: 1234,
      sizeKnown: 1,
      estimatedSizeEpisodes: 0,
    },
    datasetCoverage: {
      fullyInspectedDatasets: 1,
      fullyInspectedDurationSeconds: 30,
      partialDatasets: 0,
      unknownDatasets: 0,
    },
  });
  const csv = await (await GET(request({ ...filter, format: "csv" }))).text();
  expect(csv).toContain('"2026-10-31","Bob","1","0","1","1","900","30","1234"');
  expect(csv).not.toContain("Alice");
  expect(
    (await (await GET(request({ ...filter, format: "json" }))).json())
      .statistics,
  ).toEqual(result.statistics);
});

test("uses the same date and dataset scope for statistics and both export formats", async () => {
  const filters = {
    startDate: "2026-10-31",
    endDate: "2026-11-01",
    q: "dataset-a",
  };
  const response = await GET(request(filters));
  const result = await response.json();
  expect(result.statistics.summary.records).toBe(1);
  expect(result.statistics.summary.crossReviewed).toBe(1);
  const csv = await GET(request({ ...filters, format: "csv" }));
  expect(csv.headers.get("content-disposition")).toContain(
    "inspection-statistics.csv",
  );
  const text = await csv.text();
  expect(text).toContain("dataset-a");
  expect(text).not.toContain("dataset-b");
  const json = await GET(request({ ...filters, format: "json" }));
  expect(json.headers.get("content-disposition")).toContain(
    "inspection-statistics.json",
  );
  expect((await json.json()).statistics).toEqual(result.statistics);
});

test("one saved episode in a large dataset is partial in JSON and CSV, never full-duration credit", async () => {
  const dataset = path.join(browsePath, "dataset-a", "meta");
  await fs.mkdir(dataset, { recursive: true });
  await fs.writeFile(
    path.join(dataset, "info.json"),
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 1000,
      total_frames: 900000,
      fps: 30,
    }),
  );
  await fs.writeFile(
    path.join(dataset, "episodes.jsonl"),
    JSON.stringify({ episode_index: 0, length: 900 }),
  );
  const filter = { reviewer: "Bob", q: "dataset-a" };
  const { statistics } = await (await GET(request(filter))).json();
  const person = statistics.people[0];
  expect(person.workload.durationSeconds).toBe(30);
  expect(person.datasetCoverage).toMatchObject({
    fullyInspectedDatasets: 0,
    partialDatasets: 1,
    fullyInspectedDurationSeconds: 0,
    totalDurationSeconds: 30000,
  });
  expect(person.datasetCoverage.progress).toMatchObject([
    {
      dataset: statistics.datasets[0].dataset,
      checkedEpisodes: 1,
      totalEpisodes: 1000,
      episodeRatio: 0.001,
      status: "partial",
    },
  ]);
  const csv = await (await GET(request({ ...filter, format: "csv" }))).text();
  const personal = csv
    .split('"Inspector totals"')[1]
    .split('"Record discovery"')[0];
  expect(person.datasetCoverage.measures.durationSeconds).toMatchObject({
    total: 30000,
    knownChecked: 30,
    ratio: 0.001,
  });
  expect(personal).toContain('""status"":""partial""');
  const exported = await (
    await GET(request({ ...filter, format: "json" }))
  ).json();
  expect(exported.statistics.people[0].datasetCoverage).toEqual(
    person.datasetCoverage,
  );
});

test("period and cumulative coverage retain the same cutoff in JSON, daily rows and CSV", async () => {
  const meta = path.join(browsePath, "dataset-a/meta");
  await fs.mkdir(meta, { recursive: true });
  await fs.writeFile(
    path.join(meta, "info.json"),
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 2,
      total_frames: 3000,
      fps: 30,
    }),
  );
  await fs.writeFile(
    path.join(meta, "episodes.jsonl"),
    [
      { episode_index: 0, length: 300 },
      { episode_index: 1, length: 2700 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const collection = JSON.parse(
    await fs.readFile(reviewsFilePath(browsePath), "utf8"),
  );
  collection.datasets["dataset-a"].episodes["1"] = [
    {
      reviewer: "Alice",
      source: "episodes",
      reviewed_at: "2026-10-31T09:00:00+08:00",
    },
    {
      reviewer: "Bob",
      source: "episodes",
      reviewed_at: "2026-11-02T09:00:00+08:00",
    },
  ];
  await fs.writeFile(reviewsFilePath(browsePath), JSON.stringify(collection));
  const filter = {
    startDate: "2026-10-31",
    endDate: "2026-11-01",
    reviewer: "Alice",
    q: "dataset-a",
  };
  const { statistics } = await (await GET(request(filter))).json();
  const person = statistics.people[0];
  expect(person.workload).toMatchObject({ episodes: 1, durationSeconds: 90 });
  expect(person.datasetCoverage.measures.durationSeconds.ratio).toBe(0.9);
  expect(person.cumulativeDatasetCoverage).toMatchObject({
    scope: "cumulative",
    asOfDay: "2026-11-01",
    fullyInspectedDatasets: 1,
  });
  expect(person.cumulativeDatasetCoverage.progress[0]).toMatchObject({
    matchedEpisodes: 2,
    crossReviewedEpisodes: 1,
    crossReviewComplete: false,
  });
  expect(statistics.personDaily).toHaveLength(1);
  expect(statistics.personDaily[0].cumulativeDatasetCoverage).toEqual(
    person.cumulativeDatasetCoverage,
  );
  const exported = await (
    await GET(request({ ...filter, format: "json" }))
  ).json();
  expect(exported.statistics).toEqual(statistics);
  const csv = await (await GET(request({ ...filter, format: "csv" }))).text();
  const lines = csv.split('"Inspector totals"')[1].trim().split(/\r?\n/);
  const cells = (line: string) =>
    Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), (match) =>
      match[1].replace(/""/g, '"'),
    );
  const headers = cells(lines[0]);
  const values = cells(lines[1]);
  expect(values).toHaveLength(headers.length);
  expect(values[headers.indexOf("durationSeconds coverage ratio")]).toBe("0.9");
  expect(
    JSON.parse(values[headers.indexOf("Cumulative coverage (JSON)")]),
  ).toEqual(person.cumulativeDatasetCoverage);
});

test("a verified manifest recovers period and cumulative ratios without fabricating missing workload", async () => {
  const meta = path.join(browsePath, "dataset-a/meta");
  await fs.mkdir(meta, { recursive: true });
  await fs.writeFile(
    path.join(meta, "info.json"),
    JSON.stringify({
      codebase_version: "v2.1",
      total_episodes: 3,
      total_frames: 3000,
      fps: 30,
    }),
  );
  await fs.writeFile(
    path.join(meta, "episodes.jsonl"),
    [
      { episode_index: 0, length: 300 },
      { episode_index: 1 },
      { episode_index: 2, length: 1800 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const collection = JSON.parse(
    await fs.readFile(reviewsFilePath(browsePath), "utf8"),
  );
  collection.datasets["dataset-a"].episodes["1"] = [
    {
      reviewer: "Alice",
      source: "episodes",
      reviewed_at: "2026-10-31T09:00:00+08:00",
    },
  ];
  await fs.writeFile(reviewsFilePath(browsePath), JSON.stringify(collection));
  const filter = {
    startDate: "2026-10-31",
    endDate: "2026-11-01",
    reviewer: "Alice",
    q: "dataset-a",
  };
  const { statistics } = await (await GET(request(filter))).json();
  const person = statistics.people[0];
  expect(person.workload).toMatchObject({
    episodes: 1,
    durationSeconds: null,
    durationKnown: 0,
  });
  expect(person.datasetCoverage.measures.durationSeconds).toMatchObject({
    ratio: 0.3,
    status: "exact",
    knownChecked: 0,
    total: 100,
  });
  expect(
    person.cumulativeDatasetCoverage.measures.durationSeconds,
  ).toMatchObject({
    ratio: 0.4,
    status: "exact",
    knownChecked: 10,
    total: 100,
  });
  const json = await (await GET(request({ ...filter, format: "json" }))).json();
  expect(json.statistics).toEqual(statistics);
  const csv = await (await GET(request({ ...filter, format: "csv" }))).text();
  expect(csv).toContain('"durationSeconds coverage ratio"');
  expect(csv).toContain('"0.3"');
  expect(csv).toContain('\"\"ratio\"\":0.4');
});

test("equal selected dates mean an empty midnight range in statistics and exports", async () => {
  const filters = { startDate: "2026-10-31", endDate: "2026-10-31" };
  const { statistics } = await (await GET(request(filters))).json();
  expect(statistics.filters).toMatchObject(filters);
  expect(statistics.summary.records).toBe(0);
  expect(statistics.personDaily).toEqual([]);
  expect(statistics.daily).toEqual([]);
  expect(statistics.people).toEqual([]);
  const exported = await (
    await GET(request({ ...filters, format: "json" }))
  ).json();
  expect(exported.statistics).toEqual(statistics);
  const csv = await (await GET(request({ ...filters, format: "csv" }))).text();
  expect(csv).not.toContain("Alice");
  expect(csv).not.toContain("Bob");
});

test("returns 400 for invalid statistics date filters", async () => {
  for (const filters of [
    { startDate: "2026-02-29" },
    { startDate: "2026-11-02", endDate: "2026-11-01" },
  ]) {
    expect((await GET(request(filters))).status).toBe(400);
  }
});

test("preserves the existing summary and raw collection export contracts", async () => {
  const summary = await (await GET(request({ view: "" }))).json();
  expect(summary.summary.records).toBe(3);
  expect(summary.statistics).toBeUndefined();
  const raw = await (await GET(request({ view: "", format: "json" }))).json();
  expect(raw.datasets["dataset-a"].episodes["0"]).toHaveLength(2);
});

test("recursive homepage counts, statistics and exports merge new nested records without duplicating old snapshots", async () => {
  const original = JSON.parse(
    await fs.readFile(reviewsFilePath(browsePath), "utf8"),
  );
  const existing = path.join(browsePath, "dataset-a");
  const added = path.join(browsePath, "nested/dataset-c");
  const mark = {
    reviewer: "Alice",
    source: "episodes",
    reviewed_at: "2026-11-02T00:00:00+08:00",
  };
  for (const dir of [existing, added])
    await fs.mkdir(path.join(dir, ".xense-viewer"), { recursive: true });
  await fs.writeFile(
    reviewsFilePath(existing),
    JSON.stringify({
      ...original.datasets["dataset-a"],
      episodes: { ...original.datasets["dataset-a"].episodes, "1": [mark] },
    }),
  );
  await fs.writeFile(
    reviewsFilePath(added),
    JSON.stringify({
      version: 1,
      episodes: { "0": [{ ...mark, reviewer: "Cara" }] },
    }),
  );
  const params = { view: "", recursive: "true" };
  const homepage = await (await GET(request(params))).json();
  const statistics = (await (await GET(request())).json()).statistics;
  expect(homepage.summary).toMatchObject({
    datasets: 3,
    inspected: 4,
    records: 5,
    crossReviewed: 1,
  });
  for (const key of [
    "datasets",
    "inspected",
    "records",
    "crossReviewed",
    "pending",
  ] as const)
    expect(homepage.summary[key]).toBe(statistics.summary[key]);
  expect(homepage.reviewed_episodes_by_dataset).toEqual({
    "dataset-a": 2,
    "dataset-b": 1,
    "nested/dataset-c": 1,
  });
  expect(homepage.source_scan.sources).toHaveLength(3);
  expect(homepage.source_scan.duplicateMarks).toBe(2);
  expect(homepage.storage_path).toBeNull();
  const json = await (await GET(request({ ...params, format: "json" }))).json();
  expect(Object.keys(json.datasets).sort()).toEqual([
    "dataset-a",
    "dataset-b",
    "nested/dataset-c",
  ]);
  expect(json.datasets["dataset-a"].episodes["0"]).toHaveLength(2);
  const csv = await (await GET(request({ ...params, format: "csv" }))).text();
  expect(csv).toContain("nested/dataset-c");
  expect(csv.split("\r\n").filter((row) => row.includes("Cara"))).toHaveLength(
    1,
  );
  // A second refresh observes additions immediately; old collection reads stay compatible.
  await fs.writeFile(
    reviewsFilePath(added),
    JSON.stringify({
      version: 1,
      episodes: { "0": [{ ...mark, reviewer: "Cara" }], "1": [mark] },
    }),
  );
  const refreshed = await (await GET(request(params))).json();
  expect(refreshed.summary.records).toBe(6);
  expect(refreshed.reviewed_episodes_by_dataset["nested/dataset-c"]).toBe(2);
  const legacy = await (await GET(request({ view: "" }))).json();
  expect(legacy.summary.records).toBe(3);
  const today = (
    await (
      await GET(request({ startDate: "2026-11-02", endDate: "2026-11-03" }))
    ).json()
  ).statistics;
  expect(today.summary.records).toBe(3);
  expect(today.personDaily.map((row: { day: string }) => row.day)).toEqual([
    "2026-11-02",
    "2026-11-02",
  ]);
});

test("recursive summaries expose partial scans and reject invalid recursive flags", async () => {
  const nested = path.join(browsePath, "broken/.xense-viewer");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "episode-reviews.json"), "{broken");
  const response = await GET(request({ view: "", recursive: "true" }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.summary.records).toBe(3);
  expect(result.source_scan.warnings).toHaveLength(1);
  expect((await GET(request({ view: "", recursive: "invalid" }))).status).toBe(
    400,
  );
});

test("reports damaged records instead of a successful empty statistic", async () => {
  await fs.writeFile(reviewsFilePath(browsePath), "{broken");
  const response = await GET(request());
  expect(response.status).toBe(500);
  expect((await response.json()).statistics).toBeUndefined();
});

test("discovers nested sidecars across registered directories and deduplicates overlapping dataset snapshots", async () => {
  const original = JSON.parse(
    await fs.readFile(reviewsFilePath(browsePath), "utf8"),
  );
  const nestedDirectory = path.join(browsePath, "dataset-a");
  await fs.mkdir(path.join(nestedDirectory, ".xense-viewer"), {
    recursive: true,
  });
  await fs.writeFile(
    reviewsFilePath(nestedDirectory),
    JSON.stringify(original.datasets["dataset-a"]),
  );
  await fs.writeFile(
    reviewsFilePath(root),
    JSON.stringify({
      version: 1,
      datasets: {
        "dataset-a": {
          version: 1,
          episodes: {
            "0": [
              {
                reviewer: "Carol",
                reviewed_at: "2026-11-01T10:00:00+08:00",
                source: "episodes",
              },
            ],
          },
        },
      },
    }),
  );
  const selected = await (await GET(request())).json();
  expect(selected.source_scan.sources).toHaveLength(2);
  expect(selected.source_scan.duplicateMarks).toBe(2);
  expect(selected.statistics.summary.records).toBe(3);
  const single = await (await GET(request({ recursive: "false" }))).json();
  expect(single.source_scan.sources).toHaveLength(1);
  expect(single.source_scan.duplicateMarks).toBe(0);
  const all = await (await GET(request({ scope: "all" }))).json();
  expect(all.source_scan.sources).toHaveLength(3);
  expect(all.statistics.summary).toMatchObject({
    datasets: 3,
    inspected: 3,
    records: 4,
    reviewers: 3,
  });
  expect(all.storage_path).toBeNull();
  expect(
    all.statistics.datasets.find(
      (row: { dataset: string }) => row.dataset === nestedDirectory,
    ).sources,
  ).toHaveLength(2);
  const csv = await (
    await GET(request({ scope: "all", format: "csv" }))
  ).text();
  expect(csv).toContain("Record discovery");
  expect(csv).toContain(reviewsFilePath(nestedDirectory));
  expect(csv).toContain(
    "Touched dataset scale (reference only; not checked workload)",
  );
  const url = request().nextUrl;
  url.searchParams.append("browsePath", root);
  const multiple = await (await GET(new NextRequest(url))).json();
  expect(multiple.statistics.summary).toEqual(all.statistics.summary);
});

test("reports partial discovery failures and keeps valid nested statistics visible", async () => {
  const nested = path.join(browsePath, "broken/.xense-viewer");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "episode-reviews.json"), "{broken");
  const response = await GET(request());
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.source_scan.warnings).toHaveLength(1);
  expect(result.statistics.summary.records).toBe(3);
});

test("validates search flags and does not allow unregistered search roots", async () => {
  expect((await GET(request({ scope: "unknown" }))).status).toBe(400);
  expect((await GET(request({ recursive: "unknown" }))).status).toBe(400);
  expect((await GET(request({ browsePath: directory }))).status).toBe(500);
  const noSelection = new NextRequest(
    "http://localhost/api/local-datasets/reviews?view=statistics&scope=all",
    {
      headers: { cookie: "xense-browse-path=" + encodeURIComponent(directory) },
    },
  );
  expect((await GET(noSelection)).status).toBe(200);
});
