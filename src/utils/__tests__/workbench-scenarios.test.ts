import { describe, expect, it } from "bun:test";
import {
  canonicalWorkbenchTaskName,
  groupWorkbenchScenarioTasks,
  hasWorkbenchDateSuffix,
  resolveWorkbenchScenarioClassification,
} from "@/utils/workbench-scenarios";

describe("workbench scenario grouping", () => {
  it("removes common date suffixes and combines repeated task captures", () => {
    expect(canonicalWorkbenchTaskName("pack-box_20260902")).toBe("pack-box");
    expect(canonicalWorkbenchTaskName("pack-box-261020b")).toBe("pack-box");
    expect(canonicalWorkbenchTaskName("pack-box-2026-09-02")).toBe("pack-box");
    const rows = groupWorkbenchScenarioTasks(
      [
        {
          relativePath: "TacVerse/taccap-g1-pack-box-260902",
          source: "taccap-g1",
          robot_type: "G1",
          collectorSerialNumber: "COL-1",
          durationHours: 2,
        },
        {
          relativePath: "TacVerse/taccap-g1-pack-box-260903",
          source: "taccap-g1",
          robot_type: "G1",
          collectorSerialNumber: "COL-1",
          durationHours: 3,
        },
        {
          relativePath: "TacVerse/xtac-umi-g1-pack-box-260903",
          source: "xtac-umi-g1",
          robot_type: "G1",
          durationHours: 4,
        },
      ],
      { "taccap-g1::pack-box": { level1: "工业", level2: "装配" } },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      taskName: "",
      datasetName: "pack-box",
      datasetNames: ["pack-box"],
      machine: "COL-1",
      captureType: "taccap-g1",
      hours: 5,
      datasets: { length: 2 },
      classification: { level1: "工业", level2: "装配" },
    });
    expect(rows[1]).toMatchObject({
      taskName: "",
      captureType: "xtac-umi-g1",
      hours: 4,
      datasets: { length: 1 },
    });
  });

  it("excludes datasets without a valid trailing capture date", () => {
    expect(hasWorkbenchDateSuffix("TacVerse/taccap-g1-pack-box-260902")).toBe(
      true,
    );
    expect(
      hasWorkbenchDateSuffix("TacVerse/taccap-g1-pack-box-2026-09-02"),
    ).toBe(true);
    expect(hasWorkbenchDateSuffix("TacVerse/taccap-g1-pack-box")).toBe(false);
    expect(hasWorkbenchDateSuffix("TacVerse/taccap-g1-pack-box-260230b")).toBe(
      false,
    );

    const rows = groupWorkbenchScenarioTasks(
      [
        {
          relativePath: "TacVerse/taccap-g1-pack-box-260902",
          source: "taccap-g1",
          robot_type: "G1",
          durationHours: 2,
        },
        {
          relativePath: "TacVerse/taccap-g1-undated-task",
          source: "taccap-g1",
          robot_type: "G1",
          durationHours: 9,
        },
      ],
      {},
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].hours).toBe(2);
  });

  it("allows undated datasets and filters by Hugging Face or ModelScope", () => {
    const datasets = [
      {
        relativePath: "TacVerse/taccap-g1-task-260902",
        source: "taccap-g1",
        hubSource: "huggingface" as const,
        robot_type: "G1",
        durationHours: 2,
      },
      {
        relativePath: "TacVerse/taccap-g1-task",
        source: "taccap-g1",
        hubSource: "modelscope" as const,
        robot_type: "G1",
        durationHours: 3,
      },
    ];
    expect(
      groupWorkbenchScenarioTasks(datasets, {}, undefined, {
        requireDateSuffix: false,
        source: "all",
      }),
    ).toHaveLength(1);
    expect(
      groupWorkbenchScenarioTasks(datasets, {}, undefined, {
        requireDateSuffix: false,
        source: "modelscope",
      }),
    ).toHaveLength(1);
    expect(
      groupWorkbenchScenarioTasks(datasets, {}, undefined, {
        requireDateSuffix: false,
        source: "modelscope",
      })[0].hours,
    ).toBe(3);
  });

  it("uses workbook defaults by capture type and dataset name, while saved edits win", () => {
    const datasets = [
      {
        relativePath: "TacVerse/taccap-g1-arrange-desk-items-260902",
        source: "taccap-g1",
        robot_type: "G1",
      },
      {
        relativePath: "TacVerse/xtac-umi-g1-arrange-desk-items-260902",
        source: "xtac-umi-g1",
        robot_type: "G1",
      },
    ];
    const defaults = groupWorkbenchScenarioTasks(datasets, {});
    expect(defaults).toHaveLength(2);
    expect(
      defaults.find((row) => row.captureType === "taccap-g1")?.classification,
    ).toEqual({
      level1: "办公场景",
      level2: "桌面整理",
      taskName: "整理桌面小物件",
    });
    expect(
      defaults.find((row) => row.captureType === "xtac-umi-g1")?.classification,
    ).toEqual({
      level1: "办公场景",
      level2: "桌面整理",
      taskName: "整理桌面小物件",
    });

    const edited = groupWorkbenchScenarioTasks(datasets, {
      "taccap-g1::arrange-desk-items": {
        level1: "用户场景",
        level2: "用户子场景",
        taskName: "用户任务",
      },
    });
    expect(
      edited.find((row) => row.captureType === "taccap-g1")?.classification,
    ).toEqual({
      level1: "用户场景",
      level2: "用户子场景",
      taskName: "用户任务",
    });
    expect(
      edited.find((row) => row.captureType === "xtac-umi-g1")?.classification
        .level1,
    ).toBe("办公场景");
  });

  it("preclassifies missing inventory aliases when workbook task mappings identify them", () => {
    const rows = groupWorkbenchScenarioTasks(
      [
        {
          relativePath: "TacVerse/xtac-umi-g1-arrange-pen-set-261020",
          source: "xtac-umi-g1",
          robot_type: "G1",
        },
        {
          relativePath: "TacVerse/xtac-umi-g1-remove-oring-a-261020",
          source: "xtac-umi-g1",
          robot_type: "G1",
        },
        {
          relativePath:
            "TacVerse/taccap-g1-insert-usb-connector-into-port-1027",
          source: "taccap-g1",
          robot_type: "G1",
        },
        {
          relativePath: "TacVerse/taccap-g1-pick-up-qq-candy-b-1027",
          source: "taccap-g1",
          robot_type: "G1",
        },
      ],
      {},
    );

    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          row.classification.level1 &&
          row.classification.level2 &&
          row.classification.taskName,
      ),
    ).toBe(true);
    expect(
      rows.find((row) => row.datasetName === "arrange-pen-set")?.classification
        .level2,
    ).toBe("桌面整理");
    expect(
      rows.find((row) => row.datasetName === "remove-oring-a")?.classification
        .level2,
    ).toBe("拆卸维修");
    expect(
      rows.find((row) => row.datasetName === "insert-usb-connector-into-port")
        ?.classification.level2,
    ).toBe("电子设备");
  });

  it("uses the confirmed Workshop taxonomy for newly identified XTac tasks", () => {
    const names = [
      "clean-test-tube-turn-upside-down",
      "pick-up-test-tube-insert-into-test-tube-rack",
      "pick-up-screw-place-into-bin",
      "install-wire-harness",
      "remove-wire-harness",
    ];
    const rows = groupWorkbenchScenarioTasks(
      names.map((name) => ({
        relativePath: `TacVerse/xtac-umi-g1-${name}-261027`,
        source: "xtac-umi-g1",
        robot_type: "G1",
      })),
      {},
    );

    expect(rows).toHaveLength(5);
    expect(
      rows.every((row) => row.classification.level1 === "工作台场景"),
    ).toBe(true);
    expect(
      rows.find((row) => row.datasetName === "install-wire-harness")
        ?.classification.level2,
    ).toBe("精密装配");
    expect(
      rows.find((row) => row.datasetName === "remove-wire-harness")
        ?.classification.level2,
    ).toBe("拆卸维修");
    expect(
      rows.find((row) => row.datasetName === "clean-test-tube-turn-upside-down")
        ?.classification.level2,
    ).toBe("实验操作");
    expect(
      rows.find(
        (row) =>
          row.datasetName === "pick-up-test-tube-insert-into-test-tube-rack",
      )?.classification.level2,
    ).toBe("实验操作");
    expect(
      rows.find((row) => row.datasetName === "pick-up-screw-place-into-bin")
        ?.classification.level2,
    ).toBe("物料分拣");
  });

  it("allows freshly loaded defaults to take effect immediately", () => {
    const rows = groupWorkbenchScenarioTasks(
      [
        {
          relativePath: "TacVerse/xtac-umi-g1-new-task-261027",
          source: "xtac-umi-g1",
          robot_type: "G1",
        },
      ],
      {},
      {
        "xtac-umi-g1::new-task": {
          level1: "工作台场景",
          level2: "实验操作",
          taskName: "新任务",
        },
      },
    );
    expect(rows[0].classification).toEqual({
      level1: "工作台场景",
      level2: "实验操作",
      taskName: "新任务",
    });
  });

  it("merges manual fields over defaults and falls back for empty fields", () => {
    expect(
      resolveWorkbenchScenarioClassification(
        "task-key",
        {
          "task-key": { level1: "人工一级", level2: "", taskName: "人工任务" },
        },
        {
          "task-key": {
            level1: "默认一级",
            level2: "默认二级",
            taskName: "默认任务",
          },
        },
      ),
    ).toEqual({
      level1: "人工一级",
      level2: "默认二级",
      taskName: "人工任务",
    });
  });
});
