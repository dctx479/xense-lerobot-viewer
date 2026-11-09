import type { ReviewDatasetMetrics } from "@/utils/workbenchReviewStatistics";

export type CoverageMetric = "frames" | "durationSeconds" | "sizeBytes";
export type CoverageIssue =
  | "metadata-unavailable"
  | "manifest-unverified"
  | "manifest-count-mismatch"
  | "manifest-invalid-ids"
  | "manifest-duplicate-ids"
  | "metadata-read-failure"
  | "unmatched-records"
  | "invalid-record-ids"
  | "frames-total-mismatch"
  | "durationSeconds-total-mismatch"
  | "sizeBytes-total-mismatch";
export type CoverageMeasure = {
  knownChecked: number | null;
  total: number | null;
  knownCheckedEpisodes: number;
  checkedEpisodes: number;
  ratio: number | null;
  lowerBound: number | null;
  upperBound: number | null;
  estimated: boolean;
  source: "manifest" | "declared" | "estimated" | "none";
  status:
    | "exact"
    | "bounded"
    | "estimated"
    | "unknown"
    | "inconsistent"
    | "not-applicable";
};
export type DatasetInspectionCoverage = {
  dataset: string;
  checkedEpisodes: number;
  matchedEpisodes: number;
  unmatchedEpisodes: number;
  invalidEpisodes: number;
  totalEpisodes: number | null;
  episodeRatio: number | null;
  episodeLowerBound: number | null;
  episodeUpperBound: number | null;
  status: "complete" | "partial" | "unknown" | "uninspected" | "empty";
  manifestState: "verified" | "partial" | "unknown" | "inconsistent";
  issues: CoverageIssue[];
  measures: Record<CoverageMetric, CoverageMeasure>;
  crossReviewedEpisodes: number;
  crossReviewRatio: number | null;
  crossReviewComplete: boolean;
  evidence: "saved-episode-marks";
  acceptance: "not-assessed";
};

export const coverageMetrics = [
  "frames",
  "durationSeconds",
  "sizeBytes",
] as const;
const totals = {
  frames: "totalFrames",
  durationSeconds: "totalDurationSeconds",
  sizeBytes: "totalSizeBytes",
} as const;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const indexKey = (id: string) =>
  /^(0|[1-9]\d*)$/.test(id) && Number.isSafeInteger(Number(id));
const same = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-9;

export function prepareCoverageMetadata(
  metadata: ReviewDatasetMetrics | undefined,
) {
  const allIds = Object.keys(metadata?.episodes ?? {});
  const ids = allIds.filter(indexKey);
  const known = Object.fromEntries(
    coverageMetrics.map((metric) => {
      const keys = ids.filter((id) => finite(metadata!.episodes[id][metric]));
      return [
        metric,
        {
          ids: new Set(keys),
          total: keys.reduce(
            (sum, id) => sum + metadata!.episodes[id][metric]!,
            0,
          ),
          estimated:
            metric === "sizeBytes" &&
            keys.some((id) => metadata!.episodes[id].sizeEstimated),
        },
      ];
    }),
  ) as Record<
    CoverageMetric,
    { ids: Set<string>; total: number; estimated: boolean }
  >;
  return { ids, allIds, universe: new Set(ids), known };
}
export type PreparedCoverageMetadata = ReturnType<
  typeof prepareCoverageMetadata
>;

export function assessDatasetCoverage(
  dataset: string,
  metadata: ReviewDatasetMetrics | undefined,
  checked: ReadonlySet<string>,
  crossReviewed: ReadonlySet<string> = new Set(),
  prepared = prepareCoverageMetadata(metadata),
): DatasetInspectionCoverage {
  const issues = new Set<CoverageIssue>();
  const { ids, universe } = prepared;
  const canonical = [...checked].filter(indexKey);
  const matched = new Set(canonical.filter((id) => universe.has(id)));
  const unmatched = canonical.length - matched.size;
  const invalid = checked.size - canonical.length;
  const total = metadata?.totalEpisodes;
  const declared = finite(total) && Number.isSafeInteger(total) ? total : null;
  const audit = metadata?.manifestAudit;
  if (!metadata) issues.add("metadata-unavailable");
  if (ids.length !== prepared.allIds.length) issues.add("manifest-invalid-ids");
  if (audit?.duplicateEpisodes) issues.add("manifest-duplicate-ids");
  if (audit?.invalidRows || audit?.readFailures)
    issues.add("metadata-read-failure");
  const countConflict =
    declared !== null &&
    (ids.length > declared ||
      (metadata?.episodeManifestComplete === true && ids.length !== declared) ||
      (!!audit &&
        (audit.discoveredEpisodes !== ids.length ||
          (audit.declaredEpisodes !== null &&
            audit.declaredEpisodes !== declared))));
  if (countConflict) issues.add("manifest-count-mismatch");
  if (unmatched) issues.add("unmatched-records");
  if (invalid) issues.add("invalid-record-ids");
  const inconsistent =
    countConflict ||
    issues.has("manifest-invalid-ids") ||
    issues.has("manifest-duplicate-ids");
  const verified =
    !!metadata?.episodeManifestComplete &&
    declared !== null &&
    (!audit || audit.declaredEpisodes === declared) &&
    ids.length === declared &&
    !inconsistent &&
    !issues.has("metadata-read-failure");
  if (!verified) issues.add("manifest-unverified");
  const usableTotal = !inconsistent && declared !== null ? declared : null;
  const full = verified && declared! > 0 && matched.size === declared;
  const status =
    verified && declared === 0 && checked.size === 0
      ? "empty"
      : full
        ? "complete"
        : checked.size === 0 && usableTotal !== null && usableTotal > 0
          ? "uninspected"
          : matched.size > 0 &&
              usableTotal !== null &&
              matched.size < usableTotal &&
              !inconsistent
            ? "partial"
            : "unknown";
  const unresolved = verified ? 0 : unmatched;
  const episodeLower =
    usableTotal !== null && usableTotal > 0 ? matched.size / usableTotal : null;
  const episodeUpper =
    episodeLower === null
      ? null
      : Math.min(matched.size + unresolved, usableTotal!) / usableTotal!;
  const measures = {} as Record<CoverageMetric, CoverageMeasure>;
  for (const metric of coverageMetrics) {
    const known = prepared.known[metric];
    const checkedKnown = [...matched].filter((id) => known.ids.has(id));
    const sum = (keys: string[]) =>
      keys.reduce((value, id) => value + metadata!.episodes[id][metric]!, 0);
    // The same set must produce the same sum regardless of mark insertion order.
    const numerator =
      checkedKnown.length === known.ids.size ? known.total : sum(checkedKnown);
    const knownTotal = known.total;
    const fromManifest = verified && known.ids.size === ids.length;
    const sampleTotal = !!metadata?.estimates?.[totals[metric]];
    const sharedEstimate =
      metric === "sizeBytes" &&
      checkedKnown.some((id) => metadata!.episodes[id].sizeEstimated);
    const manifestEstimated = known.estimated;
    const reported = metadata?.[totals[metric]];
    const rawTotal =
      fromManifest && !manifestEstimated
        ? knownTotal
        : finite(reported)
          ? reported
          : fromManifest
            ? knownTotal
            : null;
    const totalWeight = finite(rawTotal) ? rawTotal : null;
    // Unmarked estimated weights also affect bounds; they cannot establish
    // deterministic limits for the checked content.
    const estimated =
      sharedEstimate ||
      (fromManifest && !manifestEstimated
        ? false
        : sampleTotal || manifestEstimated);
    if (
      fromManifest &&
      finite(reported) &&
      !sampleTotal &&
      !same(knownTotal, reported)
    )
      issues.add((metric + "-total-mismatch") as CoverageIssue);
    if (!estimated && totalWeight !== null && knownTotal > totalWeight)
      issues.add((metric + "-total-mismatch") as CoverageIssue);
    const result: CoverageMeasure = {
      knownChecked: finite(numerator) ? numerator : null,
      total: totalWeight,
      knownCheckedEpisodes: checkedKnown.length,
      checkedEpisodes: matched.size + unresolved,
      ratio: null,
      lowerBound: null,
      upperBound: null,
      estimated,
      source:
        totalWeight === null
          ? "none"
          : fromManifest && !manifestEstimated
            ? "manifest"
            : sampleTotal
              ? "estimated"
              : fromManifest && manifestEstimated && !finite(reported)
                ? "estimated"
                : "declared",
      status: "unknown",
    };
    const numeratorComplete =
      checkedKnown.length === matched.size && unresolved === 0;
    if (
      inconsistent ||
      !Number.isFinite(numerator) ||
      !Number.isFinite(knownTotal)
    )
      result.status = "inconsistent";
    else if (totalWeight !== null && totalWeight === 0)
      result.status =
        knownTotal > 0 || numerator > 0
          ? "inconsistent"
          : numeratorComplete
            ? "not-applicable"
            : "unknown";
    else if (totalWeight !== null && totalWeight > 0) {
      if (!estimated && knownTotal > totalWeight)
        result.status = "inconsistent";
      else if (estimated) {
        result.status = "estimated";
        if (numeratorComplete && numerator <= totalWeight)
          result.ratio = numerator / totalWeight;
        else if (
          full &&
          numeratorComplete &&
          fromManifest &&
          same(numerator, totalWeight)
        )
          result.ratio = 1;
      } else {
        // With a verified universe, missing checked weights can be recovered
        // from an exact total when every unmarked weight is known.
        const unmarkedWeightsComplete =
          verified &&
          ids.length - matched.size === known.ids.size - checkedKnown.length;
        const unmarkedWeight = !numeratorComplete
          ? sum([...known.ids].filter((id) => !matched.has(id)))
          : 0;
        const recoveredRatio =
          !numeratorComplete && unmarkedWeightsComplete
            ? (totalWeight - unmarkedWeight) / totalWeight
            : null;
        result.lowerBound = recoveredRatio ?? numerator / totalWeight;
        result.upperBound =
          numeratorComplete || recoveredRatio !== null
            ? result.lowerBound
            : Math.min(
                1,
                Math.max(
                  result.lowerBound,
                  (totalWeight - unmarkedWeight) / totalWeight,
                ),
              );
        result.ratio =
          numeratorComplete || recoveredRatio !== null
            ? result.lowerBound
            : null;
        result.status = result.ratio !== null ? "exact" : "bounded";
      }
    }
    measures[metric] = result;
  }
  const cross = [...matched].filter((id) => crossReviewed.has(id)).length;
  return {
    dataset,
    checkedEpisodes: checked.size,
    matchedEpisodes: matched.size,
    unmatchedEpisodes: unmatched,
    invalidEpisodes: invalid,
    totalEpisodes: usableTotal,
    episodeRatio:
      status === "unknown" || episodeLower !== episodeUpper
        ? null
        : episodeLower,
    episodeLowerBound: episodeLower,
    episodeUpperBound: episodeUpper,
    status,
    manifestState: inconsistent
      ? "inconsistent"
      : verified
        ? "verified"
        : declared === null
          ? "unknown"
          : "partial",
    issues: [...issues],
    measures,
    crossReviewedEpisodes: cross,
    crossReviewRatio: verified && declared! > 0 ? cross / declared! : null,
    crossReviewComplete: full && cross === declared,
    evidence: "saved-episode-marks",
    acceptance: "not-assessed",
  };
}

/** Sum weights, never average dataset percentages or drop unknown denominators. */
export function aggregateCoverageMeasure(
  progress: DatasetInspectionCoverage[],
  metric: CoverageMetric,
): CoverageMeasure {
  const children = progress.map((row) => row.measures[metric]);
  const checkedSum = children.reduce(
    (sum, row) => sum + (row.knownChecked ?? 0),
    0,
  );
  const knownChecked =
    children.every((row) => row.knownChecked !== null) && finite(checkedSum)
      ? checkedSum
      : null;
  const totalsKnown = children.every((row) => row.total !== null);
  const totalSum = totalsKnown
    ? children.reduce((sum, row) => sum + row.total!, 0)
    : null;
  const total = finite(totalSum) ? totalSum : null;
  const estimated = children.some((row) => row.estimated);
  const result: CoverageMeasure = {
    knownChecked,
    total,
    knownCheckedEpisodes: children.reduce(
      (sum, row) => sum + row.knownCheckedEpisodes,
      0,
    ),
    checkedEpisodes: children.reduce(
      (sum, row) => sum + row.checkedEpisodes,
      0,
    ),
    ratio: null,
    lowerBound: null,
    upperBound: null,
    estimated,
    source:
      total === null
        ? "none"
        : children.some((row) => row.source === "estimated")
          ? "estimated"
          : children.every((row) => row.source === "manifest")
            ? "manifest"
            : "declared",
    status: "unknown",
  };
  if (
    knownChecked === null ||
    (totalSum !== null && !finite(totalSum)) ||
    children.some((row) => row.status === "inconsistent")
  )
    result.status = "inconsistent";
  else if (total === 0)
    result.status = children.every((row) => row.status === "not-applicable")
      ? "not-applicable"
      : "unknown";
  else if (total !== null && total > 0) {
    const active = children.filter((row) => row.total! > 0);
    if (
      active.every((row) => row.ratio !== null) &&
      children.every((row) => row.status !== "unknown")
    ) {
      result.ratio =
        active.reduce((sum, row) => sum + row.ratio! * row.total!, 0) / total;
      result.status = estimated ? "estimated" : "exact";
    } else if (estimated) result.status = "estimated";
    else if (
      active.every(
        (row) => row.lowerBound !== null && row.upperBound !== null,
      ) &&
      children.every((row) => row.status !== "unknown")
    ) {
      result.lowerBound =
        active.reduce((sum, row) => sum + row.lowerBound! * row.total!, 0) /
        total;
      result.upperBound =
        active.reduce((sum, row) => sum + row.upperBound! * row.total!, 0) /
        total;
      result.status = "bounded";
    }
    if (result.status === "exact")
      result.lowerBound = result.upperBound = result.ratio;
  }
  return result;
}

/** Do not round a partial ratio up to 100%, or a positive tiny ratio down to zero. */
export function coveragePercent(
  ratio: number,
  locale: string,
  rounding: "down" | "up" = "down",
): string {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return "—";
  if (rounding === "down" && ratio > 0 && ratio < 0.0001)
    return "<" + (0.01).toLocaleString(locale) + "%";
  const rounded =
    (rounding === "up" ? Math.ceil(ratio * 10000) : Math.floor(ratio * 10000)) /
    100;
  if (ratio < 1 && rounded === 100) return "<100%";
  return rounded.toLocaleString(locale, { maximumFractionDigits: 2 }) + "%";
}
