import { expect, test } from "bun:test";
import {
  addReviewDwellTime,
  emptyReviewDwellTime,
  hasReviewDwellTime,
  reviewCollectionDwellTime,
} from "@/utils/reviewDwellTime";

test("legacy dwell snapshots stay unknown while recorded zero remains known", () => {
  const total = emptyReviewDwellTime();
  addReviewDwellTime(total, {});
  expect(total).toEqual({
    records: 1,
    knownRecords: 0,
    milliseconds: null,
    episodeDurationMilliseconds: null,
  });
  addReviewDwellTime(total, { stay_ms: 0, episode_duration_ms: 0 });
  expect(total).toEqual({
    records: 2,
    knownRecords: 1,
    milliseconds: 0,
    episodeDurationMilliseconds: 0,
  });
  addReviewDwellTime(total, { stay_ms: 1000, episode_duration_ms: 500 });
  expect(total).toEqual({
    records: 3,
    knownRecords: 2,
    milliseconds: 1000,
    episodeDurationMilliseconds: 500,
  });
});

test("dwell validation matches paired safe nonnegative snapshot and twice-duration boundaries", () => {
  const invalid = [
    {},
    { stay_ms: 0 },
    { episode_duration_ms: 0 },
    { stay_ms: -1, episode_duration_ms: 100 },
    { stay_ms: 1, episode_duration_ms: -1 },
    { stay_ms: 201, episode_duration_ms: 100 },
    { stay_ms: 1, episode_duration_ms: 0 },
    { stay_ms: 0.1, episode_duration_ms: 100 },
    { stay_ms: 0, episode_duration_ms: 0.1 },
    { stay_ms: NaN, episode_duration_ms: 100 },
    { stay_ms: 0, episode_duration_ms: Infinity },
    { stay_ms: "0", episode_duration_ms: 100 },
    { stay_ms: 0, episode_duration_ms: null },
    { stay_ms: 0, episode_duration_ms: Number.MAX_SAFE_INTEGER },
  ];
  const total = emptyReviewDwellTime();
  for (const record of invalid) {
    expect(hasReviewDwellTime(record)).toBe(false);
    addReviewDwellTime(total, record);
  }
  expect(total.records).toBe(invalid.length);
  expect(total.knownRecords).toBe(0);
  expect(total.milliseconds).toBeNull();
  expect(hasReviewDwellTime({ stay_ms: 200, episode_duration_ms: 100 })).toBe(
    true,
  );
});

test("overflow never resets an unknown dwell sum to a later partial value", () => {
  const total = emptyReviewDwellTime();
  const duration = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  for (let index = 0; index < 2; index++)
    addReviewDwellTime(total, {
      stay_ms: duration * 2,
      episode_duration_ms: duration,
    });
  expect(total.milliseconds).toBeNull();
  expect(total.episodeDurationMilliseconds).toBe(duration * 2);
  addReviewDwellTime(total, { stay_ms: 1, episode_duration_ms: 2 });
  addReviewDwellTime(total, { stay_ms: 1, episode_duration_ms: 1 });
  expect(total).toEqual({
    records: 4,
    knownRecords: 4,
    milliseconds: null,
    episodeDurationMilliseconds: null,
  });
});

test("collection snapshots aggregate per person and safely support prototype-like names", () => {
  const result = reviewCollectionDwellTime({
    version: 1,
    datasets: {
      dataset: {
        version: 1,
        episodes: {
          "0": [
            {
              reviewer: "__proto__",
              source: "episodes",
              reviewed_at: "2026-11-01T00:00:00+08:00",
              stay_ms: 2000,
              episode_duration_ms: 1000,
            },
            {
              reviewer: "Bob",
              source: "urdf",
              reviewed_at: "2026-11-01T00:00:00+08:00",
            },
          ],
        },
      },
    },
  });
  expect(result.total).toEqual({
    records: 2,
    knownRecords: 1,
    milliseconds: 2000,
    episodeDurationMilliseconds: 1000,
  });
  expect(result.people["__proto__"].milliseconds).toBe(2000);
  expect(result.people.Bob.milliseconds).toBeNull();
});
