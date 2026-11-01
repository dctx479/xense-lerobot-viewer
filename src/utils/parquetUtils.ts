import {
  asyncBufferFromUrl,
  parquetRead,
  parquetReadObjects,
  parquetMetadataAsync,
  type FileMetaData,
  type AsyncBuffer,
} from "hyparquet";
import { parseLocalDatasetFileApiUrl } from "@/utils/datasetRoute";
import { ParquetBufferCache } from "./parquetBufferCache";

export interface DatasetMetadata {
  codebase_version: string;
  robot_type: string;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  total_videos: number;
  total_chunks: number;
  chunks_size: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<
    string,
    {
      dtype: string;
      shape: number[];
      names: string[] | Record<string, unknown> | null;
      info?: Record<string, unknown>;
    }
  >;
}

export async function fetchJson<T>(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const localJson = await readServerLocalDatasetText(url);
  if (localJson !== null) {
    return JSON.parse(localJson) as T;
  }

  const controller =
    options.timeoutMs === undefined ? null : new AbortController();
  const timeoutId =
    controller && options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch JSON ${url}: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function formatStringWithVars(
  format: string,
  vars: Record<string, string | number>,
): string {
  return format.replace(/{(\w+)(?::\d+d)?}/g, (_, key) => String(vars[key]));
}

// Fetch and parse the Parquet file
type ParquetFile = ArrayBuffer | AsyncBuffer;
const parquetMetadataCache = new WeakMap<ParquetFile, Promise<FileMetaData>>();

function importServerOnlyModule<T>(specifier: string): Promise<T> {
  const runtimeImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as <Module>(specifier: string) => Promise<Module>;
  return runtimeImport<T>(specifier);
}

function readMetadata(file: ParquetFile): Promise<FileMetaData> {
  const cached = parquetMetadataCache.get(file);
  if (cached) return cached;
  const result = parquetMetadataAsync(file).catch((error: unknown) => {
    if (parquetMetadataCache.get(file) === result)
      parquetMetadataCache.delete(file);
    throw error;
  });
  parquetMetadataCache.set(file, result);
  return result;
}

const parquetFileCache = new ParquetBufferCache({
  open: async (url) => {
    const localFile = await openServerLocalDatasetParquet(url);
    if (localFile) return localFile;
    const { byteLength } = await asyncBufferFromUrl({
      url,
      requestInit: { cache: "no-store" },
    });
    return {
      byteLength,
      // Do not retain a hidden whole-file fallback inside asyncBufferFromUrl.
      async slice(start, end = byteLength) {
        const res = await fetch(url, {
          cache: "no-store",
          headers: { Range: "bytes=" + start + "-" + (end - 1) },
        });
        if (!res.ok)
          throw new Error("Failed to fetch parquet range: " + res.status);
        const data = await res.arrayBuffer();
        if (res.status === 200) {
          if (data.byteLength !== byteLength)
            throw new Error("Invalid parquet full-file response");
          return data.slice(start, end);
        }
        if (res.status !== 206 || data.byteLength !== end - start)
          throw new Error("Invalid parquet range response");
        return data;
      },
    };
  },
});

export function pruneParquetCache(): void {
  parquetFileCache.prune();
}

export async function fetchParquetFile(url: string): Promise<ParquetFile> {
  return parquetFileCache.get(url);
}

async function readServerLocalDatasetText(url: string): Promise<string | null> {
  if (typeof window !== "undefined") return null;

  const localFile = parseLocalDatasetFileApiUrl(url);
  if (!localFile) return null;

  const [{ statDatasetFile }, fs] = await Promise.all([
    importServerOnlyModule<typeof import("@/lib/local-dataset-paths")>(
      "@/lib/local-dataset-paths",
    ),
    importServerOnlyModule<typeof import("node:fs/promises")>(
      "node:fs/promises",
    ),
  ]);
  const file = await statDatasetFile(localFile.encodedPath, localFile.filePath);
  if (!file) return null;
  return fs.readFile(file.absolutePath, "utf8");
}

async function openServerLocalDatasetParquet(
  url: string,
): Promise<AsyncBuffer | null> {
  if (typeof window !== "undefined") return null;

  const localFile = parseLocalDatasetFileApiUrl(url);
  if (!localFile) return null;

  const [{ statDatasetFile }, { asyncBufferFromFile }] = await Promise.all([
    importServerOnlyModule<typeof import("@/lib/local-dataset-paths")>(
      "@/lib/local-dataset-paths",
    ),
    importServerOnlyModule<typeof import("hyparquet/src/node.js")>(
      "hyparquet/src/node.js",
    ),
  ]);
  const file = await statDatasetFile(localFile.encodedPath, localFile.filePath);
  if (!file) return null;
  return asyncBufferFromFile(file.absolutePath);
}

// Read specific columns from the Parquet file
export async function readParquetColumn(
  fileBuffer: ParquetFile,
  columns: string[],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<unknown[][]> {
  let rows: unknown[][] = [];
  await parquetRead({
    file: fileBuffer,
    metadata: await readMetadata(fileBuffer),
    columns: columns.length > 0 ? columns : undefined,
    rowStart: options?.rowStart,
    rowEnd: options?.rowEnd,
    onComplete: (data: unknown[][]) => {
      rows = data;
    },
  });
  return rows;
}

export async function readParquetAsObjects(
  fileBuffer: ParquetFile,
  columns: string[] = [],
  options?: { rowStart?: number; rowEnd?: number },
): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({
    file: fileBuffer,
    metadata: await readMetadata(fileBuffer),
    columns: columns.length > 0 ? columns : undefined,
    rowStart: options?.rowStart,
    rowEnd: options?.rowEnd,
  }) as Promise<Record<string, unknown>[]>;
}

// Convert a 2D array to a CSV string
export function arrayToCSV(data: (number | string)[][]): string {
  return data.map((row) => row.join(",")).join("\n");
}

type ColumnInfo = { key: string; value: string[] };

export function getRows(currentFrameData: unknown[], columns: ColumnInfo[]) {
  if (!currentFrameData || currentFrameData.length === 0) {
    return [];
  }

  const rows: Array<Array<{ isNull: true } | unknown>> = [];
  const nRows = Math.max(...columns.map((column) => column.value.length));
  let rowIndex = 0;

  while (rowIndex < nRows) {
    const row: Array<{ isNull: true } | unknown> = [];
    // number of states may NOT match number of actions. In this case, we null-pad the 2D array
    const nullCell = { isNull: true };
    // row consists of [state value, action value]
    let idx = rowIndex;

    for (const column of columns) {
      const nColumn = column.value.length;
      row.push(rowIndex < nColumn ? currentFrameData[idx] : nullCell);
      idx += nColumn; // because currentFrameData = [state0, state1, ..., stateN, action0, action1, ..., actionN]
    }

    rowIndex += 1;
    rows.push(row);
  }

  return rows;
}
