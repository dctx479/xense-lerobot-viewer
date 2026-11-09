"use client";

import { formatCalendarDateTime } from "@/utils/calendarTime";
import styles from "@/components/workbench-review-statistics.module.css";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  FiDatabase,
  FiCheckSquare,
  FiUsers,
  FiClock,
  FiHardDrive,
  FiBarChart2,
  FiCalendar,
  FiCheckCircle,
  FiRepeat,
  FiChevronDown,
  FiRefreshCw,
  FiDownload,
} from "react-icons/fi";
import {
  ReviewDailyWorkloadChart,
  ReviewMarkTrendChart,
} from "@/components/workbench-review-charts";
import { useLocale } from "@/context/locale-context";
import { ReviewDwellTimeValue } from "@/components/review-dwell-time-value";
import { useEpisodeReviewData } from "@/context/episode-reviews-context";
import { reviewDateRange } from "@/utils/reviewTime";
import type {
  ReviewWorkload,
  ReviewDatasetCoverage,
  WorkbenchReviewStatistics,
  ReviewDailyChartMetric,
} from "@/utils/workbenchReviewStatistics";
import { buildWorkbenchReviewDailyChart } from "@/utils/workbenchReviewStatistics";
import {
  coveragePercent,
  type CoverageMeasure,
  type CoverageIssue,
} from "@/utils/reviewCoverage";
import type { ReviewStatisticsScan } from "@/types/review-statistics-scan.types";

type Overview = {
  statistics: WorkbenchReviewStatistics;
  browse_path: string;
  storage_path: string | null;
  source_scan: ReviewStatisticsScan;
};

const CONTROL =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/10 bg-[var(--surface-1)] px-3 py-2 text-xs text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50";
const PANEL =
  "rounded-xl border border-white/10 bg-[var(--surface-1)]/40 p-4 sm:p-5";
const ALL_DIRECTORIES = "__all_registered__";
const DETAIL_TABLE =
  "w-full text-left text-xs leading-5 tabular-nums [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3";

function ReviewDetailColumns({
  people = false,
  datasets = false,
}: {
  people?: boolean;
  datasets?: boolean;
}) {
  const widths = datasets
    ? [200, 72, 72, 72, 72, 72, 152, 110, 110, 104, 224, 180]
    : people
      ? [112, 72, 88, 88, 88, 152, 120, 120, 112, 184, 300]
      : [112, 96, 72, 88, 88, 88, 152, 120, 120, 112, 300];
  return (
    <colgroup>
      {widths.map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  );
}

function ReviewMetricHeading({ metric }: { metric: WorkloadMetric | "dwell" }) {
  const { t } = useLocale();
  return (
    <>
      <span className="block whitespace-nowrap">
        {t(
          metric === "dwell"
            ? "review.statisticsDwellShort"
            : "review.statisticsCheckedEpisodeShort",
        )}
      </span>
      <span className="block whitespace-nowrap text-[10px] font-normal text-slate-400">
        {t(
          metric === "dwell"
            ? "review.statisticsForeground"
            : metric === "frames"
              ? "common.frames"
              : metric === "durationSeconds"
                ? "review.statisticsContentDurationShort"
                : "review.statisticsPayloadShort",
        )}
      </span>
    </>
  );
}

type WorkloadMetric = "frames" | "durationSeconds" | "sizeBytes";

function payloadSize(bytes: number, locale: string) {
  const index =
    bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  const unit = ["B", "KiB", "MiB", "GiB"][index];
  return (
    (bytes / 1024 ** index).toLocaleString(locale, {
      maximumFractionDigits: 2,
    }) +
    " " +
    unit
  );
}

function WorkloadValue({
  workload,
  metric,
}: {
  workload: ReviewWorkload;
  metric: WorkloadMetric;
}) {
  const { t, locale } = useLocale();
  const known =
    workload[
      metric === "frames"
        ? "framesKnown"
        : metric === "durationSeconds"
          ? "durationKnown"
          : "sizeKnown"
    ];
  const value = workload[metric];
  const language = locale === "zh" ? "zh-CN" : "en-US";
  return (
    <div className="whitespace-nowrap" data-workload-metric={metric}>
      <span>
        {value === null
          ? t("review.statisticsUnknown")
          : (metric === "sizeBytes" && workload.estimatedSizeEpisodes > 0
              ? "≈ "
              : "") +
            (metric === "sizeBytes"
              ? payloadSize(value, language)
              : metric === "durationSeconds"
                ? value < 60
                  ? value.toLocaleString(language, {
                      maximumFractionDigits: 2,
                    }) +
                    " " +
                    t("review.statisticsSeconds")
                  : value < 3600
                    ? (value / 60).toLocaleString(language, {
                        maximumFractionDigits: 2,
                      }) +
                      " " +
                      t("review.statisticsMinutes")
                    : (value / 3600).toLocaleString(language, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      }) +
                      " " +
                      t("review.statisticsHours")
                : value.toLocaleString(language))}
      </span>
      {known < workload.episodes && (
        <div className="mt-1 text-[10px] font-normal text-amber-300">
          {t("review.statisticsKnown", { known, total: workload.episodes })}
        </div>
      )}
    </div>
  );
}

function WorkloadCells({ workload }: { workload: ReviewWorkload }) {
  const { t } = useLocale();
  return (
    <>
      {(["frames", "durationSeconds", "sizeBytes"] as const).map((metric) => (
        <td
          key={metric}
          data-label={t(
            metric === "frames"
              ? "review.statisticsFrames"
              : metric === "durationSeconds"
                ? "review.statisticsDuration"
                : "review.statisticsSize",
          )}
          className="whitespace-nowrap text-right"
        >
          <WorkloadValue workload={workload} metric={metric} />
        </td>
      ))}
    </>
  );
}

function CoverageRatio({ measure }: { measure: CoverageMeasure }) {
  const { t, locale } = useLocale();
  if (measure.status === "inconsistent")
    return <span>{t("review.statisticsCoverageUnknown")}</span>;
  if (measure.status === "not-applicable")
    return <span>{t("review.statisticsCoverageNotApplicable")}</span>;
  return (
    <span>
      {measure.estimated ? "≈ " : ""}
      {measure.ratio !== null
        ? coveragePercent(measure.ratio, locale)
        : measure.lowerBound !== null && measure.upperBound !== null
          ? coveragePercent(measure.lowerBound, locale) +
            "–" +
            coveragePercent(measure.upperBound, locale, "up")
          : t("review.statisticsUnknown")}
    </span>
  );
}

function CoverageIssueLabel({ issue }: { issue: CoverageIssue }) {
  const { t } = useLocale();
  return (
    <span>
      {t(
        issue === "metadata-unavailable"
          ? "review.coverageIssueMetadata"
          : issue === "manifest-unverified"
            ? "review.coverageIssueManifest"
            : issue === "manifest-count-mismatch"
              ? "review.coverageIssueCount"
              : issue === "manifest-invalid-ids"
                ? "review.coverageIssueIdentity"
                : issue === "manifest-duplicate-ids"
                  ? "review.coverageIssueDuplicates"
                  : issue === "metadata-read-failure"
                    ? "review.coverageIssueRead"
                    : issue === "unmatched-records"
                      ? "review.coverageIssueUnmatched"
                      : issue === "invalid-record-ids"
                        ? "review.coverageIssueInvalidRecords"
                        : "review.coverageIssueWeight",
      )}
    </span>
  );
}

function DatasetName({ name }: { name: string }) {
  const basename =
    name.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? name;
  return (
    <div className="min-w-0" title={name}>
      <div className="break-words font-medium text-slate-100">{basename}</div>
      {name !== basename && (
        <div className="mt-1 max-w-sm break-all text-[10px] font-normal leading-4 text-slate-400">
          {name}
        </div>
      )}
    </div>
  );
}

function CoverageMeasureCard({
  measure,
  metric,
  compact = false,
}: {
  measure: CoverageMeasure;
  metric: WorkloadMetric;
  compact?: boolean;
}) {
  const { t, locale } = useLocale();
  const visible =
    measure.status !== "unknown" &&
    measure.status !== "inconsistent" &&
    measure.status !== "not-applicable";
  const lower = visible ? (measure.ratio ?? measure.lowerBound) : null;
  const upper = visible ? (measure.ratio ?? measure.upperBound) : null;
  const format = (value: number | null) =>
    value === null
      ? t("review.statisticsUnknown")
      : metric === "sizeBytes"
        ? payloadSize(value, locale)
        : metric === "durationSeconds"
          ? value < 60
            ? value.toLocaleString(locale, { maximumFractionDigits: 2 }) +
              " " +
              t("review.statisticsSeconds")
            : value < 3600
              ? (value / 60).toLocaleString(locale, {
                  maximumFractionDigits: 2,
                }) +
                " " +
                t("review.statisticsMinutes")
              : (value / 3600).toLocaleString(locale, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }) +
                " " +
                t("review.statisticsHours")
          : value.toLocaleString(locale);
  const inferred =
    measure.status === "exact" &&
    measure.knownCheckedEpisodes < measure.checkedEpisodes;
  return (
    <div
      className={
        compact
          ? "min-w-[160px] space-y-1.5"
          : "min-w-0 space-y-2 rounded-lg border border-white/10 bg-black/10 p-3"
      }
      data-coverage-status={measure.status}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-slate-400">
          {t(
            metric === "frames"
              ? "review.statisticsFramesCoverage"
              : metric === "durationSeconds"
                ? "review.statisticsDurationCoverage"
                : "review.statisticsSizeCoverage",
          )}
        </span>
        <span
          className={
            "font-semibold tabular-nums " +
            (measure.estimated || measure.status === "inconsistent"
              ? "text-amber-200"
              : "text-cyan-100")
          }
        >
          <CoverageRatio measure={measure} />
        </span>
      </div>
      <div
        aria-hidden="true"
        className="relative h-1.5 overflow-hidden rounded-full bg-white/10"
      >
        {upper !== null && (
          <div
            className="absolute inset-y-0 left-0 bg-cyan-300/20"
            style={{ width: upper * 100 + "%" }}
          />
        )}
        {lower !== null && (
          <div
            className={
              "absolute inset-y-0 left-0 " +
              (measure.estimated ? "bg-amber-400" : "bg-cyan-400")
            }
            style={{ width: lower * 100 + "%" }}
          />
        )}
      </div>
      <div className="text-[10px] leading-4 text-slate-400">
        {measure.knownCheckedEpisodes < measure.checkedEpisodes
          ? t("review.statisticsKnownWeight") + " "
          : ""}
        {format(
          measure.knownCheckedEpisodes === 0 && measure.checkedEpisodes > 0
            ? null
            : measure.knownChecked,
        )}{" "}
        / {measure.source === "estimated" ? "≈ " : ""}
        {format(measure.total)}
      </div>
      {measure.knownCheckedEpisodes < measure.checkedEpisodes && (
        <div className="text-[10px] text-amber-300">
          {t("review.statisticsKnown", {
            known: measure.knownCheckedEpisodes,
            total: measure.checkedEpisodes,
          })}
        </div>
      )}
      {(!compact || inferred) && (
        <div className="text-[10px] leading-4 text-slate-400">
          {t(
            inferred
              ? "review.statisticsCoverageInferred"
              : measure.estimated
                ? "review.statisticsCoverageEstimate"
                : measure.status === "bounded"
                  ? "review.statisticsCoverageBounds"
                  : measure.source === "manifest"
                    ? "review.statisticsCoverageManifest"
                    : measure.source === "declared"
                      ? "review.statisticsCoverageDeclared"
                      : "review.statisticsCoverageUnknown",
          )}
        </div>
      )}
    </div>
  );
}

function DatasetCoverageProgress({
  progress,
}: {
  progress?: ReviewDatasetCoverage["progress"][number];
}) {
  const { t, locale } = useLocale();
  return (
    <div className="min-w-[160px] space-y-1 text-xs tabular-nums">
      {progress ? progress.matchedEpisodes.toLocaleString(locale) : "—"} /{" "}
      {progress?.totalEpisodes == null
        ? t("review.statisticsUnknown")
        : progress.totalEpisodes.toLocaleString(locale)}
      <span className="ml-2 text-[10px] text-slate-400">
        {t(
          progress?.status === "complete"
            ? "review.statisticsCoverageComplete"
            : progress?.status === "partial"
              ? "review.statisticsCoveragePartial"
              : progress?.status === "uninspected"
                ? "review.statisticsCoverageUninspected"
                : progress?.status === "empty"
                  ? "review.statisticsCoverageEmpty"
                  : "review.statisticsCoverageUnknown",
        )}
      </span>
      {progress &&
        progress.episodeLowerBound !== null &&
        progress.episodeUpperBound !== null && (
          <div className="text-[10px] text-slate-400">
            {t("review.statisticsEpisodeCoverage")}:{" "}
            {coveragePercent(progress.episodeLowerBound, locale)}
            {progress.episodeUpperBound !== progress.episodeLowerBound
              ? "–" + coveragePercent(progress.episodeUpperBound, locale, "up")
              : ""}
          </div>
        )}
      {progress && (
        <span className="ml-2 text-[10px] text-slate-400">
          {t("review.statisticsCrossCoverage", {
            checked: progress.crossReviewedEpisodes,
            total: progress.totalEpisodes ?? t("review.statisticsUnknown"),
          })}
        </span>
      )}
      {progress && progress.issues.length > 0 && (
        <details className="mt-1 text-[10px] text-amber-300">
          <summary className="cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-cyan-400">
            {t("review.statisticsCoverageIssues", {
              count: progress.issues.length,
            })}
          </summary>
          {progress.issues.map((issue) => (
            <div key={issue}>
              <CoverageIssueLabel issue={issue} />
            </div>
          ))}
        </details>
      )}
      {progress &&
        progress.unmatchedEpisodes + progress.invalidEpisodes > 0 && (
          <div className="text-[10px] text-amber-300">
            {t("review.statisticsUnmatchedCount", {
              count: progress.unmatchedEpisodes + progress.invalidEpisodes,
            })}
          </div>
        )}
    </div>
  );
}

function DatasetCoverageDuration({
  coverage,
  cumulative,
  expanded,
  controlsId,
  onToggle,
  triggerRef,
}: {
  coverage: ReviewDatasetCoverage;
  cumulative?: ReviewDatasetCoverage;
  expanded: boolean;
  controlsId: string;
  onToggle: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, locale } = useLocale();
  const duration = coverage.measures.durationSeconds;
  const hours = (value: number | null) =>
    value === null
      ? t("review.statisticsUnknown")
      : (value / 3600).toLocaleString(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }) +
        " " +
        t("review.statisticsHours");
  return (
    <div
      data-coverage-layout="compact"
      className="min-w-0 space-y-1.5 text-left leading-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
        <span className="flex items-baseline gap-2">
          <span className="text-slate-400">
            {t("review.statisticsPeriodCoverage")}
          </span>{" "}
          <span className="font-medium text-cyan-100">
            <CoverageRatio measure={duration} />
          </span>
        </span>
        {cumulative && (
          <span
            className="flex items-baseline gap-2 text-slate-400"
            title={
              t("review.statisticsCumulativeCoverage") +
              (cumulative.asOfDay
                ? " · " +
                  t("review.statisticsCutoffTime", { date: cumulative.asOfDay })
                : "")
            }
          >
            <span>{t("review.statisticsCumulativeCompact")}</span>
            <span className="font-medium text-cyan-200">
              <CoverageRatio measure={cumulative.measures.durationSeconds} />
            </span>
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        className="h-1 overflow-hidden rounded-full bg-white/10"
      >
        {duration.ratio !== null && (
          <div
            className={
              "h-full " + (duration.estimated ? "bg-amber-400" : "bg-cyan-400")
            }
            style={{ width: duration.ratio * 100 + "%" }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-[10px] text-slate-400">
        <span>
          {duration.knownCheckedEpisodes === 0 && duration.checkedEpisodes > 0
            ? t("review.statisticsUnknown")
            : hours(duration.knownChecked)}{" "}
          / {duration.source === "estimated" ? "≈ " : ""}
          {hours(duration.total)}
        </span>
        {duration.knownCheckedEpisodes < duration.checkedEpisodes && (
          <span
            className="text-amber-300"
            title={
              duration.status === "exact"
                ? t("review.statisticsCoverageInferred")
                : undefined
            }
          >
            {t("review.statisticsKnown", {
              known: duration.knownCheckedEpisodes,
              total: duration.checkedEpisodes,
            })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-white/5 pt-1">
        <span className="text-[10px] text-slate-400">
          {t("review.statisticsCoverageSummary", {
            complete: coverage.fullyInspectedDatasets,
            partial: coverage.partialDatasets,
            unknown: coverage.unknownDatasets,
          })}
        </span>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={onToggle}
          className={
            CONTROL +
            " shrink-0 gap-1.5 border-transparent px-2 text-cyan-200 hover:border-white/10 hover:bg-white/5"
          }
        >
          {t(
            expanded
              ? "review.statisticsHideCoverageDetails"
              : "review.statisticsShowCoverageDetails",
          )}
          <FiChevronDown
            className={
              "shrink-0 transition-transform motion-reduce:transition-none" +
              (expanded ? " rotate-180" : "")
            }
            aria-hidden="true"
          />
        </button>
      </div>
    </div>
  );
}

function FullyMarkedDatasetDuration({
  coverage,
}: {
  coverage: ReviewDatasetCoverage;
}) {
  const { t, locale } = useLocale();
  const value = coverage.fullyInspectedDurationSeconds;
  return (
    <div
      className="text-[11px] leading-5 text-slate-400"
      data-coverage="fully-marked-duration"
    >
      {t("review.statisticsFullyMarkedDuration")}:{" "}
      {coverage.fullyInspectedEstimatedDurationDatasets > 0 ? "≈ " : ""}
      {value === null
        ? t("review.statisticsUnknown")
        : (value / 3600).toLocaleString(locale, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }) +
          " " +
          t("review.statisticsHours")}
      {coverage.fullyInspectedDurationKnownDatasets <
        coverage.fullyInspectedDatasets && (
        <span className="ml-2 text-amber-300">
          {t("review.statisticsKnownDatasets", {
            known: coverage.fullyInspectedDurationKnownDatasets,
            total: coverage.fullyInspectedDatasets,
          })}
        </span>
      )}
    </div>
  );
}

export function WorkbenchReviewCoverageDetails({
  coverage,
  cumulative,
  label,
  id,
  onClose,
}: {
  coverage: ReviewDatasetCoverage;
  cumulative?: ReviewDatasetCoverage;
  label: string;
  id: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const cumulativeProgress = useMemo(
    () => new Map(cumulative?.progress.map((row) => [row.dataset, row]) ?? []),
    [cumulative],
  );
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return coverage.progress.filter((row) =>
      row.dataset.toLowerCase().includes(search),
    );
  }, [coverage.progress, query]);
  return (
    <div
      id={id}
      role="region"
      aria-labelledby={id + "-title"}
      className="sticky left-0 w-[100cqw] max-w-full space-y-4 p-4 sm:p-5"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h5
            id={id + "-title"}
            className="break-words text-sm font-semibold text-slate-100"
          >
            {label} · {t("review.statisticsCoverageDetailTitle")}
          </h5>
          {cumulative?.asOfDay && (
            <p className="text-xs text-slate-400">
              {t("review.statisticsCumulativeCoverage")} ·{" "}
              {t("review.statisticsCutoffTime", { date: cumulative.asOfDay })}
            </p>
          )}
          <FullyMarkedDatasetDuration coverage={coverage} />
        </div>
        <button
          type="button"
          className={CONTROL + " shrink-0 hover:bg-white/5"}
          onClick={onClose}
        >
          <FiChevronDown className="rotate-180" aria-hidden="true" />
          {t("review.statisticsHideCoverageDetails")}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id + "-search"} className="sr-only">
          {t("review.statisticsCoverageDetailSearch")}
        </label>
        <input
          id={id + "-search"}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("review.statisticsCoverageDetailSearch")}
          className={
            CONTROL + " w-full min-w-0 sm:w-auto sm:max-w-md sm:flex-1"
          }
        />
        <span role="status" className="text-xs text-slate-400">
          {t("review.statisticsCoverageDetailCount", {
            visible: filtered.length,
            total: coverage.progress.length,
          })}
        </span>
      </div>
      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-slate-400">
          {t("review.statisticsCoverageDetailEmpty")}
        </p>
      ) : (
        <ul
          className="grid items-start gap-4"
          style={{
            gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))",
          }}
        >
          {filtered.map((progress) => {
            const accumulated = cumulativeProgress.get(progress.dataset);
            return (
              <li
                key={progress.dataset}
                data-coverage-dataset={progress.dataset}
                className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-[var(--surface-1)] p-4"
              >
                <DatasetName name={progress.dataset} />
                <DatasetCoverageProgress progress={progress} />
                <div
                  className="grid gap-2"
                  style={{
                    gridTemplateColumns:
                      "repeat(auto-fit,minmax(min(100%,160px),1fr))",
                  }}
                >
                  {(["frames", "durationSeconds", "sizeBytes"] as const).map(
                    (metric) => (
                      <CoverageMeasureCard
                        key={metric}
                        metric={metric}
                        measure={progress.measures[metric]}
                      />
                    ),
                  )}
                </div>
                {accumulated && (
                  <div className="space-y-2 border-t border-white/10 pt-3 text-cyan-200">
                    <div className="text-xs font-medium">
                      {t("review.statisticsCumulativeCoverage")}
                    </div>
                    <DatasetCoverageProgress progress={accumulated} />
                    <CoverageMeasureCard
                      metric="durationSeconds"
                      measure={accumulated.measures.durationSeconds}
                      compact
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ReviewCoverageTableRow({
  children,
  coverage,
  cumulative,
  label,
}: {
  children: ReactNode;
  coverage: ReviewDatasetCoverage;
  cumulative?: ReviewDatasetCoverage;
  label: string;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setExpanded(false);
    triggerRef.current?.focus();
  };
  return (
    <>
      <tr
        data-review-row="summary"
        role="row"
        className="border-b border-white/5 align-middle text-slate-300 hover:bg-white/[0.035]"
      >
        {children}
        <td
          data-label={t("review.statisticsCoveredDatasetDuration")}
          className={styles.coverageCell + " text-slate-400"}
        >
          <DatasetCoverageDuration
            coverage={coverage}
            cumulative={cumulative}
            expanded={expanded}
            controlsId={detailId}
            onToggle={() => setExpanded((value) => !value)}
            triggerRef={triggerRef}
          />
        </td>
      </tr>
      <tr data-review-row="details" role="row" hidden={!expanded}>
        <td
          colSpan={11}
          className="border-b border-cyan-400/20 bg-cyan-500/[0.025] !p-0"
        >
          <WorkbenchReviewCoverageDetails
            coverage={coverage}
            cumulative={cumulative}
            label={label}
            id={detailId}
            onClose={close}
          />
        </td>
      </tr>
    </>
  );
}

export function WorkbenchReviewStatisticsOverview({
  statistics,
}: {
  statistics: WorkbenchReviewStatistics;
}) {
  const { t, locale } = useLocale();
  const tableId = useId();
  const [person, setPerson] = useState("");
  const datasetProgress = useMemo(
    () =>
      new Map(
        statistics.datasetCoverage.progress.map((item) => [item.dataset, item]),
      ),
    [statistics.datasetCoverage.progress],
  );
  const [dailyMetric, setDailyMetric] =
    useState<ReviewDailyChartMetric>("records");
  const selectedPerson = statistics.people.some(
    (row) => row.reviewer === person,
  )
    ? person
    : "";
  const personRows = useMemo(
    () =>
      statistics.personDaily.filter(
        (row) => !selectedPerson || row.reviewer === selectedPerson,
      ),
    [statistics.personDaily, selectedPerson],
  );
  const personChart = useMemo(
    () =>
      buildWorkbenchReviewDailyChart(statistics, dailyMetric, selectedPerson),
    [statistics, dailyMetric, selectedPerson],
  );
  const personDays = useMemo(() => {
    const days = new Map<string, typeof personRows>();
    for (const row of personRows) {
      const group = days.get(row.day) ?? [];
      group.push(row);
      days.set(row.day, group);
    }
    return [...days].sort(([a], [b]) => a.localeCompare(b));
  }, [personRows]);
  const count = (value: number) =>
    value.toLocaleString(locale === "zh" ? "zh-CN" : "en-US");
  const timestamp = (value: string) =>
    formatCalendarDateTime(value, locale === "zh" ? "zh-CN" : "en-US");
  const cards = [
    {
      label: t("review.statisticsDatasets"),
      icon: FiDatabase,
      value: statistics.summary.datasets,
      tone: "border-white/10 bg-[var(--surface-1)]/65",
    },
    {
      label: t("review.statisticsEpisodes"),
      icon: FiCheckSquare,
      value: statistics.summary.inspected,
      tone: "border-cyan-400/25 bg-cyan-500/[0.06]",
    },
    {
      label: t("review.statisticsPending"),
      icon: FiClock,
      value: statistics.summary.pending,
      tone: "border-amber-400/25 bg-amber-500/[0.06]",
    },
    {
      label: t("review.statisticsCrossReviewed"),
      icon: FiCheckCircle,
      value: statistics.summary.crossReviewed,
      tone: "border-emerald-400/25 bg-emerald-500/[0.06]",
    },
    {
      label: t("review.statisticsRecords"),
      icon: FiRepeat,
      value: statistics.summary.records,
      tone: "border-cyan-400/25 bg-cyan-500/[0.06]",
    },
    {
      label: t("review.statisticsPeople"),
      icon: FiUsers,
      value: statistics.summary.reviewers,
      tone: "border-white/10 bg-[var(--surface-1)]/65",
    },
  ];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <div
            key={card.label}
            className={"rounded-md border p-4 " + card.tone}
          >
            <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-300">
              {card.label}
              <card.icon
                className="h-4 w-4 text-slate-400"
                aria-hidden="true"
              />
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-100">
              {count(card.value)}
            </div>
          </div>
        ))}
      </div>

      {!!statistics.summary.records && (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className={PANEL}>
              <div className="flex items-center gap-2 text-xs text-slate-300">
                <FiClock aria-hidden="true" className="text-violet-300" />
                {t("review.statisticsDwell")}
              </div>
              <div className="mt-2 text-xl font-semibold text-violet-100">
                <ReviewDwellTimeValue dwell={statistics.dwellTime} details />
              </div>
            </div>
            {(
              [
                [
                  "review.statisticsWorkloadDuration",
                  statistics.workload,
                  "durationSeconds",
                ],
                [
                  "review.statisticsUniqueDuration",
                  statistics.uniqueWorkload,
                  "durationSeconds",
                ],
                [
                  "review.statisticsWorkloadSize",
                  statistics.workload,
                  "sizeBytes",
                ],
              ] as const
            ).map(([label, workload, metric]) => (
              <div key={label} className={PANEL}>
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  {metric === "sizeBytes" ? (
                    <FiHardDrive aria-hidden="true" className="text-cyan-300" />
                  ) : (
                    <FiClock aria-hidden="true" className="text-cyan-300" />
                  )}
                  {t(label)}
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums text-cyan-100">
                  <WorkloadValue workload={workload} metric={metric} />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs leading-6 text-slate-400">
            {t("review.statisticsDwellHint")}
          </p>
          <p className="text-xs leading-6 text-slate-400">
            {t("review.statisticsWorkloadHint")}
          </p>
        </>
      )}

      {!statistics.summary.records ? (
        <p className={PANEL + " text-sm text-slate-400"}>
          {t("review.statisticsEmpty")}
        </p>
      ) : (
        <>
          <section
            className={PANEL}
            aria-label={t("review.statisticsCoverageOverview")}
          >
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <FiBarChart2 aria-hidden="true" className="text-cyan-300" />
              {t("review.statisticsCoverageOverview")}
            </h4>
            <p className="my-3 max-w-4xl text-xs leading-5 text-slate-400">
              {t("review.statisticsCoverageOverviewHint")}
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {(["frames", "durationSeconds", "sizeBytes"] as const).map(
                (metric) => (
                  <CoverageMeasureCard
                    key={metric}
                    metric={metric}
                    measure={statistics.datasetCoverage.measures[metric]}
                  />
                ),
              )}
            </div>
          </section>
          <section
            className={PANEL}
            aria-label={t("review.statisticsPersonDaily")}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h4
                className="flex items-center gap-2 text-sm font-semibold text-slate-200"
                id={tableId + "-daily"}
              >
                <FiUsers aria-hidden="true" className="text-cyan-300" />
                {t("review.statisticsPersonDaily")}
              </h4>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={t("review.reviewer")}
                  className={CONTROL}
                  value={selectedPerson}
                  onChange={(event) => setPerson(event.target.value)}
                >
                  <option value="">{t("review.statisticsAllPeople")}</option>
                  {statistics.people.map((row) => (
                    <option key={row.reviewer} value={row.reviewer}>
                      {row.reviewer}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("review.statisticsPersonDaily")}
                  className={CONTROL}
                  value={dailyMetric}
                  onChange={(event) =>
                    setDailyMetric(event.target.value as typeof dailyMetric)
                  }
                >
                  <option value="records">
                    {t("review.statisticsRecords")}
                  </option>
                  <option value="durationSeconds">
                    {t("review.statisticsDuration")} (
                    {t("review.statisticsHours")})
                  </option>
                  <option value="dwellSeconds">
                    {t("review.statisticsDwell")} ({t("review.statisticsHours")}
                    )
                  </option>
                  <option value="sizeBytes">
                    {t("review.statisticsSize")} (GiB)
                  </option>
                </select>
              </div>
            </div>
            <p className="mb-4 text-xs leading-5 text-slate-400">
              {t("review.statisticsDailyHint")}
            </p>
            <ReviewDailyWorkloadChart rows={personChart} metric={dailyMetric} />
            <div
              className={
                styles.container +
                " mt-4 overflow-x-auto rounded-lg border border-white/5"
              }
            >
              <table
                className={
                  DETAIL_TABLE + " " + styles.table + " " + styles.dense
                }
                data-review-table="daily"
                role="table"
                aria-labelledby={tableId + "-daily"}
              >
                <ReviewDetailColumns />
                <thead className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] text-[11px] text-slate-300 [&_th]:py-3 [&_th]:pr-3">
                  <tr role="row">
                    <th
                      scope="col"
                      className="sticky left-0 z-20 whitespace-nowrap bg-[var(--surface-1)] @max-[480px]:static"
                    >
                      {t("review.statisticsDay")}
                    </th>
                    <th scope="col">{t("review.reviewer")}</th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsTouchedDatasets")}
                    >
                      <span className="block">
                        {t("review.statisticsTouchedShort")}
                      </span>
                      <span className="block text-[10px] font-normal text-slate-400">
                        {t("workbench.datasets")}
                      </span>
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsInitialMarks")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsCrossMarks")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsRecords")}
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsDwell")}
                    >
                      <ReviewMetricHeading metric="dwell" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsFrames")}
                    >
                      <ReviewMetricHeading metric="frames" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsDuration")}
                    >
                      <ReviewMetricHeading metric="durationSeconds" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsSize")}
                    >
                      <ReviewMetricHeading metric="sizeBytes" />
                    </th>
                    <th
                      scope="col"
                      className="text-left"
                      title={t("review.statisticsPersonalCoverageHint")}
                    >
                      {t("review.statisticsCoveredDatasetDuration")}
                    </th>
                  </tr>
                </thead>
                {personDays.map(([day, rows]) => (
                  <tbody key={day} data-detail-day={day}>
                    <tr
                      data-review-row="day"
                      role="row"
                      className="border-y border-white/10 bg-cyan-500/[0.06]"
                    >
                      <th
                        scope="rowgroup"
                        colSpan={11}
                        className="px-3 py-2 text-left font-medium text-cyan-100"
                      >
                        <div className="sticky left-0 flex w-fit max-w-[100cqw] flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="whitespace-nowrap">
                            <time dateTime={day}>{day}</time> · UTC+8
                          </span>
                          <span className="font-normal text-slate-400">
                            {t("review.statisticsDailySummary", {
                              people: rows.length,
                              records: count(
                                rows.reduce((sum, row) => sum + row.records, 0),
                              ),
                            })}
                          </span>
                        </div>
                      </th>
                    </tr>
                    {rows.map((row) => (
                      <ReviewCoverageTableRow
                        key={JSON.stringify([row.day, row.reviewer])}
                        coverage={row.datasetCoverage}
                        cumulative={row.cumulativeDatasetCoverage}
                        label={row.reviewer + " · " + row.day + " · UTC+8"}
                      >
                        <th
                          scope="row"
                          className="sticky left-0 whitespace-nowrap bg-[var(--surface-1)] py-3 pr-3 font-medium text-slate-100 @max-[480px]:static"
                          data-label={t("review.statisticsDay")}
                        >
                          {row.day}
                        </th>
                        <td
                          className="truncate pr-3"
                          title={row.reviewer}
                          data-label={t("review.reviewer")}
                        >
                          {row.reviewer}
                        </td>
                        <td
                          className="text-right"
                          data-label={t("review.statisticsTouchedDatasets")}
                        >
                          {" "}
                          {count(row.datasets)}
                        </td>
                        <td
                          className="text-right"
                          data-label={t("review.statisticsInitialMarks")}
                        >
                          {count(row.initialInspections)}
                        </td>
                        <td
                          className="text-right"
                          data-label={t("review.statisticsCrossMarks")}
                        >
                          {count(row.crossReviews)}
                        </td>
                        <td
                          className="text-right font-medium text-cyan-200"
                          data-label={t("review.statisticsRecords")}
                        >
                          {count(row.records)}
                        </td>
                        <td
                          className="text-right text-violet-200"
                          data-label={t("review.statisticsDwell")}
                        >
                          <ReviewDwellTimeValue dwell={row.dwellTime} compact />
                        </td>
                        <WorkloadCells workload={row.workload} />
                      </ReviewCoverageTableRow>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </section>

          <section className={PANEL} aria-label={t("review.statisticsTrend")}>
            <h4 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200">
              <FiCalendar aria-hidden="true" className="text-cyan-300" />
              {t("review.statisticsTrend")}
            </h4>
            <ReviewMarkTrendChart statistics={statistics} />
            <div className="sr-only">
              <table>
                <caption>{t("review.statisticsTrend")}</caption>
                <thead>
                  <tr role="row">
                    <th>{t("review.statisticsDay")}</th>
                    <th>{t("review.statisticsInitialMarks")}</th>
                    <th>{t("review.statisticsCrossMarks")}</th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.daily.map((day) => (
                    <tr role="row" key={day.day}>
                      <th>{day.day}</th>
                      <td>{day.initialInspections}</td>
                      <td>{day.crossReviews}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className={PANEL}
            aria-label={t("review.statisticsPeopleTitle")}
          >
            <h4
              className="mb-3 text-sm font-semibold text-slate-200"
              id={tableId + "-people"}
            >
              {t("review.statisticsPeopleTitle")}
            </h4>
            <p className="mb-3 text-xs leading-5 text-slate-400">
              {t("review.statisticsPersonalCoverageHint")}
            </p>
            <div
              className={
                styles.container +
                " overflow-x-auto rounded-lg border border-white/5"
              }
            >
              <table
                className={
                  DETAIL_TABLE + " " + styles.table + " " + styles.dense
                }
                data-review-table="people"
                role="table"
                aria-labelledby={tableId + "-people"}
              >
                <ReviewDetailColumns people />
                <thead className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] text-[11px] text-slate-300 [&_th]:py-3 [&_th]:pr-3">
                  <tr role="row">
                    <th
                      scope="col"
                      className="sticky left-0 z-20 whitespace-nowrap bg-[var(--surface-1)] @max-[480px]:static"
                    >
                      {t("review.reviewer")}
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsTouchedDatasets")}
                    >
                      <span className="block">
                        {t("review.statisticsTouchedShort")}
                      </span>
                      <span className="block text-[10px] font-normal text-slate-400">
                        {t("workbench.datasets")}
                      </span>
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsInitialMarks")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsCrossMarks")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsRecords")}
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsDwell")}
                    >
                      <ReviewMetricHeading metric="dwell" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsFrames")}
                    >
                      <ReviewMetricHeading metric="frames" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsDuration")}
                    >
                      <ReviewMetricHeading metric="durationSeconds" />
                    </th>
                    <th
                      scope="col"
                      className="text-right"
                      title={t("review.statisticsSize")}
                    >
                      <ReviewMetricHeading metric="sizeBytes" />
                    </th>
                    <th scope="col">{t("review.statisticsLastReview")}</th>
                    <th scope="col" className="text-left">
                      {t("review.statisticsCoveredDatasetDuration")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.people.map((person) => (
                    <ReviewCoverageTableRow
                      key={person.reviewer}
                      coverage={person.datasetCoverage}
                      cumulative={person.cumulativeDatasetCoverage}
                      label={person.reviewer}
                    >
                      <th
                        scope="row"
                        className="sticky left-0 truncate bg-[var(--surface-1)] py-3 pr-3 font-medium text-slate-100 @max-[480px]:static"
                        title={person.reviewer}
                        data-label={t("review.reviewer")}
                      >
                        {person.reviewer}
                      </th>
                      <td
                        className="text-right"
                        data-label={t("review.statisticsTouchedDatasets")}
                      >
                        {" "}
                        {count(person.datasets)}
                      </td>
                      <td
                        className="text-right"
                        data-label={t("review.statisticsInitialMarks")}
                      >
                        {count(person.initialInspections)}
                      </td>
                      <td
                        className="text-right text-emerald-300"
                        data-label={t("review.statisticsCrossMarks")}
                      >
                        {count(person.crossReviews)}
                      </td>
                      <td
                        className="text-right font-medium text-cyan-200"
                        data-label={t("review.statisticsRecords")}
                      >
                        {count(person.records)}
                      </td>
                      <td
                        className="text-right text-violet-200"
                        data-label={t("review.statisticsDwell")}
                      >
                        <ReviewDwellTimeValue
                          dwell={person.dwellTime}
                          compact
                        />
                      </td>
                      <WorkloadCells workload={person.workload} />
                      <td
                        className="text-slate-500"
                        data-label={t("review.statisticsLastReview")}
                      >
                        {timestamp(person.lastReviewedAt)}
                      </td>
                    </ReviewCoverageTableRow>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section
            className={PANEL}
            aria-label={t("review.statisticsDatasetsTitle")}
          >
            <h4
              className="mb-3 text-sm font-semibold text-slate-200"
              id={tableId + "-datasets"}
            >
              {t("review.statisticsDatasetsTitle")}
            </h4>
            <p className="mb-3 text-xs leading-5 text-slate-400">
              {t("review.statisticsCheckedOnlyHint")}
            </p>
            <div
              className={
                styles.container +
                " max-h-[560px] overflow-auto rounded-lg border border-white/5"
              }
            >
              <table
                className={
                  DETAIL_TABLE + " " + styles.table + " " + styles.dense
                }
                data-review-table="datasets"
                role="table"
                aria-labelledby={tableId + "-datasets"}
              >
                <ReviewDetailColumns datasets />
                <thead className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] text-[11px] text-slate-300 [&_th]:py-3 [&_th]:pr-3">
                  <tr role="row">
                    <th
                      scope="col"
                      className="sticky left-0 z-20 bg-[var(--surface-1)]"
                    >
                      {t("workbench.dataset")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsEpisodes")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsPending")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsCrossReviewed")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsRecords")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsPeople")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsDwell")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsFrames")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsDuration")}
                    </th>
                    <th scope="col" className="text-right">
                      {t("review.statisticsSize")}
                    </th>
                    <th scope="col" className="px-3">
                      {t("review.statisticsDatasetCoverageColumn")}
                    </th>
                    <th scope="col">{t("review.statisticsLastReview")}</th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.datasets.map((dataset) => (
                    <tr
                      role="row"
                      key={dataset.dataset}
                      className="border-b border-white/5 align-middle text-slate-300 even:bg-white/[0.015] hover:bg-white/[0.035]"
                    >
                      <th
                        scope="row"
                        className="sticky left-0 min-w-[200px] max-w-[22rem] bg-[var(--surface-1)] py-3 pr-4 font-medium text-slate-100"
                        data-label={t("workbench.dataset")}
                      >
                        <DatasetName name={dataset.dataset} />
                        {!!dataset.sources?.length && (
                          <div className="mt-1 break-all text-[10px] font-normal text-slate-500">
                            {dataset.sources.join(" · ")}
                          </div>
                        )}
                      </th>
                      <td
                        className="text-right"
                        data-label={t("review.statisticsEpisodes")}
                      >
                        {" "}
                        {count(dataset.inspected)}
                      </td>
                      <td
                        className="text-right text-amber-300"
                        data-label={t("review.statisticsPending")}
                      >
                        {count(dataset.pending)}
                      </td>
                      <td
                        className="text-right text-emerald-300"
                        data-label={t("review.statisticsCrossReviewed")}
                      >
                        {count(dataset.crossReviewed)}
                      </td>
                      <td
                        className="text-right"
                        data-label={t("review.statisticsRecords")}
                      >
                        {" "}
                        {count(dataset.records)}
                      </td>
                      <td
                        className="text-right"
                        data-label={t("review.statisticsPeople")}
                      >
                        {" "}
                        {count(dataset.reviewers)}
                      </td>
                      <td
                        data-label={t("review.statisticsDwell")}
                        className="text-right text-violet-200"
                      >
                        <ReviewDwellTimeValue
                          dwell={dataset.dwellTime}
                          compact
                        />
                      </td>
                      <WorkloadCells workload={dataset.uniqueWorkload} />
                      <td
                        data-label={t("review.statisticsDatasetCoverageColumn")}
                        className={styles.coverageCell + " px-3"}
                      >
                        {datasetProgress.get(dataset.dataset) && (
                          <CoverageMeasureCard
                            metric="durationSeconds"
                            measure={
                              datasetProgress.get(dataset.dataset)!.measures
                                .durationSeconds
                            }
                            compact
                          />
                        )}
                      </td>
                      <td
                        className="whitespace-nowrap text-slate-500"
                        data-label={t("review.statisticsLastReview")}
                      >
                        {timestamp(dataset.lastReviewedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr
                    role="row"
                    className="border-t border-white/15 font-semibold text-slate-200"
                  >
                    <th scope="row" className="py-3">
                      {t("review.statisticsTotal")}
                    </th>
                    <td
                      className="text-right"
                      data-label={t("review.statisticsEpisodes")}
                    >
                      {count(statistics.summary.inspected)}
                    </td>
                    <td
                      className="text-right"
                      data-label={t("review.statisticsPending")}
                    >
                      {count(statistics.summary.pending)}
                    </td>
                    <td
                      className="text-right"
                      data-label={t("review.statisticsCrossReviewed")}
                    >
                      {count(statistics.summary.crossReviewed)}
                    </td>
                    <td
                      className="text-right"
                      data-label={t("review.statisticsRecords")}
                    >
                      {count(statistics.summary.records)}
                    </td>
                    <td
                      className="text-right"
                      data-label={t("review.statisticsPeople")}
                    >
                      {count(statistics.summary.reviewers)}
                    </td>
                    <td
                      data-label={t("review.statisticsDwell")}
                      className="text-right text-violet-200"
                    >
                      <ReviewDwellTimeValue
                        dwell={statistics.dwellTime}
                        compact
                      />
                    </td>
                    <WorkloadCells workload={statistics.uniqueWorkload} />
                    <td
                      data-label={t("review.statisticsDatasetCoverageColumn")}
                      className={styles.coverageCell + " px-3"}
                    >
                      <CoverageMeasureCard
                        metric="durationSeconds"
                        measure={
                          statistics.datasetCoverage.measures.durationSeconds
                        }
                        compact
                      />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
          <section
            className={PANEL}
            aria-label={t("review.statisticsDatasetScale")}
          >
            <h4
              className="mb-2 text-sm font-semibold text-slate-200"
              id={tableId + "-scale"}
            >
              {t("review.statisticsDatasetScale")}
            </h4>
            <p className="mb-4 text-xs leading-5 text-slate-400">
              {t("review.statisticsDatasetScaleHint")}
            </p>
            <div
              className={
                styles.container +
                " max-h-[560px] overflow-auto rounded-lg border border-white/5"
              }
            >
              <table
                className={
                  "w-full text-left text-xs tabular-nums " +
                  styles.table +
                  " " +
                  styles.scale
                }
                data-review-table="scale"
                role="table"
                aria-labelledby={tableId + "-scale"}
              >
                <thead className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] text-[11px] text-slate-300 [&_th]:py-3 [&_th]:pr-3">
                  <tr role="row">
                    <th scope="col" className="py-2 pr-3">
                      {t("workbench.dataset")}
                    </th>
                    <th scope="col">{t("review.statisticsEpisodeCoverage")}</th>
                    <th scope="col">
                      {t("review.statisticsDatasetTotalEpisodes")}
                    </th>
                    <th scope="col">{t("common.frames")}</th>
                    <th scope="col">
                      {t("review.statisticsDatasetTotalDuration")}
                    </th>
                    <th scope="col">
                      {t("review.statisticsDatasetTotalSize")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {statistics.datasets.map((row) => (
                    <tr
                      role="row"
                      key={row.dataset}
                      className="border-b border-white/5 align-top text-slate-400 even:bg-white/[0.015] hover:bg-white/[0.035]"
                    >
                      <th
                        scope="row"
                        className="sticky left-0 min-w-[200px] max-w-[24rem] bg-[var(--surface-1)] py-3 pr-4 font-medium"
                        data-label={t("workbench.dataset")}
                      >
                        <DatasetName name={row.dataset} />
                      </th>
                      <td
                        className={styles.coverageCell}
                        data-label={t("review.statisticsEpisodeCoverage")}
                      >
                        <DatasetCoverageProgress
                          progress={datasetProgress.get(row.dataset)}
                        />
                      </td>
                      <td
                        data-label={t("review.statisticsDatasetTotalEpisodes")}
                      >
                        {row.metadata?.totalEpisodes == null
                          ? t("review.statisticsUnknown")
                          : count(row.metadata.totalEpisodes)}
                      </td>
                      <td data-label={t("common.frames")}>
                        {row.metadata?.totalFrames == null
                          ? t("review.statisticsUnknown")
                          : (row.metadata.estimates?.totalFrames ? "≈ " : "") +
                            count(row.metadata.totalFrames)}
                      </td>
                      <td
                        data-label={t("review.statisticsDatasetTotalDuration")}
                      >
                        {row.metadata?.totalDurationSeconds == null
                          ? t("review.statisticsUnknown")
                          : (row.metadata.estimates?.totalDurationSeconds
                              ? "≈ "
                              : "") +
                            (
                              row.metadata.totalDurationSeconds / 3600
                            ).toLocaleString(locale, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }) +
                            " " +
                            t("review.statisticsHours")}
                        {row.metadata?.estimates?.totalDurationSeconds && (
                          <div className="mt-1 text-[10px] text-amber-300">
                            {t("review.statisticsEstimateSample", {
                              sample:
                                row.metadata.estimates.totalDurationSeconds
                                  .sampleEpisodes,
                              total:
                                row.metadata.estimates.totalDurationSeconds
                                  .totalEpisodes,
                            })}
                          </div>
                        )}
                      </td>
                      <td data-label={t("review.statisticsDatasetTotalSize")}>
                        {row.metadata?.totalSizeBytes == null
                          ? t("review.statisticsUnknown")
                          : (row.metadata.estimates?.totalSizeBytes
                              ? "≈ "
                              : "") +
                            payloadSize(row.metadata.totalSizeBytes, locale)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr
                    role="row"
                    className="border-t border-white/15 font-semibold text-slate-300"
                  >
                    <th scope="row" className="py-3">
                      {t("review.statisticsTotal")} (
                      {count(statistics.datasetCoverage.datasets)})
                    </th>
                    <td data-label={t("review.statisticsEpisodes")}>
                      {" "}
                      {count(statistics.summary.inspected)}
                    </td>
                    {(
                      [
                        ["totalEpisodes", "episodesKnownDatasets"],
                        ["totalFrames", "framesKnownDatasets"],
                        ["totalDurationSeconds", "durationKnownDatasets"],
                        ["totalSizeBytes", "sizeKnownDatasets"],
                      ] as const
                    ).map(([field, known]) => {
                      const value = statistics.datasetCoverage[field];
                      return (
                        <td
                          key={field}
                          data-label={t(
                            field === "totalEpisodes"
                              ? "review.statisticsDatasetTotalEpisodes"
                              : field === "totalFrames"
                                ? "common.frames"
                                : field === "totalDurationSeconds"
                                  ? "review.statisticsDatasetTotalDuration"
                                  : "review.statisticsDatasetTotalSize",
                          )}
                        >
                          {value !== null &&
                            ((field === "totalFrames" &&
                              statistics.datasetCoverage
                                .estimatedFramesDatasets > 0) ||
                              (field === "totalDurationSeconds" &&
                                statistics.datasetCoverage
                                  .estimatedDurationDatasets > 0) ||
                              (field === "totalSizeBytes" &&
                                statistics.datasetCoverage
                                  .estimatedSizeDatasets > 0)) &&
                            "≈ "}
                          {value === null
                            ? t("review.statisticsUnknown")
                            : field === "totalDurationSeconds"
                              ? (value / 3600).toLocaleString(locale, {
                                  maximumFractionDigits: 2,
                                }) +
                                " " +
                                t("review.statisticsHours")
                              : field === "totalSizeBytes"
                                ? payloadSize(value, locale)
                                : count(value)}
                          {statistics.datasetCoverage[known] <
                            statistics.datasetCoverage.datasets && (
                            <div className="mt-1 text-[10px] font-normal text-amber-300">
                              {t("review.statisticsKnownDatasets", {
                                known: statistics.datasetCoverage[known],
                                total: statistics.datasetCoverage.datasets,
                              })}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function WorkbenchReviewSources({
  scan,
}: {
  scan: ReviewStatisticsScan;
}) {
  const { t } = useLocale();
  return (
    <section className={PANEL} aria-label={t("review.statisticsSources")}>
      <details
        open={
          scan.truncated ||
          scan.warnings.length > 0 ||
          scan.conflictingMarks > 0
        }
      >
        <summary className="cursor-pointer text-xs font-medium text-slate-300">
          {t("review.statisticsSourceSummary", {
            files: scan.sources.length,
            directories: scan.directoriesScanned,
            duplicates: scan.duplicateMarks,
          })}
        </summary>
        <p className="mt-3 break-all text-[11px] leading-5 text-slate-400">
          {scan.roots.join(" · ")}
        </p>
        <p className="mt-2 text-[11px] leading-5 text-slate-500">
          {t("review.statisticsSourceHint")}
        </p>
        {scan.truncated && (
          <p role="alert" className="mt-2 text-xs text-amber-300">
            {t("review.statisticsScanTruncated")}
          </p>
        )}
        {scan.conflictingMarks > 0 && (
          <p role="alert" className="mt-2 text-xs text-amber-300">
            {t("review.statisticsScanConflicts", {
              count: scan.conflictingMarks,
            })}
          </p>
        )}
        {scan.warnings.map((warning, index) => (
          <p
            key={index}
            role="alert"
            className="mt-2 break-all text-xs text-amber-300"
          >
            {warning.path}: {warning.message}
          </p>
        ))}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[650px] text-left text-xs tabular-nums">
            <thead className="sticky top-0 z-10 border-b border-white/10 bg-[var(--surface-1)] text-[11px] text-slate-300 [&_th]:py-3 [&_th]:pr-3">
              <tr role="row">
                <th scope="col" className="py-2">
                  {t("review.statisticsSourcePath")}
                </th>
                <th scope="col">{t("review.statisticsSourceDatasets")}</th>
                <th scope="col">{t("review.statisticsSourceRecords")}</th>
              </tr>
            </thead>
            <tbody>
              {scan.sources.map((source) => (
                <tr
                  role="row"
                  key={source.path}
                  className="border-b border-white/5 align-top text-slate-400 even:bg-white/[0.015] hover:bg-white/[0.035]"
                >
                  <th scope="row" className="break-all py-3 pr-4 font-normal">
                    {source.path}
                  </th>
                  <td>{source.datasets}</td>
                  <td>{source.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

export function WorkbenchReviewDateWindow({
  startDate,
  endDate,
}: {
  startDate: string;
  endDate: string;
}) {
  const { t } = useLocale();
  return (
    <p
      className="mt-2 rounded-md border border-cyan-400/15 bg-cyan-500/5 px-3 py-2 text-[11px] leading-5 text-cyan-100"
      data-date-boundary="utc8-midnight"
    >
      {startDate && endDate
        ? t("review.statisticsDateWindow", { start: startDate, end: endDate })
        : startDate
          ? t("review.statisticsDateWindowFrom", { start: startDate })
          : endDate
            ? t("review.statisticsDateWindowUntil", { end: endDate })
            : t("review.statisticsDateWindowOpen")}
    </p>
  );
}

export default function WorkbenchReviewStatistics({
  refreshToken = 0,
}: {
  refreshToken?: number;
}) {
  const { t } = useLocale();
  const { browsePath, file } = useEpisodeReviewData();
  const [directory, setDirectory] = useState(browsePath);
  const [directories, setDirectories] = useState([browsePath]);
  const [recursive, setRecursive] = useState(true);
  const [dateRange, setDateRange] = useState(() => reviewDateRange());
  const { startDate, endDate } = dateRange;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState<{
    endpoint: string;
    overview: Overview;
  } | null>(null);
  const invalidRange = !!startDate && !!endDate && startDate > endDate;
  const endpoint = useMemo(() => {
    const params = new URLSearchParams({
      view: "statistics",
      recursive: String(recursive),
    });
    if (directory === ALL_DIRECTORIES) params.set("scope", "all");
    else params.set("browsePath", directory);
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    return "/api/local-datasets/reviews?" + params;
  }, [directory, recursive, startDate, endDate, debouncedQuery]);
  const overview =
    !invalidRange && payload?.endpoint === endpoint ? payload.overview : null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/local-datasets/locations", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result = (await response.json()) as {
          root: string;
          locations: { path: string }[];
        };
        if (!controller.signal.aborted)
          setDirectories([
            ...new Set([
              browsePath,
              result.root,
              ...result.locations.map((location) => location.path),
            ]),
          ]);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [browsePath]);

  useEffect(() => {
    if (invalidRange) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json()) as Overview & { error?: string };
        if (!response.ok)
          throw new Error(result.error ?? String(response.status));
        if (!result.statistics || !Array.isArray(result.statistics.datasets))
          throw new Error(t("review.statisticsLoadFailed"));
        if (!controller.signal.aborted)
          setPayload({ endpoint, overview: result });
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint, invalidRange, retry, refreshToken, file.updated_at, t]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) setRetry((value) => value + 1);
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return (
    <section
      className="space-y-4"
      aria-label={t("workbench.reviewStatistics")}
      aria-busy={loading}
    >
      <header className={PANEL}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">
              {t("workbench.reviewStatistics")}
            </h3>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-400">
              {t("review.statisticsHint")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              disabled={loading || invalidRange}
              className={CONTROL + " disabled:opacity-40"}
            >
              <FiRefreshCw
                aria-hidden="true"
                className={loading ? "motion-safe:animate-spin" : ""}
              />
              {t(loading ? "review.loading" : "review.refresh")}
            </button>
            {overview && !loading && (
              <>
                <a className={CONTROL} href={endpoint + "&format=csv"}>
                  <FiDownload aria-hidden="true" />
                  {t("review.statisticsExportCsv")}
                </a>
                <a className={CONTROL} href={endpoint + "&format=json"}>
                  <FiDownload aria-hidden="true" />
                  {t("review.statisticsExportJson")}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-[11px] text-slate-400 sm:col-span-2">
            <span className="block">{t("review.statisticsDirectory")}</span>
            <select
              value={directory}
              onChange={(event) => setDirectory(event.target.value)}
              className={CONTROL + " w-full"}
            >
              <option value={ALL_DIRECTORIES}>
                {t("review.statisticsAllDirectories")}
              </option>
              {directories.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-[11px] text-slate-400">
            <span className="block">{t("workbench.startDate")}</span>
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(event) =>
                setDateRange({ ...dateRange, startDate: event.target.value })
              }
              className={CONTROL + " w-full"}
            />
          </label>
          <label className="space-y-1 text-[11px] text-slate-400">
            <span className="block">{t("workbench.endDate")}</span>
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) =>
                setDateRange({ ...dateRange, endDate: event.target.value })
              }
              className={CONTROL + " w-full"}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <label className="flex items-center gap-2 px-1 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(event) => setRecursive(event.target.checked)}
            />
            {t("review.statisticsRecursive")}
          </label>
          <input
            type="search"
            aria-label={t("review.statisticsSearch")}
            placeholder={t("review.statisticsSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className={CONTROL + " min-w-0 flex-1 sm:min-w-[18rem]"}
          />
          {(["today", "last7days", "all"] as const).map((preset) => {
            const range = reviewDateRange(preset);
            const active =
              startDate === range.startDate && endDate === range.endDate;
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                onClick={() => setDateRange(reviewDateRange(preset))}
                className={
                  CONTROL +
                  (active
                    ? " border-cyan-400/50 bg-cyan-500/10 text-cyan-200"
                    : "")
                }
              >
                {t(
                  preset === "today"
                    ? "review.statisticsToday"
                    : preset === "last7days"
                      ? "review.statisticsLast7Days"
                      : "review.statisticsAllDates",
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[10px] leading-5 text-slate-500">
          {t("review.statisticsDateHint")}
        </p>
        {!invalidRange && (
          <WorkbenchReviewDateWindow startDate={startDate} endDate={endDate} />
        )}
        {startDate && startDate === endDate && (
          <p role="status" className="mt-2 text-xs text-amber-300">
            {t("workbench.emptyDateRangeHint")}
          </p>
        )}
      </header>
      {invalidRange && (
        <p role="alert" className="text-xs text-amber-300">
          {t("review.statisticsInvalidRange")}
        </p>
      )}
      {error && !invalidRange && (
        <p
          role="alert"
          className="rounded-md border border-red-400/25 bg-red-400/5 p-3 text-xs text-red-200"
        >
          {t("review.statisticsLoadFailed")} {error}
        </p>
      )}
      {loading && !overview && (
        <p role="status" className="text-xs text-slate-400">
          {t("review.loading")}
        </p>
      )}
      {overview && (
        <>
          {overview.source_scan && (
            <WorkbenchReviewSources scan={overview.source_scan} />
          )}
          <WorkbenchReviewStatisticsOverview statistics={overview.statistics} />
          {overview.storage_path && (
            <p className="break-all text-[10px] text-slate-500">
              {t("review.storage", { path: overview.storage_path })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
