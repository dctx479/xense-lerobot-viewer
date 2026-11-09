import fs from "node:fs/promises";
import path from "node:path";
import { isInsideRoot, resolveInsideDataset } from "@/lib/local-dataset-paths";
import { parseReviewCollection } from "@/lib/episode-reviews-store";
import {
  REVIEW_FILENAME,
  parseReviewsFile,
  type ReviewCollectionFile,
  type EpisodeReview,
} from "@/types/episode-review.types";
import type { ReviewStatisticsScan } from "@/types/review-statistics-scan.types";
import { loadReviewWorkloadMetrics } from "@/lib/review-workload-loader";
import type { ReviewMetrics } from "@/utils/workbenchReviewStatistics";
import { hasReviewDwellTime } from "@/utils/reviewDwellTime";

const IGNORED = new Set([
  ".git",
  "node_modules",
  ".cache",
  "__pycache__",
  ".trash",
]);
const MAX_DIRECTORIES = 20_000;
const MAX_SOURCES = 5_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

type Location = { directory: string; key: string; sources: Set<string> };
export type DiscoveredReviews = {
  collection: ReviewCollectionFile;
  locations: Map<string, Location>;
  scan: ReviewStatisticsScan;
};

/** Read-only discovery. Do not follow directory/file symlinks or rewrite any source. */
export async function discoverReviewStatisticsSources(
  roots: string[],
  recursive = true,
  signal?: AbortSignal,
): Promise<DiscoveredReviews> {
  const scan: ReviewStatisticsScan = {
    roots: [],
    recursive,
    directoriesScanned: 0,
    truncated: false,
    duplicateMarks: 0,
    conflictingMarks: 0,
    sources: [],
    warnings: [],
  };
  const locations = new Map<string, Location>();
  const markFreshness = new Map<string, number>();
  const collection: ReviewCollectionFile = {
    version: 1,
    datasets: Object.create(null),
  };
  const visited = new Set<string>();
  const targets = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    try {
      const real = await fs.realpath(root);
      if (!(await fs.stat(real)).isDirectory())
        throw new Error("Not a directory");
      if (!scan.roots.includes(real)) {
        scan.roots.push(real);
        queue.push(real);
      }
    } catch (error) {
      scan.warnings.push({ path: root, message: String(error) });
    }
  }
  let cursor = 0;
  while (cursor < queue.length) {
    signal?.throwIfAborted();
    if (
      scan.directoriesScanned >= MAX_DIRECTORIES ||
      targets.size >= MAX_SOURCES
    ) {
      scan.truncated = true;
      break;
    }
    const batch: string[] = [];
    while (
      cursor < queue.length &&
      batch.length < 16 &&
      scan.directoriesScanned + batch.length < MAX_DIRECTORIES
    ) {
      const directory = queue[cursor++];
      if (visited.has(directory)) continue;
      visited.add(directory);
      batch.push(directory);
    }
    scan.directoriesScanned += batch.length;
    const reads = await Promise.all(
      batch.map(async (directory) => {
        try {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          return {
            directory,
            entries: entries
              .filter(
                (entry) =>
                  !entry.isSymbolicLink() &&
                  ((entry.isFile() && entry.name === REVIEW_FILENAME) ||
                    (entry.isDirectory() && !IGNORED.has(entry.name))),
              )
              .sort((a, b) => a.name.localeCompare(b.name)),
            error: null,
          };
        } catch (error) {
          return { directory, entries: [], error: String(error) };
        }
      }),
    );
    // Process each completed batch in queue order so conflicts resolve consistently.
    for (const { directory, entries, error } of reads) {
      if (error) scan.warnings.push({ path: directory, message: error });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isFile()) {
          if (targets.size >= MAX_SOURCES) scan.truncated = true;
          else targets.add(target);
        }
        // Also inspect the conventional sidecar directory in non-recursive mode.
        if (
          entry.isDirectory() &&
          (recursive ||
            (scan.roots.includes(directory) && entry.name === ".xense-viewer"))
        )
          queue.push(target);
      }
    }
  }

  for (const target of [...targets].sort()) {
    signal?.throwIfAborted();
    const parent = path.dirname(target);
    const directory =
      path.basename(parent) === ".xense-viewer" ? path.dirname(parent) : parent;
    try {
      const realTarget = await fs.realpath(target);
      const stat = await fs.lstat(target);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !isInsideRoot(directory, realTarget) ||
        stat.size > MAX_FILE_BYTES
      )
        throw new Error("Invalid inspection record file");
      const raw: unknown = JSON.parse(await fs.readFile(realTarget, "utf8"));
      const parsed: ReviewCollectionFile =
        raw && typeof raw === "object" && "datasets" in raw
          ? parseReviewCollection(raw)
          : { version: 1 as const, datasets: { ".": parseReviewsFile(raw) } };
      const source = { path: realTarget, directory, datasets: 0, records: 0 };
      for (const [key, file] of Object.entries(parsed.datasets)) {
        const candidate =
          key === "." ? directory : resolveInsideDataset(directory, key);
        if (!candidate) {
          scan.warnings.push({
            path: realTarget,
            message: "Dataset path escapes record directory",
          });
          continue;
        }
        let dataset = candidate;
        try {
          dataset = await fs.realpath(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            scan.warnings.push({ path: realTarget, message: String(error) });
            continue;
          }
        }
        if (dataset !== directory && !isInsideRoot(directory, dataset)) {
          scan.warnings.push({
            path: realTarget,
            message: "Dataset symlink escapes record directory",
          });
          continue;
        }
        source.datasets++;
        const location = locations.get(dataset) ?? {
          directory,
          key,
          sources: new Set<string>(),
        };
        location.sources.add(realTarget);
        locations.set(dataset, location);
        const merged = collection.datasets[dataset] ?? {
          version: 1 as const,
          episodes: Object.create(null),
        };
        collection.datasets[dataset] = merged;
        for (const [episode, records] of Object.entries(file.episodes)) {
          const saved: EpisodeReview[] = merged.episodes[episode] ?? [];
          merged.episodes[episode] = saved;
          for (const record of records) {
            source.records++;
            const identity = JSON.stringify([
              dataset,
              episode,
              record.reviewer,
            ]);
            const freshness =
              Date.parse(file.updated_at ?? parsed.updated_at ?? "") || 0;
            const existing = saved.findIndex(
              (mark) => mark.reviewer === record.reviewer,
            );
            if (existing === -1) {
              saved.push(record);
              markFreshness.set(identity, freshness);
            } else {
              scan.duplicateMarks++;
              const previous = saved[existing];
              if (JSON.stringify(previous) !== JSON.stringify(record))
                scan.conflictingMarks++;
              // Never combine snapshots from different inspection versions. A legacy
              // mark can be backfilled without changing reviewed_at; prefer that
              // complete snapshot, then resolve ties by source update time.
              const markTime = Date.parse(record.reviewed_at);
              const previousTime = Date.parse(previous.reviewed_at);
              const hasSnapshot = hasReviewDwellTime(record);
              const previousHasSnapshot = hasReviewDwellTime(previous);
              if (
                markTime > previousTime ||
                (markTime === previousTime &&
                  ((hasSnapshot && !previousHasSnapshot) ||
                    (hasSnapshot === previousHasSnapshot &&
                      freshness > (markFreshness.get(identity) ?? 0))))
              ) {
                saved[existing] = record;
                markFreshness.set(identity, freshness);
              }
            }
          }
        }
        if (
          file.updated_at &&
          (!merged.updated_at || file.updated_at > merged.updated_at)
        )
          merged.updated_at = file.updated_at;
        if (
          file.updated_at &&
          (!collection.updated_at || file.updated_at > collection.updated_at)
        )
          collection.updated_at = file.updated_at;
      }
      if (
        parsed.updated_at &&
        (!collection.updated_at || parsed.updated_at > collection.updated_at)
      )
        collection.updated_at = parsed.updated_at;
      scan.sources.push(source);
    } catch (error) {
      scan.warnings.push({ path: target, message: String(error) });
    }
  }
  return { collection, locations, scan };
}

/** Load each dataset relative to its actual record directory, not a chosen root label. */
export async function loadDiscoveredReviewMetrics(
  discovered: DiscoveredReviews,
  datasets: string[],
): Promise<ReviewMetrics> {
  const groups = new Map<string, { identity: string; key: string }[]>();
  for (const identity of datasets) {
    const location = discovered.locations.get(identity);
    if (!location) continue;
    const group = groups.get(location.directory) ?? [];
    group.push({ identity, key: location.key });
    groups.set(location.directory, group);
  }
  const result: ReviewMetrics = Object.create(null);
  const entries = [...groups];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [directory, group] = entries[cursor++];
        try {
          const metrics = await loadReviewWorkloadMetrics(
            directory,
            group.map((item) => item.key),
          );
          for (const item of group)
            if (metrics[item.key]) result[item.identity] = metrics[item.key];
        } catch (error) {
          discovered.scan.warnings.push({
            path: directory,
            message: "Dataset metadata unavailable: " + String(error),
          });
        }
      }
    }),
  );
  return result;
}
