import { isCalendarDay } from "@/utils/calendarTime";
import initialScenarioDefaults from "@/utils/workbench-scenario-defaults.json";
import { dateFromName } from "@/lib/dataset-facets";

export type WorkbenchScenarioClassification = {
  level1: string;
  level2: string;
  taskName: string;
};

export type WorkbenchCaptureType = "taccap-g1" | "xtac-umi-g1" | "other";
export type WorkbenchScenarioSource = "all" | "huggingface" | "modelscope";

export type WorkbenchScenarioTask = {
  key: string;
  taskName: string;
  datasetName: string;
  datasetNames: string[];
  machine: string;
  captureType: WorkbenchCaptureType;
  hours: number;
  datasets: {
    relativePath: string;
    robot_type: string | null;
    durationHours?: number | null;
    source?: string | null;
    sourceLabel?: string | null;
    hubSource?: string | null;
    hubRepoId?: string | null;
    hubPath?: string | null;
  }[];
  classification: WorkbenchScenarioClassification;
};

export const WORKBENCH_SCENARIO_DEFAULTS = initialScenarioDefaults as Record<
  string,
  WorkbenchScenarioClassification
>;

export function resolveWorkbenchScenarioClassification(
  key: string,
  classifications: Record<string, WorkbenchScenarioClassification>,
  defaults: Record<
    string,
    WorkbenchScenarioClassification
  > = WORKBENCH_SCENARIO_DEFAULTS,
): WorkbenchScenarioClassification {
  const manual = classifications[key];
  const fallback = defaults[key];
  return {
    level1: manual?.level1?.trim() ? manual.level1 : (fallback?.level1 ?? ""),
    level2: manual?.level2?.trim() ? manual.level2 : (fallback?.level2 ?? ""),
    taskName: manual?.taskName?.trim()
      ? manual.taskName
      : (fallback?.taskName ?? ""),
  };
}

/** Remove a trailing date/build suffix so daily captures of one task merge. */
export function canonicalWorkbenchTaskName(value: string): string {
  return value
    .trim()
    .replace(
      /(?:[-_]20\d{2}[-_]\d{2}[-_]\d{2}|-\d{6}[A-Za-z]*|-\d{4}[A-Za-z]*|[-_]\d{8}[A-Za-z]*|[-_]\d{1,2}月\d{1,2}日|[-_]\d{1,2}[-_]\d{1,2})$/u,
      "",
    )
    .replace(/[-_]+$/u, "")
    .trim();
}

export function hasWorkbenchDateSuffix(value: string): boolean {
  const leaf = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? value;
  if (dateFromName(leaf)) return true;
  const compact = leaf.match(/[-_](20\d{6})[A-Za-z]*$/u)?.[1];
  if (compact)
    return isCalendarDay(
      [compact.slice(0, 4), compact.slice(4, 6), compact.slice(6, 8)].join("-"),
    );
  const isoDate = leaf.match(/-(\d{4}-\d{2}-\d{2})$/u)?.[1];
  return isCalendarDay(isoDate);
}

export function groupWorkbenchScenarioTasks<
  T extends {
    relativePath: string;
    robot_type: string | null;
    collectorSerialNumber?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    hubSource?: string | null;
    hubRepoId?: string | null;
    hubPath?: string | null;
    durationHours?: number | null;
  },
>(
  datasets: T[],
  classifications: Record<string, WorkbenchScenarioClassification>,
  defaults: Record<
    string,
    WorkbenchScenarioClassification
  > = WORKBENCH_SCENARIO_DEFAULTS,
  options: {
    requireDateSuffix?: boolean;
    source?: WorkbenchScenarioSource;
  } = {},
): WorkbenchScenarioTask[] {
  const groups = new Map<string, WorkbenchScenarioTask>();
  for (const dataset of datasets) {
    if (
      options.requireDateSuffix !== false &&
      !hasWorkbenchDateSuffix(dataset.relativePath)
    )
      continue;
    if (
      options.source &&
      options.source !== "all" &&
      dataset.hubSource !== options.source
    )
      continue;
    const leaf =
      dataset.relativePath.split(/[\\/]/u).filter(Boolean).at(-1) ??
      dataset.relativePath;
    const captureType =
      dataset.source === "taccap-g1" ||
      /(?:^|\/)taccap-g1-/u.test(dataset.relativePath)
        ? "taccap-g1"
        : dataset.source === "xtac-umi-g1" ||
            /(?:^|\/)xtac-umi-g1(?:-|$)/u.test(dataset.relativePath)
          ? "xtac-umi-g1"
          : "other";
    const normalizedLeaf = leaf.replace(/^(?:taccap-g1-|xtac-umi-g1-)/u, "");
    const datasetName =
      canonicalWorkbenchTaskName(normalizedLeaf) || normalizedLeaf;
    const taskName = "";
    const machine = dataset.collectorSerialNumber || "";
    const key = `${captureType}::${datasetName}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        taskName,
        datasetName,
        datasetNames: [],
        machine,
        captureType,
        hours: 0,
        datasets: [],
        classification: resolveWorkbenchScenarioClassification(
          key,
          classifications,
          defaults,
        ),
      };
      groups.set(key, group);
    }
    group.datasets.push(dataset);
    const exactDatasetName = datasetName;
    if (!group.datasetNames.includes(exactDatasetName))
      group.datasetNames.push(exactDatasetName);
    group.hours += Math.max(0, Number(dataset.durationHours) || 0);
  }
  return [...groups.values()].sort((a, b) =>
    a.datasetName.localeCompare(b.datasetName, "zh-CN"),
  );
}
