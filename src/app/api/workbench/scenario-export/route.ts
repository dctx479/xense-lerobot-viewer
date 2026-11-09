import { spawn } from "node:child_process";
import { pythonSpawnEnv, resolvePython } from "@/lib/python-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportDataset = {
  relativePath?: string;
  source?: string | null;
  sourceLabel?: string | null;
  hubSource?: string | null;
  hubRepoId?: string | null;
  hubPath?: string | null;
  durationHours?: number | null;
};
type ExportRow = {
  machine?: string;
  captureType?: string;
  level1?: string;
  level2?: string;
  taskName?: string;
  datasetName?: string;
  datasetNames?: string[];
  hours?: number;
  datasets?: ExportDataset[];
};

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_MANIFEST_ROWS = 100_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 120_000;

async function readLimitedBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES)
    return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function runExporter(python: string, script: string, input: string) {
  return new Promise<{
    output?: Buffer;
    error?: "failed" | "timeout" | "too-large";
    detail?: string;
  }>((resolve) => {
    const child = spawn(python, ["-c", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonSpawnEnv(),
    });
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: {
      output?: Buffer;
      error?: "failed" | "timeout" | "too-large";
      detail?: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ error: "timeout" });
    }, EXPORT_TIMEOUT_MS);
    child.on("error", () => finish({ error: "failed" }));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ error: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorChunks.reduce((total, item) => total + item.length, 0) < 8_192)
        errorChunks.push(chunk.subarray(0, 8_192));
    });
    child.on("close", (code) => {
      if (settled) return;
      finish(
        code === 0
          ? { output: Buffer.concat(chunks, size) }
          : {
              error: "failed",
              detail: Buffer.concat(errorChunks)
                .toString("utf8")
                .trim()
                .slice(0, 2_000),
            },
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function POST(request: Request) {
  const body = await readLimitedBody(request);
  if (body === null)
    return Response.json(
      { error: "请求过大，单次导出最多支持 32 MB 请求数据" },
      { status: 413 },
    );
  let payload: {
    rows?: unknown;
    includeMachineNumber?: unknown;
    includeDatasetManifest?: unknown;
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(payload.rows) || payload.rows.length > MAX_ROWS)
    return Response.json(
      { error: `任务行数最多支持 ${MAX_ROWS} 行` },
      { status: 400 },
    );
  const includeDatasetManifest = payload.includeDatasetManifest === true;
  const manifestRows =
    includeDatasetManifest && Array.isArray(payload.rows)
      ? payload.rows.reduce(
          (total, row) =>
            total +
            (row &&
            typeof row === "object" &&
            Array.isArray((row as ExportRow).datasets)
              ? (row as ExportRow).datasets!.length
              : 0),
          0,
        )
      : 0;
  if (manifestRows > MAX_MANIFEST_ROWS)
    return Response.json(
      { error: `实际数据集清单最多支持 ${MAX_MANIFEST_ROWS} 条` },
      { status: 413 },
    );
  const rows = payload.rows
    .filter((row): row is ExportRow => Boolean(row) && typeof row === "object")
    .map((row) => ({
      machine: String(row.machine ?? ""),
      captureType: String(row.captureType ?? "其他"),
      level1: String(row.level1 ?? ""),
      level2: String(row.level2 ?? ""),
      taskName: String(row.taskName ?? ""),
      datasetName: Array.isArray(row.datasetNames)
        ? row.datasetNames.map(String).join("、")
        : String(row.datasetName ?? ""),
      hours: Number.isFinite(Number(row.hours)) ? Number(row.hours) : 0,
      datasets:
        includeDatasetManifest && Array.isArray(row.datasets)
          ? row.datasets.map((dataset) => ({
              relativePath: String(dataset.relativePath ?? ""),
              source: String(dataset.source ?? ""),
              sourceLabel: String(dataset.sourceLabel ?? ""),
              hubSource: String(dataset.hubSource ?? ""),
              hubRepoId: String(dataset.hubRepoId ?? ""),
              hubPath: String(dataset.hubPath ?? ""),
              durationHours: Number.isFinite(Number(dataset.durationHours))
                ? Number(dataset.durationHours)
                : 0,
            }))
          : [],
    }));
  const includeMachineNumber = payload.includeMachineNumber !== false;
  const script = String.raw`import sys,json,io
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

payload=json.load(sys.stdin)
rows=payload['rows']
include_machine=payload['includeMachineNumber']
include_manifest=payload['includeDatasetManifest']
has_capture=any(r['captureType']!='其他' for r in rows)
def capture_label(kind):
    if kind=='xtac-umi-g1': return '带头显'
    if kind=='taccap-g1': return '不带头显'
    return '其他'

w=Workbook()
s=w.active
s.title='场景分类'
headers=(['采集类型'] if has_capture else []) + (['机器编号'] if include_machine else []) + ['一级场景','二级场景','任务名称','数据集名称','时长(小时)']
s.append(headers)
capture_col=1 if has_capture else None
machine_col=(2 if has_capture else 1) if include_machine else None
level1_col=(3 if has_capture else 2) if include_machine else (2 if has_capture else 1)
level2_col=level1_col+1
hours_col=len(headers)
by_capture={}
for r in rows:
    by_capture.setdefault(r['captureType'],{}).setdefault(r['level1'] or '未分类',{}).setdefault(r['level2'] or '未细分',[]).append(r)
capture_order=['xtac-umi-g1','taccap-g1','其他']
data_type_spans=[]
subtotal_styles=[]
for kind in capture_order:
    scenes=by_capture.get(kind)
    if not scenes: continue
    type_start=s.max_row+1
    for scene,subscenes in scenes.items():
        scene_start=s.max_row+1
        scene_hours=0
        for subscene,items in subscenes.items():
            detail_start=s.max_row+1
            for r in items:
                values=([capture_label(kind)] if has_capture else []) + ([r['machine']] if include_machine else []) + [r['level1'] or '未分类',r['level2'],r['taskName'],r['datasetName'],r['hours']]
                s.append(values)
            detail_end=s.max_row
            if detail_end>detail_start:
                s.merge_cells(start_row=detail_start,start_column=level2_col,end_row=detail_end,end_column=level2_col)
            subtotal=([None] if has_capture else []) + ([None] if include_machine else []) + [None,(subscene+'小计'),None,None,sum(r['hours'] for r in items)]
            s.append(subtotal)
            s.merge_cells(start_row=s.max_row,start_column=level2_col,end_row=s.max_row,end_column=hours_col-1)
            subtotal_styles.append((s.max_row, level2_col, hours_col, 'DDEBF7', '1F4E78'))
            scene_hours += sum(r['hours'] for r in items)
        scene_end=s.max_row
        if scene_end>scene_start:
            s.merge_cells(start_row=scene_start,start_column=level1_col,end_row=scene_end,end_column=level1_col)
        s.append(([None] if has_capture else []) + ([None] if include_machine else []) + [scene+'小计',None,None,None,scene_hours])
        s.merge_cells(start_row=s.max_row,start_column=level1_col,end_row=s.max_row,end_column=hours_col-1)
        subtotal_styles.append((s.max_row, level1_col, hours_col, 'C6E0B4', '385723'))
    type_end=s.max_row
    data_type_spans.append((type_start,type_end,kind))
    s.append(([capture_label(kind)+'小计'] if has_capture else []) + ([None] if include_machine else []) + [None,None,None,None,sum(r['hours'] for r in rows if r['captureType']==kind)])
    s.merge_cells(start_row=s.max_row,start_column=(capture_col or level1_col),end_row=s.max_row,end_column=hours_col-1)
    subtotal_styles.append((s.max_row, (capture_col or level1_col), hours_col, '9DC3E6', '1F4E78'))
    if has_capture and type_end>type_start:
        s.merge_cells(start_row=type_start,start_column=capture_col,end_row=type_end,end_column=capture_col)
grand_values=[None]*hours_col+[sum(r['hours'] for r in rows)]
grand_values[(capture_col or level1_col)-1]='总计'
s.append(grand_values)
grand_total_row=s.max_row
s.merge_cells(start_row=grand_total_row,start_column=(capture_col or level1_col),end_row=grand_total_row,end_column=hours_col-1)
subtotal_styles.append((grand_total_row, (capture_col or level1_col), hours_col, '1F4E78', 'FFFFFF'))
thin=Side(style='thin',color='B8C9CE')
medium=Side(style='medium',color='6B8790')
detail_border=Border(top=thin,bottom=thin,left=thin,right=thin)
for row in s.iter_rows():
    for cell in row:
        cell.border=detail_border
        cell.alignment=Alignment(vertical='center',wrap_text=True)
for cell in s[1]:
    cell.font=Font(bold=True,color='FFFFFF')
    cell.fill=PatternFill('solid',fgColor='1F4E78')
    cell.alignment=Alignment(horizontal='center',vertical='center')
    cell.border=Border(top=medium,bottom=medium,left=medium,right=medium)
for row in range(2,s.max_row+1):
    for cell in s[row]:
        cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
for row_num,start_col,end_col,color,text_color in subtotal_styles:
    for col in range(start_col,end_col+1):
        cell=s.cell(row=row_num,column=col)
        cell.font=Font(bold=True,color=text_color)
        cell.fill=PatternFill('solid',fgColor=color)
        cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
        cell.border=Border(top=medium,bottom=medium,left=thin,right=thin)
for cell in s[grand_total_row]:
    cell.font=Font(bold=True,color='FFFFFF')
    cell.fill=PatternFill('solid',fgColor='1F4E78')
    cell.border=Border(top=medium,bottom=medium,left=medium,right=medium)
for col,width in enumerate(([14] if has_capture else [])+([18] if include_machine else [])+[14,14,28,34,14],1):
    s.column_dimensions[get_column_letter(col)].width=width
s.freeze_panes='A2'
for row in range(1,s.max_row+1): s.row_dimensions[row].height=24
for row_num,*_ in subtotal_styles: s.row_dimensions[row_num].height=22
for row in range(2,s.max_row+1): s.cell(row=row,column=hours_col).number_format='0.00'

if include_manifest:
    m=w.create_sheet('实际数据集清单')
    m.append(['采集类型','任务名称','数据集名称','实际数据集路径','数据来源','来源标识','Hub 来源','Hub Repo ID','Hub 路径'] + (['机器编号'] if include_machine else []) + ['时长(小时)'])
    for r in rows:
        for d in r.get('datasets',[]):
            m.append([capture_label(r['captureType']),r['taskName'],r['datasetName'],d.get('relativePath',''),d.get('sourceLabel') or d.get('source') or '',d.get('source',''),d.get('hubSource',''),d.get('hubRepoId',''),d.get('hubPath','')] + ([r['machine']] if include_machine else []) + [d.get('durationHours') or 0])
    for c in m[1]:
        c.font=Font(bold=True,color='FFFFFF')
        c.fill=PatternFill('solid',fgColor='1F4E78')
        c.alignment=Alignment(horizontal='center')
        c.border=Border(top=medium,bottom=medium,left=medium,right=medium)
    for col,width in enumerate([14,28,30,48,18,18,16,30,36] + ([18] if include_machine else []) + [14],1): m.column_dimensions[get_column_letter(col)].width=width
    for row in m.iter_rows():
        for cell in row:
            cell.border=detail_border
            cell.alignment=Alignment(horizontal='center',vertical='center',wrap_text=True)
    m.freeze_panes='A2'
    m.auto_filter.ref=m.dimensions
    for row in range(2,m.max_row+1): m.cell(row=row,column=m.max_column).number_format='0.00'

out=io.BytesIO()
w.save(out)
sys.stdout.buffer.write(out.getvalue())`;
  let python: string;
  try {
    ({ bin: python } = await resolvePython(["openpyxl"]));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? `无法找到可用的 Python openpyxl 环境：${error.message}`
            : "无法找到可用的 Python openpyxl 环境",
      },
      { status: 500 },
    );
  }
  const result = await runExporter(
    python,
    script,
    JSON.stringify({ rows, includeMachineNumber, includeDatasetManifest }),
  );
  if (result.error === "timeout")
    return Response.json(
      { error: "导出耗时过长，请缩小筛选范围后重试" },
      { status: 504 },
    );
  if (result.error === "too-large")
    return Response.json(
      { error: "生成的 Excel 超过 64 MB，请缩小筛选范围或关闭实际数据集清单" },
      { status: 413 },
    );
  if (!result.output)
    return Response.json(
      {
        error: `Excel 生成失败${result.detail ? `：${result.detail}` : "，请查看服务端日志"}`,
      },
      { status: 500 },
    );
  return new Response(new Uint8Array(result.output), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition":
        "attachment; filename=scenario-classification.xlsx",
      "cache-control": "no-store",
    },
  });
}
