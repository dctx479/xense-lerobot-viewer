import { describe, expect, test } from "bun:test";
import { GET } from "./route";

describe("workbench scenario defaults route", () => {
  test("returns the latest on-disk defaults without caching", async () => {
    const response = await GET();
    const defaults = (await response.json()) as Record<
      string,
      { level1: string; level2: string; taskName: string }
    >;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(defaults["xtac-umi-g1::clean-test-tube-turn-upside-down"]).toEqual({
      level1: "工作台场景",
      level2: "实验操作",
      taskName: "清理试管",
    });
  });
});
