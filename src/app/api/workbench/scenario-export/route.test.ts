import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { POST } from "./route";

describe("workbench scenario export", () => {
  test("optionally exports source metadata and the actual dataset manifest", async () => {
    const response = await POST(
      new Request("http://localhost/api/workbench/scenario-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeMachineNumber: false,
          includeDatasetManifest: true,
          rows: [
            {
              captureType: "taccap-g1",
              taskName: "整理桌面小物件",
              datasetName: "arrange-desk-items",
              hours: 1.5,
              datasets: [
                {
                  relativePath: "TacVerse/taccap-g1-arrange-desk-items-0902",
                  source: "local",
                  sourceLabel: "本地数据",
                  hubSource: "huggingface",
                  hubRepoId: "TacVerse/taccap-g1-arrange-desk-items-0902",
                  hubPath: "data/chunk-000.parquet",
                  durationHours: 1.5,
                },
              ],
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const workbook = Buffer.from(await response.arrayBuffer());
    const parsed = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-c",
        [
          "import io,json,sys",
          "from openpyxl import load_workbook",
          "w=load_workbook(io.BytesIO(sys.stdin.buffer.read()),data_only=True)",
          "s=w['实际数据集清单']",
          "print(json.dumps({'sheets':w.sheetnames,'headers':[c.value for c in s[1]],'row':[c.value for c in s[2]]},ensure_ascii=False))",
        ].join("\n"),
      ],
      { input: workbook, encoding: "utf8" },
    );

    expect(parsed.status).toBe(0);
    const result = JSON.parse(parsed.stdout) as {
      sheets: string[];
      headers: string[];
      row: unknown[];
    };
    expect(result.sheets).toContain("实际数据集清单");
    expect(result.headers).toContain("实际数据集路径");
    expect(result.headers).toContain("数据来源");
    expect(result.row).toContain("TacVerse/taccap-g1-arrange-desk-items-0902");
    expect(result.row).toContain("huggingface");
    expect(result.row).not.toContain("机器编号");
  });

  test("omits the manifest sheet unless requested", async () => {
    const response = await POST(
      new Request("http://localhost/api/workbench/scenario-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{ datasetName: "arrange-desk-items", hours: 1 }],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const workbook = Buffer.from(await response.arrayBuffer());
    const parsed = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-c",
        "import io,sys; from openpyxl import load_workbook; print(','.join(load_workbook(io.BytesIO(sys.stdin.buffer.read())).sheetnames))",
      ],
      { input: workbook, encoding: "utf8" },
    );
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.trim()).toBe("场景分类");
  });

  test("merges same-level scenes and adds hierarchical subtotals and grand total", async () => {
    const response = await POST(
      new Request("http://localhost/api/workbench/scenario-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeMachineNumber: false,
          rows: [
            {
              captureType: "xtac-umi-g1",
              level1: "办公场景",
              level2: "桌面整理",
              taskName: "整理桌面小物件",
              datasetName: "arrange-desk-items",
              hours: 1,
            },
            {
              captureType: "xtac-umi-g1",
              level1: "办公场景",
              level2: "桌面整理",
              taskName: "整理签字笔套装",
              datasetName: "arrange-pen-set",
              hours: 2,
            },
            {
              captureType: "taccap-g1",
              level1: "工作台场景",
              level2: "实验操作",
              taskName: "清理试管",
              datasetName: "clean-test-tube",
              hours: 3,
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(200);
    const workbook = Buffer.from(await response.arrayBuffer());
    const parsed = spawnSync(
      process.env.PYTHON ?? "python3",
      [
        "-c",
        [
          "import io,json,sys",
          "from openpyxl import load_workbook",
          "w=load_workbook(io.BytesIO(sys.stdin.buffer.read()),data_only=True)",
          "s=w['场景分类']",
          "print(json.dumps({'merged':list(map(str,s.merged_cells.ranges)),'rows':[[c.value for c in row] for row in s.iter_rows(values_only=False)]},ensure_ascii=False))",
        ].join("\n"),
      ],
      { input: workbook, encoding: "utf8" },
    );
    expect(parsed.status).toBe(0);
    const result = JSON.parse(parsed.stdout) as {
      merged: string[];
      rows: unknown[][];
    };
    expect(result.merged).toContain("C2:C3");
    expect(result.merged).toContain("B2:B4");
    expect(result.merged).toContain("C4:E4");
    expect(result.merged).toContain("B5:E5");
    expect(result.merged).toContain("A6:E6");
    expect(result.merged).toContain("A10:E10");
    expect(result.merged).toContain("A11:E11");
    expect(result.rows[1][0]).toBe("带头显");
    expect(result.rows[6][0]).toBe("不带头显");
    expect(
      result.rows.map((row) =>
        row.filter((value) => typeof value === "string").join(" "),
      ),
    ).toContain("桌面整理小计");
    expect(result.rows.at(-1)).toContain("总计");
    expect(result.rows.at(-1)?.at(-1)).toBe(6);
  });

  test("rejects requests that exceed the request body limit", async () => {
    const response = await POST(
      new Request("http://localhost/api/workbench/scenario-export", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(32 * 1024 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("32 MB");
  });

  test("limits the optional actual dataset manifest size", async () => {
    const response = await POST(
      new Request("http://localhost/api/workbench/scenario-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeDatasetManifest: true,
          rows: [{ datasets: Array.from({ length: 100_001 }, () => ({})) }],
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("100000");
  });
});
