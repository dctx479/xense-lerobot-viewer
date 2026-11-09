import { describe, expect, test } from "bun:test";
import { formatBytes, trashEntryName, trashStamp } from "@/utils/datasetTrash";

const WHEN = new Date(Date.UTC(2026, 7, 15, 11, 2, 3));

describe("trashStamp", () => {
  test("is zero-padded UTC+8 and sorts lexically", () => {
    expect(trashStamp(WHEN)).toBe("20260815-190203");
    expect(trashStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      "20260102-110405",
    );
    expect(
      trashStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))) < trashStamp(WHEN),
    ).toBe(true);
  });
});

describe("trashEntryName", () => {
  test("flattens the dataset path under a timestamp", () => {
    expect(trashEntryName("Xense/pack_bottles", WHEN)).toBe(
      "20260815-190203__Xense__pack_bottles",
    );
  });

  test("cannot produce a separator, a leading dot, or a traversal", () => {
    const name = trashEntryName("../../etc/passwd", WHEN);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.startsWith("20260815-190203__")).toBe(true);

    const dotted = trashEntryName(".hidden/thing", WHEN);
    expect(dotted).toBe("20260815-190203__hidden__thing");
  });

  test("folds exotic characters and caps the length", () => {
    expect(trashEntryName("A b/c:d*e", WHEN)).toBe(
      "20260815-190203__A-b__c-d-e",
    );
    const long = trashEntryName("x".repeat(200), WHEN);
    expect(long.length).toBe("20260815-190203__".length + 80);
  });

  test("never yields an empty slug", () => {
    expect(trashEntryName("///", WHEN)).toBe("20260815-190203__dataset");
  });
});

describe("formatBytes", () => {
  test("scales to the magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2 kB");
    expect(formatBytes(2_046_000_000)).toBe("2.0 GB");
  });
});
