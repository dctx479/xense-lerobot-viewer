"use client";

import { calendarDayKey } from "@/utils/calendarTime";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  groupWorkbenchScenarioTasks,
  WORKBENCH_SCENARIO_DEFAULTS,
  type WorkbenchScenarioClassification,
  type WorkbenchScenarioSource,
} from "@/utils/workbench-scenarios";

export default function WorkbenchScenarioClassifier({
  organization,
  datasets,
  filenameFilter = "",
  filenameDate = "",
}: {
  organization: string;
  datasets: {
    relativePath: string;
    robot_type: string | null;
    collectorSerialNumber?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    hubSource?: "huggingface" | "modelscope" | null;
    hubRepoId?: string | null;
    hubPath?: string | null;
    durationHours?: number | null;
  }[];
  filenameFilter?: string;
  filenameDate?: string;
}) {
  const storageKey = `xense-workbench-scenes:${organization}`;
  const filenamePrefixStorageKey = `xense-workbench-scenes-filename-prefix:${organization}`;
  const [classifications, setClassifications] = useState<
    Record<string, WorkbenchScenarioClassification>
  >({});
  const [scenarioDefaults, setScenarioDefaults] = useState(
    WORKBENCH_SCENARIO_DEFAULTS,
  );
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [includeMachineNumber, setIncludeMachineNumber] = useState(true);
  const [includeDatasetManifest, setIncludeDatasetManifest] = useState(false);
  const [filenamePrefix, setFilenamePrefix] = useState("");
  const [requireDateSuffix, setRequireDateSuffix] = useState(true);
  const [sourceFilter, setSourceFilter] =
    useState<WorkbenchScenarioSource>("all");
  const [jsonMessage, setJsonMessage] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const refreshScenarioDefaults = useCallback(async () => {
    try {
      const response = await fetch("/api/workbench/scenario-defaults", {
        cache: "no-store",
      });
      if (!response.ok) return;
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        setScenarioDefaults(
          parsed as Record<string, WorkbenchScenarioClassification>,
        );
      }
    } catch {
      /* Keep the bundled defaults when runtime refresh is unavailable. */
    }
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setClassifications(JSON.parse(raw));
      setFilenamePrefix(localStorage.getItem(filenamePrefixStorageKey) ?? "");
    } catch {
      /* Ignore malformed old browser data. */
    }
    setLoaded(true);
  }, [filenamePrefixStorageKey, storageKey]);
  useEffect(() => {
    void refreshScenarioDefaults();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible")
        void refreshScenarioDefaults();
    };
    window.addEventListener("focus", refreshScenarioDefaults);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshScenarioDefaults);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshScenarioDefaults]);
  useEffect(() => {
    if (loaded)
      localStorage.setItem(storageKey, JSON.stringify(classifications));
  }, [classifications, loaded, storageKey]);
  useEffect(() => {
    if (loaded) localStorage.setItem(filenamePrefixStorageKey, filenamePrefix);
  }, [filenamePrefix, filenamePrefixStorageKey, loaded]);

  const rows = useMemo(
    () =>
      groupWorkbenchScenarioTasks(datasets, classifications, scenarioDefaults, {
        requireDateSuffix,
        source: sourceFilter,
      }),
    [
      datasets,
      classifications,
      requireDateSuffix,
      scenarioDefaults,
      sourceFilter,
    ],
  );
  const visible = rows.filter(
    (row) =>
      !query ||
      `${row.classification.taskName} ${row.datasetNames.join(" ")}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const update = (
    key: string,
    field: keyof WorkbenchScenarioClassification,
    value: string,
  ) => {
    setClassifications((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? { level1: "", level2: "", taskName: "" }),
        [field]: value,
      },
    }));
  };
  const exportExcel = async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportError("");
    try {
      const response = await fetch("/api/workbench/scenario-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeMachineNumber,
          includeDatasetManifest,
          rows: rows.map(
            ({
              datasetName,
              datasetNames,
              captureType,
              machine,
              hours,
              classification,
              datasets,
            }) => ({
              ...classification,
              datasetName,
              datasetNames,
              captureType,
              machine,
              hours,
              ...(includeDatasetManifest ? { datasets } : {}),
            }),
          ),
          filenameFilter,
          filenameDate,
        }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setExportError(result.error || `导出失败（HTTP ${response.status}）`);
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const filenameParts = [
        filenamePrefix.trim(),
        "TacVerse存量数据汇总表",
        filenameFilter,
        filenameDate || calendarDayKey().replaceAll("-", ""),
      ]
        .filter(Boolean)
        .map((part) => part.replace(/[\\/:*?"<>|]/gu, "_"));
      anchor.download = `${filenameParts.join("-")}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("导出请求失败，请检查连接后重试");
    } finally {
      setExportBusy(false);
    }
  };

  const exportJson = () => {
    const payload: Record<string, unknown> = {
      version: 1,
      organization,
      exportedAt: new Date().toISOString(),
      classifications: Object.fromEntries(
        rows.map((row) => [
          row.key,
          {
            captureType: row.captureType,
            datasetName: row.datasetName,
            taskName: row.classification.taskName,
            level1: row.classification.level1,
            level2: row.classification.level2,
          },
        ]),
      ),
    };
    if (includeDatasetManifest) {
      payload.datasetManifest = rows.flatMap((row) =>
        row.datasets.map((dataset) => ({
          captureType: row.captureType,
          datasetName: row.datasetName,
          relativePath: dataset.relativePath,
          source: dataset.source ?? "",
          sourceLabel: dataset.sourceLabel ?? "",
          hubSource: dataset.hubSource ?? "",
          hubRepoId: dataset.hubRepoId ?? "",
          hubPath: dataset.hubPath ?? "",
        })),
      );
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const jsonFilename = [filenamePrefix.trim(), "Workbench场景分类"]
      .filter(Boolean)
      .join("-");
    anchor.download = `${jsonFilename}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importJson = async (file?: File) => {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("classifications" in parsed)
      ) {
        throw new Error("JSON 文件缺少 classifications 字段");
      }
      const imported = (parsed as { classifications?: unknown })
        .classifications;
      if (
        !imported ||
        typeof imported !== "object" ||
        Array.isArray(imported)
      ) {
        throw new Error("classifications 必须是对象");
      }
      const valid: Record<string, WorkbenchScenarioClassification> = {};
      for (const [key, value] of Object.entries(imported)) {
        if (!value || typeof value !== "object") continue;
        const row = value as Partial<WorkbenchScenarioClassification>;
        if (typeof row.level1 !== "string" || typeof row.level2 !== "string")
          continue;
        valid[key] = {
          level1: row.level1,
          level2: row.level2,
          taskName: typeof row.taskName === "string" ? row.taskName : "",
        };
      }
      if (!Object.keys(valid).length)
        throw new Error("JSON 中没有可导入的场景分类记录");
      setClassifications((current) => ({ ...current, ...valid }));
      setJsonMessage(
        `已导入 ${Object.keys(valid).length} 条分类；匹配当前数据集后生效。`,
      );
    } catch (error) {
      setJsonMessage(error instanceof Error ? error.message : "JSON 导入失败");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  return (
    <section
      className="rounded-xl border border-white/10 bg-[var(--surface-1)]/45 p-4 sm:p-5"
      aria-label="场景分类"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">场景分类</h4>
          <p className="mt-1 text-[11px] text-slate-400">
            按数据来源、采集类型与数据集名称聚合；日期后缀过滤可选，任务名称由人工定义。taccap-g1：不带头显，6
            路视频 + 20 维数据；xtac-umi-g1：带头显，8 路视频 + 29
            维数据。分类保存在当前浏览器。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 hover:bg-white/[0.08]"
          >
            导入 JSON
          </button>
          <button
            type="button"
            onClick={exportJson}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 hover:bg-white/[0.08]"
          >
            导出 JSON
          </button>
          <button
            type="button"
            onClick={() => void refreshScenarioDefaults()}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 hover:bg-white/[0.08]"
          >
            刷新默认分类
          </button>
          <button
            type="button"
            disabled={exportBusy}
            onClick={() => void exportExcel()}
            className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-300/20 disabled:cursor-wait disabled:opacity-60"
          >
            {exportBusy ? "正在生成…" : "导出 Excel"}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void importJson(event.target.files?.[0])}
          />
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          文件名前缀
          <input
            value={filenamePrefix}
            onChange={(event) => setFilenamePrefix(event.target.value)}
            placeholder="可选"
            aria-label="导出文件名前缀"
            className="h-9 w-36 rounded-lg border border-white/10 bg-[var(--surface-0)] px-2 text-xs text-slate-200"
          />
        </label>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选任务或数据集"
          className="h-9 min-w-48 rounded-lg border border-white/10 bg-[var(--surface-0)] px-3 text-xs text-slate-200"
        />
        <label className="flex items-center gap-2 text-xs text-slate-300">
          数据来源
          <select
            value={sourceFilter}
            onChange={(event) =>
              setSourceFilter(event.target.value as WorkbenchScenarioSource)
            }
            className="h-9 rounded-lg border border-white/10 bg-[var(--surface-0)] px-2 text-xs text-slate-200"
          >
            <option value="all">全部</option>
            <option value="huggingface">Hugging Face</option>
            <option value="modelscope">ModelScope</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={requireDateSuffix}
            onChange={(event) => setRequireDateSuffix(event.target.checked)}
            className="accent-cyan-400"
          />
          仅统计名称带日期后缀的数据集
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={includeMachineNumber}
            onChange={(event) => setIncludeMachineNumber(event.target.checked)}
            className="accent-cyan-400"
          />
          导出机器编号（默认采集设备编号）
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={includeDatasetManifest}
            onChange={(event) =>
              setIncludeDatasetManifest(event.target.checked)
            }
            className="accent-cyan-400"
          />
          附带数据集来源与实际清单
        </label>
        <span className="self-center text-xs text-slate-500">
          {visible.length} 个任务 ·{" "}
          {rows.reduce((sum, row) => sum + row.datasets.length, 0)} 个数据集
        </span>
        {exportError && (
          <span role="alert" className="w-full text-xs text-rose-300">
            {exportError}
          </span>
        )}
      </div>
      {jsonMessage && (
        <p role="status" className="mb-3 text-xs text-cyan-200">
          {jsonMessage}
        </p>
      )}
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        {(["taccap-g1", "xtac-umi-g1", "other"] as const).map((type) => {
          const group = rows.filter((row) => row.captureType === type);
          return (
            <div
              key={type}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs"
            >
              <span className="font-medium text-slate-200">
                {type === "taccap-g1"
                  ? "taccap-g1 · 不带头显 · 6 路 / 20 维"
                  : type === "xtac-umi-g1"
                    ? "xtac-umi-g1 · 带头显 · 8 路 / 29 维"
                    : "其他类型"}
              </span>
              <div className="mt-1 text-slate-400">
                {group.length} 个任务 ·{" "}
                {group.reduce((n, row) => n + row.datasets.length, 0)} 个数据集
                · {group.reduce((n, row) => n + row.hours, 0).toFixed(2)} 小时
              </div>
            </div>
          );
        })}
      </div>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="bg-white/[0.04] text-slate-400">
            <tr>
              {[
                "采集类型",
                "机器编号",
                "一级场景",
                "二级场景",
                "任务名称",
                "数据集名称",
                "时长(小时)",
                "数据集数",
              ].map((heading) => (
                <th key={heading} className="px-3 py-2 font-medium">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.key} className="border-t border-white/[0.06]">
                <td className="px-3 py-2 text-slate-300">
                  {row.captureType === "taccap-g1"
                    ? "taccap-g1"
                    : row.captureType === "xtac-umi-g1"
                      ? "xtac-umi-g1"
                      : "其他"}
                </td>
                <td className="px-3 py-2 text-slate-300">
                  {row.machine || "—"}
                </td>
                <td className="px-2 py-1">
                  <input
                    aria-label={`${row.datasetName} 一级场景`}
                    value={row.classification.level1}
                    onChange={(event) =>
                      update(row.key, "level1", event.target.value)
                    }
                    placeholder="输入一级场景"
                    className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-slate-200"
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    aria-label={`${row.datasetName} 二级场景`}
                    value={row.classification.level2}
                    onChange={(event) =>
                      update(row.key, "level2", event.target.value)
                    }
                    placeholder="输入二级场景"
                    className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-slate-200"
                  />
                </td>
                <td className="px-2 py-1">
                  <input
                    aria-label={`${row.datasetName} 任务名称`}
                    value={row.classification.taskName}
                    onChange={(event) =>
                      update(row.key, "taskName", event.target.value)
                    }
                    placeholder="手动填写任务名称"
                    className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-slate-200"
                  />
                </td>
                <td className="max-w-72 px-3 py-2 text-slate-300">
                  {row.datasetName}
                </td>
                <td className="px-3 py-2 tabular-nums text-slate-300">
                  {row.hours.toFixed(2)}
                </td>
                <td className="px-3 py-2 tabular-nums text-slate-400">
                  {row.datasets.length}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-8 text-center text-slate-500"
                >
                  暂无匹配任务
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
