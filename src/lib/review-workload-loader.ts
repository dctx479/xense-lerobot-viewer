import fs from "node:fs/promises";
import { isInsideRoot, resolveInsideDataset } from "@/lib/local-dataset-paths";
import {
  listV3EpisodeMetadataFiles,
  openParquet,
  readParquetRowsRaw,
} from "@/lib/parquet-server";
import type {
  ReviewDatasetMetrics,
  ReviewMetrics,
} from "@/utils/workbenchReviewStatistics";

type Row = Record<string, unknown>;
type Reference = { file: string; weight: number };
type Episode = {
  frames: number | null;
  references: Reference[];
  complete: boolean;
};

// Only share reads that are still running. Completed snapshots cannot be reused:
// new episodes change the coverage denominator, and downloads can change payload
// sizes without touching the metadata. Never read video contents.
const readsInFlight = new Map<string, Promise<ReviewDatasetMetrics>>();

function numeric(value: unknown): number | null {
  const number = typeof value === "bigint" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? number
    : null;
}

function integer(value: unknown): number | null {
  const number = numeric(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function template(
  value: unknown,
  variables: Record<string, string | number>,
): string | null {
  if (typeof value !== "string") return null;
  const formatted = value.replace(
    /\{([^{}:]+)(?::0?(\d+)d)?\}/g,
    (_, key: string, width?: string) => {
      const replacement = variables[key];
      if (replacement === undefined) return "{" + key + "}";
      return String(replacement).padStart(
        Math.min(Number(width) || 0, 12),
        "0",
      );
    },
  );
  return /[{}]/.test(formatted) ? null : formatted;
}

/** Refuse lexical and symlink escapes for every metadata and payload file. */
async function safeStat(root: string, relative: string) {
  const file = resolveInsideDataset(root, relative);
  if (!file) return null;
  try {
    const real = await fs.realpath(file);
    if (!isInsideRoot(root, real)) return null;
    const stat = await fs.stat(real);
    return stat.isFile()
      ? { file: real, size: stat.size, mtimeMs: stat.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

async function readDataset(root: string): Promise<ReviewDatasetMetrics> {
  const infoFile = await safeStat(root, "meta/info.json");
  if (!infoFile || infoFile.size > 8 * 1024 * 1024)
    throw new Error("Invalid dataset info");
  const info = JSON.parse(await fs.readFile(infoFile.file, "utf8")) as Row;
  const fps = numeric(info.fps);
  const v3 = String(info.codebase_version ?? "").startsWith("v3");
  const videoKeys = new Set(
    Object.entries((info.features ?? {}) as Record<string, { dtype?: string }>)
      .filter(([, feature]) => feature?.dtype === "video")
      .map(([key]) => key),
  );
  const episodes = new Map<string, Episode>();
  const manifestAudit = {
    invalidRows: 0,
    duplicateEpisodes: 0,
    readFailures: 0,
    declaredEpisodes: integer(info.total_episodes),
    discoveredEpisodes: 0,
  };
  let metadataComplete = true;
  let payloadReferencesComplete = true;
  const consume = (row: Row) => {
    const index = integer(row.episode_index);
    if (index === null) {
      metadataComplete = false;
      manifestAudit.invalidRows++;
      return;
    }
    const start = integer(row.dataset_from_index);
    const end = integer(row.dataset_to_index);
    const frames =
      integer(row.length) ??
      (start !== null && end !== null && end >= start ? end - start : null);
    const episode: Episode = { frames, references: [], complete: true };
    const reference = (file: string | null, weight: number | null) => {
      if (!file || weight === null || weight <= 0) episode.complete = false;
      else episode.references.push({ file, weight });
    };
    const chunkSize = integer(info.chunks_size) || 1000;
    if (v3) {
      const chunk = integer(row["data/chunk_index"]);
      const file = integer(row["data/file_index"]);
      reference(
        chunk !== null && file !== null
          ? template(info.data_path, { chunk_index: chunk, file_index: file })
          : null,
        frames,
      );
      const keys = new Set(videoKeys);
      for (const key of Object.keys(row)) {
        if (key.startsWith("videos/") && key.endsWith("/chunk_index"))
          keys.add(key.slice(7, -12));
      }
      for (const key of keys) {
        const chunk = integer(row["videos/" + key + "/chunk_index"]);
        const file = integer(row["videos/" + key + "/file_index"]);
        const from = numeric(row["videos/" + key + "/from_timestamp"]);
        const to = numeric(row["videos/" + key + "/to_timestamp"]);
        reference(
          chunk !== null && file !== null
            ? template(info.video_path, {
                video_key: key,
                chunk_index: chunk,
                file_index: file,
              })
            : null,
          from !== null && to !== null && to > from ? to - from : null,
        );
      }
    } else {
      const vars = {
        episode_chunk: Math.floor(index / chunkSize),
        episode_index: index,
      };
      reference(
        template(
          info.data_path ??
            "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
          vars,
        ),
        1,
      );
      for (const key of videoKeys)
        reference(template(info.video_path, { ...vars, video_key: key }), 1);
    }
    // A missing weight/reference could inflate every other episode's share.
    if (v3 && !episode.complete) payloadReferencesComplete = false;
    if (episodes.has(String(index))) {
      metadataComplete = false;
      manifestAudit.duplicateEpisodes++;
    }
    episodes.set(String(index), episode);
  };

  if (v3) {
    const shards = await listV3EpisodeMetadataFiles(root);
    if (!shards.length) {
      metadataComplete = false;
      manifestAudit.readFailures++;
    }
    for (const relative of shards) {
      try {
        const file = await safeStat(root, relative);
        if (!file) {
          metadataComplete = false;
          manifestAudit.readFailures++;
          continue;
        }
        const handle = await openParquet(
          file.file,
          relative,
          file.size,
          file.mtimeMs,
        );
        const columns = handle.info.columns
          .map((column) => column.name)
          .filter(
            (key) =>
              [
                "episode_index",
                "length",
                "dataset_from_index",
                "dataset_to_index",
                "data/chunk_index",
                "data/file_index",
              ].includes(key) ||
              (key.startsWith("videos/") &&
                /\/(chunk_index|file_index|from_timestamp|to_timestamp)$/.test(
                  key,
                )),
          );
        if (!columns.includes("episode_index")) {
          metadataComplete = false;
          manifestAudit.readFailures++;
          continue;
        }
        for (let offset = 0; offset < handle.info.numRows; offset += 1000) {
          for (const row of await readParquetRowsRaw(
            handle,
            offset,
            1000,
            columns,
          ))
            consume(row);
        }
      } catch {
        metadataComplete = false;
        manifestAudit.readFailures++;
      }
    }
  } else {
    const file = await safeStat(root, "meta/episodes.jsonl");
    if (file && file.size <= 64 * 1024 * 1024) {
      for (const line of (await fs.readFile(file.file, "utf8")).split(
        /\r?\n/,
      )) {
        if (!line.trim()) continue;
        try {
          consume(JSON.parse(line) as Row);
        } catch {
          metadataComplete = false;
          manifestAudit.invalidRows++;
        }
      }
    } else {
      metadataComplete = false;
      manifestAudit.readFailures++;
    }
  }

  const totalEpisodes =
    integer(info.total_episodes) ?? (metadataComplete ? episodes.size : null);
  manifestAudit.discoveredEpisodes = episodes.size;
  if (totalEpisodes !== null && episodes.size !== totalEpisodes)
    metadataComplete = false;
  const weights = new Map<string, number>();
  for (const episode of episodes.values())
    for (const ref of episode.references) {
      weights.set(ref.file, (weights.get(ref.file) ?? 0) + ref.weight);
    }
  const sizes = new Map<string, number | null>();
  const files = [...weights.keys()];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) {
        const relative = files[cursor++];
        sizes.set(relative, (await safeStat(root, relative))?.size ?? null);
      }
    }),
  );
  const result: ReviewDatasetMetrics = {
    episodes: Object.create(null),
    manifestAudit,
    episodeManifestComplete:
      integer(info.total_episodes) !== null && metadataComplete,
    totalEpisodes,
    totalFrames: integer(info.total_frames),
    totalDurationSeconds: null,
    totalSizeBytes: null,
  };
  const frameSamples = [...episodes.values()].filter(
    (episode) => episode.frames !== null,
  );
  const sampledFrames = frameSamples.reduce(
    (sum, episode) => sum + episode.frames!,
    0,
  );
  const estimate = (
    field: "totalFrames" | "totalDurationSeconds" | "totalSizeBytes",
    sampleEpisodes: number,
  ) => {
    if (totalEpisodes === null) return;
    result.estimates ??= {};
    result.estimates[field] = { sampleEpisodes, totalEpisodes };
  };
  if (result.totalFrames === null) {
    if (metadataComplete && frameSamples.length === episodes.size)
      result.totalFrames = sampledFrames;
    else if (
      frameSamples.length >= 2 &&
      sampledFrames > 0 &&
      totalEpisodes !== null &&
      totalEpisodes >= frameSamples.length
    ) {
      result.totalFrames = numeric(
        (sampledFrames / frameSamples.length) * totalEpisodes,
      );
      if (result.totalFrames !== null)
        estimate("totalFrames", frameSamples.length);
    }
  }
  if (result.totalFrames !== null && fps && fps > 0) {
    result.totalDurationSeconds = numeric(result.totalFrames / fps);
    if (result.totalDurationSeconds !== null && result.estimates?.totalFrames)
      estimate("totalDurationSeconds", frameSamples.length);
  }
  if (
    metadataComplete &&
    payloadReferencesComplete &&
    [...episodes.values()].every((ep) => ep.complete) &&
    [...sizes.values()].every((size) => size !== null)
  ) {
    result.totalSizeBytes = [...sizes.values()].reduce<number>(
      (sum, size) => sum + size!,
      0,
    );
  }
  for (const [index, episode] of episodes) {
    const knownSize =
      episode.complete &&
      (!v3 || (metadataComplete && payloadReferencesComplete)) &&
      episode.references.every((ref) => sizes.get(ref.file) != null);
    result.episodes[index] = {
      frames: episode.frames,
      durationSeconds:
        episode.frames !== null && fps && fps > 0
          ? numeric(episode.frames / fps)
          : null,
      // Shared v3 payloads are apportioned by frame count (parquet) or segment
      // duration (each video stream), using ALL episodes, never the date filter.
      sizeBytes: knownSize
        ? episode.references.reduce(
            (sum, ref) =>
              sum +
              (sizes.get(ref.file)! * ref.weight) / weights.get(ref.file)!,
            0,
          )
        : null,
      sizeEstimated:
        v3 ||
        episode.references.some((ref) => weights.get(ref.file)! > ref.weight),
    };
  }
  // Only extrapolate measured episode-owned payloads. Shared v3 file sizes must
  // never be multiplied by episode counts or inferred from configured MB targets.
  if (result.totalSizeBytes === null && !v3 && totalEpisodes !== null) {
    const sampleSizes = [...episodes.entries()]
      .filter(
        ([index, episode]) =>
          result.episodes[index].sizeBytes !== null &&
          episode.references.every(
            (ref) => weights.get(ref.file) === ref.weight,
          ),
      )
      .map(([index]) => result.episodes[index].sizeBytes!);
    if (
      sampleSizes.length >= 2 &&
      sampleSizes.some((size) => size > 0) &&
      totalEpisodes >= sampleSizes.length
    ) {
      result.totalSizeBytes = numeric(
        (sampleSizes.reduce((sum, size) => sum + size, 0) /
          sampleSizes.length) *
          totalEpisodes,
      );
      if (result.totalSizeBytes !== null)
        estimate("totalSizeBytes", sampleSizes.length);
    }
  }
  return result;
}

export async function loadReviewWorkloadMetrics(
  browsePath: string,
  datasets: string[],
): Promise<ReviewMetrics> {
  const browseRoot = await fs.realpath(browsePath);
  const result: ReviewMetrics = Object.create(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, datasets.length) }, async () => {
      while (cursor < datasets.length) {
        const dataset = datasets[cursor++];
        try {
          const candidate =
            dataset === "."
              ? browseRoot
              : resolveInsideDataset(browseRoot, dataset);
          if (!candidate) continue;
          const root = await fs.realpath(candidate);
          if (root !== browseRoot && !isInsideRoot(browseRoot, root)) continue;
          let pending = readsInFlight.get(root);
          if (!pending) {
            pending = readDataset(root);
            readsInFlight.set(root, pending);
          }
          try {
            result[dataset] = await pending;
          } finally {
            if (readsInFlight.get(root) === pending) readsInFlight.delete(root);
          }
        } catch {
          // Missing, inaccessible, or corrupt metadata stays unknown, preserving counts.
        }
      }
    }),
  );
  return result;
}
