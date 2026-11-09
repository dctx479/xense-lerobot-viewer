import {
  calendarDayKey,
  calendarDayInRange,
  calendarDateInputRange,
  shiftCalendarDay,
  isCalendarDay,
} from "@/utils/calendarTime";
import type { ReviewCollectionFile } from "@/types/episode-review.types";
import { reviewTimestamp } from "@/utils/reviewTime";
import type { ReviewStatisticsScan } from "@/types/review-statistics-scan.types";
import {
  addReviewDwellTime,
  emptyReviewDwellTime,
  type ReviewDwellTime,
} from "@/utils/reviewDwellTime";
import {
  assessDatasetCoverage,
  aggregateCoverageMeasure,
  coverageMetrics,
  prepareCoverageMetadata,
  type PreparedCoverageMetadata,
  type DatasetInspectionCoverage,
  type CoverageMeasure,
  type CoverageMetric,
} from "@/utils/reviewCoverage";

export class ReviewStatisticsFilterError extends Error {}

export type WorkbenchReviewStatisticsFilter = {
  startDate?: string | null;
  endDate?: string | null;
  query?: string;
  reviewer?: string;
};

type Counts = {
  inspected: number;
  pending: number;
  crossReviewed: number;
  records: number;
};

export type ReviewEpisodeMetrics = {
  frames: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  sizeEstimated: boolean;
};

export type ReviewDatasetMetrics = {
  episodes: Record<string, ReviewEpisodeMetrics>;
  /** Only true when an explicit episode total matches a complete, unique manifest. */
  episodeManifestComplete?: boolean;
  manifestAudit?: {
    invalidRows: number;
    duplicateEpisodes: number;
    readFailures: number;
    declaredEpisodes: number | null;
    discoveredEpisodes: number;
  };
  totalEpisodes: number | null;
  totalFrames: number | null;
  totalDurationSeconds: number | null;
  totalSizeBytes: number | null;
  estimates?: Partial<
    Record<
      "totalFrames" | "totalDurationSeconds" | "totalSizeBytes",
      { sampleEpisodes: number; totalEpisodes: number }
    >
  >;
};

export type ReviewMetrics = Record<string, ReviewDatasetMetrics>;

/** Known sums remain partial when coverage is incomplete; unknown is never zero. */
export type ReviewWorkload = {
  episodes: number;
  frames: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  framesKnown: number;
  durationKnown: number;
  sizeKnown: number;
  estimatedSizeEpisodes: number;
};

function emptyWorkload(): ReviewWorkload {
  return {
    episodes: 0,
    frames: null,
    durationSeconds: null,
    sizeBytes: null,
    framesKnown: 0,
    durationKnown: 0,
    sizeKnown: 0,
    estimatedSizeEpisodes: 0,
  };
}

function addWorkload(target: ReviewWorkload, metrics?: ReviewEpisodeMetrics) {
  target.episodes++;
  for (const [field, coverage] of [
    ["frames", "framesKnown"],
    ["durationSeconds", "durationKnown"],
    ["sizeBytes", "sizeKnown"],
  ] as const) {
    const value = metrics?.[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      target[field] = (target[field] ?? 0) + value;
      target[coverage]++;
      if (field === "sizeBytes" && metrics?.sizeEstimated)
        target.estimatedSizeEpisodes++;
    }
  }
}

export type WorkbenchReviewDatasetStatistics = Counts & {
  dataset: string;
  dwellTime: ReviewDwellTime;
  reviewers: number;
  lastReviewedAt: string;
  workload: ReviewWorkload;
  uniqueWorkload: ReviewWorkload;
  metadata: Omit<ReviewDatasetMetrics, "episodes"> | null;
  sources?: string[];
};

export type WorkbenchReviewerStatistics = {
  reviewer: string;
  dwellTime: ReviewDwellTime;
  datasets: number;
  records: number;
  initialInspections: number;
  crossReviews: number;
  lastReviewedAt: string;
  workload: ReviewWorkload;
  datasetCoverage: ReviewDatasetCoverage;
  cumulativeDatasetCoverage: ReviewDatasetCoverage;
};

export type WorkbenchReviewerDailyStatistics = WorkbenchReviewerStatistics & {
  day: string;
};

export type ReviewDatasetCoverage = {
  scope: "period" | "cumulative";
  /** Exclusive cutoff at this date's UTC+8 midnight. */
  asOfDay: string | null;
  /** Full touched-dataset totals below are denominators/reference scale, never inspected coverage. */
  datasets: number;
  fullyInspectedDatasets: number;
  partialDatasets: number;
  unknownDatasets: number;
  uninspectedDatasets: number;
  emptyDatasets: number;
  crossReviewCompleteDatasets: number;
  measures: Record<CoverageMetric, CoverageMeasure>;
  fullyInspectedDurationSeconds: number | null;
  fullyInspectedDurationKnownDatasets: number;
  fullyInspectedEstimatedDurationDatasets: number;
  progress: DatasetInspectionCoverage[];
  totalEpisodes: number | null;
  totalFrames: number | null;
  totalDurationSeconds: number | null;
  totalSizeBytes: number | null;
  episodesKnownDatasets: number;
  framesKnownDatasets: number;
  durationKnownDatasets: number;
  sizeKnownDatasets: number;
  estimatedFramesDatasets: number;
  estimatedDurationDatasets: number;
  estimatedSizeDatasets: number;
};

function datasetCoverageFor(
  keys: Iterable<string>,
  metrics: ReviewMetrics,
  checked: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  crossReviewed: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  prepared = new Map<string, PreparedCoverageMetadata>(),
): ReviewDatasetCoverage {
  const unique = new Set(keys);
  const coverage: ReviewDatasetCoverage = {
    datasets: unique.size,
    scope: "period",
    asOfDay: null,
    fullyInspectedDatasets: 0,
    partialDatasets: 0,
    unknownDatasets: 0,
    uninspectedDatasets: 0,
    emptyDatasets: 0,
    crossReviewCompleteDatasets: 0,
    measures: Object.fromEntries(
      coverageMetrics.map((metric) => [
        metric,
        aggregateCoverageMeasure([], metric),
      ]),
    ) as Record<CoverageMetric, CoverageMeasure>,
    fullyInspectedDurationSeconds: null,
    fullyInspectedDurationKnownDatasets: 0,
    fullyInspectedEstimatedDurationDatasets: 0,
    progress: [],
    totalEpisodes: null,
    totalFrames: null,
    totalDurationSeconds: null,
    totalSizeBytes: null,
    episodesKnownDatasets: 0,
    framesKnownDatasets: 0,
    durationKnownDatasets: 0,
    sizeKnownDatasets: 0,
    estimatedFramesDatasets: 0,
    estimatedDurationDatasets: 0,
    estimatedSizeDatasets: 0,
  };
  for (const key of unique) {
    const dataset = Object.prototype.hasOwnProperty.call(metrics, key)
      ? metrics[key]
      : undefined;
    const inspected = checked.get(key) ?? new Set<string>();
    if (!prepared.has(key)) prepared.set(key, prepareCoverageMetadata(dataset));
    const assessment = assessDatasetCoverage(
      key,
      dataset,
      inspected,
      crossReviewed.get(key),
      prepared.get(key),
    );
    coverage.progress.push(assessment);
    if (assessment.crossReviewComplete) coverage.crossReviewCompleteDatasets++;
    if (assessment.status === "complete") {
      coverage.fullyInspectedDatasets++;
      const duration = assessment.measures.durationSeconds.total;
      if (
        assessment.measures.durationSeconds.status !== "inconsistent" &&
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration >= 0
      ) {
        coverage.fullyInspectedDurationSeconds =
          (coverage.fullyInspectedDurationSeconds ?? 0) + duration;
        coverage.fullyInspectedDurationKnownDatasets++;
        if (assessment.measures.durationSeconds.estimated)
          coverage.fullyInspectedEstimatedDurationDatasets++;
      }
    } else if (assessment.status === "partial") coverage.partialDatasets++;
    else if (assessment.status === "uninspected")
      coverage.uninspectedDatasets++;
    else if (assessment.status === "empty") coverage.emptyDatasets++;
    else coverage.unknownDatasets++;
    for (const [field, known, estimated] of [
      ["totalEpisodes", "episodesKnownDatasets", null],
      ["totalFrames", "framesKnownDatasets", "estimatedFramesDatasets"],
      [
        "totalDurationSeconds",
        "durationKnownDatasets",
        "estimatedDurationDatasets",
      ],
      ["totalSizeBytes", "sizeKnownDatasets", "estimatedSizeDatasets"],
    ] as const) {
      const value = dataset?.[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        coverage[field] = (coverage[field] ?? 0) + value;
        coverage[known]++;
        if (estimated && dataset?.estimates?.[field]) coverage[estimated]++;
      }
    }
  }
  if (coverage.fullyInspectedDatasets === 0)
    coverage.fullyInspectedDurationSeconds = 0;
  coverage.measures = Object.fromEntries(
    coverageMetrics.map((metric) => [
      metric,
      aggregateCoverageMeasure(coverage.progress, metric),
    ]),
  ) as Record<CoverageMetric, CoverageMeasure>;
  return coverage;
}

export type WorkbenchReviewStatistics = {
  summary: Counts & { datasets: number; reviewers: number };
  dwellTime: ReviewDwellTime;
  datasets: WorkbenchReviewDatasetStatistics[];
  people: WorkbenchReviewerStatistics[];
  personDaily: WorkbenchReviewerDailyStatistics[];
  workload: ReviewWorkload;
  uniqueWorkload: ReviewWorkload;
  datasetCoverage: ReviewDatasetCoverage;
  cumulativeDatasetCoverage: ReviewDatasetCoverage;
  daily: {
    day: string;
    dwellTime: ReviewDwellTime;
    records: number;
    initialInspections: number;
    crossReviews: number;
    workload: ReviewWorkload;
  }[];
  filters: {
    startDate: string | null;
    endDate: string | null;
    query: string;
    reviewer: string;
  };
  updatedAt: string | null;
};

export type ReviewDailyChartMetric =
  | "records"
  | "dwellSeconds"
  | "durationSeconds"
  | "sizeBytes";

/** Each category is an actual person/day check, never an empty global-roster slot. */
export function buildWorkbenchReviewDailyChart(
  statistics: WorkbenchReviewStatistics,
  metric: ReviewDailyChartMetric,
  reviewer = "",
) {
  return statistics.personDaily
    .filter(
      (row) => row.records > 0 && (!reviewer || row.reviewer === reviewer),
    )
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        b.records - a.records ||
        a.reviewer.localeCompare(b.reviewer),
    )
    .map((row) => ({
      label: JSON.stringify([row.day, row.reviewer]),
      day: row.day,
      reviewer: row.reviewer,
      records: row.records,
      initialInspections: row.initialInspections,
      crossReviews: row.crossReviews,
      knownEpisodes:
        metric === "records"
          ? row.records
          : metric === "dwellSeconds"
            ? row.dwellTime.knownRecords
            : row.workload[
                metric === "durationSeconds" ? "durationKnown" : "sizeKnown"
              ],
      estimated:
        metric === "sizeBytes" && row.workload.estimatedSizeEpisodes > 0,
      value:
        metric === "records"
          ? row.records
          : metric === "dwellSeconds"
            ? row.dwellTime.knownRecords === row.records &&
              row.dwellTime.milliseconds !== null
              ? row.dwellTime.milliseconds / 3_600_000
              : null
            : row.workload[
                  metric === "durationSeconds" ? "durationKnown" : "sizeKnown"
                ] === row.records && row.workload[metric] !== null
              ? row.workload[metric]! /
                (metric === "durationSeconds" ? 3600 : 1024 ** 3)
              : null,
    }));
}

function dateFilter(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!isCalendarDay(value))
    throw new ReviewStatisticsFilterError("Expected a valid YYYY-MM-DD date");
  return value;
}

/** Count saved human marks; content duration is not an inspector's working time. */
export function computeWorkbenchReviewStatistics(
  collection: ReviewCollectionFile,
  filter: WorkbenchReviewStatisticsFilter = {},
  metrics: ReviewMetrics = {},
): WorkbenchReviewStatistics {
  const startDate = dateFilter(filter.startDate);
  const endDate = dateFilter(filter.endDate);
  if (startDate && endDate && startDate > endDate) {
    throw new ReviewStatisticsFilterError(
      "Start date must not follow end date",
    );
  }
  const endExclusive =
    calendarDateInputRange({ startDate, endDate }).endDate || null;
  const query = filter.query?.trim() ?? "";
  const reviewer = filter.reviewer?.trim() ?? "";
  const datasets: WorkbenchReviewDatasetStatistics[] = [];
  const people = new Map<
    string,
    WorkbenchReviewerStatistics & { datasetKeys: Set<string> }
  >();
  const daily = new Map<string, WorkbenchReviewStatistics["daily"][number]>();
  const personDaily = new Map<
    string,
    WorkbenchReviewerDailyStatistics & { datasetKeys: Set<string> }
  >();
  const workload = emptyWorkload();
  const dwellTime = emptyReviewDwellTime();
  const uniqueWorkload = emptyWorkload();
  const checkedEpisodes = new Map<string, Set<string>>();
  const personEpisodes = new Map<string, Map<string, Set<string>>>();
  const personDayEpisodes = new Map<string, Map<string, Set<string>>>();
  const history = new Map<
    string,
    Map<string, { reviewer: string; timestamp: string }[]>
  >();
  const track = (
    target: Map<string, Set<string>>,
    dataset: string,
    episode: string,
  ) => {
    const ids = target.get(dataset) ?? new Set<string>();
    ids.add(episode);
    target.set(dataset, ids);
  };
  const summary = {
    datasets: 0,
    inspected: 0,
    pending: 0,
    crossReviewed: 0,
    records: 0,
    reviewers: 0,
  };

  for (const [dataset, file] of Object.entries(collection.datasets)) {
    if (!dataset.toLowerCase().includes(query.toLowerCase())) continue;
    const datasetMetrics = Object.prototype.hasOwnProperty.call(
      metrics,
      dataset,
    )
      ? metrics[dataset]
      : undefined;
    const row: WorkbenchReviewDatasetStatistics = {
      dataset,
      dwellTime: emptyReviewDwellTime(),
      inspected: 0,
      pending: 0,
      crossReviewed: 0,
      records: 0,
      reviewers: 0,
      lastReviewedAt: "",
      workload: emptyWorkload(),
      uniqueWorkload: emptyWorkload(),
      metadata: datasetMetrics
        ? {
            totalEpisodes: datasetMetrics.totalEpisodes,
            episodeManifestComplete: datasetMetrics.episodeManifestComplete,
            manifestAudit: datasetMetrics.manifestAudit,
            totalFrames: datasetMetrics.totalFrames,
            totalDurationSeconds: datasetMetrics.totalDurationSeconds,
            totalSizeBytes: datasetMetrics.totalSizeBytes,
            ...(datasetMetrics.estimates
              ? { estimates: datasetMetrics.estimates }
              : {}),
          }
        : null,
    };
    const names = new Set<string>();
    for (const [episode, records] of Object.entries(file.episodes)) {
      // Status uses all saved marks up to the range end. A first inspection
      // before the range still makes a second person's mark a cross-review.
      const ordered = records
        .map((record) => ({
          ...record,
          timestamp: reviewTimestamp(record.reviewed_at),
        }))
        .filter((record) =>
          calendarDayInRange(
            calendarDayKey(record.timestamp),
            null,
            endExclusive,
          ),
        )
        .sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) ||
            a.reviewer.localeCompare(b.reviewer),
        );
      const unique = ordered.filter(
        (record, index) =>
          ordered.findIndex(
            (candidate) => candidate.reviewer === record.reviewer,
          ) === index,
      );
      const datasetHistory =
        history.get(dataset) ??
        new Map<string, { reviewer: string; timestamp: string }[]>();
      datasetHistory.set(episode, unique);
      history.set(dataset, datasetHistory);
      const selected = unique.flatMap((record, index) => {
        const day = calendarDayKey(record.timestamp);
        return calendarDayInRange(day, startDate, endExclusive) &&
          (!reviewer || record.reviewer === reviewer)
          ? [{ ...record, day, initial: index === 0 }]
          : [];
      });
      if (!selected.length) continue;
      track(checkedEpisodes, dataset, episode);
      row.inspected++;
      if (unique.length >= 2) row.crossReviewed++;
      else row.pending++;
      row.records += selected.length;
      const episodeMetrics = datasetMetrics?.episodes[episode];
      addWorkload(row.uniqueWorkload, episodeMetrics);
      addWorkload(uniqueWorkload, episodeMetrics);
      for (const record of selected) {
        addReviewDwellTime(dwellTime, record);
        addReviewDwellTime(row.dwellTime, record);
        addWorkload(row.workload, episodeMetrics);
        addWorkload(workload, episodeMetrics);
        names.add(record.reviewer);
        row.lastReviewedAt =
          record.timestamp > row.lastReviewedAt
            ? record.timestamp
            : row.lastReviewedAt;
        const person = people.get(record.reviewer) ?? {
          reviewer: record.reviewer,
          dwellTime: emptyReviewDwellTime(),
          datasets: 0,
          records: 0,
          initialInspections: 0,
          crossReviews: 0,
          lastReviewedAt: "",
          datasetKeys: new Set<string>(),
          workload: emptyWorkload(),
          datasetCoverage: datasetCoverageFor([], metrics),
          cumulativeDatasetCoverage: datasetCoverageFor([], metrics),
        };
        person.records++;
        addReviewDwellTime(person.dwellTime, record);
        person.initialInspections += Number(record.initial);
        person.crossReviews += Number(!record.initial);
        person.datasetKeys.add(dataset);
        person.lastReviewedAt =
          record.timestamp > person.lastReviewedAt
            ? record.timestamp
            : person.lastReviewedAt;
        people.set(record.reviewer, person);
        addWorkload(person.workload, episodeMetrics);
        const personDayKey = JSON.stringify([record.reviewer, record.day]);
        const inspectedByPerson =
          personEpisodes.get(record.reviewer) ?? new Map<string, Set<string>>();
        track(inspectedByPerson, dataset, episode);
        personEpisodes.set(record.reviewer, inspectedByPerson);
        const inspectedByDay =
          personDayEpisodes.get(personDayKey) ?? new Map<string, Set<string>>();
        track(inspectedByDay, dataset, episode);
        personDayEpisodes.set(personDayKey, inspectedByDay);
        const personDay = personDaily.get(personDayKey) ?? {
          reviewer: record.reviewer,
          dwellTime: emptyReviewDwellTime(),
          day: record.day,
          datasets: 0,
          records: 0,
          initialInspections: 0,
          crossReviews: 0,
          lastReviewedAt: "",
          datasetKeys: new Set<string>(),
          workload: emptyWorkload(),
          datasetCoverage: datasetCoverageFor([], metrics),
          cumulativeDatasetCoverage: datasetCoverageFor([], metrics),
        };
        personDay.records++;
        addReviewDwellTime(personDay.dwellTime, record);
        personDay.initialInspections += Number(record.initial);
        personDay.crossReviews += Number(!record.initial);
        personDay.datasetKeys.add(dataset);
        personDay.lastReviewedAt =
          record.timestamp > personDay.lastReviewedAt
            ? record.timestamp
            : personDay.lastReviewedAt;
        addWorkload(personDay.workload, episodeMetrics);
        personDaily.set(personDayKey, personDay);
        const day = daily.get(record.day) ?? {
          day: record.day,
          dwellTime: emptyReviewDwellTime(),
          records: 0,
          initialInspections: 0,
          crossReviews: 0,
          workload: emptyWorkload(),
        };
        day.records++;
        addReviewDwellTime(day.dwellTime, record);
        day.initialInspections += Number(record.initial);
        day.crossReviews += Number(!record.initial);
        addWorkload(day.workload, episodeMetrics);
        daily.set(day.day, day);
      }
    }
    if (!row.records) continue;
    row.reviewers = names.size;
    datasets.push(row);
    summary.inspected += row.inspected;
    summary.pending += row.pending;
    summary.crossReviewed += row.crossReviewed;
    summary.records += row.records;
  }

  summary.datasets = datasets.length;
  summary.reviewers = people.size;
  const preparedCoverage = new Map<string, PreparedCoverageMetadata>();
  const inTime = (timestamp: string, day: string | null) =>
    calendarDayInRange(calendarDayKey(timestamp), null, day);
  const scopedCoverage = (
    keys: Iterable<string>,
    checked: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
    day: string | null = endDate,
  ) => {
    const selectedKeys = [...keys];
    const crossed = new Map<string, Set<string>>();
    for (const dataset of selectedKeys) {
      for (const episode of checked.get(dataset) ?? []) {
        const reviewers = new Set(
          (history.get(dataset)?.get(episode) ?? [])
            .filter((record) => inTime(record.timestamp, day))
            .map((record) => record.reviewer),
        );
        if (reviewers.size >= 2) track(crossed, dataset, episode);
      }
    }
    return {
      ...datasetCoverageFor(
        selectedKeys,
        metrics,
        checked,
        crossed,
        preparedCoverage,
      ),
      asOfDay: day,
    };
  };
  const cumulativeCoverage = (
    keys: Iterable<string>,
    owner: string,
    day: string | null = endDate,
  ): ReviewDatasetCoverage => {
    const selectedKeys = [...keys];
    const accumulated = new Map<string, Set<string>>();
    for (const dataset of selectedKeys) {
      for (const [episode, records] of history.get(dataset) ?? []) {
        if (
          records.some(
            (record) =>
              (!owner || record.reviewer === owner) &&
              inTime(record.timestamp, day),
          )
        )
          track(accumulated, dataset, episode);
      }
    }
    return {
      ...scopedCoverage(selectedKeys, accumulated, day),
      scope: "cumulative",
    };
  };
  // Full touched-dataset scale is contextual coverage, never checked workload.
  const datasetCoverage = scopedCoverage(
    datasets.map((row) => row.dataset),
    checkedEpisodes,
  );
  return {
    summary,
    dwellTime,
    workload,
    uniqueWorkload,
    datasetCoverage,
    cumulativeDatasetCoverage: cumulativeCoverage(
      datasets.map((row) => row.dataset),
      reviewer,
    ),
    personDaily: [...personDaily.values()]
      .map(({ datasetKeys, ...person }) => ({
        ...person,
        datasets: datasetKeys.size,
        datasetCoverage: scopedCoverage(
          datasetKeys,
          personDayEpisodes.get(JSON.stringify([person.reviewer, person.day])),
          shiftCalendarDay(person.day, 1),
        ),
        cumulativeDatasetCoverage: cumulativeCoverage(
          datasetKeys,
          person.reviewer,
          shiftCalendarDay(person.day, 1),
        ),
      }))
      .sort(
        (a, b) =>
          b.day.localeCompare(a.day) ||
          b.records - a.records ||
          a.reviewer.localeCompare(b.reviewer),
      ),
    datasets: datasets.sort(
      (a, b) => b.records - a.records || a.dataset.localeCompare(b.dataset),
    ),
    people: [...people.values()]
      .map(({ datasetKeys, ...person }) => ({
        ...person,
        datasets: datasetKeys.size,
        datasetCoverage: scopedCoverage(
          datasetKeys,
          personEpisodes.get(person.reviewer),
        ),
        cumulativeDatasetCoverage: cumulativeCoverage(
          datasetKeys,
          person.reviewer,
        ),
      }))
      .sort(
        (a, b) => b.records - a.records || a.reviewer.localeCompare(b.reviewer),
      ),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    filters: { startDate, endDate, query, reviewer },
    updatedAt: collection.updated_at ?? null,
  };
}

export function workbenchReviewStatisticsCsv(
  statistics: WorkbenchReviewStatistics,
  scan?: ReviewStatisticsScan,
): string {
  const datasetProgress = new Map(
    statistics.datasetCoverage.progress.map((item) => [item.dataset, item]),
  );
  const dwellHeaders = [
    "Recorded foreground dwell seconds (saved capped snapshots; not human work hours)",
    "Recorded episode snapshot seconds (person-marks; not a coverage denominator)",
    "Marks with valid dwell snapshots",
    "All saved marks",
  ];
  const dwellValues = (dwell: ReviewDwellTime) => [
    dwell.milliseconds === null ? "" : dwell.milliseconds / 1000,
    dwell.episodeDurationMilliseconds === null
      ? ""
      : dwell.episodeDurationMilliseconds / 1000,
    dwell.knownRecords,
    dwell.records,
  ];
  const workloadHeaders = [
    "Episodes (person-marks)",
    "Known frames",
    "Known content seconds",
    "Known payload bytes",
    "Frame coverage",
    "Duration coverage",
    "Size coverage",
    "Estimated size episodes",
  ];
  const workloadValues = (workload: ReviewWorkload) => [
    workload.episodes,
    workload.frames ?? "",
    workload.durationSeconds ?? "",
    workload.sizeBytes ?? "",
    workload.framesKnown,
    workload.durationKnown,
    workload.sizeKnown,
    workload.estimatedSizeEpisodes,
  ];
  const coverageHeaders = [
    "Fully marked dataset content seconds (deduplicated; verified episode manifest)",
    "Fully marked datasets with known duration",
    "Fully marked datasets with estimated duration",
    "Fully marked datasets",
    "Partially marked datasets",
    "Unverified datasets",
    "Per-dataset inspection progress (JSON)",
    ...coverageMetrics.flatMap((metric) => [
      metric + " matched known weight",
      metric + " coverage denominator",
      metric + " coverage ratio",
      metric + " lower bound",
      metric + " upper bound",
      metric + " coverage status",
      metric + " denominator source",
      metric + " estimated",
    ]),
    "Cumulative cutoff (00:00 UTC+8, exclusive; surviving marks only)",
    "Cumulative coverage (JSON)",
    "Evidence level",
    "Acceptance assessment",
  ];
  const coverageValues = (
    coverage: ReviewDatasetCoverage,
    cumulative: ReviewDatasetCoverage,
  ) => [
    coverage.fullyInspectedDurationSeconds ?? "",
    coverage.fullyInspectedDurationKnownDatasets,
    coverage.fullyInspectedEstimatedDurationDatasets,
    coverage.fullyInspectedDatasets,
    coverage.partialDatasets,
    coverage.unknownDatasets,
    JSON.stringify(coverage.progress),
    ...coverageMetrics.flatMap((metric) => {
      const row = coverage.measures[metric];
      return [
        row.knownChecked ?? "",
        row.total ?? "",
        row.ratio ?? "",
        row.lowerBound ?? "",
        row.upperBound ?? "",
        row.status,
        row.source,
        String(row.estimated),
      ];
    }),
    cumulative.asOfDay ?? "latest surviving marks",
    JSON.stringify(cumulative),
    "saved-episode-marks",
    "not-assessed",
  ];
  const estimateFields = [
    "totalFrames",
    "totalDurationSeconds",
    "totalSizeBytes",
  ] as const;
  const rows: (string | number)[][] = [
    [
      "Dwell totals sum known saved foreground snapshots only; each is capped at twice the episode duration when recorded, not complete human working time. Missing legacy snapshots are blank, not zero. Snapshots are attributed to the original mark date (UTC+8), including later backfills, not to a daily activity log. Episode snapshot seconds count person-marks and never replace metadata content duration or coverage denominators.",
    ],
    [
      "Checked episode duration is not human working time. Coverage uses surviving episode marks, not proof of frame-by-frame viewing, matching data revisions, sampling adequacy or quality acceptance. Period workload counts only selected marks; cumulative coverage includes earlier surviving marks through the cutoff for datasets in the row. A fully marked dataset requires a verified complete episode manifest and a matching mark for every identity. Unmatched records are isolated. Weight coverage uses actual content sums, never an average of dataset percentages; missing weights retain provable bounds and estimates never certify completion. Full touched-dataset scale is reference only. Shared v3 payload bytes are apportioned by frame/segment-duration shares and marked estimated. Missing metrics are blank; known sums may be partial.",
    ],
    ["Dataset statistics"],
    [
      "Dataset",
      "Inspected episodes",
      "Awaiting cross-review",
      "Cross-reviewed episodes",
      "Saved marks",
      "Inspectors",
      "Last inspection (UTC+8)",
      "Unique known frames",
      "Unique known content seconds",
      "Unique known payload bytes",
      "Unique frame coverage",
      "Unique duration coverage",
      "Unique size coverage",
      "Unique estimated size episodes",
      ...workloadHeaders,
      "Record source files",
      ...dwellHeaders,
    ],
    ...statistics.datasets.map((row) => [
      row.dataset,
      row.inspected,
      row.pending,
      row.crossReviewed,
      row.records,
      row.reviewers,
      row.lastReviewedAt,
      row.uniqueWorkload.frames ?? "",
      row.uniqueWorkload.durationSeconds ?? "",
      row.uniqueWorkload.sizeBytes ?? "",
      row.uniqueWorkload.framesKnown,
      row.uniqueWorkload.durationKnown,
      row.uniqueWorkload.sizeKnown,
      row.uniqueWorkload.estimatedSizeEpisodes,
      ...workloadValues(row.workload),
      (row.sources ?? []).join(" | "),
      ...dwellValues(row.dwellTime),
    ]),
    [],
    ["Touched dataset scale (reference only; not checked workload)"],
    [
      "Dataset",
      "Dataset total episodes",
      "Dataset total frames",
      "Dataset total content seconds",
      "Dataset referenced payload bytes",
      ...estimateFields.flatMap((field) => [
        field + " estimated",
        field + " sample episodes",
        field + " population episodes",
      ]),
      "Complete episode manifest verified",
      "Checked episodes",
      "Episode coverage ratio",
      "Inspection coverage status",
    ],
    ...statistics.datasets.map((row) => [
      row.dataset,
      row.metadata?.totalEpisodes ?? "",
      row.metadata?.totalFrames ?? "",
      row.metadata?.totalDurationSeconds ?? "",
      row.metadata?.totalSizeBytes ?? "",
      ...estimateFields.flatMap((field) => {
        const estimate = row.metadata?.estimates?.[field];
        return [
          estimate ? "true" : "false",
          estimate?.sampleEpisodes ?? "",
          estimate?.totalEpisodes ?? "",
        ];
      }),
      String(row.metadata?.episodeManifestComplete === true),
      row.inspected,
      datasetProgress.get(row.dataset)?.episodeRatio ?? "",
      datasetProgress.get(row.dataset)?.status ?? "unknown",
    ]),
    [],
    ["Inspector daily workload (UTC+8)"],
    [
      "Day",
      "Inspector",
      "Datasets",
      "Initial marks",
      "Cross-review marks",
      ...workloadHeaders,
      ...coverageHeaders,
      ...dwellHeaders,
    ],
    ...statistics.personDaily.map((row) => [
      row.day,
      row.reviewer,
      row.datasets,
      row.initialInspections,
      row.crossReviews,
      ...workloadValues(row.workload),
      ...coverageValues(row.datasetCoverage, row.cumulativeDatasetCoverage),
      ...dwellValues(row.dwellTime),
    ]),
    [],
    ["Inspector totals"],
    [
      "Inspector",
      "Datasets",
      "Initial marks",
      "Cross-review marks",
      ...workloadHeaders,
      ...coverageHeaders,
      ...dwellHeaders,
    ],
    ...statistics.people.map((row) => [
      row.reviewer,
      row.datasets,
      row.initialInspections,
      row.crossReviews,
      ...workloadValues(row.workload),
      ...coverageValues(row.datasetCoverage, row.cumulativeDatasetCoverage),
      ...dwellValues(row.dwellTime),
    ]),
  ];
  if (scan)
    rows.push(
      [],
      ["Record discovery"],
      [
        "Recursive",
        String(scan.recursive),
        "Truncated",
        String(scan.truncated),
        "Duplicate marks removed",
        scan.duplicateMarks,
        "Conflicting marks",
        scan.conflictingMarks,
      ],
      ["Search roots", ...scan.roots],
      [
        "Source file",
        "Record directory",
        "Datasets",
        "Saved marks before deduplication",
      ],
      ...scan.sources.map((source) => [
        source.path,
        source.directory,
        source.datasets,
        source.records,
      ]),
      ["Scan warnings"],
      ...scan.warnings.map((warning) => [warning.path, warning.message]),
    );
  const escape = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return (
    "\uFEFF" +
    rows.map((row) => row.map(escape).join(",")).join("\r\n") +
    "\r\n"
  );
}
