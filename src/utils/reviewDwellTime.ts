import type { ReviewCollectionFile } from "@/types/episode-review.types";

/** Foreground snapshots attached to saved marks, never inferred human work time. */
export type ReviewDwellTime = {
  records: number;
  knownRecords: number;
  milliseconds: number | null;
  episodeDurationMilliseconds: number | null;
};

export function emptyReviewDwellTime(): ReviewDwellTime {
  return {
    records: 0,
    knownRecords: 0,
    milliseconds: null,
    episodeDurationMilliseconds: null,
  };
}

export function hasReviewDwellTime(record: {
  stay_ms?: unknown;
  episode_duration_ms?: unknown;
}): record is { stay_ms: number; episode_duration_ms: number } {
  return (
    typeof record.stay_ms === "number" &&
    typeof record.episode_duration_ms === "number" &&
    Number.isSafeInteger(record.stay_ms) &&
    record.stay_ms >= 0 &&
    Number.isSafeInteger(record.episode_duration_ms) &&
    record.episode_duration_ms >= 0 &&
    Number.isSafeInteger(record.episode_duration_ms * 2) &&
    record.stay_ms <= record.episode_duration_ms * 2
  );
}

export function addReviewDwellTime(
  target: ReviewDwellTime,
  record: { stay_ms?: unknown; episode_duration_ms?: unknown },
) {
  target.records++;
  if (!hasReviewDwellTime(record)) return;
  for (const [field, value] of [
    ["milliseconds", record.stay_ms],
    ["episodeDurationMilliseconds", record.episode_duration_ms],
  ] as const) {
    const previous = target[field];
    const sum = (previous ?? 0) + value;
    target[field] =
      (previous === null && target.knownRecords > 0) ||
      !Number.isSafeInteger(sum)
        ? null
        : sum;
  }
  target.knownRecords++;
}

export function reviewCollectionDwellTime(collection: ReviewCollectionFile) {
  const total = emptyReviewDwellTime();
  const people: Record<string, ReviewDwellTime> = Object.create(null);
  for (const file of Object.values(collection.datasets)) {
    for (const records of Object.values(file.episodes)) {
      for (const record of records) {
        addReviewDwellTime(total, record);
        people[record.reviewer] ??= emptyReviewDwellTime();
        addReviewDwellTime(people[record.reviewer], record);
      }
    }
  }
  return { total, people };
}
