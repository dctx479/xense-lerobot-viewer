"use client";

import { useLocale } from "@/context/locale-context";
import type { ReviewDwellTime } from "@/utils/reviewDwellTime";

/** Saved foreground snapshots; content workload and coverage stay independent. */
export function ReviewDwellTimeValue({
  dwell,
  details = false,
  compact = false,
}: {
  dwell: ReviewDwellTime;
  details?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useLocale();
  const duration = (milliseconds: number | null) => {
    if (milliseconds === null) return t("review.statisticsUnknown");
    const seconds = milliseconds / 1000;
    const divisor = seconds < 60 ? 1 : seconds < 3600 ? 60 : 3600;
    const unit =
      divisor === 1
        ? "review.statisticsSeconds"
        : divisor === 60
          ? "review.statisticsMinutes"
          : "review.statisticsHours";
    return (
      (seconds / divisor).toLocaleString(locale, {
        maximumFractionDigits: divisor === 1 ? 3 : 2,
      }) +
      " " +
      t(unit)
    );
  };
  return (
    <div
      data-review-dwell="true"
      className={
        compact ? "min-w-0 tabular-nums" : "min-w-[120px] tabular-nums"
      }
      data-dwell-layout={compact ? "compact" : "full"}
      title={t("review.statisticsDwellHint")}
    >
      <div className="whitespace-nowrap">{duration(dwell.milliseconds)}</div>
      <div
        className={
          "mt-1 text-[10px] font-normal " +
          (compact ? "whitespace-nowrap " : "") +
          (dwell.knownRecords < dwell.records
            ? "text-amber-300"
            : "text-slate-400")
        }
      >
        <span
          title={t("review.statisticsDwellKnown", {
            known: dwell.knownRecords,
            total: dwell.records,
          })}
        >
          {t(
            compact
              ? "review.statisticsDwellKnownCompact"
              : "review.statisticsDwellKnown",
            {
              known: dwell.knownRecords,
              total: dwell.records,
            },
          )}
        </span>
      </div>
      {details && (
        <div className="mt-1 text-[11px] font-normal leading-5 text-slate-400">
          {t("review.statisticsDwellSnapshot")}:{" "}
          {duration(dwell.episodeDurationMilliseconds)}
        </div>
      )}
    </div>
  );
}
