"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { FiAlertCircle } from "react-icons/fi";
import { useLocale } from "@/context/locale-context";
import styles from "@/components/workbench-review-statistics.module.css";
import {
  buildWorkbenchReviewDailyChart,
  type ReviewDailyChartMetric,
  type WorkbenchReviewStatistics,
} from "@/utils/workbenchReviewStatistics";

type DailyPoint = ReturnType<typeof buildWorkbenchReviewDailyChart>[number];
const TOOLTIP_STYLE = {
  background: "var(--surface-1, #11172a)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 8,
  color: "#e2e8f0",
  fontSize: 12,
};

function DailyTooltip({
  active,
  payload,
  metric,
}: TooltipProps<number, string> & { metric: ReviewDailyChartMetric }) {
  const { t, locale } = useLocale();
  const row = payload?.[0]?.payload as DailyPoint | undefined;
  if (!active || !row) return null;
  return (
    <div className="space-y-2 rounded-lg border border-white/15 bg-[var(--surface-1)] p-3 text-xs shadow-xl">
      <div className="font-medium text-slate-100">
        {row.day} · {row.reviewer}
      </div>
      <div className="text-cyan-200">
        {row.estimated ? "≈ " : ""}
        {row.value === null
          ? t("review.statisticsUnknown")
          : row.value.toLocaleString(locale, {
              ...(metric === "records"
                ? { maximumFractionDigits: 0 }
                : { maximumSignificantDigits: 4 }),
            })}{" "}
        {metric === "durationSeconds" || metric === "dwellSeconds"
          ? t("review.statisticsHours")
          : metric === "sizeBytes"
            ? "GiB"
            : t("review.statisticsMarksUnit")}
      </div>
      {metric === "records" ? (
        <div className="text-slate-300">
          {t("review.statisticsInitialMarks")}: {row.initialInspections} ·{" "}
          {t("review.statisticsCrossMarks")}: {row.crossReviews}
        </div>
      ) : (
        <div className="text-slate-400">
          {t("review.statisticsKnown", {
            known: row.knownEpisodes,
            total: row.records,
          })}
        </div>
      )}
      {row.estimated && (
        <div className="text-amber-300">
          {t("review.statisticsEstimatedPayload")}
        </div>
      )}
    </div>
  );
}

export function ReviewDailyWorkloadChart({
  rows,
  metric,
}: {
  rows: DailyPoint[];
  metric: ReviewDailyChartMetric;
}) {
  const { t, locale } = useLocale();
  const unknown = rows.filter((row) => row.value === null).length;
  const unknownLabel =
    metric === "dwellSeconds"
      ? "review.statisticsDwellChartUnknown"
      : "review.statisticsChartUnknown";
  const estimated = rows.some((row) => row.estimated);
  const days = new Map<string, DailyPoint[]>();
  for (const row of rows) {
    const group = days.get(row.day) ?? [];
    group.push(row);
    days.set(row.day, group);
  }
  // Every date uses the same scale so bar lengths remain comparable.
  const maximum =
    rows.reduce((max, row) => Math.max(max, row.value ?? 0), 0) || 1;
  const metricLabel = t(
    metric === "records"
      ? "review.statisticsRecords"
      : metric === "durationSeconds"
        ? "review.statisticsDuration"
        : metric === "dwellSeconds"
          ? "review.statisticsDwell"
          : "review.statisticsSize",
  );
  return (
    <figure
      aria-label={t("review.statisticsPersonDaily")}
      className={styles.chart + " min-w-0"}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>
          {metricLabel} ·{" "}
          {metric === "records"
            ? t("review.statisticsMarksUnit")
            : metric === "durationSeconds" || metric === "dwellSeconds"
              ? t("review.statisticsHours")
              : "GiB"}
        </span>
        {metric !== "records" && estimated && (
          <span className="flex items-center gap-1.5 text-amber-300">
            <span
              className="h-2 w-2 rounded-sm bg-amber-400"
              aria-hidden="true"
            />
            {t("review.statisticsEstimatedPayload")}
          </span>
        )}
      </div>
      {metric === "records" && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-sm bg-cyan-400"
            />
            {t("review.statisticsInitialMarks")}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-sm bg-emerald-400"
            />
            {t("review.statisticsCrossMarks")}
          </span>
        </div>
      )}
      {unknown === rows.length && rows.length > 0 ? (
        <div className="flex min-h-40 items-center justify-center gap-2 rounded-lg border border-dashed border-amber-400/20 bg-amber-400/5 p-4 text-xs text-amber-200">
          <FiAlertCircle aria-hidden="true" />
          {t(unknownLabel, { count: unknown })}
        </div>
      ) : (
        <div className="max-h-[520px] overflow-auto rounded-lg border border-white/5 bg-black/10">
          {[...days].map(([day, dailyRows]) => {
            const height = Math.max(100, dailyRows.length * 44 + 42);
            return (
              <div
                key={day}
                data-chart-day={day}
                className="border-b border-white/10 last:border-b-0"
              >
                <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-white/5 bg-[var(--surface-1)] px-3 py-2 text-xs">
                  <time dateTime={day} className="font-semibold text-slate-100">
                    {day}{" "}
                    <span className="font-normal text-slate-500">UTC+8</span>
                  </time>
                  <span className="text-slate-400">
                    {t("review.statisticsDailySummary", {
                      people: dailyRows.length,
                      records: dailyRows
                        .reduce((sum, row) => sum + row.records, 0)
                        .toLocaleString(locale),
                    })}
                  </span>
                </div>
                {dailyRows.every((row) => row.value === null) ? (
                  <p className="px-3 py-5 text-xs text-amber-200">
                    {t(unknownLabel, {
                      count: dailyRows.length,
                    })}
                  </p>
                ) : (
                  <div className="w-full" style={{ height }}>
                    <ResponsiveContainer
                      width="100%"
                      height={height}
                      initialDimension={{ width: 720, height }}
                    >
                      <BarChart
                        accessibilityLayer
                        layout="vertical"
                        data={dailyRows}
                        margin={{ top: 12, right: 32, left: 0, bottom: 4 }}
                        barCategoryGap="28%"
                      >
                        <CartesianGrid
                          stroke="rgba(255,255,255,0.06)"
                          horizontal={false}
                        />
                        <XAxis
                          type="number"
                          domain={[0, maximum]}
                          allowDecimals={metric !== "records"}
                          tick={{ fill: "#94a3b8", fontSize: 10 }}
                          tickFormatter={(value: number) =>
                            value.toLocaleString(locale, {
                              notation: "compact",
                              maximumSignificantDigits: 3,
                            })
                          }
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="reviewer"
                          width={105}
                          interval={0}
                          tick={{ fill: "#cbd5e1", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          isAnimationActive={false}
                          cursor={{ fill: "rgba(255,255,255,0.03)" }}
                          content={<DailyTooltip metric={metric} />}
                        />
                        {/* Recharts 2.x cannot unwrap React 19 fragments when finding series. */}
                        <Bar
                          dataKey="initialInspections"
                          name={t("review.statisticsInitialMarks")}
                          stackId="marks"
                          fill="#22d3ee"
                          maxBarSize={24}
                          isAnimationActive={false}
                          hide={metric !== "records"}
                        />
                        <Bar
                          dataKey="crossReviews"
                          name={t("review.statisticsCrossMarks")}
                          stackId="marks"
                          fill="#34d399"
                          maxBarSize={24}
                          radius={[0, 3, 3, 0]}
                          isAnimationActive={false}
                          hide={metric !== "records"}
                        />
                        {metric !== "records" ? (
                          <Bar
                            dataKey="value"
                            name={metricLabel}
                            fill="#22d3ee"
                            maxBarSize={24}
                            radius={[0, 3, 3, 0]}
                            isAnimationActive={false}
                          >
                            {dailyRows.map((row) => (
                              <Cell
                                key={row.label}
                                fill={row.estimated ? "#fbbf24" : "#22d3ee"}
                              />
                            ))}
                          </Bar>
                        ) : null}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {unknown > 0 && unknown < rows.length && (
        <figcaption className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-300">
          <FiAlertCircle aria-hidden="true" />
          {t(unknownLabel, { count: unknown })}
        </figcaption>
      )}
    </figure>
  );
}

export function ReviewMarkTrendChart({
  statistics,
}: {
  statistics: WorkbenchReviewStatistics;
}) {
  const { t, locale } = useLocale();
  return (
    <div className={styles.chart + " min-w-0"}>
      <div className="h-[240px] min-w-0">
        <ResponsiveContainer
          width="100%"
          height={240}
          initialDimension={{ width: 720, height: 240 }}
        >
          <BarChart
            accessibilityLayer
            data={statistics.daily}
            margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fill: "#94a3b8", fontSize: 10 }}
              tickFormatter={(value: string) => value.slice(5)}
              minTickGap={24}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: "#94a3b8", fontSize: 10 }}
              width={50}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: "rgba(255,255,255,0.03)" }}
              labelFormatter={(label) => String(label)}
              formatter={(value: number) => value.toLocaleString(locale)}
              contentStyle={TOOLTIP_STYLE}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" />
            <Bar
              dataKey="initialInspections"
              name={t("review.statisticsInitialMarks")}
              stackId="marks"
              fill="#22d3ee"
              maxBarSize={48}
              isAnimationActive={false}
            />
            <Bar
              dataKey="crossReviews"
              name={t("review.statisticsCrossMarks")}
              stackId="marks"
              fill="#34d399"
              maxBarSize={48}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
