import { NextRequest } from "next/server";
import path from "node:path";
import { resolveReviewBrowsePath } from "@/lib/episode-review-scope";
import {
  readReviewCollection,
  reviewsFilePath,
  ReviewStoreError,
} from "@/lib/episode-reviews-store";
import { reviewCollectionCsv } from "@/lib/episode-reviews-export";
import { reviewCollectionSummary } from "@/types/episode-review.types";
import type { ReviewCollectionFile } from "@/types/episode-review.types";
import type { ReviewStatisticsScan } from "@/types/review-statistics-scan.types";
import { reviewCollectionDwellTime } from "@/utils/reviewDwellTime";
import { BROWSE_PATH_COOKIE } from "@/utils/browsePath";
import {
  discoverReviewStatisticsSources,
  loadDiscoveredReviewMetrics,
} from "@/lib/review-statistics-sources";
import { resolveLocalDatasetRoot } from "@/lib/local-datasets-discovery";
import { readLocations } from "@/lib/dataset-locations-store";
import {
  computeWorkbenchReviewStatistics,
  ReviewStatisticsFilterError,
  workbenchReviewStatisticsCsv,
} from "@/utils/workbenchReviewStatistics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function assertReadableScan(scan: ReviewStatisticsScan) {
  if (!scan.sources.length && scan.warnings.length)
    throw new ReviewStoreError(
      "Cannot read inspection records: " +
        scan.warnings
          .map((warning) => warning.path + ": " + warning.message)
          .join("; "),
      500,
    );
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const browsePath = await resolveReviewBrowsePath(
      req.nextUrl.searchParams.get("view") === "statistics" &&
        req.nextUrl.searchParams.get("scope") === "all"
        ? undefined
        : (req.nextUrl.searchParams.get("browsePath") ??
            req.cookies.get(BROWSE_PATH_COOKIE)?.value),
    );
    const format = req.nextUrl.searchParams.get("format");
    const recursiveValue = req.nextUrl.searchParams.get("recursive");
    if (
      recursiveValue !== null &&
      recursiveValue !== "true" &&
      recursiveValue !== "false"
    )
      throw new ReviewStatisticsFilterError("Invalid recursive flag");
    if (req.nextUrl.searchParams.get("view") === "statistics") {
      const filter = {
        startDate: req.nextUrl.searchParams.get("startDate"),
        endDate: req.nextUrl.searchParams.get("endDate"),
        query: req.nextUrl.searchParams.get("q") ?? "",
        reviewer: req.nextUrl.searchParams.get("reviewer") ?? "",
      };
      // Validate filters before discovery, and preserve the raw collection API below.
      computeWorkbenchReviewStatistics({ version: 1, datasets: {} }, filter);
      const scope = req.nextUrl.searchParams.get("scope") ?? "selected";
      if (scope !== "selected" && scope !== "all")
        throw new ReviewStatisticsFilterError("Invalid statistics scope");
      const recursive = recursiveValue !== "false";
      const requested = req.nextUrl.searchParams.getAll("browsePath");
      const selectedRoots = requested.length
        ? await Promise.all(
            requested.map((value) => resolveReviewBrowsePath(value)),
          )
        : [browsePath];
      const defaultRoot = resolveLocalDatasetRoot();
      const roots =
        scope === "all"
          ? [
              defaultRoot,
              ...(await readLocations(defaultRoot)).map(
                (location) => location.path,
              ),
            ]
          : selectedRoots;
      const discovered = await discoverReviewStatisticsSources(
        roots,
        recursive,
        req.signal,
      );
      const { collection, scan } = discovered;
      assertReadableScan(scan);
      const selected = computeWorkbenchReviewStatistics(collection, filter);
      const metrics = await loadDiscoveredReviewMetrics(
        discovered,
        selected.datasets.map((row) => row.dataset),
      );
      const statistics = computeWorkbenchReviewStatistics(
        collection,
        filter,
        metrics,
      );
      for (const row of statistics.datasets)
        row.sources = [
          ...(discovered.locations.get(row.dataset)?.sources ?? []),
        ].sort();
      if (format === "csv") {
        return new Response(workbenchReviewStatisticsCsv(statistics, scan), {
          headers: {
            ...headers,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition":
              'attachment; filename="inspection-statistics.csv"',
          },
        });
      }
      return Response.json(
        {
          statistics,
          browse_path: browsePath,
          storage_path: scan.sources.length === 1 ? scan.sources[0].path : null,
          source_scan: scan,
        },
        {
          headers: {
            ...headers,
            ...(format === "json"
              ? {
                  "Content-Disposition":
                    'attachment; filename="inspection-statistics.json"',
                }
              : {}),
          },
        },
      );
    }
    let collection: ReviewCollectionFile;
    let scan: ReviewStatisticsScan | undefined;
    if (recursiveValue === "true") {
      const discovered = await discoverReviewStatisticsSources(
        [browsePath],
        true,
        req.signal,
      );
      scan = discovered.scan;
      assertReadableScan(scan);
      const root = scan.roots[0];
      // Discovery uses physical identities for deduplication; the homepage and
      // portable collection exports use paths relative to the selected root.
      collection = {
        ...discovered.collection,
        datasets: Object.fromEntries(
          Object.entries(discovered.collection.datasets).map(
            ([dataset, file]) => [
              path.relative(root, dataset).split(path.sep).join("/") || ".",
              file,
            ],
          ),
        ),
      };
    } else {
      collection = await readReviewCollection(browsePath);
    }
    if (format === "csv")
      return new Response(reviewCollectionCsv(collection), {
        headers: {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="episode-reviews.csv"',
        },
      });
    if (format === "json")
      return Response.json(collection, {
        headers: {
          ...headers,
          "Content-Disposition": 'attachment; filename="episode-reviews.json"',
        },
      });
    const reviewedEpisodesByDataset: Record<string, number> = {};
    for (const [datasetKey, file] of Object.entries(collection.datasets)) {
      const count = Object.values(file.episodes).filter(
        (records) => records.length > 0,
      ).length;
      if (count > 0) reviewedEpisodesByDataset[datasetKey] = count;
    }
    return Response.json(
      {
        summary: reviewCollectionSummary(collection),
        dwell_time: reviewCollectionDwellTime(collection),
        reviewed_episodes_by_dataset: reviewedEpisodesByDataset,
        storage_path: scan
          ? scan.sources.length === 1
            ? scan.sources[0].path
            : null
          : reviewsFilePath(browsePath),
        ...(scan ? { source_scan: scan } : {}),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Cannot read inspection records",
      },
      {
        status:
          error instanceof ReviewStatisticsFilterError
            ? 400
            : error instanceof ReviewStoreError
              ? error.status
              : (error as NodeJS.ErrnoException)?.code === "ENOENT"
                ? 404
                : 500,
        headers,
      },
    );
  }
}
